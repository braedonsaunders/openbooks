/**
 * The exit values a waterfall curve is drawn through.
 *
 * Every payout of an exit waterfall is piecewise linear in the exit value:
 * it bends only where a preference tier fills, a class switches between its
 * preference and conversion, a participation cap binds or an award comes
 * into the money. A chart that joins evenly spaced samples with straight
 * lines cuts those corners, so a preference appears to fill later than it
 * does. This module refines the even samples until every bend is bracketed
 * within one unit of `resolution`, then keeps only the points a straight
 * line between neighbours cannot reproduce. Joining the returned points with
 * straight lines draws each payout exactly, to within the resolution, and
 * within the payouts' own minor-unit rounding (`tolerance`).
 */
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
} from "./quantities.ts";

export interface CurvePoint<T> {
  exit: Rational;
  result: T;
}

export interface PiecewiseCurveInput<T> {
  /** The lowest and highest exit values drawn. */
  from: Rational;
  to: Rational;
  /** Evenly spaced samples always drawn (at least two: both ends). */
  points: number;
  evaluate: (exit: Rational) => T;
  /** Every payout series of a result, by key; a missing key reads as zero. */
  measures: (result: T) => ReadonlyMap<string, Rational>;
  /** The rounding a series may show without bending (its minor-unit allowance). */
  tolerance: (result: T) => Rational;
  /** The narrowest interval refined: bends are located to within it. */
  resolution: Rational;
  /** An upper bound on refinement evaluations, so a pathological curve stays cheap. */
  maxEvaluations?: number;
}

const ZERO = rational(0n);
const TWO = rational(2n);

const absolute = (value: Rational): Rational =>
  compareRational(value, ZERO) < 0 ? subtractRational(ZERO, value) : value;

/** Whether every series at `middle` lies on the straight line from `left` to `right`, within the tolerance. */
function straight<T>(
  left: CurvePoint<T>,
  middle: CurvePoint<T>,
  right: CurvePoint<T>,
  input: PiecewiseCurveInput<T>,
): boolean {
  const span = subtractRational(right.exit, left.exit);
  if (compareRational(span, ZERO) === 0) return true;
  const weight = divideRational(subtractRational(middle.exit, left.exit), span);
  const a = input.measures(left.result);
  const m = input.measures(middle.result);
  const b = input.measures(right.result);
  const allowance = [
    input.tolerance(left.result),
    input.tolerance(middle.result),
    input.tolerance(right.result),
  ].reduce((max, value) => (compareRational(value, max) > 0 ? value : max), ZERO);
  for (const key of new Set([...a.keys(), ...m.keys(), ...b.keys()])) {
    const start = a.get(key) ?? ZERO;
    const end = b.get(key) ?? ZERO;
    const expected = addRational(start, multiplyRational(subtractRational(end, start), weight));
    if (compareRational(absolute(subtractRational(m.get(key) ?? ZERO, expected)), allowance) > 0)
      return false;
  }
  return true;
}

/**
 * The curve's points in increasing exit order: the even samples, plus a
 * point on each side of every bend, each evaluated exactly at its exit.
 */
export function piecewiseCurve<T>(input: PiecewiseCurveInput<T>): CurvePoint<T>[] {
  const steps = Math.max(1, Math.trunc(input.points) - 1);
  const width = subtractRational(input.to, input.from);
  const base: CurvePoint<T>[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const exit = addRational(
      input.from,
      multiplyRational(width, rational(BigInt(step), BigInt(steps))),
    );
    base.push({ exit, result: input.evaluate(exit) });
  }
  if (compareRational(width, ZERO) <= 0) return base.slice(0, 1);
  let budget = input.maxEvaluations ?? 400;
  const refined: CurvePoint<T>[] = [];
  const refine = (left: CurvePoint<T>, right: CurvePoint<T>) => {
    if (
      budget <= 0 ||
      compareRational(subtractRational(right.exit, left.exit), input.resolution) <= 0
    )
      return;
    const exit = divideRational(addRational(left.exit, right.exit), TWO);
    budget -= 1;
    const middle = { exit, result: input.evaluate(exit) };
    if (straight(left, middle, right, input)) return;
    refined.push(middle);
    refine(left, middle);
    refine(middle, right);
  };
  for (let index = 1; index < base.length; index += 1) refine(base[index - 1]!, base[index]!);
  const all = [...base, ...refined].sort((a, b) => compareRational(a.exit, b.exit));
  // Keep every even sample; keep a refinement point only where its
  // neighbours cannot reproduce it with a straight line (beside a bend).
  const evenExits = new Set(base.map((point) => point));
  const kept: CurvePoint<T>[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const point = all[index]!;
    if (evenExits.has(point)) {
      kept.push(point);
      continue;
    }
    const previous = kept[kept.length - 1];
    const next = all[index + 1];
    if (!previous || !next || !straight(previous, point, next, input)) kept.push(point);
  }
  return kept;
}
