import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBook } from "./book";
import { exportBook } from "../export/export";
import { nodeFs } from "../nodeFs";
import { renderGroup } from "../ui/preview";
import { splitSpec, writeSpecBook } from "./specbook";

describe("the spec as the book", () => {
  it("keeps every part of the spec, including examples that contain fences", async () => {
    const spec = await readFile("bookwriter-spec.md", "utf8");
    const split = splitSpec(spec);
    expect(split.title).toBe("Bookwriter");
    expect(split.intro).toContain("Living spec.");
    expect(splitSpec("# Book\n\n```\ncode\n```\n").intro).toContain("code");
    const trimmed = splitSpec("# Book\n\nintro\n\n## Sec\n\nbody\n\n");
    expect(trimmed.intro).toBe("intro");
    expect(trimmed.sections).toEqual([{ title: "Sec", body: "body" }]);
    expect(split.sections.map((section) => section.title)).toEqual([
      "The book",
      "On disk",
      "A section file",
      "Outline",
      "Editor",
      "Preview",
      "Markup commands",
      "Reading",
      "Export",
      "Application",
      "Left out",
      "Open questions",
    ]);
    const exportSection = split.sections.find((section) => section.title === "Export");
    expect(exportSection?.body).toContain("## The Rule");
    expect(exportSection?.body).toContain("class Foo");

    const root = await mkdtemp(join(tmpdir(), "spec-book-"));
    const fs = nodeFs();
    await writeSpecBook(fs, root, spec);
    const book = await loadBook(fs, root);
    expect(book.warnings).toEqual([]);
    expect(book.title).toBe("Bookwriter");
    expect(book.nodes.map((node) => node.header.id)).toEqual(["bookwriter", "trash"]);
    expect(book.nodes[0].children).toHaveLength(split.sections.length);

    const exported = exportBook(book.nodes);
    expect(exported.markdown.startsWith("# Bookwriter\n")).toBe(true);
    expect(exported.markdown).toContain("\n## The book\n");
    expect(exported.markdown).toContain("\n## Export\n");
    expect(exported.markdown).toContain("## The Rule");
    expect(exported.markdown).toContain("class Foo");
    expect(exported.markdown).toContain("Living spec.");
    expect(exported.markdown).toContain("Typing in the reading view writes into the section under the caret");
    expect(exported.warnings.filter((warning) => warning.startsWith("Unclosed"))).toEqual([]);

    const reading = renderGroup(book.nodes[0]);
    expect(reading.warnings).toEqual([]);
    expect(reading.html).not.toContain("broken-fence");
    expect(reading.html).not.toContain("missing-fn");
  });
});
