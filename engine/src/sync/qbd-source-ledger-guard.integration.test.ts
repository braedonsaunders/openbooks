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

function ledgerXml(rows: Array<{ txn?: string; date: string; account: string; debit: string; credit: string }>): string {
  const data = rows.map((r) =>
    `<DataRow>${r.txn ? `<ColData colID="1" value="${r.txn}"/>` : ""}<ColData colID="2" value="${r.date}"/><ColData colID="3" value="${r.account}"/><ColData colID="4" value="${r.debit}"/><ColData colID="5" value="${r.credit}"/></DataRow>`).join("");
  return envelope(`<GeneralDetailReportQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK"><ReportRet><ColDesc colID="1"><ColType>TxnID</ColType></ColDesc><ColDesc colID="2"><ColType>Date</ColType></ColDesc><ColDesc colID="3"><ColType>Account</ColType></ColDesc><ColDesc colID="4"><ColType>Debit</ColType></ColDesc><ColDesc colID="5"><ColType>Credit</ColType></ColDesc><ReportData>${data}</ReportData></ReportRet></GeneralDetailReportQueryRs>`);
}

async function seedLedger(orgId: string, connectionId: string, rows: Array<{ txn?: string; date: string; account: string; debit: string; credit: string }>): Promise<QbdSource> {
  const captureId = await prepareCapture({ orgId, connectionId, historyStartDate: "2024-01-01", since: null });
  let sequence = 1_900_000_000;
  for (const [family, requestKind, responseXml] of [
    ["account", "AccountQuery", accountListXml()],
    ["ledger:2024-01", "GeneralLedger", ledgerXml(rows)],
  ] as const) {
    await db.insert(schema.qbdRequests).values({
      orgId,
      connectionId,
      captureId,
      family,
      requestKind,
      sequence: sequence += 1_000_000,
      requestXml: "<seed/>",
      status: "complete",
      responseXml,
    });
  }
  const source = new QbdSource({ orgId, connectionId, historyStartDate: "2024-01-01", baseCurrency: "CAD" });
  (source as unknown as { captureId: string }).captureId = captureId;
  (source as unknown as { captureReady: boolean }).captureReady = true;
  return source;
}

test("a nonzero ledger row without a TxnID refuses the sync before deletion inference", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const [connection] = await db.insert(schema.connections).values({
    orgId: org.orgId,
    source: "qbd",
    displayName: `QBD TxnID test ${Date.now()}`,
    authKind: "token",
    status: "active",
    config: { historyStartDate: "2024-01-01", region: "CA", baseCurrency: "CAD" },
    secrets: sealJson({ webConnectorPassword: "txnid-test-password-123" }),
  }).returning({ id: schema.connections.id });
  assert.ok(connection);
  try {
    const source = await seedLedger(org.orgId, connection.id, [
      { date: "1/15/2024", account: "Cash", debit: "25.00", credit: "" },
    ]);
    await assert.rejects(
      () => source.monthlyActivity(),
      /GeneralLedger response for month 2024-01 contains a nonzero row without a TxnID \(row 1, account "Cash"/,
    );

    // A zero-amount TxnID-less row (heading/blank) carries no balance and is
    // still skipped.
    const zeroed = await seedLedger(org.orgId, connection.id, [
      { date: "1/15/2024", account: "Cash", debit: "", credit: "" },
    ]);
    assert.deepEqual(await zeroed.monthlyActivity(), []);
  } finally {
    await db.execute(sql`delete from qbd_requests where connection_id = ${connection.id}`);
    await db.execute(sql`delete from qbd_captures where connection_id = ${connection.id}`);
    await db.execute(sql`delete from connections where id = ${connection.id}`);
    await dropScratchOrg(org.orgId);
  }
});
