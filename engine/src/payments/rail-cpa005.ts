import { PaymentError } from "./payment-errors.ts";
import { type EftSettings } from "./rail-settings.ts";

export interface Cpa005Payment {
  /** Amount in cents (positive integer, max 10 digits). */
  amountCents: bigint;
  /** Date funds are to be made available (payment date). */
  fundsDate: Date;
  /** Payee routing: 3-digit institution + 5-digit transit. */
  institution: string;
  transit: string;
  /** Payee account number, 1–12 digits/characters. */
  accountNumber: string;
  /** Payee name, truncated to 30 characters. */
  payeeName: string;
  /** Originator's cross-reference (e.g. payment document number), ≤19 chars. */
  crossReference: string;
}

export interface Cpa005Run {
  settings: EftSettings;
  /** 1–9999, unique per file transmitted to the institution. */
  fileCreationNumber: number;
  fileCreationDate: Date;
  payments: Cpa005Payment[];
}

const RECORD_LEN = 1464;
const SEGMENTS_PER_RECORD = 6;
const SEGMENT_LEN = 240;

function alpha(value: string, len: number): string {
  return value.slice(0, len).padEnd(len, " ");
}

function num(value: bigint | number, len: number): string {
  const s = String(value);
  if (s.length > len || Number(value) < 0) {
    throw new PaymentError(`numeric field value ${s} does not fit in ${len} digits`);
  }
  return s.padStart(len, "0");
}

/** CPA date format: 0YYDDD (leading zero, 2-digit year, julian day of year). */
function julian(d: Date): string {
  const year = d.getFullYear();
  const start = Date.UTC(year, 0, 1);
  const day =
    Math.floor((Date.UTC(year, d.getMonth(), d.getDate()) - start) / 86_400_000) + 1;
  return `0${String(year % 100).padStart(2, "0")}${String(day).padStart(3, "0")}`;
}

/**
 * DE 12, Item Trace Number (22 characters), per Payments Canada Standard 005
 * (2024 ed., Appendix 1 — Data Element Dictionary). It is a structured field,
 * not filler:
 *
 *   4  destination data centre, trailing digit dropped — a value that does not
 *      match the receiving data centre REJECTS the transaction
 *   5  the originating direct clearer's data centre, > 0
 *   4  the file creation number, > 0
 *   9  an item sequence number within the file, > 0
 *
 * Zero-filling any component is a rejected item, so every component is proved
 * here rather than defaulted.
 */
function itemTraceNumber(opts: {
  destinationDataCentre: string;
  originatingDataCentre: string;
  fileCreationNumber: number;
  itemSequence: number;
}): string {
  if (!/^\d{5}$/.test(opts.destinationDataCentre)) {
    throw new PaymentError(`destination data centre "${opts.destinationDataCentre}" must be 5 digits`);
  }
  if (!/^\d{5}$/.test(opts.originatingDataCentre) || Number(opts.originatingDataCentre) === 0) {
    throw new PaymentError(
      `originating direct clearer's data centre "${opts.originatingDataCentre}" must be 5 digits and greater than zero`,
    );
  }
  if (opts.fileCreationNumber < 1) throw new PaymentError("item trace number requires a file creation number above zero");
  if (opts.itemSequence < 1) throw new PaymentError("item trace number requires an item sequence above zero");
  const trace =
    opts.destinationDataCentre.slice(0, 4) +
    opts.originatingDataCentre +
    num(opts.fileCreationNumber, 4) +
    num(opts.itemSequence, 9);
  if (trace.length !== 22) throw new PaymentError("internal error: CPA-005 item trace number is not 22 characters");
  return trace;
}

/** 9-digit institutional ID: 0 + institution(3) + transit(5). */
function institutionalId(institution: string, transit: string): string {
  if (!/^\d{3}$/.test(institution)) throw new PaymentError(`institution "${institution}" must be 3 digits`);
  if (!/^\d{5}$/.test(transit)) throw new PaymentError(`transit "${transit}" must be 5 digits`);
  return `0${institution}${transit}`;
}

/**
 * Build a CPA Standard 005 credit file (logical records A, C, Z; fixed-width
 * 1464-character records; up to six 240-character credit segments per C
 * record; CAD funds). Records are joined with CRLF.
 */
export function buildCpa005File(run: Cpa005Run): string {
  const s = run.settings;
  if (run.fileCreationNumber < 1 || run.fileCreationNumber > 9999) {
    throw new PaymentError("file creation number must be 1–9999");
  }
  if (run.payments.length === 0) throw new PaymentError("run has no payments to export");

  const originatorId = alpha(s.originatorId, 10);
  const fileCreationNo = num(run.fileCreationNumber, 4);
  const originControl = `${originatorId}${fileCreationNo}`; // positions 11–24
  const txnType = /^\d{3}$/.test(s.transactionCode ?? "") ? s.transactionCode! : "460";

  let recordCount = 0;
  const records: string[] = [];

  // -- A: header --------------------------------------------------------
  recordCount += 1;
  records.push(
    (
      "A" +
      num(recordCount, 9) +
      originControl +
      julian(run.fileCreationDate) +
      num(Number(s.dataCentre), 5) +
      " ".repeat(20) + // reserved customer-direct clearer communication area
      "CAD"
    ).padEnd(RECORD_LEN, " "),
  );

  // -- C: credit details, 6 segments per logical record -------------------
  const returnRouting = institutionalId(s.institution, s.transit);
  const returnAccount = alpha(s.account, 12);

  const segments = run.payments.map((p, i) => {
    if (p.amountCents <= 0n) throw new PaymentError("payment amounts must be positive");
    if (p.accountNumber.trim() === "") throw new PaymentError("payee account number must not be blank");
    if (p.accountNumber.length > 12) throw new PaymentError("payee account number must be 12 characters or fewer");
    if (p.crossReference.length > 19) throw new PaymentError("cross-reference must be 19 characters or fewer");
    return (
      txnType + // transaction type (3)
      num(p.amountCents, 10) + // amount in cents (10)
      julian(p.fundsDate) + // date funds to be available (6)
      institutionalId(p.institution, p.transit) + // payee institutional id (9)
      alpha(p.accountNumber, 12) + // payee account number (12)
      itemTraceNumber({
        // item trace number (22)
        destinationDataCentre: s.dataCentre,
        originatingDataCentre: s.originatingDataCentre,
        fileCreationNumber: run.fileCreationNumber,
        itemSequence: i + 1,
      }) +
      "0".repeat(3) + // stored transaction type (3)
      alpha(s.originatorShortName, 15) + // originator short name (15)
      alpha(p.payeeName, 30) + // payee name (30)
      alpha(s.originatorLongName, 30) + // originator long name (30)
      originatorId + // originating direct clearer's user id (10)
      alpha(p.crossReference, 19) + // originator cross-reference (19)
      returnRouting + // institutional id for returns (9)
      returnAccount + // account number for returns (12)
      " ".repeat(15) + // originator sundry information (15)
      " ".repeat(22) + // filler (22)
      " ".repeat(2) + // originator-direct clearer settlement code (2)
      "0".repeat(11) // invalid data element id (11)
    );
  });
  for (const seg of segments) {
    if (seg.length !== SEGMENT_LEN) throw new PaymentError("internal error: CPA-005 segment is not 240 characters");
  }

  for (let i = 0; i < segments.length; i += SEGMENTS_PER_RECORD) {
    recordCount += 1;
    const chunk = segments.slice(i, i + SEGMENTS_PER_RECORD).join("");
    records.push(("C" + num(recordCount, 9) + originControl + chunk).padEnd(RECORD_LEN, " "));
  }

  // -- Z: trailer ---------------------------------------------------------
  const totalValue = run.payments.reduce((acc, p) => acc + p.amountCents, 0n);
  recordCount += 1;
  records.push(
    (
      "Z" +
      num(recordCount, 9) +
      originControl +
      num(0, 14) + // total value of debit transactions
      num(0, 8) + // total number of debit transactions
      num(totalValue, 14) + // total value of credit transactions
      num(run.payments.length, 8) + // total number of credit transactions
      num(0, 14) + // total value of error corrections "E"
      num(0, 8) + // total number of error corrections "E"
      num(0, 14) + // total value of error corrections "F"
      num(0, 8) // total number of error corrections "F"
    ).padEnd(RECORD_LEN, " "),
  );

  for (const rec of records) {
    if (rec.length !== RECORD_LEN) throw new PaymentError("internal error: CPA-005 record is not 1464 characters");
  }
  return records.join("\r\n") + "\r\n";
}
