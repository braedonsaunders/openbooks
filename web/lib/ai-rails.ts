import { NextResponse } from "next/server";
import { AiRailsError } from "@openbooks/engine/src/hrm/ai/errors.ts";
import { can, getAuthz, type Authz } from "./authz";

/**
 * Shared HTTP plumbing for the HR-21 AI rails routes. Engine refusals
 * reach the caller with their message intact (the remedy lives in the
 * message) and a status that names the failure shape. Clients check
 * res.ok before parsing: error bodies are checked before they are
 * parsed, so a refusal never surfaces as a JSON parse error.
 */
export function aiRailsErrorResponse(e: unknown): NextResponse {
  if (e instanceof AiRailsError) {
    const status = e.code === "ai_invalid_input" || e.code === "ai_reason_required"
      ? 400
      : e.code === "ai_forbidden" || e.code === "ai_autonomy_raise_refused"
        ? 403
        : e.code === "ai_subject_missing" || e.code === "ai_flag_missing" || e.code === "ai_capability_missing"
        || e.code === "ai_decision_missing"
          ? 404
          : e.code === "ai_feature_off" || e.code === "ai_unknown_capability" || e.code === "ai_unknown_draft_kind"
            ? 404
            : e.code === "ai_finalize_blocked" || e.code === "ai_flag_closed"
              ? 409
              : 422;
    return NextResponse.json({ error: e.message }, { status });
  }
  console.error("[ai-rails] endpoint failed:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}

/** Any-of permission gate: 401 without a session, 403 without a grant. */
export async function requireAnyPerm(perms: string[]): Promise<Authz | NextResponse> {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!perms.some((perm) => can(authz, perm))) {
    return NextResponse.json({ error: `missing permission: one of ${perms.join(", ")}` }, { status: 403 });
  }
  return authz;
}

/** UUID query param: required uuids refuse with the remedy. */
export function uuidParam(url: URL, name: string, required: true): string | NextResponse;
export function uuidParam(url: URL, name: string, required: false): string | null | NextResponse;
export function uuidParam(url: URL, name: string, required: boolean): string | null | NextResponse {
  const value = url.searchParams.get(name);
  if (value === null) {
    return required
      ? NextResponse.json({ error: `${name} is required` }, { status: 400 })
      : null;
  }
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
    return NextResponse.json({ error: `${name} must be a uuid` }, { status: 400 });
  }
  return value;
}

/** Civil-date query param with the same contract. */
export function dateParam(url: URL, name: string, required: boolean): string | null | NextResponse {
  const value = url.searchParams.get(name);
  if (value === null) {
    return required
      ? NextResponse.json({ error: `${name} is required (YYYY-MM-DD)` }, { status: 400 })
      : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return NextResponse.json({ error: `${name} must be YYYY-MM-DD` }, { status: 400 });
  }
  return value;
}
