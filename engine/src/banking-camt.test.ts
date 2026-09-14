import assert from "node:assert/strict";
import test from "node:test";
import {
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
