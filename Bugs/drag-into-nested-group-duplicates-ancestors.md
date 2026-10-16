# Dragging into a nested group duplicates the ancestors

Dropping a group into a group that lives inside a sibling can rename that sibling and then recreate the sibling's old path. The dropped group lands in the copy. The copy has no `_index.md`. Loading it invents a second group from the directory slug, so the outline shows the ancestor twice.

This showed up in the ub-mode book at `/Users/unclebob/junk/ub-mode`.

Before the drag, the manuscript root was:

- `010-principles` The Principles
- `020-reduced-principles` Skill ub-mode
- `030-playbooks` Playbooks
- `040-appendices` Appendices
  - `010-appendix` Licences
  - `020-research` Research
    - `010-integration`
    - `020-skills`

Playbooks was dropped inside Research.

After the drag, Appendices had been renumbered to `030-appendices` and still held Licences and Research. Integration and Skills were still there. A second tree stood beside it:

- `040-appendices/` no `_index.md`
  - `020-research/` no `_index.md`
    - `030-playbooks/` the Playbooks group, intact

`loadGroup` turns a directory with no `_index.md` into a group whose id and title come from the slug. The window showed a second Appendices and a second Research. Those ids collided with the real groups, `appendices` and `research`.

The book is repaired. Playbooks is `manuscript/030-appendices/020-research/030-playbooks`, and `040-appendices` is gone.

## Repro

1. Open a book with two root groups, A then B. B contains a child group C.
2. Drag A and drop it inside C.
3. B should be the only root group, renumbered to `010`, and C should contain A.
4. Actual: `010-b` does not contain A. `020-b/c/a` exists. `020-b` and the `c` inside it have no `_index.md`.

The ub-mode case is the same shape with more siblings. Removing Playbooks from the root renumbered Appendices from `040` to `030`. The destination was still computed as `manuscript/040-appendices/020-research`.

## Cause

`moveNode` in `src/internals/book.ts` rewrites the source directory before it builds the destination path. `rewriteDirectory` updates `dir` and `entryName` on the nodes it reorders. It does not update `dir` on their descendants.

The destination is then `join(destParent.dir, destParent.entryName)`. When the destination parent sits inside a sibling that just received a new prefix, `destParent.dir` still names the old directory.

`rename` creates that missing parent instead of failing:

- `src/nodeFs.ts` `rename` calls `mkdir(dirname(to), { recursive: true })`.
- `src-tauri/src/lib.rs` `rename_path` calls `ensure_parent`, which is `create_dir_all`.

The old ancestor path is created empty, and the moved node is renamed into it.

The spec says a reorder rewrites the prefixes of the siblings in that directory and leaves every other directory alone (`bookwriter-spec.md`, the paragraph under `manuscript/`).

A move into a direct sibling works. That sibling is in the source rewrite, so its own `entryName` is already the new name. The test "moves a folder into a later folder" covers that case. It does not cover a destination nested under a renamed sibling.

## Fix

After the source rewrite, walk from the book root and set each node's `dir` from its parent's current entry path. Compute the destination from that. A reorder rename should not create missing parents. A missing parent means the path is wrong.

Add a test: root groups A and B, B contains C, move A inside C, reload, and assert one B, with A inside C, and no second directory whose slug is B.
