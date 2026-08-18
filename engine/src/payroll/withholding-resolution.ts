/**
 * WHICH jurisdictions withhold from this employee, and under what authority.
 *
 * This is the hard part of sub-national withholding, and it is hard because it
 * is a resolution over five independent facts rather than a lookup:
 *
 *     the region the work is performed in
 *     the region the employee resides in
 *     any reciprocity agreement between those two
 *     the certificate on file for each jurisdiction
 *     any sub-region levies at either end
 *
 * Get the order wrong and nothing crashes. The stub prints, the run posts, the
 * remittance goes out, and eighteen months later a New Jersey resident who
 * worked in New York discovers that nobody withheld New Jersey tax, or a
 * Philadelphia commuter discovers that reciprocity was allowed to cascade down
 * to a city wage tax it does not touch. Silently wrong withholding for
 * cross-border employees is the expensive failure mode, so the order is written
 * here, once, as a PURE function, with the reasoning attached.
 *
 * ===========================================================================
 * THE RESOLUTION ORDER
 * ===========================================================================
 *
 * 0. NORMALIZE RESIDENCE.
 *    A profile with no residence region recorded resolves to residence = work
 *    region, marked `assumed`. This is a deliberate, load-bearing choice. The
 *    residence attribute is new; every row written before it existed is null;
 *    and refusing to pay anyone whose residence is unrecorded would break every
 *    existing payroll to fix a case that does not apply to most of them. The
 *    assumption is RECORDED in the result (`residenceSource: "assumed"`) so
 *    readiness can ask for it and a stub can show it, and it is only ever the
 *    same-region answer, which is the answer that was already being produced.
 *
 * 1. WORK REGION FIRST, ALWAYS.
 *    Wages are sourced where the work is performed and every region that taxes
 *    wages taxes wages earned inside it. It is also the input the residence
 *    side may need: `required_net_of_credit` reduces the residence region's
 *    withholding by what the work region took, so the work region has to be
 *    computed before the residence region can be. Ordering the other way makes
 *    the credit unresolvable.
 *
 * 2. SAME REGION → ONE REGION.
 *    residence == work: the region's own tax applies on a resident basis.
 *    Reciprocity is not consulted — an agreement is between two regions and
 *    there is only one. This is the overwhelmingly common path and it is the
 *    shortest.
 *
 * 3. CROSS-BORDER → CONSULT THE AGREEMENT, DIRECTIONALLY.
 *    Look up the agreement for the ORDERED pair (work, residence).
 *
 *    3a. An agreement exists AND requires a non-residence certificate AND one
 *        is on file → the agreement governs. `taxedBy: "residence"` means the
 *        work region withholds NOTHING and the residence region's tax is
 *        withheld instead. The certificate is named in the result as the
 *        authority, because an auditor will ask which form relieved the work
 *        region and the answer must not be "the code said so".
 *
 *    3b. An agreement exists AND requires a certificate AND none is on file →
 *        `withoutCertificate` governs. For every US pair this is `work_region`:
 *        the work region's tax is withheld exactly as if no agreement existed,
 *        and an ACTIONABLE note is emitted naming the employee, the agreement
 *        and the missing form. This is the single most valuable output of the
 *        whole resolution. It is the state most new cross-border hires are in,
 *        it is correct withholding, and it is invisible in every system that
 *        models reciprocity as a boolean.
 *
 *    3c. An agreement exists and requires no certificate → `taxedBy` governs
 *        directly.
 *
 *    3d. NO agreement → both regions have a claim. The work region taxes wages
 *        sourced there (step 1). The residence region is then consulted on its
 *        OWN declared rule (`residentWithholding`), and this is where the
 *        engine refuses rather than approximates: if the residence region
 *        requires resident withholding and the engine does not implement it,
 *        the run STOPS and names the region, the employee and the gap. It does
 *        not withhold the work region only and stay quiet, because that is a
 *        materially under-withheld employee who will owe money with interest.
 *
 * 4. SUB-REGION LEVIES AT THE WORK LOCATION, then AT THE RESIDENCE LOCATION.
 *    Each declared levy is included only if the employee is actually in it
 *    (the caller supplies the codes, because sub-region membership is a fact
 *    about an ADDRESS, not something an engine can derive) and only if the levy
 *    declares it reaches that side (`nonresident` for the work side,
 *    `resident` for the residence side).
 *
 *    Reciprocity does NOT cascade to sub-region levies unless the agreement
 *    itself says so (`relievesSubRegionLevies`). Pennsylvania's agreements
 *    relieve the state personal income tax and leave Philadelphia's wage tax
 *    fully payable; a cascade would under-withhold a city tax the city will
 *    assess later with interest.
 *
 * 5. SETTLE COMPETING SUB-REGION LEVIES by the REGION's declared rule
 *    (`subRegionConflictRule`) — `both`, `higher_rate`, `work_only`,
 *    `residence_only`. Pennsylvania Act 32's "higher of the resident rate and
 *    the work-location nonresident rate" is a declared rule applied by generic
 *    code, not an `if (state === "PA")`.
 *
 * 6. ATTACH THE CERTIFICATE to every resolved levy. The levy names the
 *    certificate key; the caller reads the answers. A levy whose certificate is
 *    declared but absent is not an error — most jurisdictions have a
 *    default-on-no-certificate rule, which the certificate's field defaults
 *    express.
 *
 * ===========================================================================
 *
 * Everything above is executed by `resolveWithholding` below. It is PURE: it
 * takes declarations and facts and returns a plan. It touches no database, no
 * clock, and no country-specific branch — there is not one region code in this
 * file.
 */
import {
  type PayrollLevyReach,
  type PayrollRegionWithholding,
  type PayrollSubRegionLevy,
  regionWithholding,
  subRegionLevy,
} from "./withholding-jurisdictions.ts";
import { type PayrollReciprocityAgreement, reciprocityAgreement } from "./reciprocity.ts";
import { PayrollError } from "../payroll-error.ts";

export class PayrollWithholdingResolutionError extends PayrollError {}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface WithholdingResolutionInput {
  country: string;
  /** The region the work is performed in. Required. */
  workRegion: string;
  /**
   * The region the employee resides in, or null when it has not been recorded.
   * Null resolves to the work region — see step 0.
   */
  residenceRegion?: string | null;
  /**
   * Sub-region codes the WORK location falls inside, as the pack spells them.
   * Supplied by the caller because sub-region membership is an address fact.
   */
  workSubRegions?: readonly string[];
  /** Sub-region codes the RESIDENCE falls inside. */
  residenceSubRegions?: readonly string[];
  /**
   * Certificate keys the employee has ON FILE. Only membership matters here;
   * the answers are read by the engines through `resolveCertificate`.
   */
  certificatesOnFile?: readonly string[];
  /**
   * Rates for `higher_rate` conflict settlement, keyed by sub-region code and
   * reach ("PSD123456:resident"). Supplied by the caller because a tenant-
   * sourced rate is not available to a pure function. A missing rate makes the
   * comparison unresolvable and is reported rather than guessed.
   */
  subRegionRates?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Why a levy is in the plan — reportable on the stub and in the audit trail. */
export type WithholdingBasis =
  /** The employee lives in the jurisdiction. */
  | "resident"
  /** The employee works in the jurisdiction but lives elsewhere. */
  | "nonresident"
  /** A reciprocity agreement moved the tax to the residence region. */
  | "reciprocity"
  /** The residence region taxes out-of-region wages in its own right. */
  | "resident_out_of_region";

export interface ResolvedWithholdingLevy {
  level: "region" | "sub_region";
  region: string;
  /** Set only at `sub_region` level. */
  subRegion: string | null;
  label: string;
  basis: WithholdingBasis;
  /** Which side of the employee's life put this levy in the plan. */
  side: "work" | "residence";
  reach: PayrollLevyReach;
  /** The certificate whose answers drive it, when one is declared. */
  certificateKey: string | null;
  /**
   * For `required_net_of_credit`: the region whose withholding is credited
   * against this one. The engine must compute that region first.
   */
  creditAgainstRegion?: string;
  /** The agreement that produced this levy, when reciprocity applies. */
  agreement?: PayrollReciprocityAgreement;
}

/** A levy the pack DECLARES and the engine cannot compute. Never silent. */
export interface WithholdingGap {
  region: string;
  subRegion: string | null;
  /** Ready to show, naming the jurisdiction and what is missing. */
  message: string;
  /**
   * `blocking` — calculating without it produces materially wrong withholding,
   *   so the run must stop.
   * `advisory` — the operator should know, but proceeding is defensible (an
   *   unentered tenant rate for a levy the employer may genuinely not owe).
   */
  severity: "blocking" | "advisory";
}

export interface WithholdingResolution {
  country: string;
  workRegion: string;
  residenceRegion: string;
  /** `recorded` when the profile carried one, `assumed` when it did not. */
  residenceSource: "recorded" | "assumed";
  /** The agreement consulted, when the employee is cross-border. */
  agreement: PayrollReciprocityAgreement | null;
  /** True when an agreement exists and its certificate is NOT on file. */
  reciprocityUnclaimed: boolean;
  levies: readonly ResolvedWithholdingLevy[];
  gaps: readonly WithholdingGap[];
  /** The resolution narrative, in order, for the explainability trace. */
  trace: readonly string[];
}

// ---------------------------------------------------------------------------
// The resolution
// ---------------------------------------------------------------------------

export function resolveWithholding(input: WithholdingResolutionInput): WithholdingResolution {
  const { country } = input;
  const workRegion = input.workRegion;
  if (!workRegion) {
    throw new PayrollWithholdingResolutionError(
      "withholding cannot be resolved without a work region — the region an employee works in is "
      + "the one fact every jurisdiction's rule starts from",
    );
  }

  const trace: string[] = [];
  const levies: ResolvedWithholdingLevy[] = [];
  const gaps: WithholdingGap[] = [];
  const onFile = new Set(input.certificatesOnFile ?? []);

  // --- Step 0: normalize residence -----------------------------------------
  const recorded = input.residenceRegion && input.residenceRegion !== ""
    ? input.residenceRegion
    : null;
  const residenceRegion = recorded ?? workRegion;
  const residenceSource: "recorded" | "assumed" = recorded ? "recorded" : "assumed";
  trace.push(
    residenceSource === "recorded"
      ? `residence ${residenceRegion} recorded; work ${workRegion}`
      : `no residence region recorded — resolved as the work region ${workRegion}`,
  );

  const work = regionWithholding(country, workRegion);
  const residence = residenceRegion === workRegion
    ? work
    : regionWithholding(country, residenceRegion);

  // --- Steps 1-3: the region level -----------------------------------------
  const sameRegion = residenceRegion === workRegion;
  let agreement: PayrollReciprocityAgreement | null = null;
  let reciprocityUnclaimed = false;
  /** True when the work region's own tax is relieved by an agreement. */
  let workRegionRelieved = false;

  if (sameRegion) {
    trace.push("residence and work are the same region — reciprocity is not consulted");
    if (work.residentWithholding === "none") {
      trace.push(`${workRegion} levies no wage income tax`);
    } else {
      pushRegionLevy(work, "resident", "work");
    }
  } else {
    agreement = reciprocityAgreement(country, workRegion, residenceRegion);
    if (agreement) {
      const certificateKey = agreement.certificateKey;
      const claimed = certificateKey == null || onFile.has(certificateKey);
      reciprocityUnclaimed = !claimed;
      if (claimed) {
        trace.push(
          `reciprocity: ${workRegion}/${residenceRegion} agreement in force`
          + (certificateKey ? ` on ${certificateKey}` : " (no certificate required)")
          + ` — taxed by the ${agreement.taxedBy} region`,
        );
        if (agreement.taxedBy === "residence") {
          workRegionRelieved = true;
          if (residence.residentWithholding === "none") {
            trace.push(`${residenceRegion} levies no wage income tax — nothing is withheld`);
          } else {
            pushRegionLevy(residence, "resident", "residence", "reciprocity", agreement);
          }
        } else {
          pushRegionLevy(work, "nonresident", "work", "reciprocity", agreement);
        }
      } else if (agreement.withoutCertificate === "refuse") {
        gaps.push({
          region: workRegion, subRegion: null, severity: "blocking",
          message:
            `the employee resides in ${residenceRegion} and works in ${workRegion}, which have a `
            + `reciprocity agreement, but ${agreement.certificateKey} is not on file and the `
            + `${country} pack does not state which region withholds in that case. File the `
            + "certificate, or correct the residence region.",
        });
      } else if (agreement.withoutCertificate === "residence_region") {
        workRegionRelieved = true;
        trace.push(
          `reciprocity: ${agreement.certificateKey} is not on file, but the agreement applies `
          + "without it",
        );
        pushRegionLevy(residence, "resident", "residence", "reciprocity", agreement);
      } else {
        trace.push(
          `reciprocity: ${residenceRegion} residents working in ${workRegion} may be relieved of `
          + `${workRegion} tax, but ${agreement.certificateKey} is NOT on file — ${workRegion} tax `
          + "is withheld",
        );
        gaps.push({
          region: workRegion, subRegion: null, severity: "advisory",
          message:
            `${workRegion} income tax is being withheld from an employee who resides in `
            + `${residenceRegion}. The two regions have a reciprocity agreement, but it only takes `
            + `effect once the employee files ${agreement.certificateKey} with the employer. `
            + "Collect the form to stop withholding to the wrong region.",
        });
        pushRegionLevy(work, "nonresident", "work");
      }
    } else {
      trace.push(
        `no reciprocity agreement between work ${workRegion} and residence ${residenceRegion}`,
      );
      pushRegionLevy(work, "nonresident", "work");
    }

    // --- Step 3d: the residence region's own claim -------------------------
    // Only when the work region was NOT relieved: if an agreement already moved
    // the tax to the residence region, its resident claim is satisfied.
    if (!workRegionRelieved) {
      resolveResidentClaim();
    }
  }

  // --- Steps 4-5: sub-region levies ----------------------------------------
  const workSubs = collectSubRegions(work, input.workSubRegions ?? [], "nonresident", "work");
  const residenceSubs = collectSubRegions(
    residence, input.residenceSubRegions ?? [], "resident", "residence",
  );
  settleSubRegions(workSubs, residenceSubs);

  return {
    country, workRegion, residenceRegion, residenceSource,
    agreement, reciprocityUnclaimed, levies, gaps, trace,
  };

  // -------------------------------------------------------------------------

  function pushRegionLevy(
    region: PayrollRegionWithholding,
    reach: PayrollLevyReach,
    side: "work" | "residence",
    basis: WithholdingBasis = reach,
    from?: PayrollReciprocityAgreement,
  ): void {
    if (region.residentWithholding === "none") {
      trace.push(`${region.region} levies no wage income tax`);
      return;
    }
    if (reach === "nonresident" && !region.taxesNonresidentWages) {
      trace.push(`${region.region} does not withhold from nonresidents' wages earned there`);
      return;
    }
    if (!region.implemented) {
      gaps.push({
        region: region.region, subRegion: null, severity: "blocking",
        message:
          `${region.label} withholding is not implemented — `
          + (region.unimplementedReason
            ?? `the ${country} pack has not transcribed ${region.region}'s tables`),
      });
      return;
    }
    levies.push({
      level: "region", region: region.region, subRegion: null, label: region.label,
      basis, side, reach, certificateKey: region.certificateKey ?? null, agreement: from,
    });
    trace.push(`${region.label} applies on a ${basis} basis`);
  }

  /** Step 3d — the residence region's claim on wages earned elsewhere. */
  function resolveResidentClaim(): void {
    switch (residence.residentWithholding) {
      case "none":
        trace.push(`${residenceRegion} levies no wage income tax on its residents`);
        return;
      case "not_required":
        trace.push(
          `${residenceRegion} taxes its residents on out-of-region wages but does not require the `
          + "employer to withhold",
        );
        return;
      case "unknown": {
        // Refuse. The pack has not established whether this region requires its
        // residents' out-of-region wages to be withheld on, and picking either
        // answer for them is exactly the guess this whole module exists to
        // prevent.
        gaps.push({
          region: residenceRegion, subRegion: null, severity: "blocking",
          message:
            `the employee resides in ${residenceRegion} and works in ${workRegion}, and the `
            + `${country} pack has not established whether ${residenceRegion} requires an employer `
            + "to withhold on wages earned outside it. Withholding only "
            + `${workRegion} might under-withhold and withholding both might over-withhold, so `
            + `neither is assumed. Establish ${residenceRegion}'s rule in the pack's withholding `
            + "declaration, or correct the residence region if it is wrong.",
        });
        return;
      }
      case "required":
      case "required_net_of_credit": {
        const netOfCredit = residence.residentWithholding === "required_net_of_credit";
        if (!residence.implemented || !residence.residentWithholdingImplemented) {
          // REFUSE. Withholding only the work region here under-withholds an
          // employee by the whole residence-region liability, and nothing
          // downstream can detect it.
          gaps.push({
            region: residenceRegion, subRegion: null, severity: "blocking",
            message:
              `the employee resides in ${residenceRegion} and works in ${workRegion}. `
              + `${residence.label} requires the employer to withhold on wages earned outside `
              + (netOfCredit ? "the region, net of a credit for the work region's tax, " : "the region ")
              + `and this engine does not compute it (${residence.citation}). Withholding only `
              + `${workRegion} would under-withhold. Correct the residence region if it is wrong, `
              + `or pay this employee outside the system until ${residenceRegion} resident `
              + "withholding is implemented.",
          });
          return;
        }
        levies.push({
          level: "region", region: residenceRegion, subRegion: null, label: residence.label,
          basis: "resident_out_of_region", side: "residence", reach: "resident",
          certificateKey: residence.certificateKey ?? null,
          ...(netOfCredit ? { creditAgainstRegion: workRegion } : {}),
        });
        trace.push(
          `${residence.label} also applies to its resident's out-of-region wages`
          + (netOfCredit ? `, net of a credit for ${workRegion} withholding` : ""),
        );
        return;
      }
    }
  }

  function collectSubRegions(
    region: PayrollRegionWithholding,
    codes: readonly string[],
    reach: PayrollLevyReach,
    side: "work" | "residence",
  ): ResolvedWithholdingLevy[] {
    const found: ResolvedWithholdingLevy[] = [];
    for (const code of codes) {
      const levy = subRegionLevy(country, region.region, code);
      if (!levy) {
        const open = region.openSubRegions;
        gaps.push({
          region: region.region, subRegion: code, severity: "blocking",
          message:
            `"${code}" is not a sub-region the ${country} pack declares inside ${region.region} — `
            + (open
              ? `${region.region} identifies each ${open.kind} by a code matching `
                + `${open.codePattern}, and "${code}" does not. `
              : "")
            + "Correct the employee's work or residence location, or declare the levy in the pack.",
        });
        continue;
      }
      if (!levy.reaches.includes(reach)) {
        trace.push(`${levy.label} does not reach ${reach}s — not withheld on the ${side} side`);
        continue;
      }
      if (workRegionRelieved && side === "work" && agreement?.relievesSubRegionLevies === false) {
        // Explicit: reciprocity relieved the STATE tax, and the agreement says
        // it does not reach the city. The levy stands.
        trace.push(
          `${levy.label} is NOT relieved by the ${workRegion}/${residenceRegion} agreement `
          + "— a reciprocal agreement between regions does not bind a sub-region",
        );
      } else if (workRegionRelieved && side === "work" && agreement?.relievesSubRegionLevies) {
        trace.push(`${levy.label} is relieved by the ${workRegion}/${residenceRegion} agreement`);
        continue;
      }
      if (!levy.implemented) {
        gaps.push({
          region: region.region, subRegion: code, severity: "blocking",
          message:
            `${levy.label} levies its own income tax (${levy.citation}) and this engine does not `
            + `compute it. It is declared, not forgotten: withholding nothing for ${levy.label} `
            + "would under-withhold every employee it reaches.",
        });
        continue;
      }
      found.push({
        level: "sub_region", region: region.region, subRegion: code, label: levy.label,
        basis: reach, side, reach, certificateKey: levy.certificateKey ?? null,
      });
    }
    return found;
  }

  /** Step 5 — settle work-side against residence-side by the region's rule. */
  function settleSubRegions(
    workSubsIn: readonly ResolvedWithholdingLevy[],
    residenceSubsIn: readonly ResolvedWithholdingLevy[],
  ): void {
    let workSubs = [...workSubsIn];
    let residenceSubs = [...residenceSubsIn];
    // Rules are declared per REGION. When work and residence are in different
    // regions each side settles under its own region's rule, which is the only
    // reading that does not require one region's legislature to bind another's.
    // Levies that settle on their own terms leave the comparison entirely,
    // BEFORE any rule is applied — Philadelphia is not an Act 32 jurisdiction
    // and must never be weighed against one.
    const independent = (levy: ResolvedWithholdingLevy) =>
      subRegionLevy(country, levy.region, levy.subRegion!)?.settlesIndependently === true;
    for (const levy of [...residenceSubs, ...workSubs].filter(independent)) {
      trace.push(`${levy.label} settles independently of ${levy.region}'s sub-region rule`);
      levies.push(levy);
    }
    workSubs = workSubs.filter((levy) => !independent(levy));
    residenceSubs = residenceSubs.filter((levy) => !independent(levy));

    const rule = work.subRegionConflictRule;
    if (workSubs.length === 0 || residenceSubs.length === 0 || sameRegionSubs()) {
      // Nothing to settle: only one side has a levy, or the two sides are the
      // same jurisdiction and would be double-counted.
      const seen = new Set<string>();
      for (const levy of [...residenceSubs, ...workSubs]) {
        const key = `${levy.region}:${levy.subRegion}`;
        if (seen.has(key)) {
          trace.push(`${levy.label} reaches this employee as a resident and as a worker — `
            + "withheld once, on the resident basis");
          continue;
        }
        seen.add(key);
        levies.push(levy);
      }
      return;
    }
    switch (rule) {
      case "both":
        trace.push(`${work.region} withholds work-side and residence-side sub-region levies `
          + "independently");
        levies.push(...residenceSubs, ...workSubs);
        return;
      case "work_only":
        trace.push(`${work.region} withholds only the work-location sub-region levy`);
        levies.push(...workSubs);
        return;
      case "residence_only":
        trace.push(`${work.region} withholds only the residence sub-region levy`);
        levies.push(...residenceSubs);
        return;
      case "higher_rate":
        settleHigherRate(workSubs, residenceSubs);
        return;
    }
  }

  function sameRegionSubs(): boolean {
    return false;
  }

  /**
   * One levy is withheld, at the higher of the residence rate and the work
   * rate, remitted to the residence jurisdiction. Pennsylvania Act 32's rule,
   * applied generically because the region declared it.
   *
   * The rates come from the CALLER (a tenant-entered `sub_region`-scoped
   * statutory rate). A rate that has not been entered makes the comparison
   * unanswerable, and the honest response is to say so, not to pick a side.
   */
  function settleHigherRate(
    workSubs: readonly ResolvedWithholdingLevy[],
    residenceSubs: readonly ResolvedWithholdingLevy[],
  ): void {
    const rates = input.subRegionRates ?? {};
    const rateFor = (levy: ResolvedWithholdingLevy) => rates[`${levy.subRegion}:${levy.reach}`];
    // The residence side is the remittance destination, so it is the anchor.
    for (const home of residenceSubs) {
      const homeRate = rateFor(home);
      const rival = workSubs[0];
      const rivalRate = rival ? rateFor(rival) : undefined;
      if (homeRate == null || (rival && rivalRate == null)) {
        gaps.push({
          region: home.region, subRegion: home.subRegion, severity: "blocking",
          message:
            `${work.region} withholds the higher of the resident rate for ${home.label} and the `
            + `nonresident rate for ${rival?.label ?? "the work location"}, and `
            + `${homeRate == null ? home.label : rival!.label}'s rate has not been entered. `
            + "Enter both rates from the jurisdiction's register before paying this employee.",
        });
        continue;
      }
      const takeWork = rival != null && compareRates(rivalRate!, homeRate) > 0;
      const winner = takeWork ? rival! : home;
      trace.push(
        `${work.region}: the higher rate wins — ${winner.label} at `
        + `${takeWork ? rivalRate : homeRate} over `
        + `${takeWork ? homeRate : rivalRate ?? "(no work-location levy)"}`,
      );
      levies.push({ ...winner, basis: "resident", side: "residence" });
    }
    if (residenceSubs.length === 0) levies.push(...workSubs);
  }
}

/**
 * Compare two decimal rate strings EXACTLY, without a float.
 *
 * `Number("0.01") > Number("0.0099")` happens to be right and
 * `Number("0.1") + Number("0.2")` famously is not; a rate comparison that
 * decides which jurisdiction gets an employee's money does not get to rely on
 * which side of that line it falls. Compared digit by digit on padded integer
 * strings — no parsing, no scaling, no precision to lose.
 */
export function compareRates(a: string, b: string): number {
  const parse = (value: string) => {
    const raw = value.trim();
    if (!/^\d+(\.\d+)?$/.test(raw)) {
      throw new PayrollWithholdingResolutionError(`not a non-negative decimal rate: "${value}"`);
    }
    const [whole = "0", fraction = ""] = raw.split(".");
    return { whole: whole.replace(/^0+(?=\d)/, ""), fraction };
  };
  const left = parse(a);
  const right = parse(b);
  if (left.whole.length !== right.whole.length) {
    return left.whole.length < right.whole.length ? -1 : 1;
  }
  if (left.whole !== right.whole) return left.whole < right.whole ? -1 : 1;
  const width = Math.max(left.fraction.length, right.fraction.length);
  const lf = left.fraction.padEnd(width, "0");
  const rf = right.fraction.padEnd(width, "0");
  if (lf === rf) return 0;
  return lf < rf ? -1 : 1;
}

/** Blocking gaps only — the ones a run must stop for. */
export function blockingGaps(resolution: WithholdingResolution): WithholdingGap[] {
  return resolution.gaps.filter((gap) => gap.severity === "blocking");
}

/** The declared sub-region levies inside a region, for the setup surface. */
export function declaredSubRegions(
  country: string,
  region: string,
): readonly PayrollSubRegionLevy[] {
  return regionWithholding(country, region).subRegions;
}
