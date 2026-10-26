import { isUuid } from "@openbooks/engine/platform/identifiers";

export type ChequeStockPosition = "top" | "middle" | "bottom";

export const CHEQUE_STOCKS: Record<
  ChequeStockPosition,
  { instrumentTop: number; voucherTop: number; voucherHeight: number }
> = {
  top: { instrumentTop: 4, voucherTop: 97.13, voucherHeight: 176.27 },
  middle: { instrumentTop: 97.13, voucherTop: 190.27, voucherHeight: 83.13 },
  bottom: { instrumentTop: 190.27, voucherTop: 4, voucherHeight: 176.27 },
};

/** Stock and calibration are part of the editable HTML, and therefore its audited design hash. */
export function applyChequeStock(
  source: string,
  stock: ChequeStockPosition,
  xMm = 0,
  yMm = 0,
): string {
  if (
    !Object.hasOwn(CHEQUE_STOCKS, stock) ||
    !Number.isFinite(xMm) ||
    !Number.isFinite(yMm) ||
    Math.abs(xMm) > 6 ||
    Math.abs(yMm) > 6
  )
    throw new Error("Choose top, middle or bottom stock and an alignment correction within 6 mm.");
  const config = CHEQUE_STOCKS[stock];
  const replaceRegion = (id: string, top: number, height: number) => {
    const tag = new RegExp(`<section(?=[^>]*id=["']${id}["'])[^>]*>`, "i");
    if (!tag.test(source))
      throw new Error("Start from a cheque stock preset before changing its alignment.");
    source = source.replace(
      tag,
      `<section id="${id}" data-cheque-region="true" style="position:absolute;left:${12.5 + xMm}mm;top:${top + yMm}mm;width:190.9mm;height:${height}mm;overflow:visible;">`,
    );
  };
  replaceRegion("ob-cheque-instrument", config.instrumentTop, 85);
  replaceRegion("ob-cheque-voucher", config.voucherTop, config.voucherHeight);
  const child = (id: string, attributes: string) => {
    const tag = new RegExp(`<div(?=[^>]*id=["']${id}["'])[^>]*>`, "i");
    if (!tag.test(source)) {
      if (stock === "middle")
        throw new Error(
          "Use the native stock preset to split the voucher above and below a middle cheque.",
        );
      return;
    }
    source = source.replace(tag, `<div id="${id}" ${attributes}>`);
  };
  if (stock === "middle") {
    source = source.replace(
      /<section(?=[^>]*id=["']ob-cheque-voucher["'])[^>]*>/i,
      `<section id="ob-cheque-voucher" style="position:absolute;left:${12.5 + xMm}mm;top:${4 + yMm}mm;width:190.9mm;height:269.4mm;">`,
    );
    child(
      "ob-cheque-voucher-earnings",
      'data-cheque-region="true" style="position:absolute;left:0;top:0;width:100%;height:83.13mm;overflow:visible;"',
    );
    child(
      "ob-cheque-voucher-deductions",
      'data-cheque-region="true" style="position:absolute;left:0;top:186.27mm;width:100%;height:83.13mm;overflow:visible;"',
    );
  } else {
    child("ob-cheque-voucher-earnings", "");
    child("ob-cheque-voucher-deductions", "");
  }
  source = source
    .replace(/data-cheque-stock=["'][^"']*["']/i, `data-cheque-stock="${stock}"`)
    .replace(/data-cheque-offset-x=["'][^"']*["']/i, `data-cheque-offset-x="${xMm}"`)
    .replace(/data-cheque-offset-y=["'][^"']*["']/i, `data-cheque-offset-y="${yMm}"`);
  return source;
}

export function chequeStockFromSource(
  source: string,
): { stock: ChequeStockPosition; xMm: number; yMm: number } | null {
  const stock = source.match(/data-cheque-stock=["'](top|middle|bottom)["']/i)?.[1] as
    ChequeStockPosition | undefined;
  if (!stock) return null;
  const offset = (axis: string) =>
    Number(
      source.match(
        new RegExp(`data-cheque-offset-${axis}=["'](-?\\d+(?:\\.\\d+)?)["']`, "i"),
      )?.[1] ?? 0,
    );
  return { stock, xMm: offset("x"), yMm: offset("y") };
}

export function chequeBankDesign(source: string): { profileId: string | null; printMicr: boolean } {
  const profileId = source.match(/data-cheque-bank-profile=["']([^"']*)["']/i)?.[1] || null;
  if (profileId && !isUuid(profileId)) throw new Error("Select a valid cheque bank profile.");
  const mode = source.match(/data-cheque-micr=["']([^"']*)["']/i)?.[1] ?? "preprinted";
  if (!["preprinted", "printed"].includes(mode))
    throw new Error("Choose preprinted bank stock or printed MICR.");
  if (mode === "printed" && !profileId)
    throw new Error("Select a cheque bank profile before printing MICR.");
  return { profileId, printMicr: mode === "printed" };
}

export function applyChequeBankDesign(
  source: string,
  profileId: string | null,
  printMicr: boolean,
  encoding: "unicode" | "abcd" = "unicode",
): string {
  if (profileId && !isUuid(profileId)) throw new Error("Select a valid cheque bank profile.");
  if (printMicr && !profileId)
    throw new Error("Select a cheque bank profile before printing MICR.");
  if (encoding !== "unicode" && encoding !== "abcd")
    throw new Error("Choose Unicode or A/C/D MICR font encoding.");
  const sheetId = /id=(["'])ob-cheque-sheet\1/i;
  if (!sheetId.test(source))
    throw new Error("Start from a cheque stock preset before choosing its bank profile.");
  const cleaned = source.replace(
    /\sdata-cheque-(?:bank-profile|micr|micr-encoding)=["'][^"']*["']/gi,
    "",
  );
  const result = cleaned.replace(
    sheetId,
    `id="ob-cheque-sheet" data-cheque-bank-profile="${profileId ?? ""}" data-cheque-micr="${printMicr ? "printed" : "preprinted"}" data-cheque-micr-encoding="${encoding}"`,
  );
  chequeBankDesign(result);
  chequeMicrEncoding(result);
  return result;
}

export function chequeMicrEncoding(source: string): "unicode" | "abcd" {
  const encoding = source.match(/data-cheque-micr-encoding=["']([^"']*)["']/i)?.[1] ?? "unicode";
  if (encoding !== "unicode" && encoding !== "abcd")
    throw new Error("Choose Unicode or A/C/D MICR font encoding.");
  return encoding;
}
