import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { guardPermission, type Authz } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import {
  createSetupRecord,
  deleteSetupRecord,
  preflightSetupWrite,
  updateSetupRecord,
} from "@/lib/setup/write";
import { setupEntityRoutePermission } from "@/lib/setup/route-auth";

const requestBodySchema = z.record(z.string(), z.json());

export const runtime = "nodejs";

/**
 * Generic CRUD for every configuration entity in the Setup registry. The
 * command layer (column whitelisting, validation, feature fence, per-entity
 * rules, audit) lives in web/lib/setup/write.ts and is shared with the
 * assistant/MCP setup-record tools; this route is the HTTP adapter.
 *
 * Setup entities require admin.setup.manage; CRM lifecycle lists keep their
 * module-owned crm.setup.manage gate. Writes remain org-scoped and audited.
 */
async function authorizeSetupEntity({ params }: { request: Request; params: unknown }) {
  const entityKey =
    params && typeof params === "object" && "entity" in params
      ? String((params as { entity: unknown }).entity)
      : "";
  return guardPermission(setupEntityRoutePermission(entityKey));
}

function setupActor(gate: Authz) {
  return {
    ...gate.user,
    permissions: gate.permissions,
    allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
  };
}

function setupEntityKey(params: unknown): string {
  return params && typeof params === "object" && "entity" in params
    ? String((params as { entity: unknown }).entity)
    : "";
}

function setupWriteResponse(result: { status: number; body: Record<string, unknown> }) {
  if (result.status === 404) {
    return notFound("setup record");
  }
  return NextResponse.json(result.body, { status: result.status });
}

async function authorizeSetupCreate(ctx: { request: Request; params: unknown }) {
  const gate = await authorizeSetupEntity(ctx);
  if (gate instanceof NextResponse) return gate;

  const requestId = ctx.request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!requestId) {
    return NextResponse.json(
      { error: "Idempotency-Key header is required", code: "invalid" },
      { status: 400 },
    );
  }
  if (!isUuid(requestId)) {
    return NextResponse.json(
      { error: "Idempotency-Key must be a UUID", code: "invalid" },
      { status: 400 },
    );
  }

  const refused = await preflightSetupWrite(setupActor(gate), setupEntityKey(ctx.params), "create");
  return refused ? setupWriteResponse(refused) : gate;
}

async function authorizeSetupUpdate(ctx: { request: Request; params: unknown }) {
  const gate = await authorizeSetupEntity(ctx);
  if (gate instanceof NextResponse) return gate;
  const refused = await preflightSetupWrite(setupActor(gate), setupEntityKey(ctx.params), "update");
  return refused ? setupWriteResponse(refused) : gate;
}

async function legacyDELETE(
  req: Request,
  { params }: { params: Promise<{ entity: string }> },
  options: { reason?: string; auditReason?: string } = {},
  gate: Authz,
) {
  const actor = {
    ...gate.user,
    permissions: gate.permissions,
    allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
  };
  const entityKey = (await params).entity;
  const refused = await preflightSetupWrite(actor, entityKey, "delete");
  if (refused) return setupWriteResponse(refused);
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  const result = await deleteSetupRecord(actor, entityKey, id, options);
  return setupWriteResponse(result);
}

export const POST = defineRoute({
  authorize: authorizeSetupCreate,
  feature: {
    none: "Each setup entity uses the feature and permission declared in the setup registry.",
  },
  params: z.object({ entity: z.string() }),
  body: requestBodySchema,
  handler: async ({ request, params, body, authz: routeAuthz }) => {
    const gate = routeAuthz;

    // Creates are idempotent on the caller's key, which becomes the new row's
    // id: the drawer mints one UUID per mounted create session and reuses it
    // across retries and timeouts. The key is required (400, no write) and only
    // read on POST — PATCH never needs it. It is validated before the entity
    // preflight because the preflight reads feature state: a missing or
    // malformed key must fail with zero statements. A valid key on an
    // unknown/disabled entity still falls through to the preflight's 404/405.
    const requestId = request.headers.get("Idempotency-Key")?.trim() ?? "";
    if (!requestId) {
      return NextResponse.json(
        { error: "Idempotency-Key header is required", code: "invalid" },
        { status: 400 },
      );
    }
    if (!isUuid(requestId)) {
      return NextResponse.json(
        { error: "Idempotency-Key must be a UUID", code: "invalid" },
        { status: 400 },
      );
    }
    const actor = setupActor(gate);
    const entityKey = params.entity;
    const result = await createSetupRecord(actor, entityKey, body as Record<string, unknown>, {
      requestId,
    });
    return setupWriteResponse(result);
  },
});

export const PATCH = defineRoute({
  authorize: authorizeSetupUpdate,
  feature: {
    none: "Each setup entity uses the feature and permission declared in the setup registry.",
  },
  params: z.object({ entity: z.string() }),
  body: requestBodySchema,
  handler: async ({ params, body, authz: routeAuthz }) => {
    const gate = routeAuthz;

    const actor = setupActor(gate);
    const entityKey = params.entity;
    const result = await updateSetupRecord(actor, entityKey, body as Record<string, unknown>);
    return setupWriteResponse(result);
  },
});

export const DELETE = defineRoute({
  authorize: authorizeSetupEntity,
  feature: {
    none: "Each setup entity uses the feature and permission declared in the setup registry.",
  },
  params: z.object({ entity: z.string() }),
  body: z
    .strictObject({
      reason: z.string().trim().min(1).max(2000).optional(),
      auditReason: z.string().trim().min(1).max(2000).optional(),
    })
    .optional(),
  handler: async ({ request, params, body, authz }) =>
    legacyDELETE(request, { params: Promise.resolve(params) }, body, authz),
});
