import { evaluateFormulaMeasures, type ReportMeasure } from "@openbooks/reports";

const RATIO_INPUTS: ReportMeasure[] = [
  { fn: "sum", key: "numerator" },
  { fn: "sum", key: "denominator" },
];

/** Evaluate an analytics ratio through the same rational formula kernel as reports. */
export function evaluateAnalyticsRatio(
  numerator: string,
  denominator: string,
  format: "ratio" | "percent",
  scale: number,
): string | null {
  const measure: ReportMeasure = {
    fn: "formula",
    key: "result",
    format,
    scale,
    expr: { op: "/", left: { ref: "numerator" }, right: { ref: "denominator" } },
  };
  return evaluateFormulaMeasures([...RATIO_INPUTS, measure], [numerator, denominator])[2]?.value ?? null;
}
