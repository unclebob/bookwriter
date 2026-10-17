import { isTrash } from "../internals/book";
import type { TreeNode } from "../internals/model";

export type PreviewClick = {
  previewOn: boolean;
  editFolderId: string | null;
};

export function previewClick(node: TreeNode | null, editing: boolean, previewOn: boolean): PreviewClick {
  if (node && node.kind === "group" && !isTrash(node) && !editing) {
    return { previewOn: true, editFolderId: node.header.id };
  }
  return { previewOn: !previewOn, editFolderId: null };
}
