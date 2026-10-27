import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { createFund, listFunds } from "@openbooks/engine/nonprofit/funds";
import {
  closeGrant,
  closeOutGrant,
  createGrant,
  createGrantDrawdown,
  createGrantReport,
  listGrants,
  activateGrant,
  satisfyGrantBarrier,
  submitGrantDrawdown,
  submitGrantReport,
  awardGrant,
  recordGrantDrawdown,
  recognizeGrantDrawdown,
  amendGrant,
  voidGrant,
  voidGrantDrawdown,
} from "@openbooks/engine/nonprofit/grants";
import {
  createFundRelease,
  listFundReleases,
  submitFundRelease,
  voidFundRelease,
} from "@openbooks/engine/nonprofit/releases";
import {
  closeEncumbrance,
  createEncumbrance,
  encumbranceSubsidiaryId,
  linkEncumbranceDocumentLine,
  listEncumbrances,
  voidEncumbrance,
} from "@openbooks/engine/nonprofit/encumbrances";
import {
  bookPledge,
  cancelPledge,
  collectPledgeInstallments,
  createPledge,
  getPledgeSchedule,
  runPledgeDiscountAmortization,
  topUpPledgeAllowance,
  writeOffPledge,
} from "@openbooks/engine/nonprofit/pledges";
import {
  capitalMutation,
  capitalRead,
  DATE,
  field,
  IDEMPOTENCY_KEY,
  MONEY,
  requireUnrestricted,
  resultWithHref,
  subsidiaryScope,
  UUID,
} from "./capital-tools-common";
import { notFound, forbidden } from "./errors";

const CALENDAR_DATE = field(DATE, "Calendar date in YYYY-MM-DD format.");
const amountText = field(MONEY, "Exact money amount as a decimal string.");
const reason = field(z.string().trim().min(1).max(2000), "Reason recorded with this action.");
const postingAccounts = z.strictObject({
  bankAccountId: field(UUID, "Bank or cash account id."),
  grantsReceivableAccountId: field(UUID, "Grant receivable account id."),
  refundableAdvanceAccountId: field(UUID, "Refundable advance liability account id."),
  grantRevenueAccountId: field(UUID, "Grant revenue account id."),
  exchangeReceivableAccountId: field(UUID, "Exchange transaction receivable account id."),
  exchangeRevenueAccountId: field(UUID, "Exchange transaction revenue account id."),
});
const grantChanges = z.strictObject({
  name: field(z.string().optional(), "Replacement grant name."),
  sponsorPartyId: field(UUID.optional(), "Replacement sponsor party."),
  sponsorKind: field(
    z.enum(["government", "foundation", "corporate"]).optional(),
    "Replacement sponsor classification.",
  ),
  determination: field(
    z.enum(["contribution_unconditional", "contribution_conditional", "exchange"]).optional(),
    "Replacement accounting determination.",
  ),
  barrier: field(z.string().nullable().optional(), "Replacement conditional contribution barrier."),
  rightOfReturn: field(z.boolean().optional(), "Whether the agreement includes a right of return."),
  awardAmount: field(MONEY.optional(), "Replacement exact grant award amount."),
  periodFrom: field(DATE.optional(), "Replacement period start date."),
  periodTo: field(DATE.optional(), "Replacement period end date."),
  indirectRate: field(z.string().optional(), "Replacement exact indirect cost rate."),
  indirectBase: field(
    z.enum(["direct_costs", "modified_total_direct"]).optional(),
    "Replacement indirect cost base.",
  ),
  mtdcExclusionAccountGroupId: field(
    UUID.nullable().optional(),
    "Replacement MTDC exclusion account group.",
  ),
  mtdcSubawardAccountGroupId: field(
    UUID.nullable().optional(),
    "Replacement subaward account group.",
  ),
  mtdcSubawardThreshold: field(
    MONEY.nullable().optional(),
    "Replacement exact MTDC subaward threshold.",
  ),
  costShareRequired: field(z.boolean().optional(), "Whether cost sharing is required."),
  costShareAmount: field(MONEY.optional(), "Replacement exact required cost share."),
  fundId: field(UUID.optional(), "Replacement grant fund."),
  allowableAccountGroupId: field(UUID.optional(), "Replacement allowable expense account group."),
});

export const CAPITAL_NONPROFIT_TOOLS = [
  capitalRead({
    name: "list_funds",
    title: "List Funds",
    description:
      "Search active nonprofit funds and read their restriction and budgetary-control settings. Use returned fund ids when creating grants, releases, pledges or encumbrances.",
    permission: "funds.read",
    featureKey: "fundAccounting",
    inputSchema: z.strictObject({
      search: field(z.string().max(200).optional(), "Optional fund code or name search."),
      includeInactive: field(z.boolean().optional(), "Include inactive funds."),
      limit: field(z.number().int().min(1).max(200).optional(), "Page size."),
      offset: field(z.number().int().min(0).optional(), "Zero-based page offset."),
    }),
    execute: async (context, input) => ({
      ok: true,
      ...(await listFunds({ orgId: context.authz.user.orgId, ...input })),
      href: "/nonprofit/funds",
    }),
  }),
  capitalMutation({
    name: "create_fund",
    title: "Create Fund",
    description:
      "Create a fund with its restriction class and budgetary-control mode. Find current funds with list_funds and configure organization-wide nonprofit setup before creating one.",
    permission: "funds.manage",
    featureKey: "fundAccounting",
    inputSchema: z.strictObject({
      action: field(z.literal("create"), "Create a fund."),
      code: field(z.string().trim().min(1).max(40), "Short unique fund code."),
      name: field(z.string().trim().min(1).max(200), "Fund name."),
      kind: field(
        z.enum(["operating", "restricted", "endowment", "plant", "board_designated"]),
        "Fund classification.",
      ),
      restrictionClass: field(
        z.string().trim().min(1).max(80),
        "Restriction classification supported by the nonprofit framework.",
      ),
      budgetaryControl: field(
        z.enum(["off", "advisory", "hard"]),
        "Budget commitment control mode.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      requireUnrestricted(context);
      const { action: _action, idempotencyKey: _key, ...body } = input;
      return resultWithHref(
        await createFund({
          ...body,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
        }),
        "/nonprofit/funds",
      );
    },
  }),
  capitalRead({
    name: "list_fund_releases",
    title: "List Fund Releases",
    description:
      "Search fund releases and inspect draft, pending, posted or void status before submitting or reversing one. Find source and destination funds with list_funds.",
    permission: "funds.read",
    featureKey: "fundAccounting",
    inputSchema: z.strictObject({
      search: field(
        z.string().max(200).optional(),
        "Optional release number, purpose or satisfaction reference search.",
      ),
      status: field(
        z.enum(["draft", "pending_approval", "posted", "void"]).optional(),
        "Optional release status filter.",
      ),
      limit: field(z.number().int().min(1).max(200).optional(), "Page size."),
      offset: field(z.number().int().min(0).optional(), "Zero-based page offset."),
    }),
    execute: async (context, input) => ({
      ok: true,
      ...(await listFundReleases({ orgId: context.authz.user.orgId, ...input })),
      href: "/nonprofit/releases",
    }),
  }),
  capitalMutation({
    name: "create_fund_release",
    title: "Create Fund Release",
    description:
      "Create a draft release that transfers an exact amount between funds for a documented purpose. Find fund and release-account ids with list_funds and account reads.",
    permission: "funds.manage",
    featureKey: "fundAccounting",
    inputSchema: z.strictObject({
      fromFundId: field(UUID, "Fund releasing the balance."),
      toFundId: field(UUID, "Fund receiving the balance."),
      releaseAccountId: field(UUID, "Account used for the release posting."),
      releaseDate: field(CALENDAR_DATE, "Release effective date."),
      amount: amountText,
      purpose: field(z.string().trim().min(1).max(2000), "Purpose of the release."),
      satisfactionRef: field(
        z.string().trim().min(1).max(2000),
        "Reference proving the restriction was satisfied.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      requireUnrestricted(context);
      const { idempotencyKey: _key, ...body } = input;
      return resultWithHref(
        await createFundRelease({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          ...body,
        }),
        "/nonprofit/releases",
      );
    },
  }),
  capitalMutation({
    name: "post_fund_release",
    title: "Post Fund Release",
    description:
      "Submit a draft fund release for posting through the configured approval and ledger controls, or void a posted release with a reason and date. Find release ids with list_fund_releases.",
    permission: ["funds.manage", "gl.post"],
    featureKey: "fundAccounting",
    destructive: true,
    inputSchema: z.discriminatedUnion("action", [
      z.strictObject({
        action: field(z.literal("submit"), "Submit a draft release for approval and posting."),
        releaseId: field(UUID, "Fund release to submit."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("void"), "Void a posted fund release."),
        releaseId: field(UUID, "Posted fund release to reverse."),
        voidDate: field(CALENDAR_DATE, "Date of the reversing entry."),
        reason,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ]),
    execute: async (context, input) => {
      requireUnrestricted(context);
      if (input.action === "submit")
        return resultWithHref(
          {
            release: await submitFundRelease({
              orgId: context.authz.user.orgId,
              releaseId: input.releaseId,
              actorId: context.authz.user.id,
            }),
          },
          "/nonprofit/releases",
        );
      return resultWithHref(
        {
          release: await voidFundRelease({
            orgId: context.authz.user.orgId,
            releaseId: input.releaseId,
            actorId: context.authz.user.id,
            voidDate: input.voidDate,
            reason: input.reason,
          }),
        },
        "/nonprofit/releases",
      );
    },
  }),
  capitalRead({
    name: "list_grants",
    title: "List Grants",
    description:
      "Search current grant awards by state, fund or code and name. Use returned grant ids for award, drawdown, reporting and closeout actions.",
    permission: "grants.read",
    featureKey: "grantManagement",
    inputSchema: z.strictObject({
      status: field(
        z
          .union([
            z.enum(["draft", "awarded", "active", "closed_out", "closed", "void"]),
            z.array(z.enum(["draft", "awarded", "active", "closed_out", "closed", "void"])),
          ])
          .optional(),
        "Grant status filter.",
      ),
      fundId: field(UUID.optional(), "Filter to a fund."),
      q: field(z.string().max(200).optional(), "Search grant code or name."),
      limit: field(z.number().int().min(1).max(200).optional(), "Page size."),
      offset: field(z.number().int().min(0).optional(), "Zero-based page offset."),
    }),
    execute: async (context, input) => {
      requireUnrestricted(context);
      return {
        ok: true,
        ...(await listGrants({ orgId: context.authz.user.orgId, ...input })),
        href: "/nonprofit/grants",
      };
    },
  }),
  capitalMutation({
    name: "manage_grant_lifecycle",
    title: "Manage Grant Lifecycle",
    description:
      "Create or activate a grant, satisfy its barrier, create or submit drawdowns and reports, or close out and close the award. Find grant ids with list_grants and fund ids with list_funds.",
    permission: "grants.manage",
    featureKey: "grantManagement",
    destructive: true,
    inputSchema: z.discriminatedUnion("action", [
      z.strictObject({
        action: field(z.literal("create"), "Create a grant award."),
        code: field(z.string().trim().min(1).max(40), "Grant code."),
        name: field(z.string().trim().min(1).max(200), "Grant name."),
        sponsorPartyId: field(UUID, "Grant sponsor party."),
        sponsorKind: field(
          z.enum(["government", "foundation", "corporate"]),
          "Sponsor classification.",
        ),
        determination: field(
          z.enum(["contribution_unconditional", "contribution_conditional", "exchange"]),
          "Accounting determination.",
        ),
        barrier: field(
          z.string().nullable().optional(),
          "Conditional contribution barrier, if applicable.",
        ),
        rightOfReturn: field(
          z.boolean().optional(),
          "Whether the agreement includes a right of return.",
        ),
        awardAmount: amountText,
        periodFrom: field(CALENDAR_DATE, "Grant period start date."),
        periodTo: field(CALENDAR_DATE, "Grant period end date."),
        indirectRate: field(z.string().optional(), "Exact indirect cost rate as text."),
        indirectBase: field(
          z.enum(["direct_costs", "modified_total_direct"]).optional(),
          "Indirect cost base.",
        ),
        mtdcExclusionAccountGroupId: field(
          UUID.nullable().optional(),
          "Account group excluded from the modified total direct cost base.",
        ),
        mtdcSubawardAccountGroupId: field(
          UUID.nullable().optional(),
          "Subaward account group for MTDC treatment.",
        ),
        mtdcSubawardThreshold: field(
          MONEY.nullable().optional(),
          "Exact subaward threshold as text.",
        ),
        costShareRequired: field(z.boolean().optional(), "Whether cost sharing is required."),
        costShareAmount: field(MONEY.optional(), "Exact required cost share as text."),
        fundId: field(UUID, "Fund assigned to the grant."),
        allowableAccountGroupId: field(UUID, "Account group defining allowable expenses."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("activate"), "Activate an awarded grant."),
        grantId: field(UUID, "Grant to activate."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(
          z.literal("satisfyBarrier"),
          "Record evidence that satisfies a grant barrier.",
        ),
        grantId: field(UUID, "Grant whose barrier is satisfied."),
        evidence: field(
          z.string().trim().min(1).max(4000),
          "Evidence that the barrier was satisfied.",
        ),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("createDrawdown"), "Create a grant cash drawdown."),
        grantId: field(UUID, "Grant associated with the drawdown."),
        amount: amountText,
        kind: field(z.enum(["advance", "reimbursement", "final"]), "Drawdown classification."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("submitDrawdown"), "Submit a drawdown for review."),
        drawdownId: field(UUID, "Drawdown to submit."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("createReport"), "Create a grant report."),
        grantId: field(UUID, "Grant requiring the report."),
        title: field(z.string().trim().min(1).max(200), "Report title."),
        dueOn: field(CALENDAR_DATE, "Report due date."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("submitReport"), "Submit a prepared grant report."),
        reportId: field(UUID, "Report to submit."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("closeOut"), "Close out a completed grant."),
        grantId: field(UUID, "Grant to close out."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("close"), "Close a grant that has completed its lifecycle."),
        grantId: field(UUID, "Grant to close."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ]),
    execute: async (context, input) => {
      requireUnrestricted(context);
      const orgId = context.authz.user.orgId;
      const actorId = context.authz.user.id;
      switch (input.action) {
        case "create": {
          const { action: _action, idempotencyKey: _key, ...body } = input;
          return resultWithHref(
            { grant: await createGrant({ ...body, orgId, actorId }) },
            "/nonprofit/grants",
          );
        }
        case "activate":
          return resultWithHref(
            { grant: await activateGrant({ orgId, grantId: input.grantId, actorId }) },
            `/nonprofit/grants?grant=${input.grantId}`,
          );
        case "satisfyBarrier":
          return resultWithHref(
            {
              grant: await satisfyGrantBarrier({
                orgId,
                grantId: input.grantId,
                evidence: input.evidence,
                actorId,
              }),
            },
            `/nonprofit/grants?grant=${input.grantId}`,
          );
        case "createDrawdown":
          return resultWithHref(
            {
              drawdown: await createGrantDrawdown({
                orgId,
                grantId: input.grantId,
                amount: input.amount,
                kind: input.kind,
                actorId,
              }),
            },
            `/nonprofit/grants?grant=${input.grantId}`,
          );
        case "submitDrawdown":
          return resultWithHref(
            {
              drawdown: await submitGrantDrawdown({ orgId, drawdownId: input.drawdownId, actorId }),
            },
            "/nonprofit/grants",
          );
        case "createReport":
          return resultWithHref(
            {
              report: await createGrantReport({
                orgId,
                grantId: input.grantId,
                title: input.title,
                dueOn: input.dueOn,
                actorId,
              }),
            },
            `/nonprofit/grants?grant=${input.grantId}`,
          );
        case "submitReport":
          return resultWithHref(
            { report: await submitGrantReport({ orgId, reportId: input.reportId, actorId }) },
            "/nonprofit/grants",
          );
        case "closeOut":
          return resultWithHref(
            { grant: await closeOutGrant({ orgId, grantId: input.grantId, actorId }) },
            `/nonprofit/grants?grant=${input.grantId}`,
          );
        case "close":
          return resultWithHref(
            { grant: await closeGrant({ orgId, grantId: input.grantId, actorId }) },
            `/nonprofit/grants?grant=${input.grantId}`,
          );
      }
    },
  }),
  capitalMutation({
    name: "post_grant_action",
    title: "Post Grant Action",
    description:
      "Post a grant award or drawdown, recognize a drawdown, amend an award, or reverse a grant or drawdown through the configured general ledger controls. Find ids with list_grants and its detail reads.",
    permission: ["grants.manage", "gl.post"],
    featureKey: "grantManagement",
    destructive: true,
    inputSchema: z.discriminatedUnion("action", [
      z.strictObject({
        action: field(z.literal("award"), "Post a grant award."),
        grantId: field(UUID, "Grant to award."),
        accounts: postingAccounts,
        postingDate: field(CALENDAR_DATE, "Posting date."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("recordDrawdown"), "Post a drawdown receipt."),
        grantId: field(UUID, "Grant receiving cash."),
        drawdownId: field(UUID.optional(), "Existing drawdown record, when applicable."),
        amount: amountText,
        kind: field(z.enum(["advance", "reimbursement", "final"]), "Drawdown classification."),
        accounts: postingAccounts,
        postingDate: field(CALENDAR_DATE, "Posting date."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(
          z.literal("recognizeDrawdown"),
          "Recognize conditional grant revenue from a drawdown.",
        ),
        drawdownId: field(UUID, "Drawdown to recognize."),
        grantRevenueAccountId: field(UUID, "Grant revenue account."),
        refundableAdvanceAccountId: field(UUID, "Refundable advance account."),
        postingDate: field(CALENDAR_DATE, "Posting date."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(
          z.literal("amend"),
          "Amend grant terms and post required accounting adjustments.",
        ),
        grantId: field(UUID, "Grant to amend."),
        reason,
        changes: field(grantChanges, "Only supply grant terms that should change."),
        accounts: postingAccounts,
        postingDate: field(CALENDAR_DATE, "Posting date."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("void"), "Void a grant and reverse its posted accounting."),
        grantId: field(UUID, "Grant to void."),
        postingDate: field(CALENDAR_DATE, "Reversal posting date."),
        reason,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(
          z.literal("voidDrawdown"),
          "Void a grant drawdown and reverse its accounting.",
        ),
        drawdownId: field(UUID, "Drawdown to void."),
        postingDate: field(CALENDAR_DATE, "Reversal posting date."),
        reason,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ]),
    execute: async (context, input) => {
      requireUnrestricted(context);
      const orgId = context.authz.user.orgId;
      const actorId = context.authz.user.id;
      switch (input.action) {
        case "award":
          return resultWithHref(
            await awardGrant({
              orgId,
              grantId: input.grantId,
              accounts: input.accounts,
              postingDate: input.postingDate,
              actorId,
            }),
            `/nonprofit/grants?grant=${input.grantId}`,
          );
        case "recordDrawdown":
          return resultWithHref(
            await recordGrantDrawdown({
              orgId,
              grantId: input.grantId,
              drawdownId: input.drawdownId,
              amount: input.amount,
              kind: input.kind,
              accounts: input.accounts,
              postingDate: input.postingDate,
              actorId,
            }),
            `/nonprofit/grants?grant=${input.grantId}`,
          );
        case "recognizeDrawdown":
          return resultWithHref(
            await recognizeGrantDrawdown({
              orgId,
              drawdownId: input.drawdownId,
              grantRevenueAccountId: input.grantRevenueAccountId,
              refundableAdvanceAccountId: input.refundableAdvanceAccountId,
              postingDate: input.postingDate,
              actorId,
            }),
            "/nonprofit/grants",
          );
        case "amend":
          return resultWithHref(
            {
              grant: await amendGrant({
                orgId,
                grantId: input.grantId,
                reason: input.reason,
                changes: input.changes,
                accounts: input.accounts,
                postingDate: input.postingDate,
                actorId,
              }),
            },
            `/nonprofit/grants?grant=${input.grantId}`,
          );
        case "void":
          return resultWithHref(
            {
              grant: await voidGrant({
                orgId,
                grantId: input.grantId,
                postingDate: input.postingDate,
                reason: input.reason,
                actorId,
              }),
            },
            `/nonprofit/grants?grant=${input.grantId}`,
          );
        case "voidDrawdown":
          await voidGrantDrawdown({
            orgId,
            drawdownId: input.drawdownId,
            postingDate: input.postingDate,
            reason: input.reason,
            actorId,
          });
          return { ok: true, status: "void", href: "/nonprofit/grants" };
      }
    },
  }),
  capitalRead({
    name: "list_encumbrances",
    title: "List Encumbrances",
    description:
      "Search open, closed and void commitments within the caller's legal-entity scope. Use returned ids to close, void or liquidate commitments.",
    permission: "encumbrances.read",
    featureKey: "encumbrances",
    inputSchema: z.strictObject({
      status: field(
        z
          .union([z.enum(["open", "closed", "void"]), z.array(z.enum(["open", "closed", "void"]))])
          .optional(),
        "Encumbrance status filter.",
      ),
      subsidiaryId: field(UUID.optional(), "Filter to one subsidiary."),
      accountId: field(UUID.optional(), "Filter to one account."),
      q: field(z.string().max(200).optional(), "Search commitment, source or account."),
      limit: field(z.number().int().min(1).max(200).optional(), "Page size."),
      offset: field(z.number().int().min(0).optional(), "Zero-based page offset."),
    }),
    execute: async (context, input) => ({
      ok: true,
      ...(await listEncumbrances({
        orgId: context.authz.user.orgId,
        ...input,
        allowedSubsidiaryIds: subsidiaryScope(context),
      })),
      href: "/nonprofit/encumbrances",
    }),
  }),
  capitalMutation({
    name: "manage_encumbrance",
    title: "Manage Encumbrance",
    description:
      "Commit a manual or purchase-order amount to an expense account and fund, or close or void a commitment with a reason. Find fund and account ids with list_funds and account reads.",
    permission: "encumbrances.manage",
    featureKey: "encumbrances",
    destructive: true,
    inputSchema: z.discriminatedUnion("action", [
      z.strictObject({
        action: field(z.literal("create"), "Create a commitment."),
        sourceKind: field(
          z.enum(["purchase_order", "manual"]),
          "Manual commitment or purchase-order commitment.",
        ),
        sourceId: field(UUID.optional(), "Purchase order id when sourceKind is purchase_order."),
        amount: amountText,
        accountId: field(UUID, "Expense account committed."),
        subsidiaryId: field(UUID, "Legal entity owning the commitment."),
        departmentId: field(UUID.optional(), "Department dimension."),
        projectId: field(UUID.optional(), "Project dimension."),
        locationId: field(UUID.optional(), "Location dimension."),
        classId: field(UUID.optional(), "Class dimension."),
        fundId: field(UUID, "Fund dimension."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("close"), "Close a commitment with no remaining activity."),
        encumbranceId: field(UUID, "Commitment to close."),
        reason,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("void"), "Void a commitment recorded in error."),
        encumbranceId: field(UUID, "Commitment to void."),
        reason,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ]),
    execute: async (context, input) => {
      const orgId = context.authz.user.orgId;
      const actorId = context.authz.user.id;
      if (input.action === "create") {
        const scope = context.authz.allowedSubsidiaryIds;
        if (scope !== null && !scope.has(input.subsidiaryId)) throw notFound("record");
        const { action: _action, idempotencyKey: _key, fundId, ...body } = input;
        return resultWithHref(
          await createEncumbrance({ ...body, orgId, actorId, extraDims: { fund: fundId } }),
          "/nonprofit/encumbrances",
        );
      }
      const subsidiaryId = await encumbranceSubsidiaryId(orgId, input.encumbranceId);
      if (!subsidiaryId) throw notFound("record");
      if (
        context.authz.allowedSubsidiaryIds !== null &&
        !context.authz.allowedSubsidiaryIds.has(subsidiaryId)
      )
        throw forbidden("subsidiary.restricted");
      if (input.action === "close") {
        await closeEncumbrance({
          orgId,
          encumbranceId: input.encumbranceId,
          reason: input.reason,
          actorId,
        });
        return {
          ok: true,
          encumbranceId: input.encumbranceId,
          status: "closed",
          href: "/nonprofit/encumbrances",
        };
      }
      await voidEncumbrance({
        orgId,
        encumbranceId: input.encumbranceId,
        reason: input.reason,
        actorId,
      });
      return {
        ok: true,
        encumbranceId: input.encumbranceId,
        status: "void",
        href: "/nonprofit/encumbrances",
      };
    },
  }),
  capitalMutation({
    name: "liquidate_encumbrance",
    title: "Liquidate Encumbrance",
    description:
      "Link a posted document line as an actual against a commitment. Find the commitment with list_encumbrances and the posted line with ledger or document reads.",
    permission: ["encumbrances.manage", "gl.post"],
    featureKey: "encumbrances",
    inputSchema: z.strictObject({
      encumbranceId: field(UUID, "Commitment receiving the actual expense."),
      documentLineId: field(UUID, "Posted document line being applied."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const orgId = context.authz.user.orgId;
      const subsidiaryId = await encumbranceSubsidiaryId(orgId, input.encumbranceId);
      if (!subsidiaryId) throw notFound("record");
      if (
        context.authz.allowedSubsidiaryIds !== null &&
        !context.authz.allowedSubsidiaryIds.has(subsidiaryId)
      )
        throw forbidden("subsidiary.restricted");
      return resultWithHref(
        await linkEncumbranceDocumentLine({
          orgId,
          encumbranceId: input.encumbranceId,
          documentLineId: input.documentLineId,
          actorId: context.authz.user.id,
        }),
        "/nonprofit/encumbrances",
      );
    },
  }),
  capitalRead({
    name: "list_pledges",
    title: "List Pledges",
    description:
      "Search pledges within the caller's legal-entity scope and read their booking state and amounts. Use returned pledge ids for booking, collections, allowance or schedule reads.",
    permission: "funds.read",
    featureKey: "pledges",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID.optional(), "Optional legal entity filter."),
      status: field(z.string().max(40).optional(), "Optional pledge status filter."),
      q: field(z.string().max(200).optional(), "Search pledge number or donor."),
      limit: field(z.number().int().min(1).max(200).optional(), "Page size."),
      offset: field(z.number().int().min(0).optional(), "Zero-based page offset."),
    }),
    execute: async (context, input) => {
      const rows = await db.execute<Record<string, unknown>>(
        sql`
        select p.id, p.pledge_number as "pledgeNumber", p.subsidiary_id as "subsidiaryId",
               p.donor_party_id as "donorPartyId", d.display_name as "donorName",
               p.fund_id as "fundId", p.total_amount::text as "totalAmount",
               p.present_value::text as "presentValue", p.allowance_amount::text as "allowanceAmount",
               p.status, p.booked_on::text as "bookedOn"
          from pledges p join parties d on d.org_id=p.org_id and d.id=p.donor_party_id
         where p.org_id=${context.authz.user.orgId}
           and (${input.subsidiaryId ?? null}::uuid is null or p.subsidiary_id=${input.subsidiaryId ?? null}::uuid)
           and (${input.status ?? null}::text is null or p.status=${input.status ?? null})
           and (${input.q ? `%${input.q}%` : null}::text is null or p.pledge_number ilike ${input.q ? `%${input.q}%` : null} or d.display_name ilike ${input.q ? `%${input.q}%` : null})
           ${context.authz.allowedSubsidiaryIds === null ? sql`` : sql`and p.subsidiary_id = any(${`{${[...context.authz.allowedSubsidiaryIds].join(",")}}`}::uuid[])`}
         order by p.pledge_number, p.id limit ${input.limit ?? 50} offset ${input.offset ?? 0}
      `,
        "objects",
      );
      return { ok: true, items: rows, href: "/nonprofit/pledges" };
    },
  }),
  capitalMutation({
    name: "create_pledge",
    title: "Create Pledge",
    description:
      "Record a donor's payment promise with exact installment amounts and due dates. Find donor, fund and subsidiary ids with party and nonprofit reads.",
    permission: "funds.manage",
    featureKey: "pledges",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity recording the pledge."),
      donorPartyId: field(UUID, "Donor party making the promise."),
      fundId: field(UUID, "Fund restricted or designated for the pledge."),
      totalAmount: amountText,
      discountRate: field(
        z.string().regex(/^\d+(\.\d{1,10})?$/),
        "Exact annual discount rate as a percentage string.",
      ),
      installments: field(
        z
          .array(
            z.strictObject({ dueOn: field(DATE, "Installment due date."), amount: amountText }),
          )
          .min(1)
          .max(600),
        "Dated installment schedule that totals the pledge amount.",
      ),
      reason,
      custom: field(z.record(z.string(), z.json()).optional(), "Configured custom pledge fields."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      if (
        context.authz.allowedSubsidiaryIds !== null &&
        !context.authz.allowedSubsidiaryIds.has(input.subsidiaryId)
      )
        throw forbidden("subsidiary.restricted");
      const { idempotencyKey: _key, ...body } = input;
      return resultWithHref(
        await createPledge({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          ...body,
        }),
        "/nonprofit/pledges",
      );
    },
  }),
  capitalRead({
    name: "get_pledge_schedule",
    title: "Get Pledge Schedule",
    description:
      "Read the booked pledge's installments, collections and discount amortization schedule as of a date. Find the pledge id with list_pledges.",
    permission: "funds.read",
    featureKey: "pledges",
    inputSchema: z.strictObject({
      pledgeId: field(UUID, "Pledge whose schedule is requested."),
      asOfDate: field(DATE, "Date used to calculate installment and amortization status."),
    }),
    execute: async (context, input) => {
      const rows = await db.execute<{ subsidiary_id: string }>(
        sql`select subsidiary_id from pledges where org_id=${context.authz.user.orgId} and id=${input.pledgeId}`,
        "objects",
      );
      const row = rows[0];
      if (!row) throw notFound("pledge");
      if (
        context.authz.allowedSubsidiaryIds !== null &&
        !context.authz.allowedSubsidiaryIds.has(row.subsidiary_id)
      )
        throw notFound("pledge");
      return {
        ok: true,
        ...(await getPledgeSchedule({ orgId: context.authz.user.orgId, ...input })),
        href: "/nonprofit/pledges",
      };
    },
  }),
  capitalMutation({
    name: "post_pledge_action",
    title: "Post Pledge Action",
    description:
      "Book a pledge, collect installments, top up its allowance, write off an uncollectible amount, or cancel a booked pledge through the ledger. Find pledge ids with list_pledges and schedules with get_pledge_schedule.",
    permission: ["funds.manage", "gl.post"],
    featureKey: "pledges",
    destructive: true,
    inputSchema: z.discriminatedUnion("action", [
      z.strictObject({
        action: field(z.literal("book"), "Book a draft pledge."),
        pledgeId: field(UUID, "Draft pledge to book."),
        postingDate: field(DATE, "Booking journal date."),
        receivableAccountId: field(UUID, "Pledge receivable account."),
        discountAccountId: field(UUID, "Unamortized discount account."),
        contributionsAccountId: field(UUID, "Contributions revenue account."),
        reason,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("collect"), "Post cash collected against installments."),
        pledgeId: field(UUID, "Pledge receiving the collection."),
        allocations: field(
          z
            .array(
              z.strictObject({
                installmentId: field(UUID, "Installment receiving this collection."),
                amount: amountText,
              }),
            )
            .min(1)
            .max(600),
          "Exact installment allocation amounts.",
        ),
        postingDate: field(DATE, "Collection journal date."),
        bankAccountId: field(UUID, "Bank account receiving cash."),
        receivableAccountId: field(UUID, "Pledge receivable account."),
        allowanceAccountId: field(
          UUID.optional(),
          "Allowance account when releasing the allowance.",
        ),
        contributionsAccountId: field(
          UUID.optional(),
          "Contributions account when allowance is released.",
        ),
        reason,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(
          z.literal("top_up_allowance"),
          "Increase the allowance for an uncollectible pledge balance.",
        ),
        pledgeId: field(UUID, "Pledge receiving the allowance."),
        amount: amountText,
        postingDate: field(DATE, "Allowance journal date."),
        contributionsAccountId: field(UUID, "Contributions account."),
        allowanceAccountId: field(UUID, "Allowance for uncollectible pledges."),
        reason,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("write_off"), "Write off uncollectible pledge installments."),
        pledgeId: field(UUID, "Pledge being written off."),
        amount: amountText,
        postingDate: field(DATE, "Write-off journal date."),
        receivableAccountId: field(UUID, "Pledge receivable account."),
        discountAccountId: field(UUID, "Unamortized discount account."),
        allowanceAccountId: field(UUID, "Allowance account."),
        contributionsAccountId: field(UUID, "Contributions revenue account."),
        reason,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(z.literal("cancel"), "Cancel a booked pledge with a reversing entry."),
        pledgeId: field(UUID, "Booked pledge to cancel."),
        reversalDate: field(DATE, "Reversing journal date."),
        reason,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      z.strictObject({
        action: field(
          z.literal("amortize_discount"),
          "Post discount amortization through a period end.",
        ),
        periodEnd: field(DATE, "Period end date."),
        discountAccountId: field(UUID, "Pledge discount account."),
        contributionsAccountId: field(UUID, "Contributions revenue account."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ]),
    execute: async (context, input) => {
      const orgId = context.authz.user.orgId;
      const actorId = context.authz.user.id;
      if ("pledgeId" in input) {
        const rows = await db.execute<{ subsidiary_id: string }>(
          sql`select subsidiary_id from pledges where org_id=${orgId} and id=${input.pledgeId}`,
          "objects",
        );
        if (!rows[0]) throw notFound("pledge");
        if (
          context.authz.allowedSubsidiaryIds !== null &&
          !context.authz.allowedSubsidiaryIds.has(rows[0].subsidiary_id)
        )
          throw notFound("pledge");
      } else if (input.action === "amortize_discount") {
        requireUnrestricted(context);
      }
      let result: unknown;
      switch (input.action) {
        case "book":
          result = await bookPledge({
            orgId,
            pledgeId: input.pledgeId,
            postingDate: input.postingDate,
            receivableAccountId: input.receivableAccountId,
            discountAccountId: input.discountAccountId,
            contributionsAccountId: input.contributionsAccountId,
            reason: input.reason,
            actorId,
          });
          break;
        case "collect":
          result = await collectPledgeInstallments({
            orgId,
            pledgeId: input.pledgeId,
            allocations: input.allocations,
            postingDate: input.postingDate,
            bankAccountId: input.bankAccountId,
            receivableAccountId: input.receivableAccountId,
            allowanceAccountId: input.allowanceAccountId,
            contributionsAccountId: input.contributionsAccountId,
            idempotencyKey: input.idempotencyKey,
            reason: input.reason,
            actorId,
          });
          break;
        case "top_up_allowance":
          result = await topUpPledgeAllowance({
            orgId,
            pledgeId: input.pledgeId,
            amount: input.amount,
            postingDate: input.postingDate,
            contributionsAccountId: input.contributionsAccountId,
            allowanceAccountId: input.allowanceAccountId,
            reason: input.reason,
            actorId,
          });
          break;
        case "write_off":
          result = await writeOffPledge({
            orgId,
            pledgeId: input.pledgeId,
            amount: input.amount,
            postingDate: input.postingDate,
            receivableAccountId: input.receivableAccountId,
            discountAccountId: input.discountAccountId,
            allowanceAccountId: input.allowanceAccountId,
            contributionsAccountId: input.contributionsAccountId,
            reason: input.reason,
            actorId,
          });
          break;
        case "cancel":
          result = await cancelPledge({
            orgId,
            pledgeId: input.pledgeId,
            reversalDate: input.reversalDate,
            reason: input.reason,
            actorId,
          });
          break;
        case "amortize_discount":
          result = await runPledgeDiscountAmortization({
            orgId,
            periodEnd: input.periodEnd,
            discountAccountId: input.discountAccountId,
            contributionsAccountId: input.contributionsAccountId,
            actorId,
          });
          break;
      }
      return resultWithHref(result, "/nonprofit/pledges");
    },
  }),
];
