import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { businessToday } from "../business-date.ts";
import { db, schema, withBypassContext, withOrgContext } from "../db.ts";
import { unsealJson } from "../secrets.ts";
import { buildCapturePlan, continueRequestXml, negotiateQbxmlVersion, responseStatus, type QbdRequestSpec } from "./qbxml.ts";

const CAPTURE_TTL_MS = 12 * 60 * 60 * 1_000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1_000;

interface QbdSecrets { webConnectorPassword: string }
interface QbdConfig { historyStartDate: string; companyFile?: string }

export type CaptureResponse = {
  family: string;
  requestKind: string;
  page: number;
  responseXml: string;
};

export interface QbdAuthResult {
  ticket: string;
  companyFile: string;
}
type PublicConnection = {
  id: string;
  orgId: string;
  config: QbdConfig;
  secrets: string | null;
  status: string;
};

function secureEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

async function publicConnection(connectionId: string): Promise<PublicConnection | null> {
  return withBypassContext(async () => {
    const result = (await db.execute<PublicConnection>(sql`
      select id, org_id as "orgId", config, secrets, status
        from connections where id = ${connectionId} and source = 'qbd' limit 1`));
    return result.rows[0] ?? null;
  });
}

export async function prepareCapture(input: {
  orgId: string;
  connectionId: string;
  historyStartDate: string;
  since: Date | null;
}): Promise<string> {
  return withOrgContext(input.orgId, async () => {
    const now = new Date();
    const through = new Date(`${await businessToday(input.orgId)}T00:00:00.000Z`);
    const plan = buildCapturePlan(input.historyStartDate, through);
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        update qbd_captures set status = 'cancelled', finished_at = now(),
               error_message = 'Superseded by a newer capture', updated_at = now()
         where connection_id = ${input.connectionId} and org_id = ${input.orgId} and status in ('queued', 'running')`);
      await tx.execute(sql`
        update qbd_requests r set status = 'cancelled', updated_at = now()
         where r.connection_id = ${input.connectionId} and r.org_id = ${input.orgId} and r.status in ('queued', 'sent')
           and exists (select 1 from qbd_captures c where c.id = r.capture_id and c.org_id = r.org_id and c.status = 'cancelled')`);
      const [capture] = await tx.insert(schema.qbdCaptures).values({
        orgId: input.orgId,
        connectionId: input.connectionId,
        since: input.since,
        capturedThrough: now,
        expiresAt: new Date(now.getTime() + CAPTURE_TTL_MS),
        progress: { completed: 0, total: plan.length },
      }).returning({ id: schema.qbdCaptures.id });
      if (!capture) throw new Error("failed to create QuickBooks Desktop capture");
      await tx.insert(schema.qbdRequests).values(plan.map((request, index) => ({
        orgId: input.orgId,
        connectionId: input.connectionId,
        captureId: capture.id,
        family: request.family,
        requestKind: request.requestKind,
        sequence: (index + 1) * 1_000_000,
        requestXml: request.requestXml,
      })));
      return capture.id;
    });
  });
}

export async function waitForCapture(orgId: string, captureId: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < CAPTURE_TTL_MS) {
    const state = await withOrgContext(orgId, async () => {
      const capture = (await db.execute<{ status: string; errorMessage: string | null; expiresAt: Date }>(sql`
        select status, error_message as "errorMessage", expires_at as "expiresAt"
          from qbd_captures where id = ${captureId} and org_id = ${orgId} limit 1`));
      return capture.rows[0] ?? null;
    });
    if (!state) throw new Error("QuickBooks Desktop capture disappeared");
    if (state.status === "failed" || state.status === "cancelled") {
      throw new Error(state.errorMessage ?? `QuickBooks Desktop capture ${state.status}`);
    }
    if (state.status === "complete") {
      return;
    }
    if (new Date(state.expiresAt).getTime() <= Date.now()) {
      await withOrgContext(orgId, () => db.transaction(async (tx) => {
        await tx.execute(sql`
          update qbd_captures set status = 'failed', error_message = 'Web Connector capture timed out',
                 finished_at = now(), updated_at = now()
           where id = ${captureId} and org_id = ${orgId} and status in ('queued', 'running')`);
        await tx.execute(sql`
          update qbd_requests set status = 'cancelled', updated_at = now()
           where capture_id = ${captureId} and org_id = ${orgId} and status in ('queued', 'sent')`);
      }));
      throw new Error("QuickBooks Web Connector did not complete the capture before it expired");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("QuickBooks Web Connector capture timed out");
}

export async function releaseCapture(orgId: string, captureId: string): Promise<void> {
  await withOrgContext(orgId, async () => {
    await db.execute(sql`
      update qbd_requests set response_xml = null, updated_at = now()
       where capture_id = ${captureId} and org_id = ${orgId} and response_xml is not null`);
  });
}

/** Worker janitor: enforce raw-response retention even after a hard process exit. */
export async function purgeExpiredQbdBridgeData(): Promise<void> {
  await withBypassContext(async () => db.transaction(async (tx) => {
    await tx.execute(sql`
      update qbd_captures set status = 'failed', error_message = coalesce(error_message, 'Web Connector capture expired'),
             finished_at = coalesce(finished_at, now()), updated_at = now()
       where expires_at < now() and status in ('queued', 'running')`);
    await tx.execute(sql`
      update qbd_requests r set status = 'cancelled', session_id = null, updated_at = now()
       where r.status in ('queued', 'sent')
         and exists (select 1 from qbd_captures c where c.id = r.capture_id and c.org_id = r.org_id and c.expires_at < now())`);
    await tx.execute(sql`
      update qbd_requests r set response_xml = null, updated_at = now()
       where r.response_xml is not null
         and exists (select 1 from qbd_captures c where c.id = r.capture_id and c.org_id = r.org_id and c.expires_at < now())`);
    await tx.execute(sql`delete from qbd_sessions where expires_at < now() - interval '30 days'`);
  }));
}

export async function authenticateWebConnector(connectionId: string, username: string, password: string): Promise<QbdAuthResult> {
  const conn = await publicConnection(connectionId);
  if (!conn || conn.status === "paused") return { ticket: "", companyFile: "nvu" };
  const secret = unsealJson<QbdSecrets>(conn.secrets);
  const expectedUser = `qbd:${connectionId}`;
  if (!secret?.webConnectorPassword || !secureEqual(username, expectedUser) || !secureEqual(password, secret.webConnectorPassword)) {
    return { ticket: "", companyFile: "nvu" };
  }
  return withBypassContext(async () => {
    await db.execute(sql`delete from qbd_sessions where expires_at < now() - interval '30 days'`);
    await db.execute(sql`
      update qbd_requests set status = 'queued', session_id = null, sent_at = null, updated_at = now()
       where connection_id = ${connectionId} and org_id = ${conn.orgId}
         and status = 'sent' and sent_at < now() - interval '10 minutes'`);
    const pending = (await db.execute<{ pending: boolean }>(sql`
      select exists(
        select 1 from qbd_requests r
          join qbd_captures c on c.id = r.capture_id and c.org_id = r.org_id
         where r.connection_id = ${connectionId} and r.org_id = ${conn.orgId} and r.status = 'queued'
           and c.status in ('queued', 'running') and c.expires_at > now()
      ) as pending`));
    const ticket = randomUUID();
    await db.insert(schema.qbdSessions).values({
      id: ticket,
      orgId: conn.orgId,
      connectionId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    return { ticket, companyFile: pending.rows[0]?.pending ? String(conn.config.companyFile ?? "") : "none" };
  });
}
type SessionRow = { id: string; orgId: string; connectionId: string; status: string; expectedRegion: string | null };

async function session(ticket: string): Promise<SessionRow | null> {
  return withBypassContext(async () => {
    const result = (await db.execute<SessionRow>(sql`
      select s.id, s.org_id as "orgId", s.connection_id as "connectionId", s.status,
             c.config->>'region' as "expectedRegion"
        from qbd_sessions s
          join connections c on c.id = s.connection_id and c.org_id = s.org_id
       where s.id = ${ticket} and s.expires_at > now() limit 1`));
    return result.rows[0] ?? null;
  });
}

export async function nextWebConnectorRequest(ticket: string, metadata: {
  companyFile?: string;
  country?: string;
  qbxmlMajor?: number;
  qbxmlMinor?: number;
}): Promise<string> {
  const current = await session(ticket);
  if (!current || current.status !== "open") return "";
  return withBypassContext(async () => db.transaction(async (tx) => {
    if (metadata.country && current.expectedRegion && metadata.country.toUpperCase() !== current.expectedRegion.toUpperCase()) {
      const error = `QuickBooks region ${metadata.country} does not match configured region ${current.expectedRegion}`;
      await tx.execute(sql`update qbd_sessions set status = 'error', last_error = ${error}, closed_at = now(), last_seen_at = now() where id = ${ticket} and org_id = ${current.orgId}`);
      await tx.execute(sql`
        update qbd_captures set status = 'failed', error_message = ${error}, finished_at = now(), updated_at = now()
         where connection_id = ${current.connectionId} and org_id = ${current.orgId} and status in ('queued', 'running')`);
      await tx.execute(sql`
        update qbd_requests r set status = 'cancelled', session_id = null, updated_at = now()
         where r.connection_id = ${current.connectionId} and r.org_id = ${current.orgId} and r.status in ('queued', 'sent')
           and exists (select 1 from qbd_captures c where c.id = r.capture_id and c.org_id = r.org_id and c.status = 'failed')`);
      return "";
    }
    await tx.execute(sql`
      update qbd_sessions set last_seen_at = now(), company_file = coalesce(${metadata.companyFile ?? null}, company_file),
             country = coalesce(${metadata.country ?? null}, country), qbxml_major = coalesce(${metadata.qbxmlMajor ?? null}, qbxml_major),
             qbxml_minor = coalesce(${metadata.qbxmlMinor ?? null}, qbxml_minor)
       where id = ${ticket} and org_id = ${current.orgId}`);
    const result = (await tx.execute<{ requestXml: string; captureId: string }>(sql`
      update qbd_requests set status = 'sent', session_id = ${ticket}, sent_at = now(), updated_at = now()
       where id = (
         select r.id from qbd_requests r
          join qbd_captures c on c.id = r.capture_id and c.org_id = r.org_id
         where r.connection_id = ${current.connectionId} and r.org_id = ${current.orgId} and r.status = 'queued'
           and c.status in ('queued', 'running') and c.expires_at > now()
          order by r.sequence for update of r skip locked limit 1
       ) returning request_xml as "requestXml", capture_id as "captureId"`));
    const request = result.rows[0];
    if (!request) return "";
    await tx.execute(sql`update qbd_captures set status = 'running', updated_at = now() where id = ${request.captureId} and org_id = ${current.orgId} and status = 'queued'`);
    return negotiateQbxmlVersion(request.requestXml, metadata.qbxmlMajor, metadata.qbxmlMinor);
  }));
}

export async function acceptWebConnectorResponse(ticket: string, responseXml: string, hresult: string, message: string): Promise<number> {
  const current = await session(ticket);
  if (!current || current.status !== "open") return -101;
  return withBypassContext(async () => db.transaction(async (tx) => {
    const sent = (await tx.execute<{ id: string; orgId: string; captureId: string; family: string; requestKind: string; sequence: number; page: number; requestXml: string }>(sql`
      select id, org_id as "orgId", capture_id as "captureId", family, request_kind as "requestKind",
             sequence, page, request_xml as "requestXml"
        from qbd_requests where session_id = ${ticket} and org_id = ${current.orgId} and status = 'sent'
       order by sent_at desc limit 1 for update`));
    const request = sent.rows[0];
    if (!request) return -101;
    if (hresult || !responseXml.trim()) {
      const error = [hresult, message].filter(Boolean).join(": ") || "QuickBooks returned an empty response";
      await tx.execute(sql`update qbd_requests set status = 'failed', error_message = ${error}, completed_at = now(), updated_at = now() where id = ${request.id} and org_id = ${request.orgId}`);
      await tx.execute(sql`update qbd_captures set status = 'failed', error_message = ${error}, finished_at = now(), updated_at = now() where id = ${request.captureId} and org_id = ${request.orgId}`);
      await tx.execute(sql`update qbd_requests set status = 'cancelled', updated_at = now() where capture_id = ${request.captureId} and org_id = ${request.orgId} and status in ('queued', 'sent') and id <> ${request.id}`);
      await tx.execute(sql`update qbd_sessions set last_error = ${error}, last_seen_at = now() where id = ${ticket} and org_id = ${current.orgId}`);
      return -101;
    }
    let status: ReturnType<typeof responseStatus>;
    try {
      status = responseStatus(responseXml);
    } catch (error) {
      status = { code: -1, severity: "Error", message: (error as Error).message, iteratorId: null, iteratorRemaining: 0 };
    }
    if (status.code !== 0) {
      const error = `QuickBooks ${request.requestKind} failed (${status.code}): ${status.message}`;
      await tx.execute(sql`update qbd_requests set status = 'failed', error_message = ${error}, completed_at = now(), updated_at = now() where id = ${request.id} and org_id = ${request.orgId}`);
      await tx.execute(sql`update qbd_captures set status = 'failed', error_message = ${error}, finished_at = now(), updated_at = now() where id = ${request.captureId} and org_id = ${request.orgId}`);
      await tx.execute(sql`update qbd_requests set status = 'cancelled', updated_at = now() where capture_id = ${request.captureId} and org_id = ${request.orgId} and status in ('queued', 'sent') and id <> ${request.id}`);
      await tx.execute(sql`update qbd_sessions set last_error = ${error}, last_seen_at = now() where id = ${ticket} and org_id = ${current.orgId}`);
      return -101;
    }
    const hash = createHash("sha256").update(responseXml).digest("hex");
    await tx.execute(sql`
      update qbd_requests set status = 'complete', response_xml = ${responseXml}, response_sha256 = ${hash},
             completed_at = now(), updated_at = now() where id = ${request.id} and org_id = ${request.orgId}`);
    if (status.iteratorRemaining > 0) {
      if (!status.iteratorId) throw new Error("QuickBooks iterator response omitted iteratorID");
      const next: QbdRequestSpec = {
        family: request.family,
        requestKind: request.requestKind,
        requestXml: continueRequestXml(request.requestXml, status.iteratorId),
      };
      await tx.insert(schema.qbdRequests).values({
        orgId: request.orgId,
        connectionId: current.connectionId,
        captureId: request.captureId,
        family: next.family,
        requestKind: next.requestKind,
        sequence: request.sequence + 1,
        page: request.page + 1,
        requestXml: next.requestXml,
      });
    }
    const counts = (await tx.execute<{ complete: number; remaining: number; total: number }>(sql`
      select count(*) filter (where status = 'complete')::int as complete,
             count(*) filter (where status in ('queued', 'sent'))::int as remaining,
             count(*)::int as total
        from qbd_requests where capture_id = ${request.captureId} and org_id = ${request.orgId}`));
    const count = counts.rows[0] ?? { complete: 0, remaining: 1, total: 1 };
    const complete = count.remaining === 0;
    await tx.execute(sql`
      update qbd_captures set status = ${complete ? "complete" : "running"},
             progress = ${JSON.stringify({ completed: count.complete, total: count.total })}::jsonb,
             finished_at = ${complete ? new Date() : null}, updated_at = now()
       where id = ${request.captureId} and org_id = ${request.orgId}`);
    await tx.execute(sql`update qbd_sessions set last_seen_at = now() where id = ${ticket} and org_id = ${current.orgId}`);
    return complete ? 100 : Math.max(1, Math.min(99, Math.floor((count.complete * 100) / Math.max(1, count.total))));
  }));
}

export async function webConnectorLastError(ticket: string): Promise<string> {
  const current = await session(ticket);
  if (!current) return "Invalid or expired Web Connector ticket";
  return withBypassContext(async () => {
    const result = (await db.execute<{ error: string | null }>(sql`select last_error as error from qbd_sessions where id = ${ticket} and org_id = ${current.orgId}`));
    return result.rows[0]?.error ?? "No error recorded";
  });
}

export async function closeWebConnectorSession(ticket: string): Promise<string> {
  const current = await session(ticket);
  if (!current) return "QuickBooks Web Connector session was already closed";
  return withBypassContext(async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`update qbd_sessions set status = 'closed', closed_at = now(), last_seen_at = now() where id = ${ticket} and org_id = ${current.orgId}`);
      await tx.execute(sql`
        update qbd_requests r set
          status = case when c.status in ('queued', 'running') and c.expires_at > now() then 'queued' else 'cancelled' end,
          session_id = null, sent_at = null, updated_at = now()
          from qbd_captures c
         where c.id = r.capture_id and c.org_id = r.org_id
           and r.session_id = ${ticket} and r.org_id = ${current.orgId} and r.status = 'sent'`);
    });
    return "QuickBooks Web Connector session closed";
  });
}

export async function recordConnectionError(ticket: string, hresult: string, message: string): Promise<string> {
  const error = [hresult, message].filter(Boolean).join(": ") || "QuickBooks connection error";
  const current = await session(ticket);
  if (!current) return "done";
  await withBypassContext(async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`update qbd_sessions set status = 'error', last_error = ${error}, closed_at = now(), last_seen_at = now() where id = ${ticket} and org_id = ${current.orgId}`);
      await tx.execute(sql`
        update qbd_requests r set
          status = case when c.status in ('queued', 'running') and c.expires_at > now() then 'queued' else 'cancelled' end,
          session_id = null, sent_at = null, updated_at = now()
          from qbd_captures c
         where c.id = r.capture_id and c.org_id = r.org_id
           and r.session_id = ${ticket} and r.org_id = ${current.orgId} and r.status = 'sent'`);
    });
  });
  return "done";
}

export async function latestWebConnectorHeartbeat(orgId: string, connectionId: string): Promise<Date | null> {
  return withOrgContext(orgId, async () => {
    const result = (await db.execute<{ heartbeat: Date | null }>(sql`
      select max(last_seen_at) as heartbeat from qbd_sessions where connection_id = ${connectionId} and org_id = ${orgId}`));
    return result.rows[0]?.heartbeat ?? null;
  });
}
