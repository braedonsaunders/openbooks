import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "./route.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function post(connectionId: string, body: string): Promise<Response> {
  return POST(new Request(`http://localhost/api/qbd/web-connector/${connectionId}`, {
    method: "POST",
    headers: { "content-type": "text/xml; charset=utf-8" },
    body,
    // @ts-expect-error undici streaming-upload opt-in (ignored for string bodies)
    duplex: "half",
  }), { params: Promise.resolve({ id: connectionId }) });
}

function receiveEnvelope(ticket: string, response: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><receiveResponseXML xmlns="http://developer.intuit.com/"><ticket>${ticket}</ticket><response>${response}</response><hresult></hresult><message></message></receiveResponseXML></soap:Body></soap:Envelope>`;
}

test("a legitimate large receiveResponseXML with a valid ticket still works", { skip: !DB }, async () => {
  const { db, schema } = await import("@openbooks/engine/src/platform/db.ts");
  const { sealJson } = await import("@openbooks/engine/src/platform/secrets.ts");
  const { authenticateWebConnector } = await import("@openbooks/engine/src/qbd/bridge.ts");
  const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
  const { sql } = await import("drizzle-orm");
  const org = await createScratchOrg();
  const password = "soap-gate-test-password-123";
  const [connection] = await db.insert(schema.connections).values({
    orgId: org.orgId,
    source: "qbd",
    displayName: `QBD soap gate test ${Date.now()}`,
    authKind: "token",
    status: "active",
    config: { historyStartDate: "2024-01-01", region: "CA", baseCurrency: "CAD" },
    secrets: sealJson({ webConnectorPassword: password }),
  }).returning({ id: schema.connections.id });
  assert.ok(connection);
  try {
    const auth = await authenticateWebConnector(connection.id, `qbd:${connection.id}`, password);
    assert.ok(auth.ticket);
    // Well past the 64 KiB pre-auth bound, with a live ticket: the endpoint
    // must stream, parse and dispatch it instead of 413ing.
    const big = receiveEnvelope(auth.ticket, "x".repeat(100 * 1024));
    assert.ok(big.length > 64 * 1024);
    const response = await post(connection.id, big);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /receiveResponseXMLResponse/);
    assert.doesNotMatch(text, /soap:Fault/);
  } finally {
    await db.execute(sql`delete from qbd_sessions where connection_id = ${connection.id}`);
    await db.execute(sql`delete from connections where id = ${connection.id}`);
    await dropScratchOrg(org.orgId);
  }
});
