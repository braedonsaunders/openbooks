import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";

import { NextResponse } from "next/server";
import { createUserScript, updateUserScript } from "@openbooks/engine/scripting/admin";
import {
  computeScheduledScriptNextRunAt,
  INVALID_SCHEDULED_SCRIPT_CRON_CODE,
  scriptSaveRefusal,
} from "@openbooks/engine/scripting/scripting";
import {
  validateScriptConfiguration as validate,
  type ScriptValidationError as ValidationError,
} from "@openbooks/engine/scripting/script-config";
import {
  assertProductionEnvForScheduledScript,
  SCHEDULED_SCRIPT_NON_PRODUCTION_CODE,
  ScheduledScriptNonProductionError,
} from "@openbooks/engine/scripting/scheduled-env";

import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";

const scriptWriteFields = {
  name: z.string().trim().min(1).max(200),
  triggerPoint: z.enum([
    "before_submit",
    "before_post",
    "after_post",
    "before_void",
    "custom_gl_lines",
    "scheduled",
    "endpoint",
    "bulk",
    "client",
  ]),
  source: z.string().min(1).max(100_000),
  documentKind: z.string().trim().min(1).nullable().optional(),
  endpointSlug: z.string().max(80).nullable().optional(),
  cron: z.string().max(200).nullable().optional(),
  isActive: z.boolean().optional(),
  timeoutMs: z.number().int().min(1).max(10_000).optional(),
  sortOrder: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
};
const createScriptBodySchema = z.object(scriptWriteFields);
// The id is checked by the handler, which answers a malformed id with the same
// 404 as an unknown script; a uuid constraint here would refuse it first with 400.
const updateScriptBodySchema = z.object({ id: z.string(), ...scriptWriteFields });

export const runtime = "nodejs";

/** The schedule would never fire outside production — refuse by name, nothing written. */
function nonProductionResponse(error: ScheduledScriptNonProductionError): Promise<NextResponse> {
  return apiErrorResponse(error, {
    safeStatus: 409,
    details: { code: SCHEDULED_SCRIPT_NON_PRODUCTION_CODE, envKind: error.envKind },
  });
}

/**
 * Script configuration validation travels as data, not a thrown error, so
 * the sanitizer cannot type-refuse it: carry it in a named refusal with the
 * status the code selects, keeping the machine-readable code and field.
 */
class ScriptValidationRefusal extends Error {
  readonly code?: string;
  readonly field?: string;
  constructor(
    failure: ValidationError,
    readonly status: number,
  ) {
    super(failure.message);
    this.name = "ScriptValidationRefusal";
    this.code = failure.code;
    this.field = failure.field;
  }
}

/**
 * A saved script runs its unattended executions (schedules, bulk runs, system
 * postings) under its saver's live permissions, so the saver must hold what
 * the script plainly calls. Endpoint scripts always run as their caller.
 */
class ScriptAuthorityRefusal extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "ScriptAuthorityRefusal";
  }
}

async function saverRefusal(
  orgId: string,
  saverId: string,
  body: { triggerPoint: string; source: string },
): Promise<NextResponse | null> {
  if (body.triggerPoint === "endpoint") return null;
  const refusal = await scriptSaveRefusal(orgId, saverId, body.source);
  return refusal ? apiErrorResponse(new ScriptAuthorityRefusal(refusal)) : null;
}

function validationResponse(error: ValidationError): Promise<NextResponse> {
  const refusal = new ScriptValidationRefusal(
    error,
    error.code === INVALID_SCHEDULED_SCRIPT_CRON_CODE ? 422 : 400,
  );
  return apiErrorResponse(refusal, { details: { code: refusal.code, field: refusal.field } });
}

export const POST = defineRoute({
  permission: "scripts.manage",
  feature: "scripts",
  body: createScriptBodySchema,
  handler: async ({ request, body, authz: routeAuthz }) => {
    const gate = routeAuthz;

    const user = gate.user;

    const err = validate(body);
    if (err) return validationResponse(err);
    const refused = await saverRefusal(user.orgId, user.id, body);
    if (refused) return refused;

    const cron = body.triggerPoint === "scheduled" ? String(body.cron ?? "").trim() : null;
    const nextRunAt =
      cron && body.isActive !== false ? computeScheduledScriptNextRunAt(cron) : null;
    const slug = body.triggerPoint === "endpoint" ? String(body.endpointSlug ?? "").trim() : null;
    // Creating an ACTIVE schedule outside production would never fire (the
    // scanner only reads production orgs) — refuse by name before writing.
    // Inactive scheduled scripts and other trigger points are unaffected.
    if (cron && body.isActive !== false) {
      try {
        await assertProductionEnvForScheduledScript(user.orgId);
      } catch (error) {
        if (error instanceof ScheduledScriptNonProductionError) return nonProductionResponse(error);
        throw error;
      }
    }
    // A script can mint or mutate posted documents on every matching event, so
    // its creation is audited with the full row in the same transaction.
    const result = await createUserScript({
      orgId: user.orgId,
      actorId: user.id,
      requestId: request.headers.get("X-Request-Id"),
      input: { ...body, endpointSlug: slug, cron },
      nextRunAt,
    });
    if (result.kind === "feature_disabled") return notFound("record");
    return NextResponse.json({ id: String(result.row.id) });
  },
});

export const PATCH = defineRoute({
  permission: "scripts.manage",
  feature: "scripts",
  body: updateScriptBodySchema,
  handler: async ({ request, body, authz: routeAuthz }) => {
    const gate = routeAuthz;

    const user = gate.user;

    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    // A malformed id names nothing: same answer as an unknown script, never a
    // PostgreSQL uuid cast error escaping as a 500.
    if (typeof body.id !== "string" || !isUuid(body.id)) {
      return notFound("record");
    }
    const err = validate(body);
    if (err) return validationResponse(err);
    const refused = await saverRefusal(user.orgId, user.id, body);
    if (refused) return refused;

    const cron = body.triggerPoint === "scheduled" ? String(body.cron ?? "").trim() : null;
    const slug = body.triggerPoint === "endpoint" ? String(body.endpointSlug ?? "").trim() : null;
    try {
      const result = await updateUserScript({
        orgId: user.orgId,
        actorId: user.id,
        requestId: request.headers.get("X-Request-Id"),
        id: body.id,
        input: { ...body, endpointSlug: slug, cron },
      });
      if (result.kind === "feature_disabled" || result.kind === "missing")
        return notFound("record");
    } catch (error) {
      if (error instanceof ScheduledScriptNonProductionError) return nonProductionResponse(error);
      throw error;
    }
    return NextResponse.json({ ok: true });
  },
});
