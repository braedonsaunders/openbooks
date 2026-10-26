import { PaymentError } from "./payment-errors.ts";
import { parseIsoDate, utcDateFromParts } from "../platform/business-date.ts";
import { asciiRailText, ORIGINATOR_REMEDY, PAYEE_NAME_REMEDY } from "./rail-text.ts";

/** RBC ACH Direct Deposits, STD152 credit specification, version 11 (April 2021). */
export interface RbcStd152Settings {
  clientNumber: string;
  originatorLongName: string;
  originatorShortName: string;
  transactionCode: string;
  serviceCurrency: "CAD" | "USD";
  transmission: "file_transfer" | "file_transfer_legacy" | "direct";
  environment: "test" | "production";
}

export interface RbcStd152Payment {
  amountCents: bigint;
  fundsDate: string;
  institution: string;
  transit: string;
  accountNumber: string;
  payeeName: string;
  crossReference: string;
  paymentNumber?: string;
  language?: "E" | "F";
}

export function validateRbcStd152Settings(
  raw: Partial<RbcStd152Settings>,
): { ok: true; settings: RbcStd152Settings } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  if (typeof raw.clientNumber !== "string" || !/^\d{10}$/.test(raw.clientNumber))
    missing.push("clientNumber (10 digits assigned by RBC)");
  for (const field of ["originatorLongName", "originatorShortName"] as const) {
    if (typeof raw[field] !== "string" || !raw[field]?.trim() || raw[field]?.includes("FILL-ME"))
      missing.push(field);
  }
  if (typeof raw.transactionCode !== "string" || !/^\d{3}$/.test(raw.transactionCode))
    missing.push("transactionCode (3 digits; payroll uses 200)");
  if (raw.serviceCurrency !== "CAD" && raw.serviceCurrency !== "USD")
    missing.push("serviceCurrency (CAD or USD)");
  if (
    raw.transmission !== "file_transfer" &&
    raw.transmission !== "file_transfer_legacy" &&
    raw.transmission !== "direct"
  )
    missing.push("transmission (file_transfer, file_transfer_legacy or direct)");
  if (raw.environment !== "test" && raw.environment !== "production")
    missing.push("environment (test or production)");
  if (missing.length) return { ok: false, missing };
  try {
    text(raw.originatorLongName!, 30, "originator legal name", ORIGINATOR_REMEDY);
    text(raw.originatorShortName!, 15, "originator short name", ORIGINATOR_REMEDY);
  } catch (error) {
    return { ok: false, missing: [error instanceof Error ? error.message : "originator names"] };
  }
  return { ok: true, settings: raw as RbcStd152Settings };
}

function text(value: string, width: number, field: string, remedy: string): string {
  // Bank character restrictions are applied here without renaming the legal party.
  // Conventional name punctuation separates words; all letters and digits survive.
  const folded = asciiRailText(value, "RBC STD152", field, remedy)
    .toUpperCase()
    .replace(/[.,'\-]/g, " ")
    .replace(/ +/g, " ")
    .trim();
  if (!folded.trim() || !/^[A-Z0-9 ]+$/.test(folded))
    throw new PaymentError(`RBC STD152 ${field} requires letters, digits and spaces. ${remedy}`);
  return folded.slice(0, width).padEnd(width, " ");
}

function number(value: bigint | number, width: number): string {
  const digits = String(value);
  if (!/^\d+$/.test(digits) || digits.length > width)
    throw new PaymentError(`RBC STD152 value does not fit its ${width}-digit field`);
  return digits.padStart(width, "0");
}

function civilDay(iso: string): Date {
  try {
    return parseIsoDate(iso);
  } catch {
    throw new PaymentError(`RBC STD152 date "${iso}" must be a valid YYYY-MM-DD civil day`);
  }
}

function julian(iso: string): string {
  const date = civilDay(iso);
  const year = date.getUTCFullYear();
  const ordinal =
    Math.floor((date.getTime() - utcDateFromParts(year, 0, 1).getTime()) / 86400000) + 1;
  return `${String(year).padStart(4, "0")}${number(ordinal, 3)}`;
}

/** Canadian-bank credits; U.S. IAT recipients require a separate address-aware rail. */
export function buildRbcStd152File(run: {
  settings: RbcStd152Settings;
  fileCreationNumber: number;
  fileCreationDate: string;
  payments: readonly RbcStd152Payment[];
}): string {
  const checked = validateRbcStd152Settings(run.settings);
  if (!checked.ok)
    throw new PaymentError(`RBC STD152 profile is incomplete: ${checked.missing.join(", ")}`);
  const s = checked.settings;
  if (
    !Number.isInteger(run.fileCreationNumber) ||
    run.fileCreationNumber < 1 ||
    run.fileCreationNumber > 9999
  )
    throw new PaymentError(
      "RBC STD152 requires an allocated file creation number between 1 and 9999",
    );
  if (!run.payments.length) throw new PaymentError("RBC STD152 has no credits to export");
  const creation = civilDay(run.fileCreationDate);
  const records: string[] = [];
  const record = (kind: string, identifier: string, body: string) => {
    const value = number(records.length + 1, 6) + kind + identifier + s.clientNumber + body;
    if (value.length > 152) throw new PaymentError("RBC STD152 record exceeds 152 characters");
    records.push(value.padEnd(152, " "));
  };
  record(
    "A",
    "HDR",
    text(s.originatorLongName, 30, "originator legal name", ORIGINATOR_REMEDY) +
      (s.environment === "test" ? "TEST" : number(run.fileCreationNumber, 4)) +
      julian(run.fileCreationDate) +
      s.serviceCurrency +
      "1",
  );
  let total = 0n;
  for (const p of run.payments) {
    if (typeof p.amountCents !== "bigint" || p.amountCents <= 0n)
      throw new PaymentError("RBC STD152 credit amounts must be positive integer cents");
    const offset = (civilDay(p.fundsDate).getTime() - creation.getTime()) / 86400000;
    if (offset < -30 || offset > 173)
      throw new PaymentError(
        `RBC STD152 payment date for ${p.payeeName} must be within 30 days before and 173 days after file creation`,
      );
    if (!/^\d{3}$/.test(p.institution) || !/^\d{5}$/.test(p.transit))
      throw new PaymentError(
        `RBC STD152 ${p.payeeName} requires a 3-digit institution and 5-digit transit`,
      );
    if (!/^\d{1,12}$/.test(p.accountNumber))
      throw new PaymentError(
        `RBC STD152 ${p.payeeName} requires the significant 1–12 account digits, without padding or separators`,
      );
    if (p.crossReference.length > 19)
      throw new PaymentError("RBC STD152 customer reference exceeds 19 characters");
    if (p.paymentNumber !== undefined && !/^\d{2}$/.test(p.paymentNumber))
      throw new PaymentError("RBC STD152 payment number must be two digits");
    if (p.language !== undefined && p.language !== "E" && p.language !== "F")
      throw new PaymentError("RBC STD152 language must be E or F");
    record(
      "C",
      s.transactionCode,
      " " +
        text(p.crossReference, 19, "customer reference", ORIGINATOR_REMEDY) +
        (p.paymentNumber ?? "00") +
        "0" +
        p.institution +
        p.transit +
        p.accountNumber.padEnd(18, " ") +
        " " +
        number(p.amountCents, 10) +
        " ".repeat(6) +
        julian(p.fundsDate) +
        text(p.payeeName, 30, "recipient legal name", PAYEE_NAME_REMEDY) +
        (p.language ?? "E") +
        " " +
        text(s.originatorShortName, 15, "originator short name", ORIGINATOR_REMEDY) +
        s.serviceCurrency +
        " " +
        "CAN" +
        " ".repeat(4) +
        "N",
    );
    total += p.amountCents;
  }
  record(
    "Z",
    "TRL",
    number(run.payments.length, 6) + number(total, 14) + "0".repeat(22) + "0".repeat(6),
  );
  // The transmission envelope is not a logical 152-character record.
  const envelope =
    s.transmission !== "direct"
      ? `$$${s.transmission === "file_transfer_legacy" ? "AAPD" : "AA01"}STD0152[${s.environment === "test" ? "TEST" : "PROD"}[NL$$`.padEnd(
          94,
          " ",
        ) + "\r\n"
      : "";
  return envelope + records.join("\r\n") + "\r\n";
}
