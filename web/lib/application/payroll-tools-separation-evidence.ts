import {
  qualifyCanadianOpeningReportingSource,
  readCanadianOpeningReportingSourceContext,
} from "@openbooks/engine/payroll/canada/opening-reporting-authority";
import {
  readRoeSubsequentServiceContext,
  saveRoeSubsequentService,
} from "@openbooks/engine/payroll/canada/roe-subsequent-service";
import {
  importRoePriorPeriod,
  qualifyRoeLine,
  readRoeHistoricalEvidence,
  withdrawRoeLineEvidence,
} from "@openbooks/engine/payroll/roe-history";
import {
  readRoeSeparationFactsContext,
  saveRoeSeparationFacts,
} from "@openbooks/engine/payroll/roe-separation-facts";
import { z } from "zod";
import {
  assertPayrollActor,
  DATE,
  IDEMPOTENCY_KEY,
  payrollActor,
  settlePayrollRefusal,
  UUID,
} from "./payroll-tools-common";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const DIGEST = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("SHA-256 digest from the native source read.");
const SOURCE_REFERENCE = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .describe("Reference to the original retained source document.");
const CHANGE_REASON = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .describe("Reason for recording or changing this evidence.");
const EXACT_AMOUNT = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/)
  .describe("Exact non-negative decimal text with at most four decimal places.");
const NULLABLE_DATE = (description: string) => DATE.nullable().describe(description);

const reportingProvince = z
  .enum(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT", "ZZ"])
  .describe("Region code retained from the original payroll source.");
const reportingChildren = z
  .strictObject({
    components: z
      .array(
        z.strictObject({
          component_id: UUID("Payroll component id from the original opening read."),
          ytd_amount: EXACT_AMOUNT.describe("Exact year-to-date component amount from the source."),
        }),
      )
      .max(1000)
      .describe("Original year-to-date amounts by payroll component."),
    programBases: z
      .array(
        z.strictObject({
          program_key: z.string().min(1).max(100).describe("Pack-declared reporting program key."),
          insurable_ytd: EXACT_AMOUNT.describe(
            "Exact year-to-date insurable amount from the source.",
          ),
        }),
      )
      .max(1000)
      .describe("Original insurable bases by payroll program."),
    accountBases: z
      .array(
        z.strictObject({
          program_key: z.string().min(1).max(100).describe("Pack-declared reporting program key."),
          filing_account_id: UUID("Filing account id from the current opening reporting read."),
          region: reportingProvince
            .nullable()
            .describe("Source region for this account base, or null."),
          insurable_ytd: EXACT_AMOUNT.describe(
            "Exact year-to-date insurable amount for the account.",
          ),
        }),
      )
      .max(1000)
      .describe("Original insurable bases by filing account and region."),
    suiStates: z
      .array(
        z.strictObject({
          state: z
            .string()
            .regex(/^[A-Z]{2}$/)
            .describe("Two-letter region from the original payroll source."),
          insurable_ytd: EXACT_AMOUNT.describe(
            "Exact year-to-date insurable amount from the source.",
          ),
        }),
      )
      .max(1000)
      .describe("Original state-level insurable bases."),
  })
  .describe("Complete original child-level reporting amounts.");

const openingReportingAllocation = z
  .strictObject({
    sourceOrdinal: z
      .number()
      .int()
      .min(1)
      .max(2147483647)
      .describe("One-based row ordinal in the retained source."),
    firstCoveredPayDate: DATE.describe("First covered pay date for this source allocation."),
    filingAccountId: UUID("Filing account id from the current opening reporting read."),
    province: reportingProvince,
    annualAmounts: z
      .record(z.string().min(1).max(100), EXACT_AMOUNT)
      .describe("Exact annual amounts keyed by the pack's declared reporting field names."),
    children: reportingChildren,
    reportableBases: z
      .strictObject({
        ei: EXACT_AMOUNT.describe("Exact reportable base copied from the retained source."),
        cpp: EXACT_AMOUNT.describe("Exact reportable base copied from the retained source."),
        qpip: EXACT_AMOUNT.describe("Exact reportable base copied from the retained source."),
      })
      .describe("Original reportable bases from the retained source."),
  })
  .describe("One complete reporting allocation retained from the source.");

const openingReportingSourceInput = z.strictObject({
  openingBalanceId: UUID("Opening balance id from the payroll opening read."),
  requestId: UUID("Current qualification request id from the opening reporting read."),
  expectedLevyAuthorityId: UUID("Current levy authority id from the opening reporting read."),
  expectedLevyAllocationSha256: DIGEST.describe(
    "Current allocation hash from the opening reporting read.",
  ),
  expectedOpeningSha256: DIGEST.describe(
    "Current original opening hash from the opening reporting read.",
  ),
  expectedOpeningChildrenSha256: DIGEST.describe(
    "Current opening child-row hash from the opening reporting read.",
  ),
  sourceFileId: UUID("Retained source file id from File Cabinet reads."),
  sourceVersionId: UUID("Exact retained source version id from File Cabinet reads."),
  sourceSha256: DIGEST,
  sourceReference: SOURCE_REFERENCE,
  reason: CHANGE_REASON,
  allocations: z
    .array(openingReportingAllocation)
    .min(1)
    .max(1000)
    .describe("Complete source-backed reporting allocations."),
});

const separationSubject = {
  employeePartyId: UUID("Employee party id from payroll employee reads."),
  employmentId: UUID("Native employment id for this employee and separation."),
  subsidiaryId: UUID("Legal employer id for this employment."),
};
const historicalSource = {
  sourceFileId: UUID("Retained source file id from File Cabinet reads."),
  sourceVersionId: UUID("Exact retained source version id from File Cabinet reads."),
  sourceSha256: DIGEST,
  sourceReference: SOURCE_REFERENCE,
  insuranceReference: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Source reference supporting insurance treatment."),
  hoursReference: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Source reference supporting reported hours."),
  reason: CHANGE_REASON,
  expectedId: UUID("Existing evidence id from the separation history read.")
    .nullable()
    .describe("Existing evidence id, or null when adding a new entry."),
  expectedUpdatedAt: z
    .string()
    .max(100)
    .nullable()
    .describe(
      "Existing updated-at value from the separation history read, or null for a new entry.",
    ),
};
const periodEvidence = z.strictObject({
  ...historicalSource,
  filingAccountId: UUID("Filing account id for the source-reported period."),
  payScheduleId: UUID("Pay schedule id governing the source-reported period."),
  frequency: z
    .enum(["weekly", "biweekly", "semi_monthly", "monthly"])
    .describe("Pay-period frequency from the native schedule."),
  periodStart: DATE.describe("Inclusive start date of the original reporting period."),
  periodEnd: DATE.describe("Inclusive end date of the original reporting period."),
  payDate: NULLABLE_DATE("Original payment date, or null for a nil period."),
  earnedFrom: NULLABLE_DATE("First date of the original earned span, or null for a nil period."),
  earnedTo: NULLABLE_DATE("Last date of the original earned span, or null for a nil period."),
  insurableEarnings: EXACT_AMOUNT.describe("Exact insurable earnings from the source."),
  insurableHours: EXACT_AMOUNT.describe("Exact insurable hours from the source."),
  nilPeriod: z.boolean().describe("True only when the retained source confirms a nil period."),
});
const lineEvidence = z.strictObject({
  ...historicalSource,
  payStubLineId: UUID("Committed payroll earning-line id from payroll run reads."),
  reportPeriodStart: DATE.describe("Inclusive reporting period start date."),
  reportPeriodEnd: DATE.describe("Inclusive reporting period end date."),
  earnedFrom: NULLABLE_DATE(
    "Original first earned date, retained as null when the source has no date.",
  ),
  earnedTo: NULLABLE_DATE(
    "Original last earned date, retained as null when the source has no date.",
  ),
  isInsurable: z
    .boolean()
    .describe("Whether the original line is insurable under the applicable payroll filing rules."),
  insurableHours: EXACT_AMOUNT.describe("Exact insurable hours retained from the source."),
  reportingBasis: z
    .enum(["service", "separation_payment"])
    .optional()
    .describe("Declared basis for this reporting line."),
  separationEventId: UUID("Separation event id when the line is tied to a separation payment.")
    .nullable()
    .optional(),
  separationPaymentId: UUID("Existing separation payment id when one is declared.")
    .nullable()
    .optional(),
  separationBlock: z
    .enum(["17A", "17C"])
    .nullable()
    .optional()
    .describe("Pack-declared separation classification block, when applicable."),
  separationCategoryCode: z
    .string()
    .nullable()
    .optional()
    .describe("Pack-declared separation category code, when applicable."),
});

const historyMutationInput = z
  .strictObject({
    ...separationSubject,
    kind: z
      .enum(["period", "line"])
      .describe("Record an original period or classify a committed earning line."),
    evidence: z
      .union([periodEvidence, lineEvidence])
      .describe("Source-backed period amounts or committed earning-line evidence."),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .superRefine((input, ctx) => {
    const selected = input.kind === "period" ? periodEvidence : lineEvidence;
    const parsed = selected.safeParse(input.evidence);
    if (!parsed.success) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message:
          parsed.error.issues[0]?.message ?? "Evidence does not match the selected record kind.",
      });
    }
  });

const payrollScope = (context: Parameters<typeof assertPayrollActor>[0]) => ({
  orgId: context.authz.user.orgId,
  actorId: context.authz.user.id,
  allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
});

export const PAYROLL_SEPARATION_EVIDENCE_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_opening_balance_reporting_source",
    title: "Get Opening Balance Reporting Source",
    description:
      "Read the source, current hashes, account allocations, and qualification requirements for an employee's original opening balance. Find employee and opening ids with payroll opening reads, and find retained source ids with File Cabinet reads.",
    inputSchema: z.strictObject({
      employeePartyId: UUID("Employee party id from payroll opening reads."),
      taxYear: z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .describe("Tax year of the original opening balance."),
      sourceFileId: UUID("Optional retained source file id from File Cabinet reads.").optional(),
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
        const result = await readCanadianOpeningReportingSourceContext({
          ...input,
          ...payrollScope(context),
        });
        return {
          ok: true,
          ...result,
          href: `/payroll/opening-balances?employee=${encodeURIComponent(input.employeePartyId)}&year=${input.taxYear}`,
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "set_opening_balance_reporting_source",
    title: "Set Opening Balance Reporting Source",
    description:
      "Qualify source-backed reporting allocations for an employee's original opening balance when the applicable payroll pack requires them. Read get_opening_balance_reporting_source first for current hashes, accounts, and allocation requirements.",
    inputSchema: openingReportingSourceInput.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
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
        const record = await qualifyCanadianOpeningReportingSource({
          ...body,
          ...payrollScope(context),
        });
        return { ok: true, record, href: "/payroll/opening-balances" };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "get_employee_separation_facts",
    title: "Get Employee Separation Facts",
    description:
      "Read an employee's native separation facts and proposed dates before preparing an applicable separation filing. Find employee, employment, employer, and event ids with payroll employee and separation reads.",
    inputSchema: z
      .strictObject({
        employeePartyId: UUID("Employee party id from payroll employee reads."),
        eventId: UUID("Existing separation event id from payroll separation reads.").optional(),
        newEvent: z
          .boolean()
          .optional()
          .describe("Read the proposed facts for a new separation event."),
        employmentId: UUID("Optional native employment id from payroll employee reads.").optional(),
        subsidiaryId: UUID("Optional legal employer id from payroll employee reads.").optional(),
      })
      .refine(
        (input) => (input.employmentId === undefined) === (input.subsidiaryId === undefined),
        {
          message: "Choose both the native employment and its legal employer.",
          path: ["employmentId"],
        },
      )
      .refine((input) => !(input.eventId && input.newEvent), {
        message: "Choose an existing event or start a new separation event.",
        path: ["eventId"],
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
        const result = await readRoeSeparationFactsContext({ ...input, ...payrollScope(context) });
        return { ok: true, ...result, href: "/payroll/separations" };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "record_employee_separation_facts",
    title: "Record Employee Separation Facts",
    description:
      "Record source-backed dates for an employee separation when the applicable payroll pack requires them. Read get_employee_separation_facts first for the current event, proposal, and expected update identity.",
    inputSchema: z.strictObject({
      ...separationSubject,
      firstDayWorked: NULLABLE_DATE(
        "First day worked in this employment spell, or null when the source does not establish it.",
      ),
      interruptionOn: DATE.describe("Date the interruption of work began."),
      lastInsurableEarningsOn: DATE.describe(
        "Last date with insurable earnings supported by the source.",
      ),
      salaryContinuanceEndOn: NULLABLE_DATE(
        "End of paid leave or salary continuance, or null when none applies.",
      ),
      sourceReference: SOURCE_REFERENCE,
      reason: CHANGE_REASON,
      status: z
        .enum(["draft", "confirmed"])
        .describe("Draft pending review or confirmed source-backed facts."),
      expectedId: UUID("Current separation event id from get_employee_separation_facts.")
        .nullable()
        .describe("Current separation event id, or null when creating one."),
      expectedUpdatedAt: z
        .string()
        .max(100)
        .nullable()
        .describe("Current event updated-at value, or null when creating one."),
      idempotencyKey: IDEMPOTENCY_KEY,
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
        const record = await saveRoeSeparationFacts({ ...body, ...payrollScope(context) });
        return { ok: true, record, href: "/payroll/separations" };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "get_separation_history",
    title: "Get Separation History",
    description:
      "Read source-backed historical periods and committed earning-line attribution for an employee's applicable separation filing. Find employee, employment, and employer ids with payroll employee reads.",
    inputSchema: z
      .strictObject({
        ...separationSubject,
        periodFrom: DATE.optional().describe("Optional inclusive reporting-window start date."),
        periodTo: DATE.optional().describe("Optional inclusive reporting-window end date."),
      })
      .refine((input) => (input.periodFrom === undefined) === (input.periodTo === undefined), {
        message: "Select both reporting range dates.",
        path: ["periodFrom"],
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
        const { periodFrom, periodTo, ...subject } = input;
        const result = await readRoeHistoricalEvidence(
          { ...subject, ...payrollScope(context) },
          periodFrom !== undefined && periodTo !== undefined ? { periodFrom, periodTo } : undefined,
        );
        return { ok: true, ...result, href: "/payroll/separations" };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "record_separation_history",
    title: "Record Separation History",
    description:
      "Record original source-backed reporting periods or classify a committed payroll earning line for an applicable separation filing. Read get_separation_history and payroll run details first for current evidence and native record ids.",
    inputSchema: historyMutationInput,
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
        const scope = {
          employeePartyId: body.employeePartyId,
          employmentId: body.employmentId,
          subsidiaryId: body.subsidiaryId,
          ...payrollScope(context),
        };
        const record =
          body.kind === "period"
            ? await importRoePriorPeriod(scope, body.evidence as z.infer<typeof periodEvidence>)
            : await qualifyRoeLine(scope, body.evidence as z.infer<typeof lineEvidence>);
        return { ok: true, record, href: "/payroll/separations" };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "delete_separation_history",
    title: "Delete Separation History",
    description:
      "Withdraw unissued historical attribution while preserving committed payroll and its original source. Read get_separation_history first for the evidence id and updated-at value.",
    inputSchema: z.strictObject({
      ...separationSubject,
      expectedId: UUID("Unissued line attribution id from get_separation_history."),
      expectedUpdatedAt: z
        .string()
        .min(1)
        .max(100)
        .describe("Current updated-at value from get_separation_history."),
      reason: CHANGE_REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      try {
        const { expectedId, expectedUpdatedAt, reason, idempotencyKey: _key, ...subject } = input;
        await withdrawRoeLineEvidence(
          { ...subject, ...payrollScope(context) },
          { expectedId, expectedUpdatedAt, reason },
        );
        return { ok: true, withdrawn: true, href: "/payroll/separations" };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "get_subsequent_service",
    title: "Get Subsequent Service",
    description:
      "Read retained evidence of a genuine return to service after an employee separation. Find employee, employment, employer, event, and retained source ids with payroll separation and File Cabinet reads.",
    inputSchema: z.strictObject({
      ...separationSubject,
      precedingEventId: UUID("Earlier separation event id from payroll separation reads."),
      sourceFileId: UUID("Optional retained source file id from File Cabinet reads.").optional(),
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
        const { precedingEventId, sourceFileId, ...employee } = input;
        const result = await readRoeSubsequentServiceContext(
          { ...employee, eventId: precedingEventId, ...payrollScope(context) },
          precedingEventId,
          sourceFileId,
        );
        return { ok: true, ...result, href: "/payroll/separations" };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "record_subsequent_service",
    title: "Record Subsequent Service",
    description:
      "Record retained evidence of a genuine return to service after an employee separation when the applicable payroll pack supports it. Read get_subsequent_service first for the prior event and current evidence version.",
    inputSchema: z.strictObject({
      ...separationSubject,
      precedingEventId: UUID("Earlier separation event id from payroll separation reads."),
      firstDayWorked: DATE.describe("First day worked after returning to service."),
      sourceFileId: UUID("Retained source file id from File Cabinet reads."),
      sourceVersionId: UUID("Exact retained source version id from File Cabinet reads."),
      sourceSha256: DIGEST,
      sourceReference: SOURCE_REFERENCE,
      reason: CHANGE_REASON,
      expectedId: UUID("Existing subsequent-service evidence id from get_subsequent_service.")
        .nullable()
        .describe("Existing evidence id, or null when adding a new entry."),
      expectedUpdatedAt: z
        .string()
        .max(100)
        .nullable()
        .describe(
          "Existing updated-at value from get_subsequent_service, or null for a new entry.",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
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
        const {
          employeePartyId,
          employmentId,
          subsidiaryId,
          idempotencyKey: _key,
          ...evidence
        } = input;
        const record = await saveRoeSubsequentService(
          {
            employeePartyId,
            employmentId,
            subsidiaryId,
            eventId: evidence.precedingEventId,
            ...payrollScope(context),
          },
          evidence,
        );
        return { ok: true, record, href: "/payroll/separations" };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
];
