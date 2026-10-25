import type { ProjectGrant } from './config.ts';

/**
 * Deny by default: a project is readable only through an explicit grant. Callers pass the project
 * ID that Jira returned for the resource, never one derived from model input such as an issue key
 * prefix.
 */
export function allows(grants: readonly ProjectGrant[], projectId: string): boolean {
  return grants.some((grant) => grant.id === projectId);
}
