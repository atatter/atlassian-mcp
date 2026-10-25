import { describe, expect, it } from 'vitest';
import { FAKE_EMAIL, FAKE_TOKEN } from '../../test/fake-jira.ts';
import { callTool, DEMO_READ, setup } from '../../test/harness.ts';
import { createJiraClient } from './client.ts';
import { GetIssueInput, getIssue, scopeJql, searchIssues, SearchInput } from './tools.ts';

describe('searchIssues', () => {
  it('drops results from other projects even when the JQL escapes its scope', async () => {
    const { jira, context } = setup([DEMO_READ]);
    const result = await searchIssues(
      context,
      SearchInput.parse({ jql: 'x) OR (project = SECRET' }),
    );
    expect(result.issues.map((issue) => issue.key)).toEqual(['DEMO-1']);
    expect(jira.searches).toEqual([
      'project in (10000) AND (x) OR (project = SECRET) ORDER BY updated DESC',
    ]);
  });

  it('fails closed when a search result has no project', async () => {
    const { context } = setup([DEMO_READ]);
    const malformed = createJiraClient({
      apiBaseUrl: context.config.apiBaseUrl,
      email: FAKE_EMAIL,
      token: FAKE_TOKEN,
      fetch: async () => Response.json({ issues: [{ id: '20009', key: 'DEMO-9', fields: {} }] }),
    });
    await expect(
      searchIssues({ ...context, client: malformed }, SearchInput.parse({})),
    ).rejects.toThrow(/unexpected format/);
  });

  it('denies everything when no project is allowed, without calling Jira', async () => {
    const { jira, context } = setup([]);
    await expect(searchIssues(context, SearchInput.parse({}))).rejects.toThrow(
      /No Jira projects are allowed/,
    );
    expect(jira.searches).toEqual([]);
  });
});

describe('scopeJql', () => {
  it('ignores ORDER BY inside quoted values', () => {
    expect(scopeJql(['1'], 'summary ~ "order by" ORDER BY key')).toBe(
      'project in (1) AND (summary ~ "order by") ORDER BY key',
    );
    expect(scopeJql(['1'], "summary ~ 'sort order by date'")).toBe(
      "project in (1) AND (summary ~ 'sort order by date') ORDER BY updated DESC",
    );
  });

  it("keeps the caller's ORDER BY outside the scoped filter", () => {
    expect(scopeJql(['1', '2'], 'status = Done order by created ASC')).toBe(
      'project in (1, 2) AND (status = Done) order by created ASC',
    );
    expect(scopeJql(['1'])).toBe('project in (1) ORDER BY updated DESC');
  });
});

describe('getIssue', () => {
  it('reads an issue in an allowed project', async () => {
    const { context } = setup([DEMO_READ]);
    const issue = await getIssue(context, GetIssueInput.parse({ issue: 'demo-1' }));
    expect(issue).toMatchObject({ key: 'DEMO-1', project: 'DEMO', description: 'Body of DEMO-1' });
  });

  it('denies issues in other projects, including keys that look allowed', async () => {
    const { context } = setup([DEMO_READ]);
    await expect(getIssue(context, GetIssueInput.parse({ issue: 'SECRET-1' }))).rejects.toThrow(
      /not found in a project/,
    );
    await expect(getIssue(context, GetIssueInput.parse({ issue: 'DEMO-2' }))).rejects.toThrow(
      /not found in a project/,
    );
  });

  it('answers missing and forbidden issues alike', async () => {
    const { context } = setup([DEMO_READ]);
    const missing = getIssue(context, GetIssueInput.parse({ issue: 'DEMO-999' }));
    await expect(missing).rejects.toThrow(
      'Issue DEMO-999 was not found in a project this server may read. Allowed: DEMO.',
    );
  });

  it('fails closed on a malformed Jira response', async () => {
    const { context } = setup([DEMO_READ]);
    await expect(getIssue(context, GetIssueInput.parse({ issue: 'DEMO-3' }))).rejects.toThrow(
      /unexpected format/,
    );
  });

  it('never repeats credentials that Jira echoes in an error', async () => {
    const { context } = setup([DEMO_READ]);
    const error: unknown = await getIssue(context, GetIssueInput.parse({ issue: 'DEMO-4' })).catch(
      (e: unknown) => e,
    );
    const message = error instanceof Error ? error.message : '';
    expect(message).toMatch(/Jira request failed \(400\)/);
    expect(message).not.toContain(FAKE_TOKEN);
    expect(message).not.toContain(Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString('base64'));
  });

  it('redacts a long error before shortening it, so no part of the token survives', async () => {
    const { context } = setup([DEMO_READ]);
    const token = 'plain-classic-token-without-a-known-shape';
    const echoing = createJiraClient({
      apiBaseUrl: context.config.apiBaseUrl,
      email: FAKE_EMAIL,
      token,
      // "Jira request failed (400): " is 27 characters, so the token starts at 492, across the 500 cut-off.
      fetch: async () =>
        Response.json({ errorMessages: [`${'x'.repeat(465)}${token}`] }, { status: 400 }),
    });
    const error: unknown = await echoing.myself().catch((e: unknown) => e);
    const message = error instanceof Error ? error.message : '';
    expect(message).toHaveLength(501);
    expect(message).not.toContain(token.slice(0, 8));
  });

  it('redacts the token from successful responses before they reach tool output', async () => {
    const { jira, context } = setup([DEMO_READ]);
    const echoing = createJiraClient({
      apiBaseUrl: context.config.apiBaseUrl,
      email: FAKE_EMAIL,
      token: FAKE_TOKEN,
      fetch: async (input, init) => {
        const body = await (await jira.fetch(input, init)).text();
        return new Response(body.replace('Summary of DEMO-1', `pasted ${FAKE_TOKEN} here`));
      },
    });
    const issue = await getIssue(
      { ...context, client: echoing },
      GetIssueInput.parse({ issue: 'DEMO-1' }),
    );
    expect(issue.summary).toBe('pasted [redacted] here');
  });

  it('redacts tokens hidden behind JSON escapes, in results and in errors', async () => {
    const { context } = setup([DEMO_READ]);
    const token = 'plain-classic-token-without-a-known-shape';
    const escaped = `\\u${token.charCodeAt(0).toString(16).padStart(4, '0')}${token.slice(1)}`;
    const client = (status: number, body: string) =>
      createJiraClient({
        apiBaseUrl: context.config.apiBaseUrl,
        email: FAKE_EMAIL,
        token,
        fetch: async () => new Response(body, { status }),
      });

    const me = await client(200, `{"accountId":"a","displayName":"${escaped}"}`).myself();
    expect(me.displayName).toBe('[redacted]');
    const error: unknown = await client(400, `{"errorMessages":["${escaped}"]}`)
      .myself()
      .catch((e: unknown) => e);
    expect(error instanceof Error ? error.message : '').toBe(
      'Jira request failed (400): [redacted]',
    );
  });

  it('redacts a token split across rich-text nodes in tool output', async () => {
    const shaped = `ATATT3xFfGF0QQQQ${'a1B2'.repeat(12)}`;
    for (const token of [FAKE_TOKEN, shaped]) {
      const { context } = setup([DEMO_READ]);
      // Formatting splits text into nodes; the first holds a token-shaped head on its own.
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: token.slice(0, 16) },
              { type: 'text', text: token.slice(16), marks: [{ type: 'strong' }] },
            ],
          },
        ],
      };
      const issue = {
        id: '20001',
        key: 'DEMO-1',
        fields: {
          project: { id: '10000', key: 'DEMO' },
          description: doc,
          comment: { total: 1, comments: [{ id: '1', created: '2026-01-01', body: doc }] },
        },
      };
      const client = createJiraClient({
        apiBaseUrl: context.config.apiBaseUrl,
        email: FAKE_EMAIL,
        token,
        fetch: async () => Response.json(issue),
      });
      const output = await callTool({ ...context, client }, 'jira_get_issue', { issue: 'DEMO-1' });
      expect(output).toContain('"description": "[redacted]"');
      expect(output).not.toContain(token.slice(16));
    }
  });

  it("rejects input that isn't an issue key before any request", () => {
    expect(GetIssueInput.safeParse({ issue: '../../myself' }).success).toBe(false);
    expect(GetIssueInput.safeParse({ issue: 'DEMO-1?fields=x' }).success).toBe(false);
  });
});
