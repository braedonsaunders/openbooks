/** MT940 statement parsing. Split from banking.ts (pure moves only). */
import { BankingError, type ParsedStatementLine, type ParsedStatement, type StatementSourceContent } from "../banking-core"
import { decodeStatementSourceText } from "../statement-encoding"
import { assertRealDate, expandTwoDigitYear, normalizeAmount } from "./shared"


/**
 * Parse a SWIFT MT940 (Customer Statement) message. Reads :61: statement lines
 * (value date, D/C mark, amount) with their following :86: information line,
 * plus :25: account, :28C: statement number, and :62F: closing balance.
 */
export function parseMt940(source: StatementSourceContent): ParsedStatement {
  const text = decodeStatementSourceText(source, "mt940");
  const body = text.replace(/\r/g, "");
  // Split into tag blocks: a line starting with ":NN:" begins a new field.
  const fields: { tag: string; value: string }[] = [];
  for (const ln of body.split("\n")) {
    const m = ln.match(/^:(\d{2}[A-Z]?):(.*)$/);
    if (m) fields.push({ tag: m[1]!, value: m[2]! });
    else if (fields.length && ln.trim() && ln.trim() !== "-") fields[fields.length - 1]!.value += "\n" + ln;
  }
  // One parse produces one statement with one account, one currency, and one
  // closing balance. A file carrying several :20: statements (or several :25:
  // accounts) would otherwise merge their lines while the account identity is
  // dropped and the later balance/currency silently wins — the same quiet
  // aggregation the BAI2 parser refuses. Split one statement per message.
  const statementCount = fields.filter((field) => field.tag === "20").length;
  if (statementCount > 1) {
    throw new BankingError(
      "MT940 message contains multiple statements — import one statement per message so each keeps its own account, balance, and lines",
    );
  }
  const messageAccounts = new Set(
    fields.map((field) => (field.tag === "25" ? field.value.trim() : "")).filter((value) => value !== ""),
  );
  if (messageAccounts.size > 1) {
    throw new BankingError(
      `MT940 message contains multiple accounts (${[...messageAccounts].join(", ")}) — import one account per message so each statement keeps its own currency, balance, and lines`,
    );
  }
  const lines: ParsedStatementLine[] = [];
  let currency: string | undefined;
  let closingBalance: string | undefined;
  let statementDate: string | undefined;
  let pending: ParsedStatementLine | null = null;
  const pushPending = () => {
    if (pending) lines.push(pending);
    pending = null;
  };
  for (const { tag, value } of fields) {
    if (tag === "61") {
      pushPending();
      // YYMMDD [MMDD] {D|C|RD|RC} [funds] amount(,) type ...
      const m = value.match(/^(\d{6})(\d{4})?(R?[DC])([A-Z])?([\d.,]+)/);
      if (!m) throw new BankingError(`MT940: unparseable :61: line "${value.slice(0, 40)}"`);
      const dm = m[1]!.match(/^(\d{2})(\d{2})(\d{2})$/)!;
      // Subfield 3 names the mark, not the resulting direction: C/D are plain
      // credit/debit, while RC/RD name what is being reversed — a reversal of
      // a credit takes money out (debit) and a reversal of a debit puts it
      // back (credit), per the SWIFT MT940 debit/credit-mark contract.
      const debit = m[3] === "D" || m[3] === "RC";
      const amount = normalizeAmount((debit ? "-" : "") + m[5], "MT940 amount", "swift-decimal");
      const rest = value.slice(m[0].length);
      const ref = rest.split("//")[0]?.replace(/^N[A-Z]{3}/, "").trim() || null;
      pending = {
        postedOn: assertRealDate(expandTwoDigitYear(dm[1]!), dm[2]!, dm[3]!, `MT940 date "${m[1]}"`),
        amount,
        description: null,
        counterpartyRef: ref,
        bankTransactionId: ref,
      };
    } else if (tag === "86" && pending) {
      pending.description = value.replace(/\n/g, " ").replace(/[?>]\d{2}/g, " ").replace(/\s+/g, " ").trim() || null;
    } else if (tag === "60F" || tag === "60M" || tag === "62F" || tag === "62M") {
      // Balance fields carry the authoritative statement currency. The :25:
      // account reference never does — inferring a code from its suffix once
      // let an account like ACC…USD override the explicit CAD on the balances.
      // Opening and closing balances must agree; contradiction fails closed.
      const m = value.match(/^([DC])(\d{6})([A-Z]{3})([\d.,]+)/);
      const balanceCurrency = m?.[3];
      if (balanceCurrency && currency !== undefined && currency !== balanceCurrency) {
        throw new BankingError(
          `MT940: contradictory balance currencies ${currency} and ${balanceCurrency} — split the statements instead of merging them`,
        );
      }
      if (balanceCurrency) currency = balanceCurrency;
      if ((tag === "62F" || tag === "62M") && m) {
        closingBalance = normalizeAmount((m[1] === "D" ? "-" : "") + m[4], "MT940 closing balance", "swift-decimal");
        const dm = m[2]!.match(/^(\d{2})(\d{2})(\d{2})$/)!;
        statementDate = assertRealDate(expandTwoDigitYear(dm[1]!), dm[2]!, dm[3]!, "MT940 balance date");
      }
    }
  }
  pushPending();
  if (lines.length === 0) throw new BankingError("MT940: no :61: statement lines found");
  // Multiple :25: accounts are refused above; the surviving value (if the
  // message carries one) is the file's single account.
  const externalAccountId = [...messageAccounts][0];
  return { lines, currency, statementDate, closingBalance, externalAccountId };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
