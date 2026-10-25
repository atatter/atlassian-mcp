import * as z from 'zod';
import type { Config } from '../config.ts';
import { allows } from '../policy.ts';
import { adfToText } from './adf.ts';
import { JiraError, type Issue, type JiraClient } from './client.ts';
import { fieldEntry, otherFields } from './fields.ts';

/** What every tool call works with. Loaded fresh per call so CLI permission changes apply at once. */
export type JiraContext = { config: Config; client: JiraClient };

const IssueKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]*-[1-9]\d*$/, 'Expected an issue key such as PROJ-123.')
  .describe('Issue key, such as PROJ-123');

export const SearchInput = z.object({
  jql: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'JQL filter and optional ORDER BY. Results are always limited to the allowed projects.',
    ),
  maxResults: z.number().int().min(1).max(50).default(20),
  nextPageToken: z
    .string()
    .max(4000)
    .optional()
    .describe('Token from a previous search to fetch the next page'),
});
const FieldId = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/, 'Expected a Jira field ID such as customfield_10016.');

export const GetIssueInput = z.object({
  issue: IssueKey,
  fields: z
    .array(FieldId)
    .max(20)
    .optional()
    .describe(
      "Extra field IDs to include, such as customfield_10016. otherFields in a previous answer lists this issue's.",
    ),
});
const MAX_COMMENTS = 20;
const MAX_REFERENCES = 50;
/**
 * Fields the default answer of jira_get_issue already covers, so otherFields doesn't list them again.
 */
const SHOWN_FIELDS = [
  'project',
  'summary',
  'issuetype',
  'status',
  'priority',
  'assignee',
  'reporter',
  'labels',
  'created',
  'updated',
  'description',
  'comment',
  'parent',
  'issuelinks',
  'subtasks',
];

/** A call the configured policy forbids. */
class AccessDenied extends Error {
  override name = 'AccessDenied';
}

/**
 * Adds a project clause so results come from allowed projects. The JQL is untrusted and can
 * escape the parentheses, so this is only for relevance; results are filtered again by project ID.
 */
export function scopeJql(projectIds: readonly string[], jql = ''): string {
  // Blank out quoted values so "order by" inside a string isn't taken for the clause.
  const unquoted = jql.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (value) =>
    ' '.repeat(value.length),
  );

  const orderBy = [...unquoted.matchAll(/\border\s+by\b/gi)].at(-1)?.index;
  const where = (orderBy === undefined ? jql : jql.slice(0, orderBy)).trim();
  const order = orderBy === undefined ? 'ORDER BY updated DESC' : jql.slice(orderBy).trim();
  const scope = `project in (${projectIds.join(', ')})`;

  return `${where ? `${scope} AND (${where})` : scope} ${order}`;
}

export async function searchIssues(
  { config, client }: JiraContext,
  input: z.output<typeof SearchInput>,
) {
  if (config.projects.length === 0) {
    throw new AccessDenied(noProjectsMessage);
  }

  const result = await client.searchIssues({
    jql: scopeJql(
      config.projects.map((project) => project.id),
      input.jql,
    ),
    maxResults: input.maxResults,
    nextPageToken: input.nextPageToken,
  });

  return {
    issues: result.issues
      .filter((issue) => allows(config.projects, issue.fields.project.id))
      .map((issue) => summarize(config, issue)),
    nextPageToken: result.nextPageToken,
  };
}

export async function getIssue(jira: JiraContext, input: z.output<typeof GetIssueInput>) {
  const issue = await fetchAllowedIssue(jira, input.issue);

  const comments = issue.fields.comment?.comments ?? [];
  const totalComments = issue.fields.comment?.total ?? comments.length;
  const shownComments = comments.slice(-MAX_COMMENTS);

  const requested = input.fields ?? [];
  const fields =
    requested.length > 0
      ? Object.fromEntries(
          requested.map((id) => [
            id,
            fieldEntry(id, issue.values, issue.names, jira.client.redactSecrets),
          ]),
        )
      : undefined;
  const other = otherFields(
    issue.values,
    issue.names,
    new Set([...SHOWN_FIELDS, ...requested]),
    jira.client.redactSecrets,
  );

  return {
    ...summarize(jira.config, issue),
    reporter: issue.fields.reporter?.displayName,
    labels: issue.fields.labels,
    created: issue.fields.created,
    ...relatedIssues(jira.config.site, issue),
    description: issue.fields.description ? adfToText(issue.fields.description) : undefined,
    fields,
    otherFields: other.fields,
    ...(other.note === undefined ? {} : { otherFieldsNote: other.note }),
    totalComments,
    ...(totalComments > shownComments.length
      ? { commentsNote: `Showing the latest ${shownComments.length} of ${totalComments} comments.` }
      : {}),
    comments: shownComments.map((comment) => ({
      id: comment.id,
      author: comment.author?.displayName,
      created: comment.created,
      body: adfToText(comment.body),
    })),
  };
}

/**
 * Parent, linked and subtask issues by key and link only, at most MAX_REFERENCES of each. Their
 * other details may belong to a denied project; reading one goes through jira_get_issue's check.
 */
function relatedIssues(site: string, issue: Issue) {
  const reference = (key: string) => ({ key, url: `${site}/browse/${key}` });

  const links = (issue.fields.issuelinks ?? []).flatMap((link) => {
    if (link.outwardIssue) {
      return [{ relation: link.type.outward, ...reference(link.outwardIssue.key) }];
    }
    if (link.inwardIssue) {
      return [{ relation: link.type.inward, ...reference(link.inwardIssue.key) }];
    }
    return [];
  });
  const subtasks = (issue.fields.subtasks ?? []).map((subtask) => reference(subtask.key));

  return {
    parent: issue.fields.parent ? reference(issue.fields.parent.key) : null,
    links: links.slice(0, MAX_REFERENCES),
    ...(links.length > MAX_REFERENCES
      ? { linksNote: `Showing ${MAX_REFERENCES} of ${links.length} links.` }
      : {}),
    subtasks: subtasks.slice(0, MAX_REFERENCES),
    ...(subtasks.length > MAX_REFERENCES
      ? { subtasksNote: `Showing ${MAX_REFERENCES} of ${subtasks.length} subtasks.` }
      : {}),
  };
}

/**
 * Fetches an issue and checks the project Jira resolved it to, before any of its data is used.
 * Moved issues resolve to their new project, so a key's prefix proves nothing.
 */
async function fetchAllowedIssue({ config, client }: JiraContext, key: string) {
  const notAllowed = `Issue ${key} was not found in a project this server may read. ${allowedProjects(config)}`;
  if (config.projects.length === 0) {
    throw new AccessDenied(noProjectsMessage);
  }

  const issue = await client.readIssue(key).catch((error: unknown) => {
    // Report missing and forbidden issues alike, so the answer doesn't reveal what exists elsewhere.
    if (error instanceof JiraError && error.status === 404) {
      throw new AccessDenied(notAllowed);
    }
    throw error;
  });

  if (!allows(config.projects, issue.fields.project.id)) {
    throw new AccessDenied(notAllowed);
  }

  return issue;
}

function summarize(config: Config, issue: Issue) {
  return {
    key: issue.key,
    url: `${config.site}/browse/${issue.key}`,
    project: issue.fields.project.key,
    summary: issue.fields.summary,
    type: issue.fields.issuetype?.name,
    status: issue.fields.status?.name,
    priority: issue.fields.priority?.name,
    assignee: issue.fields.assignee?.displayName,
    parent: issue.fields.parent?.key,
    updated: issue.fields.updated,
  };
}

const noProjectsMessage =
  'No Jira projects are allowed. The user can allow one with `atlassian-mcp allow <KEY>`.';

function allowedProjects(config: Config): string {
  return `Allowed: ${config.projects.map((project) => project.key).join(', ')}.`;
}
