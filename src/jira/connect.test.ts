import { describe, expect, it } from 'vitest';
import { FAKE_EMAIL, FAKE_TOKEN } from '../../test/fake-jira.ts';
import { normalizeSite, resolveApiBase } from './connect.ts';

describe('normalizeSite', () => {
  it('accepts short names, hosts and pasted URLs', () => {
    expect(normalizeSite('acme')).toBe('https://acme.atlassian.net');
    expect(normalizeSite('acme.atlassian.net')).toBe('https://acme.atlassian.net');
    expect(normalizeSite('https://acme.atlassian.net/browse/X-1')).toBe(
      'https://acme.atlassian.net',
    );
  });

  it('refuses plain http except on loopback, and embedded credentials', () => {
    expect(() => normalizeSite('http://acme.atlassian.net')).toThrow(/https/);
    expect(normalizeSite('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(() => normalizeSite('https://user:pass@acme.atlassian.net')).toThrow(/not a valid/);
  });
});

describe('resolveApiBase', () => {
  const cloudId = '11111111-2222-3333-4444-555555555555';
  const me = { accountId: 'synthetic', displayName: 'Synthetic User' };

  it('falls back to the api.atlassian.com gateway for API tokens with scopes', async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://acme.atlassian.net/rest/api/3/myself') {
        return Response.json({}, { status: 401 });
      }
      if (url === 'https://acme.atlassian.net/_edge/tenant_info') {
        return Response.json({ cloudId });
      }
      if (url === `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`) {
        return Response.json(me);
      }
      return Response.json({}, { status: 404 });
    };
    const result = await resolveApiBase(
      'https://acme.atlassian.net',
      FAKE_EMAIL,
      FAKE_TOKEN,
      fetchImpl,
    );
    expect(result).toEqual({ apiBaseUrl: `https://api.atlassian.com/ex/jira/${cloudId}`, me });
    expect(calls).toHaveLength(3);
  });

  it('reports rejected credentials when neither base accepts the token', async () => {
    const fetchImpl = async () => Response.json({}, { status: 401 });
    await expect(
      resolveApiBase('https://acme.atlassian.net', FAKE_EMAIL, FAKE_TOKEN, fetchImpl),
    ).rejects.toThrow(/rejected/);
  });
});
