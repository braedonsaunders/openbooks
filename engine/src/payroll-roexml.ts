import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { formatMoney } from "./money.ts";
import { unsealSecret } from "./secrets.ts";
import { PayrollError } from "./payroll-error.ts";
import {
  ROE_REASON_CODES, roeRecord, type RoeRecord, type RoeReasonCode,
} from "./payroll-yearend.ts";

/**
 * Service Canada ROE Web bulk-upload XML — the same shape as the CRA T4 file
 * builder (engine/src/payroll-t4xml.ts): one transmittal element wrapping one
 * record per employee, built from the SAME committed-stub data the year-end
 * worksheets show, so the file always reconciles to the on-screen blocks.
 *
 * Blocks covered: 4 (payroll reference), 5 (CRA payroll account), 6 (pay
 * period type), 8 (SIN), 9 (employee name), 10/11/12 (first day worked, last
 * day paid, final pay-period end), 13 (occupation), 15A/15B/15C (insurable
 * hours, insurable earnings, earnings by pay period), 16 (reason for issue and
 * contact), 17 (separation payments), 18 (comment).
 *
 * Fails closed with every problem named: missing SINs, missing reason codes,
 * missing employer account, missing transmitter configuration. IMPORTANT: like
 * the T4 file, the element names follow Service Canada's published ROE Web
 * conventions but MUST be validated against the ROE Web schema for the filing
 * period before transmitting — the Service Canada validator is the authority
 * (the UI repeats this note).
 *
 * Config: orgs.settings.payroll.t4Transmitter supplies the employer business
 * number and contact — the same employer identity the T4 return files under,
 * so there is never a second transmitter record to keep in sync.
 */

/** Blocks the payroll data cannot supply: the employer declares them. */
export interface RoeIssueInput {
  employeePartyId: string;
  /** Block 16 — see ROE_REASON_CODES. */
  reasonCode: RoeReasonCode;
  /** Block 18 — mandatory for reason K (other). */
  comment?: string | null;
  /** Block 14 — expected date of recall, when known. */
  expectedRecallDate?: string | null;
}

export interface EmployerConfig {
  bn: string;
  name: string;
  contactName: string;
  contactPhone: string;
}

const esc = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * Exact decimal formatting — NEVER `Number(v).toFixed(2)`.
 *
 * Money on a stub is already cent-quantized so the double round-trip happened
 * to be a no-op, but insurable HOURS are not: they come from `sum(l.hours)` at
 * whatever precision the time entries carry. `Number("86.6150").toFixed(2)`
 * yields "86.61" because 86.615 has no exact double representation, where
 * half-up gives 86.62 — and insurable hours drive an EI claim. money.ts is
 * bigint-exact and rounds half-up, and is a drop-in for both.
 */
const amt = (value: string): string => formatMoney(value || "0", 2);

const hrs = (value: string): string => formatMoney(value || "0", 2);

/**
 * A Canadian SIN, checksum included.
 *
 * `/^\d{9}$/` alone is not an identity check: a US SSN is also nine digits, so
 * a non-Canadian employee's SSN would sail through and be transmitted to
 * Service Canada inside a `<SIN>` element under the employer's CRA business
 * number. A SIN carries a Luhn check digit; an arbitrary nine-digit number
 * fails it nine times out of ten. This is defence in depth behind the country
 * assertion, not a replacement for it.
 */
export function isCanadianSin(value: string): boolean {
  if (!/^\d{9}$/.test(value)) return false;
  let total = 0;
  for (let i = 0; i < 9; i++) {
    let digit = Number(value[8 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    total += digit;
  }
  return total % 10 === 0;
}

const tag = (name: string, value: string | null): string =>
  value == null || value === "" ? "" : `<${name}>${esc(value)}</${name}>`;

export function isRoeReasonCode(value: unknown): value is RoeReasonCode {
  return typeof value === "string" && (ROE_REASON_CODES as readonly string[]).includes(value);
}

export async function buildRoeXml(
  orgId: string,
  issues: RoeIssueInput[],
): Promise<{ filename: string; xml: string; roeCount: number }> {
  if (issues.length === 0) throw new PayrollError("select at least one employee to issue an ROE for");

  const cfgRow = (await db.execute<{ cfg: Partial<EmployerConfig> | null }>(sql`
    select settings#>'{payroll,t4Transmitter}' as cfg from orgs where id = ${orgId}
  `));
  const cfg = cfgRow.rows[0]?.cfg ?? {};
  const missingCfg = (["bn", "name", "contactName", "contactPhone"] as const)
    .filter((key) => !cfg[key] || !String(cfg[key]).trim());
  if (missingCfg.length > 0) {
    throw new PayrollError(
      `employer filing configuration incomplete (${missingCfg.join(", ")}) — set it under Payroll setup`,
    );
  }
  const employer = cfg as EmployerConfig;

  const sins = (await db.execute<{ employee_party_id: string; sin_encrypted: string | null }>(sql`
    select prof.employee_party_id, prof.sin_encrypted
      from employee_payroll_profiles prof
     where prof.org_id = ${orgId}
  `));
  const sinByEmployee = new Map(sins.rows.map((row) => [row.employee_party_id, row.sin_encrypted]));

  const missingSins: string[] = [];
  const missingComments: string[] = [];
  const missingEarnings: string[] = [];
  const records: RoeRecordToFile[] = [];

  for (const issue of issues) {
    if (!isRoeReasonCode(issue.reasonCode)) {
      throw new PayrollError(`unknown ROE reason for issue "${issue.reasonCode}"`);
    }
    const record = await roeRecord(orgId, issue.employeePartyId);
    if (!record) throw new PayrollError("employee not found");
    if (record.periods.length === 0) {
      missingEarnings.push(record.employeeName);
      continue;
    }
    // Reason K is "other": Service Canada requires the comment that explains it.
    if (issue.reasonCode === "K" && !issue.comment?.trim()) {
      missingComments.push(record.employeeName);
      continue;
    }
    const sealed = sinByEmployee.get(issue.employeePartyId);
    const sin = sealed ? unsealSecret(sealed) : null;
    if (!sin || !isCanadianSin(sin)) {
      missingSins.push(record.employeeName);
      continue;
    }
    records.push({ record, issue, sin });
  }

  // Every blocker is named at once so the payroll administrator fixes the set
  // in one pass instead of one employee per attempt.
  const problems = [
    missingSins.length > 0
      ? `missing or invalid SIN for: ${missingSins.join(", ")} — add SINs on the employee payroll profiles`
      : null,
    missingComments.length > 0
      ? `reason K (other) needs a comment for: ${missingComments.join(", ")}`
      : null,
    missingEarnings.length > 0
      ? `no committed pay periods for: ${missingEarnings.join(", ")}`
      : null,
  ].filter(Boolean);
  if (problems.length > 0) throw new PayrollError(problems.join("; "));

  return {
    filename: `ROE-${new Date().toISOString().slice(0, 10)}.xml`,
    xml: renderRoeXml({ employer, records }),
    roeCount: records.length,
  };
}

/** One ROE ready to serialize: the payroll data, the employer's declaration, the SIN. */
export interface RoeRecordToFile {
  record: RoeRecord;
  issue: RoeIssueInput;
  sin: string;
}

/**
 * The submission document itself — pure, so the block layout is verifiable
 * without a database.
 *
 * REFUSES a non-Canadian employee. `roeCandidates` and `roeRecord` carry the
 * country predicate, but this builder is separately callable — an API route, a
 * job or a test can hand it a record the queries never produced — and the
 * consequence is not a bad report: it is a false Service Canada return filed
 * under the employer's CRA business number that discloses a foreign national
 * identifier as a `<SIN>`. A query filter is a convenience; this is the
 * control.
 */
export function renderRoeXml(input: {
  employer: EmployerConfig;
  records: RoeRecordToFile[];
}): string {
  const { employer, records } = input;
  const foreign = records
    .filter(({ record }) => (record.country ?? "CA") !== "CA")
    .map(({ record }) => `${record.employeeName} (${record.country})`);
  if (foreign.length > 0) {
    throw new PayrollError(
      `a Record of Employment is a Service Canada return and can only be filed for a `
      + `Canadian employee — not: ${foreign.join(", ")}`,
    );
  }
  const roeXml: string[] = [];
  for (const { record, issue, sin } of records) {
    const [surname, ...given] = splitName(record.employeeName);
    // Block 5: the employee's own payroll program account files the ROE;
    // employees on no account fall back to the employer business number.
    const bn = record.filingAccount.accountNumber ?? employer.bn;

    const periodXml = record.periods.map((period, index) =>
      `    <PayPeriod>` +
      `<PayPeriodNumber>${index + 1}</PayPeriodNumber>` +
      `<PayPeriodEndDate>${esc(period.periodEnd)}</PayPeriodEndDate>` +
      `<InsurableEarnings>${amt(period.insurableEarnings)}</InsurableEarnings>` +
      `<InsurableHours>${hrs(period.insurableHours)}</InsurableHours>` +
      `</PayPeriod>`).join("\n");

    roeXml.push(
      `  <ROE>\n` +
      `   <PayrollReferenceNumber>${esc(record.payrollReference ?? "")}</PayrollReferenceNumber>\n` +
      `   <BusinessNumber>${esc(bn)}</BusinessNumber>\n` +
      `   <PayPeriodType>${esc(record.payPeriodType)}</PayPeriodType>\n` +
      `   <Employee>` +
      `<SIN>${sin}</SIN>` +
      `<Surname>${esc(surname)}</Surname>` +
      `<GivenName>${esc(given.join(" ") || surname)}</GivenName>` +
      `${tag("Occupation", record.occupation)}` +
      `</Employee>\n` +
      `   ${tag("FirstDayWorked", record.firstDayWorked)}\n` +
      `   ${tag("LastDayPaid", record.lastDayPaid)}\n` +
      `   ${tag("FinalPayPeriodEndDate", record.finalPayPeriodEnd)}\n` +
      `   <TotalInsurableHours>${hrs(record.totalInsurableHours)}</TotalInsurableHours>\n` +
      `   <TotalInsurableEarnings>${amt(record.totalInsurableEarnings)}</TotalInsurableEarnings>\n` +
      `   <PayPeriods>\n${periodXml}\n   </PayPeriods>\n` +
      `   <ReasonForIssue>${esc(issue.reasonCode)}</ReasonForIssue>\n` +
      `   ${tag("ExpectedRecallDate", issue.expectedRecallDate ?? null)}\n` +
      `   <SeparationPayments>` +
      `<VacationPay>${amt(record.vacationPayOnSeparation)}</VacationPay>` +
      `<OtherMonies>${amt(record.otherMoniesOnSeparation)}</OtherMonies>` +
      `</SeparationPayments>\n` +
      `   ${tag("Comment", issue.comment ?? null)}\n` +
      `   <Contact><ContactName>${esc(employer.contactName)}</ContactName>` +
      `<ContactPhone>${esc(employer.contactPhone)}</ContactPhone></Contact>\n` +
      `  </ROE>`,
    );
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ROEWebSubmission xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n` +
    ` <Employer>\n` +
    `  <BusinessNumber>${esc(employer.bn)}</BusinessNumber>\n` +
    `  <EmployerName>${esc(employer.name)}</EmployerName>\n` +
    `  <Contact><ContactName>${esc(employer.contactName)}</ContactName>` +
    `<ContactPhone>${esc(employer.contactPhone)}</ContactPhone></Contact>\n` +
    ` </Employer>\n` +
    ` <ROEs count="${roeXml.length}">\n` +
    roeXml.join("\n") + "\n" +
    ` </ROEs>\n` +
    `</ROEWebSubmission>\n`;

  return xml;
}

/** "First Last" → [surname, ...given]; single token = both. Drops any
 *  parenthesized suffix the sim data carries ("Jane Doe (Manager)"). */
function splitName(displayName: string): string[] {
  const clean = displayName.replace(/\s*\(.*\)\s*$/, "").trim();
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return [parts[0]!];
  const surname = parts[parts.length - 1]!;
  return [surname, ...parts.slice(0, -1)];
}
