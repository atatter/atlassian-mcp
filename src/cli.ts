#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  configPath,
  deleteConfig,
  loadConfig,
  updateConfig,
  type Config,
  type ProjectGrant,
} from './config.ts';
import { redact, tokenEntry } from './credentials.ts';
import { clientFor } from './jira/client.ts';
import { createPrompter, type Prompter } from './prompt.ts';
import { serve } from './server.ts';
import { clientConfig, describeConfig, findProject, replaceToken, setup } from './setup.ts';

const USAGE = `Usage: atlassian-mcp <command>

  setup                   Connect to Jira Cloud and allow a first project
  status                  Show the setup and check the connection
  allow <KEY>             Allow reading a project
  deny <KEY>              Remove a project's access
  token                   Replace the stored API token
  client-config           Print the MCP client configuration
  reset                   Delete the stored token and settings
  serve                   Run the MCP server over stdio (MCP clients start this)`;

const cliPath = fileURLToPath(import.meta.url);
const print = (line: string) => console.log(line);

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;

  switch (values.help ? 'help' : command) {
    case undefined:
    case 'help':
      return print(USAGE);
    case 'serve':
      return serve();
    case 'setup':
      return withPrompter((prompt) => setup(prompt, print, cliPath));
    case 'status':
      return status(await requireConfig());
    case 'allow':
      return allow(await requireConfig(), argument(rest));
    case 'deny':
      return deny(await requireConfig(), argument(rest));
    case 'token': {
      const config = await requireConfig();
      return withPrompter((prompt) => replaceToken(prompt, print, config));
    }
    case 'client-config':
      return print(clientConfig(cliPath));
    case 'reset':
      return withPrompter(reset);
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

async function status(config: Config): Promise<void> {
  print(describeConfig(config));
  const me = await (await clientFor(config)).myself();
  print(`Connected as ${me.displayName}`);
}

async function allow(config: Config, key: string): Promise<void> {
  const project = await findProject(await clientFor(config), key);
  const grant: ProjectGrant = { id: project.id, key: project.key };

  await updateConfig(config, (latest) => ({
    ...latest,
    projects: [...latest.projects.filter((p) => p.id !== project.id), grant],
  }));
  print(`${project.key} (${project.name}): read`);
}

async function deny(config: Config, key: string): Promise<void> {
  const upper = key.toUpperCase();
  await updateConfig(config, (latest) => {
    const projects = latest.projects.filter((project) => project.key !== upper);
    if (projects.length === latest.projects.length) {
      throw new Error(
        `No grant is stored under ${upper}. \`atlassian-mcp status\` lists the stored project keys.`,
      );
    }

    return { ...latest, projects };
  });
  print(`${upper}: no access`);
}

async function reset(prompt: Prompter): Promise<void> {
  if (!existsSync(configPath())) {
    return print('Nothing to reset.');
  }

  // Invalid settings can still be deleted, but they no longer say which keychain entry is ours.
  const config = await loadConfig().catch(() => undefined);
  const question = `Delete the API token from the keychain and ${configPath()}?`;
  if (!(await prompt.confirm(question, false))) {
    return;
  }

  if (config) {
    await tokenEntry(config.site, config.email).deleteCredential();
  } else {
    print(
      'The settings were invalid, so remove any "atlassian-mcp" entry in Keychain Access yourself.',
    );
  }

  await deleteConfig();
  print('Deleted. MCP clients that still start the server will get errors until setup runs again.');
}

async function requireConfig(): Promise<Config> {
  const config = await loadConfig();
  if (!config) {
    throw new Error('Not set up yet. Run `atlassian-mcp setup`.');
  }

  return config;
}

function argument(rest: string[]): string {
  const [value] = rest;
  if (value === undefined) {
    throw new Error(`Missing project key.\n\n${USAGE}`);
  }

  return value;
}

async function withPrompter(run: (prompt: Prompter) => Promise<void>): Promise<void> {
  const prompt = createPrompter();
  try {
    await run(prompt);
  } finally {
    prompt.close();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(redact(error instanceof Error ? error.message : String(error), []));
  process.exitCode = 1;
});
