import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { startCloseRun, CloseError } from "@openbooks/engine/src/close.ts";
import { guardPermission } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

type CloseRunSubsidiaryIds = string[] | null;

/**
 * Resolve the requested close scope against the caller's visibility policy.
 * A null allowed set is the explicit unrestricted sentinel; every restricted
 * caller must receive a concrete, non-empty scope and may not widen it by
 * omitting the body field, sending an empty array, or smuggling invalid IDs.
 */
function parseCloseRunSubsidiaryIds(
  body: Record<string, unknown>,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): CloseRunSubsidiaryIds | Response {
  const raw = body.subsidiaryIds;
  if (raw === undefined) {
    if (allowedSubsidiaryIds === null) return null;
    const allowed = [...allowedSubsidiaryIds];
    return allowed.length > 0
      ? allowed
      : NextResponse.json(
          { error: "no subsidiaries are in the caller's close scope" },
          { status: 403 },
        );
  }
  if (raw === null) {
    return allowedSubsidiaryIds === null
      ? null
      : NextResponse.json(
          { error: "close scope is restricted to the caller's subsidiaries" },
          { status: 403 },
        );
  }
  if (!Array.isArray(raw)) {
    return NextResponse.json(
      { error: "subsidiaryIds must be an array or null" },
      { status: 400 },
    );
  }
  if (
    raw.some((id) => typeof id !== "string" || !isUuid(id))
    || new Set(raw).size !== raw.length
  ) {
    return NextResponse.json(
      { error: "subsidiaryIds must contain unique valid UUIDs" },
      { status: 400 },
    );
  }
  const requested = raw as string[];
  if (requested.length === 0) {
    return allowedSubsidiaryIds === null
      ? NextResponse.json(
          { error: "use null to request an organization-wide close scope" },
          { status: 400 },
        )
      : NextResponse.json(
          { error: "close scope must include at least one authorized subsidiary" },
          { status: 403 },
        );
  }
  if (
    allowedSubsidiaryIds !== null
    && requested.some((id) => !allowedSubsidiaryIds.has(id))
  ) {
    return NextResponse.json(
      { error: "one or more close-scope subsidiaries are outside the caller's scope" },
      { status: 403 },
    );
  }
  return requested;
}

export async function POST(req: Request) {
  const gate = await guardPermission("close.run");
  if (gate instanceof NextResponse) return gate;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>;
  const periodId = typeof body.periodId === "string" ? body.periodId : "";
  const bookId = typeof body.bookId === "string" ? body.bookId : "";
  if (!isUuid(periodId) || !isUuid(bookId)) {
    return NextResponse.json(
      { error: "valid periodId and bookId are required" },
      { status: 400 },
    );
  }
  const blueprintId =
    typeof body.blueprintId === "string" && isUuid(body.blueprintId)
      ? body.blueprintId
      : undefined;
  const reportingPackageId =
    typeof body.reportingPackageId === "string" &&
    isUuid(body.reportingPackageId)
      ? body.reportingPackageId
      : undefined;
  const subsidiaryIds = parseCloseRunSubsidiaryIds(
    body,
    gate.allowedSubsidiaryIds,
  );
  if (subsidiaryIds instanceof Response) return subsidiaryIds;
  try {
    const runId = await startCloseRun({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      periodId,
      bookId,
      blueprintId,
      reportingPackageId,
      targetCloseDate:
        typeof body.targetCloseDate === "string"
          ? body.targetCloseDate
          : undefined,
      // Preserve the explicit null org-wide sentinel end-to-end. Restricted
      // omissions are resolved to their concrete allowed IDs above.
      subsidiaryIds,
    });
    return NextResponse.json({ ok: true, runId });
  } catch (error) {
    if (error instanceof CloseError)
      return NextResponse.json({ error: error.message }, { status: 422 });
    throw error;
  }
}
