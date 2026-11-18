import { describe, expect, it } from 'vitest';
import { adfToText } from './adf.ts';
import { markdownToAdf } from './markdown.ts';

const text = (value: string, ...marks: object[]) =>
  marks.length > 0 ? { type: 'text', text: value, marks } : { type: 'text', text: value };
const paragraph = (...content: object[]) => ({ type: 'paragraph', content });
const item = (...content: object[]) => ({ type: 'listItem', content });

describe('markdownToAdf', () => {
  it('converts headings, paragraphs with line breaks, and code blocks', () => {
    const doc = markdownToAdf('## Steps\n\nFirst line\nsecond line\n\n```ts\nconst a = 1;\n```');
    expect(doc).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [text('Steps')] },
        paragraph(text('First line'), { type: 'hardBreak' }, text('second line')),
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1;')] },
      ],
    });
  });

  it('nests lists by indentation and tells numbered lists from bullets', () => {
    const doc = markdownToAdf('- one\n  1. inner\n  2. second\n- two');
    expect(doc.content).toEqual([
      {
        type: 'bulletList',
        content: [
          item(paragraph(text('one')), {
            type: 'orderedList',
            content: [item(paragraph(text('inner'))), item(paragraph(text('second')))],
          }),
          item(paragraph(text('two'))),
        ],
      },
    ]);
  });

  it('starts a new list when bullets turn into numbers, and keeps the first number', () => {
    const doc = markdownToAdf('- a\n3. b\n4. c');
    expect(doc.content).toEqual([
      { type: 'bulletList', content: [item(paragraph(text('a')))] },
      {
        type: 'orderedList',
        attrs: { order: 3 },
        content: [item(paragraph(text('b'))), item(paragraph(text('c')))],
      },
    ]);
  });

  it('keeps a list across blank lines and joins wrapped item lines', () => {
    const doc = markdownToAdf('- first\n  wrapped\n\n  - child\n\n- second\n\nAfter');
    expect(doc.content).toEqual([
      {
        type: 'bulletList',
        content: [
          item(paragraph(text('first'), { type: 'hardBreak' }, text('wrapped')), {
            type: 'bulletList',
            content: [item(paragraph(text('child')))],
          }),
          item(paragraph(text('second'))),
        ],
      },
      paragraph(text('After')),
    ]);
  });

  it('marks bold, italic, inline code and links', () => {
    const doc = markdownToAdf('**bold** *it* _also_ `code` [site](https://example.invalid)');
    expect(doc.content).toEqual([
      paragraph(
        text('bold', { type: 'strong' }),
        text(' '),
        text('it', { type: 'em' }),
        text(' '),
        text('also', { type: 'em' }),
        text(' '),
        text('code', { type: 'code' }),
        text(' '),
        text('site', { type: 'link', attrs: { href: 'https://example.invalid' } }),
      ),
    ]);
  });

  it('keeps parentheses inside a link target', () => {
    const href = 'https://example.invalid/wiki/Name_(term)';
    expect(markdownToAdf(`[w](${href}).`).content).toEqual([
      paragraph(text('w', { type: 'link', attrs: { href } }), text('.')),
    ]);
  });

  it('keeps unsafe links, snake_case and arithmetic as literal text', () => {
    const doc = markdownToAdf('[x](javascript:alert(1)) snake_case_name 2 * 3 * 4');
    expect(adfToText(doc)).toBe('[x](javascript:alert(1)) snake_case_name 2 * 3 * 4');
    expect(JSON.stringify(doc)).not.toContain('"marks"');
  });

  it('marks bold italic once per mark, and leaves numbered prose in its paragraph', () => {
    expect(markdownToAdf('***both*** *_one_*').content).toEqual([
      paragraph(
        text('both', { type: 'strong' }, { type: 'em' }),
        text(' '),
        text('one', { type: 'em' }),
      ),
    ]);
    expect(markdownToAdf('Shipped in\n2024. Then more').content).toEqual([
      paragraph(text('Shipped in'), { type: 'hardBreak' }, text('2024. Then more')),
    ]);
  });

  it('nests by depth even when indentation is uneven', () => {
    const doc = markdownToAdf('- a\n    - b\n  - c\n    - d');
    expect(doc.content).toEqual([
      {
        type: 'bulletList',
        content: [
          item(paragraph(text('a')), {
            type: 'bulletList',
            content: [
              item(paragraph(text('b'))),
              item(paragraph(text('c')), {
                type: 'bulletList',
                content: [item(paragraph(text('d')))],
              }),
            ],
          }),
        ],
      },
    ]);
  });

  it('never combines the code mark with bold, which ADF rejects', () => {
    const doc = markdownToAdf('**see `x`**');
    expect(doc.content).toEqual([
      paragraph(text('see ', { type: 'strong' }), text('x', { type: 'code' })),
    ]);
  });

  it('closes an unterminated code block at the end and emits no empty text', () => {
    expect(markdownToAdf('```\n').content).toEqual([{ type: 'codeBlock' }]);
    expect(markdownToAdf('```\nleft open').content).toEqual([
      { type: 'codeBlock', content: [text('left open')] },
    ]);
  });
});
