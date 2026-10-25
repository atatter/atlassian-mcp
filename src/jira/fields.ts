import { AdfNode, adfToText } from './adf.ts';
import type { JsonValue } from './client.ts';

/** A field value as the agent sees it: scalars and lists only, never a nested object. */
export type Display = string | number | boolean | null | Display[];

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const LABELS = ['displayName', 'name', 'value', 'filename'];
const UNSUPPORTED = '[not shown: unsupported field format]';
const MAX_ITEMS = 50;
const MAX_CHARS = 2000;
const MAX_NAME_CHARS = 100;
const MAX_OTHER_FIELDS = 100;

/**
 * Turns one Jira field value into something readable without echoing arbitrary nested data. An
 * object becomes a single label: the key of an issue it references (that issue's other details
 * may belong to a denied project), rich text as plain text, or its display name, name, value or
 * filename. Any other object, and any list inside a list, is not shown. Values can still say
 * anything a user typed into them.
 */
export function displayValue(value: JsonValue): Display {
  return display(value, false);
}

function display(value: JsonValue, inList: boolean): Display {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return inList ? UNSUPPORTED : value.slice(0, MAX_ITEMS).map((item) => display(item, true));
  }

  const key = value.key;
  if (typeof key === 'string' && ISSUE_KEY.test(key)) {
    return key;
  }

  if (value.type === 'doc') {
    const doc = AdfNode.safeParse(value);
    return doc.success ? adfToText(doc.data) : UNSUPPORTED;
  }

  for (const name of LABELS) {
    const label = value[name];
    if (typeof label === 'string') {
      return label;
    }
  }

  return UNSUPPORTED;
}

type FieldEntry = { name?: string; value: Display; note?: string };

/**
 * A requested field, saying explicitly when it is empty, unknown or cut short. `redact` runs on
 * the complete text before it is cut, since rich text joined from fragments can form a token
 * that a cut would leave unrecognisable.
 */
export function fieldEntry(
  id: string,
  values: Record<string, JsonValue>,
  names: Record<string, string>,
  redact: (text: string) => string,
): FieldEntry {
  const name = own(names, id);
  const raw = own(values, id);
  if (raw === undefined && name === undefined) {
    return { value: null, note: 'Not a field on this issue. otherFields lists the ones it has.' };
  }

  const named = name === undefined ? {} : { name: shorten(redact(name)) };
  if (raw === undefined || isEmpty(raw) || displayedItems(raw).every(isBlank)) {
    return { ...named, value: null, note: 'Empty on this issue.' };
  }

  const value = displayValue(raw);
  const notes =
    Array.isArray(raw) && raw.length > MAX_ITEMS
      ? [`Showing the first ${MAX_ITEMS} of ${raw.length} items.`]
      : [];

  // A string is returned as the redacted text that was measured. Lists are measured as JSON, the
  // form the final redaction of the tool output sees, and returned as lists when they fit.
  const text = redact(typeof value === 'string' ? value : JSON.stringify(value));
  if (text.length > MAX_CHARS) {
    notes.push(`Truncated: showing ${MAX_CHARS} of ${text.length} characters.`);
    return { ...named, value: text.slice(0, MAX_CHARS), note: notes.join(' ') };
  }

  return {
    ...named,
    value: typeof value === 'string' ? text : value,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

/**
 * The issue's non-empty fields the answer doesn't already show and whose values can be shown,
 * by ID and name, for the agent to request. Names are redacted before they are shortened.
 */
export function otherFields(
  values: Record<string, JsonValue>,
  names: Record<string, string>,
  shown: ReadonlySet<string>,
  redact: (text: string) => string,
) {
  const ids = Object.entries(values)
    .filter(
      ([id, value]) =>
        !shown.has(id) &&
        !isEmpty(value) &&
        displayedItems(value).some((part) => !isBlank(part) && part !== UNSUPPORTED),
    )
    .map(([id]) => id);

  const fields = ids.slice(0, MAX_OTHER_FIELDS).map((id) => {
    const name = own(names, id);
    return name === undefined ? { id } : { id, name: shorten(redact(name)) };
  });

  return ids.length > fields.length
    ? { fields, note: `Showing ${fields.length} of ${ids.length} other fields.` }
    : { fields };
}

/** Own properties only: a field ID such as "constructor" must not find Object.prototype. */
function own<T>(record: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(record, id) ? record[id] : undefined;
}

/**
 * A field's displayed items, all of them rather than the first ones shown, to judge whether it has
 * anything readable.
 */
function displayedItems(raw: JsonValue): Display[] {
  return Array.isArray(raw) ? raw.map((item) => display(item, true)) : [displayValue(raw)];
}

/** A displayed value with nothing to read: an empty rich-text doc, empty label, blank items. */
function isBlank(value: Display): boolean {
  return value === null || value === '' || (Array.isArray(value) && value.every(isBlank));
}

function shorten(name: string): string {
  return name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS)}…` : name;
}

function isEmpty(value: JsonValue): boolean {
  if (value === null || value === '') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return typeof value === 'object' && Object.keys(value).length === 0;
}
