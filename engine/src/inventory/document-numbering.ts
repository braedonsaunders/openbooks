import { db } from "../platform/db.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { type Runner } from "./contracts.ts";
// ---------------------------------------------------------------------------
// Transfer orders — two-step (ship → in-transit → receive) location moves
// ---------------------------------------------------------------------------

export async function nextSequenceNumber(
  orgId: string,
  kind: string,
  prefix: string,
  runner: Runner = db,
): Promise<string> {
  return allocateDocumentNumber(runner, orgId, kind, prefix);
}
