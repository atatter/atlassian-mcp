import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import type { Config, ProjectGrant } from '../src/config.ts';
import { createJiraClient } from '../src/jira/client.ts';
import { registerJiraTools } from '../src/jira/register.ts';
import type { JiraContext } from '../src/jira/tools.ts';
import { createFakeJira, FAKE_EMAIL, FAKE_TOKEN } from './fake-jira.ts';

// Shared setup for tool tests: a fake Jira, a synthetic config and an in-memory MCP connection.

/** Read access to the synthetic DEMO project. */
export const DEMO_READ: ProjectGrant = { id: '10000', key: 'DEMO' };

export function setup(projects: ProjectGrant[]) {
  const jira = createFakeJira();
  const config: Config = {
    version: 1,
    site: 'https://example.invalid',
    apiBaseUrl: 'https://example.invalid',
    email: FAKE_EMAIL,
    projects,
  };
  const client = createJiraClient({
    apiBaseUrl: config.apiBaseUrl,
    email: FAKE_EMAIL,
    token: FAKE_TOKEN,
    fetch: jira.fetch,
  });

  return { jira, context: { config, client } };
}

/** Calls a registered tool through an in-memory MCP connection and returns its text output. */
export async function callTool(
  jira: JiraContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerJiraTools(server, async () => jira);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}
