import assert from "node:assert/strict";
import test from "node:test";
import { COUNTRY_TAX_PACKS, packReturnCodesWithTaxCodes, packTaxCodesForReturn } from "./index.ts";
import type { CountryTaxPackDefinition, TaxReturnPackBox } from "./types.ts";

/**
 * Statutory fidelity of rate bands vs return boxes (AUDIT-C 81–86): every
 * rate a pack can price must have a declared destination on its return —
 * a real box/casilla/line — and every band's window must open at a sourced
 * effective date, never at the fetch date. Either half fails fleet-wide, so
 * a new pack (or a new band on an old pack) cannot reintroduce the shape.
 */

function governmentBoxes(pack: CountryTaxPackDefinition, returnPackCode: string): TaxReturnPackBox[] {
  const returnPack = pack.returnPacks.find((entry) => entry.code === returnPackCode);
  assert.ok(returnPack, `${pack.country}: return pack ${returnPackCode} is missing`);
  return returnPack.boxes.filter((box) => !box.lineCode.startsWith("OB_"));
}

/** Percent numbers named by a box label, with comma decimals ("10,5%"). */
function labelPercents(label: string): number[] {
  const out: number[] = [];
  for (const match of label.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) {
    out.push(Number(match[1]!.replace(",", ".")));
  }
  return out;
}

function mentionsZero(label: string): boolean {
  return labelPercents(label).includes(0) || /\bzero\b/i.test(label);
}

test("every priced band on a rate-split return has a box, a declared destination, or a reviewed workpaper-only reason", () => {
  assert.ok(COUNTRY_TAX_PACKS.length > 0, "no country tax packs registered");
  for (const pack of COUNTRY_TAX_PACKS) {
    for (const returnPackCode of packReturnCodesWithTaxCodes(pack)) {
      const gov = governmentBoxes(pack, returnPackCode);
      const govCodes = new Set(gov.map((box) => box.lineCode));
      // An aggregate return (LIPE totals, GSTR-3B, BAS) routes every band
      // through its totals by construction — only a return that splits
      // bands across boxes can drop one.
      const split = gov.some((box) => labelPercents(box.label).length > 0);
      if (!split) continue;
      for (const code of packTaxCodesForReturn(pack, returnPackCode)) {
        const routed =
          code.ratePercent === 0
            ? gov.some((box) => mentionsZero(box.label))
            : gov.some((box) => labelPercents(box.label).includes(code.ratePercent));
        if (routed) continue;
        if (code.returnBoxes?.length) {
          for (const line of code.returnBoxes) {
            assert.ok(
              govCodes.has(line),
              `${pack.country}/${returnPackCode}/${code.code} declares destination box ${line}, which is not on the return — ` +
                `fix the declaration or add the box`,
            );
          }
          continue;
        }
        assert.ok(
          code.workpaperOnlyReason && code.workpaperOnlyReason.length > 0,
          `${pack.country}/${returnPackCode}/${code.code} prices ${code.ratePercent}% with no destination on the return: ` +
            `add the box/casilla for it, declare returnBoxes, or record a reviewed workpaperOnlyReason`,
        );
      }
    }
  }
});

test("no band opens at its source's fetch date without a reviewed truncation reason", () => {
  assert.ok(COUNTRY_TAX_PACKS.length > 0, "no country tax packs registered");
  for (const pack of COUNTRY_TAX_PACKS) {
    const sources = new Map(pack.sources.map((source) => [source.id, source] as const));
    for (const returnPackCode of packReturnCodesWithTaxCodes(pack)) {
      for (const code of packTaxCodesForReturn(pack, returnPackCode)) {
        const first = code.rates?.[0];
        if (!first) continue;
        const source = sources.get(first.sourceId);
        if (!source) continue;
        if (first.effectiveFrom !== source.asOf) continue;
        assert.ok(
          code.truncatedScheduleReason && code.truncatedScheduleReason.length > 0,
          `${pack.country}/${returnPackCode}/${code.code} opens ${first.effectiveFrom}, the cited source's own asOf date: ` +
            `re-date the band from the sourced effective date or record a reviewed truncatedScheduleReason`,
        );
      }
    }
  }
});
