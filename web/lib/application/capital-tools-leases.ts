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
import {
  capitalMutation,
  describeObjectFields,
  field,
  IDEMPOTENCY_KEY,
  resultWithHref,
  UUID,
} from "./capital-tools-common";
import { notFound } from "./errors";

const createLeaseInput = describeObjectFields(
  leaseSchema.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
  {
    subsidiaryId: "Legal entity that owns the lease.",
    leaseNumber: "Unique lease number within the organization.",
    description: "Lease description.",
    commencementOn: "Lease commencement date.",
    termPeriods: "Number of payment periods in the lease term.",
    paymentFrequency: "Monthly, quarterly, or annual payment interval.",
    paymentTiming: "Payments in advance or arrears.",
    paymentAmount: "Exact periodic payment amount as a decimal string.",
    annualDiscountRatePercent: "Exact annual discount rate as a decimal string.",
    classificationInputs: "Inputs supporting the lease classification assessment.",
    exemption: "Short-term or low-value exemption, if elected.",
    initialDirectCosts: "Exact initial direct costs as a decimal string.",
    prepayments: "Exact payments made before commencement as a decimal string.",
    incentives: "Exact lease incentives as a decimal string.",
    costClearingAccountId: "Account for initial direct costs, when applicable.",
    openingBalances:
      "Opening lease liability and right-of-use balances when adopting an existing lease.",
    accounts: "Required right-of-use asset, liability, expense and payment accounts.",
    departmentId: "Department dimension.",
    projectId: "Project dimension.",
    locationId: "Location dimension.",
    idempotencyKey: "Unique retry key for this lease creation.",
  },
);
const changeLeaseInput = describeObjectFields(
  leaseChangeSchema.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
  {
    operation: "Modification, remeasurement, termination or separate lease.",
    effectiveOn: "Effective date of the change.",
    reason: "Reason recorded with the change.",
    idempotencyKey: "Unique retry key for this lease change.",
    scopeReductionPercent: "Exact scope reduction percentage as a decimal string.",
    settlementPayment: "Exact settlement payment as a decimal string.",
    gainLossAccountId: "Account for any termination or remeasurement gain or loss.",
    assessment: "Accounting assessment supporting the proposed change.",
    remainingTerms: "Updated remaining term and payment terms for a modification.",
    separateLease: "New agreement terms when the change creates a separate lease.",
  },
);
const postLeaseInput = describeObjectFields(
  leasePostSchema.extend({
    leaseId: UUID,
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
        await createLeaseAgreement(context.authz.user.orgId, context.authz.user.id, body),
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
        await proposeLeaseChange(context.authz.user.orgId, leaseId, context.authz.user.id, body),
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
        input.asOfDate,
        context.authz.user.id,
        { leaseId: input.leaseId },
      );
      return resultWithHref(result, `/assets/leases?lease=${input.leaseId}`);
    },
  }),
];
