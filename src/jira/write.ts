import * as z from 'zod';
import {
  AccessDenied,
  allowedProjects,
  fetchAllowedIssue,
  IssueKey,
  type JiraContext,
  loadAllowed,
} from './access.ts';
import type { IssueFields } from './client.ts';
import { markdownToAdf } from './markdown.ts';

/** Jira caps summaries at 255 characters and rich text fields at 32,767. */
const Markdown = z.string().trim().min(1).max(30_000);

/** Fields create and update share. Text is Markdown, converted to Jira's rich text. */
const EditableFields = z.object({
  summary: z.string().trim().min(1).max(255).optional(),
  description: Markdown.optional().describe('Markdown; replaces the whole description'),
  labels: z
    .array(z.string().regex(/^\S{1,255}$/, 'Labels cannot contain spaces.'))
    .max(50)
    .optional()
    .describe('Replaces all labels'),
  priority: z.string().trim().min(1).max(100).optional().describe('Priority name, such as High'),
  assignee: z
    .union([z.literal('me'), z.string().regex(/^[\w:-]{1,128}$/, 'Expected an account ID.')])
    .nullable()
    .optional()
    .describe('"me", an Atlassian account ID, or null to unassign'),
});

export const CreateIssueInput = EditableFields.required({ summary: true }).extend({
  project: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Expected a project key such as PROJ.')
    .describe('Project key, such as PROJ'),
  issueType: z.string().trim().min(1).max(100).describe('Issue type name, such as Task or Bug'),
  parent: IssueKey.optional().describe('Parent issue key, for a subtask or an issue under an epic'),
});

export const UpdateIssueInput = EditableFields.extend({
  issue: IssueKey,
  status: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe('Status to move the issue to, such as Done'),
  comment: Markdown.optional().describe('Markdown comment to add'),
});

/**
 * Creates an issue in an allowed project. The project is resolved to the ID Jira returns before
 * the policy check, and a parent must be readable under the same policy.
 */
export async function createIssue(jira: JiraContext, input: z.output<typeof CreateIssueInput>) {
  const { config, client } = jira;
  const project = await loadAllowed(config, {
    notAllowed: `Project ${input.project} is not one this server may use. ${allowedProjects(config)}`,
    load: () => client.getProject(input.project),
    projectId: (found) => found.id,
  });
  const parent = input.parent ? await fetchAllowedIssue(jira, input.parent) : undefined;

  const types = await client.issueTypes(project.id);
  const wanted = input.issueType.toLowerCase();
  const type = types.find((candidate) => candidate.name.toLowerCase() === wanted);
  if (!type) {
    const names = types.map((candidate) => candidate.name).join(', ') || 'none';
    throw new Error(`${project.key} has no issue type "${input.issueType}". Available: ${names}.`);
  }

  const fields = await jiraFields(input, async () => (await client.myself()).accountId);
  const created = await client.createIssue({
    project: { id: project.id },
    issuetype: { id: type.id },
    ...(parent ? { parent: { id: parent.id } } : {}),
    ...fields,
    // Already in fields; repeated so the type knows a new issue always has one.
    summary: input.summary,
  });

  return { key: created.key, url: `${config.site}/browse/${created.key}` };
}

/**
 * Changes an issue the user created, in an allowed project. Ownership is Jira's `creator`, which
 * no one can edit. Everything that can be checked is checked before the first write; field edits,
 * the status move and the comment then run in that order, and if one fails, the error names the
 * ones already applied.
 */
export async function updateIssue(jira: JiraContext, input: z.output<typeof UpdateIssueInput>) {
  const { config, client } = jira;
  const { issue: key, status, comment, ...edits } = input;
  const editing = Object.values(edits).some((value) => value !== undefined);
  if (!editing && status === undefined && comment === undefined) {
    throw new Error('Nothing to change. Pass a field, a status or a comment.');
  }

  const issue = await fetchAllowedIssue(jira, key);
  const me = await client.myself();
  const creator = issue.fields.creator?.accountId;
  if (creator !== me.accountId) {
    const who =
      creator === undefined ? "Jira didn't say who created it" : 'someone else created it';
    throw new AccessDenied(
      `${issue.key} can't be changed: ${who}. This server only changes issues you created.`,
    );
  }

  const fields = await jiraFields(edits, async () => me.accountId);
  const alreadyThere = status?.toLowerCase() === issue.fields.status?.name.toLowerCase();
  const transition =
    status && !alreadyThere ? await findTransition(jira, issue, status) : undefined;

  const changed: string[] = [];
  try {
    if (editing) {
      await client.editIssue(issue.id, fields);
      changed.push(...Object.keys(fields));
    }
    if (transition) {
      await client.transition(issue.id, transition.id);
      changed.push('status');
    }
    if (comment !== undefined) {
      await client.addComment(issue.id, markdownToAdf(comment));
      changed.push('comment');
    }
  } catch (error) {
    if (changed.length === 0 || !(error instanceof Error)) {
      throw error;
    }
    throw new Error(`${error.message} Already applied: ${changed.join(', ')}.`);
  }

  return { key: issue.key, url: `${config.site}/browse/${issue.key}`, changed };
}

/**
 * Workflows differ per project, so the status is matched against where the transitions Jira
 * offers lead.
 */
async function findTransition(
  { client }: JiraContext,
  issue: { id: string; key: string },
  status: string,
) {
  const transitions = await client.transitions(issue.id);
  const wanted = status.toLowerCase();
  const match = transitions.find((transition) => transition.to.name.toLowerCase() === wanted);
  if (!match) {
    const targets = [...new Set(transitions.map((transition) => transition.to.name))];
    throw new Error(
      `${issue.key} can't move to "${status}". Available: ${targets.join(', ') || 'none'}.`,
    );
  }

  return match;
}

/** The editable inputs as Jira's `fields` object, leaving out what wasn't given. */
async function jiraFields(
  input: z.output<typeof EditableFields>,
  myAccountId: () => Promise<string>,
): Promise<IssueFields> {
  const { summary, description, labels, priority, assignee } = input;

  return {
    ...(summary === undefined ? {} : { summary }),
    ...(description === undefined ? {} : { description: markdownToAdf(description) }),
    ...(labels === undefined ? {} : { labels }),
    ...(priority === undefined ? {} : { priority: { name: priority } }),
    ...(await assigneeField(assignee, myAccountId)),
  };
}

/** "me" is the token's owner, looked up only when asked for; null unassigns. */
async function assigneeField(
  assignee: string | null | undefined,
  myAccountId: () => Promise<string>,
): Promise<Pick<IssueFields, 'assignee'>> {
  if (assignee === undefined) {
    return {};
  }
  if (assignee === null) {
    return { assignee: null };
  }

  return { assignee: { accountId: assignee === 'me' ? await myAccountId() : assignee } };
}
