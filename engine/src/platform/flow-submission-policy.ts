/** Immutable receipt from the native Flow submission dispatcher. */
export interface FlowSubmissionPolicy {
  version: 1;
  trigger: "on_submit" | "on_create" | "on_update";
  kind: "gated" | "ungated";
  flowIds: string[];
  runIds: string[];
}
