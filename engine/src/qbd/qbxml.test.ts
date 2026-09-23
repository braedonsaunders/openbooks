import test from "node:test";
import assert from "node:assert/strict";
import { buildCapturePlan, calendarMonths, continueRequestXml, negotiateQbxmlVersion, parseQbdReportDate, parseReportRows, parseXml, requestElementName, requestIdFromRequestXml, responseElementForRequest, responseStatus, stampRequestId, xmlEscape } from "./qbxml.ts";

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

test("report dates normalize from QuickBooks display format to ISO", () => {
  assert.equal(parseQbdReportDate("01/31/2024"), "2024-01-31");
  assert.equal(parseQbdReportDate("1/5/2024"), "2024-01-05");
  assert.equal(parseQbdReportDate("12/31/2023"), "2023-12-31");
  assert.equal(parseQbdReportDate("02/29/2024"), "2024-02-29");
  assert.equal(parseQbdReportDate("2024-01-31"), "2024-01-31");
  assert.throws(() => parseQbdReportDate("02/29/2023"), /not a calendar date/);
  assert.throws(() => parseQbdReportDate("13/01/2024"), /not a calendar date/);
  assert.throws(() => parseQbdReportDate("2024-13-01"), /not a calendar date/);
  assert.throws(() => parseQbdReportDate("01/31/24"), /not a recognized date/);
  assert.throws(() => parseQbdReportDate(""), /not a recognized date/);
  assert.throws(() => parseQbdReportDate(undefined), /not a recognized date/);
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
  assert.deepEqual(responseStatus(xml), { code: 0, severity: "Info", message: "Status OK", iteratorId: "abc", iteratorRemaining: 2, kind: "GeneralDetailReportQueryRs", requestId: null });
  assert.deepEqual(parseReportRows(xml), [{ rowType: "DataRow", columns: { TxnID: "TXN-1", Amount: "12.34" } }]);
});

test("requestID correlation stamps the request element, never the envelope", () => {
  const plan = buildCapturePlan("2024-01-01", new Date("2024-01-01T00:00:00Z"));
  const company = plan.find((r) => r.family === "company")!;
  assert.equal(requestElementName(company.requestXml), "CompanyQueryRq");
  assert.equal(responseElementForRequest(company.requestXml), "CompanyQueryRs");
  assert.equal(requestIdFromRequestXml(company.requestXml), null);

  const stamped = stampRequestId(company.requestXml, "11111111-2222-4333-8555-666666666666");
  assert.match(stamped, /<CompanyQueryRq requestID="11111111-2222-4333-8555-666666666666"\/>/);
  assert.doesNotMatch(stamped, /QBXMLMsgsRq requestID/);
  assert.equal(requestIdFromRequestXml(stamped), "11111111-2222-4333-8555-666666666666");

  // Re-stamping a re-queued request replaces the identity instead of
  // duplicating the attribute.
  const restamped = stampRequestId(stamped, "22222222-2222-4333-8555-666666666666");
  assert.equal(requestIdFromRequestXml(restamped), "22222222-2222-4333-8555-666666666666");
  assert.equal(restamped.match(/requestID/g)?.length, 1);

  // The expected response element is derived from the request element, not
  // the capture-plan kind: ledger requests are GeneralLedger rows carrying
  // a GeneralDetailReportQueryRq element.
  const ledger = plan.find((r) => r.family === "ledger:2024-01")!;
  assert.equal(requestElementName(ledger.requestXml), "GeneralDetailReportQueryRq");
  assert.equal(responseElementForRequest(ledger.requestXml), "GeneralDetailReportQueryRs");

  // Iterator attributes survive the stamp: the next page is still continuable.
  const account = plan.find((r) => r.family === "account")!;
  const stampedAccount = stampRequestId(account.requestXml, "33333333-2222-4333-8555-666666666666");
  assert.match(stampedAccount, /iterator="Start"/);
  assert.equal(requestIdFromRequestXml(continueRequestXml(stampedAccount, "it-1")), "33333333-2222-4333-8555-666666666666");

  const echoed = `<?xml version="1.0"?><QBXML><QBXMLMsgsRs><CompanyQueryRs requestID="11111111-2222-4333-8555-666666666666" statusCode="0" statusSeverity="Info" statusMessage="Status OK"><CompanyRet/></CompanyQueryRs></QBXMLMsgsRs></QBXML>`;
  assert.deepEqual(responseStatus(echoed).requestId, "11111111-2222-4333-8555-666666666666");
  assert.equal(responseStatus(echoed).kind, "CompanyQueryRs");
});
