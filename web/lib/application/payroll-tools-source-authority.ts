import {
  openingLevySourceRequiresAllocations,
  qualifyOpeningLevySourceAuthority,
  readOpeningLevySourceContext,
} from "@openbooks/engine/payroll/opening-levy-source-authority";
import { correctOpeningLevySourceAuthority } from "@openbooks/engine/payroll/opening-levy-source-correction";
import { PayrollError } from "@openbooks/engine/payroll/error";
import { z } from "zod";
import { ApplicationError } from "./errors";
import {
  assertPayrollActor,
  IDEMPOTENCY_KEY,
  payrollActor,
  settlePayrollRefusal,
  UUID,
  DATE,
} from "./payroll-tools-common";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const allocation = z.object({
  programKey: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("Declared opening levy programme key; pass it through from the authority read."),
  region: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .describe("Original programme jurisdiction from the source record."),
  subRegion: z
    .string()
    .trim()
    .max(80)
    .optional()
    .describe("Original sub-region when declared by the selected programme."),
  filingAccountId: UUID("Filing account id from the employer authority read.")
    .nullable()
    .optional(),
  federalAccountId: UUID("Federal account id from the employer authority read.")
    .nullable()
    .describe("Federal account association required by some declared programmes."),
  amount: z
    .string()
    .regex(/^\d+(?:\.\d{1,4})?$/)
    .describe("Non-negative exact opening allocation amount as decimal text."),
});
const qualification = z.object({
  openingBalanceId: UUID("Opening balance id from the payroll opening read."),
  expectedOpeningSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe("Expected opening snapshot hash from the authority read."),
  expectedOpeningChildrenSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe("Expected child-row snapshot hash from the authority read."),
  sourceFileId: UUID("Retained source file id from file-cabinet reads."),
  sourceVersionId: UUID("Exact source version id from file-cabinet reads."),
  sourceSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe("SHA-256 of the retained source version."),
  sourceReference: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Source reference recorded by the employer."),
  originalCountry: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .describe(
      "Original report jurisdiction code copied from source evidence; pass through without interpreting it.",
    ),
  originalCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .describe(
      "Original report currency code copied from source evidence; pass through without interpreting it.",
    ),
  coverageStart: DATE.describe("Inclusive start date covered by the original payroll source."),
  coverageEnd: DATE.describe("Inclusive end date covered by the original payroll source."),
  coverageComplete: z
    .literal(true)
    .describe("Confirm that the retained source covers the full declared period."),
  allocations: z
    .array(allocation)
    .max(1000)
    .describe(
      "Complete source allocations for pack-declared opening levy programmes, including explicit zero allocations where applicable.",
    ),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Reason for qualifying the retained opening source."),
});

export const PAYROLL_SOURCE_AUTHORITY_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_payroll_opening_levy_source_authority",
    title: "Get Payroll Opening Levy Source Authority",
    description:
      "Read a person's opening balance together with its current source qualification requirements. Find the employee, opening id and retained source version with payroll opening and file-cabinet reads.",
    inputSchema: z.object({
      employeePartyId: UUID("Employee party id from payroll opening reads."),
      taxYear: z.number().int().min(2000).max(2100).describe("Tax year of the opening balance."),
      sourceFileId: UUID("Optional source file id from file-cabinet reads.").optional(),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.read"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.read");
      try {
        const result = await readOpeningLevySourceContext({
          ...input,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          ...result,
          href: `/payroll/opening-balances?employee=${input.employeePartyId}&year=${input.taxYear}`,
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "qualify_payroll_opening_levy_source",
    title: "Qualify Payroll Opening Levy Source",
    description:
      "Qualify an opening balance against retained original payroll evidence and the complete pack-declared statutory allocation set. Read get_payroll_opening_levy_source_authority first for current hashes, accounts, and allocation requirements.",
    inputSchema: qualification
      .extend({ idempotencyKey: IDEMPOTENCY_KEY })
      .superRefine((input, ctx) => {
        if (
          openingLevySourceRequiresAllocations(input.originalCountry) &&
          input.allocations.length === 0
        )
          ctx.addIssue({
            code: "custom",
            path: ["allocations"],
            message:
              "Declare the complete original statutory levy allocations, including explicit zeros",
          });
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      try {
        const { idempotencyKey: _key, ...body } = input;
        const record = await qualifyOpeningLevySourceAuthority({
          ...body,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, record, href: "/payroll/opening-balances" };
      } catch (error) {
        if (error instanceof PayrollError) settlePayrollRefusal(error, 409);
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "correct_payroll_opening_levy_source",
    title: "Correct Payroll Opening Levy Source",
    description:
      "Append corrected evidence for an unconsumed opening levy qualification while retaining the original audit history. Read get_payroll_opening_levy_source_authority for the current authority id and allocation hash, and supply a correction request id and reason.",
    inputSchema: qualification
      .extend({
        requestId: UUID("Unique correction request id for the audited authority correction."),
        expectedAuthorityId: UUID(
          "Current authority id from get_payroll_opening_levy_source_authority.",
        ),
        expectedAllocationSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .describe("Current allocation hash returned by the authority read."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .superRefine((input, ctx) => {
        if (
          openingLevySourceRequiresAllocations(input.originalCountry) &&
          input.allocations.length === 0
        )
          ctx.addIssue({
            code: "custom",
            path: ["allocations"],
            message:
              "Declare the complete original statutory levy allocations, including explicit zeros",
          });
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      try {
        const { idempotencyKey: _key, ...body } = input;
        const record = await correctOpeningLevySourceAuthority({
          ...body,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, record, href: "/payroll/opening-balances" };
      } catch (error) {
        if (error instanceof PayrollError)
          throw new ApplicationError("conflict", error.message, 409);
        settlePayrollRefusal(error);
      }
    },
  }),
];
