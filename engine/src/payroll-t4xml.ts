import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { unsealSecret } from "./secrets.ts";
import { PayrollError } from "./payroll-run.ts";
import type { FilingAccountRef } from "./payroll-filing.ts";
import { t4Returns, type T4Slip, type T4SummaryTotals } from "./payroll-yearend.ts";

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

export async function buildT4Xml(orgId: string, taxYear: number): Promise<{
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
  const cfgRow = (await db.execute(sql`
    select settings#>'{payroll,t4Transmitter}' as cfg from orgs where id = ${orgId}
  `)) as unknown as { rows: { cfg: Partial<TransmitterConfig> | null }[] };
  const cfg = cfgRow.rows[0]?.cfg ?? {};
  const missingCfg = (["bn", "transmitterNumber", "name", "contactName", "contactEmail", "contactPhone"] as const)
    .filter((key) => !cfg[key] || !String(cfg[key]).trim());
  if (missingCfg.length > 0) {
    throw new PayrollError(
      `T4 transmitter configuration incomplete (${missingCfg.join(", ")}) — set it under Payroll setup`,
    );
  }
  const transmitter = cfg as TransmitterConfig;

  const returns = await t4Returns(orgId, taxYear);
  if (returns.length === 0) throw new PayrollError(`no committed Canadian stubs for ${taxYear}`);
  const slipCount = returns.reduce((count, ret) => count + ret.slips.length, 0);

  const sins = (await db.execute(sql`
    select prof.employee_party_id, prof.sin_encrypted
      from employee_payroll_profiles prof
     where prof.org_id = ${orgId}
  `)) as unknown as { rows: { employee_party_id: string; sin_encrypted: string | null }[] };
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

  return {
    filename: `T4-${taxYear}.xml`,
    xml: renderT4Xml({ orgId, taxYear, transmitter, returns: withSins }),
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
}): string {
  const { orgId, taxYear, transmitter, returns } = input;
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
        `   <RPT_TCD>O</RPT_TCD>\n` +
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
      `   <RPT_TCD>O</RPT_TCD>\n` +
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
    `  <sbmt_ref_id>T4-${taxYear}-${orgId.slice(0, 8)}</sbmt_ref_id>\n` +
    `  <rpt_tcd>O</rpt_tcd>\n` +
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
