import assert from "node:assert/strict";
import test from "node:test";
import { isTaxProvisionSelection, supportedTaxCountries } from "../tax/pack-provisioning.ts";
import { COUNTRY_TAX_PACKS, packReturnCodesWithTaxCodes, packTaxCodesForReturn } from "./index.ts";
import type { CountryTaxPackDefinition, EffectiveTaxRate, TaxReturnPackBox } from "./types.ts";

/**
 * Every registered country tax pack, held to one set of registry-wide
 * invariants plus a table of the facts each pack files by. A new pack cannot
 * register without a row, and a changed box, sign, formula, band or rate era
 * shows up as a one-line diff against its row.
 */

function dayAfter(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

interface ReturnFacts {
  /** Default frequency, submission channel, government format. */
  filing: string;
  /** Line codes in return order; a leading minus marks a box whose sign is -1. */
  boxes: string;
  formulas?: string[];
  /**
   * Declared order. `CODE role -> boxes: rate% from, ...` where `-` is no role,
   * `-> boxes` is a declared destination, and `from..to` marks an era that
   * closes before the next one opens (or is the last and closes at all).
   */
  codes?: string[];
}

interface PackFacts {
  taxType: string;
  /** The seven completeness levels in COMPLETENESS_KEYS order. */
  completeness: string;
  jurisdictions?: number;
  returns: Record<string, ReturnFacts>;
}

const COMPLETENESS_KEYS = [
  "jurisdictions", "standardRates", "returnDefinitions", "localRates", "taxability", "sourcingRules", "nexusRules",
] as const;

function describeRates(rates: readonly EffectiveTaxRate[]): string {
  return rates.map((rate, index) => {
    const next = rates[index + 1];
    const runsOn = rate.effectiveTo === undefined || (next !== undefined && dayAfter(rate.effectiveTo) === next.effectiveFrom);
    return `${rate.ratePercent}% ${rate.effectiveFrom}${runsOn ? "" : `..${rate.effectiveTo}`}`;
  }).join(", ");
}

function factsOf(pack: CountryTaxPackDefinition): PackFacts {
  const returns: Record<string, ReturnFacts> = {};
  for (const returnPack of pack.returnPacks) {
    const formulas = returnPack.boxes.filter((box) => box.formula).map((box) => `${box.lineCode} = ${box.formula}`);
    const codes = packTaxCodesForReturn(pack, returnPack.code).map((code) =>
      `${code.code} ${code.role ?? "-"}${code.returnBoxes ? ` -> ${code.returnBoxes.join(" ")}` : ""}: ${describeRates(code.rates ?? [])}`,
    );
    returns[returnPack.code] = {
      filing: `${returnPack.defaultFrequency} ${returnPack.submissionChannel} ${returnPack.governmentFormat}`,
      boxes: returnPack.boxes.map((box) => `${box.sign < 0 ? "-" : ""}${box.lineCode}`).join(" "),
      ...(formulas.length > 0 ? { formulas } : {}),
      ...(codes.length > 0 ? { codes } : {}),
    };
  }
  return {
    taxType: pack.countryTaxType,
    completeness: COMPLETENESS_KEYS.map((key) => pack.completeness[key]).join(" "),
    ...(pack.jurisdictions.length > 0 ? { jurisdictions: pack.jurisdictions.length } : {}),
    returns,
  };
}

const PACK_FACTS: Record<string, PackFacts> = {
  CA: {
    taxType: "gst", completeness: "complete complete partial not_applicable partial partial partial", jurisdictions: 13,
    returns: {
      CA_GST34: {
        filing: "quarterly portal_manual portal_entry",
        boxes: "101 -103 104 105 106 107 108 109 110 111 112 113A 205 405 113B 113C 114 115",
        formulas: [
          "105 = 103 + 104",
          "108 = 106 + 107",
          "109 = 105 - 108",
          "112 = 110 + 111",
          "113A = 109 - 112",
          "113B = 205 + 405",
          "113C = 113A + 113B",
          "114 = max(-113C, 0)",
          "115 = max(113C, 0)",
        ],
        codes: ["CA-GST -: 7% 1991-01-01, 6% 2006-07-01, 5% 2008-01-01"],
      },
      CA_BC_PST: {
        filing: "monthly portal_manual portal_entry", boxes: "A B -C D E",
        formulas: ["E = C + D"],
        codes: ["CA-BC-PST - -> C: 7% 2013-04-01"],
      },
      CA_SK_PST: {
        filing: "monthly portal_manual portal_entry", boxes: "1 2 -3 4 5",
        formulas: ["5 = 3 + 4"],
        codes: ["CA-SK-PST -: 6% 2017-03-23"],
      },
      CA_MB_RST: {
        filing: "monthly portal_manual portal_entry", boxes: "1 2 -3 4 5",
        formulas: ["5 = 3 + 4"],
        codes: ["CA-MB-RST -: 7% 2019-07-01"],
      },
      CA_QC_QST: {
        filing: "quarterly portal_manual portal_entry", boxes: "205 -203 205I 206 208",
        formulas: ["208 = 203 - 205I + 206"],
        codes: ["CA-QC-QST -: 9.975% 2013-01-01"],
      },
    },
  },
  US: {
    taxType: "sales_use", completeness: "complete complete partial partial partial partial partial", jurisdictions: 51,
    returns: {
      US_SALES_TAX_WORKPAPER: {
        filing: "monthly portal_manual portal_entry",
        boxes: "GROSS_SALES EXEMPT_SALES TAXABLE_SALES -TAX_COLLECTED ADJUSTMENTS TAX_DUE",
        formulas: ["TAX_DUE = TAX_COLLECTED + ADJUSTMENTS"],
      },
      US_CA_CDTFA401: {
        filing: "quarterly portal_manual portal_entry", boxes: "1 2 3 11 12 -19 20 21",
        formulas: ["3 = 1 + 2", "12 = 3 - 11", "21 = 19 - 20"],
        codes: [
          "US-CA-ST -: 3% 1949-07-01, 4% 1962-01-01, 5% 1967-08-01, 5% 1972-07-01, 6% 1973-07-01, "
            + "5% 1973-10-01, 6% 1974-04-01, 6.25% 1989-12-01, 6% 1991-01-01, 7.25% 1991-07-15, 7% 2001-01-01, "
            + "7.25% 2002-01-01, 7.25% 2004-07-01, 8.25% 2009-04-01, 7.25% 2011-07-01, 7.5% 2013-01-01, "
            + "7.25% 2017-01-01",
        ],
      },
      US_TX_01114: {
        filing: "monthly portal_manual portal_entry", boxes: "1 2 3 4 -7 13",
        formulas: ["4 = 2 + 3", "13 = 7"],
        codes: [
          "US-TX-ST -: 2% 1961-09-01, 3% 1968-10-02, 3.25% 1969-10-01, 4% 1971-07-01, 4.125% 1984-10-02, "
            + "5.25% 1987-01-01, 6% 1987-10-01, 6.25% 1990-07-01",
        ],
      },
      US_NY_ST100: {
        filing: "quarterly portal_manual portal_entry", boxes: "1 1a 12 -14 17",
        formulas: ["17 = 14"],
        codes: ["US-NY-ST -: 4.25% 2003-06-01, 4% 2005-06-01"],
      },
      US_FL_DR15: {
        filing: "monthly portal_manual portal_entry", boxes: "A1 A2 A3 -5 6 7",
        formulas: ["7 = 5 - 6"],
        codes: ["US-FL-ST -: 3% 1949-11-01, 4% 1968-04-01, 5% 1982-05-01, 6% 1988-02-01"],
      },
    },
  },
  AU: {
    taxType: "gst", completeness: "not_applicable complete partial not_applicable partial partial partial",
    returns: {
      AU_BAS_GST: {
        filing: "quarterly portal_manual portal_entry", boxes: "G1 G2 G3 G10 G11 -1A 1B",
        codes: ["AU-GST -: 10% 2000-07-01"],
      },
    },
  },
  NZ: {
    taxType: "gst", completeness: "not_applicable complete partial not_applicable partial partial partial",
    returns: {
      NZ_GST101A: {
        filing: "bimonthly portal_manual portal_entry", boxes: "5 6 7 -8 9 10 11 12 13 14 15",
        formulas: ["7 = 5 - 6", "10 = 8 + 9", "14 = 12 + 13", "15 = abs(10 - 14)"],
        codes: ["NZ-GST -: 10% 1986-10-01, 12.5% 1989-07-01, 15% 2010-10-01"],
      },
    },
  },
  GB: {
    taxType: "vat", completeness: "not_applicable complete partial not_applicable partial partial partial",
    returns: {
      GB_VAT100: {
        filing: "quarterly efile_api api", boxes: "-1 2 3 4 5 6 7 8 9",
        formulas: ["3 = 1 + 2", "5 = abs(3 - 4)"],
        codes: [
          "GB-VAT-STD standard: 10% 1973-04-01, 8% 1974-07-29, 15% 1979-06-18, 17.5% 1991-04-01, "
            + "15% 2008-12-01, 17.5% 2010-01-01, 20% 2011-01-04",
          "GB-VAT-RED reduced: 8% 1994-04-01, 5% 1997-09-01",
          "GB-VAT-ZERO zero: 0% 1973-04-01",
        ],
      },
    },
  },
  DE: {
    taxType: "vat", completeness: "not_applicable complete partial not_applicable partial partial partial",
    returns: {
      DE_USTVA: {
        filing: "monthly file_upload certified_file", boxes: "81 86 87 41 -OB_OUTPUT 66 61 62 67 OB_INPUT 83",
        codes: [
          "DE-VAT-STD standard: 10% 1968-01-01, 11% 1968-07-01, 12% 1978-01-01, 13% 1979-07-01, "
            + "14% 1983-07-01, 15% 1993-01-01, 16% 1998-04-01, 19% 2007-01-01, 16% 2020-07-01, 19% 2021-01-01",
          "DE-VAT-RED reduced: 5% 1968-01-01, 5.5% 1968-07-01, 6% 1978-01-01, 6.5% 1979-07-01, 7% 1983-07-01, "
            + "5% 2020-07-01, 7% 2021-01-01",
        ],
      },
    },
  },
  FR: {
    taxType: "vat", completeness: "partial partial partial partial partial partial partial",
    returns: {
      FR_CA3: {
        filing: "monthly file_upload certified_file", boxes: "A1 E1 08 09 9B -OB_OUTPUT 16 19 20 OB_INPUT 23 25 TD 28",
        codes: [
          "FR-VAT-STD standard: 20% 2014-01-01",
          "FR-VAT-RED10 reduced: 10% 2014-01-01",
          "FR-VAT-RED55 reduced: 5.5% 2014-01-01",
        ],
      },
    },
  },
  ES: {
    taxType: "vat", completeness: "partial partial partial partial partial partial partial",
    returns: {
      ES_MODELO303: {
        filing: "quarterly portal_manual portal_entry", boxes: "01 02 -03 04 05 -06 07 08 -09 -27 28 29 45 46 -OB_OUTPUT OB_INPUT",
        codes: ["ES-VAT-STD -: 21% 2012-09-01", "ES-VAT-RED reduced: 10% 2026-03-26", "ES-VAT-SUPERRED reduced: 4% 2026-03-26"],
      },
    },
  },
  IT: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      IT_LIPE: {
        filing: "quarterly file_upload certified_file", boxes: "VP2 VP3 -VP4 VP5 VP6 VP7 VP8 VP9 VP10 VP11 VP12 VP13 VP14",
        codes: ["IT-VAT-STD -: 22% 2013-10-01", "IT-VAT-RED10 reduced: 10% 2026-09-18", "IT-VAT-RED4 reduced: 4% 2026-09-18"],
      },
    },
  },
  NL: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      NL_OB: {
        filing: "quarterly portal_manual portal_entry", boxes: "1a 1b 1c 1d 1e 2a 3a 3b 3c 4a 4b -5a 5b",
        codes: [
          "NL-VAT-STD standard -> 1a: 17.5% 1992-10-01, 19% 2001-01-01, 21% 2012-10-01",
          "NL-VAT-RED reduced -> 1b: 6% 2005-01-01, 9% 2019-01-01",
        ],
      },
    },
  },
  IE: {
    taxType: "vat", completeness: "not_applicable complete partial not_applicable partial partial partial",
    returns: {
      IE_VAT3: {
        filing: "bimonthly portal_manual portal_entry", boxes: "-T1 T2 T3 T4 E1 E2 ES1 ES2 PA1",
        codes: [
          "IE-VAT-STD standard: 16.37% 1972-11-01, 19.5% 1973-09-03, 20% 1976-03-01, 25% 1980-05-01, "
            + "30% 1982-05-01, 35% 1983-03-01, 23% 1985-03-01, 25% 1986-03-01, 23% 1990-03-01, 21% 1991-03-01, "
            + "20% 2001-01-01, 21% 2002-03-01, 21.5% 2008-12-01, 21% 2010-01-01, 23% 2012-01-01, 21% 2020-09-01, "
            + "23% 2021-03-01",
          "IE-VAT-RED reduced: 5.26% 1972-11-01, 6.75% 1973-09-03, 10% 1976-03-01, 15% 1981-09-01, "
            + "18% 1982-05-01, 23% 1983-03-01, 10% 1985-03-01, 12.5% 1991-03-01, 16% 1992-03-01, 12.5% 1993-03-01, "
            + "13.5% 2003-01-01",
          "IE-VAT-RED2 reduced: 5% 1988-03-01..1990-02-28, 12.5% 1992-03-01..1993-02-28, 9% 2011-07-01",
        ],
      },
    },
  },
  SG: {
    taxType: "gst", completeness: "not_applicable complete partial not_applicable partial partial partial",
    returns: {
      SG_GSTF5: {
        filing: "quarterly portal_manual portal_entry", boxes: "1 2 3 4 5 -6 7 8 9 10 11 12 13 14 15",
        formulas: ["4 = 1 + 2 + 3", "8 = 6 - 7"],
        codes: ["SG-GST -: 3% 1994-04-01, 4% 2003-01-01, 5% 2004-01-01, 7% 2007-07-01, 8% 2023-01-01, 9% 2024-01-01"],
      },
    },
  },
  IN: {
    taxType: "gst", completeness: "partial partial partial partial partial partial partial",
    returns: {
      IN_GSTR3B: {
        filing: "monthly portal_manual portal_entry",
        boxes: "3.1(a) 3.1(b) 3.1(c) 3.1(d) 3.1(e) 3.1.1(i) 3.1.1(ii) 3.2 4(A) 4(B) 4(C) 4(D) 5 5.1 6.1 -OB_OUTPUT OB_INPUT",
        codes: ["IN-GST-18 -: 18% 2017-07-01"],
      },
    },
  },
  ZA: {
    taxType: "vat", completeness: "not_applicable complete partial not_applicable partial partial partial",
    returns: {
      ZA_VAT201: {
        filing: "bimonthly portal_manual portal_entry",
        boxes: "1 1A 2 2A 3 -4 -4A 5 6 7 8 -9 10 -11 -12 -13 14 14A 15 15A 16 17 18 19 20",
        formulas: ["8 = 6 + 7", "20 = 13 - 19"],
        codes: ["ZA-VAT-STD -: 10% 1991-09-30, 14% 1993-04-07, 15% 2018-04-01"],
      },
    },
  },
  AE: {
    taxType: "vat", completeness: "not_applicable complete partial not_applicable partial partial partial",
    returns: {
      AE_VAT201: {
        filing: "quarterly portal_manual portal_entry", boxes: "1 2 3 4 5 6 7 8 9 10 11 -12 13 14",
        formulas: ["14 = 12 - 13"],
        codes: ["AE-VAT-STD -: 5% 2018-01-01"],
      },
    },
  },
  JP: {
    taxType: "consumption", completeness: "not_applicable complete partial not_applicable partial partial partial",
    returns: {
      JP_CONSUMPTION: {
        filing: "annual portal_manual portal_entry", boxes: "1 -2 -3 4 5 6 7 8 9 10 11 12 26 -OB_OUTPUT OB_INPUT",
        codes: [
          "JP-CT-STD standard: 3% 1989-04-01, 5% 1997-04-01, 8% 2014-04-01, 10% 2019-10-01",
          "JP-CT-RED reduced: 8% 2019-10-01",
        ],
      },
    },
  },
  CH: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      CH_MWST_ABRECHNUNG: {
        filing: "quarterly portal_manual portal_entry",
        boxes: "200 205 220 221 225 230 235 280 289 299 -303 -302 -313 -312 -343 -342 -383 -382 -399 400 405 410 "
          + "415 420 479 -500 510 -OB_OUTPUT OB_INPUT",
        codes: [
          "CH-VAT-STD standard: 7.6% 2001-01-01, 8% 2011-01-01, 7.7% 2018-01-01, 8.1% 2024-01-01",
          "CH-VAT-RED reduced: 2.4% 2001-01-01, 2.5% 2011-01-01, 2.6% 2024-01-01",
          "CH-VAT-LODGING reduced: 3.6% 2001-01-01, 3.8% 2011-01-01, 3.7% 2018-01-01, 3.8% 2024-01-01",
        ],
      },
    },
  },
  AT: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial not_applicable partial",
    returns: {
      AT_U30: {
        filing: "monthly portal_manual portal_entry", boxes: "000 022 029 006 037 060 095 -OB_OUTPUT OB_INPUT",
        codes: [
          "AT-VAT-STD standard: 20% 2026-08-01",
          "AT-VAT-RED10 reduced: 10% 2026-08-01",
          "AT-VAT-RED13 reduced: 13% 2026-08-01",
          "AT-VAT-ENCLAVE -: 19% 2023-01-01",
        ],
      },
    },
  },
  BE: {
    taxType: "vat", completeness: "partial partial partial not_applicable partial partial partial",
    returns: {
      BE_VAT_PERIODIC: {
        filing: "monthly file_upload certified_file", boxes: "01 02 03 54 59 71 72 -OB_OUTPUT OB_INPUT",
        codes: [
          "BE-VAT-STD standard: 21% 2026-09-18",
          "BE-VAT-RED12 reduced: 12% 2026-09-18",
          "BE-VAT-RED6 reduced: 6% 2026-09-18",
        ],
      },
    },
  },
  PL: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      PL_JPK_V7M: {
        filing: "monthly file_upload certified_file",
        boxes: "P_19 -P_20 P_17 -P_18 P_15 -P_16 P_13 -P_38 P_48 P_51 P_62 -OB_OUTPUT OB_INPUT",
        codes: [
          "PL-VAT-STD standard: 23% 2011-01-01",
          "PL-VAT-RED8 reduced: 8% 2011-01-01",
          "PL-VAT-RED5 reduced: 5% 2021-12-13",
          "PL-VAT-ZERO zero: 0% 2004-05-01",
        ],
      },
    },
  },
  SE: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      SE_MOMSDEKLARATION: {
        filing: "quarterly portal_manual portal_entry", boxes: "05 06 07 08 -10 -11 -12 48 49 -OB_OUTPUT OB_INPUT",
        codes: [
          "SE-VAT-STD standard: 25% 2019-07-01",
          "SE-VAT-RED12 reduced: 12% 2019-07-01",
          "SE-VAT-FOOD6 reduced: 6% 2026-04-01..2027-12-31",
          "SE-VAT-RED6 reduced: 6% 2019-07-01",
        ],
      },
    },
  },
  KR: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      KR_VAT_RETURN: {
        filing: "quarterly portal_manual portal_entry",
        boxes: "-OUTPUT_TAX ZERO_RATED_SUPPLIES INPUT_TAX TAX_PAYABLE_REFUNDABLE -OB_OUTPUT OB_INPUT",
        codes: ["KR-VAT-STD standard: 10% 2024-01-01", "KR-VAT-ZERO zero: 0% 2024-01-01"],
      },
    },
  },
  PT: {
    taxType: "vat", completeness: "complete partial partial not_applicable partial partial partial",
    returns: {
      PT_IVA_DP: {
        filing: "monthly portal_manual portal_entry",
        boxes: "1 -2 5 -6 3 -4 20 21 23 22 24 40 41 61 81 65 66 67 68 90 91 -92 -93 94 95 96 -OB_OUTPUT OB_INPUT",
        codes: [
          "PT-VAT-STD standard: 21% 2010-07-01, 23% 2011-01-01",
          "PT-VAT-INT reduced: 13% 2010-07-01",
          "PT-VAT-RED reduced: 6% 2010-07-01",
          "PT-MAD-VAT-STD standard: 22% 2012-04-01",
          "PT-MAD-VAT-INT reduced: 12% 2012-04-01",
          "PT-MAD-VAT-RED reduced: 4% 2024-10-01",
          "PT-AZO-VAT-STD standard: 16% 2021-07-01",
          "PT-AZO-VAT-INT reduced: 9% 2010-07-01",
          "PT-AZO-VAT-RED reduced: 4% 2010-07-01",
        ],
      },
    },
  },
  DK: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      DK_MOMS: {
        filing: "quarterly portal_manual portal_entry",
        boxes: "-SALGSMOMS -EU_VAREKOEB_MOMS -UDLAND_YDELSER_MOMS KOEBSMOMS MOMSRESULTAT -OB_OUTPUT OB_INPUT",
        formulas: ["MOMSRESULTAT = SALGSMOMS+EU_VAREKOEB_MOMS+UDLAND_YDELSER_MOMS-KOEBSMOMS"],
        codes: ["DK-VAT-STD standard: 25% 1992-01-01"],
      },
    },
  },
  NO: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      NO_MVA_MELDING: {
        filing: "bimonthly efile_api api", boxes: "3 31 33 32 5 6 1 11 13 12 -OB_OUTPUT OB_INPUT",
        codes: [
          "NO-VAT-STD standard: 25% 2012-01-01",
          "NO-VAT-FOOD reduced: 15% 2012-01-01",
          "NO-VAT-PASSENGER reduced: 8% 2012-01-01, 10% 2016-01-01, 12% 2018-01-01, 6% 2020-04-01, 12% 2021-10-01",
          "NO-VAT-FISH-1111 -: 11.11% 2025-01-01",
        ],
      },
    },
  },
  SA: {
    taxType: "vat", completeness: "not_applicable complete partial not_applicable partial partial partial",
    returns: {
      SA_VAT_RETURN: {
        filing: "monthly portal_manual portal_entry", boxes: "1 2 3 4 5 6 7 8 9 10 11 12 -13 14 15 -16 -OB_OUTPUT OB_INPUT",
        codes: ["SA-VAT-STD standard -> 1 7 8 9: 5% 2018-01-01, 15% 2020-07-01", "SA-VAT-ZERO zero: 0% 2018-01-01"],
      },
    },
  },
  TR: {
    taxType: "vat", completeness: "partial partial partial partial partial partial partial",
    returns: {
      TR_KDV1: {
        filing: "monthly portal_manual portal_entry",
        boxes: "MATRAH-20 -HESAPLANAN-20 MATRAH-10 -HESAPLANAN-10 MATRAH-1 -HESAPLANAN-1 INDIRILECEK-KDV "
          + "ODENECEK-KDV -OB_OUTPUT OB_INPUT",
        codes: [
          "TR-VAT-STD standard: 18% 2007-12-31, 20% 2023-07-10",
          "TR-VAT-RED10 reduced: 8% 2007-12-31, 10% 2023-07-10",
          "TR-VAT-RED1 reduced: 1% 2007-12-31",
        ],
      },
    },
  },
  HU: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      HU_AFA_65: {
        filing: "monthly file_upload certified_file", boxes: "05 06 07 110 36 64 65 66 111 76 83 84 85 -OB_OUTPUT OB_INPUT",
        codes: [
          "HU-VAT-STD standard: 27% 2012-01-01",
          "HU-VAT-RED18 reduced: 18% 2012-01-01",
          "HU-VAT-RED5 reduced: 5% 2012-01-01",
          "HU-VAT-ZERO zero: 0% 2012-01-01",
        ],
      },
    },
  },
  RO: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      RO_D300: {
        filing: "monthly file_upload certified_file", boxes: "9 10 19 24 25 31 32 36 37 38 41 44 45 46 -OB_OUTPUT OB_INPUT",
        codes: ["RO-VAT-STD standard: 19% 2017-01-01, 21% 2025-08-01", "RO-VAT-RED11 reduced: 11% 2025-08-01"],
      },
    },
  },
  FI: {
    taxType: "vat", completeness: "partial partial partial not_applicable partial partial partial",
    returns: {
      FI_ALV: {
        filing: "monthly portal_manual portal_entry", boxes: "-301 -302 -303 305 306 307 308 -OB_OUTPUT OB_INPUT",
        formulas: ["308 = 301 + 302 + 303 + 305 + 306 - 307"],
        codes: [
          "FI-VAT-STD standard: 24% 2013-01-01, 25.5% 2024-09-01",
          "FI-VAT-RED135 reduced: 14% 2025-01-01, 13.5% 2026-01-01",
          "FI-VAT-RED10 reduced: 10% 2013-01-01, 10% 2025-01-01",
          "FI-VAT-ZERO zero: 0% 2026-01-01",
        ],
      },
    },
  },
  CL: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      CL_F29: {
        filing: "monthly portal_manual portal_entry",
        boxes: "502 111 513 -510 -709 517 501 154 518 538 520 525 -528 532 535 553 504 -593 -594 -592 -539 164 127 "
          + "544 523 537 77 89 91 -OB_OUTPUT OB_INPUT",
        formulas: ["89 = 538 - 537"],
        codes: ["CL-VAT-STD standard: 19% 2003-10-01"],
      },
    },
  },
  AR: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      AR_IVA_SIMPLE: {
        filing: "monthly portal_manual portal_entry",
        boxes: "REG_EMITIDOS REG_RECIBIDOS -DET_DEBITO DET_CREDITO DET_RET_PERC DET_PAGOS_CTA DET_SALDO -OB_OUTPUT OB_INPUT",
        codes: [
          "AR-VAT-STD standard: 18% 1992-03-01, 21% 1995-04-01, 21% 1996-04-01, 19% 2002-11-18, 21% 2003-01-18",
          "AR-VAT-RED105 reduced: 9.5% 2002-11-18, 10.5% 2003-01-18",
          "AR-VAT-INC27 -: 27% 1992-03-01",
        ],
      },
      AR_F2002: {
        filing: "monthly portal_manual portal_entry",
        boxes: "-DF_ALIC_21 -DF_ALIC_105 -DF_ALIC_27 CF_TOTAL SALDO_AFIP SALDO_CONTRIB -OB_OUTPUT OB_INPUT",
        codes: [
          "AR-VAT-STD standard: 18% 1992-03-01, 21% 1995-04-01, 21% 1996-04-01, 19% 2002-11-18, 21% 2003-01-18",
          "AR-VAT-RED105 reduced: 9.5% 2002-11-18, 10.5% 2003-01-18",
          "AR-VAT-INC27 -: 27% 1992-03-01",
        ],
      },
    },
  },
  MX: {
    taxType: "vat", completeness: "partial partial partial not_applicable partial partial partial",
    returns: {
      MX_IVA_MENSUAL: {
        filing: "monthly portal_manual portal_entry", boxes: "-IVA-CAUSADO IVA-ACREDITABLE IVA-CARGO IVA-FAVOR -OB_OUTPUT OB_INPUT",
        codes: [
          "MX-VAT-STD standard: 16% 2014-01-01",
          "MX-VAT-NORTH-8 reduced: 8% 2019-01-01, 8% 2026-01-01..2026-12-31",
          "MX-VAT-SOUTH-8 reduced: 8% 2021-01-01, 8% 2026-01-01..2026-12-31",
          "MX-VAT-ZERO zero: 0% 2014-01-01",
        ],
      },
    },
  },
  GR: {
    taxType: "vat", completeness: "not_applicable partial partial partial partial partial partial",
    returns: {
      GR_FPA_F2: {
        filing: "quarterly portal_manual portal_entry",
        boxes: "301 -331 302 -332 303 -333 308 -338 304 -334 305 -335 306 -336 309 -339 307 -337 367 387 430 470 "
          + "480 511 502 503 -OB_OUTPUT OB_INPUT",
        codes: [
          "GR-VAT-STD standard: 24% 2024-07-01",
          "GR-VAT-RED13 reduced: 13% 2024-07-01",
          "GR-VAT-RED6 reduced: 6% 2024-07-01",
          "GR-VAT-RED4 reduced: 4% 2024-07-01",
          "GR-VAT-ISL17 reduced: 17% 2026-01-01",
          "GR-VAT-ISL9 reduced: 9% 2026-01-01",
          "GR-VAT-ISL4 reduced: 4% 2026-01-01",
          "GR-VAT-ISL3 reduced: 3% 2026-01-01",
        ],
      },
    },
  },
  CO: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial not_applicable partial",
    returns: {
      CO_F300: {
        filing: "bimonthly portal_manual portal_entry", boxes: "27 28 35 -57 -58 -65 75 79 80 81 -OB_OUTPUT OB_INPUT",
        codes: [
          "CO-VAT-STD standard -> 28 58: 19% 2017-01-01",
          "CO-VAT-RED5 reduced: 5% 2017-01-01",
          "CO-VAT-ZERO zero -> 35: 0% 2017-01-01",
        ],
      },
    },
  },
  IS: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      IS_VSK: {
        filing: "bimonthly portal_manual portal_entry",
        boxes: "VELTA-24 VELTA-11 VELTA-0 -UTSKATTUR INNSKATTUR MISMUNUR -OB_OUTPUT OB_INPUT",
        formulas: ["MISMUNUR = UTSKATTUR - INNSKATTUR"],
        codes: ["IS-VAT-STD standard: 24% 2015-01-01", "IS-VAT-RED11 reduced: 11% 2015-01-01", "IS-VAT-ZERO zero: 0% 2014-09-01"],
      },
    },
  },
  CZ: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      CZ_DPH: {
        filing: "monthly file_upload certified_file", boxes: "1 2 20 -OB_OUTPUT 40 41 46 OB_INPUT 62 63 64 65",
        codes: ["CZ-VAT-STD standard: 21% 2023-06-06", "CZ-VAT-RED12 reduced: 12% 2024-01-01", "CZ-VAT-ZERO zero: 0% 2024-01-01"],
      },
    },
  },
  TH: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      TH_PP30: {
        filing: "monthly portal_manual portal_entry", boxes: "1 2 3 4 -5 6 7 8 9 10 11 12 -OB_OUTPUT OB_INPUT",
        codes: [
          "TH-VAT-STD standard: 7% 2023-10-01, 7% 2024-10-01, 7% 2025-10-01, 7% 2026-10-01..2027-09-30",
          "TH-VAT-ZERO zero: 0% 2000-02-07",
        ],
      },
    },
  },
  KE: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      KE_VAT3: {
        filing: "monthly portal_manual portal_entry",
        boxes: "-OUTPUT_TAX ZERO_RATED_SUPPLIES INPUT_TAX WITHHOLDING_VAT EXCESS_INPUT_BF TAX_PAYABLE_CREDIT_CF "
          + "-OB_OUTPUT OB_INPUT",
        codes: ["KE-VAT-STD standard -> OUTPUT_TAX: 14% 2020-04-01, 16% 2021-01-01", "KE-VAT-ZERO zero: 0% 2020-04-01"],
      },
    },
  },
  PH: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      PH_BIR_2550Q: {
        filing: "quarterly portal_manual portal_entry", boxes: "-31 32 -34 -37 60 61 -OB_OUTPUT OB_INPUT",
        codes: ["PH-VAT-STD standard: 12% 2024-04-01", "PH-VAT-ZERO zero: 0% 2024-04-01"],
      },
    },
  },
  VN: {
    taxType: "vat", completeness: "not_applicable partial partial not_applicable partial partial partial",
    returns: {
      VN_GTGT_01: {
        filing: "monthly portal_manual portal_entry",
        boxes: "27 -28 29 30 -31 32 -33 25 36 40 PL08-I-05 PL08-I-06 PL08-II-07 -PL08-II-08 PL08-III-09 -OB_OUTPUT OB_INPUT",
        codes: [
          "VN-VAT-STD standard: 10% 2009-01-01",
          "VN-VAT-RED8 reduced: 8% 2025-07-01..2026-12-31",
          "VN-VAT-RED5 reduced: 5% 2009-01-01",
          "VN-VAT-ZERO zero: 0% 2009-01-01",
        ],
      },
    },
  },
};

test("the fact table has exactly one row per registered pack", () => {
  assert.deepEqual(Object.keys(PACK_FACTS).sort(), COUNTRY_TAX_PACKS.map((pack) => pack.country).sort());
});

for (const pack of COUNTRY_TAX_PACKS) {
  test(`${pack.country} files the returns, boxes and dated rate bands in its row`, () => {
    assert.deepEqual(factsOf(pack), PACK_FACTS[pack.country], `${pack.code} differs from its PACK_FACTS row`);
  });
}

/**
 * Bands whose history has deliberate holes. Revenue's table lists several
 * simultaneous second-reduced rates for 1983-1985 and none in other eras, so
 * Ireland's band covers only its single-value eras rather than a guessed one.
 */
const DISCONTIGUOUS_BANDS = new Set(["IE-VAT-RED2"]);

test("every band's rate history is closed and contiguous unless its gaps are named", () => {
  const gapped = new Set<string>();
  for (const pack of COUNTRY_TAX_PACKS) {
    for (const returnCode of packReturnCodesWithTaxCodes(pack)) {
      for (const code of packTaxCodesForReturn(pack, returnCode)) {
        const label = `${pack.country}/${returnCode}/${code.code}`;
        const rates = code.rates ?? [];
        assert.ok(rates.length > 0, `${label} declares no rate history`);
        for (let index = 1; index < rates.length; index++) {
          const prior = rates[index - 1]!;
          const current = rates[index]!;
          assert.ok(prior.effectiveTo, `${label}: the ${prior.ratePercent}% band before ${current.effectiveFrom} must be closed`);
          if (dayAfter(prior.effectiveTo) === current.effectiveFrom) continue;
          gapped.add(code.code);
          assert.ok(
            DISCONTIGUOUS_BANDS.has(code.code),
            `${label}: ${prior.ratePercent}% ends ${prior.effectiveTo} but the next band opens ${current.effectiveFrom} — ` +
              `transcribe the missing era or name the band in DISCONTIGUOUS_BANDS with its reason`,
          );
        }
      }
    }
  }
  assert.deepEqual([...gapped].sort(), [...DISCONTIGUOUS_BANDS].sort(), "named gaps must all be live");
});

/** Packs set up per state or province rather than through one country-level return. */
const PROVISIONED_BY_SUBDIVISION = new Set(["US"]);

test("every pack with a country-level return is provisionable by country from setup", () => {
  const catalog = new Map(supportedTaxCountries().map((entry) => [entry.country, entry]));
  for (const pack of COUNTRY_TAX_PACKS) {
    const entry = catalog.get(pack.country);
    assert.ok(entry, `${pack.country} is absent from setup`);
    if (PROVISIONED_BY_SUBDIVISION.has(pack.country)) {
      assert.equal(entry.countryStatus, "subdivisions", `${pack.country} installs by subdivision`);
      continue;
    }
    assert.equal(entry.countryStatus, "ready", `${pack.country} is not ready in setup`);
    assert.ok(pack.parentReturnPackCode, `${pack.country} names no country-level return`);
    assert.equal(entry.countryPack, pack.parentReturnPackCode, `${pack.country} setup installs a different return`);
    assert.equal(isTaxProvisionSelection(pack.parentReturnPackCode), true, `${pack.country} return is not selectable`);
  }
});

const WORKPAPER_BOXES: Record<string, Pick<TaxReturnPackBox, "basis" | "glMap">> = {
  OB_OUTPUT: { basis: "tax_collected", glMap: "sales" },
  OB_INPUT: { basis: "tax_paid", glMap: "purchases" },
};

test("every return files over https and ties its workpaper boxes to the ledger side they reconcile", () => {
  for (const pack of COUNTRY_TAX_PACKS) {
    for (const returnPack of pack.returnPacks) {
      assert.match(returnPack.submissionUrl, /^https:\/\//, `${returnPack.code} files at a non-https address`);
      for (const box of returnPack.boxes) {
        const expected = WORKPAPER_BOXES[box.lineCode];
        if (!expected) continue;
        assert.deepEqual({ basis: box.basis, glMap: box.glMap }, expected, `${returnPack.code}/${box.lineCode} reconciles the wrong ledger side`);
      }
    }
  }
});

/**
 * Authority hosts per country: a pack may cite its own tax authority,
 * finance ministry, official gazette or statute book, never a vendor page and
 * never another country's authority. Additions name their reason inline.
 */
const AUTHORITY_HOSTS: Record<string, readonly string[]> = {
  AE: ["www.tax.gov.ae", "tax.gov.ae"],
  AR: ["servicios.infoleg.gob.ar", "www.afip.gob.ar", "biblioteca.arca.gob.ar", "www.arca.gob.ar"],
  AT: ["formulare.bmf.gv.at", "www.usp.gv.at", "finanzonline.bmf.gv.at"],
  AU: ["www.ato.gov.au"],
  BE: ["finance.belgium.be"],
  CA: ["www.canada.ca", "www.bclaws.gov.bc.ca", "www.gov.mb.ca", "www.revenuquebec.ca", "sets.saskatchewan.ca"],
  CH: ["www.estv.admin.ch", "www.bazg.admin.ch", "www.estv2.admin.ch"],
  CL: ["www.sii.cl", "www.contraloria.cl"],
  CO: ["www.dian.gov.co", "www.funcionpublica.gov.co", "muisca.dian.gov.co"],
  // e-Sbírka is the state's legislation portal: the enacted instrument itself.
  CZ: ["financnisprava.gov.cz", "www.e-sbirka.cz", "adisspr.mfcr.cz"],
  DE: ["www.bundesfinanzministerium.de", "www.elster.de"],
  DK: ["skat.dk", "www.retsinformation.dk"],
  ES: ["sede.agenciatributaria.gob.es"],
  FI: ["www.vero.fi", "vero.fi"],
  FR: ["bofip.impots.gouv.fr", "www.impots.gouv.fr"],
  GB: ["www.gov.uk"],
  GR: ["diavgeia.gov.gr", "minfin.gov.gr"],
  HU: ["nav.gov.hu", "www.magyarkozlony.hu"],
  IE: ["www.revenue.ie"],
  IN: ["cbic-gst.gov.in", "tutorial.gst.gov.in"],
  IS: ["www.skatturinn.is", "www.althingi.is", "www.reglugerd.is"],
  IT: ["www.gazzettaufficiale.it", "def.finanze.it", "www1.agenziaentrate.gov.it", "www.agenziaentrate.gov.it"],
  JP: ["www.nta.go.jp"],
  KE: ["www.kra.go.ke"],
  KR: ["nts.go.kr", "mofe.go.kr"],
  MX: ["www.diputados.gob.mx", "www.sat.gob.mx", "dof.gob.mx"],
  NL: ["www.belastingdienst.nl", "zoek.officielebekendmakingen.nl", "download.belastingdienst.nl", "wetten.overheid.nl"],
  NO: ["lovdata.no", "www.skatteetaten.no"],
  NZ: ["www.taxtechnical.ird.govt.nz", "www.ird.govt.nz"],
  PH: ["www.bir.gov.ph", "bir-cdn.bir.gov.ph"],
  PL: ["www.podatki.gov.pl", "api.sejm.gov.pl", "podatki-arch.mf.gov.pl"],
  PT: ["www.portaldasfinancas.gov.pt", "info.portaldasfinancas.gov.pt", "at.madeira.gov.pt"],
  RO: ["static.anaf.ro"],
  SA: ["zatca.gov.sa"],
  // Svensk författningssamling, the statute book: SFS 2026:118 enacts the
  // temporary 6% food rate and SFS 2026:119 reverts it, so the band's end
  // date is attested by enacted law rather than by an announcement.
  SE: ["www.skatteverket.se", "svenskforfattningssamling.se"],
  SG: ["www.iras.gov.sg", "apisandbox.iras.gov.sg"],
  TH: ["www.rd.go.th", "rd.go.th", "efiling.rd.go.th"],
  TR: ["www.resmigazete.gov.tr", "dijital.gib.gov.tr", "ebeyan.gib.gov.tr"],
  US: [
    "otr.cfo.dc.gov", "revenue.louisiana.gov", "www.tax.newmexico.gov", "dor.sd.gov", "www.cdtfa.ca.gov",
    "comptroller.texas.gov", "www.tax.ny.gov", "floridarevenue.com",
  ],
  VN: ["congbaocdn.chinhphu.vn", "www.vietnamtradeportal.gov.vn", "thuedientu.gdt.gov.vn"],
  ZA: ["www.sars.gov.za"],
};

/**
 * Mirrored primary documents, id-specific and never host-wide: the document
 * is the authority's own file and only the host is secondary. Each entry
 * names its reason; the owning pack's doc comment carries the full story.
 */
const MIRRORED_PRIMARY_DOCUMENTS: Record<string, string> = {
  // BMF's own U30 form (KZ 037 Jungholz/Mittelberg claim) via the
  // statutory chamber's mirror; the BMF formularservice does not host
  // that vintage. See the Austria pack doc comment.
  bmf_u30_2023: "www.wko.at",
  // Skatteetaten's own published SAF-T code specification (mvaKodeSAFT)
  // for the mva-meldingen return; the tax agency publishes its machine
  // return specification on GitHub. See the Norway pack doc comment.
  saft_mva_koder: "github.com",
  // DSIVA's own 2010 ofícios circulados via professional-body mirrors: the
  // AT portal archives no DSIVA-era ofícios and the gazette PDFs are not
  // retrievable from this sandbox. Both texts were read in full and state
  // exactly the cited rates and dates. See the Portugal pack doc comment.
  at_dp_modelo_instrucoes: "www.aproces.org",
  dsiva_oc30118_2010_aplicabilidade: "cihc.occ.pt",
  dsiva_oc30121_2010_taxa_normal: "www.apeca.pt",
  // AADE's own Φ2 form (050 ΦΠΑ ΕΚΔΟΣΗ 2024 under decision A.1058/2024)
  // mirrored by the logistis.gr accounting portal; every 2024 box change
  // cross-checks against AADE circular E.2030 on Diavgeia. See the Greece
  // pack doc comment.
  gr_f2_form_2024_mirror: "www.logistis.gr",
  // OPANAF order 2131/2025 (D300 model, MO nr. 826/2025) mirrored by the
  // LegisRO legal publisher; the mirrored PDF carries the official
  // “Monitorul Oficial al României, Partea I, nr. 826/2025” reference.
  // Re-source to an ANAF host if the order appears there.
  mo_826_2025_d300: "legis.medleg.ro",
  // Streamlined Sales Tax Governing Board state-rate tables: the joint
  // publication of the member-state revenue agencies, not a vendor.
  sst_state_tables: "www.streamlinedsalestax.org",
  // USPS postal abbreviations for the US state-code table: the federal
  // postal authority's own publication, not a vendor.
  usps_subdivision_codes: "about.usps.com",
};

test("every pack sources only its own country's authority hosts or a named mirror", () => {
  const seenExceptions = new Set<string>();
  for (const pack of COUNTRY_TAX_PACKS) {
    const hosts = new Set(AUTHORITY_HOSTS[pack.country] ?? []);
    assert.ok(pack.sources.length > 0, `${pack.country} declares no sources`);
    for (const source of pack.sources) {
      const host = new URL(source.url).hostname;
      if (MIRRORED_PRIMARY_DOCUMENTS[source.id] === host) {
        seenExceptions.add(source.id);
        continue;
      }
      assert.ok(
        hosts.has(host),
        `${pack.country}/${source.id} rests on ${host}, which is not a ${pack.country} authority host — ` +
          `re-source to the authority or name a per-source-id exception`,
      );
    }
  }
  assert.deepEqual([...seenExceptions].sort(), Object.keys(MIRRORED_PRIMARY_DOCUMENTS).sort(), "named exceptions must all be live");
});

/**
 * Statutory fidelity of rate bands vs return boxes: every rate a pack can
 * price must have a declared destination on its return — a real
 * box/casilla/line — and every band's window must open at a sourced
 * effective date, never at the fetch date.
 */

function governmentBoxes(pack: CountryTaxPackDefinition, returnPackCode: string): TaxReturnPackBox[] {
  const returnPack = pack.returnPacks.find((entry) => entry.code === returnPackCode);
  assert.ok(returnPack, `${pack.country}: return pack ${returnPackCode} is missing`);
  return returnPack.boxes.filter((box) => !box.lineCode.startsWith("OB_"));
}

/** Percent numbers named by a box label, with comma decimals ("10,5%"). */
function labelPercents(label: string): string[] {
  return [...label.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map((match) => match[1]!.replace(",", "."));
}

test("statutory fidelity: every priced band on a rate-split return has a box, a declared destination, or a reviewed workpaper-only reason", () => {
  for (const pack of COUNTRY_TAX_PACKS) {
    for (const returnPackCode of packReturnCodesWithTaxCodes(pack)) {
      const gov = governmentBoxes(pack, returnPackCode);
      const govCodes = new Set(gov.map((box) => box.lineCode));
      // An aggregate return (LIPE totals, GSTR-3B, BAS) routes every band
      // through its totals by construction — only a return that splits
      // bands across boxes can drop one.
      if (!gov.some((box) => labelPercents(box.label).length > 0)) continue;
      for (const code of packTaxCodesForReturn(pack, returnPackCode)) {
        const routed = code.ratePercent === "0"
          ? gov.some((box) => labelPercents(box.label).includes("0") || /\bzero\b/i.test(box.label))
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

test("statutory fidelity: no band opens at its source's fetch date without a reviewed truncation reason", () => {
  for (const pack of COUNTRY_TAX_PACKS) {
    const sources = new Map(pack.sources.map((source) => [source.id, source] as const));
    for (const returnPackCode of packReturnCodesWithTaxCodes(pack)) {
      for (const code of packTaxCodesForReturn(pack, returnPackCode)) {
        const first = code.rates?.[0];
        if (!first || first.effectiveFrom !== sources.get(first.sourceId)?.asOf) continue;
        assert.ok(
          code.truncatedScheduleReason && code.truncatedScheduleReason.length > 0,
          `${pack.country}/${returnPackCode}/${code.code} opens ${first.effectiveFrom}, the cited source's own asOf date: ` +
            `re-date the band from the sourced effective date or record a reviewed truncatedScheduleReason`,
        );
      }
    }
  }
});
