import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { add } from "../../money/money.ts";
import { PayrollError } from "../error.ts";
import { assertPayrollCountryKnown } from "../country.ts";
import {
  assertPayrollFilingAccountKnown,
  filingAccountRef,
  filingAccountsById,
} from "../filing.ts";
import { FR_TAX_YEARS } from "./rates.ts";
import { frPasEditionForVersement } from "./tables-2026.ts";
import type {
  PayrollFilingData,
  PayrollFilingRowScope,
  PayrollFilingSlipData,
  PayrollPackFilings,
  PayrollYearEndFiling,
} from "../filing-registry.ts";

/**
 * The FR pack's filing declaration: the annual récapitulatif of
 * DSN-declared versements, per employee and per month.
 *
 * Premise first, because it decides the shape: France has NO employer-issued
 * annual tax certificate. The Déclaration Sociale Nominative (DSN) — monthly,
 * via net-entreprises.fr — replaced the DADS and nearly every separate
 * payroll return, and since the prélèvement à la source took effect on
 * 1 January 2019 (CGI art. 204 A et s.) the employee's tax data reaches the
 * DGFiP through the DSN month by month, pre-filling their déclaration de
 * revenus. What the employer owes the employee is the monthly bulletin de
 * paie (Code du travail, art. L3243-2 and R3243-1) — not an annual slip.
 * Inventing an annual certificate France no longer uses would be worse than
 * declaring nothing, so this filing does not pretend to be one.
 *
 * What it IS: the per-employee, per-month reconciliation of what the year's
 * COMMITTED, POSTED pay runs actually paid and withheld — brut, net
 * imposable, PAS and cotisations — tying each month to its DSN to the
 * centime. The DSN file itself is OUT OF SCOPE as a submission standard: a
 * national reporting format on the scale of the bank-file standards, needing
 * its own campaign with cited specifications. `downloadRefusal` names it
 * precisely.
 *
 * Import discipline (Spain/Poland TDZ, twice confirmed): this module keeps
 * runtime edges to `packs.ts` and `filing-registry.ts` at ZERO — `import
 * type` only. The year comes off the pack's own FR_TAX_YEARS declaration,
 * never through a generic lookup that would pull packs.ts in at runtime,
 * and the row-id grammar is local (the CA precedent).
 */

/** Stable key of the FR annual filing within the pack. */
export const FR_RECAP_FILING_KEY = "recapitulatif-annuel";

/** Local row-id UUID shape (the CA precedent: owned here, never shared). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Versement-month shape inside a row id. */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The FR recap row grammar, as the inverse of frRecapPopulation's
 * `employee:YYYY-MM:account` construction (the account empty for the
 * unassigned aggregate). Owned HERE, beside the builder — the
 * subsidiary-scope guard parses through the declaration, never its own copy
 * of this shape. Null for anything that is not one of this filing's rows.
 */
export function parseFrRecapRowId(rowId: string): PayrollFilingRowScope | null {
  const parts = rowId.split(":");
  if (parts.length !== 3) return null;
  const [employee, month, account] = parts as [string, string, string];
  if (!UUID_RE.test(employee)) return null;
  if (!MONTH_RE.test(month)) return null;
  if (account && !UUID_RE.test(account)) return null;
  return { employees: [employee], accounts: account ? [account] : [] };
}

/**
 * Refuse a year the pack never transcribed rather than reporting it.
 * Pure — no database — so the year rule is unit-testable.
 *
 * The FR engine transcribes calendar 2026 only (PAS grilles I May-2025 for
 * January–April versements, May-2026 from May, plus the 2026 URSSAF
 * parameters). A 2025 or 2024 population would report PAS figures computed
 * under no published grille — the caYearCaps doctrine: fail the same way,
 * not the opposite way.
 */
export function assertFrFilingYearSupported(taxYear: number): void {
  const covered = FR_TAX_YEARS.editions.some(
    (edition) => edition.year === taxYear && edition.status === "published",
  );
  if (!covered) {
    throw new PayrollError(
      `no published FR statutory tables for tax year ${taxYear} — the FR payroll pack's only `
      + "transcribed year is calendar 2026 (PAS grille I and URSSAF parameters in "
      + "engine/src/payroll/fr/). Transcribe the year's grille and contribution parameters first.",
    );
  }
}

/** One (employee, versement month, SIRET account) slice of the year's DSN-declared pay. */
export interface FrRecapRow {
  employeePartyId: string;
  employeeName: string;
  /** Versement month, YYYY-MM — the month whose DSN this row ties to. */
  versementMonth: string;
  /** SIRET account the versements were filed under; null = unassigned. */
  filingAccountId: string | null;
  /** First pay date in the month — names the PAS grille edition in force. */
  firstPayDate: string;
  stubCount: number;
  /** Salaire brut: the stub earnings the cotisations priced on. */
  brut: string;
  /** Montant net imposable: the PAS assiette, as the engine derived it. */
  netImposable: string;
  /** Prélèvement à la source withheld. */
  pas: string;
  /** Taux PAS applied in the month (distinct values; usually one). */
  tauxPas: string;
  vieillesseSal: string;
  csg: string;
  crds: string;
  arrcoSal: string;
  cegSal: string;
  cetSal: string;
  /** Cotisations salariales: the six employee lines above, totalled. */
  cotisationsSalariales: string;
  /** All employer_contribution lines on the month's stubs, totalled. */
  cotisationsPatronales: string;
  /** Net payé. */
  netPaye: string;
}

const num = (value: unknown): string => (value == null ? "0" : String(value));

/**
 * The year's committed FR versements, straight off the committed-stub
 * subledger — what was actually paid and withheld, never a recomputation.
 * A draft or uncommitted run never appears: the join requires
 * run_status = 'committed'.
 *
 * Every box is a sum of posted amounts, not a derivation: brut sums the
 * taxable earning lines, PAS and each cotisation sum their system_key lines,
 * net imposable sums the NET_IMPOSABLE factor the engine derived at
 * calculate time, net payé sums the posted net_pay. (Poland's warning
 * applied: no plausible-but-wrong subtraction anywhere.)
 */
export async function frRecapRows(orgId: string, taxYear: number): Promise<FrRecapRow[]> {
  assertFrFilingYearSupported(taxYear);
  await assertPayrollCountryKnown(db, orgId, taxYear);
  await assertPayrollFilingAccountKnown(db, orgId, { taxYear });
  const line = (kind: string, key: string) => sql`
    (select coalesce(sum(l.amount), 0) from pay_stub_lines l
      join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
     where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = ${kind}
       and pc.system_key = ${key})`;
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select s.employee_party_id, p.display_name,
           to_char(s.pay_date, 'YYYY-MM') as versement_month,
           s.filing_account_id as filing_account_id,
           min(s.pay_date)::text as first_pay_date,
           count(*)::int as stub_count,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'earning'
                  and coalesce(pc.taxable, true))) as brut,
           sum(coalesce((s.factors->>'NET_IMPOSABLE')::numeric, 0)) as net_imposable,
           sum(${line("deduction", "pas")}) as pas,
           sum(${line("deduction", "vieillesse")}) as vieil_sal,
           sum(${line("deduction", "csg")}) as csg,
           sum(${line("deduction", "crds")}) as crds,
           sum(${line("deduction", "arrco")}) as arrco_sal,
           sum(${line("deduction", "ceg")}) as ceg_sal,
           sum(${line("deduction", "cet")}) as cet_sal,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'employer_contribution')) as patronales,
           sum(s.net_pay) as net_paye,
           string_agg(distinct (s.factors->>'TAUX_PAS'), ', ') as taux_pas
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join parties p on p.id = s.employee_party_id and p.org_id = ${orgId}
     where s.org_id = ${orgId} and s.tax_year = ${taxYear} and s.country = 'FR'
     group by s.employee_party_id, p.display_name, to_char(s.pay_date, 'YYYY-MM'), s.filing_account_id
     order by p.display_name, to_char(s.pay_date, 'YYYY-MM')
   `));
  return rows.rows.map((row) => {
    const vieil = num(row.vieil_sal);
    const csg = num(row.csg);
    const crds = num(row.crds);
    const arrco = num(row.arrco_sal);
    const ceg = num(row.ceg_sal);
    const cet = num(row.cet_sal);
    return {
      employeePartyId: String(row.employee_party_id),
      employeeName: String(row.display_name),
      versementMonth: String(row.versement_month),
      filingAccountId: (row.filing_account_id as string | null) ?? null,
      firstPayDate: String(row.first_pay_date),
      stubCount: Number(row.stub_count ?? 0),
      brut: num(row.brut),
      netImposable: num(row.net_imposable),
      pas: num(row.pas),
      tauxPas: row.taux_pas == null ? "" : String(row.taux_pas),
      vieillesseSal: vieil,
      csg,
      crds,
      arrcoSal: arrco,
      cegSal: ceg,
      cetSal: cet,
      cotisationsSalariales: [vieil, csg, crds, arrco, ceg, cet].reduce(add, "0"),
      cotisationsPatronales: num(row.patronales),
      netPaye: num(row.net_paye),
    };
  });
}

function frRecapRowId(row: Pick<FrRecapRow, "employeePartyId" | "versementMonth" | "filingAccountId">): string {
  return `${row.employeePartyId}:${row.versementMonth}:${row.filingAccountId ?? ""}`;
}

async function frRecapPopulation(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const slices = await frRecapRows(orgId, taxYear);
  // Fail closed on an empty year: an empty statutory reconciliation is a
  // wrong one — it would be read as "nothing was paid". Refuse by name.
  if (slices.length === 0) {
    throw new PayrollError(
      `no committed French pay runs for tax year ${taxYear} — the récapitulatif reports posted `
      + "versements only, so a year with nothing committed has nothing to reconcile. Commit a pay run first.",
    );
  }
  const total = (pick: (row: FrRecapRow) => string) => slices.reduce((acc, row) => add(acc, pick(row)), "0");
  return {
    rowKey: "rowId",
    columns: [
      { key: "employee", label: "Salarié" },
      { key: "month", label: "Mois (versement)" },
      { key: "brut", label: "Salaire brut", align: "right", money: true },
      { key: "netImposable", label: "Net imposable", align: "right", money: true },
      { key: "pas", label: "Prélèvement à la source", align: "right", money: true },
      { key: "cotisSal", label: "Cotisations salariales", align: "right", money: true },
      { key: "cotisPat", label: "Cotisations employeur", align: "right", money: true },
      { key: "netPaye", label: "Net payé", align: "right", money: true },
      { key: "taux", label: "Taux PAS (%)" },
    ],
    rows: slices.map((slice) => ({
      rowId: frRecapRowId(slice),
      employee: slice.employeeName,
      month: slice.versementMonth,
      brut: slice.brut,
      netImposable: slice.netImposable,
      pas: slice.pas,
      cotisSal: slice.cotisationsSalariales,
      cotisPat: slice.cotisationsPatronales,
      netPaye: slice.netPaye,
      taux: slice.tauxPas,
    })),
    // The DSN-year tie (Poland's "why not" answered with a reconciliation):
    // France declares no employer-side annual return alongside this
    // reconciliation — the employer's declaration IS the twelve monthly
    // DSNs — so the annual totals tie the year's DSNs, not a second filing.
    totals: [
      { label: "Versements", value: String(slices.length) },
      { label: "Salaire brut (année)", value: total((row) => row.brut), money: true },
      { label: "Prélèvement à la source (année)", value: total((row) => row.pas), money: true },
      { label: "Net payé (année)", value: total((row) => row.netPaye), money: true },
    ],
  };
}

/** The PAS grille edition in force for a versement, in the authority's own citation. */
function frGrilleCitation(firstPayDate: string): string {
  const edition = frPasEditionForVersement(firstPayDate);
  return edition === "may2025"
    ? "BOI-BAREME-000037-20250410 (grilles à compter du 1er mai 2025)"
    : "BOI-BAREME-000037-20260407 (grilles à compter du 1er mai 2026)";
}

/**
 * One (employee, month) slice as its annual-statement page. The French
 * bulletin de paie carries NO numbered boxes, so codes are the bulletin's
 * own line identifiers and every label is bulletin vocabulary — with the
 * article behind each line in the notes, not guessed.
 */
async function frRecapSlip(orgId: string, taxYear: number, rowId: string): Promise<PayrollFilingSlipData> {
  // Grammar first: a value that is not one of this filing's rows is refused
  // as such even when the year has no rows at all (which refuses its own
  // way below) — the operator asked for a row that cannot exist.
  if (!parseFrRecapRowId(rowId)) {
    throw new PayrollError(
      `no ${taxYear} récapitulatif slice matches the requested versement — it is not one of this filing's rows`,
    );
  }
  const slices = await frRecapRows(orgId, taxYear);
  const slice = slices.find((candidate) => frRecapRowId(candidate) === rowId);
  if (!slice) {
    throw new PayrollError(
      `no ${taxYear} récapitulatif slice matches the requested versement — it is not one of this filing's rows`,
    );
  }
  const account = filingAccountRef(slice.filingAccountId, await filingAccountsById(orgId));
  return {
    formCode: "FR_RECAP",
    formName: "Récapitulatif annuel des versements déclarés en DSN — relevé par salarié et par mois",
    headerFields: [
      { label: "Salarié", value: slice.employeeName },
      { label: "Mois de versement", value: slice.versementMonth },
      { label: "SIRET (établissement)", value: account.accountNumber ?? "Unassigned" },
      { label: "Année d'imposition", value: String(taxYear) },
      { label: "Grille PAS en vigueur", value: frGrilleCitation(slice.firstPayDate) },
    ],
    boxes: [
      { code: "BRUT", label: "Salaire brut", value: slice.brut },
      { code: "NET_IMPOSABLE", label: "Montant net imposable (assiette PAS)", value: slice.netImposable },
      { code: "PAS", label: "Prélèvement à la source", value: slice.pas, emphasis: true },
      { code: "TAUX", label: "Taux PAS appliqué (%)", value: slice.tauxPas === "" ? "—" : slice.tauxPas },
      { code: "VIEIL_SAL", label: "Assurance vieillesse (salariale)", value: slice.vieillesseSal },
      { code: "CSG", label: "Contribution sociale généralisée — CSG (salariale)", value: slice.csg },
      { code: "CRDS", label: "Contribution au remboursement de la dette sociale — CRDS (salariale)", value: slice.crds },
      { code: "ARRCO_SAL", label: "Retraite complémentaire AGIRC-ARRCO (salariale)", value: slice.arrcoSal },
      { code: "CEG_SAL", label: "Contribution d'équilibre général (salariale)", value: slice.cegSal },
      { code: "CET_SAL", label: "Contribution d'équilibre technique (salariale)", value: slice.cetSal },
      { code: "COT_PAT", label: "Cotisations employeur (total)", value: slice.cotisationsPatronales },
      { code: "NET_PAYE", label: "Net payé", value: slice.netPaye, emphasis: true },
    ],
    notes: [
      "France issues no employer annual tax certificate: the monthly DSN (net-entreprises.fr) replaced the DADS "
      + "and carries the prélèvement à la source to the DGFiP since 1 January 2019 (CGI art. 204 A et s.), so the "
      + "employee's return is pre-filled and the employer owes monthly bulletins de paie (C. trav. art. L3243-2, "
      + "R3243-1). This page reconciles one month of DSN-declared versements; it is not a certificate.",
      "Salaire brut, Net payé — lignes du bulletin de paie, C. trav. art. R3243-1 (mentions obligatoires).",
      "Montant net imposable, Prélèvement à la source — CGI art. 204 A et s.; assiette mensuelle et grille en "
      + "vigueur à la date du versement, BOI-IR-PAS-20-20-30-10 (§90 base mensuelle, §120 grille applicable).",
      "Vieillesse, CSG, CRDS — cotisations URSSAF 2026 (urssaf.fr, taux et barèmes secteur privé): CSG/CRDS sur "
      + "98,25 % du brut dans la limite de 4 × PASS. AGIRC-ARRCO, CEG, CET — agirc-arrco.fr (tranches 1 et 2).",
      "The employee's NIR (numéro de sécurité sociale) is intentionally not printed here: it travels on the "
      + "monthly DSN, and no annual statement carries a statutory box for it (named gap, not a blank).",
      "Versements beyond this month's committed runs — drafts, uncommitted calculations, future months — are "
      + "excluded by construction: only run_status = 'committed' stubs reconcile.",
    ],
  };
}

function frRecapFiling(): PayrollYearEndFiling {
  return {
    key: FR_RECAP_FILING_KEY,
    label: "Récapitulatif annuel DSN (par salarié, par mois)",
    cadence: "annual",
    description:
      "France has no employer-issued annual tax certificate — the monthly DSN carries pay and PAS to the "
      + "authorities — so this filing is the per-employee, per-month reconciliation of the year's committed "
      + "versements (brut, net imposable, PAS, cotisations), tying each month to its DSN to the centime.",
    emptyText: "No committed French pay stubs for this year.",
    population: (orgId, taxYear) => frRecapPopulation(orgId, taxYear),
    parseRowId: parseFrRecapRowId,
    slip: { build: (orgId, taxYear, rowId) => frRecapSlip(orgId, taxYear, rowId) },
    downloadRefusal:
      "the FR pack produces no DSN file (Déclaration Sociale Nominative — the monthly employer declaration "
      + "via net-entreprises.fr): this reconciliation is the source data; transmit the DSN through "
      + "net-entreprises.fr. The DSN submission standard itself is out of scope as a separate campaign.",
    // A wrong month is corrected where it lives: the DSN is rectified out
    // of product (annule-et-remplace) and the bulletin reissued. There is
    // no annual certificate to re-file, so no in-product mechanics exist.
    amendment: {
      supported: false,
      refusal:
        "a wrong versement is corrected out of product with a DSN rectificative (annule-et-remplace) via "
        + "net-entreprises.fr and a reissued bulletin de paie — no in-product correction file is built",
    },
  };
}

/** Lazy for the same import-cycle reason as the US declaration. */
let cached: PayrollPackFilings | null = null;

/** The FR pack's filing declaration, destined for FR_PAYROLL_PACK.filings. */
export function frPackFilings(): PayrollPackFilings {
  cached ??= {
    country: "FR",
    programTypes: [
      { key: "fr_siret", label: "SIRET — établissement employeur (DSN)" },
    ],
    yearEnd: [frRecapFiling()],
  };
  return cached;
}
