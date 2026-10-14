import { closesFence, fenceMark, type Fence } from "../internals/model";

export type CommandId =
  | "emphasis"
  | "strong"
  | "inline-code"
  | "link"
  | "picture"
  | "subsection"
  | "lower-subsection"
  | "bullet"
  | "numbered"
  | "quotation"
  | "code-block"
  | "footnote";

export type MarkupCommand = {
  id: CommandId;
  name: string;
  /** What the command inserts, shown on the menu and the reminder page. */
  inserts: string;
  accelerator?: string;
};

export const COMMANDS: MarkupCommand[] = [
  { id: "emphasis", name: "Emphasis", inserts: "*…* around the selection", accelerator: "CmdOrCtrl+I" },
  { id: "strong", name: "Strong", inserts: "**…** around the selection", accelerator: "CmdOrCtrl+B" },
  { id: "inline-code", name: "Inline code", inserts: "`…` around the selection", accelerator: "CmdOrCtrl+E" },
  { id: "link", name: "Link", inserts: "[selection](url)" },
  { id: "picture", name: "Picture", inserts: "![selection](images/file){width=100%}, and moves that file into the book" },
  { id: "subsection", name: "Subsection", inserts: "# at the start of the current line" },
  { id: "lower-subsection", name: "Lower subsection", inserts: "## at the start of the current line" },
  { id: "bullet", name: "Bullet list", inserts: "- at the start of the current line" },
  { id: "numbered", name: "Numbered list", inserts: "1. at the start of the current line" },
  { id: "quotation", name: "Quotation", inserts: "> at the start of the current line" },
  {
    id: "code-block",
    name: "Code block",
    inserts: "A fenced block around the selection, with a blank line before and after",
  },
  {
    id: "footnote",
    name: "Footnote",
    inserts: "[^n] at the cursor, and a matching definition at the end of the section",
  },
];

export type EditResult = {
  text: string;
  anchor: number;
  head: number;
};

export type TextSpan = {
  from: number;
  to: number;
  insert: string;
};

/**
 * The shortest edit that turns `before` into `after`.
 * Replacing the whole document maps the editor's scroll anchor to the start.
 */
export function changedSpan(before: string, after: string): TextSpan {
  const from = commonPrefix(before, after);
  const tail = commonSuffix(before, after, from);
  return { from, to: before.length - tail, insert: after.slice(from, after.length - tail) };
}

function commonPrefix(before: string, after: string): number {
  const limit = Math.min(before.length, after.length);
  let index = 0;
  while (index < limit && before[index] === after[index]) index += 1;
  return index;
}

function commonSuffix(before: string, after: string, prefix: number): number {
  const limit = Math.min(before.length, after.length) - prefix;
  let index = 0;
  while (index < limit && tailMatches(before, after, index)) index += 1;
  return index;
}

function tailMatches(before: string, after: string, index: number): boolean {
  return before[before.length - 1 - index] === after[after.length - 1 - index];
}

function clamp(text: string, index: number): number {
  return Math.max(0, Math.min(index, text.length));
}

function rangeOf(text: string, anchor: number, head: number): { start: number; end: number; head: number } {
  const a = clamp(text, anchor);
  const h = clamp(text, head);
  return { start: Math.min(a, h), end: Math.max(a, h), head: h };
}

function wrap(text: string, anchor: number, head: number, open: string, close: string): EditResult {
  const { start, end } = rangeOf(text, anchor, head);
  const selected = text.slice(start, end);
  const next = text.slice(0, start) + open + selected + close + text.slice(end);
  if (selected.length === 0) {
    const cursor = start + open.length;
    return { text: next, anchor: cursor, head: cursor };
  }
  const cursor = start + open.length + selected.length + close.length;
  return { text: next, anchor: cursor, head: cursor };
}

function lineStart(text: string, index: number): number {
  const at = clamp(text, index);
  return text.lastIndexOf("\n", at - 1) + 1;
}

function prefixLine(text: string, anchor: number, head: number, prefix: string): EditResult {
  const { head: cursor } = rangeOf(text, anchor, head);
  const start = lineStart(text, cursor);
  const next = text.slice(0, start) + prefix + text.slice(start);
  const shift = prefix.length;
  const placed = cursor + shift;
  return { text: next, anchor: clamp(next, shiftedAnchor(anchor, start, shift)), head: placed };
}

/** The anchor moves with the prefix only when it sits on the prefixed line. */
function shiftedAnchor(anchor: number, start: number, shift: number): number {
  if (anchor >= start) return anchor + shift;
  return anchor;
}

function ensureBlankBefore(text: string, index: number): { text: string; index: number } {
  if (index === 0) return { text: "\n" + text, index: 1 };
  const before = text.slice(0, index);
  if (before.endsWith("\n\n")) return { text, index };
  if (before.endsWith("\n")) return { text: before + "\n" + text.slice(index), index: index + 1 };
  return { text: before + "\n\n" + text.slice(index), index: index + 2 };
}

function insertCodeBlock(text: string, anchor: number, head: number, language: string): EditResult {
  const { start, end } = rangeOf(text, anchor, head);
  const selected = text.slice(start, end);
  let working = text;
  let at = start;
  const blanked = ensureBlankBefore(working, at);
  working = blanked.text;
  at = blanked.index;
  const endShift = at - start;
  const selectedEnd = end + endShift;
  const info = language;
  const interior = selected.length === 0 ? "\n" : selected.endsWith("\n") ? selected : selected + "\n";
  const fence = "```" + info + "\n" + interior + "```\n\n";
  const next = working.slice(0, at) + fence + working.slice(selectedEnd);
  if (!info) {
    const cursor = at + 3;
    return { text: next, anchor: cursor, head: cursor };
  }
  const inside = selected.length === 0 ? at + 3 + info.length + 1 : at + 3 + info.length + 1 + selected.length;
  return { text: next, anchor: inside, head: inside };
}

function nextFootnoteNumber(text: string): number {
  const used = new Set<number>();
  for (const match of text.matchAll(/^\[\^(\d+)\]:/gm)) {
    used.add(Number.parseInt(match[1], 10));
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

function insertFootnote(text: string, anchor: number, head: number): EditResult {
  const cursor = rangeOf(text, anchor, head).head;
  const n = nextFootnoteNumber(text);
  const ref = `[^${n}]`;
  let next = text.slice(0, cursor) + ref + text.slice(cursor);
  if (!next.endsWith("\n")) next += "\n";
  if (!next.endsWith("\n\n")) next += "\n";
  const definition = `[^${n}]: `;
  const headAt = next.length + definition.length;
  next += definition;
  return { text: next, anchor: headAt, head: headAt };
}

function markdownDestination(relative: string): string {
  const clean = relative.replace(/[\r\n]/g, "");
  if (clean === "" || /[\s()]/.test(clean)) return `<${clean.replace(/[<>]/g, "")}>`;
  return clean;
}

function insertPicture(text: string, anchor: number, head: number, relative: string): EditResult {
  const { start, end } = rangeOf(text, anchor, head);
  const caption = text.slice(start, end).replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
  const mark = `![${caption}](${markdownDestination(relative)}){width=100%}`;
  const next = text.slice(0, start) + mark + text.slice(end);
  if (caption.length === 0) {
    const cursor = start + 2;
    return { text: next, anchor: cursor, head: cursor };
  }
  const cursor = start + mark.length;
  return { text: next, anchor: cursor, head: cursor };
}

export function applyCommand(
  id: CommandId,
  text: string,
  anchor: number,
  head: number,
  language = "",
  picturePath = "",
): EditResult {
  switch (id) {
    case "emphasis":
      return wrap(text, anchor, head, "*", "*");
    case "strong":
      return wrap(text, anchor, head, "**", "**");
    case "inline-code":
      return wrap(text, anchor, head, "`", "`");
    case "link":
      return wrap(text, anchor, head, "[", "](url)");
    case "picture":
      if (!picturePath) return { text, anchor, head };
      return insertPicture(text, anchor, head, picturePath);
    case "subsection":
      return prefixLine(text, anchor, head, "# ");
    case "lower-subsection":
      return prefixLine(text, anchor, head, "## ");
    case "bullet":
      return prefixLine(text, anchor, head, "- ");
    case "numbered":
      return prefixLine(text, anchor, head, "1. ");
    case "quotation":
      return prefixLine(text, anchor, head, "> ");
    case "code-block":
      return insertCodeBlock(text, anchor, head, language);
    case "footnote":
      return insertFootnote(text, anchor, head);
  }
}

/** Language tag of the last fenced block in tree order. An empty tag wins when it is last. */
export function latestLanguage(bodies: string[]): string {
  let seen = false;
  let language = "";
  for (const body of bodies) {
    let fence: Fence | null = null;
    for (const line of body.split("\n")) {
      const mark = fenceMark(line);
      if (!mark) continue;
      if (!fence) {
        fence = { char: mark.char, len: mark.len };
        seen = true;
        language = mark.info.trim().split(/\s+/)[0] ?? "";
        continue;
      }
      if (closesFence(fence, mark)) fence = null;
    }
  }
  return seen ? language : "";
}
