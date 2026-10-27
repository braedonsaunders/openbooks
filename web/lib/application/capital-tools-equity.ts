import "server-only";
import { z } from "zod";
import {
  amendRound,
  amendShareClass,
  changePlanReserve,
  createPlan,
  createRound,
  createShareClass,
  electMfnTerms,
  issueSecurity,
  listEquityEntities,
  listSecurities,
  listStakeholders,
  loadCapTableView,
  loadStructure,
  modelEntityRound,
  pendingEquityActions,
  previewCompensationRun,
  previewInterestRun,
  postCompensationRun,
  postInterestRun,
  recordSecurityEvent,
  recordSplit,
  reverseMfnElection,
  runEntityWaterfallScenario,
  voidRound,
  withdrawEquityAction,
} from "@openbooks/engine/equity";
import { issueSecurityBody } from "../../app/api/equity/_schema";
import {
  capitalMutation,
  capitalRead,
  DATE,
  describeObjectFields,
  field,
  IDEMPOTENCY_KEY,
  INTEGER_TEXT,
  resultWithHref,
  UUID,
} from "./capital-tools-common";

const CODE = field(
  z.string().trim().min(1).max(40),
  "Short identifier unique within the legal entity.",
);
const NAME = field(z.string().trim().min(1).max(200), "Human-readable name.");
const DECIMAL = field(
  z.string().regex(/^\d{1,18}(\.\d{1,10})?$/),
  "Exact decimal amount, price, percentage, or rate as text.",
);
const OPTIONAL_DECIMAL = field(
  DECIMAL.nullable().optional(),
  "Optional exact decimal value as text.",
);
const REASON = field(
  z.string().trim().min(5).max(2000),
  "Reason recorded with this equity action.",
);
const currency = field(
  z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .nullable()
    .optional(),
  "Three-letter currency code, when specified.",
);

const issueBody = describeObjectFields(
  issueSecurityBody.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
  {
    subsidiaryId: "Legal entity issuing the security.",
    kind: "Security type: share, option, RSU, warrant, SAFE, or note.",
    holderPartyId: "Party receiving the security.",
    securityNumber: "Certificate or security number, if supplied.",
    issueDate: "Date the security is issued.",
    shareClassId: "Share class for share-based securities.",
    planId: "Equity plan for an option or award.",
    roundId: "Financing round associated with the security.",
    quantity: "Whole share or award quantity as text.",
    pricePerShare: "Exact price per share as text.",
    considerationAmount: "Exact cash consideration as text.",
    considerationAccountId: "General ledger account receiving consideration.",
    expirationDate: "Expiration date, when applicable.",
    optionType: "ISO or NSO tax classification for an option.",
    earlyExercise: "Whether unvested option shares may be exercised early.",
    unvestedRepurchaseBasis: "Repurchase basis for unvested shares.",
    safeType: "Pre-money or post-money SAFE terms.",
    mfn: "Whether the SAFE carries most-favored-nation terms.",
    valuationCap: "Exact valuation cap as text.",
    discountPercent: "Exact conversion discount percentage as text.",
    interestRatePercent: "Exact annual interest percentage as text.",
    interestBasis: "Accrual compounding convention.",
    interestDayCount: "Interest day-count convention.",
    currency: "Security denomination currency.",
    maturityDate: "Maturity date for a convertible note.",
    valuation: "Grant-date valuation assumptions for an award.",
    memo: "Optional issuance memo.",
    idempotencyKey: "Unique retry key for this exact issuance.",
    vestingStart: "Vesting start date.",
    vestingMonths: "Total vesting period in months.",
    cliffMonths: "Initial cliff period in months.",
    vestingFrequency: "Vesting frequency after the cliff.",
    vestingTranches: "Explicit dated vesting installments, when used.",
    acceleration: "Change-of-control acceleration rule.",
    accelerationPercent: "Exact percentage of acceleration, when applicable.",
  },
);

const eventCommon = {
  securityId: field(UUID, "Security receiving this event."),
  effectiveOn: field(DATE, "Date the security event takes effect."),
  idempotencyKey: IDEMPOTENCY_KEY,
  reason: field(
    z.string().trim().max(2000).nullable().optional(),
    "Reason recorded with the event.",
  ),
};
const eventBody = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: field(z.literal("exercise"), "Exercise options or warrants."),
    quantity: INTEGER_TEXT,
    considerationAccountId: field(
      UUID.nullable().optional(),
      "Account receiving exercise consideration.",
    ),
    ...eventCommon,
  }),
  z.strictObject({
    kind: field(z.literal("settle"), "Vest or settle shares or awards."),
    quantity: INTEGER_TEXT,
    ...eventCommon,
  }),
  z.strictObject({
    kind: field(z.literal("forfeit"), "Forfeit unvested award units."),
    quantity: INTEGER_TEXT,
    ...eventCommon,
  }),
  z.strictObject({
    kind: field(z.literal("expire"), "Expire an unexercised security."),
    quantity: INTEGER_TEXT,
    ...eventCommon,
  }),
  z.strictObject({
    kind: field(z.literal("cancel"), "Cancel an award or convertible instrument."),
    quantity: field(
      INTEGER_TEXT.nullable().optional(),
      "Units cancelled, when the security is unit-based.",
    ),
    ...eventCommon,
  }),
  z.strictObject({
    kind: field(z.literal("transfer"), "Transfer security ownership."),
    quantity: INTEGER_TEXT,
    transfereePartyId: field(UUID, "Party receiving the transferred units."),
    ...eventCommon,
  }),
  z.strictObject({
    kind: field(z.literal("convert"), "Convert a SAFE or note into shares."),
    quantity: field(INTEGER_TEXT.nullable().optional(), "Units converted, if applicable."),
    roundId: field(UUID.nullable().optional(), "Financing round for conversion."),
    targetShareClassId: field(UUID.nullable().optional(), "Share class issued on conversion."),
    ...eventCommon,
  }),
  z.strictObject({
    kind: field(z.literal("election_83b"), "Record a restricted stock holder's 83(b) election."),
    ...eventCommon,
  }),
  z.strictObject({
    kind: field(z.literal("repurchase"), "Repurchase shares into treasury."),
    quantity: INTEGER_TEXT,
    amount: field(DECIMAL.nullable().optional(), "Exact repurchase amount as text."),
    fairMarketValuePerShare: field(
      DECIMAL.nullable().optional(),
      "Exact fair market value per share as text.",
    ),
    considerationAccountId: field(
      UUID.nullable().optional(),
      "Account paying repurchase consideration.",
    ),
    ...eventCommon,
  }),
  z.strictObject({
    kind: field(z.literal("repay"), "Repay a SAFE or convertible note."),
    amount: DECIMAL,
    considerationAccountId: field(UUID, "Account used to pay the repayment."),
    ...eventCommon,
  }),
  z.strictObject({
    kind: field(z.literal("void"), "Void an event recorded in error."),
    ...eventCommon,
  }),
  z.strictObject({
    kind: field(z.literal("reverse"), "Reverse an existing security event."),
    reversesEventId: field(UUID, "Event being reversed."),
    ...eventCommon,
  }),
]);

export const CAPITAL_EQUITY_TOOLS = [
  capitalRead({
    name: "list_pending_equity_actions",
    title: "List Pending Equity Actions",
    description:
      "List equity changes awaiting an approval decision for a legal entity. Use the returned request ids with decide_approval or withdraw_equity_action.",
    permission: "equity.read",
    featureKey: "equity",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity whose pending equity actions are listed."),
    }),
    execute: async (context, input) => ({
      ok: true,
      items: await pendingEquityActions({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        subsidiaryId: input.subsidiaryId,
      }),
      href: `/equity?subsidiaryId=${input.subsidiaryId}&tab=actions`,
    }),
  }),
  capitalRead({
    name: "list_equity_entities",
    title: "List Equity Entities",
    description:
      "List active legal entities the caller can manage equity for. Use the returned subsidiary id in equity structure and cap table reads.",
    permission: "equity.read",
    featureKey: "equity",
    inputSchema: z.strictObject({}),
    execute: async (context) => ({
      ok: true,
      entities: await listEquityEntities({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
      }),
      href: "/equity",
    }),
  }),
  capitalRead({
    name: "get_equity_cap_table",
    title: "Get Equity Cap Table",
    description:
      "Read a legal entity's cap table as of a date, including holders and outstanding instruments. Find the entity id with list_equity_entities.",
    permission: "equity.read",
    featureKey: "equity",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity id from list_equity_entities."),
      asOf: field(DATE, "Date at which holdings are calculated."),
    }),
    execute: async (context, input) => ({
      ok: true,
      ...(await loadCapTableView({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      })),
      href: `/equity?subsidiaryId=${input.subsidiaryId}`,
    }),
  }),
  capitalRead({
    name: "get_equity_structure",
    title: "Get Equity Structure",
    description:
      "Read a legal entity's share classes, amendments, splits, plans, reserves and financing rounds. Find the entity id with list_equity_entities.",
    permission: "equity.read",
    featureKey: "equity",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity id from list_equity_entities."),
      asOf: field(DATE, "Date at which effective terms are resolved."),
    }),
    execute: async (context, input) => ({
      ok: true,
      ...(await loadStructure({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      })),
      href: `/equity?subsidiaryId=${input.subsidiaryId}`,
    }),
  }),
  capitalRead({
    name: "list_equity_securities",
    title: "List Equity Securities",
    description:
      "List shares, options, awards and convertible securities as of a date. Find the legal entity id with list_equity_entities and holder ids with party search.",
    permission: "equity.read",
    featureKey: "equity",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity id."),
      asOf: field(DATE, "Date at which security status is calculated."),
      kind: field(
        z.enum(["share", "option", "rsu", "warrant", "safe", "note"]).optional(),
        "Optional security type filter.",
      ),
      holderPartyId: field(UUID.optional(), "Optional party holder filter."),
    }),
    execute: async (context, input) => ({
      ok: true,
      ...(await listSecurities({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      })),
      href: `/equity?subsidiaryId=${input.subsidiaryId}&tab=securities`,
    }),
  }),
  capitalRead({
    name: "list_equity_stakeholders",
    title: "List Equity Stakeholders",
    description:
      "List parties holding securities in a legal entity. Find the legal entity id with list_equity_entities.",
    permission: "equity.read",
    featureKey: "equity",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity id."),
      asOf: field(DATE, "Date at which holders are resolved."),
    }),
    execute: async (context, input) => ({
      ok: true,
      ...(await listStakeholders({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      })),
      href: `/equity?subsidiaryId=${input.subsidiaryId}&tab=holders`,
    }),
  }),
  capitalRead({
    name: "model_equity_round",
    title: "Model Equity Round",
    description:
      "Model round pricing, convertible conversions, pool top-up and dilution without recording a transaction. Find the entity id with list_equity_entities.",
    permission: "equity.read",
    featureKey: "equity",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity being modeled."),
      asOf: field(DATE, "Cap table effective date."),
      preMoneyValuation: field(DECIMAL, "Exact pre-money valuation as text."),
      investment: field(DECIMAL, "Exact investment amount as text."),
      targetPoolPercent: OPTIONAL_DECIMAL,
    }),
    execute: async (context, input) => ({
      ok: true,
      ...(await modelEntityRound({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
        targetPoolPercent: input.targetPoolPercent ?? null,
      })),
      href: `/equity?subsidiaryId=${input.subsidiaryId}&tab=rounds`,
    }),
  }),
  capitalRead({
    name: "preview_equity_interest_run",
    title: "Preview Equity Interest Run",
    description:
      "Preview convertible-note interest through a date before posting the run. Find the legal entity id with list_equity_entities.",
    permission: "equity.read",
    featureKey: "equity",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity whose convertible notes accrue interest."),
      throughDate: field(DATE, "Last date included in the interest preview."),
    }),
    execute: async (context, input) => ({
      ok: true,
      ...(await previewInterestRun({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      })),
      href: `/equity?subsidiaryId=${input.subsidiaryId}&tab=interest`,
    }),
  }),
  capitalRead({
    name: "preview_equity_compensation_run",
    title: "Preview Equity Compensation Run",
    description:
      "Preview stock-based compensation and award releases through a date before posting the run. Find the legal entity id with list_equity_entities.",
    permission: "equity.read",
    featureKey: "equity",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity whose awards are recognized."),
      throughDate: field(DATE, "Last date included in the compensation preview."),
    }),
    execute: async (context, input) => ({
      ok: true,
      ...(await previewCompensationRun({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      })),
      href: `/equity?subsidiaryId=${input.subsidiaryId}&tab=compensation`,
    }),
  }),
  capitalRead({
    name: "model_equity_waterfall",
    title: "Model Equity Waterfall",
    description:
      "Model distributions through the preference stack for an exit value without recording a transaction. Find the entity id with list_equity_entities.",
    permission: "equity.read",
    featureKey: "equity",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity being modeled."),
      asOf: field(DATE, "Cap table effective date."),
      exitValue: field(DECIMAL, "Exact exit value as text."),
      transactionFees: field(
        DECIMAL.nullable().optional(),
        "Exact transaction fees paid before distributions.",
      ),
      unvestedAwards: field(
        z.enum(["participate", "cancel"]).default("participate"),
        "Whether unvested awards participate.",
      ),
      changeOfControl: field(z.boolean().default(true), "Whether the exit is a change of control."),
      terminated: field(z.boolean().default(false), "Whether awards terminate at exit."),
    }),
    execute: async (context, input) => ({
      ok: true,
      ...(await runEntityWaterfallScenario({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      })),
      href: `/equity?subsidiaryId=${input.subsidiaryId}&tab=waterfall`,
    }),
  }),
  capitalMutation({
    name: "create_share_class",
    title: "Create Share Class",
    description:
      "Create a legal entity share class with its authorized shares, par value and effective preference terms. Find entity ids with list_equity_entities.",
    permission: "equity.manage",
    featureKey: "equity",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity issuing the class."),
      code: CODE,
      name: NAME,
      kind: field(z.enum(["common", "preferred"]), "Common or preferred share class."),
      effectiveOn: field(DATE, "Effective date."),
      authorizedShares: field(INTEGER_TEXT, "Authorized whole shares as text."),
      parValue: field(DECIMAL, "Exact par value per share as text."),
      originalIssuePrice: OPTIONAL_DECIMAL,
      conversionPrice: OPTIONAL_DECIMAL,
      liquidationMultiple: OPTIONAL_DECIMAL,
      liquidationPreferenceBasis: field(
        z.enum(["amount_paid", "original_issue_price"]).nullable().optional(),
        "Basis for the liquidation preference.",
      ),
      participation: field(
        z.enum(["none", "full", "capped"]).optional(),
        "Participation rights after preference.",
      ),
      participationCapMultiple: OPTIONAL_DECIMAL,
      seniority: field(z.number().int().min(0).max(1000).optional(), "Preference seniority order."),
      antiDilution: field(
        z.enum(["none", "broad_based", "narrow_based", "full_ratchet"]).optional(),
        "Anti-dilution adjustment method.",
      ),
      conversionShareClassId: field(UUID.nullable().optional(), "Class received on conversion."),
      conversionAdjustsForSplits: field(
        z.boolean().optional(),
        "Whether conversion terms adjust for stock splits.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      return resultWithHref(
        await createShareClass({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          ...body,
        }),
        `/equity?subsidiaryId=${input.subsidiaryId}`,
      );
    },
  }),
  capitalMutation({
    name: "amend_share_class",
    title: "Amend Share Class",
    description:
      "Change authorized shares, conversion price or conversion class from an effective date; enabled Equity approval flows may hold the amendment for approval. Find class ids with get_equity_structure.",
    permission: "equity.manage",
    featureKey: "equity",
    inputSchema: z.strictObject({
      shareClassId: field(UUID, "Share class to amend."),
      kind: field(
        z.enum(["authorized_shares", "conversion_price", "conversion_class"]),
        "Term being amended.",
      ),
      effectiveOn: field(DATE, "Effective date."),
      authorizedShares: field(INTEGER_TEXT.nullable().optional(), "New authorized shares as text."),
      conversionPrice: OPTIONAL_DECIMAL,
      conversionShareClassId: field(UUID.nullable().optional(), "New conversion class."),
      reason: REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { shareClassId, idempotencyKey: _key, ...body } = input;
      return resultWithHref(
        await amendShareClass({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          shareClassId,
          ...body,
        }),
        "/equity?tab=structure",
      );
    },
  }),
  capitalMutation({
    name: "record_equity_split",
    title: "Record Equity Split",
    description:
      "Record a stock split that restates holdings and prices from an effective date; enabled Equity approval flows may hold the split for approval. Find share class ids with get_equity_structure.",
    permission: "equity.manage",
    featureKey: "equity",
    inputSchema: z.strictObject({
      shareClassId: field(UUID, "Share class being split."),
      effectiveOn: field(DATE, "Split effective date."),
      ratioNumerator: field(INTEGER_TEXT, "New shares per old share, numerator."),
      ratioDenominator: field(INTEGER_TEXT, "Old shares per new share, denominator."),
      reason: REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { shareClassId, idempotencyKey: _key, ...body } = input;
      return resultWithHref(
        await recordSplit({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          shareClassId,
          ...body,
        }),
        "/equity?tab=structure",
      );
    },
  }),
  capitalMutation({
    name: "create_equity_plan",
    title: "Create Equity Plan",
    description:
      "Create an equity compensation plan and its initial share reserve. Find legal entity and share class ids with list_equity_entities and get_equity_structure.",
    permission: "equity.manage",
    featureKey: "equity",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity adopting the plan."),
      code: CODE,
      name: NAME,
      shareClassId: field(UUID, "Share class reserved for awards."),
      effectiveOn: field(DATE, "Effective date of the plan."),
      reservedShares: field(INTEGER_TEXT, "Initial whole-share reserve as text."),
      recycleForfeited: field(z.boolean(), "Whether forfeited awards return to the reserve."),
      recycleExpired: field(z.boolean(), "Whether expired awards return to the reserve."),
      recycleRepurchased: field(z.boolean(), "Whether repurchased shares return to the reserve."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      return resultWithHref(
        await createPlan({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          ...body,
        }),
        `/equity?subsidiaryId=${input.subsidiaryId}&tab=plans`,
      );
    },
  }),
  capitalMutation({
    name: "change_equity_plan_reserve",
    title: "Change Equity Plan Reserve",
    description:
      "Increase or reduce an equity plan reserve from an effective date; enabled Equity approval flows may hold the change for approval. Find the plan id with get_equity_structure.",
    permission: "equity.manage",
    featureKey: "equity",
    inputSchema: z.strictObject({
      planId: field(UUID, "Equity plan to change."),
      effectiveOn: field(DATE, "Effective date."),
      shareDelta: field(z.string().regex(/^-?\d{1,19}$/), "Signed whole-share change as text."),
      reason: REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { planId, idempotencyKey: _key, ...body } = input;
      return resultWithHref(
        await changePlanReserve({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          planId,
          ...body,
        }),
        "/equity?tab=plans",
      );
    },
  }),
  capitalMutation({
    name: "create_equity_round",
    title: "Create Equity Round",
    description:
      "Record a closed financing round used to price share issuances and convertible securities. Find entity and share class ids with equity reads.",
    permission: "equity.manage",
    featureKey: "equity",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity issuing the round."),
      name: NAME,
      shareClassId: field(UUID, "Share class issued in the round."),
      closedOn: field(DATE, "Round close date."),
      pricePerShare: field(DECIMAL, "Exact issue price per share as text."),
      preMoneyValuation: field(DECIMAL, "Exact pre-money valuation as text."),
      currency,
      preMoneyBasisReason: field(
        z.string().trim().max(2000).nullable().optional(),
        "Explanation for the pre-money basis.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      return resultWithHref(
        await createRound({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          ...body,
        }),
        `/equity?subsidiaryId=${input.subsidiaryId}&tab=rounds`,
      );
    },
  }),
  capitalMutation({
    name: "amend_equity_round",
    title: "Amend Equity Round",
    description:
      "Amend a round's name, price or pre-money value from an effective date; enabled Equity approval flows may hold it for approval. Find the round id with get_equity_structure.",
    permission: "equity.manage",
    featureKey: "equity",
    inputSchema: z.strictObject({
      roundId: field(UUID, "Financing round to amend."),
      effectiveOn: field(DATE, "Effective date."),
      name: field(
        z.string().trim().min(1).max(200).nullable().optional(),
        "Replacement round name.",
      ),
      pricePerShare: OPTIONAL_DECIMAL,
      preMoneyValuation: OPTIONAL_DECIMAL,
      preMoneyBasisReason: field(
        z.string().trim().max(2000).nullable().optional(),
        "Explanation for the pre-money basis.",
      ),
      reason: REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { roundId, ...body } = input;
      return resultWithHref(
        await amendRound({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          roundId,
          ...body,
        }),
        "/equity?tab=rounds",
      );
    },
  }),
  capitalMutation({
    name: "void_equity_round",
    title: "Void Equity Round",
    description:
      "Void a round recorded in error after its live securities have been addressed; enabled Equity approval flows may require approval. Find the round id with get_equity_structure.",
    permission: "equity.manage",
    featureKey: "equity",
    destructive: true,
    inputSchema: z.strictObject({
      roundId: field(UUID, "Financing round to void."),
      effectiveOn: field(DATE, "Void effective date."),
      reason: REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) =>
      resultWithHref(
        await voidRound({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          roundId: input.roundId,
          effectiveOn: input.effectiveOn,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        }),
        "/equity?tab=rounds",
      ),
  }),
  capitalMutation({
    name: "issue_equity_security",
    title: "Issue Equity Security",
    description:
      "Issue shares, options, RSUs, warrants, SAFEs or convertible notes, including grant-date vesting terms. Find entity, holder, class, plan and round ids with the equity and party reads.",
    permission: "equity.manage",
    featureKey: "equity",
    inputSchema: issueBody,
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      return resultWithHref(
        await issueSecurity({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          ...body,
        }),
        `/equity?subsidiaryId=${input.subsidiaryId}&tab=securities`,
      );
    },
  }),
  capitalMutation({
    name: "record_equity_security_event",
    title: "Record Equity Security Event",
    description:
      "Record an option exercise, award vesting or settlement, transfer, conversion, forfeiture, expiration, repurchase, repayment, void or reversal. Find the security id with list_equity_securities.",
    permission: "equity.manage",
    featureKey: "equity",
    inputSchema: eventBody,
    execute: async (context, input) =>
      resultWithHref(
        await recordSecurityEvent({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          ...input,
        }),
        "/equity?tab=securities",
      ),
  }),
  capitalMutation({
    name: "elect_mfn_terms",
    title: "Elect MFN Terms",
    description:
      "Record an MFN SAFE holder's election to adopt more favorable later financing terms from a date. Find security ids with list_equity_securities.",
    permission: "equity.manage",
    featureKey: "equity",
    inputSchema: z.strictObject({
      securityId: field(UUID, "MFN SAFE security making the election."),
      sourceSecurityId: field(UUID, "Later security providing the better terms."),
      effectiveOn: field(DATE, "Effective date of the election."),
      reason: REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) =>
      resultWithHref(
        await electMfnTerms({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          securityId: input.securityId,
          sourceSecurityId: input.sourceSecurityId,
          effectiveOn: input.effectiveOn,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        }),
        "/equity?tab=securities",
      ),
  }),
  capitalMutation({
    name: "reverse_mfn_election",
    title: "Reverse MFN Election",
    description:
      "Reverse an MFN election recorded in error so the security returns to the earlier terms from a chosen date. Find the security and amendment ids in its detail.",
    permission: "equity.manage",
    featureKey: "equity",
    destructive: true,
    inputSchema: z.strictObject({
      securityId: field(UUID, "MFN SAFE security."),
      amendmentId: field(UUID, "MFN election amendment to reverse."),
      effectiveOn: field(DATE, "Effective date of the reversal."),
      reason: REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) =>
      resultWithHref(
        await reverseMfnElection({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          securityId: input.securityId,
          amendmentId: input.amendmentId,
          effectiveOn: input.effectiveOn,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        }),
        "/equity?tab=securities",
      ),
  }),
  capitalMutation({
    name: "post_equity_interest_run",
    title: "Post Equity Interest Run",
    description:
      "Accrue convertible note interest through a date; repeat runs return the existing posted result and do not accrue twice. Find the entity id with list_equity_entities.",
    permission: "equity.manage",
    featureKey: "equity",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity whose convertible notes accrue interest."),
      throughDate: field(DATE, "Last date included in interest accrual."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      return resultWithHref(
        await postInterestRun({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          ...body,
        }),
        `/equity?subsidiaryId=${input.subsidiaryId}&tab=interest`,
      );
    },
  }),
  capitalMutation({
    name: "post_equity_compensation_run",
    title: "Post Equity Compensation Run",
    description:
      "Recognize stock-based compensation for awards through a date. Find the legal entity id with list_equity_entities and awards with list_equity_securities.",
    permission: "equity.manage",
    featureKey: "equity",
    inputSchema: z.strictObject({
      subsidiaryId: field(UUID, "Legal entity whose awards are recognized."),
      throughDate: field(DATE, "Last date included in compensation recognition."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      return resultWithHref(
        await postCompensationRun({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          ...body,
        }),
        `/equity?subsidiaryId=${input.subsidiaryId}&tab=compensation`,
      );
    },
  }),
  capitalMutation({
    name: "withdraw_equity_action",
    title: "Withdraw Equity Action",
    description:
      "Withdraw an equity action request that is awaiting approval; only its requester can withdraw it. Find the request id in the equity action approval reads.",
    permission: "equity.read",
    featureKey: "equity",
    destructive: true,
    inputSchema: z.strictObject({
      requestId: field(UUID, "Pending equity action request to withdraw."),
      reason: REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) =>
      resultWithHref(
        await withdrawEquityAction({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          requestId: input.requestId,
          reason: input.reason,
        }),
        "/equity",
      ),
  }),
];
