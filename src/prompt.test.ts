import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPrompter } from './prompt.ts';

// Readline only handles editing keys such as Ctrl-U and Ctrl-Y for a capable terminal type.
beforeEach(() => {
  vi.stubEnv('TERM', 'xterm-256color');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it('keeps a hidden answer out of the terminal and its history', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => {
    shown += chunk;
  });
  const prompt = createPrompter(input, output);

  const secret = prompt.askSecret('Token: ');
  input.write('synthetic-secret\r');
  expect(await secret).toBe('synthetic-secret');

  // Up arrow recalls history in a terminal; the secret must not come back.
  const next = prompt.ask('Key: ');
  input.write('\u001b[A\r');
  expect(await next).toBe('');
  prompt.close();
  expect(shown).toContain('Token: ');
  expect(shown).not.toContain('synthetic-secret');
});

it('never echoes a secret that arrives early, pasted with an earlier answer or typed ahead', async () => {
  for (const [first, rest] of [
    ['a@example.invalid\rsynthetic-secret\r', ''],
    ['a@example.invalid\rsynthetic-', 'secret\r'],
  ]) {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    let shown = '';
    output.on('data', (chunk: Buffer) => {
      shown += chunk;
    });
    const prompt = createPrompter(input, output);

    const email = prompt.ask('Email: ');
    input.write(first);
    expect(await email).toBe('a@example.invalid');
    const secret = prompt.askSecret('Token: ');
    input.write(rest);
    expect(await secret).toBe('synthetic-secret');
    prompt.close();
    expect(shown).toContain('Token: ');
    expect(shown).not.toContain('synthetic-');
  }
});

it("doesn't redraw a partial secret pasted ahead behind a visible prompt", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => {
    shown += chunk;
  });
  const prompt = createPrompter(input, output);

  const site = prompt.ask('Site: ');
  input.write('acme\ra@example.invalid\rsynthetic-');
  expect(await site).toBe('acme');
  expect(await prompt.ask('Email: ')).toBe('a@example.invalid');
  const secret = prompt.askSecret('Token: ');
  input.write('secret\r');
  expect(await secret).toBe('synthetic-secret');
  prompt.close();
  expect(shown).toContain('Email: ');
  expect(shown).not.toContain('synthetic-');
});

it("can't paste a secret back from readline's kill ring at a later prompt", async () => {
  for (const kill of ['\u0015', `${'\u001b[D'.repeat(4)}\u000b`]) {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    let shown = '';
    output.on('data', (chunk: Buffer) => {
      shown += chunk;
    });
    const prompt = createPrompter(input, output);

    // Ctrl-U (or Ctrl-K after moving left) deletes a wrong paste into the kill ring.
    const secret = prompt.askSecret('Token: ');
    input.write(`synthetic-secret${kill}`);
    input.write(kill === '\u0015' ? 'good\r' : '\u0015good\r');
    expect(await secret).toBe('good');
    // Ctrl-Y at a visible prompt would paste the deleted text back.
    const key = prompt.ask('Key: ');
    input.write('\u0019DEMO\r');
    expect(await key).toBe('DEMO');
    prompt.close();
    expect(shown).not.toContain('synthetic-');
  }
});
