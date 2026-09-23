/**
 * The ONE concentration verdict for /analytics/vendor-performance.
 *
 * Both the overview diversification gauge and the HHI card read the same
 * portfolio number (`totals.hhi`, 0–1) and must never deliver opposite
 * plain-language conclusions about it: at hhi ≈ 0.28 the gauge used to say
 * "Balanced" (`(1-hhi)*100 >= 70`) while the card said "highly concentrated"
 * (`hhi*10000 > 2500`). The bands below are the standard HHI bands
 * (unconcentrated below 1500, moderately concentrated 1500–2500, highly
 * concentrated above 2500, on the classic 0–10000 scale); the gauge keeps
 * showing its 0–100 diversification score numerically, but its word and the
 * card's word derive from the same band. The gauge speaks diversification,
 * the card speaks concentration — same band, consistent semantics.
 *
 * Client-safe: no server imports, so VendorView.tsx can use it directly.
 */

export type ConcentrationBand = "diversified" | "moderate" | "highlyConcentrated";

/** Standard HHI bands on the 0–10000 scale (the same scale totals.hhiScaled uses). */
export function concentrationBand(hhiScaled: number): ConcentrationBand {
  if (hhiScaled > 2500) return "highlyConcentrated";
  if (hhiScaled > 1500) return "moderate";
  return "diversified";
}

export interface ConcentrationVerdict {
  band: ConcentrationBand;
  /** Locale key for the gauge word (diversification language). */
  gaugeKey: "gauge.diversified" | "gauge.balanced" | "gauge.concentrated";
  /** Locale key for the HHI card sub-line (concentration language). */
  subKey: "sub.diversified" | "sub.moderate" | "sub.highlyConcentrated";
}

/**
 * The single verdict both elements render. Takes the rounded 0–10000 HHI —
 * the exact number the card displays — so a hairline value can never land
 * the two words in different bands.
 */
export function concentrationVerdict(hhiScaled: number): ConcentrationVerdict {
  const band = concentrationBand(hhiScaled);
  switch (band) {
    case "highlyConcentrated":
      return { band, gaugeKey: "gauge.concentrated", subKey: "sub.highlyConcentrated" };
    case "moderate":
      return { band, gaugeKey: "gauge.balanced", subKey: "sub.moderate" };
    case "diversified":
      return { band, gaugeKey: "gauge.diversified", subKey: "sub.diversified" };
  }
}
