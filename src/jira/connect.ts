import * as z from 'zod';
import { createJiraClient, JiraError } from './client.ts';

/**
 * Turns "acme", "acme.atlassian.net" or a pasted Jira URL into a site origin. Plain http is
 * accepted only for loopback hosts, which the tests use for a local fake Jira.
 */
export function normalizeSite(input: string): string {
  const raw = input.trim();
  const withScheme = /^[a-z]+:\/\//i.test(raw)
    ? raw
    : `https://${raw.includes('.') ? raw : `${raw}.atlassian.net`}`;
  const url = URL.parse(withScheme);
  if (!url || url.username || url.password) {
    throw new Error(`"${raw}" is not a valid site URL.`);
  }

  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('The site must use https://.');
  }

  return url.origin;
}

const TenantInfo = z.object({ cloudId: z.guid() });

/**
 * Finds the API base URL that accepts this token. Classic API tokens work against the site
 * itself; API tokens with scopes only work through api.atlassian.com with the site's cloud ID.
 */
export async function resolveApiBase(
  site: string,
  email: string,
  token: string,
  fetchImpl = fetch,
) {
  try {
    const me = await createJiraClient({
      apiBaseUrl: site,
      email,
      token,
      fetch: fetchImpl,
    }).myself();
    return { apiBaseUrl: site, me };
  } catch (error) {
    if (!(error instanceof JiraError && error.status === 401)) {
      throw error;
    }
  }

  const response = await fetchImpl(`${site}/_edge/tenant_info`, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);
  const tenant = TenantInfo.safeParse(
    response?.ok ? await response.json().catch(() => undefined) : undefined,
  );
  if (!tenant.success) {
    throw new JiraError(401, 'Jira rejected the email and API token.');
  }

  const apiBaseUrl = `https://api.atlassian.com/ex/jira/${tenant.data.cloudId}`;
  const me = await createJiraClient({ apiBaseUrl, email, token, fetch: fetchImpl }).myself();
  return { apiBaseUrl, me };
}
