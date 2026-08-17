/**
 * The placeholder a scaffolded statutory edition carries until a human
 * transcribes the published figures.
 *
 * A generated rate module is a real, type-checking module — which is exactly
 * why it needs a sentinel. Without one, "the 2027 tables exist" and "the 2027
 * tables are correct" are indistinguishable to every caller, and the failure
 * mode is a payroll withheld from zeros. With one, the year module says so in
 * its own values, the pack's golden stub fails until every last one is gone, and
 * `ratesForPayDate` refuses the edition by name.
 *
 * Deliberately import-free: the sentinel is reached from generated year modules,
 * from the pack rate modules, and from the tax-year registry, and a shared
 * constant must never be the thing that introduces an import cycle between
 * them.
 */
export const UNFILLED = "__FILL_IN__";

/**
 * Every path inside a value that still carries the placeholder, in dotted form
 * ("fica.ssRate", "standard.single.0.atLeast"). Empty means the edition is
 * fully transcribed — the assertion a generated golden stub makes.
 */
export function unfilledPaths(value: unknown, path = ""): string[] {
  if (value === UNFILLED) return [path || "(root)"];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => unfilledPaths(entry, path ? `${path}.${index}` : String(index)));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, entry]) => unfilledPaths(entry, path ? `${path}.${key}` : key));
  }
  return [];
}
