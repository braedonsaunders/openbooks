import { formatMoney, sum, toUnits } from "../money/money.ts";
import { PaymentError } from "./payment-errors.ts";
import { isValidBic, isValidIban, normalizeBsb, normalizeCemtexAccount, validateCemtexSettings, validateSepaSettings, type CemtexSettings, type EftSettings, type NachaSettings, type SepaSettings } from "./rail-settings.ts";

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

export interface NachaEntry {
  /** 22 = checking credit, 32 = savings credit. */
  transactionCode: "22" | "32";
  /** Receiving bank 9-digit routing (8 + check digit). */
  routingNumber: string;
  accountNumber: string;
  amountCents: bigint;
  individualId: string;
  individualName: string;
}

function nachaField(v: string, len: number, align: "l" | "r" = "l", pad = " "): string {
  const s = v.slice(0, len);
  return align === "l" ? s.padEnd(len, pad) : s.padStart(len, pad);
}

/** Build a NACHA ACH credit file (94-char records, blocked to 10). */
export function buildNachaFile(opts: {
  settings: NachaSettings;
  effectiveDate: Date;
  creationDate: Date;
  fileIdModifier?: string;
  entries: NachaEntry[];
}): string {
  const s = opts.settings;
  if (opts.entries.length === 0) throw new PaymentError("run has no payments to export");
  const sec = s.entryClassCode ?? "CCD";
  const odfi8 = s.odfiRouting.slice(0, 8);
  const yymmdd = (d: Date) => `${String(d.getFullYear() % 100).padStart(2, "0")}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;

  const rows: string[] = [];
  // 1 — File Header
  rows.push(
    "1" + "01" + nachaField(s.immediateDestination, 10, "r") + nachaField(s.immediateOrigin, 10, "r") +
    yymmdd(opts.creationDate) + hhmm(opts.creationDate) + (opts.fileIdModifier ?? "A") + "094" + "10" + "1" +
    nachaField(s.destinationName, 23) + nachaField(s.originName, 23) + nachaField("", 8),
  );
  // 5 — Batch Header (220 = credits only)
  rows.push(
    "5" + "220" + nachaField(s.companyName, 16) + nachaField("", 20) + nachaField(s.companyId, 10) + sec +
    nachaField(s.entryDescription ?? "PAYMENT", 10) + nachaField("", 6) + yymmdd(opts.effectiveDate) + nachaField("", 3) +
    "1" + odfi8 + nachaField("0000001", 7, "r", "0"),
  );
  // 6 — Entry Details
  let entryHash = 0n;
  let totalCredit = 0n;
  opts.entries.forEach((e, i) => {
    if (e.amountCents <= 0n) throw new PaymentError("payment amounts must be positive");
    if (e.accountNumber.trim() === "") throw new PaymentError("payment account number must not be blank");
    if (e.accountNumber.length > 17) throw new PaymentError("payment account number must be 17 characters or fewer");
    if (!/^\d{8,9}$/.test(e.routingNumber)) {
      throw new PaymentError("payment routing number must contain eight or nine digits");
    }
    const rt8 = e.routingNumber.slice(0, 8);
    const expectedCheckDigit = nachaCheckDigit(rt8);
    if (e.routingNumber.length === 9 && e.routingNumber[8] !== expectedCheckDigit) {
      throw new PaymentError("payment routing number has an invalid ABA check digit");
    }
    const checkDigit = e.routingNumber.length === 9 ? e.routingNumber[8] : expectedCheckDigit;
    entryHash += BigInt(rt8);
    totalCredit += e.amountCents;
    const trace = odfi8 + String(i + 1).padStart(7, "0");
    rows.push(
      "6" + e.transactionCode + rt8 + checkDigit + nachaField(e.accountNumber, 17) + nachaField(String(e.amountCents), 10, "r", "0") +
      nachaField(e.individualId, 15) + nachaField(e.individualName, 22) + nachaField("", 2) + "0" + trace,
    );
  });
  const hashMod = (entryHash % 10_000_000_000n).toString().padStart(10, "0");
  // 8 — Batch Control
  rows.push(
    "8" + "220" + nachaField(String(opts.entries.length), 6, "r", "0") + hashMod +
    nachaField("0", 12, "r", "0") + nachaField(String(totalCredit), 12, "r", "0") + nachaField(s.companyId, 10) +
    nachaField("", 19) + nachaField("", 6) + odfi8 + nachaField("0000001", 7, "r", "0"),
  );
  // 9 — File Control
  const entryCount = opts.entries.length;
  const blockCount = Math.ceil((rows.length + 1) / 10);
  rows.push(
    "9" + nachaField("1", 6, "r", "0") + nachaField(String(blockCount), 6, "r", "0") + nachaField(String(entryCount), 8, "r", "0") +
    hashMod + nachaField("0", 12, "r", "0") + nachaField(String(totalCredit), 12, "r", "0") + nachaField("", 39),
  );
  // pad with 9-filler records to a full 10-record block
  while (rows.length % 10 !== 0) rows.push("9".repeat(94));
  for (const r of rows) if (r.length !== 94) throw new PaymentError(`NACHA record is ${r.length} chars, not 94`);
  return rows.join("\n") + "\n";
}

/** ABA routing check digit (mod-10 weighted 3-7-1) from the first 8 digits. */
export function nachaCheckDigit(rt8: string): string {
  const w = [3, 7, 1, 3, 7, 1, 3, 7];
  const sum = rt8.split("").reduce((a, d, i) => a + Number(d) * w[i]!, 0);
  return String((10 - (sum % 10)) % 10);
}

const xmlEsc = (v: string) => v.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));

/** Build a SEPA pain.001.001.03 Customer Credit Transfer Initiation (EUR). */
export function buildSepaFile(opts: {
  settings: SepaSettings;
  messageId: string;
  creationDateTime: string; // ISO
  executionDate: string; // YYYY-MM-DD
  payments: { endToEndId: string; amount: string; creditorName: string; creditorIban: string; creditorBic?: string | null; remittance: string | null }[];
}): string {
  const settings = validateSepaSettings(opts.settings);
  if (!settings.ok) {
    throw new PaymentError(`SEPA originator settings are invalid: ${settings.missing.join(", ")}`);
  }
  const s = settings.settings;
  if (opts.payments.length === 0) throw new PaymentError("run has no payments to export");
  // pain.001 carries exact 2dp credit amounts: a non-positive payment is not
  // a credit transfer, and anything finer than cents must fail here rather
  // than be silently rounded into CtrlSum and InstdAmt (the CPA-005, NACHA,
  // and SEPA-debit writers all refuse non-positive amounts the same way).
  for (const payment of opts.payments) {
    const units = toUnits(payment.amount);
    if (units <= 0n) throw new PaymentError("payment amounts must be positive");
    if (units % 100n !== 0n) {
      throw new PaymentError(`payment amount ${payment.amount} has sub-cent precision`);
    }
    if (!isValidIban(payment.creditorIban)) {
      throw new PaymentError(`creditor IBAN for ${payment.creditorName} is invalid`);
    }
    const creditorBic = (payment.creditorBic ?? "").trim();
    if (creditorBic && !isValidBic(creditorBic)) {
      throw new PaymentError(`creditor BIC for ${payment.creditorName} is invalid`);
    }
  }
  const ctrlSum = formatMoney(sum(opts.payments.map((payment) => payment.amount)), 2);
  const nb = opts.payments.length;
  const tx = opts.payments.map((p) => {
    const bic = (p.creditorBic ?? "").trim().toUpperCase();
    const iban = p.creditorIban.replace(/\s/g, "").toUpperCase();
    return `      <CdtTrfTxInf>
        <PmtId><EndToEndId>${xmlEsc(p.endToEndId.slice(0, 35))}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="EUR">${formatMoney(p.amount, 2)}</InstdAmt></Amt>
${bic ? `        <CdtrAgt><FinInstnId><BIC>${xmlEsc(bic)}</BIC></FinInstnId></CdtrAgt>\n` : ""}        <Cdtr><Nm>${xmlEsc(p.creditorName.slice(0, 70))}</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>${xmlEsc(iban)}</IBAN></Id></CdtrAcct>
        <RmtInf><Ustrd>${xmlEsc((p.remittance ?? p.endToEndId).slice(0, 140))}</Ustrd></RmtInf>
      </CdtTrfTxInf>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${xmlEsc(opts.messageId.slice(0, 35))}</MsgId>
      <CreDtTm>${opts.creationDateTime}</CreDtTm>
      <NbOfTxs>${nb}</NbOfTxs>
      <CtrlSum>${ctrlSum}</CtrlSum>
      <InitgPty><Nm>${xmlEsc(s.originatorName.slice(0, 70))}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${xmlEsc(opts.messageId.slice(0, 35))}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${nb}</NbOfTxs>
      <CtrlSum>${ctrlSum}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>
      <ReqdExctnDt>${opts.executionDate}</ReqdExctnDt>
      <Dbtr><Nm>${xmlEsc(s.originatorName.slice(0, 70))}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>${xmlEsc(s.originatorIban.replace(/\s/g, ""))}</IBAN></Id></DbtrAcct>
      <DbtrAgt><FinInstnId><BIC>${xmlEsc(s.originatorBic)}</BIC></FinInstnId></DbtrAgt>
      <ChrgBr>SLEV</ChrgBr>
${tx}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
}

export interface CemtexPayment {
  /** Amount in cents (positive integer, max 10 digits). */
  amountCents: bigint;
  /** Target account BSB, canonical NNN-NNN. */
  bsb: string;
  /** Target account number, 1–9 digits (hyphens already edited out). */
  accountNumber: string;
  /** Title of the account to be credited (≤32 chars). */
  accountTitle: string;
  /** Lodgement reference on the employee's statement (≤18 chars). */
  lodgementReference: string;
}

export interface CemtexRun {
  settings: CemtexSettings;
  /** Date the transactions are released to all financial institutions. */
  processingDate: Date;
  /** Detail payments — all credits (transaction code 53, Pay). */
  payments: CemtexPayment[];
}

/**
 * Build an Australian Cemtex (ABA) direct-credit file: descriptive record
 * (type 0), one detail record (type 1) per payment, file-total record
 * (type 7); every record exactly 120 characters, joined with CRLF.
 *
 * Offsets verified position for position against three concordant published
 * transcriptions, which agree with each other on every field boundary:
 *
 * - Cemtex, "ABA file format technical details" (cemtexaba.com, retrieved
 *   2026-09-20) — the format owner's own field tables for records 0, 1 and 7.
 * - M. Cordover, sample-with-comments.aba v1.1 (2013-04-07, CC-BY 3.0 AU) —
 *   an annotated 3-line file with a character ruler, which additionally names
 *   the formal specification: the file type is formally a BECS DE (Bulk
 *   Electronic Clearing System Direct Entry) file specified by the Australian
 *   Payments Clearing Association in Appendix C2 (pp. 78–85) with the
 *   character set in Appendix C7 (p. 86) of the BECS Procedures. That APCA
 *   PDF is no longer reachable (APCA became AusPayNet in 2017), so the
 *   offsets below are the triple-corroborated transcription, not a reading
 *   of the formal pages.
 * - flash-oss aba-generator 2.1.0 (npm) — its record schemas carry the same
 *   boundaries in 0-indexed form (header bsb [1,8], account [8,17], seq
 *   [18,20], bank [20,23], user [30,56], userId [56,62], description [62,74],
 *   date [74,80], time [80,84]; detail bsb [1,8], account [8,17], indicator
 *   [17,18], code [18,20], amount [20,30], title [30,62], reference [62,80],
 *   traceBsb [80,87], traceAccount [87,96], remitter [96,112], withholding
 *   [112,120]; total net [20,30], credit [30,40], debit [40,50], count
 *   [74,80]).
 *
 * Where the transcriptions differ in PROSE they are reconciled toward the
 * formal APCA shape: the descriptive record carries the funds-account Ext:BSB
 * (2–8) and Ext:Account (9–17) plus the processing-time field (81–84, left
 * blank — the APCA specification requires blank; some banks accept HHmm).
 * Where a transcription's prose disagrees with its own BYTES, the bytes win:
 * the Cordover sample's comment credits "BSB 062-292" but its detail record
 * carries "062-692" at positions 2–8.
 *
 * Payroll fixes what BECS standardizes rather than what an institution
 * assigns: transaction code 53 (Pay), blank indicator, zero withholding (PAYG
 * withholding is remitted to the ATO through its own channel, never through
 * the withholding-tax field), description "PAYROLL", reel sequence "01".
 */
export function buildCemtexFile(run: CemtexRun): string {
  const checked = validateCemtexSettings(run.settings);
  if (!checked.ok) {
    throw new PaymentError(`Cemtex originator settings are invalid: ${checked.missing.join(", ")}`);
  }
  const s = checked.settings;
  if (run.payments.length === 0) throw new PaymentError("run has no payments to export");
  // The annotated sample caps a file at 500 detail records ("though that
  // limit may be increased by certain financial institutions"). The reel
  // sequence number exists for multi-file batches, which this writer does not
  // produce — so a population past the cap is a named refusal, never a
  // silently over-long file the bank rejects.
  if (run.payments.length > 500) {
    throw new PaymentError(
      `Cemtex file holds at most 500 detail records but the run has ${run.payments.length} — split the pay run or arrange a higher file limit with the bank`,
    );
  }

  const padR = (value: string, len: number): string => {
    if (value.length > len) throw new PaymentError(`field value "${value}" does not fit in ${len} characters`);
    return value.padEnd(len, " ");
  };
  const padL0 = (value: string, len: number): string => {
    if (value.length > len || !/^\d*$/.test(value)) {
      throw new PaymentError(`numeric field value "${value}" does not fit in ${len} digits`);
    }
    return value.padStart(len, "0");
  };
  const bsb = (value: string, what: string): string => {
    const normal = normalizeBsb(value);
    if (!normal) throw new PaymentError(`${what} "${value}" is not a 6-digit BSB (NNN-NNN)`);
    return normal;
  };
  const account = (value: string, what: string): string => {
    const normal = normalizeCemtexAccount(value);
    if (normal === null) {
      throw new PaymentError(`${what} "${value}" must be 1–9 digits (hyphens edited out), not blank and not all zeros`);
    }
    return normal.padStart(9, " ");
  };
  const ddmmyy = (d: Date): string => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getDate())}${p(d.getMonth() + 1)}${p(d.getFullYear() % 100)}`;
  };

  // -- 0: descriptive ---------------------------------------------------
  // Positions 2–17 carry the funds (source) account. The APCA text calls
  // them Ext:BSB/Ext:Account and requires blank, but every bank-facing
  // transcription populates them: the annotated sample's own bytes carry
  // the funds account there, and aba-generator marks the header BSB
  // "required by most banks". The bytes win — the trace account goes here
  // as well as on every detail record. Computed first so both records share
  // the one validated value.
  const traceBsb = bsb(s.traceBsb, "trace BSB");
  const traceAccount = account(s.traceAccount, "trace account");
  const descriptive =
    "0" +
    traceBsb + // 2–8: funds-account BSB
    traceAccount + // 9–17: funds-account number (right-justified, blank-filled)
    " " + // 18: reserved, blank
    "01" + // 19–20: reel sequence number (single-file batch)
    s.bankAbbreviation + // 21–23: processing bank's APCA abbreviation
    padR("", 7) + // 24–30: reserved, blank
    padR(s.userName, 26) + // 31–56: user preferred name
    padL0(s.userId, 6) + // 57–62: BECS User Identification Number
    padR("PAYROLL", 12) + // 63–74: file description — this file IS a payroll file
    ddmmyy(run.processingDate) + // 75–80: release date DDMMYY
    padR("", 4) + // 81–84: processing time — blank, as the APCA specification requires
    padR("", 36); // 85–120: reserved, blank
  if (descriptive.length !== 120) throw new PaymentError("internal error: Cemtex descriptive record is not 120 characters");

  // -- 1: details ---------------------------------------------------------
  const details = run.payments.map((p) => {
    if (p.amountCents <= 0n) throw new PaymentError("payment amounts must be positive");
    const record =
      "1" +
      bsb(p.bsb, "target BSB") + // 2–8
      account(p.accountNumber, "target account") + // 9–17
      " " + // 18: indicator — blank (no new/varied details, no dividend/interest withholding)
      "53" + // 19–20: transaction code 53, Pay
      padL0(String(p.amountCents), 10) + // 21–30: cents, unsigned zero-filled
      padR(p.accountTitle, 32) + // 31–62
      padR(p.lodgementReference, 18) + // 63–80
      traceBsb + // 81–87
      traceAccount + // 88–96
      padR(s.remitterName, 16) + // 97–112
      padL0("0", 8); // 113–120: withholding tax — zero (PAYG goes to the ATO, not here)
    if (record.length !== 120) throw new PaymentError("internal error: Cemtex detail record is not 120 characters");
    return record;
  });

  // -- 7: file total ------------------------------------------------------
  const total = run.payments.reduce((acc, p) => acc + p.amountCents, 0n);
  const trailer =
    "7" +
    "999-999" + // 2–8: BSB-format filler
    padR("", 12) + // 9–20: reserved, blank
    padL0(String(total), 10) + // 21–30: net (credits minus debits; payroll files carry no debits)
    padL0(String(total), 10) + // 31–40: credit total
    padL0("0", 10) + // 41–50: debit total — nil on a payroll credit file
    padR("", 24) + // 51–74: reserved, blank
    padL0(String(run.payments.length), 6) + // 75–80: detail-record count
    padR("", 40); // 81–120: reserved, blank
  if (trailer.length !== 120) throw new PaymentError("internal error: Cemtex file-total record is not 120 characters");

  return [descriptive, ...details, trailer].join("\r\n") + "\r\n";
}
