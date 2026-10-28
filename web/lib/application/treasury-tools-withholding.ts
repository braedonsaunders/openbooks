import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  ContractorWithholdingError,
  createWithholdingDeposit,
  createWithholdingRemittance,
  fileWithholdingReturn,
  listWithholdingPeriods,
  loadWithholdingReturn,
  prepareWithholdingReturn,
  revokeWithholdingStanding,
  saveWithholdingStanding,
  withholdingStatements,
} from "@openbooks/engine/contractor-withholding";
import { subsidiaryScopeAllows } from "@openbooks/engine/organization/scope";
import { can } from "../authz";
import { withholdingEnrollments } from "../contractor-withholding";
import type { ApplicationContext } from "./context";
import { notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  assertTreasuryGate,
  assertUnrestricted,
  DATE,
  IDEMPOTENCY_KEY,
  settleDomainRefusal,
  UUID,
} from "./treasury-tools-common";
import { standingBody } from "../../app/api/contractor-withholding/standings/schema";

function settleWithholding(error: unknown): never {
  if (error instanceof ContractorWithholdingError)
    settleDomainRefusal({ message: error.message, remedy: error.remedy, status: 422 });
  settleDomainRefusal(error);
}

async function assertWithholdingScope(
  context: ApplicationContext,
  id: string,
  kind: "enrollment" | "return",
) {
  const rows =
    kind === "enrollment"
      ? await db.execute<{ subsidiaryId: string }>(
          sql`select subsidiary_id as "subsidiaryId" from withholding_enrollments where org_id=${context.authz.user.orgId} and id=${id}`,
          "objects",
        )
      : await db.execute<{ subsidiaryId: string }>(
          sql`select subsidiary_id as "subsidiaryId" from withholding_returns where org_id=${context.authz.user.orgId} and id=${id}`,
          "objects",
        );
  const row = rows[0];
  if (!row || !subsidiaryScopeAllows(context.authz.allowedSubsidiaryIds, row.subsidiaryId))
    throw notFound("record");
}

const withholdingHref = (params: Record<string, string>) =>
  `/contractor-withholding?${new URLSearchParams(params).toString()}`;

const standingInput = standingBody.extend({ idempotencyKey: IDEMPOTENCY_KEY });
export const TREASURY_WITHHOLDING_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_withholding_enrollments",
    title: "List Withholding Enrollments",
    description:
      "List contractor withholding enrollments and their supported schemes in the caller's subsidiary scope. Use an enrollment id to read its due periods and prepare a statutory return.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "ap.read"),
    featureKey: "contractorWithholding",
    execute: async (context) => {
      await assertTreasuryGate(context, "ap.read", "contractorWithholding");
      return { enrollments: await withholdingEnrollments(context.authz) };
    },
  }),
  definition({
    name: "list_withholding_periods",
    title: "List Withholding Periods",
    description:
      "List statutory periods and return status for one visible contractor withholding enrollment. Use an enrollment id from list_withholding_enrollments before preparing a return.",
    inputSchema: z.object({
      enrollmentId: UUID.describe("Withholding enrollment id from list_withholding_enrollments."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "ap.read"),
    featureKey: "contractorWithholding",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "ap.read", "contractorWithholding");
      await assertWithholdingScope(context, input.enrollmentId, "enrollment");
      try {
        return {
          periods: await listWithholdingPeriods(db, context.authz.user.orgId, input.enrollmentId),
        };
      } catch (error) {
        settleWithholding(error);
      }
    },
  }),
  definition({
    name: "prepare_withholding_return",
    title: "Prepare Withholding Return",
    description:
      "Freeze a return snapshot after the selected statutory period has ended and all posted deductions are current. Use list_withholding_periods for a due period; reread the new return before filing it with the authority.",
    inputSchema: z.object({
      enrollmentId: UUID.describe("Withholding enrollment id from list_withholding_enrollments."),
      periodStart: DATE.describe(
        "First date of a closed statutory period from list_withholding_periods.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ap.pay"),
    featureKey: "contractorWithholding",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "ap.pay", "contractorWithholding");
      await assertWithholdingScope(context, input.enrollmentId, "enrollment");
      try {
        const result = await prepareWithholdingReturn(
          db,
          context.authz.user.orgId,
          input,
          context.authz.user.id,
        );
        return {
          ok: true,
          ...result,
          status: "prepared",
          href: withholdingHref({ enrollment: input.enrollmentId, return: result.id }),
        };
      } catch (error) {
        settleWithholding(error);
      }
    },
  }),
  definition({
    name: "get_withholding_return",
    title: "Get Withholding Return",
    description:
      "Read a prepared or filed contractor withholding return and its per-payee statements before filing or remitting. Use the id returned by prepare_withholding_return; out-of-scope returns read as missing.",
    inputSchema: z.object({
      returnId: UUID.describe("Withholding return id from prepare_withholding_return."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "ap.read"),
    featureKey: "contractorWithholding",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "ap.read", "contractorWithholding");
      await assertWithholdingScope(context, input.returnId, "return");
      try {
        const ret = await loadWithholdingReturn(db, context.authz.user.orgId, input.returnId);
        return {
          return: ret,
          statements: withholdingStatements(ret),
          href: withholdingHref({ enrollment: ret.enrollmentId, return: input.returnId }),
        };
      } catch (error) {
        settleWithholding(error);
      }
    },
  }),
  definition({
    name: "file_withholding_return",
    title: "File Withholding Return",
    description:
      "Record the authority reference and freeze a current prepared withholding return as filed. Use get_withholding_return to confirm its period and review status; financial workpapers also require explicit confirmation.",
    inputSchema: z.object({
      returnId: UUID.describe("Prepared withholding return id from get_withholding_return."),
      filingReference: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .describe("Reference issued by the filing authority."),
      confirmed: z.boolean().optional().describe("Confirm review of a financial workpaper return."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ap.pay"),
    featureKey: "contractorWithholding",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "ap.pay", "contractorWithholding");
      await assertWithholdingScope(context, input.returnId, "return");
      try {
        const ret = await loadWithholdingReturn(db, context.authz.user.orgId, input.returnId);
        if (ret.returnKind === "financial_workpaper" && input.confirmed !== true)
          throw new ContractorWithholdingError(
            "Confirm that the workpaper was reviewed before freezing it.",
          );
        await fileWithholdingReturn(
          db,
          context.authz.user.orgId,
          {
            returnId: input.returnId,
            filingReference: input.filingReference,
            confirmed: input.confirmed,
          },
          context.authz.user.id,
        );
        return {
          ok: true,
          returnId: input.returnId,
          status: "filed",
          filingReference: input.filingReference,
          href: withholdingHref({ enrollment: ret.enrollmentId, return: input.returnId }),
        };
      } catch (error) {
        settleWithholding(error);
      }
    },
  }),
  definition({
    name: "create_withholding_remittance",
    title: "Create Withholding Remittance",
    description:
      "Generate the remittance document for a filed return when its scheme does not require a separate deposit schedule. Use get_withholding_return to verify the frozen filing; the document appears in the payable records.",
    inputSchema: z.object({
      returnId: UUID.describe("Filed withholding return id from get_withholding_return."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ap.pay"),
    featureKey: "contractorWithholding",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "ap.pay", "contractorWithholding");
      await assertWithholdingScope(context, input.returnId, "return");
      try {
        const result = await createWithholdingRemittance(
          db,
          context.authz.user.orgId,
          { returnId: input.returnId },
          context.authz.user.id,
        );
        return {
          ok: true,
          ...result,
          status: "draft",
          href: `/documents/${encodeURIComponent(result.documentId)}`,
        };
      } catch (error) {
        settleWithholding(error);
      }
    },
  }),
  definition({
    name: "create_withholding_deposit",
    title: "Create Withholding Deposit",
    description:
      "Generate a payable deposit bill for a visible withholding enrollment through a statutory due date. Use list_withholding_periods and enrollment setup to choose the appropriate through date; the payable document can then follow the generic document lifecycle.",
    inputSchema: z.object({
      enrollmentId: UUID.describe("Withholding enrollment id from list_withholding_enrollments."),
      throughDate: DATE.describe("Statutory date through which deductions are included."),
      amendsDocumentId: UUID.optional().describe(
        "Existing deposit bill being amended, if applicable.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ap.pay"),
    featureKey: "contractorWithholding",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "ap.pay", "contractorWithholding");
      await assertWithholdingScope(context, input.enrollmentId, "enrollment");
      try {
        const result = await createWithholdingDeposit(
          db,
          context.authz.user.orgId,
          {
            enrollmentId: input.enrollmentId,
            throughDate: input.throughDate,
            amendsDocumentId: input.amendsDocumentId,
          },
          context.authz.user.id,
        );
        return {
          ok: true,
          ...result,
          status: "draft",
          href: `/documents/${encodeURIComponent(result.documentId)}`,
        };
      } catch (error) {
        settleWithholding(error);
      }
    },
  }),
  definition({
    name: "create_withholding_standing",
    title: "Create Withholding Standing",
    description:
      "Create an effective-dated contractor withholding standing after verifying the party, scheme band, and authority evidence. This setup changes the organization-wide withholding policy and requires unrestricted setup access.",
    inputSchema: standingInput,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage") && authz.allowedSubsidiaryIds === null,
    featureKey: "contractorWithholding",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "admin.setup.manage", "contractorWithholding");
      assertUnrestricted(context);
      try {
        const result = await saveWithholdingStanding(
          db,
          context.authz.user.orgId,
          input,
          context.authz.user.id,
        );
        return {
          ok: true,
          ...result,
          status: "active",
          href: "/contractor-withholding?tab=standings",
        };
      } catch (error) {
        settleWithholding(error);
      }
    },
  }),
  definition({
    name: "update_withholding_standing",
    title: "Update Withholding Standing",
    description:
      "Revise an effective-dated contractor withholding standing using its current id and complete replacement values. This organization-wide setup action requires unrestricted setup access; read the withholding workspace afterward to verify the current band.",
    inputSchema: standingInput.extend({
      standingId: UUID.describe("Withholding standing id returned by create_withholding_standing."),
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage") && authz.allowedSubsidiaryIds === null,
    featureKey: "contractorWithholding",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "admin.setup.manage", "contractorWithholding");
      assertUnrestricted(context);
      const { standingId, ...body } = input;
      try {
        const result = await saveWithholdingStanding(
          db,
          context.authz.user.orgId,
          { ...body, id: standingId },
          context.authz.user.id,
        );
        return {
          ok: true,
          ...result,
          status: "active",
          href: "/contractor-withholding?tab=standings",
        };
      } catch (error) {
        settleWithholding(error);
      }
    },
  }),
  definition({
    name: "revoke_withholding_standing",
    title: "Revoke Withholding Standing",
    description:
      "Revoke an effective-dated contractor withholding standing with a recorded reason. Confirm the standing id from its setup result; this organization-wide action requires unrestricted setup access.",
    inputSchema: z.object({
      standingId: UUID.describe("Withholding standing id returned by create_withholding_standing."),
      reason: z.string().trim().min(1).max(2000).describe("Reason for revoking the standing."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage") && authz.allowedSubsidiaryIds === null,
    featureKey: "contractorWithholding",
    execute: async (context, input) => {
      await assertTreasuryGate(context, "admin.setup.manage", "contractorWithholding");
      assertUnrestricted(context);
      try {
        await revokeWithholdingStanding(
          db,
          context.authz.user.orgId,
          { id: input.standingId, reason: input.reason },
          context.authz.user.id,
        );
        return {
          ok: true,
          standingId: input.standingId,
          status: "revoked",
          href: "/contractor-withholding?tab=standings",
        };
      } catch (error) {
        settleWithholding(error);
      }
    },
  }),
];
