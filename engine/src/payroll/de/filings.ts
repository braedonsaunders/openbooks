import { sql, type SQL } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { add } from "../../money/money.ts";
import { PayrollError } from "../error.ts";
import { PayrollPackError } from "../payroll-error.ts";
import { assertPayrollCountryKnown } from "../country.ts";
import {
  assertPayrollFilingAccountKnown,
  filingAccountsById,
  filingAccountRef,
} from "../filing.ts";
import {
  payrollCertificate,
  resolveCertificate,
} from "../certificates.ts";
import { storedTaxCertificates } from "../run-calculation-support.ts";
import type {
  PayrollFilingData,
  PayrollFilingRowScope,
  PayrollFilingSlipData,
  PayrollYearEndFiling,
} from "../filing-registry.ts";
import { DE_TAX_YEARS } from "./rates.ts";

/**
 * The DE pack's year-end filing: the Ausdruck der elektronischen
 * Lohnsteuerbescheinigung — the employee's printout of the data transmitted
 * to the Finanzamt.
 *
 * The two-sided shape, stated once so no reader confuses the halves: under
 * EStG §41b the employer transmits the Elektronische Lohnsteuerbescheinigung
 * to the Finanzamt via ELSTER (the submission Datensatz — OUT OF SCOPE, the
 * downloadRefusal below names it), and what the employee is owed is the
 * Ausdruck, the printout of the transmitted data. This filing IS the
 * printout: every figure certifies what the year's committed pay runs
 * actually withheld, never a recomputation.
 *
 * Line set provenance (rate tables and form layouts publish separately, and
 * only the form proves its own boxes): the Zeilen below are transcribed from
 * the authority's own "Ausdruck der elektronischen Lohnsteuerbescheinigung
 * für 2026" (BMF, Anlage LStH 2026 Anhang 23 — footer version 6.25). The
 * procedure it prints under is the BMF-Schreiben vom 5.9.2024
 * (IV C 5-S 2378/19/10002:002, BStBl 2024 I S. 1255), which governs the
 * Ausstellung der elektronischen Lohnsteuerbescheinigung for calendar years
 * from 2025. Correction travels the same channel: a transmitted certificate
 * is corrected by retransmitting it flagged as amended (als geändert
 * gekennzeichnet, EStG §41c Satz 5 — §41b Abs. 1 gilt entsprechend).
 *
 * What is certified versus computed: Zeilen 4/5/6 and the SV shares are the
 * withheld sums off the committed stub lines; Steuerklasse, Faktor,
 * Kinderfreibeträge, Freibetrag/Hinzurechnungsbetrag and Konfession are the
 * ELStAM Merkmale in force for the last Lohnzahlungszeitraum (per-employee
 * declared facts, read through resolveCertificate, never derived).
 * Kirchensteuer is whatever was withheld at the Land's own 8%/9% split —
 * never a national default. The IdNr has no payroll column (see the gap
 * below): it travels on the ELSTER transmission, not on this printout.
 *
 * Lazy-cycle note (the caPackFilings pattern): this module is reached from
 * the pack declaration and reaches the builders, which reach the pack
 * registry — so everything is only dereferenced at call time, never during
 * module evaluation.
 */

const num = (value: unknown): string => (value == null ? "0" : String(value));

/**
 * The row-id UUID shape, owned locally (the canada/filings.ts UUID_RE
 * precedent) rather than imported from filing-registry.ts: that module
 * imports packs.ts at evaluation time, and a pack-tree module that reaches
 * it would put its own pack object mid-flight when packs.ts evaluates
 * PAYROLL_COUNTRY_PACKS — `Cannot access 'DE_PAYROLL_PACK' before
 * initialization` for any entry starting at de/pack.ts.
 */
const ROW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The only year whose Ausdruck layout the authority has published. */
export const LOHNSTEUERBESCHEINIGUNG_FORM_YEAR = 2026;

/**
 * Refuse any year but the published Ausdruck year, by name. Rate tables and
 * form layouts have separate publication calendars: computing 2026 money is
 * not permission to print it on another year's box layout.
 */
export function assertLohnsteuerbescheinigungYear(taxYear: number): void {
  const published = DE_TAX_YEARS.editions.some(
    (edition) => edition.year === taxYear && edition.status === "published",
  );
  if (!published) {
    throw new PayrollPackError(
      `DE Lohnsteuerbescheinigung: no published Ausdruck der elektronischen `
      + `Lohnsteuerbescheinigung for tax year ${taxYear} — 2026 is the only published edition `
      + `(BMF Programmablaufplan für den Lohnsteuerabzug 2026, BMF-Schreiben vom 12.11.2025; `
      + `Ausdruck der elektronischen Lohnsteuerbescheinigung für 2026). Rate tables and form `
      + `layouts publish separately: filing a prior year's box layout against current money is `
      + `refused. Transcribe the ${taxYear} Ausdruck layout before issuing.`,
    );
  }
}

/**
 * The Ausdruck row grammar, as the inverse of the population's bare
 * employee-id rowKey. Owned HERE, beside the builder — the
 * subsidiary-scope guard parses through the declaration, never its own copy
 * of this shape. One row per employee: the certificate is IdNr-keyed, not
 * account-keyed.
 */
export function parseLohnsteuerbescheinigungRowId(rowId: string): PayrollFilingRowScope | null {
  if (!ROW_UUID_RE.test(rowId)) return null;
  return { employees: [rowId], accounts: [] };
}

const AUSDRUCK_2026 =
  "Ausdruck der elektronischen Lohnsteuerbescheinigung für 2026 "
  + "(BMF, Anlage LStH 2026 Anhang 23)";

/** Every box the slip prints → the Ausdruck Zeile it comes from. */
export const LOHNSTEUERBESCHEINIGUNG_CITATIONS: Record<string, { zeile: string; label: string; source: string }> = {
  "3": { zeile: "Zeile 3", label: "Bruttoarbeitslohn einschl. Sachbezüge", source: `${AUSDRUCK_2026}, Zeile 3` },
  "4": { zeile: "Zeile 4", label: "Einbehaltene Lohnsteuer von 3.", source: `${AUSDRUCK_2026}, Zeile 4` },
  "5": { zeile: "Zeile 5", label: "Einbehaltener Solidaritätszuschlag von 3.", source: `${AUSDRUCK_2026}, Zeile 5` },
  "6": { zeile: "Zeile 6", label: "Einbehaltene Kirchensteuer des Arbeitnehmers von 3.", source: `${AUSDRUCK_2026}, Zeile 6` },
  "22a": { zeile: "Zeile 22a", label: "Arbeitgeberanteil zur gesetzlichen Rentenversicherung", source: `${AUSDRUCK_2026}, Zeile 22a` },
  "23a": { zeile: "Zeile 23a", label: "Arbeitnehmeranteil zur gesetzlichen Rentenversicherung", source: `${AUSDRUCK_2026}, Zeile 23a` },
  "24a": { zeile: "Zeile 24a", label: "Steuerfreie Arbeitgeberzuschüsse zur gesetzlichen Krankenversicherung", source: `${AUSDRUCK_2026}, Zeile 24a` },
  "24c": { zeile: "Zeile 24c", label: "Steuerfreie Arbeitgeberzuschüsse zur gesetzlichen Pflegeversicherung", source: `${AUSDRUCK_2026}, Zeile 24c` },
  "25": { zeile: "Zeile 25", label: "Arbeitnehmerbeiträge zur gesetzlichen Krankenversicherung", source: `${AUSDRUCK_2026}, Zeile 25` },
  "26": { zeile: "Zeile 26", label: "Arbeitnehmerbeiträge zur sozialen Pflegeversicherung", source: `${AUSDRUCK_2026}, Zeile 26` },
  "27": { zeile: "Zeile 27", label: "Arbeitnehmerbeiträge zur Arbeitslosenversicherung", source: `${AUSDRUCK_2026}, Zeile 27` },
};

/**
 * Ausdruck Zeilen this printout does NOT produce, named rather than printed
 * as zeros an employer might file. The slip face carries the scope note;
 * this is the declaration behind it.
 */
export const LOHNSTEUERBESCHEINIGUNG_GAPS: readonly string[] = [
  "Zeile 2 (Zeiträume ohne Anspruch auf Arbeitslohn, Anzahl U): U-Zeiten are not tracked by payroll — verify manually if the employment had unpaid gaps.",
  "Zeile 7 (Einbehaltene Kirchensteuer des Ehegatten/Lebenspartners, nur bei Konfessionsverschiedenheit): the engine withholds the employee's Kirchensteuer only (system_key kirchenlohnsteuer) — a spouse share has no stub line to certify; verify manually if Konfessionsverschiedenheit applies.",
  "Zeile 8, Zeile 9, Zeile 10 sowie Zeilen 29–32 (Versorgungsbezüge, Versorgungsfreibetrag): the 2026 engine prices laufende Bezüge only and refuses sonstige Bezüge — no Versorgungsbezug can be present; verify manually for pensioners.",
  "Zeile 15 und 15a (Progressionsvorbehalt, Kurzarbeitergeld): Lohnersatzleistungen are not modelled — verify manually if any were paid.",
  "Zeile 16, Zeilen 17–21 sowie Zeile 24b (steuerfreie Leistungen, DBA-Auslandstätigkeit, private Krankenversicherung): not modelled — verify manually if any apply.",
  "Zeile 28 und Zeile 33: left unbesetzt by the form itself — nothing is ever printed there.",
  "Zeile 34 (Freibetrag DBA Türkei): not modelled — verify manually if it applies.",
  "Steuerliche Identifikationsnummer (IdNr, header block): payroll stores no IdNr column (employee_payroll_profiles carries only the sealed CA/US sin_encrypted) — the IdNr travels on the ELSTER transmission (EStG §41b Datensatz), never as plaintext in payroll; identify the employee by IdNr when transmitting via ELSTER.",
];

export const LOHNSTEUERBESCHEINIGUNG_DOWNLOAD_REFUSAL =
  "the DE pack produces no ELSTER Lohnsteuerbescheinigung transmission (the EStG §41b electronic "
  + "certificate Datensatz) — the Ausdruck above is the complete employee statement; transmit the "
  + "certificate data to the Finanzamt through ELSTER directly";

export const LOHNSTEUERBESCHEINIGUNG_AMENDMENT_REFUSAL =
  "a wrong Lohnsteuerbescheinigung is corrected by retransmitting it flagged as amended (als geändert "
  + "gekennzeichnet, EStG §41c Satz 5 — §41b Abs. 1 gilt entsprechend) via ELSTER, which this pack does "
  + "not transmit. Correct the payroll data, re-run and commit, retransmit via ELSTER, and re-print the "
  + "Ausdruck from the corrected runs";

/** One employee's certified year, as the DB builder assembles it. */
export interface DeLohnsteuerbescheinigungSlip {
  employeePartyId: string;
  employeeName: string;
  /** Beschäftigungsland (profile province), for the header. */
  land: string;
  /** ELStAM Merkmale in force for the last Lohnzahlungszeitraum. */
  steuerklasse: string;
  /** §39f Faktor (three decimals) — set only for Steuerklasse IV Faktorverfahren. */
  faktor: string | null;
  kinderfreibetraege: string;
  freibetragJahr: string;
  hinzurechnungsbetragJahr: string;
  /** ELStAM Konfession key, or null when the employee owes no church tax. */
  konfession: string | null;
  zeitraumVon: string;
  zeitraumBis: string;
  /** "number · name" of the Betriebsstättenfinanzamt account, or null. */
  finanzamt: string | null;
  /** Zeile 3 — the year's taxable earnings lines (laufender Arbeitslohn). */
  gross: string;
  /** Zeilen 4/5/6 — what was actually withheld. */
  lst: string;
  soli: string;
  kist: string;
  /** Arbeitnehmeranteile Zeilen 23a/25/26/27. */
  rvW: string;
  kvW: string;
  pvW: string;
  avW: string;
  /** Arbeitgeberanteile Zeilen 22a/24a/24c. No Ausdruck Zeile carries the
   *  employer's Arbeitslosenversicherung share, so it is not certified here. */
  rvEr: string;
  kvEr: string;
  pvEr: string;
}

/**
 * One row as its statutory Ausdruck — pure, so the citation completeness
 * ("every printed box cites its Zeile") is verifiable without a database.
 * Amounts pass through verbatim: the slip certifies withheld sums, it does
 * not recompute them.
 */
export function lohnsteuerbescheinigungSlipData(slip: DeLohnsteuerbescheinigungSlip): PayrollFilingSlipData {
  const steuerklasseFaktor = slip.faktor != null && slip.faktor !== ""
    ? `${slip.steuerklasse} / ${slip.faktor}`
    : slip.steuerklasse;
  return {
    formCode: "DE_LSTB",
    formName: "Ausdruck der elektronischen Lohnsteuerbescheinigung",
    formNumber: "Lohnsteuerbescheinigung",
    headerFields: [
      { label: "Arbeitnehmer", value: slip.employeeName },
      { label: "Bescheinigungszeitraum (Zeile 1)", value: `${slip.zeitraumVon} – ${slip.zeitraumBis}` },
      { label: "Steuerklasse/Faktor", value: steuerklasseFaktor },
      { label: "Zahl der Kinderfreibeträge", value: slip.kinderfreibetraege },
      { label: "Steuerfreier Jahresbetrag", value: slip.freibetragJahr },
      { label: "Jahreshinzurechnungsbetrag", value: slip.hinzurechnungsbetragJahr },
      { label: "Kirchensteuermerkmale", value: slip.konfession ?? "— keine" },
      { label: "Beschäftigungsland", value: slip.land || "—" },
      { label: "Finanzamt, an das die Lohnsteuer abgeführt wurde", value: slip.finanzamt ?? "Unassigned" },
      {
        label: "Steuerliche Identifikationsnummer (IdNr)",
        value: "Not stored by payroll — identify the employee by IdNr when transmitting via ELSTER (EStG §41b)",
      },
    ],
    boxes: [
      { code: "3", label: "Bruttoarbeitslohn einschl. Sachbezüge", value: slip.gross, emphasis: true },
      { code: "4", label: "Einbehaltene Lohnsteuer von 3.", value: slip.lst },
      { code: "5", label: "Einbehaltener Solidaritätszuschlag von 3.", value: slip.soli },
      { code: "6", label: "Einbehaltene Kirchensteuer des Arbeitnehmers von 3.", value: slip.kist },
      { code: "23a", label: "Arbeitnehmeranteil zur gesetzlichen Rentenversicherung", value: slip.rvW },
      { code: "25", label: "Arbeitnehmerbeiträge zur gesetzlichen Krankenversicherung", value: slip.kvW },
      { code: "26", label: "Arbeitnehmerbeiträge zur sozialen Pflegeversicherung", value: slip.pvW },
      { code: "27", label: "Arbeitnehmerbeiträge zur Arbeitslosenversicherung", value: slip.avW },
      { code: "22a", label: "Arbeitgeberanteil zur gesetzlichen Rentenversicherung", value: slip.rvEr },
      { code: "24a", label: "Steuerfreie Arbeitgeberzuschüsse zur gesetzlichen Krankenversicherung", value: slip.kvEr },
      { code: "24c", label: "Steuerfreie Arbeitgeberzuschüsse zur gesetzlichen Pflegeversicherung", value: slip.pvEr },
    ],
    notes: [
      "Dieser Ausdruck ist die Arbeitnehmerkopie der elektronisch an das Finanzamt übermittelten Daten "
      + "(EStG §41b); die ELSTER-Übertragung selbst wird von diesem Pack nicht erzeugt. / This printout "
      + "is the employee copy of the data transmitted to the Finanzamt; the ELSTER transmission itself "
      + "is not produced by this pack.",
      "Umfang: laufende Bezüge der monatlichen 2026-Abrechnung. Versorgungsbezüge (Zeilen 8–10, 29–32), "
      + "Progressionsvorbehalt (Zeile 15), steuerfreie Leistungen (Zeilen 16–21, 24b), U-Zeiten (Zeile 2) "
      + "und DBA-Fälle (Zeilen 16, 34) sind nicht abgebildet — vor der Abgabe prüfen. / Scope: monthly-"
      + "engine laufende Bezüge only; verify the unmodelled Zeilen before filing if any apply.",
      "No Ausdruck Zeile carries the employer's Arbeitslosenversicherung share — it is not part of this "
      + "certificate.",
    ],
  };
}

/**
 * Every employee's certified year, straight off the committed-stub
 * subledger. A draft or uncommitted run never appears: the join admits only
 * run_status = 'committed'.
 */
export async function lohnsteuerbescheinigungSlips(
  orgId: string,
  taxYear: number,
): Promise<DeLohnsteuerbescheinigungSlip[]> {
  assertLohnsteuerbescheinigungYear(taxYear);
  await assertPayrollCountryKnown(db, orgId, taxYear);
  await assertPayrollFilingAccountKnown(db, orgId, { taxYear });
  const earningSum = (alias: SQL) => sql`
    (select coalesce(sum(l.amount), 0) from pay_stub_lines l
       join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
      where l.org_id = ${orgId} and l.stub_id = ${alias}.id and l.kind = 'earning'
        and coalesce(pc.taxable, true))`;
  const withheldSum = (alias: SQL, systemKey: string, kind: string) => sql`
    (select coalesce(sum(l.amount), 0) from pay_stub_lines l
       join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
      where l.org_id = ${orgId} and l.stub_id = ${alias}.id and l.kind = ${kind}
        and pc.system_key = ${systemKey})`;
  const s = sql.raw("s");
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select s.employee_party_id, p.display_name,
           min(s.pay_date)::text as first_pay, max(s.pay_date)::text as last_pay,
           ${earningSum(s)} as gross,
           ${withheldSum(s, "lohnsteuer", "deduction")} as lst,
           ${withheldSum(s, "solidaritaetszuschlag", "deduction")} as soli,
           ${withheldSum(s, "kirchenlohnsteuer", "deduction")} as kist,
           ${withheldSum(s, "rv", "deduction")} as rv_w,
           ${withheldSum(s, "kv", "deduction")} as kv_w,
           ${withheldSum(s, "pv", "deduction")} as pv_w,
           ${withheldSum(s, "av", "deduction")} as av_w,
           ${withheldSum(s, "rv", "employer_contribution")} as rv_er,
           ${withheldSum(s, "kv", "employer_contribution")} as kv_er,
           ${withheldSum(s, "pv", "employer_contribution")} as pv_er
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
        and r.run_status = 'committed'
      join parties p on p.id = s.employee_party_id and p.org_id = ${orgId}
     where s.org_id = ${orgId} and s.tax_year = ${taxYear} and s.country = 'DE'
     group by s.employee_party_id, p.display_name
     order by p.display_name
  `));
  if (rows.rows.length === 0) {
    throw new PayrollPackError(
      `DE Lohnsteuerbescheinigung: no committed German (DE) pay stubs for ${taxYear} — commit a `
      + `${taxYear} DE pay run before issuing Lohnsteuerbescheinigungen (an empty statutory form is `
      + `never issued; draft and uncommitted runs do not appear on it).`,
    );
  }
  // No ANY($array): a bare JavaScript array interpolates as a row
  // constructor, not a PostgreSQL array — filter in JS instead.
  const wanted = new Set(rows.rows.map((row) => String(row.employee_party_id)));
  const profiles = (await db.execute<{ employee_party_id: string; province: string }>(sql`
    select employee_party_id, province from employee_payroll_profiles
     where org_id = ${orgId}
  `));
  const landByEmployee = new Map(
    profiles.rows
      .filter((row) => wanted.has(String(row.employee_party_id)))
      .map((row) => [String(row.employee_party_id), String(row.province ?? "")]),
  );
  const elstam = payrollCertificate("DE", "de_elstam");
  const accounts = await filingAccountsById(orgId);
  const finanzamtDefault = [...accounts.values()]
    .filter((account) => account.country === "DE" && account.programType === "de_finanzamt" && account.isActive)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))[0];
  const finanzamt = filingAccountRef(finanzamtDefault?.id ?? null, accounts);
  const finanzamtLabel = finanzamt.accountNumber
    ? `${finanzamt.accountNumber}${finanzamt.name ? ` · ${finanzamt.name}` : ""}`
    : null;

  const slips: DeLohnsteuerbescheinigungSlip[] = [];
  for (const row of rows.rows) {
    const employeePartyId = String(row.employee_party_id);
    const employeeName = String(row.display_name);
    const lastPay = String(row.last_pay);
    // The Merkmale in force for the LAST Lohnzahlungszeitraum — the form's
    // own definition ("Für den letzten Lohnzahlungszeitraum wurden folgende
    // Lohnsteuerabzugsmerkmale zugrunde gelegt").
    const stored = await storedTaxCertificates(db, orgId, employeePartyId, "DE");
    const resolved = resolveCertificate({
      certificate: elstam,
      stored,
      profile: {},
      asOf: lastPay,
    });
    const steuerklasse = resolved.answers["steuerklasse"] ?? null;
    if (!resolved.onFile || steuerklasse == null || steuerklasse === "") {
      throw new PayrollPackError(
        `DE Lohnsteuerbescheinigung: no ELStAM (de_elstam) with a Steuerklasse is on file for `
        + `${employeeName} as of ${lastPay} — the certificate must state under which Steuerklasse the `
        + `Lohnsteuer was withheld (EStG §§39a, 39e). Retrieve ELStAM and file the de_elstam `
        + `certificate before issuing; refusing rather than assuming Steuerklasse I.`,
      );
    }
    const faktorRaw = resolved.answers["faktor"] ?? null;
    slips.push({
      employeePartyId,
      employeeName,
      land: landByEmployee.get(employeePartyId) ?? "",
      steuerklasse,
      faktor: steuerklasse === "IV" && faktorRaw != null && faktorRaw !== "" && faktorRaw !== "1.000"
        ? faktorRaw
        : null,
      kinderfreibetraege: resolved.answers["kinderfreibetrag_anzahl"] ?? "0",
      freibetragJahr: resolved.answers["freibetrag"] ?? "0",
      hinzurechnungsbetragJahr: resolved.answers["hinzurechnungsbetrag"] ?? "0",
      konfession: (() => {
        const konfession = resolved.answers["konfession"] ?? null;
        return konfession == null || konfession === "" ? null : konfession;
      })(),
      zeitraumVon: String(row.first_pay),
      zeitraumBis: lastPay,
      finanzamt: finanzamtLabel,
      gross: num(row.gross),
      lst: num(row.lst),
      soli: num(row.soli),
      kist: num(row.kist),
      rvW: num(row.rv_w),
      kvW: num(row.kv_w),
      pvW: num(row.pv_w),
      avW: num(row.av_w),
      rvEr: num(row.rv_er),
      kvEr: num(row.kv_er),
      pvEr: num(row.pv_er),
    });
  }
  return slips;
}

async function lohnsteuerbescheinigungPopulation(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const slips = await lohnsteuerbescheinigungSlips(orgId, taxYear);
  let gross = "0";
  let lst = "0";
  let soli = "0";
  let kist = "0";
  let svAn = "0";
  let agAn = "0";
  const rows = slips.map((slip) => {
    const anTotal = add(add(slip.rvW, slip.kvW), add(slip.pvW, slip.avW));
    const agTotal = add(add(slip.rvEr, slip.kvEr), slip.pvEr);
    gross = add(gross, slip.gross);
    lst = add(lst, slip.lst);
    soli = add(soli, slip.soli);
    kist = add(kist, slip.kist);
    svAn = add(svAn, anTotal);
    agAn = add(agAn, agTotal);
    return {
      rowId: slip.employeePartyId,
      employee: slip.employeeName,
      steuerklasse: slip.faktor ? `${slip.steuerklasse} / ${slip.faktor}` : slip.steuerklasse,
      z3: slip.gross,
      z4: slip.lst,
      z5: slip.soli,
      z6: slip.kist,
      svAn: anTotal,
      agAn: agTotal,
    };
  });
  return {
    rowKey: "rowId",
    columns: [
      { key: "employee", label: "Arbeitnehmer" },
      { key: "steuerklasse", label: "StKl/Faktor" },
      { key: "z3", label: "Zeile 3 Brutto", align: "right", money: true },
      { key: "z4", label: "Zeile 4 LSt", align: "right", money: true },
      { key: "z5", label: "Zeile 5 Soli", align: "right", money: true },
      { key: "z6", label: "Zeile 6 KiSt", align: "right", money: true },
      { key: "svAn", label: "AN-Beiträge 23a/25/26/27", align: "right", money: true },
      { key: "agAn", label: "AG-Anteile 22a/24a/24c", align: "right", money: true },
    ],
    rows,
    totals: [
      { label: "Bescheinigungen", value: String(slips.length) },
      { label: "Brutto (Zeile 3)", value: gross, money: true },
      { label: "Lohnsteuer (Zeile 4)", value: lst, money: true },
      { label: "Solidaritätszuschlag (Zeile 5)", value: soli, money: true },
      { label: "Kirchensteuer (Zeile 6)", value: kist, money: true },
      { label: "Arbeitnehmerbeiträge", value: svAn, money: true },
      { label: "Arbeitgeberanteile", value: agAn, money: true },
    ],
  };
}

async function lohnsteuerbescheinigungSlip(
  orgId: string,
  taxYear: number,
  rowId: string,
): Promise<PayrollFilingSlipData> {
  const slips = await lohnsteuerbescheinigungSlips(orgId, taxYear);
  const slip = slips.find((candidate) => candidate.employeePartyId === rowId);
  if (!slip) {
    throw new PayrollError(
      `no ${taxYear} Lohnsteuerbescheinigung matches the requested employee`,
    );
  }
  return lohnsteuerbescheinigungSlipData(slip);
}

/**
 * The DE pack's year-end filing declaration, built lazily (first lookup,
 * not module evaluation) for the same import-cycle reason as
 * caPackFilings: everything inside is only dereferenced at call time.
 */
export function lohnsteuerbescheinigungFiling(): PayrollYearEndFiling {
  return {
    key: "lohnsteuerbescheinigung",
    label: "Ausdruck der elektronischen Lohnsteuerbescheinigung (§41b EStG)",
    cadence: "annual",
    description:
      "The employee's printout of the annual electronic wage-tax certificate (EStG §41b): "
      + "certified withheld Lohnsteuer, Solidaritätszuschlag, Kirchensteuer and SV shares per "
      + "employee, from committed runs. The ELSTER transmission itself is not produced.",
    population: (orgId, taxYear) => lohnsteuerbescheinigungPopulation(orgId, taxYear),
    parseRowId: parseLohnsteuerbescheinigungRowId,
    slip: { build: (orgId, taxYear, rowId) => lohnsteuerbescheinigungSlip(orgId, taxYear, rowId) },
    downloadRefusal: LOHNSTEUERBESCHEINIGUNG_DOWNLOAD_REFUSAL,
    // A wrong certificate is corrected by retransmitting it flagged as
    // amended via ELSTER (EStG §41c/§41b) — the channel this pack refuses —
    // so there is no in-product correction to declare. Refused by name with
    // the real out-of-product remedy.
    amendment: {
      supported: false,
      refusal: LOHNSTEUERBESCHEINIGUNG_AMENDMENT_REFUSAL,
    },
  };
}
