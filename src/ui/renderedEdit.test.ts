import { describe, expect, it } from "vitest";
import { applyRenderedInput, caretLocal, inBlock, renderedInput } from "./renderedEdit";

describe("rendered edit", () => {
  it("inserts at the caret and leaves every other byte", () => {
    const next = applyRenderedInput("Hello **bold**.", 8, 8, { kind: "insert", text: "X" });
    expect(next).toMatchObject({ body: "Hello **Xbold**.", caret: 9, from: 8, to: 8, insert: "X" });
  });

  it("replaces the selection", () => {
    const next = applyRenderedInput("Hello", 4, 1, { kind: "insert", text: "i" });
    expect(next).toMatchObject({ body: "Hio", caret: 2, from: 1, to: 4, insert: "i" });
  });

  it("backspace deletes the source character before the caret", () => {
    const next = applyRenderedInput("Hello **bold**.", 8, 8, { kind: "backspace", word: false });
    expect(next).toMatchObject({ body: "Hello *bold**.", caret: 7, from: 7, to: 8, insert: "" });
  });

  it("does nothing when backspace is at the start", () => {
    const next = applyRenderedInput("Hello", 0, 0, { kind: "backspace", word: false });
    expect(next).toMatchObject({ body: "Hello", caret: 0, from: 0, to: 0, insert: "" });
  });

  it("delete removes the source character after the caret", () => {
    const next = applyRenderedInput("Hello", 1, 1, { kind: "delete", word: false });
    expect(next).toMatchObject({ body: "Hllo", caret: 1, from: 1, to: 2, insert: "" });
  });

  it("backspace of a selection deletes that selection", () => {
    const next = applyRenderedInput("Hello", 1, 4, { kind: "backspace", word: false });
    expect(next).toMatchObject({ body: "Ho", caret: 1, from: 1, to: 4, insert: "" });
  });

  it("word backspace deletes the previous word", () => {
    const next = applyRenderedInput("Hello bold.", 11, 11, { kind: "backspace", word: true });
    expect(next.body).toBe("Hello ");
    expect(next.caret).toBe(6);
  });

  it("word delete removes the next word", () => {
    const next = applyRenderedInput("Hello bold.", 6, 6, { kind: "delete", word: true });
    expect(next.body).toBe("Hello ");
    expect(next.caret).toBe(6);
  });

  it("word delete at either end stays inside the text", () => {
    expect(applyRenderedInput("Hello bold.", 0, 0, { kind: "delete", word: true })).toMatchObject({
      body: " bold.",
      caret: 0,
    });
    expect(applyRenderedInput("Hello", 5, 5, { kind: "delete", word: true })).toMatchObject({
      body: "Hello",
      caret: 5,
      from: 5,
      to: 5,
    });
  });

  it("a cut deletes the selection and does not delete when nothing is selected", () => {
    expect(applyRenderedInput("Hello", 1, 4, { kind: "cut" }).body).toBe("Ho");
    expect(applyRenderedInput("Hello", 2, 2, { kind: "cut" })).toMatchObject({ body: "Hello", caret: 2 });
  });

  it("clamps a caret that falls outside the text", () => {
    expect(applyRenderedInput("Hi", 10, 10, { kind: "insert", text: "!" })).toMatchObject({
      body: "Hi!",
      caret: 3,
      from: 2,
      to: 2,
      insert: "!",
    });
    expect(applyRenderedInput("Hi", -3, -3, { kind: "insert", text: "!" })).toMatchObject({
      body: "!Hi",
      caret: 1,
      from: 0,
      to: 0,
      insert: "!",
    });
    expect(applyRenderedInput("Hi", Number.NaN, Number.NaN, { kind: "insert", text: "!" })).toMatchObject({
      body: "!Hi",
      caret: 1,
    });
  });

  it("names the edits a rendered keystroke can be", () => {
    expect(renderedInput("insertText", "a", "\n\n")).toEqual({ kind: "insert", text: "a" });
    expect(renderedInput("insertFromPaste", "pasted", "\n\n")).toEqual({ kind: "insert", text: "pasted" });
    expect(renderedInput("insertReplacementText", "x", "\n\n")).toEqual({ kind: "insert", text: "x" });
    expect(renderedInput("insertParagraph", null, "\n\n")).toEqual({ kind: "insert", text: "\n\n" });
    expect(renderedInput("insertLineBreak", null, "\n\n")).toEqual({ kind: "insert", text: "\n" });
    expect(renderedInput("deleteContentBackward", null, "\n\n")).toEqual({ kind: "backspace", word: false });
    expect(renderedInput("deleteWordBackward", null, "\n\n")).toEqual({ kind: "backspace", word: true });
    expect(renderedInput("deleteContentForward", null, "\n\n")).toEqual({ kind: "delete", word: false });
    expect(renderedInput("deleteWordForward", null, "\n\n")).toEqual({ kind: "delete", word: true });
    expect(renderedInput("deleteByCut", null, "\n\n")).toEqual({ kind: "cut" });
    expect(renderedInput("historyUndo", null, "\n\n")).toEqual({ kind: "undo" });
    expect(renderedInput("historyRedo", null, "\n\n")).toEqual({ kind: "redo" });
    expect(renderedInput("insertText", null, "\n\n")).toBeNull();
    expect(renderedInput("formatBold", null, "\n\n")).toBeNull();
  });

  it("knows when the caret is inside a code block", () => {
    const runs = [{ src: 10, text: "code\n", block: true }];
    expect(inBlock(runs, 10)).toBe(true);
    expect(inBlock(runs, 15)).toBe(true);
    expect(inBlock(runs, 9)).toBe(false);
    expect(inBlock([{ src: 0, text: "hi", block: false }], 1)).toBe(false);
  });

  it("places a caret that lands in a gap on the nearest visible character", () => {
    const runs = [
      { src: 0, text: "Hello " },
      { src: 8, text: "bold" },
    ];
    expect(caretLocal(runs, 3)).toEqual({ src: 0, local: 3 });
    expect(caretLocal(runs, 6)).toEqual({ src: 0, local: 6 });
    expect(caretLocal(runs, 8)).toEqual({ src: 8, local: 0 });
    expect(caretLocal(runs, 7)).toEqual({ src: 0, local: 6 });
    expect(caretLocal(runs, 12)).toEqual({ src: 8, local: 4 });
    expect(caretLocal([
      { src: 0, text: "ab" },
      { src: 2, text: "cd" },
    ], 3)).toEqual({ src: 2, local: 1 });
    expect(caretLocal([], 0)).toBeNull();
  });
});
