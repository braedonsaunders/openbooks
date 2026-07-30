import { add, fromUnits, neg, sum, toUnits } from "../../money.ts";
import type {
  CanonicalGlLine,
  CanonicalGlSnapshot,
  GlComparison,
  GlDifference,
} from "./types.ts";

function lineKey(line: CanonicalGlLine): string {
  return [
    line.account,
    line.party ?? "",
    line.project ?? "",
    line.costCenter ?? "",
  ].join("|");
}

/** Aggregate away source row ordering without discarding accounting dimensions. */
export function canonicalizeLines(lines: readonly CanonicalGlLine[]): CanonicalGlLine[] {
  const byKey = new Map<string, { line: CanonicalGlLine; units: bigint }>();
  for (const line of lines) {
    const key = lineKey(line);
    const current = byKey.get(key);
    if (current) current.units += toUnits(line.amount);
    else byKey.set(key, { line: { ...line }, units: toUnits(line.amount) });
  }
  return [...byKey.values()]
    .filter(({ units }) => units !== 0n)
    .map(({ line, units }) => ({ ...line, amount: fromUnits(units) }))
    .sort((a, b) => lineKey(a).localeCompare(lineKey(b)));
}

export function snapshotBalanced(snapshot: CanonicalGlSnapshot): boolean {
  return toUnits(sum(snapshot.lines.map((line) => line.amount))) === 0n;
}

export function compareSnapshots(
  openbooks: CanonicalGlSnapshot,
  erpnext: CanonicalGlSnapshot,
): GlComparison {
  const ours = canonicalizeLines(openbooks.lines);
  const theirs = canonicalizeLines(erpnext.lines);
  const oursByKey = new Map(ours.map((line) => [lineKey(line), line.amount]));
  const theirsByKey = new Map(theirs.map((line) => [lineKey(line), line.amount]));
  const keys = [...new Set([...oursByKey.keys(), ...theirsByKey.keys()])].sort();
  const differences: GlDifference[] = [];
  for (const key of keys) {
    const a = oursByKey.get(key) ?? "0";
    const b = theirsByKey.get(key) ?? "0";
    const delta = add(a, neg(b));
    if (toUnits(delta) !== 0n) differences.push({ key, openbooks: a, erpnext: b, delta });
  }
  const openbooksBalanced = snapshotBalanced({ ...openbooks, lines: ours });
  const erpnextBalanced = snapshotBalanced({ ...erpnext, lines: theirs });
  return {
    ok: openbooksBalanced && erpnextBalanced && differences.length === 0,
    openbooksBalanced,
    erpnextBalanced,
    differences,
  };
}
