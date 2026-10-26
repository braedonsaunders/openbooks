import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { isUuid } from "@/lib/list-params";
import {
  createSetupRecord,
  deleteSetupRecord,
  preflightSetupWrite,
  updateSetupRecord,
  type SetupWriteResult,
} from "@/lib/setup/write";

export const runtime = "nodejs";

// Benefits setup uses the native registry's validation, scope, idempotency,
// and audit commands. HR management authorizes only these Benefits entities;
// it does not grant access to the general configuration API.
const params = z.object({
  entity: z.enum([
    "benefit-plans",
    "benefit-contribution-rules",
    "benefit-contribution-classes",
    "benefit-contribution-tiers",
    "benefit-contribution-rule-components",
    "benefit-recovery-sources",
    "benefit-enrollment-configuration",
    "benefit-enrollment-terms",
    "entitlement-plans",
    "entitlement-plan-limits",
    "entitlement-service-tiers",
    "payroll-vacation-terms",
    "payroll-service-credits",
  ]),
});
const requestBody = z.record(z.string(), z.json());
const response = (result: SetupWriteResult) =>
  NextResponse.json(result.body, { status: result.status });
const actorFrom = (authz: {
  user: { orgId: string; id: string };
  permissions: ReadonlySet<string>;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}) => ({
  ...authz.user,
  permissions: authz.permissions,
  allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
});
const requestIdFrom = (request: Request) => request.headers.get("Idempotency-Key")?.trim() ?? "";
const invalidRequestId = (request: Request) =>
  isUuid(requestIdFrom(request))
    ? null
    : NextResponse.json(
        { error: "Idempotency-Key must be a UUID", code: "invalid" },
        { status: 400 },
      );
const preflight = async (
  authz: Parameters<typeof actorFrom>[0],
  entity: string,
  method: "create" | "update" | "delete",
) => {
  const refused = await preflightSetupWrite(actorFrom(authz), entity, method);
  return refused ? response(refused) : undefined;
};

export const POST = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  params,
  body: requestBody,
  beforeBody: async ({ request, params, authz }) => {
    const invalid = invalidRequestId(request);
    if (invalid) return invalid;
    return preflight(authz, params.entity, "create");
  },
  handler: async ({ request, params, authz, body }) => {
    const actor = actorFrom(authz);
    return response(
      await createSetupRecord(actor, params.entity, body, { requestId: requestIdFrom(request) }),
    );
  },
});

export const PATCH = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  params,
  body: requestBody,
  beforeBody: async ({ params, authz }) => preflight(authz, params.entity, "update"),
  handler: async ({ params, authz, body }) => {
    return response(await updateSetupRecord(actorFrom(authz), params.entity, body));
  },
});

export const DELETE = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  params,
  handler: async ({ request, params, authz }) => {
    const actor = actorFrom(authz);
    const refused = await preflightSetupWrite(actor, params.entity, "delete");
    if (refused) return response(refused);
    return response(
      await deleteSetupRecord(
        actor,
        params.entity,
        new URL(request.url).searchParams.get("id") ?? "",
      ),
    );
  },
});
