/**
 * One stable colour per equity series, shared by every equity chart: the
 * ownership donut, the payment cascade and the proceeds curve. A share class
 * keeps its colour whatever the as-of date or exit value shows; it takes its
 * slot from the legal entity's class creation order. Award kinds and
 * convertibles have fixed colours of their own, and the pool, fees and
 * unallocated proceeds are drawn neutral.
 *
 * The hues were chosen as a set: each class slot reads apart from the next
 * class slot, from every award and convertible colour, from the neutral and
 * from the exit bar (OKLab distance at least 15 for normal vision, at least
 * 8 under simulated protanopia and deuteranopia), so whichever classes and
 * awards a capitalization holds, neighbouring slices, bars and crossing
 * lines stay distinguishable. The first four classes and the three award
 * kinds also read apart pairwise for normal vision (at least 15), so the
 * proceeds curve's crossing lines never pair two similar hues. Legends and
 * axis labels name every series, so identity never rests on colour alone. A
 * sixth class reuses the first slot.
 */
export const EQUITY_CLASS_COLORS = ["#008300", "#e87ba4", "#9a6324", "#26a69a", "#e34948"] as const;

/** Options, RSUs and warrants on the donut; options also stand for all awards on the waterfall. */
export const EQUITY_AWARD_COLORS = {
  option: "#2a78d6",
  rsu: "#eda100",
  warrant: "#7b1fa2",
} as const;

/** SAFEs and convertible notes paid or converted in an exit. */
export const EQUITY_CONVERTIBLE_COLORS = { safe: "#eda100", note: "#7b1fa2" } as const;

/** The unallocated pool, transaction fees and unallocated proceeds: what no holder receives. */
export const EQUITY_NEUTRAL_COLOR = "#cbd5e1";
/** The gross exit value the payment cascade starts from. */
export const EQUITY_EXIT_COLOR = "#475569";

/** A share class's colour from its place in the legal entity's class creation order. */
export function equityClassColor(shareClassId: string, classOrder: readonly string[]): string {
  const index = classOrder.indexOf(shareClassId);
  return EQUITY_CLASS_COLORS[(index < 0 ? classOrder.length : index) % EQUITY_CLASS_COLORS.length]!;
}

/** An ownership slice's colour: its class, its award kind, or the neutral pool. */
export function ownershipSliceColor(
  slice: { key: string; group: string },
  classOrder: readonly string[],
): string {
  if (slice.group === "class")
    return equityClassColor(slice.key.replace(/^class:/, ""), classOrder);
  if (slice.group === "option" || slice.group === "rsu" || slice.group === "warrant")
    return EQUITY_AWARD_COLORS[slice.group];
  return EQUITY_NEUTRAL_COLOR;
}

/**
 * A waterfall recipient's colour, for the payment cascade's steps and the
 * proceeds curve's lines: `class:<id>` (preference or participation),
 * `awards`, `safes`, `notes`, `fees` or `unallocated`.
 */
export function waterfallRecipientColor(key: string, classOrder: readonly string[]): string {
  if (key.startsWith("class:")) return equityClassColor(key.slice("class:".length), classOrder);
  switch (key) {
    case "awards":
      return EQUITY_AWARD_COLORS.option;
    case "safes":
      return EQUITY_CONVERTIBLE_COLORS.safe;
    case "notes":
      return EQUITY_CONVERTIBLE_COLORS.note;
    default:
      return EQUITY_NEUTRAL_COLOR;
  }
}

/** A payment cascade step's colour: the recipient it pays (a class's preference and participation share its colour). */
export function waterfallStepColor(
  step: { key: string; kind: string },
  classOrder: readonly string[],
): string {
  if (step.kind === "preference" || step.kind === "participation")
    return waterfallRecipientColor(
      `class:${step.key.slice(step.key.indexOf(":") + 1)}`,
      classOrder,
    );
  if (step.kind === "safe_cash_out" || step.kind === "safe_conversion")
    return waterfallRecipientColor("safes", classOrder);
  return waterfallRecipientColor(step.kind, classOrder);
}
