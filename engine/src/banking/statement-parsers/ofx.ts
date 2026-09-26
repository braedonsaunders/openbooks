/** OFX statement parsing. Split from banking.ts (pure moves only). */
import { BankingError, type ParsedStatementLine, type ParsedStatement, type StatementSourceContent } from "../banking-core"
import { decodeStatementSourceText } from "../statement-encoding"
import { decodeOfxEntities, assertRealDate, normalizeAmount } from "./shared"


/** First leaf value for `<TAG>value` (SGML, unclosed) or `<TAG>value</TAG>`. */
function ofxValue(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, "i"));
  const v = m?.[1]?.trim();
  return v ? decodeOfxEntities(v) : undefined;
}

/** OFX DTPOSTED/DTASOF: YYYYMMDD[HHMMSS[.mmm]][ [gmt offset] ] → YYYY-MM-DD. */
function ofxDate(raw: string): string {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) throw new BankingError(`OFX: unparseable date "${raw}"`);
  return assertRealDate(m[1]!, m[2]!, m[3]!, `OFX date "${raw}"`);
}

/**
 * Parse an OFX bank statement (v1 SGML headers or v2 XML) into normalized
 * lines. Reads `<STMTTRN>` blocks (DTPOSTED, TRNAMT, NAME/MEMO, FITID,
 * REFNUM/CHECKNUM) plus statement-level CURDEF and LEDGERBAL.
 */
export function parseOfx(source: StatementSourceContent): ParsedStatement {
  const text = decodeStatementSourceText(source, "ofx");
  const body = text.replace(/\r\n/g, "\n");
  const chunks = body.split(/<STMTTRN>/i).slice(1);
  if (chunks.length === 0) {
    throw new BankingError("No transactions found — expected OFX <STMTTRN> blocks");
  }
  const lines: ParsedStatementLine[] = chunks.map((chunk, i) => {
    const block = chunk.split(/<\/STMTTRN>/i)[0]!;
    const dt = ofxValue(block, "DTPOSTED");
    const amt = ofxValue(block, "TRNAMT");
    if (!dt) throw new BankingError(`OFX transaction ${i + 1}: missing DTPOSTED`);
    if (!amt) throw new BankingError(`OFX transaction ${i + 1}: missing TRNAMT`);
    const name = ofxValue(block, "NAME");
    const memo = ofxValue(block, "MEMO");
    const description =
      name && memo && memo !== name ? `${name} — ${memo}` : (name ?? memo ?? null);
    return {
      postedOn: ofxDate(dt),
      amount: normalizeAmount(amt, `OFX transaction ${i + 1}`),
      description,
      counterpartyRef: ofxValue(block, "REFNUM") ?? ofxValue(block, "CHECKNUM") ?? null,
      bankTransactionId: ofxValue(block, "FITID") ?? null,
    };
  });

  const parsed: ParsedStatement = { lines };
  // Account identity lives in BANKACCTFROM/CCACCTFROM/INVACCTFROM sections
  // as ACCTID. One parse produces one statement: distinct account
  // identifiers would merge ledgers while only the last balance wins, the
  // same quiet aggregation the BAI2 and MT940 parsers refuse.
  const acctIds = [...body.matchAll(/<ACCTID>\s*([^<\r\n]*)/gi)]
    .map((m) => decodeOfxEntities(m[1]!.trim()))
    .filter((v) => v !== "");
  const distinctAcctIds = [...new Set(acctIds)];
  if (distinctAcctIds.length > 1) {
    throw new BankingError(
      `OFX file contains multiple accounts (${distinctAcctIds.join(", ")}) — import one account per file so each statement keeps its own balance and lines`,
    );
  }
  if (distinctAcctIds.length === 1) parsed.externalAccountId = distinctAcctIds[0];
  const curdef = ofxValue(body, "CURDEF");
  if (curdef && /^[A-Za-z]{3}$/.test(curdef)) parsed.currency = curdef.toUpperCase();
  const ledger = body.match(/<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|$)/i)?.[1];
  if (ledger) {
    const bal = ofxValue(ledger, "BALAMT");
    const asOf = ofxValue(ledger, "DTASOF");
    if (bal) parsed.closingBalance = normalizeAmount(bal, "OFX ledger balance");
    if (asOf) parsed.statementDate = ofxDate(asOf);
  }
  return parsed;
}
