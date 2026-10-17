import { describe, expect, it } from "vitest";
import type { TreeNode } from "../internals/model";
import { previewClick } from "./view";

function node(kind: TreeNode["kind"], id: string): TreeNode {
  return {
    kind,
    header: { id, title: id, synopsis: "", status: "idea", role: "body" },
    body: "Folder words.\n",
    prefix: "010",
    slug: id,
    dir: "",
    entryName: "",
    children: [],
  };
}

describe("preview button", () => {
  it("opens a folder's markup beside the preview", () => {
    expect(previewClick(node("group", "playbooks"), false, false)).toEqual({
      previewOn: true,
      editFolderId: "playbooks",
    });
    expect(previewClick(node("group", "playbooks"), false, true)).toEqual({
      previewOn: true,
      editFolderId: "playbooks",
    });
  });

  it("toggles the preview for a text, a folder already open for markup, and the trash", () => {
    expect(previewClick(node("section", "inward"), true, true)).toEqual({
      previewOn: false,
      editFolderId: null,
    });
    expect(previewClick(node("group", "playbooks"), true, true)).toEqual({
      previewOn: false,
      editFolderId: null,
    });
    expect(previewClick(node("group", "trash"), false, true)).toEqual({
      previewOn: false,
      editFolderId: null,
    });
    expect(previewClick(null, false, false)).toEqual({ previewOn: true, editFolderId: null });
  });
});
