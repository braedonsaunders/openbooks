import assert from "node:assert/strict";
import test from "node:test";
import {
  BankingError,
  normalizeExternalAccountId,
  parseBai2,
  parseCamt053,
  parseCsv,
  parseMt940,
  parseOfx,
} from "./banking.ts";

/**
 * Statement account identity, per format. The scheduled SFTP import files
 * every watch-folder statement into the schedule's account: without the
 * file's own identifier a same-currency statement for account B dropped
 * in account A's folder silently becomes A's lines and balance evidence.
 * These tests pin the carry-through (and the multi-account refusals) that
 * the import gate compares against the schedule's binding.
 */

const ofxDoc = (acctFrom: string) =>
  [
    "OFXHEADER:100",
    "DATA:OFXSGML",
    "VERSION:102",
    "SECURITY:NONE",
    "ENCODING:USASCII",
    "CHARSET:1252",
    "COMPRESSION:NONE",
    "OLDFILEUID:NONE",
    "NEWFILEUID:NONE",
    "",
    `<OFX><CURDEF>CAD<STMTRS>${acctFrom}<STMTTRN><DTPOSTED>20260715</DTPOSTED><TRNAMT>-10.50</TRNAMT><NAME>Vendor</NAME><FITID>1</FITID></STMTTRN></STMTRS></OFX>`,
  ].join("\r\n");

test("OFX carries its ACCTID as the file's account", () => {
  const parsed = parseOfx(ofxDoc("<BANKACCTFROM><BANKID>001</BANKID><ACCTID>12345678</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>"));
  assert.equal(parsed.externalAccountId, "12345678");
});

test("OFX with two distinct accounts refuses naming both", () => {
  const two = ofxDoc("<BANKACCTFROM><ACCTID>111</ACCTID></BANKACCTFROM>").replace(
    "</STMTTRN>",
    "</STMTTRN><CCACCTFROM><ACCTID>222</ACCTID></CCACCTFROM>",
  );
  assert.throws(
    () => parseOfx(two),
    (e: unknown) => e instanceof BankingError && /multiple accounts/.test(e.message) && /111/.test(e.message) && /222/.test(e.message),
    "merging two ledgers must name both accounts, not just refuse",
  );
});

test("OFX without an ACCTID carries no identity", () => {
  const parsed = parseOfx(ofxDoc(""));
  assert.equal(parsed.externalAccountId, undefined);
});

test("BAI2 carries its single 03 account number", () => {
  const parsed = parseBai2(
    ["02,ORG,1,1,260821,0000,CAD,2/", "03,987654321,CAD,015,100000/", "16,165,+150000,S,REF,,deposit/"].join("\n"),
  );
  assert.equal(parsed.externalAccountId, "987654321");
});

test("MT940 carries its :25: account", () => {
  const parsed = parseMt940(
    [
      ":20:STMT1",
      ":25:DE975203000012345678",
      ":28C:1",
      ":60F:C260821EUR1000,00",
      ":61:2608210821C500,00NTRFREFONE",
      ":86:Alpha deposit",
      ":62F:C260821EUR1500,00",
      "-",
    ].join("\n"),
  );
  assert.equal(parsed.externalAccountId, "DE975203000012345678");
});

test("CAMT.053 carries its statement IBAN and refuses a second one", () => {
  const camt = (iban: string, extra = "") =>
    `<?xml version="1.0" encoding="UTF-8"?><Document><BkToCstmrStmt><Stmt><Ccy>CAD</Ccy><Acct><Id><IBAN>${iban}</IBAN></Id></Acct>${extra}<Ntry><Amt Ccy="CAD">100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-08-10</Dt></BookgDt><AddtlNtryInf>rent</AddtlNtryInf></Ntry></Stmt></BkToCstmrStmt></Document>`;
  assert.equal(parseCamt053(camt("CA000123456789")).externalAccountId, "CA000123456789");
  assert.throws(
    () => parseCamt053(camt("CA000123456789", "<Acct><Id><IBAN>CA000999999999</IBAN></Id></Acct>")),
    (e: unknown) =>
      e instanceof BankingError && /multiple accounts/.test(e.message) && /CA000999999999/.test(e.message),
  );
});

test("CSV carries no account identity", () => {
  assert.equal(parseCsv("date,amount,description\n2026-07-01,12.50,salary\n", { date: 0, amount: 1, description: 2 })[0]?.amount, "12.5000");
});

test("identifier comparison is whitespace-blind and case-blind, never silent", () => {
  assert.equal(normalizeExternalAccountId("de97 5203 0000 1234 5678"), "DE975203000012345678");
  assert.equal(normalizeExternalAccountId("  "), undefined);
  assert.equal(normalizeExternalAccountId(null), undefined);
});
