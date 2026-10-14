import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exportBook, exportChapter, exportDocxFiles, exportNoteGroups, transformBody } from "./export";
import { parseSection, type TreeNode } from "../internals/model";

function node(
  kind: TreeNode["kind"],
  header: TreeNode["header"],
  body: string,
  children: TreeNode[] = [],
): TreeNode {
  return {
    kind,
    header,
    body,
    prefix: "010",
    slug: header.id,
    dir: "",
    entryName: "",
    children,
  };
}

describe("export", () => {
  it("matches the manuscript in the spec", () => {
    const spec = readFileSync("bookwriter-spec.md", "utf8");
    const between = (start: string, end: string, fromIndex = 0) => {
      const from = spec.indexOf(start, fromIndex);
      const to = spec.indexOf(end, from);
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeGreaterThan(from);
      return spec.slice(from, to + end.length);
    };
    const exampleStart = spec.indexOf("Export of the example above:");
    const example = between("# Preface {-}", "[^inward-1]: Toward higher-level policy.", exampleStart);
    const inward = parseSection(between("---\nid: inward", "[^1]: Toward higher-level policy.") + "\n");

    const preface = node(
      "section",
      { id: "preface", title: "Preface", synopsis: "", status: "draft", role: "front" },
      "The preface body.\n",
    );
    const inwardNode = node(
      "section",
      { id: "inward", title: "Inward", synopsis: "", status: "draft", role: "body", unit: "text" },
      inward.body,
    );
    const rule = node(
      "group",
      { id: "the-rule", title: "The Rule", synopsis: "", status: "draft", role: "body", unit: "section" },
      "Inside the chapter.\n",
      [inwardNode],
    );
    const naming = node(
      "group",
      { id: "naming", title: "Naming", synopsis: "", status: "draft", role: "body", unit: "chapter" },
      "The chapter opener.\n",
      [rule],
    );

    const exported = exportBook([preface, naming]);
    expect(exported.warnings).toEqual([]);
    expect(exported.markdown.trimEnd()).toBe(example.trimEnd());
  });

  it("numbers parts and chapters in tree order", () => {
    const scene = node(
      "section",
      { id: "scene", title: "Scene", synopsis: "", status: "draft", role: "body", unit: "chapter" },
      "Nested.\n",
    );
    const one = node(
      "group",
      { id: "one", title: "One", synopsis: "", status: "draft", role: "body", unit: "part" },
      "Part opener.\n",
      [scene],
    );
    const loose = node(
      "section",
      { id: "loose", title: "Loose", synopsis: "", status: "draft", role: "body", unit: "text" },
      "Loose.\n",
    );
    const preface = node(
      "group",
      { id: "preface", title: "Preface", synopsis: "", status: "draft", role: "front", unit: "chapter" },
      "Front.\n",
    );
    const buried = node(
      "section",
      { id: "buried", title: "Buried", synopsis: "", status: "draft", role: "body", unit: "chapter" },
      "Gone.\n",
    );
    const trash = node(
      "group",
      { id: "trash", title: "Trash", synopsis: "", status: "idea", role: "body", unit: "part" },
      "",
      [buried],
    );
    const two = node("group", { id: "two", title: "Two", synopsis: "", status: "draft", role: "body", unit: "chapter" }, "");
    const note = node(
      "section",
      { id: "note", title: "Note", synopsis: "", status: "draft", role: "body", unit: "section" },
      "Aside.\n",
    );
    const exported = exportBook([preface, loose, one, trash, two, note]);
    expect(exported.warnings).toEqual([]);
    expect(exported.markdown).toBe(
      [
        "# Preface {-}\n\nFront.",
        "# Loose\n\nLoose.",
        '<div class="page-break"></div>\n\n<p class="chapter-number">Part 1</p>\n\n# One\n\nPart opener.\n\n<div class="page-break"></div>\n\n<p class="chapter-number">Chapter 1</p>\n\n## Scene\n\nNested.',
        '<div class="page-break"></div>\n\n<p class="chapter-number">Chapter 2</p>\n\n# Two',
        '<div class="page-break"></div>\n\n# Note\n\nAside.',
      ].join("\n\n"),
    );
  });

  it("groups front matter together and each chapter together", () => {
    const intro = node(
      "section",
      { id: "intro", title: "Introduction", synopsis: "", status: "draft", role: "body", unit: "text" },
      "Intro.[^1]\n\n[^1]: Intro note.\n",
    );
    const preface = node(
      "group",
      { id: "preface", title: "Preface", synopsis: "", status: "draft", role: "front" },
      "Preface.[^1]\n\n[^1]: Front note.\n",
      [intro],
    );
    const later = node(
      "section",
      { id: "later", title: "Later", synopsis: "", status: "draft", role: "body", unit: "text" },
      "After the note.\n",
    );
    const inside = node(
      "section",
      { id: "inside", title: "Inside", synopsis: "", status: "draft", role: "body", unit: "text" },
      "Inside.[^2]\n\n[^2]: Inside note.\n",
    );
    const first = node(
      "group",
      { id: "one", title: "First", synopsis: "", status: "draft", role: "body", unit: "chapter" },
      "First.[^1]\n\n[^1]: First note.\n",
      [inside, later],
    );
    const second = node(
      "section",
      { id: "two", title: "Second", synopsis: "", status: "draft", role: "body", unit: "chapter" },
      "Second.[^7]\n\n[^7]: Second note.\n",
    );
    const part = node(
      "group",
      { id: "part", title: "The Part", synopsis: "", status: "draft", role: "body", unit: "part" },
      "Part opener.\n",
      [first, second],
    );
    const nodes = [preface, part];
    const exported = exportNoteGroups(nodes);
    expect(exported.groups).toHaveLength(4);
    expect(exported.groups[0]).toContain("Front note.");
    expect(exported.groups[0]).toContain("Intro note.");
    expect(exported.groups[0]).not.toContain("First note.");
    expect(exported.groups[1]).toContain("Part opener.");
    expect(exported.groups[1]).not.toContain("First note.");
    expect(exported.groups[2]).toContain("First note.");
    expect(exported.groups[2]).toContain("Inside note.");
    expect(exported.groups[2]).toContain("After the note.");
    expect(exported.groups[2]).not.toContain("Second note.");
    expect(exported.groups[3]).toContain("Second note.");
    expect(exportBook(nodes).markdown).toBe(exported.groups.join("\n\n"));
  });

  it("does not prefix a footnote written inside inline code", () => {
    const transformed = transformBody("A footnote is `[^1]`.\n\nSee.[^1]\n\n[^1]: Note.\n", {
      depth: 1,
      sectionId: "editor",
      front: false,
    });
    expect(transformed.text).toContain("`[^1]`");
    expect(transformed.text).toContain("See.[^editor-1]");
  });

  it("prefixes a footnote written in a heading", () => {
    const transformed = transformBody("## SOLID[^2] Design Principles\n\n`[^2]` stays.\n\n[^2]: Martin, 2003.\n", {
      depth: 1,
      sectionId: "plane",
      front: false,
    });
    expect(transformed.text).toContain("### SOLID[^plane-2] Design Principles");
    expect(transformed.text).toContain("`[^2]` stays.");
    expect(transformed.text).toContain("[^plane-2]: Martin, 2003.");
  });

  it("leaves headings and footnotes inside fences alone", () => {
    const transformed = transformBody("```\n# Stay\n[^1]\n```\n\nSee.[^1]\n\n[^1]: Note.\n", {
      depth: 2,
      sectionId: "inward",
      front: false,
    });
    expect(transformed.text).toContain("# Stay");
    expect(transformed.text).toContain("[^1]\n```");
    expect(transformed.text).toContain("See.[^inward-1]");
    expect(transformed.text).toContain("[^inward-1]: Note.");
  });

  it("marks an inherited front-matter section unnumbered and clamps a deep heading", () => {
    const child = node(
      "section",
      { id: "preface", title: "Preface", synopsis: "", status: "idea", role: "body" },
      "##### Too deep\n",
    );
    const group = node(
      "group",
      { id: "front-matter", title: "Front", synopsis: "", status: "idea", role: "front" },
      "",
      [child],
    );
    const exported = exportBook([group]);
    expect(exported.markdown).toContain("# Front {-}\n\n## Preface {-}\n\n###### Too deep {-}");
    expect(exported.warnings.some((warning) => warning.includes("level 7"))).toBe(true);
  });

  it("breaks where the page break is set", () => {
    const scene = node(
      "section",
      { id: "scene", title: "Scene", synopsis: "", status: "draft", role: "body", break: true },
      "On the next page.\n",
    );
    const quiet = node(
      "group",
      { id: "quiet", title: "Quiet", synopsis: "", status: "draft", role: "body", break: false },
      "Same page.\n",
      [scene],
    );
    const loose = node("section", { id: "loose", title: "Loose", synopsis: "", status: "draft", role: "body" }, "Before.\n");
    const exported = exportBook([loose, quiet]);
    expect(exported.markdown).toBe(
      [
        "# Loose\n\nBefore.",
        "# Quiet\n\nSame page.",
        '<div class="page-break"></div>\n\n## Scene\n\nOn the next page.',
      ].join("\n\n"),
    );
    const opening = node(
      "section",
      { id: "scene", title: "Scene", synopsis: "", status: "draft", role: "body", break: true },
      "Opens.\n",
    );
    expect(exportBook([opening]).markdown.startsWith("# Scene")).toBe(true);
  });

  it("writes one word file for each front-matter piece and each chapter", () => {
    const inside = node(
      "section",
      { id: "inside", title: "Inside", synopsis: "", status: "draft", role: "body", unit: "text" },
      "Inside the chapter.\n",
    );
    const nested = node(
      "section",
      { id: "nested", title: "Nested", synopsis: "", status: "draft", role: "body", unit: "chapter" },
      "Nested body.\n",
    );
    const first = node(
      "group",
      { id: "one", title: "The (not so) New Productivity Curve", synopsis: "", status: "draft", role: "body", unit: "chapter" },
      "Opener.\n",
      [inside, nested],
    );
    const second = node(
      "section",
      { id: "two", title: "Junior Partners?", synopsis: "", status: "draft", role: "body", unit: "chapter" },
      "Second.\n",
    );
    const part = node(
      "group",
      { id: "part", title: "You and your Agents.", synopsis: "", status: "draft", role: "body", unit: "part" },
      "Part opener.\n",
      [first, second],
    );
    const note = node(
      "section",
      { id: "note", title: "A Note", synopsis: "", status: "draft", role: "body", unit: "chapter" },
      "Child of front.\n",
    );
    const introduction = node(
      "group",
      { id: "introduction", title: "Introduction", synopsis: "", status: "draft", role: "front", unit: "section" },
      "Intro.\n",
      [note],
    );
    const buried = node(
      "section",
      { id: "buried", title: "Buried", synopsis: "", status: "draft", role: "body", unit: "chapter" },
      "Gone.\n",
    );
    const trash = node(
      "group",
      { id: "trash", title: "Trash", synopsis: "", status: "idea", role: "body" },
      "",
      [buried],
    );
    const exported = exportDocxFiles([
      node("section", { id: "kills", title: "Twenty kills per second.", synopsis: "", status: "draft", role: "front" }, "Kills.\n"),
      node("section", { id: "preface", title: "Preface", synopsis: "", status: "draft", role: "front" }, "Front.\n"),
      introduction,
      node("section", { id: "loose", title: "Loose", synopsis: "", status: "draft", role: "body", unit: "text" }, "Loose text.\n"),
      part,
      trash,
      node("section", { id: "preface-2", title: "Preface", synopsis: "", status: "draft", role: "front" }, "Again.\n"),
      node("section", { id: "blank", title: " ... ", synopsis: "", status: "draft", role: "front" }, ""),
      node("section", { id: "hello", title: "Hello: World/Two", synopsis: "", status: "draft", role: "front" }, ""),
    ]);

    expect(exported.warnings).toEqual([]);
    expect(exported.files.map((file) => file.name)).toEqual([
      "FM-Twenty kills per second.docx",
      "FM-Preface.docx",
      "FM-Introduction.docx",
      "01-The (not so) New Productivity Curve.docx",
      "02-Nested.docx",
      "03-Junior Partners.docx",
      "FM-Preface-2.docx",
      "FM-untitled.docx",
      "FM-Hello WorldTwo.docx",
    ]);
    const chapter = exported.files[3].markdown;
    expect(chapter).toContain('<p class="chapter-number">Chapter 1</p>');
    expect(chapter).toContain("## Inside");
    expect(chapter).toContain("Inside the chapter.");
    expect(chapter).toContain('<p class="chapter-number">Chapter 2</p>');
    expect(chapter).toContain("Nested body.");
    expect(chapter).not.toContain("Second.");
    expect(chapter).not.toContain("Part opener.");
    const nestedFile = exported.files[4].markdown;
    expect(nestedFile).toContain('<p class="chapter-number">Chapter 2</p>');
    expect(nestedFile).toContain("# Nested");
    expect(nestedFile).not.toContain("Opener.");
    expect(exported.files[5].markdown).toContain('<p class="chapter-number">Chapter 3</p>');
    expect(exported.files[5].markdown).toContain("# Junior Partners?");
    const front = exported.files[2].markdown;
    expect(front).toContain("# Introduction {-}\n\nIntro.");
    expect(front).toContain("## A Note {-}\n\nChild of front.");
    expect(front).not.toContain("Chapter");
    expect(exported.files.some((file) => file.markdown.includes("Loose text."))).toBe(false);
    expect(exported.files.some((file) => file.markdown.includes("Gone."))).toBe(false);
    expect(exported.files[0].markdown).toContain("# Twenty kills per second. {-}");
    expect(exported.files[3].markdown.startsWith('<p class="chapter-number">Chapter 1</p>')).toBe(true);
  });

  it("exports one chapter with its sections, its book number, and not a nested chapter", () => {
    const inside = node(
      "section",
      { id: "inside", title: "Inside", synopsis: "", status: "draft", role: "body", unit: "text" },
      "Inside the chapter.\n",
    );
    const scene = node(
      "section",
      { id: "scene", title: "Scene", synopsis: "", status: "draft", role: "body", unit: "section" },
      "On the next page.\n",
    );
    const nested = node(
      "section",
      { id: "nested", title: "Nested", synopsis: "", status: "draft", role: "body", unit: "chapter" },
      "Nested body.\n",
    );
    const first = node(
      "group",
      { id: "one", title: "Hello: World?", synopsis: "", status: "draft", role: "body", unit: "chapter" },
      "Opener.\n",
      [inside, scene, nested],
    );
    const second = node(
      "section",
      { id: "two", title: "Second", synopsis: "", status: "draft", role: "body", unit: "chapter" },
      "Second.\n",
    );
    const part = node(
      "group",
      { id: "part", title: "The Part", synopsis: "", status: "draft", role: "body", unit: "part" },
      "Part opener.\n",
      [first, second],
    );

    const chapter = exportChapter([part], "one");
    expect(chapter?.filename).toBe("01-Hello World.pdf");
    expect(chapter?.title).toBe("Hello: World?");
    expect(chapter?.markdown).toBe(
      [
        '<p class="chapter-number">Chapter 1</p>',
        "# Hello: World?\n\nOpener.",
        "## Inside\n\nInside the chapter.",
        '<div class="page-break"></div>\n\n## Scene\n\nOn the next page.',
      ].join("\n\n"),
    );
    expect(chapter?.markdown).not.toContain("Nested");
    expect(chapter?.markdown).not.toContain("Second");
    expect(chapter?.markdown).not.toContain("Part opener");

    const later = exportChapter([part], "two");
    expect(later?.filename).toBe("03-Second.pdf");
    expect(later?.markdown.startsWith('<p class="chapter-number">Chapter 3</p>')).toBe(true);
    expect(later?.markdown).toContain("# Second\n\nSecond.");
    expect(later?.markdown).not.toContain("Opener");

    expect(exportChapter([part], "part")).toBeNull();
    expect(exportChapter([part], "missing")).toBeNull();
  });

  it("keeps a one-character front heading and a one-character body", () => {
    const heading = node(
      "section",
      { id: "h", title: "H", synopsis: "", status: "draft", role: "front" },
      "# B\n",
    );
    const body = node(
      "section",
      { id: "z", title: "Zed", synopsis: "", status: "draft", role: "body", unit: "text" },
      "Z\n",
    );
    expect(exportBook([heading, body]).markdown).toBe("# H {-}\n\n## B {-}\n\n# Zed\n\nZ");
  });
});
