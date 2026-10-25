import { expect, it } from 'vitest';
import { redact } from './credentials.ts';

/** A third party's Basic credential, as someone might paste a header into an issue. */
const BASIC = Buffer.from('someone@example.invalid:not-our-token').toString('base64');

it('masks a Basic header whose whitespace JSON has escaped', () => {
  for (const space of ['\n', '\t', '\f', '\v', '\u0000']) {
    expect(redact(JSON.stringify({ value: `Basic${space}${BASIC}` }), [])).toBe(
      '{"value":"[redacted]"}',
    );
  }
  // A backslash the user typed is escaped again, so it isn't taken for whitespace.
  expect(redact(JSON.stringify({ value: `Basic\\n${BASIC}` }), [])).toContain(BASIC);
});

it('masks Basic credentials whatever characters their base64 uses', () => {
  // Encodes to letters and "/" only: no digit, "+" or padding.
  const lettersOnly = Buffer.from('a@a.aa:aaaaaaaaaaaaaaaa?').toString('base64');
  expect(lettersOnly).toMatch(/^[A-Za-z/]+$/);
  expect(redact(`Basic ${lettersOnly}`, [])).toBe('[redacted]');
});

it('masks Basic credentials with text glued on or a non-ASCII password', () => {
  const credential = Buffer.from('someone@example.invalid:pa55word-xyz').toString('base64');
  expect(redact(`Basic ${credential}more`, [])).toBe('[redacted]');
  expect(redact(`Basic ${credential}/x`, [])).toBe('[redacted]');
  expect(redact(`Basic ${Buffer.from('user:pässwörd-long').toString('base64')}`, [])).toBe(
    '[redacted]',
  );
});

it('leaves ordinary words after "Basic" alone', () => {
  expect(redact('Basic Internationalization support', [])).toBe(
    'Basic Internationalization support',
  );
  expect(redact('Basic setup/configuration', [])).toBe('Basic setup/configuration');
  expect(redact('Basic Configuration=true', [])).toBe('Basic Configuration=true');
  const prose = JSON.stringify({ text: 'Basic\nconfiguration/setup steps' });
  expect(redact(prose, [])).toBe(prose);
});

it('masks exact secrets, their base64 form and token-shaped strings', () => {
  const secret = 'synthetic-secret-value';
  const tokenShaped = `ATATT${'x'.repeat(24)}`;
  const text = `a ${secret} b ${Buffer.from(secret).toString('base64')} c ${tokenShaped} d Basic ${BASIC}`;
  expect(redact(text, [secret])).toBe('a [redacted] b [redacted] c [redacted] d [redacted]');
});
