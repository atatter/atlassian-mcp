import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';

/**
 * Read access to one project. Policy matches on the immutable project ID; the key is for display
 * and for `deny <KEY>`. Settings written by earlier versions may carry an `access` field, which is
 * ignored.
 */
const ProjectGrant = z.object({
  id: z.string().regex(/^\d+$/),
  key: z.string(),
});
export type ProjectGrant = z.infer<typeof ProjectGrant>;

/** The token is never part of the config; it lives in the OS keychain (see credentials.ts). */
export const Config = z.object({
  version: z.literal(1),
  site: z.url(),
  apiBaseUrl: z.url(),
  email: z.email(),
  projects: z.array(ProjectGrant),
});
export type Config = z.infer<typeof Config>;

/**
 * Settings live outside any repo. ATLASSIAN_MCP_CONFIG_DIR exists so tests never touch real
 * settings.
 */
function configDir(): string {
  return (
    process.env.ATLASSIAN_MCP_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'atlassian-mcp')
  );
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

/** Returns undefined when setup has not run yet. */
export async function loadConfig(): Promise<Config | undefined> {
  let text: string;
  try {
    text = await readFile(configPath(), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  const parsed = Config.safeParse(parseJson(text));
  if (!parsed.success) {
    throw new Error(
      `Settings at ${configPath()} are invalid. Run \`atlassian-mcp setup\` to replace them or \`atlassian-mcp reset\` to delete them.`,
    );
  }

  return parsed.data;
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const temp = `${configPath()}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(Config.parse(config), null, 2)}\n`, { mode: 0o600 });
  await rename(temp, configPath());
}

/**
 * Applies a change to the settings as they are right before writing, so a command that waited on
 * Jira or the user can't restore access another command revoked in the meantime. Refuses if the
 * connection the command worked with was replaced, since project IDs belong to one site.
 */
export async function updateConfig(
  base: Config,
  change: (latest: Config) => Config,
): Promise<void> {
  const latest = await loadConfig();
  if (latest?.site !== base.site || latest.email !== base.email) {
    throw new Error('The setup changed while this command ran. Nothing was saved; run it again.');
  }

  await saveConfig(change(latest));
}

export async function deleteConfig(): Promise<void> {
  await rm(configPath(), { force: true });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
