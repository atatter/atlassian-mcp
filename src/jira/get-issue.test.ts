import { describe, expect, expectTypeOf, it } from 'vitest';
import { EXCLUDED, FAKE_EMAIL, FAKE_TOKEN } from '../../test/fake-jira.ts';
import { callTool, DEMO_READ, setup } from '../../test/harness.ts';
import { createJiraClient } from './client.ts';
import { GetIssueInput, getIssue } from './tools.ts';

describe('jira_get_issue fields', () => {
  it("answers what an issue's parent is, by key and link only", async () => {
    const { jira, context } = setup([DEMO_READ]);
    const output = await callTool(context, 'jira_get_issue', { issue: 'DEMO-1' });
    const answer = JSON.parse(output);
    expect(answer.parent).toEqual({
      key: 'SECRET-9',
      url: 'https://example.invalid/browse/SECRET-9',
    });
    expect(answer.links).toEqual([
      {
        relation: 'is blocked by',
        key: 'SECRET-1',
        url: 'https://example.invalid/browse/SECRET-1',
      },
      { relation: 'relates to', key: 'DEMO-5', url: 'https://example.invalid/browse/DEMO-5' },
    ]);
    expect(answer.subtasks).toEqual([
      { key: 'DEMO-6', url: 'https://example.invalid/browse/DEMO-6' },
    ]);
    // Nothing nested about the referenced issues, and no request beyond the one issue read.
    expect(output).not.toContain(EXCLUDED);
    expect(jira.requests).toEqual(['GET /rest/api/3/issue/DEMO-1?fields=*all&expand=names']);
  });

  it("lists the issue's other fields and returns the ones asked for", async () => {
    const { context } = setup([DEMO_READ]);
    const first = JSON.parse(await callTool(context, 'jira_get_issue', { issue: 'DEMO-1' }));
    expect(first.fields).toBeUndefined();
    expect(first.otherFields).toEqual([
      { id: 'customfield_10016', name: 'Story Points' },
      { id: 'customfield_10020', name: 'Sprint' },
      { id: 'customfield_10031', name: 'Picked Issue' },
      { id: 'customfield_10032', name: 'Team' },
      { id: 'customfield_10040', name: 'Long Notes' },
      { id: 'customfield_10060', name: 'Rich Notes' },
    ]);

    const ids = [
      'customfield_10016',
      'customfield_10020',
      'customfield_10030',
      'customfield_10031',
      'customfield_10032',
    ];
    const output = await callTool(context, 'jira_get_issue', {
      issue: 'DEMO-1',
      fields: [
        ...ids,
        'customfield_10040',
        'customfield_10050',
        'customfield_10060',
        'customfield_99999',
      ],
    });
    const second = JSON.parse(output);
    expect(second.fields).toEqual({
      customfield_10016: { name: 'Story Points', value: 5 },
      customfield_10020: { name: 'Sprint', value: ['Sprint 12'] },
      customfield_10030: { name: 'Parent Link', value: '[not shown: unsupported field format]' },
      customfield_10031: { name: 'Picked Issue', value: 'SECRET-1' },
      customfield_10032: { name: 'Team', value: 'Team Synthetic' },
      customfield_10040: {
        name: 'Long Notes',
        value: 'x'.repeat(2000),
        note: 'Truncated: showing 2000 of 5000 characters.',
      },
      customfield_10050: { name: 'Empty Field', value: null, note: 'Empty on this issue.' },
      customfield_10060: { name: 'Rich Notes', value: 'Rich text value' },
      customfield_99999: {
        value: null,
        note: 'Not a field on this issue. otherFields lists the ones it has.',
      },
    });
    // Parent Link isn't listed (its format can't be shown) but can still be asked for.
    expect(second.otherFields).toEqual([]);
    expect(output).not.toContain(EXCLUDED);
  });

  it('keeps the requested fields typed', async () => {
    const { context } = setup([DEMO_READ]);
    const input = GetIssueInput.parse({ issue: 'DEMO-1', fields: ['customfield_10016'] });
    const answer = await getIssue(context, input);
    expectTypeOf(answer.fields).not.toBeAny();
    expect(answer.fields?.['customfield_10016']?.value).toBe(5);
  });

  it('checks the resolved project before reading any requested field', async () => {
    const { context } = setup([DEMO_READ]);
    const output = await callTool(context, 'jira_get_issue', {
      issue: 'DEMO-2',
      fields: ['summary', 'customfield_10016'],
    });
    expect(output).toBe(
      'Issue DEMO-2 was not found in a project this server may read. Allowed: DEMO.',
    );
  });

  it('redacts a token held in a custom field or its name', async () => {
    const { jira, context } = setup([DEMO_READ]);
    const client = createJiraClient({
      apiBaseUrl: context.config.apiBaseUrl,
      email: FAKE_EMAIL,
      token: FAKE_TOKEN,
      fetch: async (input, init) => {
        const body = (await (await jira.fetch(input, init)).text())
          .replace('"Team Synthetic"', `"${FAKE_TOKEN}"`)
          .replace('"Story Points"', `"points ${FAKE_TOKEN}"`);
        return new Response(body);
      },
    });
    const output = await callTool({ ...context, client }, 'jira_get_issue', {
      issue: 'DEMO-1',
      fields: ['customfield_10032'],
    });
    expect(output).toContain('"value": "[redacted]"');
    expect(output).toContain('"name": "points [redacted]"');
    expect(output).not.toContain(FAKE_TOKEN);
  });

  it('redacts a token split across rich text before cutting a long field short', async () => {
    const { context } = setup([DEMO_READ]);
    const token = 'plain-classic-token-without-a-known-shape';
    const text = (value: string) => ({ type: 'text', text: value });
    // Cut at 2000 characters before redaction, this would keep the token's first 15 characters.
    const nodes = [
      text('x'.repeat(1985)),
      text(token.slice(0, 15)),
      text(token.slice(15)),
      text('y'.repeat(100)),
    ];
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: nodes }] };
    const issue = {
      id: '20001',
      key: 'DEMO-1',
      fields: { project: { id: '10000', key: 'DEMO' }, customfield_1: doc },
      names: {},
    };
    const client = createJiraClient({
      apiBaseUrl: context.config.apiBaseUrl,
      email: FAKE_EMAIL,
      token,
      fetch: async () => Response.json(issue),
    });
    const output = await callTool({ ...context, client }, 'jira_get_issue', {
      issue: 'DEMO-1',
      fields: ['customfield_1'],
    });
    expect(output).toContain('Truncated');
    expect(output).not.toContain(token.slice(0, 8));
  });

  it('bounds links and subtasks, and says so', async () => {
    const { context } = setup([DEMO_READ]);
    const ref = (index: number) => ({ key: `DEMO-${index + 100}`, fields: { summary: EXCLUDED } });
    const issuelinks = Array.from({ length: 60 }, (_, index) => ({
      type: { inward: 'in', outward: 'out' },
      outwardIssue: ref(index),
    }));
    const subtasks = Array.from({ length: 70 }, (_, index) => ref(index));
    const issue = {
      id: '20007',
      key: 'DEMO-7',
      fields: { project: { id: '10000', key: 'DEMO' }, issuelinks, subtasks },
      names: {},
    };
    const client = createJiraClient({
      apiBaseUrl: context.config.apiBaseUrl,
      email: FAKE_EMAIL,
      token: FAKE_TOKEN,
      fetch: async () => Response.json(issue),
    });
    const output = await callTool({ ...context, client }, 'jira_get_issue', { issue: 'DEMO-7' });
    const answer = JSON.parse(output);
    expect(answer.links).toHaveLength(50);
    expect(answer.subtasks).toHaveLength(50);
    expect(answer).toMatchObject({
      linksNote: 'Showing 50 of 60 links.',
      subtasksNote: 'Showing 50 of 70 subtasks.',
    });
    expect(output).not.toContain(EXCLUDED);
  });

  it("returns the same redacted text it measured, so redaction can't lift the length cap", async () => {
    const { context } = setup([DEMO_READ]);
    // A typed backslash-n before a third party's Basic credential with a long tail glued on: masked
    // when measured as a field, but not once serialized, where JSON doubles the backslash.
    const credential = Buffer.from('someone@example.invalid:not-our-toke').toString('base64');
    expect(credential).not.toContain('='); // no padding, so the tail joins the base64 run
    const value = `Basic\\n${credential}${'Q'.repeat(100_000)}`;
    const issue = {
      id: '20007',
      key: 'DEMO-7',
      fields: { project: { id: '10000', key: 'DEMO' }, customfield_1: value },
      names: {},
    };
    const client = createJiraClient({
      apiBaseUrl: context.config.apiBaseUrl,
      email: FAKE_EMAIL,
      token: FAKE_TOKEN,
      fetch: async () => Response.json(issue),
    });
    const output = await callTool({ ...context, client }, 'jira_get_issue', {
      issue: 'DEMO-7',
      fields: ['customfield_1'],
    });
    expect(output.length).toBeLessThan(5000);
  });

  it('answers that an issue has no parent', async () => {
    const { context } = setup([DEMO_READ]);
    const issue = {
      id: '20007',
      key: 'DEMO-7',
      fields: { project: { id: '10000', key: 'DEMO' } },
      names: {},
    };
    const client = createJiraClient({
      apiBaseUrl: context.config.apiBaseUrl,
      email: FAKE_EMAIL,
      token: FAKE_TOKEN,
      fetch: async () => Response.json(issue),
    });
    const answer = JSON.parse(
      await callTool({ ...context, client }, 'jira_get_issue', { issue: 'DEMO-7' }),
    );
    expect(answer).toMatchObject({
      key: 'DEMO-7',
      parent: null,
      links: [],
      subtasks: [],
      otherFields: [],
    });
  });

  it('shows only the parent key in search results', async () => {
    const { context } = setup([DEMO_READ]);
    const output = await callTool(context, 'jira_search_issues', {});
    expect(JSON.parse(output).issues).toMatchObject([{ key: 'DEMO-1', parent: 'SECRET-9' }]);
    expect(output).not.toContain(EXCLUDED);
  });

  it("rejects field IDs that aren't IDs before any request", () => {
    expect(
      GetIssueInput.safeParse({ issue: 'DEMO-1', fields: ['customfield_1&expand=x'] }).success,
    ).toBe(false);
    expect(
      GetIssueInput.safeParse({
        issue: 'DEMO-1',
        fields: Array.from({ length: 21 }, (_, i) => `f${i}`),
      }).success,
    ).toBe(false);
  });
});
