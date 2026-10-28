import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  ensureFiling,
  finalizeFiling,
  FORM_TYPES,
  InformationReturnError,
  markFilingFiled,
  recomputeFiling,
  stampRecipientCopiesPrinted,
  updateFilingRecipient,
  voidFiling,
  type FormType,
} from "@openbooks/engine/compliance/information-returns";
import { can, guardSubsidiaryScope } from "../authz";
import { isFeatureEnabled } from "../features";
import { loadFiling, loadFilings, loadInformationReturnFilingScope } from "../compliance";
import { assertApplicationPermission } from "./context";
import { ApplicationError, forbidden, notFound } from "./errors";
import type { ApplicationContext } from "./context";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  createComplianceEvidence,
  requestBodySchema as createCertificateBodySchema,
} from "@/app/api/compliance/records/route";
import {
  actOnComplianceEvidence,
  requestBodySchema as certificateActionBodySchema,
} from "@/app/api/compliance/records/[id]/route";
import { loadLienWaivers } from "../compliance";
import {
  createLienWaiver,
  requestBodySchema as lienWaiverCreateBodySchema,
} from "@/app/api/compliance/lien-waivers/route";
import {
  actOnLienWaiver,
  requestBodySchema as lienWaiverActionBodySchema,
} from "@/app/api/compliance/lien-waivers/[id]/route";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from an information-return filing read.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const AMOUNT = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,4})?$/)
  .describe("Exact monetary amount as decimal text; never use a JSON number.");

function settleInformationReturnRefusal(error: unknown): never {
  if (error instanceof InformationReturnError) {
    const status = error.status;
    throw new ApplicationError(
      status === 404 ? "not_found" : status === 409 ? "conflict" : "invalid_input",
      error.message,
      status,
    );
  }
  throw error;
}

async function requireFeature(context: ApplicationContext): Promise<void> {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "informationReturns"))) {
    throw notFound("information-return filing");
  }
}

async function requireFilingScope(context: ApplicationContext, filingId: string): Promise<void> {
  const scope = await loadInformationReturnFilingScope(context.authz.user.orgId, filingId);
  if (!scope) throw notFound("information-return filing");
  const denied = guardSubsidiaryScope(context.authz, scope.subsidiaryId);
  if (denied) throw forbidden("subsidiary.restricted");
}

async function certificateResponse(response: Response): Promise<Record<string, unknown>> {
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const status = response.status;
    const code =
      status === 404
        ? "not_found"
        : status === 403
          ? "forbidden"
          : status === 409
            ? "conflict"
            : "invalid_input";
    throw new ApplicationError(
      code,
      typeof payload.error === "string" ? payload.error : "Certificate action was refused",
      status,
      payload,
    );
  }
  return payload;
}

async function requireComplianceFeature(context: ApplicationContext): Promise<void> {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "subcontractorCompliance"))) {
    throw notFound("compliance record");
  }
}

async function requireLienWaiverFeatures(context: ApplicationContext): Promise<void> {
  await requireComplianceFeature(context);
  if (!(await isFeatureEnabled(context.authz.user.orgId, "projects"))) {
    throw notFound("lien waiver");
  }
}

async function lienWaiverResponse(response: Response): Promise<Record<string, unknown>> {
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const status = response.status;
    const code =
      status === 404
        ? "not_found"
        : status === 403
          ? "forbidden"
          : status === 409
            ? "conflict"
            : "invalid_input";
    throw new ApplicationError(
      code,
      typeof payload.error === "string" ? payload.error : "Lien-waiver action was refused",
      status,
      payload,
    );
  }
  return payload;
}

export const PURCHASING_COMPLIANCE_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_information_return_filings",
    title: "List Information Return Filings",
    description:
      "List information-return filings visible in your subsidiary scope and their current status. Use the returned ids with get_information_return_filing before computing, finalizing, filing, or voiding.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "compliance.read"),
    featureKey: "informationReturns",
    execute: async (context) => {
      assertApplicationPermission(context, "compliance.read");
      await requireFeature(context);
      return {
        filings: await loadFilings(context.authz.user.orgId, context.authz.allowedSubsidiaryIds),
        href: "/compliance/information-returns",
      };
    },
  }),
  definition({
    name: "get_information_return_filing",
    title: "Get Information Return Filing",
    description:
      "Read one filing, recipient amounts, adjustments, and readiness state before changing it. Find its id with list_information_return_filings.",
    inputSchema: z.object({
      filingId: UUID.describe("Filing UUID from list_information_return_filings."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "compliance.read"),
    featureKey: "informationReturns",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.read");
      await requireFeature(context);
      const filing = await loadFiling(
        context.authz.user.orgId,
        input.filingId,
        context.authz.allowedSubsidiaryIds,
      );
      if (!filing) throw notFound("information-return filing");
      return { filing, href: `/compliance/information-returns/${input.filingId}` };
    },
  }),
  definition({
    name: "open_information_return_filing",
    title: "Open Information Return Filing",
    description:
      "Open a draft filing for a completed tax year and form, scoped to one accessible legal entity when needed. A filing is unique per year, form, and entity; verify it with get_information_return_filing.",
    inputSchema: z.object({
      formType: z.enum(FORM_TYPES).describe("Installed information-return form."),
      taxYear: z.number().int().min(1990).max(2200).describe("Completed calendar tax year."),
      subsidiaryId: UUID.nullable()
        .optional()
        .describe("Legal-entity UUID, or null for an organization-wide filing."),
      threshold: AMOUNT.optional().describe("Optional exact reporting threshold override."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "compliance.manage"),
    featureKey: "informationReturns",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.manage");
      const orgId = context.authz.user.orgId;
      await requireFeature(context);
      const taxYear = Number(input.taxYear);
      const currentYear = Number((await businessToday(orgId)).slice(0, 4));
      if (taxYear >= currentYear)
        throw new ApplicationError(
          "invalid_input",
          "only completed tax years can be filed — that tax year has not ended yet",
          422,
        );
      const subsidiaryId = input.subsidiaryId ?? null;
      const denied = guardSubsidiaryScope(context.authz, subsidiaryId);
      if (denied) throw forbidden("subsidiary.restricted");
      if (subsidiaryId !== null) {
        const active = await db.execute<{ id: string }>(
          sql`select id from subsidiaries where id = ${subsidiaryId} and org_id = ${orgId} and is_active`,
          "objects",
        );
        if (!active[0]) throw notFound("subsidiary");
      }
      if (input.threshold !== undefined) {
        const whole = input.threshold.split(".")[0]!.replace(/^[+-]?0*/, "");
        if (whole.length > 15)
          throw new ApplicationError(
            "invalid_input",
            "Threshold is out of range — at most 15 whole digits fit the ledger",
            422,
          );
      }
      try {
        const filing = await ensureFiling({
          orgId,
          taxYear,
          formType: input.formType as FormType,
          subsidiaryId,
          threshold: input.threshold,
          actorId: context.authz.user.id,
        });
        return {
          ok: true,
          ...filing,
          status: filing.status,
          href: `/compliance/information-returns/${filing.id}`,
        };
      } catch (error) {
        settleInformationReturnRefusal(error);
      }
    },
  }),
  definition({
    name: "compute_information_return_filing",
    title: "Compute Information Return Filing",
    description:
      "Recompute a draft or computed filing from posted payments, preserving explicit recipient adjustments and exclusions. Find its id and status with get_information_return_filing.",
    inputSchema: z.object({
      filingId: UUID.describe("Draft or computed filing UUID."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "compliance.manage"),
    featureKey: "informationReturns",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.manage");
      await requireFeature(context);
      await requireFilingScope(context, input.filingId);
      const orgId = context.authz.user.orgId;
      try {
        const computed = await recomputeFiling({
          orgId,
          filingId: input.filingId,
          actorId: context.authz.user.id,
        });
        await db.execute(
          sql`insert into audit_log(org_id, table_name, row_id, action, changes, actor_id) values (${orgId}, 'information_return_filings', ${input.filingId}, 'compute', ${JSON.stringify({ after: { action: "compute" } })}::jsonb, ${context.authz.user.id})`,
        );
        const filing = await loadFiling(orgId, input.filingId, context.authz.allowedSubsidiaryIds);
        if (!filing) throw notFound("information-return filing");
        return {
          ok: true,
          ...computed,
          filing,
          status: filing.status,
          href: `/compliance/information-returns/${input.filingId}`,
        };
      } catch (error) {
        settleInformationReturnRefusal(error);
      }
    },
  }),
  definition({
    name: "finalize_information_return_filing",
    title: "Finalize Information Return Filing",
    description:
      "Freeze a computed filing after its exceptions are resolved and a reviewer is authorized to attest to the statutory position. Find its id and exceptions with get_information_return_filing.",
    inputSchema: z.object({
      filingId: UUID.describe("Computed filing UUID."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "compliance.file"),
    featureKey: "informationReturns",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.file");
      await requireFeature(context);
      await requireFilingScope(context, input.filingId);
      const orgId = context.authz.user.orgId;
      try {
        await finalizeFiling({ orgId, filingId: input.filingId, actorId: context.authz.user.id });
        await db.execute(
          sql`insert into audit_log(org_id, table_name, row_id, action, changes, actor_id) values (${orgId}, 'information_return_filings', ${input.filingId}, 'finalize', ${JSON.stringify({ after: { action: "finalize" } })}::jsonb, ${context.authz.user.id})`,
        );
        const filing = await loadFiling(orgId, input.filingId, context.authz.allowedSubsidiaryIds);
        if (!filing) throw notFound("information-return filing");
        return {
          ok: true,
          filing,
          status: filing.status,
          href: `/compliance/information-returns/${input.filingId}`,
        };
      } catch (error) {
        settleInformationReturnRefusal(error);
      }
    },
  }),
  definition({
    name: "mark_information_return_filed",
    title: "Mark Information Return Filed",
    description:
      "Record that a finalized filing was transmitted or delivered to an authority. The filing must already be finalized; find it with get_information_return_filing.",
    inputSchema: z.object({
      filingId: UUID.describe("Finalized filing UUID."),
      channel: z
        .enum(["iris", "fire", "paper", "provider", "other"])
        .describe("Filing or delivery channel."),
      reference: z
        .string()
        .trim()
        .max(200)
        .nullable()
        .optional()
        .describe("Optional filing confirmation or transmission reference."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "compliance.file"),
    featureKey: "informationReturns",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.file");
      await requireFeature(context);
      await requireFilingScope(context, input.filingId);
      const orgId = context.authz.user.orgId;
      try {
        await markFilingFiled({
          orgId,
          filingId: input.filingId,
          channel: input.channel,
          reference: input.reference ?? null,
          actorId: context.authz.user.id,
        });
        const afterBody = {
          action: "file",
          channel: input.channel,
          ...(input.reference === undefined ? {} : { reference: input.reference }),
        };
        await db.execute(
          sql`insert into audit_log(org_id, table_name, row_id, action, changes, actor_id) values (${orgId}, 'information_return_filings', ${input.filingId}, 'file', ${JSON.stringify({ after: afterBody })}::jsonb, ${context.authz.user.id})`,
        );
        const filing = await loadFiling(orgId, input.filingId, context.authz.allowedSubsidiaryIds);
        if (!filing) throw notFound("information-return filing");
        return {
          ok: true,
          filing,
          status: filing.status,
          href: `/compliance/information-returns/${input.filingId}`,
        };
      } catch (error) {
        settleInformationReturnRefusal(error);
      }
    },
  }),
  definition({
    name: "void_information_return_filing",
    title: "Void Information Return Filing",
    description:
      "Void a filing that has not been transmitted, retaining its audit history. Filed returns cannot be voided; find its id and state with get_information_return_filing.",
    inputSchema: z.object({
      filingId: UUID.describe("Filing UUID."),
      reason: z.string().trim().min(1).max(2000).describe("Reason for voiding the filing."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "compliance.file"),
    featureKey: "informationReturns",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.file");
      await requireFeature(context);
      await requireFilingScope(context, input.filingId);
      const orgId = context.authz.user.orgId;
      try {
        await voidFiling({
          orgId,
          filingId: input.filingId,
          actorId: context.authz.user.id,
          reason: input.reason,
        });
        const filing = await loadFiling(orgId, input.filingId, context.authz.allowedSubsidiaryIds);
        return {
          ok: true,
          id: input.filingId,
          filing,
          status: filing?.status ?? "void",
          href: `/compliance/information-returns/${input.filingId}`,
        };
      } catch (error) {
        settleInformationReturnRefusal(error);
      }
    },
  }),
  definition({
    name: "update_information_return_recipient",
    title: "Update Information Return Recipient",
    description:
      "Adjust exact box amounts or include or exclude a recipient while the filing is draft or computed. Find recipient ids and current adjustments with get_information_return_filing.",
    inputSchema: z.object({
      filingId: UUID.describe("Draft or computed filing UUID."),
      recipientId: UUID.describe("Recipient UUID from the filing read."),
      adjustments: z
        .record(z.string().max(50), AMOUNT)
        .optional()
        .describe("Exact decimal adjustments by valid form box key."),
      adjustmentReason: z
        .string()
        .trim()
        .max(2000)
        .nullable()
        .optional()
        .describe("Required reason when non-zero adjustments are supplied."),
      status: z.enum(["included", "excluded"]).optional().describe("Recipient inclusion status."),
      exclusionReason: z
        .string()
        .trim()
        .max(2000)
        .nullable()
        .optional()
        .describe("Required reason when excluding a recipient."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "compliance.manage"),
    featureKey: "informationReturns",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.manage");
      await requireFeature(context);
      await requireFilingScope(context, input.filingId);
      try {
        await updateFilingRecipient({
          orgId: context.authz.user.orgId,
          filingId: input.filingId,
          recipientId: input.recipientId,
          actorId: context.authz.user.id,
          adjustments: input.adjustments,
          adjustmentReason: input.adjustmentReason ?? null,
          status: input.status,
          exclusionReason: input.exclusionReason ?? null,
        });
        const filing = await loadFiling(
          context.authz.user.orgId,
          input.filingId,
          context.authz.allowedSubsidiaryIds,
        );
        if (!filing) throw notFound("information-return filing");
        return {
          ok: true,
          filing,
          status: filing.status,
          href: `/compliance/information-returns/${input.filingId}`,
        };
      } catch (error) {
        settleInformationReturnRefusal(error);
      }
    },
  }),
  definition({
    name: "furnish_information_return_copies",
    title: "Furnish Information Return Copies",
    description:
      "Record that Copy B forms were furnished for an already finalized or filed return. Optionally target one included recipient; find filing and recipient ids with get_information_return_filing.",
    inputSchema: z.object({
      filingId: UUID.describe("Finalized or filed return UUID."),
      recipientId: UUID.optional().describe(
        "Optional included recipient UUID; omit to record all included recipients.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "compliance.manage"),
    featureKey: "informationReturns",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.manage");
      await requireFeature(context);
      await requireFilingScope(context, input.filingId);
      try {
        const furnished = await stampRecipientCopiesPrinted({
          orgId: context.authz.user.orgId,
          filingId: input.filingId,
          recipientId: input.recipientId,
          actorId: context.authz.user.id,
        });
        return {
          ok: true,
          id: input.filingId,
          furnished,
          status: "furnished",
          href: `/compliance/information-returns/${input.filingId}`,
        };
      } catch (error) {
        settleInformationReturnRefusal(error);
      }
    },
  }),
  definition({
    name: "list_subcontractor_certificates",
    title: "List Subcontractor Certificates",
    description:
      "Review a vendor's insurance and compliance certificates, including expiry and approval revisions, before requesting a renewal or attesting to coverage. Find the vendor id with list_records or get_record.",
    inputSchema: z.object({ partyId: UUID.describe("Vendor party UUID.") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "compliance.read"),
    featureKey: "subcontractorCompliance",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.read");
      await requireComplianceFeature(context);
      const party = await db.execute<{ subsidiaryId: string | null }>(
        sql`select subsidiary_id as "subsidiaryId" from parties where org_id = ${context.authz.user.orgId} and id = ${input.partyId}`,
        "objects",
      );
      if (!party[0]) throw notFound("vendor");
      const denied = guardSubsidiaryScope(context.authz, party[0].subsidiaryId, {
        orgWideNull: true,
      });
      if (denied) throw forbidden("subsidiary.restricted");
      const records = await db.execute<Record<string, unknown>>(
        sql`
        select c.id, c.requirement_id as "requirementId", r.name as "requirementName",
               c.project_id as "projectId", c.status, c.issuer_name as "issuerName",
               c.policy_number as "policyNumber", c.effective_from as "effectiveFrom",
               c.expires_on as "expiresOn", c.coverage_amount as "coverageAmount",
               c.aggregate_amount as "aggregateAmount", c.coverage_currency as "coverageCurrency",
               c.additional_insured as "additionalInsured", c.waiver_of_subrogation as "waiverOfSubrogation",
               c.primary_noncontributory as "primaryNoncontributory", c.notes,
               c.revision, c.verified_revision as "verifiedRevision"
          from compliance_records c
          join compliance_requirements r on r.id = c.requirement_id and r.org_id = c.org_id
          left join projects pj on pj.id = c.project_id and pj.org_id = c.org_id
         where c.org_id = ${context.authz.user.orgId} and c.party_id = ${input.partyId}
           and c.status <> 'superseded'
           ${context.authz.allowedSubsidiaryIds === null ? sql`` : context.authz.allowedSubsidiaryIds.size === 0 ? sql`and false` : sql`and (pj.subsidiary_id is null or pj.subsidiary_id = any(${`{${[...context.authz.allowedSubsidiaryIds].join(",")}}`}::uuid[]))`}
         order by c.expires_on nulls last, c.effective_from desc, c.id
      `,
        "objects",
      );
      return {
        records: records.map((record) => ({
          ...record,
          href: `/compliance/vendors?vendor=${input.partyId}`,
        })),
        href: `/compliance/vendors?vendor=${input.partyId}`,
      };
    },
  }),
  definition({
    name: "receive_subcontractor_certificate",
    title: "Receive Subcontractor Certificate",
    description:
      "Record a new certificate as pending review for an applicable vendor requirement; evidence never becomes accepted until a separate verifier attests to it. Find vendor and requirement ids with compliance reads and list_records.",
    inputSchema: z.object({
      evidence: createCertificateBodySchema.describe(
        "Certificate values and the vendor requirement they support.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "compliance.manage"),
    featureKey: "subcontractorCompliance",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.manage");
      await requireComplianceFeature(context);
      const result = await certificateResponse(
        await createComplianceEvidence(context.authz, input.evidence),
      );
      const id = String(result.id);
      return {
        ok: true,
        ...result,
        status: "pending_review",
        href: `/compliance/vendors?vendor=${input.evidence.partyId}`,
        id,
      };
    },
  }),
  ...(["verify", "reject", "reopen", "update"] as const).map((action) => {
    const permission = action === "update" ? "compliance.manage" : "compliance.verify";
    const name = `${action}_subcontractor_certificate`;
    const title = `${action[0]!.toUpperCase()}${action.slice(1)} Subcontractor Certificate`;
    const actionSchema =
      action === "verify"
        ? z.object({
            revision: z
              .number()
              .int()
              .positive()
              .describe("Certificate revision copied from the read."),
          })
        : action === "reject"
          ? z.object({
              revision: z
                .number()
                .int()
                .positive()
                .describe("Certificate revision copied from the read."),
              reason: z
                .string()
                .trim()
                .min(1)
                .max(2000)
                .describe("Reason the certificate does not satisfy its requirement."),
            })
          : action === "reopen"
            ? z.object({
                revision: z
                  .number()
                  .int()
                  .positive()
                  .describe("Certificate revision copied from the read."),
              })
            : z
                .object({
                  revision: z
                    .number()
                    .int()
                    .positive()
                    .describe("Certificate revision copied from the read."),
                  issuerName: z
                    .string()
                    .trim()
                    .max(200)
                    .nullable()
                    .optional()
                    .describe("Updated certificate issuer."),
                  policyNumber: z
                    .string()
                    .trim()
                    .max(200)
                    .nullable()
                    .optional()
                    .describe("Updated policy number."),
                  effectiveFrom: z
                    .string()
                    .regex(/^\d{4}-\d{2}-\d{2}$/)
                    .nullable()
                    .optional()
                    .describe("Updated coverage start date."),
                  expiresOn: z
                    .string()
                    .regex(/^\d{4}-\d{2}-\d{2}$/)
                    .nullable()
                    .optional()
                    .describe("Updated coverage expiry date."),
                  coverageAmount: AMOUNT.nullable()
                    .optional()
                    .describe("Updated exact coverage amount."),
                  aggregateAmount: AMOUNT.nullable()
                    .optional()
                    .describe("Updated exact aggregate amount."),
                  coverageCurrency: z
                    .string()
                    .regex(/^[A-Z]{3}$/)
                    .nullable()
                    .optional()
                    .describe("Updated coverage currency."),
                  additionalInsured: z
                    .boolean()
                    .nullable()
                    .optional()
                    .describe("Updated additional-insured evidence."),
                  waiverOfSubrogation: z
                    .boolean()
                    .nullable()
                    .optional()
                    .describe("Updated waiver-of-subrogation evidence."),
                  primaryNoncontributory: z
                    .boolean()
                    .nullable()
                    .optional()
                    .describe("Updated primary and noncontributory evidence."),
                  notes: z
                    .string()
                    .trim()
                    .max(2000)
                    .nullable()
                    .optional()
                    .describe("Updated certificate notes."),
                })
                .refine(
                  (body) =>
                    Object.keys(body).some(
                      (key) => key !== "revision" && body[key as keyof typeof body] !== undefined,
                    ),
                  "Provide at least one certificate field to update.",
                );
    return definition({
      name,
      title,
      description: `${action === "verify" ? "Attest that" : action === "reject" ? "Reject" : action === "reopen" ? "Reopen" : "Edit"} a certificate while respecting its current review state and revision. Find certificate ids and revisions with list_subcontractor_certificates.`,
      inputSchema: z.object({
        certificateId: UUID.describe("Certificate UUID from the vendor's certificate list."),
        change: actionSchema.describe("Fields required for this certificate action."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      readOnly: false,
      destructive: action === "reject",
      openWorld: false,
      assistantConfirmation: "always",
      visibleTo: (authz) => can(authz, permission),
      featureKey: "subcontractorCompliance",
      execute: async (context, input) => {
        assertApplicationPermission(context, permission);
        await requireComplianceFeature(context);
        const body = { action, ...input.change } as z.infer<typeof certificateActionBodySchema>;
        const result = await certificateResponse(
          await actOnComplianceEvidence({ id: input.certificateId }, context.authz, body),
        );
        const party = await db.execute<{ id: string }>(
          sql`select party_id as id from compliance_records where org_id = ${context.authz.user.orgId} and id = ${input.certificateId}`,
          "objects",
        );
        if (!party[0]) throw notFound("certificate");
        return {
          ok: true,
          ...result,
          status:
            result.status ??
            (action === "verify"
              ? "active"
              : action === "reject"
                ? "rejected"
                : action === "reopen"
                  ? "pending_review"
                  : undefined),
          href: `/compliance/vendors?vendor=${party[0].id}`,
        };
      },
    });
  }),
  definition({
    name: "list_lien_waivers",
    title: "List Lien Waivers",
    description:
      "Find received or issued lien waivers by vendor, project, status, or direction. The result includes the ids and lifecycle state used by the waiver actions.",
    inputSchema: z.object({
      direction: z.enum(["received", "issued"]).optional().describe("Optional waiver direction."),
      status: z
        .enum(["draft", "requested", "received", "signed", "rejected", "void"])
        .optional()
        .describe("Optional waiver status filter."),
      projectId: UUID.optional().describe("Optional project UUID filter."),
      partyId: UUID.optional().describe("Optional vendor UUID filter."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "compliance.read"),
    featureKey: "subcontractorCompliance",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.read");
      await requireLienWaiverFeatures(context);
      const waivers = await loadLienWaivers({
        orgId: context.authz.user.orgId,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        direction: input.direction ?? null,
        status: input.status ?? null,
        projectId: input.projectId ?? null,
        partyId: input.partyId ?? null,
      });
      return {
        waivers: waivers.map((waiver) => ({
          ...waiver,
          href: `/compliance/lien-waivers?waiver=${waiver.id}`,
        })),
        href: "/compliance/lien-waivers",
      };
    },
  }),
  definition({
    name: "create_lien_waiver",
    title: "Create Lien Waiver",
    description:
      "Create a draft lien waiver for a project and vendor, using a covered bill amount when one is linked. Find project, party, bill, and pay-application ids with the project, party, AP, and subcontract reads.",
    inputSchema: z.object({
      waiver: lienWaiverCreateBodySchema.describe(
        "Waiver parties, project, date, type, and exact amount.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "compliance.manage"),
    featureKey: "subcontractorCompliance",
    execute: async (context, input) => {
      assertApplicationPermission(context, "compliance.manage");
      await requireLienWaiverFeatures(context);
      const result = await lienWaiverResponse(await createLienWaiver(context.authz, input.waiver));
      const id = String(result.id);
      const rows = await loadLienWaivers({
        orgId: context.authz.user.orgId,
        id,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
      });
      if (!rows[0]) throw notFound("lien waiver");
      return {
        ok: true,
        ...result,
        waiver: rows[0],
        status: rows[0].status,
        href: `/compliance/lien-waivers?waiver=${id}`,
      };
    },
  }),
  ...(
    [
      {
        action: "request",
        name: "request_lien_waiver",
        title: "Request Lien Waiver",
        destructive: false,
        schema: z.object({}),
      },
      {
        action: "receive",
        name: "receive_lien_waiver",
        title: "Receive Lien Waiver",
        destructive: false,
        schema: z.object({}),
      },
      {
        action: "sign",
        name: "sign_lien_waiver",
        title: "Sign Lien Waiver",
        destructive: false,
        schema: z.object({
          signedByName: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .describe("Name of the person who signed the waiver."),
          signedByTitle: z
            .string()
            .trim()
            .max(200)
            .nullable()
            .optional()
            .describe("Optional signer's title."),
          signedAt: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullable()
            .optional()
            .describe("Date signed in YYYY-MM-DD format; omitted uses business today."),
          notarized: z
            .boolean()
            .nullable()
            .optional()
            .describe("Whether the recorded signature was notarized."),
        }),
      },
      {
        action: "reject",
        name: "reject_lien_waiver",
        title: "Reject Lien Waiver",
        destructive: true,
        schema: z.object({
          reason: z
            .string()
            .trim()
            .min(1)
            .max(2000)
            .describe("Reason the submitted waiver is unacceptable."),
        }),
      },
      {
        action: "void",
        name: "void_lien_waiver",
        title: "Void Lien Waiver",
        destructive: true,
        schema: z.object({
          reason: z
            .string()
            .trim()
            .min(1)
            .max(2000)
            .describe("Reason the waiver is voided; retained in audit history."),
        }),
      },
      {
        action: "update",
        name: "update_lien_waiver",
        title: "Update Lien Waiver",
        destructive: false,
        schema: z
          .object({
            throughDate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .nullable()
              .optional()
              .describe("Updated coverage through date."),
            amount: AMOUNT.nullable().optional().describe("Updated exact waiver amount."),
            jurisdiction: z
              .string()
              .trim()
              .max(20)
              .nullable()
              .optional()
              .describe("Updated ISO 3166-2 jurisdiction."),
            notes: z
              .string()
              .trim()
              .max(2000)
              .nullable()
              .optional()
              .describe("Updated waiver notes."),
          })
          .refine(
            (body) => Object.values(body).some((value) => value !== undefined),
            "Provide at least one lien-waiver field to update.",
          ),
      },
    ] as const
  ).map(({ action, name, title, destructive, schema }) =>
    definition({
      name,
      title,
      description: `${action === "request" ? "Request a draft waiver from" : action === "receive" ? "Record receipt of" : action === "sign" ? "Record the execution of" : action === "reject" ? "Reject" : action === "void" ? "Void" : "Edit"} a lien waiver only while its lifecycle permits that action. Find waiver ids and state with list_lien_waivers.`,
      inputSchema: z.object({
        waiverId: UUID.describe("Lien-waiver UUID from list_lien_waivers."),
        change: schema.describe("Fields required for this lien-waiver action."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      readOnly: false,
      destructive,
      openWorld: false,
      assistantConfirmation: "always",
      visibleTo: (authz) => can(authz, "compliance.manage"),
      featureKey: "subcontractorCompliance",
      execute: async (context, input) => {
        assertApplicationPermission(context, "compliance.manage");
        await requireLienWaiverFeatures(context);
        const body = lienWaiverActionBodySchema.parse({ action, ...input.change });
        const result = await lienWaiverResponse(
          await actOnLienWaiver({ id: input.waiverId }, context.authz, body),
        );
        const waivers = await loadLienWaivers({
          orgId: context.authz.user.orgId,
          id: input.waiverId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        if (!waivers[0]) throw notFound("lien waiver");
        return {
          ok: true,
          ...result,
          waiver: waivers[0],
          status: waivers[0].status,
          href: `/compliance/lien-waivers?waiver=${input.waiverId}`,
        };
      },
    }),
  ),
];
