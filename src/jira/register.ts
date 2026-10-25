import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { redact } from '../credentials.ts';
import { GetIssueInput, getIssue, type JiraContext, SearchInput, searchIssues } from './tools.ts';

/**
 * Registers the Jira tools. Policy is enforced inside every call; annotations are only hints.
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
}
