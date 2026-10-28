import "server-only";
import { z } from "zod";
import { db } from "@openbooks/engine/platform/db";
import {
  createPayrollWorkLocation,
  listPayrollWorkLocations,
  updatePayrollWorkLocation,
} from "@openbooks/engine/payroll/work-location-admin";
import { proposeHolidayObligation } from "@openbooks/engine/payroll/holiday-obligations";
import { statutoryHolidayCalendarsOf } from "@openbooks/engine/payroll/holidays";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { accessAtLeast, fileAccessLevel } from "../file-cabinet";
import { fileViewer } from "../../app/api/file-cabinet/lib";
import {
  assertPayrollActor,
  assertPayrollEmployeeAccess,
  DATE,
  IDEMPOTENCY_KEY,
  payrollActor,
  settlePayrollRefusal,
  UUID,
} from "./payroll-tools-common";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { notFound } from "./errors";

const WORK_SHARE = z
  .string()
  .regex(/^(?:0(?:\.\d{1,10})?|1(?:\.0{1,10})?)$/)
  .nullable()
  .optional()
  .describe("Exact allocation share from zero to one, as decimal text.");
const WORK_LOCATION_FIELDS = {
  employmentId: UUID("Employment id from the payroll work-location list."),
  periodStart: DATE.describe("First date covered by this allocation."),
  periodEnd: DATE.describe("Last date covered by this allocation."),
  region: z.string().trim().min(1).max(32).describe("Pack-recognized payroll work region."),
  subregion: z
    .string()
    .trim()
    .max(64)
    .nullable()
    .optional()
    .describe("Pack-recognized work subregion, if applicable."),
  serviceDays: z
    .string()
    .regex(/^\d+$/)
    .nullable()
    .optional()
    .describe("Whole service days in this period, as an integer string."),
  workShare: WORK_SHARE,
  source: z
    .enum(["hr_records", "certificate", "adequate_records"])
    .describe("Evidence basis for the work allocation."),
  evidenceDocumentId: UUID("Saved evidence document id from the file cabinet.")
    .nullable()
    .optional(),
  changeReason: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe("Reason retained with the allocation audit."),
};
const SAVE_WORK_LOCATION = z
  .object(WORK_LOCATION_FIELDS)
  .refine((value) => value.periodStart <= value.periodEnd, {
    message: "period start must not follow period end",
    path: ["periodEnd"],
  })
  .refine((value) => (value.serviceDays != null) !== (value.workShare != null), {
    message: "enter either service days or a work share",
  });

export const PAYROLL_EMPLOYMENT_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_payroll_statutory_holidays",
    title: "List Payroll Statutory Holidays",
    description:
      "Read pack-declared statutory holiday calendars for active payroll employees. Use this with pay-run holiday assertion reads to identify applicable holiday dates and citations for the selected payroll year.",
    inputSchema: z.object({
      year: z
        .number()
        .int()
        .min(1900)
        .max(2999)
        .optional()
        .describe("Civil year to read; defaults to the current organization business year."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.read"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.read");
      const year =
        input.year ?? Number((await businessToday(context.authz.user.orgId)).slice(0, 4));
      const reading = await statutoryHolidayCalendarsOf({
        orgId: context.authz.user.orgId,
        year,
        subsidiaryIds:
          context.authz.allowedSubsidiaryIds === null
            ? null
            : [...context.authz.allowedSubsidiaryIds],
      });
      return { ok: true, year, ...reading, href: `/payroll/statutory-holidays?year=${year}` };
    },
  }),
  definition({
    name: "list_payroll_work_locations",
    title: "List Payroll Work Locations",
    description:
      "Read payroll employees and their dated work-region allocations for payroll apportionment. Use payroll employees to identify an employment, then pass its id and dates to review a period's allocations.",
    inputSchema: z
      .object({
        employmentId: UUID("Employment id from the employee's payroll record.").optional(),
        periodStart: DATE.optional().describe(
          "First date in the allocation period; required with employmentId and periodEnd.",
        ),
        periodEnd: DATE.optional().describe(
          "Last date in the allocation period; required with employmentId and periodStart.",
        ),
      })
      .refine((value) => !value.employmentId || (value.periodStart && value.periodEnd), {
        message: "An employment period requires employmentId, periodStart and periodEnd.",
      }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      const result = await listPayrollWorkLocations({
        orgId: context.authz.user.orgId,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        detail:
          input.employmentId && input.periodStart && input.periodEnd
            ? {
                employmentId: input.employmentId,
                periodStart: input.periodStart,
                periodEnd: input.periodEnd,
              }
            : undefined,
      });
      if (result.kind === "employment_out_of_scope") throw notFound("employment");
      return { ok: true, ...result, href: "/payroll/work-locations" };
    },
  }),
  definition({
    name: "create_payroll_work_location",
    title: "Create Payroll Work Location",
    description:
      "Record an employment's evidenced work-region allocation for a payroll period. Find the employment with list_payroll_work_locations and verify the saved row for the same dates.",
    inputSchema: SAVE_WORK_LOCATION.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
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
        const nativeBody = {
          ...body,
          serviceDays: body.serviceDays == null ? body.serviceDays : Number(body.serviceDays),
        };
        const result = await createPayrollWorkLocation(
          context.authz.user.orgId,
          context.authz.user.id,
          context.authz.allowedSubsidiaryIds,
          nativeBody,
        );
        if (result.kind === "employment_out_of_scope") throw notFound("employment");
        return {
          ok: true,
          row: result.row,
          href: `/payroll/work-locations?employment=${input.employmentId}&from=${input.periodStart}&to=${input.periodEnd}`,
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "update_payroll_work_location",
    title: "Update Payroll Work Location",
    description:
      "Correct an existing evidenced work-region allocation for the same employee and payroll period. Find the allocation id with list_payroll_work_locations and verify the updated row there.",
    inputSchema: SAVE_WORK_LOCATION.extend({
      id: UUID("Allocation id returned by list_payroll_work_locations."),
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
      try {
        const { idempotencyKey: _key, ...body } = input;
        const nativeBody = {
          ...body,
          serviceDays: body.serviceDays == null ? body.serviceDays : Number(body.serviceDays),
        };
        const result = await updatePayrollWorkLocation(
          context.authz.user.orgId,
          context.authz.user.id,
          context.authz.allowedSubsidiaryIds,
          nativeBody,
        );
        if (result.kind === "employment_out_of_scope" || result.kind === "not_found")
          throw notFound("payroll work location");
        return {
          ok: true,
          row: result.row,
          href: `/payroll/work-locations?employment=${input.employmentId}&from=${input.periodStart}&to=${input.periodEnd}`,
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "propose_payroll_holiday_obligation",
    title: "Propose Payroll Holiday Obligation",
    description:
      "Submit a source-backed proposal for unpaid statutory holiday entitlement through the configured approval flow. Use the holiday and source documents from the payroll reads, then verify the proposal in Accounting Changes.",
    inputSchema: z.object({
      instruction: z
        .object({
          employeePartyId: UUID("Employee id from payroll employee reads."),
          holidayDates: z
            .array(DATE.describe("Holiday date covered by the source instruction."))
            .min(1)
            .max(100),
          hours: z
            .string()
            .regex(/^\d+(?:\.\d{1,4})?$/)
            .describe("Exact eligible hours as decimal text."),
          assessedOn: DATE.describe("Date the entitlement assessment was made."),
          wageBasisDate: DATE.describe("Date used to resolve the applicable wage basis."),
          paymentDate: DATE.describe("Date the proposed entitlement is expected to be paid."),
          instructionKey: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .describe("Stable source-instruction identity."),
          sourceReference: z
            .string()
            .trim()
            .min(1)
            .max(2000)
            .describe("Reference to the source instruction."),
          sourceDigest: z
            .string()
            .regex(/^[a-f0-9]{64}$/i)
            .describe("SHA-256 digest of the source instruction."),
        })
        .describe("Pack-independent source evidence accepted by the payroll holiday service."),
      source: z
        .object({
          fileId: UUID("Source evidence file id from the file cabinet."),
          versionId: UUID("Exact source evidence version id from the file cabinet."),
        })
        .describe("Versioned source evidence from the file cabinet."),
      employmentId: UUID("Employment id owning the holiday entitlement."),
      reason: z
        .string()
        .trim()
        .min(8)
        .max(1000)
        .describe("Reason for this proposed entitlement adjustment."),
      idempotencyKey: z
        .string()
        .trim()
        .min(8)
        .max(120)
        .describe("Unique retry key for this exact proposal."),
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayrollEmployeeAccess(context, [input.instruction.employeePartyId]);
      try {
        const result = await proposeHolidayObligation({
          ...input,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
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
        return { ok: true, ...result, href: `/accounting/changes?changeId=${result.changeId}` };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
];
