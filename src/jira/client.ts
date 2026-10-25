import * as z from 'zod';
import type { Config } from '../config.ts';
import { maskSecrets, redact, tokenEntry } from '../credentials.ts';
import { AdfNode } from './adf.ts';

/** A failed Jira call. Messages are already redacted and safe to show to the model. */
export class JiraError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
  }
}

const Named = z.object({ name: z.string() });
const Person = z.object({ displayName: z.string() });

const Project = z.object({ id: z.string().regex(/^\d+$/), key: z.string(), name: z.string() });

/**
 * Another issue as Jira nests it in parent, links and subtasks. Only the key is kept: its summary,
 * status and other fields may belong to a project the policy denies.
 */
const IssueRef = z.object({ key: z.string() });

export const JsonValue = z.json();
export type JsonValue = z.infer<typeof JsonValue>;

/** `project` is required: an issue whose project can't be checked must fail closed. */
const Issue = z.object({
  id: z.string().regex(/^\d+$/),
  key: z.string(),
  fields: z.object({
    project: z.object({ id: z.string(), key: z.string() }),
    summary: z.string().optional(),
    status: Named.optional(),
    issuetype: Named.optional(),
    priority: Named.nullish(),
    assignee: Person.nullish(),
    reporter: Person.nullish(),
    labels: z.array(z.string()).optional(),
    parent: IssueRef.nullish(),
    subtasks: z.array(IssueRef).optional(),
    issuelinks: z
      .array(
        z.object({
          type: z.object({ inward: z.string(), outward: z.string() }),
          inwardIssue: IssueRef.optional(),
          outwardIssue: IssueRef.optional(),
        }),
      )
      .optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
    description: AdfNode.nullish(),
    comment: z
      .object({
        total: z.number(),
        comments: z.array(
          z.object({
            id: z.string(),
            author: Person.optional(),
            created: z.string(),
            body: AdfNode,
          }),
        ),
      })
      .optional(),
  }),
});
export type Issue = z.infer<typeof Issue>;

/**
 * Every field of one issue, untyped, with display names. Read through `Issue` for anything policy
 * or the default answer depends on; the raw values are only for fields the caller asks for.
 */
const IssueWithAllFields = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.record(z.string(), JsonValue),
  names: z.record(z.string(), z.string()).optional(),
});

const SearchResult = z.object({ issues: z.array(Issue), nextPageToken: z.string().optional() });
const Myself = z.object({ accountId: z.string(), displayName: z.string() });
const ProjectPage = z.object({ values: z.array(Project) });
const ErrorBody = z.object({
  errorMessages: z.array(z.string()).optional(),
  errors: z.record(z.string(), z.string()).optional(),
});

const SUMMARY_FIELDS = [
  'project',
  'summary',
  'status',
  'issuetype',
  'priority',
  'assignee',
  'parent',
  'updated',
];

type ClientOptions = { apiBaseUrl: string; email: string; token: string; fetch?: typeof fetch };
type RequestOptions = { method?: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown };

export type JiraClient = ReturnType<typeof createJiraClient>;

const UNEXPECTED_FORMAT = 'Jira returned a response in an unexpected format.';

/**
 * Jira Cloud REST v3 over Basic auth. Every string in a response has the token masked as it is
 * parsed and is then validated; anything unexpected becomes a JiraError with a redacted message.
 * Text later assembled from several strings goes through `redactSecrets`. Redirects are refused
 * so the credential can't follow one.
 */
export function createJiraClient({
  apiBaseUrl,
  email,
  token,
  fetch: fetchImpl = fetch,
}: ClientOptions) {
  const authorization = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const secrets = [token, `${email}:${token}`];

  async function request<S extends z.ZodType>(
    schema: S,
    path: string,
    options: RequestOptions = {},
  ) {
    const url = new URL(`${apiBaseUrl}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(name, value);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: options.method ?? 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization,
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? null : JSON.stringify(options.body),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.cause instanceof Error
          ? error.cause.message
          : String(error);
      throw new JiraError(0, redact(`Could not reach Jira: ${reason}`, secrets));
    }

    let data: unknown;
    try {
      // Masking decoded values, not the raw text, so JSON escapes can't hide the token.
      data = JSON.parse(await response.text(), (_key, value) =>
        typeof value === 'string' ? maskSecrets(value, secrets) : value,
      );
    } catch {
      data = undefined;
    }

    if (!response.ok) {
      throw new JiraError(response.status, describeFailure(response.status, data));
    }

    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new JiraError(response.status, UNEXPECTED_FORMAT);
    }

    return parsed.data;
  }

  return {
    /**
     * For complete output text assembled from response strings, where a token may only appear
     * once joined.
     */
    redactSecrets: (text: string) => redact(text, secrets),
    myself: () => request(Myself, '/rest/api/3/myself'),
    getProject: (key: string) => request(Project, `/rest/api/3/project/${encodeURIComponent(key)}`),
    listProjects: async () =>
      (
        await request(ProjectPage, '/rest/api/3/project/search', {
          query: { maxResults: '50', orderBy: 'key' },
        })
      ).values,
    searchIssues: (search: {
      jql: string;
      maxResults: number;
      nextPageToken?: string | undefined;
    }) =>
      request(SearchResult, '/rest/api/3/search/jql', {
        method: 'POST',
        body: { ...search, fields: SUMMARY_FIELDS },
      }),
    /**
     * One issue with all its fields: typed for policy and defaults, raw values and names for the
     * rest.
     */
    readIssue: async (idOrKey: string) => {
      const all = await request(
        IssueWithAllFields,
        `/rest/api/3/issue/${encodeURIComponent(idOrKey)}`,
        { query: { fields: '*all', expand: 'names' } },
      );
      const issue = Issue.safeParse(all);
      if (!issue.success) {
        throw new JiraError(200, UNEXPECTED_FORMAT);
      }

      return { ...issue.data, values: all.fields, names: all.names ?? {} };
    },
  };
}

/** A client for the configured connection, using the token from the keychain. */
export async function clientFor(config: Config): Promise<JiraClient> {
  const token = await tokenEntry(config.site, config.email).getPassword();
  if (!token) {
    throw new Error(
      'No API token in the keychain. The user can run `atlassian-mcp token` in a terminal.',
    );
  }

  return createJiraClient({ apiBaseUrl: config.apiBaseUrl, email: config.email, token });
}

const FAILURES: Record<number, string> = {
  401: 'Jira rejected the credentials (401)',
  403: 'Jira denied access (403)',
  404: 'Not found, or not visible to this account (404)',
};

/** Redacted before shortening, so a cut can only shorten a "[redacted]" marker, never a secret. */
function describeFailure(status: number, data: unknown): string {
  const body = ErrorBody.safeParse(data);
  const details = body.success
    ? [...(body.data.errorMessages ?? []), ...Object.values(body.data.errors ?? {})]
    : [];
  const summary = FAILURES[status] ?? `Jira request failed (${status})`;
  const message = redact(details.length > 0 ? `${summary}: ${details.join('; ')}` : summary, []);

  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}
