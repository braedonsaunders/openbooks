import { UNITED_ARAB_EMIRATES_TAX_PACK } from "./ae.ts";
import { AUSTRIA_TAX_PACK } from "./at.ts";
import { AUSTRALIA_TAX_PACK } from "./au.ts";
import { BELGIUM_TAX_PACK } from "./be.ts";
import { CANADA_TAX_PACK } from "./ca.ts";
import { CHILE_TAX_PACK } from "./cl.ts";
import { CZECHIA_TAX_PACK } from "./cz.ts";
import { DENMARK_TAX_PACK } from "./dk.ts";
import { SWITZERLAND_TAX_PACK } from "./ch.ts";
import { GERMANY_TAX_PACK } from "./de.ts";
import { SPAIN_TAX_PACK } from "./es.ts";
import { FINLAND_TAX_PACK } from "./fi.ts";
import { FRANCE_TAX_PACK } from "./fr.ts";
import { UNITED_KINGDOM_TAX_PACK } from "./gb.ts";
import { IRELAND_TAX_PACK } from "./ie.ts";
import { HUNGARY_TAX_PACK } from "./hu.ts";
import { INDIA_TAX_PACK } from "./in.ts";
import { ITALY_TAX_PACK } from "./it.ts";
import { JAPAN_TAX_PACK } from "./jp.ts";
import { KOREA_TAX_PACK } from "./kr.ts";
import { NETHERLANDS_TAX_PACK } from "./nl.ts";
import { NORWAY_TAX_PACK } from "./no.ts";
import { NEW_ZEALAND_TAX_PACK } from "./nz.ts";
import { POLAND_TAX_PACK } from "./pl.ts";
import { PORTUGAL_TAX_PACK } from "./pt.ts";
import { ROMANIA_TAX_PACK } from "./ro.ts";
import { SAUDI_ARABIA_TAX_PACK } from "./sa.ts";
import { SWEDEN_TAX_PACK } from "./se.ts";
import { SINGAPORE_TAX_PACK } from "./sg.ts";
import { TURKIYE_TAX_PACK } from "./tr.ts";
import { UNITED_STATES_TAX_PACK } from "./us.ts";
import { SOUTH_AFRICA_TAX_PACK } from "./za.ts";
import type { CountryTaxCodeDefinition, CountryTaxJurisdictionDefinition, CountryTaxPackDefinition, TaxReturnPackBox } from "./types.ts";

export type { CountryPackCoverage, CountryTaxCodeDefinition, CountryTaxCodeRole, CountryTaxJurisdictionDefinition, CountryTaxPackDefinition } from "./types.ts";
export { assertPackCodeRateSchedule, packGuardToday, packRatesCoveringDate } from "./rate-schedule.ts";

export const COUNTRY_TAX_PACKS: readonly CountryTaxPackDefinition[] = [
  CANADA_TAX_PACK,
  UNITED_STATES_TAX_PACK,
  AUSTRALIA_TAX_PACK,
  NEW_ZEALAND_TAX_PACK,
  UNITED_KINGDOM_TAX_PACK,
  GERMANY_TAX_PACK,
  FRANCE_TAX_PACK,
  SPAIN_TAX_PACK,
  ITALY_TAX_PACK,
  NETHERLANDS_TAX_PACK,
  IRELAND_TAX_PACK,
  SINGAPORE_TAX_PACK,
  INDIA_TAX_PACK,
  SOUTH_AFRICA_TAX_PACK,
  UNITED_ARAB_EMIRATES_TAX_PACK,
  JAPAN_TAX_PACK,
  SWITZERLAND_TAX_PACK,
  AUSTRIA_TAX_PACK,
  BELGIUM_TAX_PACK,
  POLAND_TAX_PACK,
  SWEDEN_TAX_PACK,
  KOREA_TAX_PACK,
  PORTUGAL_TAX_PACK,
  DENMARK_TAX_PACK,
  NORWAY_TAX_PACK,
  SAUDI_ARABIA_TAX_PACK,
  TURKIYE_TAX_PACK,
  CZECHIA_TAX_PACK,
  HUNGARY_TAX_PACK,
  ROMANIA_TAX_PACK,
  FINLAND_TAX_PACK,
  CHILE_TAX_PACK,
];
export const JURISDICTION_SELECTION_PREFIX = "JURISDICTION:";

export interface ResolvedCountryTaxJurisdiction extends CountryTaxJurisdictionDefinition {
  country: string;
  countryPackCode: string;
  countryPackVersion: string;
}

export function countryTaxPack(country: string): CountryTaxPackDefinition | undefined {
  return COUNTRY_TAX_PACKS.find((pack) => pack.country === country);
}

export function countryTaxPackForReturn(returnPackCode: string): CountryTaxPackDefinition | undefined {
  return COUNTRY_TAX_PACKS.find((pack) =>
    pack.parentReturnPackCode === returnPackCode || pack.jurisdictions.some((item) => item.returnPackCode === returnPackCode),
  );
}

/**
 * THE only reader of CountryTaxPackDefinition.returnPackTaxCodes. Collapses
 * the single-or-set union to an always-array set (empty when the return
 * declares nothing), so no call site ever re-handles both shapes. A
 * structural test enforces that no other production module reads the field.
 */
export function packTaxCodesForReturn(
  pack: CountryTaxPackDefinition,
  returnPackCode: string,
): readonly CountryTaxCodeDefinition[] {
  const entry = pack.returnPackTaxCodes[returnPackCode];
  if (entry === undefined) return [];
  if (isTaxCodeSet(entry)) return entry;
  return [entry];
}

function isTaxCodeSet(
  entry: CountryTaxCodeDefinition | readonly CountryTaxCodeDefinition[],
): entry is readonly CountryTaxCodeDefinition[] {
  return Array.isArray(entry);
}

/** Return-pack codes of this pack that declare at least a key (possibly an empty set, which guards reject). */
export function packReturnCodesWithTaxCodes(pack: CountryTaxPackDefinition): readonly string[] {
  return Object.keys(pack.returnPackTaxCodes);
}

/**
 * Headline code per return for readers that predate multi-code sets: the
 * sole definition, else the standard-role one, else the first declared.
 * Provisioning installs the FULL set and never uses this; it exists so
 * single-code packs keep their exact historical primary.
 */
export function primaryPackTaxCode(
  pack: CountryTaxPackDefinition,
  returnPackCode: string,
): CountryTaxCodeDefinition | undefined {
  const definitions = packTaxCodesForReturn(pack, returnPackCode);
  if (definitions.length <= 1) return definitions[0];
  return definitions.find((definition) => definition.role === "standard") ?? definitions[0];
}

/**
 * The library definition of one return box. The return engine uses the box's
 * declared `glMap` side (sales vs purchases) to decide which document family a
 * taxable-base box sums, because tax_report_lines stores only the basis: a
 * code that applies to BOTH sides is mapped into both the sales-base and the
 * purchases-base box, and only the box knows which side it reports.
 */
export function taxReturnPackBox(returnPackCode: string, lineCode: string): TaxReturnPackBox | undefined {
  for (const pack of COUNTRY_TAX_PACKS) {
    const returnPack = pack.returnPacks.find((item) => item.code === returnPackCode);
    if (returnPack) return returnPack.boxes.find((box) => box.lineCode === lineCode);
  }
  return undefined;
}

export function jurisdictionSelectionKey(country: string, region: string): string {
  return `${JURISDICTION_SELECTION_PREFIX}${country}-${region}`;
}

export function resolveJurisdictionSelection(selection: string): ResolvedCountryTaxJurisdiction | undefined {
  if (!selection.startsWith(JURISDICTION_SELECTION_PREFIX)) return undefined;
  const code = selection.slice(JURISDICTION_SELECTION_PREFIX.length);
  for (const pack of COUNTRY_TAX_PACKS) {
    const prefix = `${pack.country}-`;
    if (!code.startsWith(prefix)) continue;
    const region = code.slice(prefix.length);
    const jurisdiction = pack.jurisdictions.find((item) => item.region === region);
    if (jurisdiction) return { ...jurisdiction, country: pack.country, countryPackCode: pack.code, countryPackVersion: pack.version };
  }
  return undefined;
}
