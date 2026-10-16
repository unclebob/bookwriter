import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Fs } from "./internals/book";

export function nodeFs(): Fs {
  return {
    async readText(path) {
      return readFile(path, "utf8");
    },
    async readBytes(path) {
      return new Uint8Array(await readFile(path));
    },
    async writeText(path, text) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
    },
    async readDir(path) {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "dir" : "file",
      }));
    },
    async rename(from, to) {
      await rename(from, to);
    },
    async moveFile(from, to) {
      await mkdir(dirname(to), { recursive: true });
      try {
        await rename(from, to);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EXDEV") throw error;
        await copyFile(from, to);
        try {
          await rm(from);
        } catch (removeError) {
          await rm(to);
          throw removeError;
        }
      }
    },
    async canonicalize(path) {
      return realpath(path);
    },
    async mkdir(path) {
      await mkdir(path, { recursive: true });
    },
    async remove(path) {
      await rm(path, { recursive: true, force: true });
    },
  };
}
