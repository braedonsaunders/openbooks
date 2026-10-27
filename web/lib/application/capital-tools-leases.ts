import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { subsidiaryScopeAllows } from "@openbooks/engine/organization/scope";
import {
  commenceLease,
  createLeaseAgreement,
  postDueLeaseSchedules,
} from "@openbooks/engine/revenue/leases";
import { proposeLeaseChange } from "@openbooks/engine/revenue/lease-changes";
import { leaseChangeSchema, leasePostSchema, leaseSchema } from "../../app/api/leases/_schema";
import { compareDecimal } from "../exact-decimal";
import {
  capitalMutation,
  DATE,
  describeObjectFields,
  field,
  IDEMPOTENCY_KEY,
  resultWithHref,
  UUID,
} from "./capital-tools-common";
import { notFound } from "./errors";

const LEASE_DECIMAL = z
  .string()
  .max(64)
  .regex(/^-?\d+(?:\.\d+)?$/, "Enter an exact decimal as text.");
const leasePercent = (description: string) =>
  field(
    LEASE_DECIMAL.refine(
      (value) => compareDecimal(value, "0") >= 0 && compareDecimal(value, "100") <= 0,
      "Enter a percentage from 0 through 100.",
    ),
    description,
  );
const leaseClassificationInput = z.strictObject({
  transfersOwnership: field(z.boolean().optional(), "Whether ownership transfers by lease end."),
  purchaseOptionReasonablyCertain: field(
    z.boolean().optional(),
    "Whether exercise of the purchase option is reasonably certain.",
  ),
  leaseTermMonths: field(z.number().int().nonnegative().optional(), "Lease term in months."),
  economicLifeMonths: field(
    z.number().int().nonnegative().optional(),
    "Underlying asset economic life in months.",
  ),
  termThresholdPercent: leasePercent("Term threshold percentage from 0 to 100."),
  pvOfPayments: field(LEASE_DECIMAL.optional(), "Exact present value of lease payments as text."),
  fairValue: field(LEASE_DECIMAL.optional(), "Exact underlying asset fair value as text."),
  pvThresholdPercent: leasePercent("Present-value threshold percentage from 0 to 100."),
  specializedAsset: field(
    z.boolean().optional(),
    "Whether the asset is specialized to the lessee.",
  ),
});
const leaseCreateFields = z.strictObject({
  subsidiaryId: field(UUID, "Legal entity that owns the lease."),
  leaseNumber: field(
    z.string().trim().min(1).max(100),
    "Unique lease number within the organization.",
  ),
  description: field(z.string().max(1000).optional(), "Lease description."),
  commencementOn: field(DATE, "Lease commencement date."),
  termPeriods: field(z.number().int().positive(), "Number of payment periods in the lease term."),
  paymentFrequency: field(z.enum(["monthly", "quarterly", "annual"]), "Payment frequency."),
  paymentTiming: field(
    z.enum(["advance", "arrears"]),
    "Whether payments are in advance or arrears.",
  ),
  paymentAmount: field(LEASE_DECIMAL, "Exact periodic payment amount as a decimal string."),
  annualDiscountRatePercent: field(
    z.string().max(25),
    "Exact annual discount rate as a decimal string.",
  ),
  classificationInputs: field(
    leaseClassificationInput,
    "Inputs supporting the lease classification assessment.",
  ),
  exemption: field(
    z.enum(["short_term", "low_value"]).nullable().optional(),
    "Short-term or low-value exemption, if elected.",
  ),
  initialDirectCosts: field(
    LEASE_DECIMAL.optional(),
    "Exact initial direct costs as a decimal string.",
  ),
  prepayments: field(
    LEASE_DECIMAL.optional(),
    "Exact payments made before commencement as a decimal string.",
  ),
  incentives: field(LEASE_DECIMAL.optional(), "Exact lease incentives as a decimal string."),
  costClearingAccountId: field(
    UUID.nullable().optional(),
    "Account for initial direct costs, when applicable.",
  ),
  openingBalances: field(
    z
      .strictObject({
        liability: field(LEASE_DECIMAL, "Opening lease liability as an exact decimal string."),
        rouCarrying: field(
          LEASE_DECIMAL,
          "Opening right-of-use carrying amount as an exact decimal string.",
        ),
        asOf: field(DATE, "Cutover date for opening balances."),
      })
      .nullable()
      .optional(),
    "Opening lease balances when adopting an existing lease.",
  ),
  accounts: field(
    z.strictObject({
      rouAsset: field(UUID, "Right-of-use asset account."),
      leaseLiability: field(UUID, "Lease liability account."),
      interestExpense: field(UUID, "Interest expense account."),
      amortizationExpense: field(UUID, "Right-of-use amortization expense account."),
      leaseExpense: field(UUID, "Operating lease expense account."),
      payment: field(UUID, "Lease payment account."),
    }),
    "Required right-of-use asset, liability, expense and payment accounts.",
  ),
  departmentId: field(UUID.nullable().optional(), "Department dimension."),
  projectId: field(UUID.nullable().optional(), "Project dimension."),
  locationId: field(UUID.nullable().optional(), "Location dimension."),
});
const createLeaseInput = z.strictObject({
  ...leaseCreateFields.shape,
  idempotencyKey: field(IDEMPOTENCY_KEY, "Unique retry key for this lease creation."),
});
const remainingTerms = z.strictObject({
  periods: field(z.number().int().positive(), "Remaining payment periods."),
  payment: field(LEASE_DECIMAL, "Exact remaining periodic payment as text."),
  paymentFrequency: field(
    z.enum(["monthly", "quarterly", "annual"]),
    "Remaining payment frequency.",
  ),
  paymentTiming: field(
    z.enum(["advance", "arrears"]),
    "Whether remaining payments are in advance or arrears.",
  ),
  annualRatePercent: field(z.string().max(25), "Exact annual discount rate as text."),
  classificationInputs: field(
    leaseClassificationInput,
    "Classification inputs for the remaining term.",
  ),
});
const changeLeaseInput = z.strictObject({
  operation: field(
    z.enum(["modification", "remeasurement", "termination", "separate_lease"]),
    "Modification, remeasurement, termination or separate lease.",
  ),
  effectiveOn: field(DATE, "Effective date of the change."),
  reason: field(z.string().trim().min(8).max(1000), "Reason recorded with the change."),
  idempotencyKey: field(IDEMPOTENCY_KEY, "Unique retry key for this lease change."),
  scopeReductionPercent: field(
    LEASE_DECIMAL,
    "Exact scope reduction percentage as a decimal string.",
  ),
  settlementPayment: field(LEASE_DECIMAL, "Exact settlement payment as a decimal string."),
  gainLossAccountId: field(UUID, "Account for any termination or remeasurement gain or loss."),
  assessment: field(
    z.string().trim().min(8).max(4000),
    "Accounting assessment supporting the proposed change.",
  ),
  remainingTerms: field(
    remainingTerms.optional(),
    "Updated remaining term and payment terms for a modification.",
  ),
  separateLease: field(
    z
      .strictObject({
        additionalRightOfUse: field(z.literal(true), "Whether the change adds a right of use."),
        commensurateStandalonePrice: field(
          z.literal(true),
          "Whether the added right is priced at a standalone rate.",
        ),
        agreement: field(leaseCreateFields, "Terms of the separate lease agreement."),
      })
      .optional(),
    "New agreement terms when the change creates a separate lease.",
  ),
});
const postLeaseInput = describeObjectFields(
  z.strictObject({
    leaseId: UUID,
    asOfDate: DATE,
    idempotencyKey: IDEMPOTENCY_KEY,
  }),
  {
    leaseId: "Lease whose due schedules are posted.",
    asOfDate: "Last date for due lease schedule entries.",
    idempotencyKey: "Unique retry key for this exact posting run.",
  },
);

export const CAPITAL_LEASE_TOOLS = [
  capitalMutation({
    name: "create_lease_agreement",
    title: "Create Lease Agreement",
    description:
      "Create a draft lease agreement with classification inputs, schedule terms and required posting accounts. Find the legal entity and account ids with organization and accounting reads.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    inputSchema: createLeaseInput,
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      return resultWithHref(
        await createLeaseAgreement(
          context.authz.user.orgId,
          context.authz.user.id,
          leaseSchema.parse(body),
        ),
        "/assets/leases",
      );
    },
  }),
  capitalMutation({
    name: "propose_lease_change",
    title: "Propose Lease Change",
    description:
      "Propose a lease modification, remeasurement, termination or separate lease with its effective date and accounting assessment. Find the lease id with search_lease_agreements.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    destructive: true,
    inputSchema: z.strictObject({
      leaseId: field(UUID, "Lease agreement to change."),
      ...changeLeaseInput.shape,
    }),
    execute: async (context, input) => {
      const { leaseId, ...body } = input;
      return resultWithHref(
        await proposeLeaseChange(
          context.authz.user.orgId,
          leaseId,
          context.authz.user.id,
          leaseChangeSchema.parse(body),
        ),
        `/assets/leases?lease=${leaseId}`,
      );
    },
  }),
  capitalMutation({
    name: "commence_lease",
    title: "Commence Lease",
    description:
      "Commence a draft lease and establish its right-of-use asset, liability and schedule. Find lease ids with search_lease_agreements.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    inputSchema: z.strictObject({
      leaseId: field(UUID, "Draft lease agreement to commence."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) =>
      resultWithHref(
        await commenceLease(context.authz.user.orgId, input.leaseId, context.authz.user.id),
        `/assets/leases?lease=${input.leaseId}`,
      ),
  }),
  capitalMutation({
    name: "post_lease_schedules",
    title: "Post Lease Schedules",
    description:
      "Post due entries for one commenced lease through an as-of date. Find the lease id and schedule state with search_lease_agreements and get_lease_agreement.",
    permission: "assets.manage",
    featureKey: "fixedAssets",
    inputSchema: postLeaseInput,
    execute: async (context, input) => {
      const known = await db.execute<{ subsidiary_id: string | null }>(
        sql`
        select subsidiary_id from lease_agreements
         where org_id = ${context.authz.user.orgId} and id = ${input.leaseId}
      `,
        "objects",
      );
      if (
        !known[0] ||
        !subsidiaryScopeAllows(context.authz.allowedSubsidiaryIds, known[0].subsidiary_id)
      )
        throw notFound("lease");
      const result = await postDueLeaseSchedules(
        context.authz.user.orgId,
        leasePostSchema.parse({ asOfDate: input.asOfDate }).asOfDate,
        context.authz.user.id,
        { leaseId: input.leaseId },
      );
      return resultWithHref(result, `/assets/leases?lease=${input.leaseId}`);
    },
  }),
];
