import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { portalRefusal, type PortalRefusal } from "./errors.ts";

export const PORTAL_FEATURE = "customerPortal";
export const PORTAL_FEATURE_REMEDY = "Turn on Customer portal on Company Settings → Features";

/** Magic links live 15 minutes; sessions live 24 hours. */
export const PORTAL_LINK_TTL_MINUTES = 15;
export const PORTAL_SESSION_TTL_HOURS = 24;
/**
 * At most this many magic links per email address and org per hour. Past
 * the cap the request still reports success but sends nothing: a refusal
 * would confirm the address belongs to a customer.
 */
export const PORTAL_REQUESTS_PER_HOUR = 5;
/** Consume attempts against a dead link before it locks and needs reissue. */
export const PORTAL_DEAD_LINK_ATTEMPTS = 25;

export type PortalSession = {
  orgId: string;
  partyId: string;
  linkId: string;
};

/**
 * The portal credential encoding: sha256 hex of the Bearer [REDACTED] The
 * plaintext token is never stored — lookup is by hash only, the same
 * handling as payment link tokens.
 */
export function portalTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Mint a 192-bit URL-safe token for a magic link or session. */
export function mintPortalToken(): string {
  return randomBytes(24).toString("base64url");
}

export function normalizePortalEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) return null;
  return email;
}

type PortalCandidate = {
  orgId: string;
  partyId: string;
  orgName: string;
  portalName: string;
};

type PortalLinkRow = {
  id: string;
  org_id: string;
  party_id: string;
  purpose: string;
  expires_at: string;
  consumed_at: string | null;
  failed_attempts: number;
};

async function portalCandidates(email: string): Promise<PortalCandidate[]> {
  // A customer is reachable at their party email or any active contact email.
  // Matches in orgs without the portal gate stay silent: the requester
  // learns nothing about which orgs hold their address.
  const rows = (await db.execute<PortalCandidate>(sql`
    with candidates as (
      select p.org_id as "orgId", p.id as "partyId"
        from parties p
       where lower(p.email) = ${email} and p.is_active
      union
      select c.org_id as "orgId", c.party_id as "partyId"
        from contacts c
       where lower(c.email) = ${email} and c.is_active and c.party_id is not null
    )
    select distinct candidates."orgId" as "orgId", candidates."partyId" as "partyId",
           o.name as "orgName",
           coalesce((
             select s.portal_name from customer_portal_settings s
              where s.org_id = candidates."orgId" and s.effective_from <= current_date
              order by s.effective_from desc limit 1
           ), 'Customer portal') as "portalName"
      from candidates
      join orgs o on o.id = candidates."orgId"
  `)).rows;
  const enabled: PortalCandidate[] = [];
  for (const row of rows) {
    if (await orgFeatureEnabled(row.orgId, PORTAL_FEATURE)) enabled.push(row);
  }
  return enabled;
}

export type RequestedPortalLink = {
  orgId: string;
  orgName: string;
  portalName: string;
  partyId: string;
  email: string;
  token: string;
  expiresAt: Date;
};

/**
 * Request a magic link for a customer contact email. Always resolves (never
 * 404s on unknown addresses) so the request endpoint cannot enumerate
 * customer emails; only matching orgs with the portal gate on receive mail.
 * Throws 429 naming the wait when the address asked too often.
 */
export async function requestPortalLink(rawEmail: unknown): Promise<{ sent: boolean; links: RequestedPortalLink[] }> {
  const email = normalizePortalEmail(rawEmail);
  if (!email) {
    throw portalRefusal(
      "Enter the email address from your customer account",
      "invalid_email",
      422,
      "Use the billing or contact email your supplier has on file",
    );
  }
  // bypass: public-token-lookup — the anonymous requester names only an email, so the owning orgs are resolved from that identifier before every write runs inside each candidate org's scope.
  return withBypassContext(async () => {
    const candidates = await portalCandidates(email);
    const links: RequestedPortalLink[] = [];
    for (const candidate of candidates) {
      const link = await withOrgTransaction(candidate.orgId, () =>
        issuePartyLink(db, candidate.orgId, candidate.partyId, email),
      );
      if (link) {
        links.push({
          orgId: candidate.orgId,
          orgName: candidate.orgName,
          portalName: candidate.portalName,
          partyId: candidate.partyId,
          email,
          token: link.token,
          expiresAt: link.expiresAt,
        });
      }
    }
    return { sent: true, links };
  });
}

async function issuePartyLink(
  runner: SqlExecutor,
  orgId: string,
  partyId: string,
  email: string,
): Promise<{ token: string; expiresAt: Date } | null> {
  const recent = (await runner.execute<{ count: string }>(sql`
    select count(*)::text as count from customer_portal_links
     where org_id = ${orgId} and lower(contact_email) = ${email} and purpose = 'magic_link'
       and created_at > now() - interval '1 hour'
  `)).rows[0]?.count ?? "0";
  if (Number(recent) >= PORTAL_REQUESTS_PER_HOUR) return null;
  const token = mintPortalToken();
  const inserted = (await runner.execute<{ id: string; expires_at: string }>(sql`
    insert into customer_portal_links (org_id, party_id, contact_email, token_hash, purpose, expires_at)
    values (${orgId}, ${partyId}, ${email}, ${portalTokenHash(token)}, 'magic_link',
            now() + ${`${PORTAL_LINK_TTL_MINUTES} minutes`}::interval)
    returning id, expires_at
  `)).rows[0];
  if (!inserted) throw portalRefusal("The portal link could not be created", "invalid_link", 422, "Request a new link");
  await recordPortalEvent(runner, orgId, {
    partyId,
    linkId: inserted.id,
    action: "link_requested",
    reasonCode: null,
    detail: { email },
  });
  // One live magic link per customer: an older unconsumed link for the same
  // party stops working the moment a newer one is issued.
  await runner.execute(sql`
    update customer_portal_links
       set expires_at = now(), updated_at = now()
     where org_id = ${orgId} and party_id = ${partyId} and purpose = 'magic_link'
       and consumed_at is null and expires_at > now()
       and token_hash <> ${portalTokenHash(token)}
  `);
  return { token, expiresAt: new Date(inserted.expires_at) };
}

export type ConsumedPortalLink = {
  orgId: string;
  partyId: string;
  linkId: string;
  sessionToken: string;
  sessionExpiresAt: Date;
};

/**
 * Exchange a single-use magic link for a 24-hour session token. The magic
 * link is consumed atomically; replays, expiries and unknown tokens all
 * refuse with the reissue remedy.
 */
export async function consumePortalLink(token: unknown): Promise<ConsumedPortalLink> {
  if (typeof token !== "string" || token.length < 16) {
    throw portalRefusal("This portal link is invalid", "invalid_link", 404, "Request a new link from the portal sign-in");
  }
  // bypass: public-token-lookup — the magic-link token resolves the owning org from one row before the consume runs in that org's scope.
  return withBypassContext(async () => {
    const row = (await db.execute<PortalLinkRow>(sql`
      select id, org_id, party_id, purpose, expires_at::text as expires_at,
             consumed_at::text as consumed_at, failed_attempts
        from customer_portal_links
       where token_hash = ${portalTokenHash(token)} and purpose = 'magic_link'
       limit 1
      for update
    `)).rows[0];
    if (!row) {
      throw portalRefusal("This portal link is invalid", "invalid_link", 404, "Request a new link from the portal sign-in");
    }
    if (!(await orgFeatureEnabled(row.org_id, PORTAL_FEATURE))) {
      throw portalRefusal("The customer portal is turned off for this organization", "feature_disabled", 404, PORTAL_FEATURE_REMEDY);
    }
    if (row.consumed_at) {
      throw portalRefusal("This portal link was already used", "link_consumed", 404, "Request a new link from the portal sign-in");
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await bumpDeadLinkAttempts(row);
      throw portalRefusal("This portal link has expired", "link_expired", 404, "Request a new link from the portal sign-in");
    }
    if (row.failed_attempts >= PORTAL_DEAD_LINK_ATTEMPTS) {
      throw portalRefusal("This portal link is locked after too many attempts", "link_locked", 429, "Request a new link from the portal sign-in");
    }
    return withOrgTransaction(row.org_id, async () => {
      const consumed = (await db.execute<{ id: string }>(sql`
        update customer_portal_links
           set consumed_at = now(), updated_at = now()
         where org_id = ${row.org_id} and id = ${row.id} and consumed_at is null
        returning id
      `)).rows[0];
      if (!consumed) {
        throw portalRefusal("This portal link was already used", "link_consumed", 404, "Request a new link from the portal sign-in");
      }
      // One live session per customer: signing in again retires the older session.
      await db.execute(sql`
        update customer_portal_links
           set expires_at = now(), updated_at = now()
         where org_id = ${row.org_id} and party_id = ${row.party_id} and purpose = 'session'
           and consumed_at is null and expires_at > now()
      `);
      const sessionToken = mintPortalToken();
      const session = (await db.execute<{ id: string; expires_at: string }>(sql`
        insert into customer_portal_links (org_id, party_id, contact_email, token_hash, purpose, expires_at)
        select ${row.org_id}, ${row.party_id}, contact_email, ${portalTokenHash(sessionToken)}, 'session',
               now() + ${`${PORTAL_SESSION_TTL_HOURS} hours`}::interval
          from customer_portal_links where org_id = ${row.org_id} and id = ${row.id}
        returning id, expires_at::text as expires_at
      `)).rows[0];
      if (!session) throw new Error("portal session was not recorded");
      await recordPortalEvent(db, row.org_id, {
        partyId: row.party_id,
        linkId: session.id,
        action: "session_created",
        reasonCode: null,
        detail: {},
      });
      return {
        orgId: row.org_id,
        partyId: row.party_id,
        linkId: session.id,
        sessionToken,
        sessionExpiresAt: new Date(session.expires_at),
      };
    });
  });
}

async function bumpDeadLinkAttempts(row: PortalLinkRow): Promise<void> {
  await withOrgTransaction(row.org_id, async () => {
    await db.execute(sql`
      update customer_portal_links
         set failed_attempts = failed_attempts + 1, updated_at = now()
       where org_id = ${row.org_id} and id = ${row.id}
    `);
  });
}

/**
 * Resolve a session token to its customer scope. Returns null for unknown,
 * expired or gate-disabled sessions — callers 404 without disclosing why.
 */
export async function resolvePortalSession(token: unknown): Promise<PortalSession | null> {
  if (typeof token !== "string" || token.length < 16) return null;
  // bypass: public-token-lookup — the session token resolves the owning org from one row; the caller re-enters that org's scope.
  return withBypassContext(async () => {
    const row = (await db.execute<PortalLinkRow>(sql`
      select id, org_id, party_id, purpose, expires_at::text as expires_at,
             consumed_at::text as consumed_at, failed_attempts
        from customer_portal_links
       where token_hash = ${portalTokenHash(token)} and purpose = 'session'
       limit 1
    `)).rows[0];
    if (!row || row.consumed_at) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    if (!(await orgFeatureEnabled(row.org_id, PORTAL_FEATURE))) return null;
    return { orgId: row.org_id, partyId: row.party_id, linkId: row.id };
  });
}

/** End the session now; a missing row is already ended. */
export async function revokePortalSession(token: unknown): Promise<void> {
  if (typeof token !== "string" || token.length < 16) return;
  // bypass: public-token-lookup — the session token resolves the owning org from one row before the revoke runs in that org's scope.
  await withBypassContext(async () => {
    const row = (await db.execute<{ org_id: string; id: string }>(sql`
      select org_id, id from customer_portal_links
       where token_hash = ${portalTokenHash(token)} and purpose = 'session'
       limit 1
    `)).rows[0];
    if (!row) return;
    await withOrgTransaction(row.org_id, async () => {
      await db.execute(sql`
        update customer_portal_links
           set expires_at = now(), updated_at = now()
         where org_id = ${row.org_id} and id = ${row.id}
      `);
    });
  });
}

export async function recordPortalEvent(
  runner: SqlExecutor,
  orgId: string,
  event: {
    partyId: string;
    linkId: string | null;
    action: string;
    reasonCode: string | null;
    detail: Record<string, unknown>;
  },
): Promise<string> {
  const inserted = (await runner.execute<{ id: string }>(sql`
    insert into customer_portal_events (org_id, party_id, link_id, action, reason_code, detail)
    values (${orgId}, ${event.partyId}, ${event.linkId}, ${event.action}, ${event.reasonCode},
            ${JSON.stringify(event.detail)}::jsonb)
    returning id
  `)).rows[0];
  if (!inserted) throw new Error("portal audit event was not recorded");
  return inserted.id;
}

export type { PortalRefusal };
