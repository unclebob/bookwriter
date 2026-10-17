import { FileHolds, saveInstall } from "./holds";
import {
  assignPrefixes,
  collectIds,
  filePath,
  findNode,
  nextPrefix,
  parseSection,
  parseTitle,
  serializeSection,
  serializeTitle,
  slugify,
  uniqueId,
  walk,
  type Header,
  type TreeNode,
} from "./model";
import { baseName, joinPath, parentPath } from "./path";

export type DirEntry = { name: string; kind: "file" | "dir" };

export interface Fs {
  readText(path: string): Promise<string>;
  /** Whole file as bytes (pictures). */
  readBytes(path: string): Promise<Uint8Array>;
  writeText(path: string, text: string): Promise<void>;
  readDir(path: string): Promise<DirEntry[]>;
  rename(from: string, to: string): Promise<void>;
  /** Move one file, including across devices. Creates the destination directory. */
  moveFile(from: string, to: string): Promise<void>;
  canonicalize(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  /** Remove a file or a directory. A missing path is not an error. */
  remove(path: string): Promise<void>;
}

export type Book = {
  root: string;
  title: string;
  nodes: TreeNode[];
  warnings: string[];
};

const ENTRY = /^(\d+)-(.+)$/;
export const TRASH_ID = "trash";

export function isTrash(node: TreeNode): boolean {
  return node.header.id === TRASH_ID;
}

export async function initBook(fs: Fs, root: string, title: string): Promise<void> {
  await fs.mkdir(joinPath(root, "manuscript"));
  await fs.writeText(joinPath(root, "book.yaml"), serializeTitle(title));
}

export async function loadBook(fs: Fs, root: string): Promise<Book> {
  const warnings: string[] = [];
  let title = "";
  try {
    title = parseTitle(await fs.readText(joinPath(root, "book.yaml")));
  } catch {
    title = baseName(root);
    warnings.push("This folder has no book.yaml. A title was taken from the folder name.");
  }
  if (!title) title = baseName(root);
  const manuscript = joinPath(root, "manuscript");
  let entries: DirEntry[];
  try {
    entries = await fs.readDir(manuscript);
  } catch {
    await initBook(fs, root, title);
    entries = [];
    warnings.push("Created an empty manuscript.");
  }
  const nodes = await loadChildren(fs, manuscript, entries, warnings);
  nodes.push(await loadTrash(fs, manuscript, warnings));
  const seen = new Set<string>();
  walk(nodes, (node) => {
    if (seen.has(node.header.id)) warnings.push(`Duplicate id "${node.header.id}".`);
    seen.add(node.header.id);
  });
  return { root, title, nodes, warnings };
}

async function loadTrash(fs: Fs, manuscript: string, warnings: string[]): Promise<TreeNode> {
  const dir = joinPath(manuscript, "trash");
  await fs.mkdir(dir);
  const index = joinPath(dir, "_index.md");
  const header: Header = { id: TRASH_ID, title: "Trash", synopsis: "", status: "idea", role: "body" };
  try {
    await fs.readText(index);
  } catch {
    await fs.writeText(index, serializeSection(header, ""));
  }
  const trash = await loadGroup(fs, manuscript, "trash", "", "trash", warnings);
  trash.header = { ...trash.header, id: TRASH_ID, title: "Trash" };
  return trash;
}

async function loadChildren(fs: Fs, dir: string, entries: DirEntry[], warnings: string[]): Promise<TreeNode[]> {
  const nodes: TreeNode[] = [];
  const prefixes = new Set<string>();
  const sorted = entries
    .map((entry) => ({ entry, match: ENTRY.exec(entry.kind === "file" ? entry.name.replace(/\.md$/, "") : entry.name) }))
    .filter((item) => item.match && (item.entry.kind === "dir" || item.entry.name.endsWith(".md")))
    .sort((a, b) => {
      const an = Number(a.match![1]);
      const bn = Number(b.match![1]);
      if (an !== bn) return an - bn;
      return a.entry.name.localeCompare(b.entry.name);
    });

  for (const item of sorted) {
    const prefix = item.match![1];
    const slug = item.match![2];
    if (prefixes.has(prefix)) warnings.push(`Duplicate prefix ${prefix} in ${dir}.`);
    prefixes.add(prefix);
    if (item.entry.kind === "dir") {
      nodes.push(await loadGroup(fs, dir, item.entry.name, prefix, slug, warnings));
    } else {
      nodes.push(await loadSection(fs, dir, item.entry.name, prefix, slug, warnings));
    }
  }
  return nodes;
}

async function loadSection(
  fs: Fs,
  dir: string,
  entryName: string,
  prefix: string,
  slug: string,
  warnings: string[],
): Promise<TreeNode> {
  const path = joinPath(dir, entryName);
  const parsed = parseSection(await fs.readText(path));
  for (const warning of parsed.warnings) warnings.push(`${entryName}: ${warning}`);
  return {
    kind: "section",
    header: parsed.header,
    body: parsed.body,
    prefix,
    slug,
    dir,
    entryName,
    children: [],
  };
}

async function loadGroup(
  fs: Fs,
  dir: string,
  entryName: string,
  prefix: string,
  slug: string,
  warnings: string[],
): Promise<TreeNode> {
  const groupDir = joinPath(dir, entryName);
  const indexPath = joinPath(groupDir, "_index.md");
  let header: Header = {
    id: slug,
    title: slug.replace(/-/g, " "),
    synopsis: "",
    status: "idea",
    role: "body",
  };
  let body = "";
  try {
    const parsed = parseSection(await fs.readText(indexPath));
    header = parsed.header;
    body = parsed.body;
    for (const warning of parsed.warnings) warnings.push(`${entryName}/_index.md: ${warning}`);
  } catch {
    warnings.push(`${entryName} has no _index.md.`);
  }
  const children = await loadChildren(fs, groupDir, await fs.readDir(groupDir), warnings);
  return { kind: "group", header, body, prefix, slug, dir, entryName, children };
}

export type HeldSave = "saved" | "hold" | "same";

export async function saveNode(fs: Fs, node: TreeNode, header: Header, body: string): Promise<void> {
  const holds = new FileHolds();
  const path = filePath(node);
  const current = await readOrNull(fs, path);
  if (current !== null) holds.replaceAll(new Map([[node.header.id, { path, bytes: current }]]));
  const result = await saveHeldNode(fs, holds, node, header, body);
  if (result === "hold") throw new Error(`Could not save ${path}.`);
}

export async function saveHeldNode(
  fs: Fs,
  holds: FileHolds,
  node: TreeNode,
  header: Header,
  body: string,
  live?: () => string,
  busy?: boolean,
): Promise<HeldSave> {
  const kept: Header = { ...header, id: node.header.id };
  const snapshot = serializeSection(kept, body);
  const buffer = live ? live() : snapshot;
  if (buffer === snapshot) {
    node.header = kept;
    node.body = body;
  }
  return settle(fs, holds, node.header.id, filePath(node), snapshot, buffer, suppliedBusy(busy));
}

export async function saveBookTitle(fs: Fs, book: Book, title: string): Promise<void> {
  const holds = new FileHolds();
  const path = joinPath(book.root, "book.yaml");
  const current = await readOrNull(fs, path);
  if (current !== null) holds.replaceAll(new Map([["book.yaml", { path, bytes: current }]]));
  const result = await saveHeldTitle(fs, holds, book, title);
  if (result === "hold") throw new Error(`Could not save ${path}.`);
}

export async function saveHeldTitle(
  fs: Fs,
  holds: FileHolds,
  book: Book,
  title: string,
  live?: () => string,
  busy?: boolean,
): Promise<HeldSave> {
  const snapshot = serializeTitle(title);
  const buffer = live ? live() : snapshot;
  if (buffer === snapshot) book.title = title;
  return settle(fs, holds, "book.yaml", joinPath(book.root, "book.yaml"), snapshot, buffer, suppliedBusy(busy));
}

function suppliedBusy(busy: boolean | undefined): boolean {
  if (busy === undefined) return false;
  return busy;
}

async function settle(
  fs: Fs,
  holds: FileHolds,
  id: string,
  path: string,
  snapshot: string,
  buffer: string,
  busy: boolean,
): Promise<HeldSave> {
  const disk = await readOrNull(fs, path);
  const diskNow = await readOrNull(fs, path);
  const decision = saveInstall({ busy, base: holds.base(id), disk, diskNow, snapshot, buffer });
  if (decision === "hold") return "hold";
  if (decision === "write") await fs.writeText(path, snapshot);
  holds.noteWrite(id, path, snapshot);
  if (decision === "write") return "saved";
  return "same";
}

export async function readOrNull(fs: Fs, path: string): Promise<string | null> {
  try {
    return await fs.readText(path);
  } catch {
    return null;
  }
}

export async function createNode(
  fs: Fs,
  book: Book,
  parentId: string | null,
  kind: "group" | "section",
  title: string,
): Promise<string> {
  const parent = parentId ? findNode(book.nodes, parentId) : null;
  const dir = parent ? joinPath(parent.node.dir, parent.node.entryName) : joinPath(book.root, "manuscript");
  const onDisk = await fs.readDir(dir);
  const prefixes = onDisk
    .map((entry) => /^(\d+)-/.exec(entry.name)?.[1])
    .filter((prefix): prefix is string => Boolean(prefix));
  const id = uniqueId(title, collectIds(book.nodes));
  const prefix = nextPrefix(prefixes);
  const entryName = kind === "section" ? `${prefix}-${id}.md` : `${prefix}-${id}`;
  const header: Header = { id, title, synopsis: "", status: "idea", role: "body", unit: kind === "group" ? "section" : "text" };
  const text = serializeSection(header, "");
  if (kind === "group") {
    const groupDir = joinPath(dir, entryName);
    await fs.mkdir(groupDir);
    await fs.writeText(joinPath(groupDir, "_index.md"), text);
  } else {
    await fs.writeText(joinPath(dir, entryName), text);
  }
  return id;
}

export type DropZone = "before" | "after" | "inside";

type Located = {
  node: TreeNode;
  parent: TreeNode | null;
  siblings: TreeNode[];
};

function locate(nodes: TreeNode[], id: string, parent: TreeNode | null = null): Located | null {
  for (const node of nodes) {
    if (node.header.id === id) return { node, parent, siblings: nodes };
    const child = locate(node.children, id, node);
    if (child) return child;
  }
  return null;
}

function contains(node: TreeNode, id: string): boolean {
  return node.children.some((child) => child.header.id === id || contains(child, id));
}

export type SiblingPlan = { parentId: string | null; order: string[] };

function rejectedMove(moving: Located | null, target: Located | null, movingId: string, targetId: string): boolean {
  if (!moving || !target) return true;
  return movingId === targetId || isTrash(moving.node);
}

function dropsInside(target: Located, zone: DropZone): boolean {
  if (isTrash(target.node)) return true;
  return zone === "inside" && target.node.kind === "group";
}

function parentForDrop(target: Located, zone: DropZone): TreeNode | null {
  if (dropsInside(target, zone)) return target.node;
  return target.parent;
}

function dropInsideSelf(moving: Located, newParent: TreeNode | null): boolean {
  if (!newParent) return false;
  const movingId = moving.node.header.id;
  return newParent.header.id === movingId || contains(moving.node, newParent.header.id);
}

function pooled(roots: TreeNode[], newParent: TreeNode | null): TreeNode[] {
  if (newParent) return newParent.children;
  return roots.filter((node) => !isTrash(node));
}

function insertionIndex(destination: TreeNode[], targetId: string, zone: DropZone): number {
  let index = destination.findIndex((node) => node.header.id === targetId);
  if (index < 0) index = destination.length;
  if (zone === "after") index += 1;
  return index;
}

function placeInDestination(destination: TreeNode[], moving: Located, targetId: string, zone: DropZone, inside: boolean): void {
  if (inside) {
    destination.push(moving.node);
    return;
  }
  destination.splice(insertionIndex(destination, targetId, zone), 0, moving.node);
}

function orderOf(nodes: TreeNode[]): string[] {
  return nodes.map((node) => node.header.id);
}

function siblingPlans(moving: Located, newParent: TreeNode | null, destination: TreeNode[]): SiblingPlan[] {
  const dest = { parentId: headerId(newParent), order: orderOf(destination) };
  if (headerId(moving.parent) === headerId(newParent)) return [dest];
  const movingId = moving.node.header.id;
  const source = moving.siblings.filter((node) => keptSibling(node, movingId));
  return [{ parentId: headerId(moving.parent), order: orderOf(source) }, dest];
}

function headerId(node: TreeNode | null): string | null {
  if (!node) return null;
  return node.header.id;
}

function keptSibling(node: TreeNode, movingId: string): boolean {
  return node.header.id !== movingId && !isTrash(node);
}

function locatePair(roots: TreeNode[], movingId: string, targetId: string): { moving: Located; target: Located } | null {
  const moving = locate(roots, movingId);
  const target = locate(roots, targetId);
  if (rejectedMove(moving, target, movingId, targetId)) return null;
  return { moving: moving as Located, target: target as Located };
}

function buildPlans(roots: TreeNode[], moving: Located, target: Located, zone: DropZone): SiblingPlan[] {
  const newParent = parentForDrop(target, zone);
  if (dropInsideSelf(moving, newParent)) return [];
  const destination = pooled(roots, newParent).filter((node) => node.header.id !== moving.node.header.id);
  placeInDestination(destination, moving, target.node.header.id, zone, newParent === target.node);
  return siblingPlans(moving, newParent, destination);
}

/** Sibling orders after a drag. Empty when the drop would put a group inside itself. */
export function planMove(roots: TreeNode[], movingId: string, targetId: string, zone: DropZone): SiblingPlan[] {
  const pair = locatePair(roots, movingId, targetId);
  if (!pair) return [];
  return buildPlans(roots, pair.moving, pair.target, zone);
}

async function twoPhaseRename(fs: Fs, renames: { from: string; to: string }[]): Promise<void> {
  const temps: { temp: string; to: string }[] = [];
  for (let i = 0; i < renames.length; i += 1) {
    const rename = renames[i];
    const temp = joinPath(parentPath(rename.from), `__bw_tmp_${i}_${baseName(rename.to)}`);
    await fs.rename(rename.from, temp);
    temps.push({ temp, to: rename.to });
  }
  for (const temp of temps) await fs.rename(temp.temp, temp.to);
}

async function rewriteDirectory(fs: Fs, dir: string, ordered: TreeNode[]): Promise<void> {
  const prefixes = assignPrefixes(ordered.length);
  const renames: { from: string; to: string }[] = [];
  ordered.forEach((node, index) => {
    const prefix = prefixes[index];
    const name = node.kind === "section" ? `${prefix}-${node.slug}.md` : `${prefix}-${node.slug}`;
    const from = joinPath(node.dir, node.entryName);
    const to = joinPath(dir, name);
    if (from !== to) renames.push({ from, to });
    node.prefix = prefix;
    node.entryName = name;
    node.dir = dir;
    placeDirs(node.children, to);
  });
  await twoPhaseRename(fs, renames);
}

function nodesInOrder(roots: TreeNode[], ids: string[]): TreeNode[] {
  return ids.map((id) => {
    const found = findNode(roots, id);
    if (!found) throw new Error(`Missing node ${id} while reordering.`);
    return found.node;
  });
}

function placeDirs(nodes: TreeNode[], dir: string): void {
  for (const node of nodes) {
    node.dir = dir;
    placeDirs(node.children, joinPath(dir, node.entryName));
  }
}

export async function moveNode(fs: Fs, book: Book, movingId: string, targetId: string, zone: DropZone): Promise<void> {
  const plans = planMove(book.nodes, movingId, targetId, zone);
  if (!plans.length) return;
  const moving = findNode(book.nodes, movingId);
  if (!moving) return;

  if (plans.length === 2) {
    const sourceDir = moving.node.dir;
    await rewriteDirectory(fs, sourceDir, nodesInOrder(book.nodes, plans[0].order));
    const destination = plans[1];
    const destParent = destination.parentId ? findNode(book.nodes, destination.parentId) : null;
    const destDir = destParent
      ? joinPath(destParent.node.dir, destParent.node.entryName)
      : joinPath(book.root, "manuscript");
    const tempName = `__bw_tmp_${moving.node.header.id}`;
    await fs.rename(joinPath(sourceDir, moving.node.entryName), joinPath(destDir, tempName));
    moving.node.dir = destDir;
    moving.node.entryName = tempName;
    await rewriteDirectory(fs, destDir, nodesInOrder(book.nodes, destination.order));
    return;
  }
  const dir = moving.node.dir;
  await rewriteDirectory(fs, dir, nodesInOrder(book.nodes, plans[0].order));
}

export async function deleteNode(fs: Fs, book: Book, id: string): Promise<void> {
  const target = findNode(book.nodes, id);
  if (!target || isTrash(target.node) || target.ancestors.some(isTrash)) return;
  await moveNode(fs, book, id, TRASH_ID, "inside");
}

export async function emptyTrash(fs: Fs, book: Book): Promise<void> {
  const dir = trashDirectory(book);
  await removeTrashEntries(fs, dir, await fs.readDir(dir));
}

function trashDirectory(book: Book): string {
  return joinPath(book.root, "manuscript", TRASH_ID);
}

async function removeTrashEntries(fs: Fs, dir: string, entries: DirEntry[]): Promise<void> {
  for (const entry of entries) await removeTrashEntry(fs, dir, entry);
}

async function removeTrashEntry(fs: Fs, dir: string, entry: DirEntry): Promise<void> {
  if (trashHeader(entry.name)) return;
  await fs.remove(joinPath(dir, entry.name));
}

function trashHeader(name: string): boolean {
  return name === "_index.md";
}

export function manuscriptNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.filter((node) => !isTrash(node));
}

export function slugFromTitle(title: string): string {
  return slugify(title);
}
