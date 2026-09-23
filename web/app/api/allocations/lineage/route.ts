import { NextResponse } from "next/server";
import { guardAllocations } from "../../../../lib/allocations-gate";
import { isUuid } from "../../../../lib/list-params";
import { RunQueryError, queryLineage } from "../../../../../engine/src/allocations/run-queries.ts";

export const runtime = "nodejs";

/**
 * Lineage drill (A8): from a run or a journal entry (or a document for
 * entry/post modes), every allocated line back to its source and driver.
 * Exactly one anchor; `allocations.read`. The LineagePanel component
 * renders this payload for the Runs tab, A5's journal drawer and A9.
 */
export async function GET(req: Request) {
  const gate = await guardAllocations("allocations.read");
  if (gate instanceof NextResponse) return gate;
  const params = new URL(req.url).searchParams;
  const anchor = (name: "runId" | "journalEntryId" | "documentId"): string | undefined => {
    const raw = params.get(name);
    if (raw === null || raw === "") return undefined;
    if (!isUuid(raw)) throw new RunQueryError("validation", `${name} must be a uuid`);
    return raw;
  };
  // Real pagination: the drill answers { anchor, rows, total, limit, offset,
  // truncated } so a run with more lines than fit one page never looks
  // complete. Malformed paging is a 400 via the engine validators below.
  const numeric = (name: "limit" | "offset"): number | undefined => {
    const raw = params.get(name);
    if (raw === null || raw === "") return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new RunQueryError("validation", `${name} must be a number`);
    return value;
  };
  try {
    const result = await queryLineage(
      gate.user.orgId,
      {
        runId: anchor("runId"),
        journalEntryId: anchor("journalEntryId"),
        documentId: anchor("documentId"),
      },
      {
        limit: numeric("limit"),
        offset: numeric("offset"),
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RunQueryError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
