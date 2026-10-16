export const STATUSES = ["idea", "draft", "revise", "done"] as const;
export type Status = (typeof STATUSES)[number];
export type Role = "front" | "body";

export const UNITS = ["part", "chapter", "section", "text"] as const;
export type Unit = (typeof UNITS)[number];

export type Header = {
  id: string;
  title: string;
  synopsis: string;
  status: Status;
  role: Role;
  /** How this node opens. Absent on files written before units existed. */
  unit?: Unit;
  /**
   * Legacy page break from files that have no unit.
   * `true` is read as a section and `false` as text. Not written once `unit` is set.
   */
  break?: boolean;
};

export type TreeNode = {
  kind: "group" | "section";
  header: Header;
  body: string;
  prefix: string;
  slug: string;
  /** Directory that contains this node's entry. */
  dir: string;
  /** File or directory name inside `dir`, including the numeric prefix. */
  entryName: string;
  children: TreeNode[];
};

export type ParsedSection = {
  header: Header;
  body: string;
  warnings: string[];
};

const HEADER_KEYS = ["id", "title", "synopsis", "status", "role"] as const;

export function wordCount(body: string): number {
  const trimmed = body.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function nodeWordCount(node: TreeNode): number {
  const own = wordCount(node.body);
  const nested = node.children.reduce((sum, child) => sum + nodeWordCount(child), 0);
  return own + nested;
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

export function uniqueId(title: string, used: Set<string>): string {
  const base = slugify(title);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * Sibling prefixes step by 10 and use at least three digits.
 * Past 990 the width grows so the last prefix still fits, and the step stays 10.
 */
export function assignPrefixes(count: number): string[] {
  const step = 10;
  let width = 3;
  while (count * step >= 10 ** width) width += 1;
  const prefixes: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    prefixes.push(String(i * step).padStart(width, "0"));
  }
  return prefixes;
}

export function nextPrefix(existing: string[]): string {
  const nums = existing.map(wholeNumber).filter((n): n is number => n !== null);
  const max = nums.length ? Math.max(...nums) : 0;
  const n = max + 10;
  const width = Math.max(3, String(n).length);
  return String(n).padStart(width, "0");
}

function wholeNumber(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  return Number(text);
}

export function effectiveFront(role: Role, ancestors: { role: Role }[]): boolean {
  return role === "front" || ancestors.some((ancestor) => ancestor.role === "front");
}

export type Division = { unit: "part" | "chapter"; number: number };

/** "Part N" or "Chapter N". The number is derived and is not stored. */
export function divisionLabel(division: Division): string {
  const name = division.unit === "part" ? "Part" : "Chapter";
  return `${name} ${division.number}`;
}

/**
 * The unit a node opens as.
 * A missing unit keeps an old `break` flag (`true` is a section, `false` is text).
 * With neither, a folder is a section and a section file is text, and neither is numbered.
 */
export function effectiveUnit(node: {
  kind: TreeNode["kind"];
  header: { unit?: Unit; break?: boolean };
}): Unit {
  if (node.header.unit) return node.header.unit;
  if (node.header.break === false) return "text";
  if (node.header.break === true) return "section";
  return node.kind === "group" ? "section" : "text";
}

/** A part, a chapter, and a section start a new page. Text does not. */
export function startsNewPage(node: {
  kind: TreeNode["kind"];
  header: { unit?: Unit; break?: boolean };
}): boolean {
  return effectiveUnit(node) !== "text";
}

/**
 * Part numbers and chapter numbers, each in tree order through the whole manuscript.
 * The two sequences are independent. Front matter and the trash take no number.
 */
export function divisions(roots: TreeNode[]): Map<string, Division> {
  const found = new Map<string, Division>();
  let part = 0;
  let chapter = 0;
  const visit = (nodes: TreeNode[], ancestors: TreeNode[]) => {
    for (const node of nodes) {
      if (node.header.id === "trash") continue;
      const unit = effectiveUnit(node);
      const front = effectiveFront(
        node.header.role,
        ancestors.map((ancestor) => ancestor.header),
      );
      if (!front && unit === "part") {
        part += 1;
        found.set(node.header.id, { unit, number: part });
      } else if (!front && unit === "chapter") {
        chapter += 1;
        found.set(node.header.id, { unit, number: chapter });
      }
      visit(node.children, [...ancestors, node]);
    }
  };
  visit(roots, []);
  return found;
}

export function clampHeadingLevel(level: number): { level: number; clamped: boolean } {
  if (level > 6) return { level: 6, clamped: true };
  if (level < 1) return { level: 1, clamped: true };
  return { level, clamped: false };
}

export function quoteScalar(value: string): string {
  if (value === "") return '""';
  const plain = /^[A-Za-z0-9][A-Za-z0-9 .,'_-]*$/.test(value);
  const reserved = /^(true|false|null|yes|no|on|off)$/i.test(value);
  if (plain && !reserved) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) return unquoteDouble(value);
  if (quotedSingle(value)) return unquoteSingle(value);
  return value;
}

function quotedSingle(value: string): boolean {
  return value.startsWith("'") && value.endsWith("'") && value.length >= 2;
}

function unquoteSingle(value: string): string {
  return value.slice(1, -1).replace(/''/g, "'");
}

function unquoteDouble(value: string): string {
  let out = "";
  for (let i = 1; i < value.length; i += 1) {
    const char = value[i];
    if (char === "\\") {
      i += 1;
      out += escapedChar(value[i]);
      continue;
    }
    if (char === '"') break;
    out += char;
  }
  return out;
}

function escapedChar(char: string | undefined): string {
  if (char === "n") return "\n";
  if (char === undefined) return "";
  return char;
}

function defaultHeader(partial: Partial<Header>): Header {
  const id = partial.id || "section";
  const title = partial.title || "";
  const synopsis = partial.synopsis || "";
  const status = partial.status || "idea";
  const role = partial.role || "body";
  return { id, title, synopsis, status, role };
}

export function serializeSection(header: Header, body: string): string {
  const lines = [
    "---",
    `id: ${quoteScalar(header.id)}`,
    `title: ${quoteScalar(header.title)}`,
    `synopsis: ${quoteScalar(header.synopsis)}`,
    `status: ${header.status}`,
    `role: ${header.role}`,
  ];
  if (header.unit) lines.push(`unit: ${header.unit}`);
  else if (typeof header.break === "boolean") lines.push(`break: ${header.break ? "true" : "false"}`);
  lines.push("---", "");
  return lines.join("\n") + body;
}

function readUnit(raw: string | undefined, warnings: string[]): Unit | undefined {
  if (raw === undefined) return undefined;
  if ((UNITS as readonly string[]).includes(raw)) return raw as Unit;
  warnings.push(`Unit "${raw}" is not part, chapter, section, or text.`);
  return undefined;
}

function readBreak(raw: string | undefined, warnings: string[]): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  warnings.push(`Page break "${raw}" is not true or false.`);
  return undefined;
}

function readHeaderLine(line: string, fields: Map<string, string>, warnings: string[]): void {
  if (!line.trim()) return;
  const split = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
  if (!split) {
    warnings.push(`Ignored header line "${line}".`);
    return;
  }
  fields.set(split[1], parseScalar(split[2]));
}

function headerFields(block: string, warnings: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of block.split("\n")) readHeaderLine(line, fields, warnings);
  return fields;
}

function warnMissingKeys(fields: Map<string, string>, warnings: string[]): void {
  for (const key of HEADER_KEYS) {
    if (!fields.has(key)) warnings.push(`Header is missing ${key}.`);
  }
}

function readStatus(raw: string | undefined, warnings: string[]): Status {
  const status = (raw ?? "idea") as Status;
  if (STATUSES.includes(status)) return status;
  warnings.push(`Status "${status}" is not one of ${STATUSES.join(", ")}.`);
  return "idea";
}

function readRole(raw: string | undefined, warnings: string[]): Role {
  const role = (raw ?? "body") as Role;
  if (role === "front" || role === "body") return role;
  warnings.push(`Role "${role}" is not front or body.`);
  return "body";
}

function headerFromFields(fields: Map<string, string>, warnings: string[]): Header {
  warnMissingKeys(fields, warnings);
  const unit = readUnit(fields.has("unit") ? fields.get("unit") : undefined, warnings);
  const pageBreak = readBreak(fields.has("break") ? fields.get("break") : undefined, warnings);
  const id = fields.get("id") || "section";
  const title = fields.get("title") || "";
  const synopsis = fields.get("synopsis") || "";
  const status = readStatus(fields.get("status"), warnings);
  const role = readRole(fields.get("role"), warnings);
  const header: Header = { id, title, synopsis, status, role };
  if (unit !== undefined) header.unit = unit;
  if (pageBreak !== undefined) header.break = pageBreak;
  return header;
}

function sectionFromHeader(block: string, body: string, warnings: string[]): ParsedSection {
  return { header: headerFromFields(headerFields(block, warnings), warnings), body, warnings };
}

export function parseSection(text: string): ParsedSection {
  const warnings: string[] = [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const matched = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!matched) {
    warnings.push("Missing header. The file was read as a body.");
    return { header: defaultHeader({ title: "Untitled" }), body: normalized, warnings };
  }
  return sectionFromHeader(matched[1], matched[2], warnings);
}

export function serializeTitle(title: string): string {
  return `title: ${quoteScalar(title)}\n`;
}

export function parseTitle(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  for (const line of normalized.split("\n")) {
    const matched = /^title:\s*(.*)$/.exec(line);
    if (matched) return parseScalar(matched[1]);
  }
  return "";
}

export type Fence = { char: string; len: number };

/** A fence opener or closer, using CommonMark's rule that a closer carries no info string. */
export function fenceMark(line: string): { char: string; len: number; info: string } | null {
  const matched = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!matched) return null;
  const token = matched[2];
  const info = matched[3];
  const backtick = token.startsWith("`");
  if (backtick && info.includes("`")) return null;
  return { char: backtick ? "`" : "~", len: token.length, info };
}

export function closesFence(open: Fence, mark: { char: string; len: number; info: string }): boolean {
  return mark.char === open.char && mark.len >= open.len && mark.info.trim() === "";
}

/** Advance a fence one line. A fenced line is copied through unchanged. */
export function stepFence(line: string, fence: Fence | null): { fence: Fence | null; fenced: boolean } {
  const mark = fenceMark(line);
  if (!mark) return { fence, fenced: fence !== null };
  return fenceFromMark(fence, mark);
}

function fenceFromMark(
  fence: Fence | null,
  mark: { char: string; len: number; info: string },
): { fence: Fence | null; fenced: boolean } {
  if (!fence) return { fence: { char: mark.char, len: mark.len }, fenced: true };
  return { fence: fenceAfterClose(fence, mark), fenced: true };
}

function fenceAfterClose(fence: Fence, mark: { char: string; len: number; info: string }): Fence | null {
  return closesFence(fence, mark) ? null : fence;
}

/** Closed inline code spans on one line. An unmatched backtick is ordinary text. */
export function codeSpanRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let index = 0;
  while (index !== line.length) {
    const ticks = backtickRun(line, index);
    if (ticks === 0) {
      index += 1;
      continue;
    }
    const closer = line.indexOf("`".repeat(ticks), index + ticks);
    if (closer === -1) break;
    ranges.push([index, closer + ticks]);
    index = closer + ticks;
  }
  return ranges;
}

function backtickRun(line: string, index: number): number {
  let ticks = 0;
  while (line[index + ticks] === "`") ticks += 1;
  return ticks;
}

export function insideSpan(offset: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

export function walk(nodes: TreeNode[], visit: (node: TreeNode, ancestors: TreeNode[]) => void, ancestors: TreeNode[] = []): void {
  for (const node of nodes) {
    visit(node, ancestors);
    walk(node.children, visit, [...ancestors, node]);
  }
}

export function findNode(nodes: TreeNode[], id: string): { node: TreeNode; ancestors: TreeNode[] } | null {
  let found: { node: TreeNode; ancestors: TreeNode[] } | null = null;
  walk(nodes, (node, ancestors) => {
    if (node.header.id === id) found = { node, ancestors };
  });
  return found;
}

export function collectIds(nodes: TreeNode[]): Set<string> {
  const ids = new Set<string>();
  walk(nodes, (node) => ids.add(node.header.id));
  return ids;
}

export function filePath(node: TreeNode): string {
  const entry = joinEntry(node.dir, node.entryName);
  return node.kind === "group" ? joinEntry(entry, "_index.md") : entry;
}

function joinEntry(dir: string, name: string): string {
  return dir.replace(/\/+$/, "") + "/" + name;
}
