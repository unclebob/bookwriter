import "./styles.css";
import { defaultKeymap, history, historyKeymap, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { findNext, findPrevious, getSearchQuery, openSearchPanel, search, searchKeymap, setSearchQuery, type SearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, type Command } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import {
  createNode,
  deleteNode,
  emptyTrash,
  isTrash,
  loadBook,
  manuscriptNodes,
  moveNode,
  saveBookTitle,
  saveNode,
  type Book,
  type DropZone,
} from "../internals/book";
import { COMMANDS, applyCommand, latestLanguage, type CommandId, type MarkupCommand } from "../ui/commands";
import { exportBook, exportDocxFiles } from "../export/export";
import { nextMatch, previousMatch, type FindHit, type FindPart } from "../ui/find";
import { exportPdfWithPictures } from "../export/pdf";
import { rasterizePicture } from "../ui/rasterize";
import { formatAccelerator } from "../ui/keys";
import { blockAtLine, lineOffset, offsetFraction, scrollToSpot, sourceOffset } from "../ui/locate";
import { divisionLabel, divisions, effectiveUnit, findNode, nodeWordCount, slugify, UNITS, walk, type Division, type Header, type Status, type TreeNode, type Unit } from "../internals/model";
import { joinPath, parentPath } from "../internals/path";
import { PICTURE_EXTENSIONS, placePicture, resolvePictureSources } from "../internals/pictures";
import { renderBook, renderGroup, renderSection } from "../ui/preview";
import { clampPreviewWidth, previewWidthFromPointer } from "../ui/split";
import { allowBook, pandocDocx, startupBookPath, tauriFs } from "../ui/tauriFs";
import { dropRedo, emptyTrail, historyStep, noteVisit, redoVisit, undoVisit, type Trail } from "../ui/trail";

const fs = tauriFs;
const bookTitle = document.querySelector<HTMLInputElement>("#book-title")!;
const saveState = document.querySelector<HTMLElement>("#save-state")!;
const warningsEl = document.querySelector<HTMLElement>("#warnings")!;
const outlineEl = document.querySelector<HTMLElement>("#outline")!;
const inspector = document.querySelector<HTMLFormElement>("#inspector")!;
const fieldTitle = document.querySelector<HTMLInputElement>("#field-title")!;
const fieldSynopsis = document.querySelector<HTMLTextAreaElement>("#field-synopsis")!;
const fieldStatus = document.querySelector<HTMLSelectElement>("#field-status")!;
const fieldRole = document.querySelector<HTMLSelectElement>("#field-role")!;
const unitInputs = [...document.querySelectorAll<HTMLInputElement>('#inspector input[name="unit"]')];
const fieldId = document.querySelector<HTMLElement>("#field-id")!;
const editProse = document.querySelector<HTMLButtonElement>("#btn-edit-prose")!;
const readGroup = document.querySelector<HTMLButtonElement>("#btn-read")!;
const editorHost = document.querySelector<HTMLElement>("#editor-host")!;
const readingEl = document.querySelector<HTMLElement>("#reading")!;
const previewEl = document.querySelector<HTMLElement>("#preview")!;
const paneSplit = document.querySelector<HTMLElement>("#pane-split")!;
const outlineColumn = document.querySelector<HTMLElement>(".outline-column")!;
const workspace = document.querySelector<HTMLElement>(".workspace")!;
const palette = document.querySelector<HTMLElement>("#palette")!;
const paletteInput = document.querySelector<HTMLInputElement>("#palette-input")!;
const paletteList = document.querySelector<HTMLUListElement>("#palette-list")!;
const reminder = document.querySelector<HTMLElement>("#reminder")!;
const reminderRows = document.querySelector<HTMLElement>("#reminder-rows")!;
const createDialog = document.querySelector<HTMLDialogElement>("#create-dialog")!;
const contextMenu = document.querySelector<HTMLElement>("#context-menu")!;
const createLabel = document.querySelector<HTMLElement>("#create-label")!;
const createTitle = document.querySelector<HTMLInputElement>("#create-title")!;

let book: Book | null = null;
/** Outline row for the whole manuscript. Not a node id. */
const BOOK_ID = "\u0000book";

let selectedId: string | null = null;
const collapsed = new Set<string>();
let editingProse = false;
let previewOn = true;
let dirty = false;
let suppress = false;
let navigating = false;
let saveTimer = 0;
let paletteIndex = 0;
let pendingHistory: "undo" | "redo" | null = null;
let historyBusy = false;

type Visit = { id: string; prose: boolean; state: EditorState | null };
type Selection = { node: TreeNode; ancestors: TreeNode[] };
type VisitMove = { trail: Trail<Visit>; to: Visit };
type ContextAction = { label: string; run: () => Promise<void> };
type CaretPoint = { offsetNode: Node; offset: number };

type CaretDoc = Document & {
  caretRangeFromPoint?: (px: number, py: number) => Range | null;
  caretPositionFromPoint?: (px: number, py: number) => CaretPoint | null;
};
let trail = emptyTrail<Visit>();

function inMarkup(command: Command): Command {
  return (view) => editing() && command(view);
}

/** Survives a new editor state when Find Next opens another text. */
let searchWholeBook = false;

/** Find Next and Find Previous follow the whole-book checkbox. Other search commands stay as they are. */
function bookSearch(command: Command): Command {
  return (view) => runBookSearch(command, view);
}

function runBookSearch(command: Command, view: EditorView): boolean {
  if (wholeBookStep(command)) return true;
  return finishBookSearch(command, view);
}

function wholeBookStep(command: Command): boolean {
  if (!searchWholeBook) return false;
  return stepWholeBook(command);
}

function stepWholeBook(command: Command): boolean {
  if (command === findNext) return startBookFind("next");
  return stepWholeBookBack(command);
}

function stepWholeBookBack(command: Command): boolean {
  if (command !== findPrevious) return false;
  return startBookFind("previous");
}

function startBookFind(direction: "next" | "previous"): boolean {
  void findInBook(direction);
  return true;
}

function finishBookSearch(command: Command, view: EditorView): boolean {
  const ran = command(view);
  if (ran) wireBookFind(view);
  return ran;
}

const editorExtensions = [
  history(),
  search({ top: true }),
  keymap.of([
    { key: "Mod-b", run: () => (runCommand("strong"), true) },
    { key: "Mod-i", run: () => (runCommand("emphasis"), true) },
    { key: "Mod-e", run: () => (runCommand("inline-code"), true) },
    { key: "Mod-z", run: () => requestHistory("undo"), preventDefault: true },
    { key: "Mod-y", mac: "Mod-Shift-z", run: () => requestHistory("redo"), preventDefault: true },
    { linux: "Ctrl-Shift-z", run: () => requestHistory("redo"), preventDefault: true },
    ...searchKeymap.map((binding) => ({
      ...binding,
      run: binding.run ? inMarkup(bookSearch(binding.run)) : undefined,
      shift: binding.shift ? inMarkup(bookSearch(binding.shift)) : undefined,
    })),
    ...historyKeymap,
    ...defaultKeymap,
  ]),
  markdown({ codeLanguages: languages }),
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ spellcheck: "true" }),
  EditorView.theme({
    "&": { backgroundColor: "#fbf8f2", height: "100%" },
    ".cm-content": { caretColor: "#241f1a" },
    "&.cm-focused": { outline: "none" },
    ".cm-activeLine": { backgroundColor: "rgba(110, 75, 42, 0.04)" },
  }),
  EditorView.updateListener.of((update) => {
    // Find Next and Find Previous mark the selection with this event. Select-all uses a longer name.
    if (update.transactions.some((tr) => tr.annotation(Transaction.userEvent) === "select.search")) {
      scrollPreviewToCursor();
    }
    if (!update.docChanged || suppress) return;
    const motion = update.transactions.some((tr) => {
      const event = tr.annotation(Transaction.userEvent);
      return event === "undo" || event === "redo";
    });
    if (!motion) trail = dropRedo(trail);
    dirty = true;
    if (navigating) return;
    saveState.textContent = "Unsaved";
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void flush(), 400);
    drawPreview();
    paintWordCount();
  }),
];

const editor = new EditorView({
  parent: editorHost,
  state: EditorState.create({ doc: "", extensions: editorExtensions }),
});

function viewingBook(): boolean {
  return selectedId === BOOK_ID;
}

function selectable(id: string): boolean {
  if (id === BOOK_ID) return true;
  return nodeExists(id);
}

function nodeExists(id: string): boolean {
  return book != null && findNode(book.nodes, id) != null;
}

function selected(): Selection | null {
  if (noSelection()) return null;
  return findNode(book!.nodes, selectedId!);
}

function noSelection(): boolean {
  return missingBookOrId() || viewingBook();
}

function missingBookOrId(): boolean {
  return book == null || selectedId == null;
}

function editing(): boolean {
  const current = selected();
  if (!current) return false;
  return editingNode(current.node);
}

function editingNode(node: TreeNode): boolean {
  return node.kind === "section" || editingProse;
}

function selectedUnit(): Unit {
  const picked = checkedUnit();
  if (isUnit(picked)) return picked;
  return "text";
}

function checkedUnit(): string | undefined {
  return unitInputs.find((input) => input.checked)?.value;
}

function isUnit(picked: string | undefined): picked is Unit {
  return picked != null && (UNITS as readonly string[]).includes(picked);
}

function headerFromForm(node: TreeNode): Header {
  return {
    id: node.header.id,
    title: fieldTitle.value,
    synopsis: fieldSynopsis.value,
    status: fieldStatus.value as Status,
    role: fieldRole.value === "front" ? "front" : "body",
    unit: selectedUnit(),
  };
}

function cancelSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
}

function loadDocument(body: string, resetHistory: boolean): void {
  if (documentUnchanged(body, resetHistory)) return;
  suppress = true;
  replaceDocument(body, resetHistory);
  suppress = false;
  dirty = false;
}

function documentUnchanged(body: string, resetHistory: boolean): boolean {
  return !resetHistory && editor.state.doc.toString() === body;
}

function replaceDocument(body: string, resetHistory: boolean): void {
  if (resetHistory) editor.setState(EditorState.create({ doc: body, extensions: editorExtensions }));
  else editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: body } });
}

function takeVisit(): Visit | null {
  if (!selectedId) return null;
  return { id: selectedId, prose: editingProse, state: visitState() };
}

function visitState(): EditorState | null {
  return editing() ? editor.state : null;
}

function showCurrent(): void {
  renderOutline();
  fillInspector();
  drawReading();
  drawPreview();
  paintWordCount();
  if (editing()) editor.focus();
}

async function flush(): Promise<void> {
  cancelSave();
  const current = selected();
  if (cannotSave(current)) return;
  await saveCurrent(current);
}

function cannotSave(current: Selection | null): current is null {
  return !hasSaveTarget(current) || !dirty;
}

function hasSaveTarget(current: Selection | null): boolean {
  return book != null && current != null;
}

async function saveCurrent(current: Selection): Promise<void> {
  await saveNode(fs, current.node, headerFromForm(current.node), flushBody(current));
  dirty = false;
  saveState.textContent = "Saved";
  paintWordCount();
}

function flushBody(current: Selection): string {
  return editing() ? editor.state.doc.toString() : current.node.body;
}

function requestHistory(kind: "undo" | "redo"): boolean {
  if (historyBlocked()) return true;
  pendingHistory = kind;
  queueMicrotask(runPendingHistory);
  return true;
}

function historyBlocked(): boolean {
  return activeField() != null || pendingHistory != null;
}

function runPendingHistory(): void {
  const which = pendingHistory;
  pendingHistory = null;
  if (which) void stepHistory(which);
}

function menuHistory(kind: "undo" | "redo"): void {
  if (activeField()) {
    document.execCommand(kind);
    return;
  }
  requestHistory(kind);
}

// A section change is an undo step of its own. Undoing it selects the section
// you left and restores the text there, rather than writing that text here.
async function stepHistory(kind: "undo" | "redo"): Promise<void> {
  if (historyBusy) return;
  await applyHistoryStep(kind, historyStep(localDepth(kind), switchCount(kind)));
}

function localDepth(kind: "undo" | "redo"): number {
  return editing() ? editorDepth(kind) : 0;
}

function editorDepth(kind: "undo" | "redo"): number {
  return kind === "undo" ? undoDepth(editor.state) : redoDepth(editor.state);
}

function switchCount(kind: "undo" | "redo"): number {
  return kind === "undo" ? trail.undo.length : trail.redo.length;
}

async function applyHistoryStep(kind: "undo" | "redo", step: "local" | "switch" | "none"): Promise<void> {
  if (step === "local") undoOrRedo(kind);
  else await moveHistory(kind, step);
}

function undoOrRedo(kind: "undo" | "redo"): void {
  if (kind === "undo") undo(editor);
  else redo(editor);
}

async function moveHistory(kind: "undo" | "redo", step: "local" | "switch" | "none"): Promise<void> {
  if (step === "none") return;
  await landHistory(kind);
}

async function landHistory(kind: "undo" | "redo"): Promise<void> {
  const here = takeVisit();
  if (cannotLeave(here)) return;
  await landMoved(kind, here);
}

function cannotLeave(here: Visit | null): here is null {
  return here == null || book == null;
}

async function landMoved(kind: "undo" | "redo", here: Visit): Promise<void> {
  const moved = shiftedVisit(kind, here);
  if (cannotLand(moved)) return;
  await finishLand(moved);
}

function shiftedVisit(kind: "undo" | "redo", here: Visit): VisitMove | null {
  return kind === "undo" ? undoVisit(trail, here) : redoVisit(trail, here);
}

function cannotLand(moved: VisitMove | null): moved is null {
  return moved == null || !selectable(moved.to.id);
}

async function finishLand(moved: VisitMove): Promise<void> {
  trail = moved.trail;
  historyBusy = true;
  try {
    await land(moved.to);
  } finally {
    historyBusy = false;
  }
}

async function land(visit: Visit): Promise<void> {
  navigating = true;
  const landed = await tryLand(visit);
  if (landed) showCurrent();
}

async function tryLand(visit: Visit): Promise<boolean> {
  try {
    return await prepareLand(visit);
  } finally {
    navigating = false;
  }
}

async function prepareLand(visit: Visit): Promise<boolean> {
  cancelSave();
  await flushTwice();
  if (cannotLandOn(visit)) return false;
  await settleVisit(visit);
  return true;
}

async function flushTwice(): Promise<void> {
  await flush();
  if (dirty) await flush();
}

function cannotLandOn(visit: Visit): boolean {
  return book == null || !selectable(visit.id);
}

async function settleVisit(visit: Visit): Promise<void> {
  selectedId = visit.id;
  editingProse = visit.prose;
  restoreVisitState(visit);
  await syncLandedBody();
}

function restoreVisitState(visit: Visit): void {
  if (visit.state) restoreEditorState(visit.state);
  else loadSelectedBody();
}

function restoreEditorState(state: EditorState): void {
  suppress = true;
  editor.setState(state);
  suppress = false;
}

function loadSelectedBody(): void {
  loadDocument(editingBody(selected()), true);
}

function editingBody(current: Selection | null): string {
  if (hasEditingBody(current)) return current.node.body;
  return "";
}

function hasEditingBody(current: Selection | null): current is Selection {
  return current != null && editing();
}

async function syncLandedBody(): Promise<void> {
  if (landedBodyDiffers(selected())) await markDirtyAndFlush();
  else markSaved();
}

function landedBodyDiffers(current: Selection | null): boolean {
  return current != null && bodyOutOfDate(current);
}

function bodyOutOfDate(current: Selection): boolean {
  return editing() && current.node.body !== editor.state.doc.toString();
}

async function markDirtyAndFlush(): Promise<void> {
  dirty = true;
  await flush();
}

function markSaved(): void {
  dirty = false;
  saveState.textContent = "Saved";
}

function showPictures(html: string): string {
  if (!book) return html;
  const root = book.root;
  return resolvePictureSources(html, (relative) => convertFileSrc(joinPath(root, relative)));
}

function paintViewToggle(): void {
  const button = document.querySelector<HTMLButtonElement>("#btn-preview")!;
  button.textContent = previewOn ? "Markup" : "Preview";
  button.setAttribute("aria-pressed", String(previewOn));
}

function placeCursor(offset: number): void {
  const pos = Math.max(0, Math.min(offset, editor.state.doc.length));
  editor.dispatch({
    selection: { anchor: pos, head: pos },
    scrollIntoView: true,
  });
  editor.focus();
}

function elementAt(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return parentElementOf(target);
}

function parentElementOf(target: EventTarget | null): Element | null {
  if (target instanceof Node) return target.parentElement;
  return null;
}

function fractionAt(block: HTMLElement, x: number, y: number): number {
  const placed = caretFraction(block, x, y);
  if (placed != null) return placed;
  return verticalFraction(block, y);
}

function caretFraction(block: HTMLElement, x: number, y: number): number | null {
  const doc = block.ownerDocument as CaretDoc;
  const total = textLength(block);
  const range = rangeFromPoint(doc, x, y);
  const point = caretPoint(doc, range, x, y);
  const node = caretNode(range, point);
  const nodeOffset = caretOffset(range, point);
  if (!caretInside(block, node, nodeOffset, total)) return null;
  return probeFraction(doc, block, node, nodeOffset as number, total);
}

function textLength(block: HTMLElement): number {
  const text = block.textContent;
  if (text == null) return 0;
  return text.length;
}

function rangeFromPoint(doc: CaretDoc, x: number, y: number): Range | null {
  const fromPoint = doc.caretRangeFromPoint;
  if (!fromPoint) return null;
  return fromPoint.call(doc, x, y);
}

function caretNode(range: Range | null, point: CaretPoint | null | undefined): Node | undefined {
  return range ? range.startContainer : offsetNode(point);
}

function offsetNode(point: CaretPoint | null | undefined): Node | undefined {
  return point?.offsetNode;
}

function caretOffset(range: Range | null, point: CaretPoint | null | undefined): number | undefined {
  return range ? range.startOffset : pointOffset(point);
}

function pointOffset(point: CaretPoint | null | undefined): number | undefined {
  return point?.offset;
}

function caretPoint(doc: CaretDoc, range: Range | null, x: number, y: number): CaretPoint | null | undefined {
  return range ? null : positionFromPoint(doc, x, y);
}

function positionFromPoint(doc: CaretDoc, x: number, y: number): CaretPoint | null | undefined {
  const fromPoint = doc.caretPositionFromPoint;
  if (!fromPoint) return null;
  return fromPoint.call(doc, x, y);
}

function caretInside(block: HTMLElement, node: Node | undefined, nodeOffset: number | undefined, total: number): node is Node {
  return node != null && offsetInBlock(block, node, nodeOffset, total);
}

function offsetInBlock(block: HTMLElement, node: Node, nodeOffset: number | undefined, total: number): boolean {
  return nodeOffset != null && containsWithText(block, node, total);
}

function containsWithText(block: HTMLElement, node: Node, total: number): boolean {
  return block.contains(node) && total > 0;
}

function probeFraction(doc: CaretDoc, block: HTMLElement, node: Node, nodeOffset: number, total: number): number | null {
  try {
    return measuredFraction(doc, block, node, nodeOffset, total);
  } catch {
    // The caret sits outside this block. Use the vertical fraction below.
    return null;
  }
}

function measuredFraction(doc: CaretDoc, block: HTMLElement, node: Node, nodeOffset: number, total: number): number {
  const probe = doc.createRange();
  probe.setStart(block, 0);
  probe.setEnd(node, nodeOffset);
  return Math.min(1, Math.max(0, probe.toString().length / total));
}

function verticalFraction(block: HTMLElement, y: number): number {
  const rect = block.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  return Math.min(1, Math.max(0, (y - rect.top) / rect.height));
}

function nearestBlock(root: HTMLElement, y: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestDist = Infinity;
  for (const block of root.querySelectorAll<HTMLElement>("[data-line]")) {
    const closer = closerBlock(block, y, best, bestDist);
    best = closer[0];
    bestDist = closer[1];
  }
  return best;
}

function closerBlock(block: HTMLElement, y: number, best: HTMLElement | null, bestDist: number): [HTMLElement | null, number] {
  const dist = blockDistance(block, y);
  if (dist < bestDist) return [block, dist];
  return [best, bestDist];
}

function blockDistance(block: HTMLElement, y: number): number {
  const rect = block.getBoundingClientRect();
  if (y < rect.top) return rect.top - y;
  return belowDistance(rect, y);
}

function belowDistance(rect: DOMRect, y: number): number {
  return y > rect.bottom ? y - rect.bottom : 0;
}

/** Approximate source offset for a click in rendered markup. */
function clickOffset(root: HTMLElement, event: MouseEvent, source: string): number {
  const element = elementAt(event.target);
  if (!insideRoot(root, element)) return 0;
  return offsetInRoot(root, element, event, source);
}

function insideRoot(root: HTMLElement, element: Element | null): element is Element {
  return element != null && root.contains(element);
}

function offsetInRoot(root: HTMLElement, element: Element, event: MouseEvent, source: string): number {
  const direct = element.closest<HTMLElement>("[data-line]");
  if (ownedBlock(root, direct)) return offsetOfBlock(direct, event, source);
  return offsetFromHeading(root, element, event, source);
}

function ownedBlock(root: HTMLElement, block: HTMLElement | null): block is HTMLElement {
  return block != null && root.contains(block);
}

function offsetFromHeading(root: HTMLElement, element: Element, event: MouseEvent, source: string): number {
  const heading = element.closest("h1, h2, h3, h4, h5, h6");
  if (ownedHeading(root, heading)) return 0;
  return offsetFromNearest(root, event, source);
}

function ownedHeading(root: HTMLElement, heading: Element | null): boolean {
  return heading != null && root.contains(heading);
}

function offsetFromNearest(root: HTMLElement, event: MouseEvent, source: string): number {
  const block = nearestBlock(root, event.clientY);
  if (!block) return 0;
  return offsetOfBlock(block, event, source);
}

function offsetOfBlock(block: HTMLElement, event: MouseEvent, source: string): number {
  const start = Number(block.dataset.line);
  const end = spanEnd(block, start);
  if (!integerSpan(start, end)) return 0;
  return sourceOffset(source, start, end, fractionAt(block, event.clientX, event.clientY));
}

function spanEnd(block: HTMLElement, start: number): number {
  const raw = block.dataset.end;
  if (raw == null) return start + 1;
  return Number(raw);
}

function integerSpan(start: number, end: number): boolean {
  return Number.isInteger(start) && Number.isInteger(end);
}

function showWarnings(lines: string[]): void {
  const unique = [...new Set(lines.filter(Boolean))];
  warningsEl.hidden = unique.length === 0;
  warningsEl.textContent = unique.join(" ");
}

function paintWordCount(): void {
  const current = selected();
  if (!current) return;
  paintRowCount(current.node);
}

function paintRowCount(node: TreeNode): void {
  const row = outlineEl.querySelector<HTMLElement>(`[data-id="${CSS.escape(node.header.id)}"] .meta`);
  if (!row) return;
  row.textContent = `${node.header.status} · ${nodeWordCount(countedNode(node))} words`;
}

function countedNode(node: TreeNode): TreeNode {
  return { ...node, body: editing() ? editor.state.doc.toString() : node.body };
}

const MIN_PANE = 180;
const PREVIEW_WIDTH_KEY = "bookwriter.preview-width";

function readPreviewWidth(): number | null {
  try {
    return storedPreviewWidth();
  } catch {
    return null;
  }
}

function storedPreviewWidth(): number | null {
  const value = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
  if (usableWidth(value)) return value;
  return null;
}

function usableWidth(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function writePreviewWidth(width: number): void {
  try {
    localStorage.setItem(PREVIEW_WIDTH_KEY, String(width));
  } catch {
    // The width still applies for this session when storage is unavailable.
  }
}

function fittedPreviewWidth(width: number): number {
  const rect = workspace.getBoundingClientRect();
  const splitter = paneSplit.getBoundingClientRect().width || 5;
  const available = rect.width - outlineColumn.getBoundingClientRect().width - splitter;
  return clampPreviewWidth(available, width, MIN_PANE);
}

function applyPreviewWidth(width: number | null): void {
  if (width == null) {
    workspace.style.removeProperty("--preview-width");
    paneSplit.removeAttribute("aria-valuenow");
    return;
  }
  const fitted = fittedPreviewWidth(width);
  workspace.style.setProperty("--preview-width", `${fitted}px`);
  paneSplit.setAttribute("aria-valuemin", String(MIN_PANE));
  paneSplit.setAttribute("aria-valuenow", String(fitted));
}

let previewWidth = readPreviewWidth();
applyPreviewWidth(previewWidth);

function dragPreviewWidth(clientX: number): number {
  const rect = workspace.getBoundingClientRect();
  return previewWidthFromPointer(
    rect.width,
    rect.left,
    clientX,
    outlineColumn.getBoundingClientRect().width,
    paneSplit.getBoundingClientRect().width,
    MIN_PANE,
  );
}

let splitting = false;

paneSplit.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  splitting = true;
  paneSplit.classList.add("dragging");
  document.body.classList.add("pane-dragging");
  paneSplit.setPointerCapture(event.pointerId);
  event.preventDefault();
});
paneSplit.addEventListener("pointermove", (event) => {
  if (!splitting) return;
  previewWidth = dragPreviewWidth(event.clientX);
  applyPreviewWidth(previewWidth);
});
function endSplit(): void {
  if (!splitting) return;
  stopSplitting();
}

function stopSplitting(): void {
  splitting = false;
  paneSplit.classList.remove("dragging");
  document.body.classList.remove("pane-dragging");
  if (previewWidth != null) writePreviewWidth(fittedPreviewWidth(previewWidth));
}
paneSplit.addEventListener("pointerup", endSplit);
paneSplit.addEventListener("pointercancel", endSplit);
paneSplit.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const current = previewWidth ?? previewEl.getBoundingClientRect().width;
  const step = event.shiftKey ? 80 : 24;
  previewWidth = fittedPreviewWidth(current + (event.key === "ArrowLeft" ? step : -step));
  applyPreviewWidth(previewWidth);
  writePreviewWidth(previewWidth);
});
window.addEventListener("resize", () => {
  if (previewWidth != null) applyPreviewWidth(previewWidth);
});

function drawPreview(): void {
  const current = selected();
  hidePreviewUnlessEditing();
  if (!canPreview(current)) {
    previewEl.innerHTML = "";
    return;
  }
  paintPreview(current);
}

function hidePreviewUnlessEditing(): void {
  previewEl.hidden = !previewOn || !editing();
  paneSplit.hidden = previewEl.hidden;
  workspace.classList.toggle("preview-off", previewEl.hidden);
}

function canPreview(current: Selection | null): current is Selection {
  return current != null && editing();
}

function paintPreview(current: Selection): void {
  const node = { ...current.node, body: editor.state.doc.toString(), children: current.node.children };
  const rendered = renderSection(node, current.ancestors, divisionOf(current.node));
  const scroll = keptScroll(node.header.id);
  previewEl.innerHTML = showPictures(rendered.html);
  previewEl.scrollTop = scroll;
  showWarnings([...bookWarnings(), ...rendered.warnings]);
}

function bookWarnings(): string[] {
  if (!book) return [];
  return book.warnings;
}

function keptScroll(id: string): number {
  if (showingSection(id)) return previewEl.scrollTop;
  return 0;
}

function showingSection(id: string): boolean {
  return sectionId(previewEl.querySelector<HTMLElement>("section[data-id]")) === id;
}

function sectionId(section: HTMLElement | null): string | undefined {
  return section?.dataset.id;
}

const PREVIEW_SCROLL_PADDING = 48;

/** Scroll the preview to the rendered block around the editor cursor. */
function scrollPreviewToCursor(): void {
  if (previewClosed()) return;
  scrollPreviewLine(editor.state.doc.toString(), editor.state.selection.main.head);
}

function previewClosed(): boolean {
  return Boolean(previewEl.hidden) || !editing();
}

function scrollPreviewLine(source: string, cursor: number): void {
  const line = editor.state.doc.lineAt(cursor).number - 1;
  const blocks = [...previewEl.querySelectorAll<HTMLElement>("[data-line]")];
  const spans = blocks.map(blockSpan);
  const picked = blockAtLine(spans, line);
  if (picked < 0) previewEl.scrollTop = 0;
  else placePreviewScroll(source, cursor, blocks[picked], spans[picked]);
}

function blockSpan(block: HTMLElement): { start: number; end: number } {
  const start = Number(block.dataset.line);
  return { start, end: spanEnd(block, start) };
}

function placePreviewScroll(source: string, cursor: number, block: HTMLElement, span: { start: number; end: number }): void {
  const fraction = offsetFraction(cursor, lineOffset(source, span.start), lineOffset(source, span.end));
  const pane = previewEl.getBoundingClientRect();
  const rect = block.getBoundingClientRect();
  const spot = rect.top + rect.height * fraction;
  previewEl.scrollTop = scrollToSpot(previewEl.scrollTop, pane.top, spot, PREVIEW_SCROLL_PADDING);
}

function drawReading(): void {
  if (readingWholeBook()) paintWholeBook();
  else paintSelectionReading();
}

function readingWholeBook(): boolean {
  return openBookView() && !editing();
}

function openBookView(): boolean {
  return viewingBook() && book != null;
}

function paintWholeBook(): void {
  editorHost.hidden = true;
  readingEl.hidden = false;
  const rendered = renderBook(manuscriptNodes(book!.nodes));
  readingEl.innerHTML = showPictures(rendered.html);
  showWarnings([...bookWarnings(), ...rendered.warnings]);
}

function paintSelectionReading(): void {
  const current = selected();
  if (hideReading(current)) clearReading();
  else paintGroupReading(current);
}

function hideReading(current: Selection | null): current is null {
  if (!current) return true;
  return editingOrTrash(current.node);
}

function editingOrTrash(node: TreeNode): boolean {
  return editing() || isTrash(node);
}

function clearReading(): void {
  readingEl.hidden = true;
  readingEl.innerHTML = "";
  editorHost.hidden = !editing();
}

function paintGroupReading(current: Selection): void {
  editorHost.hidden = true;
  readingEl.hidden = false;
  const rendered = renderGroup(current.node, current.ancestors, groupDivisions());
  readingEl.innerHTML = showPictures(rendered.html);
  showWarnings([...bookWarnings(), ...rendered.warnings]);
}

function groupDivisions(): Map<string, Division> | undefined {
  return book ? divisions(book.nodes) : undefined;
}

function divisionOf(node: TreeNode): Division | undefined {
  if (!book) return undefined;
  return divisions(book.nodes).get(node.header.id);
}

function outlineTitle(node: TreeNode): string {
  return node.header.title || node.slug;
}

function bookWordCount(): number {
  if (!book) return 0;
  return manuscriptNodes(book.nodes).reduce((sum, node) => sum + nodeWordCount(node), 0);
}

function renderOutline(): void {
  outlineEl.replaceChildren();
  if (!book) return;
  appendOutline();
}

function appendOutline(): void {
  appendBookRow();
  if (bookOpen()) drawNodes(book!.nodes, 1);
}

function bookOpen(): boolean {
  return !collapsed.has(BOOK_ID);
}

function appendBookRow(): void {
  const bookRow = document.createElement("div");
  bookRow.className = bookRowClass();
  bookRow.dataset.id = BOOK_ID;
  bookRow.append(bookTwistButton(), bookBody());
  bookRow.addEventListener("click", () => void choose(BOOK_ID, false));
  bookRow.addEventListener("contextmenu", (event) => showBookMenu(event));
  outlineEl.append(bookRow);
}

function bookRowClass(): string {
  return `node book${viewingBook() ? " selected" : ""}`;
}

function bookTwistButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "twist";
  fillTwist(button, bookOpen(), "book");
  button.addEventListener("click", toggleBookRow);
  return button;
}

function fillTwist(button: HTMLButtonElement, open: boolean, noun: string): void {
  button.textContent = open ? "▾" : "▸";
  button.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-label", twistLabel(open, noun));
}

function twistLabel(open: boolean, noun: string): string {
  return open ? `Collapse ${noun}` : `Expand ${noun}`;
}

function toggleBookRow(event: Event): void {
  event.stopPropagation();
  toggleCollapsed(BOOK_ID);
  renderOutline();
}

function toggleCollapsed(id: string): void {
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
}

function bookBody(): HTMLElement {
  const body = document.createElement("div");
  body.className = "node-body";
  const label = document.createElement("span");
  label.className = "title";
  label.textContent = book!.title || "Book";
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `${bookWordCount()} words`;
  body.append(label, meta);
  return body;
}

function drawNodes(nodes: TreeNode[], depth: number): void {
  for (const node of nodes) appendOutlineNode(node, depth);
}

function appendOutlineNode(node: TreeNode, depth: number): void {
  outlineEl.append(outlineRow(node, depth));
  if (expandedGroup(node)) drawNodes(node.children, depth + 1);
}

function expandedGroup(node: TreeNode): boolean {
  return node.kind === "group" && !collapsed.has(node.header.id);
}

function outlineRow(node: TreeNode, depth: number): HTMLDivElement {
  const row = document.createElement("div");
  row.className = outlineRowClass(node);
  row.dataset.id = node.header.id;
  row.draggable = !isTrash(node);
  row.style.paddingLeft = `${0.35 + depth * 0.85}rem`;
  row.append(outlineGutter(node), outlineBody(node));
  wireOutlineRow(row, node);
  return row;
}

function outlineRowClass(node: TreeNode): string {
  return `node ${node.kind}${trashClass(node)}${selectedClass(node)}`;
}

function trashClass(node: TreeNode): string {
  return isTrash(node) ? " trash" : "";
}

function selectedClass(node: TreeNode): string {
  return node.header.id === selectedId ? " selected" : "";
}

function outlineGutter(node: TreeNode): HTMLElement {
  if (node.kind === "group") return folderTwist(node.header.id);
  return twistSpacer();
}

function folderTwist(id: string): HTMLButtonElement {
  const twist = document.createElement("button");
  twist.type = "button";
  twist.className = "twist";
  fillTwist(twist, !collapsed.has(id), "folder");
  twist.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleCollapsed(id);
    renderOutline();
  });
  return twist;
}

function twistSpacer(): HTMLElement {
  const spacer = document.createElement("span");
  spacer.className = "twist-spacer";
  return spacer;
}

function outlineBody(node: TreeNode): HTMLElement {
  const body = document.createElement("div");
  body.className = "node-body";
  appendDivision(body, node);
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = outlineTitle(node);
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `${node.header.status} · ${nodeWordCount(node)} words`;
  body.append(title, meta);
  appendSynopsis(body, node);
  return body;
}

function appendDivision(body: HTMLElement, node: TreeNode): void {
  const division = divisionOf(node);
  if (!division) return;
  const label = document.createElement("span");
  label.className = "chapter-number";
  label.textContent = divisionLabel(division);
  body.append(label);
}

function appendSynopsis(body: HTMLElement, node: TreeNode): void {
  if (!node.header.synopsis) return;
  const synopsis = document.createElement("span");
  synopsis.className = "synopsis";
  synopsis.textContent = node.header.synopsis;
  body.append(synopsis);
}

function wireOutlineRow(row: HTMLElement, node: TreeNode): void {
  row.addEventListener("click", () => void choose(node.header.id, false));
  row.addEventListener("contextmenu", (event) => openRowMenu(event, node.header.id));
  row.addEventListener("dragstart", (event) => startRowDrag(event, node.header.id));
  row.addEventListener("dragover", (event) => dragOverRow(event, row, node.kind === "group"));
  row.addEventListener("dragleave", () => clearDropClasses(row));
  row.addEventListener("drop", (event) => dropOnRow(event, row, node));
}

function openRowMenu(event: MouseEvent, id: string): void {
  const found = rowNode(id);
  if (found) showContextMenu(event, found.node, found.ancestors);
}

function rowNode(id: string): Selection | null {
  if (!book) return null;
  return findNode(book.nodes, id);
}

function startRowDrag(event: DragEvent, id: string): void {
  event.dataTransfer?.setData("text/plain", id);
  event.dataTransfer!.effectAllowed = "move";
}

function dragOverRow(event: DragEvent, row: HTMLElement, group: boolean): void {
  event.preventDefault();
  clearDropClasses(row);
  row.classList.add(dropClass(row, event.clientY, group));
}

function clearDropClasses(row: HTMLElement): void {
  row.classList.remove("drop-before", "drop-after", "drop-inside");
}

function dropOnRow(event: DragEvent, row: HTMLElement, node: TreeNode): void {
  event.preventDefault();
  const zone = dropZone(row, event.clientY, node.kind === "group");
  clearDropClasses(row);
  const moving = draggedId(event);
  if (moving) void drop(moving, node.header.id, zone);
}

function draggedId(event: DragEvent): string {
  const data = event.dataTransfer;
  if (!data) return "";
  return data.getData("text/plain");
}

function dropClass(row: HTMLElement, clientY: number, group: boolean): string {
  return `drop-${dropZone(row, clientY, group)}`;
}

function dropZone(row: HTMLElement, clientY: number, group: boolean): DropZone {
  const ratio = dropRatio(row, clientY);
  if (insideZone(group, ratio)) return "inside";
  return beforeOrAfter(ratio);
}

function dropRatio(row: HTMLElement, clientY: number): number {
  const rect = row.getBoundingClientRect();
  return (clientY - rect.top) / rect.height;
}

function insideZone(group: boolean, ratio: number): boolean {
  return group && withinMiddle(ratio);
}

function withinMiddle(ratio: number): boolean {
  return ratio > 0.28 && ratio < 0.72;
}

function beforeOrAfter(ratio: number): DropZone {
  return ratio < 0.5 ? "before" : "after";
}

function fillInspector(): void {
  const current = selected();
  inspector.hidden = !current;
  if (!current) return;
  fillInspectorFields(current.node);
}

function fillInspectorFields(node: TreeNode): void {
  fieldTitle.value = node.header.title;
  fieldSynopsis.value = node.header.synopsis;
  fieldStatus.value = node.header.status;
  fieldRole.value = node.header.role;
  fieldId.textContent = node.header.id;
  const trash = isTrash(node);
  setInspectorDisabled(trash);
  setUnitChecks(effectiveUnit(node), trash);
  setGroupButtons(node, trash);
}

function setInspectorDisabled(trash: boolean): void {
  fieldTitle.disabled = trash;
  fieldSynopsis.disabled = trash;
  fieldStatus.disabled = trash;
  fieldRole.disabled = trash;
}

function setUnitChecks(unit: Unit, trash: boolean): void {
  for (const input of unitInputs) setUnitInput(input, unit, trash);
}

function setUnitInput(input: HTMLInputElement, unit: Unit, trash: boolean): void {
  input.checked = input.value === unit;
  input.disabled = trash;
}

function setGroupButtons(node: TreeNode, trash: boolean): void {
  const group = node.kind === "group";
  editProse.hidden = hideEditProse(trash, group);
  readGroup.hidden = hideReadGroup(trash, group);
}

function hideEditProse(trash: boolean, group: boolean): boolean {
  return trash || notShowingEdit(group);
}

function notShowingEdit(group: boolean): boolean {
  return !group || editingProse;
}

function hideReadGroup(trash: boolean, group: boolean): boolean {
  return trash || notShowingRead(group);
}

function notShowingRead(group: boolean): boolean {
  return !group || !editingProse;
}

async function choose(id: string, prose: boolean): Promise<void> {
  if (sameSelection(id, prose)) {
    showCurrent();
    return;
  }
  await switchSelection(id, prose);
  showCurrent();
}

function sameSelection(id: string, prose: boolean): boolean {
  return selectedId === id && editingProse === prose;
}

async function switchSelection(id: string, prose: boolean): Promise<void> {
  navigating = true;
  try {
    await commitLeaving(id, prose);
  } finally {
    navigating = false;
  }
}

async function commitLeaving(id: string, prose: boolean): Promise<void> {
  cancelSave();
  await flushTwice();
  noteLeaving();
  selectedId = id;
  editingProse = prose;
  loadSelectedBody();
}

function noteLeaving(): void {
  const leaving = takeVisit();
  if (leaving) trail = noteVisit(trail, leaving);
}

async function refresh(keep: string | null, resetHistory = false): Promise<void> {
  if (!book) return;
  await reloadBook(keep, resetHistory);
}

async function reloadBook(keep: string | null, resetHistory: boolean): Promise<void> {
  const previousId = selectedId;
  const previousProse = editingProse;
  const loaded = await loadBook(fs, book!.root);
  book = loaded;
  selectedId = keptId(keep);
  const changed = selectionChanged(resetHistory, previousId, previousProse);
  if (changed) trail = emptyTrail();
  bookTitle.value = loaded.title;
  loadRefreshedDocument(changed);
  renderOutline();
  fillInspector();
  drawReading();
  drawPreview();
  showWarnings(loaded.warnings);
}

function keptId(keep: string | null): string {
  if (keepable(keep)) return keep;
  return BOOK_ID;
}

function keepable(keep: string | null): keep is string {
  return keep === BOOK_ID || nodeKept(keep);
}

function nodeKept(keep: string | null): boolean {
  return keep != null && bookHas(keep);
}

function bookHas(id: string): boolean {
  return book != null && findNode(book.nodes, id) != null;
}

function selectionChanged(resetHistory: boolean, previousId: string | null, previousProse: boolean): boolean {
  return resetHistory || idOrProseChanged(previousId, previousProse);
}

function idOrProseChanged(previousId: string | null, previousProse: boolean): boolean {
  return selectedId !== previousId || editingProse !== previousProse;
}

function loadRefreshedDocument(changed: boolean): void {
  const current = selected();
  if (refreshEditing(current)) loadDocument(current.node.body, changed);
  else loadBlankIfChanged(changed);
}

function refreshEditing(current: Selection | null): current is Selection {
  return current != null && editing();
}

function loadBlankIfChanged(changed: boolean): void {
  if (changed) loadDocument("", true);
}

async function openRoot(root: string): Promise<void> {
  const full = await canonicalRoot(root);
  if (!full) return;
  await openCanonical(full);
}

async function canonicalRoot(root: string): Promise<string | null> {
  try {
    return await fs.canonicalize(root);
  } catch (error) {
    showWarnings([String(error)]);
    return null;
  }
}

async function openCanonical(full: string): Promise<void> {
  const pictureWarning = await pictureAccess(full);
  const loaded = await loadBook(fs, full);
  book = loaded;
  selectedId = null;
  editingProse = false;
  trail = emptyTrail();
  bookTitle.value = loaded.title;
  document.title = titled(loaded.title);
  saveState.textContent = "Saved";
  await refresh(BOOK_ID, true);
  if (pictureWarning) showWarnings([...bookWarnings(), pictureWarning]);
}

async function pictureAccess(full: string): Promise<string> {
  try {
    await allowBook(full);
    return "";
  } catch (error) {
    return `Pictures in this book cannot be shown. ${String(error)}`;
  }
}

function titled(title: string): string {
  return title || "Bookwriter";
}

async function openFolder(): Promise<void> {
  const picked = await open({
    directory: true,
    title: "Open book",
    defaultPath: bookParent(),
  });
  if (typeof picked === "string") await openRoot(picked);
}

function bookParent(): string | undefined {
  return book ? parentPath(book.root) : undefined;
}

async function exportManuscript(): Promise<void> {
  if (!book) return;
  await writeFileExport("Export manuscript", "md", "Markdown", writeMarkdownExport);
}

async function flushedBook(): Promise<Book> {
  await flush();
  const loaded = await loadBook(fs, book!.root);
  book = loaded;
  return loaded;
}

async function writeFileExport(
  title: string,
  extension: string,
  label: string,
  write: (path: string) => Promise<void>,
): Promise<void> {
  const loaded = await flushedBook();
  const destination = await save({
    title,
    defaultPath: joinPath(loaded.root, `${exportStem(loaded.title)}.${extension}`),
    filters: [{ name: label, extensions: [extension] }],
  });
  if (typeof destination !== "string") return;
  await write(destination);
}

function exportStem(title: string): string {
  return slugify(title) || "manuscript";
}

async function writeMarkdownExport(destination: string): Promise<void> {
  const result = exportBook(manuscriptNodes(book!.nodes));
  await fs.writeText(destination, withTrailingNewline(result.markdown));
  showWarnings(result.warnings);
  saveState.textContent = exportStatus(result.warnings.length);
}

function withTrailingNewline(markdown: string): string {
  return markdown.endsWith("\n") ? markdown : markdown + "\n";
}

function exportStatus(warningCount: number): string {
  return warningCount ? "Exported with warnings" : "Exported";
}

async function exportPdfManuscript(): Promise<void> {
  if (!book) return;
  await safePdfExport();
}

async function safePdfExport(): Promise<void> {
  try {
    await writeFileExport("Export PDF", "pdf", "PDF", writePdfFile);
  } catch (error) {
    showWarnings([`PDF export failed: ${String(error)}`]);
    saveState.textContent = "Export failed";
  }
}

async function writePdfFile(destination: string): Promise<void> {
  const result = await exportPdfWithPictures(manuscriptNodes(book!.nodes), book!.title, fs, book!.root, { rasterize: rasterizePicture });
  await fs.writeText(destination, result.pdf);
  showWarnings(result.warnings);
  saveState.textContent = exportStatus(result.warnings.length);
}

async function exportDocxManuscript(): Promise<void> {
  if (!book) return;
  await safeDocxExport();
}

async function safeDocxExport(): Promise<void> {
  try {
    await writeDocxExport();
  } catch (error) {
    showWarnings([`Word export failed: ${String(error)}`]);
    saveState.textContent = "Export failed";
  }
}

async function writeDocxExport(): Promise<void> {
  const loaded = await flushedBook();
  const directory = await pickDocxDirectory(loaded.root);
  if (typeof directory !== "string") return;
  await writeDocxFiles(directory);
}

function pickDocxDirectory(root: string) {
  return open({
    directory: true,
    title: "Export chapters to Word",
    defaultPath: root,
  });
}

async function writeDocxFiles(directory: string): Promise<void> {
  const result = exportDocxFiles(manuscriptNodes(book!.nodes));
  await writePresentDocx(directory, result);
}

async function writePresentDocx(directory: string, result: ReturnType<typeof exportDocxFiles>): Promise<void> {
  if (result.files.length === 0) {
    emptyDocxExport();
    return;
  }
  await finishDocxExport(directory, result);
}

function emptyDocxExport(): void {
  showWarnings(["There are no chapters or front matter to export."]);
  saveState.textContent = "Export failed";
}

async function finishDocxExport(directory: string, result: ReturnType<typeof exportDocxFiles>): Promise<void> {
  await writeDocxList(directory, result.files);
  showWarnings(result.warnings);
  saveState.textContent = exportStatus(result.warnings.length);
}

async function writeDocxList(directory: string, files: ReturnType<typeof exportDocxFiles>["files"]): Promise<void> {
  for (const file of files) await writeDocxFile(directory, file);
}

async function writeDocxFile(directory: string, file: ReturnType<typeof exportDocxFiles>["files"][number]): Promise<void> {
  await pandocDocx(withTrailingNewline(file.markdown), joinPath(directory, file.name), book!.root);
}

createDialog.addEventListener("click", (event) => {
  if (event.target === createDialog && createDialog.open) createDialog.close("cancel");
});

function askTitle(label: string): Promise<string | null> {
  createLabel.textContent = label;
  createTitle.value = "";
  createDialog.showModal();
  createTitle.focus();
  return new Promise((resolve) => {
    createDialog.addEventListener(
      "close",
      () => resolve(createDialog.returnValue === "ok" ? createTitle.value.trim() : null),
      { once: true },
    );
  });
}

createTitle.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !createDialog.open) return;
  event.preventDefault();
  createDialog.querySelector<HTMLButtonElement>('button[value="ok"]')?.click();
});

function clearBarMenu(): void {
  delete contextMenu.dataset.menu;
  collapseBar("#btn-file");
  collapseBar("#btn-edit");
}

function collapseBar(selector: string): void {
  document.querySelector(selector)?.setAttribute("aria-expanded", "false");
}

function closeContextMenu(): void {
  contextMenu.hidden = true;
  contextMenu.replaceChildren();
  clearBarMenu();
}

type MenuEntry = { label: string; shortcut?: string; run: () => void };

function usesMacShortcuts(): boolean {
  return /\bMac/.test(navigator.platform) || /\bMac/.test(navigator.userAgent);
}

function menuButton(entry: MenuEntry, keepFocus: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  const name = document.createElement("span");
  name.textContent = entry.label;
  button.append(name);
  appendShortcut(button, entry.shortcut);
  if (keepFocus) button.addEventListener("pointerdown", (event) => event.preventDefault());
  button.addEventListener("click", (click) => runMenuEntry(click, entry));
  return button;
}

function appendShortcut(button: HTMLButtonElement, shortcut: string | undefined): void {
  if (!shortcut) return;
  const key = document.createElement("span");
  key.className = "menu-key";
  key.textContent = shortcut;
  button.append(key);
}

function runMenuEntry(click: Event, entry: MenuEntry): void {
  click.stopPropagation();
  closeContextMenu();
  entry.run();
}

function showBarMenu(anchor: HTMLElement, actions: MenuEntry[]): void {
  closeContextMenu();
  contextMenu.dataset.menu = anchor.id;
  for (const action of actions) contextMenu.append(menuButton(action, true));
  anchor.setAttribute("aria-expanded", "true");
  const rect = anchor.getBoundingClientRect();
  placeContextMenu(rect.left, rect.bottom + 4);
}

function toggleBarMenu(event: Event, anchor: HTMLElement, actions: MenuEntry[]): void {
  event.preventDefault();
  event.stopPropagation();
  if (barMenuOpen(anchor)) closeContextMenu();
  else showBarMenu(anchor, actions);
}

function barMenuOpen(anchor: HTMLElement): boolean {
  return !contextMenu.hidden && contextMenu.dataset.menu === anchor.id;
}

function placeContextMenu(x: number, y: number): void {
  contextMenu.hidden = false;
  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
  clampContextMenu(x, y);
}

function clampContextMenu(x: number, y: number): void {
  const rect = contextMenu.getBoundingClientRect();
  clampMenuLeft(rect, x);
  clampMenuTop(rect, y);
}

function clampMenuLeft(rect: DOMRect, x: number): void {
  if (rect.right > window.innerWidth) contextMenu.style.left = `${Math.max(8, x - rect.width)}px`;
}

function clampMenuTop(rect: DOMRect, y: number): void {
  if (rect.bottom > window.innerHeight) contextMenu.style.top = `${Math.max(8, y - rect.height)}px`;
}

function showContextMenu(event: MouseEvent, node: TreeNode, ancestors: TreeNode[]): void {
  event.preventDefault();
  clearBarMenu();
  fillContextActions(node, ancestors);
  placeContextMenu(event.clientX, event.clientY);
}

function showBookMenu(event: MouseEvent): void {
  event.preventDefault();
  clearBarMenu();
  fillBookActions();
  placeContextMenu(event.clientX, event.clientY);
}

function fillBookActions(): void {
  contextMenu.replaceChildren();
  for (const action of bookActions()) appendContextAction(action);
}

function bookActions(): ContextAction[] {
  return [
    { label: "Add text", run: () => addTextAtBook() },
    { label: "Add folder", run: () => addFolderAtBook() },
  ];
}

function fillContextActions(node: TreeNode, ancestors: TreeNode[]): void {
  const actions = contextActions(node, nodeInTrash(node, ancestors));
  contextMenu.replaceChildren();
  for (const action of actions) appendContextAction(action);
}

function nodeInTrash(node: TreeNode, ancestors: TreeNode[]): boolean {
  return isTrash(node) || ancestors.some(isTrash);
}

function contextActions(node: TreeNode, inTrash: boolean): ContextAction[] {
  if (isTrash(node)) return trashActions();
  return rowActions(node, inTrash);
}

function rowActions(node: TreeNode, inTrash: boolean): ContextAction[] {
  const actions = node.kind === "group" ? groupActions(node) : sectionActions(node);
  return withDelete(actions, node, inTrash);
}

function trashActions(): ContextAction[] {
  return [{ label: "Empty trash", run: () => emptyTheTrash() }];
}

function groupActions(node: TreeNode): ContextAction[] {
  return [
    { label: "Add text", run: () => addTextAtTop(node.header.id) },
    { label: "Add folder", run: () => addInside(node.header.id, "group") },
  ];
}

function sectionActions(node: TreeNode): ContextAction[] {
  return [{ label: "Add text", run: () => addTextBelow(node.header.id) }];
}

function withDelete(actions: ContextAction[], node: TreeNode, inTrash: boolean): ContextAction[] {
  if (inTrash) return actions;
  return [...actions, { label: "Delete", run: () => deleteItem(node.header.id) }];
}

function appendContextAction(action: ContextAction): void {
  contextMenu.append(menuButton({ label: action.label, run: () => void action.run() }, false));
}

function showCommandMenu(event: MouseEvent): void {
  event.preventDefault();
  clearBarMenu();
  placeCommandCursor(event);
  contextMenu.replaceChildren();
  appendCommandItems();
  placeContextMenu(event.clientX, event.clientY);
}

function placeCommandCursor(event: MouseEvent): void {
  const pos = editor.posAtCoords({ x: event.clientX, y: event.clientY });
  if (!keepsSelection(pos, editor.state.selection.main)) placeCursor(resolvedPos(pos));
}

function resolvedPos(pos: number | null): number {
  return pos ?? editor.state.doc.length;
}

function keepsSelection(pos: number | null, range: { empty: boolean; from: number; to: number }): boolean {
  return pos != null && selectionCovers(pos, range);
}

function selectionCovers(pos: number, range: { empty: boolean; from: number; to: number }): boolean {
  return !range.empty && posInside(pos, range);
}

function posInside(pos: number, range: { from: number; to: number }): boolean {
  return pos >= range.from && pos <= range.to;
}

function appendCommandItems(): void {
  const mac = usesMacShortcuts();
  for (const command of COMMANDS) appendCommandItem(command, mac);
}

function appendCommandItem(command: MarkupCommand, mac: boolean): void {
  contextMenu.append(menuButton({
    label: command.name,
    shortcut: commandShortcut(command.accelerator, mac),
    run: () => runCommand(command.id),
  }, false));
}

function commandShortcut(accelerator: string | undefined, mac: boolean): string | undefined {
  return accelerator ? formatAccelerator(accelerator, mac) : undefined;
}

async function addTextAtBook(): Promise<void> {
  if (!book) return;
  await insertTextAtBook();
}

async function insertTextAtBook(): Promise<void> {
  const title = await askTitle("New text");
  if (!title) return;
  await placeTextAtBook(title);
}

async function placeTextAtBook(title: string): Promise<void> {
  await flush();
  const id = await createNode(fs, book!, null, "section", title);
  book = await loadBook(fs, book!.root);
  await moveBeforeFirstRoot(id);
  collapsed.delete(BOOK_ID);
  editingProse = false;
  await refresh(id);
  await choose(id, false);
}

async function moveBeforeFirstRoot(id: string): Promise<void> {
  const first = nodeId(rootBesides(id));
  if (first) await moveNode(fs, book!, id, first, "before");
}

function rootBesides(id: string): TreeNode | undefined {
  return bookNodes().find((node) => keptRoot(node, id));
}

function bookNodes(): TreeNode[] {
  if (!book) return [];
  return book.nodes;
}

function keptRoot(node: TreeNode, id: string): boolean {
  return node.header.id !== id && !isTrash(node);
}

async function addFolderAtBook(): Promise<void> {
  if (!book) return;
  await insertFolderAtBook();
}

async function insertFolderAtBook(): Promise<void> {
  const title = await askTitle("New folder");
  if (!title) return;
  await finishFolderAtBook(title);
}

async function finishFolderAtBook(title: string): Promise<void> {
  await flush();
  const id = await createNode(fs, book!, null, "group", title);
  collapsed.delete(BOOK_ID);
  editingProse = true;
  await refresh(id);
  await choose(id, true);
}

async function addTextAtTop(parentId: string): Promise<void> {
  if (!book) return;
  await insertTextAtTop(parentId);
}

async function insertTextAtTop(parentId: string): Promise<void> {
  const title = await askTitle("New text");
  if (!title) return;
  await placeTextAtTop(parentId, title);
}

async function placeTextAtTop(parentId: string, title: string): Promise<void> {
  await flush();
  const id = await createNode(fs, book!, parentId, "section", title);
  book = await loadBook(fs, book!.root);
  await moveBeforeFirst(parentId, id);
  collapsed.delete(parentId);
  editingProse = false;
  await refresh(id);
  await choose(id, false);
}

async function moveBeforeFirst(parentId: string, id: string): Promise<void> {
  const parent = findNode(book!.nodes, parentId);
  const first = otherChild(parent, id);
  if (first) await moveNode(fs, book!, id, first.header.id, "before");
}

function otherChild(parent: Selection | null, id: string): TreeNode | undefined {
  return parent?.node.children.find((child) => child.header.id !== id);
}

async function addInside(parentId: string, kind: "group" | "section"): Promise<void> {
  if (!book) return;
  await insertInside(parentId, kind);
}

async function insertInside(parentId: string, kind: "group" | "section"): Promise<void> {
  const title = await askTitle(kindLabel(kind));
  if (!title) return;
  await finishInside(parentId, kind, title);
}

function kindLabel(kind: "group" | "section"): string {
  return kind === "group" ? "New folder" : "New text";
}

async function finishInside(parentId: string, kind: "group" | "section", title: string): Promise<void> {
  await flush();
  const id = await createNode(fs, book!, parentId, kind, title);
  collapsed.delete(parentId);
  editingProse = kind === "group";
  await refresh(id);
  await choose(id, kind === "group");
}

async function addTextBelow(sectionId: string): Promise<void> {
  if (!book) return;
  await insertTextBelow(sectionId);
}

async function insertTextBelow(sectionId: string): Promise<void> {
  const title = await askTitle("New text");
  if (!title) return;
  await placeTextBelow(sectionId, title);
}

async function placeTextBelow(sectionId: string, title: string): Promise<void> {
  await flush();
  const found = findNode(book!.nodes, sectionId);
  if (!found) return;
  await finishTextBelow(sectionId, title, found.ancestors.at(-1));
}

async function finishTextBelow(sectionId: string, title: string, parent: TreeNode | undefined): Promise<void> {
  const id = await createNode(fs, book!, nodeId(parent), "section", title);
  book = await loadBook(fs, book!.root);
  await moveNode(fs, book, id, sectionId, "after");
  if (parent) collapsed.delete(parent.header.id);
  editingProse = false;
  await refresh(id);
  await choose(id, false);
}

async function emptyTheTrash(): Promise<void> {
  if (!book) return;
  await clearTrash();
}

async function clearTrash(): Promise<void> {
  await keepOpenEdits();
  const next = selectionAfterEmpty();
  releaseDeletedProse(next);
  await emptyTrash(fs, book!);
  await refresh(next);
}

async function keepOpenEdits(): Promise<void> {
  if (openInsideTrash()) cancelSave();
  else await flush();
}

function releaseDeletedProse(next: string | null): void {
  if (next !== selectedId) editingProse = false;
}

function selectionAfterEmpty(): string | null {
  if (openInsideTrash()) return outsideTrash();
  return selectedId;
}

function openInsideTrash(): boolean {
  const current = selected();
  return current != null && insideTrash(current);
}

function insideTrash(current: Selection): boolean {
  return current.ancestors.some(isTrash);
}

function outsideTrash(): string | null {
  const current = selected();
  return ancestorOutside(current) ?? firstManuscriptId();
}

function ancestorOutside(current: Selection | null): string | undefined {
  if (!current) return undefined;
  return survivingAncestor(current);
}

async function deleteItem(id: string): Promise<void> {
  if (!book) return;
  await removeItem(id);
}

async function removeItem(id: string): Promise<void> {
  const current = findNode(book!.nodes, id);
  if (blockedDelete(current)) return;
  await finishDelete(id, current);
}

function blockedDelete(current: Selection | null): current is null {
  return current == null || trashedNode(current);
}

function trashedNode(current: Selection): boolean {
  return isTrash(current.node) || current.ancestors.some(isTrash);
}

async function finishDelete(id: string, current: Selection): Promise<void> {
  if (selectedId === id) await flush();
  const next = nextAfterDelete(current);
  await deleteNode(fs, book!, id);
  clearProseIfDeleted(id);
  await refresh(refreshAfterDelete(id, next));
}

function clearProseIfDeleted(id: string): void {
  if (selectedId === id) editingProse = false;
}

function refreshAfterDelete(id: string, next: string | null): string | null {
  return selectedId === id ? next : selectedId;
}

function nextAfterDelete(current: Selection): string | null {
  return survivingAncestor(current) ?? firstManuscriptId();
}

function survivingAncestor(current: Selection): string | undefined {
  return [...current.ancestors].reverse().find((node) => !isTrash(node))?.header.id;
}

function firstManuscriptId(): string | null {
  return nodeId(manuscriptNodes(book!.nodes)[0]);
}

function nodeId(node: TreeNode | undefined): string | null {
  if (!node) return null;
  return node.header.id;
}

async function create(kind: "group" | "section"): Promise<void> {
  if (!book) return;
  await createTitled(kind);
}

async function createTitled(kind: "group" | "section"): Promise<void> {
  const title = await askTitle(kindLabel(kind));
  if (!title) return;
  await finishCreate(kind, title);
}

async function finishCreate(kind: "group" | "section", title: string): Promise<void> {
  await flush();
  const id = await createNode(fs, book!, createParentId(), kind, title);
  editingProse = kind === "group";
  await refresh(id);
  await choose(id, kind === "group");
}

function createParentId(): string | null {
  const current = selected();
  if (underTrash(current)) return null;
  return parentFor(current);
}

function underTrash(current: Selection | null): boolean {
  return current != null && nodeOrAncestorTrash(current);
}

function nodeOrAncestorTrash(current: Selection): boolean {
  return isTrash(current.node) || current.ancestors.some(isTrash);
}

function parentFor(current: Selection | null): string | null {
  if (selectedGroup(current)) return current.node.header.id;
  return ancestorParent(current);
}

function selectedGroup(current: Selection | null): current is Selection {
  return current?.node.kind === "group";
}

function ancestorParent(current: Selection | null): string | null {
  if (!current) return null;
  return nodeId(current.ancestors.at(-1));
}

async function deleteSelected(): Promise<void> {
  if (selectedId) await deleteItem(selectedId);
}

async function drop(movingId: string, targetId: string, zone: DropZone): Promise<void> {
  if (cannotDrop(movingId, targetId)) return;
  await finishDrop(movingId, targetId, zone);
}

function cannotDrop(movingId: string, targetId: string): boolean {
  return book == null || movingId === targetId;
}

async function finishDrop(movingId: string, targetId: string, zone: DropZone): Promise<void> {
  await flush();
  await moveNode(fs, book!, movingId, targetId, zone);
  await refresh(movingId);
}

function runCommand(id: CommandId): void {
  if (id === "picture") void choosePicture();
  else applyEditingCommand(id);
}

function applyEditingCommand(id: CommandId): void {
  if (!editing()) return;
  const range = editor.state.selection.main;
  const result = applyCommand(id, editor.state.doc.toString(), range.anchor, range.head, latestLanguage(commandBodies()));
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: result.text },
    selection: { anchor: result.anchor, head: result.head },
  });
  editor.focus();
}

function commandBodies(): string[] {
  const bodies: string[] = [];
  if (book) walk(book.nodes, (node) => bodies.push(commandBody(node)));
  return bodies;
}

function commandBody(node: TreeNode): string {
  return node.header.id === selectedId ? editor.state.doc.toString() : node.body;
}

async function choosePicture(): Promise<void> {
  if (cannotPickPicture()) return;
  await pickPicture(book!.root);
}

function cannotPickPicture(): boolean {
  return book == null || !editing();
}

async function pickPicture(root: string): Promise<void> {
  const picked = await open({
    title: "Picture",
    defaultPath: root,
    multiple: false,
    filters: [{ name: "Pictures", extensions: PICTURE_EXTENSIONS }],
  });
  if (!pictureStillOpen(picked, root)) return;
  await insertPicture(root, picked);
}

function pictureStillOpen(picked: unknown, root: string): picked is string {
  return typeof picked === "string" && samePictureBook(root);
}

function samePictureBook(root: string): boolean {
  return currentBookIs(root) && editing();
}

function currentBookIs(root: string): boolean {
  return book?.root === root;
}

async function insertPicture(root: string, picked: string): Promise<void> {
  const relative = await movedPicture(root, picked);
  if (relative == null) return;
  dispatchPicture(relative);
}

async function movedPicture(root: string, picked: string): Promise<string | null> {
  try {
    return await placePicture(fs, root, picked);
  } catch (error) {
    showWarnings([`The picture could not be moved into the book. ${String(error)}`]);
    return null;
  }
}

function dispatchPicture(relative: string): void {
  const range = editor.state.selection.main;
  const result = applyCommand("picture", editor.state.doc.toString(), range.anchor, range.head, "", relative);
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: result.text },
    selection: { anchor: result.anchor, head: result.head },
  });
  editor.focus();
}

function matchingCommands(): typeof COMMANDS {
  const query = paletteInput.value.trim().toLowerCase();
  return COMMANDS.filter((command) => command.name.toLowerCase().includes(query));
}

function drawPalette(): void {
  const matches = matchingCommands();
  if (paletteIndex >= matches.length) paletteIndex = 0;
  paletteList.replaceChildren();
  matches.forEach(appendPaletteItem);
}

function appendPaletteItem(command: MarkupCommand, index: number): void {
  const item = document.createElement("li");
  item.textContent = paletteLabel(command);
  if (index === paletteIndex) item.className = "active";
  item.addEventListener("mousedown", (event) => activatePalette(event, command.id));
  paletteList.append(item);
}

function paletteLabel(command: MarkupCommand): string {
  return command.accelerator ? `${command.name}  ${command.inserts}` : `${command.name}  ${command.inserts}`;
}

function activatePalette(event: Event, id: CommandId): void {
  event.preventDefault();
  closePalette();
  runCommand(id);
}

function openPalette(): void {
  palette.hidden = false;
  paletteInput.value = "";
  paletteIndex = 0;
  drawPalette();
  paletteInput.focus();
}

function closePalette(): void {
  palette.hidden = true;
}

function openReminder(): void {
  reminderRows.replaceChildren();
  for (const command of COMMANDS) appendReminderRow(command);
  reminder.hidden = false;
}

function appendReminderRow(command: MarkupCommand): void {
  const row = document.createElement("tr");
  const name = document.createElement("td");
  name.textContent = reminderName(command);
  const inserts = document.createElement("td");
  inserts.textContent = command.inserts;
  row.append(name, inserts);
  reminderRows.append(row);
}

function reminderName(command: MarkupCommand): string {
  return command.accelerator ? `${command.name}` : command.name;
}

function runEdit(action: () => Promise<void>, label: string): void {
  void action().catch((error: unknown) => showWarnings([`${label} failed. ${String(error)}`]));
}

function activeField(): HTMLInputElement | HTMLTextAreaElement | null {
  const active = document.activeElement;
  if (editableField(active)) return active;
  return null;
}

function editableField(active: Element | null): active is HTMLInputElement | HTMLTextAreaElement {
  if (!isTextField(active)) return false;
  return fieldOpen(active);
}

function isTextField(active: Element | null): active is HTMLInputElement | HTMLTextAreaElement {
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
}

function fieldOpen(active: HTMLInputElement | HTMLTextAreaElement): boolean {
  return !active.readOnly && !active.disabled;
}

function replaceFieldSelection(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const start = selectionBound(field.selectionStart);
  const end = selectionBound(field.selectionEnd);
  field.setRangeText(text, start, end, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

async function editCopy(): Promise<void> {
  const field = activeField();
  if (field) await copyField(field);
  else await copyEditor();
}

async function copyField(field: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
  await writeText(field.value.slice(selectionBound(field.selectionStart), selectionBound(field.selectionEnd)));
}

function selectionBound(value: number | null): number {
  return value ?? 0;
}

async function copyEditor(): Promise<void> {
  if (!editing()) return;
  const range = editor.state.selection.main;
  await writeText(editor.state.sliceDoc(range.from, range.to));
}

async function editCut(): Promise<void> {
  const field = activeField();
  if (field) await cutField(field);
  else await cutEditor();
}

async function cutField(field: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
  await writeText(field.value.slice(selectionBound(field.selectionStart), selectionBound(field.selectionEnd)));
  replaceFieldSelection(field, "");
}

async function cutEditor(): Promise<void> {
  if (!editing()) return;
  const range = editor.state.selection.main;
  await writeText(editor.state.sliceDoc(range.from, range.to));
  editor.dispatch({
    changes: { from: range.from, to: range.to, insert: "" },
    selection: { anchor: range.from, head: range.from },
  });
}

async function editPaste(): Promise<void> {
  const text = await readText();
  const field = activeField();
  if (field) replaceFieldSelection(field, text);
  else pasteEditor(text);
}

function pasteEditor(text: string): void {
  if (!editing()) return;
  const range = editor.state.selection.main;
  editor.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length, head: range.from + text.length },
  });
  editor.focus();
}

function openFind(): void {
  if (!editing()) return;
  openSearchPanel(editor);
  wireBookFind(editor);
}

function openReplace(): void {
  if (!editing()) return;
  openSearchPanel(editor);
  wireBookFind(editor);
  focusReplaceField();
}

function focusReplaceField(): void {
  editor.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]")?.focus();
}

function goToMatch(direction: "next" | "previous"): void {
  if (!editing()) return;
  stepMatch(direction);
}

function stepMatch(direction: "next" | "previous"): void {
  if (searchWholeBook) void findInBook(direction);
  else stepLocalMatch(direction);
}

function stepLocalMatch(direction: "next" | "previous"): void {
  if (direction === "next") findNext(editor);
  else findPrevious(editor);
}

/** Texts in tree order. The open buffer is used for the current node, so unsaved words are included. Trash is left out. */
function searchParts(): FindPart[] {
  if (!book) return [];
  return bookSearchParts();
}

function bookSearchParts(): FindPart[] {
  const current = selected();
  const parts: FindPart[] = [];
  walk(manuscriptNodes(book!.nodes), (node) => parts.push(searchPart(node, current)));
  if (missingOpenPart(current, parts)) parts.push(openPart(current!));
  return parts;
}

function searchPart(node: TreeNode, current: Selection | null): FindPart {
  return { id: node.header.id, text: searchPartText(node, current) };
}

function searchPartText(node: TreeNode, current: Selection | null): string {
  if (openBuffer(node, current)) return editor.state.doc.toString();
  return node.body;
}

function openBuffer(node: TreeNode, current: Selection | null): boolean {
  return current != null && node.header.id === current.node.header.id;
}

function missingOpenPart(current: Selection | null, parts: FindPart[]): boolean {
  return current != null && openPartMissing(current, parts);
}

function openPartMissing(current: Selection, parts: FindPart[]): boolean {
  return editing() && !parts.some((part) => part.id === current.node.header.id);
}

function openPart(current: Selection): FindPart {
  return { id: current.node.header.id, text: editor.state.doc.toString() };
}

function selectMatch(from: number, to: number): void {
  const range = EditorSelection.range(from, to);
  editor.dispatch({
    selection: range,
    effects: EditorView.scrollIntoView(range),
    userEvent: "select.search",
  });
}

function focusSearch(): void {
  editor.dom.querySelector<HTMLInputElement>(".cm-search [main-field]")?.focus();
}

/** The panel's next, previous, and Enter follow the whole book checkbox once the panel is open. */
function wireBookFind(view: EditorView): void {
  const panel = view.dom.querySelector<HTMLElement>(".cm-search");
  if (bookFindWired(panel)) return;
  attachBookFind(panel, view);
}

function bookFindWired(panel: HTMLElement | null): panel is null {
  return panel == null || panel.dataset.bookFind != null;
}

function attachBookFind(panel: HTMLElement, view: EditorView): void {
  panel.dataset.bookFind = "true";
  placeBookLabel(panel, bookLabel(bookCheckbox(), view));
  watchBookButton(panel, "button[name=next]", "next");
  watchBookButton(panel, "button[name=prev]", "previous");
  panel.addEventListener("keydown", onBookFindKey, true);
}

function watchBookButton(panel: HTMLElement, selector: string, direction: "next" | "previous"): void {
  panel.querySelector(selector)?.addEventListener("click", (event) => takeBookMatch(direction, event), true);
}

function bookCheckbox(): HTMLInputElement {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.name = "book";
  box.checked = searchWholeBook;
  box.addEventListener("change", () => {
    searchWholeBook = box.checked;
  });
  return box;
}

function bookLabel(box: HTMLInputElement, view: EditorView): HTMLLabelElement {
  const label = document.createElement("label");
  label.append(box, view.state.phrase("whole book"));
  return label;
}

function placeBookLabel(panel: HTMLElement, label: HTMLLabelElement): void {
  const word = wordRow(panel);
  if (word) word.after(label);
  else panel.append(label);
}

function wordRow(panel: HTMLElement): Element | null {
  return inputParent(panel.querySelector('input[name="word"]'));
}

function inputParent(input: Element | null): Element | null {
  if (!input) return null;
  return input.parentElement;
}

function takeBookMatch(direction: "next" | "previous", event: Event): void {
  if (!searchWholeBook) return;
  event.stopImmediatePropagation();
  event.preventDefault();
  void findInBook(direction);
}

function onBookFindKey(event: KeyboardEvent): void {
  if (ignoreBookFindKey(event)) return;
  matchFromSearchField(event);
}

function ignoreBookFindKey(event: KeyboardEvent): boolean {
  return !searchWholeBook || blockedFindKey(event);
}

function blockedFindKey(event: KeyboardEvent): boolean {
  return event.key !== "Enter" || modifierFindKey(event);
}

function modifierFindKey(event: KeyboardEvent): boolean {
  return event.altKey || metaOrCtrl(event);
}

function metaOrCtrl(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

function matchFromSearchField(event: KeyboardEvent): void {
  if (!searchField(event.target)) return;
  takeBookMatch(bookFindDirection(event), event);
}

function bookFindDirection(event: KeyboardEvent): "next" | "previous" {
  return event.shiftKey ? "previous" : "next";
}

function searchField(target: EventTarget | null): target is HTMLInputElement {
  return target instanceof HTMLInputElement && target.name === "search";
}

let finding = false;

async function findInBook(direction: "next" | "previous"): Promise<void> {
  if (findBusy()) return;
  await seekInBook(direction);
}

function findBusy(): boolean {
  return finding || notSearching();
}

function notSearching(): boolean {
  return !editing() || book == null;
}

async function seekInBook(direction: "next" | "previous"): Promise<void> {
  const query = getSearchQuery(editor.state);
  if (!query.valid) showSearchPanel();
  else await seekValid(direction, query);
}

function showSearchPanel(): void {
  openSearchPanel(editor);
  wireBookFind(editor);
}

async function seekValid(direction: "next" | "previous", query: SearchQuery): Promise<void> {
  const current = selected();
  if (!current) return;
  await revealHit(direction, current, query);
}

async function revealHit(direction: "next" | "previous", current: Selection, query: SearchQuery): Promise<void> {
  const hit = bookHit(direction, current.node.header.id, query);
  if (!hit) return;
  await showHit(hit, current.node.header.id, query);
}

function bookHit(direction: "next" | "previous", id: string, query: SearchQuery): FindHit | null {
  const from = matchOrigin(direction);
  if (direction === "next") return nextMatch(searchParts(), id, from, query);
  return previousMatch(searchParts(), id, from, query);
}

function matchOrigin(direction: "next" | "previous"): number {
  return direction === "next" ? editor.state.selection.main.to : editor.state.selection.main.from;
}

async function showHit(hit: FindHit, currentId: string, query: SearchQuery): Promise<void> {
  const fromPanel = searchFieldFocused();
  if (hit.id !== currentId) await jumpToHit(hit, query, fromPanel);
  else showLocalHit(hit, fromPanel);
}

function searchFieldFocused(): boolean {
  return elementContains(editor.dom.querySelector(".cm-search"), document.activeElement);
}

function elementContains(panel: Element | null, active: Element | null): boolean {
  if (!panel) return false;
  return panel.contains(active);
}

function showLocalHit(hit: FindHit, fromPanel: boolean): void {
  selectMatch(hit.from, hit.to);
  if (fromPanel) focusSearch();
}

async function jumpToHit(hit: FindHit, query: SearchQuery, fromPanel: boolean): Promise<void> {
  const found = findNode(book!.nodes, hit.id);
  if (!found) return;
  await landOnHit(hit, found.node.kind === "group", query, fromPanel);
}

async function landOnHit(hit: FindHit, prose: boolean, query: SearchQuery, fromPanel: boolean): Promise<void> {
  finding = true;
  try {
    await openHit(hit, prose, query, fromPanel);
  } finally {
    finding = false;
  }
}

async function openHit(hit: FindHit, prose: boolean, query: SearchQuery, fromPanel: boolean): Promise<void> {
  await choose(hit.id, prose);
  openSearchPanel(editor);
  editor.dispatch({ effects: setSearchQuery.of(query) });
  wireBookFind(editor);
  selectHitIfPresent(hit);
  if (fromPanel) focusSearch();
}

function selectHitIfPresent(hit: FindHit): void {
  if (hit.to <= editor.state.doc.length) selectMatch(hit.from, hit.to);
}

async function installMenu(): Promise<void> {
  const formatItems = await Promise.all(
    COMMANDS.map((command) =>
      MenuItem.new({
        id: command.id,
        text: command.name,
        accelerator: command.accelerator,
        action: () => runCommand(command.id),
      }),
    ),
  );
  const menu = await Menu.new({
    items: [
      await Submenu.new({
        text: "Bookwriter",
        items: [
          await PredefinedMenuItem.new({ item: "Hide" }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await PredefinedMenuItem.new({ item: "Quit" }),
        ],
      }),
      await Submenu.new({
        text: "File",
        items: [
          await MenuItem.new({ id: "open", text: "Open Book…", accelerator: "CmdOrCtrl+O", action: () => void openFolder() }),
          await MenuItem.new({ id: "export", text: "Export Manuscript…", accelerator: "CmdOrCtrl+Shift+E", action: () => void exportManuscript() }),
          await MenuItem.new({ id: "export-pdf", text: "Export PDF…", action: () => void exportPdfManuscript() }),
          await MenuItem.new({ id: "export-docx", text: "Export Chapters to Word…", action: () => void exportDocxManuscript() }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await MenuItem.new({ id: "new-section", text: "Text", action: () => void create("section") }),
          await MenuItem.new({ id: "new-group", text: "Folder", action: () => void create("group") }),
          await MenuItem.new({ id: "delete", text: "Delete", action: () => void deleteSelected() }),
        ],
      }),
      await Submenu.new({
        text: "Edit",
        items: [
          await MenuItem.new({ id: "undo", text: "Undo", accelerator: "CmdOrCtrl+Z", action: () => menuHistory("undo") }),
          await MenuItem.new({ id: "redo", text: "Redo", accelerator: "CmdOrCtrl+Shift+Z", action: () => menuHistory("redo") }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await PredefinedMenuItem.new({ item: "Cut" }),
          await PredefinedMenuItem.new({ item: "Copy" }),
          await PredefinedMenuItem.new({ item: "Paste" }),
          await PredefinedMenuItem.new({ item: "SelectAll" }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await MenuItem.new({ id: "find", text: "Find…", accelerator: "CmdOrCtrl+F", action: openFind }),
          await MenuItem.new({ id: "find-next", text: "Find Next", accelerator: "CmdOrCtrl+G", action: () => goToMatch("next") }),
          await MenuItem.new({ id: "find-previous", text: "Find Previous", accelerator: "CmdOrCtrl+Shift+G", action: () => goToMatch("previous") }),
          await MenuItem.new({ id: "replace", text: "Replace…", accelerator: "CmdOrCtrl+Alt+F", action: openReplace }),
        ],
      }),
      await Submenu.new({ text: "Format", items: formatItems }),
      await Submenu.new({
        text: "View",
        items: [
          await MenuItem.new({ id: "palette", text: "Command Palette", accelerator: "CmdOrCtrl+K", action: openPalette }),
          await MenuItem.new({ id: "reminder", text: "Markup", action: openReminder }),
          await MenuItem.new({
            id: "preview",
            text: "Preview",
            accelerator: "CmdOrCtrl+Shift+P",
            action: () => document.querySelector<HTMLButtonElement>("#btn-preview")!.click(),
          }),
        ],
      }),
    ],
  });
  await menu.setAsAppMenu();
}

const fileButton = document.querySelector<HTMLButtonElement>("#btn-file")!;
const editButton = document.querySelector<HTMLButtonElement>("#btn-edit")!;
const macShortcuts = usesMacShortcuts();
fileButton.addEventListener("pointerdown", (event) => {
  toggleBarMenu(event, fileButton, [
    { label: "Open", shortcut: formatAccelerator("CmdOrCtrl+O", macShortcuts), run: () => void openFolder() },
    { label: "Export", shortcut: formatAccelerator("CmdOrCtrl+Shift+E", macShortcuts), run: () => void exportManuscript() },
    { label: "Export PDF", run: () => void exportPdfManuscript() },
    { label: "Export Word", run: () => void exportDocxManuscript() },
  ]);
});
editButton.addEventListener("pointerdown", (event) => {
  toggleBarMenu(event, editButton, [
    { label: "Undo", shortcut: formatAccelerator("CmdOrCtrl+Z", macShortcuts), run: () => menuHistory("undo") },
    { label: "Redo", shortcut: formatAccelerator("CmdOrCtrl+Shift+Z", macShortcuts), run: () => menuHistory("redo") },
    { label: "Cut", shortcut: formatAccelerator("CmdOrCtrl+X", macShortcuts), run: () => runEdit(editCut, "Cut") },
    { label: "Copy", shortcut: formatAccelerator("CmdOrCtrl+C", macShortcuts), run: () => runEdit(editCopy, "Copy") },
    { label: "Paste", shortcut: formatAccelerator("CmdOrCtrl+V", macShortcuts), run: () => runEdit(editPaste, "Paste") },
    { label: "Find", shortcut: formatAccelerator("CmdOrCtrl+F", macShortcuts), run: openFind },
  ]);
});
document.querySelector("#btn-preview")!.addEventListener("click", () => {
  previewOn = !previewOn;
  paintViewToggle();
  drawPreview();
});
paintViewToggle();
document.querySelector("#btn-palette")!.addEventListener("click", openPalette);
document.querySelector("#reminder-close")!.addEventListener("click", () => {
  reminder.hidden = true;
});
editor.dom.addEventListener("contextmenu", (event) => {
  if (!editing()) return;
  showCommandMenu(event);
});
editor.dom.addEventListener("click", (event) => {
  if (event.button !== 0 || !editing() || previewEl.hidden) return;
  const target = event.target;
  if (!(target instanceof Node) || !editor.contentDOM.contains(target)) return;
  scrollPreviewToCursor();
});
function followFootnote(root: HTMLElement, event: MouseEvent): boolean {
  const anchor = footnoteAnchor(event.target);
  if (!anchor) return false;
  return openFootnote(root, anchor, event);
}

function footnoteAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  const element = elementAt(target);
  if (!element) return null;
  return keptFootnote(element.closest("a"));
}

function keptFootnote(anchor: Element | null): HTMLAnchorElement | null {
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  return footnoteHref(anchor);
}

function footnoteHref(anchor: HTMLAnchorElement): HTMLAnchorElement | null {
  if (!isFootnoteHref(anchor.getAttribute("href"))) return null;
  return anchor;
}

function isFootnoteHref(href: string | null): boolean {
  return href != null && href.startsWith("#fn");
}

function openFootnote(root: HTMLElement, anchor: HTMLAnchorElement, event: MouseEvent): boolean {
  const target = footnoteNode(root, anchor.getAttribute("href"));
  if (!target) return false;
  event.preventDefault();
  scrollPaneTo(root, target);
  syncMarkdown(target);
  return true;
}

function syncMarkdown(target: HTMLElement): void {
  if (!markdownShown()) return;
  placeCursor(sourceSpot(target, editor.state.doc.toString()));
}

function markdownShown(): boolean {
  return editing() && !editorHost.hidden;
}

function sourceSpot(element: HTMLElement, source: string): number {
  const block = sourceBlock(element);
  if (!block) return 0;
  return renderedSpot(block, element, source);
}

function sourceBlock(element: HTMLElement): HTMLElement | null {
  return lineBlock(element) ?? innerBlock(element);
}

function lineBlock(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>("[data-line]");
}

function innerBlock(element: HTMLElement): HTMLElement | null {
  return element.querySelector<HTMLElement>("[data-line]");
}

function renderedSpot(block: HTMLElement, element: HTMLElement, source: string): number {
  const start = Number(block.dataset.line);
  const end = spanEnd(block, start);
  if (!integerSpan(start, end)) return 0;
  return sourceOffset(source, start, end, blockFraction(block, element));
}

function blockFraction(block: HTMLElement, element: HTMLElement): number {
  const total = textLength(block);
  if (!(total > 0)) return 0;
  return rangeFraction(block, element, total);
}

function rangeFraction(block: HTMLElement, element: HTMLElement, total: number): number {
  const measured = measureElement(block, element, total);
  if (measured == null) return 0;
  return measured;
}

function measureElement(block: HTMLElement, element: HTMLElement, total: number): number | null {
  try {
    return clampedFraction(block, element, total);
  } catch {
    return null;
  }
}

function clampedFraction(block: HTMLElement, element: HTMLElement, total: number): number {
  const probe = block.ownerDocument.createRange();
  probe.setStart(block, 0);
  probe.setEndBefore(element);
  return Math.min(1, Math.max(0, probe.toString().length / total));
}

function footnoteNode(root: HTMLElement, href: string | null): HTMLElement | null {
  const id = footnoteId(href);
  if (!id) return null;
  return root.querySelector<HTMLElement>(`[id="${attrValue(id)}"]`);
}

function footnoteId(href: string | null): string | null {
  if (href == null) return null;
  return href.slice(1);
}

function attrValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function scrollPaneTo(root: HTMLElement, target: HTMLElement): void {
  const pane = scrollParent(root);
  const top = pane.getBoundingClientRect().top;
  const spot = target.getBoundingClientRect().top;
  pane.scrollTop = scrollToSpot(pane.scrollTop, top, spot, PREVIEW_SCROLL_PADDING);
}

function scrollParent(root: HTMLElement): HTMLElement {
  if (canScroll(root)) return root;
  return parentScroller(root);
}

function parentScroller(root: HTMLElement): HTMLElement {
  const parent = root.parentElement;
  if (!(parent instanceof HTMLElement)) return root;
  return scrollParent(parent);
}

function canScroll(element: HTMLElement): boolean {
  return overflowScrolls(element) && element.scrollHeight > element.clientHeight;
}

function overflowScrolls(element: HTMLElement): boolean {
  const overflow = getComputedStyle(element).overflowY;
  return overflow === "auto" || overflow === "scroll";
}

previewEl.addEventListener("click", (event) => {
  if (!editing()) return;
  if (followFootnote(previewEl, event)) return;
  event.preventDefault();
  placeCursor(clickOffset(previewEl, event, editor.state.doc.toString()));
});
readingEl.addEventListener("click", (event) => {
  if (!book) return;
  if (followFootnote(readingEl, event)) return;
  const element = elementAt(event.target);
  const section = element?.closest<HTMLElement>("section[data-id]");
  if (!section || !readingEl.contains(section)) return;
  const id = section.dataset.id;
  if (!id) return;
  const found = findNode(book.nodes, id);
  if (!found) return;
  event.preventDefault();
  const offset = clickOffset(section, event, found.node.body);
  void openAt(id, found.node.kind === "group", offset);
});

async function openAt(id: string, prose: boolean, offset: number): Promise<void> {
  if (needsChoose(id, prose)) await choose(id, prose);
  placeCursor(offset);
}

function needsChoose(id: string, prose: boolean): boolean {
  return selectedId !== id || proseDiffers(prose);
}

function proseDiffers(prose: boolean): boolean {
  return prose !== editingProse || !editing();
}
editProse.addEventListener("click", () => {
  if (selectedId) void choose(selectedId, true);
});
readGroup.addEventListener("click", () => {
  if (selectedId) void choose(selectedId, false);
});

for (const field of [fieldTitle, fieldSynopsis, fieldStatus, fieldRole, ...unitInputs]) {
  field.addEventListener("change", () => {
    dirty = true;
    const renumber = field === fieldRole || unitInputs.includes(field as HTMLInputElement);
    void flush().then(() => {
      const current = selected();
      if (!current) return;
      if (renumber) renderOutline();
      const row = outlineEl.querySelector<HTMLElement>(`[data-id="${CSS.escape(current.node.header.id)}"] .title`);
      if (row && !renumber) row.textContent = outlineTitle(current.node);
      paintWordCount();
      const synopsis = outlineEl.querySelector<HTMLElement>(`[data-id="${CSS.escape(current.node.header.id)}"] .synopsis`);
      if (synopsis) synopsis.textContent = current.node.header.synopsis;
      drawPreview();
      drawReading();
    });
  });
}

bookTitle.addEventListener("change", () => {
  if (!book) return;
  void saveBookTitle(fs, book, bookTitle.value).then(() => {
    document.title = bookTitle.value || "Bookwriter";
    renderOutline();
  });
});

paletteInput.addEventListener("input", () => {
  paletteIndex = 0;
  drawPalette();
});
paletteInput.addEventListener("keydown", (event) => {
  const matches = matchingCommands();
  if (event.key === "ArrowDown") {
    paletteIndex = Math.min(matches.length - 1, paletteIndex + 1);
    drawPalette();
    event.preventDefault();
  } else if (event.key === "ArrowUp") {
    paletteIndex = Math.max(0, paletteIndex - 1);
    drawPalette();
    event.preventDefault();
  } else if (event.key === "Enter") {
    const command = matches[paletteIndex];
    closePalette();
    if (command) runCommand(command.id);
    event.preventDefault();
  } else if (event.key === "Escape") closePalette();
});

document.addEventListener("keydown", (event) => {
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (palette.hidden) openPalette();
    else closePalette();
  } else if (meta && event.key.toLowerCase() === "s") {
    event.preventDefault();
    dirty = true;
    void flush();
  } else if (event.key === "Escape") {
    reminder.hidden = true;
    closeContextMenu();
  }
});

document.addEventListener("pointerdown", (event) => {
  if (contextMenu.hidden) return;
  if (event.target instanceof Node && contextMenu.contains(event.target)) return;
  closeContextMenu();
});
document.querySelector(".outline-column")!.addEventListener("scroll", closeContextMenu);

void installMenu().catch((error: unknown) => {
  showWarnings([`The menu bar could not be installed. ${String(error)}`]);
});

void startupBookPath()
  .then((path) => openRoot(path))
  .catch((error: unknown) => {
    saveState.textContent = "Open a book";
    showWarnings([String(error)]);
  });
