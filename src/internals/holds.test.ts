import { describe, expect, it } from "vitest";
import { FileHolds, hasNewRefresh } from "./holds";

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

  it("refuses to save a dirty buffer over a companion write", () => {
    const holds = loaded();
    holds.markEditing("open");
    expect(holds.planSave("open", "Remote", "Mine")).toEqual({ write: null });
    expect(holds.conflict("open")).toBe(true);
    expect(holds.planSave("open", "Remote", "Mine")).toEqual({ write: null });
  });

  it("tracks a file the window has not seen, and leaves a known file alone", () => {
    const holds = loaded();
    holds.ensureTracked("open", { path: "elsewhere.md", bytes: "Other" });
    holds.ensureTracked("fresh", { path: "manuscript/030-fresh.md", bytes: "New" });
    expect(holds.planSave("open", "Hello", "Mine")).toEqual({ write: "Mine" });
    expect(holds.planSave("fresh", "New", "Renamed")).toEqual({ write: "Renamed" });
  });

  it("writes when disk is still the base", () => {
    const holds = loaded();
    holds.markEditing("open");
    expect(holds.planSave("open", "Hello", "Mine")).toEqual({ write: "Mine" });
    expect(holds.conflict("open")).toBe(false);
  });

  it("keeps mine by writing the buffer back and takes theirs without writing", () => {
    const holds = loaded();
    holds.markEditing("open");
    holds.planSave("open", null, "Mine");
    expect(holds.keepMine("open", "Mine")).toEqual({ path: open, bytes: "Mine", removePath: null });
    expect(holds.conflict("open")).toBe(false);

    holds.markEditing("open");
    holds.observe(new Map([["other", { path: other, bytes: "There" }]]));
    expect(holds.takeTheirs("open")).toEqual({ path: open, bytes: null });
    expect(holds.conflict("open")).toBe(false);
  });

  it("follows a prefix rename of a clean section", () => {
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
    expect(holds.conflict("open")).toBe(false);
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

  it("reverts to the base when disk still matches, and not during a conflict", () => {
    const holds = loaded();
    holds.markEditing("open");
    expect(holds.matchesBase("open", "Hello")).toBe(true);
    expect(holds.revertToBase("open")).toBe("Hello");
    expect(holds.editing("open")).toBe(false);
    holds.markEditing("open");
    holds.planSave("open", "Remote", "Mine");
    expect(holds.matchesBase("open", "Remote")).toBe(false);
    expect(holds.matchesBase("open", "Hello")).toBe(true);
    expect(holds.revertToBase("open")).toBeNull();
    expect(holds.conflict("open")).toBe(true);
  });

  it("keeps a dirty buffer on a new token, and on refresh only when disk moved", () => {
    const holds = loaded();
    holds.markEditing("open");
    expect(holds.keepOpenBuffer("open", "token", "Hello")).toBe(true);
    expect(holds.keepOpenBuffer("open", "revert", "Hello")).toBe(false);
    expect(holds.keepOpenBuffer("open", "token", "Remote")).toBe(true);
    expect(holds.keepOpenBuffer("open", "revert", "Remote")).toBe(true);
    holds.planSave("open", "Remote", "Mine");
    expect(holds.keepOpenBuffer("open", "token", "Hello")).toBe(true);
    expect(holds.keepOpenBuffer("open", "revert", "Hello")).toBe(false);
    expect(holds.keepOpenBuffer("quiet", "token", "Hello")).toBe(false);
  });
});
