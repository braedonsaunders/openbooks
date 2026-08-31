import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/src/db.ts";
import { dropScratchOrg } from "@openbooks/engine/src/test-fixtures.ts";

// Committed-database evidence contract for the v1 API-key execution audit
// (web/lib/application/api-key-audit.ts + executeIdempotent pairing):
//
//   * a material command (create/update/delete) NEVER commits without its
//     durable api_key_events row — forcing that storage to fail must roll the
//     whole command back and fail the request;
//   * every outcome (success, replay, permission denial) retains canonical
//     key/request correlation: key id, method, path, status, IP, user agent.
//
// This is the only suite covering the v1 records routes themselves, so it also
// pins that those handlers exercise the production write path end to end.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // The web tsconfig maps '@/…' to the web root; the plain runner needs the
    // mapping spelled out.
    if (specifier.startsWith("@/")) {
      return {
        url: new URL(`${specifier.slice(2)}.ts`, new URL("../../../../", import.meta.url)).href,
        shortCircuit: true,
        format: "module",
      };
    }
    return nextResolve(specifier, context);
  },
});

const DB = !!process.env.OPENBOOKS_DB_URL;

const { generateApiKey } = await import("../../../../lib/api-auth");
const createRoute = await import("./[typeKey]/route.ts");
const itemRoute = await import("./[typeKey]/[id]/route.ts");

async function query<T extends Record<string, unknown>>(
  statement: ReturnType<typeof sql>,
): Promise<T[]> {
  return withBypassContext(
    async () => (await db.execute<T>(statement)).rows as T[],
  );
}

/** Install/uninstall an unconditional insert blocker on the execution audit. */
async function setAuditFailureMode(mode: "forced" | "allow"): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`
      drop trigger if exists force_api_key_event_failure on api_key_events`);
    if (mode === "forced") {
      await db.execute(sql`
        create or replace function openbooks_test_fail_api_key_events() returns trigger
        language plpgsql as $fn$ begin raise exception 'forced api_key_events failure'; end $fn$`);
      await db.execute(sql`
        create trigger force_api_key_event_failure before insert on api_key_events
          for each row execute function openbooks_test_fail_api_key_events()`);
    }
  });
}

interface EvidenceOrg {
  orgId: string;
  adminUserId: string;
  guestUserId: string;
  adminKey: string;
  adminKeyId: string;
  guestKey: string;
}

/** Minimal tenant: org + two credentials (one privileged, one roleless). */
async function seedEvidenceOrg(): Promise<EvidenceOrg> {
  const orgId = randomUUID();
  const adminUserId = randomUUID();
  const guestUserId = randomUUID();

  return withBypassContext(async () => {
    // dropScratchOrg refuses anything not named 'Scratch %'.
    await db.execute(sql`
      insert into orgs (id, name, base_currency, country, settings, env_kind)
      values (${orgId}, ${"Scratch " + orgId.slice(0, 8)}, 'CAD', 'CA',
              '{"features":{"apiAccess":true}}'::jsonb, 'sandbox')`);

    const adminRoleId = randomUUID();
    await db.execute(sql`
      insert into app_roles (id, org_id, key, name, permissions)
      values (${adminRoleId}, ${orgId}, 'records_manager', 'Records Manager',
              '["parties.read","parties.manage"]'::jsonb)`);
    const emptyRoleId = randomUUID();
    await db.execute(sql`
      insert into app_roles (id, org_id, key, name, permissions)
      values (${emptyRoleId}, ${orgId}, 'empty', 'Empty', '[]'::jsonb)`);

    // Users park inactive until their assignment exists: an active user must
    // always carry one explicit role assignment.
    for (const [userId, email] of [
      [adminUserId, `${adminUserId}@evidence.test`],
      [guestUserId, `${guestUserId}@evidence.test`],
    ] as const) {
      await db.execute(sql`
        insert into users (id, org_id, email, name, password_hash, is_active)
        values (${userId}, ${orgId}, ${email}, 'Evidence User', 'unusable', false)`);
    }
    await db.execute(sql`
      insert into role_assignments (org_id, user_id, role_id) values
        (${orgId}, ${adminUserId}, ${adminRoleId}),
        (${orgId}, ${guestUserId}, ${emptyRoleId})`);
    await db.execute(sql`
      update users set is_active = true where org_id = ${orgId}`);

    let adminKey = "";
    let adminKeyId = "";
    let guestKey = "";
    // Keys must carry explicit catalogue scopes; the owner's effective
    // permissions still intersect these grants during authentication.
    for (const userId of [adminUserId, guestUserId]) {
      const generated = generateApiKey();
      const [row] = (await db.execute<{ id: string }>(sql`
        insert into api_keys (org_id, user_id, name, key_prefix, key_hash, key_preview, scopes, is_active)
        values (${orgId}, ${userId},
                ${userId === adminUserId ? "evidence admin key" : "roleless guest key"},
                ${generated.keyPrefix}, ${generated.keyHash}, ${generated.keyPreview},
                '["parties.read", "parties.manage"]'::jsonb, true)
        returning id`)).rows;
      if (userId === adminUserId) {
        adminKey = generated.plaintext;
        adminKeyId = row!.id;
      } else {
        guestKey = generated.plaintext;
      }
    }

    return { orgId, adminUserId, guestUserId, adminKey, adminKeyId, guestKey };
  });
}

function recordsRequest(
  method: "POST" | "PATCH" | "DELETE",
  pathname: string,
  plaintextKey: string,
  idempotencyKey: string,
  body?: Record<string, unknown>,
): Request {
  return new Request(`http://openbooks.evidence.test${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${plaintextKey}`,
      ...(method === "DELETE" ? {} : { "content-type": "application/json" }),
      "idempotency-key": idempotencyKey,
      "user-agent": "evidence-suite/1",
      "x-forwarded-for": "203.0.113.9, 198.51.100.7",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function malformedRecordsRequest(
  pathname: string,
  plaintextKey: string,
  idempotencyKey: string,
): Request {
  return new Request(`http://openbooks.evidence.test${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${plaintextKey}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "user-agent": "evidence-suite/1",
      "x-forwarded-for": "203.0.113.9, 198.51.100.7",
    },
    body: "{not-json",
  });
}

const COLLECTION_PATH = "/api/v1/records/parties";

const partyCount = async (orgId: string): Promise<number> => {
  const [row] = await query<{ n: number }>(
    sql`select count(*)::int as n from parties where org_id = ${orgId}`);
  return row!.n;
};
const eventCount = async (orgId: string): Promise<number> => {
  const [row] = await query<{ n: number }>(
    sql`select count(*)::int as n from api_key_events where org_id = ${orgId}`);
  return row!.n;
};
const claimCount = async (orgId: string): Promise<number> => {
  const [row] = await query<{ n: number }>(
    sql`select count(*)::int as n from application_idempotency_keys where org_id = ${orgId}`);
  return row!.n;
};

test("malformed authenticated commands retain execution audit evidence", { skip: !DB }, async () => {
  const org = await seedEvidenceOrg();
  try {
    const response = await withOrgContext(org.orgId, () =>
      createRoute.POST(
        malformedRecordsRequest(COLLECTION_PATH, org.adminKey, "evidence-malformed-01"),
        { params: Promise.resolve({ typeKey: "parties" }) },
      ));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid request body" });

    const events = await query<{
      key_id: string; method: string; path: string; status_code: number; error: string | null;
    }>(sql`
      select key_id, method, path, status_code, error
        from api_key_events where org_id = ${org.orgId} order by id asc`);
    assert.equal(events.length, 1, "the malformed request is durably evidenced");
    assert.deepEqual(events[0], {
      key_id: org.adminKeyId,
      method: "POST",
      path: COLLECTION_PATH,
      status_code: 400,
      error: "invalid_input",
    });
    assert.equal(await partyCount(org.orgId), 0, "malformed input never reaches the application writer");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function seedParty(orgId: string, displayName: string): Promise<string> {
  const [party] = await withBypassContext(async () =>
    (await db.execute<{ id: string }>(sql`
      insert into parties (org_id, kind, display_name, created_by, updated_by)
      values (${orgId}, 'customer', ${displayName}, null, null)
      returning id`)).rows);
  assert.ok(party, "the fixture party exists");
  return party.id;
}

test("a forced execution-audit failure blocks and rolls back the material create", { skip: !DB }, async () => {
  const org = await seedEvidenceOrg();
  try {
    await setAuditFailureMode("forced");

    const response = await withOrgContext(org.orgId, () =>
      createRoute.POST(recordsRequest("POST", COLLECTION_PATH, org.adminKey, "evidence-create-01",
        { kind: "customer", display_name: "Evidence Party" }),
      { params: Promise.resolve({ typeKey: "parties" }) }));

    // Fail closed: the client never sees success without durable evidence…
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
    // …and nothing half-committed: the party, the idempotency claim, and the
    // audit attempt are gone together.
    assert.equal(await partyCount(org.orgId), 0, "the create rolled back with its audit");
    assert.equal(await eventCount(org.orgId), 0, "the failed audit write left no partial event");
    assert.equal(await claimCount(org.orgId), 0, "the idempotency claim rolled back too");
  } finally {
    await setAuditFailureMode("allow");
    await dropScratchOrg(org.orgId);
  }
});

test("a forced execution-audit failure blocks and rolls back the material update", { skip: !DB }, async () => {
  const org = await seedEvidenceOrg();
  try {
    const partyId = await seedParty(org.orgId, "Update Target");
    await setAuditFailureMode("forced");

    const response = await withOrgContext(org.orgId, () =>
      itemRoute.PATCH(
        recordsRequest("PATCH", `${COLLECTION_PATH}/${partyId}`, org.adminKey, "evidence-update-01",
          { display_name: "Renamed During Forced Failure" }),
        { params: Promise.resolve({ typeKey: "parties", id: partyId }) }));

    assert.equal(response.status, 500);
    const [after] = await query<{ display_name: string }>(sql`
      select display_name from parties where org_id = ${org.orgId}`);
    assert.equal(after?.display_name, "Update Target", "the update rolled back with its audit");
    assert.equal(await eventCount(org.orgId), 0);
    assert.equal(await claimCount(org.orgId), 0);
  } finally {
    await setAuditFailureMode("allow");
    await dropScratchOrg(org.orgId);
  }
});

test("a forced execution-audit failure blocks and rolls back the material delete", { skip: !DB }, async () => {
  const org = await seedEvidenceOrg();
  try {
    const partyId = await seedParty(org.orgId, "Delete Target");
    await setAuditFailureMode("forced");

    const response = await withOrgContext(org.orgId, () =>
      itemRoute.DELETE(
        recordsRequest("DELETE", `${COLLECTION_PATH}/${partyId}`, org.adminKey, "evidence-delete-01"),
        { params: Promise.resolve({ typeKey: "parties", id: partyId }) }));

    assert.equal(response.status, 500);
    assert.equal(await partyCount(org.orgId), 1, "the delete rolled back with its audit");
    assert.equal(await eventCount(org.orgId), 0);
    assert.equal(await claimCount(org.orgId), 0);
  } finally {
    await setAuditFailureMode("allow");
    await dropScratchOrg(org.orgId);
  }
});

test("successful create commits exactly one canonical evidence row; replays add correlation only", { skip: !DB }, async () => {
  const org = await seedEvidenceOrg();
  try {
    const first = await withOrgContext(org.orgId, () =>
      createRoute.POST(recordsRequest("POST", COLLECTION_PATH, org.adminKey, "evidence-success-01",
        { kind: "customer", display_name: "Evidence Party" }),
      { params: Promise.resolve({ typeKey: "parties" }) }));
    assert.equal(first.status, 201);
    const body = (await first.json()) as { id: string };

    const events = await query<{
      key_id: string; method: string; path: string; status_code: number;
      duration_ms: number; ip_address: string | null; user_agent: string | null;
      error: string | null;
    }>(sql`
      select key_id, method, path, status_code, duration_ms, ip_address, user_agent, error
        from api_key_events where org_id = ${org.orgId} order by id asc`);
    assert.equal(events.length, 1, "exactly one durable execution event");
    const event = events[0]!;
    assert.equal(event.key_id, org.adminKeyId, "canonical key binding");
    assert.equal(event.method, "POST");
    assert.equal(event.path, COLLECTION_PATH);
    assert.equal(Number(event.status_code), 201);
    assert.ok(Number(event.duration_ms) >= 0);
    assert.equal(event.ip_address, "203.0.113.9", "first proxy hop recorded");
    assert.equal(event.user_agent, "evidence-suite/1");
    assert.equal(event.error, null);

    // The authenticating credential leaves its usage trace.
    const [adminKey] = await query<{ last_used_at: Date | null }>(sql`
      select last_used_at from api_keys where id = ${org.adminKeyId}`);
    assert.ok(adminKey?.last_used_at, "last_used_at is persisted, not best-effort");

    // Replay of the identical command: correlation retained, no second effect.
    const replay = await withOrgContext(org.orgId, () =>
      createRoute.POST(recordsRequest("POST", COLLECTION_PATH, org.adminKey, "evidence-success-01",
        { kind: "customer", display_name: "Evidence Party" }),
      { params: Promise.resolve({ typeKey: "parties" }) }));
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    const replayBody = (await replay.json()) as { id: string };
    assert.equal(replayBody.id, body.id, "replay returns the stored result");
    assert.equal(await partyCount(org.orgId), 1, "still exactly one effect");
    assert.equal(await eventCount(org.orgId), 2, "the replay carries its own correlation row");
  } finally {
    await setAuditFailureMode("allow");
    await dropScratchOrg(org.orgId);
  }
});

test("permission denial keeps canonical key/request correlation without touching data", { skip: !DB }, async () => {
  const org = await seedEvidenceOrg();
  try {
    const denied = await withOrgContext(org.orgId, () =>
      createRoute.POST(recordsRequest("POST", COLLECTION_PATH, org.guestKey, "evidence-denied-01",
        { kind: "customer", display_name: "Evidence Party" }),
      { params: Promise.resolve({ typeKey: "parties" }) }));
    assert.equal(denied.status, 403);

    const events = await query<{
      status_code: number; ip_address: string | null; user_agent: string | null; error: string | null;
    }>(sql`
      select status_code, ip_address, user_agent, error
        from api_key_events where org_id = ${org.orgId}`);
    assert.equal(events.length, 1, "the denial is durably evidenced");
    assert.equal(Number(events[0]!.status_code), 403);
    assert.equal(events[0]!.error, "forbidden");
    assert.equal(events[0]!.ip_address, "203.0.113.9");
    assert.equal(await partyCount(org.orgId), 0);
  } finally {
    await setAuditFailureMode("allow");
    await dropScratchOrg(org.orgId);
  }
});
