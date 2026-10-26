import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  applyRoeReportingImport,
  validateRoePriorPeriod,
  validateRoeLineEvidence,
  type RoeReportingImport,
  type RoeHistorySubject,
} from "@openbooks/engine/payroll/roe-history";
import { authorizeRoeReportingEmployee } from "@openbooks/engine/payroll/roe-separation-facts";
import {
  duplicateImportRowIndexes,
  subsidiaryReadFilter,
  type DataResource,
} from "./resource-core";
import {
  finishExportPage,
  readExportWindow,
  transferId,
  transferLimit,
  transferWhere,
} from "./export-page";
import { importRowError } from "./row-error";
import type { CellValue, ResourceDescriptor, ResourceField, WriteOutcome } from "./types";

export const ROE_PERIODS_KEY = "payroll-roe-historical-periods";
export const ROE_LINES_KEY = "payroll-roe-line-evidence";
const descriptor = (key: string, label: string, naturalKey: string): ResourceDescriptor => ({
  key,
  label,
  naturalKey,
  group: "Setup",
  iconKey: "history",
  supportsImport: true,
  scopedWrite: true,
  readPermission: "payroll.read",
  writePermission: "payroll.run",
});
export const ROE_PERIODS_DESCRIPTOR = descriptor(
  ROE_PERIODS_KEY,
  "ROE historical reporting periods",
  "employmentId + periodStart + periodEnd",
);
export const ROE_LINES_DESCRIPTOR = descriptor(
  ROE_LINES_KEY,
  "ROE retained earning-line evidence",
  "payStubLineId",
);
const SUBJECT_FIELDS: ResourceField[] = [
  { key: "employeePartyId", label: "Native employee ID", kind: "text", required: true },
  { key: "employeeName", label: "Employee name", kind: "text", readOnly: true },
  { key: "employmentId", label: "Native employment ID", kind: "text", required: true },
  { key: "subsidiaryId", label: "Legal employer ID", kind: "text", required: true },
];
const SOURCE_FIELDS: ResourceField[] = [
  { key: "sourceFileId", label: "Original File Cabinet file ID", kind: "text", required: true },
  { key: "sourceVersionId", label: "Original file version ID", kind: "text", required: true },
  { key: "sourceSha256", label: "Original file SHA-256", kind: "text", required: true },
  {
    key: "sourceReference",
    label: "Original employee and period source reference",
    kind: "long_text",
    required: true,
  },
  {
    key: "insuranceReference",
    label: "Original insurance classification source",
    kind: "long_text",
    required: true,
  },
  {
    key: "hoursReference",
    label: "Original insurable hours source",
    kind: "long_text",
    required: true,
  },
  {
    key: "reason",
    label: "Reason for retaining or correcting reporting evidence",
    kind: "long_text",
    required: true,
  },
  {
    key: "expectedId",
    label: "Reviewed evidence ID (new for first import)",
    kind: "text",
    required: true,
  },
  { key: "expectedUpdatedAt", label: "Reviewed evidence version (blank for new)", kind: "text" },
];
const PERIOD_FIELDS: ResourceField[] = [
  ...SUBJECT_FIELDS,
  {
    key: "filingAccountId",
    label: "Canadian payroll filing account ID",
    kind: "text",
    required: true,
  },
  { key: "payScheduleId", label: "Native pay schedule ID", kind: "text", required: true },
  {
    key: "frequency",
    label: "Pay-period type",
    kind: "select",
    required: true,
    options: ["weekly", "biweekly", "semi_monthly", "monthly"].map((value) => ({
      value,
      label: value.replace("_", " "),
    })),
  },
  { key: "periodStart", label: "Reporting period start", kind: "date", required: true },
  { key: "periodEnd", label: "Reporting period end", kind: "date", required: true },
  { key: "payDate", label: "Actual payment date (blank for nil period)", kind: "date" },
  { key: "earnedFrom", label: "Original earned span start (blank for nil period)", kind: "date" },
  { key: "earnedTo", label: "Original earned span end (blank for nil period)", kind: "date" },
  {
    key: "insurableEarnings",
    label: "Source-qualified insurable earnings",
    kind: "currency",
    required: true,
  },
  {
    key: "insurableHours",
    label: "Source-qualified insurable hours",
    kind: "currency",
    required: true,
  },
  {
    key: "nilPeriod",
    label: "Explicit source-qualified nil period",
    kind: "boolean",
    required: true,
  },
  ...SOURCE_FIELDS,
];
const LINE_FIELDS: ResourceField[] = [
  ...SUBJECT_FIELDS,
  { key: "payStubLineId", label: "Committed earning-line ID", kind: "text", required: true },
  {
    key: "reportingBasis",
    label: "Reporting basis",
    kind: "select",
    options: [
      { value: "service", label: "Service earnings" },
      { value: "separation_payment", label: "Source-qualified separation cash" },
    ],
  },
  {
    key: "separationEventId",
    label: "Selected separation event ID (separation cash only)",
    kind: "text",
  },
  {
    key: "separationPaymentId",
    label: "Existing paid declaration ID (blank creates one from the exact committed line)",
    kind: "text",
  },
  {
    key: "separationBlock",
    label: "Original separation payment block",
    kind: "select",
    options: [
      { value: "17A", label: "17A — vacation paid on separation" },
      { value: "17C", label: "17C — other separation money" },
    ],
  },
  {
    key: "separationCategoryCode",
    label: "Original separation category (2 for vacation paid on separation)",
    kind: "text",
  },
  {
    key: "reportPeriodStart",
    label: "Source-qualified reporting period start",
    kind: "date",
    required: true,
  },
  {
    key: "reportPeriodEnd",
    label: "Source-qualified reporting period end",
    kind: "date",
    required: true,
  },
  {
    key: "earnedFrom",
    label: "Original earned span start (retain original absence for separation cash)",
    kind: "date",
  },
  {
    key: "earnedTo",
    label: "Original earned span end (retain original absence for separation cash)",
    kind: "date",
  },
  { key: "isInsurable", label: "Original earning is insurable", kind: "boolean", required: true },
  {
    key: "insurableHours",
    label: "Source-qualified insurable hours",
    kind: "currency",
    required: true,
  },
  ...SOURCE_FIELDS,
];
function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Provide ${key} as explicit text`);
  return value.trim();
}
function nullableText(row: Record<string, unknown>, key: string): string | null {
  if (row[key] === null || row[key] === undefined || row[key] === "") return null;
  return text(row, key);
}
function boolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`Provide ${key} explicitly as true or false`);
}
function evidence(row: Record<string, unknown>, kind: "period" | "line"): RoeReportingImport {
  const expectedId = text(row, "expectedId");
  const source = {
    sourceFileId: text(row, "sourceFileId"),
    sourceVersionId: text(row, "sourceVersionId"),
    sourceSha256: text(row, "sourceSha256"),
    sourceReference: text(row, "sourceReference"),
    insuranceReference: text(row, "insuranceReference"),
    hoursReference: text(row, "hoursReference"),
    reason: text(row, "reason"),
    expectedId: expectedId === "new" ? null : expectedId,
    expectedUpdatedAt: nullableText(row, "expectedUpdatedAt"),
  };
  const input: RoeReportingImport =
    kind === "period"
      ? {
          kind,
          evidence: {
            ...source,
            filingAccountId: text(row, "filingAccountId"),
            payScheduleId: text(row, "payScheduleId"),
            frequency: text(row, "frequency") as "weekly" | "biweekly" | "semi_monthly" | "monthly",
            periodStart: text(row, "periodStart"),
            periodEnd: text(row, "periodEnd"),
            payDate: nullableText(row, "payDate"),
            earnedFrom: nullableText(row, "earnedFrom"),
            earnedTo: nullableText(row, "earnedTo"),
            insurableEarnings: row.insurableEarnings,
            insurableHours: row.insurableHours,
            nilPeriod: boolean(row, "nilPeriod"),
          },
        }
      : {
          kind,
          evidence: {
            ...source,
            payStubLineId: text(row, "payStubLineId"),
            reportPeriodStart: text(row, "reportPeriodStart"),
            reportPeriodEnd: text(row, "reportPeriodEnd"),
            earnedFrom: nullableText(row, "earnedFrom"),
            earnedTo: nullableText(row, "earnedTo"),
            isInsurable: boolean(row, "isInsurable"),
            insurableHours: row.insurableHours,
            reportingBasis: (nullableText(row, "reportingBasis") ?? "service") as
              "service" | "separation_payment",
            separationEventId: nullableText(row, "separationEventId"),
            separationPaymentId: nullableText(row, "separationPaymentId"),
            separationBlock: nullableText(row, "separationBlock") as "17A" | "17C" | null,
            separationCategoryCode: nullableText(row, "separationCategoryCode"),
          },
        };
  return input.kind === "period"
    ? { kind: "period", evidence: validateRoePriorPeriod(input.evidence) }
    : { kind: "line", evidence: validateRoeLineEvidence(input.evidence) };
}
/** The shared import workspace handles mapping and retry; native payroll owns every evidence write. */
export function payrollRoeReportingResource(orgId: string, kind: "period" | "line"): DataResource {
  const fields = kind === "period" ? PERIOD_FIELDS : LINE_FIELDS;
  const desc = kind === "period" ? ROE_PERIODS_DESCRIPTOR : ROE_LINES_DESCRIPTOR;
  return {
    descriptor: desc,
    async fields() {
      return fields;
    },
    async columns() {
      return fields.map(({ key, label }) => ({ key, label }));
    },
    async read(ctx) {
      if (!ctx?.actorId || ctx.allowedSubsidiaryIds === undefined)
        throw new Error(
          "ROE evidence export requires the acting user and explicit legal-entity scope",
        );
      return withOrgTransaction(orgId, async () => {
        const table =
          kind === "period" ? sql`payroll_roe_historical_periods` : sql`payroll_roe_line_evidence`;
        const specific =
          kind === "period"
            ? sql`
          e.filing_account_id::text as "filingAccountId",e.pay_schedule_id::text as "payScheduleId",e.frequency,
          e.period_start::text as "periodStart",e.period_end::text as "periodEnd",e.pay_date::text as "payDate",
          e.earned_from::text as "earnedFrom",e.earned_to::text as "earnedTo",
          e.insurable_earnings::text as "insurableEarnings",e.nil_period as "nilPeriod",`
            : sql`
          e.pay_stub_line_id::text as "payStubLineId",e.report_period_start::text as "reportPeriodStart",e.report_period_end::text as "reportPeriodEnd",
          e.reporting_basis as "reportingBasis",e.separation_event_id::text as "separationEventId",e.separation_payment_id::text as "separationPaymentId",
          e.separation_basis_snapshot->'classification'->>'block' as "separationBlock",e.separation_basis_snapshot->'classification'->>'categoryCode' as "separationCategoryCode",
          e.earned_from::text as "earnedFrom",e.earned_to::text as "earnedTo",e.is_insurable as "isInsurable",`;
        const rows = (
          await readExportWindow<Record<string, CellValue>>(
            db,
            sql`
          select e.employee_party_id::text as "employeePartyId",p.display_name as "employeeName",e.employment_id::text as "employmentId",
            e.subsidiary_id::text as "subsidiaryId",${specific} e.insurable_hours::text as "insurableHours",
            e.source_file_id::text as "sourceFileId",e.source_version_id::text as "sourceVersionId",e.source_sha256 as "sourceSha256",
            e.source_reference as "sourceReference",e.insurance_reference as "insuranceReference",e.hours_reference as "hoursReference",
            e.change_reason as reason,e.id::text as "expectedId",e.updated_at::text as "expectedUpdatedAt"${transferId(ctx, sql`e.id`)}
          from ${table} e join parties p on p.org_id=e.org_id and p.id=e.employee_party_id
          where e.org_id=${orgId} ${subsidiaryReadFilter(sql`e.subsidiary_id`, ctx.allowedSubsidiaryIds)}
            ${transferWhere(ctx, sql`e.id`)} order by e.id limit ${transferLimit(ctx)}`,
            ctx,
          )
        ).rows;
        for (const employeePartyId of new Set(rows.map((row) => String(row.employeePartyId)))) {
          await authorizeRoeReportingEmployee(
            {
              orgId,
              actorId: ctx.actorId!,
              employeePartyId,
              allowedSubsidiaryIds: ctx.allowedSubsidiaryIds,
            },
            "payroll.read",
          );
        }
        finishExportPage(rows, desc.label, ctx);
        return { fields, columns: fields.map(({ key, label }) => ({ key, label })), rows };
      });
    },
    async write(rows, mode, ctx) {
      if (ctx.orgId !== orgId || ctx.allowedSubsidiaryIds === undefined)
        throw new Error(
          "ROE evidence import requires the owning organization and explicit legal-entity scope",
        );
      if (ctx.post) throw new Error("ROE reporting evidence cannot post payroll or journals");
      type Prepared =
        { input: RoeReportingImport; subject: RoeHistorySubject; key: string } | { error: string };
      const prepared = rows.map<Prepared>((row) => {
        try {
          const input = evidence(row, kind);
          const subject: RoeHistorySubject = {
            orgId,
            actorId: ctx.actorId,
            allowedSubsidiaryIds: ctx.allowedSubsidiaryIds!,
            employeePartyId: text(row, "employeePartyId"),
            employmentId: text(row, "employmentId"),
            subsidiaryId: text(row, "subsidiaryId"),
          };
          const key =
            input.kind === "period"
              ? JSON.stringify([
                  subject.employmentId.toLowerCase(),
                  input.evidence.periodStart,
                  input.evidence.periodEnd,
                ])
              : input.evidence.payStubLineId.toLowerCase();
          return { input, subject, key };
        } catch (error) {
          return { error: importRowError(error) };
        }
      });
      const keys = prepared.map((row) => ("error" in row ? null : row.key));
      await ctx.recordKeys?.(keys);
      const duplicates = duplicateImportRowIndexes(keys);
      const overlaps = new Set<number>();
      if (kind === "period") {
        const groups = new Map<string, { index: number; start: string; end: string }[]>();
        for (const [index, item] of prepared.entries()) {
          if ("error" in item || item.input.kind !== "period") continue;
          const key = item.subject.employmentId.toLowerCase(),
            entries = groups.get(key) ?? [];
          entries.push({
            index,
            start: item.input.evidence.periodStart,
            end: item.input.evidence.periodEnd,
          });
          groups.set(key, entries);
        }
        for (const group of groups.values()) {
          group.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
          let latest: (typeof group)[number] | undefined;
          for (const period of group) {
            if (latest && period.start <= latest.end) {
              overlaps.add(latest.index);
              overlaps.add(period.index);
            }
            if (!latest || period.end > latest.end) latest = period;
          }
        }
      }
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] };
      for (const [index, item] of prepared.entries()) {
        try {
          if ("error" in item) throw new Error(item.error);
          if (duplicates.has(index))
            throw new Error(
              "This reporting evidence identity appears more than once — retain one reviewed row per original period or earning line",
            );
          if (overlaps.has(index))
            throw new Error(
              "Original reporting periods overlap in this import — reconcile the source intervals before importing",
            );
          if (mode === "insert" && item.input.evidence.expectedId !== null)
            throw new Error(
              "This reporting evidence already exists — export its current version and select update mode",
            );
          const result = await applyRoeReportingImport(item.subject, item.input, ctx.dryRun);
          if (result.action === "insert") outcome.created++;
          else if (result.action === "update") outcome.updated++;
        } catch (error) {
          outcome.failed++;
          outcome.errors.push({ row: index + 1, message: importRowError(error) });
        }
      }
      return outcome;
    },
  };
}
