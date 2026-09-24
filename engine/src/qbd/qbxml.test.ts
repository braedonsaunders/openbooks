import test from "node:test";
import assert from "node:assert/strict";
import { assertQbdResponsePayload, assertSoapEnvelopeComplexity, assertUniformReportLocale, buildCapturePlan, calendarMonths, continueRequestXml, identifyQbdSoapCall, negotiateQbxmlVersion, parseQbdReportAmount, parseQbdReportDate, parseReportRows, parseXml, QBD_PREAUTH_MAX_BYTES, requestElementName, requestIdFromRequestXml, responseElementForRequest, responseStatus, stampRequestId, xmlEscape } from "./qbxml.ts";

test("capture plan splits the ledger into bounded calendar months", () => {
  const through = new Date("2024-03-12T19:20:00Z");
  const plan = buildCapturePlan("2024-01-15", through);
  assert.deepEqual(plan.filter((r) => r.family.startsWith("ledger:")).map((r) => r.family), [
    "ledger:2024-01", "ledger:2024-02", "ledger:2024-03",
  ]);
  assert.match(plan.find((r) => r.family === "ledger:2024-01")!.requestXml, /<FromReportDate>2024-01-15<\/FromReportDate>/);
  assert.match(plan.find((r) => r.family === "ledger:2024-03")!.requestXml, /<ToReportDate>2024-03-12<\/ToReportDate>/);
  // Bounded history also captures a dated opening trial balance as of the
  // day before the window, so carried balances can reconcile.
  const opening = plan.find((r) => r.family === "opening-trial-balance")!;
  assert.equal(opening.requestKind, "TrialBalance");
  assert.match(opening.requestXml, /<ToReportDate>2024-01-14<\/ToReportDate>/);
  assert.deepEqual(calendarMonths("2024-02-29", through)[0], { month: "2024-02", from: "2024-02-29", to: "2024-02-29" });
});

test("the capture plan issues only read-only query requests", () => {
  // The auth-time reclaim re-queues an aged 'sent' request for a later
  // session to execute again. That is safe only because every request the
  // bridge emits is a read (*QueryRq): re-execution re-reads, it never
  // duplicates a QuickBooks write, so no idempotency marker is needed. If a
  // mutating (Add/Mod) request is ever added to the plan, this test fails to
  // force its reclaim path to be reconciled first.
  const through = new Date("2024-03-12T19:20:00Z");
  const plan = buildCapturePlan("2024-01-15", through);
  assert.ok(plan.length > 0);
  for (const request of plan) {
    const element = requestElementName(request.requestXml);
    assert.ok(element, `${request.family} carries a request element`);
    assert.match(element, /QueryRq$/, `${request.family} must be a read-only query, got ${element}`);
  }
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

test("report amounts parse in either locale without silent rescaling", () => {
  // US company file: commas are grouping, unchanged from the old behavior.
  assert.deepEqual(parseQbdReportAmount("1,234.56"), { text: "1234.56", decimal: ".", grouping: "," });
  assert.deepEqual(parseQbdReportAmount("1,234.5678"), { text: "1234.5678", decimal: ".", grouping: "," });
  // German company file: the comma is the decimal mark — stripping it would
  // overstate twelve-thirty-four as 1234 (100x).
  assert.deepEqual(parseQbdReportAmount("12,34"), { text: "12.34", decimal: ",", grouping: null });
  assert.deepEqual(parseQbdReportAmount("1.234,56"), { text: "1234.56", decimal: ",", grouping: "." });
  assert.deepEqual(parseQbdReportAmount("-1.234,56"), { text: "-1234.56", decimal: ",", grouping: "." });
  // Unmarked and grouped-only values pin no decimal separator.
  assert.deepEqual(parseQbdReportAmount("25.00"), { text: "25.00", decimal: ".", grouping: null });
  assert.deepEqual(parseQbdReportAmount("1,234,567"), { text: "1234567", decimal: null, grouping: "," });
  assert.deepEqual(parseQbdReportAmount("1.234.567"), { text: "1234567", decimal: null, grouping: "." });
  // Empty cells (headings/blanks) stay zero; zeros never refuse over format.
  assert.deepEqual(parseQbdReportAmount(""), { text: "0", decimal: null, grouping: null });
  assert.deepEqual(parseQbdReportAmount("0.000"), { text: "0", decimal: null, grouping: null });
  assert.deepEqual(parseQbdReportAmount("0,000"), { text: "0", decimal: null, grouping: null });
});

test("ambiguous report amounts refuse by name with both readings", () => {
  // A REALISTIC collision, not a synthetic duplicate: the message must tell
  // a US operator apart from a German one, naming both readings.
  assert.throws(
    () => parseQbdReportAmount("12,345", "trial balance"),
    /QuickBooks amount "12,345" in trial balance is ambiguous: it reads as 12345 with US thousands separators and as 12\.345 with a European decimal comma/,
  );
  assert.throws(
    () => parseQbdReportAmount("1.234", "trial balance"),
    /QuickBooks amount "1\.234" in trial balance is ambiguous: it reads as 1\.234 with a US decimal point and as 1234 with European thousands separators/,
  );
  // Misplaced grouping (Indian-style, stray separators) refuses too.
  assert.throws(() => parseQbdReportAmount("1,00,000"), /misplaced separators/);
  assert.throws(() => parseQbdReportAmount("12,34.56"), /misplaced separators/);
  assert.throws(() => parseQbdReportAmount("1 234,56"), /not a recognized number/);
});

test("a report mixing US and European formats refuses as a locale mismatch", () => {
  const us = [parseQbdReportAmount("1,234.56"), parseQbdReportAmount("12.34")];
  const german = [parseQbdReportAmount("1.234,56"), parseQbdReportAmount("12,34")];
  assert.doesNotThrow(() => assertUniformReportLocale(us, "trial balance"));
  assert.doesNotThrow(() => assertUniformReportLocale(german, "trial balance"));
  // The cross case: US grouping beside a European decimal mark.
  const crossed = [parseQbdReportAmount("1,234,567"), parseQbdReportAmount("12,34")];
  assert.throws(
    () => assertUniformReportLocale([...us, ...german], "trial balance"),
    /mixes US-style \(1,234\.56\) and European-style \(1\.234,56\) number formats/,
  );
  assert.throws(
    () => assertUniformReportLocale(crossed, "trial balance"),
    /mixes US-style \(1,234\.56\) and European-style \(1\.234,56\) number formats/,
  );
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

test("a success response without its payload is refused, never read as empty", () => {
  const truncated = `<?xml version="1.0"?><QBXML><QBXMLMsgsRs><GeneralDetailReportQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK"></GeneralDetailReportQueryRs></QBXMLMsgsRs></QBXML>`;
  assert.throws(
    () => assertQbdResponsePayload({ family: "ledger:2024-01", requestKind: "GeneralLedger", expectedRs: "GeneralDetailReportQueryRs", responseXml: truncated }),
    /GeneralLedger capture for ledger:2024-01.*carries no report/,
  );

  // ReportRet and column descriptors present but zero data rows: a genuinely
  // empty month, still accepted.
  const emptyMonth = `<?xml version="1.0"?><QBXML><QBXMLMsgsRs><GeneralDetailReportQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK"><ReportRet><ColDesc colID="1"><ColType>TxnID</ColType></ColDesc><ReportData></ReportData></ReportRet></GeneralDetailReportQueryRs></QBXMLMsgsRs></QBXML>`;
  assert.doesNotThrow(
    () => assertQbdResponsePayload({ family: "ledger:2024-01", requestKind: "GeneralLedger", expectedRs: "GeneralDetailReportQueryRs", responseXml: emptyMonth }),
  );
  assert.deepEqual(parseReportRows(emptyMonth), []);

  // Lists get the same missing-container validation: no answering Rs node is
  // refused, while a present-but-empty list stays valid.
  const noContainer = `<?xml version="1.0"?><QBXML><QBXMLMsgsRs></QBXMLMsgsRs></QBXML>`;
  assert.throws(
    () => assertQbdResponsePayload({ family: "customer", requestKind: "CustomerQuery", expectedRs: "CustomerQueryRs", responseXml: noContainer }),
    /CustomerQuery capture for customer.*carries no CustomerQueryRs payload/,
  );
  const emptyList = `<?xml version="1.0"?><QBXML><QBXMLMsgsRs><CustomerQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK"></CustomerQueryRs></QBXMLMsgsRs></QBXML>`;
  assert.doesNotThrow(
    () => assertQbdResponsePayload({ family: "customer", requestKind: "CustomerQuery", expectedRs: "CustomerQueryRs", responseXml: emptyList }),
  );
});

test("the pre-auth head identifies the SOAP method and ticket without parsing", () => {
  assert.equal(QBD_PREAUTH_MAX_BYTES, 64 * 1024);
  const head = `<soap:Envelope><soap:Body><receiveResponseXML xmlns="http://developer.intuit.com/"><ticket>01a0ce9f-1d5b-7a7a-be6c-0585424d49f5</ticket><response>`;
  assert.deepEqual(identifyQbdSoapCall(head), { method: "receiveResponseXML", ticket: "01a0ce9f-1d5b-7a7a-be6c-0585424d49f5" });
  // A truncated prefix still identifies: only the opening element matters.
  assert.deepEqual(identifyQbdSoapCall(`<soap:Body><authenticate `), { method: "authenticate", ticket: null });
  assert.deepEqual(
    identifyQbdSoapCall(`<sendRequestXML><ticket>abc</ticket></sendRequestXML>`),
    { method: "sendRequestXML", ticket: "abc" },
  );
  assert.equal(identifyQbdSoapCall(`<soap:Body><unknownMethod/></soap:Body>`), null);
  assert.equal(identifyQbdSoapCall(""), null);
});

test("the complexity guard refuses deep or bloated envelopes before parsing", () => {
  assert.doesNotThrow(() => assertSoapEnvelopeComplexity(`<soap:Envelope><soap:Body><serverVersion/></soap:Body></soap:Envelope>`));
  const deep = `<a>`.repeat(200) + `x` + `</a>`.repeat(200);
  assert.throws(() => assertSoapEnvelopeComplexity(deep), /nests deeper than 128 elements/);
  assert.throws(() => assertSoapEnvelopeComplexity(`<a/>`.repeat(11), { maxTags: 10, maxDepth: 128 }), /exceeds the 10-tag parser budget/);
  assert.throws(() => assertSoapEnvelopeComplexity(`<!DOCTYPE x [<!ENTITY y "z">]><x/>`), /may not define a DTD or entity/);
  // CDATA payload text is opaque: escaped bulk cannot inflate the count.
  assert.doesNotThrow(() => assertSoapEnvelopeComplexity(`<response><![CDATA[${"<a>".repeat(5000)}]]></response>`));
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

test("responseStatus accepts strict integer tokens and refuses the rest", () => {
  const rs = (attrs: string): string =>
    `<?xml version="1.0"?><QBXML><QBXMLMsgsRs><CompanyQueryRs requestID="11111111-2222-4333-8555-666666666666" ${attrs}><CompanyRet><CompanyName>Acme</CompanyName></CompanyRet></CompanyQueryRs></QBXMLMsgsRs></QBXML>`;
  // Accepted: present codes (including negative error codes), and an absent
  // iterator count meaning the last page.
  assert.equal(responseStatus(rs('statusCode="0"')).code, 0);
  assert.equal(responseStatus(rs('statusCode="0"')).iteratorRemaining, 0);
  assert.equal(responseStatus(rs('statusCode="0" iteratorRemainingCount="0"')).iteratorRemaining, 0);
  assert.equal(responseStatus(rs('statusCode="0" iteratorRemainingCount="2" iteratorID="it-1"')).iteratorRemaining, 2);
  assert.equal(responseStatus(rs('statusCode="500"')).code, 500);
  assert.equal(responseStatus(rs('statusCode="-1"')).code, -1);
  // Refused iterator counts: unreadable, negative, fractional, infinite, and
  // anything outside the safe-integer range.
  for (const bad of ["oops", "-1", "1.5", "Infinity", "NaN", "", " ", " 2", "2 ", "0x10", "99999999999999999999999"]) {
    assert.throws(
      () => responseStatus(rs(`statusCode="0" iteratorRemainingCount="${bad}" iteratorID="it-1"`)),
      /invalid iteratorRemainingCount/,
      `iteratorRemainingCount ${JSON.stringify(bad)} must be refused`,
    );
  }
  // Refused status codes: a blank or whitespace status previously coerced to
  // 0 (SUCCESS); a missing attribute is malformed, not absent.
  for (const bad of ["", " ", "oops", "0.0", "Infinity", "NaN", "99999999999999999999999"]) {
    assert.throws(
      () => responseStatus(rs(`statusCode="${bad}"`)),
      /invalid statusCode/,
      `statusCode ${JSON.stringify(bad)} must be refused`,
    );
  }
  assert.throws(() => responseStatus(rs("")), /invalid statusCode/);
});
