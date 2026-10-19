import { ratesForPayDate } from "./rates.ts";

/** Resolve the statutory caps used by Canadian year-end slips from the filing year's published rates. */
export function canadianYearEndCaps(taxYear: number): {
  mie: string;
  cppYmpe: string;
  cppYampe: string;
  qppYmpe: string;
  qppYampe: string;
  qpipMie: string;
} {
  const rates = ratesForPayDate(`${taxYear}-07-01`);
  return {
    mie: rates.ei.mie,
    cppYmpe: rates.cpp.ympe,
    cppYampe: rates.cpp.yampe,
    qppYmpe: rates.qpp.ympe,
    qppYampe: rates.qpp.yampe,
    qpipMie: rates.qpip.mie,
  };
}
