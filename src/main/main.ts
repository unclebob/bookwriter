import "./styles.css";
import { defaultKeymap, history, historyKeymap, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { findNext, findPrevious, getSearchQuery, openSearchPanel, search, searchKeymap, setSearchQuery, type SearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, type Command } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  readOrNull,
  saveHeldNode,
  saveHeldTitle,
  type Book,
  type DropZone,
  type HeldSave,
} from "../internals/book";
import { FileHolds, hasNewRefresh, installDisk, type HeldFile } from "../internals/holds";
import { bodyPlace, bookRelative, createPlaceWriter, manuscriptPlace, readingPlace, titlePlace } from "../internals/place";
import { COMMANDS, applyCommand, changedSpan, latestLanguage, type CommandId, type MarkupCommand } from "../ui/commands";
import { exportBook, exportChapter, exportDocxFiles, type ChapterExport } from "../export/export";
import { nextMatch, previousMatch, type FindHit, type FindPart } from "../ui/find";
import { chapterPdf, exportPdfWithPictures } from "../export/pdf";
import { rasterizePicture } from "../ui/rasterize";
import { formatAccelerator } from "../ui/keys";
import { blockAtLine, lineOffset, offsetFraction, scrollToSpot, sourceOffset } from "../ui/locate";
import { divisionLabel, divisions, effectiveUnit, filePath, findNode, nodeWordCount, parseSection, serializeSection, serializeTitle, slugify, UNITS, walk, type Division, type Header, type Status, type TreeNode, type Unit } from "../internals/model";
import { joinPath, parentPath } from "../internals/path";
import { PICTURE_EXTENSIONS, placePicture, resolvePictureSources } from "../internals/pictures";
import { renderBook, renderGroup, renderSection, textRuns } from "../ui/preview";
import {
  applyRenderedInput,
  caretLocal,
  inBlock,
  renderedInput,
  type RenderedInput,
  type SourceChange,
  type TextEdit,
} from "../ui/renderedEdit";
import { previewClick } from "../ui/view";
import { clampPreviewWidth, previewWidthFromPointer } from "../ui/split";
import { allowBook, clearPlace, ensureCompanion, pandocDocx, readRefresh, setOpenBook, startupBookPath, stopCompanion, tauriFs, writePlace } from "../ui/tauriFs";
import { dropRedo, emptyTrail, historyStep, noteVisit, redoVisit, undoVisit, type Trail } from "../ui/trail";

const fs = tauriFs;
const holds = new FileHolds();
const places = createPlaceWriter(
  (json) => writePlace(json),
  () => clearPlace(),
);
let appliedToken: string | null = null;
let companionWatching = false;
let companionBusy = false;
let preserved: TreeNode | null = null;
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
const createOk = createDialog.querySelector<HTMLButtonElement>('button[value="ok"]')!;

let book: Book | null = null;
/** Outline row for the whole manuscript. Not a node id. */
const BOOK_ID = "\u0000book";

let selectedId: string | null = null;
const collapsed = new Set<string>();
let editingProse = false;
let previewOn = true;
let dirty = false;
let titleDirty = false;
let suppress = false;
let navigating = false;
let saveFlight: Promise<void> | null = null;
const parked = new Set<string>();
const SAVE_EVERY_MS = 400;
let paletteIndex = 0;
let pendingHistory: "undo" | "redo" | null = null;
let historyBusy = false;

type Visit = { id: string; prose: boolean; state: EditorState | null };
type Selection = { node: TreeNode; ancestors: TreeNode[] };
type VisitMove = { trail: Trail<Visit>; to: Visit };
type ContextAction = { label: string; run: () => Promise<void> };
let trail = emptyTrail<Visit>();
/** The rendered pane the caret should return to after a redraw. */
let renderedFocus: HTMLElement | null = null;
/** Section whose body is in the hidden editor while the reading view is up. */
let renderedOwner: string | null = null;

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
    { key: "Mod-r", run: () => (refreshDisplay(), true) },
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
    if (update.selectionSet && !suppress) publishPlace();
    if (!update.docChanged || suppress) return;
    const current = selected();
    if (current) holds.markEditing(current.node.header.id);
    const motion = update.transactions.some((tr) => {
      const event = tr.annotation(Transaction.userEvent);
      return event === "undo" || event === "redo";
    });
    if (!motion) trail = dropRedo(trail);
    dirty = true;
    if (navigating) return;
    saveState.textContent = "Unsaved";
    drawPreview();
    paintWordCount();
    syncRenderedView();
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

let savesWatching = false;

function watchSaves(): void {
  if (savesWatching) return;
  armSaves();
}

function armSaves(): void {
  savesWatching = true;
  window.setInterval(saveOnCadence, SAVE_EVERY_MS);
}

function saveOnCadence(): void {
  if (cadenceSkips()) return;
  void flush();
}

function cadenceSkips(): boolean {
  return saveBlocked() || nothingToSave();
}

function saveBlocked(): boolean {
  return navigating || companionBusy;
}

function nothingToSave(): boolean {
  return saveInFlight() || !saveWaiting();
}

function saveInFlight(): boolean {
  return saveFlight !== null;
}

function saveWaiting(): boolean {
  return dirty || titleOrParked();
}

function titleOrParked(): boolean {
  return titleDirty || parked.size > 0;
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
  else replaceKeptBody(body);
}

/** A disk reload is not an edit, and the viewport stays on the same place in the text. */
function replaceKeptBody(body: string): void {
  editor.dispatch({
    changes: changedSpan(editor.state.doc.toString(), body),
    annotations: Transaction.addToHistory.of(false),
  });
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
  if (flushRefused()) return;
  await joinOrStart();
}

function flushRefused(): boolean {
  return book == null || companionBusy;
}

async function joinOrStart(): Promise<void> {
  if (saveFlight) {
    await saveFlight;
    return;
  }
  await startFlush();
}

async function startFlush(): Promise<void> {
  saveFlight = runFlush();
  try {
    await saveFlight;
  } finally {
    saveFlight = null;
  }
}

async function runFlush(): Promise<void> {
  if (await flushPaused()) return;
  await writeOpenFiles();
}

async function writeOpenFiles(): Promise<void> {
  await saveOpenBuffer();
  await saveOpenTitle();
  await saveParked();
  paintSaved();
}

async function flushPaused(): Promise<boolean> {
  if (flushRefused()) return true;
  return batchPending();
}

async function batchPending(): Promise<boolean> {
  if (await tokenPending()) return true;
  return companionBusy;
}

async function tokenPending(): Promise<boolean> {
  return hasNewRefresh(appliedToken, await quietRefresh());
}

async function quietRefresh(): Promise<string | null> {
  try {
    return await readRefresh();
  } catch {
    return null;
  }
}

async function saveOpenBuffer(): Promise<void> {
  const current = selected();
  if (!openToSave(current)) return;
  await writeOpen(current);
}

function openToSave(current: Selection | null): current is Selection {
  return bookOpenForSave() && current != null;
}

function bookOpenForSave(): boolean {
  return book != null && sectionPending();
}

function sectionPending(): boolean {
  return dirty || openParked();
}

function openParked(): boolean {
  const id = selectedNodeId();
  if (!id) return false;
  return parked.has(id);
}

function selectedNodeId(): string | null {
  const current = selected();
  if (!current) return null;
  return current.node.header.id;
}

async function writeOpen(current: Selection): Promise<void> {
  rememberOpen();
  const header = headerFromForm(current.node);
  const body = flushBody(current);
  const id = current.node.header.id;
  const result = await saveHeldNode(fs, holds, current.node, header, body, () => liveSection(current));
  noteBufferResult(current, header, body, id, result);
}

function noteBufferResult(current: Selection, header: Header, body: string, id: string, result: HeldSave): void {
  if (result === "hold") {
    holdOpen(id);
    return;
  }
  releaseOpen(current, header, body, id);
}

function holdOpen(id: string): void {
  dirty = true;
  parked.add(id);
}

function releaseOpen(current: Selection, header: Header, body: string, id: string): void {
  dirty = liveSection(current) !== serializeSection({ ...header, id }, body);
  if (!dirty) parked.delete(id);
  paintWordCount();
}

function liveSection(current: Selection): string {
  return serializeSection(headerFromForm(current.node), flushBody(current));
}

function rememberOpen(): void {
  const current = selected();
  if (!current) return;
  storeOpen(current);
}

function storeOpen(current: Selection): void {
  current.node.header = headerFromForm(current.node);
  if (!editing()) return;
  current.node.body = editor.state.doc.toString();
}

async function saveOpenTitle(): Promise<void> {
  if (!titleOpen()) return;
  await writeTitle();
}

function titleOpen(): boolean {
  return book != null && titleDirty;
}

async function writeTitle(): Promise<void> {
  const title = bookTitle.value;
  const result = await saveHeldTitle(fs, holds, book!, title, () => serializeTitle(bookTitle.value));
  noteTitle(title, result);
}

function noteTitle(title: string, result: HeldSave): void {
  if (result === "hold") {
    titleDirty = true;
    return;
  }
  finishTitle(title);
}

function finishTitle(title: string): void {
  titleDirty = bookTitle.value !== title;
  if (titleDirty) return;
  document.title = titled(title);
}

async function saveParked(): Promise<void> {
  if (!book) return;
  await saveParkedIds(selectedNodeId());
}

async function saveParkedIds(openId: string | null): Promise<void> {
  for (const id of [...parked]) await saveParkedId(id, openId);
}

async function saveParkedId(id: string, openId: string | null): Promise<void> {
  if (id === openId) return;
  await saveClosed(id);
}

async function saveClosed(id: string): Promise<void> {
  const node = parkedNode(id);
  if (!node) {
    parked.delete(id);
    return;
  }
  await writeParked(node);
}

function parkedNode(id: string): TreeNode | null {
  const found = findNode(book!.nodes, id);
  if (!found) return null;
  return found.node;
}

async function writeParked(node: TreeNode): Promise<void> {
  const result = await saveHeldNode(fs, holds, node, node.header, node.body);
  if (result === "hold") return;
  parked.delete(node.header.id);
}

function paintSaved(): void {
  saveState.textContent = savedLabel();
}

function savedLabel(): string {
  if (unsaved()) return "Unsaved";
  return "Saved";
}

function unsaved(): boolean {
  return dirty || titleOrParked();
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
  if (!historyOwnsEditor()) return 0;
  return editorDepth(kind);
}

function historyOwnsEditor(): boolean {
  return editing() || renderedOwner != null;
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
  paintSaved();
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
  setEditorCursor(offset);
  editor.focus();
}

function setEditorCursor(offset: number): void {
  const pos = clampedPos(offset);
  editor.dispatch({
    selection: { anchor: pos, head: pos },
    scrollIntoView: true,
  });
}

function clampedPos(offset: number): number {
  return Math.max(0, Math.min(offset, editor.state.doc.length));
}

function elementAt(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return parentElementOf(target);
}

function parentElementOf(target: EventTarget | null): Element | null {
  if (target instanceof Node) return target.parentElement;
  return null;
}

function textLength(block: HTMLElement): number {
  const text = block.textContent;
  if (text == null) return 0;
  return text.length;
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
  paintReadingHtml(showPictures(rendered.html));
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
  paintReadingHtml(showPictures(rendered.html));
  showWarnings([...bookWarnings(), ...rendered.warnings]);
}

let readingStamp = "";

function paintReadingHtml(html: string): void {
  const scroll = keptReadingScroll();
  readingStamp = readingViewStamp();
  readingEl.innerHTML = html;
  readingEl.scrollTop = scroll;
}

function keptReadingScroll(): number {
  if (readingStamp !== readingViewStamp()) return 0;
  return readingEl.scrollTop;
}

function readingViewStamp(): string {
  if (viewingBook()) return BOOK_ID;
  return selectedOrEmpty();
}

function selectedOrEmpty(): string {
  if (selectedId) return selectedId;
  return "";
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
    publishPlace();
    return;
  }
  await switchSelection(id, prose);
  showCurrent();
  publishPlace();
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
  releaseReadingBuffer();
  rememberOpen();
  await flushTwice();
  parkLeaving();
  noteLeaving();
  selectedId = id;
  editingProse = prose;
  loadSelectedBody();
}

function parkLeaving(): void {
  const leaving = selectedNodeId();
  if (!shouldPark(leaving)) return;
  parked.add(leaving);
}

function shouldPark(leaving: string | null): leaving is string {
  return leaving != null && dirty;
}

function noteLeaving(): void {
  const leaving = takeVisit();
  if (leaving) trail = noteVisit(trail, leaving);
}

async function refresh(keep: string | null, resetHistory = false): Promise<void> {
  if (!book) return;
  await reloadBook(keep, resetHistory);
}

type OpenCapture = { id: string; header: Header; body: string };

type ReloadCapture = {
  kept: OpenCapture | null;
  keptTitle: string | null;
  previousId: string | null;
  previousProse: boolean;
};

async function reloadBook(keep: string | null, resetHistory: boolean): Promise<void> {
  const captured = captureReload();
  const loaded = await loadBook(fs, book!.root);
  finishReload(keep, resetHistory, captured, loaded);
}

function captureReload(): ReloadCapture {
  return {
    kept: dirtyCapture(),
    keptTitle: dirtyTitle(),
    previousId: selectedId,
    previousProse: editingProse,
  };
}

function dirtyCapture(): OpenCapture | null {
  if (!dirty) return null;
  return captureOpen();
}

function dirtyTitle(): string | null {
  if (!titleDirty) return null;
  return bookTitle.value;
}

function finishReload(keep: string | null, resetHistory: boolean, captured: ReloadCapture, loaded: Book): void {
  book = loaded;
  restoreKept(captured.kept);
  selectedId = keptId(keep);
  const changed = selectionChanged(resetHistory, captured.previousId, captured.previousProse);
  clearTrailIf(changed);
  restoreTitle(captured.keptTitle, loaded);
  loadRefreshedDocument(changed);
  markRestored(captured.kept);
  paintReload(loaded);
}

function restoreKept(kept: OpenCapture | null): void {
  if (!kept) return;
  restoreCaptured(kept);
}

function clearTrailIf(changed: boolean): void {
  if (changed) trail = emptyTrail();
}

function restoreTitle(keptTitle: string | null, loaded: Book): void {
  if (keptTitle !== null) keepTitleText(keptTitle);
  else showLoadedTitle(loaded);
}

function keepTitleText(title: string): void {
  book!.title = title;
  bookTitle.value = title;
}

function showLoadedTitle(loaded: Book): void {
  bookTitle.value = loaded.title;
  document.title = titled(loaded.title);
  titleDirty = false;
}

function markRestored(kept: OpenCapture | null): void {
  if (!kept) return;
  dirty = true;
}

function paintReload(loaded: Book): void {
  renderOutline();
  fillInspector();
  drawReading();
  drawPreview();
  showWarnings(loaded.warnings);
}

function captureOpen(): OpenCapture | null {
  const current = selected();
  if (!current) return null;
  rememberOpen();
  return { id: current.node.header.id, header: { ...current.node.header }, body: current.node.body };
}

function restoreCaptured(kept: OpenCapture): void {
  const found = rowNode(kept.id);
  if (!found) return;
  placeCaptured(found.node, kept);
}

function placeCaptured(node: TreeNode, kept: OpenCapture): void {
  node.header = kept.header;
  node.body = kept.body;
  parked.add(kept.id);
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
  if (!book) return;
  holds.replaceAll(await snapshotFiles(book));
  preserved = null;
  await setOpenBook(book.root);
  appliedToken = await readRefresh().catch(() => null);
  void ensureCompanion().catch((error: unknown) => showWarnings([String(error)]));
  watchCompanion();
  watchSaves();
  publishPlace();
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

let refreshing = false;

function refreshDisplay(): void {
  if (book == null || refreshing) return;
  refreshing = true;
  void finishRefresh();
}

async function finishRefresh(): Promise<void> {
  try {
    await showDisk();
  } catch (error) {
    showWarnings([`The book could not be read. ${String(error)}`]);
  } finally {
    refreshing = false;
  }
}

/** Read the files again. The open buffer is not written first, so an outside edit is what shows. */
async function showDisk(): Promise<void> {
  if (!book) return;
  await readDisk();
}

async function readDisk(): Promise<void> {
  navigating = true;
  try {
    await applyFromDisk("revert");
  } finally {
    navigating = false;
  }
  // A parked visit still holds the buffer from before this read. Undo would write it back.
  trail = emptyTrail();
  focusEditing();
  publishPlace();
}

function focusEditing(): void {
  if (editing()) editor.focus();
}

type OpenMine = { header: Header; body: string };

type RefreshCapture = {
  openNode: TreeNode | null;
  openId: string | null;
  bodySnapshot: string | null;
  titleSnapshot: string | null;
  previousId: string | null;
  previousProse: boolean;
};

async function applyFromDisk(reason: "token" | "revert"): Promise<void> {
  if (!book) return;
  await replaceFromDisk(reason);
}

async function replaceFromDisk(reason: "token" | "revert"): Promise<void> {
  const captured = captureRefresh();
  const loaded = await loadBook(fs, book!.root);
  const files = await snapshotFiles(loaded);
  finishRefreshLoad(reason, captured, loaded, files);
}

function captureRefresh(): RefreshCapture {
  rememberOpen();
  const openNode = openNodeOf(selected());
  return {
    openNode,
    openId: nodeId(openNode),
    bodySnapshot: bodySnapshotOf(),
    titleSnapshot: titleSnapshotOf(),
    previousId: selectedId,
    previousProse: editingProse,
  };
}

function openNodeOf(open: Selection | null): TreeNode | null {
  if (open) return open.node;
  return preserved;
}

function bodySnapshotOf(): string | null {
  if (!dirty) return null;
  return sectionSnapshot();
}

function titleSnapshotOf(): string | null {
  if (!titleDirty) return null;
  return serializeTitle(bookTitle.value);
}

function finishRefreshLoad(
  reason: "token" | "revert",
  captured: RefreshCapture,
  loaded: Book,
  files: Map<string, HeldFile>,
): void {
  const keepBody = keptBuffer(reason, captured.openId, captured.bodySnapshot);
  const keepTitle = keptTitle(reason, captured.titleSnapshot);
  const mine = capturedMine(keepBody, captured.openNode);
  holds.observe(files);
  book = loaded;
  installTitle(keepTitle, files);
  installBody(mine, captured.openId, captured.openNode, files, captured.previousId, captured.previousProse);
  paintRefresh();
}

function paintRefresh(): void {
  renderOutline();
  fillInspector();
  drawReading();
  drawPreview();
  paintSaved();
}

function capturedMine(keepBody: boolean, openNode: TreeNode | null): OpenMine | null {
  if (!keepBody) return null;
  return mineFrom(openNode);
}

function mineFrom(openNode: TreeNode | null): OpenMine | null {
  if (!openNode) return null;
  return { header: headerFromForm(openNode), body: shownBody(openNode) };
}

function installTitle(keepTitle: boolean, files: Map<string, HeldFile>): void {
  if (keepTitle) acceptTitle(files);
  else showBookTitle(files);
}

function acceptTitle(files: Map<string, HeldFile>): void {
  book!.title = bookTitle.value;
  const titleFile = files.get("book.yaml");
  holds.acceptDisk("book.yaml", titlePathOf(titleFile), titleBytes(titleFile));
  titleDirty = true;
}

function titlePathOf(file: HeldFile | undefined): string {
  if (file) return file.path;
  return joinPath(book!.root, "book.yaml");
}

function titleBytes(file: HeldFile | undefined): string | null {
  if (file) return file.bytes;
  return null;
}

function showBookTitle(files: Map<string, HeldFile>): void {
  bookTitle.value = book!.title;
  document.title = titled(book!.title);
  titleDirty = false;
  noteTitleFile(files.get("book.yaml"));
}

function noteTitleFile(file: HeldFile | undefined): void {
  if (!file) return;
  holds.noteWrite("book.yaml", file.path, file.bytes);
}

function installBody(
  mine: OpenMine | null,
  openId: string | null,
  openNode: TreeNode | null,
  files: Map<string, HeldFile>,
  previousId: string | null,
  previousProse: boolean,
): void {
  if (keptMine(mine, openId, openNode)) acceptBody(openId!, openNode!, mine!, files);
  else showBody(openId, files, previousId, previousProse);
}

function keptMine(mine: OpenMine | null, openId: string | null, openNode: TreeNode | null): boolean {
  return mine != null && nodeReady(openId, openNode);
}

function nodeReady(openId: string | null, openNode: TreeNode | null): boolean {
  return openId != null && openNode != null;
}

function acceptBody(openId: string, openNode: TreeNode, mine: OpenMine, files: Map<string, HeldFile>): void {
  restoreMine(openId, openNode, mine);
  holds.acceptDisk(openId, diskPath(openId, openNode, files), diskBytes(openId, files));
  dirty = true;
  parked.add(openId);
}

function diskPath(openId: string, openNode: TreeNode, files: Map<string, HeldFile>): string {
  const file = files.get(openId);
  if (file) return file.path;
  return filePath(openNode);
}

function diskBytes(openId: string, files: Map<string, HeldFile>): string | null {
  const file = files.get(openId);
  if (file) return file.bytes;
  return null;
}

function showBody(
  openId: string | null,
  files: Map<string, HeldFile>,
  previousId: string | null,
  previousProse: boolean,
): void {
  preserved = null;
  selectedId = keptId(previousId);
  editingProse = previousProse;
  loadRefreshedDocument(selectionChanged(false, previousId, previousProse));
  noteOpenFile(openId, files);
  dropParked(openId);
  dirty = false;
}

function noteOpenFile(openId: string | null, files: Map<string, HeldFile>): void {
  if (!openId) return;
  noteHeldFile(openId, files.get(openId));
}

function noteHeldFile(openId: string, file: HeldFile | undefined): void {
  if (!file) return;
  holds.noteWrite(openId, file.path, file.bytes);
}

function dropParked(openId: string | null): void {
  if (!openId) return;
  parked.delete(openId);
}

function keptBuffer(reason: "token" | "revert", openId: string | null, snapshot: string | null): boolean {
  if (skipBuffer(reason, openId)) return false;
  return heldSection(openId!, snapshot);
}

function skipBuffer(reason: "token" | "revert", openId: string | null): boolean {
  return reason !== "token" || openId === null;
}

function heldSection(openId: string, snapshot: string | null): boolean {
  return installDisk({ base: holds.base(openId), snapshot, buffer: sectionSnapshot() }) === "hold";
}

function keptTitle(reason: "token" | "revert", snapshot: string | null): boolean {
  if (reason !== "token") return false;
  return heldTitleText(snapshot);
}

function heldTitleText(snapshot: string | null): boolean {
  return installDisk({ base: holds.base("book.yaml"), snapshot, buffer: serializeTitle(bookTitle.value) }) === "hold";
}

function sectionSnapshot(): string | null {
  const current = selected();
  if (!current) return null;
  return serializeSection(headerFromForm(current.node), shownBody(current.node));
}

function shownBody(node: TreeNode): string {
  const current = selected();
  if (current?.node.header.id === node.header.id && editingNode(node)) {
    return editor.state.doc.toString();
  }
  return node.body;
}

function restoreMine(
  openId: string,
  openNode: TreeNode,
  mine: { header: Header; body: string },
): void {
  const found = book ? findNode(book.nodes, openId) : null;
  const header = { ...mine.header, id: openId };
  if (found) {
    found.node.header = header;
    found.node.body = mine.body;
    preserved = null;
    selectedId = openId;
    return;
  }
  preserved = { ...openNode, header, body: mine.body };
  selectedId = openId;
}

async function snapshotFiles(current: Book): Promise<Map<string, HeldFile>> {
  const files = new Map<string, HeldFile>();
  const titlePath = joinPath(current.root, "book.yaml");
  const title = await readOrNull(fs, titlePath);
  if (title !== null) files.set("book.yaml", { path: titlePath, bytes: title });
  const nodes: TreeNode[] = [];
  walk(current.nodes, (node) => nodes.push(node));
  for (const node of nodes) {
    const path = filePath(node);
    const bytes = await readOrNull(fs, path);
    if (bytes !== null) files.set(node.header.id, { path, bytes });
  }
  return files;
}

function watchCompanion(): void {
  if (companionWatching) return;
  companionWatching = true;
  window.setInterval(() => {
    void pollCompanion();
  }, 400);
}

async function pollCompanion(): Promise<void> {
  if (pollIdle()) return;
  await takeToken();
}

function pollIdle(): boolean {
  return book == null || companionBusy;
}

async function takeToken(): Promise<void> {
  const read = await readToken();
  if (!read.ok) return;
  await applyToken(read.token);
}

async function readToken(): Promise<{ ok: true; token: string | null } | { ok: false }> {
  try {
    return { ok: true, token: await readRefresh() };
  } catch (error) {
    showWarnings([String(error)]);
    return { ok: false };
  }
}

async function applyToken(token: string | null): Promise<void> {
  if (!hasNewRefresh(appliedToken, token)) return;
  await runToken(token);
}

async function runToken(token: string | null): Promise<void> {
  companionBusy = true;
  navigating = true;
  try {
    await holdForToken(token);
  } finally {
    companionBusy = false;
    navigating = false;
  }
  publishPlace();
}

async function holdForToken(token: string | null): Promise<void> {
  try {
    await finishToken(token);
  } catch (error) {
    showWarnings([`The book could not be read. ${String(error)}`]);
  }
}

async function finishToken(token: string | null): Promise<void> {
  await joinedFlight();
  await applyFromDisk("token");
  appliedToken = token;
}

async function joinedFlight(): Promise<void> {
  const flight = saveFlight;
  if (!flight) return;
  await flight;
}

function publishPlace(): void {
  if (!book) {
    places.submit(null);
    return;
  }
  if (document.activeElement === bookTitle) {
    const anchor = bookTitle.selectionStart ?? 0;
    const head = bookTitle.selectionEnd ?? anchor;
    places.submit(titlePlace(bookTitle.value, anchor, head));
    return;
  }
  if (!selectedId || selectedId === BOOK_ID) {
    places.submit(manuscriptPlace());
    return;
  }
  const current = selected();
  if (!current) {
    places.submit(manuscriptPlace());
    return;
  }
  if (current.node.kind === "group" && !editingProse) {
    places.submit(readingPlace(current.node.header.id));
    return;
  }
  const selection = editor.state.selection.main;
  places.submit(
    bodyPlace(
      bookRelative(book.root, filePath(current.node)),
      current.node.header.id,
      editor.state.doc.toString(),
      selection.anchor,
      selection.head,
    ),
  );
}

function bookParent(): string | undefined {
  return book ? parentPath(book.root) : undefined;
}

async function exportManuscript(): Promise<void> {
  if (!book) return;
  await writeFileExport("Export manuscript", "md", "Markdown", writeMarkdownExport);
}

async function flushedBook(): Promise<Book> {
  const captured = captureReload();
  await flush();
  return restoredBook(captured);
}

async function restoredBook(captured: ReloadCapture): Promise<Book> {
  const loaded = await loadBook(fs, book!.root);
  book = loaded;
  restoreFlushed(captured.kept);
  restoreFlushedTitle(captured.keptTitle);
  return book!;
}

function restoreFlushed(kept: OpenCapture | null): void {
  if (!stillDirty(kept)) return;
  restoreCaptured(kept!);
}

function stillDirty(kept: OpenCapture | null): boolean {
  return dirty && kept != null;
}

function restoreFlushedTitle(keptTitle: string | null): void {
  if (!titleStillDirty(keptTitle)) return;
  book!.title = keptTitle!;
}

function titleStillDirty(keptTitle: string | null): boolean {
  return titleDirty && keptTitle !== null;
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

async function exportThisChapter(id: string): Promise<void> {
  if (!book) return;
  try {
    await saveChapterPdf(id);
  } catch (error) {
    showWarnings([`PDF export failed: ${String(error)}`]);
    saveState.textContent = "Export failed";
  }
}

async function saveChapterPdf(id: string): Promise<void> {
  const loaded = await flushedBook();
  const chapter = exportChapter(manuscriptNodes(loaded.nodes), id);
  if (!chapter) {
    missingChapter();
    return;
  }
  const destination = await chooseChapterPdf(loaded.root, chapter.filename);
  if (typeof destination !== "string") return;
  await writeChapterPdf(destination, chapter);
}

function missingChapter(): void {
  failExport("That chapter is not in the book.");
}

function failExport(message: string): void {
  showWarnings([message]);
  saveState.textContent = "Export failed";
}

function chooseChapterPdf(root: string, filename: string) {
  return save({
    title: "Export chapter to PDF",
    defaultPath: joinPath(root, filename),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
}

async function writeChapterPdf(destination: string, chapter: ChapterExport): Promise<void> {
  const result = await chapterPdf(chapter, fs, book!.root, { rasterize: rasterizePicture });
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
  failExport("There are no chapters or front matter to export.");
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
  return askNamed(label, "", "Create");
}

function askNamed(label: string, value: string, confirm: string): Promise<string | null> {
  createLabel.textContent = label;
  createTitle.value = value;
  createOk.textContent = confirm;
  createDialog.showModal();
  createTitle.focus();
  createTitle.select();
  return new Promise((resolve) => {
    createDialog.addEventListener("close", () => resolve(namedTitle()), { once: true });
  });
}

function namedTitle(): string | null {
  if (createDialog.returnValue !== "ok") return null;
  const title = createTitle.value.trim();
  return title || null;
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
    { label: "Rename", run: () => renameBook() },
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
  return withDelete(withChapterPdf(withRename(actions, node), node, inTrash), node, inTrash);
}

function withRename(actions: ContextAction[], node: TreeNode): ContextAction[] {
  if (isTrash(node)) return actions;
  return [{ label: "Rename", run: () => renameNode(node.header.id) }, ...actions];
}

function withChapterPdf(actions: ContextAction[], node: TreeNode, inTrash: boolean): ContextAction[] {
  if (skipChapterPdf(node, inTrash)) return actions;
  return [...actions, { label: "Export to PDF", run: () => exportThisChapter(node.header.id) }];
}

function skipChapterPdf(node: TreeNode, inTrash: boolean): boolean {
  return inTrash || effectiveUnit(node) !== "chapter";
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

async function renameBook(): Promise<void> {
  if (!book) return;
  const title = await askNamed("Rename", book.title, "Rename");
  if (!title || title === book.title) return;
  await writeBookTitle(title);
}

async function writeBookTitle(title: string): Promise<void> {
  if (!book) return;
  bookTitle.value = title;
  holds.markEditing("book.yaml");
  titleDirty = true;
  await flush();
  renderOutline();
  publishPlace();
}

async function renameNode(id: string): Promise<void> {
  const found = rowNode(id);
  if (!found || isTrash(found.node)) return;
  const title = await askNamed("Rename", found.node.header.title, "Rename");
  if (!title || title === found.node.header.title) return;
  if (selected()?.node.header.id === id) await renameOpen(title);
  else await renameClosed(found.node, title);
}

async function renameOpen(title: string): Promise<void> {
  const current = selected();
  if (!current) return;
  fieldTitle.value = title;
  holds.markEditing(current.node.header.id);
  dirty = true;
  await flush();
  showCurrent();
}

async function renameClosed(node: TreeNode, title: string): Promise<void> {
  const result = await writeClosed(node, title);
  trackClosed(node, result);
  showCurrent();
}

async function writeClosed(node: TreeNode, title: string): Promise<HeldSave> {
  const path = filePath(node);
  const disk = await readOrNull(fs, path);
  trackDisk(node, path, disk);
  const source = closedSource(node, disk);
  return saveHeldNode(fs, holds, node, { ...source.header, title }, source.body);
}

function trackDisk(node: TreeNode, path: string, disk: string | null): void {
  if (disk === null) return;
  holds.ensureTracked(node.header.id, { path, bytes: disk });
}

function trackClosed(node: TreeNode, result: HeldSave): void {
  if (result !== "hold") return;
  parked.add(node.header.id);
  saveState.textContent = "Unsaved";
}

function closedSource(node: TreeNode, disk: string | null): { header: Header; body: string } {
  if (disk === null) return { header: node.header, body: node.body };
  const parsed = parseSection(disk);
  return { header: { ...parsed.header, id: node.header.id }, body: parsed.body };
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
  if (openInsideTrash()) {
    dropTrashEdits();
    return;
  }
  await flush();
}

function dropTrashEdits(): void {
  dirty = false;
  unparkOpen();
}

function unparkOpen(): void {
  const id = selectedNodeId();
  if (!id) return;
  parked.delete(id);
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

function nodeId(node: TreeNode | null | undefined): string | null {
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
  dispatchEdit(result.text, result.anchor, result.head);
}

function dispatchEdit(text: string, anchor: number, head: number): void {
  editor.dispatch({
    changes: changedSpan(editor.state.doc.toString(), text),
    selection: { anchor, head },
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
  dispatchEdit(result.text, result.anchor, result.head);
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
          await MenuItem.new({ id: "refresh", text: "Refresh", accelerator: "CmdOrCtrl+R", action: refreshDisplay }),
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
    { label: "Refresh", shortcut: formatAccelerator("CmdOrCtrl+R", macShortcuts), run: refreshDisplay },
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
  const next = previewClick(selected()?.node ?? null, editing(), previewOn);
  previewOn = next.previewOn;
  paintViewToggle();
  if (next.editFolderId) void choose(next.editFolderId, true);
  else drawPreview();
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

previewEl.addEventListener("beforeinput", onRenderedInput);
readingEl.addEventListener("beforeinput", onRenderedInput);
previewEl.addEventListener("keydown", onRenderedKeyDown);
readingEl.addEventListener("keydown", onRenderedKeyDown);
editor.dom.addEventListener("focusin", () => {
  renderedFocus = null;
});
previewEl.addEventListener("click", (event) => {
  if (followFootnote(previewEl, event)) return;
  keepLink(event);
  focusRendered(previewEl);
  syncPreviewCaret();
});
readingEl.addEventListener("click", (event) => {
  if (followFootnote(readingEl, event)) return;
  keepLink(event);
  focusRendered(readingEl);
});

function focusRendered(root: HTMLElement): void {
  renderedFocus = root;
}

function keepLink(event: MouseEvent): void {
  if (!linked(elementAt(event.target))) return;
  event.preventDefault();
}

function linked(element: Element | null): boolean {
  if (!element) return false;
  return element.closest("a") != null;
}

function syncPreviewCaret(): void {
  if (!editing()) return;
  movePreviewCaret();
}

function movePreviewCaret(): void {
  const caret = readCaret(previewEl);
  if (!caret) return;
  setEditorCursor(caret.head);
}

function onRenderedKeyDown(event: KeyboardEvent): void {
  if (skipBreak(event)) return;
  event.preventDefault();
  insertBreak(event);
}

function skipBreak(event: KeyboardEvent): boolean {
  return event.key !== "Enter" || event.isComposing;
}

function insertBreak(event: KeyboardEvent): void {
  const root = renderedEventRoot(event.currentTarget);
  if (!root) return;
  insertIn(root, event.shiftKey);
}

function insertIn(root: HTMLElement, shift: boolean): void {
  const caret = readCaret(root);
  if (!caret) return;
  insertAt(root, caret, shift);
}

function insertAt(root: HTMLElement, caret: SourceCaret, shift: boolean): void {
  editNode(root, caret, { kind: "insert", text: breakText(caret, shift) }, "insertParagraph");
}

function breakText(caret: SourceCaret, shift: boolean): string {
  if (shift) return "\n";
  return breakFor(caret);
}

function onRenderedInput(event: InputEvent): void {
  const root = renderedEventRoot(event.currentTarget);
  if (!root) return;
  event.preventDefault();
  applyRendered(root, event);
}

function renderedEventRoot(target: EventTarget | null): HTMLElement | null {
  if (target === readingEl) return readingEl;
  return previewTarget(target);
}

function previewTarget(target: EventTarget | null): HTMLElement | null {
  if (target === previewEl) return previewEl;
  return null;
}

function applyRendered(root: HTMLElement, event: InputEvent): void {
  if (isBreakInput(event.inputType)) return;
  applyCaret(root, event);
}

function applyCaret(root: HTMLElement, event: InputEvent): void {
  const caret = readCaret(root);
  if (!caret) return;
  runCaret(root, caret, event);
}

function isBreakInput(type: string): boolean {
  return type === "insertParagraph" || type === "insertLineBreak";
}

function runCaret(root: HTMLElement, caret: SourceCaret, event: InputEvent): void {
  const input = renderedInput(event.inputType, inputText(event), breakFor(caret));
  if (!input) return;
  runRendered(root, caret, input, event.inputType);
}

function inputText(event: InputEvent): string | null {
  if (event.data != null) return event.data;
  return transferText(event.dataTransfer);
}

function transferText(transfer: DataTransfer | null): string | null {
  if (!transfer) return null;
  return transfer.getData("text/plain");
}

function breakFor(caret: SourceCaret): string {
  const node = nodeOf(caret.node);
  if (!node) return "\n\n";
  return paragraphBreak(renderedBody(node), caret.head, caret.anchor === caret.head);
}

function paragraphBreak(body: string, head: number, collapsed: boolean): string {
  if (breakLine(body, head, collapsed)) return "\n";
  return "\n\n";
}

function breakLine(body: string, head: number, collapsed: boolean): boolean {
  return collapsed && inBlock(textRuns(body), head);
}

function renderedBody(node: TreeNode): string {
  if (editorOwns(node)) return editor.state.doc.toString();
  return node.body;
}

function editorOwns(node: TreeNode): boolean {
  return editing() && selectedId === node.header.id;
}

function runRendered(root: HTMLElement, caret: SourceCaret, input: RenderedInput, type: string): void {
  if (isHistory(input)) requestHistory(input.kind);
  else editNode(root, caret, input, type);
}

function isHistory(input: RenderedInput): input is { kind: "undo" } | { kind: "redo" } {
  return input.kind === "undo" || input.kind === "redo";
}

function editNode(root: HTMLElement, caret: SourceCaret, input: TextEdit, type: string): void {
  const node = nodeOf(caret.node);
  if (!node) return;
  commitRendered(root, node, caret, input, type);
}

function nodeOf(node: Node): TreeNode | null {
  const section = sectionOf(node);
  if (!section) return null;
  return nodeById(section.dataset.id);
}

function sectionOf(node: Node | null): HTMLElement | null {
  const element = elementNode(node);
  if (!element) return null;
  return element.closest<HTMLElement>("section[data-id]");
}

function elementNode(node: Node | null): Element | null {
  if (node instanceof Element) return node;
  return parentOf(node);
}

function parentOf(node: Node | null): Element | null {
  if (node instanceof Text) return parentElementOf(node);
  return null;
}

function nodeById(id: string | undefined): TreeNode | null {
  const found = findById(id);
  if (!found) return null;
  return found.node;
}

function findById(id: string | undefined): { node: TreeNode } | null {
  if (!hasBookId(id)) return null;
  return findNode(book!.nodes, id);
}

function hasBookId(id: string | undefined): id is string {
  return id != null && book != null;
}

function commitRendered(root: HTMLElement, node: TreeNode, caret: SourceCaret, input: TextEdit, type: string): void {
  const body = renderedBody(node);
  copyCut(body, caret, type);
  writeChange(root, node, applyRenderedInput(body, caret.anchor, caret.head, input));
}

function copyCut(body: string, caret: SourceCaret, type: string): void {
  if (type !== "deleteByCut") return;
  void writeText(cutText(body, caret));
}

function cutText(body: string, caret: SourceCaret): string {
  const from = Math.min(caret.anchor, caret.head);
  const to = Math.max(caret.anchor, caret.head);
  return body.slice(from, to);
}

function writeChange(root: HTMLElement, node: TreeNode, next: SourceChange): void {
  if (next.body === renderedBody(node)) return;
  renderedFocus = root;
  dispatchChange(node, next);
}

function dispatchChange(node: TreeNode, next: SourceChange): void {
  if (editorOwns(node)) dispatchRendered(next);
  else dispatchReading(node, next);
}

function dispatchRendered(next: SourceChange): void {
  editor.dispatch({
    changes: { from: next.from, to: next.to, insert: next.insert },
    selection: { anchor: next.caret, head: next.caret },
  });
}

function dispatchReading(node: TreeNode, next: SourceChange): void {
  holdReading(node);
  dispatchRendered(next);
}

function holdReading(node: TreeNode): void {
  if (renderedOwner === node.header.id) return;
  switchReading(node);
}

function switchReading(node: TreeNode): void {
  releaseReadingBuffer();
  openReadingBuffer(node);
}

function openReadingBuffer(node: TreeNode): void {
  renderedOwner = node.header.id;
  loadDocument(node.body, true);
}

function releaseReadingBuffer(): void {
  const id = renderedOwner;
  if (!id) return;
  parkReading(id);
}

function parkReading(id: string): void {
  renderedOwner = null;
  const node = parkedReading(id);
  if (!node) return;
  storeParkedBody(node, id);
}

function parkedReading(id: string): TreeNode | null {
  const found = rowNode(id);
  if (!found) return null;
  return found.node;
}

function storeParkedBody(node: TreeNode, id: string): void {
  node.body = editor.state.doc.toString();
  parked.add(id);
}

function syncRenderedView(): void {
  if (renderedOwner) syncReadingBuffer();
  else placePreviewCaret();
}

function placePreviewCaret(): void {
  if (skipPreviewCaret()) return;
  placeRenderedCaret(previewEl, editor.state.selection.main.head);
}

function skipPreviewCaret(): boolean {
  if (renderedFocus !== previewEl) return true;
  return previewHidden();
}

function previewHidden(): boolean {
  return previewEl.hidden !== false;
}

function syncReadingBuffer(): void {
  const node = ownedReading();
  if (!node) return;
  writeReadingNode(node);
}

function ownedReading(): TreeNode | null {
  const found = findOwned();
  if (!found) return null;
  return found.node;
}

function findOwned(): { node: TreeNode } | null {
  if (!readingOwnerId()) return null;
  return findNode(book!.nodes, renderedOwner!);
}

function readingOwnerId(): boolean {
  return book != null && renderedOwner != null;
}

function writeReadingNode(node: TreeNode): void {
  node.body = editor.state.doc.toString();
  parked.add(node.header.id);
  holds.markEditing(node.header.id);
  drawReading();
  placeRenderedCaret(readingEl, editor.state.selection.main.head);
  paintRowCount(node);
}

type SourceCaret = { anchor: number; head: number; node: Node };

function placeRenderedCaret(root: HTMLElement, offset: number): void {
  const spot = caretSpot(root, offset);
  if (!spot) return;
  selectSpot(root, spot);
}

function caretSpot(root: HTMLElement, offset: number): { node: Text; offset: number } | null {
  const host = hostFor(root, offset);
  if (!host) return null;
  return textPoint(host.el, host.local);
}

function hostFor(root: HTMLElement, offset: number): { el: HTMLElement; local: number } | null {
  const placed = caretLocal(domRuns(root), offset);
  if (!placed) return null;
  return hostAt(root, placed);
}

function hostAt(root: HTMLElement, placed: { src: number; local: number }): { el: HTMLElement; local: number } | null {
  const el = root.querySelector<HTMLElement>(`[data-src="${placed.src}"]`);
  if (!el) return null;
  return { el, local: placed.local };
}

function domRuns(root: HTMLElement): Array<{ src: number; text: string }> {
  return [...root.querySelectorAll<HTMLElement>("[data-src]")].map(domRun);
}

function domRun(el: HTMLElement): { src: number; text: string } {
  return { src: Number(el.dataset.src), text: el.textContent ?? "" };
}

function textPoint(el: HTMLElement, local: number): { node: Text; offset: number } | null {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  return stepText(walker, local, 0);
}

function stepText(walker: TreeWalker, local: number, seen: number): { node: Text; offset: number } | null {
  const node = walker.nextNode();
  if (!(node instanceof Text)) return null;
  return pointOrNext(walker, node, local, seen);
}

function pointOrNext(
  walker: TreeWalker,
  node: Text,
  local: number,
  seen: number,
): { node: Text; offset: number } | null {
  const next = seen + node.length;
  if (local <= next) return { node, offset: local - seen };
  return stepText(walker, local, next);
}

function selectSpot(root: HTMLElement, spot: { node: Text; offset: number }): void {
  const range = root.ownerDocument.createRange();
  range.setStart(spot.node, spot.offset);
  range.collapse(true);
  const selection = root.ownerDocument.getSelection();
  if (!selection) return;
  applySpot(root, selection, range, spot.node);
}

function applySpot(root: HTMLElement, selection: globalThis.Selection, range: Range, node: Text): void {
  selection.removeAllRanges();
  selection.addRange(range);
  root.focus();
  reveal(node.parentElement);
}

function reveal(element: HTMLElement | null): void {
  if (!element) return;
  element.scrollIntoView({ block: "nearest" });
}

function readCaret(root: HTMLElement): SourceCaret | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection) return null;
  return caretFrom(root, selection);
}

function caretFrom(root: HTMLElement, selection: globalThis.Selection): SourceCaret | null {
  const anchor = sourceOf(root, selection.anchorNode, selection.anchorOffset);
  if (anchor == null) return null;
  return caretHead(root, selection, anchor);
}

function caretHead(root: HTMLElement, selection: globalThis.Selection, anchor: number): SourceCaret | null {
  const head = sourceOf(root, selection.focusNode, selection.focusOffset);
  if (head == null) return null;
  return caretSame(selection, anchor, head);
}

function caretSame(selection: globalThis.Selection, anchor: number, head: number): SourceCaret | null {
  const node = sharedSectionNode(selection);
  if (!node) return null;
  return { anchor, head, node };
}

function sharedSectionNode(selection: globalThis.Selection): Node | null {
  if (!oneSection(selection.anchorNode, selection.focusNode)) return null;
  return selection.anchorNode;
}

function oneSection(anchor: Node | null, head: Node | null): boolean {
  const section = sectionOf(anchor);
  if (!section) return false;
  return section === sectionOf(head);
}

function sourceOf(root: HTMLElement, node: Node | null, offset: number): number | null {
  const host = hostOf(root, node);
  if (!host) return null;
  return srcPlus(host, node, offset);
}

function hostOf(root: HTMLElement, node: Node | null): HTMLElement | null {
  const element = elementNode(node);
  if (!element) return null;
  return closestSource(root, element);
}

function closestSource(root: HTMLElement, element: Element): HTMLElement | null {
  const host = element.closest<HTMLElement>("[data-src]");
  if (!inside(root, host)) return null;
  return host;
}

function inside(root: HTMLElement, host: HTMLElement | null): host is HTMLElement {
  return host != null && root.contains(host);
}

function srcPlus(host: HTMLElement, node: Node | null, offset: number): number | null {
  const local = localOffset(host, node, offset);
  if (local == null) return null;
  return Number(host.dataset.src) + local;
}

function localOffset(host: HTMLElement, node: Node | null, offset: number): number | null {
  if (!node) return null;
  return countedOffset(host, node, offset);
}

function countedOffset(host: HTMLElement, node: Node, offset: number): number | null {
  const walker = host.ownerDocument.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  return countTo(walker, node, offset, 0);
}

function countTo(walker: TreeWalker, target: Node, offset: number, seen: number): number | null {
  const node = walker.nextNode();
  if (!(node instanceof Text)) return null;
  return countNode(walker, node, target, offset, seen);
}

function countNode(walker: TreeWalker, node: Text, target: Node, offset: number, seen: number): number | null {
  if (node === target) return seen + offset;
  return countTo(walker, target, offset, seen + node.length);
}
editProse.addEventListener("click", () => {
  if (selectedId) void choose(selectedId, true);
});
readGroup.addEventListener("click", () => {
  if (selectedId) void choose(selectedId, false);
});

for (const field of [fieldTitle, fieldSynopsis, fieldStatus, fieldRole, ...unitInputs]) {
  field.addEventListener("input", () => {
    const current = selected();
    if (current) holds.markEditing(current.node.header.id);
    dirty = true;
    saveState.textContent = "Unsaved";
  });
  field.addEventListener("change", () => {
    const current = selected();
    if (current) holds.markEditing(current.node.header.id);
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

bookTitle.addEventListener("input", () => {
  if (!book) return;
  holds.markEditing("book.yaml");
  titleDirty = true;
  saveState.textContent = "Unsaved";
  publishPlace();
});
bookTitle.addEventListener("focus", () => publishPlace());
bookTitle.addEventListener("keyup", () => publishPlace());
bookTitle.addEventListener("click", () => publishPlace());
bookTitle.addEventListener("select", () => publishPlace());
bookTitle.addEventListener("change", () => {
  if (!book) return;
  titleDirty = true;
  void flush().then(() => renderOutline());
});
void getCurrentWindow().onCloseRequested(async () => {
  await stopCompanion().catch(() => undefined);
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
