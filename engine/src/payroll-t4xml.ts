import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add } from "./money.ts";
import { unsealSecret } from "./secrets.ts";
import { PayrollError } from "./payroll-error.ts";
import { filingAccountRef, filingAccountsById, type FilingAccountRef } from "./payroll-filing.ts";
import {
  t4Returns, t4Summary,
  type T4Return, type T4Slip, type T4SummaryTotals,
} from "./payroll-yearend.ts";

/**
 * CRA T4 Internet File Transfer XML — the T619 electronic transmittal
 * wrapping the T4 returns (slips + summary), built from the same committed-
 * stub data as the year-end worksheets so the file always reconciles to the
 * on-screen boxes.
 *
 * A T4 return is filed per payroll program account, so the transmittal carries
 * ONE <T4> return per filing account, each stamped with that account's number
 * and its own <T4Summary>. Employees on no account fall back to the
 * transmitter's business number — the single-account behaviour.
 *
 * Fails closed with every problem named: missing SINs, missing employer BN,
 * missing transmitter configuration. IMPORTANT: validate the generated file
 * against the CRA's published XML schema for the filing year before
 * transmitting — element sets shift between years, and the CRA validator is
 * the authority (the UI repeats this note).
 *
 * Config: orgs.settings.payroll.t4Transmitter =
 *   { bn, transmitterNumber, name, contactName, contactEmail, contactPhone }
 */

interface TransmitterConfig {
  bn: string;
  transmitterNumber: string;
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
}

const esc = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const amt = (value: string): string => Number(value || 0).toFixed(2);

/**
 * The CRA's report-type code — the field that tells the agency what this
 * submission IS. It rides on the T619 transmittal, on every T4 slip and on
 * every T4 Summary, and all three must agree.
 *
 *   O — original.  A — amended (restated slips).  C — cancelled (slips that
 *   should never have existed).
 *
 * An amended or cancelled submission carries ONLY the slips being corrected,
 * per the CRA's own instruction not to re-send slips that did not change; the
 * accompanying summary therefore totals the slips in THAT file.
 */
export type T4ReportTypeCode = "O" | "A" | "C";

export interface BuildT4XmlOptions {
  /** Defaults to "O" — the original submission, byte-identical to before. */
  reportTypeCode?: T4ReportTypeCode;
  /**
   * Restrict the file to these slips, by the T4 population's own row key
   * (`employeePartyId:province:filingAccountId`). Used by the amendment
   * path; undefined means the whole year.
   */
  rowIds?: readonly string[];
  /**
   * File exactly these slips instead of recomputing from the subledger — the
   * CANCELLATION path, where the whole point is that the ledger no longer
   * produces them (see `returnsOfSlips`). Wins over `rowIds`.
   */
  slips?: readonly T4Slip[];
}

/** The T4 population's row key — one slip per employee, province and account. */
export const t4RowId = (slip: Pick<T4Slip, "employeePartyId" | "province" | "filingAccountId">) =>
  `${slip.employeePartyId}:${slip.province}:${slip.filingAccountId ?? ""}`;

export async function buildT4Xml(
  orgId: string,
  taxYear: number,
  options: BuildT4XmlOptions = {},
): Promise<{
  filename: string;
  xml: string;
  slipCount: number;
  /**
   * Returns this org still owes BEYOND this file, named rather than omitted.
   *
   * A Quebec employee's year-end is a T4 *and* an RL-1 (Revenu Québec). The
   * RL-1 exists as its own filing on the year-end page
   * (engine/src/payroll/canada/quebec/rl1-filing.ts) and is not part of this
   * T4 transmission, so the notice points the employer at it instead of
   * letting this file pass as "the filing" for a QC employee.
   */
  unsupportedFilings: string[];
}> {
  const cfgRow = (await db.execute<{ cfg: Partial<TransmitterConfig> | null }>(sql`
    select settings#>'{payroll,t4Transmitter}' as cfg from orgs where id = ${orgId}
  `));
  const cfg = cfgRow.rows[0]?.cfg ?? {};
  const missingCfg = (["bn", "transmitterNumber", "name", "contactName", "contactEmail", "contactPhone"] as const)
    .filter((key) => !cfg[key] || !String(cfg[key]).trim());
  if (missingCfg.length > 0) {
    throw new PayrollError(
      `T4 transmitter configuration incomplete (${missingCfg.join(", ")}) — set it under Payroll setup`,
    );
  }
  const transmitter = cfg as TransmitterConfig;

  const reportTypeCode = options.reportTypeCode ?? "O";
  const returns = options.slips
    ? await returnsOfSlips(orgId, taxYear, options.slips)
    : await scopedReturns(orgId, taxYear, options.rowIds);
  const slipCount = returns.reduce((count, ret) => count + ret.slips.length, 0);

  const sins = (await db.execute<{ employee_party_id: string; sin_encrypted: string | null }>(sql`
    select prof.employee_party_id, prof.sin_encrypted
      from employee_payroll_profiles prof
     where prof.org_id = ${orgId}
  `));
  const sinByEmployee = new Map(sins.rows.map((row) => [row.employee_party_id, row.sin_encrypted]));

  const missingSins: string[] = [];
  const withSins: T4ReturnWithSins[] = [];
  for (const ret of returns) {
    const slips: (T4Slip & { sin: string })[] = [];
    for (const slip of ret.slips) {
      const sealed = sinByEmployee.get(slip.employeePartyId);
      const sin = sealed ? unsealSecret(sealed) : null;
      if (!sin || !/^\d{9}$/.test(sin)) {
        missingSins.push(slip.employeeName);
        continue;
      }
      slips.push({ ...slip, sin });
    }
    withSins.push({ ...ret, slips });
  }
  if (missingSins.length > 0) {
    throw new PayrollError(
      `missing or invalid SIN for: ${missingSins.join(", ")} — add SINs on the employee payroll profiles`,
    );
  }

  const quebec = withSins
    .flatMap((ret) => ret.slips)
    .filter((slip) => slip.isQuebec)
    .map((slip) => slip.employeeName);

  const suffix = reportTypeCode === "O" ? "" : reportTypeCode === "A" ? "-amended" : "-cancelled";
  return {
    filename: `T4-${taxYear}${suffix}.xml`,
    xml: renderT4Xml({ orgId, taxYear, transmitter, returns: withSins, reportTypeCode }),
    slipCount,
    unsupportedFilings: quebec.length > 0
      ? [
        `${quebec.join(", ")} ${quebec.length === 1 ? "is" : "are"} employed in Quebec and also `
        + "requires an RL-1 from Revenu Québec — the T4 in this file is complete; the RL-1 "
        + "is its own filing on the payroll year-end page and is transmitted to Revenu "
        + "Québec separately, never inside this CRA file",
      ]
      : [],
  };
}

/**
 * The year's returns, optionally narrowed to named slips.
 *
 * An AMENDED submission carries only the slips being restated, per the CRA's
 * instruction not to re-send slips that did not change, and each account's
 * summary is restated over the slips this file actually contains (employer
 * CPP/EI included, scoped to the same employees) so the return reconciles to
 * itself rather than to a year it is not reporting.
 */
async function scopedReturns(
  orgId: string,
  taxYear: number,
  rowIds: readonly string[] | undefined,
): Promise<T4Return[]> {
  const all = await t4Returns(orgId, taxYear);
  if (all.length === 0) throw new PayrollError(`no committed Canadian stubs for ${taxYear}`);
  if (!rowIds) return all;
  const wanted = new Set(rowIds);
  const scoped: T4Return[] = [];
  for (const ret of all) {
    const slips = ret.slips.filter((slip) => wanted.has(t4RowId(slip)));
    if (slips.length === 0) continue;
    scoped.push({
      ...ret,
      slips,
      summary: await t4Summary(
        orgId, taxYear, ret.filingAccount.id, slips.map((slip) => slip.employeePartyId),
      ),
    });
  }
  if (scoped.length === 0) {
    throw new PayrollError(
      `none of the requested slips exist on the ${taxYear} T4 return — nothing to file`,
    );
  }
  return scoped;
}

/**
 * Returns assembled from slips the CALLER supplies rather than from the
 * ledger — the cancellation path.
 *
 * A cancelled slip is the CRA being told that this exact slip should never
 * have existed, and its instruction is that a cancelled slip carries the SAME
 * information as the original. That information cannot come from a
 * recomputation: the usual reason a slip is cancelled is that the data behind
 * it is gone (a voided run, an employee moved to another entity), so
 * recomputing would either produce nothing or produce different figures from
 * the ones the agency holds. The slips therefore come from the issued
 * snapshot, and the summary totals THOSE slips.
 *
 * Employer CPP/EI is the one figure a slip does not carry, so it is read from
 * the subledger for the same employees. Where the underlying run was voided it
 * reads nil — which is exactly what the employer is declaring.
 */
async function returnsOfSlips(
  orgId: string,
  taxYear: number,
  slips: readonly T4Slip[],
): Promise<T4Return[]> {
  if (slips.length === 0) throw new PayrollError("no slips were named — nothing to file");
  const accounts = await filingAccountsById(orgId);
  const accountIds = [...new Set(slips.map((slip) => slip.filingAccountId))];
  const returns: T4Return[] = [];
  for (const accountId of accountIds) {
    const own = slips.filter((slip) => slip.filingAccountId === accountId);
    const ledger = await t4Summary(
      orgId, taxYear, accountId, own.map((slip) => slip.employeePartyId),
    );
    const total = (pick: (slip: T4Slip) => string) =>
      own.reduce((acc, slip) => add(acc, pick(slip)), "0");
    returns.push({
      filingAccount: filingAccountRef(accountId, accounts),
      slips: [...own],
      summary: {
        ...ledger,
        slips: own.length,
        employmentIncome: total((slip) => slip.box14EmploymentIncome),
        employeeCpp: total((slip) => slip.box16Cpp),
        employeeCpp2: total((slip) => slip.box16aCpp2),
        employeeEi: total((slip) => slip.box18Ei),
        incomeTax: total((slip) => slip.box22IncomeTax),
      },
    });
  }
  return returns.sort((a, b) =>
    (a.filingAccount.accountNumber ?? "").localeCompare(b.filingAccount.accountNumber ?? ""));
}

/**
 * Rebuild the T4 slip an issued snapshot reported.
 *
 * The inverse of the CA pack's own slip declaration
 * (engine/src/payroll/canada/filings.ts), keyed on the CRA's box NUMBERS —
 * the only stable vocabulary the two sides share. `t4-amendment` round-trips
 * a real slip through both directions and asserts equality, so the two cannot
 * drift apart silently.
 *
 * `rowId` is the population's own key and carries the employee, the province
 * of employment and the filing account, so none of the three is parsed back
 * out of a printed header label.
 */
export function t4SlipFromReported(
  reported: { fields: readonly { code: string | null; label: string; value: string }[] },
  rowId: string,
): T4Slip {
  const [employeePartyId, province, accountId] = rowId.split(":");
  if (!employeePartyId || province == null) {
    throw new PayrollError(`"${rowId}" is not a T4 slip row key`);
  }
  const box = (code: string): string =>
    reported.fields.find((field) => field.code === code)?.value ?? "0";
  const header = (label: string): string =>
    reported.fields.find((field) => field.code == null && field.label === label)?.value ?? "";
  const isQuebec = province === "QC";
  return {
    employeePartyId,
    employeeName: header("Employee's name"),
    province,
    isQuebec,
    filingAccountId: accountId ? accountId : null,
    box14EmploymentIncome: box("14"),
    // Québec employment reports the same contribution in boxes 17/17A.
    box16Cpp: box(isQuebec ? "17" : "16"),
    box16aCpp2: box(isQuebec ? "17A" : "16A"),
    box18Ei: box("18"),
    box22IncomeTax: box("22"),
    box24EiInsurable: box("24"),
    box26CppPensionable: box("26"),
    box44UnionDues: box("44"),
    box55Qpip: box("55"),
    box56QpipInsurable: box("56"),
    // Not a T4 box — a provenance count the transmittal never prints.
    stubCount: 0,
  };
}

/** A T4 return whose slips carry the unsealed SIN the file has to print. */
export interface T4ReturnWithSins {
  filingAccount: FilingAccountRef;
  slips: (T4Slip & { sin: string })[];
  summary: T4SummaryTotals;
}

/**
 * The transmittal document itself — pure, so the file's shape is verifiable
 * without a database: one <T4> return per filing account, each stamped with
 * that account's business number and its own <T4Summary>.
 */
export function renderT4Xml(input: {
  orgId: string;
  taxYear: number;
  transmitter: TransmitterConfig;
  returns: T4ReturnWithSins[];
  /** O original (default) | A amended | C cancelled — see T4ReportTypeCode. */
  reportTypeCode?: T4ReportTypeCode;
}): string {
  const { orgId, taxYear, transmitter, returns } = input;
  const rpt = input.reportTypeCode ?? "O";
  const returnXml: string[] = [];
  for (const ret of returns) {
    // The account's own number is the employer BN on its slips and summary;
    // unassigned employees file under the transmitter's business number.
    const bn = ret.filingAccount.accountNumber ?? transmitter.bn;
    const slipXml: string[] = [];
    for (const slip of ret.slips) {
      const sin = slip.sin;
      const [surname, ...given] = splitName(slip.employeeName);
      // Quebec files the SAME contribution in a DIFFERENT box. Box 16 is CPP
      // and box 17 is QPP, and they are mutually exclusive on a slip: a QC
      // employee contributes to the Québec Pension Plan, so reporting their
      // contribution in <CPP_CNTRB_AMT> tells the CRA they paid into a plan
      // they are not in — and the employee's QPP record, which Retraite
      // Québec keeps, has a hole in it. The slip has carried `isQuebec` and
      // `box55Qpip` all along and this builder used neither.
      const pension = slip.isQuebec
        ? `   <QPP_CNTRB_AMT>${amt(slip.box16Cpp)}</QPP_CNTRB_AMT>\n`
        : `   <CPP_CNTRB_AMT>${amt(slip.box16Cpp)}</CPP_CNTRB_AMT>\n`;
      // Boxes 55/56 — QPIP premiums and the earnings they were assessed on.
      // Quebec-only, and simply absent from the file for everyone else rather
      // than reported as a zero the CRA would have to interpret.
      const qpip = slip.isQuebec
        ? `   <PPIP_AMT>${amt(slip.box55Qpip)}</PPIP_AMT>\n`
          + `   <PPIP_ERN_AMT>${amt(slip.box56QpipInsurable)}</PPIP_ERN_AMT>\n`
        : "";
      slipXml.push(
        `  <T4Slip>\n` +
        `   <EMPE_NM><snm>${esc(surname)}</snm><gvn_nm>${esc(given.join(" ") || surname)}</gvn_nm></EMPE_NM>\n` +
        `   <SIN>${sin}</SIN>\n` +
        `   <BN>${esc(bn)}</BN>\n` +
        `   <EMPT_PROV_CD>${esc(slip.province)}</EMPT_PROV_CD>\n` +
        `   <RPT_TCD>${rpt}</RPT_TCD>\n` +
        `   <EMPT_INC_AMT>${amt(slip.box14EmploymentIncome)}</EMPT_INC_AMT>\n` +
        pension +
        `   <EMPE_CPP2_AMT>${amt(slip.box16aCpp2)}</EMPE_CPP2_AMT>\n` +
        `   <EIP_AMT>${amt(slip.box18Ei)}</EIP_AMT>\n` +
        `   <ITX_DDCT_AMT>${amt(slip.box22IncomeTax)}</ITX_DDCT_AMT>\n` +
        `   <EI_INSU_ERN_AMT>${amt(slip.box24EiInsurable)}</EI_INSU_ERN_AMT>\n` +
        `   <CPP_QPP_ERN_AMT>${amt(slip.box26CppPensionable)}</CPP_QPP_ERN_AMT>\n` +
        qpip +
        `   <UNN_DUES_AMT>${amt(slip.box44UnionDues)}</UNN_DUES_AMT>\n` +
        `  </T4Slip>`,
      );
    }
    returnXml.push(
      ` <T4>\n` +
      slipXml.join("\n") + "\n" +
      `  <T4Summary>\n` +
      `   <bn>${esc(bn)}</bn>\n` +
      `   <tx_yr>${taxYear}</tx_yr>\n` +
      `   <slp_cnt>${ret.slips.length}</slp_cnt>\n` +
      `   <RPT_TCD>${rpt}</RPT_TCD>\n` +
      `   <TOT_EMPT_INC_AMT>${amt(ret.summary.employmentIncome)}</TOT_EMPT_INC_AMT>\n` +
      `   <TOT_EMPE_CPP_AMT>${amt(ret.summary.employeeCpp)}</TOT_EMPE_CPP_AMT>\n` +
      `   <TOT_EMPE_CPP2_AMT>${amt(ret.summary.employeeCpp2)}</TOT_EMPE_CPP2_AMT>\n` +
      `   <TOT_EMPR_CPP_AMT>${amt(ret.summary.employerCpp)}</TOT_EMPR_CPP_AMT>\n` +
      `   <TOT_EMPE_EIP_AMT>${amt(ret.summary.employeeEi)}</TOT_EMPE_EIP_AMT>\n` +
      `   <TOT_EMPR_EIP_AMT>${amt(ret.summary.employerEi)}</TOT_EMPR_EIP_AMT>\n` +
      `   <TOT_ITX_DDCT_AMT>${amt(ret.summary.incomeTax)}</TOT_ITX_DDCT_AMT>\n` +
      `  </T4Summary>\n` +
      ` </T4>`,
    );
  }
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Submission xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n` +
    ` <T619>\n` +
    `  <sbmt_ref_id>T4-${taxYear}${rpt === "O" ? "" : `-${rpt}`}-${orgId.slice(0, 8)}</sbmt_ref_id>\n` +
    `  <rpt_tcd>${rpt}</rpt_tcd>\n` +
    `  <trnmtr_nbr>${esc(transmitter.transmitterNumber)}</trnmtr_nbr>\n` +
    `  <trnmtr_tcd>1</trnmtr_tcd>\n` +
    `  <summ_cnt>${returns.length}</summ_cnt>\n` +
    `  <lang_cd>E</lang_cd>\n` +
    `  <TRNMTR_NM><l1_nm>${esc(transmitter.name)}</l1_nm></TRNMTR_NM>\n` +
    `  <CNTC><cntc_nm>${esc(transmitter.contactName)}</cntc_nm>` +
    `<cntc_area_cd></cntc_area_cd><cntc_phn_nbr>${esc(transmitter.contactPhone)}</cntc_phn_nbr>` +
    `<cntc_email_area>${esc(transmitter.contactEmail)}</cntc_email_area></CNTC>\n` +
    ` </T619>\n` +
    ` <Return>\n` +
    returnXml.join("\n") + "\n" +
    ` </Return>\n` +
    `</Submission>\n`;

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
