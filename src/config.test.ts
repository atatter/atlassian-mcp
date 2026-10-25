import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { configPath, loadConfig, saveConfig, updateConfig, type Config } from './config.ts';

const base: Config = {
  version: 1,
  site: 'https://one.example.invalid',
  apiBaseUrl: 'https://one.example.invalid',
  email: 'synthetic.user@example.invalid',
  projects: [
    { id: '10000', key: 'A' },
    { id: '10001', key: 'B' },
  ],
};
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atlassian-mcp-config-'));
  process.env.ATLASSIAN_MCP_CONFIG_DIR = dir;
});
afterEach(async () => {
  delete process.env.ATLASSIAN_MCP_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

it("applies a change to the latest settings, so a slow command can't restore a revoked grant", async () => {
  await saveConfig(base);
  // Another command revokes A while this one still holds the old snapshot.
  await saveConfig({ ...base, projects: base.projects.filter((project) => project.key !== 'A') });
  await updateConfig(base, (latest) => ({
    ...latest,
    projects: [...latest.projects, { id: '10002', key: 'C' }],
  }));
  expect((await loadConfig())?.projects.map((project) => project.key)).toEqual(['B', 'C']);
});

it('refuses to apply a change made for a different connection', async () => {
  await saveConfig({ ...base, site: 'https://two.example.invalid', projects: [] });
  await expect(updateConfig(base, (latest) => latest)).rejects.toThrow(/setup changed/);
  expect((await loadConfig())?.projects).toEqual([]);
});

it('reads grants from earlier settings as read access, and saves them without the old field', async () => {
  const earlier = { ...base, projects: [{ id: '10000', key: 'A', access: 'comment' }] };
  await writeFile(configPath(), JSON.stringify(earlier));
  const loaded = await loadConfig();
  expect(loaded?.projects).toEqual([{ id: '10000', key: 'A' }]);

  await saveConfig(loaded ?? base);
  expect(await readFile(configPath(), 'utf8')).not.toContain('access');
});
