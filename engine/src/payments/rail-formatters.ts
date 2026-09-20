import { formatMoney, sum, toUnits } from "../money/money.ts";
import { PaymentError } from "./payment-errors.ts";
import { isValidBic, isValidIban, isValidBancoCode, isValidContaDv, inscricaoTipoFor, normalizeAgencia, normalizeContaNumero, normalizeCpfCnpj, normalizeBankCode, normalizeBranchCode, normalizeBsb, normalizeCemtexAccount, normalizeGbAccountNumber, normalizeSortCode, normalizeZenginAccount, toZenginKana, validateCnab240BbSettings, validateBacsSettings, validateCemtexSettings, validateSepaSettings, validateZenginSettings, type Cnab240BbSettings, type BacsSettings, type CemtexSettings, type EftSettings, type NachaSettings, type SepaSettings, type ZenginSettings } from "./rail-settings.ts";

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

export interface BacsPayment {
  /** Amount in pence (positive integer, max 11 digits). */
  amountCents: bigint;
  /** Destination sort code, canonical NN-NN-NN (re-validated below). */
  sortCode: string;
  /** Destination account number, 8 digits (re-validated below). */
  accountNumber: string;
  /** Destination account name (≤18 chars after channel mapping). */
  accountName: string;
  /** Service user's reference on the employee's statement (≤18 chars after channel mapping). */
  reference: string;
}

export interface BacsRun {
  settings: BacsSettings;
  /** The Bacs processing date (the run's pay date): UHL1 positions 5–10. */
  processingDate: Date;
  /** File creation instant (HDR1 creation date): explicit so goldens are reproducible. */
  creationDate: Date;
  /**
   * VOL1 serial, 6 chars, pre-allocated by the caller from its number
   * sequence — Bacs validates serials against duplicates (held 3 months), so
   * it is allocated once and stored, never re-derived.
   */
  volSerial: string;
  /** UHL1 file number, 3 digits, pre-allocated by the caller. */
  fileNumber: string;
  /** Detail payments — all Direct Credits (transaction code 99). */
  payments: BacsPayment[];
}

/**
 * Build a Bacs Standard 18 Direct Credit submission: VOL1/HDR1/HDR2/UHL1
 * labels (80 chars), one 100-char credit record (code 99) per payment, one
 * debit contra (code 17), EOF1/EOF2, UTL1; records joined with CRLF.
 *
 * Single-processing-day, single-account-section, single-SUN direct submission
 * only — the shape payroll always has (one pay date, one originating
 * account). Multi-day files (106-char records), bureaus submitting for many
 * SUNs (VOL1 owner ≠ HDR1 SUN), and AUDDIS/DD flows are out of scope and
 * refused by construction (there is only one SUN field in the settings).
 *
 * EVIDENCE. The formal specification is Bacs Electronic Funds Transfer, File
 * Structures (PN5011) v3.10 (VocaLink, 03 Oct 2016) — published to service
 * users and members, not openly; the service-user PDFs on bacs.co.uk require
 * login (confirmed 2026-09-20). The layout below is transcribed from four
 * concordant published sources, none of which is the PN5011 PDF:
 *
 * 1. Bacs, "ISO 20022/Bacs Translation Guide" v1.1 (29 Nov 2017, public
 *    bacs.co.uk document library, retrieved 2026-09-20) — Bacs' own
 *    description of Standard 18: the 11 numbered input fields and their
 *    semantics (§5.2), the VOL1/HDR1/HDR2/UHL1/input/EOF1/EOF2/UTL1
 *    submission skeleton (§5.3), fields 9 (47–64) and 11 (83–100) at their
 *    exact positions (§5.7, citing PN5011), the HDR1 SUN at characters 6–11
 *    (§5.4), credit-side code 99 / debit-side code 17 (§7.3.2, §4.2), contra
 *    mechanics — code 17, identical originating/destination accounts, field
 *    10 "CONTRA", multi-contra rule (§4.2) — the Bacs charset (§4.8) and
 *    bYYDDD dates (§4.9).
 * 2. The Access Group, Dimensions help centre, "BACS Standard 18" (retrieved
 *    2026-09-20) — position-level tables for every record above, including
 *    the 100-char data record (106 for multi-day), the contra, and UTL1.
 * 3. PayBatch (victorsaly/batch-payment-app, open source, active Aug 2026),
 *    src/standard18.js — a second 100-char credit implementation agreeing
 *    with (2) on all eleven data boundaries, with field-slice assertions in
 *    test/run.js (a worked example: dest 123456/12345678, origin
 *    090122/11223344, 150.50, ref INV-1001).
 * 4. standard18-bacs (MuhammadTalha776932, open source, Aug 2026), a file
 *    validator — the same label order and skeleton, labels 80 chars, codes
 *    99/17.
 *
 * Corroboration gradient, stated plainly: every MONEY byte (the 100-char
 * credit record) is triple-sourced (1–3) with a worked example; the skeleton
 * is triple-sourced (1, 2, 4); label/contra/UTL1 FIELD offsets are
 * single-sourced from (2), cross-checked where checkable — the HDR1 SUN at
 * 6–11 appears in (1) §5.4 exactly where (2) puts it, and every label sums to
 * exactly 80. (2)'s one prose/bytes slip ("47-46" for field 9) is corrected
 * to 47–64 per (1) §5.7 and the 18-char width. A contradicting schematic (a
 * 2025 explainer describing 80-char typed 01/06/07/08 records, no positions)
 * is rejected: it carries no byte evidence and contradicts (1)'s skeleton.
 *
 * Why single-sourced envelope offsets are shippable: they fail LOUD. Bacs
 * validates the envelope (serial/SUN/processing-date/currency/balance/totals)
 * before processing items — (2) states a mis-structured file "will be
 * rejected" — so a wrong label offset rejects the whole file visibly instead
 * of moving money. No label byte can redirect a credit; only the
 * triple-sourced data bytes address money.
 *
 * Open items (not blockers): Standard 18 field 07 carries an HMRC-hash
 * cross-reference on salary payments linking to the employer's RTI return
 * ((1) §5.2) — the hashing algorithm is not published openly, so field 07 is
 * emitted blank per (2)'s free-format default; the bank accepts blank free
 * format and the hash is an HMRC-matching aid, not a bank validation. The
 * HDR1 file identifier tail (positions 16–21) is "blank filled or the same
 * SUN" per (2) — the SUN is emitted, the alternative noted.
 */
export function buildBacsFile(run: BacsRun): string {
  const checked = validateBacsSettings(run.settings);
  if (!checked.ok) {
    throw new PaymentError(`Bacs originator settings are invalid: ${checked.missing.join(", ")}`);
  }
  const s = checked.settings;
  if (run.payments.length === 0) throw new PaymentError("run has no payments to export");
  if (!/^[0-9A-Za-z ]{6}$/.test(run.volSerial) || run.volSerial.trim() === "" || /^0+$/.test(run.volSerial)) {
    throw new PaymentError("Bacs VOL1 serial must be 6 alphanumeric characters, right-justified, not blank or all zeros");
  }
  if (!/^\d{3}$/.test(run.fileNumber) || Number(run.fileNumber) === 0) {
    throw new PaymentError("Bacs UHL1 file number must be 3 digits and greater than zero");
  }

  // Bacs channel text: uppercase only; anything outside the Bacs set becomes
  // a space. This mirrors the channel deterministically — (1) §4.8: lowercase
  // input is converted to blank by Bacs itself — rather than letting the bank
  // mangle names unpredictably. Lengths are the published field widths;
  // over-length text fails here rather than shifting every field after it.
  // (Non-ASCII never reaches this writer: the payroll artifact refuses
  // non-ASCII on fixed-width rails before rendering.)
  const text = (value: string, len: number, what: string): string => {
    const mapped = value
      .toUpperCase()
      .replace(/[^A-Z0-9 .&/-]/g, " ")
      .slice(0, len);
    if (value.trim() === "") throw new PaymentError(`Bacs ${what} must not be blank`);
    return mapped.padEnd(len, " ");
  };
  const pence = (value: bigint, len: number, what: string): string => {
    const digits = String(value);
    if (value <= 0n) throw new PaymentError("payment amounts must be positive");
    if (digits.length > len) {
      throw new PaymentError(`Bacs ${what} ${digits} pence does not fit in ${len} digits — split the pay run`);
    }
    return digits.padStart(len, "0");
  };
  const sort = (value: string, what: string): string => {
    // Six digits, no hyphens on the wire: positions carry NNNNNN.
    const normal = normalizeSortCode(value);
    if (!normal) throw new PaymentError(`Bacs ${what} "${value}" is not a 6-digit sort code`);
    return normal.replace(/-/g, "");
  };
  const account = (value: string, what: string): string => {
    const normal = normalizeGbAccountNumber(value);
    if (normal === null) {
      throw new PaymentError(`Bacs ${what} "${value}" is not an 8-digit account number`);
    }
    return normal;
  };
  // Bacs date: bYYDDD — blank + 2-digit year + Julian day ((1) §4.9).
  const yyddd = (d: Date): string => {
    const start = Date.UTC(d.getFullYear(), 0, 1);
    const day =
      Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - start) / 86_400_000) + 1;
    return ` ${String(d.getFullYear() % 100).padStart(2, "0")}${String(day).padStart(3, "0")}`;
  };

  const originSort = sort(s.originatingSortCode, "originating sort code");
  const originAccount = account(s.originatingAccount, "originating account");
  const userName = text(s.serviceUserName, 18, "service user name");
  const creation = yyddd(run.creationDate);
  const processing = yyddd(run.processingDate);
  // Expiry: "the earliest date at which [the] file may be overwritten" ((2)
  // HDR1 field 10) must be LATER than the processing day; the exact value is
  // free, so processing + 7 days, deterministically. A regeneration carries a
  // new serial and new dates, never a re-derived identity.
  const expiryDate = new Date(run.processingDate);
  expiryDate.setDate(expiryDate.getDate() + 7);
  const expiry = yyddd(expiryDate);

  // -- VOL1: volume header (80) -------------------------------------------
  // (2): VOL1 | 1 | serial 5–10 | blank 11 | blanks 12–31 | blanks 32–37
  // (direct SUN quoted, so no HSBC/SAGE marker) | owner 38–51 (38–41 blank,
  // 42–47 SUN, 48–51 blank) | blanks 52–79 | 1. (1) §5.3: VOL1 carries the
  // submitter SUN — payroll submits direct, so owner SUN and HDR1 SUN are the
  // one configured SUN; bureau (split-SUN) submission is out of scope.
  const vol1 =
    "VOL1" +
    run.volSerial + // 5–10
    " " + // 11
    " ".repeat(20) + // 12–31
    " ".repeat(6) + // 32–37
    " ".repeat(4) + // 38–41
    s.serviceUserNumber + // 42–47
    " ".repeat(4) + // 48–51
    " ".repeat(28) + // 52–79
    "1"; // 80
  if (vol1.length !== 80) throw new PaymentError("internal error: Bacs VOL1 record is not 80 characters");

  // -- HDR1: header label 1 (80) ------------------------------------------
  // (2): HDR1 | 1 | file identifier 5–21 (5 "A", 6–11 SUN — the SUN position
  // (1) §5.4 confirms at characters 6–11 — 12 "S", 13–14 spaces, 15 space,
  // 16–21 SUN, the SUN chosen over blanks) | serial 22–27 | "0001" | "0001" |
  // generation spaces | version spaces | creation bYYDDD | expiry bYYDDD |
  // blank | zero block count | system-code spaces | reserved spaces.
  const hdr1 =
    "HDR1" +
    "A" + // 5
    s.serviceUserNumber + // 6–11
    "S" + // 12
    "  " + // 13–14
    " " + // 15
    s.serviceUserNumber + // 16–21 (SUN; (2) allows blanks as the alternative)
    run.volSerial + // 22–27
    "0001" + // 28–31 file section
    "0001" + // 32–35 file sequence
    "    " + // 36–39 generation
    "  " + // 40–41 version
    creation + // 42–47
    expiry + // 48–53
    " " + // 54
    "000000" + // 55–60 block count, zero-filled
    " ".repeat(13) + // 61–73 system code
    " ".repeat(7); // 74–80
  if (hdr1.length !== 80) throw new PaymentError("internal error: Bacs HDR1 record is not 80 characters");

  // -- HDR2: header label 2 (80) ------------------------------------------
  // (2): HDR2 | 2 | "F" | "02000" block length | "00100" record length
  // (single processing day) | 35 spaces | "00" | 28 spaces.
  const hdr2 =
    "HDR2" + "F" + "02000" + "00100" + " ".repeat(35) + "00" + " ".repeat(28);
  if (hdr2.length !== 80) throw new PaymentError("internal error: Bacs HDR2 record is not 80 characters");

  // -- UHL1: user header label 1 (80) -------------------------------------
  // (2): UHL1 | 1 | processing bYYDDD 5–10 | "999999" + 4 spaces 11–20 |
  // currency "00" 21–22 | country zeros 23–28 | "1 DAILY  " 29–37 (single
  // processing day) | file number 38–40 | 7 spaces | audit-print spaces
  // 48–54 | 26 spaces. (1) §5.3 confirms UHL1 carries processing date and
  // currency code; the processing day must be a valid Bacs processing day —
  // the bank calendar is not transcribed here, so an invalid day is the
  // bank's loud rejection, never a silent misdate.
  const uhl1 =
    "UHL1" +
    processing + // 5–10
    "999999" + // 11–16
    "    " + // 17–20
    "00" + // 21–22 currency code, transcribed literally
    "000000" + // 23–28
    "1 DAILY  " + // 29–37 work code, single processing day
    run.fileNumber + // 38–40
    " ".repeat(7) + // 41–47
    " ".repeat(7) + // 48–54 audit print identifier (no sample printing)
    " ".repeat(26); // 55–80
  if (uhl1.length !== 80) throw new PaymentError("internal error: Bacs UHL1 record is not 80 characters");

  // -- Data: Direct Credits, code 99 (100 each) -----------------------------
  // Triple-sourced offsets ((1) §5.2/§5.7, (2), (3)): dest sort 1–6, dest
  // account 7–14, type "0" 15, code "99" 16–17, orig sort 18–23, orig account
  // 24–31, free format blanks 32–35, pence ZF 36–46, user name 47–64,
  // reference 65–82, dest name 83–100.
  //
  // Field 07 (free format, 32–35) is emitted blank per (2)'s default. (1)
  // §5.2 notes salary payments carry an HMRC-hash RTI cross-reference there —
  // the hashing algorithm is not published openly, so no hash is computed
  // here; the bank accepts blank free format and the hash is an HMRC-matching
  // aid, not a bank validation.
  const details = run.payments.map((p) => {
    const record =
      sort(p.sortCode, `destination sort code for ${p.accountName}`) + // 1–6
      account(p.accountNumber, `destination account for ${p.accountName}`) + // 7–14
      "0" + // 15
      "99" + // 16–17: Bank Giro / Direct Credit
      originSort + // 18–23
      originAccount + // 24–31
      "    " + // 32–35 free format (see note above)
      pence(p.amountCents, 11, `credit to ${p.accountName}`) + // 36–46
      userName + // 47–64
      text(p.reference, 18, `reference for ${p.accountName}`) + // 65–82
      text(p.accountName, 18, "destination account name"); // 83–100
    if (record.length !== 100) throw new PaymentError("internal error: Bacs detail record is not 100 characters");
    return record;
  });

  // -- Contra: the debit leg, code 17 (100) --------------------------------
  // (1) §4.2 + (2): a credit file's contra is a DEBIT (code 17) on the
  // originator's own account — originating and destination details identical
  // — field 10 "CONTRA", amount = the file total. (1): contras cannot be
  // declined or returned; over-11-digit totals need multiple contras, whose
  // splitting is unspecified — so an over-cap file is a named refusal, never
  // a silently unbalanced submission.
  const total = run.payments.reduce((acc, p) => acc + p.amountCents, 0n);
  const contra =
    originSort + // 1–6
    originAccount + // 7–14
    "0" + // 15
    "17" + // 16–17: debit contra to a credit file
    originSort + // 18–23
    originAccount + // 24–31
    "    " + // 32–35
    pence(total, 11, "contra total") + // 36–46
    userName + // 47–64 narrative (user's choice; the service user name)
    "CONTRA" + " ".repeat(12) + // 65–82 contra identification
    userName; // 83–100 abbreviated account name (the service user name)
  if (contra.length !== 100) throw new PaymentError("internal error: Bacs contra record is not 100 characters");

  // -- EOF1/EOF2: end-of-file labels (80 each) ------------------------------
  // (2): EOF1 repeats HDR1 positions 5–80; EOF2 repeats HDR2 positions 5–80.
  const eof1 = "EOF1" + hdr1.slice(4);
  const eof2 = "EOF2" + hdr2.slice(4);
  if (eof1.length !== 80 || eof2.length !== 80) {
    throw new PaymentError("internal error: Bacs EOF record is not 80 characters");
  }

  // -- UTL1: user trailer label 1 (80) --------------------------------------
  // (2): UTL1 | 1 | debit monetary total 5–17 (13, pence ZF — the contra) |
  // credit monetary total 18–30 (13 — the credits) | debit count 31–37 (7 —
  // the one contra) | credit count 38–44 (7) | 10 spaces | 26 spaces. The
  // credit-file example in (2) confirms the shape: N code-99 records plus one
  // code-17 contra count as debit 1 / credit N.
  const utl1 =
    "UTL1" +
    pence(total, 13, "debit total") + // 5–17
    pence(total, 13, "credit total") + // 18–30
    "0000001" + // 31–37: the one debit contra
    String(run.payments.length).padStart(7, "0") + // 38–44: credit count
    " ".repeat(10) + // 45–54
    " ".repeat(26); // 55–80
  if (utl1.length !== 80) throw new PaymentError("internal error: Bacs UTL1 record is not 80 characters");
  if (!/^\d{7}$/.test(String(run.payments.length).padStart(7, "0")) || run.payments.length > 9_999_999) {
    throw new PaymentError("Bacs file holds at most 9,999,999 detail records");
  }

  return [vol1, hdr1, hdr2, uhl1, ...details, contra, eof1, eof2, utl1].join("\r\n") + "\r\n";
}

export interface ZenginPayment {
  /** Amount in yen (positive integer, max 10 digits — JPY has no minor unit). */
  amountYen: bigint;
  /** Destination bank code (金融機関コード), 4 digits. */
  bankCode: string;
  /** Destination branch code (支店コード), 3 digits. */
  branchCode: string;
  /** Destination deposit type (預金種目): "1" = 普通, "2" = 当座. */
  depositType: string;
  /** Destination account number, 1–7 digits (zero-filled on the wire). */
  accountNumber: string;
  /**
   * Payee name; mapped to half-width katakana on the wire. Kanji has no
   * mechanical reading and is refused — register the フリガナ instead.
   */
  payeeName: string;
  /** Employer-side employee number for the 社員番号 field (≤10 chars). */
  employeeNumber: string;
}

export interface ZenginRun {
  settings: ZenginSettings;
  /** The salary transfer date (振込指定日): emitted as MMDD. */
  transferDate: Date;
  /** Detail payments — all salary transfers (種別コード 11, 給与振込). */
  payments: ZenginPayment[];
}

/**
 * Build a Zengin (全銀協規定形式) salary-transfer file — 給与振込, 種別コード
 * 11: one 120-byte header (データ区分 1), one 120-byte data record
 * (データ区分 2) per payment, one 120-byte trailer (8) and one 120-byte end
 * record (9), joined with CRLF. The returned string is the logical text
 * (half-width katakana + ASCII); `encodeZenginFile` renders the Shift_JIS
 * bytes the bank reads.
 *
 * EVIDENCE. The unreachable primary is the JBA's own fixed-width 規定
 * (every bank manual below cites 「全銀協規定フォーマットに準拠」; the
 * JBA-published document retrieved, 全国銀行協会 平成29年8月, specifies the
 * XML family, not this layout). The layout below is transcribed from SEVEN
 * concordant bank-published sources plus one vendor guide, retrieved
 * 2026-09-20, which agree on every field boundary (each source's widths sum
 * to exactly 120 per record):
 *
 * 1. MUFG Bank BizStation, 「給与・賞与振込（全銀形式）レコードフォーマット」
 *    — header (種別 11/12, 委託者コード N10, 委託者名 C40, 取組日 MMDD,
 *    仕向銀行/支店/種目/口座, ダミー C17), data (被仕向銀行 N4 + 銀行名 C15
 *    + 支店 N3 + 支店名 C15 + 手形交換所 N4 + 種目 N1 + 口座 N7 + 受取人 C30
 *    + 金額 N10 + 新規 N1 + 社員番号 N10 + 所属コード N10 + ダミー C9),
 *    trailer (件数 N6 + 金額 N12), end; the Shift_JIS-or-EBCDIC charset
 *    clause with its kana/character conversion tables; the 200,000-record
 *    cap; 新規コード fixed "0".
 * 2. Chiba Bank, 「給与・賞与振込（全銀協規定形式）」 — the same four
 *    records with 社員番号/所属コード as C(10) and ダミー C(9); CRLF after
 *    each 120 bytes; JIS-or-EBCDIC; 手形交換所 all zeros; 新規 "0".
 * 3. Tajima Bank, 「給与振込（全銀協規定形式）」 — 種別 11/12, the same
 *    data shape with 社員番号/所属コード C(10), ダミー C(9).
 * 4. Kiraboshi Bank, 「給与・賞与振込 振込依頼ファイル・フォーマット
 *    （全銀協規定形式）」(20241202) — the same four records, 社員番号/
 *    所属コード C(10) marked optional, CR+LF/CR/LF accepted, コード区分
 *    0…JIS 1…EBCDIC.
 * 5. Tsuruga Shinkin, 「全銀ファイル フォーマット」 — 種別コード 総合:21、
 *    給与:11、賞与:12; the shared header/trailer/end; the note that
 *    識別表示 Y (EDI) is 無効 for 給与・賞与振込 — salary records carry no
 *    EDI block, hence the 9-char ダミー.
 * 6. MUFG Trust, 「総合振込（全銀協規定形式）」(manual05) — the shared
 *    header/trailer/end shapes and the N/C justification rules (N 右詰0埋め,
 *    C 左詰スペース埋め); its data record is the 総合振込 variant
 *    (顧客コード/振込区分/識別表示/EDI), which salary does NOT carry.
 * 7. Docomo SMTB Net Bank, 「全銀協規定形式（振込ファイル）」 — the shared
 *    shapes with the explicit tie コード区分「0」 = シフトJIS and
 *    CR+LF terminators on 120-byte records.
 * 8. Yamada-tools, 「全銀フォーマット完全ガイド【2026年版】」(vendor
 *    secondary, 2026-03-27) — 1-indexed byte positions for the shared
 *    header/data skeleton, the kana-only rule, Shift_JIS, and zero-padding
 *    short account numbers; asserts 種別 11/12 for salary/bonus.
 *
 * Corroboration gradient, stated plainly: every MONEY byte (data-record
 * positions 1–91 and the trailer counts/totals) is 7-bank-unanimous with
 * 1-indexed positions cross-checked; the salary tail (社員番号/所属コード/
 * ダミー at 92–120) is 4-bank-unanimous on offsets with ONE attribute
 * disagreement — MUFG prints N(10) zero-filled, Chiba/Tajima/Kiraboshi print
 * C(10) — resolved to C(10) left-justified space-filled by 3-to-1 majority,
 * safe because MUFG itself accepts space remainders there and the field is
 * reconciliation-only (it cannot address money). No published byte artifact
 * (an accepted file's bytes) was reachable; no bank publishes one.
 *
 * Rejected with reason: the vendor guide's aside that salary may also use
 * 種別 71 (and bonus 72) — no bank manual among (1)–(7) lists 71/72 for the
 * header 種別コード, so the file emits 11 (給与振込) and a bonus-only file is
 * a future variant, not a silent 12. The 賞与 code 12 differs from 11 in
 * exactly those two bytes (sources (1)–(4) share one layout table for both).
 *
 * Why the residual single-attribute point is shippable: the 社員番号 field
 * is informational — banks match and settle on bank/branch/種目/account plus
 * the trailer totals, all unanimous. A wrong 社員番号 justification cannot
 * redirect a credit; at worst an employer's reconciliation match needs the
 * documented form.
 *
 * ENCODING (part of the format, not an implementation detail): text fields
 * are half-width katakana in Shift_JIS (sources (1), (7), (8) state Shift_JIS
 * outright; (2)–(4) state JIS-or-EBCDIC with コード区分, and (7) ties
 * コード区分「0」 to シフトJIS — hence コード区分 "0", contentType
 * `text/plain; charset=Shift_JIS`, and bytes via `encodeZenginFile`). The
 * file is NEVER valid UTF-8: uploading the logical string as UTF-8 makes
 * every payee name unreadable and shifts every field after it.
 *
 * JPY has no minor unit: amounts are whole yen, N(10) per credit
 * (max 9,999,999,999) and N(12) in the trailer. Sub-yen values are refused,
 * never rounded — rounding a net pay changes what the employee is owed.
 *
 * The transfer date is MMDD only (the 規定 has no year field); the bank
 * interprets it inside its processing window, so a file generated far from
 * its transfer date is the bank's loud rejection, never a silent misdate.
 */
export function buildZenginFile(run: ZenginRun): string {
  const checked = validateZenginSettings(run.settings);
  if (!checked.ok) {
    throw new PaymentError(`Zengin originator settings are invalid: ${checked.missing.join(", ")}`);
  }
  const s = checked.settings;
  if (run.payments.length === 0) throw new PaymentError("run has no payments to export");
  // MUFG BizStation caps one transmission at 200,000 data records. Past the
  // cap is a named refusal, never a silently over-long file the bank rejects.
  if (run.payments.length > 200_000) {
    throw new PaymentError(
      `Zengin file holds at most 200,000 detail records but the run has ${run.payments.length} — split the pay run`,
    );
  }

  const num = (value: string, len: number, what: string): string => {
    if (value.length > len || !/^\d*$/.test(value)) {
      throw new PaymentError(`Zengin ${what} "${value}" does not fit in ${len} digits`);
    }
    return value.padStart(len, "0");
  };
  const text = (value: string, len: number, what: string): string => {
    if (value.length > len) {
      throw new PaymentError(`Zengin ${what} does not fit in ${len} characters`);
    }
    return value.padEnd(len, " ");
  };
  const yen = (value: bigint, len: number, what: string): string => {
    const digits = String(value);
    if (value <= 0n) throw new PaymentError("payment amounts must be positive");
    if (digits.length > len) {
      throw new PaymentError(`Zengin ${what} ${digits} yen does not fit in ${len} digits — split the pay run`);
    }
    return digits.padStart(len, "0");
  };
  const bank = (value: string, what: string): string => {
    const normal = normalizeBankCode(value);
    if (!normal) throw new PaymentError(`Zengin ${what} "${value}" is not a 4-digit bank code`);
    return normal;
  };
  const branch = (value: string, what: string): string => {
    const normal = normalizeBranchCode(value);
    if (!normal) throw new PaymentError(`Zengin ${what} "${value}" is not a 3-digit branch code`);
    return normal;
  };
  const account = (value: string, what: string): string => {
    const normal = normalizeZenginAccount(value);
    if (normal === null) {
      throw new PaymentError(`Zengin ${what} "${value}" is not a 1–7 digit account number`);
    }
    return normal;
  };
  const depositType = (value: string, what: string): string => {
    // Four salary-transfer manuals price the payee 種目 as 1 (普通) or 2
    // (当座) only; 4 (貯蓄) and 9 (その他) appear solely in 総合振込 tables,
    // so they are refused here rather than emitted into an account-address
    // byte the salary channel does not define.
    if (value !== "1" && value !== "2") {
      throw new PaymentError(`Zengin ${what} "${value}" must be 1 (普通) or 2 (当座)`);
    }
    return value;
  };
  // Transfer date MMDD: the 規定 carries month and day only.
  const mmdd = (d: Date): string => {
    if (Number.isNaN(d.getTime())) throw new PaymentError("Zengin transfer date is not a calendar date");
    const m = d.getMonth() + 1;
    const day = d.getDate();
    return `${String(m).padStart(2, "0")}${String(day).padStart(2, "0")}`;
  };

  const transferDay = mmdd(run.transferDate);

  // -- 1: header (120) ----------------------------------------------------
  // 1(1) + 種別 11(2–3) + コード区分 0(4) + 委託者コード(5–14) +
  // 委託者名(15–54) + 取組日 MMDD(55–58) + 仕向銀行番号(59–62) +
  // 仕向銀行名(63–77) + 仕向支店番号(78–80) + 仕向支店名(81–95) +
  // 預金種目(96) + 口座番号(97–103) + ダミー(104–120).
  const header =
    "1" +
    "11" + // 種別コード: 給与振込 (賞与 12 differs in these bytes only)
    "0" + // コード区分: JIS (Shift_JIS bytes via encodeZenginFile)
    num(s.clientCode, 10, "client code") +
    text(s.clientName, 40, "client name") +
    transferDay +
    bank(s.bankCode, "originating bank code") +
    text(s.bankName, 15, "originating bank name") +
    branch(s.branchCode, "originating branch code") +
    text(s.branchName, 15, "originating branch name") +
    depositType(s.depositType, "originating deposit type") +
    account(s.accountNumber, "originating account number") +
    " ".repeat(17);
  if (header.length !== 120) throw new PaymentError("internal error: Zengin header record is not 120 characters");

  // -- 2: details (120 each) ------------------------------------------------
  // 2(1) + 被仕向銀行番号(2–5) + 被仕向銀行名(6–20) + 被仕向支店番号(21–23) +
  // 被仕向支店名(24–38) + 手形交換所番号(39–42) + 預金種目(43) +
  // 口座番号(44–50) + 受取人名(51–80) + 振込金額(81–90) + 新規コード(91) +
  // 社員番号(92–101) + 所属コード(102–111) + ダミー(112–120).
  const details = run.payments.map((p) => {
    const payee = toZenginKana(p.payeeName);
    if (payee === null || payee.trim() === "") {
      throw new PaymentError(
        `Zengin payee name "${p.payeeName}" cannot be expressed in half-width katakana — register the payee's katakana name (フリガナ) on the employee's approved bank account`,
      );
    }
    // 社員番号 rides the channel too: an unmappable number refuses by
    // employee name here (not as an anonymous encoder error later), while
    // an empty one is legal — every manual marks the field optional.
    const empRaw = toZenginKana(p.employeeNumber);
    if (empRaw === null) {
      throw new PaymentError(
        `Zengin employee number "${p.employeeNumber}" for ${p.payeeName} cannot be expressed in half-width katakana`,
      );
    }
    const record =
      "2" +
      bank(p.bankCode, `destination bank code for ${p.payeeName}`) +
      " ".repeat(15) + // 被仕向銀行名: optional (省略可) on every manual
      branch(p.branchCode, `destination branch code for ${p.payeeName}`) +
      " ".repeat(15) + // 被仕向支店名: optional (省略可) on every manual
      "0000" + // 手形交換所番号: all zeros (unused)
      depositType(p.depositType, `deposit type for ${p.payeeName}`) +
      account(p.accountNumber, `destination account for ${p.payeeName}`) +
      // 受取人名: the bank matches on account coordinates, not the name —
      // over-length display names truncate (cf. CPA-005 30, Bacs 18),
      // unmappable ones (kanji) refuse above, never guess a reading.
      payee.slice(0, 30).padEnd(30, " ") +
      yen(p.amountYen, 10, `transfer to ${p.payeeName}`) +
      "0" + // 新規コード: "0" fixed for salary on every manual
      // 社員番号 C(10): reconciliation-only; the employer's number as-is,
      // truncated to the field (never re-justified into a new identifier).
      empRaw.slice(0, 10).padEnd(10, " ") +
      " ".repeat(10) + // 所属コード: no department code is carried
      " ".repeat(9); // ダミー: salary carries no EDI block
    if (record.length !== 120) throw new PaymentError("internal error: Zengin data record is not 120 characters");
    return record;
  });

  // -- 8: trailer (120) -----------------------------------------------------
  // 8(1) + 合計件数 N6(2–7) + 合計金額 N12 yen(8–19) + ダミー(20–120).
  const total = run.payments.reduce((acc, p) => acc + p.amountYen, 0n);
  const trailer =
    "8" +
    num(String(run.payments.length), 6, "detail count") +
    yen(total, 12, "trailer total") +
    " ".repeat(101);
  if (trailer.length !== 120) throw new PaymentError("internal error: Zengin trailer record is not 120 characters");

  // -- 9: end (120) ---------------------------------------------------------
  const end = "9" + " ".repeat(119);
  if (end.length !== 120) throw new PaymentError("internal error: Zengin end record is not 120 characters");

  return [header, ...details, trailer, end].join("\r\n") + "\r\n";
}

/**
 * Render the logical Zengin text as the Shift_JIS bytes the bank reads.
 *
 * Hand-rolled JIS X 0201 (not iconv): the channel alphabet is exactly ASCII
 * printable + half-width katakana, each one Shift_JIS byte, so the encoder
 * is a small total table — and anything outside it (a kanji that slipped
 * past validation, a full-width character, an emoji) is a thrown refusal,
 * never a `?` replacement byte that would silently shift every field after
 * it. CRLF passes through as 0x0D 0x0A.
 */
export function encodeZenginFile(text: string): Buffer {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "\r") { bytes.push(0x0d); continue; }
    if (ch === "\n") { bytes.push(0x0a); continue; }
    // JIS X 0201 Roman: ASCII printable; 0x5C is the yen mark (¥) on
    // Japanese systems and the kana-channel backslash folds there.
    if (code >= 0x20 && code <= 0x7e) { bytes.push(code); continue; }
    // JIS X 0201 katakana: U+FF61–FF9F → 0xA1–0xDF.
    if (code >= 0xff61 && code <= 0xff9f) { bytes.push(code - 0xff61 + 0xa1); continue; }
    throw new PaymentError(
      `Zengin file contains U+${code.toString(16).toUpperCase().padStart(4, "0")} "${ch}", which has no Shift_JIS single-byte form — names must be half-width katakana before encoding`,
    );
  }
  return Buffer.from(bytes);
}

export interface Cnab240BbPayment {
  /** Amount in centavos (positive integer, max 15 digits: 13 + 2 implied decimals). */
  amountCents: bigint;
  /** Destination bank, 3 digits: '001' for a Banco do Brasil account, the destination bank for a TED. */
  bancoFavorecido: string;
  /** Destination agência, 1–5 digits (re-validated below). */
  agencia: string;
  /** Destination agência check digit, 1 alphanumeric (re-validated below). */
  agenciaDv: string;
  /** Destination conta, 1–12 digits (re-validated below). */
  conta: string;
  /** Destination conta check digit, 1 alphanumeric (re-validated below). */
  contaDv: string;
  /**
   * Second (combined) check digit, or null for blank. BB accounts carry no
   * second digit (blank); some other banks' accounts do — carried verbatim
   * for TED destinations, never invented.
   */
  dac: string | null;
  /** Favorecido name (≤30 chars after channel mapping). */
  favorecidoNome: string;
  /** '1' CPF or '2' CNPJ (derived from the inscription length, re-checked below). */
  inscricaoTipo: "1" | "2";
  /** Favorecido CPF (11) or CNPJ (14) digits, check digits re-validated below. */
  inscricaoNumero: string;
  /** Company reference for this credit (G064, ≤20 chars after channel mapping). */
  seuNumero: string;
}

export interface Cnab240BbRun {
  settings: Cnab240BbSettings;
  /**
   * Arquivo sequence number (NSA, header 158–163), 6 chars, pre-allocated by
   * the caller from its number sequence — stored, never re-derived.
   */
  nsa: string;
  /** File generation instant (header data/hora de geração): explicit so goldens are reproducible. */
  creationDate: Date;
  /** The payment date (Segmento A data do pagamento): the run's pay date. */
  paymentDate: Date;
  /** Detail payments — split by destination into forma-01 / forma-41 lotes below. */
  payments: Cnab240BbPayment[];
}

/**
 * Build a CNAB 240 Pagamentos credit file in the BANCO DO BRASIL variant:
 * header de arquivo (tipo 0), one header de lote (tipo 1) per forma de
 * lançamento, one Segmento A + Segmento B pair per payment, one trailer de
 * lote (tipo 5) per lote, trailer de arquivo (tipo 9); 240-char records
 * joined with CRLF.
 *
 * Lote discipline — the shape payroll always has. Forma de lançamento is a
 * LOTE-level field, so one lote cannot mix same-bank credits and TEDs:
 * BB-destination payments go in a forma-'01' lote (câmara '000', tipo de
 * serviço '30' — Pagamento de Salários), other-bank payments in a
 * forma-'41' lote (TED outra titularidade, câmara '018'). A single-group
 * file carries a single lote. Poupança (05), DOC (03), PIX (45), cartão
 * salário (60) and ordem de pagamento (10) are out of scope by construction
 * — there is no lote for them, so they cannot be expressed.
 *
 * EVIDENCE. The primary specification is FEBRABAN's *Layout Padrão CNAB 240
 * — Pagamentos* (the G/P field codes used throughout — G001, G060, P001,
 * P010 — are FEBRABAN's), as implemented for Banco do Brasil in BB's own
 * *Layout de Pagamentos — CNAB 240* manual (quoted at length in source 3
 * below; the vendored `PgtVer03BB.xls` reference in that source names the
 * manual vintage). Neither FEBRABAN's nor BB's PDF is openly reachable, so
 * both are named here as the unreachable primaries and the layout below is
 * transcribed from FIVE concordant published sources, none of which is
 * either PDF:
 *
 * 1. Bradesco, *Manual CNAB 240 — Multipag* (2017, bank-published, retrieved
 *    2026-09-20 via a public implementation's vendored copy): the full
 *    position-level tables for header de arquivo (p.14), trailer de arquivo
 *    (p.15), header de lote (p.22) and Segmento A (pp.23–24, every field
 *    01.3A–30.3A with De/Até positions, sizes, formats and defaults) plus
 *    Segmento B (p.24, OBRIGATÓRIO on remessa) and trailer de lote (p.28).
 *    Field codes (G001…P013) are FEBRABAN's own, so this manual doubles as
 *    evidence for the federation standard behind the bank variants.
 * 2. Banco Inter, *Manual CNAB 240 — Pagamentos* (2025, bank-published):
 *    Segmento A para TED (pp.13–14) — positions 1–43, 74–134 and 155–177
 *    identical to (1); 43 = "Campo em branco"; 74–93 blanks-acceptable;
 *    102–104 "BRL"; 105–119 zeros for reais; 135–177 return-only.
 * 3. rubycnab240 (Hamdan85, open source, BB-targeted, implementation quoting
 *    BB's manual field by field): header/lote convênio `9 digits + '0126'`
 *    with BB's wording; tipo de serviço 20/30/98 with '30' = Pagamento de
 *    Salários; forma table 01/02/03/04/05/10/41/43 with the câmara-018 rule
 *    for 03/41/43 and '000' for crédito no BB; Segmento A DAC blank for BB
 *    accounts (BB's wording); the arquivo/lote version pairing table
 *    (031↔050 … 043↔084); trailer fills as emitted.
 * 4. bradesco-cnab240 (thiagosantos, open source, PRODUCTION payroll:
 *    "Padrão Bradesco Multipag CNAB240 para folha de pagamento" — tested
 *    against folha with Bradesco): Segmento A/B serializers whose field
 *    widths sum to exactly 240, header-lote serviço '30' + forma '01' +
 *    lote version '045', A+B pair per employee, câmara '000' = crédito em
 *    conta with '018' TED / '700' DOC noted.
 * 5. OCA l10n-brazil `l10n_br_cnab_structure` data (Akretion/Engenere,
 *    production Odoo, files accepted by banks daily): position-level field
 *    rows for Itaú/BB/Santander/Sicoob 240 pagamento structures — BB lote
 *    version default '045', BB convênio slot default '0126', BB densidade
 *    default '00000', BB Segmento A/B skeletons, per-bank payment-way
 *    tables (forma 01/41 with câmara 018 for TED, 009 for PIX).
 *
 * Corroboration gradient, stated plainly: every MONEY byte (Segmento A
 * 120–134 valor, 94–101 data, the 24–43 conta block positions, 44–93 nome
 * and seu-número spans) and the whole skeleton (header/trailer arquivo,
 * header/trailer lote, Segmento A 1–177, Segmento B 1–32) agree across (1),
 * (2), (4) and (5), with (3) concurring on the BB flavor — five
 * transcriptions, identical bytes. Bank-divergent by honest design: the
 * 178–230 tail (BB/Bradesco G031 + P005/P013 vs Itaú's ISPB/PIX extension
 * vs Inter's tipo-conta split), the convênio treatment (BB `9 + '0126'` vs
 * Bradesco's 20-char convênio), the arquivo layout version and densidade,
 * P014 (Bradesco '01' vs BB blanks), trailer-lote 42–65 fills (Bradesco
 * zeros vs BB blanks), and the Segmento B tail (BB blanks vs Bradesco
 * P012/P015) — each emitted in the BB flavor per (3) and (5)'s BB rows,
 * with the divergence named here rather than averaged into a layout no
 * bank accepts.
 *
 * Why the BB-flavored envelope choices are shippable: they fail LOUD. BB
 * validates the envelope (NSA/version pairing, convênio, lote counts and
 * the P007 somatória) before processing items — a wrong version, convênio
 * or count rejects the whole file visibly instead of moving money. No
 * envelope byte can redirect a credit; only the five-sourced detail bytes
 * address money, and those never vary by bank.
 *
 * Two conscious refusals, not gaps. (a) The arquivo layout version is
 * REQUIRED tenant configuration, not a default: versions are bank- and
 * era-specific and must pair with the lote version, so a pinned guess risks
 * a parser rejection with no operator remedy — the refusal names the
 * convênio documentation. (b) CPF/CNPJ check digits ARE validated (módulo
 * 11): unlike the Bacs modulus weight tables — pinned tables that
 * false-refuse newly allocated accounts — the Receita algorithm is public,
 * table-free and stable, so a mistyped inscription is refused here rather
 * than riding Segmento B to a confrontation failure.
 */
export function buildCnab240BbFile(run: Cnab240BbRun): string {
  const checked = validateCnab240BbSettings(run.settings);
  if (!checked.ok) {
    throw new PaymentError(`CNAB 240 originator settings are invalid: ${checked.missing.join(", ")}`);
  }
  const s = checked.settings;
  if (run.payments.length === 0) throw new PaymentError("run has no payments to export");
  if (!/^\d{6}$/.test(run.nsa) || /^0+$/.test(run.nsa)) {
    throw new PaymentError("CNAB 240 NSA must be 6 digits and greater than zero");
  }

  // CNAB channel text: uppercase, unaccented. Accents strip deterministically
  // (NFD + mark removal) and anything outside the channel set becomes a
  // space — mirroring the channel rather than letting the bank mangle names
  // unpredictably. Lengths are the published field widths; over-length text
  // fails here rather than shifting every field after it. (Non-ASCII never
  // reaches this writer through the payroll path either: the artifact
  // refuses non-ASCII on fixed-width rails before rendering.)
  const text = (value: string, len: number, what: string, allowBlank = false): string => {
    const mapped = value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9 .,/&+\-:;()?]/g, " ")
      .slice(0, len);
    if (!allowBlank && mapped.trim() === "") throw new PaymentError(`CNAB 240 ${what} must not be blank`);
    if (value.trim() !== "" && mapped.trim() === "") {
      throw new PaymentError(`CNAB 240 ${what} has no representable characters`);
    }
    return mapped.padEnd(len, " ");
  };
  const digits = (value: bigint | string | number, len: number, what: string): string => {
    const raw = String(value);
    if (!/^\d+$/.test(raw)) throw new PaymentError(`CNAB 240 ${what} "${raw}" must be numeric`);
    if (raw.length > len) {
      throw new PaymentError(`CNAB 240 ${what} ${raw} does not fit in ${len} digits — split the pay run`);
    }
    return raw.padStart(len, "0");
  };
  const centavos = (value: bigint, len: number, what: string): string => {
    if (value <= 0n) throw new PaymentError("payment amounts must be positive");
    return digits(value, len, what);
  };
  const ddmmaaaa = (d: Date): string => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getDate())}${p(d.getMonth() + 1)}${d.getFullYear()}`;
  };
  const agencia = (value: string, what: string): string => {
    const normal = normalizeAgencia(value);
    if (!normal) throw new PaymentError(`CNAB 240 ${what} "${value}" is not an agência (up to 5 digits)`);
    return normal;
  };
  const conta = (value: string, what: string): string => {
    const normal = normalizeContaNumero(value);
    if (!normal) throw new PaymentError(`CNAB 240 ${what} "${value}" is not a conta (up to 12 digits)`);
    return normal;
  };
  const dv = (value: string, what: string): string => {
    if (!isValidContaDv(value)) throw new PaymentError(`CNAB 240 ${what} must be a single check-digit character`);
    return value.trim().toUpperCase();
  };

  const empresaAg = agencia(s.agencia, "debit agência");
  const empresaConta = conta(s.conta, "debit conta");
  const empresaAgDv = dv(s.agenciaDv, "debit agência DV");
  const empresaContaDv = dv(s.contaDv, "debit conta DV");
  const nomeEmpresa = text(s.nomeEmpresa, 30, "company name");
  const cnpj = normalizeCpfCnpj(s.cnpjEmpresa);
  if (cnpj?.length !== 14) throw new PaymentError("CNAB 240 employer inscription must be a 14-digit CNPJ");

  // -- header de arquivo (tipo 0, lote 0000) ---------------------------------
  // (1) p.14; (3)/(5) BB rows: convênio(9) + '0126' + 5 + 2 blanks; NSA at
  // 158–163; arquivo layout version at 164–166 (tenant-configured, paired
  // with lote 045); densidade '00000' per (3) and (5)'s BB default
  // ("INFORMAR 00000").
  const headerArquivo =
    "001" + // 1–3 banco na compensação (this variant transmits to BB)
    "0000" + // 4–7 lote de serviço
    "0" + // 8 tipo de registro
    " ".repeat(9) + // 9–17 uso exclusivo FEBRABAN
    "2" + // 18 tipo de inscrição da empresa (CNPJ)
    cnpj + // 19–32 número de inscrição da empresa
    digits(s.convenio, 9, "convênio") + // 33–41 convênio no banco
    "0126" + // 42–45 cobrança-convênio slot: '0126' para pagamento (3)
    " ".repeat(5) + // 46–50 uso reservado do banco
    " ".repeat(2) + // 51–52 (3)/(5) leave blank; NOT a test flag
    empresaAg + // 53–57 agência mantenedora
    empresaAgDv + // 58 DV agência
    empresaConta + // 59–70 conta corrente
    empresaContaDv + // 71 DV conta
    "0" + // 72 DV ag/conta: '0' for a BB debit account (3)
    nomeEmpresa + // 73–102 nome da empresa
    text("BANCO DO BRASIL", 30, "bank name") + // 103–132 nome do banco
    " ".repeat(10) + // 133–142 uso exclusivo FEBRABAN
    "1" + // 143 remessa
    ddmmaaaa(run.creationDate) + // 144–151 data de geração
    run.creationDate.toTimeString().slice(0, 8).replace(/:/g, "") + // 152–157 hora de geração HHMMSS
    run.nsa + // 158–163 NSA
    digits(s.versaoLayoutArquivo, 3, "arquivo layout version") + // 164–166 versão do layout
    "00000" + // 167–171 densidade
    " ".repeat(20) + // 172–191 reservado banco
    " ".repeat(20) + // 192–211 reservado empresa
    " ".repeat(29); // 212–240 uso exclusivo FEBRABAN
  if (headerArquivo.length !== 240) throw new PaymentError("internal error: CNAB 240 header de arquivo is not 240 characters");

  // -- lotes: forma 01 (crédito em conta BB) and forma 41 (TED) ----------------
  // One lote per forma — forma is lote-level, so mixing would misdescribe
  // credits. Tipo de serviço '30' (Pagamento de Salários) on every lote:
  // (3) quotes BB admitting only 20/30/98, (4) emits '30' for folha.
  const groups: { forma: "01" | "41"; camara: "000" | "018"; payments: Cnab240BbPayment[] }[] = [];
  for (const p of run.payments) {
    if (!isValidBancoCode(p.bancoFavorecido)) {
      throw new PaymentError(`CNAB 240 destination bank "${p.bancoFavorecido}" must be 3 digits`);
    }
    const ted = p.bancoFavorecido !== "001";
    let group = groups.find((g) => g.forma === (ted ? "41" : "01"));
    if (!group) {
      group = { forma: ted ? "41" : "01", camara: ted ? "018" : "000", payments: [] };
      groups.push(group);
    }
    group.payments.push(p);
  }
  // Deterministic lote order: the same-bank lote first, then TED — the same
  // inputs always produce the same characters.
  groups.sort((a, b) => a.forma.localeCompare(b.forma));

  const records: string[] = [headerArquivo];
  let loteNo = 0;
  for (const group of groups) {
    loteNo += 1;
    const lote = digits(loteNo, 4, "lote number");
    // -- header de lote (tipo 1) ------------------------------------------------
    // (1) p.22; (3)/(5) BB rows: convênio + '0126' + blanks; P014 at
    // 223–224 left BLANK — Bradesco carries '01' there but both BB-flavored
    // transcriptions blank it, so the BB variant does too. Endereço
    // 143–222 optional: blank (no company address on file).
    const headerLote =
      "001" + // 1–3 banco
      lote + // 4–7 lote de serviço
      "1" + // 8 tipo de registro
      "C" + // 9 tipo da operação (crédito)
      "30" + // 10–11 tipo de serviço: Pagamento de Salários
      group.forma + // 12–13 forma de lançamento: 01 crédito em conta, 41 TED outra titularidade
      "045" + // 14–16 versão do layout do lote: '045' in (1), (4) and (5)'s BB default
      " " + // 17 uso exclusivo FEBRABAN
      "2" + // 18 tipo de inscrição da empresa (CNPJ)
      cnpj + // 19–32 número de inscrição da empresa
      digits(s.convenio, 9, "convênio") + // 33–41 convênio
      "0126" + // 42–45 '0126' para pagamento (3)
      " ".repeat(5) + // 46–50 uso reservado do banco
      " ".repeat(2) + // 51–52 blank (3)
      empresaAg + // 53–57 agência
      empresaAgDv + // 58 DV agência
      empresaConta + // 59–70 conta
      empresaContaDv + // 71 DV conta
      "0" + // 72 DV ag/conta: '0' for a BB debit account (3)
      nomeEmpresa + // 73–102 nome da empresa
      " ".repeat(40) + // 103–142 Informação 1: blank for salary (G031 is SIAPE/depósito-judicial only)
      " ".repeat(80) + // 143–222 endereço da empresa: optional, blank
      " ".repeat(8) + // 223–230 blank on the BB variant (see above)
      " ".repeat(10); // 231–240 ocorrências (retorno)
    if (headerLote.length !== 240) throw new PaymentError("internal error: CNAB 240 header de lote is not 240 characters");
    records.push(headerLote);

    // -- Segmentos A + B -------------------------------------------------------
    let seq = 0;
    let loteTotal = 0n;
    for (const p of group.payments) {
      seq += 1;
      if (seq > 99999) throw new PaymentError("CNAB 240 lote holds at most 99999 records — split the pay run");
      const seqA = digits(seq, 5, "record sequence");
      const inscricao = normalizeCpfCnpj(p.inscricaoNumero);
      if (!inscricao) {
        throw new PaymentError(`CNAB 240 inscription "${p.inscricaoNumero}" is not a valid CPF/CNPJ`);
      }
      const tipo = inscricaoTipoFor(inscricao);
      if (tipo !== p.inscricaoTipo) {
        throw new PaymentError("internal error: CNAB 240 inscription type does not match its length");
      }
      // -- Segmento A: the credit (1) pp.23–24; (2) pp.13–14; (3)–(5) ---------
      const segmentoA =
        "001" + // 1–3 banco
        lote + // 4–7 lote
        "3" + // 8 tipo de registro
        seqA + // 9–13 seqüencial no lote
        "A" + // 14 segmento
        "0" + // 15 tipo de movimento: inclusão
        "00" + // 16–17 instrução: inclusão de registro detalhe liberado
        group.camara + // 18–20 câmara: '000' crédito em conta, '018' TED
        digits(p.bancoFavorecido, 3, "destination bank") + // 21–23 banco do favorecido
        agencia(p.agencia, "favorecido agência") + // 24–28 agência
        dv(p.agenciaDv, "favorecido agência DV") + // 29 DV agência
        conta(p.conta, "favorecido conta") + // 30–41 conta
        dv(p.contaDv, "favorecido conta DV") + // 42 DV conta
        (p.dac == null || p.dac === "" ? " " : dv(p.dac, "favorecido DAC")) + // 43 DAC: blank for BB accounts (3); second DV carried verbatim for TED
        text(p.favorecidoNome, 30, "favorecido name") + // 44–73 nome do favorecido
        text(p.seuNumero, 20, "seu número", true) + // 74–93 seu número (G064): blank acceptable per (2)
        ddmmaaaa(run.paymentDate) + // 94–101 data do pagamento
        "BRL" + // 102–104 tipo da moeda: (2) kills the SISPAG-'009' reading for this variant
        "0".repeat(15) + // 105–119 quantidade da moeda: zeros for reais (1)(2)(3)
        centavos(p.amountCents, 15, "payment amount") + // 120–134 valor (13+2)
        " ".repeat(20) + // 135–154 nosso número: blank on remessa, assigned on return
        "0".repeat(8) + // 155–162 data real: return-only, zeros on remessa (3)
        "0".repeat(15) + // 163–177 valor real: return-only, zeros on remessa (3)
        " ".repeat(40) + // 178–217 Informação 2: blank for salary (G031 is SIAPE/depósito-judicial only)
        " ".repeat(2) + // 218–219 finalidade DOC (P005): no DOC on this rail
        " ".repeat(5) + // 220–224 finalidade TED (P011): blank is accepted BB-side per (3)/(5); Inter documents 00004=salários for Inter-transmitted files
        " ".repeat(2) + // 225–226 finalidade complementar (P013): blank; '06' (salários) exists in the table but no transcription emits it for salary
        " ".repeat(3) + // 227–229 uso exclusivo FEBRABAN
        "0" + // 230 aviso: '0' não emite (1)(4)(5); (3) sends blank for same-bank — noted, '0' is the documented value
        " ".repeat(10); // 231–240 ocorrências (retorno)
      if (segmentoA.length !== 240) throw new PaymentError("internal error: CNAB 240 Segmento A is not 240 characters");
      records.push(segmentoA);
      loteTotal += p.amountCents;

      seq += 1;
      if (seq > 99999) throw new PaymentError("CNAB 240 lote holds at most 99999 records — split the pay run");
      // -- Segmento B: the inscription (1) p.24 OBRIGATÓRIO; (3) -------------
      // Address block 33–225 blank: (3)'s BB transcription blanks all 193
      // (no per-employee address needed); (4) fills the employer's address,
      // a Bradesco liberty, not a requirement. Inscription at 18–32 is the
      // load-bearing field (required for TED; emitted always).
      const segmentoB =
        "001" + // 1–3 banco
        lote + // 4–7 lote
        "3" + // 8 tipo de registro
        digits(seq, 5, "record sequence") + // 9–13 seqüencial (A+1)
        "B" + // 14 segmento
        " ".repeat(3) + // 15–17 uso exclusivo FEBRABAN
        tipo + // 18 tipo de inscrição: 1 CPF, 2 CNPJ
        digits(inscricao, 14, "inscription") + // 19–32 número: 14 wide, CPF zero-padded left per (1)/(3)/(4)
        " ".repeat(193) + // 33–225 address block: blank (see above)
        "0" + // 226 aviso: '0' (3)
        " ".repeat(6) + // 227–232 blank on the BB variant ((1)'s P012/SIAPE and (2)'s ISPB live here on other flavors)
        " ".repeat(8); // 233–240 blank on remessa (ocorrências on return)
      if (segmentoB.length !== 240) throw new PaymentError("internal error: CNAB 240 Segmento B is not 240 characters");
      records.push(segmentoB);
    }

    // -- trailer de lote (tipo 5) ------------------------------------------------
    // (1) p.28: 18–23 record count (header + details + trailer), 24–41 P007
    // somatória 16+2, 42–59 G058, 60–65 G066, 66–230 blanks, 231–240
    // ocorrências. G058/G066 fill: (3)'s BB transcription blanks them;
    // (4)'s Bradesco flow zero-fills — the BB flavor is emitted, the
    // divergence named, and a wrong fill rejects the file visibly.
    const trailerLote =
      "001" + // 1–3 banco
      lote + // 4–7 lote
      "5" + // 8 tipo de registro
      " ".repeat(9) + // 9–17 uso exclusivo FEBRABAN
      digits(seq + 2, 6, "lote record count") + // 18–23 qtde (header + details + trailer)
      centavos(loteTotal, 18, "lote total") + // 24–41 somatória 16+2
      " ".repeat(18) + // 42–59 somatória qtde moedas: blank on the BB variant (see above)
      " ".repeat(6) + // 60–65 número aviso débito: blank on the BB variant
      " ".repeat(165) + // 66–230 uso exclusivo FEBRABAN
      " ".repeat(10); // 231–240 ocorrências (retorno)
    if (trailerLote.length !== 240) throw new PaymentError("internal error: CNAB 240 trailer de lote is not 240 characters");
    records.push(trailerLote);
  }

  // -- trailer de arquivo (tipo 9, lote 9999) ------------------------------------
  // (1) p.15; (3)/(4)/(5): 18–23 lote count, 24–29 whole-file record count
  // (every tipo 0/1/3/5/9 record), 30–35 zeros (no conciliação), 36–240 blanks.
  const trailerArquivo =
    "001" + // 1–3 banco
    "9999" + // 4–7 lote de serviço
    "9" + // 8 tipo de registro
    " ".repeat(9) + // 9–17 uso exclusivo FEBRABAN
    digits(groups.length, 6, "lote count") + // 18–23 qtde de lotes
    digits(records.length + 1, 6, "file record count") + // 24–29 qtde de registros (incl. this trailer)
    "0".repeat(6) + // 30–35 qtde de contas conciliação
    " ".repeat(205); // 36–240 uso exclusivo FEBRABAN
  if (trailerArquivo.length !== 240) throw new PaymentError("internal error: CNAB 240 trailer de arquivo is not 240 characters");
  records.push(trailerArquivo);

  return records.join("\r\n") + "\r\n";
}
