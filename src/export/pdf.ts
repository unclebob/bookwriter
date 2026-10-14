import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import type { Fs } from "../internals/book";
import { CHAPTER_NUMBER_CLASS, PAGE_BREAK_CLASS, exportNoteGroups, type ChapterExport } from "./export";
import type { TreeNode } from "../internals/model";
import { bookPicturePath } from "../internals/pictures";
import { joinPath } from "../internals/path";
import { encodeImage, type EncodeOptions, type PdfImage } from "./pdfimage";

/**
 * PDF export. The book is exported to manuscript Markdown exactly as the Markdown
 * export does, parsed with the same Markdown dialect the preview uses, then laid
 * out on US Letter pages with the PDF standard fonts. Body text is Helvetica, code
 * is Courier, and pictures are embedded. The result is plain ASCII (picture data is
 * ASCII85 text), so it can be saved through the same text writer as every other export.
 */

export type PdfResult = { pdf: string; pages: number; warnings: string[] };

/** One picture that was read (or could not be) before layout started. */
export type Picture = { image: PdfImage } | { error: string };
export type Pictures = Map<string, Picture>;

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 72;
const FOOTER_Y = 40;
const TEXT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const BOTTOM = MARGIN;
const CONTENT_HEIGHT = PAGE_HEIGHT - 2 * MARGIN;

/** F1 Helvetica, F2 Helvetica-Bold, F3 Courier, F4 Helvetica-Oblique, F5 Helvetica-BoldOblique, F6 Symbol. */
type FontKey = "F1" | "F2" | "F3" | "F4" | "F5" | "F6";

const FONT_NAMES: Record<FontKey, string> = {
  F1: "Helvetica",
  F2: "Helvetica-Bold",
  F3: "Courier",
  F4: "Helvetica-Oblique",
  F5: "Helvetica-BoldOblique",
  F6: "Symbol",
};

// Advance widths for ASCII 32..126, in 1/1000 em. Oblique faces share the upright widths.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611,
  556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389,
  280, 389, 584,
];

const WIN_ANSI: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

/** Horizontal, vertical, ├-shape, and └-shape box drawing. Other U+2500–U+257F characters become +. */
const BOX_HORIZONTAL = new Set([0x2500, 0x2501, 0x2504, 0x2505, 0x2508, 0x2509, 0x254c, 0x254d, 0x2550]);
const BOX_VERTICAL = new Set([0x2502, 0x2503, 0x2506, 0x2507, 0x250a, 0x250b, 0x254e, 0x254f, 0x2551]);
const BOX_FORK = new Set([0x251c, 0x2523, 0x2560]);
const BOX_ELBOW = new Set([0x2514, 0x2517, 0x255a]);

function boxDiagonal(cp: number): number | undefined {
  if (cp === 0x2571) return 0x2f;
  if (cp === 0x2572) return 0x5c;
  if (cp === 0x2573) return 0x78;
  return undefined;
}

/**
 * One ASCII column for a box-drawing character. The standard fonts have no such glyphs.
 * ├── is drawn as |-- and └── as `--, and a run of ─ is a run of hyphens.
 */
function boxAscii(cp: number): number | undefined {
  if (cp < 0x2500 || cp > 0x257f) return undefined;
  if (BOX_HORIZONTAL.has(cp)) return 0x2d;
  if (BOX_VERTICAL.has(cp) || BOX_FORK.has(cp)) return 0x7c;
  if (BOX_ELBOW.has(cp)) return 0x60;
  return boxDiagonal(cp) ?? 0x2b;
}

function markByte(cp: number): number | undefined {
  if (cp === 0x276f) return 0x9b; // ❯ the prompt angle, drawn as ›
  if (cp === 0x23fa) return 0x95; // ⏺ the reply mark, drawn as •
  if (cp === 0x23bf) return 0x60; // ⎿ the result elbow, drawn as `
  if (cp === 0x2212) return 0x2d; // − minus sign, drawn as -
  if (cp === 0x2011) return 0x2d; // ‑ non-breaking hyphen, drawn as -
  return undefined;
}

/** WinAnsi byte for one character, or null when the standard fonts cannot show it as itself. */
function winAnsiByte(cp: number): number | null {
  const drawn = boxAscii(cp) ?? markByte(cp);
  if (drawn !== undefined) return drawn;
  if (cp === 9) return 32;
  if (cp >= 32 && cp <= 126) return cp;
  if (cp >= 160 && cp <= 255) return cp;
  const mapped = WIN_ANSI[cp];
  return mapped === undefined ? null : mapped;
}

/** ⁰ and ⁴–⁹ have no superscript glyph in the text fonts. The digit is drawn smaller and raised. */
function raisedDigit(cp: number): number | undefined {
  if (cp === 0x2070) return 0x30;
  if (cp >= 0x2074 && cp <= 0x2079) return 0x30 + (cp - 0x2070);
  return undefined;
}

/** Map text to single-byte WinAnsi codes; anything outside that set becomes "?". A tab is one space here; code expands tabs first. */
function encode(text: string): number[] {
  const codes: number[] = [];
  for (const char of text.normalize("NFC")) codes.push(winAnsiByte(char.codePointAt(0)!) ?? 63);
  return codes;
}

function hasUnshownCharacter(text: string): boolean {
  for (const char of text.normalize("NFC")) {
    const cp = char.codePointAt(0)!;
    if (cp === 10 || cp === 13 || cp === 0x03c0 || cp === 0x03a0 || cp === 0x2265) continue;
    if (raisedDigit(cp) !== undefined) continue;
    if (winAnsiByte(cp) === null) return true;
  }
  return false;
}

/** Replace tabs with spaces up to the next multiple of `stop` columns, so indentation lines up. */
export function expandTabs(line: string, stop = 4): string {
  let out = "";
  let column = 0;
  for (const char of line) {
    if (char === "\t") {
      const spaces = stop - (column % stop);
      out += " ".repeat(spaces);
      column += spaces;
    } else {
      out += char;
      column += 1;
    }
  }
  return out;
}

function pdfString(codes: number[]): string {
  let out = "(";
  for (const code of codes) {
    if (code === 40 || code === 41 || code === 92) out += "\\" + String.fromCharCode(code);
    else if (code < 32 || code > 126) out += "\\" + code.toString(8).padStart(3, "0");
    else out += String.fromCharCode(code);
  }
  return out + ")";
}

function glyphWidth(code: number, font: FontKey): number {
  if (font === "F3") return 600;
  if (font === "F6") return code === 0x70 ? 549 : code === 0x50 ? 614 : 556;
  const table = font === "F2" || font === "F5" ? HELVETICA_BOLD : HELVETICA;
  return code >= 32 && code <= 126 ? table[code - 32] : 556;
}

function textWidth(codes: number[], font: FontKey, size: number): number {
  let sum = 0;
  for (const code of codes) sum += glyphWidth(code, font);
  return (sum * size) / 1000;
}

/** Text in one font. Spaces inside a `nobreak` run never start a new line (code spans). */
type Run = { text: string; font: FontKey; nobreak?: boolean };
type Piece = { codes: number[]; font: FontKey; rise?: number; scale?: number };

function pieceWidth(piece: Piece, size: number): number {
  return textWidth(piece.codes, piece.font, size * (piece.scale ?? 1));
}

function linePieceWidth(pieces: Piece[], size: number): number {
  return pieces.reduce((sum, piece) => sum + pieceWidth(piece, size), 0);
}

function append(line: Piece[], piece: Piece): void {
  const last = line[line.length - 1];
  if (last && last.font === piece.font && last.rise === piece.rise && last.scale === piece.scale) {
    last.codes.push(...piece.codes);
  } else line.push({ codes: [...piece.codes], font: piece.font, rise: piece.rise, scale: piece.scale });
}

type Glyph = { code: number; font: FontKey; rise?: number; scale?: number };

/** Characters of one run. Pi uses Symbol. A missing superscript digit is a raised digit. */
function glyphs(text: string, font: FontKey): Glyph[] {
  const out: Glyph[] = [];
  for (const char of text.normalize("NFC")) {
    const cp = char.codePointAt(0)!;
    const digit = raisedDigit(cp);
    if (digit !== undefined) {
      out.push({ code: digit, font, rise: 0.35, scale: 0.6 });
      continue;
    }
    if (cp === 0x03c0) {
      out.push({ code: 0x70, font: "F6" });
      continue;
    }
    if (cp === 0x03a0) {
      out.push({ code: 0x50, font: "F6" });
      continue;
    }
    // ≥ has no glyph in the text fonts. Symbol draws it at byte 0xB3.
    if (cp === 0x2265) {
      out.push({ code: 0xb3, font: "F6" });
      continue;
    }
    out.push({ code: winAnsiByte(cp) ?? 63, font });
  }
  return out;
}

type Token = { space: Piece } | { word: Piece[] };

function finishWord(line: Token[], word: Piece[]): Piece[] {
  if (word.length) line.push({ word });
  return [];
}

function breakSpace(glyph: Glyph, run: Run): boolean {
  return glyph.code === 32 && !run.nobreak && glyph.rise === undefined && glyph.font === run.font;
}

function addSpace(tokens: Token[], font: FontKey): void {
  const last = tokens[tokens.length - 1];
  if (tokens.length > 0 && !(last && "space" in last)) tokens.push({ space: { codes: [32], font } });
}

function samePiece(tail: Piece, glyph: Glyph): boolean {
  return tail.font === glyph.font && tail.rise === glyph.rise && tail.scale === glyph.scale;
}

function addGlyph(word: Piece[], glyph: Glyph): void {
  const tail = word[word.length - 1];
  if (tail && samePiece(tail, glyph)) tail.codes.push(glyph.code);
  else word.push({ codes: [glyph.code], font: glyph.font, rise: glyph.rise, scale: glyph.scale });
}

function takeGlyph(lines: Token[][], word: Piece[], glyph: Glyph, run: Run): Piece[] {
  if (!breakSpace(glyph, run)) {
    addGlyph(word, glyph);
    return word;
  }
  const next = finishWord(lines[lines.length - 1], word);
  addSpace(lines[lines.length - 1], run.font);
  return next;
}

function takePart(lines: Token[][], word: Piece[], part: string, run: Run, broken: boolean): Piece[] {
  if (broken) {
    word = finishWord(lines[lines.length - 1], word);
    lines.push([]);
  }
  for (const glyph of glyphs(part, run.font)) word = takeGlyph(lines, word, glyph, run);
  return word;
}

function tokenizeRun(lines: Token[][], word: Piece[], run: Run): Piece[] {
  const parts = run.text.split("\n");
  for (let index = 0; index < parts.length; index++) word = takePart(lines, word, parts[index], run, index > 0);
  return word;
}

function trimLineSpaces(lines: Token[][]): void {
  for (const tokens of lines) {
    while (tokens.length && "space" in tokens[tokens.length - 1]) tokens.pop();
  }
}

/** Cut runs into words and the spaces between them, one list per hard line break. */
function tokenize(runs: Run[]): Token[][] {
  const lines: Token[][] = [[]];
  let word: Piece[] = [];
  for (const run of runs) word = tokenizeRun(lines, word, run);
  finishWord(lines[lines.length - 1], word);
  trimLineSpaces(lines);
  return lines;
}

type LineBuf = { pieces: Piece[]; width: number };

function blankLine(): LineBuf {
  return { pieces: [], width: 0 };
}

function appendWord(line: LineBuf, word: Piece[]): void {
  for (const piece of word) append(line.pieces, piece);
}

// A word wider than a whole line: cut it wherever it reaches the edge.
function cutLongWord(word: Piece[], size: number, width: number): Piece[][] {
  const lines: Piece[][] = [];
  let pieces: Piece[] = [];
  let used = 0;
  for (const piece of word) {
    for (const code of piece.codes) {
      const w = textWidth([code], piece.font, size * (piece.scale ?? 1));
      if (used + w > width && used > 0) {
        lines.push(pieces);
        pieces = [];
        used = 0;
      }
      append(pieces, { codes: [code], font: piece.font, rise: piece.rise, scale: piece.scale });
      used += w;
    }
  }
  lines.push(pieces);
  return lines;
}

function placeFitted(out: Piece[][], word: Piece[], size: number, width: number): LineBuf {
  if (linePieceWidth(word, size) <= width) {
    const line = blankLine();
    appendWord(line, word);
    line.width = linePieceWidth(word, size);
    return line;
  }
  const parts = cutLongWord(word, size, width);
  const last = parts.pop() ?? [];
  out.push(...parts);
  return { pieces: last, width: linePieceWidth(last, size) };
}

function putWord(out: Piece[][], line: LineBuf, gap: Piece | null, word: Piece[], size: number, width: number): LineBuf {
  const wordWidth = linePieceWidth(word, size);
  const spacing = gap ? pieceWidth(gap, size) : 0;
  if (line.pieces.length > 0 && line.width + spacing + wordWidth <= width) {
    if (gap) append(line.pieces, gap);
    appendWord(line, word);
    line.width += spacing + wordWidth;
    return line;
  }
  if (line.pieces.length > 0) out.push(line.pieces);
  return placeFitted(out, word, size, width);
}

function wrapTokens(tokens: Token[], size: number, width: number): Piece[][] {
  const out: Piece[][] = [];
  let line = blankLine();
  let gap: Piece | null = null;
  for (const token of tokens) {
    if ("space" in token) gap = token.space;
    else {
      line = putWord(out, line, gap, token.word, size, width);
      gap = null;
    }
  }
  out.push(line.pieces);
  return out;
}

/** Break runs into lines no wider than `width`. Over-long words are split. */
function wrapRuns(runs: Run[], size: number, width: number): Piece[][] {
  const out: Piece[][] = [];
  for (const tokens of tokenize(runs)) out.push(...wrapTokens(tokens, size, width));
  return out;
}

type TextItem = { kind: "text"; pieces: Piece[]; size: number; x: number; y: number; gray?: number };
type RuleItem = { kind: "rule"; y: number };
type RectItem = { kind: "rect"; x: number; y: number; w: number; h: number; gray: number };
type ImageItem = { kind: "image"; index: number; x: number; y: number; w: number; h: number; orientation: number };
type Item = TextItem | RuleItem | RectItem | ImageItem;

type TextOptions = {
  font: FontKey;
  size: number;
  indent?: number;
  leading?: number;
  after?: number;
  before?: number;
  bullet?: string;
  keepWithNext?: number;
  center?: boolean;
};

const CODE_SIZE = 9;
const CODE_LEADING = 11.5;
const CODE_PAD = 5;
const CODE_RULE = 2;

/** A run of blocks that must not be left behind when the next block starts a new page. */
type Hold = { index: number; cursor: number; yAfter: number };

function runsOf(content: string | Run[], font: FontKey): Run[] {
  return typeof content === "string" ? [{ text: content, font }] : content;
}

function spaceBefore(before: number | undefined, occupied: boolean): number {
  return before && occupied ? before : 0;
}

function textX(center: boolean | undefined, indent: number, pieces: Piece[], size: number): number {
  if (!center) return MARGIN + indent;
  return MARGIN + indent + (TEXT_WIDTH - indent - linePieceWidth(pieces, size)) / 2;
}

function paintTextLine(page: Item[], pieces: Piece[], options: TextOptions, indent: number, index: number, y: number): void {
  if (index === 0 && options.bullet) {
    const bullet: Piece = { codes: encode(options.bullet), font: options.font };
    page.push({ kind: "text", pieces: [bullet], size: options.size, x: MARGIN + indent - 14, y });
  }
  page.push({ kind: "text", pieces, size: options.size, x: textX(options.center, indent, pieces, options.size), y });
}

function nextHold(
  hold: Hold | null,
  keepWithNext: number | undefined,
  moved: boolean,
  origin: number,
  cursor: number,
  yAfter: number,
): Hold | null {
  if (!(keepWithNext && !moved)) return null;
  if (hold && hold.index <= origin) {
    hold.yAfter = yAfter;
    return hold;
  }
  return { index: origin, cursor, yAfter };
}

type CodeRow = { codes: number[]; more: boolean };

function codeColumns(boxWidth: number): number {
  return Math.max(8, Math.floor((boxWidth - CODE_RULE - 2 * CODE_PAD - 6) / (0.6 * CODE_SIZE)));
}

function codeRows(source: string, columns: number): CodeRow[] {
  const rows: CodeRow[] = [];
  for (const line of source.split("\n")) {
    const codes = encode(expandTabs(line));
    if (codes.length === 0) rows.push({ codes, more: false });
    for (let at = 0; at < codes.length; at += columns) {
      rows.push({ codes: codes.slice(at, at + columns), more: at + columns < codes.length });
    }
  }
  return rows;
}

// No lone first or last line of a block on a page of its own.
function avoidCodeWidow(take: number, remaining: number): number {
  if (take < remaining && remaining - take === 1 && take > 2) return take - 1;
  return take;
}

function codeSlice(take: number, remaining: number, pageEmpty: boolean): number | null {
  if (!(take < Math.min(2, remaining))) return take;
  return pageEmpty ? 1 : null;
}

function paintCodeRow(page: Item[], row: CodeRow, boxX: number, boxWidth: number, baseline: number): void {
  const x = boxX + CODE_RULE + CODE_PAD;
  if (row.codes.length > 0) {
    page.push({ kind: "text", pieces: [{ codes: row.codes, font: "F3" }], size: CODE_SIZE, x, y: baseline });
  }
  if (row.more) {
    page.push({
      kind: "text",
      pieces: [{ codes: [0xbb], font: "F3" }],
      size: CODE_SIZE,
      x: boxX + boxWidth - CODE_PAD - 4,
      y: baseline,
      gray: 0.45,
    });
  }
}

function paintCodeSlice(page: Item[], rows: CodeRow[], done: number, take: number, boxX: number, boxWidth: number, top: number): number {
  const height = take * CODE_LEADING + 2 * CODE_PAD;
  page.push({ kind: "rect", x: boxX, y: top - height, w: boxWidth, h: height, gray: 0.95 });
  page.push({ kind: "rect", x: boxX, y: top - height, w: CODE_RULE, h: height, gray: 0.7 });
  for (let k = 0; k < take; k++) {
    const baseline = top - CODE_PAD - (k + 1) * CODE_LEADING + 3;
    paintCodeRow(page, rows[done + k], boxX, boxWidth, baseline);
  }
  return top - height;
}

class Layout {
  pages: Item[][] = [[]];
  y = PAGE_HEIGHT - MARGIN;
  images: PdfImage[] = [];
  /**
   * The chapter line and the headings under it. `keepWithNext` only reserves a
   * fixed gap, which is shorter than the heading that follows, so a chapter
   * number was left at the bottom of the previous page. The whole run moves
   * with the block that did not fit.
   */
  private hold: Hold | null = null;

  private get page(): Item[] {
    return this.pages[this.pages.length - 1];
  }

  newPage(): void {
    this.pages.push([]);
    this.y = PAGE_HEIGHT - MARGIN;
    this.hold = null;
  }

  /** True when this page already holds something, so a page break starts the next page. */
  hasContent(): boolean {
    return this.page.length > 0;
  }

  /**
   * Start a new page unless `height` still fits. `gap` is reapplied above the
   * block when a kept run moves with it. Returns true when a new page was opened.
   */
  need(height: number, gap = 0): boolean {
    if (this.y - height >= BOTTOM || this.page.length === 0) return false;
    const hold = this.hold;
    if (hold && hold.index < this.page.length && hold.cursor > hold.yAfter) {
      const yAfter = PAGE_HEIGHT - MARGIN - (hold.cursor - hold.yAfter);
      if (yAfter - gap - height >= BOTTOM) {
        const carried = this.page.splice(hold.index);
        const shift = PAGE_HEIGHT - MARGIN - hold.cursor;
        this.hold = null;
        this.newPage();
        for (const item of carried) item.y += shift;
        this.page.push(...carried);
        this.y = yAfter - gap;
        return true;
      }
    }
    this.hold = null;
    this.newPage();
    return true;
  }

  text(content: string | Run[], options: TextOptions): void {
    const indent = options.indent ?? 0;
    const leading = options.leading ?? options.size * 1.35;
    const lines = wrapRuns(runsOf(content, options.font), options.size, TEXT_WIDTH - indent);
    const gap = spaceBefore(options.before, this.page.length > 0);
    this.y -= gap;
    this.need(leading * Math.min(lines.length, 2) + (options.keepWithNext ?? 0), gap);
    const origin = this.page.length;
    const cursor = this.y;
    let moved = false;
    for (let index = 0; index < lines.length; index++) {
      if (this.y - leading < BOTTOM) {
        this.newPage();
        moved = true;
      }
      this.y -= leading;
      paintTextLine(this.page, lines[index], options, indent, index, this.y);
    }
    this.y -= options.after ?? 0;
    this.hold = nextHold(this.hold, options.keepWithNext, moved, origin, cursor, this.y);
  }

  rule(): void {
    this.need(12);
    this.y -= 6;
    this.page.push({ kind: "rule", y: this.y });
    this.y -= 6;
    this.hold = null;
  }

  /**
   * A block of code: Courier, every line kept as written (tabs expanded to 4 columns),
   * over-long lines cut at the box edge and marked with a grey continuation sign.
   * The shaded box is drawn once per page, so a long block may split between pages.
   */
  code(source: string, indent: number): void {
    const boxX = MARGIN + indent;
    const boxWidth = TEXT_WIDTH - indent;
    const rows = codeRows(source, codeColumns(boxWidth));
    if (this.page.length > 0) this.y -= 2;
    let done = 0;
    while (done < rows.length) {
      const remaining = rows.length - done;
      const room = Math.floor((this.y - BOTTOM - 2 * CODE_PAD) / CODE_LEADING);
      const take = codeSlice(avoidCodeWidow(Math.min(room, remaining), remaining), remaining, this.page.length === 0);
      if (take === null) {
        const fits = done === 0 && this.need(Math.min(2, remaining) * CODE_LEADING + 2 * CODE_PAD, 2);
        if (!fits) this.newPage();
        continue;
      }
      this.y = paintCodeSlice(this.page, rows, done, take, boxX, boxWidth, this.y);
      done += take;
      this.hold = null;
      if (done < rows.length) this.newPage();
    }
    this.y -= 8;
  }

  /** Place a picture (never split across pages) with an optional centred caption. */
  figure(image: PdfImage, key: number, size: { width?: number; height?: number }, indent: number, caption: string): void {
    const available = TEXT_WIDTH - indent;
    const shown = orientedPixels(image);
    const shownWidth = shown.width;
    const shownHeight = shown.height;
    const captionLines = caption ? wrapRuns([{ text: caption, font: "F4" }], 9.5, available).length : 0;
    const captionHeight = captionLines ? captionLines * 9.5 * 1.35 + 4 : 0;
    const maxHeight = CONTENT_HEIGHT - captionHeight - 12;
    // Natural size is 96 pixels to the inch; a picture is never enlarged unless asked.
    let w = size.width ?? (size.height ? (size.height * shownWidth) / shownHeight : shownWidth * 0.75);
    let h = size.height ?? (size.width ? (size.width * shownHeight) / shownWidth : shownHeight * 0.75);
    const shrink = Math.min(1, available / w, maxHeight / h);
    w *= shrink;
    h *= shrink;
    this.y -= 4;
    this.need(h + captionHeight + 8, 4);
    const x = MARGIN + indent + (available - w) / 2;
    this.y -= h;
    this.page.push({ kind: "image", index: key, x, y: this.y, w, h, orientation: image.orientation });
    this.y -= 4;
    if (captionLines) {
      this.y -= 2;
      this.text(caption, { font: "F4", size: 9.5, indent, center: true, after: 6 });
    } else this.y -= 4;
    this.hold = null;
  }
}

function orientedPixels(image: PdfImage): { width: number; height: number } {
  if (image.orientation < 5) return { width: image.width, height: image.height };
  return { width: image.height, height: image.width };
}

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
md.use(footnote);

type MdToken = ReturnType<typeof md.parse>[number];

const HEADING_SIZE = [0, 24, 19, 16, 14, 12, 11];

/** Nearest font for the given base face with bold and italic switched on. */
function styled(base: FontKey, bold: boolean, italic: boolean): FontKey {
  const heavy = bold || base === "F2" || base === "F5";
  const slanted = italic || base === "F4" || base === "F5";
  if (heavy && slanted) return "F5";
  if (heavy) return "F2";
  return slanted ? "F4" : "F1";
}

type PictureRef = { src: string; alt: string; width?: number; height?: number };
type Segment = { runs: Run[] } | { picture: PictureRef; alone: boolean };

const SIZE_UNITS: Record<string, number> = { "": 0.75, px: 0.75, pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, em: 11, rem: 11 };

/** The `{width=30% height=2in}` block that may follow a picture, as points. `available` is the line width. */
function pictureSize(block: string, available: number): { width?: number; height?: number } {
  const read = (name: string, whole: number): number | undefined => {
    const found = new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(block);
    const parsed = found ? /^([\d.]+)(%|[a-z]*)$/.exec(found[1]) : null;
    if (!parsed) return undefined;
    const amount = Number(parsed[1]);
    if (!Number.isFinite(amount) || amount <= 0) return undefined;
    if (parsed[2] === "%") return (amount / 100) * whole;
    const factor = SIZE_UNITS[parsed[2]];
    return factor === undefined ? undefined : amount * factor;
  };
  return { width: read("width", available), height: read("height", CONTENT_HEIGHT) };
}

type InlineState = {
  segments: Segment[];
  runs: Run[];
  bold: number;
  italic: number;
  skip: number;
  base: FontKey;
  available: number;
};

function inlineFont(state: InlineState): FontKey {
  return styled(state.base, state.bold > 0, state.italic > 0);
}

function flushRuns(state: InlineState): void {
  if (state.runs.length) state.segments.push({ runs: state.runs });
  state.runs = [];
}

function takeImage(child: MdToken, next: MdToken | undefined, available: number): { segment: Segment; skip?: number } {
  let size: { width?: number; height?: number } = {};
  const block = next?.type === "text" ? /^\{([^{}]*)\}/.exec(next.content) : null;
  let skip: number | undefined;
  if (block) {
    size = pictureSize(block[1], available);
    skip = block[0].length;
  }
  const picture = { src: String(child.attrGet("src") ?? ""), alt: child.content, ...size };
  return { segment: { picture, alone: false }, skip };
}

function footnoteLabel(meta: { id?: number } | null): string {
  return `[${footnoteNumber(meta)}]`;
}

function footnoteNumber(meta: { id?: number } | null): number {
  const id = meta?.id ?? 0;
  return id + 1;
}

function layoutMark(state: InlineState, child: MdToken): boolean {
  switch (child.type) {
    case "strong_open":
      state.bold += 1;
      return true;
    case "strong_close":
      state.bold -= 1;
      return true;
    case "em_open":
      state.italic += 1;
      return true;
    case "em_close":
      state.italic -= 1;
      return true;
    case "softbreak":
      state.runs.push({ text: " ", font: inlineFont(state) });
      return true;
    case "hardbreak":
      state.runs.push({ text: "\n", font: inlineFont(state) });
      return true;
    case "footnote_ref":
      state.runs.push({ text: footnoteLabel(child.meta as { id?: number } | null), font: inlineFont(state) });
      return true;
    default:
      return false;
  }
}

function layoutContent(state: InlineState, child: MdToken, next: MdToken | undefined): void {
  switch (child.type) {
    case "text": {
      const text = state.skip ? child.content.slice(state.skip) : child.content;
      state.skip = 0;
      if (text) state.runs.push({ text, font: inlineFont(state) });
      return;
    }
    case "code_inline":
      state.runs.push({ text: child.content, font: "F3", nobreak: child.content.length <= 40 });
      return;
    case "image": {
      flushRuns(state);
      const taken = takeImage(child, next, state.available);
      state.skip = taken.skip ?? state.skip;
      state.segments.push(taken.segment);
      return;
    }
    default:
      return;
  }
}

function segmentBlank(segment: Segment): boolean {
  return "runs" in segment && segment.runs.every((run) => run.text.trim() === "");
}

function markLonePicture(segments: Segment[]): void {
  const meaningful = segments.filter((segment) => !segmentBlank(segment));
  if (meaningful.length === 1 && "picture" in meaningful[0]) meaningful[0].alone = true;
}

function visibleSegments(segments: Segment[]): Segment[] {
  return segments.filter((segment) => !segmentBlank(segment) || "picture" in segment);
}

/**
 * Split an inline token into text runs and pictures. Code spans keep Courier, and
 * emphasis and strong text switch between the Helvetica faces. Pictures end the text
 * before them; `alone` marks a paragraph that holds nothing else, which gets a caption.
 */
function inlineSegments(token: MdToken, base: FontKey, available: number): Segment[] {
  const state: InlineState = { segments: [], runs: [], bold: 0, italic: 0, skip: 0, base, available };
  const children = token.children ?? [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (layoutMark(state, child)) continue;
    layoutContent(state, child, children[i + 1]);
  }
  flushRuns(state);
  markLonePicture(state.segments);
  return visibleSegments(state.segments);
}

function plainRuns(segments: Segment[]): Run[] {
  const out: Run[] = [];
  for (const segment of segments) {
    if ("runs" in segment) out.push(...segment.runs);
    else out.push({ text: `[${segment.picture.alt || "image"}]`, font: "F4" });
  }
  return out;
}

/** The picture files a Markdown text refers to, as written. */
export function pictureSources(markdown: string): string[] {
  const found = new Set<string>();
  const visit = (tokens: MdToken[]) => {
    for (const token of tokens) {
      if (token.type === "image") {
        const src = String(token.attrGet("src") ?? "");
        if (src) found.add(src);
      }
      if (token.children) visit(token.children);
    }
  };
  visit(md.parse(markdown, {}));
  return [...found];
}

/**
 * Read every picture the Markdown uses through the book's file layer, exactly as the
 * preview locates them (relative to the book folder, never outside it). A picture
 * that cannot be read or decoded is recorded as an error and shown as its alt text.
 */
export async function loadPictures(fs: Fs, root: string, markdown: string, options: EncodeOptions = {}): Promise<Pictures> {
  const pictures: Pictures = new Map();
  for (const src of pictureSources(markdown)) {
    const relative = bookPicturePath(src);
    if (relative === false) {
      pictures.set(src, { error: "web pictures are not fetched" });
      continue;
    }
    if (relative === null) {
      pictures.set(src, { error: "the picture is outside the book folder" });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await fs.readBytes(joinPath(root, relative));
    } catch (error) {
      pictures.set(src, { error: `the file could not be read (${String(error).replace(/^Error:\s*/, "")})` });
      continue;
    }
    try {
      pictures.set(src, { image: await encodeImage(bytes, options) });
    } catch (error) {
      pictures.set(src, { error: (error as Error).message });
    }
  }
  return pictures;
}

/** The "Part N" or "Chapter N" line, when this paragraph is that opener. */
function divisionLine(content: string): string | null {
  const matched = new RegExp(`^<p class="${CHAPTER_NUMBER_CLASS}">((?:Part|Chapter) \\d+)</p>$`).exec(content.trim());
  return matched?.[1] ?? null;
}

type ListState = { ordered: boolean; count: number };

type LayoutState = {
  layout: Layout;
  warnings: string[];
  pictures: Pictures | undefined;
  lists: ListState[];
  quote: number;
  pendingBullet: string | null;
  heading: number;
  chapterLead: boolean;
  inNotes: boolean;
  noteNumber: number;
  row: Run[][] | null;
  headerRow: boolean;
  noteFirst: boolean;
  warned: Set<string>;
  imageKeys: Map<string, number>;
};

function layoutIndent(state: LayoutState): number {
  return state.lists.length * 22 + state.quote * 18 + (state.inNotes ? 14 : 0);
}

function placeKnownPicture(state: LayoutState, picture: PictureRef, image: PdfImage, alone: boolean): void {
  let key = state.imageKeys.get(picture.src);
  if (key === undefined) {
    key = state.layout.images.length;
    state.layout.images.push(image);
    state.imageKeys.set(picture.src, key);
  }
  state.layout.figure(image, key, picture, layoutIndent(state), alone ? picture.alt : "");
}

function warnMissingPicture(state: LayoutState, picture: PictureRef, known: Picture | undefined): void {
  if (!state.warned.has(picture.src)) {
    state.warned.add(picture.src);
    const reason = known && "error" in known ? known.error : "pictures were not loaded";
    state.warnings.push(`Picture "${picture.src}" is not in the PDF: ${reason}.`);
  }
  state.layout.text(`[${picture.alt || "image"}]`, { font: "F4", size: 11, indent: layoutIndent(state), leading: 15, after: 8 });
}

function placePicture(state: LayoutState, picture: PictureRef, alone: boolean): void {
  const known = state.pictures?.get(picture.src);
  if (known && "image" in known) {
    placeKnownPicture(state, picture, known.image, alone);
    return;
  }
  warnMissingPicture(state, picture, known);
}

function layoutParagraph(state: LayoutState, runs: Run[]): void {
  const bullet = state.pendingBullet ?? undefined;
  state.pendingBullet = null;
  state.layout.text(runs, {
    font: "F1",
    size: 11,
    indent: layoutIndent(state),
    leading: 15,
    after: state.lists.length ? 3 : 8,
    bullet,
  });
}

function openBulletList(state: LayoutState): void {
  state.lists.push({ ordered: false, count: 0 });
}

function openOrderedList(state: LayoutState, token: MdToken): void {
  state.lists.push({ ordered: true, count: Number(token.attrGet("start") ?? 1) - 1 });
}

function closeList(state: LayoutState): void {
  state.lists.pop();
  if (state.lists.length === 0) state.layout.y -= 4;
}

function openItem(state: LayoutState): void {
  const list = state.lists[state.lists.length - 1];
  list.count += 1;
  state.pendingBullet = list.ordered ? `${list.count}.` : "\u2022";
}

function openHeading(state: LayoutState, token: MdToken): void {
  state.heading = Number(token.tag.slice(1));
}

function closeHeading(state: LayoutState): void {
  state.heading = 0;
  state.chapterLead = false;
}

function openNotes(state: LayoutState): void {
  state.inNotes = true;
  state.layout.rule();
  state.layout.text("Notes", { font: "F2", size: 14, after: 6, keepWithNext: 30 });
}

function closeNotes(state: LayoutState): void {
  state.inNotes = false;
}

function openNote(state: LayoutState, token: MdToken): void {
  state.noteNumber = Number((token.meta as { id?: number } | null)?.id ?? state.noteNumber - 1) + 1;
  state.noteFirst = true;
}

function openRow(state: LayoutState): void {
  state.row = [];
}

function openHeader(state: LayoutState): void {
  state.headerRow = true;
}

function rowFont(state: LayoutState): FontKey {
  return state.headerRow ? "F2" : "F1";
}

function joinRow(row: Run[][], font: FontKey): Run[] {
  const cells: Run[] = [];
  for (let index = 0; index < row.length; index++) {
    if (index > 0) cells.push({ text: "  |  ", font });
    cells.push(...row[index]);
  }
  return cells;
}

function layoutRow(state: LayoutState): void {
  const row = state.row;
  const font = rowFont(state);
  state.row = null;
  state.headerRow = false;
  if (row) state.layout.text(joinRow(row, font), { font, size: 10, indent: layoutIndent(state), after: 2 });
}

function openPage(layout: Layout, text: string): boolean {
  if (text !== `<div class="${PAGE_BREAK_CLASS}"></div>`) return false;
  if (layout.hasContent()) layout.newPage();
  return true;
}

function openDivision(state: LayoutState, content: string): boolean {
  const opener = divisionLine(content);
  if (!opener) return false;
  state.layout.text(opener, { font: "F2", size: 13, before: 22, after: 0, center: true, keepWithNext: 48 });
  state.chapterLead = true;
  return true;
}

function warnRawHtml(state: LayoutState): void {
  if (state.warned.has("html")) return;
  state.warnings.push("Raw HTML is not shown in the PDF.");
  state.warned.add("html");
}

function handledHtml(state: LayoutState, content: string): boolean {
  return openPage(state.layout, content) || openDivision(state, content);
}

function layoutHtmlBlock(state: LayoutState, token: MdToken): void {
  if (handledHtml(state, token.content.trim())) return;
  warnRawHtml(state);
}

function layoutCode(state: LayoutState, token: MdToken): void {
  state.layout.code(token.content.replace(/\n$/, ""), layoutIndent(state));
}

function layoutTableCell(state: LayoutState, token: MdToken, available: number): void {
  const font = rowFont(state);
  state.row!.push(plainRuns(inlineSegments(token, font, available)));
}

function layoutHeadingText(state: LayoutState, token: MdToken, available: number): void {
  const clean = plainRuns(inlineSegments(token, "F2", available));
  const last = clean[clean.length - 1];
  if (last) last.text = last.text.replace(/\s*\{-\}\s*$/, "");
  const before = state.chapterLead ? 4 : state.heading <= 2 ? 18 : 12;
  state.layout.text(clean, { font: "F2", size: HEADING_SIZE[state.heading], before, after: 6, keepWithNext: 40 });
}

function layoutNoteText(state: LayoutState, token: MdToken, available: number): void {
  const label = state.noteFirst ? `${state.noteNumber}.` : undefined;
  state.noteFirst = false;
  state.layout.text(plainRuns(inlineSegments(token, "F1", available)), {
    font: "F1",
    size: 9.5,
    indent: layoutIndent(state),
    after: 3,
    bullet: label,
  });
}

function layoutInlineSegment(state: LayoutState, segment: Segment): void {
  if ("picture" in segment) {
    placePicture(state, segment.picture, segment.alone);
    return;
  }
  const text = segment.runs.map((run) => run.text).join("").trim();
  if (openPage(state.layout, text)) return;
  if (openDivision(state, text)) return;
  layoutParagraph(state, segment.runs);
}

function layoutBody(state: LayoutState, token: MdToken, available: number): void {
  for (const segment of inlineSegments(token, "F1", available)) layoutInlineSegment(state, segment);
}

function layoutInline(state: LayoutState, token: MdToken): void {
  const available = TEXT_WIDTH - layoutIndent(state);
  if (state.row) layoutTableCell(state, token, available);
  else if (state.heading) layoutHeadingText(state, token, available);
  else if (state.inNotes) layoutNoteText(state, token, available);
  else layoutBody(state, token, available);
}

function layoutStructure(state: LayoutState, token: MdToken): boolean {
  switch (token.type) {
    case "bullet_list_open":
      openBulletList(state);
      return true;
    case "ordered_list_open":
      openOrderedList(state, token);
      return true;
    case "bullet_list_close":
    case "ordered_list_close":
      closeList(state);
      return true;
    case "list_item_open":
      openItem(state);
      return true;
    case "blockquote_open":
      state.quote += 1;
      return true;
    case "blockquote_close":
      state.quote -= 1;
      return true;
    case "heading_open":
      openHeading(state, token);
      return true;
  }
  return false;
}

function layoutRegions(state: LayoutState, token: MdToken): boolean {
  switch (token.type) {
    case "heading_close":
      closeHeading(state);
      return true;
    case "footnote_block_open":
      openNotes(state);
      return true;
    case "footnote_block_close":
      closeNotes(state);
      return true;
    case "footnote_open":
      openNote(state, token);
      return true;
    case "tr_open":
      openRow(state);
      return true;
    case "th_open":
      openHeader(state);
      return true;
    case "tr_close":
      layoutRow(state);
      return true;
  }
  return false;
}

function layoutBlocks(state: LayoutState, token: MdToken): void {
  switch (token.type) {
    case "html_block":
      layoutHtmlBlock(state, token);
      return;
    case "hr":
      state.layout.rule();
      return;
    case "fence":
    case "code_block":
      layoutCode(state, token);
      return;
    case "inline":
      layoutInline(state, token);
      return;
    default:
      return;
  }
}

function layoutTokens(tokens: MdToken[], layout: Layout, warnings: string[], pictures: Pictures | undefined): void {
  const state: LayoutState = {
    layout,
    warnings,
    pictures,
    lists: [],
    quote: 0,
    pendingBullet: null,
    heading: 0,
    chapterLead: false,
    inNotes: false,
    noteNumber: 0,
    row: null,
    headerRow: false,
    noteFirst: false,
    warned: new Set<string>(),
    imageKeys: new Map<string, number>(),
  };
  for (const token of tokens) {
    if (layoutStructure(state, token)) continue;
    if (layoutRegions(state, token)) continue;
    layoutBlocks(state, token);
  }
}

/** PDF matrix that puts the stored picture into a `w` by `h` box at (x, y) as its EXIF orientation says. */
function imageMatrix(item: ImageItem): string {
  const { x, y, w, h } = item;
  const m: Record<number, number[]> = {
    1: [w, 0, 0, h, x, y],
    2: [-w, 0, 0, h, x + w, y],
    3: [-w, 0, 0, -h, x + w, y + h],
    4: [w, 0, 0, -h, x, y + h],
    5: [0, -h, -w, 0, x + w, y + h],
    6: [0, -h, w, 0, x, y + h],
    7: [0, h, w, 0, x, y],
    8: [0, h, -w, 0, x + w, y],
  };
  return (m[item.orientation] ?? m[1]).map((n) => String(Math.round(n * 1000) / 1000)).join(" ");
}

function fontObject(key: FontKey): string {
  const encoding = key === "F6" ? "" : " /Encoding /WinAnsiEncoding";
  return `<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAMES[key]}${encoding} >>`;
}

// Each picture takes one object, or two when it has a soft mask.
function assignImageIds(images: PdfImage[], firstImage: number): { imageIds: number[]; maskIds: (number | null)[] } {
  const imageIds: number[] = [];
  const maskIds: (number | null)[] = [];
  let nextId = firstImage;
  for (const image of images) {
    imageIds.push(nextId++);
    maskIds.push(image.alpha ? nextId++ : null);
  }
  return { imageIds, maskIds };
}

function pieceSize(item: TextItem, piece: Piece): string {
  return piece.scale ? (item.size * piece.scale).toFixed(2) : String(item.size);
}

function showPiece(item: TextItem, piece: Piece): string {
  let out = ` /${piece.font} ${pieceSize(item, piece)} Tf`;
  if (piece.rise) out += ` ${(item.size * piece.rise).toFixed(2)} Ts`;
  out += ` ${pdfString(piece.codes)} Tj`;
  if (piece.rise) out += " 0 Ts";
  return out;
}

function showText(item: TextItem): string {
  const visible = item.pieces.filter((piece) => piece.codes.length > 0);
  if (visible.length === 0) return "";
  const gray = item.gray === undefined ? "0 g" : `${item.gray} g`;
  let out = `BT ${gray} ${item.x.toFixed(2)} ${item.y.toFixed(2)} Td`;
  for (const piece of visible) out += showPiece(item, piece);
  return out + " ET\n";
}

function showItem(item: Item, used: Set<number>): string {
  if (item.kind === "rule") {
    return `0.6 G 0.5 w ${MARGIN} ${item.y.toFixed(2)} m ${PAGE_WIDTH - MARGIN} ${item.y.toFixed(2)} l S\n`;
  }
  if (item.kind === "rect") {
    return `${item.gray} g ${item.x.toFixed(2)} ${item.y.toFixed(2)} ${item.w.toFixed(2)} ${item.h.toFixed(2)} re f\n`;
  }
  if (item.kind === "image") {
    used.add(item.index);
    return `q ${imageMatrix(item)} cm /Im${item.index} Do Q\n`;
  }
  return showText(item);
}

function pageStream(items: Item[], index: number): { body: string; used: Set<number> } {
  const used = new Set<number>();
  let body = "";
  for (const item of items) body += showItem(item, used);
  const label = pdfString(encode(String(index + 1)));
  const width = textWidth(encode(String(index + 1)), "F1", 9);
  body += `0 g BT /F1 9 Tf ${((PAGE_WIDTH - width) / 2).toFixed(2)} ${FOOTER_Y} Td ${label} Tj ET\n`;
  return { body, used };
}

function pageResources(fontKeys: FontKey[], used: Set<number>, imageIds: number[]): string {
  const xobjects = used.size
    ? ` /XObject << ${[...used].map((key) => `/Im${key} ${imageIds[key]} 0 R`).join(" ")} >>`
    : "";
  const fonts = fontKeys.map((key, n) => `/${key} ${3 + n} 0 R`).join(" ");
  return `/Resources << /Font << ${fonts} >>${xobjects} >>`;
}

function writePage(objects: string[], items: Item[], index: number, fontKeys: FontKey[], imageIds: number[], firstPage: number): void {
  const pageId = firstPage + index * 2;
  const { body, used } = pageStream(items, index);
  objects[pageId] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
    `${pageResources(fontKeys, used, imageIds)} /Contents ${pageId + 1} 0 R >>`;
  objects[pageId + 1] = `<< /Length ${body.length} >>\nstream\n${body}endstream`;
}

function writePages(objects: string[], pages: Item[][], fontKeys: FontKey[], imageIds: number[], firstPage: number): void {
  pages.forEach((items, index) => writePage(objects, items, index, fontKeys, imageIds, firstPage));
}

function imageObject(image: PdfImage, mask: number | null): string {
  const filters = image.filters.map((name) => `/${name}`).join(" ");
  const parts = [
    "/Type /XObject /Subtype /Image",
    `/Width ${image.width} /Height ${image.height}`,
    `/ColorSpace ${image.colorSpace} /BitsPerComponent ${image.bpc}`,
    `/Filter [${filters}]`,
  ];
  if (image.extra) parts.push(image.extra);
  if (mask !== null) parts.push(`/SMask ${mask} 0 R`);
  parts.push(`/Length ${image.data.length}`);
  return `<< ${parts.join(" ")} >>\nstream\n${image.data}\nendstream`;
}

function maskObject(image: PdfImage, alpha: string): string {
  return (
    `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
    `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter [/ASCII85Decode /FlateDecode] /Length ${alpha.length} >>\n` +
    `stream\n${alpha}\nendstream`
  );
}

function writeImages(objects: string[], images: PdfImage[], imageIds: number[], maskIds: (number | null)[]): void {
  images.forEach((image, index) => {
    const mask = maskIds[index];
    objects[imageIds[index]] = imageObject(image, mask);
    if (mask !== null && image.alpha) objects[mask] = maskObject(image, image.alpha);
  });
}

function writeXref(objects: string[], infoId: number): string {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

function assemble(layout: Layout, title: string): string {
  const pageCount = layout.pages.length;
  const objects: string[] = [];
  const fontKeys = Object.keys(FONT_NAMES) as FontKey[];
  const infoId = 3 + fontKeys.length;
  const firstPage = infoId + 1;
  const { imageIds, maskIds } = assignImageIds(layout.images, firstPage + pageCount * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = layout.pages.map((_, index) => `${firstPage + index * 2} 0 R`).join(" ");
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;
  fontKeys.forEach((key, index) => {
    objects[3 + index] = fontObject(key);
  });
  objects[infoId] = `<< /Title ${pdfString(encode(title))} /Producer (Bookwriter) >>`;
  writePages(objects, layout.pages, fontKeys, imageIds, firstPage);
  writeImages(objects, layout.images, imageIds, maskIds);
  return writeXref(objects, infoId);
}

/** Render Markdown to a PDF document held as an ASCII string. Pictures come from `pictures` (see `loadPictures`). */
export function markdownToPdf(markdown: string, title = "", pictures?: Pictures): PdfResult {
  return renderGroups([markdown], title, pictures);
}

/** The whole book as a PDF. Front matter and each chapter keep their own notes. */
export function exportPdf(nodes: TreeNode[], title = "", pictures?: Pictures): PdfResult {
  const exported = exportNoteGroups(nodes);
  return mergeWarnings(renderGroups(exported.groups, title, pictures), exported.warnings);
}

/** Like `exportPdf`, but first reads the book's pictures from `root` through `fs`. */
export async function exportPdfWithPictures(
  nodes: TreeNode[],
  title: string,
  fs: Fs,
  root: string,
  options: EncodeOptions = {},
): Promise<PdfResult> {
  const exported = exportNoteGroups(nodes);
  const pictures = await loadPictures(fs, root, exported.groups.join("\n\n"), options);
  return mergeWarnings(renderGroups(exported.groups, title, pictures), exported.warnings);
}

/** A PDF of one chapter. Pictures are read from the book folder. */
export async function chapterPdf(
  chapter: ChapterExport,
  fs: Fs,
  root: string,
  options: EncodeOptions = {},
): Promise<PdfResult> {
  const pictures = await loadPictures(fs, root, chapter.markdown, options);
  return mergeWarnings(markdownToPdf(chapter.markdown, chapter.title, pictures), chapter.warnings);
}

function renderGroups(groups: string[], title: string, pictures?: Pictures): PdfResult {
  const warnings: string[] = [];
  const layout = new Layout();
  layoutTokens(parseGroups(groups), layout, warnings, pictures);
  noteUnshown(groups.join("\n\n"), warnings);
  return { pdf: assemble(layout, title), pages: layout.pages.length, warnings };
}

function parseGroups(groups: string[]): MdToken[] {
  const tokens: MdToken[] = [];
  for (const markdown of groups) tokens.push(...md.parse(markdown, {}));
  return tokens;
}

function noteUnshown(markdown: string, warnings: string[]): void {
  if (hasUnshownCharacter(markdown)) {
    warnings.push("Some characters cannot be shown in the PDF and were replaced with ?.");
  }
}

function mergeWarnings(rendered: PdfResult, warnings: string[]): PdfResult {
  return { ...rendered, warnings: [...warnings, ...rendered.warnings] };
}
