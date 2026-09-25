import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { businessToday } from "../../platform/business-date.ts";
import { db } from "../../platform/db.ts";
import { formatMoney } from "../../money/money.ts";
import { unsealSecret } from "../../platform/secrets.ts";
import { PayrollError } from "../error.ts";
import {
  ROE_REASON_CODES, roeRecord, type RoeRecord, type RoeReasonCode,
} from "../yearend.ts";
import { validateXML } from "xmllint-wasm";

// This is the schema linked from Service Canada's current ROE Web Appendix D.
// Keep it local and validate offline; no employee payroll data is sent to a
// third-party validation service and schema availability is not a runtime risk.
// Loaded lazily on first validation: a module-scope filesystem read breaks
// module evaluation under bundler SSR runtimes (their URL realm rejects the
// resolved file URL), which crashed every page importing the pack registry.
let cachedPayrollExtractV2Xsd: string | null = null;
function payrollExtractV2Xsd(): string {
  if (cachedPayrollExtractV2Xsd === null) {
    cachedPayrollExtractV2Xsd = readFileSync(
      fileURLToPath(new URL("./schemas/PayrollExtractXmlV2.xsd", import.meta.url)),
      "utf8",
    );
  }
  return cachedPayrollExtractV2Xsd;
}

/**
 * Service Canada ROE Web bulk-upload XML — the same shape as the CRA T4 file
 * builder (engine/src/payroll/canada/t4xml.ts): one transmittal element wrapping one
 * record per employee, built from the SAME committed-stub data the year-end
 * worksheets show, so the file always reconciles to the on-screen blocks.
 *
 * Blocks covered: 3 (payroll reference), 5 (CRA payroll account), 6 (pay
 * period type), 8 (SIN), 9 (employee name), 10/11/12 (first day worked, last
 * day paid, final pay-period end), 13 (occupation), 15A/15B/15C (insurable
 * hours and earnings by pay period), 16 (reason for issue and contact), 17
 * (separation payments), 18 (comment). Every generated file is validated
 * against Service Canada's published Payroll Extract v2 schema before return.
 *
 * Fails closed with every problem named: missing SINs, missing reason codes,
 * missing employer account, missing transmitter configuration, or fields that
 * cannot fit the published Payroll Extract v2 schema.
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
    filename: `ROE-${await businessToday(orgId)}.xml`,
    xml: await validateRoeXml(renderRoeXml({ employer, records })),
    roeCount: records.length,
  };
}

/** Validate the bytes against Service Canada's published Payroll Extract v2 XSD. */
export async function validateRoeXml(xml: string): Promise<string> {
  const result = await validateXML({
    xml: [{ fileName: "roe-payroll-extract.xml", contents: xml }],
    schema: [{ fileName: "PayrollExtractXmlV2.xsd", contents: payrollExtractV2Xsd() }],
  });
  if (!result.valid) {
    const detail = result.errors.map((error) => error.message).join("; ");
    throw new PayrollError(`generated ROE Payroll Extract v2 XML failed Service Canada's schema validation: ${detail}`);
  }
  return xml;
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
  // Strict: a null country is UNKNOWN, not Canadian — this builder is
  // separately callable with records the queries never produced, and the old
  // `?? "CA"` filed those as Canadian returns.
  const foreign = records
    .filter(({ record }) => record.country !== "CA")
    .map(({ record }) => `${record.employeeName} (${record.country ?? "unknown country"})`);
  if (foreign.length > 0) {
    throw new PayrollError(
      `a Record of Employment is a Service Canada return and can only be filed for a `
      + `Canadian employee — not: ${foreign.join(", ")}`,
    );
  }
  const phone = employer.contactPhone.replace(/\D/g, "");
  if (phone.length !== 10) {
    throw new PayrollError("the ROE transmitter contact phone must contain a 3-digit area code and 7-digit number — correct Payroll setup");
  }
  const contact = personName(employer.contactName);
  if (!contact.first || !contact.last || contact.first.length > 20 || contact.last.length > 28) {
    throw new PayrollError("the ROE transmitter contact needs a first and last name within Service Canada's field limits — correct Payroll setup");
  }
  const roeXml: string[] = [];
  for (const { record, issue, sin } of records) {
    const names = personName(record.employeeName);
    const { mailingAddress: address } = record;
    if (!address) throw new PayrollError(`${record.employeeName} has no ROE mailing address — add an employee address before issuing the ROE`);
    const addressLines = [address.line1, `${address.city} ${address.region}`, address.line2 ?? ""];
    if (addressLines.some((line) => line.length > 35)
      || !address.line1.trim() || !address.city.trim() || !address.region.trim()
      || !address.postalCode.trim() || address.postalCode.length > 10
      || !["CA", "US"].includes(address.country)) {
      throw new PayrollError(`${record.employeeName}'s ROE mailing address is incomplete or exceeds Service Canada's fields — correct the employee address`);
    }
    if (names.first.length > 20 || names.middle.length > 4 || names.last.length > 28) {
      throw new PayrollError(`${record.employeeName}'s name exceeds Service Canada's ROE name fields — correct the employee name`);
    }
    // Block 5: the employee's own payroll program account files the ROE;
    // employees on no account fall back to the employer business number.
    const bn = record.filingAccount.accountNumber ?? employer.bn;
    const periodXml = record.periods.map((period, index) =>
      `     <PP nbr="${index + 1}"><AMT>${amt(period.insurableEarnings)}</AMT></PP>`).join("\n");
    const vacationXml = record.separationAmounts.filter((amount) => amount.block === "17A")
      .map((amount) => `    <VP nbr="1"><CD>${esc(amount.code)}</CD><AMT>${amt(amount.amount)}</AMT></VP>`).join("");
    const otherXml = record.separationAmounts.filter((amount) => amount.block === "17C")
      .map((amount, index) => `    <OM nbr="${index + 1}"><CD>${esc(amount.code)}</CD><AMT>${amt(amount.amount)}</AMT></OM>`).join("");
    const recall = issue.expectedRecallDate ? "Y" : "U";
    const comment = issue.comment?.trim() ?? "";
    if (comment.length > 160) throw new PayrollError(`${record.employeeName}'s ROE comment exceeds Service Canada's 160-character limit`);

    roeXml.push(
      `  <ROE PrintingLanguage="E" Issue="S">\n` +
      `   ${tag("B3", record.payrollReference)}\n` +
      `   <B5>${esc(bn)}</B5><B6>${esc(record.payPeriodType)}</B6><B8>${esc(sin)}</B8>\n` +
      `   <B9><FN>${esc(names.first)}</FN>${names.middle ? `<MN>${esc(names.middle)}</MN>` : ""}` +
      `<LN>${esc(names.last)}</LN><A1>${esc(address.line1)}</A1>` +
      `<A2>${esc(`${address.city} ${address.region}`)}</A2>${tag("A3", address.line2)}` +
      `<PC>${esc(address.postalCode.replace(/[ -]/g, "").toUpperCase())}</PC></B9>\n` +
      `   <B10>${esc(record.firstDayWorked ?? "")}</B10><B11>${esc(record.lastDayPaid ?? "")}</B11>` +
      `<B12>${esc(record.finalPayPeriodEnd ?? "")}</B12>${tag("B13", record.occupation)}\n` +
      `   <B14><CD>${recall}</CD>${tag("DT", issue.expectedRecallDate ?? null)}</B14>\n` +
      `   <B15A>${ceilWhole(record.totalInsurableHours)}</B15A><B15C>\n${periodXml}\n   </B15C>\n` +
      `   <B16><CD>${esc(reasonCode(issue.reasonCode))}</CD><FN>${esc(contact.first)}</FN>` +
      `<LN>${esc(contact.last)}</LN><AC>${phone.slice(0, 3)}</AC><TEL>${phone.slice(3)}</TEL></B16>\n` +
      `${vacationXml ? `   <B17A>${vacationXml}</B17A>\n` : ""}` +
      `${otherXml ? `   <B17C>\n${otherXml}\n   </B17C>\n` : ""}` +
      `${tag("B18", comment || null)}\n` +
      `   <B20>E</B20>\n` +
      `  </ROE>`,
    );
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ROEHEADER FileVersion="W-2.0" SoftwareVendor="OpenBooks" ProductName="OpenBooks">\n` +
    roeXml.join("\n") + "\n" +
    `</ROEHEADER>\n`;

  return xml;
}

/** "First Last" → [surname, ...given]; single token = both. Drops any
 *  parenthesized suffix the sim data carries ("Jane Doe (Manager)"). */
function personName(displayName: string): { first: string; middle: string; last: string } {
  const clean = displayName.replace(/\s*\(.*\)\s*$/, "").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  return {
    first: parts[0] ?? "",
    middle: parts.slice(1, -1).join(" "),
    last: parts.length > 1 ? parts.at(-1)! : (parts[0] ?? ""),
  };
}

const reasonCode = (code: RoeReasonCode): string => ({
  A: "A00", B: "B00", D: "D00", E: "E00", F: "F00", G: "G00", H: "H00",
  J: "J00", K: "K00", M: "M00", N: "N00", P: "P00", Z: "Z00",
})[code];

function ceilWhole(decimal: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!match) throw new PayrollError("ROE Block 15A hours are not a nonnegative decimal");
  const fraction = match[2] ?? "";
  return (BigInt(match[1]!) + (/[1-9]/.test(fraction) ? 1n : 0n)).toString();
}
