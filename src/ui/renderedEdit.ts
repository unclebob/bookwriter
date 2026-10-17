/** A keystroke in the rendered screen, named the way the browser names it. */
export type RenderedInput =
  | { kind: "insert"; text: string }
  | { kind: "backspace"; word: boolean }
  | { kind: "delete"; word: boolean }
  | { kind: "cut" }
  | { kind: "undo" }
  | { kind: "redo" };

export type TextEdit = Exclude<RenderedInput, { kind: "undo" } | { kind: "redo" }>;

/** The splice a rendered keystroke makes in a markdown body. */
export type SourceChange = {
  body: string;
  caret: number;
  from: number;
  to: number;
  insert: string;
};

type Span = { from: number; to: number; insert: string };

type Direction = 1 | -1;

const NAMED: Record<string, RenderedInput> = {
  historyUndo: { kind: "undo" },
  historyRedo: { kind: "redo" },
  deleteContentBackward: { kind: "backspace", word: false },
  deleteWordBackward: { kind: "backspace", word: true },
  deleteContentForward: { kind: "delete", word: false },
  deleteWordForward: { kind: "delete", word: true },
  deleteByCut: { kind: "cut" },
};

/** The edit named by a browser input type. `paragraph` is what Enter inserts. */
export function renderedInput(type: string, data: string | null, paragraph: string): RenderedInput | null {
  const named = NAMED[type];
  if (named) return named;
  return typedInsert(type, data, paragraph);
}

function typedInsert(type: string, data: string | null, paragraph: string): RenderedInput | null {
  const text = insertedText(type, data, paragraph);
  if (text == null) return null;
  return { kind: "insert", text };
}

function insertedText(type: string, data: string | null, paragraph: string): string | null {
  if (type === "insertParagraph") return paragraph;
  if (type === "insertLineBreak") return "\n";
  if (insertsData(type)) return data;
  return null;
}

function insertsData(type: string): boolean {
  return type === "insertText" || type === "insertFromPaste" || type === "insertReplacementText";
}

/**
 * Splice `input` into `body` at the caret. Offsets are source characters.
 * A selection is the range between anchor and head. Bytes outside that range stay.
 */
export function applyRenderedInput(body: string, anchor: number, head: number, input: TextEdit): SourceChange {
  const from = clampOffset(body, Math.min(anchor, head));
  const to = clampOffset(body, Math.max(anchor, head));
  return applySpan(body, editSpan(body, from, to, input));
}

function editSpan(body: string, from: number, to: number, input: TextEdit): Span {
  if (input.kind === "insert") return { from, to, insert: input.text };
  if (input.kind === "cut" || from !== to) return { from, to, insert: "" };
  if (input.kind === "backspace") return backSpan(body, from, input.word);
  return forwardSpan(body, from, input.word);
}

function backSpan(body: string, at: number, word: boolean): Span {
  return { from: backFrom(body, at, word), to: at, insert: "" };
}

function backFrom(body: string, at: number, word: boolean): number {
  if (word) return wordEdge(body, at, -1);
  return Math.max(0, at - 1);
}

function forwardSpan(body: string, at: number, word: boolean): Span {
  return { from: at, to: forwardTo(body, at, word), insert: "" };
}

function forwardTo(body: string, at: number, word: boolean): number {
  if (word) return wordEdge(body, at, 1);
  return Math.min(body.length, at + 1);
}

function wordEdge(body: string, at: number, dir: Direction): number {
  return skipWord(body, skipSpace(body, at, dir), dir);
}

function skipSpace(body: string, at: number, dir: Direction): number {
  let index = at;
  while (onSpace(body, index, dir)) index += dir;
  return index;
}

function skipWord(body: string, at: number, dir: Direction): number {
  let index = at;
  while (onWord(body, index, dir)) index += dir;
  return index;
}

function onSpace(body: string, index: number, dir: Direction): boolean {
  return isClass(body, stepIndex(index, dir), (char) => /\s/.test(char));
}

function onWord(body: string, index: number, dir: Direction): boolean {
  return isClass(body, stepIndex(index, dir), (char) => !/\s/.test(char));
}

function stepIndex(index: number, dir: Direction): number {
  if (dir === -1) return index - 1;
  return index;
}

function isClass(body: string, index: number, test: (char: string) => boolean): boolean {
  if (index < 0 || index >= body.length) return false;
  return test(body[index]);
}

function applySpan(body: string, span: Span): SourceChange {
  const next = body.slice(0, span.from) + span.insert + body.slice(span.to);
  return { body: next, caret: span.from + span.insert.length, from: span.from, to: span.to, insert: span.insert };
}

function clampOffset(body: string, offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.min(body.length, Math.trunc(offset)));
}

type VisibleRun = { src: number; text: string; block?: boolean };

/** True when `offset` sits in a fenced or indented code run, including its edges. */
export function inBlock(runs: VisibleRun[], offset: number): boolean {
  return runs.some((run) => coversBlock(run, offset));
}

function coversBlock(run: VisibleRun, offset: number): boolean {
  return run.block === true && offset >= run.src && offset <= run.src + run.text.length;
}

/**
 * Where to draw a caret for a source offset.
 * An offset inside a run uses that run. An offset in the markup between runs
 * uses the nearest visible edge. Ties keep the earlier run.
 */
export function caretLocal(runs: VisibleRun[], offset: number): { src: number; local: number } | null {
  let best: { src: number; local: number; dist: number } | null = null;
  for (const run of runs) {
    const placed = placeInRun(run.src, run.src + run.text.length, offset);
    if (placed.dist === 0) return { src: run.src, local: placed.local };
    best = preferCloser(best, run.src, placed);
  }
  return droppedDist(best);
}

function placeInRun(src: number, end: number, offset: number): { local: number; dist: number } {
  if (offset <= src) return { local: 0, dist: src - offset };
  if (offset >= end) return { local: end - src, dist: offset - end };
  return { local: offset - src, dist: 0 };
}

function preferCloser(
  best: { src: number; local: number; dist: number } | null,
  src: number,
  placed: { local: number; dist: number },
): { src: number; local: number; dist: number } {
  if (best && best.dist <= placed.dist) return best;
  return { src, local: placed.local, dist: placed.dist };
}

function droppedDist(best: { src: number; local: number; dist: number } | null): { src: number; local: number } | null {
  if (!best) return null;
  return { src: best.src, local: best.local };
}
