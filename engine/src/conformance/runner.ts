/**
 * Conformance corpus runner.
 *
 * The comparison contract, deliberately identical in spirit to the ledger-parity
 * harness:
 *
 *  - Amounts are signed, debit-positive, normalized to the ledger's 4dp, and
 *    compared as EXACT strings. There is no tolerance.
 *  - Accounts are compared through semantic roles, never COA numbers.
 *  - Lines are netted per role within an entry and zero-net roles are dropped,
 *    so a case cannot fail merely because the product split one economic effect
 *    across two lines or emitted them in a different order.
 *  - Every actual entry must independently balance to zero. An unbalanced entry
 *    is a failure even if its role totals happen to match.
 *  - A `not-implemented` case never runs and is reported as GAP, never as pass.
 */

import { fromUnits, toUnits } from "../money.ts";
import { syntheticRoles } from "./roles.ts";
import type {
  ActualOutcome,
  CaseContext,
  CaseResult,
  CaseStatus,
  ConformanceCase,
  CorpusReport,
  Difference,
  ExpectedEntry,
  LedgerContext,
  Outcome,
  Role,
} from "./types.ts";

/** Ledger-exact normalization: "100" and "100.0000" are the same figure. */
const norm = (amount: string): string => fromUnits(toUnits(amount));

/** Net an entry's lines per role, dropping roles that net to zero. */
function netByRole(
  lines: { role: Role; amount: string }[],
): Map<Role, string> {
  const totals = new Map<Role, bigint>();
  for (const line of lines) {
    totals.set(line.role, (totals.get(line.role) ?? 0n) + toUnits(line.amount));
  }
  const out = new Map<Role, string>();
  for (const [role, units] of totals) {
    if (units !== 0n) out.set(role, fromUnits(units));
  }
  return out;
}

function compareEntries(
  expected: ExpectedEntry[],
  actual: { step: string; lines: { role: Role; amount: string }[] }[],
): Difference[] {
  const differences: Difference[] = [];

  if (expected.length !== actual.length) {
    differences.push({
      at: "entry count",
      expected: String(expected.length),
      actual: String(actual.length),
    });
  }

  const steps = Math.max(expected.length, actual.length);
  for (let i = 0; i < steps; i++) {
    const exp = expected[i];
    const act = actual[i];
    const label = exp?.step ?? act?.step ?? `#${i + 1}`;

    if (!exp) {
      differences.push({ at: `entry "${label}"`, expected: "(no entry)", actual: "(entry produced)" });
      continue;
    }
    if (!act) {
      differences.push({ at: `entry "${label}"`, expected: "(entry)", actual: "(none produced)" });
      continue;
    }
    if (exp.step !== act.step) {
      differences.push({ at: `entry #${i + 1} step`, expected: exp.step, actual: act.step });
    }

    // Double-entry integrity of the ACTUAL entry, checked independently of the
    // expectation. A case must never pass on an unbalanced entry.
    const residual = act.lines.reduce((sum, l) => sum + toUnits(l.amount), 0n);
    if (residual !== 0n) {
      differences.push({
        at: `entry "${label}" balance`,
        expected: "0.0000",
        actual: fromUnits(residual),
      });
    }

    const expNet = netByRole(exp.lines);
    const actNet = netByRole(act.lines);
    const roles = new Set<Role>([...expNet.keys(), ...actNet.keys()]);
    for (const role of [...roles].sort()) {
      const e = expNet.get(role);
      const a = actNet.get(role);
      if (e === undefined || a === undefined || norm(e) !== norm(a)) {
        differences.push({
          at: `entry "${label}" role ${role}`,
          expected: e === undefined ? "(no posting)" : norm(e),
          actual: a === undefined ? "(no posting)" : norm(a),
        });
      }
    }
  }
  return differences;
}

function compareValues(
  expected: Record<string, string>,
  actual: Record<string, string>,
): Difference[] {
  const differences: Difference[] = [];
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of [...keys].sort()) {
    const e = expected[key];
    const a = actual[key];
    if (e === undefined) {
      differences.push({ at: `value ${key}`, expected: "(not expected)", actual: a! });
      continue;
    }
    if (a === undefined) {
      differences.push({ at: `value ${key}`, expected: e, actual: "(not produced)" });
      continue;
    }
    // Values may be non-monetary (a rate, a count, a label), so only normalize
    // when both sides parse as decimals.
    const bothMoney = /^-?\d+(\.\d+)?$/.test(e) && /^-?\d+(\.\d+)?$/.test(a);
    if (bothMoney ? norm(e) !== norm(a) : e !== a) {
      differences.push({ at: `value ${key}`, expected: bothMoney ? norm(e) : e, actual: bothMoney ? norm(a) : a });
    }
  }
  return differences;
}

/** Turn raw account-keyed actual lines into role-keyed lines. */
function resolveRoles(
  outcome: ActualOutcome,
  roles: Record<Role, string>,
): { step: string; lines: { role: Role; amount: string }[] }[] {
  const reverse = new Map<string, Role>();
  for (const [role, accountId] of Object.entries(roles) as [Role, string][]) {
    if (accountId) reverse.set(accountId, role);
  }
  return (outcome.entries ?? []).map((entry) => ({
    step: entry.step,
    lines: entry.lines.map((line) => {
      const role = reverse.get(line.accountId);
      if (!role) {
        throw new Error(
          `posting to account ${line.accountId} has no conformance role — ` +
            `every account a case touches must be bound in roles.ts`,
        );
      }
      return { role, amount: line.amount };
    }),
  }));
}

export interface RunOptions {
  /** Ledger context; when absent, `ledger`-tier cases are skipped. */
  ledger?: { roles: Record<Role, string>; ledger: LedgerContext };
  /** Restrict the run to case ids or standards (substring match on id). */
  filter?: string;
}

export async function runCase(kase: ConformanceCase, options: RunOptions = {}): Promise<CaseResult> {
  const started = process.hrtime.bigint();
  const elapsed = (): number => Number(process.hrtime.bigint() - started) / 1e6;

  if (kase.support === "not-implemented") {
    return { case: kase, status: "gap", differences: [], ms: elapsed() };
  }
  if (!kase.run) {
    return {
      case: kase,
      status: "fail",
      differences: [{ at: "case", expected: "a run function", actual: "none" }],
      ms: elapsed(),
    };
  }
  if (kase.tier === "ledger" && !options.ledger) {
    return { case: kase, status: "skipped", differences: [], ms: elapsed() };
  }

  const ctx: CaseContext =
    kase.tier === "ledger"
      ? { roles: options.ledger!.roles, ledger: options.ledger!.ledger }
      : { roles: syntheticRoles() };

  try {
    const actual = await kase.run(ctx);
    const expected: Outcome = kase.expected;
    const differences: Difference[] = [];

    if (expected.entries || actual.entries) {
      differences.push(
        ...compareEntries(expected.entries ?? [], resolveRoles(actual, ctx.roles)),
      );
    }
    if (expected.values || actual.values) {
      differences.push(...compareValues(expected.values ?? {}, actual.values ?? {}));
    }
    return {
      case: kase,
      status: differences.length === 0 ? "pass" : "fail",
      differences,
      ms: elapsed(),
    };
  } catch (error) {
    return {
      case: kase,
      status: "fail",
      differences: [],
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      ms: elapsed(),
    };
  }
}

export async function runCorpus(
  cases: readonly ConformanceCase[],
  options: RunOptions & { at: string; gitSha?: string | null } = { at: "" },
): Promise<CorpusReport> {
  const selected = options.filter
    ? cases.filter(
        (c) =>
          c.id.includes(options.filter!) ||
          c.citations.some((cit) => cit.standard.toLowerCase().includes(options.filter!.toLowerCase())),
      )
    : cases;

  const results: CaseResult[] = [];
  for (const kase of selected) {
    results.push(await runCase(kase, options));
  }

  const totals: Record<CaseStatus, number> = { pass: 0, fail: 0, gap: 0, skipped: 0 };
  for (const result of results) totals[result.status]++;

  return {
    at: options.at,
    gitSha: options.gitSha ?? null,
    results,
    totals,
    pass: totals.fail === 0,
  };
}
