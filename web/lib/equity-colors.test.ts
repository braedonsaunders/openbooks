import assert from "node:assert/strict";
import test from "node:test";
import {
  EQUITY_AWARD_COLORS,
  EQUITY_CLASS_COLORS,
  EQUITY_CONVERTIBLE_COLORS,
  EQUITY_EXIT_COLOR,
  EQUITY_NEUTRAL_COLOR,
  equityClassColor,
  ownershipSliceColor,
  waterfallRecipientColor,
  waterfallStepColor,
} from "./equity-colors";

// Machado, Oliveira & Fernandes (2009) colour-vision-deficiency transforms at severity 1.0, in linear sRGB.
const SIMULATIONS = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;

function linear(hex: string): [number, number, number] {
  return [1, 3, 5].map((index) => {
    const c = parseInt(hex.slice(index, index + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

function oklab([r, g, b]: readonly number[]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Perceptual distance between two colours (Euclidean OKLab ×100), for normal vision or a simulated deficiency. */
function distance(left: string, right: string, vision?: keyof typeof SIMULATIONS): number {
  const seen = (hex: string) => {
    const rgb = linear(hex);
    if (!vision) return oklab(rgb);
    const matrix = SIMULATIONS[vision];
    return oklab(
      matrix.map((row) =>
        Math.max(0, Math.min(1, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])),
      ),
    );
  };
  const [a, b] = [seen(left), seen(right)];
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Normal-vision floor and colour-deficient floor every neighbouring pair must clear. */
const NORMAL_FLOOR = 15;
const CVD_FLOOR = 8;

function assertDistinct(pairs: [string, string, string][]) {
  const failures = pairs.flatMap(([left, right, why]) => {
    const normal = distance(left, right);
    const deficient = Math.min(distance(left, right, "protan"), distance(left, right, "deutan"));
    return normal >= NORMAL_FLOOR && deficient >= CVD_FLOOR
      ? []
      : [
          `${why}: ${left} vs ${right} (normal ${normal.toFixed(1)}, deficient ${deficient.toFixed(1)})`,
        ];
  });
  assert.deepEqual(failures, [], failures.join("\n"));
}

test("neighbouring ownership slices read apart whichever classes and awards a capitalization holds", () => {
  const awards = Object.values(EQUITY_AWARD_COLORS);
  const pairs: [string, string, string][] = [];
  // Consecutive classes sit side by side; the last class present can border any award or the pool.
  for (let i = 0; i + 1 < EQUITY_CLASS_COLORS.length; i++)
    pairs.push([EQUITY_CLASS_COLORS[i]!, EQUITY_CLASS_COLORS[i + 1]!, "consecutive classes"]);
  for (const cls of EQUITY_CLASS_COLORS) {
    pairs.push(
      [cls, EQUITY_NEUTRAL_COLOR, "class beside the pool"],
      [cls, EQUITY_EXIT_COLOR, "class beside the exit bar"],
    );
    for (const award of [...awards, ...Object.values(EQUITY_CONVERTIBLE_COLORS)])
      pairs.push([cls, award, "class beside an award or convertible"]);
  }
  for (let i = 0; i < awards.length; i++) {
    pairs.push(
      [awards[i]!, EQUITY_NEUTRAL_COLOR, "award beside the pool"],
      [awards[i]!, EQUITY_EXIT_COLOR, "award beside the exit bar"],
    );
    for (let j = i + 1; j < awards.length; j++) pairs.push([awards[i]!, awards[j]!, "award kinds"]);
  }
  assertDistinct(pairs);
});

test("the classes and awards that collided read apart: the first four classes, options, RSUs and warrants", () => {
  // A capitalization of common, Series A, Seed and a second Series A class with all three award kinds.
  const order = ["cs", "seriesa", "seed", "qaa2"];
  const shown = [
    ...order.map((id) => ownershipSliceColor({ key: `class:${id}`, group: "class" }, order)),
    ...(["option", "rsu", "warrant"] as const).map((group) =>
      ownershipSliceColor({ key: group, group }, order),
    ),
  ];
  assert.equal(new Set(shown).size, shown.length, "no two series share a colour");
  // Any two of them may sit side by side on the donut or cross on the proceeds curve.
  const failures: string[] = [];
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      const normal = distance(shown[i]!, shown[j]!);
      if (normal < NORMAL_FLOOR)
        failures.push(`${shown[i]} vs ${shown[j]} (normal ${normal.toFixed(1)})`);
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("a share class keeps one colour across the donut, the cascade and the proceeds curve, whatever the date shows", () => {
  const order = ["cs", "seed", "seriesa"];
  const early = ["cs", "seed"].map((id) => equityClassColor(id, order));
  assert.deepEqual(
    order.slice(0, 2).map((id) => equityClassColor(id, order)),
    early,
    "a later class leaves earlier colours alone",
  );
  for (const id of order) {
    const donut = ownershipSliceColor({ key: `class:${id}`, group: "class" }, order);
    assert.equal(
      waterfallRecipientColor(`class:${id}`, order),
      donut,
      "the curve line matches the donut slice",
    );
    assert.equal(
      waterfallStepColor({ key: `preference:${id}`, kind: "preference" }, order),
      donut,
      "the preference bar matches",
    );
    assert.equal(
      waterfallStepColor({ key: `participation:${id}`, kind: "participation" }, order),
      donut,
      "the participation bar matches",
    );
  }
  assert.equal(
    ownershipSliceColor({ key: "pool", group: "pool" }, order),
    EQUITY_NEUTRAL_COLOR,
    "the pool is drawn neutral",
  );
  assert.equal(
    waterfallStepColor({ key: "fees", kind: "fees" }, order),
    EQUITY_NEUTRAL_COLOR,
    "fees reach no holder",
  );
  assert.equal(
    waterfallStepColor({ key: "safe_conversion", kind: "safe_conversion" }, order),
    waterfallRecipientColor("safes", order),
  );
  assert.equal(waterfallRecipientColor("awards", order), EQUITY_AWARD_COLORS.option);
});
