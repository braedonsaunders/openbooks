import { sql } from "drizzle-orm";
import { PayrollError } from "../error.ts";
import { PayrollPackError } from "../payroll-error.ts";
import { resolveStoredEmployerFact } from "../employer-fact-store.ts";
import { CA_OPENING_YTD_FIELDS } from "./opening-ytd.ts";

/**
 * The pay-run lifecycle states, as `pay_runs.run_status` spells them
 * (schema/src/payroll.ts): draft → calculated → committed, with voided as
 * the terminal reversal. This union is the exhaustive switch below — a new
 * lifecycle state breaks the compile, never silently inherits a side.
 */
export type CaExemptionRunStatus = "draft" | "calculated" | "committed" | "voided";

function assertNeverStatus(status: never): never {
  throw new PayrollPackError(
    `CA EHT exemption has no rule for pay-run status "${status}" — `
    + "name the new lifecycle state here before it consumes (or escapes) exemption room",
  );
}

/**
 * Whether stubs on a run in this lifecycle state consume the employer's
 * annual EHT exemption for OTHER runs. Only committed runs do: a draft or
 * calculated run may be abandoned or recalculated, and counting its
 * uncommitted remuneration lets two disjoint-roster drafts each claim the
 * full exemption — recalculating either one then sees the other as prior
 * and both commit over-taxed (the double count this switch exists to stop).
 * A voided run is reversed history and consumes nothing. The run being
 * calculated sequences its own employees through the separate own-document
 * arm in the query below, not through this switch.
 *
 * The SQL below spells the committed arm as a literal (`run_status =
 * 'committed'` — SQL cannot call this function); the unit test pins the two
 * together, so a change here without the query fails loudly.
 */
/**
 * Québec HSF sector classes (TP-1015.F-V s. 5): the rate formula keys off
 * the employer's sector, and the separately authorized 2026
 * agriculture/forestry/fishing exemption zeroes it.
 */
export type QuebecHsfSector = "other" | "primary_manufacturing" | "public" | "exempt_2026";

/**
 * The statutory HSF rate for the employer's year-to-date total payroll:
 * 2026 formulae per Revenu Québec's "Total Payroll
 * Threshold and Health Services Fund Contribution Rate" table — other-sector
 * 1.65% at or under $1M rising by 1.2662 + (0.3838 × payroll ÷ $1M) to
 * 4.26% past $7.8M; primary-and-manufacturing 1.25% rising by
 * 0.8074 + (0.4426 × payroll ÷ $1M) to 4.26%; public sector flat 4.26%.
 * Exact integer-cent arithmetic, half-up to four rate decimals. Only 2026
 * is transcribed — any other year refuses rather than pricing a stale table.
 */
export function quebecHsfRateForPayroll(sector: QuebecHsfSector, totalPayroll: string, year: number): Rate {
  if (year !== 2026) {
    throw new PayrollPackError(
      `QC HSF rate formula is transcribed for 2026 only — update the Revenu Québec table before pricing ${year}`,
    );
  }
  // Year-to-date sums arrive at money scale; the formula keys off whole
  // cents (Revenu Québec thresholds are dollar-exact).
  const cents = toUnits(roundMoney(totalPayroll, 2)) / 100n;
  if (cents < 0n) {
    throw new PayrollPackError(`QC HSF total payroll must be non-negative, got "${totalPayroll}"`);
  }
  // Fixed-4dp statutory rate text on every exit: canonical Rate.
  if (sector === "exempt_2026") return "0.0000" as Rate;
  if (sector === "public") return "4.2600" as Rate;
  const ONE_M = 100_000_000n;
  const CAP = 780_000_000n;
  const FULL = 42600n;
  let rate: bigint;
  if (cents <= ONE_M) {
    rate = sector === "primary_manufacturing" ? 12500n : 16500n;
  } else if (cents > CAP) {
    rate = FULL;
  } else if (sector === "primary_manufacturing") {
    rate = 8074n + (4426n * cents + 50_000_000n) / 100_000_000n;
  } else {
    rate = 12662n + (3838n * cents + 50_000_000n) / 100_000_000n;
  }
  if (rate > FULL) rate = FULL;
  return `${rate / 10000n}.${String(rate % 10000n).padStart(4, "0")}` as Rate;
}

export function ehtExemptionConsumedByRunStatus(status: CaExemptionRunStatus): boolean {
  switch (status) {
    case "committed":
      return true;
    case "draft":
    case "calculated":
    case "voided":
      return false;
    default:
      return assertNeverStatus(status);
  }
}
import {
  add, cmp, mulPercent, mulRatio, neg, roundMoney, sum, toUnits,
} from "../../money/money.ts";
import type { Money, Rate } from "../../money/brands.ts";
import { caPayrollConfig } from "./config.ts";
import type {
  PayrollEmployerLevyContext,
  PayrollEmployerLevyFactors,
  StatutoryAllocation,
} from "../statutory-context.ts";

/**
 * 2026 CNT constants (Revenu Québec, Contribution Related to Labour
 * Standards; LE-39.0.2-V): 0.06% of remuneration to $103,000 per employee.
 */
const CNT_RATE_2026 = "0.06";
const CNT_MAX_2026 = "103000";

/**
 * Phase 8 — CA pack earnings-assessed employer levies: WCB/WSIB, provincial
 * EHT, the Québec health services fund (TP-1015.F-V s. 5), and the Québec
 * contribution related to labour standards (CNT).
 */
export async function applyCaEmployerLevies(
  ctx: PayrollEmployerLevyContext,
): Promise<PayrollEmployerLevyFactors> {
  const {
    tx, orgId, documentId, employeePartyId, employeeName, taxYear, region, lines, pushStatutory,
  } = ctx;
  const config = await caPayrollConfig(orgId, taxYear, ctx.payDate ?? null);

  const grossEarnings = () =>
    sum(lines.filter((l) => l.kind === "earning" && !l.accrualOnly).map((l) => l.amount));

  // Kernel-exact legs throughout (sum / add / mulPercent outputs, or zero):
  // typed Money so the factors struct is proven at every assignment.
  let wcbAmount: Money = "0" as Money;
  let wcbAssessable: Money = "0" as Money;
  let ehtAmount: Money = "0" as Money;
  let ehtEarnings: Money = "0" as Money;
  let hsfAmount: Money = "0" as Money;
  let hsfEarnings: Money = "0" as Money;

  const wcbGroup = (await tx.execute<{ rate_percent: string | null; max_assessable: string | null }>(sql`
    select g.rate_percent, g.max_assessable
      from employee_roles er
      join worker_comp_groups g on g.id = er.worker_comp_group_id and g.org_id = er.org_id and g.is_active
     where er.org_id = ${orgId} and er.party_id = ${employeePartyId} and er.is_active
     limit 1
  `));
  const wcb = wcbGroup.rows[0];
  if (wcb?.rate_percent && cmp(wcb.rate_percent, "0") > 0) {
    // Committed stubs only. A calculated run is a draft that may be abandoned
    // or recalculated, and counting its assessable earnings lets unpaid
    // figures consume the annual cap — the same doctrine `employeeYtd` states
    // for CPP/EI. (The run being calculated keeps its own-document arm below
    // so the exemption still sequences across its own employees.)
    // Pre-adoption assessable earnings ride the opening carry-in, like every
    // other annual ceiling: without it a mid-year adopter re-opens the full
    // group maximum on the first stub.
    const wcbAssessableColumn = CA_OPENING_YTD_FIELDS.find(
      (field) => field.key === "wcbAssessableYtd",
    )!.column;
    const priorAssessable = ((await tx.execute<{ prior: string }>(sql`
      select coalesce((select ${sql.raw(wcbAssessableColumn)} from payroll_opening_balances
                         where org_id = ${orgId} and employee_party_id = ${employeePartyId}
                           and tax_year = ${taxYear}), 0)
             + coalesce(sum((s.factors->>'WCB_EARN')::numeric), 0) as prior
        from pay_stubs s
        join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
       where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
         and s.tax_year = ${taxYear}
         and (r.run_status = 'committed'
              or s.pay_run_document_id = ${documentId})
    `))).rows[0]!.prior;
    const gross = grossEarnings();
    const room = wcb.max_assessable
      ? (cmp(wcb.max_assessable, priorAssessable) > 0 ? add(wcb.max_assessable, neg(priorAssessable)) : "0")
      : gross;
    wcbAssessable = (cmp(gross, room) <= 0 ? gross : room) as Money;
    if (cmp(wcbAssessable, "0") > 0) {
      wcbAmount = mulPercent(wcbAssessable, wcb.rate_percent, 2) as Money;
      // Aggregate tagged earning lines by costing target (project + department):
      // hourly earnings post one line per DAY since dated lookbacks, but WSIB
      // assesses earnings and the stub allocates the premium by project — one
      // split per day-line would multiply WCB lines (four for two projects)
      // while the premium total stays identical. First-appearance order is
      // kept so the last-project remainder rule below stays stable.
      const byTarget = new Map<string, { amount: string; projectId: string; departmentId: string | null }>();
      for (const line of lines) {
        if (line.kind !== "earning" || line.accrualOnly || !line.projectId) continue;
        const key = `${line.projectId}|${line.departmentId ?? ""}`;
        const seen = byTarget.get(key);
        if (seen) seen.amount = add(seen.amount, line.amount);
        else {
          byTarget.set(key, {
            amount: line.amount,
            projectId: line.projectId,
            departmentId: line.departmentId ?? null,
          });
        }
      }
      const splits = [...byTarget.values()];
      const grossUnits = toUnits(gross);
      const allocations: StatutoryAllocation[] = [];
      let allocated = "0";
      const allTagged = cmp(sum(splits.map((s) => s.amount)), gross) === 0;
      for (const [index, split] of splits.entries()) {
        const share = index === splits.length - 1 && allTagged
          ? add(wcbAmount, neg(allocated))
          : roundMoney(mulRatio(wcbAmount, toUnits(split.amount), grossUnits), 2);
        if (cmp(share, "0") === 0) continue;
        allocated = add(allocated, share);
        allocations.push({
          amount: share, projectId: split.projectId, departmentId: split.departmentId,
        });
      }
      const remainder = add(wcbAmount, neg(allocated));
      if (cmp(remainder, "0") !== 0) {
        const last = allocations[allocations.length - 1];
        if (cmp(remainder, "0") < 0 && last) last.amount = add(last.amount, remainder);
        else allocations.push({ amount: remainder });
      }
      const allocatedTotal = sum(allocations.map((a) => a.amount));
      if (cmp(allocatedTotal, wcbAmount) !== 0) {
        throw new PayrollError(
          `WCB allocation ${allocatedTotal} does not equal the ${wcbAmount} premium `
          + `for ${employeeName}`,
        );
      }
      pushStatutory("wcb", "employer_contribution", "WCB/WSIB", wcbAmount, 260, { allocations });
    }
  }

  const eht = config.eht(region);
  if (eht) {
    ehtEarnings = grossEarnings() as Money;
    if (cmp(ehtEarnings, "0") > 0) {
      // Committed runs only (see `ehtExemptionConsumedByRunStatus`, which
      // this literal mirrors — SQL cannot call it): a calculated run is a
      // draft that may be abandoned or recalculated, and counting its
      // uncommitted remuneration lets two disjoint-roster drafts each claim
      // the full exemption, then double-count each other on recalc and both
      // commit over-taxed. The own-document arm sequences the exemption
      // across the employees of the run being calculated in roster order
      // (display_name, party_id — the deterministic order run-calculation
      // uses), so a recalc, which deletes this run's stubs before rewriting
      // them, cannot double count. Across runs the order is commit order:
      // whoever commits first consumes the room, and the commit-time
      // staleness arm (`employerLevyYtd` in readiness.ts) refuses a run
      // calculated before a concurrent commit until it recalculates — that
      // arm, not draft-counting, is what stops two overlapping drafts from
      // both committing with the full exemption.
      //
      // A voided run consumes nothing twice over: its run_status is
      // 'voided' (never 'committed'), and its document is excluded below.
      //
      // Pre-adoption remuneration rides the pack-declared opening carry-in
      // (`ehtRemunerationYtd`), summed across the employer's in-province
      // carry-ins: the exemption is employer-level, so one employee's
      // committed stubs cannot reconstruct what the prior provider paid.
      // Province is the employee's CURRENT payroll province — the best
      // proxy on file for where pre-adoption pay was earned.
      const ehtCarryInColumn = CA_OPENING_YTD_FIELDS.find(
        (field) => field.key === "ehtRemunerationYtd",
      )!.column;
      const priorInProvince = ((await tx.execute<{ prior: string }>(sql`
        select coalesce(sum((s.factors->>'EHT_EARN')::numeric), 0)
               + coalesce((
                   select sum(b.${sql.raw(ehtCarryInColumn)})
                     from payroll_opening_balances b
                    where b.org_id = ${orgId} and b.tax_year = ${taxYear}
                      and exists (
                        select 1 from employee_payroll_profiles prof
                         where prof.org_id = b.org_id
                           and prof.employee_party_id = b.employee_party_id
                           and prof.is_active and prof.province = ${region})
                 ), 0) as prior
          from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
          join documents d on d.id = r.document_id and d.org_id = r.org_id
         where s.org_id = ${orgId} and s.tax_year = ${taxYear} and s.province = ${region}
           and (s.pay_run_document_id = ${documentId} or r.run_status = 'committed')
           and d.status <> 'voided'
      `))).rows[0]!.prior;
      const exemption = eht.annualExemption ?? "0";
      const exemptionLeft = cmp(exemption, priorInProvince) > 0
        ? add(exemption, neg(priorInProvince))
        : "0";
      const taxableRemuneration = cmp(ehtEarnings, exemptionLeft) > 0
        ? add(ehtEarnings, neg(exemptionLeft))
        : "0";
      if (cmp(taxableRemuneration, "0") > 0) {
        ehtAmount = mulPercent(taxableRemuneration, eht.rate, 2) as Money;
        pushStatutory("eht", "employer_contribution", "Employer Health Tax", ehtAmount, 270);
      }
    }
  }

  // Québec health services fund (TP-1015.F-V s. 5): employment income is
  // generally subject, so the stub's gross earnings, with no exemption and
  // no cap. QC-gated twice: the region check below, and the ca_hsf slot
  // which refuses a rate row for any other province at the write boundary.
  // The statutory formula prices the employer's year-to-date rate and each
  // Stub books the cumulative true-up: crossing $1M mid-year
  // reprices prior remuneration, which a flat per-stub rate can never do. No
  // fallback — without a sector class the run refuses instead of mispricing.
  if (region === "QC") {
    const hsf = config.hsf(region);
    if (hsf) {
      hsfEarnings = grossEarnings() as Money;
      if (cmp(hsfEarnings, "0") > 0) {
        const classes = (hsf.sectorOther ? 1 : 0)
          + (hsf.sectorPublic ? 1 : 0)
          + (hsf.sectorPrimaryManufacturing ? 1 : 0)
          + (hsf.sectorExempt2026 ? 1 : 0);
        if (classes > 1) {
          throw new PayrollPackError(
            "QC HSF sector flags are mutually exclusive — set exactly one of sectorOther, "
            + "sectorPublic, sectorPrimaryManufacturing, sectorExempt2026",
          );
        }
        const sector: QuebecHsfSector | null = hsf.sectorOther
          ? "other"
          : hsf.sectorPublic
            ? "public"
            : hsf.sectorPrimaryManufacturing
              ? "primary_manufacturing"
              : hsf.sectorExempt2026
                ? "exempt_2026"
                : null;
        if (sector === null) {
          throw new PayrollPackError(
            "QC HSF needs the employer's sector classification: the statutory rate comes from "
            + "the Revenu Québec total-payroll formula by sector, never from a flat configured rate. "
            + "Set exactly one sector flag on the QC ca_hsf rate (sectorOther, sectorPublic, "
            + "sectorPrimaryManufacturing, or sectorExempt2026) before calculating payroll",
          );
        } else if (sector === "exempt_2026") {
          if (taxYear !== 2026) {
            throw new PayrollPackError(
              `QC HSF 2026 agriculture/forestry/fishing exemption does not cover ${taxYear} — clear the `
              + "exemption or transcribe the year's rule before pricing",
            );
          }
          hsfAmount = "0" as Money;
        } else {
          // Committed runs plus the run being calculated (own-document arm,
          // same sequencing doctrine as the EHT exemption above): a recalc
          // deletes this run's stubs first, so no double count. Voided runs
          // and documents consume and book nothing. Pre-adoption history has
          // no HSF carry-in column yet — a mid-year adopter understates the
          // rate basis, so true up the adoption stub outside the pack until
          // one exists.
          const ytd = (await tx.execute<{ remuneration: string; booked: string }>(sql`
            select coalesce(sum((s.factors->>'HSF_EARN')::numeric), 0) as remuneration,
                   coalesce(sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                                  join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                                 where l.org_id = ${orgId} and l.stub_id = s.id
                                   and l.kind = 'employer_contribution' and pc.system_key = 'hsf')), 0) as booked
              from pay_stubs s
              join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
              join documents d on d.id = r.document_id and d.org_id = r.org_id
             where s.org_id = ${orgId} and s.tax_year = ${taxYear} and s.province = ${region}
               and (r.run_status = 'committed' or s.pay_run_document_id = ${documentId})
               and d.status <> 'voided'
          `)).rows[0]!;
          const ytdBase = add(ytd.remuneration, hsfEarnings);
          const rate = quebecHsfRateForPayroll(sector, ytdBase, taxYear);
          const cumulative = mulPercent(ytdBase, rate, 2);
          hsfAmount = (cmp(cumulative, ytd.booked) > 0 ? add(cumulative, neg(ytd.booked)) : "0") as Money;
        }
        if (cmp(hsfAmount, "0") > 0) {
          pushStatutory("hsf", "employer_contribution", "Health Services Fund", hsfAmount, 280);
        }
      }
    }
  }

  // Québec contribution related to labour standards (CNT): 0.06% of the
  // remuneration subject to $103,000 per employee per year for 2026, minus
  // the statutory exemption classes (LE-39.0.2-V; RQ contribution page).
  // Employment income is generally subject, so the stub's gross earnings.
  // The cap binds committed stubs plus the run being calculated (WCB shape:
  // committed-only counting lets two drafts each claim the full room).
  // Pre-adoption remuneration has no CNT carry-in column yet: a mid-year
  // adopter re-opens the full $103,000 room on the first stub (bounded
  // over-accrual, high earners only) until the column lands.
  let cntAmount: Money = "0" as Money;
  let cntEarnings: Money = "0" as Money;
  if (region === "QC") {
    if (taxYear !== 2026) {
      throw new PayrollPackError(
        `Québec CNT has no transcribed rate for ${taxYear}: 2026 prices 0.06% to $103,000 per employee `
        + "(Revenu Québec). Transcribe the year's rate and maximum before calculating.",
      );
    }
    const runSubsidiary = (await tx.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from documents where org_id = ${orgId} and id = ${documentId}
    `)).rows[0]?.subsidiary_id ?? null;
    const cntExemption = await resolveStoredEmployerFact({
      tx,
      orgId,
      subsidiaryId: runSubsidiary,
      country: "CA",
      factKey: "cnt_exemption",
      asOf: ctx.payDate ?? `${taxYear}-12-31`,
    });
    if (cntExemption === "none") {
      const priorCnt = ((await tx.execute<{ prior: string }>(sql`
        select coalesce(sum((s.factors->>'CNT_EARN')::numeric), 0) as prior
          from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
         where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
           and s.tax_year = ${taxYear}
           and (r.run_status = 'committed'
                or s.pay_run_document_id = ${documentId})
      `))).rows[0]!.prior;
      const gross = grossEarnings();
      const room = cmp(CNT_MAX_2026, priorCnt) > 0 ? add(CNT_MAX_2026, neg(priorCnt)) : "0";
      cntEarnings = (cmp(gross, room) <= 0 ? gross : room) as Money;
      if (cmp(cntEarnings, "0") > 0) {
        cntAmount = mulPercent(cntEarnings, CNT_RATE_2026, 2) as Money;
        pushStatutory("cnt", "employer_contribution", "Contribution related to labour standards (CNT)", cntAmount, 285);
      }
    }
  }

  return { wcbAmount, wcbAssessable, ehtAmount, ehtEarnings, hsfAmount, hsfEarnings, cntAmount, cntEarnings };
}
