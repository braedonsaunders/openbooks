import { PayrollError } from "./error.ts";

/** Independent factor producers cannot replace a different statutory result. */
export function mergeStatutoryFactors(
  factors: Record<string, unknown>,
  additions: Iterable<readonly [string, unknown]>,
  source: "program" | "employer-aggregate",
  country: string,
): void {
  for (const [key, value] of additions) {
    if (key in factors && factors[key] !== value) {
      throw new PayrollError(
        `${source} factor "${key}" collides with the ${country} pack's statutory factors — ` +
          (source === "program"
            ? "rename the program's stubFactorKey"
            : "rename the levy's factorKey"),
      );
    }
    factors[key] = value;
  }
}
