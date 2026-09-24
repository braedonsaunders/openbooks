import { assertPayrollCountryKnown } from "../../country.ts";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, type SqlExecutor } from "../../../platform/db.ts";
import { add, cmp, normalizeMoney } from "../../../money/money.ts";
import { RATES_2026_JAN } from "../rates.ts";
import { PayrollError } from "../../error.ts";
import type { PayrollFilingData } from "../../filing-registry.ts";
import { openingProgramBasesByEmployee } from "../../opening-balances.ts";
import {
  carryOpeningYearEndYtd,
  seedOpeningOnlySlips,
  type OpeningYearEndYtd,
} from "../../yearend.ts";

// A return is a statutory artifact, so all of its source reads must come from
// one pinned snapshot. Keep a dedicated handle: callers such as filing pages
// may already be inside a request transaction whose isolation level was chosen
// before this function was reached, and the application's `db` proxy would
// otherwise reuse that transaction instead of applying repeatable-read.
const rl1Db = drizzle({ client: pool });

/**
 * RL-1 slip data assembly — Revenu Québec's "Revenus d'emploi et revenus
 * divers", the Québec-side year-end slip a QC employee receives ALONGSIDE
 * their T4. Built from committed stubs (the payroll subledger of record)
 * exactly as `t4Slips` is, so every box reconciles to stub factors.
 *
 * Box definitions transcribed from the Guide du relevé 1 (RL-1.G), Part 5
 * ("Comment remplir le relevé 1") — the published RQ guide, not memory:
 *   A    Revenus d'emploi (s. 5.3)
 *   B.A  Cotisation au RRQ — base + first additional (s. 5.4)
 *   B.B  Cotisation supplémentaire au RRQ — second additional (s. 5.4)
 *   C    Cotisation à l'assurance emploi (s. 5.5)
 *   E    Impôt du Québec retenu (s. 5.7)
 *   F    Cotisation syndicale (s. 5.8)
 *   G    Salaire admissible au RRQ (s. 5.9) — capped at the year's maximum
 *        pensionable earnings when only B.A has an amount, and at the
 *        ADDITIONAL maximum pensionable earnings when B.B does too
 *   H    Cotisation au RQAP (s. 5.10)
 *   I    Salaire admissible au RQAP (s. 5.11) — capped at the year's QPIP
 *        maximum insurable earnings
 *
 * Boxes the payroll data cannot honestly populate are OMITTED, not zeroed
 * with a guess, and named in `RL1_UNSUPPORTED_BOXES`:
 *   D (RPP contribution only) — the component model's 'pension_f' treatment
 *     is TP-1015.F-V's whole factor-F class (RPP + RRSP + VRSP/PRPP + FHSA
 *     + …), and box D takes strictly RPP; reporting the class as the box
 *     would overstate D for any employee with an RRSP component. The T4
 *     builder omits its box 20 for the same reason.
 *   J–W and the box-O codes — benefit/commission/tip attributions no stub
 *     line carries today.
 *
 * The RL-1 is filed under the employer's Revenu Québec identification
 * number — a DIFFERENT registration from the CRA payroll (RP) program
 * account every other Canadian filing here groups by. That identity is
 * tenant configuration (see payroll-rl1xml.ts); an org holds one, so the
 * year's slips assemble into ONE return. Employers filing under several RQ
 * numbers need an RQ program type on payroll_filing_accounts first — a named
 * gap, not an approximation.
 */

const num = (value: unknown): string => (value == null ? "0" : String(value));

/** Named for the year-end surface, so omission is published, never implied. */
export const RL1_UNSUPPORTED_BOXES =
  "RL-1 boxes D (RPP-only contributions) and J–W (benefit, commission and tip "
  + "attributions) are not populated: the payroll data cannot attribute them "
  + "without guessing. Enter them on the slips in Revenu Québec's services if "
  + "they apply.";

/**
 * Statutory caps for the RL-1 boxes, per tax year. REFUSES an unknown year —
 * same discipline as `caYearCaps` and `ratesForPayDate`: an uncapped box G/I
 * silently misstates pensionable and insurable salary on every slip.
 *
 * 2026 values (Guide RL-1.G s. 5.9/5.11 rule, TP-1015.F-V (2026-01) p. 7
 * amounts): YMPE 74,600; additional maximum (YAMPE) 85,000; QPIP maximum
 * insurable earnings 103,000.
 */
export function rl1YearCaps(taxYear: number): {
  ympe: string; yampe: string; qpipMie: string;
} {
  if (taxYear === 2026) {
    return {
      ympe: RATES_2026_JAN.qpp.ympe,
      yampe: RATES_2026_JAN.qpp.yampe,
      qpipMie: RATES_2026_JAN.qpip.mie,
    };
  }
  throw new PayrollError(
    `no Revenu Québec maximums for tax year ${taxYear} — RL-1 boxes G and I cannot be capped. `
    + "Add the year to engine/src/payroll/canada/quebec/rl1.ts (rl1YearCaps) alongside the TP-1015.F-V edition",
  );
}

export interface Rl1Slip {
  employeePartyId: string;
  employeeName: string;
  /** Box A — employment income (taxable earnings on QC stubs). */
  boxA: string;
  /** Box B.A — QPP contribution (base + first additional). */
  boxBA: string;
  /** Box B.B — second additional QPP contribution. */
  boxBB: string;
  /** Box C — EI premium (at the Québec-reduced rate). */
  boxC: string;
  /** Box E — Québec income tax withheld (qc_income_tax lines). */
  boxE: string;
  /** Box F — union dues withheld. */
  boxF: string;
  /** Box G — QPP pensionable salary, capped (YMPE, or YAMPE when B.B > 0). */
  boxG: string;
  /** Box H — QPIP premium. */
  boxH: string;
  /** Box I — QPIP eligible salary, capped at the QPIP maximum. */
  boxI: string;
  stubCount: number;
}

/** The raw per-employee aggregates `rl1Slips` reads from committed stubs. */
export interface Rl1SlipAggregates {
  employeePartyId: string;
  employeeName: string;
  taxableIncome: string;
  qpp: string;
  qpp2: string;
  ei: string;
  qpip: string;
  qcIncomeTax: string;
  unionDues: string;
  pensionable: string;
  insurable: string;
  /** The QPIP program's own insurable base (box I source), never the EI base. */
  qpipInsurable: string;
  stubCount: number;
}

/**
 * Pure box mapping, separated from the SQL so the cap rules are testable
 * without a database (the `capAnnualEarnings` pattern).
 *
 * Box G's cap depends on box B.B (RL-1.G s. 5.9): the maximum pensionable
 * earnings when only B.A has an amount, the ADDITIONAL maximum when B.B does
 * too. Box I caps at the QPIP maximum insurable earnings (s. 5.11). Both are
 * exact string-money comparisons — no floats.
 */
export function assembleRl1Slip(
  row: Rl1SlipAggregates,
  caps: { ympe: string; yampe: string; qpipMie: string },
): Rl1Slip {
  const capMoney = (value: string, cap: string) => (cmp(value, cap) > 0 ? cap : value);
  const hasSecondAdditional = cmp(row.qpp2, "0") > 0;
  return {
    employeePartyId: row.employeePartyId,
    employeeName: row.employeeName,
    boxA: row.taxableIncome,
    boxBA: row.qpp,
    boxBB: row.qpp2,
    boxC: row.ei,
    boxE: row.qcIncomeTax,
    boxF: row.unionDues,
    boxG: capMoney(row.pensionable, hasSecondAdditional ? caps.yampe : caps.ympe),
    boxH: row.qpip,
    // Box I is the QPIP program's OWN insurable base capped at the QPIP
    // maximum — never the EI base (box C's source).
    boxI: capMoney(row.qpipInsurable, caps.qpipMie),
    stubCount: row.stubCount,
  };
}

/**
 * One RL-1 slip per employee with committed Québec-province stubs in the
 * year. `pay_stubs.province` is the per-stub snapshot, so a mid-year
 * QC↔elsewhere mover contributes exactly their Québec periods — the same
 * per-province attribution the T4 builder performs, seen from the RQ side.
 */
async function rl1SlipsInSnapshot(
  runner: SqlExecutor,
  orgId: string,
  taxYear: number,
): Promise<Rl1Slip[]> {
  await assertPayrollCountryKnown(runner, orgId, taxYear);
  const caps = rl1YearCaps(taxYear);
  const rows = (await runner.execute<Record<string, unknown>>(sql`
    with committed as (
      select s.*
        from pay_stubs s
        join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
       where s.org_id = ${orgId} and s.tax_year = ${taxYear}
         and s.country = 'CA' and s.province = 'QC'
    )
    select c.employee_party_id, p.display_name,
           count(*)::int as stub_count,
           sum(c.pensionable_earnings) as pensionable,
           sum(c.insurable_earnings) as insurable,
           sum((c.factors->>'C')::numeric) as qpp,
           sum(coalesce((c.factors->>'C2')::numeric, 0)) as qpp2,
           sum((c.factors->>'EI')::numeric) as ei,
           sum(coalesce((c.factors->>'QPIP')::numeric, 0)) as qpip,
           -- The QPIP program's own insurable base (see the T4 reader for
           -- the legacy fallback rationale: pre-program-model stubs read
           -- their single accumulated base exactly).
           sum(coalesce((c.factors->>'IE_QPIP')::numeric, c.insurable_earnings)) as qpip_insurable,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'earning'
                  and coalesce(pc.taxable, true))) as taxable_income,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'deduction'
                  and pc.system_key = 'qc_income_tax')) as qc_income_tax,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'deduction'
                  and pc.tax_treatment = 'union_dues')) as union_dues
      from committed c
      join parties p on p.id = c.employee_party_id and p.org_id = ${orgId}
     group by c.employee_party_id, p.display_name
     order by p.display_name
  `));

  const stubAggregates: Rl1SlipAggregates[] = rows.rows.map((row) => ({
    employeePartyId: String(row.employee_party_id),
    employeeName: String(row.display_name),
    taxableIncome: num(row.taxable_income),
    qpp: num(row.qpp),
    qpp2: num(row.qpp2),
    ei: num(row.ei),
    qpip: num(row.qpip),
    qcIncomeTax: num(row.qc_income_tax),
    unionDues: num(row.union_dues),
    pensionable: num(row.pensionable),
    insurable: num(row.insurable),
    qpipInsurable: num(row.qpip_insurable),
    stubCount: Number(row.stub_count ?? 0),
  }));

  // Mid-year adopters: fold the prior provider's year-to-date into the
  // aggregates BEFORE the annual maxima are applied, exactly as the T4 folds
  // its carry-in before `capAnnualEarnings`. An opening-only employee seeds a
  // zero slip only on Québec-profile evidence, and the carry lands once per
  // employee — the RL-1 is already one slip per employee, so no room-sharing
  // across slips is needed.
  const openings = await openingRl1YtdByEmployee(runner, orgId, taxYear);
  const profiles = await openingRl1Profiles(runner, orgId, [...openings.keys()]);
  // An opening-only employee seeds a zero slip only on Québec-profile
  // evidence: the RL-1 is Québec employment, and an opening with no QC
  // evidence anywhere must not conjure a Québec slip. (The T4/W-2 still carry
  // that employee on their own returns.)
  const qcOpeningIds = [...openings.keys()].filter(
    (id) => profiles.get(id)?.province === "QC",
  );
  const seeded = seedOpeningOnlySlips(stubAggregates, qcOpeningIds, (employeePartyId) => ({
    employeePartyId,
    employeeName: profiles.get(employeePartyId)?.name ?? employeePartyId,
    taxableIncome: "0", qpp: "0", qpp2: "0", ei: "0", qpip: "0",
    qcIncomeTax: "0", unionDues: "0", pensionable: "0", insurable: "0",
    qpipInsurable: "0",
    stubCount: 0,
  }));
  const carried = carryOpeningYearEndYtd(seeded, openings, openingYtdIntoRl1Aggregates);
  return carried.map((row) => assembleRl1Slip(row, caps));
}

/**
 * Fold one employee's pre-adoption year-to-date into their RL-1 aggregates —
 * the same carry-in the T4 (`openingYtdIntoT4Slip`) and W-2 builders perform,
 * so a mid-year adopter's RL-1 reconciles to the prior provider's YTD report
 * exactly as their T4 does.
 *
 * Carried: taxable (box A), QPP/QPP2 (boxes B.A/B.B — `cpp_ytd` is the QPP
 * column for Québec employment, as the T4's own box-17 mapping reads it), EI
 * premiums (box C), QPIP premiums (box H), and the QPP-pensionable base (box
 * G, capped with the stubs by `assembleRl1Slip` below, never after it).
 *
 * Deliberately absent, like the T4's box 44: Québec income tax (box E —
 * `tax_ytd` is the T4-box-22 federal money, not the Québec slice) and union
 * dues (box F — the model collects no union-dues YTD). Box I IS carried:
 * the QPIP program's OWN insurable base arrives in `programBasesYtd` under
 * the pack-declared program key and is capped at the QPIP maximum with the
 * stubs below — never the EI base (`insurable_ytd`), which would invent a
 * Québec return. Absent key means no pre-adoption QPIP base, never a guess.
 */
export function openingYtdIntoRl1Aggregates(
  row: Rl1SlipAggregates,
  opening: OpeningYearEndYtd,
): Rl1SlipAggregates {
  return {
    ...row,
    taxableIncome: add(row.taxableIncome, opening.taxableYtd),
    qpp: add(row.qpp, opening.cppYtd),
    qpp2: add(row.qpp2, opening.cpp2Ytd),
    ei: add(row.ei, opening.eiYtd),
    qpip: add(row.qpip, opening.qpipYtd),
    pensionable: add(row.pensionable, opening.pensionableYtd),
    qpipInsurable: add(row.qpipInsurable, opening.programBasesYtd["qpip"] ?? "0"),
  };
}

/**
 * The statutory carry-ins for one org-year, keyed by Canadian-pack employee —
 * the RL-1's read of the same `payroll_opening_balances` rows the T4 folds
 * in. Queried through the caller's snapshot runner, never a second session:
 * the RL-1 assembles every source inside one repeatable-read transaction.
 */
async function openingRl1YtdByEmployee(
  runner: SqlExecutor,
  orgId: string,
  taxYear: number,
): Promise<Map<string, OpeningYearEndYtd>> {
  const rows = (await runner.execute<{
    employee_party_id: string;
    pensionable_ytd: unknown; insurable_ytd: unknown;
    cpp_ytd: unknown; cpp2_ytd: unknown; ei_ytd: unknown; qpip_ytd: unknown;
    taxable_ytd: unknown; tax_ytd: unknown;
  }>(sql`
    select b.employee_party_id,
           b.pensionable_ytd, b.insurable_ytd, b.cpp_ytd, b.cpp2_ytd, b.ei_ytd, b.qpip_ytd,
           b.taxable_ytd, b.tax_ytd
      from payroll_opening_balances b
      -- Strict country match, never a coalesce default: an opening whose
      -- employee has no profile row is refused by the unknown-country guard
      -- before this reader runs. (A profile row always carries a country.)
      join employee_payroll_profiles prof
        on prof.org_id = b.org_id and prof.employee_party_id = b.employee_party_id
       and prof.country = 'CA'
     where b.org_id = ${orgId} and b.tax_year = ${taxYear}
       and (
         coalesce(b.pensionable_ytd, 0) <> 0 or coalesce(b.insurable_ytd, 0) <> 0
         or coalesce(b.cpp_ytd, 0) <> 0 or coalesce(b.cpp2_ytd, 0) <> 0
         or coalesce(b.ei_ytd, 0) <> 0 or coalesce(b.qpip_ytd, 0) <> 0
         or coalesce(b.taxable_ytd, 0) <> 0 or coalesce(b.tax_ytd, 0) <> 0
         -- A program-only carry-in still seeds slips: its base feeds box I
         -- with no statutory column alongside.
         or exists (
           select 1 from payroll_opening_program_bases pb
            where pb.org_id = b.org_id and pb.employee_party_id = b.employee_party_id
              and pb.tax_year = b.tax_year and coalesce(pb.insurable_ytd, 0) <> 0
         )
       )
  `));
  // Through the caller's snapshot runner, never a second session (see above).
  const programs = await openingProgramBasesByEmployee(orgId, taxYear, runner);
  return new Map(rows.rows.map((row) => [row.employee_party_id, {
    pensionableYtd: normalizeMoney(String(row.pensionable_ytd ?? "0")),
    insurableYtd: normalizeMoney(String(row.insurable_ytd ?? "0")),
    cppYtd: normalizeMoney(String(row.cpp_ytd ?? "0")),
    cpp2Ytd: normalizeMoney(String(row.cpp2_ytd ?? "0")),
    eiYtd: normalizeMoney(String(row.ei_ytd ?? "0")),
    qpipYtd: normalizeMoney(String(row.qpip_ytd ?? "0")),
    taxableYtd: normalizeMoney(String(row.taxable_ytd ?? "0")),
    taxYtd: normalizeMoney(String(row.tax_ytd ?? "0")),
    // RL-1 is Québec employment: US FICA withholding never applies here.
    ficaWithheldYtd: "0",
    programBasesYtd: programs.get(row.employee_party_id) ?? {},
  }]));
}

/**
 * Display names and employment provinces for opening-only employees, from the
 * same snapshot. Only Québec-profile employees can seed an RL-1 slip: the
 * slip is Québec employment, and an opening with no QC evidence anywhere must
 * not conjure one.
 */
async function openingRl1Profiles(
  runner: SqlExecutor,
  orgId: string,
  employeeIds: readonly string[],
): Promise<Map<string, { name: string; province: string }>> {
  if (employeeIds.length === 0) return new Map();
  const rows = (await runner.execute<{
    employee_party_id: string; display_name: string; province: string | null;
  }>(sql`
    select p.id as employee_party_id, p.display_name,
           coalesce(prof.province, '') as province
      from parties p
      -- Strict country match: a missing profile row yields no province, so an
      -- opening with no QC evidence anywhere still conjures no Québec slip.
      left join employee_payroll_profiles prof
        on prof.org_id = p.org_id and prof.employee_party_id = p.id
       and prof.country = 'CA'
     where p.org_id = ${orgId} and p.id in (${sql.join(employeeIds.map((id) => sql`${id}`), sql`, `)})
  `));
  return new Map(rows.rows.map((row) => [row.employee_party_id, {
    name: row.display_name,
    province: row.province ?? "",
  }]));
}

export async function rl1Slips(orgId: string, taxYear: number): Promise<Rl1Slip[]> {
  return rl1Db.transaction(
    (tx) => rl1SlipsInSnapshot(tx, orgId, taxYear),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * RL-1 summary (RLZ-1.S worksheet) totals. The employer QPP/QPIP shares come
 * from the employer_contribution stub lines of the same Québec stubs, so the
 * summary always reconciles to the slips it accompanies.
 *
 * `gaps` names the RLZ-1.S lines this product does NOT produce, rather than
 * printing zeros an employer might file: the health services fund annual
 * total (per-stub HSF accrues at the tenant-entered QC rate, but the RLZ-1.S
 * annual reconciliation is not produced), the CNT labour-standards
 * levy, the WSDRF training levy, and the year's remittances made to Revenu
 * Québec. The last is a reporting boundary, not a tracking gap: RQ
 * remittance bills are dated and tracked per destination from the RQ schedule
 * (see Payroll → Remittances), but this summary does not reconcile
 * remittances-made totals against them.
 */
export interface Rl1SummaryTotals {
  slips: number;
  boxA: string;
  boxBA: string;
  boxBB: string;
  boxC: string;
  boxE: string;
  boxF: string;
  boxG: string;
  boxH: string;
  boxI: string;
  employerQpp: string;
  employerQpip: string;
  gaps: string[];
}

export const RLZ1S_GAPS = [
  "health services fund annual total is not reconciled on this summary — per-stub HSF accrues "
  + "at the tenant-entered QC rate (TP-1015.F-V s. 5)",
  "labour standards (CNT) and WSDRF training contributions are not computed",
  "remittances made to Revenu Québec during the year are not reconciled on this summary — " +
    "Payroll → Remittances dates and tracks each RQ bill from the RQ schedule",
];

async function rl1SummaryInSnapshot(
  runner: SqlExecutor,
  orgId: string,
  taxYear: number,
  slips: readonly Rl1Slip[],
): Promise<Rl1SummaryTotals> {
  const employer = (await runner.execute<{ employer_qpp: string | null; employer_qpip: string | null }>(sql`
    select
      sum(case when pc.system_key in ('cpp', 'cpp2') then l.amount else 0 end) as employer_qpp,
      sum(case when pc.system_key = 'qpip' then l.amount else 0 end) as employer_qpip
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
     where l.org_id = ${orgId} and s.tax_year = ${taxYear} and s.province = 'QC'
       -- A null component country is SHARED baseline, not an unknown to
       -- default: shared rows apply to every pack's employees.
       and l.kind = 'employer_contribution' and (pc.country is null or pc.country = 'CA')
  `));
  const total = (pick: (slip: Rl1Slip) => string) =>
    slips.reduce((acc, slip) => add(acc, pick(slip)), "0");
  return {
    slips: slips.length,
    boxA: total((s) => s.boxA),
    boxBA: total((s) => s.boxBA),
    boxBB: total((s) => s.boxBB),
    boxC: total((s) => s.boxC),
    boxE: total((s) => s.boxE),
    boxF: total((s) => s.boxF),
    boxG: total((s) => s.boxG),
    boxH: total((s) => s.boxH),
    boxI: total((s) => s.boxI),
    employerQpp: num(employer.rows[0]?.employer_qpp),
    employerQpip: num(employer.rows[0]?.employer_qpip),
    gaps: [...RLZ1S_GAPS],
  };
}

export async function rl1Summary(orgId: string, taxYear: number): Promise<Rl1SummaryTotals> {
  return rl1Db.transaction(
    async (tx) => {
      const slips = await rl1SlipsInSnapshot(tx, orgId, taxYear);
      return rl1SummaryInSnapshot(tx, orgId, taxYear, slips);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** The year's RL-1 return: every QC slip under the org's RQ identification. */
export interface Rl1Return {
  /** The employer's Revenu Québec identification number, when configured
   *  (orgs.settings.payroll.rl1Transmitter.identificationNumber). */
  identificationNumber: string | null;
  slips: Rl1Slip[];
  summary: Rl1SummaryTotals;
}

export async function rl1Return(orgId: string, taxYear: number): Promise<Rl1Return> {
  return rl1Db.transaction(
    async (tx) => {
      const cfg = (await tx.execute<{ id_number: string | null }>(sql`
        select settings#>>'{payroll,rl1Transmitter,identificationNumber}' as id_number
          from orgs where id = ${orgId}
      `));
      const slips = await rl1SlipsInSnapshot(tx, orgId, taxYear);
      return {
        identificationNumber: cfg.rows[0]?.id_number ?? null,
        slips,
        summary: await rl1SummaryInSnapshot(tx, orgId, taxYear, slips),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * The year-end filing population, typed against the filing registry so the
 * CA pack declaration registers it as-is; that declaration lives in
 * engine/src/payroll/canada/filings.ts.
 */
export async function rl1Population(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  return rl1Db.transaction(
    async (tx) => {
      const slips = await rl1SlipsInSnapshot(tx, orgId, taxYear);
      const summary = await rl1SummaryInSnapshot(tx, orgId, taxYear, slips);
      return {
        rowKey: "employeePartyId",
        columns: [
          { key: "employee", label: "Employee" },
          { key: "boxA", label: "Box A income", align: "right", money: true },
          { key: "boxB", label: "Box B.A/B.B QPP", align: "right", money: true },
          { key: "boxC", label: "Box C EI", align: "right", money: true },
          { key: "boxE", label: "Box E Québec tax", align: "right", money: true },
          { key: "boxG", label: "Box G QPP salary", align: "right", money: true },
          { key: "boxH", label: "Box H QPIP", align: "right", money: true },
          { key: "boxI", label: "Box I QPIP salary", align: "right", money: true },
          { key: "boxF", label: "Box F dues", align: "right", money: true },
        ],
        rows: slips.map((slip) => ({
          employeePartyId: slip.employeePartyId,
          employee: slip.employeeName,
          boxA: slip.boxA,
          // B.A + B.B together, as the T4 population shows 16 + 16A.
          boxB: add(slip.boxBA, slip.boxBB),
          boxC: slip.boxC,
          boxE: slip.boxE,
          boxG: slip.boxG,
          boxH: slip.boxH,
          boxI: slip.boxI,
          boxF: slip.boxF,
        })),
        totals: [
          { label: "Slips", value: String(summary.slips) },
          { label: "Box A employment income", value: summary.boxA, money: true },
          {
            label: "QPP (employee + employer)",
            value: add(add(summary.boxBA, summary.boxBB), summary.employerQpp),
            money: true,
          },
          {
            label: "QPIP (employee + employer)",
            value: add(summary.boxH, summary.employerQpip),
            money: true,
          },
          { label: "Québec income tax", value: summary.boxE, money: true },
        ],
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
