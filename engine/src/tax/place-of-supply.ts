/** Native statutory selection for ordinary, fully taxable Canadian goods sales.
 * Delivery means legal delivery under the sale agreement, including goods made
 * available for collection. Special supply rules require a separate assessment. */
import { CANADA_TAX_PACK } from '../country-tax-packs/ca.ts';
import type { CountryTaxCodeDefinition } from '../country-tax-packs/types.ts';
import { isIsoCalendarDate } from '../platform/business-date.ts';
import { computeLineTaxes } from './tax.ts';
import { canonicalDecimal } from '../money/exact-decimal.ts';
import { fitsLedgerRange, normalizeMoney } from '../money/money.ts';

export class PlaceOfSupplyError extends Error {
  readonly status = 422;
  constructor(message: string) { super(message); this.name = 'PlaceOfSupplyError'; }
}

export interface GoodsSupplyQuoteInput {
  taxableAmount: string;
  quotedOn: string;
  country: string;
  deliveryProvince: string;
  basis: 'ordinary_taxable_goods_sale';
}

/** Rates come from the maintained pack's effective schedules, never headline
 * rates. GST and applicable provincial standard tax are both retained. */
export function quoteGoodsPlaceOfSupply(input: GoodsSupplyQuoteInput) {
  if (input.basis !== 'ordinary_taxable_goods_sale') {
    throw new PlaceOfSupplyError('classify the supply under its applicable place-of-supply and taxability rules before quoting; this command requires an ordinary fully taxable goods sale');
  }
  if (!isIsoCalendarDate(input.quotedOn)) throw new PlaceOfSupplyError('provide the actual supply date in YYYY-MM-DD form');
  if (input.country !== 'CA') throw new PlaceOfSupplyError('use the applicable country tax rules; this native goods command prices supplies made in Canada');
  const province = CANADA_TAX_PACK.jurisdictions.find((row) => row.region === input.deliveryProvince);
  if (!province) throw new PlaceOfSupplyError('provide a Canadian province or territory code for legal delivery under the sale agreement');
  const codes: CountryTaxCodeDefinition[] = [];
  if (province.taxType === 'hst') {
    if (!province.defaultTaxCode) throw new PlaceOfSupplyError('the HST rate schedule is unavailable; update the country tax pack before quoting');
    codes.push(province.defaultTaxCode);
  } else {
    const gst = CANADA_TAX_PACK.returnPackTaxCodes?.CA_GST34;
    if (!gst || Array.isArray(gst)) throw new PlaceOfSupplyError('the federal GST rate schedule is unavailable; update the country tax pack before quoting');
    codes.push(gst as CountryTaxCodeDefinition);
    if (province.taxType !== 'gst') {
      const provincial = province.returnPackCode && CANADA_TAX_PACK.returnPackTaxCodes?.[province.returnPackCode];
      if (!provincial || Array.isArray(provincial)) throw new PlaceOfSupplyError('the provincial tax rate schedule is unavailable; update the country tax pack before quoting');
      codes.push(provincial as CountryTaxCodeDefinition);
    }
  }
  const exact = canonicalDecimal(input.taxableAmount, 4);
  if (exact === null || !fitsLedgerRange(exact)) throw new PlaceOfSupplyError('provide the taxable amount as an exact ledger-range decimal with at most four decimal places');
  const taxableAmount = normalizeMoney(exact);
  const components = codes.map((code) => {
    const rates = code.rates?.filter((rate) => rate.effectiveFrom <= input.quotedOn && (!rate.effectiveTo || rate.effectiveTo >= input.quotedOn)) ?? [];
    if (rates.length !== 1) throw new PlaceOfSupplyError(`no unique ${code.code} rate covers ${input.quotedOn}; update the sourced rate schedule before quoting`);
    const rate = rates[0]!;
    return {
      code: code.code, jurisdiction: input.deliveryProvince, ratePercent: rate.ratePercent,
      sourceId: rate.sourceId, effectiveFrom: rate.effectiveFrom, effectiveTo: rate.effectiveTo ?? null,
    };
  });
  const taxes = computeLineTaxes(taxableAmount, components.map((row, sequence) => ({
    taxCodeId: row.code, code: row.code, sequence, ratePercent: row.ratePercent,
    roundingScale: 2, compoundOnPrevious: false,
  })));
  return {
    countryPack: CANADA_TAX_PACK.code, countryPackVersion: CANADA_TAX_PACK.version,
    basis: input.basis, quotedOn: input.quotedOn, taxableAmount,
    components: components.map((row, index) => ({ ...row, taxAmount: taxes.components[index]!.taxAmount })),
    taxAmount: taxes.taxTotal,
  };
}
