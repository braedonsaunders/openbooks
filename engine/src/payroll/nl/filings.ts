import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { unsealSecret } from "../../platform/secrets.ts";
import {
  certificateChoice,
  certificateFlag,
  resolveCertificate,
  type StoredCertificate,
} from "../certificates.ts";
import { assertPayrollCountryKnown } from "../country.ts";
import { PayrollError } from "../error.ts";
import { assertPayrollFilingAccountKnown } from "../filing.ts";
import type {
  PayrollFilingData,
  PayrollFilingRowScope,
  PayrollFilingSlipData,
  PayrollPackFilings,
} from "../filing-registry.ts";
import { storedTaxCertificates } from "../run-calculation-support.ts";
import { NL_CERTIFICATES } from "./certificates.ts";
import { nlRatesForTaxYear } from "./loonheffing.ts";
import type { NlAgeClass } from "./rates.ts";

/**
 * The NL pack's filing declaration: the jaaropgaaf population, slip and row
 * grammar.
 *
 * The jaaropgaaf is the annual statement the employer issues to the employee
 * (Belastingdienst, Handboek Loonheffingen 2026, hoofdstuk 15, §15.3
 * "Verplichte gegevens op de jaaropgaaf" — established against the March 2026
 * edition; the English translation carries the same chapter order as the
 * Dutch). The statement is form-free (§15.2, model applies from 2022), so the
 * boxes below are the §15.3 mandatory list, each cited to its loonstaat
 * column (hoofdstuk 11): loon (kolom 14), ingehouden loonbelasting/premie
 * volksverzekeringen (kolom 15), verrekende arbeidskorting (kolom 18), BSN,
 * ingehouden bijdrage Zvw (kolom 16), werkgeversheffing Zvw, and totaal
 * premies werknemersverzekeringen. The SV-loon base rides along as
 * permitted additional information (§15.3: "You may also include other
 * information"), with its derivation stated on the slip.
 *
 * Every figure is read off the year's COMMITTED, POSTED pay runs — what was
 * actually paid and withheld under the employee's own tabeltoepassing arm —
 * never recomputed. A draft or uncommitted run never appears.
 */

// ---------------------------------------------------------------------------
// The slip builder
// ---------------------------------------------------------------------------

/** One employee's jaaropgaaf figures for the year, off committed stubs. */
export interface JaaropgaafSlip {
  employeePartyId: string;
  employeeName: string;
  /** Loon voor de loonbelasting/premie volksverzekeringen (loonstaat kolom 14). */
  loon: string;
  /** Ingehouden loonbelasting/premie volksverzekeringen (loonstaat kolom 15). */
  ingehouden: string;
  /** Verrekende arbeidskorting (loonstaat kolom 18). */
  arbeidskorting: string;
  /** Werkgeversheffing Zvw (employer levy, §15.3). */
  zvwWerkgeversheffing: string;
  /** Totaal premies werknemersverzekeringen (§15.3: WW + WIA, Whk included). */
  premiesWerknemersverzekeringen: string;
  /** Premieloon (SV-loon) priced off — additional information, derivation stated. */
  svLoon: string;
  /** The tabeltoepassing arm, read off the opgaaf on file (as of 31 December). */
  ageClass: NlAgeClass;
  /** Whether the opgaaf on file elects the loonheffingskorting. */
  kortingToegepast: boolean;
}

const num = (value: unknown): string => (value == null ? "0" : String(value));

/**
 * The year's committed NL stubs per employee, with the loonstaat columns the
 * jaaropgaaf reprints. Loon (kolom 14, §11.2.9: columns 3+4+5−7) is the
 * taxable-earnings sum — identical to the tvl the engine priced, because the
 * pack declares no income-reducing pre-tax treatments; ingehouden (kolom 15,
 * §11.2.10) is the withheld loonheffing lines; verrekende arbeidskorting
 * (kolom 18, §11.2.13: offset via the tijdvaktabel) is the summed ARK_T
 * period offsets the engine settled. Employer premiums ride their own lines
 * (WW, WIA with the Whk beschikking amount folded in, Zvw werkgeversheffing).
 */
export async function jaaropgaafSlips(orgId: string, taxYear: number): Promise<JaaropgaafSlip[]> {
  await assertPayrollCountryKnown(db, orgId, taxYear);
  await assertPayrollFilingAccountKnown(db, orgId, { taxYear });
  // The withholding the statement reprints only exists where the tables are
  // transcribed: any other year is refused by name, never printed as zeros.
  nlRatesForTaxYear(taxYear);
  const rows = (await db.execute<Record<string, unknown>>(sql`
    with committed as (
      select s.*
        from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
     where s.org_id = ${orgId} and s.tax_year = ${taxYear}
       and s.country = 'NL'
    )
    select c.employee_party_id, p.display_name,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'earning'
                  and coalesce(pc.taxable, true))) as loon,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'deduction'
                  and pc.system_key = 'loonheffing')) as ingehouden,
           sum(coalesce((c.factors->>'ARK_T')::numeric, 0)) as arbeidskorting,
           sum(coalesce((c.factors->>'SV_BASE')::numeric, 0)) as sv_loon,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'employer_contribution'
                  and pc.system_key = 'zvw')) as zvw,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'employer_contribution'
                  and pc.system_key in ('ww', 'wia'))) as premies
      from committed c
      join parties p on p.id = c.employee_party_id and p.org_id = ${orgId}
     group by c.employee_party_id, p.display_name
     order by p.display_name
  `));
  const slips: JaaropgaafSlip[] = [];
  for (const row of rows.rows) {
    const employeePartyId = String(row.employee_party_id);
    const opgaaf = await nlOpgaafOnFile(orgId, employeePartyId, taxYear);
    slips.push({
      employeePartyId,
      employeeName: String(row.display_name),
      loon: num(row.loon),
      ingehouden: num(row.ingehouden),
      arbeidskorting: num(row.arbeidskorting),
      zvwWerkgeversheffing: num(row.zvw),
      premiesWerknemersverzekeringen: num(row.premies),
      svLoon: num(row.sv_loon),
      ageClass: opgaaf.ageClass,
      kortingToegepast: opgaaf.kortingToegepast,
    });
  }
  return slips;
}

/**
 * The employee's tabeltoepassing facts as of 31 December of the filing year,
 * resolved through the pack's own certificate declaration — the same
 * declaration → resolveCertificate chain the engine prices from, never a
 * second reading of the answers. Absent form means not applied and the
 * default arm, exactly as the engine withholds without the korting when no
 * opgaaf is on file.
 */
async function nlOpgaafOnFile(
  orgId: string, employeePartyId: string, taxYear: number,
): Promise<{ ageClass: NlAgeClass; kortingToegepast: boolean }> {
  const declared = NL_CERTIFICATES.certificates.find((certificate) => certificate.key === "nl_loonheffingen");
  if (!declared) {
    throw new PayrollError("the NL payroll pack declares no nl_loonheffingen certificate — the jaaropgaaf cannot state the tabeltoepassing");
  }
  const stored: StoredCertificate[] = await storedTaxCertificates(db, orgId, employeePartyId, "NL");
  const resolved = resolveCertificate({ certificate: declared, stored, asOf: `${taxYear}-12-31` });
  return {
    ageClass: ((certificateChoice(resolved, "age_class") ?? "under_aow") as NlAgeClass),
    kortingToegepast: certificateFlag(resolved, "apply_loonheffingskorting"),
  };
}

/** The certificate's own arm labels — the declaration stays the single source. */
function ageClassLabel(ageClass: NlAgeClass): string {
  const declared = NL_CERTIFICATES.certificates
    .find((certificate) => certificate.key === "nl_loonheffingen")
    ?.fields.find((field) => field.key === "age_class");
  const choice = declared?.kind === "choice"
    ? declared.choices?.find((option) => option.value === ageClass)
    : undefined;
  return choice?.label ?? ageClass;
}

/**
 * The sealed BSN, unsealed at render time — never stored on a filing row, a
 * log line or an error message. §15.3 requires the BSN on the statement with
 * no "(if known)" escape, so a missing or malformed value is a NAMED gap
 * with its remedy on the slip's face, never a blank box.
 */
async function bsnForSlip(orgId: string, employeePartyId: string): Promise<string> {
  const rows = (await db.execute<{ sin_encrypted: string | null }>(sql`
    select prof.sin_encrypted
      from employee_payroll_profiles prof
     where prof.org_id = ${orgId} and prof.employee_party_id = ${employeePartyId}
  `));
  const sealed = rows.rows[0]?.sin_encrypted ?? null;
  const bsn = unsealSecret(sealed);
  // The pack's own identifier shape (9 digits; the elfproef is real but
  // unsourced, so it is NOT enforced — see the pack declaration).
  if (bsn && /^\d{9}$/.test(bsn)) return bsn;
  const remedy = "add the BSN on the employee payroll profile before issuing";
  if (!bsn) {
    return `Not on file — ${remedy} (Handboek Loonheffingen 2026, hoofdstuk 15, §15.3 requires the BSN on the statement)`;
  }
  return `Invalid — ${remedy} (the stored identifier is not 9 digits)`;
}

async function employerName(orgId: string): Promise<string> {
  const rows = (await db.execute<{ name: string | null }>(sql`
    select name from orgs where id = ${orgId}
  `));
  return rows.rows[0]?.name ?? "Unknown employer";
}

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

/**
 * The row-id UUID shape, verbatim the registry's (`isFilingRowUuid` in
 * engine/src/payroll/filing-registry.ts) but LOCAL: importing the registry at
 * runtime pulls engine/src/payroll/packs.ts into this module's evaluation,
 * and packs.ts dereferences this pack's const while it is still initializing
 * (the Canada filings module keeps the same local copy for the same reason).
 * The unit agreement test in filings.test.ts pins the two predicates
 * together, so a drift that 404s real rows fails loudly.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The jaaropgaaf row grammar, as the inverse of jaaropgaafPopulation's bare
 * employee-UUID construction. One row per employee: §15.1 permits combining
 * multiple income relationships of one employment into a single statement.
 * Owned HERE, beside the builder — the subsidiary-scope guard parses through
 * the declaration, never its own copy of this shape.
 */
export function parseJaaropgaafRowId(rowId: string): PayrollFilingRowScope | null {
  if (!UUID_RE.test(rowId)) return null;
  return { employees: [rowId], accounts: [] };
}

async function jaaropgaafPopulation(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const slips = await jaaropgaafSlips(orgId, taxYear);
  // An empty statutory form is a wrong statutory form: a year with no
  // committed runs has no statement to issue, so it refuses by name instead
  // of printing one row of zeros an employer might hand over.
  if (slips.length === 0) {
    throw new PayrollError(
      `the NL payroll pack has no committed ${taxYear} pay runs for this org — no jaaropgaaf can be produced`,
    );
  }
  return {
    rowKey: "rowId",
    columns: [
      { key: "employee", label: "Employee" },
      { key: "loon", label: "Loon (kolom 14)", align: "right", money: true },
      { key: "ingehouden", label: "Ingehouden (kolom 15)", align: "right", money: true },
      { key: "arbeidskorting", label: "Arbeidskorting (kolom 18)", align: "right", money: true },
      { key: "zvwWerkgeversheffing", label: "Werkgeversheffing Zvw", align: "right", money: true },
      { key: "premies", label: "Premies werknemersverz.", align: "right", money: true },
      { key: "svLoon", label: "Premieloon (SV-loon)", align: "right", money: true },
    ],
    rows: slips.map((slip) => ({
      rowId: slip.employeePartyId,
      employee: slip.employeeName,
      loon: slip.loon,
      ingehouden: slip.ingehouden,
      arbeidskorting: slip.arbeidskorting,
      zvwWerkgeversheffing: slip.zvwWerkgeversheffing,
      premies: slip.premiesWerknemersverzekeringen,
      svLoon: slip.svLoon,
    })),
  };
}

/** One employee's jaaropgaaf — the §15.3 mandatory list in the authority's own terms. */
async function jaaropgaafSlip(orgId: string, taxYear: number, rowId: string): Promise<PayrollFilingSlipData> {
  const slips = await jaaropgaafSlips(orgId, taxYear);
  const slip = slips.find((candidate) => candidate.employeePartyId === rowId);
  if (!slip) {
    throw new PayrollError(`no ${taxYear} jaaropgaaf matches the requested employee`);
  }
  return {
    formCode: "NL_JAAROPGAAF",
    formName: "Jaaropgaaf",
    formNumber: "Jaaropgaaf",
    headerFields: [
      { label: "Employee", value: slip.employeeName },
      { label: "Employer / withholding agent", value: await employerName(orgId) },
      { label: "Tax year", value: String(taxYear) },
      { label: "Burgerservicenummer (BSN)", value: await bsnForSlip(orgId, slip.employeePartyId) },
      {
        label: "Tabeltoepassing (leeftijdsklasse, per the opgaaf on file)",
        value: ageClassLabel(slip.ageClass),
      },
      {
        label: "Loonheffingskorting toegepast (per the opgaaf on file)",
        value: slip.kortingToegepast ? "Ja" : "Nee",
      },
    ],
    boxes: [
      {
        code: "14",
        label: "Loon voor de loonbelasting/premie volksverzekeringen (loonstaat kolom 14)",
        value: slip.loon,
      },
      {
        code: "15",
        label: "Ingehouden loonbelasting/premie volksverzekeringen (loonstaat kolom 15)",
        value: slip.ingehouden,
      },
      {
        code: "18",
        label: "Verrekende arbeidskorting (loonstaat kolom 18)",
        value: slip.arbeidskorting,
      },
      {
        code: "16",
        label: "Ingehouden bijdrage Zvw (loonstaat kolom 16)",
        value: "0",
      },
      {
        code: "ZVW-WG",
        label: "Werkgeversheffing Zvw",
        value: slip.zvwWerkgeversheffing,
      },
      {
        code: "TOTAAL-PREM",
        label: "Totaal premies werknemersverzekeringen",
        value: slip.premiesWerknemersverzekeringen,
      },
      {
        code: "SV-LOON",
        label: "Premieloon werknemersverzekeringen/Zvw (SV-loon)",
        value: slip.svLoon,
      },
    ],
    notes: [
      "Totals tie to the year's committed, posted NL pay runs to the cent; draft or uncommitted runs are excluded.",
      "Withholding is reported as withheld under the employee's own tabeltoepassing arm — the age class above prices the schijventarief and the heffingskortingen (Rekenvoorschriften 2026, Tabellen 1–6).",
      "Kolom 16 is € 0,00: no employee-side Zvw is withheld under the standard tables this pack prices — the employee's nominal Zvw premium is paid directly to their insurer, never through the payroll (see the pack declaration).",
      "The premies total is the WW (AWf) and WIA (Aof basispremie plus the differentiated Whk beschikking) employer premiums settled through the loonaangifte. No WGA premium recovered from the employee is netted: the pack has no employee-recovery mechanism (Handboek 2026, §15.3).",
      "Premieloon is the SV-loon base the employer premiums were priced off, capped at the maximumpremieloon — additional information (§15.3 permits it), not a mandatory box.",
    ],
  };
}

/** Lazy, like every pack's filings declaration: not dereferenced at module-evaluation time. */
let cached: PayrollPackFilings | null = null;

export function nlPackFilings(): PayrollPackFilings {
  cached ??= buildNlPackFilings();
  return cached;
}

function buildNlPackFilings(): PayrollPackFilings {
  return {
    country: "NL",
    programTypes: [
      { key: "nl_loonheffingen", label: "Loonheffingen (payroll tax number)" },
    ],
    yearEnd: [
      {
        key: "jaaropgaaf",
        label: "Jaaropgaaf",
        cadence: "annual",
        description:
          "The annual statement the employer issues to the employee (Handboek Loonheffingen 2026, "
          + "hoofdstuk 15, §15.3): loon (kolom 14), ingehouden loonbelasting/premie volksverzekeringen "
          + "(kolom 15), verrekende arbeidskorting (kolom 18), BSN, ingehouden bijdrage Zvw (kolom 16), "
          + "werkgeversheffing Zvw, and totaal premies werknemersverzekeringen — with the tabeltoepassing "
          + "and the loonheffingskorting election per the opgaaf on file.",
        population: (orgId, taxYear) => jaaropgaafPopulation(orgId, taxYear),
        parseRowId: parseJaaropgaafRowId,
        slip: { build: (orgId, taxYear, rowId) => jaaropgaafSlip(orgId, taxYear, rowId) },
        downloadRefusal:
          "the NL payroll pack produces no jaaropgaaf file — no jaaropgaaf file builder exists "
          + "(the 2026 withholding figures it would print are transcribed; the file is not)",
        // A wrong jaaropgaaf is corrected where the wrong number IS: the
        // loonaangifte is corrected with a correctiebericht (Handboek
        // Loonheffingen 2026, hoofdstuk 14, Correctie), and the employee gets
        // a corrected statement. No in-product correction file is built.
        amendment: {
          supported: false,
          refusal:
            "a wrong jaaropgaaf is corrected by filing a corrected loonaangifte (correctiebericht) "
            + "with the Belastingdienst and issuing a corrected statement — no in-product correction "
            + "file is built (Handboek Loonheffingen 2026, hoofdstuk 14)",
        },
      },
    ],
  };
}
