import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { keyedFingerprint, unsealSecret } from "../../platform/secrets.ts";
import { add, neg, normalizeMoney } from "../../money/money.ts";
import { assertPayrollCountryKnown } from "../country.ts";
import { PayrollError } from "../error.ts";
import { assertPayrollFilingAccountKnown } from "../filing.ts";
import type {
  PayrollFilingCorrectionRow,
  PayrollFilingData,
  PayrollFilingRowScope,
  PayrollFilingSlipData,
} from "../filing-registry.ts";
import { PayrollPackError } from "../payroll-error.ts";
import { payrollSupportedTaxYears } from "../tax-years.ts";
import { PL_TAX_YEARS } from "./rates.ts";

/**
 * The PL pack's PIT-11 builder: one employee information return per employee
 * with committed 2026 employment stubs, straight off the committed-stub
 * subledger — never a recomputation.
 *
 * Box layout authority: Ministerstwo Finansów, PIT-11(29) (the published
 * form for rok 2025; the 2026-year edition is not published yet, so every
 * box below cites the (29) poz. number and the slip carries that version
 * caveat on its face). Employment income is section E row 1 (art. 31
 * employer payers):
 *
 * - poz. 29 Przychód — the year's revenue actually paid. Form fn 13:
 *   tax-exempt income never enters; the pack prices standard taxable
 *   employment only, so this is the committed earning lines.
 * - poz. 30 Koszty uzyskania przychodu — form fn 14: "koszty faktycznie
 *   uwzględnione przez płatnika przy poborze zaliczek" — the monthly KUP
 *   (250/300 zł, art. 22 ust. 2 pkt 1/3) actually applied on each committed
 *   stub, carried on the stub's stored KUP factor.
 * - poz. 31 Dochód — the form's own arithmetic, "(b − c)": poz. 29 minus
 *   poz. 30. NOT revenue minus contributions: the ZUS employee
 *   contributions reduce the monthly PIT base (art. 32 ust. 4) but the
 *   information return prints dochód as przychód minus KUP.
 * - poz. 33 Zaliczka pobrana przez płatnika — the whole-złoty advances
 *   actually withheld (the committed `pit` stub lines). Form fn 15: shown
 *   once, in row 1.
 * - poz. 95 Składki na ubezpieczenia społeczne odliczone od dochodu —
 *   the employee emerytalne + rentowe + chorobowe actually withheld
 *   (committed `zus_emeryt`/`zus_rent`/`zus_chor` lines). Form fn 20
 *   excludes contributions on exempt income; the pack models none.
 * - poz. 122 Składki na ubezpieczenie zdrowotne — the 9 % health
 *   contribution actually withheld (committed `zus_zdr` lines). Form
 *   fn 23; base per art. 81 ust. 6 (revenue minus employee social
 *   contributions), uncapped per art. 81 ust. 5.
 *
 * Deliberately absent, named on the slip rather than printed as zeros:
 *
 * - poz. 32 (treaty-exempt dochód) — the pack models no double-taxation-
 *   treaty exemption channel, so there is never an exempt amount to print.
 * - poz. 123 (union dues, art. 26 ust. 1 pkt 2c) — the pack declares
 *   `employeeUnionDuesTaxTreatment: null`; the engine gives dues no
 *   treatment, so no dues figure exists to file.
 * - Section E rows 2/3 (under-26, senior relief) — the engine refuses
 *   those paths by name (ulga dla młodych; the senior exemption needs its
 *   claim channel), so no committed stub can carry them; every stub in
 *   scope was priced as standard row-1 employment.
 *
 * The health contribution is NOT deductible from tax in 2026 (the art. 27b
 * deduction is gone since 2022): the engine deducts only KUP and the
 * employee's social contributions from the PIT base (art. 32 ust. 4 — see
 * ./compute-statutory.ts), and no box here subtracts poz. 122 from
 * anything.
 */

const num = (value: unknown): string => (value == null ? "0" : String(value));

/**
 * Poz. 31 from its cited inputs: the form prints dochód as "(b − c)" —
 * poz. 29 przychód minus poz. 30 KUP. Pure so the derivation the whole
 * slip rests on is verifiable without a database. Exact-decimal
 * (money.ts), never floats.
 */
export function pit11Dochod(przychod: string, kup: string): string {
  return add(normalizeMoney(przychod), neg(normalizeMoney(kup)));
}

export interface Pit11Slip {
  employeePartyId: string;
  employeeName: string;
  /** poz. 29 — year's revenue actually paid. */
  przychod: string;
  /** poz. 30 — KUP actually applied on committed stubs. */
  kup: string;
  /** poz. 31 — poz. 29 minus poz. 30, the form's own (b − c). */
  dochod: string;
  /** poz. 33 — advances actually withheld. */
  zaliczka: string;
  /** poz. 95 — employee social contributions actually withheld. */
  skladkiSpoleczne: string;
  /** poz. 122 — health contribution actually withheld. */
  skladkiZdrowotne: string;
  stubCount: number;
}

/**
 * The year the pack can price is the year it can report: 2026 only.
 * payrollTaxYearProblem('PL', 2025) and ('PL', 2024) both report `missing`
 * — an annual box summed across a year the engine will not price is a
 * guess, so the builder refuses by name before reading a row.
 *
 * Answered from the pack's own PL_TAX_YEARS declaration through the
 * cycle-free tax-years leaf — never through ../packs.ts, which imports
 * every pack's pack.ts at module level (this module loads underneath
 * pl/pack.ts, so that edge is a TDZ crash; see the lazy-declaration note
 * atop canada/filings.ts). The message mirrors payrollTaxYearProblem's
 * `missing` kind, including the scaffold remedy.
 */
function assertPlTaxYearSupported(taxYear: number): void {
  const loaded = payrollSupportedTaxYears(PL_TAX_YEARS);
  if (loaded.includes(taxYear)) return;
  throw new PayrollPackError(
    `${taxYear} statutory tables are not loaded for PL — `
    + (loaded.length > 0 ? `loaded years: ${loaded.join(", ")}. ` : "no years are loaded. ")
    + `Scaffold the edition with \`node --import tsx scripts/payroll-new-tax-year.ts --country PL --year ${taxYear}\` `
    + "and transcribe the published figures into engine/src/payroll/pl/rates.ts.",
  );
}

/** One employee's annual boxes from committed stubs, in filing order. */
export async function pit11Slips(orgId: string, taxYear: number): Promise<Pit11Slip[]> {
  assertPlTaxYearSupported(taxYear);
  await assertPayrollCountryKnown(db, orgId, taxYear);
  await assertPayrollFilingAccountKnown(db, orgId, { taxYear });
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select s.employee_party_id, p.display_name,
           count(*)::int as stub_count,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'earning'
                  and coalesce(pc.taxable, true))) as przychod,
           sum(coalesce((s.factors->>'KUP')::numeric, 0)) as kup,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'deduction'
                  and pc.system_key = 'pit')) as zaliczka,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'deduction'
                  and pc.system_key in ('zus_emeryt', 'zus_rent', 'zus_chor'))) as spoleczne,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'deduction'
                  and pc.system_key = 'zus_zdr')) as zdrowotna
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
        and r.run_status = 'committed'
      join parties p on p.id = s.employee_party_id and p.org_id = ${orgId}
     where s.org_id = ${orgId} and s.tax_year = ${taxYear} and s.country = 'PL'
     group by s.employee_party_id, p.display_name
     order by p.display_name
  `));
  return rows.rows.map((row) => {
    const przychod = normalizeMoney(num(row.przychod));
    const kup = normalizeMoney(num(row.kup));
    return {
      employeePartyId: String(row.employee_party_id),
      employeeName: String(row.display_name),
      przychod,
      kup,
      dochod: pit11Dochod(przychod, kup),
      zaliczka: normalizeMoney(num(row.zaliczka)),
      skladkiSpoleczne: normalizeMoney(num(row.spoleczne)),
      skladkiZdrowotne: normalizeMoney(num(row.zdrowotna)),
      stubCount: Number(row.stub_count ?? 0),
    };
  });
}

/**
 * The lax row-id UUID shape, byte-identical to the web layer's guard and
 * `isFilingRowUuid` in ../filing-registry.ts. A LOCAL copy — the Canada
 * precedent (canada/filings.ts `UUID_RE`) — because that module imports
 * ../packs.ts at load time, and this module loads underneath pl/pack.ts,
 * so that edge is a TDZ crash on `PAYROLL_COUNTRY_PACKS`. The parity test
 * in ./pit11.test.ts pins this copy to the canonical helper on a battery
 * of strings, so drift fails loudly instead of 404ing real rows.
 */
const PIT11_ROW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The PIT-11 row grammar, as the inverse of pit11Population's bare employee
 * id construction (the ROE/RL-1 precedent: an information return is per
 * employee under the org's single NIP payer identity). Owned HERE, beside
 * the builder — the subsidiary-scope guard parses through the declaration,
 * never its own copy of this shape.
 */
export function parsePit11RowId(rowId: string): PayrollFilingRowScope | null {
  if (!PIT11_ROW_UUID_RE.test(rowId)) return null;
  return { employees: [rowId], accounts: [] };
}

export async function pit11Population(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const slips = await pit11Slips(orgId, taxYear);
  if (slips.length === 0) {
    throw new PayrollError(
      `no committed PL pay stubs for tax year ${taxYear} — a PIT-11 with no rows is a wrong `
      + "statutory form, not an empty one. Commit the year's pay runs before opening the filing.",
    );
  }
  const total = (pick: (slip: Pit11Slip) => string) =>
    slips.reduce((acc, slip) => add(acc, pick(slip)), "0");
  return {
    rowKey: "rowId",
    columns: [
      { key: "employee", label: "Employee" },
      { key: "poz29", label: "Poz. 29 przychód", align: "right", money: true },
      { key: "poz30", label: "Poz. 30 KUP", align: "right", money: true },
      { key: "poz31", label: "Poz. 31 dochód", align: "right", money: true },
      { key: "poz33", label: "Poz. 33 zaliczka", align: "right", money: true },
      { key: "poz95", label: "Poz. 95 składki społeczne", align: "right", money: true },
      { key: "poz122", label: "Poz. 122 składka zdrowotna", align: "right", money: true },
    ],
    rows: slips.map((slip) => ({
      rowId: slip.employeePartyId,
      employee: slip.employeeName,
      poz29: slip.przychod,
      poz30: slip.kup,
      poz31: slip.dochod,
      poz33: slip.zaliczka,
      poz95: slip.skladkiSpoleczne,
      poz122: slip.skladkiZdrowotne,
    })),
    totals: [
      { label: "Informations (PIT-11)", value: String(slips.length) },
      { label: "Przychód (poz. 29)", value: total((slip) => slip.przychod), money: true },
      // The PIT-4R tie, stated where the operator reconciles: the employer's
      // annual PIT-4R declaration of advances withheld must equal this sum —
      // both read the same committed `pit` stub lines.
      { label: "Zaliczki pobrane (poz. 33 — PIT-4R tie)", value: total((slip) => slip.zaliczka), money: true },
    ],
  };
}

/** One employee's PIT-11, box for box — the Ministry's own poz. numbers. */
export async function pit11Slip(
  orgId: string,
  taxYear: number,
  rowId: string,
): Promise<PayrollFilingSlipData> {
  const slips = await pit11Slips(orgId, taxYear);
  const slip = slips.find((entry) => entry.employeePartyId === rowId);
  if (!slip) {
    throw new PayrollError(
      `no ${taxYear} PIT-11 matches the requested employee — the information exists only `
      + "for employees with committed PL pay stubs in that year",
    );
  }
  return {
    formCode: "PL_PIT11",
    formName: "PIT-11 — Informacja o przychodach z innych źródeł oraz o dochodach i pobranych zaliczkach na podatek dochodowy",
    formNumber: "PIT-11",
    headerFields: [
      { label: "Employee (podatnik)", value: slip.employeeName },
      { label: "Tax year (rok, poz. 4)", value: String(taxYear) },
      {
        label: "Form edition",
        value: "PIT-11(29) box layout (rok 2025) — re-verify box numbers against the 2026-year edition when the Ministry publishes it",
      },
    ],
    boxes: [
      { code: "29", label: "Przychód — należności ze stosunku pracy (E.1, kol. b)", value: slip.przychod },
      { code: "30", label: "Koszty uzyskania przychodu faktycznie uwzględnione (E.1, kol. c)", value: slip.kup },
      { code: "31", label: "Dochód (poz. 29 minus poz. 30)", value: slip.dochod, emphasis: true },
      { code: "33", label: "Zaliczka pobrana przez płatnika (E.1, kol. f)", value: slip.zaliczka, emphasis: true },
      { code: "95", label: "Składki na ubezpieczenia społeczne odliczone od dochodu", value: slip.skladkiSpoleczne },
      { code: "122", label: "Składki na ubezpieczenie zdrowotne pobrane przez płatnika", value: slip.skladkiZdrowotne },
    ],
    notes: [
      "Section E row 1 (art. 31 employer payers). Every figure reads a committed stub — never a recomputation — and the slip's totals tie to the year's committed pay runs to the grosz.",
      "Poz. 32 (treaty-exempt dochód) is not printed: the pack models no double-taxation-treaty exemption, so there is never an exempt amount to file.",
      "Poz. 123 (union dues) is not printed: the engine gives union dues no tax treatment, so no dues figure exists to file.",
      "The 9 % health contribution (poz. 122) is not deductible from tax in 2026 — only KUP and the employee's social contributions reduce the PIT base (art. 32 ust. 4).",
      "PIT-4R (the employer's annual declaration of advances, due to the urząd skarbowy by the end of January) reconciles to these same committed runs: its advances total must equal the sum of poz. 33 across all PIT-11 informations. No PIT-4R is produced here — it is the employer's declaration, not the employee's statement.",
      "ZUS monthly declarations (DRA rozliczeniowa, RCA/RSA imienne — the separate PUE/eZUS channel) are out of scope and are not produced here.",
    ],
  };
}

/**
 * The corrected PIT-11, box by box — what was reported beside what is
 * correct. A PIT-11 is corrected by re-filing the SAME information with
 * poz. 7 marked "korekta informacji" (Ordynacja podatkowa art. 81 — the
 * form's own footnote 8); there is no separate correction form and no
 * cancellation code. Pure: the delta rides the generic correction row, so
 * the amended slip is verifiable without a database.
 */
export async function pit11CorrectionSlip(row: PayrollFilingCorrectionRow): Promise<PayrollFilingSlipData> {
  const boxes = row.changes
    .filter((change) => change.code != null)
    .flatMap((change) => [
      { code: change.code!, label: `${change.label} — as filed`, value: change.previous ?? "—" },
      {
        code: change.code!,
        label: `${change.label} — amended`,
        value: change.current ?? "—",
        emphasis: true,
      },
    ]);
  if (boxes.length === 0) {
    throw new PayrollError(
      `nothing on ${row.label}'s PIT-11 changed — an amended information restating the same `
      + "figures tells the urząd skarbowy nothing and must not be filed",
    );
  }
  return {
    formCode: "PL_PIT11",
    formName: "PIT-11 — Informacja o przychodach (KOREKTA)",
    formNumber: "PIT-11",
    headerFields: [
      ...row.current.headerFields,
      { label: "Cel złożenia (poz. 7)", value: "2 — korekta informacji" },
    ],
    boxes,
    notes: [
      "Only the boxes that changed are restated; every other box on the original information stands.",
      "The amounts are recomputed from committed pay stubs — an amended PIT-11 can never disagree with the payroll subledger it summarizes.",
      "A PIT-11 issued for a person who should never have had one is withdrawn the same way: a korekta restating its boxes at zero — the form carries no cancellation code.",
    ],
  };
}

/**
 * The identity fact a PIT-11 amendment must compare but must never print.
 * A wrong PESEL is one of the commonest reasons an employer corrects, and
 * the operator has to see that it moved. The PESEL itself is sealed on the
 * payroll profile (the pack's employeeIdentifier writer) and stays there:
 * what the snapshot holds is a keyed fingerprint, which proves a change
 * and discloses nothing — the T4 SIN precedent.
 */
export async function pit11ConfidentialFields(
  orgId: string,
  _taxYear: number,
  rowId: string,
): Promise<{ label: string; fingerprint: string }[]> {
  const employeePartyId = rowId;
  if (!PIT11_ROW_UUID_RE.test(employeePartyId)) return [];
  const rows = (await db.execute<{ sin_encrypted: string | null }>(sql`
    select sin_encrypted from employee_payroll_profiles
     where org_id = ${orgId} and employee_party_id = ${employeePartyId}
  `));
  const pesel = unsealSecret(rows.rows[0]?.sin_encrypted ?? null);
  return [{
    label: "PESEL",
    fingerprint: pesel ? keyedFingerprint("pl.pesel", pesel) : "",
  }];
}
