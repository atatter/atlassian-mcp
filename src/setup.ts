import * as z from 'zod';
import { loadConfig, saveConfig, updateConfig, type Config } from './config.ts';
import { tokenEntry } from './credentials.ts';
import { createJiraClient, type JiraClient } from './jira/client.ts';
import { normalizeSite, resolveApiBase } from './jira/connect.ts';
import type { Prompter } from './prompt.ts';

type Print = (line: string) => void;

const TOKEN_HELP = `Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens
A token with scopes needs read:jira-user and read:jira-work.
The token is stored in the OS keychain, never in a file.`;

/** Guided first-time setup: connection, token, one allowed project. Replaces any existing setup. */
export async function setup(prompt: Prompter, print: Print, cliPath: string): Promise<void> {
  print(`Connect atlassian-mcp to Jira Cloud.\n${TOKEN_HELP}\n`);

  // Invalid settings are replaced like missing ones; setup is how the user fixes them.
  let existing: Config | undefined;
  try {
    existing = await loadConfig();
  } catch {
    print(
      'The current settings are invalid and will be replaced. Remove any old "atlassian-mcp" entry in Keychain Access yourself.\n',
    );
  }

  if (existing) {
    print(`This replaces the current setup for ${existing.email} at ${existing.site}.\n`);
  }

  const site = normalizeSite(await prompt.ask('Jira site (for example your-team.atlassian.net): '));
  const email = z.email().safeParse(await prompt.ask('Atlassian account email: '));
  if (!email.success) {
    throw new Error('That is not an email address.');
  }

  const token = await askToken(prompt);

  print('Checking the connection…');
  const { apiBaseUrl, me } = await resolveApiBase(site, email.data, token);
  print(
    `Connected as ${me.displayName}${apiBaseUrl === site ? '' : ' (API token with scopes)'}.\n`,
  );

  const client = createJiraClient({ apiBaseUrl, email: email.data, token });
  const visible = await client.listProjects();
  print(`Projects this account can see${visible.length === 50 ? ' (first 50)' : ''}:`);
  for (const project of visible) {
    print(`  ${project.key.padEnd(12)} ${project.name}`);
  }

  const project = await findProject(client, await prompt.ask('\nProject key to allow reading: '));

  const config: Config = {
    version: 1,
    site,
    apiBaseUrl,
    email: email.data,
    projects: [{ id: project.id, key: project.key }],
  };
  print(`\nSummary\n${describeConfig(config)}`);
  if (!(await prompt.confirm('Save?', true))) {
    print('Nothing saved.');
    return;
  }

  // In this order, a failure at any step leaves no token from the previous valid settings or this
  // setup that the saved settings don't point to, so `reset` can find it.
  if (existing && (existing.site !== site || existing.email !== email.data)) {
    await tokenEntry(existing.site, existing.email).deleteCredential();
  }
  await saveConfig(config);
  await tokenEntry(site, email.data).setPassword(token);
  print(`\nSaved.\n\n${clientConfig(cliPath)}`);
}

/** Replaces the stored token after checking it against the configured site. */
export async function replaceToken(prompt: Prompter, print: Print, config: Config): Promise<void> {
  print(TOKEN_HELP);
  const token = await askToken(prompt);
  const { apiBaseUrl, me } = await resolveApiBase(config.site, config.email, token);

  // Settings first: this refuses if setup or reset replaced the connection while the user typed.
  await updateConfig(config, (latest) => ({ ...latest, apiBaseUrl }));
  await tokenEntry(config.site, config.email).setPassword(token);
  print(`Token saved. Connected as ${me.displayName}.`);
}

async function askToken(prompt: Prompter): Promise<string> {
  const token = await prompt.askSecret('API token (input hidden): ');
  if (!token) {
    throw new Error('No token entered.');
  }

  return token;
}

/** Looks a project up by key, so grants store Jira's immutable project ID. */
export async function findProject(client: JiraClient, input: string) {
  const key = input.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(`"${input}" is not a project key.`);
  }

  return client.getProject(key);
}

export function describeConfig(config: Config): string {
  const projects = config.projects.length
    ? config.projects.map((project) => `  ${project.key.padEnd(12)} read`).join('\n')
    : '  (none; every call is denied)';
  return `Site:     ${config.site}\nAccount:  ${config.email}\nProjects:\n${projects}`;
}

/** How to register the server with MCP clients, which then start it on demand. */
export function clientConfig(cliPath: string): string {
  const configDir = process.env.ATLASSIAN_MCP_CONFIG_DIR;
  const command = [process.execPath, cliPath, 'serve'].map(shellQuote).join(' ');
  const env = configDir ? `ATLASSIAN_MCP_CONFIG_DIR=${configDir}` : undefined;
  const json = {
    mcpServers: {
      atlassian: {
        command: process.execPath,
        args: [cliPath, 'serve'],
        ...(configDir ? { env: { ATLASSIAN_MCP_CONFIG_DIR: configDir } } : {}),
      },
    },
  };

  return [
    'Add the server to your MCP client. The client starts it when needed; no terminal has to stay open.',
    '',
    'Claude Code:',
    `  claude mcp add --scope user${env ? ` -e ${shellQuote(env)}` : ''} atlassian -- ${command}`,
    'Codex:',
    `  codex mcp add${env ? ` --env ${shellQuote(env)}` : ''} atlassian -- ${command}`,
    'Other clients:',
    JSON.stringify(json, null, 2),
  ].join('\n');
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
