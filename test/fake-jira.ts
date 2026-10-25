import { createServer, type Server } from 'node:http';
import { buffer } from 'node:stream/consumers';
import * as z from 'zod';

// Synthetic credentials and data only. Nothing here comes from a real Jira site.
export const FAKE_EMAIL = 'synthetic.user@example.invalid';
export const FAKE_TOKEN = 'synthetic-test-token-0000000000';

const project = (id: string, key: string) => ({ id, key, name: `${key} project` });
const DEMO = project('10000', 'DEMO');
const SECRET = project('10001', 'SECRET');

const issue = (id: string, key: string, inProject: typeof DEMO) => ({
  id,
  key,
  fields: {
    project: { id: inProject.id, key: inProject.key },
    summary: `Summary of ${key}`,
    status: { name: 'To Do' },
    issuetype: { name: 'Task' },
    priority: null,
    assignee: { displayName: 'Synthetic Person' },
    updated: '2026-01-01T00:00:00.000+0000',
    description: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: `Body of ${key}` }] }],
    },
    comment: { total: 0, comments: [] },
  },
});

/** Details of SECRET issues that Jira nests inside DEMO-1. None of this may reach tool output. */
export const EXCLUDED = 'EXCLUDED-DETAIL';
const nestedSecret = (key: string) => ({
  id: '20009',
  key,
  self: `https://example.invalid/rest/api/3/issue/${key}`,
  fields: { summary: `${EXCLUDED} summary`, status: { name: `${EXCLUDED} status` } },
});

const doc = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/**
 * DEMO-1 as Jira returns it for fields=*all&expand=names: references to a denied project, and custom
 * fields of the shapes Jira uses (number, sprint objects, issue references, rich text, long text).
 */
const demo1 = {
  ...issue('20001', 'DEMO-1', DEMO),
  fields: {
    ...issue('20001', 'DEMO-1', DEMO).fields,
    parent: nestedSecret('SECRET-9'),
    issuelinks: [
      {
        id: '1',
        type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        inwardIssue: nestedSecret('SECRET-1'),
      },
      {
        id: '2',
        type: { name: 'Relates', inward: 'relates to', outward: 'relates to' },
        outwardIssue: nestedSecret('DEMO-5'),
      },
    ],
    subtasks: [nestedSecret('DEMO-6')],
    watches: { self: 'https://example.invalid/watchers', watchCount: 1, isWatching: false },
    customfield_10016: 5,
    customfield_10020: [
      { id: 1, name: 'Sprint 12', state: 'active', goal: `${EXCLUDED} sprint goal` },
    ],
    customfield_10030: {
      hasEpicLinkFieldDependency: false,
      data: { id: 20_009, key: 'SECRET-9', summary: `${EXCLUDED} link` },
    },
    customfield_10031: nestedSecret('SECRET-1'),
    customfield_10032: { name: 'Team Synthetic', issue: nestedSecret('SECRET-1') },
    customfield_10040: 'x'.repeat(5000),
    customfield_10050: null,
    customfield_10060: doc('Rich text value'),
  },
  names: {
    project: 'Project',
    summary: 'Summary',
    parent: 'Parent',
    issuelinks: 'Linked Issues',
    subtasks: 'Sub-tasks',
    watches: 'Watchers',
    customfield_10016: 'Story Points',
    customfield_10020: 'Sprint',
    customfield_10030: 'Parent Link',
    customfield_10031: 'Picked Issue',
    customfield_10032: 'Team',
    customfield_10040: 'Long Notes',
    customfield_10050: 'Empty Field',
    customfield_10060: 'Rich Notes',
  },
};

const ISSUES = {
  'DEMO-1': demo1,
  'SECRET-1': issue('20002', 'SECRET-1', SECRET),
  // A key that looks like DEMO but whose issue lives in SECRET, as after a move between projects.
  'DEMO-2': issue('20003', 'DEMO-2', SECRET),
};

/** Endpoints that always answer the same way. */
const FIXED: Record<string, unknown> = {
  '/rest/api/3/myself': { accountId: 'synthetic', displayName: 'Synthetic User' },
  '/rest/api/3/project/search': { values: [DEMO, SECRET], isLast: true },
  '/rest/api/3/project/DEMO': DEMO,
  '/rest/api/3/project/SECRET': SECRET,
  // Malformed: the issue has no project, so it can't be checked.
  '/rest/api/3/issue/DEMO-3': { id: '20004', key: 'DEMO-3', fields: {} },
};

/**
 * A fetch-compatible fake of the Jira Cloud endpoints this package calls. Search ignores JQL and
 * returns issues from every project, like a query that escaped its project clause.
 */
export function createFakeJira() {
  const searches: string[] = [];
  // Every request as "METHOD /path?query", to prove what was and wasn't asked of Jira.
  const requests: string[] = [];
  const expectedAuth = `Basic ${Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString('base64')}`;

  async function handle(request: Request): Promise<Response> {
    const { pathname, search } = new URL(request.url);
    requests.push(`${request.method} ${pathname}${decodeURIComponent(search)}`);
    if (request.headers.get('authorization') !== expectedAuth) {
      return Response.json({ errorMessages: ['Unauthorized'] }, { status: 401 });
    }

    if (Object.hasOwn(FIXED, pathname)) {
      return Response.json(FIXED[pathname]);
    }
    if (pathname === '/rest/api/3/search/jql' && request.method === 'POST') {
      searches.push(z.object({ jql: z.string() }).parse(await request.json()).jql);
      return Response.json({ issues: Object.values(ISSUES), isLast: true });
    }
    // An upstream error that echoes the credentials back.
    if (pathname === '/rest/api/3/issue/DEMO-4') {
      return Response.json(
        { errorMessages: [`Bad header ${expectedAuth}`, `token ${FAKE_TOKEN}`] },
        { status: 400 },
      );
    }

    const issueMatch = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(pathname);
    const found = issueMatch?.[1]
      ? Object.entries(ISSUES).find(
          ([key, value]) => key === issueMatch[1] || value.id === issueMatch[1],
        )
      : undefined;
    if (found) {
      return Response.json(found[1]);
    }

    return Response.json(
      { errorMessages: ['Issue does not exist or you do not have permission to see it.'] },
      { status: 404 },
    );
  }

  const fetch = (input: string | URL | Request, init?: RequestInit) =>
    handle(new Request(input, init));

  return { handle, fetch, searches, requests };
}

/** Serves the fake over HTTP on a random loopback port, for tests that run the built CLI. */
export async function listen(
  handle: (request: Request) => Promise<Response>,
): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const data = await buffer(req);
    const body = data.length > 0 ? data : null;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers.set(name, value);
      }
    }

    const response = await handle(
      new Request(`http://127.0.0.1${req.url}`, { method: req.method ?? 'GET', headers, body }),
    );
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(Buffer.from(await response.arrayBuffer()));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fake Jira did not get a port');
  }

  return { url: `http://127.0.0.1:${address.port}`, server };
}
