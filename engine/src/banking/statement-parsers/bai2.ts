/** BAI2 statement parsing. Split from banking.ts (ARCH-FILE-SPLIT; pure moves only). */
import { BankingError, type ParsedStatementLine, type ParsedStatement, type StatementSourceContent } from "../banking-core"
import { decodeStatementSourceText } from "../statement-encoding"
import { assertRealDate, expandTwoDigitYear } from "./shared"
import { fromUnits } from "../../money/money.ts"


/**
 * Statement money lands in numeric(19,4) columns (lines and balances alike):
 * fifteen whole digits. A pasted figure wider than that normalized fine and
 * died only at the insert with a storage error. Fail closed at parse time,
 * once, for every format that funnels through here.
 */
export function assertLedgerRange(units: bigint, message: string): void {
  const whole = (units < 0n ? -units : units) / 10_000n;
  if (whole > 999_999_999_999_999n) throw new BankingError(message);
}

/**
 * Parse a BAI2 (Cash Management Balance Reporting) file. Type-16 detail records
 * carry a BAI type code, amount (in cents, no decimal), and reference/text.
 * Type codes < 400 are credits, ≥ 400 debits. The statement date comes from the
 * type-02 group header (field 4, YYMMDD) and closing balance from the type-03
 * account record's 015 status code.
 */
export function parseBai2(source: StatementSourceContent): ParsedStatement {
  const text = decodeStatementSourceText(source, "bai2");
  // Join 88-continuation records onto their parent, split on record delimiter.
  const raw = text.replace(/\r/g, "");
  const records: string[] = [];
  for (const seg of raw.split("/\n")) {
    for (const ln of seg.split("\n")) {
      const t = ln.replace(/\/\s*$/, "").trim();
      if (!t) continue;
      if (t.startsWith("88,") && records.length) records[records.length - 1] += "," + t.slice(3);
      else records.push(t);
    }
  }
  const lines: ParsedStatementLine[] = [];
  let statementDate: string | undefined;
  let currency: string | undefined;
  let closingBalance: string | undefined;
  const accountNumbers = new Set<string>();
  let lineNo = 0;
  for (const rec of records) {
    const f = rec.split(",");
    if (f[0] === "02") {
      const d = f[4]; // YYMMDD
      const m = d?.match(/^(\d{2})(\d{2})(\d{2})$/);
      if (m) statementDate = assertRealDate(expandTwoDigitYear(m[1]!), m[2]!, m[3]!, `BAI2 date "${d}"`);
    } else if (f[0] === "03") {
      // One file routinely carries several accounts (one 03 record each), but
      // this parser produces a single statement with one currency, one closing
      // balance, and lines stripped of account identity. Merging accounts would
      // quietly aggregate — or currency-corrupt — other accounts' money, so
      // at most one identified account section is accepted per file: a missing account
      // number leaves lines unidentifiable, a repeated 03 re-states the
      // currency/balance evidence (last write wins), and a second distinct
      // account mixes two ledgers. Split one statement per account instead.
      const accountNumber = (f[1] ?? "").trim();
      if (!accountNumber) {
        throw new BankingError(
          "BAI2 account record is missing its account number — lines without account identity cannot be imported",
        );
      }
      if (accountNumbers.has(accountNumber)) {
        throw new BankingError(
          `BAI2 file repeats account ${accountNumber} — import one statement per account section so each keeps its own currency, balance, and lines`,
        );
      }
      accountNumbers.add(accountNumber);
      if (accountNumbers.size > 1) {
        throw new BankingError(
          `BAI2 file contains multiple accounts (${[...accountNumbers].join(", ")}) — import one account per file so each statement keeps its own currency, balance, and lines`,
        );
      }
      if (f[2]) currency = f[2];
      // status/summary type codes follow in groups of (code, amount, ...)
      for (let i = 3; i + 1 < f.length; i += 1) {
        if (f[i] === "015" && f[i + 1]) closingBalance = baiAmount(f[i + 1]!); // 015 = closing ledger
      }
    } else if (f[0] === "16") {
      const typeCode = Number(f[1]);
      const cents = f[2];
      if (cents === undefined || cents === "") {
        throw new BankingError(`BAI2: unparseable amount "${cents ?? ""}"`);
      }
      const magnitude = baiAmount(cents);
      const signed = typeCode >= 400 ? "-" + magnitude.replace(/^-/, "") : magnitude;
      const bankRef = f[4] || null;
      const custRef = f[5] || null;
      const textDesc = f.slice(6).join(",").trim() || null;
      if (!statementDate) {
        throw new BankingError("BAI2: type-16 transaction before a type-02 header date");
      }
      lines.push({
        postedOn: statementDate,
        amount: signed,
        description: textDesc,
        counterpartyRef: custRef ?? bankRef,
        bankTransactionId: bankRef ?? custRef,
      });
      lineNo++;
    }
  }
  if (lineNo === 0) throw new BankingError("BAI2: no type-16 transaction records found");
  // Multi-account files are refused above, so the surviving identifier is
  // the file's single account.
  const externalAccountId = [...accountNumbers][0];
  return { lines, currency, statementDate, closingBalance, externalAccountId };
}

/** BAI2 amounts are integer cents with no decimal point (e.g. "150000" = 1500.00). */
function baiAmount(cents: string): string {
  const match = cents.match(/^([+-]?)(\d+)$/);
  if (!match) throw new BankingError(`BAI2: unparseable amount "${cents}"`);
  const sign = match[1] === "-" ? -1n : 1n;
  const units = sign * BigInt(match[2]!) * 100n;
  assertLedgerRange(units, `BAI2: amount "${cents}" is out of range for the ledger`);
  return fromUnits(units);
}
