import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import { isFeatureEnabled } from "../features";
import { can, guardSubsidiaryScope } from "../authz";
import { assertApplicationPermission } from "./context";
import { ApplicationError, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  createComplianceWaiver,
  requestBodySchema as createWaiverSchema,
} from "@/app/api/compliance/waivers/route";
import {
  approveComplianceWaiver,
  revokeComplianceWaiver,
} from "@/app/api/compliance/waivers/[id]/route";
import {
  updateVendorComplianceSettings,
  requestBodySchema as vendorSettingsOptionalSchema,
} from "@/app/api/compliance/vendors/[partyId]/route";

const UUID = z.string().regex(UUID_RE).describe("UUID copied from a compliance read.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const vendorSettingsSchema = vendorSettingsOptionalSchema
  .unwrap()
  .refine(
    (settings) =>
      Object.entries(settings).some(([key, value]) => key !== "reason" && value !== undefined),
    "Provide at least one vendor compliance field to update.",
  );

function gateResponse(response: Response, fallback: string): Promise<Record<string, unknown>> {
  return response.json().then((payload: unknown) => {
    const result = payload as Record<string, unknown>;
    if (!response.ok) {
      const status = response.status;
      throw new ApplicationError(
        status === 404
          ? "not_found"
          : status === 403
            ? "forbidden"
            : status === 409
              ? "conflict"
              : "invalid_input",
        typeof result.error === "string" ? result.error : fallback,
        status,
        result,
      );
    }
    return result;
  });
}

async function requireCompliance(context: Parameters<ApplicationToolDefinition["execute"]>[0]) {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "subcontractorCompliance")))
    throw notFound("compliance record");
}

export const PURCHASING_COMPLIANCE_EXCEPTION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_compliance_waivers",
    title: "List Compliance Waivers",
    description:
      "Find temporary vendor compliance exceptions and their approval, expiry, and revocation state. Use vendor and project ids from list_records; use returned waiver ids with the exception actions.",
    inputSchema: z.object({
      partyId: UUID.optional().describe("Optional vendor party UUID filter."),
      projectId: UUID.nullable()
        .optional()
        .describe("Optional project UUID filter; null selects vendor-wide exceptions."),
      status: z
        .enum(["pending_approval", "approved", "revoked", "expired"])
        .optional()
        .describe("Optional lifecycle status filter."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "compliance.read"),
    featureKey: "subcontractorCompliance",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.read");
      await requireCompliance(context);
      const rows = await db.execute<Record<string, unknown>>(
        sql`
          select w.id, w.party_id as "partyId", p.display_name as vendor,
                 w.requirement_id as "requirementId", r.name as requirement,
                 w.project_id as "projectId", w.reason,
                 w.effective_from as "effectiveFrom", w.expires_on as "expiresOn",
                 w.requested_by as "requestedBy", w.approved_by as "approvedBy",
                 w.approved_at as "approvedAt", w.revoked_at as "revokedAt",
                 w.revoke_reason as "revokeReason",
                 case when w.revoked_at is not null then 'revoked'
                      when w.approved_at is null then 'pending_approval'
                      when w.expires_on < current_date then 'expired'
                      else 'approved' end as status,
                 p.subsidiary_id as "partySubsidiaryId", pj.subsidiary_id as "projectSubsidiaryId"
            from compliance_waivers w
            join parties p on p.id = w.party_id and p.org_id = w.org_id
            join compliance_requirements r on r.id = w.requirement_id and r.org_id = w.org_id
            left join projects pj on pj.id = w.project_id and pj.org_id = w.org_id
           where w.org_id = ${context.authz.user.orgId}
             ${input.partyId ? sql`and w.party_id = ${input.partyId}` : sql``}
             ${input.projectId !== undefined ? (input.projectId === null ? sql`and w.project_id is null` : sql`and w.project_id = ${input.projectId}`) : sql``}
           order by w.created_at desc, w.id
        `,
        "objects",
      );
      const waivers = rows
        .filter((row) => {
          if (
            guardSubsidiaryScope(context.authz, row.partySubsidiaryId as string | null, {
              orgWideNull: true,
            })
          )
            return false;
          if (
            guardSubsidiaryScope(context.authz, row.projectSubsidiaryId as string | null, {
              orgWideNull: true,
            })
          )
            return false;
          return input.status === undefined || row.status === input.status;
        })
        .map(({ partySubsidiaryId: _partyScope, projectSubsidiaryId: _projectScope, ...row }) => ({
          ...row,
          href: `/compliance/vendors?vendor=${row.partyId}`,
        }));
      return { waivers, href: "/compliance/vendors" };
    },
  }),
  definition({
    name: "request_compliance_waiver",
    title: "Request Compliance Waiver",
    description:
      "Request a time-bounded exception for a vendor requirement when the requirement is applicable and the reason is documented. Find the vendor, requirement, and optional project ids with compliance and project reads.",
    inputSchema: z.object({
      request: createWaiverSchema.describe(
        "Vendor, requirement, dates, and reason for the exception.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "compliance.waive"),
    featureKey: "subcontractorCompliance",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.waive");
      await requireCompliance(context);
      const result = await gateResponse(
        await createComplianceWaiver(context.authz, input.request),
        "Compliance waiver was refused",
      );
      const id = String(result.id);
      return {
        ok: true,
        ...result,
        id,
        href: `/compliance/vendors?vendor=${input.request.partyId}`,
      };
    },
  }),
  definition({
    name: "approve_compliance_waiver",
    title: "Approve Compliance Waiver",
    description:
      "Submit a pending exception request through its configured approval Flow. Find pending waiver ids with list_compliance_waivers.",
    inputSchema: z.object({ waiverId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "compliance.waive"),
    featureKey: "subcontractorCompliance",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.waive");
      await requireCompliance(context);
      const result = await gateResponse(
        await approveComplianceWaiver(context.authz, { id: input.waiverId }, { action: "approve" }),
        "Compliance waiver approval was refused",
      );
      const party = await db.execute<{ partyId: string }>(
        sql`select party_id as "partyId" from compliance_waivers where org_id = ${context.authz.user.orgId} and id = ${input.waiverId}`,
        "objects",
      );
      if (!party[0]) throw notFound("compliance waiver");
      return {
        ok: true,
        ...result,
        id: input.waiverId,
        href: `/compliance/vendors?vendor=${party[0].partyId}`,
      };
    },
  }),
  definition({
    name: "revoke_compliance_waiver",
    title: "Revoke Compliance Waiver",
    description:
      "Revoke an approved exception with a recorded reason; the exception row remains in audit history. Find waiver ids and current state with list_compliance_waivers.",
    inputSchema: z.object({
      waiverId: UUID,
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason the approved exception is revoked."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "compliance.waive"),
    featureKey: "subcontractorCompliance",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.waive");
      await requireCompliance(context);
      const result = await gateResponse(
        await revokeComplianceWaiver(
          context.authz,
          { id: input.waiverId },
          { reason: input.reason },
        ),
        "Compliance waiver revocation was refused",
      );
      const party = await db.execute<{ partyId: string }>(
        sql`select party_id as "partyId" from compliance_waivers where org_id = ${context.authz.user.orgId} and id = ${input.waiverId}`,
        "objects",
      );
      if (!party[0]) throw notFound("compliance waiver");
      return {
        ok: true,
        ...result,
        id: input.waiverId,
        status: "revoked",
        href: `/compliance/vendors?vendor=${party[0].partyId}`,
      };
    },
  }),
  definition({
    name: "update_vendor_compliance_settings",
    title: "Update Vendor Compliance Settings",
    description:
      "Update the vendor's compliance classification or year-end information-return settings; each field requires its corresponding organization feature to be enabled. Find vendor ids with list_records and verify on the vendor compliance drawer.",
    inputSchema: z.object({
      partyId: UUID,
      settings: vendorSettingsSchema.describe("Vendor compliance fields to update."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "compliance.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.manage");
      const result = await gateResponse(
        await updateVendorComplianceSettings(
          context.authz,
          { partyId: input.partyId },
          input.settings,
        ),
        "Vendor compliance settings were refused",
      );
      return {
        ok: true,
        ...result,
        id: input.partyId,
        href: `/compliance/vendors?vendor=${input.partyId}`,
      };
    },
  }),
];
