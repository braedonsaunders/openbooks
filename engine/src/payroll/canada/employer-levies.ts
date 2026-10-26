import { canonicalDecimal } from "../../money/exact-decimal.ts";
import { sql } from "drizzle-orm";
import { PayrollError } from "../error.ts";
import { PayrollPackError } from "../payroll-error.ts";
import { resolveStoredEmployerFact } from "../employer-fact-store.ts";
import { undecidedWorkerCompError } from "../employee-worker-comp.ts";
import {
  resolveStatutoryHistoryScope,
  employerScopedStatutoryStubs,
  requireStatutoryHistoryFactors,
} from "../statutory-history-scope.ts";
import {
  employeeOpeningLevyAmount,
  readEmployeeOpeningLevySources,
  requireEmployerOpeningLevySources,
} from "../opening-levy-source-reader.ts";
import {
  EMPLOYER_LEVY_PROGRAMS,
  parseEmployerLevyAdjustmentEvidence,
} from "../run-levy-adjustment-evidence.ts";

/**
 * The pay-run lifecycle states, as `pay_runs.run_status` spells them
 * (schema/src/payroll.ts): draft → calculated → committed, with voided as
 * the terminal reversal. This union is the exhaustive switch below — a new
 * lifecycle state breaks the compile, never silently inherits a side.
 */
export type CaExemptionRunStatus = "draft" | "calculated" | "committed" | "voided";

function assertNeverStatus(status: never): never {
  throw new PayrollPackError(
    `CA EHT exemption has no rule for pay-run status "${status}" — ` +
      "name the new lifecycle state here before it consumes (or escapes) exemption room",
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
export function quebecHsfRateForPayroll(
  sector: QuebecHsfSector,
  totalPayroll: string,
  year: number,
): Rate {
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
  add,
  cmp,
  mulPercent,
  mulRatio,
  neg,
  roundMoney,
  sum,
  toUnits,
} from "../../money/money.ts";
import type { Money, Rate } from "../../money/brands.ts";
import { caPayrollConfig } from "./config.ts";
import type {
  PayrollEmployerLevyContext,
  PayrollEmployerLevyFactors,
  StatutoryAllocation,
} from "../statutory-context.ts";

/** Per-period employer levies are priced at ledger precision (four places)
 *  and then rounded to the cent, as payroll bureaus hold premium amounts. */
function ledgerPrecisionLevy(base: string, ratePercent: string): Money {
  return roundMoney(mulPercent(base, ratePercent, 4), 2) as Money;
}

/**
 * 2026 CNT constants (Revenu Québec, Contribution Related to Labour
 * Standards; LE-39.0.2-V): 0.06% of remuneration to $103,000 per employee.
 */
const CNT_RATE_2026 = "0.06";
const CNT_MAX_2026 = "103000";

/**
 * One levy key's assessable base: the earning lines assessable for it.
 * Applicability rides the lines from the component's effective-dated
 * statutory treatment
 * (absent key means assessable, matching the sibling flags' default-true);
 * a non-taxable earning type defaults to excluded through its STORED
 * exclusions, never through a rule here. Accrual-only lines accrue no
 * premium. Pure, so the exclusion semantics are verifiable without a
 * database.
 */
export function levyAssessableBase(
  lines: readonly Pick<
    PayrollEmployerLevyContext["lines"][number],
    "kind" | "amount" | "accrualOnly" | "programApplicability"
  >[],
  programKey: string,
): string {
  return sum(
    lines
      .filter(
        (l) =>
          l.kind === "earning" && !l.accrualOnly && (l.programApplicability?.[programKey] ?? true),
      )
      .map((l) => l.amount),
  );
}

/**
 * Phase 8 — CA pack earnings-assessed employer levies: WCB/WSIB, provincial
 * EHT, the Québec health services fund (TP-1015.F-V s. 5), and the Québec
 * contribution related to labour standards (CNT).
 */
export async function applyCaEmployerLevies(
  ctx: PayrollEmployerLevyContext,
): Promise<PayrollEmployerLevyFactors> {
  const {
    tx,
    orgId,
    documentId,
    employeePartyId,
    employeeName,
    taxYear,
    region,
    lines,
    pushStatutory,
  } = ctx;
  const historyScope = await resolveStatutoryHistoryScope(tx, {
    orgId,
    documentId,
    taxYear,
    subsidiaryId: ctx.subsidiaryId ?? null,
    country: "CA",
  });
  const config = await caPayrollConfig(orgId, taxYear, ctx.payDate ?? null);

  // Each levy assesses its OWN earnings base (see `levyAssessableBase`
  // below): the earning lines assessable for that levy key.
  const assessableFor = (programKey: string) => levyAssessableBase(lines, programKey);

  // Kernel-exact legs throughout (sum / add / mulPercent outputs, or zero):
  // typed Money so the factors struct is proven at every assignment.
  let wcbAmount: Money = "0" as Money;
  let wcbAssessable: Money = "0" as Money;
  let ehtAmount: Money = "0" as Money;
  let ehtEarnings: Money = "0" as Money;
  let hsfAmount: Money = "0" as Money;
  let hsfEarnings: Money = "0" as Money;

  // A current inactive employee role does not exempt earnings on an already
  // selected historical or final-payment run from its retained classification.
  const workerCompGroupId =
    ctx.workerCompGroupId === undefined
      ? ((
          await tx.execute<{ id: string | null }>(
            sql`
        select public.payroll_worker_comp_group_at(${orgId}::uuid, ${employeePartyId}::uuid, coalesce(${ctx.payDate ?? null}::date, current_date))::text as id
      `,
            "objects",
          )
        )[0]?.id ?? null)
      : ctx.workerCompGroupId;
  const wcb =
    workerCompGroupId === null
      ? undefined
      : (
          await tx.execute<{ rate_percent: string | null; max_assessable: string | null }>(
            sql`
        select rate_percent, max_assessable from worker_comp_groups
         where org_id=${orgId} and id=${workerCompGroupId} for share
      `,
            "objects",
          )
        )[0];
  if (
    workerCompGroupId &&
    (!wcb ||
      wcb.rate_percent === null ||
      cmp(wcb.rate_percent, "0") < 0 ||
      (wcb.max_assessable !== null && cmp(wcb.max_assessable, "0") < 0))
  ) {
    throw new PayrollError(
      `${employeeName}: the dated worker-compensation group has no valid configured rate or assessable ceiling — review its rate and ceiling in Company Setup → Worker compensation groups before calculating.`,
    );
  }
  // Audited employer-only issued levy amounts recorded on this run. The
  // operator states the exact issued premium; calculation books it exactly
  // beside the native assessment of the run's own lines. It records no
  // assessable earnings and re-prices nothing: dated assessability policy,
  // annual maxima and exemptions apply to the run's own lines exactly as
  // they would without it. Any employer-contribution levy adjustment
  // without its audited evidence refuses rather than booking an
  // unexplained amount.
  const levyAdjustmentRows = await tx.execute<{
    id: string;
    amount: string;
    note: string | null;
    system_key: string;
    is_active: boolean;
    country: string | null;
  }>(
    sql`
    select a.id::text, a.amount::text as amount, a.note, c.system_key, c.is_active, c.country
      from pay_run_adjustments a
      join pay_components c on c.org_id=a.org_id and c.id=a.component_id
     where a.org_id=${orgId} and a.pay_run_document_id=${documentId}
       and a.employee_party_id=${employeePartyId} and a.adjustment_type='line'
       and c.kind='employer_contribution' and c.system_key in ('eht', 'wcb')
     order by a.created_at, a.id
  `,
    "objects",
  );
  let wcbAdjustmentAmount: Money = "0" as Money;
  let ehtAdjustmentAmount: Money = "0" as Money;
  for (const row of levyAdjustmentRows) {
    const evidence = parseEmployerLevyAdjustmentEvidence(row.note);
    if (
      !evidence ||
      evidence.requestId !== row.id ||
      !row.is_active ||
      row.country !== "CA" ||
      canonicalDecimal(canonicalDecimal(row.amount, 4), 2) === null ||
      cmp(row.amount, "0") <= 0 ||
      EMPLOYER_LEVY_PROGRAMS[evidence.programKey].systemKey !== row.system_key
    ) {
      throw new PayrollError(
        `${employeeName}: a saved employer levy adjustment is missing its programme, reason, source reference or request identity — correct it through the audited employer levy adjustment command before calculating`,
      );
    }
    if (evidence.programKey === "ca_wcb") {
      if (evidence.workerCompGroupId !== workerCompGroupId) {
        throw new PayrollError(
          `${employeeName}: the saved WCB/WSIB levy adjustment names a different worker-compensation group than the employee's group on the pay date — correct it through the audited employer levy adjustment command before calculating`,
        );
      }
      wcbAdjustmentAmount = add(wcbAdjustmentAmount, row.amount) as Money;
    } else {
      ehtAdjustmentAmount = add(ehtAdjustmentAmount, row.amount) as Money;
    }
  }
  const hasWcbAdjustment = levyAdjustmentRows.some((row) => row.system_key === "wcb");
  const hasEhtAdjustment = levyAdjustmentRows.some((row) => row.system_key === "eht");
  if (hasWcbAdjustment && !(wcb?.rate_percent && cmp(wcb.rate_percent, "0") >= 0)) {
    throw new PayrollError(
      `${employeeName}: a WCB/WSIB levy adjustment is recorded but the employee's worker-compensation group has no configured rate — configure the group in Company Setup → Worker compensation groups before calculating`,
    );
  }
  // An undecided coverage with assessable earnings is a refusal, never a
  // silent zero: without a rate class there is no premium, and without an
  // exemption the employee is covered by law. Readiness names every such
  // employee before calculate; this backstop holds for callers that reach
  // the levy without it. No assessable earnings means no premium is lost,
  // so an uncovered employee with nothing assessable calculates cleanly.
  if (!wcb && cmp(assessableFor("wcb"), "0") > 0) {
    const coverage = (
      await tx.execute<{ wcb_exempt: boolean | null }>(
        sql`
      select wcb_exempt from employee_payroll_profiles
       where org_id = ${orgId} and employee_party_id = ${employeePartyId}
    `,
        "objects",
      )
    )[0];
    if (!coverage?.wcb_exempt) {
      throw new PayrollError(undecidedWorkerCompError(employeeName));
    }
  }
  if (wcb?.rate_percent && cmp(wcb.rate_percent, "0") > 0) {
    // Committed stubs only. A calculated run is a draft that may be abandoned
    // or recalculated, and counting its assessable earnings lets unpaid
    // figures consume the annual cap — the same doctrine `employeeYtd` states
    // for CPP/EI. (The run being calculated keeps its own-document arm below
    // so the exemption still sequences across its own employees.)
    // Pre-adoption assessable earnings ride the opening carry-in, like every
    // other annual ceiling: without it a mid-year adopter re-opens the full
    // group maximum on the first stub.
    await requireStatutoryHistoryFactors(tx, historyScope, { employeePartyId, region }, [
      "WCB_EARN",
    ]);
    const openingSources = await readEmployeeOpeningLevySources(tx, {
      orgId,
      employeePartyId,
      taxYear,
      subsidiaryId: historyScope.subsidiaryId,
      beforeDate: ctx.payDate,
    });
    const openingAssessable = employeeOpeningLevyAmount(openingSources, {
      programKey: "ca_wcb",
      region,
    });
    const priorAssessable = (
      await tx.execute<{ prior: string }>(
        sql`
      select ${openingAssessable}::numeric + coalesce(sum((s.factors->>'WCB_EARN')::numeric), 0) as prior
        from ${employerScopedStatutoryStubs(historyScope, { employeePartyId, region })} s
       where s.pay_run_document_id <> ${documentId}
    `,
        "objects",
      )
    )[0]!.prior;
    const assessable = assessableFor("wcb");
    const room = wcb.max_assessable
      ? cmp(wcb.max_assessable, priorAssessable) > 0
        ? add(wcb.max_assessable, neg(priorAssessable))
        : "0"
      : assessable;
    const computedAssessable = (cmp(assessable, room) <= 0 ? assessable : room) as Money;
    wcbAssessable = computedAssessable;
    if (cmp(computedAssessable, "0") > 0 || hasWcbAdjustment) {
      const computedAmount =
        cmp(computedAssessable, "0") > 0
          ? ledgerPrecisionLevy(computedAssessable, wcb.rate_percent)
          : ("0" as Money);
      // The assessed premium factor stays the native assessment of this
      // stub's own lines; the issued operator amount rides the same line
      // set and is retained separately (wcbAdjustmentAmount), never
      // relabelled as assessment.
      wcbAmount = computedAmount;
      const lineTotal = add(computedAmount, wcbAdjustmentAmount) as Money;
      // Aggregate tagged ASSESSABLE earning lines by costing target (project +
      // department): hourly earnings post one line per DAY since dated
      // lookbacks, but WSIB assesses earnings and the stub allocates the
      // premium by project — one split per day-line would multiply WCB lines
      // (four for two projects) while the premium total stays identical.
      // Excluded earning types carry no premium, so they carry no allocation
      // either. First-appearance order is kept so the last-project remainder
      // rule below stays stable.
      const byTarget = new Map<
        string,
        { amount: string; projectId: string; departmentId: string | null }
      >();
      for (const line of lines) {
        if (line.kind !== "earning" || line.accrualOnly || !line.projectId) continue;
        if (!(line.programApplicability?.["wcb"] ?? true)) continue;
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
      const assessableUnits = toUnits(assessable);
      const allocations: StatutoryAllocation[] = [];
      let allocated = "0";
      const allTagged = cmp(sum(splits.map((s) => s.amount)), assessable) === 0;
      for (const [index, split] of splits.entries()) {
        const share =
          index === splits.length - 1 && allTagged
            ? add(computedAmount, neg(allocated))
            : roundMoney(mulRatio(computedAmount, toUnits(split.amount), assessableUnits), 2);
        if (cmp(share, "0") === 0) continue;
        allocated = add(allocated, share);
        allocations.push({
          amount: share,
          projectId: split.projectId,
          departmentId: split.departmentId,
        });
      }
      const remainder = add(computedAmount, neg(allocated));
      if (cmp(remainder, "0") !== 0) {
        const last = allocations[allocations.length - 1];
        if (cmp(remainder, "0") < 0 && last) last.amount = add(last.amount, remainder);
        else allocations.push({ amount: remainder });
      }
      // The issued operator entry carries no assessed earnings or
      // costing target here: it posts unallocated, in the same single WCB
      // line set (one earnings-assessed slot per stub).
      if (cmp(wcbAdjustmentAmount, "0") !== 0) allocations.push({ amount: wcbAdjustmentAmount });
      const allocatedTotal = sum(allocations.map((a) => a.amount));
      if (cmp(allocatedTotal, lineTotal) !== 0) {
        throw new PayrollError(
          `WCB allocation ${allocatedTotal} does not equal the ${lineTotal} premium ` +
            `for ${employeeName}`,
        );
      }
      pushStatutory("wcb", "employer_contribution", "WCB/WSIB", lineTotal, 260, { allocations });
    }
  }

  const eht = config.eht(region);
  if (hasEhtAdjustment && !eht) {
    throw new PayrollError(
      `${employeeName}: an employer health tax levy adjustment is recorded but CA ${region} employer health tax is not configured for ${taxYear} — configure the ca_eht rate in Payroll Setup → Statutory rates before calculating`,
    );
  }
  if (eht) {
    const lineEarnings = assessableFor("eht") as Money;
    ehtEarnings = lineEarnings;
    if (cmp(lineEarnings, "0") > 0 || hasEhtAdjustment) {
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
      // Pre-adoption remuneration is allocated by its original province and
      // summed only for this legal employer. The current employee profile is
      // never used to relabel another province's historical assessments.
      const exemptionFact = `eht_exemption_share_${region.toLowerCase()}`;
      const declaredExemption = await resolveStoredEmployerFact({
        tx,
        orgId,
        subsidiaryId: historyScope.subsidiaryId,
        country: "CA",
        factKey: exemptionFact,
        asOf: ctx.payDate ?? `${taxYear}-01-01`,
      });
      const availableExemption = eht.annualExemption ?? "0";
      if (cmp(availableExemption, "0") > 0 && declaredExemption === null) {
        throw new PayrollError(
          `CA ${region} employer health tax has no annual exemption allocation for this legal employer — ` +
            `record ${exemptionFact} for ${taxYear} in Payroll Setup → Employer facts before applying the associated-employer exemption.`,
        );
      }
      const exemption = declaredExemption ?? "0";
      if (cmp(exemption, availableExemption) > 0) {
        throw new PayrollError(
          `CA ${region} employer health tax exemption allocation exceeds the configured amount available to the associated-employer group — ` +
            `review ${exemptionFact} in Payroll Setup → Employer facts and the ${region} rate in Payroll Setup → Statutory rates.`,
        );
      }
      // Prior remuneration can consume only a positive declared exemption.
      // A zero allocation taxes this run's full base and needs no prior factor.
      let priorInProvince = "0";
      if (cmp(exemption, "0") > 0) {
        await requireStatutoryHistoryFactors(tx, historyScope, { region }, ["EHT_EARN"]);
        const ehtOpening = await requireEmployerOpeningLevySources(tx, {
          orgId,
          subsidiaryId: historyScope.subsidiaryId,
          taxYear,
          programKey: "ca_eht",
          region,
          beforeDate: ctx.payDate,
        });
        const priorRows = await tx.execute<{ prior: string }>(
          sql`
          select (coalesce(sum((s.factors->>'EHT_EARN')::numeric), 0)
                  + ${ehtOpening}::numeric)::text as prior
            from ${employerScopedStatutoryStubs(historyScope, { region, includeCurrentDocument: true })} s
        `,
          "objects",
        );
        if (priorRows.length !== 1)
          throw new PayrollError(
            "Employer health tax prior remuneration could not be resolved uniquely",
          );
        priorInProvince = priorRows[0]!.prior;
      }
      const exemptionLeft =
        cmp(exemption, priorInProvince) > 0 ? add(exemption, neg(priorInProvince)) : "0";
      const taxableRemuneration =
        cmp(lineEarnings, exemptionLeft) > 0 ? add(lineEarnings, neg(exemptionLeft)) : "0";
      const computedEhtAmount =
        cmp(taxableRemuneration, "0") > 0
          ? ledgerPrecisionLevy(taxableRemuneration, eht.rate)
          : ("0" as Money);
      // Assessed factor = native assessment of own lines only; the issued
      // operator amount adds to the line and is retained separately.
      ehtAmount = computedEhtAmount;
      const ehtLineTotal = add(computedEhtAmount, ehtAdjustmentAmount) as Money;
      if (cmp(ehtLineTotal, "0") !== 0) {
        pushStatutory("eht", "employer_contribution", "Employer Health Tax", ehtLineTotal, 270);
      }
    }
  }

  // Québec health services fund (TP-1015.F-V s. 5): employment income is
  // generally subject, so the stub's assessable earnings, with no exemption
  // and no cap. QC-gated twice: the region check below, and the ca_hsf slot
  // which refuses a rate row for any other province at the write boundary.
  // The statutory formula prices the employer's year-to-date rate and each
  // Stub books the cumulative true-up: crossing $1M mid-year
  // reprices prior remuneration, which a flat per-stub rate can never do. No
  // fallback — without a sector class the run refuses instead of mispricing.
  if (region === "QC") {
    const hsf = config.hsf(region);
    if (hsf) {
      hsfEarnings = assessableFor("hsf") as Money;
      if (cmp(hsfEarnings, "0") > 0) {
        const classes =
          (hsf.sectorOther ? 1 : 0) +
          (hsf.sectorPublic ? 1 : 0) +
          (hsf.sectorPrimaryManufacturing ? 1 : 0) +
          (hsf.sectorExempt2026 ? 1 : 0);
        if (classes > 1) {
          throw new PayrollPackError(
            "QC HSF sector flags are mutually exclusive — set exactly one of sectorOther, " +
              "sectorPublic, sectorPrimaryManufacturing, sectorExempt2026",
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
            "QC HSF needs the employer's sector classification: the statutory rate comes from " +
              "the Revenu Québec total-payroll formula by sector, never from a flat configured rate. " +
              "Set exactly one sector flag on the QC ca_hsf rate (sectorOther, sectorPublic, " +
              "sectorPrimaryManufacturing, or sectorExempt2026) before calculating payroll",
          );
        } else if (sector === "exempt_2026") {
          if (taxYear !== 2026) {
            throw new PayrollPackError(
              `QC HSF 2026 agriculture/forestry/fishing exemption does not cover ${taxYear} — clear the ` +
                "exemption, or contact support for a year the exemption does not cover.",
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
          const ytd = (
            await tx.execute<{ remuneration: string; booked: string }>(
              sql`
            select coalesce(sum((s.factors->>'HSF_EARN')::numeric), 0) as remuneration,
                   coalesce(sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                                  join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                                 where l.org_id = ${orgId} and l.stub_id = s.id
                                   and l.kind = 'employer_contribution' and pc.system_key = 'hsf')), 0) as booked
          from ${employerScopedStatutoryStubs(historyScope, { region, includeCurrentDocument: true })} s
          `,
              "objects",
            )
          )[0]!;
          const ytdBase = add(ytd.remuneration, hsfEarnings);
          const rate = quebecHsfRateForPayroll(sector, ytdBase, taxYear);
          const cumulative = mulPercent(ytdBase, rate, 2);
          hsfAmount = (
            cmp(cumulative, ytd.booked) > 0 ? add(cumulative, neg(ytd.booked)) : "0"
          ) as Money;
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
  // Employment income is generally subject, so the stub's assessable earnings.
  // The cap binds committed stubs plus the run being calculated (WCB shape:
  // committed-only counting lets two drafts each claim the full room).
  // Pre-adoption remuneration counts only through its source-qualified
  // original Québec allocation; unqualified legacy wages refuse before this cap.
  let cntAmount: Money = "0" as Money;
  let cntEarnings: Money = "0" as Money;
  if (region === "QC") {
    if (taxYear !== 2026) {
      throw new PayrollPackError(
        `Québec CNT has no transcribed rate for ${taxYear}: 2026 prices 0.06% to $103,000 per employee ` +
          "(Revenu Québec). This year is not yet supported by the CA-QC pack; contact support.",
      );
    }
    const runSubsidiary = historyScope.subsidiaryId;
    const cntExemption = await resolveStoredEmployerFact({
      tx,
      orgId,
      subsidiaryId: runSubsidiary,
      country: "CA",
      factKey: "cnt_exemption",
      asOf: ctx.payDate ?? `${taxYear}-12-31`,
    });
    if (cntExemption === "none") {
      await requireStatutoryHistoryFactors(tx, historyScope, { employeePartyId, region: "QC" }, [
        "CNT_EARN",
      ]);
      const cntSources = await readEmployeeOpeningLevySources(tx, {
        orgId,
        employeePartyId,
        taxYear,
        subsidiaryId: historyScope.subsidiaryId,
        beforeDate: ctx.payDate,
      });
      const cntOpening = employeeOpeningLevyAmount(cntSources, {
        programKey: "ca_cnt",
        region: "QC",
      });
      const priorCnt = (
        await tx.execute<{ prior: string }>(
          sql`
        select ${cntOpening}::numeric + coalesce(sum((s.factors->>'CNT_EARN')::numeric), 0) as prior
          from ${employerScopedStatutoryStubs(historyScope, { employeePartyId, region: "QC", includeCurrentDocument: true })} s
      `,
          "objects",
        )
      )[0]!.prior;
      const assessable = assessableFor("cnt");
      const room = cmp(CNT_MAX_2026, priorCnt) > 0 ? add(CNT_MAX_2026, neg(priorCnt)) : "0";
      cntEarnings = (cmp(assessable, room) <= 0 ? assessable : room) as Money;
      if (cmp(cntEarnings, "0") > 0) {
        cntAmount = mulPercent(cntEarnings, CNT_RATE_2026, 2) as Money;
        pushStatutory(
          "cnt",
          "employer_contribution",
          "Contribution related to labour standards (CNT)",
          cntAmount,
          285,
        );
      }
    }
  }

  return {
    wcbAmount,
    wcbAssessable,
    ehtAmount,
    ehtEarnings,
    hsfAmount,
    hsfEarnings,
    cntAmount,
    cntEarnings,
    ...(hasWcbAdjustment ? { wcbAdjustmentAmount } : {}),
    ...(hasEhtAdjustment ? { ehtAdjustmentAmount } : {}),
  };
}
