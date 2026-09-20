import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  commitPostingPeriodAssignment,
  PostingPeriodAssignmentError,
  previewPostingPeriodAssignment,
} from "@openbooks/engine/src/close/posting-periods.ts";
import { CloseError } from "@openbooks/engine/src/close/period-policy.ts";
import { guardPermission } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

type Gate = Exclude<Awaited<ReturnType<typeof guardPermission>>, NextResponse>;

/** The caller's subsidiary visibility as an engine scope filter. */
function subsidiaryScope(gate: Gate): string[] | null | NextResponse {
  if (gate.allowedSubsidiaryIds === null) return null;
  const allowed = [...gate.allowedSubsidiaryIds];
  return allowed.length > 0
    ? allowed
    : NextResponse.json(
        { error: "no subsidiaries are in the caller's scope" },
        { status: 403 },
      );
}

function parseIdList(value: string | null): string[] | undefined | NextResponse {
  if (value === null || value === "") return undefined;
  const ids = value.split(",").filter((id) => id.length > 0);
  if (ids.some((id) => !isUuid(id)) || new Set(ids).size !== ids.length) {
    return NextResponse.json(
      { error: "documentIds must contain unique valid UUIDs" },
      { status: 400 },
    );
  }
  return ids;
}

/** Preview the posting-period assignment for approved documents lacking one. */
export async function GET(req: Request) {
  const gate = await guardPermission("close.run");
  if (gate instanceof NextResponse) return gate;
  const url = new URL(req.url);
  const bookId = url.searchParams.get("bookId") ?? "";
  if (!isUuid(bookId)) {
    return NextResponse.json({ error: "valid bookId is required" }, { status: 400 });
  }
  const documentIds = parseIdList(url.searchParams.get("documentIds"));
  if (documentIds instanceof NextResponse) return documentIds;
  const scope = subsidiaryScope(gate);
  if (scope instanceof NextResponse) return scope;
  try {
    const preview = await previewPostingPeriodAssignment(gate.user.orgId, {
      bookId,
      documentIds,
      subsidiaryIds: scope,
    });
    return NextResponse.json(preview);
  } catch (error) {
    if (error instanceof PostingPeriodAssignmentError || error instanceof CloseError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}

/** Commit the assignment (preview first: only previewed rows are committed). */
export async function POST(req: Request) {
  const gate = await guardPermission("close.run");
  if (gate instanceof NextResponse) return gate;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as Record<string, unknown>;
  const bookId = typeof body.bookId === "string" ? body.bookId : "";
  if (!isUuid(bookId)) {
    return NextResponse.json({ error: "valid bookId is required" }, { status: 400 });
  }
  const rawIds = body.documentIds;
  if (rawIds !== undefined) {
    if (
      !Array.isArray(rawIds)
      || rawIds.some((id) => typeof id !== "string" || !isUuid(id))
      || new Set(rawIds).size !== rawIds.length
    ) {
      return NextResponse.json(
        { error: "documentIds must contain unique valid UUIDs" },
        { status: 400 },
      );
    }
  }
  const scope = subsidiaryScope(gate);
  if (scope instanceof NextResponse) return scope;
  try {
    const result = await commitPostingPeriodAssignment(gate.user.orgId, {
      bookId,
      documentIds: rawIds as string[] | undefined,
      subsidiaryIds: scope,
      actorId: gate.user.id,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof PostingPeriodAssignmentError || error instanceof CloseError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}
