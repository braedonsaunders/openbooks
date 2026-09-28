import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { notFound } from "@/lib/api/responses";
import { can, getAuthz, type Authz } from "@/lib/authz";
import { featureEnabled, resolvedFeatureState } from "@/lib/features";
import { applicationContextFromSession } from "@/lib/application/context";
import { executeIdempotent } from "@/lib/application/idempotency";
import { isUuid } from "@/lib/list-params";
import { SETUP_ENTITY_BY_KEY } from "@/lib/setup/registry";
import type { SetupCommandName } from "@/lib/setup/types";
import { setFramework } from "@openbooks/engine/src/nonprofit/frameworks.ts";
import { setFundPair } from "@openbooks/engine/src/nonprofit/funds.ts";
import { setFunctionalMapping } from "@openbooks/engine/src/nonprofit/functional.ts";

export const runtime = "nodejs";

/**
 * POST /api/admin/setup/[entity]/command — the domain-command counterpart to
 * the generic CRUD route beside it. The entity comes from the URL through the
 * Setup registry, never the body: unknown entities, entities without a
 * command marker, and feature-off entities fail closed before the body is
 * read. The marker's literal name selects one of three strict schemas and
 * one direct engine call — no dynamic lookup, no table/SQL derivation, no
 * generic fallback. Identity (org, actor) comes from the session, never the
 * request. Domain refusals keep their typed status with message, code,
 * remedy, and field intact; anything else follows the standard error path.
 */

const paramsSchema = z.object({ entity: z.string() });

const frameworkBody = z.strictObject({
  framework: z.enum(["us_asc958", "ew_sorp_frs102"]),
  reason: z.string(),
});

const fundPairBody = z.strictObject({
  fromFundId: z.string(),
  toFundId: z.string(),
  dueFromAccountId: z.string(),
  dueToAccountId: z.string(),
  isActive: z.boolean().optional(),
  // The boundary requires the reason so a blank reason never reaches the
  // domain; the fund-pair domain stores it with its reason implementation.
  reason: z.string().trim().min(1),
});

const functionalMappingBody = z.strictObject({
  departmentId: z.string().nullish(),
  projectId: z.string().nullish(),
  functionKey: z.enum(["program", "management_general", "fundraising"]),
  programKey: z.string().nullish(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullish(),
  reason: z.string(),
});

/** Domain refusals keep typed status with message, code, remedy, and field. */
export function commandRefusalResponse(error: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(error instanceof Error)) return null;
  const source = error as Error & { status?: unknown; code?: unknown; remedy?: unknown; field?: unknown };
  if (typeof source.status !== "number" || !Number.isInteger(source.status) || source.status < 400 || source.status > 499) {
    return null;
  }
  return {
    status: source.status,
    body: {
      error: error.message,
      ...(typeof source.code === "string" ? { code: source.code } : {}),
      ...(typeof source.remedy === "string" ? { remedy: source.remedy } : {}),
      ...(typeof source.field === "string" ? { field: source.field } : {}),
    },
  };
}

/** Shape failures map through the same typed refusal path as domain refusals. */
function invalidCommandBody(): Error {
  return Object.assign(new Error("invalid command body"), { status: 400, code: "invalid" });
}

/** Parse with the descriptor's literal schema and run the matching engine command. */
async function runCommandBody(
  authz: Authz,
  command: { name: SetupCommandName },
  raw: Record<string, unknown>,
): Promise<unknown> {
  const orgId = authz.user.orgId;
  const actorId = authz.user.id;
  switch (command.name) {
    case "setFramework": {
      const parsed = frameworkBody.safeParse(raw);
      if (!parsed.success) throw invalidCommandBody();
      return setFramework({ orgId, actorId, framework: parsed.data.framework, reason: parsed.data.reason });
    }
    case "setFundPair": {
      const parsed = fundPairBody.safeParse(raw);
      if (!parsed.success) throw invalidCommandBody();
      // The reason travels with the call so the fund-pair domain receives it;
      // the cast carries the boundary-required field the stored input type
      // gains with its reason implementation.
      return setFundPair({ orgId, actorId, ...parsed.data } as Parameters<typeof setFundPair>[0] & { reason: string });
    }
    case "setFunctionalMapping": {
      const parsed = functionalMappingBody.safeParse(raw);
      if (!parsed.success) throw invalidCommandBody();
      return setFunctionalMapping({ orgId, actorId, ...parsed.data });
    }
  }
}

async function runCommand(
  authz: Authz,
  entityKey: string,
  command: { name: SetupCommandName },
  requestId: string,
  raw: Record<string, unknown>,
): Promise<NextResponse> {
  try {
    // The key fences the command: exact replay returns the stored response
    // and key reuse with a changed body refuses — both owned by the
    // canonical boundary, not this route. A domain refusal thrown inside
    // executes unrecorded (the claim rolls back) and maps below.
    const outcome = await executeIdempotent({
      context: applicationContextFromSession(authz, "api", requestId),
      operation: `setup.${command.name}`,
      idempotencyKey: requestId,
      request: { entity: entityKey, body: raw },
      execute: () => runCommandBody(authz, command, raw),
    });
    return NextResponse.json(outcome.value, { status: 200 });
  } catch (error) {
    const refusal = commandRefusalResponse(error);
    if (refusal) return NextResponse.json(refusal.body, { status: refusal.status });
    throw error;
  }
}

/** The 403 names the missing grant and where an admin restores it. */
function permissionRefusal(permission: string): NextResponse {
  return NextResponse.json(
    { error: `missing permission: ${permission} — ask an administrator to grant it in Admin → Users & Roles`, code: "forbidden" },
    { status: 403 },
  );
}

async function handler(request: Request, params: { entity: string }, authz: Authz): Promise<NextResponse> {
  // Entity selection is URL + registry only. Unknown, marker-less, and
  // feature-off entities are indistinguishable 404s — the same answer the
  // generic route gives a disabled entity — and all of it happens before the
  // body is read.
  const entity = SETUP_ENTITY_BY_KEY.get(params.entity);
  if (!entity?.command) return notFound("setup entity");
  if (!featureEnabled(await resolvedFeatureState(authz.user.orgId), entity.command.feature)) {
    return notFound("setup entity");
  }
  // The static gate already enforced funds.manage, but the type admits only
  // that one permission — so the descriptor is re-asserted here from the
  // declaration itself, never a parallel map, before anything is parsed.
  if (!can(authz, entity.command.permission)) return permissionRefusal(entity.command.permission);
  // Creates are upserts keyed by the caller's idempotency key, mirroring the
  // generic route's anti-double-submit contract; row identity stays
  // engine-owned and every command runs through its domain handler.
  const requestId = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!requestId) {
    return NextResponse.json({ error: "Idempotency-Key header is required", code: "invalid" }, { status: 400 });
  }
  if (!isUuid(requestId)) {
    return NextResponse.json({ error: "Idempotency-Key must be a UUID", code: "invalid" }, { status: 400 });
  }
  const parsed = await parseJsonBody(request, z.record(z.string(), z.json()));
  if (!parsed.ok) return parsed.response;
  return runCommand(authz, params.entity, entity.command, requestId, parsed.data as Record<string, unknown>);
}

export const POST = defineRoute({
  authorize: async () => {
    // funds.manage gates before params and body: the 403 names the grant and
    // where an admin restores it, so the operator never guesses.
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    // Static pre-gate: the descriptor type admits no permission other than
    // funds.manage, so this names the only grant the handler re-asserts.
    if (!can(authz, "funds.manage")) return permissionRefusal("funds.manage");
    return authz;
  },
  feature: { none: "This endpoint has no single route-wide feature gate; the descriptor's authoritative feature is checked per entity in the handler." },
  params: paramsSchema,
  handler: async ({ request, authz, params }) => handler(request, params as { entity: string }, authz),
});
