/**
 * Deduction-protection settlement driven by the caller statutory pass.
 *
 * Extracted verbatim from engine/src/payroll/run.ts; bodies preserve exact
 * math, transaction/lock sequencing, and refusal identity.
 */
import { PayrollError } from "./error.ts";
import { add, cmp, neg, sum } from "../money/money.ts";
import { type PayrollDeductionTreatment } from "./packs.ts";
import { applyDeductionProtection, protectedBase, protectionConverged, protectionNeedsIteration, PROTECTION_MAX_PASSES, settleProtectionOscillation, totalShortfall, type DeductionShortfall, type ProtectionBase } from "./limits.ts";
import { protectionTreatmentIterates } from "./treatment-bases.ts";
import { type Line } from "./run-stub-records.ts";
/**
 * Deduction protection over the CURRENT line set, driven to settlement by
 * the caller's statutory pass: fast path, single re-cap, or the alternating
 * fixpoint. Each pass re-caps the
 * ORIGINAL request, never the previous pass's capped amount. Returns the
 * protected orders (the live line objects), their uncapped requests, and
 * the settled result for shortfall reporting.
 */
export async function settleDeductionProtection(args: {
  lines: Line[];
  gross: string;
  /** `${emp.display_name ?? partyId}`, named in the non-convergence refusal. */
  employeeLabel: string;
  /** The run's pack vocabulary: decides which protected treatments iterate. */
  packTreatments: readonly PayrollDeductionTreatment[];
  runStatutoryPass: () => Promise<void>;
}) {
  const { lines, gross, employeeLabel, packTreatments, runStatutoryPass } = args;
  const protectedLines = lines.filter(
    (l) => l.kind === "deduction" && l.protectionBase && l.protectionBase !== "none",
  );
  // What each order asked for, captured before any pass caps it.
  const protectionRequested = protectedLines.map((l) => l.amount);

  /** Protection over the CURRENT line set — the statutory lines included. */
  const protectionPass = () => {
    const baseLines = lines.map((l) => ({
      kind: l.kind,
      amount: l.amount,
      includeInDisposableEarnings: l.includeInDisposableEarnings ?? true,
      accrualOnly: l.accrualOnly,
      protectedDeduction: protectedLines.includes(l),
    }));
    const unprotected = sum(lines
      .filter((l) => l.kind === "deduction" && !protectedLines.includes(l))
      .map((l) => l.amount));
    // A refundable credit is take-home pay the protection pool must see: it
    // raises what the employee would take home (and therefore what a
    // garnishment measured on net pay may take) exactly like gross does.
    const credits = sum(lines
      .filter((l) => l.kind === "credit" && !l.accrualOnly)
      .map((l) => l.amount));
    const available = add(add(gross, neg(unprotected)), credits);
    return applyDeductionProtection(
      protectedLines.map((l, index) => ({
        key: String(index),
        // Each pass re-caps the ORIGINAL request, never the previous pass's
        // capped amount — otherwise the order would ratchet down for free.
        requested: protectionRequested[index]!,
        maxPercent: l.protectionMaxPercent ?? "0",
        priority: l.protectionPriority ?? 100,
        base: protectedBase(l.protectionBase as ProtectionBase, baseLines),
      })),
      protectedBase("net_pay", baseLines),
      { available: cmp(available, "0") > 0 ? available : "0" },
    );
  };

  const applyPass = (entries: readonly { key: string; amount: string }[]) => {
    // Reducing the line IS the protection: the stub shows what was actually
    // taken, and the unpaid balance is reported, never silently dropped.
    for (const entry of entries) protectedLines[Number(entry.key)]!.amount = entry.amount;
  };

  let lastProtection: ReturnType<typeof protectionPass> | null = null;
  if (protectedLines.length === 0) {
    await runStatutoryPass();
  } else if (
    !protectionNeedsIteration(
      protectedLines.map((l) => ({ taxTreatment: l.taxTreatment })),
      // A protected order iterates only when its treatment moves this run's
      // statutory pass: a protected salary-sacrifice order raises taxable
      // income when capped, which lowers net, which lowers the cap. An
      // after-tax garnishment takes the fast path; an undeclared tag fails
      // closed to iteration (see protectionTreatmentIterates).
      (treatment) => protectionTreatmentIterates(packTreatments, treatment),
    )
  ) {
    await runStatutoryPass();
    lastProtection = protectionPass();
    applyPass(lastProtection.applied);
  } else {
    let previous = protectedLines.map((l, index) => ({ key: String(index), amount: l.amount }));
    for (let pass = 1; pass <= PROTECTION_MAX_PASSES; pass++) {
      // Withholdings computed from what the previous pass settled on, then
      // re-capped against the net pay those withholdings leave.
      applyPass(previous);
      await runStatutoryPass();
      const result = protectionPass();
      const current = result.applied.map(({ key, amount }) => ({ key, amount }));
      if (protectionConverged(previous, current)) {
        applyPass(current);
        lastProtection = result;
        break;
      }
      if (pass === PROTECTION_MAX_PASSES) {
        // Out of passes. A gap of at most a cent is the statutory engine's
        // rounding, and settles on the LOWER amount (payroll-limits.ts explains
        // the bias); anything wider is a genuine failure and must not be paid.
        const settled = settleProtectionOscillation(previous, current);
        if (!settled) {
          throw new PayrollError(
            `deduction protection did not converge for ${employeeLabel}`
            + ` on ${protectedLines.map((l) => l.description).join(", ")}`
            + ` after ${PROTECTION_MAX_PASSES} passes`,
          );
        }
        applyPass(settled);
        // The stub's withholdings must come from what is actually deducted.
        await runStatutoryPass();
        lastProtection = protectionPass();
        break;
      }
      previous = current;
    }
  }
  return { lastProtection, protectedLines, protectionRequested };
}

type ProtectionOutcome = Awaited<ReturnType<typeof settleDeductionProtection>>;

/**
 * Shortfalls are derived from what the stub FINALLY deducts, so the settle
 * branch reports the settled amount's balance rather than the last pass's.
 * Stamped into the factors map as PROT_SHORT and PROT_SHORT:<description>.
 */
export function recordProtectionShortfalls(
  factors: Record<string, string>, outcome: ProtectionOutcome,
): void {
  const { lastProtection, protectedLines, protectionRequested } = outcome;
  const shortfalls: DeductionShortfall[] = [];
  const shortfallReason = new Map(
    (lastProtection?.shortfalls ?? []).map((entry) => [entry.key, entry.reason]),
  );
  for (const [index, line] of protectedLines.entries()) {
    const owed = add(protectionRequested[index]!, neg(line.amount));
    if (cmp(owed, "0") <= 0) continue;
    shortfalls.push({
      key: line.description,
      requested: protectionRequested[index]!,
      applied: line.amount,
      shortfall: owed,
      reason: shortfallReason.get(String(index)) ?? "protected_base",
    });
  }
  if (shortfalls.length > 0) {
    factors.PROT_SHORT = totalShortfall(shortfalls);
    for (const entry of shortfalls) factors[`PROT_SHORT:${entry.key}`] = entry.shortfall;
  }
}
