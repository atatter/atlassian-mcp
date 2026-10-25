import { expect, it } from 'vitest';
import { adfToText } from './adf.ts';

it('flattens paragraphs, lists, mentions and line breaks to text', () => {
  const text = (value: string) => ({ type: 'text', text: value });
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          text('Hello '),
          { type: 'mention', attrs: { text: '@Sam' } },
          { type: 'hardBreak' },
          text('next'),
        ],
      },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [text('one')] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [text('two')] }] },
        ],
      },
      { type: 'rule' },
    ],
  };
  expect(adfToText(doc)).toBe('Hello @Sam\nnext\n- one\n- two');
});
