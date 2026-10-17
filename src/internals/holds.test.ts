import { describe, expect, it } from "vitest";
import { FileHolds, hasNewRefresh, installDisk, saveInstall } from "./holds";

const open = "manuscript/010-open.md";
const other = "manuscript/020-other.md";

describe("file holds", () => {
  it("reloads a file the writer is not editing and leaves the open bytes alone", () => {
    const holds = loaded();
    holds.markEditing("open");
    const effects = holds.observe(
      new Map([
        ["open", { path: open, bytes: "Hello" }],
        ["other", { path: other, bytes: "Remote" }],
      ]),
    );
    expect(effects).toEqual([{ kind: "reload", id: "other", path: other, bytes: "Remote" }]);
  });

  it("ignores an edit of a file it has not seen", () => {
    const holds = new FileHolds();
    holds.markEditing("missing");
    expect(holds.editing("missing")).toBe(false);
    expect(holds.base("missing")).toBeNull();
  });

  it("keeps the base when a file is already being edited", () => {
    const holds = loaded();
    holds.markEditing("open");
    holds.markEditing("open");
    expect(holds.editing("open")).toBe(true);
    expect(holds.base("open")).toBe("Hello");
  });

  it("tracks a file the window has not seen, and leaves a known file alone", () => {
    const holds = loaded();
    holds.ensureTracked("open", { path: "elsewhere.md", bytes: "Other" });
    holds.ensureTracked("fresh", { path: "manuscript/030-fresh.md", bytes: "New" });
    expect(holds.base("open")).toBe("Hello");
    expect(holds.base("fresh")).toBe("New");
  });

  it("follows a prefix rename of a clean section and keeps a missing edit", () => {
    const holds = loaded();
    const next = "manuscript/030-open.md";
    expect(
      holds.observe(
        new Map([
          ["open", { path: next, bytes: "Hello" }],
          ["other", { path: other, bytes: "There" }],
        ]),
      ),
    ).toEqual([{ kind: "moved", id: "open", path: next }]);
    expect(holds.editing("open")).toBe(false);

    const editing = loaded();
    editing.markEditing("open");
    expect(
      editing.observe(
        new Map([
          ["open", { path: next, bytes: "Hello" }],
          ["other", { path: other, bytes: "There" }],
        ]),
      ),
    ).toEqual([{ kind: "moved", id: "open", path: next }]);
    expect(editing.base("open")).toBe("Hello");
    expect(editing.observe(new Map([["other", { path: other, bytes: "There" }]]))).toEqual([
      { kind: "removed", id: "open" },
    ]);
    expect(editing.editing("open")).toBe(false);
    expect(editing.base("open")).toBeNull();
  });
});

function loaded(): FileHolds {
  const holds = new FileHolds();
  holds.replaceAll(
    new Map([
      ["open", { path: open, bytes: "Hello" }],
      ["other", { path: other, bytes: "There" }],
    ]),
  );
  return holds;
}

describe("refresh token", () => {
  it("applies a new token once", () => {
    expect(hasNewRefresh(null, null)).toBe(false);
    expect(hasNewRefresh(null, "1")).toBe(true);
    expect(hasNewRefresh("1", "1")).toBe(false);
    expect(hasNewRefresh("1", null)).toBe(false);
    expect(hasNewRefresh("1", "2")).toBe(true);
  });

});

describe("installing a save", () => {
  const ready = {
    busy: false,
    base: "Hello",
    disk: "Hello",
    diskNow: "Hello",
    snapshot: "Mine",
    buffer: "Mine",
  };

  it("holds while the companion is busy and while the buffer has moved", () => {
    expect(saveInstall({ ...ready, busy: true })).toBe("hold");
    expect(saveInstall({ ...ready, buffer: "Mine!" })).toBe("hold");
    expect(saveInstall({ ...ready, diskNow: "Remote" })).toBe("hold");
    expect(saveInstall({ ...ready, disk: "Remote", diskNow: "Remote" })).toBe("hold");
    expect(saveInstall({ ...ready, base: null, disk: null, diskNow: null })).toBe("write");
    expect(saveInstall({ ...ready, disk: null, diskNow: null })).toBe("hold");
  });

  it("writes a stable buffer when disk is still the base, and skips a disk that already matches", () => {
    expect(saveInstall(ready)).toBe("write");
    expect(saveInstall({ ...ready, disk: "Mine", diskNow: "Mine" })).toBe("same");
  });

  it("writes the held buffer once the companion bytes are accepted as the base", () => {
    const holds = loaded();
    holds.markEditing("open");
    holds.observe(new Map([["open", { path: open, bytes: "Remote" }]]));
    expect(holds.editing("open")).toBe(true);
    expect(holds.base("open")).toBe("Hello");
    expect(
      saveInstall({ ...ready, base: holds.base("open"), disk: "Remote", diskNow: "Remote" }),
    ).toBe("hold");
    holds.acceptDisk("open", open, "Remote");
    expect(holds.base("open")).toBe("Remote");
    expect(
      saveInstall({ ...ready, base: holds.base("open"), disk: "Remote", diskNow: "Remote" }),
    ).toBe("write");
    holds.noteWrite("open", open, "Mine");
    expect(holds.editing("open")).toBe(false);
    expect(holds.base("open")).toBe("Mine");
  });

  it("installs companion bytes only when the buffer is still the base", () => {
    expect(installDisk({ base: "Hello", snapshot: null, buffer: null })).toBe("install");
    expect(installDisk({ base: "Hello", snapshot: null, buffer: "Mine" })).toBe("install");
    expect(installDisk({ base: "Hello", snapshot: "Hello", buffer: null })).toBe("install");
    expect(installDisk({ base: "Hello", snapshot: "Hello", buffer: "Hello" })).toBe("install");
    expect(installDisk({ base: "Hello", snapshot: "Mine", buffer: "Mine" })).toBe("hold");
    expect(installDisk({ base: "Hello", snapshot: "Hello", buffer: "Hello!" })).toBe("hold");
  });
});
