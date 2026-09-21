/**
 * The IT pack's Certificazione Unica population: one slip per employee,
 * summed off the year's COMMITTED, POSTED pay runs — never recomputed.
 *
 * Box set: CU 2026 istruzioni (redditi 2025), AdE Provvedimento n. 15707 del
 * 15 gennaio 2026. Every printed box cites its punto below; everything the
 * committed stubs cannot supply is an explicit note on the slip, never a
 * guessed figure:
 *
 * - DATI FISCALI punto 1 / punto 2 — "nel punto 1 vanno indicati i redditi
 *   per i quali il contratto di lavoro è a tempo indeterminato, nel punto 2
 *   ... a tempo determinato". The pack carries no per-period contract type,
 *   so the split follows the tempo_determinato flag on the employee's
 *   it_detrazioni declaration on file (the pack's only employee-filed input
 *   channel); a mid-year contract change needs a manual check, said on the
 *   slip. Pensionati (punto 3) are refused by the engine, so punto 3 never
 *   prints; punti 4/5/13 (assimilati, assegni, ippica) have no engine inputs
 *   and are folded into nothing — an employee paid only through those
 *   channels is outside what this pack computes.
 * - Punto 21 — "va indicato il totale delle ritenute d'acconto ... quello
 *   che risulta dalle operazioni di conguaglio": the summed income_tax
 *   lines actually withheld on the year's committed stubs. That sum IS the
 *   conguaglio total when the conguaglio was settled through payroll (a
 *   December adjustment committed like any other run lands in this sum) and
 *   is identical to it for full-year level pay, which is this pack's modeled
 *   scope. What the product never does is COMPUTE the art. 23 DPR 600/1973
 *   year-end conguaglio (actual annual income, giorni, spettante
 *   detrazioni) — for a non-level year the sostituto must settle it in pay
 *   first, said on the slip. Certifying the withheld sum rather than a
 *   recomputed liability is deliberate: only moved money reconciles to the
 *   F24 payments, and a "correct" liability nobody withheld would be the
 *   false figure.
 * - Punto 22 — "l'addizionale regionale all'IRPEF dovuta ... sul totale dei
 *   redditi di lavoro dipendente e assimilati certificati": the summed
 *   regional_surtax lines. Tenant-deliberated rates, so the figure reports
 *   what was withheld from entered rates; an unconfigured scope refuses at
 *   computation, never accrues zero (see compute-statutory.ts).
 * - Punto 391 — "l'importo del trattamento integrativo che il sostituto
 *   d'imposta ha erogato al lavoratore": the summed ti_payout credits.
 * - INPS Sezione 1 punto 4 — "Imponibile previdenziale ... l'importo
 *   complessivo delle retribuzioni mensili dovute nell'anno solare": the
 *   summed stub pensionable base. Punto 6 — "Contributi a carico del
 *   lavoratore trattenuti ... 9,19% (IVS) ... 1% (IVS) sulla parte di
 *   retribuzione eccedente la prima fascia": the summed worker-share INPS
 *   deductions, which the engine prices at exactly those rates.
 *
 * Deliberately NOT printed (each named on the slip with its remedy):
 * - Addizionale comunale acconto/saldo (punti 26/27/29) and the prior-year /
 *   cessation timing boxes (23/24/25/28): the engine computes the annual
 *   surtax as one figure — the acconto/saldo instalment split and other-year
 *   withholdings are untranscribed timing (IT_REFUSED_2025).
 * - Imposta lorda and the detrazioni (punti 361/367/368/374/375): an annual
 *   conguaglio computation off total income, not a sum of stub lines; the
 *   filing reports what was withheld (punto 21), never a recomputation.
 * - Giorni and rapporto dates (punti 6/8/9/10/11): the engine carries no
 *   detrazione-day counts or employment dates.
 * - INPS matricola (Sezione 1 punto 1): the employer's INPS position, not
 *   payroll data.
 * - The L. 207/2024 c. 4 somma: "non concorre alla formazione del reddito",
 *   so its credit lines are excluded from punti 1/2 by construction.
 *
 * Rounding: CU 2026 istruzioni — "esponendo i dati in centesimi,
 * arrotondando per eccesso se la terza cifra decimale è uguale o superiore
 * a cinque o per difetto se inferiore" (half-up to the cent, quoted in
 * tax-year-2025.ts). Stub lines are already cent-rounded at computation, and
 * whole-cent sums of whole-cent lines stay whole-cent, so no further
 * rounding is applied here — there is nothing left to round.
 *
 * Year coverage: tax year 2025 only (the CU 2026 layout above). 2026 payroll
 * computes, but its box set lives in the CU 2027 istruzioni (redditi 2026),
 * unpublished at transcription time (tax-year-2026.ts) — printing CU 2026
 * boxes for 2026 income would be a guess, so 2026 refuses by name.
 */
import { sql } from "drizzle-orm";
import { cmp } from "../../money/money.ts";
import { db } from "../../platform/db.ts";
import { assertPayrollCountryKnown } from "../country.ts";
import { PayrollError } from "../error.ts";
import { assertPayrollFilingAccountKnown } from "../filing.ts";
import type {
  PayrollFilingData,
  PayrollFilingRowScope,
  PayrollFilingSlipData,
  PayrollSlipBox,
} from "../filing-registry.ts";

/**
 * The row-id UUID shape, stated locally rather than imported — a runtime
 * import of ../filing-registry.ts from a pack builder is a
 * module-evaluation cycle (packs.ts reaches this module through the pack,
 * and the registry reaches back), and the failure it produces is a TDZ
 * ReferenceError, not a wrong figure. Same pattern, same lax shape the web
 * layer guards `[id]` params with — ids are opaque here, not validated.
 */
const CU_ROW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { certificateFlag, type ResolvedCertificate } from "../certificates.ts";
import { IT_CERTIFICATES } from "./certificates.ts";
import { IT_REGIONS } from "./regions.ts";

/** The only tax year whose CU box layout is transcribed (CU 2026). */
export const CU_SUPPORTED_TAX_YEAR = 2025;

export class ItFilingRefusal extends PayrollError {}

function itDetrazioniDeclaration() {
  const found = IT_CERTIFICATES.certificates.find((cert) => cert.key === "it_detrazioni");
  if (!found) {
    throw new ItFilingRefusal(
      "the IT payroll pack declares no it_detrazioni certificate, so the CU cannot attribute tempo determinato",
    );
  }
  return found;
}

/** One employee's CU figures, straight off the committed stubs. */
export interface CuSlip {
  employeePartyId: string;
  employeeName: string;
  /** tempo_determinato on the it_detrazioni declaration on file. */
  isFixedTerm: boolean;
  /** ISTAT region name from the stub domicile snapshot, when known. */
  domicilioRegione: string | null;
  /** Domicile comune (codice catastale) from the declaration, when known. */
  domicilioComune: string | null;
  /** Punti 1/2: taxable dependent-employment earnings. */
  redditi: string;
  /** Punto 21: IRPEF withheld. */
  ritenuteIrpef: string;
  /** Punto 22: addizionale regionale dovuta. */
  addizionaleRegionale: string;
  /** INPS Sezione 1 punto 4: imponibile previdenziale. */
  imponibileInps: string;
  /** INPS Sezione 1 punto 6: contributi a carico del lavoratore. */
  contributiInpsWorker: string;
  /** Punto 391: trattamento integrativo erogato. */
  trattamentoIntegrativo: string;
  stubCount: number;
}

const num = (value: unknown): string => (value == null ? "0" : String(value));

/**
 * The CU row grammar, as the inverse of cuPopulation's bare-employee-id
 * construction. Owned here, beside the builder — the subsidiary-scope guard
 * parses through the declaration, never its own copy of this shape.
 */
export function parseCuRowId(rowId: string): PayrollFilingRowScope | null {
  if (!CU_ROW_UUID_RE.test(rowId)) return null;
  return { employees: [rowId], accounts: [] };
}

/**
 * One employee's CU boxes in the authority's own punto numbers — pure, so
 * the "never print a zero" rule is verifiable without a database. Punti 1/2,
 * 21 and 22 are the certificate's fiscal core and always print (a zero
 * withholding is a fact the return needs); punto 391 and the INPS boxes are
 * amounts paid or earned, omitted when zero like the W-2's boxes 15–20.
 */
export function cuSlipBoxes(slip: CuSlip): PayrollSlipBox[] {
  const boxes: PayrollSlipBox[] = [
    slip.isFixedTerm
      ? { code: "2", label: "Redditi di lavoro dipendente — tempo determinato", value: slip.redditi }
      : { code: "1", label: "Redditi di lavoro dipendente — tempo indeterminato", value: slip.redditi },
    { code: "21", label: "Ritenute IRPEF", value: slip.ritenuteIrpef, emphasis: true },
    { code: "22", label: "Addizionale regionale all'IRPEF dovuta", value: slip.addizionaleRegionale },
  ];
  if (cmp(slip.trattamentoIntegrativo, "0") !== 0) {
    boxes.push({ code: "391", label: "Trattamento integrativo erogato", value: slip.trattamentoIntegrativo });
  }
  if (cmp(slip.imponibileInps, "0") !== 0) {
    boxes.push({ code: "INPS-4", label: "INPS Sezione 1 — Imponibile previdenziale", value: slip.imponibileInps });
  }
  if (cmp(slip.contributiInpsWorker, "0") !== 0) {
    boxes.push({
      code: "INPS-6",
      label: "INPS Sezione 1 — Contributi a carico del lavoratore trattenuti",
      value: slip.contributiInpsWorker,
    });
  }
  return boxes;
}

/** What the slip does not carry, each with its reason and remedy. */
function cuSlipNotes(slip: CuSlip): string[] {
  const notes = [
    "Punti 1/2 report the year's committed pay runs; the L. 207/2024 c. 4 somma does not form reddito and is excluded.",
    "Addizionale comunale (CU punti 26/27/29) not shown: the engine computes the annual surtax as one figure and the acconto/saldo split is not modelled — settle it from the F24 payments.",
    "Punti 23/24/25/28 (prior years and cessations) not shown: they belong to other years or to cessation-time withholding, not to this year's committed runs.",
    "Imposta lorda and detrazioni (punti 361/367/368/374/375) not shown: an annual conguaglio computation, not a sum of stub lines — the certificate reports what was withheld (punto 21).",
    "Punto 21 is the IRPEF withheld on the committed runs, conguaglio included only if settled in pay: the art. 23 DPR 600/1973 year-end conguaglio is not computed by this product — verify it before transmitting and, if it moves the withholding, settle it in pay and re-certify.",
    "Giorni and rapporto dates (punti 6/8/9/10/11) not shown: the engine carries no detrazione-day counts or employment dates — take them from the employment relationship.",
    "INPS matricola (Sezione 1 punto 1) not shown: the employer's INPS position, not payroll data — enter it from the INPS registration.",
    "Codice fiscale del percipiente not shown: the national identifier is sealed in the payroll engine and never leaves it — carry it onto the transmitted CU from the anagrafica at render time.",
  ];
  if (slip.isFixedTerm) {
    notes.push(
      "Tempo determinato follows the it_detrazioni declaration on file: verify the punti 1/2 split when the contract changed mid-year.",
    );
  }
  return notes;
}

/**
 * Every employee with a committed IT stub in the year, with the CU figures
 * summed beside them. Draft and uncommitted runs never appear: the join
 * admits only run_status = 'committed', and a filing must report what was
 * actually paid and withheld, never a recomputation.
 */
export async function cuSlips(orgId: string, taxYear: number): Promise<CuSlip[]> {
  if (taxYear !== 2025 && taxYear !== 2026) {
    throw new ItFilingRefusal(
      `the IT payroll pack has no transcribed tables for tax year ${taxYear}: 2025 and 2026 are the transcribed `
      + "editions (see engine/src/payroll/it/tax-year-2025.ts and tax-year-2026.ts). Transcribe the year's "
      + "Legge di Bilancio, AdE provvedimenti, and INPS circular into engine/src/payroll/it/rates.ts before "
      + `certifying ${taxYear}.`,
    );
  }
  if (taxYear !== CU_SUPPORTED_TAX_YEAR) {
    throw new ItFilingRefusal(
      `the IT payroll pack transcribes the CU box layout only for tax year 2025 (CU 2026 istruzioni, `
      + `AdE Provvedimento n. 15707 del 15 gennaio 2026): the CU ${taxYear + 1} istruzioni (redditi ${taxYear}) `
      + `are not transcribed (see engine/src/payroll/it/tax-year-2026.ts), so no CU can be certified for ${taxYear} `
      + `until that layout is transcribed.`,
    );
  }
  await assertPayrollCountryKnown(db, orgId, taxYear);
  await assertPayrollFilingAccountKnown(db, orgId, { taxYear });
  const rows = (await db.execute<Record<string, unknown>>(sql`
    with committed as (
      select s.*
        from pay_stubs s
        join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
       where s.org_id = ${orgId} and s.tax_year = ${taxYear}
         and s.country = 'IT'
    )
    select c.employee_party_id, p.display_name,
           max(c.province) as region,
           count(*)::int as stub_count,
           sum(c.pensionable_earnings) as imponibile,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'earning'
                  and coalesce(pc.taxable, true))) as redditi,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'deduction'
                  and pc.system_key = 'income_tax')) as irpef,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'deduction'
                  and pc.system_key = 'regional_surtax')) as addreg,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'deduction'
                  and pc.system_key = 'inps')) as inps_worker,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'credit'
                  and pc.system_key = 'ti_payout')) as ti
      from committed c
      join parties p on p.id = c.employee_party_id and p.org_id = ${orgId}
     group by c.employee_party_id, p.display_name
     order by p.display_name
  `));
  if (rows.rows.length === 0) {
    throw new ItFilingRefusal(
      `no committed IT pay stubs for tax year ${taxYear}: the Certificazione Unica reports committed pay runs, `
      + "so an empty slip would be a wrong slip. Calculate and commit the year's IT pay runs first.",
    );
  }
  const declaration = itDetrazioniDeclaration();
  const certRows = (await db.execute<{ employee_party_id: string; answers: Record<string, string | null> }>(sql`
    select distinct on (c.employee_party_id) c.employee_party_id, c.answers
      from employee_tax_certificates c
     where c.org_id = ${orgId} and c.country = 'IT' and c.certificate_key = 'it_detrazioni'
       and c.superseded_on is null
       and (c.effective_from is null or c.effective_from <= ${`${taxYear}-12-31`}::date)
     order by c.employee_party_id, c.effective_from desc nulls last
  `));
  const certByEmployee = new Map(
    certRows.rows.map((row) => [String(row.employee_party_id), row.answers as Record<string, string | null>]),
  );
  const regionName = (code: string | null): string | null =>
    IT_REGIONS.find((region) => region.code === code)?.name ?? null;
  return rows.rows.map((row) => {
    const employeePartyId = String(row.employee_party_id);
    const answers = certByEmployee.get(employeePartyId) ?? {};
    const resolved: ResolvedCertificate = {
      certificate: declaration,
      onFile: true,
      effectiveFrom: null,
      answers,
      missing: [],
    };
    const comune = answers["domicilio_comune"];
    return {
      employeePartyId,
      employeeName: String(row.display_name),
      isFixedTerm: certificateFlag(resolved, "tempo_determinato"),
      domicilioRegione: regionName(row.region == null ? null : String(row.region)),
      domicilioComune: comune == null || comune === "" ? null : comune,
      redditi: num(row.redditi),
      ritenuteIrpef: num(row.irpef),
      addizionaleRegionale: num(row.addreg),
      imponibileInps: num(row.imponibile),
      contributiInpsWorker: num(row.inps_worker),
      trattamentoIntegrativo: num(row.ti),
      stubCount: Number(row.stub_count ?? 0),
    };
  });
}

/** The CU population table: one row per certified employee. */
export async function cuPopulation(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const slips = await cuSlips(orgId, taxYear);
  return {
    rowKey: "rowId",
    columns: [
      { key: "employee", label: "Percipiente" },
      { key: "contratto", label: "Contratto" },
      { key: "redditi", label: "Redditi (punti 1/2)", align: "right", money: true },
      { key: "irpef", label: "Ritenute IRPEF (21)", align: "right", money: true },
      { key: "addRegionale", label: "Addizionale regionale (22)", align: "right", money: true },
      { key: "imponibileInps", label: "Imponibile INPS", align: "right", money: true },
      { key: "inpsWorker", label: "Contributi INPS (INPS-6)", align: "right", money: true },
      { key: "trattamentoIntegrativo", label: "Tratt. integrativo (391)", align: "right", money: true },
    ],
    rows: slips.map((slip) => ({
      rowId: slip.employeePartyId,
      employee: slip.employeeName,
      contratto: slip.isFixedTerm ? "tempo determinato" : "tempo indeterminato",
      redditi: slip.redditi,
      irpef: slip.ritenuteIrpef,
      addRegionale: slip.addizionaleRegionale,
      imponibileInps: slip.imponibileInps,
      inpsWorker: slip.contributiInpsWorker,
      trattamentoIntegrativo: slip.trattamentoIntegrativo,
    })),
  };
}

/** One employee's CU slip, box for box — the CU 2026 punto numbers. */
export async function cuSlip(orgId: string, taxYear: number, rowId: string): Promise<PayrollFilingSlipData> {
  const slips = await cuSlips(orgId, taxYear);
  const slip = slips.find((entry) => entry.employeePartyId === rowId);
  if (!slip) {
    throw new PayrollError(
      `no ${taxYear} Certificazione Unica matches the requested employee`,
    );
  }
  const domicilio = [slip.domicilioComune, slip.domicilioRegione].filter(Boolean).join(" — ") || "non dichiarato";
  return {
    formCode: "IT_CU",
    formName: "Certificazione Unica — Redditi di lavoro dipendente",
    formNumber: "CU 2026",
    headerFields: [
      { label: "Percipiente", value: slip.employeeName },
      { label: "Anno d'imposta", value: `${taxYear} (CU ${taxYear + 1}, redditi ${taxYear})` },
      { label: "Domicilio fiscale", value: domicilio },
    ],
    boxes: cuSlipBoxes(slip),
    notes: cuSlipNotes(slip),
  };
}

