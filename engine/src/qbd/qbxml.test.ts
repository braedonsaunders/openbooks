import test from "node:test";
import assert from "node:assert/strict";
import { buildCapturePlan, calendarMonths, continueRequestXml, negotiateQbxmlVersion, parseReportRows, parseXml, responseStatus, xmlEscape } from "./qbxml.ts";

test("capture plan splits the ledger into bounded calendar months", () => {
  const through = new Date("2024-03-12T19:20:00Z");
  const plan = buildCapturePlan("2024-01-15", through);
  assert.deepEqual(plan.filter((r) => r.family.startsWith("ledger:")).map((r) => r.family), [
    "ledger:2024-01", "ledger:2024-02", "ledger:2024-03",
  ]);
  assert.match(plan.find((r) => r.family === "ledger:2024-01")!.requestXml, /<FromReportDate>2024-01-15<\/FromReportDate>/);
  assert.match(plan.find((r) => r.family === "ledger:2024-03")!.requestXml, /<ToReportDate>2024-03-12<\/ToReportDate>/);
  assert.deepEqual(calendarMonths("2024-02-29", through)[0], { month: "2024-02", from: "2024-02-29", to: "2024-02-29" });
});

test("parser rejects DTD and entity declarations", () => {
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY y "z">]><x>&y;</x>'), /may not define/);
});

test("request version is negotiated down to the QuickBooks-supported qbXML version", () => {
  const request = buildCapturePlan("2024-01-01", new Date("2024-01-01T00:00:00Z"))[0]!.requestXml;
  assert.match(negotiateQbxmlVersion(request, 16, 0), /<\?qbxml version="16\.0"\?>/);
  assert.match(negotiateQbxmlVersion(request, 99, 0), /<\?qbxml version="17\.0"\?>/);
});

test("iterator continuation escapes the QuickBooks iterator id", () => {
  const start = buildCapturePlan("2024-01-01", new Date("2024-01-01T00:00:00Z")).find((r) => r.family === "account")!;
  const next = continueRequestXml(start.requestXml, 'id&"');
  assert.match(next, /iterator="Continue" iteratorID="id&amp;&quot;"/);
  assert.match(continueRequestXml(next, "second"), /iterator="Continue" iteratorID="second"/);
  assert.equal(xmlEscape("<&>\"'"), "&lt;&amp;&gt;&quot;&apos;");
});

test("status and report parsers handle qbXML attributes and column ids", () => {
  const xml = `<?xml version="1.0"?><QBXML><QBXMLMsgsRs><GeneralDetailReportQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK" iteratorID="abc" iteratorRemainingCount="2"><ReportRet><ColDesc colID="1"><ColType>TxnID</ColType></ColDesc><ColDesc colID="2"><ColType>Amount</ColType></ColDesc><ReportData><DataRow><ColData colID="1" value="TXN-1"/><ColData colID="2" value="12.34"/></DataRow></ReportData></ReportRet></GeneralDetailReportQueryRs></QBXMLMsgsRs></QBXML>`;
  assert.deepEqual(responseStatus(xml), { code: 0, severity: "Info", message: "Status OK", iteratorId: "abc", iteratorRemaining: 2 });
  assert.deepEqual(parseReportRows(xml), [{ rowType: "DataRow", columns: { TxnID: "TXN-1", Amount: "12.34" } }]);
});
