import { describe, expect, it } from "vitest";
import type { TreeNode } from "../internals/model";
import { renderBook, renderGroup, renderSection, textRuns } from "./preview";

function section(body: string, role: TreeNode["header"]["role"] = "body"): TreeNode {
  return {
    kind: "section",
    header: { id: "inward", title: "Inward", synopsis: "", status: "draft", role },
    body,
    prefix: "010",
    slug: "inward",
    dir: "",
    entryName: "010-inward.md",
    children: [],
  };
}

describe("source runs", () => {
  it("points each visible run at the markdown characters it shows", () => {
    expect(textRuns("Hello **bold** world.\n")).toEqual([
      { src: 0, text: "Hello ", block: false },
      { src: 8, text: "bold", block: false },
      { src: 14, text: " world.", block: false },
    ]);
    expect(textRuns("# Title\n\nBody.\n")).toEqual([
      { src: 2, text: "Title", block: false },
      { src: 9, text: "Body.", block: false },
    ]);
    const note = "See ^[the bridge].\n";
    expect(textRuns(note)).toContainEqual({ src: note.indexOf("the bridge"), text: "the bridge", block: false });
    expect(textRuns("See the ![Bridge](images/bridge.jpg){width=100%} today.\n").map((run) => run.text)).toEqual([
      "See the ",
      " today.",
    ]);
    expect(textRuns("Hello\n\n```\ncode\n```\n")).toContainEqual({ src: 11, text: "code\n", block: true });
  });

  it("stamps the rendered text with the markdown offset it came from", () => {
    const rendered = renderSection(section("Hello **bold**.\n"), []);
    expect(rendered.html).toContain('<span data-src="8">bold</span>');
    expect(rendered.html).not.toContain('data-src="0">Inward');

    const picture = renderSection(section("See the ![Bridge](images/bridge.jpg){width=100%} today.\n"), []);
    expect(picture.html).toContain('alt="Bridge"');
    expect(picture.html).toContain('<span data-src="48"> today.</span>');
    expect(picture.html).not.toContain(">Bridge</span>");

    const code = renderSection(section("Hello\n\n```\ncode\n```\n"), []);
    expect(code.html).toContain('<code data-src="11"');
  });

  it("does not stamp text whose characters are not in the source", () => {
    expect(textRuns("Tom &amp; Jerry\n")).toEqual([]);
    expect(textRuns("Tom &amp; Jerry\n\nNext\n")).toEqual([]);
    const rendered = renderSection(section("Tom &amp; Jerry\n"), []);
    expect(rendered.html).toContain("Tom &amp; Jerry");
    expect(rendered.html).not.toContain("data-src");
  });

  it("keeps each copy of the same characters at its own offset", () => {
    expect(textRuns("Hi\n\nHi\n")).toEqual([
      { src: 0, text: "Hi", block: false },
      { src: 4, text: "Hi", block: false },
    ]);
    expect(textRuns("a`a`\n")).toEqual([
      { src: 0, text: "a", block: false },
      { src: 2, text: "a", block: false },
    ]);
  });

  it("stamps a single character", () => {
    expect(renderSection(section("A\n"), []).html).toContain('<span data-src="0">A</span>');
    expect(renderSection(section("See `x`.\n"), []).html).toContain('<code data-src="5"');
  });
});

describe("preview", () => {
  it("shows the section the way export will, including a missing note and a broken fence", () => {
    const parent: TreeNode = {
      kind: "group",
      header: { id: "rule", title: "The Rule", synopsis: "", status: "draft", role: "body" },
      body: "",
      prefix: "010",
      slug: "rule",
      dir: "",
      entryName: "010-rule",
      children: [],
    };
    const grand: TreeNode = {
      kind: "group",
      header: { id: "naming", title: "Naming", synopsis: "", status: "draft", role: "body" },
      body: "",
      prefix: "010",
      slug: "naming",
      dir: "",
      entryName: "010-naming",
      children: [parent],
    };
    const node = section("# Where the rule stops\n\nSee.[^9]\n\n```java\nclass Foo {\n");
    const rendered = renderSection(node, [grand, parent]);
    expect(rendered.html).toContain("<h3>Inward</h3>");
    expect(rendered.html).toMatch(/<h4[^>]*>\s*<span data-src="2">Where the rule stops<\/span><\/h4>/);
    expect(rendered.html).toContain("missing-fn");
    expect(rendered.html).toContain("broken-fence");
    expect(rendered.html).toContain("Foo");
    expect(rendered.warnings).toContain("Footnote [^9] has no definition.");
    expect(rendered.warnings.filter((warning) => warning.includes("Unclosed"))).toEqual(["Unclosed code fence."]);
  });

  it("points a footnote marker at the note in that same section", () => {
    const here = section("See.[^1]\n\n[^1]: Here.\n");
    const there = section("Also.[^1]\n\n[^1]: There.\n");
    there.header = { ...there.header, id: "outward", title: "Outward" };
    const one = renderSection(here, []);
    expect(one.warnings).toEqual([]);
    expect(one.html).toContain('href="#fn-inward-1"');
    expect(one.html).toContain('id="fn-inward-1"');
    expect(one.html).toContain('id="fnref-inward-1"');
    expect(one.html).toContain('href="#fnref-inward-1"');
    expect(one.html).toContain('data-line="0"');
    expect(one.html).toMatch(/data-line="2"[^>]*>\s*<span data-src="16">Here\./);
    const both = renderBook([here, there]);
    expect(both.html).toContain('id="fn-inward-1"');
    expect(both.html).toContain('id="fn-outward-1"');
    expect(both.html).not.toContain('href="#fn1"');
  });

  it("turns an inline note into a footnote and keeps one written in code", () => {
    const rendered = renderSection(section("See ^[the bridge] and `^[not a note]`.\n[^1]: Kept.\n"), []);
    expect(rendered.html).toContain("the bridge");
    expect(rendered.html).toContain("not a note");
    expect(rendered.warnings).toEqual([]);
  });

  it("does not treat a footnote mentioned in code as a missing note", () => {
    const rendered = renderSection(
      section("A footnote is `[^1]`, and the command inserts `[^n]`.\n"),
      [],
    );
    expect(rendered.warnings).toEqual([]);
    expect(rendered.html).not.toContain("missing-fn");
  });

  it("marks each block with the source lines it came from", () => {
    const rendered = renderSection(section("Hello\n\n```\ncode\n```\n"), []);
    expect(rendered.html).toContain('data-id="inward"');
    expect(rendered.html).toContain('data-line="0"');
    expect(rendered.html).toContain('<pre data-line="2" data-end="5"');
  });

  it("sizes a picture from the width field and does not print that field", () => {
    const rendered = renderSection(section("See the ![Bridge](images/bridge.jpg){width=100%} today.\n"), []);
    expect(rendered.html).toContain('style="width: 100%"');
    expect(rendered.html).toContain('alt="Bridge"');
    expect(rendered.html).toContain("today.");
    expect(rendered.html).not.toContain("{width=100%}");

    const sized = renderSection(section("![Map](images/map.png){width=40% height=8cm}\n"), []);
    expect(sized.html).toContain('style="width: 40%; height: 8cm"');
    expect(sized.html).not.toContain("{width=");
  });

  it("renders the whole manuscript in order and skips nothing it was given", () => {
    const preface = section("Before.\n", "front");
    preface.header = { ...preface.header, id: "preface", title: "Preface" };
    const chapter: TreeNode = {
      kind: "group",
      header: { id: "naming", title: "Naming", synopsis: "", status: "draft", role: "body", unit: "chapter" },
      body: "Opener.\n",
      prefix: "020",
      slug: "naming",
      dir: "",
      entryName: "020-naming",
      children: [section("Inside.\n")],
    };
    const rendered = renderBook([preface, chapter]);
    expect(rendered.html.indexOf("<h1>Preface</h1>")).toBeLessThan(rendered.html.indexOf("Chapter 1"));
    expect(rendered.html).toContain('<p class="chapter-number">Chapter 1</p><h1>Naming</h1>');
    expect(rendered.html).toContain("<h2>Inward</h2>");
    expect(rendered.html.indexOf("Page break")).toBeGreaterThan(rendered.html.indexOf("<h1>Preface</h1>"));
    expect(rendered.html.indexOf("Page break")).toBeLessThan(rendered.html.indexOf("Chapter 1"));
    expect(rendered.warnings).toEqual([]);
  });

  it("numbers a chapter heading and not the folder's child", () => {
    const chapter: TreeNode = {
      kind: "group",
      header: { id: "naming", title: "Naming", synopsis: "", status: "draft", role: "body", unit: "chapter" },
      body: "Opener.\n",
      prefix: "010",
      slug: "naming",
      dir: "",
      entryName: "010-naming",
      children: [section("Inside.\n")],
    };
    const rendered = renderGroup(chapter);
    expect(rendered.html).toContain('<section class="rendered-section folder break"');
    expect(rendered.html).toContain('<p class="chapter-number">Chapter 1</p><h1>Naming</h1>');
    expect(rendered.html).toContain("<h2>Inward</h2>");
    expect(rendered.html).not.toContain("<h2>Chapter");
    expect(rendered.html).not.toContain("Page break");
  });

  it("marks a folder inside the one being read", () => {
    const inner: TreeNode = {
      kind: "group",
      header: { id: "rule", title: "The Rule", synopsis: "", status: "draft", role: "body" },
      body: "Nested.\n",
      prefix: "010",
      slug: "rule",
      dir: "",
      entryName: "010-rule",
      children: [],
    };
    const chapter: TreeNode = {
      kind: "group",
      header: { id: "naming", title: "Naming", synopsis: "", status: "draft", role: "body" },
      body: "Opener.\n",
      prefix: "020",
      slug: "naming",
      dir: "",
      entryName: "020-naming",
      children: [inner],
    };
    const rendered = renderGroup(chapter);
    const breaks = rendered.html.split("Page break");
    expect(breaks).toHaveLength(2);
    expect(breaks[0]).toContain("<h1>Naming</h1>");
    expect(breaks[1]).toContain("<h2>The Rule</h2>");
  });

  it("marks a section whose page break is set and skips a folder whose page break is clear", () => {
    const scene = section("Next.\n");
    scene.header = { ...scene.header, id: "scene", title: "Scene", break: true };
    const quiet: TreeNode = {
      kind: "group",
      header: { id: "quiet", title: "Quiet", synopsis: "", status: "draft", role: "body", break: false },
      body: "Same page.\n",
      prefix: "010",
      slug: "quiet",
      dir: "",
      entryName: "010-quiet",
      children: [scene],
    };
    const rendered = renderBook([section("Before.\n"), quiet]);
    const breaks = rendered.html.split("Page break");
    expect(breaks).toHaveLength(2);
    expect(breaks[0]).toContain("<h1>Quiet</h1>");
    expect(breaks[1]).toContain("<h2>Scene</h2>");

    const opener = section("First.\n");
    opener.header = { ...opener.header, break: true };
    const alone = renderBook([opener]);
    expect(alone.html).not.toContain("Page break");
    expect(alone.html).toContain('class="rendered-section break"');
  });

  it("heads a part and a chapter, and leaves text on the same page", () => {
    const stay = section("Stay.\n");
    stay.header = { ...stay.header, id: "stay", title: "Stay", unit: "text" };
    const next = section("Next.\n");
    next.header = { ...next.header, id: "next", title: "Next", unit: "chapter" };
    const part: TreeNode = {
      kind: "group",
      header: { id: "opening", title: "Opening", synopsis: "", status: "draft", role: "body", unit: "part" },
      body: "Begin.\n",
      prefix: "010",
      slug: "opening",
      dir: "",
      entryName: "010-opening",
      children: [stay, next],
    };
    const rendered = renderBook([part]);
    expect(rendered.html).toContain('<p class="chapter-number">Part 1</p><h1>Opening</h1>');
    expect(rendered.html).toContain('<p class="chapter-number">Chapter 1</p><h2>Next</h2>');
    expect(rendered.html).not.toContain(">Section ");
    const breaks = rendered.html.split("Page break");
    expect(breaks).toHaveLength(2);
    expect(breaks[0]).toContain("<h2>Stay</h2>");
    expect(breaks[1]).toContain("<h2>Next</h2>");
  });

  it("keeps two inline notes, including one with no trailing newline", () => {
    const both = renderSection(section("One ^[alpha] and two ^[beta].\n"), []);
    expect(both.html).toContain("alpha");
    expect(both.html).toContain("beta");
    expect(both.html.match(/<li/g)?.length).toBe(2);
    const bare = renderSection(section("See ^[gamma]"), []);
    expect(bare.html).toContain("gamma");
    expect(bare.html).not.toContain("NaN");
    expect(bare.warnings).toEqual([]);
  });

  it("warns only when a heading is past level 6", () => {
    const ancestors = (count: number): TreeNode[] =>
      Array.from({ length: count }, (_, index) => ({
        kind: "group",
        header: { id: `p${index}`, title: `P${index}`, synopsis: "", status: "draft", role: "body" },
        body: "",
        prefix: "010",
        slug: `p${index}`,
        dir: "",
        entryName: `p${index}`,
        children: [],
      }));
    const sixth = renderSection(section("Body.\n"), ancestors(5));
    expect(sixth.html).toContain("<h6>Inward</h6>");
    expect(sixth.warnings).toEqual([]);
    expect(renderSection(section("Body.\n"), ancestors(6)).warnings).toContain(
      '"Inward" is deeper than heading level 6.',
    );
  });

  it("labels a front-matter section", () => {
    const rendered = renderSection(section("A preface.\n", "front"), []);
    expect(rendered.html).toContain('class="rendered-section front"');
    expect(rendered.html).toContain("Front matter");
    expect(rendered.html).toContain("<h1>Inward</h1>");
  });
});
