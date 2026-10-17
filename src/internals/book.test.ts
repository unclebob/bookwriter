import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createNode,
  deleteNode,
  emptyTrash,
  loadBook,
  manuscriptNodes,
  moveNode,
  planMove,
  saveBookTitle,
  saveHeldNode,
  saveHeldTitle,
  saveNode,
  type Fs,
} from "./book";
import { FileHolds } from "./holds";
import { exportBook } from "../export/export";
import { filePath, serializeSection, type TreeNode } from "./model";
import { nodeFs } from "../nodeFs";

function tree(): TreeNode[] {
  const section = (id: string): TreeNode => ({
    kind: "section",
    header: { id, title: id, synopsis: "", status: "idea", role: "body" },
    body: "",
    prefix: "010",
    slug: id,
    dir: "",
    entryName: "",
    children: [],
  });
  const group = section("group");
  group.kind = "group";
  group.children = [section("child")];
  return [section("a"), section("b"), group];
}

describe("planMove", () => {
  it("reorders siblings and refuses to drop a group into itself", () => {
    const roots = tree();
    const reordered = planMove(roots, "b", "a", "before");
    expect(reordered).toEqual([{ parentId: null, order: ["b", "a", "group"] }]);

    const into = planMove(roots, "a", "group", "inside");
    expect(into).toEqual([
      { parentId: null, order: ["b", "group"] },
      { parentId: "group", order: ["child", "a"] },
    ]);

    expect(planMove(roots, "group", "child", "after")).toEqual([]);
    expect(planMove(roots, "a", "group", "before")).toEqual([{ parentId: null, order: ["b", "a", "group"] }]);
    expect(planMove(roots, "missing", "a", "before")).toEqual([]);

    const child = roots[2].children[0];
    child.kind = "group";
    child.children = [{ ...child, kind: "section", header: { ...child.header, id: "grand", title: "grand" }, children: [] }];
    expect(planMove(roots, "group", "grand", "after")).toEqual([]);
  });

  it("drops a section into trash and will not move the trash folder", () => {
    const roots = tree();
    roots.push({
      kind: "group",
      header: { id: "trash", title: "Trash", synopsis: "", status: "idea", role: "body" },
      body: "",
      prefix: "",
      slug: "trash",
      dir: "",
      entryName: "trash",
      children: [],
    });
    const into = planMove(roots, "b", "trash", "before");
    expect(into).toEqual([
      { parentId: null, order: ["a", "group"] },
      { parentId: "trash", order: ["b"] },
    ]);
    expect(planMove(roots, "trash", "a", "before")).toEqual([]);
  });
});

describe("manuscript order", () => {
  it("sorts by prefix number, then by name, and skips the trash", () => {
    const section = (id: string): TreeNode => ({
      kind: "section",
      header: { id, title: id, synopsis: "", status: "idea", role: "body" },
      body: "",
      prefix: "010",
      slug: id,
      dir: "",
      entryName: "",
      children: [],
    });
    const trash = section("trash");
    trash.kind = "group";
    expect(manuscriptNodes([section("a"), trash, section("b")]).map((node) => node.header.id)).toEqual(["a", "b"]);
  });

  it("loads numeric prefix order and reports a duplicated prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-"));
    const fs = nodeFs();
    const manuscript = join(root, "manuscript");
    await fs.mkdir(manuscript);
    await fs.writeText(join(root, "book.yaml"), "title: Trial\n");
    const write = (name: string, id: string) =>
      fs.writeText(
        join(manuscript, name),
        `---\nid: ${id}\ntitle: ${id}\nsynopsis: ""\nstatus: idea\nrole: body\n---\n`,
      );
    await write("010-m.md", "m");
    await write("010-c.md", "c");
    await write("20-b.md", "b");
    await write("100-a.md", "a");

    const book = await loadBook(fs, root);
    const nodes = manuscriptNodes(book.nodes);
    expect(nodes.map((node) => node.header.id)).toEqual(["c", "m", "b", "a"]);
    expect(nodes.map((node) => node.prefix)).toEqual(["010", "010", "20", "100"]);
    await fs.writeText(join(manuscript, ".secret.md"), "hidden");
    await fs.mkdir(join(manuscript, "__bw_tmp_half"));
    const again = await loadBook(fs, root);
    expect(manuscriptNodes(again.nodes).map((node) => node.header.id)).toEqual(["c", "m", "b", "a"]);
    expect(book.warnings.some((warning) => warning.includes("Duplicate prefix 010"))).toBe(true);
  });
});

describe("the book folder", () => {
  it("creates, reorders, and saves without renaming when the title changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-"));
    const fs = nodeFs();
    await fs.mkdir(join(root, "manuscript"));
    await fs.writeText(join(root, "book.yaml"), "title: Trial\n");

    let book = await loadBook(fs, root);
    const chapter = await createNode(fs, book, null, "group", "The Rule");
    book = await loadBook(fs, root);
    const inward = await createNode(fs, book, chapter, "section", "Inward");
    const edge = await createNode(fs, book, chapter, "section", "Boundaries");
    book = await loadBook(fs, root);

    const group = book.nodes[0];
    expect(group.kind).toBe("group");
    expect(group.header.id).toBe("the-rule");
    expect(group.header.unit).toBe("section");
    expect(group.children[0].header.unit).toBe("text");
    expect(group.children.map((child) => child.header.id)).toEqual(["inward", "boundaries"]);
    expect(group.children.map((child) => child.entryName)).toEqual(["010-inward.md", "020-boundaries.md"]);

    await moveNode(fs, book, edge, inward, "before");
    book = await loadBook(fs, root);
    expect(book.nodes[0].children.map((child) => child.entryName)).toEqual([
      "010-boundaries.md",
      "020-inward.md",
    ]);
    expect(book.nodes[0].children.map((child) => child.header.id)).toEqual(["boundaries", "inward"]);

    const moved = book.nodes[0].children[1];
    const originalPath = filePath(moved);
    await saveNode(
      fs,
      moved,
      { ...moved.header, title: "Points Inward", status: "revise" },
      "A dependency points inward.\n",
    );
    const saved = await readFile(originalPath, "utf8");
    expect(saved).toContain("id: inward\n");
    expect(saved).toContain("title: Points Inward\n");
    expect(saved).toContain("status: revise\n");
    expect(saved.endsWith("---\nA dependency points inward.\n")).toBe(true);
    expect(originalPath.endsWith("020-inward.md")).toBe(true);

    await deleteNode(fs, book, "boundaries");
    book = await loadBook(fs, root);
    expect(book.nodes[0].children.map((child) => child.header.id)).toEqual(["inward"]);
    const trashed = book.nodes.find((node) => node.header.id === "trash");
    expect(trashed?.children.map((child) => child.header.id)).toEqual(["boundaries"]);
    expect(exportBook(book.nodes).markdown).not.toContain("Boundaries");

    const below = await createNode(fs, book, chapter, "section", "After Inward");
    book = await loadBook(fs, root);
    await moveNode(fs, book, below, "inward", "after");
    book = await loadBook(fs, root);
    expect(book.nodes[0].children.map((child) => child.header.id)).toEqual(["inward", "after-inward"]);

    const opening = await createNode(fs, book, chapter, "section", "Opening");
    book = await loadBook(fs, root);
    const first = book.nodes[0].children[0];
    await moveNode(fs, book, opening, first.header.id, "before");
    book = await loadBook(fs, root);
    expect(book.nodes[0].children.map((child) => child.header.id)).toEqual(["opening", "inward", "after-inward"]);
  });

  it("moves a folder into a later folder and keeps what is inside", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-"));
    const fs = nodeFs();
    await fs.mkdir(join(root, "manuscript"));
    await fs.writeText(join(root, "book.yaml"), "title: Trial\n");

    let book = await loadBook(fs, root);
    const earlier = await createNode(fs, book, null, "group", "Earlier");
    book = await loadBook(fs, root);
    const later = await createNode(fs, book, null, "group", "Later");
    book = await loadBook(fs, root);
    await createNode(fs, book, earlier, "section", "Inside");
    book = await loadBook(fs, root);

    await moveNode(fs, book, earlier, later, "inside");
    book = await loadBook(fs, root);

    const roots = book.nodes.filter((node) => node.header.id !== "trash");
    expect(roots.map((node) => node.header.id)).toEqual(["later"]);
    expect(roots[0].children.map((child) => child.header.id)).toEqual(["earlier"]);
    expect(roots[0].children[0].children.map((child) => child.header.id)).toEqual(["inside"]);
  });

  it("moves a folder into a group that sits inside a later sibling", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-"));
    const fs = nodeFs();
    await fs.mkdir(join(root, "manuscript"));
    await fs.writeText(join(root, "book.yaml"), "title: Trial\n");

    let book = await loadBook(fs, root);
    const first = await createNode(fs, book, null, "group", "A");
    book = await loadBook(fs, root);
    const second = await createNode(fs, book, null, "group", "B");
    book = await loadBook(fs, root);
    const nested = await createNode(fs, book, second, "group", "C");
    book = await loadBook(fs, root);
    await createNode(fs, book, first, "section", "Inside");
    book = await loadBook(fs, root);

    await moveNode(fs, book, first, nested, "inside");
    book = await loadBook(fs, root);

    const roots = book.nodes.filter((node) => node.header.id !== "trash");
    expect(roots.map((node) => node.header.id)).toEqual(["b"]);
    expect(roots[0].children.map((child) => child.header.id)).toEqual(["c"]);
    expect(roots[0].children[0].children.map((child) => child.header.id)).toEqual(["a"]);
    expect(roots[0].children[0].children[0].children.map((child) => child.header.id)).toEqual(["inside"]);
    const names = (await fs.readDir(join(root, "manuscript"))).map((entry) => entry.name);
    expect(names.filter((name) => name.endsWith("-b"))).toEqual(["010-b"]);
  });

  it("moves a nested folder out to the front of the book", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-"));
    const fs = nodeFs();
    await fs.mkdir(join(root, "manuscript"));
    await fs.writeText(join(root, "book.yaml"), "title: Trial\n");

    let book = await loadBook(fs, root);
    const parent = await createNode(fs, book, null, "group", "Parent");
    book = await loadBook(fs, root);
    const nested = await createNode(fs, book, parent, "group", "Nested");
    book = await loadBook(fs, root);
    await createNode(fs, book, nested, "section", "Inside");
    book = await loadBook(fs, root);

    await moveNode(fs, book, nested, parent, "before");
    book = await loadBook(fs, root);

    const roots = book.nodes.filter((node) => node.header.id !== "trash");
    expect(roots.map((node) => node.header.id)).toEqual(["nested", "parent"]);
    expect(roots[0].children.map((child) => child.header.id)).toEqual(["inside"]);
    expect(roots[1].children).toEqual([]);
  });

  it("empties the trash and leaves the rest of the manuscript", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-"));
    const fs = nodeFs();
    await fs.mkdir(join(root, "manuscript"));
    await fs.writeText(join(root, "book.yaml"), "title: Trial\n");

    let book = await loadBook(fs, root);
    const chapter = await createNode(fs, book, null, "group", "The Rule");
    book = await loadBook(fs, root);
    await createNode(fs, book, chapter, "section", "Inward");
    const gone = await createNode(fs, book, chapter, "section", "Boundaries");
    const folder = await createNode(fs, book, chapter, "group", "Nested");
    book = await loadBook(fs, root);
    const buried = await createNode(fs, book, folder, "section", "Buried");
    book = await loadBook(fs, root);

    await deleteNode(fs, book, gone);
    book = await loadBook(fs, root);
    await deleteNode(fs, book, folder);
    book = await loadBook(fs, root);
    await fs.writeText(join(root, "manuscript", "trash", "notes.txt"), "stray");

    const trashed = book.nodes.find((node) => node.header.id === "trash");
    const removed = trashed?.children.map((child) => join(child.dir, child.entryName)) ?? [];
    const buriedPath = filePath(trashed!.children.flatMap((child) => child.children).find((child) => child.header.id === buried)!);
    expect(trashed?.children.map((child) => child.header.id).sort()).toEqual(["boundaries", "nested"]);

    await emptyTrash(fs, book);
    book = await loadBook(fs, root);
    expect(book.nodes.find((node) => node.header.id === "trash")?.children).toEqual([]);
    expect(book.nodes[0].children.map((child) => child.header.id)).toEqual(["inward"]);
    await expect(fs.readText(join(root, "manuscript", "trash", "notes.txt"))).rejects.toThrow();
    await expect(access(buriedPath)).rejects.toThrow();
    for (const path of removed) await expect(access(path)).rejects.toThrow();
    expect(await fs.readText(join(root, "manuscript", "trash", "_index.md"))).toContain("id: trash");

    await emptyTrash(fs, book);
    book = await loadBook(fs, root);
    expect(book.nodes.find((node) => node.header.id === "trash")?.children).toEqual([]);
  });

  it("renumbers the sections that stay when the first one is deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-"));
    const fs = nodeFs();
    await fs.mkdir(join(root, "manuscript"));
    await fs.writeText(join(root, "book.yaml"), "title: Trial\n");

    let book = await loadBook(fs, root);
    const chapter = await createNode(fs, book, null, "group", "The Rule");
    book = await loadBook(fs, root);
    const first = await createNode(fs, book, chapter, "section", "Alpha");
    await createNode(fs, book, chapter, "section", "Beta");
    await createNode(fs, book, chapter, "section", "Gamma");
    book = await loadBook(fs, root);

    await deleteNode(fs, book, first);
    book = await loadBook(fs, root);
    expect(book.nodes[0].children.map((child) => child.entryName)).toEqual(["010-beta.md", "020-gamma.md"]);

    const trashed = book.nodes.find((node) => node.header.id === "trash");
    await deleteNode(fs, book, "missing");
    await deleteNode(fs, book, "trash");
    await deleteNode(fs, book, trashed?.children[0].header.id ?? "");
    book = await loadBook(fs, root);

    expect(book.nodes[0].children.map((child) => child.entryName)).toEqual(["010-beta.md", "020-gamma.md"]);
    expect(book.nodes.find((node) => node.header.id === "trash")?.children.map((child) => child.header.id)).toEqual([
      "alpha",
    ]);
  });

  it("leaves two trashed texts in order when the first is deleted again", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-"));
    const fs = nodeFs();
    await fs.mkdir(join(root, "manuscript"));
    await fs.writeText(join(root, "book.yaml"), "title: Trial\n");

    let book = await loadBook(fs, root);
    const chapter = await createNode(fs, book, null, "group", "The Rule");
    book = await loadBook(fs, root);
    const alpha = await createNode(fs, book, chapter, "section", "Alpha");
    const beta = await createNode(fs, book, chapter, "section", "Beta");
    book = await loadBook(fs, root);

    await deleteNode(fs, book, alpha);
    book = await loadBook(fs, root);
    await deleteNode(fs, book, beta);
    book = await loadBook(fs, root);
    await deleteNode(fs, book, alpha);
    book = await loadBook(fs, root);

    expect(book.nodes.find((node) => node.header.id === "trash")?.children.map((child) => child.header.id)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("leaves a companion section in place when the buffer is dirty", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-"));
    const fs = nodeFs();
    await fs.mkdir(join(root, "manuscript"));
    await fs.writeText(join(root, "book.yaml"), "title: Trial\n");
    let book = await loadBook(fs, root);
    await createNode(fs, book, null, "section", "Inward");
    book = await loadBook(fs, root);
    const section = book.nodes[0];
    const path = filePath(section);
    const holds = new FileHolds();
    holds.replaceAll(new Map([[section.header.id, { path, bytes: await fs.readText(path) }]]));
    holds.markEditing(section.header.id);
    const remote = await fs.readText(path);
    const companion = remote.replace("---\n", "---\n") + "Remote.\n";
    await fs.writeText(path, remote.endsWith("\n") ? `${remote}Remote.\n` : companion);
    const result = await saveHeldNode(fs, holds, section, section.header, "Mine.\n");
    expect(result).toBe("hold");
    expect(await fs.readText(path)).toContain("Remote.");
    expect(await fs.readText(path)).not.toContain("Mine.");

    holds.acceptDisk(section.header.id, path, await fs.readText(path));
    expect(await saveHeldNode(fs, holds, section, section.header, "Mine.\n")).toBe("saved");
    expect(await fs.readText(path)).toContain("Mine.");
    expect(await fs.readText(path)).not.toContain("Remote.");
  });

  it("does not install a snapshot after the buffer changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-"));
    const fs = nodeFs();
    await fs.mkdir(join(root, "manuscript"));
    await fs.writeText(join(root, "book.yaml"), "title: Trial\n");
    let book = await loadBook(fs, root);
    await createNode(fs, book, null, "section", "Inward");
    book = await loadBook(fs, root);
    const section = book.nodes[0];
    const path = filePath(section);
    const holds = new FileHolds();
    holds.replaceAll(new Map([[section.header.id, { path, bytes: await fs.readText(path) }]]));
    holds.markEditing(section.header.id);
    const before = await fs.readText(path);
    const result = await saveHeldNode(fs, holds, section, section.header, "Mine.\n", () =>
      serializeSection(section.header, "Mine!\n"),
    );
    expect(result).toBe("hold");
    expect(await fs.readText(path)).toBe(before);
  });

  it("reports a write, and a save whose bytes are already on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-"));
    const fs = nodeFs();
    await fs.mkdir(join(root, "manuscript"));
    await fs.writeText(join(root, "book.yaml"), "title: Trial\n");
    let book = await loadBook(fs, root);
    await createNode(fs, book, null, "section", "Inward");
    book = await loadBook(fs, root);
    const section = book.nodes[0];
    const path = filePath(section);
    const holds = new FileHolds();
    holds.replaceAll(new Map([[section.header.id, { path, bytes: await fs.readText(path) }]]));

    const wrote = await saveHeldNode(fs, holds, section, section.header, "Mine.\n");
    expect(wrote).toBe("saved");
    expect(await fs.readText(path)).toContain("Mine.\n");

    const again = await saveHeldNode(fs, holds, section, section.header, "Mine.\n");
    expect(again).toBe("same");
  });

  it("saves a book title, reports same, and leaves a companion title on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-"));
    const fs = nodeFs();
    await fs.mkdir(join(root, "manuscript"));
    await fs.writeText(join(root, "book.yaml"), "title: Trial\n");
    const book = await loadBook(fs, root);
    const path = join(root, "book.yaml");
    const holds = new FileHolds();
    holds.replaceAll(new Map([["book.yaml", { path, bytes: await fs.readText(path) }]]));
    holds.markEditing("book.yaml");

    expect(await saveHeldTitle(fs, holds, book, "Renamed")).toBe("saved");
    expect(book.title).toBe("Renamed");
    expect((await loadBook(fs, root)).title).toBe("Renamed");

    expect(await saveHeldTitle(fs, holds, book, "Renamed")).toBe("same");

    holds.markEditing("book.yaml");
    await fs.writeText(path, "title: Theirs\n");
    expect(await saveHeldTitle(fs, holds, book, "Mine")).toBe("hold");
    expect((await loadBook(fs, root)).title).toBe("Theirs");
    holds.acceptDisk("book.yaml", path, await fs.readText(path));
    expect(await saveHeldTitle(fs, holds, book, "Mine")).toBe("saved");
    expect((await loadBook(fs, root)).title).toBe("Mine");
  });

  it("writes the book title it just read, and refuses when that file changes first", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-"));
    const fs = nodeFs();
    await fs.mkdir(join(root, "manuscript"));
    await fs.writeText(join(root, "book.yaml"), "title: Trial\n");
    const book = await loadBook(fs, root);
    const path = join(root, "book.yaml");

    await saveBookTitle(fs, book, "From Disk");
    expect(book.title).toBe("From Disk");
    expect((await loadBook(fs, root)).title).toBe("From Disk");

    const racing = titleOnSecondRead(fs, path, "title: Theirs\n");
    await expect(saveBookTitle(racing, book, "Too Late")).rejects.toThrow(/Could not save/);
    expect((await loadBook(fs, root)).title).toBe("From Disk");
  });

  it("keeps the open title and the open section after a companion write", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-"));
    const fs = nodeFs();
    await fs.mkdir(join(root, "manuscript"));
    await fs.writeText(join(root, "book.yaml"), "title: Trial\n");
    let book = await loadBook(fs, root);
    await createNode(fs, book, null, "section", "Inward");
    book = await loadBook(fs, root);
    const section = book.nodes[0];
    const path = filePath(section);
    const titlePath = join(root, "book.yaml");
    const holds = new FileHolds();
    holds.replaceAll(
      new Map([
        [section.header.id, { path, bytes: await fs.readText(path) }],
        ["book.yaml", { path: titlePath, bytes: await fs.readText(titlePath) }],
      ]),
    );

    holds.markEditing(section.header.id);
    await fs.writeText(path, `${await fs.readText(path)}Remote.\n`);
    const header = { ...section.header, title: "Kept" };
    expect(await saveHeldNode(fs, holds, section, header, "Mine.\n")).toBe("hold");
    holds.acceptDisk(section.header.id, path, await fs.readText(path));
    expect(await saveHeldNode(fs, holds, section, header, "Mine.\n")).toBe("saved");
    expect(section.header.title).toBe("Kept");
    expect(section.body).toBe("Mine.\n");
    const kept = await fs.readText(path);
    expect(kept).toContain("title: Kept\n");
    expect(kept).toContain("Mine.\n");
    expect(kept).not.toContain("Remote.");

    holds.markEditing("book.yaml");
    await fs.writeText(titlePath, "title: Theirs\n");
    expect(await saveHeldTitle(fs, holds, book, "Mine")).toBe("hold");
    holds.acceptDisk("book.yaml", titlePath, await fs.readText(titlePath));
    expect(await saveHeldTitle(fs, holds, book, "Mine")).toBe("saved");
    expect(book.title).toBe("Mine");
    expect((await loadBook(fs, root)).title).toBe("Mine");
  });

  it("holds a save while the companion is busy", async () => {
    const root = await mkdtemp(join(tmpdir(), "bookwriter-"));
    const fs = nodeFs();
    await fs.mkdir(join(root, "manuscript"));
    await fs.writeText(join(root, "book.yaml"), "title: Trial\n");
    const book = await loadBook(fs, root);
    const path = join(root, "book.yaml");
    const holds = new FileHolds();
    holds.replaceAll(new Map([["book.yaml", { path, bytes: await fs.readText(path) }]]));
    holds.markEditing("book.yaml");
    expect(await saveHeldTitle(fs, holds, book, "Mine", undefined, true)).toBe("hold");
    expect((await loadBook(fs, root)).title).toBe("Trial");
  });
});

function titleOnSecondRead(inner: Fs, path: string, next: string): Fs {
  let reads = 0;
  return {
    ...inner,
    readText(target) {
      if (target !== path) return inner.readText(target);
      reads += 1;
      if (reads === 2) return Promise.resolve(next);
      return inner.readText(target);
    },
  };
}
