import { describe, expect, it } from 'vitest';
import type { JsonValue } from './client.ts';
import { displayValue, fieldEntry as entry, otherFields } from './fields.ts';

const keep = (text: string) => text;
const fieldEntry = (id: string, values: Record<string, JsonValue>, names: Record<string, string>) =>
  entry(id, values, names, keep);

describe('displayValue', () => {
  it("keeps scalars and reads labels from Jira's common object shapes", () => {
    expect(displayValue(5)).toBe(5);
    expect(displayValue('2026-01-01')).toBe('2026-01-01');
    expect(
      displayValue({
        accountId: 'a1',
        displayName: 'Synthetic Person',
        emailAddress: 'p@example.invalid',
      }),
    ).toBe('Synthetic Person');
    expect(displayValue({ self: 's', id: '1', value: 'High' })).toBe('High');
    expect(displayValue([{ name: 'Sprint 12', goal: 'nested' }, { name: 'Sprint 13' }])).toEqual([
      'Sprint 12',
      'Sprint 13',
    ]);
    expect(displayValue({ filename: 'notes.txt', size: 10, author: { displayName: 'x' } })).toBe(
      'notes.txt',
    );
    expect(
      displayValue({
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rich' }] }],
      }),
    ).toBe('Rich');
  });

  it('reduces anything that references an issue to its key', () => {
    const nested = { id: '1', key: 'SECRET-1', self: 's', fields: { summary: 'hidden' } };
    expect(displayValue(nested)).toBe('SECRET-1');
    expect(displayValue([nested])).toEqual(['SECRET-1']);
  });

  it("doesn't show objects it has no label for, however their details are nested", () => {
    const unsupported = '[not shown: unsupported field format]';
    expect(displayValue({ data: { key: 'SECRET-9', summary: 'hidden' } })).toBe(unsupported);
    expect(displayValue({ originalEstimate: '1d', summary: 'hidden' })).toBe(unsupported);
    // Lists inside lists aren't shown, so only a field's top-level list can be shortened, with a note.
    expect(displayValue([[Array.from({ length: 60 }, (_, index) => index)]])).toEqual([
      unsupported,
    ]);
  });
});

describe('fieldEntry', () => {
  const names = {
    customfield_1: 'Points',
    customfield_2: 'Empty',
    customfield_3: 'Long',
    customfield_4: 'Many',
  };
  const values = {
    customfield_1: 3,
    customfield_2: null,
    timetracking: {},
    customfield_3: 'y'.repeat(2500),
    customfield_4: Array.from({ length: 60 }, (_, index) => index),
  };

  it('tells empty, unknown and shortened values apart', () => {
    expect(fieldEntry('customfield_1', values, names)).toEqual({ name: 'Points', value: 3 });
    expect(fieldEntry('customfield_2', values, names)).toEqual({
      name: 'Empty',
      value: null,
      note: 'Empty on this issue.',
    });
    expect(fieldEntry('customfield_9', values, names)).toEqual({
      value: null,
      note: 'Not a field on this issue. otherFields lists the ones it has.',
    });
    expect(fieldEntry('customfield_3', values, names)).toEqual({
      name: 'Long',
      value: 'y'.repeat(2000),
      note: 'Truncated: showing 2000 of 2500 characters.',
    });
    expect(fieldEntry('customfield_4', values, names)).toMatchObject({
      note: 'Showing the first 50 of 60 items.',
    });
    expect(fieldEntry('timetracking', values, names)).toEqual({
      value: null,
      note: 'Empty on this issue.',
    });
    // Judged on the whole list, not on the first 50 items shown.
    const late = [...Array.from({ length: 50 }, () => null), 'present'];
    expect(fieldEntry('late', { late }, {})).toMatchObject({
      note: 'Showing the first 50 of 51 items.',
    });
    expect(otherFields({ late }, {}, new Set(), keep)).toEqual({ fields: [{ id: 'late' }] });
    const blank = {
      doc: { type: 'doc', version: 1, content: [] },
      label: { name: '' },
      list: [null, ''],
    };
    for (const id of Object.keys(blank)) {
      expect(fieldEntry(id, blank, {})).toEqual({ value: null, note: 'Empty on this issue.' });
    }
    // Names on Object.prototype are not fields.
    expect(fieldEntry('constructor', values, names)).toEqual({
      value: null,
      note: 'Not a field on this issue. otherFields lists the ones it has.',
    });
  });

  it('lists only fields whose values can be shown', () => {
    const system = {
      watches: { self: 's', watchCount: 1, isWatching: false },
      worklog: { total: 0, worklogs: [] },
      customfield_8: [{ x: 1 }, { y: 2 }],
      customfield_9: [[1]],
      customfield_10: { type: 'doc', version: 1, content: [] },
      customfield_11: [null],
      customfield_1: 3,
    };
    expect(otherFields(system, {}, new Set(), keep)).toEqual({ fields: [{ id: 'customfield_1' }] });
  });

  it('redacts a name before shortening it', () => {
    // Token-shaped, assembled so the source holds no token-shaped literal for the secret scan.
    const name = `${'x'.repeat(90)}${['ATATT', '1234567890abcdefghijklmnop'].join('')}`;
    const maskToken = (text: string) => text.replace(/ATATT\w+/g, '[redacted]');
    const points = { customfield_1: 3 };
    expect(otherFields(points, { customfield_1: name }, new Set(), maskToken).fields[0]?.name).toBe(
      `${'x'.repeat(90)}[redacted]`,
    );
    expect(entry('customfield_1', points, { customfield_1: name }, maskToken).name).toBe(
      `${'x'.repeat(90)}[redacted]`,
    );
  });

  it('bounds the list of other fields and long names, and says so', () => {
    const many = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [`customfield_${index}`, index]),
    );
    const listed = otherFields(many, { customfield_0: 'n'.repeat(300) }, new Set(), keep);
    expect(listed.fields).toHaveLength(100);
    expect(listed.fields[0]).toEqual({ id: 'customfield_0', name: `${'n'.repeat(100)}…` });
    expect(listed.note).toBe('Showing 100 of 120 other fields.');
    expect(fieldEntry('customfield_0', many, { customfield_0: 'n'.repeat(300) }).name).toBe(
      `${'n'.repeat(100)}…`,
    );
  });

  it('lists other non-empty fields by ID and name', () => {
    expect(otherFields(values, names, new Set(['customfield_3']), keep)).toEqual({
      fields: [
        { id: 'customfield_1', name: 'Points' },
        { id: 'customfield_4', name: 'Many' },
      ],
    });
  });
});
