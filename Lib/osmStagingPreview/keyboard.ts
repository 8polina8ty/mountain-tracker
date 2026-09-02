import type { PreviewQaStatus } from "./core.ts";

export type QaKeyboardAction =
  | { type: "SELECT_STATUS"; status: Exclude<PreviewQaStatus, "PENDING"> }
  | { type: "PREVIOUS_ROUTE" }
  | { type: "NEXT_ROUTE" };

export function getQaKeyboardAction(input: {
  key: string;
  editableOrControlContext: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}): QaKeyboardAction | null {
  if (
    input.editableOrControlContext ||
    input.ctrlKey ||
    input.altKey ||
    input.metaKey ||
    input.shiftKey ||
    input.repeat
  ) {
    return null;
  }
  if (input.key.toLowerCase() === "a") {
    return { type: "SELECT_STATUS", status: "VISUALLY_APPROVED" };
  }
  if (input.key.toLowerCase() === "n") {
    return { type: "SELECT_STATUS", status: "NEEDS_REVIEW" };
  }
  if (input.key.toLowerCase() === "r") {
    return { type: "SELECT_STATUS", status: "REJECTED" };
  }
  if (input.key === "ArrowLeft") return { type: "PREVIOUS_ROUTE" };
  if (input.key === "ArrowRight") return { type: "NEXT_ROUTE" };
  return null;
}
