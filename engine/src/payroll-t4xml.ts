import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { unsealSecret } from "./secrets.ts";
import { PayrollError } from "./payroll-run.ts";
import { t4Slips, t4Summary } from "./payroll-yearend.ts";

/**
 * CRA T4 Internet File Transfer XML — the T619 electronic transmittal
 * wrapping the T4 return (slips + summary), built from the same committed-
 * stub data as the year-end worksheets so the file always reconciles to the
 * on-screen boxes.
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

  const [slips, summary] = await Promise.all([t4Slips(orgId, taxYear), t4Summary(orgId, taxYear)]);
  if (slips.length === 0) throw new PayrollError(`no committed Canadian stubs for ${taxYear}`);

  const sins = (await db.execute(sql`
    select prof.employee_party_id, prof.sin_encrypted
      from employee_payroll_profiles prof
     where prof.org_id = ${orgId}
  `)) as unknown as { rows: { employee_party_id: string; sin_encrypted: string | null }[] };
  const sinByEmployee = new Map(sins.rows.map((row) => [row.employee_party_id, row.sin_encrypted]));

  const missingSins: string[] = [];
  const slipXml: string[] = [];
  for (const slip of slips) {
    const sealed = sinByEmployee.get(slip.employeePartyId);
    const sin = sealed ? unsealSecret(sealed) : null;
    if (!sin || !/^\d{9}$/.test(sin)) {
      missingSins.push(slip.employeeName);
      continue;
    }
    const [surname, ...given] = splitName(slip.employeeName);
    slipXml.push(
      `  <T4Slip>\n` +
      `   <EMPE_NM><snm>${esc(surname)}</snm><gvn_nm>${esc(given.join(" ") || surname)}</gvn_nm></EMPE_NM>\n` +
      `   <SIN>${sin}</SIN>\n` +
      `   <BN>${esc(transmitter.bn)}</BN>\n` +
      `   <EMPT_PROV_CD>${esc(slip.province)}</EMPT_PROV_CD>\n` +
      `   <RPT_TCD>O</RPT_TCD>\n` +
      `   <EMPT_INC_AMT>${amt(slip.box14EmploymentIncome)}</EMPT_INC_AMT>\n` +
      `   <CPP_CNTRB_AMT>${amt(slip.box16Cpp)}</CPP_CNTRB_AMT>\n` +
      `   <EMPE_CPP2_AMT>${amt(slip.box16aCpp2)}</EMPE_CPP2_AMT>\n` +
      `   <EIP_AMT>${amt(slip.box18Ei)}</EIP_AMT>\n` +
      `   <ITX_DDCT_AMT>${amt(slip.box22IncomeTax)}</ITX_DDCT_AMT>\n` +
      `   <EI_INSU_ERN_AMT>${amt(slip.box24EiInsurable)}</EI_INSU_ERN_AMT>\n` +
      `   <CPP_QPP_ERN_AMT>${amt(slip.box26CppPensionable)}</CPP_QPP_ERN_AMT>\n` +
      `   <UNN_DUES_AMT>${amt(slip.box44UnionDues)}</UNN_DUES_AMT>\n` +
      `  </T4Slip>`,
    );
  }
  if (missingSins.length > 0) {
    throw new PayrollError(
      `missing or invalid SIN for: ${missingSins.join(", ")} — add SINs on the employee payroll profiles`,
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
    `  <summ_cnt>1</summ_cnt>\n` +
    `  <lang_cd>E</lang_cd>\n` +
    `  <TRNMTR_NM><l1_nm>${esc(transmitter.name)}</l1_nm></TRNMTR_NM>\n` +
    `  <CNTC><cntc_nm>${esc(transmitter.contactName)}</cntc_nm>` +
    `<cntc_area_cd></cntc_area_cd><cntc_phn_nbr>${esc(transmitter.contactPhone)}</cntc_phn_nbr>` +
    `<cntc_email_area>${esc(transmitter.contactEmail)}</cntc_email_area></CNTC>\n` +
    ` </T619>\n` +
    ` <Return>\n` +
    ` <T4>\n` +
    slipXml.join("\n") + "\n" +
    `  <T4Summary>\n` +
    `   <bn>${esc(transmitter.bn)}</bn>\n` +
    `   <tx_yr>${taxYear}</tx_yr>\n` +
    `   <slp_cnt>${slips.length}</slp_cnt>\n` +
    `   <RPT_TCD>O</RPT_TCD>\n` +
    `   <TOT_EMPT_INC_AMT>${amt(summary.employmentIncome)}</TOT_EMPT_INC_AMT>\n` +
    `   <TOT_EMPE_CPP_AMT>${amt(summary.employeeCpp)}</TOT_EMPE_CPP_AMT>\n` +
    `   <TOT_EMPE_CPP2_AMT>${amt(summary.employeeCpp2)}</TOT_EMPE_CPP2_AMT>\n` +
    `   <TOT_EMPR_CPP_AMT>${amt(summary.employerCpp)}</TOT_EMPR_CPP_AMT>\n` +
    `   <TOT_EMPE_EIP_AMT>${amt(summary.employeeEi)}</TOT_EMPE_EIP_AMT>\n` +
    `   <TOT_EMPR_EIP_AMT>${amt(summary.employerEi)}</TOT_EMPR_EIP_AMT>\n` +
    `   <TOT_ITX_DDCT_AMT>${amt(summary.incomeTax)}</TOT_ITX_DDCT_AMT>\n` +
    `  </T4Summary>\n` +
    ` </T4>\n` +
    ` </Return>\n` +
    `</Submission>\n`;

  return { filename: `T4-${taxYear}.xml`, xml, slipCount: slips.length };
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
