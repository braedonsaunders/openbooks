import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, env, schema } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import {
  acceptWebConnectorResponse,
  authenticateWebConnector,
  closeWebConnectorSession,
  nextWebConnectorRequest,
  prepareCapture,
  recordConnectionError,
  releaseCapture,
  terminateConnectionSessions,
  waitForCapture,
  webConnectorLastError,
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
    assert.match(request, /<CompanyQueryRq requestID="/);
    const sentId = (await db.execute<{ id: string }>(sql`
      select id from qbd_requests where capture_id = ${captureId} and family = 'company'`));
    const response = `<?xml version="1.0"?><QBXML><QBXMLMsgsRs><CompanyQueryRs requestID="${sentId.rows[0]?.id}" statusCode="0" statusSeverity="Info" statusMessage="Status OK"><CompanyRet><CompanyName>Bridge Test</CompanyName></CompanyRet></CompanyQueryRs></QBXMLMsgsRs></QBXML>`;
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

async function createQbdTestConnection(orgId: string): Promise<{ id: string; password: string }> {
  const password = `bridge-test-password-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [connection] = await db.insert(schema.connections).values({
    orgId,
    source: "qbd",
    displayName: `QBD correlation test ${Date.now()}`,
    authKind: "token",
    status: "active",
    config: { historyStartDate: new Date().toISOString().slice(0, 8) + "01", region: "CA", baseCurrency: "CAD" },
    secrets: sealJson({ webConnectorPassword: password }),
  }).returning({ id: schema.connections.id });
  assert.ok(connection);
  return { id: connection.id, password };
}

async function openQbdTestTicket(orgId: string, connectionId: string, password: string): Promise<{ ticket: string; captureId: string }> {
  const captureId = await prepareCapture({
    orgId,
    connectionId,
    historyStartDate: new Date().toISOString().slice(0, 8) + "01",
    since: null,
  });
  const auth = await authenticateWebConnector(connectionId, `qbd:${connectionId}`, password);
  assert.ok(auth.ticket);
  return { ticket: auth.ticket, captureId };
}

function companyResponse(requestId: string): string {
  return `<?xml version="1.0"?><QBXML><QBXMLMsgsRs><CompanyQueryRs requestID="${requestId}" statusCode="0" statusSeverity="Info" statusMessage="Status OK"><CompanyRet><CompanyName>Correlation Test</CompanyName></CompanyRet></CompanyQueryRs></QBXMLMsgsRs></QBXML>`;
}

test("a sendRequestXML retry re-sends the outstanding request instead of claiming a second one", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  try {
    const { ticket, captureId } = await openQbdTestTicket(orgId, connection.id, connection.password);
    const first = await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
    assert.match(first, /<CompanyQueryRq requestID="/);
    // The retry arrives before any response was submitted: it must observe
    // the same bytes, not a second request.
    const retry = await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
    assert.equal(retry, first);
    const inflight = (await db.execute<{ sent: number; queued: number }>(sql`
      select count(*) filter (where status = 'sent')::int as sent,
             count(*) filter (where status = 'queued')::int as queued
        from qbd_requests where capture_id = ${captureId} and session_id = ${ticket}`));
    assert.equal(inflight.rows[0]?.sent, 1);
    const total = (await db.execute<{ queued: number }>(sql`
      select count(*) filter (where status = 'queued')::int as queued
        from qbd_requests where capture_id = ${captureId}`));
    const plan = (await db.execute<{ total: number }>(sql`select count(*)::int as total from qbd_requests where capture_id = ${captureId}`));
    assert.equal(total.rows[0]?.queued, (plan.rows[0]?.total ?? 1) - 1);
    await closeWebConnectorSession(ticket);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

test("a correlated response is stored under its own request and the next send advances", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  try {
    const { ticket, captureId } = await openQbdTestTicket(orgId, connection.id, connection.password);
    const first = await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
    await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
    const sentA = (await db.execute<{ id: string }>(sql`
      select id from qbd_requests where capture_id = ${captureId} and session_id = ${ticket} and status = 'sent'`));
    const idA = sentA.rows[0]?.id;
    assert.ok(idA);
    const progress = await acceptWebConnectorResponse(ticket, companyResponse(idA), "", "");
    assert.ok(progress > 0 && progress < 100);
    // The response landed on A; the next send claims B with its own identity.
    const second = await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
    assert.notEqual(second, first);
    const rows = (await db.execute<{ id: string; family: string; status: string; xml: string | null }>(sql`
      select id, family, status, response_xml as xml from qbd_requests
       where capture_id = ${captureId} and family in ('company', 'preferences') order by sequence`));
    assert.equal(rows.rows[0]?.status, "complete");
    assert.equal(rows.rows[0]?.xml, companyResponse(idA));
    assert.equal(rows.rows[1]?.status, "sent");
    assert.equal(rows.rows[1]?.xml, null);
    assert.match(second, new RegExp(`requestID="${rows.rows[1]?.id}"`));
    await closeWebConnectorSession(ticket);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

test("a response for another request is refused and leaves the outstanding request in flight", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  try {
    const { ticket, captureId } = await openQbdTestTicket(orgId, connection.id, connection.password);
    await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
    const sentA = (await db.execute<{ id: string }>(sql`
      select id from qbd_requests where capture_id = ${captureId} and session_id = ${ticket} and status = 'sent'`));
    const idA = sentA.rows[0]?.id;
    assert.ok(idA);
    // A response stamped for a request that was never sent on this ticket.
    const refused = await acceptWebConnectorResponse(ticket, companyResponse("99999999-9999-4999-8999-999999999999"), "", "");
    assert.equal(refused, -101);
    const state = (await db.execute<{ status: string; xml: string | null }>(sql`
      select status, response_xml as xml from qbd_requests where id = ${idA}`));
    assert.equal(state.rows[0]?.status, "sent");
    assert.equal(state.rows[0]?.xml, null);
    const capture = (await db.execute<{ status: string }>(sql`select status from qbd_captures where id = ${captureId}`));
    assert.equal(capture.rows[0]?.status, "running");
    const session = (await db.execute<{ error: string | null }>(sql`select last_error as error from qbd_sessions where id = ${ticket}`));
    assert.match(session.rows[0]?.error ?? "", /requestID/);
    assert.match(session.rows[0]?.error ?? "", /sendRequestXML/);
    // The genuine response still completes the outstanding request.
    const progress = await acceptWebConnectorResponse(ticket, companyResponse(idA), "", "");
    assert.ok(progress > 0 && progress < 100);
    await closeWebConnectorSession(ticket);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

test("an uncorrelated response and a wrong-type response are refused", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  try {
    const { ticket, captureId } = await openQbdTestTicket(orgId, connection.id, connection.password);
    await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
    const sentA = (await db.execute<{ id: string }>(sql`
      select id from qbd_requests where capture_id = ${captureId} and session_id = ${ticket} and status = 'sent'`));
    const idA = sentA.rows[0]?.id;
    assert.ok(idA);
    // No requestID at all while the outstanding request carries one.
    const bare = `<?xml version="1.0"?><QBXML><QBXMLMsgsRs><CompanyQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK"><CompanyRet/></CompanyQueryRs></QBXMLMsgsRs></QBXML>`;
    assert.equal(await acceptWebConnectorResponse(ticket, bare, "", ""), -101);
    // Right requestID, wrong response family.
    const wrongKind = `<?xml version="1.0"?><QBXML><QBXMLMsgsRs><AccountQueryRs requestID="${idA}" statusCode="0" statusSeverity="Info" statusMessage="Status OK"><AccountRet/></AccountQueryRs></QBXMLMsgsRs></QBXML>`;
    assert.equal(await acceptWebConnectorResponse(ticket, wrongKind, "", ""), -101);
    const session = (await db.execute<{ error: string | null }>(sql`select last_error as error from qbd_sessions where id = ${ticket}`));
    assert.match(session.rows[0]?.error ?? "", /AccountQueryRs/);
    assert.match(session.rows[0]?.error ?? "", /CompanyQueryRs/);
    const state = (await db.execute<{ status: string; xml: string | null }>(sql`
      select status, response_xml as xml from qbd_requests where id = ${idA}`));
    assert.equal(state.rows[0]?.status, "sent");
    assert.equal(state.rows[0]?.xml, null);
    await closeWebConnectorSession(ticket);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

test("a replayed response for a completed request is acknowledged, not errored", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  try {
    const { ticket, captureId } = await openQbdTestTicket(orgId, connection.id, connection.password);
    await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
    const sentA = (await db.execute<{ id: string }>(sql`
      select id from qbd_requests where capture_id = ${captureId} and session_id = ${ticket} and status = 'sent'`));
    const idA = sentA.rows[0]?.id;
    assert.ok(idA);
    const progress = await acceptWebConnectorResponse(ticket, companyResponse(idA), "", "");
    // The client never saw the success reply and submits the same response
    // again before asking for the next request: same progress, no error.
    const replay = await acceptWebConnectorResponse(ticket, companyResponse(idA), "", "");
    assert.equal(replay, progress);
    assert.ok(replay > 0 && replay < 100);
    const stored = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from qbd_requests where capture_id = ${captureId} and status = 'complete'`));
    assert.equal(stored.rows[0]?.n, 1);
    await closeWebConnectorSession(ticket);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function ticketLockKey(ticket: string): string {
  return `qbd-web-connector:${ticket}`;
}

/**
 * Park a transaction holding the ticket advisory lock, so a send started
 * afterwards blocks inside its locked section after completing its
 * pre-transaction session lookup. Models the race window deterministically:
 * whatever runs while the holder is parked commits between the send's lookup
 * and its claim.
 */
async function holdTicketLock(ticket: string): Promise<{ release: () => void; done: Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let acquired = false;
  const done = db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ticketLockKey(ticket)}, 0))`);
    acquired = true;
    await gate;
  }).then(() => undefined, (error: unknown) => { throw error; });
  for (let i = 0; i < 200 && !acquired; i += 1) await sleep(25);
  assert.ok(acquired, "the lock holder must hold the ticket lock before the race starts");
  return { release, done };
}

async function sentOnTicket(ticket: string): Promise<number> {
  const result = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from qbd_requests where session_id = ${ticket} and status = 'sent'`));
  return result.rows[0]?.n ?? -1;
}

test("a close racing a send strands no request 'sent' on the closed ticket", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  const meta = { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 };
  try {
    const { ticket } = await openQbdTestTicket(orgId, connection.id, connection.password);
    const holder = await holdTicketLock(ticket);
    let sendXml = "<unresolved>";
    try {
      const sendPromise = nextWebConnectorRequest(ticket, meta);
      // Let the send finish its 'open' lookup and block on the ticket lock.
      await sleep(500);
      const closePromise = closeWebConnectorSession(ticket);
      // Let the close reach the ticket lock too (pre-fix it never takes one
      // and commits immediately while the send is parked).
      await sleep(500);
      holder.release();
      const [send, closeMsg] = await Promise.all([sendPromise, closePromise]);
      sendXml = send;
      assert.match(closeMsg, /closed/);
    } finally {
      holder.release();
      await holder.done;
    }
    void sendXml; // either order is legal; only the end state is asserted
    const status = (await db.execute<{ status: string }>(sql`select status from qbd_sessions where id = ${ticket}`));
    assert.equal(status.rows[0]?.status, "closed");
    assert.equal(await sentOnTicket(ticket), 0);
    // The queued request was re-queued, never stranded: the next session
    // claims it normally.
    const auth = await authenticateWebConnector(connection.id, `qbd:${connection.id}`, connection.password);
    assert.ok(auth.ticket);
    const retry = await nextWebConnectorRequest(auth.ticket, meta);
    assert.match(retry, /<CompanyQueryRq requestID="/);
    await closeWebConnectorSession(auth.ticket);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

test("a connection error racing a send strands no request 'sent' on the errored ticket", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  const meta = { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 };
  try {
    const { ticket } = await openQbdTestTicket(orgId, connection.id, connection.password);
    const holder = await holdTicketLock(ticket);
    try {
      const sendPromise = nextWebConnectorRequest(ticket, meta);
      await sleep(500);
      const errorPromise = recordConnectionError(ticket, "0x80040400", "race-induced connection error");
      await sleep(500);
      holder.release();
      await Promise.all([sendPromise, errorPromise]);
    } finally {
      holder.release();
      await holder.done;
    }
    const session = (await db.execute<{ status: string; error: string | null }>(sql`
      select status, last_error as error from qbd_sessions where id = ${ticket}`));
    assert.equal(session.rows[0]?.status, "error");
    assert.match(session.rows[0]?.error ?? "", /race-induced connection error/);
    assert.equal(await sentOnTicket(ticket), 0);
    const auth = await authenticateWebConnector(connection.id, `qbd:${connection.id}`, connection.password);
    assert.ok(auth.ticket);
    const retry = await nextWebConnectorRequest(auth.ticket, meta);
    assert.match(retry, /<CompanyQueryRq requestID="/);
    await closeWebConnectorSession(auth.ticket);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

test("a send that read 'open' before a close commits claims nothing and records the reason", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  const meta = { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 };
  try {
    const { ticket } = await openQbdTestTicket(orgId, connection.id, connection.password);
    const holder = await holdTicketLock(ticket);
    let sendXml = "<unresolved>";
    try {
      const sendPromise = nextWebConnectorRequest(ticket, meta);
      await sleep(500);
      // Commit the pre-fix close shape (no ticket lock) while the send is
      // parked: status closed between the send's lookup and its claim.
      await db.execute(sql`update qbd_sessions set status = 'closed', closed_at = now(), last_seen_at = now() where id = ${ticket} and org_id = ${orgId}`);
      holder.release();
      sendXml = await sendPromise;
    } finally {
      holder.release();
      await holder.done;
    }
    assert.equal(sendXml, "");
    assert.equal(await sentOnTicket(ticket), 0);
    const session = (await db.execute<{ error: string | null }>(sql`select last_error as error from qbd_sessions where id = ${ticket}`));
    assert.match(session.rows[0]?.error ?? "", /no longer open/);
    // The closed ticket keeps answering like a closed ticket, with the reason
    // available through getLastError.
    assert.equal(await nextWebConnectorRequest(ticket, meta), "");
    assert.equal(await acceptWebConnectorResponse(ticket, companyResponse("00000000-0000-4000-8000-000000000000"), "", ""), -101);
    assert.match(await webConnectorLastError(ticket), /no longer open/);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

test("a same-id replay with changed bytes is refused and keeps the stored payload", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  try {
    const { ticket, captureId } = await openQbdTestTicket(orgId, connection.id, connection.password);
    await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
    const sentA = (await db.execute<{ id: string }>(sql`
      select id from qbd_requests where capture_id = ${captureId} and session_id = ${ticket} and status = 'sent'`));
    const idA = sentA.rows[0]?.id;
    assert.ok(idA);
    const original = companyResponse(idA);
    const progress = await acceptWebConnectorResponse(ticket, original, "", "");
    assert.ok(progress > 0 && progress < 100);
    // Same requestID but different payload bytes: not a replay of what was
    // stored, so it must be refused visibly — never acknowledged as success.
    const mutated = original.replace("Correlation Test", "Correlation Test MUTATED");
    assert.notEqual(mutated, original);
    assert.equal(await acceptWebConnectorResponse(ticket, mutated, "", ""), -101);
    assert.match(await webConnectorLastError(ticket), /a different response for an already-completed request/);
    const stored = (await db.execute<{ status: string; xml: string | null }>(sql`
      select status, response_xml as xml from qbd_requests where id = ${idA}`));
    assert.equal(stored.rows[0]?.status, "complete");
    assert.equal(stored.rows[0]?.xml, original);
    // The refusal changed nothing: the genuine bytes still acknowledge.
    assert.equal(await acceptWebConnectorResponse(ticket, original, "", ""), progress);
    await closeWebConnectorSession(ticket);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

test("a wildcard requestID matches no completed request", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  try {
    const { ticket, captureId } = await openQbdTestTicket(orgId, connection.id, connection.password);
    await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
    const sentA = (await db.execute<{ id: string }>(sql`
      select id from qbd_requests where capture_id = ${captureId} and session_id = ${ticket} and status = 'sent'`));
    const idA = sentA.rows[0]?.id;
    assert.ok(idA);
    const original = companyResponse(idA);
    const progress = await acceptWebConnectorResponse(ticket, original, "", "");
    assert.ok(progress > 0 && progress < 100);
    // '%' and '_' are LIKE wildcards, not request ids: neither may match the
    // completed request the way the old substring lookup did.
    for (const wildcard of ["%", "_"]) {
      assert.equal(await acceptWebConnectorResponse(ticket, companyResponse(wildcard), "", ""), -101);
    }
    const stored = (await db.execute<{ status: string; xml: string | null; n: number }>(sql`
      select status, response_xml as xml,
             (select count(*)::int from qbd_requests where capture_id = ${captureId} and status = 'complete') as n
        from qbd_requests where id = ${idA}`));
    assert.equal(stored.rows[0]?.status, "complete");
    assert.equal(stored.rows[0]?.xml, original);
    assert.equal(stored.rows[0]?.n, 1);
    await closeWebConnectorSession(ticket);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

test("a malformed iterator count fails the capture with a named error and stores nothing", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  try {
    const { ticket, captureId } = await openQbdTestTicket(orgId, connection.id, connection.password);
    await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
    const sentA = (await db.execute<{ id: string }>(sql`
      select id from qbd_requests where capture_id = ${captureId} and session_id = ${ticket} and status = 'sent'`));
    const idA = sentA.rows[0]?.id;
    assert.ok(idA);
    // A statusCode=0 page whose remaining count is unreadable must not read
    // as the last page: the capture fails instead of importing pages missing.
    const bad = companyResponse(idA).replace(
      'statusCode="0"',
      'statusCode="0" iteratorRemainingCount="oops" iteratorID="it-1"',
    );
    assert.equal(await acceptWebConnectorResponse(ticket, bad, "", ""), -101);
    const request = (await db.execute<{ status: string; xml: string | null }>(sql`
      select status, response_xml as xml from qbd_requests where id = ${idA}`));
    assert.equal(request.rows[0]?.status, "failed");
    assert.equal(request.rows[0]?.xml, null);
    const capture = (await db.execute<{ status: string; error: string | null }>(sql`
      select status, error_message as error from qbd_captures where id = ${captureId}`));
    assert.equal(capture.rows[0]?.status, "failed");
    assert.match(capture.rows[0]?.error ?? "", /invalid iteratorRemainingCount "oops" for CompanyQuery/);
    const completed = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from qbd_captures where connection_id = ${connection.id} and status = 'complete'`));
    assert.equal(completed.rows[0]?.n, 0);
    assert.match(await webConnectorLastError(ticket), /invalid iteratorRemainingCount "oops" for CompanyQuery/);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

test("a blank or whitespace statusCode fails the capture with a named error", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  for (const badStatus of ["", " "]) {
    const connection = await createQbdTestConnection(orgId);
    try {
      const { ticket, captureId } = await openQbdTestTicket(orgId, connection.id, connection.password);
      await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
      const sentA = (await db.execute<{ id: string }>(sql`
        select id from qbd_requests where capture_id = ${captureId} and session_id = ${ticket} and status = 'sent'`));
      const idA = sentA.rows[0]?.id;
      assert.ok(idA);
      // A blank status previously coerced to 0 (SUCCESS) and could store a
      // response for a capture that never succeeded.
      const bad = companyResponse(idA).replace('statusCode="0"', `statusCode="${badStatus}"`);
      assert.equal(await acceptWebConnectorResponse(ticket, bad, "", ""), -101);
      const request = (await db.execute<{ status: string; xml: string | null }>(sql`
        select status, response_xml as xml from qbd_requests where id = ${idA}`));
      assert.equal(request.rows[0]?.status, "failed");
      assert.equal(request.rows[0]?.xml, null);
      const capture = (await db.execute<{ status: string; error: string | null }>(sql`
        select status, error_message as error from qbd_captures where id = ${captureId}`));
      assert.equal(capture.rows[0]?.status, "failed");
      assert.match(capture.rows[0]?.error ?? "", new RegExp(`invalid statusCode ${JSON.stringify(badStatus)} for CompanyQuery`));
      const completed = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from qbd_captures where connection_id = ${connection.id} and status = 'complete'`));
      assert.equal(completed.rows[0]?.n, 0);
    } finally {
      await db.execute(sql`delete from connections where id = ${connection.id}`);
    }
  }
});


test("a truncated ledger response fails the capture instead of recording an empty month", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  try {
    const startMonth = new Date().toISOString().slice(0, 8) + "01";
    const captureId = await prepareCapture({ orgId, connectionId: connection.id, historyStartDate: startMonth, since: null });
    const auth = await authenticateWebConnector(connection.id, `qbd:${connection.id}`, connection.password);
    assert.ok(auth.ticket);
    const ledger = (await db.execute<{ id: string; family: string }>(sql`
      select id, family from qbd_requests where capture_id = ${captureId} and family like 'ledger:%' order by sequence limit 1`));
    const ledgerId = ledger.rows[0]?.id;
    const family = ledger.rows[0]?.family;
    assert.ok(ledgerId && family);
    // Mark the outstanding ledger request sent without claiming through the
    // queue, so the test submits the truncated response directly against it.
    await db.execute(sql`update qbd_requests set status = 'sent', session_id = ${auth.ticket}, sent_at = now() where id = ${ledgerId}`);

    // statusCode=0 but no ReportRet: a truncated response, never an empty
    // month. The capture must fail by family — nothing is stored complete,
    // so a later sync cannot reverse prior documents as source deletions.
    const truncated = `<?xml version="1.0"?><QBXML><QBXMLMsgsRs><GeneralDetailReportQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK"></GeneralDetailReportQueryRs></QBXMLMsgsRs></QBXML>`;
    assert.equal(await acceptWebConnectorResponse(auth.ticket, truncated, "", ""), -101);
    const capture = (await db.execute<{ status: string; error: string | null }>(sql`
      select status, error_message as error from qbd_captures where id = ${captureId}`));
    assert.equal(capture.rows[0]?.status, "failed");
    assert.match(capture.rows[0]?.error ?? "", new RegExp(`GeneralLedger capture for ${family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*carries no report`));
    assert.match(await webConnectorLastError(auth.ticket), /carries no report/);
    await assert.rejects(() => waitForCapture(orgId, captureId), /carries no report/);
    const stored = (await db.execute<{ complete: number }>(sql`
      select count(*)::int as complete from qbd_requests where capture_id = ${captureId} and status = 'complete'`));
    assert.equal(stored.rows[0]?.complete, 0);

    // A present-but-empty report month (ReportRet + column descriptors, zero
    // data rows) is still accepted and stored complete.
    const captureId2 = await prepareCapture({ orgId, connectionId: connection.id, historyStartDate: startMonth, since: null });
    const ledger2 = (await db.execute<{ id: string }>(sql`
      select id from qbd_requests where capture_id = ${captureId2} and family like 'ledger:%' order by sequence limit 1`));
    assert.ok(ledger2.rows[0]?.id);
    await db.execute(sql`update qbd_requests set status = 'sent', session_id = ${auth.ticket}, sent_at = now() where id = ${ledger2.rows[0].id}`);
    const emptyMonth = `<?xml version="1.0"?><QBXML><QBXMLMsgsRs><GeneralDetailReportQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK"><ReportRet><ColDesc colID="1"><ColType>TxnID</ColType></ColDesc><ColDesc colID="2"><ColType>Account</ColType></ColDesc><ReportData></ReportData></ReportRet></GeneralDetailReportQueryRs></QBXMLMsgsRs></QBXML>`;
    const progress = await acceptWebConnectorResponse(auth.ticket, emptyMonth, "", "");
    assert.ok(progress > 0 && progress < 100, `empty report month is stored, got progress ${progress}`);
    await closeWebConnectorSession(auth.ticket);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

test("pausing between auth and send stops the ticket from claiming or submitting", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  try {
    const { ticket, captureId } = await openQbdTestTicket(orgId, connection.id, connection.password);
    const first = await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
    assert.match(first, /<CompanyQueryRq requestID="/);

    // The owner pauses between auth and send. With the session still open,
    // the in-lock re-read must observe the CURRENT connection status and
    // claim nothing — the pause commits after the pre-transaction lookup.
    await db.execute(sql`update connections set status = 'paused' where id = ${connection.id}`);
    assert.equal(await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 }), "");
    assert.match(await webConnectorLastError(ticket), /connection is paused/);

    // Terminating the paused connection closes the session and re-queues the
    // in-flight request, same shape as close.
    assert.equal(await terminateConnectionSessions(orgId, connection.id), 1);
    const session = (await db.execute<{ status: string }>(sql`select status from qbd_sessions where id = ${ticket}`));
    assert.equal(session.rows[0]?.status, "closed");
    const requeued = (await db.execute<{ status: string; session: string | null }>(sql`
      select status, session_id as session from qbd_requests where capture_id = ${captureId} and family = 'company'`));
    assert.equal(requeued.rows[0]?.status, "queued");
    assert.equal(requeued.rows[0]?.session, null);

    // The pre-pause ticket claims nothing and submits nothing afterwards.
    assert.equal(await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 }), "");
    assert.match(await webConnectorLastError(ticket), /paused/);
    const companyId = (await db.execute<{ id: string }>(sql`
      select id from qbd_requests where capture_id = ${captureId} and family = 'company'`));
    await db.execute(sql`update qbd_requests set status = 'sent', session_id = ${ticket}, sent_at = now() where id = ${companyId.rows[0]?.id}`);
    const unpaused = `<?xml version="1.0"?><QBXML><QBXMLMsgsRs><CompanyQueryRs statusCode="0" statusSeverity="Info" statusMessage="Status OK"><CompanyRet><CompanyName>Pause Test</CompanyName></CompanyRet></CompanyQueryRs></QBXMLMsgsRs></QBXML>`;
    assert.equal(await acceptWebConnectorResponse(ticket, unpaused, "", ""), -101);
    const untouched = (await db.execute<{ status: string; xml: string | null }>(sql`
      select status, response_xml as xml from qbd_requests where id = ${companyId.rows[0]?.id}`));
    assert.equal(untouched.rows[0]?.status, "sent");
    assert.equal(untouched.rows[0]?.xml, null);

    // Re-terminating with no open session touches nothing but still
    // re-queues the request stranded on the dead ticket.
    assert.equal(await terminateConnectionSessions(orgId, connection.id), 0);

    // Resume: a fresh ticket claims the re-queued work again.
    await db.execute(sql`update connections set status = 'active' where id = ${connection.id}`);
    const reauth = await authenticateWebConnector(connection.id, `qbd:${connection.id}`, connection.password);
    assert.ok(reauth.ticket);
    const reclaimed = await nextWebConnectorRequest(reauth.ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
    assert.match(reclaimed, /<CompanyQueryRq requestID="/);
    await closeWebConnectorSession(reauth.ticket);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

test("authenticate does not reclaim an aged request whose session is still open", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  try {
    const { ticket } = await openQbdTestTicket(orgId, connection.id, connection.password);
    await nextWebConnectorRequest(ticket, { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 });
    const sentA = (await db.execute<{ id: string }>(sql`
      select id from qbd_requests where session_id = ${ticket} and status = 'sent'`));
    const idA = sentA.rows[0]?.id;
    assert.ok(idA);
    // A large QuickBooks report can legitimately take more than 10 minutes:
    // age the request past the reclaim window while its session is open.
    await db.execute(sql`update qbd_requests set sent_at = now() - interval '11 minutes' where id = ${idA}`);
    // Another poll authenticates meanwhile. The aged request still belongs to
    // the open session, so it must not be stripped from ticket A.
    const other = await authenticateWebConnector(connection.id, `qbd:${connection.id}`, connection.password);
    assert.ok(other.ticket);
    const kept = (await db.execute<{ status: string; session: string | null }>(sql`
      select status, session_id as session from qbd_requests where id = ${idA}`));
    assert.equal(kept.rows[0]?.status, "sent");
    assert.equal(kept.rows[0]?.session, ticket);
    // A's late response for the request it still owns is accepted, not -101.
    const progress = await acceptWebConnectorResponse(ticket, companyResponse(idA), "", "");
    assert.ok(progress > 0 && progress < 100, `late response on an open session is accepted, got ${progress}`);
    await closeWebConnectorSession(ticket);
    await closeWebConnectorSession(other.ticket);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

test("after the owning ticket expires, a new session reclaims the aged request exactly once", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  const meta = { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 };
  try {
    const { ticket } = await openQbdTestTicket(orgId, connection.id, connection.password);
    await nextWebConnectorRequest(ticket, meta);
    const sentA = (await db.execute<{ id: string }>(sql`
      select id from qbd_requests where session_id = ${ticket} and status = 'sent'`));
    const idA = sentA.rows[0]?.id;
    assert.ok(idA);
    await db.execute(sql`update qbd_requests set sent_at = now() - interval '11 minutes' where id = ${idA}`);
    // The owner can no longer answer: its ticket expired (close would have
    // re-queued through its own path, so expiry isolates the auth reclaim).
    await db.execute(sql`update qbd_sessions set expires_at = now() - interval '1 minute' where id = ${ticket}`);
    const reclaimed = (await authenticateWebConnector(connection.id, `qbd:${connection.id}`, connection.password));
    assert.ok(reclaimed.ticket);
    const queued = (await db.execute<{ status: string; session: string | null }>(sql`
      select status, session_id as session from qbd_requests where id = ${idA}`));
    assert.equal(queued.rows[0]?.status, "queued");
    assert.equal(queued.rows[0]?.session, null);
    // The new session claims the reclaimed request with its correlation
    // identity intact, and a further authenticate leaves it alone: the
    // reclaim happened exactly once.
    const retry = await nextWebConnectorRequest(reclaimed.ticket, meta);
    assert.match(retry, new RegExp(`requestID="${idA}"`));
    const later = await authenticateWebConnector(connection.id, `qbd:${connection.id}`, connection.password);
    assert.ok(later.ticket);
    const held = (await db.execute<{ status: string; session: string | null }>(sql`
      select status, session_id as session from qbd_requests where id = ${idA}`));
    assert.equal(held.rows[0]?.status, "sent");
    assert.equal(held.rows[0]?.session, reclaimed.ticket);
    await closeWebConnectorSession(reclaimed.ticket);
    await closeWebConnectorSession(later.ticket);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

test("a concurrent authenticate and accept on an aged request serialize under the ticket lock", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  const meta = { country: "CA", qbxmlMajor: 17, qbxmlMinor: 0 };
  try {
    const { ticket } = await openQbdTestTicket(orgId, connection.id, connection.password);
    await nextWebConnectorRequest(ticket, meta);
    const sentA = (await db.execute<{ id: string }>(sql`
      select id from qbd_requests where session_id = ${ticket} and status = 'sent'`));
    const idA = sentA.rows[0]?.id;
    assert.ok(idA);
    await db.execute(sql`update qbd_requests set sent_at = now() - interval '11 minutes' where id = ${idA}`);
    const holder = await holdTicketLock(ticket);
    try {
      // The accept arrives first and parks on the ticket lock; the
      // authenticate must queue behind it on the same lock instead of
      // stealing the request out from under the response.
      const acceptPromise = acceptWebConnectorResponse(ticket, companyResponse(idA), "", "");
      await sleep(500);
      const authPromise = authenticateWebConnector(connection.id, `qbd:${connection.id}`, connection.password);
      await sleep(500);
      holder.release();
      const [progress, other] = await Promise.all([acceptPromise, authPromise]);
      assert.ok(other.ticket);
      assert.ok(progress > 0 && progress < 100, `racy accept still stores its response, got ${progress}`);
    } finally {
      holder.release();
      await holder.done;
    }
    // Whichever waiter won the lock, the end state is the same: the valid
    // response was stored under the session that owned the request, and the
    // request was never re-queued for a duplicate execution.
    const stored = (await db.execute<{ status: string; session: string | null; xml: string | null }>(sql`
      select status, session_id as session, response_xml as xml from qbd_requests where id = ${idA}`));
    assert.equal(stored.rows[0]?.status, "complete");
    assert.equal(stored.rows[0]?.session, ticket);
    assert.equal(stored.rows[0]?.xml, companyResponse(idA));
    await closeWebConnectorSession(ticket);
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});

test("storage refuses a second in-flight request on one ticket", { skip: !DB }, async () => {
  const orgs = (await db.execute<{ id: string }>(sql`select id from orgs order by created_at limit 1`));
  const orgId = orgs.rows[0]?.id;
  if (!orgId) return;
  const connection = await createQbdTestConnection(orgId);
  try {
    const { ticket, captureId } = await openQbdTestTicket(orgId, connection.id, connection.password);
    await db.execute(sql`
      insert into qbd_requests (org_id, connection_id, capture_id, family, request_kind, sequence, request_xml, status, session_id, sent_at)
      values (${orgId}, ${connection.id}, ${captureId}, 'company', 'CompanyQuery', 999001, '<QBXML/>', 'sent', ${ticket}, now())`);
    await assert.rejects(
      db.execute(sql`
        insert into qbd_requests (org_id, connection_id, capture_id, family, request_kind, sequence, request_xml, status, session_id, sent_at)
        values (${orgId}, ${connection.id}, ${captureId}, 'company', 'CompanyQuery', 999002, '<QBXML/>', 'sent', ${ticket}, now())`),
      (error: unknown) =>
        (error as { code?: string }).code === "23505"
        || (error as { cause?: { code?: string } }).cause?.code === "23505",
      "the second in-flight claim must fail on qbd_requests_one_sent_per_session",
    );
  } finally {
    await db.execute(sql`delete from connections where id = ${connection.id}`);
  }
});
