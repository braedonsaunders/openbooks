import { NextResponse } from "next/server";
import { guardPermission } from "../../../../lib/authz";
import { createDraftJournal } from "../../../../lib/journals";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DraftBody = { subsidiaryId?: string };

async function readDraftBody(
  req?: Request,
): Promise<
  { ok: true; body: DraftBody } | { ok: false; response: NextResponse }
> {
  if (!req) return { ok: true, body: {} };
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "invalid request body" },
        { status: 400 },
      ),
    };
  }
  if (!raw.trim()) return { ok: true, body: {} };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "invalid request body" },
        { status: 400 },
      ),
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "invalid request body" },
        { status: 400 },
      ),
    };
  }
  const candidate = (value as Record<string, unknown>).subsidiaryId;
  if (candidate === undefined) return { ok: true, body: {} };
  if (typeof candidate !== "string" || !UUID_RE.test(candidate)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "invalid subsidiary" },
        { status: 422 },
      ),
    };
  }
  return { ok: true, body: { subsidiaryId: candidate.toLowerCase() } };
}

function scopeErrorResponse(error: unknown): NextResponse | null {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case "invalid_subsidiary":
      return NextResponse.json(
        { error: "invalid subsidiary" },
        { status: 422 },
      );
    case "subsidiary_not_allowed":
      return NextResponse.json({ error: "not found" }, { status: 404 });
    case "no_available_subsidiary":
      return NextResponse.json(
        { error: "no_available_subsidiary" },
        { status: 409 },
      );
    case "ambiguous_subsidiary_scope":
      return NextResponse.json(
        { error: "subsidiary_selection_required" },
        { status: 409 },
      );
    default:
      return null;
  }
}

/** Instant-into-draft: create an empty draft manual journal and return its id. */
export async function POST(req?: Request) {
  const gate = await guardPermission("gl.post");
  if (gate instanceof NextResponse) return gate;
  const parsed = await readDraftBody(req);
  if (!parsed.ok) return parsed.response;
  const { subsidiaryId } = parsed.body;

  // The route rejects an explicit cross-scope id before invoking the writer;
  // the service repeats this check for every non-route caller.
  if (
    subsidiaryId &&
    gate.allowedSubsidiaryIds !== null &&
    !gate.allowedSubsidiaryIds.has(subsidiaryId)
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Empty restricted scope can never produce a legal journal. Leave the
  // one-versus-many legal-entity decision to the service's database check.
  if (
    !subsidiaryId &&
    gate.allowedSubsidiaryIds !== null &&
    gate.allowedSubsidiaryIds.size === 0
  ) {
    return NextResponse.json(
      { error: "no_available_subsidiary" },
      { status: 409 },
    );
  }

  try {
    const doc = await createDraftJournal(gate.user.orgId, gate.user.id, {
      subsidiaryId,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    return NextResponse.json(doc);
  } catch (error) {
    const response = scopeErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
