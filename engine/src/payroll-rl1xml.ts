import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { unsealSecret } from "./secrets.ts";
import { PayrollError } from "./payroll-error.ts";
import { rl1Slips, type Rl1Slip } from "./payroll-rl1.ts";

/**
 * RL-1 electronic transmission — the Revenu Québec side of what
 * payroll-t4xml.ts is for the CRA: fail-closed validation of the tenant's
 * transmitter identity and of the slip data, plus the publicly documented
 * transmission mechanics (file naming, transmitter/certification/slip-number
 * requirements).
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: render the XML itself.
 *
 * The tag-level RL-1 XML specification — the per-box balises of the R record,
 * the preparer record, the T totals record, the year's schema version and the
 * check-digit algorithm for slip sequential numbers — is distributed by
 * Revenu Québec only to registered partners ("Guide de préparation du
 * relevé 1 en format XML" and guide IN-800, Programmation et transmission des
 * fichiers de relevés; the XSDs sit behind the partner-space login, and the
 * per-year software certification number RQ-YY-NN-NNN is issued on
 * certification). None of it is publicly published, and the tag set moves
 * year to year (box B.B split arrived in 2024). Emitting a file from a
 * guessed or outdated tag set would produce an untransmittable — or worse, a
 * silently wrong — statutory filing, so `buildRl1Xml` validates everything
 * that IS establishable and then refuses by name. A refusal is honest; a
 * plausible reconstruction of a filing format is not.
 *
 * Publicly established facts implemented here (revenuquebec.ca, "Sending RL
 * Slips and Summaries Online" / "Transmission de relevés … par Internet", and
 * form ED-430-V):
 *   - transmitter number: "NP" + six digits, obtained with form ED-430-V;
 *   - a certification number is required for the filing year's software;
 *   - the employer transmits under a 10-digit RQ identification number;
 *   - each slip carries a nine-digit sequential number — eight digits
 *     assigned by RQ, the ninth a check digit the software computes (the
 *     algorithm is in the partner-gated IN-800, so the range is validated
 *     here and the digit is not invented);
 *   - the classic file name is AAPPPPPPSSS.xml (2-digit year, the 6 digits
 *     of the transmitter number, 3-digit chronological file number), and RQ
 *     requires the name under 30 characters;
 *   - more than 5 RL-1 slips MUST be transmitted electronically.
 *
 * Config: orgs.settings.payroll.rl1Transmitter =
 *   { transmitterNumber, certificationNumber, identificationNumber,
 *     fileSequence, name, contactName, contactPhone, contactEmail,
 *     slipRangeStart?, slipRangeEnd? }
 * — all tenant-entered, never invented.
 */

export interface Rl1TransmitterConfig {
  /** "NP" + 6 digits (ED-430-V registration). */
  transmitterNumber: string;
  /** The filing year's software certification number from Revenu Québec. */
  certificationNumber: string;
  /** The employer's 10-digit Revenu Québec identification number. */
  identificationNumber: string;
  /** Chronological file number for the year (the SSS of AAPPPPPPSSS.xml). */
  fileSequence: number;
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  /** First/last of the 8-digit sequential-number series RQ assigned. */
  slipRangeStart?: string;
  slipRangeEnd?: string;
}

/**
 * Validate the transmitter configuration — pure, every problem named, so the
 * setup screen and the build path agree on what "ready" means.
 */
export function rl1TransmitterProblems(cfg: Partial<Rl1TransmitterConfig>): string[] {
  const problems: string[] = [];
  if (!cfg.transmitterNumber || !/^NP\d{6}$/.test(cfg.transmitterNumber)) {
    problems.push(
      "transmitterNumber must be \"NP\" followed by six digits (register with form ED-430-V)",
    );
  }
  if (!cfg.certificationNumber || !String(cfg.certificationNumber).trim()) {
    problems.push("certificationNumber for the filing year is required");
  }
  if (!cfg.identificationNumber || !/^\d{10}$/.test(cfg.identificationNumber)) {
    problems.push("identificationNumber must be the employer's 10-digit Revenu Québec number");
  }
  if (
    cfg.fileSequence === undefined
    || !Number.isInteger(cfg.fileSequence)
    || cfg.fileSequence < 1 || cfg.fileSequence > 999
  ) {
    problems.push("fileSequence must be an integer from 1 to 999");
  }
  for (const key of ["name", "contactName", "contactEmail", "contactPhone"] as const) {
    if (!cfg[key] || !String(cfg[key]).trim()) problems.push(`${key} is required`);
  }
  const start = cfg.slipRangeStart;
  const end = cfg.slipRangeEnd;
  if ((start || end) && !(start && end)) {
    problems.push("slipRangeStart and slipRangeEnd must be provided together");
  }
  if (start && !/^\d{8}$/.test(start)) {
    problems.push("slipRangeStart must be the 8-digit first number of the series RQ assigned");
  }
  if (end && !/^\d{8}$/.test(end)) {
    problems.push("slipRangeEnd must be the 8-digit last number of the series RQ assigned");
  }
  if (start && end && /^\d{8}$/.test(start) && /^\d{8}$/.test(end)
    && Number(end) < Number(start)) {
    problems.push("slipRangeEnd must not be lower than slipRangeStart");
  }
  return problems;
}

/** Load and validate the tenant's transmitter identity — fail-closed. */
export async function rl1TransmitterConfig(orgId: string): Promise<Rl1TransmitterConfig> {
  const row = (await db.execute(sql`
    select settings#>'{payroll,rl1Transmitter}' as cfg from orgs where id = ${orgId}
  `)) as unknown as { rows: { cfg: Partial<Rl1TransmitterConfig> | null }[] };
  const cfg = row.rows[0]?.cfg ?? {};
  const problems = rl1TransmitterProblems(cfg);
  if (problems.length > 0) {
    throw new PayrollError(
      `RL-1 transmitter configuration incomplete (${problems.join("; ")}) — `
      + "set it under Payroll setup",
    );
  }
  return cfg as Rl1TransmitterConfig;
}

/**
 * The classic RQ transmission file name: AAPPPPPPSSS.xml — the tax year's
 * last two digits, the six digits of the transmitter number, and the 3-digit
 * chronological file number (e.g. 2026 + NP123456 + file 1 →
 * "26123456001.xml"). RQ requires the transmitted name under 30 characters;
 * this convention is 15.
 */
export function rl1XmlFilename(
  taxYear: number,
  transmitterNumber: string,
  fileSequence: number,
): string {
  if (!/^NP\d{6}$/.test(transmitterNumber)) {
    throw new PayrollError(`invalid RL-1 transmitter number "${transmitterNumber}"`);
  }
  if (!Number.isInteger(fileSequence) || fileSequence < 1 || fileSequence > 999) {
    throw new PayrollError(`invalid RL-1 file sequence ${fileSequence} — must be 1..999`);
  }
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2099) {
    throw new PayrollError(`invalid RL-1 tax year ${taxYear}`);
  }
  const yy = String(taxYear % 100).padStart(2, "0");
  const seq = String(fileSequence).padStart(3, "0");
  const name = `${yy}${transmitterNumber.slice(2)}${seq}.xml`;
  if (name.length >= 30) throw new PayrollError("RL-1 file name must be under 30 characters");
  return name;
}

/**
 * Why no downloadable file exists — the registry's `downloadRefusal` string,
 * shown wherever the T4's download button would be.
 */
export const RL1_XML_DOWNLOAD_REFUSAL =
  "The RL-1 XML transmission file is not generated: Revenu Québec distributes the "
  + "tag-level XML specification, the year's schema, and the slip-number check-digit "
  + "algorithm only to registered software partners (Guide de préparation du relevé 1 "
  + "en format XML; guide IN-800), so a generated file could not be validated against "
  + "the real schema and might misstate a statutory filing. The RL-1 slip data above "
  + "is complete — file it through Revenu Québec's online services (mandatory when "
  + "more than 5 slips) or authorized software until the partner specification is "
  + "obtained and the serializer in engine/src/payroll-rl1xml.ts is completed.";

/** A slip carrying the unsealed SIN the eventual file must print. */
export type Rl1SlipWithSin = Rl1Slip & { sin: string };

/**
 * Validate everything an RL-1 transmission needs — transmitter identity,
 * slip population, SINs, and (when configured) that the assigned sequential-
 * number series is large enough for the year's slips — then refuse the render
 * by name. When the partner specification is obtained, the serializer slots
 * in AFTER this validation and nothing before it changes.
 */
export async function buildRl1Xml(orgId: string, taxYear: number): Promise<never> {
  const cfg = await rl1TransmitterConfig(orgId);

  const slips = await rl1Slips(orgId, taxYear);
  if (slips.length === 0) {
    throw new PayrollError(`no committed Québec pay stubs for ${taxYear}`);
  }

  // SINs, unsealed and format-checked — identical failure mode to the T4.
  const sins = (await db.execute(sql`
    select prof.employee_party_id, prof.sin_encrypted
      from employee_payroll_profiles prof
     where prof.org_id = ${orgId}
  `)) as unknown as { rows: { employee_party_id: string; sin_encrypted: string | null }[] };
  const sinByEmployee = new Map(sins.rows.map((row) => [row.employee_party_id, row.sin_encrypted]));
  const missingSins: string[] = [];
  for (const slip of slips) {
    const sealed = sinByEmployee.get(slip.employeePartyId);
    const sin = sealed ? unsealSecret(sealed) : null;
    if (!sin || !/^\d{9}$/.test(sin)) missingSins.push(slip.employeeName);
  }
  if (missingSins.length > 0) {
    throw new PayrollError(
      `missing or invalid SIN for: ${missingSins.join(", ")} — add SINs on the employee payroll profiles`,
    );
  }

  // Every slip in the file needs a sequential number from the RQ-assigned
  // series; a series smaller than the population is a real refusal today,
  // not a problem deferred to the serializer.
  if (cfg.slipRangeStart && cfg.slipRangeEnd) {
    const capacity = Number(cfg.slipRangeEnd) - Number(cfg.slipRangeStart) + 1;
    if (capacity < slips.length) {
      throw new PayrollError(
        `the assigned RL-1 sequential-number series (${cfg.slipRangeStart}–${cfg.slipRangeEnd}) `
        + `holds ${capacity} numbers but ${slips.length} slips must be filed — `
        + "request a larger series from Revenu Québec",
      );
    }
  }

  throw new PayrollError(RL1_XML_DOWNLOAD_REFUSAL);
}
