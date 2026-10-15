import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { COMMANDS, applyCommand, changedSpan, latestLanguage } from "./commands";

describe("markup commands", () => {
  it("lists the twelve constructs, and foot finds Footnote", () => {
    expect(COMMANDS.map((command) => command.name)).toEqual([
      "Emphasis",
      "Strong",
      "Inline code",
      "Link",
      "Picture",
      "Subsection",
      "Lower subsection",
      "Bullet list",
      "Numbered list",
      "Quotation",
      "Code block",
      "Footnote",
    ]);
    const foot = COMMANDS.filter((command) => command.name.toLowerCase().includes("foot"));
    expect(foot.map((command) => command.name)).toEqual(["Footnote"]);
    const picture = COMMANDS.filter((command) => command.name.toLowerCase().includes("pic"));
    expect(picture.map((command) => command.name)).toEqual(["Picture"]);
  });

  it("wraps a selection and parks the cursor inside empty marks", () => {
    const wrapped = applyCommand("emphasis", "word", 0, 4);
    expect(wrapped.text).toBe("*word*");
    expect(wrapped.head).toBe(6);

    const empty = applyCommand("strong", "", 0, 0);
    expect(empty.text).toBe("****");
    expect(empty.head).toBe(2);

    const link = applyCommand("link", "word", 0, 4);
    expect(link.text).toBe("[word](url)");
    expect(link.head).toBe(link.text.length);

    const picture = applyCommand("picture", "See the bridge today.", 8, 14, "", "images/bridge.jpg");
    expect(picture.text).toBe("See the ![bridge](images/bridge.jpg){width=100%} today.");
    expect(picture.head).toBe("See the ![bridge](images/bridge.jpg){width=100%}".length);

    const bare = applyCommand("picture", "See.", 4, 4, "", "images/my photo.jpg");
    expect(bare.text).toBe("See.![](<images/my photo.jpg>){width=100%}");
    expect(bare.head).toBe(6);

    const escaped = applyCommand("picture", "A]b", 0, 3, "", "images/a.jpg");
    expect(escaped.text).toBe("![A\\]b](images/a.jpg){width=100%}");

    const code = applyCommand("inline-code", "x", 1, 1);
    expect(code.text).toBe("x``");
    expect(code.head).toBe(2);
  });

  it("prefixes the current line", () => {
    const heading = applyCommand("subsection", "hello\nnext", 1, 1);
    expect(heading.text).toBe("# hello\nnext");
    const quote = applyCommand("quotation", "line", 0, 0);
    expect(quote.text).toBe("> line");
    expect(quote.anchor).toBe(2);
    expect(quote.head).toBe(2);
    const item = applyCommand("bullet", "line", 2, 2);
    expect(item.text).toBe("- line");
    const numbered = applyCommand("numbered", "line", 0, 0);
    expect(numbered.text).toBe("1. line");
    const lower = applyCommand("lower-subsection", "line", 0, 0);
    expect(lower.text).toBe("## line");

    const second = applyCommand("subsection", "hello\nnext", 7, 7);
    expect(second.text).toBe("hello\n# next");
    const onBreak = "ab\ncd";
    const atBreak = onBreak.indexOf("\n");
    expect(applyCommand("subsection", onBreak, atBreak, atBreak).text).toBe("# ab\ncd");
  });

  it("moves only the cursors that sit on the prefixed line", () => {
    const text = "hello\nnext";
    const edited = applyCommand("subsection", text, 0, 7);
    expect(edited.text).toBe("hello\n# next");
    expect(edited.anchor).toBe(0);
    expect(edited.head).toBe(9);
  });

  it("inserts a fenced block using the latest language in the book", () => {
    expect(latestLanguage(["```java\nint x;\n```\n", "```\nplain\n```\n"])).toBe("");
    expect(latestLanguage(["See.\n", "```java\nint x;\n```\n"])).toBe("java");

    const empty = applyCommand("code-block", "", 0, 0, "");
    expect(empty.text).toBe("\n```\n\n```\n\n");
    expect(empty.head).toBe(4);

    const coded = applyCommand("code-block", "int x;", 0, 6, "java");
    expect(coded.text).toBe("\n```java\nint x;\n```\n\n");
    expect(coded.text[coded.head - 1]).toBe(";");

    const afterWord = applyCommand("code-block", "See this", 4, 8, "");
    expect(afterWord.text).toBe("See \n\n```\nthis\n```\n\n");

    const afterLine = applyCommand("code-block", "See\nint x;", 4, 10, "java");
    expect(afterLine.text).toBe("See\n\n```java\nint x;\n```\n\n");

    const afterBlank = applyCommand("code-block", "See\n\nint x;", 5, 11, "java");
    expect(afterBlank.text).toBe("See\n\n```java\nint x;\n```\n\n");

    const kept = applyCommand("code-block", "See\n\nint x;\nMore", 5, 11, "java");
    expect(kept.text).toBe("See\n\n```java\nint x;\n```\n\n\nMore");

    const one = applyCommand("code-block", "x", 0, 1, "java");
    expect(one.text).toBe("\n```java\nx\n```\n\n");
    expect(one.head).toBe(10);

    const emptyNamed = applyCommand("code-block", "See", 3, 3, "java");
    expect(emptyNamed.text).toBe("See\n\n```java\n\n```\n\n");
    expect(emptyNamed.head).toBe(13);
  });

  it("adds the next footnote without renumbering the ones already there", () => {
    const text = "Hello [^1] there.\n\n[^1]: First.\n";
    const edited = applyCommand("footnote", text, text.length, text.length);
    expect(edited.text).toBe("Hello [^1] there.\n\n[^1]: First.\n[^2]\n\n[^2]: ");
    expect(edited.head).toBe(edited.text.length);
  });

  it("limits an emphasis edit to the selection, leaving the text around it", () => {
    const before = "Keep this.\nChange me.\nKeep that.";
    const edited = applyCommand("emphasis", before, 11, 21);
    const span = changedSpan(before, edited.text);
    expect(span).toEqual({ from: 11, to: 21, insert: "*Change me.*" });
    expect(before.slice(0, span.from) + span.insert + before.slice(span.to)).toBe(edited.text);
  });

  it("maps a caret at the start of Hello onto X when X is inserted there", () => {
    const before = EditorState.create({ doc: "Hello", selection: { anchor: 0 } });
    const next = before.update({ changes: changedSpan("Hello", "XHello") }).state;
    expect(next.doc.toString()).toBe("XHello");
    expect(next.selection.main.head).toBe(0);
    expect(next.doc.sliceString(0, 1)).toBe("X");
  });

  it("keeps a caret on e when X is inserted before it", () => {
    const before = EditorState.create({ doc: "Hello", selection: { anchor: 1 } });
    const next = before.update({ changes: changedSpan("Hello", "XHello") }).state;
    expect(next.selection.main.head).toBe(2);
    expect(next.doc.sliceString(2, 3)).toBe("e");
  });

  it("finds an edit at either end, and an empty edit when the text matches", () => {
    expect(changedSpan("same", "same")).toEqual({ from: 4, to: 4, insert: "" });
    expect(changedSpan("tail", "head\ntail")).toEqual({ from: 0, to: 0, insert: "head\n" });
    expect(changedSpan("head", "head\ntail")).toEqual({ from: 4, to: 4, insert: "\ntail" });
    expect(changedSpan("abc", "xyz")).toEqual({ from: 0, to: 3, insert: "xyz" });
  });
});
