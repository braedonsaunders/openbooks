import type {
  LaborComplianceReportContext,
  LaborComplianceFileFormat,
} from "../labor-compliance.ts";
import type { PayrollFilingFile } from "../filing-registry.ts";
import { LaborComplianceBuildError } from "../labor-compliance.ts";

/**
 * United States labor-compliance report formats (HR-13).
 *
 * The pack declares its two artefacts; the generic certified-payroll
 * service lists whatever the pack declares and renders through the
 * declared builder. Builders are deterministic and pure over the typed
 * context — no DB, no clock, no environment — and throw
 * LaborComplianceBuildError naming the person or field plus an existing
 * remedy when a truthful file cannot be produced. Filenames derive from
 * the context (project reference + week ending), never invented at write
 * time, so a filed artefact keeps the name it was filed under.
 */

function requireRows(ctx: LaborComplianceReportContext): void {
  if (ctx.rows.length === 0) {
    throw new LaborComplianceBuildError(
      `week ending ${ctx.weekEnding} has no resolved worker/classification/day rows — resolve the week from approved time entries before generating the report.`,
    );
  }
  for (const row of ctx.rows) {
    if (!row.displayName || row.displayName.trim().length === 0) {
      throw new LaborComplianceBuildError(
        `employment ${row.employmentId} on ${row.day} has no display name — set the worker's name on the party record before generating the report.`,
      );
    }
    if (!row.classificationCode || row.classificationCode.trim().length === 0) {
      throw new LaborComplianceBuildError(
        `${row.displayName} on ${row.day} has no work classification — assign a classification effective that day before generating the report.`,
      );
    }
  }
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "project";
}

function federalWeeklyBuild(ctx: LaborComplianceReportContext): PayrollFilingFile {
  requireRows(ctx);
  const project = ctx.projectReference ?? ctx.projectName ?? "project";
  const lines = [
    `FEDERAL WEEKLY CERTIFIED PAYROLL — week ending ${ctx.weekEnding}`,
    `Contractor: ${ctx.orgName}`,
    `Project: ${project}`,
    `Generated: ${ctx.generatedAt}`,
    "worker|classification|day|hours|base_rate|fringe_cash|fringe_credit|deductions|net|rate_source",
    ...ctx.rows.map((row) =>
      [
        row.displayName,
        `${row.classificationCode} ${row.classificationName}`.trim(),
        row.day,
        row.hours,
        row.baseRate,
        row.fringeCash,
        row.fringeCredit,
        row.deductions,
        row.net,
        row.rateSource,
      ].join("|"),
    ),
  ];
  return {
    filename: `certified-payroll-${slug(project)}-${ctx.weekEnding}.txt`,
    contentType: "text/plain",
    body: `${lines.join("\n")}\n`,
  };
}

function stateXmlBuild(ctx: LaborComplianceReportContext): PayrollFilingFile {
  requireRows(ctx);
  const project = ctx.projectReference ?? ctx.projectName ?? "project";
  const esc = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const rows = ctx.rows
    .map(
      (row) =>
        `  <row worker=${JSON.stringify(esc(row.displayName))} classification=${JSON.stringify(esc(row.classificationCode))} day=${JSON.stringify(esc(row.day))} hours=${JSON.stringify(esc(row.hours))} baseRate=${JSON.stringify(esc(row.baseRate))} fringeCash=${JSON.stringify(esc(row.fringeCash))} fringeCredit=${JSON.stringify(esc(row.fringeCredit))} deductions=${JSON.stringify(esc(row.deductions))} net=${JSON.stringify(esc(row.net))} rateSource=${JSON.stringify(esc(row.rateSource))} />`,
    )
    .join("\n");
  return {
    filename: `certified-payroll-${slug(project)}-${ctx.weekEnding}.xml`,
    contentType: "application/xml",
    body: `<certifiedPayroll weekEnding=${JSON.stringify(esc(ctx.weekEnding))} project=${JSON.stringify(esc(project))} contractor=${JSON.stringify(esc(ctx.orgName))} generatedAt=${JSON.stringify(esc(ctx.generatedAt))}>\n${rows}\n</certifiedPayroll>\n`,
  };
}

/** The US pack's declared labor-compliance files: the federal weekly form and one state XML. */
export const US_LABOR_COMPLIANCE_FORMATS: readonly LaborComplianceFileFormat[] = [
  {
    key: "federal-weekly",
    label: "WH-347 Certified Payroll (federal weekly)",
    build: federalWeeklyBuild,
  },
  {
    key: "state-xml",
    label: "California certified payroll XML (DIR eCPR)",
    build: stateXmlBuild,
  },
];
