import * as z from 'zod';
import type { Config } from '../config.ts';
import { allows } from '../policy.ts';
import { JiraError, type JiraClient } from './client.ts';

// The deny-by-default gate every tool, read or write, goes through.

/** What every tool call works with. Loaded fresh per call so CLI permission changes apply at once. */
export type JiraContext = { config: Config; client: JiraClient };

export const IssueKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]*-[1-9]\d*$/, 'Expected an issue key such as PROJ-123.')
  .describe('Issue key, such as PROJ-123');

/** A call the configured policy forbids. */
export class AccessDenied extends Error {
  override name = 'AccessDenied';
}

/**
 * Fetches an issue and checks the project Jira resolved it to, before any of its data is used.
 * Moved issues resolve to their new project, so a key's prefix proves nothing.
 */
export function fetchAllowedIssue({ config, client }: JiraContext, key: string) {
  return loadAllowed(config, {
    notAllowed: `Issue ${key} was not found in a project this server may read. ${allowedProjects(config)}`,
    load: () => client.readIssue(key),
    projectId: (issue) => issue.fields.project.id,
  });
}

/**
 * The deny-by-default gate for anything a tool loads: no grants means no call to Jira, and the
 * project is the one Jira returned. Missing and forbidden resources answer alike, so the answer
 * doesn't reveal what exists elsewhere.
 */
export async function loadAllowed<T>(
  config: Config,
  gate: { notAllowed: string; load: () => Promise<T>; projectId: (resource: T) => string },
): Promise<T> {
  if (config.projects.length === 0) {
    throw new AccessDenied(noProjectsMessage);
  }

  const resource = await gate.load().catch((error: unknown) => {
    if (error instanceof JiraError && error.status === 404) {
      throw new AccessDenied(gate.notAllowed);
    }
    throw error;
  });

  if (!allows(config.projects, gate.projectId(resource))) {
    throw new AccessDenied(gate.notAllowed);
  }

  return resource;
}

export const noProjectsMessage =
  'No Jira projects are allowed. The user can allow one with `atlassian-mcp allow <KEY>`.';

export function allowedProjects(config: Config): string {
  return `Allowed: ${config.projects.map((project) => project.key).join(', ')}.`;
}
