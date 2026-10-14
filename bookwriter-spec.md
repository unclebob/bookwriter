# Bookwriter

Living spec. This is a draft. Expect it to change.

Bookwriter is a small writing application for one long book. A book is an ordered tree of short documents. You write each document on its own, rearrange the tree by dragging, and export one manuscript.

## The book

There are two kinds of node.

- A **group** holds other nodes, and it may hold prose of its own.
- A **section** is a leaf. It holds prose.

A short book can be a flat list of sections. A long book can nest as deep as it needs.

A **unit** says how that node opens in the manuscript. The choice is the same for a group and for a section file.

- A **part** is numbered. The manuscript writes `Part N`, centered and bold, and then the title.
- A **chapter** is numbered. The manuscript writes `Chapter N`, centered and bold, and then the title.
- A **section** is not numbered. The manuscript writes the title and no line above it. This unit is not the leaf node of the same name.
- **Text** is not numbered. It stays on the current page.

A part, a chapter, and a section start on a new page. The node that opens the manuscript is the first page, so that break is not written in front of it.

Parts and chapters are numbered separately, in tree order, through the whole manuscript. A chapter inside a part takes the next chapter number. The numbers are computed, never stored. Front matter and the trash take no number.

A new group starts as a section. A new section file starts as text.

A **subsection** is not a node. It is a Markdown heading inside a section file.

**Front matter** (copyright, dedication, preface) is ordinary nodes with role `front`. The tree controls where they sit. The role keeps export from numbering them.

Each node has:

| Field | Meaning |
|---|---|
| `id` | Stable identity. Assigned when the node is created. Never changed by a rename or a reorder. Unique within the book. |
| `title` | The heading export will emit for this node. |
| `synopsis` | Short summary shown under the title in the outline. May be empty. |
| `status` | One of `idea`, `draft`, `revise`, `done`. A new node starts as `idea`. |
| `role` | One of `front` or `body`. A new node starts as `body`. |
| `unit` | One of `part`, `chapter`, `section`, `text`. A part, a chapter, and a section start on a new page. Text does not. A new group starts as `section`. A new section file starts as `text`. A file that omits `unit` and says `break: false` is text. A file that omits `unit` and says `break: true` is a section. A file that omits both is a section when it is a group and text when it is a section file. Saving the form writes `unit` and leaves `break` out. |

A node is front matter when its own role is `front`, or when any group above it is `front`. Set the role on the front-matter group and the children follow.

Word count is computed, never stored. A section's count is the number of whitespace-separated words in its body. A group's count is the words in its own body plus the counts of its children.

## On disk

The book is a folder of Pandoc Markdown files. The folder is the only stored form of the book. There is no database and no separate binder file.

```text
my-book/
  book.yaml
  images/
    bridge.jpg
  manuscript/
    010-front-matter/
      _index.md
      010-preface.md
    020-naming/
      _index.md
      010-the-rule/
        _index.md
        010-inward.md
        020-boundaries.md
```

`book.yaml` holds facts about the whole book. Today that is the title.

```yaml
title: The Book Title
```

Under `manuscript/`:

- A directory is a group.
- `_index.md` inside a directory is that group's own document. Every group has one. The body may be empty.
- Any other `.md` file is a section.
- `_index.md` is reserved. A section cannot use that name.

Order among siblings is a numeric prefix: `010`, `020`, `030`, step 10, at least three digits. The slug after the prefix is a readable name taken from the title when the node is created. Changing the title does not rename the file. Reordering rewrites the prefixes of the siblings in that directory and leaves every other directory alone. The `id` does not change.

The slug is lowercase words separated by hyphens, with punctuation removed. The `id` is that same slug. If the id is already used in the book, the application appends `-2`, `-3`, and so on.

If a directory would need a prefix past `990`, the prefixes in that directory gain another digit (`0100`, `0200`, …).

Files are UTF-8 with LF line endings.

Pictures live in `images/`, beside `manuscript/`. A picture path in a text is relative to the book folder. `images/bridge.jpg` is that file.

## A section file

The application owns the header. The writer owns the body. The header is rewritten in a fixed field order on every save. The body is written back as the editor holds it. The application does not parse the body and serialize it again, and it does not reflow it.

````markdown
---
id: inward
title: Inward
synopsis: Source dependencies point inward, toward policy.
status: draft
role: body
unit: text
---
A dependency points inward.[^1]

# Where the rule stops

```java
class Foo {
    void bar() {}
}
```

[^1]: Toward higher-level policy.
````

The header is the first thing in the file. One newline separates the closing `---` from the body. An empty body ends the file after that newline.

The body is Pandoc Markdown.

- The title lives in the header. The body does not repeat it.
- A heading in the body is a subsection or deeper. Write `#` for a subsection. Write `##` for the level under that. Export shifts these headings by the node's depth.
- A code snippet is a fenced block with a language tag, with a blank line before and after the fence.
- A footnote is Pandoc syntax. `[^1]` refers to a definition `[^1]: …` in the same file. An inline note `^[Toward higher-level policy.]` is also allowed. Labels in the file are local to that file. Two sections may both use `[^1]`.

A group's `_index.md` uses the same header and the same body rules.

## Outline

The outline is the home screen. The book is the top row, and it is selected when a book opens. Choosing it shows the manuscript straight through, in tree order, with the trash left out. The rows beneath it are the tree. Each of those rows shows the title, the status, the word count, and the synopsis. A part or a chapter also shows `Part N` or `Chapter N` on its row. The book row shows the book title and the word count. The form under the tree edits the selected row: title, synopsis, status, role, and unit. The unit is four choices: part, chapter, section, or text. The book row has no form. Its title is the field at the top of the window.

Dragging a row changes the order. Dropping a row onto a group makes it a child of that group. Both operations are prefix rewrites, as described above.

Right-clicking the trash row offers Empty trash. That deletes the pieces in the trash. The trash folder remains.

There is no corkboard and no index-card view.

## Editor

Selecting a section opens its body in the editor. The header is edited from the outline, not from inside the body.

The editor shows Markdown source. The characters in the editor are the characters in the file. A subsection is a line that starts with `#`. A code snippet is a fenced block. A footnote is `[^1]` or an inline `^[…]`. Saving writes that buffer to the body and leaves every other byte of the body as the writer left it.

The marks stay visible. Highlighting shows a heading line as a heading and a fenced block as code, with the `#` and the backticks still on screen.

Find searches the open text. The find panel has a whole book checkbox beside match case, regexp, and by word. With that checked, Find Next and Find Previous continue through the other texts in tree order and open the text that holds the match. The trash is left out. The search wraps around the manuscript. Replace keeps working in the open text. A successful Find Next or Find Previous scrolls the preview to the match.

## Preview

The open section has a rendered preview beside the Markdown. It can be shown or hidden.

The preview is drawn from the editor buffer as the buffer changes, including text that has not been saved. It shows that section as export will show it. The title is a heading at the section's depth. Body headings are shifted by that same depth. A front-matter section shows its headings unnumbered. Code is highlighted. Footnotes are shown as notes, numbered in the order they appear in the section. Clicking a footnote marker scrolls the preview to that note, and the return mark on the note scrolls back to the marker. When the Markdown is displayed, the cursor moves to that same place. A picture path names a file in the book folder, and the preview shows that file. A broken fence or a footnote reference with no definition is visible in the preview.

Typing stays in the Markdown editor. The preview is a view of the buffer. Clicking in the Markdown scrolls the preview to that place. A successful find scrolls the preview to the match.

## Markup commands

A command inserts the characters for one construct. The writer recalls the name. The command recalls the syntax. The command writes into the buffer at the cursor and does not rebuild the section. Existing text is left as it stands, including existing footnote numbers.

The menu and the command palette list these twelve commands. The palette finds a command by its name, so "foot" reaches Footnote and "pic" reaches Picture.

| Command | What it inserts |
|---|---|
| Emphasis | `*…*` around the selection |
| Strong | `**…**` around the selection |
| Inline code | `` `…` `` around the selection |
| Link | `[selection](url)` |
| Picture | `![selection](images/file){width=100%}`, and moves that file into the book |
| Subsection | `# ` at the start of the current line |
| Lower subsection | `## ` at the start of the current line |
| Bullet list | `- ` at the start of the current line |
| Numbered list | `1. ` at the start of the current line |
| Quotation | `> ` at the start of the current line |
| Code block | A fenced block around the selection, with a blank line before and after |
| Footnote | `[^n]` at the cursor, and a matching definition at the end of the section |

With a selection, Emphasis, Strong, Inline code, and Link wrap it and leave the cursor after the closing mark. With nothing selected, they insert the marks and leave the cursor between them.

Code block takes its language tag from the most recent fenced block already in the book. The cursor is left inside the block. When the book has no fenced block yet, the tag is empty and the cursor is left on the tag so it can be filled in.

Footnote scans the open section for `[^n]` definitions and uses the next free number. The cursor is left after `[^n]: `, ready for the note. Definitions already in the file keep their numbers.

Picture opens a file chooser in the book folder. The chosen file is moved into `images/`. The path in the mark is relative to the book folder. The mark always ends with `{width=100%}`. A file already in `images/` stays where it is. A file whose name is already there is saved as `name-2`, `name-3`, and so on. With a selection, the selection is the caption and the cursor is left after the mark. With nothing selected, the cursor is left between the brackets.

One reminder page lists these same twelve commands and the characters each one inserts. The page and the menu match.

Any other Pandoc construct can still be typed by hand. The menu, the palette, and the reminder page cover this list only.

## Reading

Selecting a group opens a rendered view of that group, in tree order: the group's own body, then each descendant's title and body. Headings are shown at their exported size, code is highlighted, and footnotes are shown as notes. A footnote marker, and the return mark on its note, scroll this view to the other end of the link. This is how a group is read straight through. A part or a chapter shows its number, centered and bold, above the title. A part, a chapter, or a section is marked with a page break. Text is not. The node that opens the view is not marked.

The rendered view is produced from the files for reading. It is not edited. To change a sentence, open the section that contains it. The section preview, beside the editor, is the rendered view of the one section being written.

## Export

Export walks the tree in order and writes one Pandoc Markdown file. That file is the manuscript. It is written outside `manuscript/`. The writer chooses the destination when exporting.

For each node, export emits the title as a heading, then the body.

The heading level is the node's depth. Depth is the number of groups under `manuscript/` that contain the node, counting the node's own group when the node is a group's `_index.md`.

| Node | Depth | Exported heading |
|---|---|---|
| `manuscript/020-naming/_index.md`, unit `chapter` | 1 | `Chapter 1`, then `# Naming` |
| `manuscript/020-naming/010-the-rule/_index.md`, unit `section` | 2 | `## The Rule` |
| `manuscript/020-naming/010-the-rule/010-inward.md`, unit `text` | 3 | `### Inward` |

A part or a chapter is any body node whose unit says so, at any depth. Export writes `Part N` or `Chapter N` on a centered bold line, then the node's title as the heading beneath it. Parts and chapters are numbered separately, in tree order. A section writes the title only. Text writes the title only and stays on the current page. A front-matter node and the trash are not numbered. The number is not stored in the file.

A part, a chapter, and a section begin on a new page. Text does not. The node that opens the manuscript is the first page, so the break is not written in front of it.

In the example below, Preface is front matter, Naming is a chapter, The Rule is a section, and Inward is text.

A body heading is shifted by that same depth. A `#` inside `010-inward.md` is exported as `####`, one level below the section's own heading. Markdown has six heading levels. A heading that would land past level 6 is exported at level 6, and the export warns.

A front-matter heading is emitted with Pandoc's unnumbered marker: `# Preface {-}`. Body headings inside front matter get the same marker.

Footnote labels are prefixed with the section id during export, on both the reference and the definition. `[^1]` in the section whose id is `inward` is written as `[^inward-1]`. Inline notes have no label and need no prefix. Pandoc numbers the notes in the finished book. The labels in the source are not the numbers a reader sees.

Bookwriter's PDF prints the front matter's notes at the end of the front matter, and each chapter's notes at the end of that chapter, including the notes from the sections inside it. A part's own notes, and the notes of a section that is not inside a chapter, are printed at the end of that part or section. Each of those groups is numbered from 1 in the order the notes appear.

Export of the example above:

````markdown
# Preface {-}

The preface body.

<div class="page-break"></div>

<p class="chapter-number">Chapter 1</p>

# Naming

The chapter opener.

<div class="page-break"></div>

## The Rule

Inside the chapter.

### Inward

A dependency points inward.[^inward-1]

#### Where the rule stops

```java
class Foo {
    void bar() {}
}
```

[^inward-1]: Toward higher-level policy.
````

The application stops at that Markdown file. PDF, EPUB, and Word are Pandoc's job, run on the exported file. Picture paths are left as written, relative to the book folder. Run Pandoc from the book folder so a picture path resolves. Bookwriter does not grow a compile engine of its own.

Export Chapters to Word writes each front-matter piece and each chapter as its own Word file in a directory the writer chooses. A front-matter file is named `FM-title.docx` and holds that piece together with the sections inside it. A chapter file is named `cc-title.docx`, where `cc` is the chapter number written in at least two digits and `title` is that chapter's title, and it holds the sections inside the chapter. A part is not its own file. Pandoc does the conversion, run from the book folder so a picture path resolves.

Right-clicking a chapter and choosing Export to PDF writes a PDF of that chapter and the sections inside it. A nested chapter is its own chapter and is left out. The chapter keeps the number it has in the book. The suggested file name is `cc-title.pdf`.

## Application

The program is written in TypeScript.

The window is a Tauri window: a dock icon, a menu bar, and direct access to the book folder.

The body editor is CodeMirror. It edits the Markdown body, and the buffer is the file. The section preview is drawn from that buffer. The rendered chapter view is the reading view of a group.

The local program does these things with the folder:

- list a directory
- read a file
- write a file
- rename siblings when the order changes
- move a picture into `images/`
- concatenate the tree for export

## Left out

Recorded so this spec does not quietly grow back into Scrivener.

- Corkboard, index cards, and a second layout of the same tree
- A rendered editor that writes Markdown back out on save
- Commands that rebuild a section, including renumbering footnotes already in the file
- A menu or reminder for Pandoc constructs beyond the twelve markup commands
- Compile presets, separators, and placeholders
- Custom metadata fields beyond the six in the header
- A research bin of PDFs and clippings
- Snapshots as an application feature
- A database, or any copy of the book that can drift from the files
- An index, numbered references such as "see Figure 3," and callout numbers on lines of code

A book that must carry an index, numbered references, or code callouts in the source can store AsciiDoc bodies in this same tree. That is not part of the current design.

## Open questions

- Back matter (appendices, glossary) as a third role beside `front` and `body`.
