import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("window close", () => {
  it("grants the destroy the close box uses after the companion stops", async () => {
    const path = new URL("../src-tauri/capabilities/default.json", import.meta.url);
    const capability = JSON.parse(await readFile(path, "utf8")) as { permissions: string[] };
    expect(capability.permissions).toContain("core:window:allow-destroy");
  });
});
