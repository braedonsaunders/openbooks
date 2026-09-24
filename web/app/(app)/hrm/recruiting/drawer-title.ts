/**
 * CK-23b: which record owns the open drawer. An open offer or candidate
 * drawer is titled for its own record (the offer title carries the
 * persisted employer as review context), never for the requisition — the
 * loader maps the winning kind to its translated title key.
 *
 * Pure and dependency-free so the branch is unit-testable without booting
 * Next: view.ts must not be imported outside the app router (server-only).
 */
export type DrawerTitleKind = "offer" | "candidate" | "requisition";

export function drawerTitleKind(record: {
  readonly hasOffer: boolean;
  readonly hasCandidate: boolean;
}): DrawerTitleKind {
  if (record.hasOffer) return "offer";
  if (record.hasCandidate) return "candidate";
  return "requisition";
}
