import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { redact } from '../credentials.ts';
import type { JiraContext } from './access.ts';
import { GetIssueInput, getIssue, SearchInput, searchIssues } from './tools.ts';
import { CreateIssueInput, createIssue, UpdateIssueInput, updateIssue } from './write.ts';

/**
 * Registers the Jira tools. Policy is enforced inside every call; annotations are only hints.
 * There is deliberately no tool that deletes anything.
 * Results are redacted as complete text, since rich text joined from fragments can form a token.
 */
export function registerJiraTools(server: McpServer, context: () => Promise<JiraContext>) {
  const run = async (call: (jira: JiraContext) => Promise<unknown>): Promise<CallToolResult> => {
    try {
      const jira = await context();
      const result = await call(jira);

      return {
        content: [
          { type: 'text', text: jira.client.redactSecrets(JSON.stringify(result, null, 2)) },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error.';
      return { content: [{ type: 'text', text: redact(message, []) }], isError: true };
    }
  };

  server.registerTool(
    'jira_search_issues',
    {
      title: 'Search Jira issues',
      description:
        'Search issues with JQL in the Jira projects the user allowed. Returns a compact list per issue ' +
        '(key, summary, type, status, priority, assignee, parent key, updated). Use jira_get_issue for details.',
      inputSchema: SearchInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) => run((jira) => searchIssues(jira, input)),
  );

  server.registerTool(
    'jira_get_issue',
    {
      title: 'Read a Jira issue',
      description:
        'Read one issue: details, description, parent, links, subtasks and the latest comments. Parent, ' +
        'linked and subtask issues are listed by key only; read them with this tool. otherFields lists the ' +
        "issue's other fields whose values can be shown, by ID and name; pass IDs in `fields` to get them, e.g. " +
        '{"issue":"PROJ-1","fields":["customfield_10016"]}.',
      inputSchema: GetIssueInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) => run((jira) => getIssue(jira, input)),
  );

  server.registerTool(
    'jira_create_issue',
    {
      title: 'Create a Jira issue',
      description:
        'Create an issue in a Jira project the user allowed. description is Markdown. Returns the new key ' +
        'and link. Set the status afterwards with jira_update_issue.',
      inputSchema: CreateIssueInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (input) => run((jira) => createIssue(jira, input)),
  );

  server.registerTool(
    'jira_update_issue',
    {
      title: 'Update a Jira issue you created',
      description:
        'Change an issue the user created: summary, description, labels, priority, assignee, status, ' +
        'or add a comment. Given fields replace the current values; description and comment are ' +
        "Markdown. Issues created by other people can't be changed.",
      inputSchema: UpdateIssueInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (input) => run((jira) => updateIssue(jira, input)),
  );
}
