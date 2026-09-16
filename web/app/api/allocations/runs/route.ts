import { NextResponse } from "next/server";
import { guardAllocations } from "../../../../lib/allocations-gate";
import { isUuid } from "../../../../lib/list-params";
import { RunQueryError, listRuns } from "../../../../../engine/src/allocations/run-queries.ts";

export const runtime = "nodejs";

const STATUSES = ["previewed", "pending_approval", "posted", "reversed", "failed", "superseded"] as const;

/**
 * Run list (A8). `allocations.read` + the caller's subsidiary scope
 * (org-wide runs stay invisible to restricted callers).
 */
export async function GET(req: Request) {
  const gate = await guardAllocations("allocations.read");
  if (gate instanceof NextResponse) return gate;
  const params = new URL(req.url).searchParams;
  const pick = (name: string): string | undefined => {
    const raw = params.get(name);
    if (raw === null || raw === "") return undefined;
    if (!isUuid(raw)) throw new RunQueryError("validation", `${name} must be a uuid`);
    return raw;
  };
  const status = params.get("status") ?? undefined;
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: `unknown status: ${status}` }, { status: 400 });
  }
  const limit = params.get("limit") === null ? undefined : Number(params.get("limit"));
  const offset = params.get("offset") === null ? undefined : Number(params.get("offset"));
  try {
    const result = await listRuns(gate.user.orgId, {
      ruleId: pick("ruleId"),
      periodId: pick("periodId"),
      bookId: pick("bookId"),
      subsidiaryId: pick("subsidiaryId"),
      status: status as (typeof STATUSES)[number] | undefined,
      limit,
      offset,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RunQueryError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
