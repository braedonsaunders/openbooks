import "server-only";
import { z } from "zod";
import {
  payrollPeriodOpeningForEmployee,
  savePayrollPeriodOpening,
} from "@openbooks/engine/payroll/period-openings";
import {
  payrollPriorEarningsForEmployee,
  savePayrollPriorEarnings,
} from "@openbooks/engine/payroll/prior-earnings";
import {
  declaredEmployerLevyFields,
  employerLevyOpeningsForYear,
  saveEmployerLevyOpening,
  EmployerLevyOpeningSaveError,
  assertTaxYear,
  declaredAccountOpeningBaseFields,
  declaredProgramBaseFields,
  OPENING_BALANCE_FIELDS,
} from "@openbooks/engine/payroll/opening-balances";
import {
  readOpeningEmployerContext,
  qualifyOpeningEmployerAuthority,
} from "@openbooks/engine/payroll/opening-employer-authority";
import {
  assertMovementDate,
  EntitlementOpeningSaveError,
  saveEntitlementOpenings,
} from "@openbooks/engine/payroll/entitlements/operations";
import {
  requestBodySchema as annualOpeningBodySchema,
  savePayrollOpeningBalances,
} from "../../app/api/payroll/opening-balances/route";
import { scopedEntitlementOpenings, scopedOpeningBalances } from "../payroll-scoped-views";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { accessAtLeast, fileAccessLevel } from "../file-cabinet";
import { db } from "@openbooks/engine/platform/db";
import { fileViewer } from "../../app/api/file-cabinet/lib";
import {
  assertPayrollActor,
  assertPayrollEmployeeAccess,
  assertPayrollUnrestrictedScope,
  DATE,
  IDEMPOTENCY_KEY,
  payrollActor,
  settlePayrollRefusal,
  UUID,
} from "./payroll-tools-common";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const EXACT_AMOUNT = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,4})?$/)
  .describe("Exact signed decimal amount as text, at most four fractional places.");
const EARNING_LINE = z
  .object({
    sourceKey: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .describe("Stable line identity from the previous payroll source."),
    sourceLabel: z.string().trim().min(1).max(160).describe("Source label for the earning line."),
    earnedFrom: DATE.describe("First date covered by this earning line."),
    earnedThrough: DATE.describe("Last date covered by this earning line."),
    bucket: z
      .enum(["regular", "overtime", "vacationPay", "holidayPay"])
      .describe("Statutory prior-earnings category."),
    amount: EXACT_AMOUNT,
  })
  .describe("One source-backed prior earning line.");
const PRIOR_PERIOD = z
  .object({
    from: DATE.describe("Source pay-period start date."),
    through: DATE.describe("Source pay-period end date."),
    sourceReference: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe("Reference to the prior payroll period statement."),
    lines: z
      .array(EARNING_LINE)
      .max(2000)
      .describe(
        "Every earning line in this period; use an empty array only when the source confirms zero earnings.",
      ),
  })
  .describe("A complete source pay period, including periods with confirmed zero earnings.");

const OPENING_AMOUNT = z
  .string()
  .regex(/^(?:-?\d+(?:\.\d{1,4})?)?$/)
  .describe(
    "Exact opening amount as decimal text; blank keeps a value untouched where the native grid permits it.",
  );
const OPENING_MAP = z
  .record(z.string().describe("Pack-declared opening field or component id."), OPENING_AMOUNT)
  .describe("Exact decimal opening values keyed by the pack declaration.");
const OPENING_ROW = z
  .object({
    employeePartyId: UUID("Employee party id from payroll opening reads."),
    amounts: OPENING_MAP.optional().describe("Pack-declared statutory carry-in values."),
    components: OPENING_MAP.nullable()
      .optional()
      .describe("Component carry-in values keyed by component id or code."),
    programs: OPENING_MAP.optional().describe("Pack-declared program base carry-in values."),
    suiStates: OPENING_MAP.optional().describe("Pack-declared state-specific unemployment bases."),
    accountBases: z
      .array(
        z.object({
          programKey: z
            .string()
            .min(1)
            .max(120)
            .describe("Pack-declared account-base program key."),
          filingAccountId: UUID("Filing-account id from payroll setup."),
          region: z.string().nullable().describe("Pack-declared region for the account base."),
          insurableYtd: OPENING_AMOUNT.describe("Exact insurable year-to-date amount as text."),
        }),
      )
      .max(1000)
      .optional()
      .describe("Filing-account-scoped wage bases from pack declarations."),
    updatedAt: z
      .string()
      .nullable()
      .optional()
      .describe("Current row version returned by the payroll opening read, or null when absent."),
  })
  .describe("One employee's carry-in row.");

async function readRouteResponse(response: Response): Promise<Record<string, unknown>> {
  const raw: unknown = await response.json().catch(() => ({}));
  const body =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (response.ok) return body;
  const message =
    typeof body.error === "string" ? body.error : "Payroll opening change was refused.";
  if (response.status === 404) throw notFound("payroll opening");
  const code =
    response.status === 403 ? "forbidden" : response.status === 409 ? "conflict" : "invalid_input";
  throw new ApplicationError(
    code,
    message,
    response.status >= 400 && response.status < 500 ? response.status : 422,
    {
      ...(body.details && typeof body.details === "object" ? { details: body.details } : {}),
      ...(typeof body.remedy === "string" ? { remedy: body.remedy } : {}),
    },
  );
}

function parseNative<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError)
      throw invalidInput(error.issues[0]?.message ?? "Payroll opening is invalid.");
    throw error;
  }
}

export const PAYROLL_OPENING_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_payroll_period_opening",
    title: "Get Payroll Period Opening",
    description:
      "Read the pack-declared paid-period opening fields, employee legal employer, schedule and current annual balance revision. Find the employee id with list_payroll_employees and use the returned field names and revisions to prepare a reviewed period-opening write.",
    inputSchema: z.object({
      employeePartyId: UUID("Employee party id from list_payroll_employees."),
      taxYear: z.number().int().min(2000).max(2100).describe("Tax year being opened."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.read"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.read");
      await assertPayrollEmployeeAccess(context, [input.employeePartyId]);
      try {
        const view = await payrollPeriodOpeningForEmployee({
          ...input,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          ...view,
          href: `/payroll/period-openings?employeePartyId=${input.employeePartyId}&taxYear=${input.taxYear}`,
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "save_payroll_period_opening",
    title: "Save Payroll Period Opening",
    description:
      "Record source-backed prior-period payments within an employee's annual payroll opening balance, using the exact pack fields and optimistic revisions from get_payroll_period_opening. Verify the saved period row and annual revision with that read.",
    inputSchema: z.object({
      employeePartyId: UUID("Employee party id from get_payroll_period_opening."),
      taxYear: z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .describe("Tax year returned by get_payroll_period_opening."),
      subsidiaryId: UUID("Legal-employer id returned by get_payroll_period_opening."),
      payScheduleId: UUID("Assigned pay schedule id returned by get_payroll_period_opening."),
      country: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .describe(
          "Pack jurisdiction identifier returned by get_payroll_period_opening; pass it through without branching on it.",
        ),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .describe("Legal-employer payroll currency returned by get_payroll_period_opening."),
      periodStart: DATE.describe("First date in the prior payroll period."),
      periodEnd: DATE.describe("Last date in the prior payroll period."),
      paidThrough: DATE.describe("Date through which payments are evidenced."),
      amounts: z
        .record(
          z.string().describe("Field key returned by the selected payroll pack."),
          EXACT_AMOUNT,
        )
        .describe("Exact decimal amounts for the pack-declared period-opening fields."),
      sourceReference: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Source statement or payroll record reference."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason for recording this prior-period evidence."),
      expectedRevision: z
        .number()
        .int()
        .positive()
        .nullable()
        .describe(
          "Current period-opening revision returned by get_payroll_period_opening; null when no row exists.",
        ),
      expectedAnnualUpdatedAt: z
        .string()
        .min(1)
        .max(80)
        .describe(
          "Current annual opening revision timestamp returned by get_payroll_period_opening.",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollEmployeeAccess(context, [input.employeePartyId]);
      try {
        const result = await savePayrollPeriodOpening({
          ...input,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          dryRun: false,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          changed: result.changed,
          record: result.record,
          annualUpdatedAt: result.annualUpdatedAt,
          href: `/payroll/period-openings?employeePartyId=${input.employeePartyId}&taxYear=${input.taxYear}`,
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "get_payroll_prior_earnings",
    title: "Get Payroll Prior Earnings",
    description:
      "Read a former-provider earnings record used in the current payroll's statutory history window. Find the employee and legal-employer ids from payroll employee and legal-entity reads, then use the returned revision before replacing the record.",
    inputSchema: z.object({
      employeePartyId: UUID("Employee party id from list_payroll_employees."),
      subsidiaryId: UUID("Legal-employer id for the employee."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.read"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.read");
      await assertPayrollEmployeeAccess(context, [input.employeePartyId]);
      try {
        const record = await payrollPriorEarningsForEmployee({
          ...input,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          record,
          href: `/payroll/prior-earnings?employeePartyId=${input.employeePartyId}&subsidiaryId=${input.subsidiaryId}`,
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "save_payroll_prior_earnings",
    title: "Save Payroll Prior Earnings",
    description:
      "Record complete former-provider earnings periods from an authorized, versioned source file before current-period calculations. Read the current revision with get_payroll_prior_earnings and verify the replacement there.",
    inputSchema: z.object({
      employeePartyId: UUID("Employee party id from list_payroll_employees."),
      subsidiaryId: UUID("Legal-employer id for the employee."),
      country: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .describe(
          "Pack jurisdiction identifier from the employee profile; pass it through without branching on it.",
        ),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .describe("Payroll currency from the employee's legal employer."),
      historyFrom: DATE.describe("First day covered by the prior-provider history."),
      historyThrough: DATE.describe("Last day covered by the prior-provider history."),
      periods: z
        .array(PRIOR_PERIOD)
        .min(1)
        .max(367)
        .describe(
          "All source periods in the interval, including source-confirmed zero-earning periods.",
        ),
      sourceFileId: UUID("Source file id from file-cabinet reads."),
      sourceVersionId: UUID("Exact source file version id from file-cabinet reads."),
      sourceHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .describe("SHA-256 of the exact source version content."),
      sourceReference: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Description or reference for the verified previous payroll source."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason for recording or replacing the history."),
      expectedRevision: z
        .number()
        .int()
        .positive()
        .nullable()
        .describe(
          "Current revision returned by get_payroll_prior_earnings; null when none exists.",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollEmployeeAccess(context, [input.employeePartyId]);
      try {
        const { idempotencyKey: _key, ...request } = input;
        const result = await savePayrollPriorEarnings({
          ...request,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          dryRun: false,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          authorizeFile: async (fileId) =>
            accessAtLeast(
              await fileAccessLevel(
                context.authz.user.orgId,
                fileViewer(context.authz),
                fileId,
                db,
              ),
              "viewer",
            ),
        });
        return {
          ok: true,
          ...result,
          href: `/payroll/prior-earnings?employeePartyId=${input.employeePartyId}&subsidiaryId=${input.subsidiaryId}`,
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "list_payroll_opening_balances",
    title: "List Payroll Opening Balances",
    description:
      "Read employee payroll carry-ins, their optimistic row versions and pack-declared statutory fields for a tax year. Find employees with list_payroll_employees and review these rows before saving any year-to-date opening changes.",
    inputSchema: z.object({
      taxYear: z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .optional()
        .describe("Tax year to read; defaults to the organization's current business year."),
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
        const year = assertTaxYear(
          input.taxYear ?? Number((await businessToday(context.authz.user.orgId)).slice(0, 4)),
        );
        const [data, programs, accountPrograms] = await Promise.all([
          scopedOpeningBalances(context.authz, year),
          declaredProgramBaseFields(),
          declaredAccountOpeningBaseFields(),
        ]);
        return {
          ok: true,
          ...data,
          fields: OPENING_BALANCE_FIELDS.map(({ key, label, help, packs }) => ({
            key,
            label,
            help,
            packs,
          })),
          programs: programs.map(({ programKey, label, help, country }) => ({
            key: programKey,
            label,
            help,
            packs: [country],
          })),
          accountPrograms: accountPrograms.map(
            ({ programKey, label, help, country, filingProgramType, requiresRegion }) => ({
              key: programKey,
              label,
              help,
              country,
              filingProgramType,
              requiresRegion,
            }),
          ),
          href: `/payroll/opening-balances?year=${year}`,
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "save_payroll_opening_balances",
    title: "Save Payroll Opening Balances",
    description:
      "Save the reviewed full set of employee year-to-date carry-ins with row-version checks and an audit reason. Read list_payroll_opening_balances first, retain every existing row value that should remain, and verify the changed employees there.",
    inputSchema: z
      .object({
        taxYear: z
          .number()
          .int()
          .min(2000)
          .max(2100)
          .describe("Tax year shown by list_payroll_opening_balances."),
        rows: z
          .array(OPENING_ROW)
          .max(2000)
          .describe(
            "Rows to update for this tax year, with exact pack-declared values and their current versions.",
          ),
        auditReason: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .optional()
          .describe("Reason retained with the opening-balance change."),
        sourceReference: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .optional()
          .describe("Reference to the source payroll report or migration record."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine((body) => body.sourceReference === undefined || body.auditReason !== undefined, {
        message: "A source-referenced opening change requires an audit reason.",
        path: ["auditReason"],
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollEmployeeAccess(
        context,
        input.rows.map((row) => row.employeePartyId),
      );
      try {
        const { idempotencyKey: _key, ...raw } = input;
        const body = parseNative(annualOpeningBodySchema, raw);
        const response = await savePayrollOpeningBalances({ authz: context.authz, body });
        const result = await readRouteResponse(response);
        return { ok: true, ...result, href: `/payroll/opening-balances?year=${input.taxYear}` };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "get_payroll_opening_employer_authority",
    title: "Get Payroll Opening Employer Authority",
    description:
      "Read an employee's year-to-date opening record, legal employers and retained source evidence to prepare an authority qualification. Find the employee and source-file ids with payroll opening and file-cabinet reads.",
    inputSchema: z.object({
      employeePartyId: UUID("Employee party id from payroll opening reads."),
      taxYear: z.number().int().min(2000).max(2100).describe("Tax year of the opening record."),
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
      await assertPayrollEmployeeAccess(context, [input.employeePartyId]);
      try {
        const result = await readOpeningEmployerContext({
          ...input,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, href: `/payroll/opening-balances?year=${input.taxYear}` };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "qualify_payroll_opening_employer_authority",
    title: "Qualify Payroll Opening Employer Authority",
    description:
      "Bind an employee's opening balance to the legal employer and exact versioned source that substantiates it, without changing paid history. Find the opening id, expected hash and source version with get_payroll_opening_employer_authority, then verify the qualification there.",
    inputSchema: z.object({
      openingBalanceId: UUID("Opening balance row id from get_payroll_opening_employer_authority."),
      subsidiaryId: UUID("Legal-employer id from get_payroll_opening_employer_authority."),
      expectedOpeningSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .describe("Current opening hash returned by the authority read."),
      sourceFileId: UUID("Versioned source file id from file-cabinet reads."),
      sourceVersionId: UUID("Exact source file version id from file-cabinet reads."),
      sourceSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .describe("SHA-256 of the exact source version."),
      sourceReference: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reference to the original employer payroll evidence."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason for qualifying this opening's source authority."),
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
        const result = await qualifyOpeningEmployerAuthority({
          ...body,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, record: result, href: "/payroll/opening-balances" };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "get_payroll_employer_levy_openings",
    title: "Get Payroll Employer Levy Openings",
    description:
      "Read current pack-declared employer levy carry-ins and the expected complete scope for a tax year. This organization-wide view requires unrestricted subsidiary access; verify all rows before replacing them.",
    inputSchema: z.object({
      taxYear: z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .optional()
        .describe("Tax year to read; defaults to the organization's current business year."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.read"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.read");
      assertPayrollUnrestrictedScope(context);
      try {
        const year = assertTaxYear(
          input.taxYear ?? Number((await businessToday(context.authz.user.orgId)).slice(0, 4)),
        );
        const [levies, rows] = await Promise.all([
          declaredEmployerLevyFields(year),
          employerLevyOpeningsForYear(context.authz.user.orgId, year),
        ]);
        return { ok: true, year, levies, rows, href: `/payroll/opening-balances?year=${year}` };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "save_payroll_employer_levy_openings",
    title: "Save Payroll Employer Levy Openings",
    description:
      "Replace the complete set of employer levy year-to-date bases using pack-declared levy keys and exact source values. Read get_payroll_employer_levy_openings first; this organization-wide write requires unrestricted subsidiary access.",
    inputSchema: z.object({
      taxYear: z.number().int().min(2000).max(2100).describe("Tax year for the employer carry-in."),
      rows: z
        .array(
          z.object({
            country: z
              .string()
              .trim()
              .min(2)
              .max(3)
              .describe(
                "Pack key returned by get_payroll_employer_levy_openings; pass through without interpreting it.",
              ),
            levyKey: z.string().trim().min(1).max(120).describe("Pack-declared employer levy key."),
            region: z
              .string()
              .trim()
              .max(80)
              .nullable()
              .optional()
              .describe("Pack-declared region for this levy base."),
            baseYtd: z
              .string()
              .regex(/^\d+(?:\.\d{1,4})?$/)
              .describe("Non-negative exact year-to-date base as decimal text."),
          }),
        )
        .max(500)
        .describe("Complete employer levy opening set for this tax year."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      assertPayrollUnrestrictedScope(context);
      try {
        const { idempotencyKey: _key, ...body } = input;
        return {
          ok: true,
          ...(await saveEmployerLevyOpening({
            rows: body.rows.map((row) => ({
              country: row.country.trim(),
              levyKey: row.levyKey.trim(),
              region: row.region?.trim() || null,
              baseYtd: row.baseYtd,
            })),
            orgId: context.authz.user.orgId,
            actorId: context.authz.user.id,
            taxYear: assertTaxYear(body.taxYear),
          })),
          href: `/payroll/opening-balances?year=${input.taxYear}`,
        };
      } catch (error) {
        if (error instanceof EmployerLevyOpeningSaveError)
          throw new ApplicationError("conflict", error.message, 409, {
            errors: error.result.errors,
          });
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "list_payroll_entitlement_openings",
    title: "List Payroll Entitlement Openings",
    description:
      "Read employee entitlement opening balances as of a date. Find employees with payroll employee reads and use the pack-declared plan and amount fields to prepare a reviewed opening movement.",
    inputSchema: z.object({
      asOf: DATE.optional().describe(
        "Date to resolve opening balances; defaults to the current date.",
      ),
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
        const data = await scopedEntitlementOpenings(context.authz, {
          asOf: input.asOf ? assertMovementDate(input.asOf) : undefined,
        });
        return { ok: true, ...data, href: "/payroll/opening-balances?tab=entitlements" };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "save_payroll_entitlement_openings",
    title: "Save Payroll Entitlement Openings",
    description:
      "Record a dated, audited opening movement for the listed employee entitlement plans. Read list_payroll_entitlement_openings first and verify updated balances there.",
    inputSchema: z.object({
      movementDate: DATE.describe("Date the prior-system entitlement balance was measured."),
      note: z
        .string()
        .trim()
        .max(2000)
        .nullable()
        .optional()
        .describe("Source note retained with the opening movement."),
      rows: z
        .array(
          z.object({
            employeePartyId: UUID("Employee party id from list_payroll_entitlement_openings."),
            amounts: z
              .record(
                z.string().describe("Entitlement plan key from list_payroll_entitlement_openings."),
                OPENING_AMOUNT,
              )
              .optional()
              .describe("Exact decimal opening amounts by plan key."),
          }),
        )
        .max(2000)
        .describe("Employee opening rows to replace for this movement date."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollEmployeeAccess(
        context,
        input.rows.map((row) => row.employeePartyId),
      );
      try {
        const result = await saveEntitlementOpenings({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          movementDate: assertMovementDate(input.movementDate),
          rows: input.rows.map((row) => ({
            employeePartyId: row.employeePartyId,
            amounts: row.amounts ?? {},
          })),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          note: input.note?.trim() || null,
        });
        return {
          ok: true,
          ...result,
          href: `/payroll/opening-balances?tab=entitlements&asOf=${input.movementDate}`,
        };
      } catch (error) {
        if (error instanceof EntitlementOpeningSaveError)
          throw new ApplicationError("conflict", error.message, 409, {
            errors: error.result.errors,
            warnings: error.result.warnings,
          });
        settlePayrollRefusal(error);
      }
    },
  }),
];
