import {
  clampHeadingLevel,
  codeSpanRanges,
  divisionLabel,
  divisions,
  effectiveFront,
  effectiveUnit,
  findNode,
  insideSpan,
  startsNewPage,
  stepFence,
  type Division,
  type Fence,
  type TreeNode,
} from "../internals/model";

export type TransformOptions = {
  depth: number;
  /** When set, footnote labels are prefixed with this section id. */
  sectionId?: string;
  /** Front matter headings gain Pandoc's unnumbered marker. */
  front?: boolean;
};

export type Transformed = {
  text: string;
  warnings: string[];
};

function prefixFootnotes(line: string, sectionId: string): string {
  const spans = codeSpanRanges(line);
  return line.replace(/\[\^([^\]]+)\]/g, (match, label: string, offset: number) => {
    if (insideSpan(offset, spans)) return match;
    return `[^${sectionId}-${label}]`;
  });
}

function unnumbered(text: string): string {
  if (/\{\s*-\s*\}/.test(text)) return text;
  if (text.length === 0) return "{-}";
  return `${text} {-}`.trimStart();
}

function shiftHeading(line: string, options: TransformOptions, warnings: string[]): string | null {
  const heading = /^(#{1,6})([ \t]+)(.*)$/.exec(line);
  if (!heading) return null;
  const raw = heading[1].length + options.depth;
  const clamped = clampHeadingLevel(raw);
  if (clamped.clamped) warnings.push(`A heading of level ${raw} was written at level ${clamped.level}.`);
  let text = heading[3];
  if (options.sectionId) text = prefixFootnotes(text, options.sectionId);
  if (options.front) text = unnumbered(text);
  return "#".repeat(clamped.level) + heading[2] + text;
}

function proseLine(line: string, options: TransformOptions): string {
  if (!options.sectionId) return line;
  return prefixFootnotes(line, options.sectionId);
}

/**
 * Shift body headings by the section depth and, when asked, prefix footnote labels.
 * Fenced code is copied through unchanged.
 */
export function transformBody(body: string, options: TransformOptions): Transformed {
  const warnings: string[] = [];
  const out: string[] = [];
  let fence: Fence | null = null;

  for (const line of body.split("\n")) {
    const stepped = stepFence(line, fence);
    fence = stepped.fence;
    if (stepped.fenced) {
      out.push(line);
      continue;
    }
    out.push(shiftHeading(line, options, warnings) ?? proseLine(line, options));
  }

  if (fence) warnings.push("Unclosed code fence.");
  return { text: out.join("\n"), warnings };
}

/** Class on the centered "Part N" or "Chapter N" line. The reading view and the PDF both recognize it. */
export const CHAPTER_NUMBER_CLASS = "chapter-number";

/** Class on the break that starts a node on a new page. */
export const PAGE_BREAK_CLASS = "page-break";

export function divisionOpener(division: Division): string {
  return `<p class="${CHAPTER_NUMBER_CLASS}">${divisionLabel(division)}</p>`;
}

export function pageBreak(): string {
  return `<div class="${PAGE_BREAK_CLASS}"></div>`;
}

function titleHeading(
  depth: number,
  title: string,
  front: boolean,
  warnings: string[],
  division?: Division,
): string {
  const clamped = clampHeadingLevel(depth);
  if (clamped.clamped && depth > 6) {
    warnings.push(`"${title}" is deeper than heading level 6 and was written at level 6.`);
  }
  const marker = front ? " {-}" : "";
  const heading = `${"#".repeat(clamped.level)} ${title}${marker}`;
  if (!division) return heading;
  return `${divisionOpener(division)}\n\n${heading}`;
}

type Piece = { key: string; markdown: string };
type NoteGroup = { key: string; parts: string[] };

/**
 * Manuscript Markdown split where notes are printed.
 * Front matter is one group. Each chapter, including the sections inside it, is one group.
 * Anything else keeps its own notes.
 */
export function exportNoteGroups(nodes: TreeNode[]): { groups: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const pieces = collectPieces(withoutTrash(nodes), [], warnings, divisions(nodes), false);
  return { groups: packGroups(pieces), warnings };
}

export function exportBook(nodes: TreeNode[]): { markdown: string; warnings: string[] } {
  const exported = exportNoteGroups(nodes);
  return { markdown: exported.groups.join("\n\n"), warnings: exported.warnings };
}

function withoutTrash(nodes: TreeNode[]): TreeNode[] {
  return nodes.filter(keptNode);
}

function keptNode(node: TreeNode): boolean {
  return node.header.id !== "trash";
}

function collectPieces(
  nodes: TreeNode[],
  ancestors: TreeNode[],
  warnings: string[],
  numbered: Map<string, Division>,
  followed: boolean,
): Piece[] {
  const pieces: Piece[] = [];
  nodes.forEach((node, index) => addNode(pieces, node, ancestors, warnings, numbered, followed || index > 0));
  return pieces;
}

function addNode(
  pieces: Piece[],
  node: TreeNode,
  ancestors: TreeNode[],
  warnings: string[],
  numbered: Map<string, Division>,
  followed: boolean,
): void {
  pieces.push(ownPiece(node, ancestors, warnings, numbered, followed));
  addChildren(pieces, node, ancestors, warnings, numbered);
}

function addChildren(
  pieces: Piece[],
  node: TreeNode,
  ancestors: TreeNode[],
  warnings: string[],
  numbered: Map<string, Division>,
): void {
  pieces.push(...collectPieces(node.children, [...ancestors, node], warnings, numbered, true));
}

function ownPiece(
  node: TreeNode,
  ancestors: TreeNode[],
  warnings: string[],
  numbered: Map<string, Division>,
  followed: boolean,
): Piece {
  return { key: noteKey(node, ancestors), markdown: exportOwn(node, ancestors, warnings, numbered, followed) };
}

function noteKey(node: TreeNode, ancestors: TreeNode[]): string {
  if (isFront(node, ancestors)) return "front";
  return chapterOrNode(node, ancestors);
}

function isFront(node: TreeNode, ancestors: TreeNode[]): boolean {
  return effectiveFront(node.header.role, ancestors.map(headerOf));
}

function headerOf(node: TreeNode): TreeNode["header"] {
  return node.header;
}

function chapterOrNode(node: TreeNode, ancestors: TreeNode[]): string {
  const owner = chapterOwner(node, ancestors);
  if (owner) return `chapter:${owner}`;
  return `node:${node.header.id}`;
}

function chapterOwner(node: TreeNode, ancestors: TreeNode[]): string | null {
  if (isChapter(node)) return node.header.id;
  return ancestorChapter(ancestors);
}

function isChapter(node: TreeNode): boolean {
  return effectiveUnit(node) === "chapter";
}

function ancestorChapter(ancestors: TreeNode[]): string | null {
  return [...ancestors].reverse().find(isChapter)?.header.id ?? null;
}

function exportOwn(
  node: TreeNode,
  ancestors: TreeNode[],
  warnings: string[],
  numbered: Map<string, Division>,
  followed: boolean,
): string {
  const text = nodeText(node, ancestors, warnings, numbered);
  if (opensPage(node, followed)) return `${pageBreak()}\n\n${text}`;
  return text;
}

function opensPage(node: TreeNode, followed: boolean): boolean {
  return startsNewPage(node) && followed;
}

function nodeText(
  node: TreeNode,
  ancestors: TreeNode[],
  warnings: string[],
  numbered: Map<string, Division>,
): string {
  const front = isFront(node, ancestors);
  const depth = ancestors.length + 1;
  const heading = titleHeading(depth, node.header.title, front, warnings, numbered.get(node.header.id));
  const transformed = transformBody(node.body, { depth, sectionId: node.header.id, front });
  warnings.push(...transformed.warnings);
  return joinBody(heading, transformed.text);
}

function joinBody(heading: string, text: string): string {
  const body = text.replace(/\n+$/, "");
  if (body.length > 0) return `${heading}\n\n${body}`;
  return heading;
}

function packGroups(pieces: Piece[]): string[] {
  const groups: NoteGroup[] = [];
  for (const piece of pieces) appendPiece(groups, piece);
  return groups.map(joinGroup);
}

function appendPiece(groups: NoteGroup[], piece: Piece): void {
  const group = lastGroup(groups);
  if (extendsGroup(group, piece.key)) group.parts.push(piece.markdown);
  else groups.push({ key: piece.key, parts: [piece.markdown] });
}

function lastGroup(groups: NoteGroup[]): NoteGroup | undefined {
  return groups[groups.length - 1];
}

function extendsGroup(group: NoteGroup | undefined, key: string): group is NoteGroup {
  return group != null && group.key === key;
}

function joinGroup(group: NoteGroup): string {
  return group.parts.join("\n\n");
}

export type DocxFile = { name: string; markdown: string };

export type ChapterExport = {
  markdown: string;
  warnings: string[];
  title: string;
  filename: string;
};

/** One chapter and the sections inside it, numbered as in the whole book. A nested chapter is left out. */
export function exportChapter(nodes: TreeNode[], id: string): ChapterExport | null {
  const node = chapterNode(nodes, id);
  if (!node) return null;
  const warnings: string[] = [];
  const numbered = divisions(nodes);
  return {
    markdown: chapterMarkdown(node, warnings, numbered),
    warnings,
    title: node.header.title,
    filename: `${docxStem(node, numbered)}.pdf`,
  };
}

function chapterNode(nodes: TreeNode[], id: string): TreeNode | null {
  const found = findNode(withoutTrash(nodes), id);
  if (!found || !isChapter(found.node)) return null;
  return found.node;
}

function chapterMarkdown(node: TreeNode, warnings: string[], numbered: Map<string, Division>): string {
  return chapterPieces(node, warnings, numbered).map(pieceText).join("\n\n");
}

function chapterPieces(node: TreeNode, warnings: string[], numbered: Map<string, Division>): Piece[] {
  const pieces = [ownPiece(node, [], warnings, numbered, false)];
  addChapterChildren(pieces, node.children, [node], warnings, numbered);
  return pieces;
}

function addChapterChildren(
  pieces: Piece[],
  nodes: TreeNode[],
  ancestors: TreeNode[],
  warnings: string[],
  numbered: Map<string, Division>,
): void {
  for (const node of nodes) addChapterChild(pieces, node, ancestors, warnings, numbered);
}

function addChapterChild(
  pieces: Piece[],
  node: TreeNode,
  ancestors: TreeNode[],
  warnings: string[],
  numbered: Map<string, Division>,
): void {
  if (isChapter(node)) return;
  pieces.push(ownPiece(node, ancestors, warnings, numbered, true));
  addChapterChildren(pieces, node.children, [...ancestors, node], warnings, numbered);
}

/** One Word file for each front-matter piece, and one for each chapter. Parts are not files. */
export function exportDocxFiles(nodes: TreeNode[]): { files: DocxFile[]; warnings: string[] } {
  const warnings: string[] = [];
  const files: DocxFile[] = [];
  collectDocx(nodes, [], warnings, divisions(nodes), files, new Set());
  return { files, warnings };
}

function collectDocx(
  nodes: TreeNode[],
  ancestors: TreeNode[],
  warnings: string[],
  numbered: Map<string, Division>,
  files: DocxFile[],
  used: Set<string>,
): void {
  withoutTrash(nodes).forEach((node) => addDocx(node, ancestors, warnings, numbered, files, used));
}

function addDocx(
  node: TreeNode,
  ancestors: TreeNode[],
  warnings: string[],
  numbered: Map<string, Division>,
  files: DocxFile[],
  used: Set<string>,
): void {
  if (isDocxFile(node, ancestors)) pushDocx(files, used, node, warnings, numbered);
  walkDocx(node, ancestors, warnings, numbered, files, used);
}

function isDocxFile(node: TreeNode, ancestors: TreeNode[]): boolean {
  return frontRoot(node, ancestors) || isChapter(node);
}

function frontRoot(node: TreeNode, ancestors: TreeNode[]): boolean {
  return isFront(node, ancestors) && !parentIsFront(ancestors);
}

function parentIsFront(ancestors: TreeNode[]): boolean {
  const parent = ancestors.at(-1);
  return parent != null && isFront(parent, ancestors.slice(0, -1));
}

function walkDocx(
  node: TreeNode,
  ancestors: TreeNode[],
  warnings: string[],
  numbered: Map<string, Division>,
  files: DocxFile[],
  used: Set<string>,
): void {
  if (frontRoot(node, ancestors)) return;
  collectDocx(node.children, [...ancestors, node], warnings, numbered, files, used);
}

function pushDocx(
  files: DocxFile[],
  used: Set<string>,
  node: TreeNode,
  warnings: string[],
  numbered: Map<string, Division>,
): void {
  files.push(docxFile(used, node, warnings, numbered));
}

function docxFile(used: Set<string>, node: TreeNode, warnings: string[], numbered: Map<string, Division>): DocxFile {
  return { name: uniqueDocxName(used, docxName(node, numbered)), markdown: docxMarkdown(node, warnings, numbered) };
}

function docxMarkdown(node: TreeNode, warnings: string[], numbered: Map<string, Division>): string {
  return collectPieces([node], [], warnings, numbered, false).map(pieceText).join("\n\n");
}

function pieceText(piece: Piece): string {
  return piece.markdown;
}

function docxName(node: TreeNode, numbered: Map<string, Division>): string {
  return `${docxStem(node, numbered)}.docx`;
}

function docxStem(node: TreeNode, numbered: Map<string, Division>): string {
  return `${docxCode(numbered.get(node.header.id))}-${docxTitle(node.header.title)}`;
}

function docxCode(division: Division | undefined): string {
  return division?.unit === "chapter" ? chapterCode(division.number) : "FM";
}

function chapterCode(number: number): string {
  return String(number).padStart(2, "0");
}

function docxTitle(title: string): string {
  return cleanedTitle(title) || "untitled";
}

function cleanedTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().replace(/\.+$/, "");
}

function uniqueDocxName(used: Set<string>, name: string): string {
  const unique = unusedName(used, name, 1);
  used.add(unique);
  return unique;
}

function unusedName(used: Set<string>, name: string, n: number): string {
  const candidate = candidateName(name, n);
  return taken(used, candidate) ? unusedName(used, name, n + 1) : candidate;
}

function candidateName(name: string, n: number): string {
  return n === 1 ? name : suffixedName(name, n);
}

function taken(used: Set<string>, name: string): boolean {
  return used.has(name);
}

function suffixedName(name: string, n: number): string {
  return name.replace(/\.docx$/, `-${n}.docx`);
}
