import * as z from 'zod';

/** Atlassian Document Format: Jira Cloud's rich text for descriptions and comments. */
export const AdfNode = z.object({
  type: z.string(),
  text: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  get content() {
    return z.array(AdfNode).optional();
  },
});
export type AdfNode = z.infer<typeof AdfNode>;

// The ADF this package writes, from Markdown in markdown.ts. Jira Cloud REST v3 takes it for
// descriptions and comments; https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
export type Mark = { type: 'strong' | 'em' | 'code' } | { type: 'link'; attrs: { href: string } };
export type Inline = { type: 'text'; text: string; marks?: Mark[] } | { type: 'hardBreak' };
export type Block =
  | { type: 'paragraph'; content: Inline[] }
  | { type: 'heading'; attrs: { level: number }; content: Inline[] }
  | { type: 'codeBlock'; attrs?: { language: string }; content?: { type: 'text'; text: string }[] }
  | { type: 'bulletList'; content: ListItem[] }
  | { type: 'orderedList'; attrs?: { order: number }; content: ListItem[] };
export type ListItem = { type: 'listItem'; content: Block[] };
export type AdfDoc = { type: 'doc'; version: 1; content: Block[] };

/** Flattens ADF to plain text. Formatting is dropped; block nodes end with a newline. */
export function adfToText(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'inlineCard':
      return stringAttr(node, 'url');
    case 'mention':
    case 'emoji':
    case 'status':
      return stringAttr(node, 'text');
  }

  // Other leaves (dates, media, rules) carry no readable text.
  if (node.content === undefined) {
    return '';
  }

  const inner = node.content.map(adfToText).join('');
  if (node.type === 'doc') {
    return inner.trimEnd();
  }
  if (node.type === 'listItem') {
    return `- ${inner}`;
  }

  return inner.endsWith('\n') ? inner : `${inner}\n`;
}

function stringAttr(node: AdfNode, name: string): string {
  const value = node.attrs?.[name];
  return typeof value === 'string' ? value : '';
}
