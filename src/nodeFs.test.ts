import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeFs } from "./nodeFs";

describe("node filesystem", () => {
  it("does not create a missing parent when renaming", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-fs-"));
    try {
      const fs = nodeFs();
      const from = join(root, "one.md");
      await fs.writeText(from, "body");
      await expect(fs.rename(from, join(root, "missing", "two.md"))).rejects.toThrow();
      expect((await fs.readDir(root)).map((entry) => entry.name)).toEqual(["one.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a path that is already gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-fs-"));
    try {
      await expect(nodeFs().remove(join(root, "missing"))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
