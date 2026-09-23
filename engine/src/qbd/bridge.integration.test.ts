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
