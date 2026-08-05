import { UNITED_ARAB_EMIRATES_TAX_PACK } from "./ae.ts";
import { AUSTRALIA_TAX_PACK } from "./au.ts";
import { CANADA_TAX_PACK } from "./ca.ts";
import { GERMANY_TAX_PACK } from "./de.ts";
import { SPAIN_TAX_PACK } from "./es.ts";
import { FRANCE_TAX_PACK } from "./fr.ts";
import { UNITED_KINGDOM_TAX_PACK } from "./gb.ts";
import { IRELAND_TAX_PACK } from "./ie.ts";
import { INDIA_TAX_PACK } from "./in.ts";
import { ITALY_TAX_PACK } from "./it.ts";
import { JAPAN_TAX_PACK } from "./jp.ts";
import { NETHERLANDS_TAX_PACK } from "./nl.ts";
import { NEW_ZEALAND_TAX_PACK } from "./nz.ts";
import { SINGAPORE_TAX_PACK } from "./sg.ts";
import { UNITED_STATES_TAX_PACK } from "./us.ts";
import { SOUTH_AFRICA_TAX_PACK } from "./za.ts";
import type { CountryTaxCodeDefinition, CountryTaxJurisdictionDefinition, CountryTaxPackDefinition } from "./types.ts";

export type { CountryPackCoverage, CountryTaxCodeDefinition, CountryTaxJurisdictionDefinition, CountryTaxPackDefinition } from "./types.ts";

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

export function countryTaxCodeForReturn(returnPackCode: string): CountryTaxCodeDefinition | undefined {
  return COUNTRY_TAX_PACKS.map((pack) => pack.returnPackTaxCodes[returnPackCode]).find((item) => item !== undefined);
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
