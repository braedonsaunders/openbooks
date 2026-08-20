import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, env, schema } from "../db.ts";
import { sealJson } from "../secrets.ts";
import {
  acceptWebConnectorResponse,
  authenticateWebConnector,
  closeWebConnectorSession,
  nextWebConnectorRequest,
  prepareCapture,
  releaseCapture,
} from "./bridge.ts";

const DB = Boolean(env.OPENBOOKS_DB_URL && env.OPENBOOKS_DATA_KEY);

test("Web Connector bridge authenticates, atomically claims, hashes, and releases a response", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const password = "bridge-test-password-123";
  const [connection] = await db.insert(schema.connections).values({
    orgId,
    source: "qbd",
    displayName: `QBD bridge test ${Date.now()}`,
    authKind: "token",
    status: "active",
    config: { historyStartDate: new Date().toISOString().slice(0, 8) + "01", region: "CA", baseCurrency: "CAD" },
    secrets: sealJson({ webConnectorPassword: password }),
  }).returning({ id: schema.connections.id });
  assert.ok(connection);

  try {
    const captureId = await prepareCapture({
      orgId,
      connectionId: connection.id,
      historyStartDate: new Date().toISOString().slice(0, 8) + "01",
      since: null,
    });
    const bad = await authenticateWebConnector(connection.id, `qbd:${connection.id}`, "wrong");
    assert.deepEqual(bad, { ticket: "", companyFile: "nvu" });
    const auth = await authenticateWebConnector(connection.id, `qbd:${connection.id}`, password);
    assert.ok(auth.ticket);
    assert.equal(auth.companyFile, "");

    const request = await nextWebConnectorRequest(auth.ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
    assert.match(request, /<CompanyQueryRq\/>/);
    const response = `<?xml version="1.0"?><QBXML><QBXMLMsgsRs><CompanyQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK"><CompanyRet><CompanyName>Bridge Test</CompanyName></CompanyRet></CompanyQueryRs></QBXMLMsgsRs></QBXML>`;
    const progress = await acceptWebConnectorResponse(auth.ticket, response, "", "");
    assert.ok(progress > 0 && progress < 100);

    const stored = (await db.execute<{ status: string; xml: string | null; hash: string | null }>(sql`
      select status, response_xml as xml, response_sha256 as hash
        from qbd_requests where capture_id = ${captureId} and family = 'company'`));
    assert.equal(stored.rows[0]?.status, "complete");
    assert.equal(stored.rows[0]?.xml, response);
    assert.match(stored.rows[0]?.hash ?? "", /^[0-9a-f]{64}$/);

    await closeWebConnectorSession(auth.ticket);
    await releaseCapture(orgId, captureId);
    const released = (await db.execute<{ xml: string | null }>(sql`select response_xml as xml from qbd_requests where capture_id = ${captureId} and family = 'company'`));
    assert.equal(released.rows[0]?.xml, null);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});
