import assert from "node:assert/strict";
import test from "node:test";
import {
  BankingError,
  filterDuplicateStatementLines,
  parseCamt053,
} from "./banking.ts";

/**
 * A standing order executes monthly with the SAME originator-set EndToEndId
 * on every execution; each execution carries its own bank-assigned
 * AcctSvcrRef. The dedupe key must be the bank's per-entry reference, or
 * every execution after the first is silently dropped at import.
 */
const STANDING_ORDER_CAMT = `<?xml version="1.0" encoding="UTF-8"?>
<Document><BkToCstmrStmt><Stmt><Ccy>CAD</Ccy>
<Ntry><Amt Ccy="CAD">100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-08-10</Dt></BookgDt><AddtlNtryInf>STANDING ORDER RENT</AddtlNtryInf><TxDtls><EndToEndId>STANDING-ORDER-1</EndToEndId><AcctSvcrRef>BANK-AAA</AcctSvcrRef></TxDtls></Ntry>
<Ntry><Amt Ccy="CAD">100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-09-10</Dt></BookgDt><AddtlNtryInf>STANDING ORDER RENT</AddtlNtryInf><TxDtls><EndToEndId>STANDING-ORDER-1</EndToEndId><AcctSvcrRef>BANK-BBB</AcctSvcrRef></TxDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

test("camt.053 keys entries by the bank reference, not the reused end-to-end id", () => {
  const parsed = parseCamt053(STANDING_ORDER_CAMT);
  assert.equal(parsed.lines.length, 2);
  assert.deepEqual(
    parsed.lines.map((line) => line.bankTransactionId),
    ["BANK-AAA", "BANK-BBB"],
  );
  const filtered = filterDuplicateStatementLines(parsed.lines, new Set());
  assert.equal(filtered.lines.length, 2);
  assert.equal(filtered.duplicates, 0);
});

test("camt.053 reconciliation uses booked balances regardless of available-balance order", () => {
  const balance = (code: string, amount: string, date: string) => `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt>${amount}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>`;
  const booked = balance("CLBD", "100", "2026-09-10");
  const available = balance("CLAV", "80", "2026-09-11");
  for (const balances of [booked + available, available + booked]) {
    const parsed = parseCamt053(STANDING_ORDER_CAMT.replace("</Stmt>", `${balances}</Stmt>`));
    assert.equal(parsed.closingBalance, "100.0000");
    assert.equal(parsed.statementDate, "2026-09-10");
    assert.equal(parsed.lines.length, 2);
  }
  const availableOnly = parseCamt053(STANDING_ORDER_CAMT.replace("</Stmt>", `${available}</Stmt>`));
  assert.equal(availableOnly.closingBalance, undefined);
  assert.equal(availableOnly.statementDate, undefined);
});

test("camt.053 refuses sibling statements instead of omitting subsequent account or date evidence", () => {
  const statement = STANDING_ORDER_CAMT.match(/<Stmt>([\s\S]*?)<\/Stmt>/)![0];
  for (const second of [statement, statement.replaceAll("2026-09-10", "2026-10-10")]) {
    assert.throws(
      () => parseCamt053(`<Document><BkToCstmrStmt>${statement}${second}</BkToCstmrStmt></Document>`),
      (error: unknown) => error instanceof BankingError && /multiple statements/.test(error.message),
    );
  }
});

test("camt.053 retains entry-level bank references for recurring customer references", () => {
  const entry = (date: string, bankRef?: string) => `<Ntry>${bankRef ? `<AcctSvcrRef>${bankRef}</AcctSvcrRef>` : ""}<Amt>100</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>${date}</Dt></BookgDt><TxDtls><Refs><EndToEndId>RENT</EndToEndId></Refs></TxDtls></Ntry>`;
  const parsed = parseCamt053(`<Document><BkToCstmrStmt><Stmt>${entry("2026-08-10", "BANK-A")}${entry("2026-09-10", "BANK-B")}</Stmt></BkToCstmrStmt></Document>`);
  assert.deepEqual(parsed.lines.map(line => line.bankTransactionId), ["BANK-A", "BANK-B"]);
  assert.equal(filterDuplicateStatementLines(parsed.lines, new Set()).lines.length, 2);
  const withoutBankReference = parseCamt053(`<Stmt>${entry("2026-08-10")}${entry("2026-09-10")}</Stmt>`);
  assert.deepEqual(withoutBankReference.lines.map(line => line.bankTransactionId), [null, null]);
  assert.equal(filterDuplicateStatementLines(withoutBankReference.lines, new Set()).lines.length, 2);
});
