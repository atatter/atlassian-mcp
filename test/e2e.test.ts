import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { tokenEntry } from '../src/credentials.ts';
import { createFakeJira, EXCLUDED, FAKE_EMAIL, FAKE_TOKEN, listen } from './fake-jira.ts';

// Runs the built CLI (`pnpm build` first) against a loopback fake Jira, the real OS keychain and a
// temporary settings folder. The keychain entry uses synthetic credentials and is deleted afterwards.

const CLI = join(import.meta.dirname, '../dist/cli.js');
const jira = createFakeJira();
const secretForms = [FAKE_TOKEN, Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString('base64')];
let configDir: string;
let site: string;
let http: Server;
let client: Client;
let serverStderr = '';

function runCli(args: string[], input = ''): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, ATLASSIAN_MCP_CONFIG_DIR: configDir },
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk;
  });
  child.stdin.end(input);
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, output })));
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  return { isError: result.isError === true, text };
}

function expectNoSecret(text: string) {
  for (const secret of secretForms) {
    expect(text).not.toContain(secret);
  }
}

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'atlassian-mcp-e2e-'));
  ({ url: site, server: http } = await listen(jira.handle));
});

afterAll(async () => {
  await client?.close();
  http?.close();
  await tokenEntry(site, FAKE_EMAIL).deleteCredential();
  await rm(configDir, { recursive: true, force: true });
});

describe('built CLI and stdio server', () => {
  it('sets up with the token in the keychain and nowhere else', async () => {
    const answers = [site, FAKE_EMAIL, FAKE_TOKEN, 'demo', 'y'].join('\n');
    const { code, output } = await runCli(['setup'], `${answers}\n`);
    expect(output).toContain('Connected as Synthetic User');
    expect(output).toMatch(/DEMO\s+read/);
    expect(code).toBe(0);
    expectNoSecret(output);

    expect(await tokenEntry(site, FAKE_EMAIL).getPassword()).toBe(FAKE_TOKEN);
    for (const file of await readdir(configDir)) {
      expectNoSecret(await readFile(join(configDir, file), 'utf8'));
    }
  });

  it.runIf(process.platform === 'darwin')(
    'stores the token in the macOS login keychain',
    async () => {
      const found = await promisify(execFile)('security', [
        'find-generic-password',
        '-s',
        'atlassian-mcp',
        '-a',
        `${FAKE_EMAIL} ${site}`,
      ]);
      expect(found.stdout).toContain('"svce"<blob>="atlassian-mcp"');
      expectNoSecret(found.stdout);
    },
  );

  it('starts over stdio and lists the three Jira tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'serve'],
      env: { ...getDefaultEnvironment(), ATLASSIAN_MCP_CONFIG_DIR: configDir },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      serverStderr += chunk;
    });
    client = new Client({ name: 'e2e', version: '0.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      'jira_get_issue',
      'jira_search_issues',
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('enforces read-only project policy on every call', async () => {
    const search = await call('jira_search_issues', { jql: 'x) OR (project = SECRET' });
    const { issues } = z
      .object({ issues: z.array(z.object({ key: z.string() })) })
      .parse(JSON.parse(search.text));
    expect(issues.map((issue) => issue.key)).toEqual(['DEMO-1']);

    expect(await call('jira_get_issue', { issue: 'DEMO-1' })).toMatchObject({ isError: false });
    expect(await call('jira_get_issue', { issue: 'SECRET-1' })).toMatchObject({ isError: true });
    expect(await call('jira_get_issue', { issue: 'DEMO-2' })).toMatchObject({ isError: true });
    expect(await call('jira_get_issue', { issue: '../myself' })).toMatchObject({ isError: true });
    // There is no write tool to call: the attempt fails however the SDK reports an unknown tool.
    const write = client.callTool({
      name: 'jira_add_comment',
      arguments: { issue: 'DEMO-1', body: 'hi' },
    });
    expect(
      await write.then(
        (result) => result.isError === true,
        () => true,
      ),
    ).toBe(true);
    expect(
      jira.requests.filter(
        (request) =>
          !request.startsWith('GET ') && !request.startsWith('POST /rest/api/3/search/jql'),
      ),
    ).toEqual([]);
  });

  it('offers field selection over stdio and answers with references and requested fields', async () => {
    const { tools } = await client.listTools();
    const getIssue = tools.find((tool) => tool.name === 'jira_get_issue');
    expect(Object.keys(getIssue?.inputSchema.properties ?? {}).toSorted()).toEqual([
      'fields',
      'issue',
    ]);

    const result = await call('jira_get_issue', { issue: 'DEMO-1', fields: ['customfield_10016'] });
    expect(result.isError).toBe(false);
    const answer = z
      .object({
        parent: z.object({ key: z.string() }),
        fields: z.record(z.string(), z.object({ name: z.string(), value: z.unknown() })),
        otherFields: z.array(z.object({ id: z.string() })),
      })
      .parse(JSON.parse(result.text));
    expect(answer.parent.key).toBe('SECRET-9');
    expect(answer.fields).toEqual({ customfield_10016: { name: 'Story Points', value: 5 } });
    expect(answer.otherFields.map((field) => field.id)).toContain('customfield_10020');
    expect(result.text).not.toContain(EXCLUDED);
  });

  it('redacts credentials echoed by Jira and fails closed on malformed responses', async () => {
    const echoed = await call('jira_get_issue', { issue: 'DEMO-4' });
    expect(echoed.isError).toBe(true);
    expectNoSecret(echoed.text);
    expect(await call('jira_get_issue', { issue: 'DEMO-3' })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/unexpected format/),
    });
  });

  it('applies CLI permission changes to the running server', async () => {
    expect((await runCli(['deny', 'DEMO'])).code).toBe(0);
    expect(await call('jira_get_issue', { issue: 'DEMO-1' })).toMatchObject({ isError: true });
    expect(await call('jira_search_issues', {})).toMatchObject({ isError: true });

    expect((await runCli(['allow', 'DEMO'])).code).toBe(0);
    expect(await call('jira_get_issue', { issue: 'DEMO-1' })).toMatchObject({ isError: false });
    expect(await call('jira_get_issue', { issue: 'DEMO-2' })).toMatchObject({ isError: true });

    expect((await runCli(['deny', 'DEMO'])).code).toBe(0);
  });

  it('keeps the token out of server diagnostics', () => {
    for (const secret of secretForms) {
      expect(serverStderr).not.toContain(secret);
    }
  });

  it('reset deletes the keychain entry and settings', async () => {
    const { code, output } = await runCli(['reset'], 'y\n');
    expect(code).toBe(0);
    expectNoSecret(output);
    expect(await tokenEntry(site, FAKE_EMAIL).getPassword()).toBeNull();
    expect(await readdir(configDir)).toEqual([]);
    expect(await call('jira_get_issue', { issue: 'DEMO-1' })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/not set up/),
    });
  });

  it('token refuses to write the keychain after reset ran while it waited', async () => {
    const answers = [site, FAKE_EMAIL, FAKE_TOKEN, 'demo', 'y'].join('\n');
    expect((await runCli(['setup'], `${answers}\n`)).code).toBe(0);

    const child = spawn(process.execPath, [CLI, 'token'], {
      env: { ...process.env, ATLASSIAN_MCP_CONFIG_DIR: configDir },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
    await vi.waitFor(() => expect(output).toContain('API token (input hidden):'));

    expect((await runCli(['reset'], 'y\n')).code).toBe(0);
    child.stdin.end(`${FAKE_TOKEN}\n`);
    expect(await exited).toBe(1);
    expect(output).toContain('The setup changed while this command ran');
    expect(await tokenEntry(site, FAKE_EMAIL).getPassword()).toBeNull();
  });

  it('recovers from invalid settings with reset', async () => {
    expect((await runCli(['reset'])).output).toContain('Nothing to reset.');
    await writeFile(join(configDir, 'config.json'), '{ not json');
    const status = await runCli(['status']);
    expect(status.code).toBe(1);
    expect(status.output).toMatch(
      /invalid\. Run `atlassian-mcp setup` to replace them or `atlassian-mcp reset`/,
    );
    const { code, output } = await runCli(['reset'], 'y\n');
    expect(code).toBe(0);
    expect(output).toContain('remove any "atlassian-mcp" entry in Keychain Access yourself');
    expect(await readdir(configDir)).toEqual([]);
  });
});
