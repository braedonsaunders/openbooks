/**
 * Which lifecycle actions the document drawer offers for a saved record.
 *
 * A posted document is immutable history: it can be voided (a governed
 * reversal) or corrected through the posted-correction flow, but it is never
 * posted again and never physically deleted. These rules are the single
 * reading the drawer's action menu renders from, so a status branch added
 * for one record kind cannot quietly re-open Post or Delete for another.
 */

export interface DocumentActionFacts {
  status: string;
  /** The kind posts directly on save/create instead of routing approval. */
  directPost: boolean;
  /** The caller holds the create grant for the record's namespace. */
  canCreate: boolean;
  /** The caller holds the post (approve) grant for the record's namespace. */
  canPost: boolean;
}

export type DocumentLifecycleAction = "submit" | "post" | "void" | "delete" | "returnToDraft";

export function documentActionAvailable(action: DocumentLifecycleAction, facts: DocumentActionFacts): boolean {
  const { status, directPost, canCreate, canPost } = facts;
  // Terminal states: a posted or voided record offers no lifecycle transition
  // other than a governed void of a posted record.
  if (status === "posted") return action === "void" && canPost;
  if (status === "voided") return false;
  switch (action) {
    case "submit":
      return status === "draft" && canCreate && !directPost;
    case "post":
      return (status === "draft" && canCreate && directPost) || (status === "approved" && canPost);
    case "void":
      return status === "approved" && canPost;
    case "delete":
      return status === "draft" && canCreate;
    case "returnToDraft":
      return status === "approved" && canPost;
  }
}
