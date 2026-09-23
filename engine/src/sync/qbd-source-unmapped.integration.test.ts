import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, env, schema } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import { prepareCapture } from "../qbd/bridge.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { QbdSource } from "./qbd-source.ts";

const DB = Boolean(env.OPENBOOKS_DB_URL && env.OPENBOOKS_DATA_KEY);

function envelope(inner: string): string {
  return `<?xml version="1.0"?><QBXML><QBXMLMsgsRs>${inner}</QBXMLMsgsRs></QBXML>`;
}

function accountListXml(): string {
  return envelope(`<AccountQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK"><AccountRet><ListID>CASH-1</ListID><Name>Cash</Name><FullName>Cash</FullName><AccountType>Bank</AccountType><IsActive>true</IsActive></AccountRet></AccountQueryRs>`);
}

function trialBalanceXml(rows: Array<{ account: string; debit: string; credit: string }>): string {
  const data = rows.map((r) =>
    `<DataRow><ColData colID="1" value="${r.account}"/><ColData colID="2" value="${r.debit}"/><ColData colID="3" value="${r.credit}"/></DataRow>`).join("");
  return envelope(`<GeneralSummaryReportQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK"><ReportRet><ColDesc colID="1"><ColType>Account</ColType></ColDesc><ColDesc colID="2"><ColType>Debit</ColType></ColDesc><ColDesc colID="3"><ColType>Credit</ColType></ColDesc><ReportData>${data}</ReportData></ReportRet></GeneralSummaryReportQueryRs>`);
}

function ledgerXml(rows: Array<{ txn: string; date: string; account: string; debit: string; credit: string }>): string {
  const data = rows.map((r) =>
    `<DataRow><ColData colID="1" value="${r.txn}"/><ColData colID="2" value="${r.date}"/><ColData colID="3" value="${r.account}"/><ColData colID="4" value="${r.debit}"/><ColData colID="5" value="${r.credit}"/></DataRow>`).join("");
  return envelope(`<GeneralDetailReportQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK"><ReportRet><ColDesc colID="1"><ColType>TxnID</ColType></ColDesc><ColDesc colID="2"><ColType>Date</ColType></ColDesc><ColDesc colID="3"><ColType>Account</ColType></ColDesc><ColDesc colID="4"><ColType>Debit</ColType></ColDesc><ColDesc colID="5"><ColType>Credit</ColType></ColDesc><ReportData>${data}</ReportData></ReportRet></GeneralDetailReportQueryRs>`);
}

async function seedCapture(orgId: string, connectionId: string, rows: Array<{ family: string; requestKind: string; responseXml: string }>): Promise<QbdSource> {
  const captureId = await prepareCapture({ orgId, connectionId, historyStartDate: "2024-01-01", since: null });
  // Seeded rows share the capture's (capture_id, sequence) unique scope with
  // the plan rows prepareCapture just inserted ((index+1)*1M), so they use a
  // base far above any real plan length.
  let sequence = 1_900_000_000;
  for (const row of rows) {
    await db.insert(schema.qbdRequests).values({
      orgId,
      connectionId,
      captureId,
      family: row.family,
      requestKind: row.requestKind,
      sequence: sequence += 1_000_000,
      requestXml: "<seed/>",
      status: "complete",
      responseXml: row.responseXml,
    });
  }
  const source = new QbdSource({ orgId, connectionId, historyStartDate: "2024-01-01" });
  (source as unknown as { captureId: string }).captureId = captureId;
  (source as unknown as { captureReady: boolean }).captureReady = true;
  return source;
}

async function createConnection(orgId: string): Promise<string> {
  const [connection] = await db.insert(schema.connections).values({
    orgId,
    source: "qbd",
    displayName: `QBD unmapped test ${Date.now()}`,
    authKind: "token",
    status: "active",
    config: { historyStartDate: "2024-01-01", region: "CA", baseCurrency: "CAD" },
    secrets: sealJson({ webConnectorPassword: "unmapped-test-password-123" }),
  }).returning({ id: schema.connections.id });
  assert.ok(connection);
  return connection.id;
}

test("a nonzero trial-balance row for an unmapped account refuses verification by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const connectionId = await createConnection(org.orgId);
  try {
    const source = await seedCapture(org.orgId, connectionId, [
      { family: "account", requestKind: "AccountQuery", responseXml: accountListXml() },
      {
        family: "trial-balance",
        requestKind: "TrialBalance",
        responseXml: trialBalanceXml([
          { account: "Cash", debit: "100.00", credit: "" },
          { account: "Ghost", debit: "50.00", credit: "" },
        ]),
      },
    ]);
    await assert.rejects(() => source.trialBalance(), /unmapped account "Ghost"/);

    // A truly zero row for the same unmapped account is deliberately skipped.
    const zeroed = await seedCapture(org.orgId, connectionId, [
      { family: "account", requestKind: "AccountQuery", responseXml: accountListXml() },
      {
        family: "trial-balance",
        requestKind: "TrialBalance",
        responseXml: trialBalanceXml([
          { account: "Cash", debit: "100.00", credit: "" },
          { account: "Ghost", debit: "", credit: "" },
        ]),
      },
    ]);
    assert.deepEqual(await zeroed.trialBalance(), [{ accountRef: "CASH-1", balance: "100.0000" }]);
  } finally {
    await db.execute(sql`delete from qbd_requests where connection_id = ${connectionId}`);
    await db.execute(sql`delete from qbd_captures where connection_id = ${connectionId}`);
    await db.execute(sql`delete from connections where id = ${connectionId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("nonzero ledger activity for an unmapped account refuses the true-up by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const connectionId = await createConnection(org.orgId);
  try {
    const source = await seedCapture(org.orgId, connectionId, [
      { family: "account", requestKind: "AccountQuery", responseXml: accountListXml() },
      {
        family: "ledger:2024-01",
        requestKind: "GeneralLedger",
        responseXml: ledgerXml([
          { txn: "t1", date: "1/15/2024", account: "Ghost", debit: "25.00", credit: "" },
        ]),
      },
    ]);
    await assert.rejects(() => source.monthlyActivity(), /unmapped account "Ghost" in 2024-01/);

    const zeroed = await seedCapture(org.orgId, connectionId, [
      { family: "account", requestKind: "AccountQuery", responseXml: accountListXml() },
      {
        family: "ledger:2024-01",
        requestKind: "GeneralLedger",
        responseXml: ledgerXml([
          { txn: "t1", date: "1/15/2024", account: "Ghost", debit: "", credit: "" },
        ]),
      },
    ]);
    assert.deepEqual(await zeroed.monthlyActivity(), []);
  } finally {
    await db.execute(sql`delete from qbd_requests where connection_id = ${connectionId}`);
    await db.execute(sql`delete from qbd_captures where connection_id = ${connectionId}`);
    await db.execute(sql`delete from connections where id = ${connectionId}`);
    await dropScratchOrg(org.orgId);
  }
});
