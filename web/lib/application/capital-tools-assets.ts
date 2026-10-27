import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { isIsoCalendarDate, businessToday } from "@openbooks/engine/platform/business-date/module";
import { normalizeMoney } from "@openbooks/engine/money/money";
import {
  acceptAssetProposals,
  proposeJournalLine,
  rejectAssetProposal,
  restoreAssetProposal,
  reverseAssetProposalAcceptance,
  scanAssetProposals,
} from "@openbooks/engine/assets/asset-proposals";
import {
  disposeAsset,
  remeasureAsset,
  reverseAssetLifecycleEvent,
} from "@openbooks/engine/assets/asset-lifecycle";
import {
  previewDepreciation,
  runDepreciation,
  recordDepreciationInput,
  buildAllSchedules,
  StalePreviewError,
  ClosedBatchError,
  DepreciationRefusalError,
} from "@openbooks/engine/assets/depreciation";
import {
  hasActiveDepreciationBook,
  hasDepreciationPeriod,
  listVisibleDepreciationAssetIds,
  isVisibleDepreciationAsset,
} from "@openbooks/engine/assets/depreciation-route-queries";
import { reverseSourceManagedDepreciation } from "@openbooks/engine/assets/depreciation-reversal";
import {
  createCipRecord,
  capitalizeCip,
  linkCipCosts,
  unlinkCipCost,
  reverseCipCapitalization,
} from "@openbooks/engine/assets/asset-cip";
import {
  attachAssetComponent,
  createAssetComponent,
  detachAssetComponent,
  disposeCompoundAsset,
} from "@openbooks/engine/assets/asset-components";
import {
  cancelMaintenanceRecord,
  createMaintenanceSchedule,
  recordMaintenance,
  recordUsageReading,
  updateMaintenanceSchedule,
} from "@openbooks/engine/assets/asset-maintenance";
import {
  createInsurancePolicy,
  removeInsuranceCoverage,
  renewInsurancePolicy,
  setInsuranceCoverage,
  updateInsurancePolicy,
} from "@openbooks/engine/assets/asset-insurance";
import { proposeAssetChange } from "@openbooks/engine/assets/asset-changes";
import { proposeAssetGroupValuation } from "@openbooks/engine/assets/group-valuations";
import { linkManualDepreciationEntry, buildSchedule } from "@openbooks/engine/assets/depreciation";
import { listVisibleDepreciationAssetNumbers } from "@openbooks/engine/assets/depreciation-route-queries";
import { findVisibleReversibleAsset } from "@openbooks/engine/assets/asset-route-queries";
import { assignAssetTaxCategory } from "@openbooks/engine/assets/asset-tax-category-assignments";
import {
  installTaxDepreciationPack,
  taxDepreciationPacks,
} from "@openbooks/engine/tax-returns/depreciation-packs";
import { listTaxRegimes, runTaxPool } from "@openbooks/engine/tax-returns/pool-run";
import { activePostingPrimaryBookId } from "@openbooks/engine/platform/database";
import {
  findActiveTaxPoolBook,
  findTaxPoolSubsidiary,
} from "@openbooks/engine/assets/tax-pool-route-queries";
import {
  defaultPostingSubsidiaryId,
  loadSubsidiaryContext,
  SubsidiaryError,
} from "@openbooks/engine/organization/subsidiaries";
import { fitsLedgerRange } from "@openbooks/engine/money/money";
import { canonicalDecimal, compareDecimal } from "../exact-decimal";
import {
  capitalMutation,
  capitalRead,
  DATE,
  field,
  IDEMPOTENCY_KEY,
  MONEY,
  resultWithHref,
  subsidiaryScope,
  UUID,
} from "./capital-tools-common";
import { conflict, forbidden, invalidInput, notFound } from "./errors";

const CALENDAR_DATE = DATE.refine(isIsoCalendarDate, "Enter a real calendar date.");
const OPTIONAL_TEXT = (limit: number, description: string) =>
  field(z.string().trim().max(limit).nullable().optional(), description);
const OPTIONAL_MONEY = field(MONEY.nullable().optional(), "Exact decimal amount as text, or null.");
const PLAN_LINE = z.strictObject({
  date: field(CALENDAR_DATE, "Depreciation date for this schedule line."),
  amount: field(MONEY, "Exact scheduled amount as decimal text."),
});
const GROUP_COMPONENT = z.strictObject({
  cost: field(MONEY, "Original group cost for the component."),
  accumulated: field(MONEY, "Accumulated group depreciation."),
  salvage: field(MONEY, "Group salvage value."),
  remainingPlan: field(z.array(PLAN_LINE).max(1200), "Remaining group depreciation plan."),
  removedPlan: field(
    z.array(PLAN_LINE).max(1200).optional(),
    "Removed group depreciation lines, when applicable.",
  ),
  unimpairedAccumulated: field(
    MONEY.optional(),
    "Unimpaired accumulated depreciation for impairment history.",
  ),
  unimpairedRemainingPlan: field(
    z.array(PLAN_LINE).max(1200).optional(),
    "Unimpaired remaining depreciation plan.",
  ),
  unimpairedRemovedPlan: field(
    z.array(PLAN_LINE).max(1200).optional(),
    "Unimpaired depreciation lines removed by the change.",
  ),
});
const ASSET_TRANSFER = z.strictObject({
  subsidiaryId: field(UUID, "Receiving subsidiary."),
  categoryId: field(UUID, "Receiving asset category."),
  assetNumber: field(z.string().trim().min(1).max(100), "Receiving asset number."),
  name: field(z.string().trim().min(1).max(255), "Receiving asset name."),
  buyerAmount: field(MONEY, "Exact buyer acquisition basis."),
  buyerSalvage: field(MONEY, "Exact buyer salvage value."),
  buyerProductionUnits: field(MONEY.optional(), "Remaining production units, when used."),
  lifeMonths: field(z.number().int().min(1).max(1200), "Buyer remaining useful life in months."),
  payableAccountId: field(UUID, "Intercompany payable account."),
  eliminationSubsidiaryId: field(UUID, "Elimination subsidiary for the group transaction."),
  sellerToGroupRate: field(z.string().max(40), "Seller currency to group currency exchange rate."),
  buyerToGroupRate: field(z.string().max(40), "Buyer currency to group currency exchange rate."),
  sellerToBuyerRate: field(z.string().max(40), "Seller currency to buyer currency exchange rate."),
  ctaAccountId: field(UUID, "Cumulative translation adjustment account."),
  groupAssetAccountId: field(UUID, "Group asset account."),
  groupAccumulatedAccountId: field(UUID, "Group accumulated depreciation account."),
  groupDepreciationAccountId: field(UUID, "Group depreciation expense account."),
  groupGainLossAccountId: field(UUID, "Group gain or loss account."),
  taxRatePercent: field(MONEY, "Exact tax rate percentage."),
  deferredTaxAccountId: field(UUID, "Deferred tax account."),
  taxExpenseAccountId: field(UUID, "Tax expense account."),
  exchangeRateEvidence: field(
    z.string().trim().min(8).max(4000),
    "Evidence supporting the exchange rates.",
  ),
  groupAssessment: field(z.string().trim().min(8).max(4000), "Group accounting assessment."),
  groupPlans: field(
    z
      .array(
        z.strictObject({
          bookId: field(UUID, "Accounting book id."),
          lines: field(
            z.array(PLAN_LINE).max(1200),
            "Group depreciation lines by date and amount.",
          ),
        }),
      )
      .max(100)
      .optional(),
    "Explicit group depreciation schedules by book.",
  ),
});

export const CAPITAL_ASSET_TOOLS = [
  capitalRead({
    name: "list_asset_proposals",
    title: "List Asset Proposals",
    description:
      "List pending, accepted, rejected or voided capitalization proposals with their source posting and acceptance. Use returned proposal ids with decide_asset_proposal or accept_asset_proposals.",
    permission: "assets.read",
    featureKey: "assetProposals",
    inputSchema: z.strictObject({
      status: field(
        z.enum(["pending", "accepted", "rejected", "voided", "all"]).optional(),
        "Proposal status filter; defaults to pending.",
      ),
      limit: field(z.number().int().min(1).max(500).optional(), "Maximum proposals to return."),
    }),
    execute: async (context, input) => {
      const rows = await db.execute<Record<string, unknown>>(
        sql`
        select p.id, p.status, p.origin, p.posting_date::text as "postingDate",
               p.amount::text as amount, p.currency, p.quantity::text as quantity, p.description,
               p.source_line_id as "sourceLineId", p.source_entry_id as "sourceEntryId",
               p.source_document_id as "sourceDocumentId", p.suggested_category_id as "suggestedCategoryId",
               p.subsidiary_id as "subsidiaryId", s.name as "subsidiaryName",
               d.document_number as "sourceDocumentNumber", je.entry_number as "sourceEntryNumber",
               ac.id as "acceptanceId", ac.operation as "acceptedOperation", ac.status as "acceptanceStatus",
               ac.accepted_on::text as "acceptedOn"
          from asset_proposals p
          join subsidiaries s on s.org_id=p.org_id and s.id=p.subsidiary_id
          join journal_entries je on je.org_id=p.org_id and je.id=p.source_entry_id
          left join documents d on d.org_id=p.org_id and d.id=p.source_document_id
          left join asset_proposal_acceptances ac on ac.org_id=p.org_id and ac.id=p.acceptance_id
         where p.org_id=${context.authz.user.orgId}
           and (${input.status === "all" ? null : (input.status ?? "pending")}::text is null or p.status=${input.status === "all" ? null : (input.status ?? "pending")})
           ${context.authz.allowedSubsidiaryIds === null ? sql`` : sql`and p.subsidiary_id = any(${`{${[...context.authz.allowedSubsidiaryIds].join(",")}}`}::uuid[])`}
         order by p.posting_date desc, p.id desc limit ${input.limit ?? 100}
      `,
        "objects",
      );
      return { ok: true, items: rows, href: "/assets/proposals" };
    },
  }),
  capitalMutation({
    name: "scan_asset_proposals",
    title: "Scan Asset Proposals",
    description:
      "Find capitalizable bill and journal lines under the effective capitalization rules, or propose one posted journal line. Use search_assets and the document or journal reads to find the source ids.",
    permission: "assets.capitalize",
    featureKey: "assetProposals",
    inputSchema: z.discriminatedUnion("action", [
      z.strictObject({
        action: field(z.literal("scan"), "Scan all eligible postings in a date window."),
        from: field(CALENDAR_DATE, "First posting date included in the scan."),
        to: field(CALENDAR_DATE, "Last posting date included in the scan."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("line"), "Propose one posted journal line."),
        journalLineId: field(UUID, "Posted journal line to review as an asset proposal."),
        categoryId: field(UUID.nullable().optional(), "Asset category to apply, when known."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ]),
    execute: async (context, input) => {
      const result =
        input.action === "scan"
          ? await scanAssetProposals(context.authz.user.orgId, {
              from: input.from,
              to: input.to,
              actorId: context.authz.user.id,
            })
          : await proposeJournalLine(context.authz.user.orgId, {
              journalLineId: input.journalLineId,
              categoryId: input.categoryId ?? null,
              actorId: context.authz.user.id,
              allowedSubsidiaryIds: subsidiaryScope(context),
            });
      return resultWithHref(result, "/assets/proposals");
    },
  }),
  capitalMutation({
    name: "decide_asset_proposal",
    title: "Decide Asset Proposal",
    description:
      "Reject a pending proposal with a reason or restore a rejected proposal to the review queue. Find proposal ids in the asset proposals page or from scan_asset_proposals.",
    permission: "assets.capitalize",
    featureKey: "assetProposals",
    destructive: true,
    inputSchema: z.strictObject({
      proposalId: field(UUID, "Proposal id from scan_asset_proposals or the asset proposal list."),
      action: field(z.enum(["reject", "restore"]), "Reject the proposal or restore it to review."),
      reason: field(z.string().trim().min(1).max(2000), "Reason recorded with this decision."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const args = {
        proposalId: input.proposalId,
        reason: input.reason,
        actorId: context.authz.user.id,
        allowedSubsidiaryIds: subsidiaryScope(context),
      };
      if (input.action === "reject") await rejectAssetProposal(context.authz.user.orgId, args);
      else await restoreAssetProposal(context.authz.user.orgId, args);
      return {
        ok: true,
        proposalId: input.proposalId,
        status: input.action === "reject" ? "rejected" : "pending",
        href: "/assets/proposals",
      };
    },
  }),
  capitalMutation({
    name: "accept_asset_proposals",
    title: "Accept Asset Proposals",
    description:
      "Accept pending proposals as one asset, a split, a merge, a component or a construction-in-progress record. Find proposal ids with scan_asset_proposals and asset ids with search_assets.",
    permission: "assets.capitalize",
    featureKey: "assetProposals",
    inputSchema: z.strictObject({
      operation: field(
        z.enum(["asset", "split", "merge", "component", "cip"]),
        "How the selected proposals are grouped.",
      ),
      proposalIds: field(z.array(UUID).min(1).max(200), "Pending proposal ids to accept together."),
      acceptedOn: field(CALENDAR_DATE, "Effective acceptance date."),
      reason: OPTIONAL_TEXT(2000, "Reason for this acceptance."),
      targets: field(
        z
          .array(
            z.strictObject({
              name: field(z.string().trim().min(1).max(200), "Name for the resulting asset."),
              categoryId: field(UUID, "Asset category for the resulting asset."),
              amount: field(MONEY, "Exact cost allocated to this resulting asset."),
              quantity: field(
                z
                  .string()
                  .regex(/^\d+(\.\d{1,8})?$/)
                  .nullable()
                  .optional(),
                "Optional exact quantity for the asset.",
              ),
              description: OPTIONAL_TEXT(4000, "Asset description."),
              serialNumber: OPTIONAL_TEXT(200, "Asset serial number."),
              inServiceOn: field(
                CALENDAR_DATE.nullable().optional(),
                "In-service date, if ready for use.",
              ),
              placeInService: field(
                z.boolean().optional(),
                "Whether the accepted asset is placed in service.",
              ),
            }),
          )
          .max(500)
          .default([]),
        "Resulting asset records and proposal allocations.",
      ),
      parentAssetId: field(UUID.nullable().optional(), "Parent asset for component acceptance."),
      cipAssetId: field(
        UUID.nullable().optional(),
        "Construction-in-progress asset for capitalization.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const result = await acceptAssetProposals(
        context.authz.user.orgId,
        {
          idempotencyKey: input.idempotencyKey,
          operation: input.operation,
          proposalIds: input.proposalIds,
          acceptedOn: input.acceptedOn,
          reason: input.reason ?? null,
          targets: input.targets.map((target) => ({
            ...target,
            quantity: target.quantity ?? null,
          })),
          parentAssetId: input.parentAssetId ?? null,
          cipAssetId: input.cipAssetId ?? null,
        },
        { actorId: context.authz.user.id, allowedSubsidiaryIds: subsidiaryScope(context) },
      );
      return resultWithHref(result, "/assets");
    },
  }),
  capitalMutation({
    name: "reverse_asset_proposal_acceptance",
    title: "Reverse Asset Proposal Acceptance",
    description:
      "Reverse a posted proposal acceptance, remove the draft assets it created and return proposals to the queue. Find acceptance ids in the asset proposals history.",
    permission: "assets.capitalize",
    featureKey: "assetProposals",
    destructive: true,
    inputSchema: z.strictObject({
      acceptanceId: field(UUID, "Acceptance id from proposal history."),
      date: field(CALENDAR_DATE, "Date for the reversing journal."),
      reason: field(z.string().trim().min(1).max(2000), "Reason for reversing the acceptance."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) =>
      resultWithHref(
        await reverseAssetProposalAcceptance(context.authz.user.orgId, {
          acceptanceId: input.acceptanceId,
          date: input.date,
          reason: input.reason,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: subsidiaryScope(context),
        }),
        "/assets/proposals",
      ),
  }),
  capitalRead({
    name: "preview_asset_depreciation",
    title: "Preview Asset Depreciation",
    description:
      "Preview due depreciation by book, period and asset selection before posting. Find asset ids with search_assets and book or period ids in the accounting setup reads.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    inputSchema: z.strictObject({
      throughDate: field(CALENDAR_DATE.nullable().optional(), "Last date included in the preview."),
      postingDate: field(
        CALENDAR_DATE.nullable().optional(),
        "Journal posting date, if different from the through date.",
      ),
      bookId: field(UUID.nullable().optional(), "Active depreciation book to preview."),
      periodId: field(UUID.nullable().optional(), "Open accounting period for posting."),
      assetIds: field(
        z.array(UUID).max(500).optional(),
        "Assets to include; omit to preview all visible due assets.",
      ),
    }),
    execute: async (context, input) => {
      const orgId = context.authz.user.orgId;
      const throughDate = input.throughDate ?? (await businessToday(orgId));
      if (!isIsoCalendarDate(throughDate)) throw invalidInput("Enter a real calendar date.");
      if (input.bookId && !(await hasActiveDepreciationBook(orgId, input.bookId)))
        throw notFound("depreciation book");
      if (input.periodId && !(await hasDepreciationPeriod(orgId, input.periodId)))
        throw notFound("accounting period");
      const selected = input.assetIds
        ? [...new Set(input.assetIds.map((id) => id.toLowerCase()))]
        : undefined;
      if (selected?.length) {
        const visible = await listVisibleDepreciationAssetIds({
          orgId,
          ids: selected,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        const seen = new Set(visible.map((row) => String(row.id).toLowerCase()));
        if (selected.some((id) => !seen.has(id))) throw notFound("asset");
      }
      const result = await previewDepreciation(orgId, {
        asOfDate: throughDate,
        postingDate: input.postingDate ?? undefined,
        bookId: input.bookId ?? undefined,
        periodId: input.periodId ?? undefined,
        assetIds: selected,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds
          ? [...context.authz.allowedSubsidiaryIds]
          : undefined,
      });
      return { ok: true, ...result, href: "/assets?tab=depreciation" };
    },
  }),
  capitalMutation({
    name: "run_asset_depreciation",
    title: "Run Asset Depreciation",
    description:
      "Post due depreciation for one asset or the visible fixed-asset register through a date. Preview first with preview_asset_depreciation; find asset ids with search_assets.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    inputSchema: z.strictObject({
      asOfDate: field(
        CALENDAR_DATE.nullable().optional(),
        "Last date through which depreciation is recognized.",
      ),
      assetId: field(
        UUID.nullable().optional(),
        "One asset to run; omit to run all visible due assets.",
      ),
      bookId: field(UUID.nullable().optional(), "Depreciation book to run."),
      periodId: field(UUID.nullable().optional(), "Accounting period pinned by a preview."),
      postingDate: field(
        CALENDAR_DATE.nullable().optional(),
        "Journal posting date, if different from the through date.",
      ),
      assetIds: field(
        z.array(UUID).max(500).optional(),
        "Exact asset selection pinned by a preview.",
      ),
      fingerprint: field(
        z.string().min(1).max(200).optional(),
        "Fingerprint returned by preview_asset_depreciation; required to confirm a selected batch.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const orgId = context.authz.user.orgId;
      const asOfDate = input.asOfDate ?? (await businessToday(orgId));
      if (!isIsoCalendarDate(asOfDate)) throw invalidInput("Enter a real calendar date.");
      const isConfirm =
        input.fingerprint !== undefined ||
        input.assetIds !== undefined ||
        input.periodId !== undefined;
      if (!isConfirm) {
        const result = await runDepreciation(
          orgId,
          asOfDate,
          context.authz.user.id,
          input.assetId ?? undefined,
          context.authz.allowedSubsidiaryIds ? [...context.authz.allowedSubsidiaryIds] : undefined,
          input.bookId ?? undefined,
        );
        return resultWithHref(result, "/assets?tab=depreciation");
      }
      const fingerprint = input.fingerprint?.trim() ?? "";
      if (!fingerprint)
        throw invalidInput(
          "A preview fingerprint is required to confirm a selected depreciation batch.",
        );
      const assetIds = [...new Set((input.assetIds ?? []).map((id) => id.toLowerCase()))];
      if (assetIds.length === 0)
        throw invalidInput("Select at least one asset from the depreciation preview.");
      const bookId = input.bookId ?? null;
      if (bookId && !(await hasActiveDepreciationBook(orgId, bookId)))
        throw notFound("depreciation book");
      const periodId = input.periodId ?? null;
      if (periodId && !(await hasDepreciationPeriod(orgId, periodId)))
        throw notFound("accounting period");
      const owned = await listVisibleDepreciationAssetIds({
        orgId,
        ids: assetIds,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
      });
      const seen = new Set(owned.map((row) => String(row.id).toLowerCase()));
      if (assetIds.some((id) => !seen.has(id))) throw notFound("asset");
      const preview = await previewDepreciation(orgId, {
        asOfDate,
        bookId: bookId ?? undefined,
        periodId: periodId ?? undefined,
        assetIds,
        postingDate: input.postingDate ?? undefined,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds
          ? [...context.authz.allowedSubsidiaryIds]
          : undefined,
      });
      if (preview.fingerprint !== fingerprint) throw conflict("stale_preview");
      if (preview.staleAssets.length > 0)
        throw conflict("schedules_stale", {
          assets: preview.staleAssets.map((asset) => ({
            assetId: asset.assetId,
            assetNumber: asset.assetNumber,
            assetName: asset.assetName,
          })),
          remedy: "Rebuild the listed schedules, preview again, then confirm the new fingerprint.",
        });
      if (preview.rows.length === 0) throw invalidInput("Nothing is due for the selected assets.");
      try {
        const result = await runDepreciation(
          orgId,
          asOfDate,
          context.authz.user.id,
          undefined,
          context.authz.allowedSubsidiaryIds ? [...context.authz.allowedSubsidiaryIds] : undefined,
          bookId ?? undefined,
          {
            assetIds,
            periodId: periodId ?? undefined,
            postingDate: input.postingDate ?? preview.postingDate ?? undefined,
            lineIds: preview.rows.map((row) => row.lineId),
            expectedFingerprint: fingerprint,
            expectedLines: preview.rows.map((row) => ({
              lineId: row.lineId,
              assetId: row.assetId,
              amount: row.amount,
              periodId: row.periodId,
              bookId: row.bookId,
              debitAccountId: row.debitAccountId,
              creditAccountId: row.creditAccountId,
              subsidiaryId: row.subsidiaryId,
              departmentId: row.departmentId,
              projectId: row.projectId,
              locationId: row.locationId,
              evidence: row.evidence,
            })),
          },
        );
        return { ...resultWithHref(result, "/assets?tab=depreciation"), fingerprint };
      } catch (error) {
        if (error instanceof StalePreviewError) throw conflict("stale_preview");
        if (error instanceof ClosedBatchError)
          throw conflict("period_closed", {
            asset: error.assetNumber,
            period: error.periodName,
            remedy: error.message,
          });
        if (error instanceof DepreciationRefusalError) throw conflict(error.message);
        throw error;
      }
    },
  }),
  capitalMutation({
    name: "record_asset_depreciation_input",
    title: "Record Asset Depreciation Input",
    description:
      "Record manual or production-usage depreciation supported by an evidence file, then rebuild the asset schedule. Find the asset with search_assets and the evidence file with file search.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    inputSchema: z.strictObject({
      assetId: field(UUID, "Asset receiving this depreciation input."),
      effectiveDate: field(CALENDAR_DATE, "Date the input applies."),
      kind: field(z.enum(["manual", "production_usage"]), "Manual amount or production usage."),
      value: field(
        MONEY.refine(fitsLedgerRange, "Amount must fit the ledger scale."),
        "Exact amount or usage quantity.",
      ),
      memo: field(z.string().trim().max(2000), "Explanation for the input."),
      evidenceFileId: field(UUID, "Evidence file supporting the input."),
      bookId: field(UUID.optional(), "Book to apply the input to; omit for the primary book."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const orgId = context.authz.user.orgId;
      if (
        !(await isVisibleDepreciationAsset({
          orgId,
          assetId: input.assetId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        }))
      )
        throw notFound("asset");
      const scope = context.authz.allowedSubsidiaryIds
        ? [...context.authz.allowedSubsidiaryIds]
        : undefined;
      await buildAllSchedules(input.assetId, orgId, context.authz.user.id, scope);
      const result = await recordDepreciationInput({
        ...input,
        orgId,
        actorId: context.authz.user.id,
        allowedSubsidiaryIds: scope,
      });
      return resultWithHref(result, "/assets?tab=depreciation");
    },
  }),
  capitalMutation({
    name: "reverse_asset_depreciation",
    title: "Reverse Asset Depreciation",
    description:
      "Reverse one source-managed depreciation schedule line with a reason. Find the asset and its schedule line with get_asset.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    destructive: true,
    inputSchema: z.strictObject({
      assetId: field(UUID, "Asset whose depreciation line is being reversed."),
      lineId: field(UUID, "Source-managed depreciation schedule line from get_asset."),
      reason: field(z.string().trim().min(8).max(500), "Reason for reversing the line."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) =>
      resultWithHref(
        await reverseSourceManagedDepreciation({
          orgId: context.authz.user.orgId,
          assetId: input.assetId,
          lineId: input.lineId,
          actorId: context.authz.user.id,
          reason: input.reason,
        }),
        "/assets",
      ),
  }),
  capitalMutation({
    name: "dispose_asset",
    title: "Dispose Asset",
    description:
      "Sell or write off an asset and post its disposal journal. Find the asset with search_assets and choose the proceeds account from the account list when proceeds are nonzero.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    destructive: true,
    inputSchema: z.strictObject({
      assetId: field(UUID, "Asset to dispose."),
      date: field(
        CALENDAR_DATE.nullable().optional(),
        "Disposal date; defaults to the organization's business date.",
      ),
      proceeds: field(MONEY.optional(), "Exact cash or receivable proceeds; defaults to zero."),
      proceedsAccountId: field(UUID.optional(), "Account receiving nonzero proceeds."),
      writeOff: field(z.boolean().optional(), "Set true for a zero-proceeds write-off."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const proceedsRaw = canonicalDecimal(input.proceeds ?? "0", 4);
      if (proceedsRaw === null || compareDecimal(proceedsRaw, "0") < 0)
        throw invalidInput("Proceeds must be a non-negative amount.");
      const writeOff = input.writeOff === true;
      if (writeOff && compareDecimal(proceedsRaw, "0") !== 0)
        throw invalidInput("A write-off must have zero proceeds.");
      if (!writeOff && compareDecimal(proceedsRaw, "0") > 0 && !input.proceedsAccountId)
        throw invalidInput("Select the account receiving the proceeds.");
      const date = input.date ?? (await businessToday(context.authz.user.orgId));
      if (!isIsoCalendarDate(date)) throw invalidInput("Enter a real calendar date.");
      const result = await disposeAsset(context.authz.user.orgId, input.assetId, {
        proceeds: normalizeMoney(proceedsRaw),
        proceedsAccountId: input.proceedsAccountId ?? null,
        date,
        actorId: context.authz.user.id,
        writeOff,
        ...(context.authz.allowedSubsidiaryIds
          ? { allowedSubsidiaryIds: [...context.authz.allowedSubsidiaryIds] }
          : {}),
      });
      return resultWithHref(result, "/assets");
    },
  }),
  capitalMutation({
    name: "remeasure_asset",
    title: "Remeasure Asset",
    description:
      "Impair or revalue an asset to a new carrying amount, post the adjustment and rebuild its remaining depreciation schedule. Find the asset with search_assets.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    inputSchema: z.strictObject({
      assetId: field(UUID, "Asset to remeasure."),
      newCarryingValue: field(MONEY, "New exact carrying value after impairment or revaluation."),
      date: field(
        CALENDAR_DATE.nullable().optional(),
        "Effective date; defaults to the organization's business date.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const amount = canonicalDecimal(input.newCarryingValue, 4);
      if (amount === null || compareDecimal(amount, "0") < 0)
        throw invalidInput("Enter a non-negative carrying value.");
      const date = input.date ?? (await businessToday(context.authz.user.orgId));
      if (!isIsoCalendarDate(date)) throw invalidInput("Enter a real calendar date.");
      return resultWithHref(
        await remeasureAsset(context.authz.user.orgId, input.assetId, {
          newCarryingValue: normalizeMoney(amount),
          date,
          actorId: context.authz.user.id,
          ...(context.authz.allowedSubsidiaryIds
            ? { allowedSubsidiaryIds: [...context.authz.allowedSubsidiaryIds] }
            : {}),
        }),
        "/assets",
      );
    },
  }),
  capitalMutation({
    name: "propose_asset_change",
    title: "Propose Asset Change",
    description:
      "Propose a partial disposal or intercompany transfer with accounting, tax and group carrying-value evidence. Find the source asset with search_assets and use the asset change read for books and scope ids.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    inputSchema: z.strictObject({
      assetId: field(UUID, "Source asset receiving the change."),
      operation: field(
        z.enum(["partial_disposal", "intercompany_transfer"]),
        "Partial disposal or intercompany transfer.",
      ),
      effectiveOn: field(CALENDAR_DATE, "Effective date of the change."),
      reason: field(z.string().trim().min(8).max(1000), "Reason for the change."),
      assessment: field(
        z.string().trim().min(8).max(4000),
        "Accounting assessment supporting the change.",
      ),
      portion: field(
        z.union([
          z.strictObject({
            percent: field(MONEY, "Exact percent of the asset being disposed or transferred."),
          }),
          z.strictObject({
            books: field(
              z
                .array(
                  z.strictObject({
                    bookId: field(UUID, "Accounting book id."),
                    cost: field(MONEY, "Cost removed from this book."),
                    accumulated: field(MONEY, "Accumulated depreciation removed from this book."),
                    salvage: field(MONEY, "Salvage value removed from this book."),
                    remainingProductionUnits: field(
                      MONEY.optional(),
                      "Remaining production units removed, when applicable.",
                    ),
                    group: field(
                      GROUP_COMPONENT.optional(),
                      "Group-currency carrying values and schedule details.",
                    ),
                  }),
                )
                .min(1)
                .max(100),
              "Book-by-book amounts for the portion.",
            ),
          }),
        ]),
        "Portion to dispose or transfer, by percent or by book.",
      ),
      proceeds: field(MONEY, "Exact proceeds or transfer amount."),
      proceedsAccountId: field(UUID, "Account used for proceeds or settlement."),
      transfer: field(
        ASSET_TRANSFER.optional(),
        "Complete buyer, FX, tax and group setup for an intercompany transfer.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) =>
      resultWithHref(
        await proposeAssetChange(context.authz.user.orgId, input.assetId, context.authz.user.id, {
          operation: input.operation,
          effectiveOn: input.effectiveOn,
          reason: input.reason,
          assessment: input.assessment,
          portion: input.portion,
          proceeds: input.proceeds,
          proceedsAccountId: input.proceedsAccountId,
          transfer: input.transfer,
          idempotencyKey: input.idempotencyKey,
        }),
        "/assets",
      ),
  }),
  capitalMutation({
    name: "propose_asset_group_valuation",
    title: "Propose Asset Group Valuation",
    description:
      "Record the group-currency valuation and remaining depreciation plan for an intercompany asset transfer. Find the source transfer event in the asset's group valuation history.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    inputSchema: z.strictObject({
      assetId: field(UUID, "Asset receiving the group valuation."),
      sourceEventId: field(UUID, "Intercompany transfer event from the asset history."),
      effectiveOn: field(CALENDAR_DATE, "Date the group valuation takes effect."),
      carryingValue: field(MONEY, "Exact group carrying value."),
      buyerToGroupRate: field(z.string().min(1).max(40), "Exact exchange rate evidence."),
      assessment: field(z.string().trim().min(8).max(4000), "Group valuation assessment."),
      reason: field(z.string().trim().min(8).max(1000), "Reason for the valuation."),
      remainingPlan: field(
        z.array(PLAN_LINE).max(1200),
        "Remaining depreciation schedule by date and exact amount.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { assetId, ...body } = input;
      return resultWithHref(
        {
          changeId: await proposeAssetGroupValuation(
            context.authz.user.orgId,
            assetId,
            context.authz.user.id,
            body,
          ),
        },
        "/assets",
      );
    },
  }),
  capitalMutation({
    name: "reverse_asset_event",
    title: "Reverse Asset Event",
    description:
      "Post a governed reversal of a reversible fixed-asset lifecycle event. Find the event id and asset id with get_asset.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    destructive: true,
    inputSchema: z.strictObject({
      assetId: field(UUID, "Asset that owns the event."),
      eventId: field(UUID, "Reversible lifecycle event from the asset history."),
      date: field(CALENDAR_DATE, "Date for the reversing event and journal."),
      reason: field(z.string().trim().min(8).max(500), "Reason for the reversal."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const visible = await findVisibleReversibleAsset(
        context.authz.user.orgId,
        input.assetId,
        context.authz.allowedSubsidiaryIds,
      );
      if (!visible) throw notFound("asset");
      return resultWithHref(
        await reverseAssetLifecycleEvent(context.authz.user.orgId, input.eventId, {
          assetId: input.assetId,
          date: input.date,
          reason: input.reason,
          actorId: context.authz.user.id,
          ...(context.authz.allowedSubsidiaryIds
            ? { allowedSubsidiaryIds: [...context.authz.allowedSubsidiaryIds] }
            : {}),
        }),
        "/assets",
      );
    },
  }),
  capitalMutation({
    name: "create_cip_asset",
    title: "Create CIP Asset",
    description:
      "Open a construction-in-progress asset on its CIP account before linking posted project or bill costs. Find category, subsidiary and account ids with setup and asset reads.",
    permission: "assets.capitalize",
    featureKey: "constructionInProgress",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity that owns construction."),
      categoryId: field(UUID, "Fixed-asset category used on capitalization."),
      name: field(z.string().trim().min(1).max(200), "Construction project or asset name."),
      description: OPTIONAL_TEXT(4000, "Construction description."),
      cipAccountId: field(UUID, "Construction-in-progress general ledger account."),
      startedOn: field(CALENDAR_DATE.nullable().optional(), "Construction start date."),
      departmentId: field(UUID.nullable().optional(), "Department dimension."),
      projectId: field(UUID.nullable().optional(), "Project dimension."),
      locationId: field(UUID.nullable().optional(), "Location dimension."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) =>
      resultWithHref(
        await createCipRecord(context.authz.user.orgId, {
          ...input,
          description: input.description ?? null,
          startedOn: input.startedOn ?? null,
          departmentId: input.departmentId ?? null,
          projectId: input.projectId ?? null,
          locationId: input.locationId ?? null,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: subsidiaryScope(context),
        }),
        "/assets?tab=construction-in-progress",
      ),
  }),
  capitalMutation({
    name: "link_cip_costs",
    title: "Link CIP Costs",
    description:
      "Link posted general-ledger cost lines to a construction-in-progress asset, or unlink a cost with a reason. Find CIP assets and posted journal line ids in asset and ledger reads.",
    permission: "assets.capitalize",
    featureKey: "constructionInProgress",
    inputSchema: z.discriminatedUnion("action", [
      z.strictObject({
        action: field(z.literal("link"), "Link posted cost lines."),
        cipAssetId: field(UUID, "CIP asset receiving the costs."),
        journalLineIds: field(z.array(UUID).min(1).max(500), "Posted journal line ids to link."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("unlink"), "Remove one linked cost from the CIP record."),
        costId: field(UUID, "CIP cost link to remove."),
        reason: field(z.string().trim().min(1).max(2000), "Reason for removing the linked cost."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ]),
    execute: async (context, input) => {
      const options = {
        actorId: context.authz.user.id,
        allowedSubsidiaryIds: subsidiaryScope(context),
      };
      const result =
        input.action === "link"
          ? await linkCipCosts(context.authz.user.orgId, {
              cipAssetId: input.cipAssetId,
              journalLineIds: input.journalLineIds,
              ...options,
            })
          : await unlinkCipCost(context.authz.user.orgId, {
              costId: input.costId,
              reason: input.reason,
              ...options,
            });
      return resultWithHref(result, "/assets?tab=construction-in-progress");
    },
  }),
  capitalMutation({
    name: "capitalize_cip",
    title: "Capitalize CIP",
    description:
      "Capitalize linked construction costs into fixed assets or components, with any remainder charged to expense, in one balanced posting. Find the CIP asset and cost lines with asset and ledger reads.",
    permission: "assets.capitalize",
    featureKey: "constructionInProgress",
    inputSchema: z.strictObject({
      cipAssetId: field(UUID, "CIP asset to capitalize."),
      idempotencyKey: IDEMPOTENCY_KEY,
      capitalizedOn: field(CALENDAR_DATE, "Capitalization and in-service date."),
      reason: field(z.string().trim().min(1).max(2000), "Reason for capitalization."),
      closeWhenEmpty: field(
        z.boolean().optional(),
        "Close the CIP record when its balance reaches zero.",
      ),
      lines: field(
        z
          .array(
            z.discriminatedUnion("kind", [
              z.strictObject({
                kind: field(z.literal("asset"), "Create a new fixed asset."),
                name: field(z.string().trim().min(1).max(200), "Asset name."),
                categoryId: field(UUID, "Asset category."),
                amount: field(MONEY, "Exact amount capitalized."),
                description: OPTIONAL_TEXT(4000, "Asset description."),
                placeInService: field(
                  z.boolean().optional(),
                  "Place the asset in service on capitalization.",
                ),
              }),
              z.strictObject({
                kind: field(z.literal("component"), "Create a component of an existing asset."),
                parentAssetId: field(UUID, "Parent asset id."),
                name: field(z.string().trim().min(1).max(200), "Component name."),
                categoryId: field(UUID, "Asset category."),
                amount: field(MONEY, "Exact amount capitalized."),
                description: OPTIONAL_TEXT(4000, "Component description."),
                placeInService: field(z.boolean().optional(), "Place the component in service."),
              }),
              z.strictObject({
                kind: field(z.literal("expense"), "Expense a non-capitalizable remainder."),
                expenseAccountId: field(UUID, "Expense account id."),
                amount: field(MONEY, "Exact amount expensed."),
                memo: OPTIONAL_TEXT(500, "Expense line memo."),
              }),
            ]),
          )
          .min(1)
          .max(200),
        "Assets, components and expense lines produced by capitalization.",
      ),
    }),
    execute: async (context, input) =>
      resultWithHref(
        await capitalizeCip(context.authz.user.orgId, input, {
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: subsidiaryScope(context),
        }),
        "/assets?tab=construction-in-progress",
      ),
  }),
  capitalMutation({
    name: "reverse_cip_capitalization",
    title: "Reverse CIP Capitalization",
    description:
      "Reverse a posted CIP capitalization, remove its created draft assets and reopen the construction record. Find the capitalization id in the CIP history.",
    permission: "assets.capitalize",
    featureKey: "constructionInProgress",
    destructive: true,
    inputSchema: z.strictObject({
      capitalizationId: field(UUID, "Posted CIP capitalization id."),
      date: field(CALENDAR_DATE, "Date for the reversing journal."),
      reason: field(z.string().trim().min(1).max(2000), "Reason for reversing the capitalization."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) =>
      resultWithHref(
        await reverseCipCapitalization(context.authz.user.orgId, {
          ...input,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: subsidiaryScope(context),
        }),
        "/assets?tab=construction-in-progress",
      ),
  }),
  capitalMutation({
    name: "manage_asset_components",
    title: "Manage Asset Components",
    description:
      "Attach or detach an existing asset as a component, or create a draft component under a parent asset. Find parent and component ids with search_assets.",
    permission: "assets.manage",
    featureKey: "assetComponents",
    inputSchema: z.discriminatedUnion("action", [
      z.strictObject({
        action: field(z.literal("attach"), "Attach an existing asset to the parent."),
        parentAssetId: field(UUID, "Parent asset id."),
        componentAssetId: field(UUID, "Existing asset to attach."),
        reason: OPTIONAL_TEXT(2000, "Reason for the attachment."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("detach"), "Detach an existing component."),
        parentAssetId: field(UUID, "Parent asset id."),
        componentAssetId: field(UUID, "Component asset to detach."),
        reason: field(z.string().trim().min(1).max(2000), "Reason for detaching the component."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("create"), "Create a new draft component."),
        parentAssetId: field(UUID, "Parent asset id."),
        name: field(z.string().trim().min(1).max(200), "Component name."),
        categoryId: field(UUID, "Asset category."),
        acquisitionCost: field(MONEY, "Exact acquisition cost."),
        acquiredOn: field(CALENDAR_DATE.nullable().optional(), "Acquisition date."),
        inServiceOn: field(CALENDAR_DATE.nullable().optional(), "In-service date."),
        description: OPTIONAL_TEXT(4000, "Component description."),
        serialNumber: OPTIONAL_TEXT(200, "Serial number."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ]),
    execute: async (context, input) => {
      const common = {
        actorId: context.authz.user.id,
        allowedSubsidiaryIds: subsidiaryScope(context),
      };
      const result =
        input.action === "attach"
          ? await attachAssetComponent(context.authz.user.orgId, {
              parentAssetId: input.parentAssetId,
              componentAssetId: input.componentAssetId,
              reason: input.reason ?? null,
              ...common,
            })
          : input.action === "detach"
            ? await detachAssetComponent(context.authz.user.orgId, {
                componentAssetId: input.componentAssetId,
                reason: input.reason,
                ...common,
              })
            : await createAssetComponent(context.authz.user.orgId, {
                parentAssetId: input.parentAssetId,
                actorId: common.actorId,
                allowedSubsidiaryIds: common.allowedSubsidiaryIds,
                name: input.name,
                categoryId: input.categoryId,
                acquisitionCost: input.acquisitionCost,
                acquiredOn: input.acquiredOn ?? null,
                inServiceOn: input.inServiceOn ?? null,
                description: input.description ?? null,
                serialNumber: input.serialNumber ?? null,
              });
      return resultWithHref(result, `/assets?assetId=${input.parentAssetId}`);
    },
  }),
  capitalMutation({
    name: "dispose_compound_asset",
    title: "Dispose Compound Asset",
    description:
      "Dispose a parent asset and all live components in one transaction, allocating sale proceeds by carrying value. Find the parent asset with search_assets.",
    permission: "assets.manage",
    featureKey: "assetComponents",
    destructive: true,
    inputSchema: z.strictObject({
      parentAssetId: field(UUID, "Parent asset and compound group to dispose."),
      date: field(CALENDAR_DATE, "Disposal date."),
      proceeds: field(
        MONEY.nullable().optional(),
        "Total exact sale proceeds, defaulting to zero.",
      ),
      proceedsAccountId: field(UUID.nullable().optional(), "Account receiving sale proceeds."),
      writeOff: field(z.boolean().optional(), "Set true for a no-proceeds write-off."),
      reason: field(
        z.string().trim().min(1).max(2000),
        "Reason for disposing of the compound asset.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) =>
      resultWithHref(
        await disposeCompoundAsset(context.authz.user.orgId, {
          parentAssetId: input.parentAssetId,
          date: input.date,
          proceeds: input.proceeds ?? "0",
          proceedsAccountId: input.proceedsAccountId ?? null,
          writeOff: input.writeOff === true,
          reason: input.reason,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: subsidiaryScope(context),
        }),
        "/assets",
      ),
  }),
  capitalMutation({
    name: "manage_asset_maintenance",
    title: "Manage Asset Maintenance",
    description:
      "Record maintenance performed on an asset or cancel a maintenance record entered in error. Find asset and schedule ids with the fixed-asset reads.",
    permission: "assets.maintain",
    featureKey: "assetMaintenance",
    destructive: true,
    inputSchema: z.discriminatedUnion("action", [
      z.strictObject({
        action: field(z.literal("record"), "Record completed maintenance."),
        assetId: field(UUID, "Asset serviced."),
        scheduleId: field(
          UUID.nullable().optional(),
          "Maintenance schedule satisfied by this work.",
        ),
        performedOn: field(CALENDAR_DATE, "Date performed."),
        usageReading: OPTIONAL_MONEY,
        description: field(z.string().trim().min(1).max(2000), "Work performed."),
        vendorPartyId: field(UUID.nullable().optional(), "Vendor who performed the work."),
        cost: OPTIONAL_MONEY,
        treatment: field(
          z.enum(["expense", "betterment"]),
          "Expense the work or propose it for capitalization.",
        ),
        sourceDocumentLineId: field(
          UUID.nullable().optional(),
          "Posted bill line paying for the maintenance.",
        ),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("cancel"), "Cancel an incorrectly entered maintenance record."),
        recordId: field(UUID, "Maintenance record to cancel."),
        reason: field(z.string().trim().min(1).max(2000), "Reason for the cancellation."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ]),
    execute: async (context, input) => {
      const options = {
        actorId: context.authz.user.id,
        allowedSubsidiaryIds: subsidiaryScope(context),
      };
      if (input.action === "cancel") {
        await cancelMaintenanceRecord(context.authz.user.orgId, {
          recordId: input.recordId,
          reason: input.reason,
          ...options,
        });
        return {
          ok: true,
          recordId: input.recordId,
          status: "cancelled",
          href: "/assets?tab=maintenance",
        };
      }
      const { action: _action, idempotencyKey: _key, ...record } = input;
      return resultWithHref(
        await recordMaintenance(context.authz.user.orgId, record, options),
        "/assets?tab=maintenance",
      );
    },
  }),
  capitalMutation({
    name: "create_asset_maintenance_schedule",
    title: "Create Asset Maintenance Schedule",
    description:
      "Schedule recurring time or usage based maintenance for an asset. Find the asset and vendor ids with fixed-asset and party reads.",
    permission: "assets.maintain",
    featureKey: "assetMaintenance",
    inputSchema: z.strictObject({
      assetId: field(UUID, "Asset that needs scheduled maintenance."),
      name: field(z.string().trim().min(1).max(200), "Maintenance task name."),
      description: OPTIONAL_TEXT(4000, "Task description."),
      intervalMonths: field(
        z.number().int().min(1).max(600).nullable().optional(),
        "Months between maintenance events.",
      ),
      intervalUsage: OPTIONAL_MONEY,
      usageUnit: OPTIONAL_TEXT(40, "Usage meter unit, such as hours or kilometres."),
      startsOn: field(CALENDAR_DATE, "First maintenance date."),
      vendorPartyId: field(UUID.nullable().optional(), "Preferred maintenance vendor."),
      estimatedCost: OPTIONAL_MONEY,
      leadDays: field(
        z.number().int().min(0).max(365).nullable().optional(),
        "Days before due date to alert.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...fields } = input;
      return resultWithHref(
        await createMaintenanceSchedule(context.authz.user.orgId, fields, {
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: subsidiaryScope(context),
        }),
        "/assets?tab=maintenance",
      );
    },
  }),
  capitalMutation({
    name: "update_asset_maintenance_schedule",
    title: "Update Asset Maintenance Schedule",
    description:
      "Change the terms or active status of an asset maintenance schedule; its next due point is recalculated. Find the schedule id in the maintenance view.",
    permission: "assets.maintain",
    featureKey: "assetMaintenance",
    inputSchema: z.strictObject({
      scheduleId: field(UUID, "Maintenance schedule to update."),
      name: field(z.string().trim().min(1).max(200), "Maintenance task name."),
      description: OPTIONAL_TEXT(4000, "Task description."),
      intervalMonths: field(
        z.number().int().min(1).max(600).nullable().optional(),
        "Months between maintenance events.",
      ),
      intervalUsage: OPTIONAL_MONEY,
      usageUnit: OPTIONAL_TEXT(40, "Usage meter unit."),
      startsOn: field(CALENDAR_DATE, "First maintenance date."),
      vendorPartyId: field(UUID.nullable().optional(), "Preferred maintenance vendor."),
      estimatedCost: OPTIONAL_MONEY,
      leadDays: field(
        z.number().int().min(0).max(365).nullable().optional(),
        "Days before due date to alert.",
      ),
      isActive: field(z.boolean(), "Whether this schedule remains active."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { scheduleId, idempotencyKey: _key, ...fields } = input;
      return resultWithHref(
        await updateMaintenanceSchedule(context.authz.user.orgId, scheduleId, fields, {
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: subsidiaryScope(context),
        }),
        "/assets?tab=maintenance",
      );
    },
  }),
  capitalMutation({
    name: "record_asset_meter_reading",
    title: "Record Asset Meter Reading",
    description:
      "Record an equipment meter reading used to determine maintenance due dates. Find the asset with search_assets.",
    permission: "assets.maintain",
    featureKey: "assetMaintenance",
    inputSchema: z.strictObject({
      assetId: field(UUID, "Asset with the meter."),
      readOn: field(CALENDAR_DATE, "Date of this meter reading."),
      reading: field(MONEY, "Exact cumulative meter amount as text."),
      unit: field(
        z.string().trim().min(1).max(40),
        "Meter unit, such as hours, cycles, or kilometres.",
      ),
      memo: OPTIONAL_TEXT(500, "Reading note."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...fields } = input;
      return resultWithHref(
        await recordUsageReading(context.authz.user.orgId, fields, {
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: subsidiaryScope(context),
        }),
        "/assets?tab=maintenance",
      );
    },
  }),
  capitalMutation({
    name: "create_asset_insurance_policy",
    title: "Create Asset Insurance Policy",
    description:
      "Record an insurance policy and coverage term for one legal entity's assets. Find insurer party and subsidiary ids with party and organization reads.",
    permission: "assets.maintain",
    featureKey: "assetInsurance",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity insured by the policy."),
      insurerPartyId: field(UUID, "Insurer party id."),
      policyNumber: field(z.string().trim().min(1).max(120), "Insurance policy number."),
      description: OPTIONAL_TEXT(2000, "Policy description."),
      coverageStartsOn: field(CALENDAR_DATE, "First day of coverage."),
      coverageEndsOn: field(CALENDAR_DATE, "Last day of coverage."),
      premium: OPTIONAL_MONEY,
      deductible: OPTIONAL_MONEY,
      renewalLeadDays: field(
        z.number().int().min(0).max(365).nullable().optional(),
        "Days ahead to flag renewal.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...fields } = input;
      return resultWithHref(
        await createInsurancePolicy(context.authz.user.orgId, fields, {
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: subsidiaryScope(context),
        }),
        "/assets?tab=insurance",
      );
    },
  }),
  capitalMutation({
    name: "update_asset_insurance_policy",
    title: "Update Asset Insurance Policy",
    description:
      "Update policy terms using the current updatedAt token as a concurrency guard. Find policy ids and updatedAt values in the insurance view.",
    permission: "assets.maintain",
    featureKey: "assetInsurance",
    inputSchema: z.strictObject({
      policyId: field(UUID, "Policy to update."),
      insurerPartyId: field(UUID, "Insurer party id."),
      policyNumber: field(z.string().trim().min(1).max(120), "Insurance policy number."),
      description: OPTIONAL_TEXT(2000, "Policy description."),
      coverageStartsOn: field(CALENDAR_DATE, "First day of coverage."),
      coverageEndsOn: field(CALENDAR_DATE, "Last day of coverage."),
      premium: OPTIONAL_MONEY,
      deductible: OPTIONAL_MONEY,
      renewalLeadDays: field(
        z.number().int().min(0).max(365).nullable().optional(),
        "Days ahead to flag renewal.",
      ),
      status: field(z.enum(["active", "cancelled"]), "Policy status."),
      expectedUpdatedAt: field(
        z.string().min(1).max(200),
        "Exact current update token from the policy read.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { policyId, idempotencyKey: _key, ...fields } = input;
      return resultWithHref(
        await updateInsurancePolicy(context.authz.user.orgId, policyId, fields, {
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: subsidiaryScope(context),
        }),
        "/assets?tab=insurance",
      );
    },
  }),
  capitalMutation({
    name: "manage_asset_insurance_coverage",
    title: "Manage Asset Insurance Coverage",
    description:
      "Add an asset to a policy, remove coverage with a reason, or renew the policy into a new coverage period. Find policy and asset ids in the insurance and asset reads.",
    permission: "assets.maintain",
    featureKey: "assetInsurance",
    destructive: true,
    inputSchema: z.discriminatedUnion("action", [
      z.strictObject({
        action: field(z.literal("set_coverage"), "Add or update coverage for an asset."),
        policyId: field(UUID, "Insurance policy id."),
        assetId: field(UUID, "Asset being insured."),
        insuredValue: field(MONEY, "Exact insured value."),
        replacementValue: OPTIONAL_MONEY,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("remove_coverage"), "Remove an asset from a policy."),
        policyId: field(UUID, "Insurance policy id."),
        assetId: field(UUID, "Asset to remove."),
        reason: field(z.string().trim().min(1).max(2000), "Reason for removing coverage."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("renew"), "Renew an insurance policy."),
        policyId: field(UUID, "Insurance policy id."),
        policyNumber: field(
          z.string().trim().max(120).nullable().optional(),
          "New policy number, if changed.",
        ),
        coverageStartsOn: field(CALENDAR_DATE, "First day of renewed coverage."),
        coverageEndsOn: field(CALENDAR_DATE, "Last day of renewed coverage."),
        premium: OPTIONAL_MONEY,
        deductible: OPTIONAL_MONEY,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ]),
    execute: async (context, input) => {
      const common = {
        policyId: input.policyId,
        actorId: context.authz.user.id,
        allowedSubsidiaryIds: subsidiaryScope(context),
      };
      if (input.action === "set_coverage")
        return resultWithHref(
          await setInsuranceCoverage(context.authz.user.orgId, {
            ...common,
            assetId: input.assetId,
            insuredValue: input.insuredValue,
            replacementValue: input.replacementValue ?? null,
          }),
          "/assets?tab=insurance",
        );
      if (input.action === "remove_coverage")
        return resultWithHref(
          await removeInsuranceCoverage(context.authz.user.orgId, {
            ...common,
            assetId: input.assetId,
            reason: input.reason,
          }),
          "/assets?tab=insurance",
        );
      return resultWithHref(
        await renewInsurancePolicy(context.authz.user.orgId, {
          ...common,
          policyNumber: input.policyNumber ?? null,
          coverageStartsOn: input.coverageStartsOn,
          coverageEndsOn: input.coverageEndsOn,
          premium: input.premium ?? null,
          deductible: input.deductible ?? null,
        }),
        "/assets?tab=insurance",
      );
    },
  }),
  capitalMutation({
    name: "link_manual_depreciation_entry",
    title: "Link Manual Depreciation Entry",
    description:
      "Link a posted hand journal entry to a depreciation schedule line so a later depreciation run cannot post the same amount twice. Find the asset schedule and journal entry ids with get_asset and ledger reads.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    inputSchema: z.strictObject({
      assetId: field(UUID, "Asset whose schedule line is being linked."),
      lineId: field(UUID, "Depreciation schedule line receiving the evidence."),
      entryId: field(UUID, "Posted manual journal entry used as evidence."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) =>
      resultWithHref(
        await linkManualDepreciationEntry(context.authz.user.orgId, input.assetId, {
          lineId: input.lineId,
          entryId: input.entryId,
          actorId: context.authz.user.id,
          ...(context.authz.allowedSubsidiaryIds
            ? { allowedSubsidiaryIds: [...context.authz.allowedSubsidiaryIds] }
            : {}),
        }),
        "/assets?tab=depreciation",
      ),
  }),
  capitalMutation({
    name: "rebuild_asset_schedules",
    title: "Rebuild Asset Schedules",
    description:
      "Rebuild stale depreciation schedules for a selected set of assets and optionally one active book. Find asset ids with search_assets and book ids with accounting setup reads.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    inputSchema: z.strictObject({
      bookId: field(
        UUID.nullable().optional(),
        "Active book to rebuild; omit to use the primary book.",
      ),
      assetIds: field(
        z.array(UUID).min(1).max(500),
        "Visible assets whose schedules need rebuilding.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const orgId = context.authz.user.orgId;
      if (input.bookId && !(await hasActiveDepreciationBook(orgId, input.bookId)))
        throw notFound("depreciation book");
      const assetIds = [...new Set(input.assetIds.map((id) => id.toLowerCase()))];
      const rows = await listVisibleDepreciationAssetNumbers({
        orgId,
        ids: assetIds,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
      });
      const byId = new Map(
        rows.map((row) => [String(row.id).toLowerCase(), String(row.asset_number)]),
      );
      if (assetIds.some((id) => !byId.has(id))) throw notFound("asset");
      const rebuilt: {
        assetId: string;
        assetNumber: string;
        scheduleId: string;
        lineCount: number;
        skippedMonths: string[];
      }[] = [];
      const problems: string[] = [];
      for (const assetId of assetIds) {
        try {
          const built = await buildSchedule(
            assetId,
            orgId,
            context.authz.user.id,
            input.bookId ?? undefined,
            context.authz.allowedSubsidiaryIds
              ? [...context.authz.allowedSubsidiaryIds]
              : undefined,
          );
          rebuilt.push({
            assetId,
            assetNumber: byId.get(assetId) ?? assetId,
            scheduleId: built.scheduleId,
            lineCount: built.lineCount,
            skippedMonths: built.skippedMonths,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          problems.push(
            `${byId.get(assetId) ?? assetId}: rebuild refused (${message.slice(0, 160)})`,
          );
        }
      }
      return { ok: true, rebuilt, problems, href: "/assets?tab=depreciation" };
    },
  }),
  capitalRead({
    name: "list_tax_depreciation_packs",
    title: "List Tax Depreciation Packs",
    description:
      "List the country tax depreciation packs that can be installed for this organization. Use the returned pack code with install_tax_depreciation_pack.",
    permission: "assets.read",
    featureKey: "fixedAssets",
    inputSchema: z.strictObject({}),
    execute: async () => ({
      ok: true,
      packs: taxDepreciationPacks(),
      href: "/assets?tab=tax-depreciation",
    }),
  }),
  capitalMutation({
    name: "install_tax_depreciation_pack",
    title: "Install Tax Depreciation Pack",
    description:
      "Install one supported country tax depreciation regime as the organization's effective tax setup. Find pack codes with list_tax_depreciation_packs; this organization-wide change requires unrestricted setup administration.",
    permission: "admin.setup.manage",
    featureKey: "fixedAssets",
    inputSchema: z.strictObject({
      code: field(z.string().trim().min(1).max(100), "Supported tax depreciation pack code."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
      return resultWithHref(
        await installTaxDepreciationPack(
          context.authz.user.orgId,
          input.code,
          context.authz.user.id,
        ),
        "/assets?tab=tax-depreciation",
      );
    },
  }),
  capitalMutation({
    name: "assign_asset_tax_category",
    title: "Assign Asset Tax Category",
    description:
      "Assign a tax regime and class code to a fixed-asset category for tax-pool reporting. Find category ids with setup reads and regime codes from the installed tax pack.",
    permission: "admin.setup.manage",
    featureKey: "fixedAssets",
    inputSchema: z.strictObject({
      categoryId: field(UUID, "Asset category receiving the tax assignment."),
      regime: field(z.string().trim().min(1).max(100), "Installed tax depreciation regime code."),
      classCode: field(
        z.string().trim().min(1).max(100).nullable().optional(),
        "Tax class code supported by this regime.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
      const result = await assignAssetTaxCategory({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        categoryId: input.categoryId,
        regime: input.regime,
        classCode: input.classCode ?? null,
      });
      switch (result.kind) {
        case "regime_not_found":
          throw invalidInput("The tax regime is not installed.", {
            remedy: "Install the organization's tax depreciation pack and retry.",
          });
        case "invalid_class":
          throw invalidInput("The tax class is not supported by this regime.", {
            remedy: "Choose a supported class from the installed regime.",
          });
        case "category_not_found":
          throw notFound("asset category");
        case "open_pool":
          throw invalidInput(
            `Cannot remove tax class ${result.classCode} while its pool has a nonzero balance.`,
            { remedy: "Keep or restore the class assignment until the pool is closed." },
          );
        default:
          return { ok: true, ...result, href: "/assets?tab=tax-depreciation" };
      }
    },
  }),
  capitalMutation({
    name: "run_asset_tax_pool",
    title: "Run Asset Tax Pool",
    description:
      "Calculate and post tax depreciation pools for a complete calendar tax year. Find available regime, book and subsidiary ids with the tax setup and organization reads; a short-year window is refused until a regime factor is configured.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    inputSchema: z.strictObject({
      regime: field(
        z.string().trim().min(1).max(100).optional(),
        "Installed tax regime code; if omitted, use the first available regime as the route does.",
      ),
      taxYear: field(z.number().int().min(1000).max(9999), "Four-digit tax year."),
      yearStart: field(
        CALENDAR_DATE.optional(),
        "Optional tax-year start; only the full calendar year is supported.",
      ),
      yearEnd: field(
        CALENDAR_DATE.optional(),
        "Optional tax-year end; only the full calendar year is supported.",
      ),
      bookId: field(
        UUID.optional(),
        "Active accounting book; defaults to the primary posting book.",
      ),
      subsidiaryId: field(UUID.optional(), "Subsidiary to run; defaults to the organization root."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const orgId = context.authz.user.orgId;
      const regimes = await listTaxRegimes(orgId);
      const regime = input.regime ?? regimes[0]?.code;
      if (!regime || !regimes.some((item) => item.code === regime))
        throw invalidInput("The tax depreciation regime is not enabled for this organization.", {
          remedy: "Install a supported tax depreciation pack.",
        });
      if (!Number.isSafeInteger(input.taxYear) || !isIsoCalendarDate(`${input.taxYear}-01-01`))
        throw invalidInput("Tax year must be a runnable calendar year.");
      const yearStart = input.yearStart ?? `${input.taxYear}-01-01`;
      const yearEnd = input.yearEnd ?? `${input.taxYear}-12-31`;
      if (yearStart > yearEnd) throw invalidInput("Year start must not follow year end.");
      if (yearStart !== `${input.taxYear}-01-01` || yearEnd !== `${input.taxYear}-12-31`)
        throw invalidInput("Short tax-year windows are not supported.", {
          remedy:
            "Run the full calendar tax year because no regime-specific short-year factor is configured.",
        });
      const bookId = input.bookId
        ? ((await findActiveTaxPoolBook(orgId, input.bookId))?.id ?? null)
        : await activePostingPrimaryBookId(orgId);
      if (input.bookId && !bookId) throw notFound("accounting book");
      let subsidiaryId: string | null;
      if (input.subsidiaryId) {
        if (
          context.authz.allowedSubsidiaryIds !== null &&
          !context.authz.allowedSubsidiaryIds.has(input.subsidiaryId)
        )
          throw forbidden("subsidiary.restricted");
        subsidiaryId = (await findTaxPoolSubsidiary(orgId, input.subsidiaryId))?.id ?? null;
      } else {
        try {
          subsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, orgId));
        } catch (error) {
          if (!(error instanceof SubsidiaryError)) throw error;
          subsidiaryId = null;
        }
      }
      if (!bookId || !subsidiaryId)
        throw invalidInput("No posting book or subsidiary is configured.", {
          remedy: "Configure an active accounting book and subsidiary before running tax pools.",
        });
      if (
        context.authz.allowedSubsidiaryIds !== null &&
        !context.authz.allowedSubsidiaryIds.has(subsidiaryId)
      )
        throw forbidden("subsidiary.restricted");
      return resultWithHref(
        await runTaxPool(orgId, bookId, subsidiaryId, regime, input.taxYear, {
          yearStart,
          yearEnd,
          actorId: context.authz.user.id,
        }),
        "/assets?tab=tax-depreciation",
      );
    },
  }),
];
