import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { createSetupRecord, deleteSetupRecord, preflightSetupWrite, updateSetupRecord } from '../../../../../lib/setup/write'

const requestBodySchema = z.record(z.string(), z.json());


export const runtime = 'nodejs'

/**
 * Generic CRUD for every configuration entity in the Setup registry. The
 * command layer (column whitelisting, validation, feature fence, per-entity
 * rules, audit) lives in web/lib/setup/write.ts and is shared with the
 * assistant/MCP setup-record tools; this route is the HTTP adapter.
 *
 * Gated by admin.setup.manage. Org-scoped (except the shared `currencies`
 * reference table) and audited to audit_log, mirroring the settings route.
 */
const PERMISSION = 'admin.setup.manage'

function setupWriteResponse(result: { status: number; body: Record<string, unknown> }) {
  if (result.status === 404) {
    return notFound("setup record");
  }
  return NextResponse.json(result.body, { status: result.status });
}

async function legacyPOST(req: Request, { params }: { params: Promise<{ entity: string }> }) {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const actor = { ...gate.user, permissions: gate.permissions, allowedSubsidiaryIds: gate.allowedSubsidiaryIds }
  const entityKey = (await params).entity
  const refused = await preflightSetupWrite(actor, entityKey, 'create')
  if (refused) return setupWriteResponse(refused)
  // Creates are idempotent on the caller's key, which becomes the new row's
  // id: the drawer mints one UUID per mounted create session and reuses it
  // across retries and timeouts. The key is required (400, no write) and only
  // read on POST — PATCH never needs it. It is validated after authentication
  // and the entity preflight, so unknown/disabled entities and
  // declared-module creates keep their 404/405 semantics with or without it.
  const requestId = req.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!requestId) {
    return NextResponse.json({ error: 'Idempotency-Key header is required', code: 'invalid' }, { status: 400 })
  }
  if (!isUuid(requestId)) {
    return NextResponse.json({ error: 'Idempotency-Key must be a UUID', code: 'invalid' }, { status: 400 })
  }
  const parsedBody = await parseJsonBody(req, requestBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const result = await createSetupRecord(actor, entityKey, parsedBody.data as Record<string, unknown>, { requestId })
  return setupWriteResponse(result)
}

async function legacyPATCH(req: Request, { params }: { params: Promise<{ entity: string }> }) {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const actor = { ...gate.user, permissions: gate.permissions, allowedSubsidiaryIds: gate.allowedSubsidiaryIds }
  const entityKey = (await params).entity
  const refused = await preflightSetupWrite(actor, entityKey, 'update')
  if (refused) return setupWriteResponse(refused)
  const parsedBody2 = await parseJsonBody(req, requestBodySchema);
  if (!parsedBody2.ok) return parsedBody2.response;
  const result = await updateSetupRecord(actor, entityKey, parsedBody2.data as Record<string, unknown>)
  return setupWriteResponse(result)
}

async function legacyDELETE(req: Request, { params }: { params: Promise<{ entity: string }> }) {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const actor = { ...gate.user, permissions: gate.permissions, allowedSubsidiaryIds: gate.allowedSubsidiaryIds }
  const entityKey = (await params).entity
  const refused = await preflightSetupWrite(actor, entityKey, 'delete')
  if (refused) return setupWriteResponse(refused)
  const url = new URL(req.url)
  const id = url.searchParams.get('id') ?? ''
  const result = await deleteSetupRecord(actor, entityKey, id)
  return setupWriteResponse(result)
}

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  params: z.object({ "entity": z.string() }),
  body: requestBodySchema,
  handler: async ({ request, body, params }) => {
    const replayHeaders = new Headers(request.headers);
    replayHeaders.delete("content-length");
    const replayRequest = new Request(request.url, { method: request.method, headers: replayHeaders, body: JSON.stringify(body), signal: request.signal });
    return legacyPOST(replayRequest as never, { params: Promise.resolve(params as never) } as never);
  },
});

export const PATCH = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  params: z.object({ "entity": z.string() }),
  body: requestBodySchema,
  handler: async ({ request, body, params }) => {
    const replayHeaders = new Headers(request.headers);
    replayHeaders.delete("content-length");
    const replayRequest = new Request(request.url, { method: request.method, headers: replayHeaders, body: JSON.stringify(body), signal: request.signal });
    return legacyPATCH(replayRequest as never, { params: Promise.resolve(params as never) } as never);
  },
});

export const DELETE = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  params: z.object({ "entity": z.string() }),
  handler: async ({ request, params }) => legacyDELETE(request as never, { params: Promise.resolve(params as never) } as never),
});
