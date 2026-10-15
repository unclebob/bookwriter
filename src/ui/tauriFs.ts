import { invoke } from "@tauri-apps/api/core";
import type { DirEntry, Fs } from "../internals/book";

export const tauriFs: Fs = {
  readText: (path) => invoke("read_text", { path }),
  readBytes: async (path) => new Uint8Array(await invoke<ArrayBuffer>("read_bytes", { path })),
  writeText: (path, text) => invoke("write_text", { path, text }),
  readDir: (path) => invoke<DirEntry[]>("read_dir", { path }),
  rename: (from, to) => invoke("rename_path", { from, to }),
  moveFile: (from, to) => invoke("move_file", { from, to }),
  canonicalize: (path) => invoke("canonicalize_path", { path }),
  mkdir: (path) => invoke("make_dir", { path }),
  remove: (path) => invoke("remove_path", { path }),
};

/** Let the preview load picture files from this book folder. */
export function allowBook(root: string): Promise<void> {
  return invoke("allow_book", { root });
}

export function startupBookPath(): Promise<string> {
  return invoke("startup_book_path");
}

/** Ask Pandoc to write one Word file. `resourceDir` is the book folder, so picture paths resolve. */
export function pandocDocx(markdown: string, output: string, resourceDir: string): Promise<void> {
  return invoke("pandoc_docx", { markdown, output, resourceDir });
}

export function setOpenBook(root: string): Promise<void> {
  return invoke("set_open_book", { root });
}

export function ensureCompanion(): Promise<void> {
  return invoke("ensure_companion");
}

export function stopCompanion(): Promise<void> {
  return invoke("stop_companion");
}

export function readRefresh(): Promise<string | null> {
  return invoke("read_refresh");
}

export function writePlace(json: string): Promise<void> {
  return invoke("write_place", { json });
}

export function clearPlace(): Promise<void> {
  return invoke("clear_place");
}
