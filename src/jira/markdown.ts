import type { AdfDoc, Block, Inline, ListItem, Mark } from './adf.ts';

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const LIST_START = /^\s*(?:[-*+]|1[.)])\s+/;

/**
 * Converts the Markdown agents write to ADF: paragraphs, headings, bullet and numbered lists
 * (nested by indentation), fenced code blocks, links, bold, italic and inline code. Anything
 * else stays as literal text. Line breaks inside a paragraph are kept.
 */
export function markdownToAdf(markdown: string): AdfDoc {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const content: Block[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const fence = FENCE.exec(line);
    const heading = HEADING.exec(line);

    if (line.trim() === '') {
      index += 1;
    } else if (fence) {
      const end = lines.findIndex((next, at) => at > index && next.trim() === '```');
      const stop = end === -1 ? lines.length : end;
      content.push(codeBlock(lines.slice(index + 1, stop).join('\n'), fence[1] ?? ''));
      index = stop + 1;
    } else if (heading) {
      content.push({
        type: 'heading',
        attrs: { level: heading[1]?.length ?? 1 },
        content: inline(heading[2] ?? ''),
      });
      index += 1;
    } else if (LIST_ITEM.test(line)) {
      const run = takeList(lines, index);
      content.push(...lists(run.items));
      index = run.end;
    } else {
      const text = takeWhile(
        lines,
        index,
        (next) => next.trim() !== '' && !interruptsParagraph(next),
      );
      content.push({ type: 'paragraph', content: inline(text.join('\n')) });
      index += text.length;
    }
  }

  return { type: 'doc', version: 1, content };
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || LIST_ITEM.test(line);
}

/** As in CommonMark, only a numbered list starting at 1 ends a paragraph, so "in\n2024. Then" stays text. */
function interruptsParagraph(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || LIST_START.test(line);
}

function takeWhile(lines: string[], from: number, keep: (line: string) => boolean): string[] {
  const end = lines.findIndex((line, at) => at >= from && !keep(line));
  return lines.slice(from, end === -1 ? lines.length : end);
}

/**
 * The list that starts at `from`. Blank lines between items keep it going, and an indented line
 * of text right after an item continues that item on a new line.
 */
function takeList(lines: string[], from: number): { items: ListLine[]; end: number } {
  const items: ListLine[] = [];
  let end = from;
  for (let at = from; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    const last = items.at(-1);
    if (line.trim() === '') {
      continue;
    }
    if (LIST_ITEM.test(line)) {
      items.push(listLine(line));
    } else if (last && at === end && /^\s/.test(line) && !startsBlock(line)) {
      last.text += `\n${line.trim()}`;
    } else {
      break;
    }
    end = at + 1;
  }

  return { items, end };
}

function codeBlock(code: string, language: string): Block {
  return {
    type: 'codeBlock',
    ...(language ? { attrs: { language } } : {}),
    // ADF rejects empty text nodes.
    ...(code ? { content: [{ type: 'text', text: code }] } : {}),
  };
}

type ListLine = { indent: number; ordered: boolean; number: number; text: string };
type ListRun = { ordered: boolean; start: number; items: { text: string; children: ListLine[] }[] };

function listLine(line: string): ListLine {
  const [, indent = '', marker = '', text = ''] = LIST_ITEM.exec(line) ?? [];
  const ordered = /\d/.test(marker);
  return {
    indent: indent.replaceAll('\t', '  ').length,
    ordered,
    number: ordered ? Number.parseInt(marker, 10) : 1,
    text,
  };
}

/**
 * Lines indented deeper than the shallowest one belong to a nested list under the item above
 * them. Switching between bullets and numbers at the same depth starts a new list.
 */
function lists(lines: ListLine[]): Block[] {
  const base = lines.reduce((least, line) => Math.min(least, line.indent), Infinity);
  const runs: ListRun[] = [];
  for (const line of lines) {
    const run = runs.at(-1);
    const item = run?.items.at(-1);
    if (item && line.indent > base) {
      item.children.push(line);
    } else if (run?.ordered === line.ordered) {
      run.items.push({ text: line.text, children: [] });
    } else {
      runs.push({
        ordered: line.ordered,
        start: line.number,
        items: [{ text: line.text, children: [] }],
      });
    }
  }

  return runs.map(listBlock);
}

/** An ordered list keeps its first number, so `3.` renders as 3 rather than 1. */
function listBlock({ ordered, start, items }: ListRun): Block {
  const content: ListItem[] = items.map((item) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: inline(item.text) }, ...lists(item.children)],
  }));
  if (!ordered) {
    return { type: 'bulletList', content };
  }

  return { type: 'orderedList', ...(start === 1 ? {} : { attrs: { order: start } }), content };
}

/**
 * Inline code, bold italic, bold, links, then italic with `*` or `_`. Underscores inside words, as in
 * snake_case, stay literal. A link target may hold one level of parentheses, as Wikipedia's do.
 */
const INLINE =
  /`(?<code>[^`\n]+)`|\*\*\*(?<both>.+?)\*\*\*|\*\*(?<bold>.+?)\*\*|\[(?<label>[^\]\n]+)\]\((?<href>(?:[^()\s]|\([^()\s]*\))+)\)|(?<![\w*])\*(?![\s*])(?<star>.+?)(?<![\s*])\*(?![\w*])|(?<![\w_])_(?![\s_])(?<underscore>.+?)(?<![\s_])_(?![\w_])/g;

/** Link targets Jira can safely render; anything else stays as literal text. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;

function inline(text: string): Inline[] {
  const nodes: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    nodes.push(...plain(text.slice(last, match.index)));
    nodes.push(...styled(match));
    last = match.index + match[0].length;
  }
  nodes.push(...plain(text.slice(last)));

  return nodes;
}

function styled(match: RegExpExecArray): Inline[] {
  const { code, both, bold, label, href, star, underscore } = match.groups ?? {};
  if (code !== undefined) {
    return [{ type: 'text', text: code, marks: [{ type: 'code' }] }];
  }
  if (both !== undefined) {
    return withMark(withMark(inline(both), { type: 'strong' }), { type: 'em' });
  }
  if (bold !== undefined) {
    return withMark(inline(bold), { type: 'strong' });
  }
  if (label !== undefined && href !== undefined) {
    return SAFE_HREF.test(href)
      ? withMark(inline(label), { type: 'link', attrs: { href } })
      : plain(match[0]);
  }

  return withMark(inline(star ?? underscore ?? ''), { type: 'em' });
}

/**
 * ADF allows the code mark only alongside a link, so other marks skip code text. A mark the text
 * already has, as in `*_x_*`, isn't added twice.
 */
function withMark(nodes: Inline[], mark: Mark): Inline[] {
  return nodes.map((node) => {
    if (node.type === 'hardBreak') {
      return node;
    }

    const marks = node.marks ?? [];
    const skip = mark.type === 'link' ? [mark.type] : [mark.type, 'code'];
    if (marks.some((existing) => skip.includes(existing.type))) {
      return node;
    }

    return { ...node, marks: [...marks, mark] };
  });
}

function plain(text: string): Inline[] {
  return text.split('\n').flatMap((part, at) => {
    const nodes: Inline[] = at > 0 ? [{ type: 'hardBreak' }] : [];
    return part ? [...nodes, { type: 'text', text: part }] : nodes;
  });
}
