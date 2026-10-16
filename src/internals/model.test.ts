import { describe, expect, it } from "vitest";
import {
  assignPrefixes,
  clampHeadingLevel,
  codeSpanRanges,
  divisions,
  filePath,
  effectiveUnit,
  insideSpan,
  nextPrefix,
  parseScalar,
  parseSection,
  serializeSection,
  slugify,
  startsNewPage,
  stepFence,
  uniqueId,
  wordCount,
  type TreeNode,
} from "./model";

const inwardFile = `---
id: inward
title: Inward
synopsis: Source dependencies point inward, toward policy.
status: draft
role: body
unit: text
---
A dependency points inward.[^1]

# Where the rule stops

\`\`\`java
class Foo {
    void bar() {}
}
\`\`\`

[^1]: Toward higher-level policy.
`;

describe("section files", () => {
  it("keeps the body bytes and writes the header in a fixed order", () => {
    const parsed = parseSection(inwardFile);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.header).toEqual({
      id: "inward",
      title: "Inward",
      synopsis: "Source dependencies point inward, toward policy.",
      status: "draft",
      role: "body",
      unit: "text",
    });
    expect(parsed.body.startsWith("A dependency points inward.[^1]\n")).toBe(true);
    expect(parsed.body).toContain("class Foo");
    const written = serializeSection(parsed.header, parsed.body);
    expect(parseSection(written).body).toBe(parsed.body);
    expect(written.startsWith("---\nid: inward\ntitle: Inward\n")).toBe(true);
  });

  it("turns carriage returns into line feeds and quotes scalars that need it", () => {
    const parsed = parseSection("---\r\nid: a\r\ntitle: A: B\r\nsynopsis: \"\"\r\nstatus: no\r\nrole: front\r\n---\r\nLine\r\n");
    expect(parsed.header.title).toBe("A: B");
    expect(parsed.body).toBe("Line\n");
    expect(parsed.warnings.some((warning) => warning.includes("Status"))).toBe(true);
    const saved = serializeSection(
      { id: "a", title: "A: B", synopsis: "", status: "idea", role: "front" },
      "Line\n",
    );
    expect(saved).toContain('title: "A: B"');
    expect(saved).toContain('synopsis: ""');
    expect(saved.endsWith("---\nLine\n")).toBe(true);
  });

  it("reads quoted scalars, a bad role, and a file with no header", () => {
    expect(parseScalar('"say \\"hi\\"\\n"')).toBe('say "hi"\n');
    expect(parseScalar('"a\\')).toBe("a");
    expect(parseScalar("'it''s'")).toBe("it's");
    expect(parseScalar('"unterminated')).toBe("unterminated");
    expect(parseScalar("hello'")).toBe("hello'");
    expect(parseScalar("''")).toBe("");
    expect(parseScalar("'")).toBe("'");
    expect(parseScalar("'open")).toBe("'open");
    const blank = parseSection('---\nid: a\ntitle: A\nsynopsis: ""\nstatus:\nrole:\n---\n');
    expect(blank.header.status).toBe("idea");
    expect(blank.header.role).toBe("body");
    expect(blank.warnings.some((warning) => warning.includes('Status ""'))).toBe(true);
    expect(blank.warnings.some((warning) => warning.includes('Role ""'))).toBe(true);
    const quoted = parseSection("---\nid: a\ntitle: T\nsynopsis: s\nstatus: idea\nrole: side\nnot a field\n---\nBody\n");
    expect(quoted.header.role).toBe("body");
    expect(quoted.warnings.some((warning) => warning.includes("Role"))).toBe(true);
    expect(quoted.warnings.some((warning) => warning.includes("Ignored"))).toBe(true);
    const bare = parseSection("No header\n");
    expect(bare.header.title).toBe("Untitled");
    expect(bare.body).toBe("No header\n");
    expect(bare.warnings.some((warning) => warning.includes("Missing header"))).toBe(true);
    const thin = parseSection("---\ntitle: T\n---\n");
    expect(thin.warnings.some((warning) => warning.includes("missing id"))).toBe(true);
  });

  it("reads and writes the unit, and keeps a legacy page break until a unit is set", () => {
    const chapter = parseSection("---\nid: a\ntitle: A\nsynopsis: \"\"\nstatus: idea\nrole: body\nunit: chapter\n---\n");
    expect(chapter.warnings).toEqual([]);
    expect(chapter.header.unit).toBe("chapter");
    expect(serializeSection(chapter.header, "")).toContain("role: body\nunit: chapter\n---\n");

    const missing = parseSection("---\nid: a\ntitle: A\nsynopsis: \"\"\nstatus: idea\nrole: body\n---\n");
    expect(missing.warnings).toEqual([]);
    expect(missing.header.unit).toBeUndefined();
    expect(serializeSection(missing.header, "")).not.toContain("unit:");

    const bad = parseSection("---\nid: a\ntitle: A\nsynopsis: \"\"\nstatus: idea\nrole: body\nunit: maybe\n---\n");
    expect(bad.warnings.some((warning) => warning.includes("Unit"))).toBe(true);
    expect(bad.header.unit).toBeUndefined();

    const on = parseSection("---\nid: a\ntitle: A\nsynopsis: \"\"\nstatus: idea\nrole: body\nbreak: true\n---\n");
    expect(on.warnings).toEqual([]);
    expect(on.header.break).toBe(true);
    expect(on.header.unit).toBeUndefined();
    expect(serializeSection(on.header, "")).toContain("role: body\nbreak: true\n---\n");
    expect(effectiveUnit({ kind: "section", header: on.header })).toBe("section");

    const off = parseSection("---\nid: a\ntitle: A\nsynopsis: \"\"\nstatus: idea\nrole: body\nbreak: false\n---\n");
    expect(off.header.break).toBe(false);
    expect(serializeSection(off.header, "")).toContain("break: false\n");
    expect(effectiveUnit({ kind: "group", header: off.header })).toBe("text");

    const both = parseSection("---\nid: a\ntitle: A\nsynopsis: \"\"\nstatus: idea\nrole: body\nunit: text\nbreak: true\n---\n");
    expect(effectiveUnit({ kind: "group", header: both.header })).toBe("text");
    expect(serializeSection(both.header, "")).toContain("unit: text\n");
    expect(serializeSection(both.header, "")).not.toContain("break:");

    const badBreak = parseSection("---\nid: a\ntitle: A\nsynopsis: \"\"\nstatus: idea\nrole: body\nbreak: maybe\n---\n");
    expect(badBreak.warnings.some((warning) => warning.includes("Page break"))).toBe(true);
    expect(badBreak.header.break).toBeUndefined();
  });
});

describe("identity and order", () => {
  it("builds a slug and keeps ids unique", () => {
    expect(slugify("The Dependency Rule")).toBe("the-dependency-rule");
    expect(slugify("Don't Stop")).toBe("dont-stop");
    const used = new Set(["inward"]);
    expect(uniqueId("Inward", used)).toBe("inward-2");
    used.add("inward-2");
    expect(uniqueId("Inward", used)).toBe("inward-3");
  });

  it("numbers siblings by tens, widening past 990", () => {
    expect(assignPrefixes(0)).toEqual([]);
    expect(assignPrefixes(3)).toEqual(["010", "020", "030"]);
    expect(assignPrefixes(99)[98]).toBe("990");
    expect(assignPrefixes(100)[0]).toBe("0010");
    expect(assignPrefixes(100)[99]).toBe("1000");
    expect(nextPrefix(["010", "020"])).toBe("030");
    expect(nextPrefix([])).toBe("010");
    expect(nextPrefix(["010-"])).toBe("010");
    const section = treeNode("section", "inward");
    section.dir = "manuscript/010-rule";
    section.entryName = "020-inward.md";
    expect(filePath(section)).toBe("manuscript/010-rule/020-inward.md");
  });
});

function treeNode(
  kind: TreeNode["kind"],
  id: string,
  role: TreeNode["header"]["role"] = "body",
  children: TreeNode[] = [],
): TreeNode {
  return {
    kind,
    header: { id, title: id, synopsis: "", status: "idea", role },
    body: "",
    prefix: "010",
    slug: id,
    dir: "",
    entryName: "",
    children,
  };
}

describe("parts and chapters", () => {
  it("numbers parts and chapters in tree order and skips front matter and trash", () => {
    const scene = treeNode("section", "scene");
    scene.header = { ...scene.header, unit: "chapter" };
    const naming = treeNode("group", "naming", "body", [scene]);
    naming.header = { ...naming.header, unit: "part" };
    const preface = treeNode("group", "preface", "front");
    preface.header = { ...preface.header, unit: "chapter" };
    const buried = treeNode("section", "buried");
    buried.header = { ...buried.header, unit: "chapter" };
    const trash = treeNode("group", "trash", "body", [buried]);
    const practice = treeNode("section", "practice");
    practice.header = { ...practice.header, unit: "chapter" };
    const loose = treeNode("section", "loose");
    const numbers = divisions([preface, loose, naming, trash, practice]);
    expect(numbers.get("naming")).toEqual({ unit: "part", number: 1 });
    expect(numbers.get("scene")).toEqual({ unit: "chapter", number: 1 });
    expect(numbers.get("practice")).toEqual({ unit: "chapter", number: 2 });
    expect(numbers.has("preface")).toBe(false);
    expect(numbers.has("loose")).toBe(false);
    expect(numbers.has("trash")).toBe(false);
    expect(numbers.has("buried")).toBe(false);
  });

  it("pages a part, a chapter, and a section, and leaves text where it falls", () => {
    const folder = treeNode("group", "naming");
    const loose = treeNode("section", "loose");
    expect(effectiveUnit(folder)).toBe("section");
    expect(effectiveUnit(loose)).toBe("text");
    expect(startsNewPage(folder)).toBe(true);
    expect(startsNewPage(loose)).toBe(false);
    expect(startsNewPage({ ...loose, header: { ...loose.header, unit: "chapter" } })).toBe(true);
    expect(startsNewPage({ ...folder, header: { ...folder.header, unit: "text" } })).toBe(false);
    expect(startsNewPage({ ...loose, header: { ...loose.header, break: true } })).toBe(true);
    expect(startsNewPage({ ...folder, header: { ...folder.header, break: false } })).toBe(false);
  });
});

describe("word count", () => {
  it("counts whitespace-separated words in the body", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("  A dependency points inward.[^1]\n")).toBe(4);
  });
});

describe("markup edges", () => {
  it("clamps a heading into levels 1 through 6 and says when it moved", () => {
    expect(clampHeadingLevel(0)).toEqual({ level: 1, clamped: true });
    expect(clampHeadingLevel(1)).toEqual({ level: 1, clamped: false });
    expect(clampHeadingLevel(6)).toEqual({ level: 6, clamped: false });
    expect(clampHeadingLevel(7)).toEqual({ level: 6, clamped: true });
  });

  it("opens and closes a backtick fence, and a tilde line leaves it open", () => {
    const open = stepFence("```", null);
    expect(open).toEqual({ fence: { char: "`", len: 3 }, fenced: true });
    expect(stepFence("~~~", open.fence)).toEqual({ fence: { char: "`", len: 3 }, fenced: true });
    expect(stepFence("```", open.fence)).toEqual({ fence: null, fenced: true });
  });

  it("finds closed code spans, including the opening backtick and not the end", () => {
    expect(codeSpanRanges("``a``")).toEqual([[0, 5]]);
    expect(codeSpanRanges("`a` `b`")).toEqual([[0, 3], [4, 7]]);
    expect(codeSpanRanges("a`b`")).toEqual([[1, 4]]);
    expect(codeSpanRanges("`a")).toEqual([]);
    expect(insideSpan(0, [[0, 3]])).toBe(true);
    expect(insideSpan(2, [[0, 3]])).toBe(true);
    expect(insideSpan(3, [[0, 3]])).toBe(false);
    expect(insideSpan(0, [[2, 5]])).toBe(false);
  });
});
