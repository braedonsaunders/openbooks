import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { z } from "zod";
import { DOCUMENT_REVISION_PATTERN } from "../api/registry-data.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { ApplicationError } = await import("./errors.ts");
const { applicationWriteValue, normalizeDocumentRecordRevisions } = await import("./records.ts");
const { applicationTool } = await import("./tool-catalog.ts");
const { domainFailure } = await import("./documents.ts");
const { DocumentEditError } = await import("../documents.ts");
type ApplicationContext = import("./context").ApplicationContext;

const EXACT_REVISION = "2026-08-24T12:34:56.123456Z";
const ID = "00000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "document-occ-test-1";

test("generic document reads replace the lossy Date with the exact persisted revision", () => {
  const lossy = new Date("2026-08-24T12:34:56.123Z");
  const [record] = normalizeDocumentRecordRevisions("documents", [{
    id: ID,
    updated_at: lossy,
    __documentRevision: EXACT_REVISION,
  }]);
  assert.equal(record?.updated_at, EXACT_REVISION);
  assert.equal("__documentRevision" in (record ?? {}), false);
  assert.equal(new Date(EXACT_REVISION).getTime(), lossy.getTime(), "the fixture proves Date loses the suffix");

  const ordinary = [{ id: ID, updated_at: lossy }];
  assert.equal(normalizeDocumentRecordRevisions("parties", ordinary), ordinary);
  assert.throws(
    () => normalizeDocumentRecordRevisions("documents", [{ updated_at: lossy }]),
    /exact persisted revision/,
  );
});

test("document update and correction tool schemas require the exact persisted token", () => {
  const update = applicationTool("update_record")!;
  const updateInput = {
    typeKey: "bills",
    id: ID,
    body: { memo: "reviewed" },
    idempotencyKey: IDEMPOTENCY_KEY,
  };
  assert.equal(update.inputSchema.safeParse(updateInput).success, false);
  assert.equal(update.inputSchema.safeParse({
    ...updateInput,
    body: { ...updateInput.body, expectedUpdatedAt: null },
  }).success, false);
  assert.equal(update.inputSchema.safeParse({
    ...updateInput,
    body: { ...updateInput.body, expectedUpdatedAt: "2026-08-24T12:34:56.123Z" },
  }).success, false);
  const parsedUpdate = update.inputSchema.safeParse({
    ...updateInput,
    body: { ...updateInput.body, expectedUpdatedAt: EXACT_REVISION },
  });
  assert.equal(parsedUpdate.success, true);
  if (parsedUpdate.success) {
    const parsed = parsedUpdate.data as { body: { expectedUpdatedAt: string } };
    assert.equal(parsed.body.expectedUpdatedAt, EXACT_REVISION);
  }
  assert.equal(update.inputSchema.safeParse({ ...updateInput, typeKey: "parties" }).success, true);

  const advertised = z.toJSONSchema(update.inputSchema) as {
    type?: string;
    properties?: {
      body?: { properties?: { expectedUpdatedAt?: { pattern?: string } } };
    };
    allOf?: Array<{
      if?: { properties?: { typeKey?: { enum?: string[] } } };
      then?: { properties?: { body?: { required?: string[] } } };
    }>;
  };
  assert.equal(advertised.type, "object", "the MCP registrar can expose the conditional schema");
  assert.equal(
    advertised.properties?.body?.properties?.expectedUpdatedAt?.pattern,
    DOCUMENT_REVISION_PATTERN,
  );
  const documentRequirement = advertised.allOf?.[0];
  assert.deepEqual(documentRequirement?.if?.properties?.typeKey?.enum, ["bills", "invoices"]);
  assert.deepEqual(
    documentRequirement?.then?.properties?.body?.required,
    ["expectedUpdatedAt"],
    "the model-visible schema makes document revisions mandatory",
  );

  const correction = applicationTool("correct_document")!;
  const correctionInput = {
    documentId: ID,
    correction: { amendmentReason: "correct source evidence" },
    idempotencyKey: IDEMPOTENCY_KEY,
  };
  assert.equal(correction.inputSchema.safeParse(correctionInput).success, false);
  assert.equal(correction.inputSchema.safeParse({
    ...correctionInput,
    correction: { ...correctionInput.correction, expectedUpdatedAt: null },
  }).success, false);
  const parsedCorrection = correction.inputSchema.safeParse({
    ...correctionInput,
    correction: { ...correctionInput.correction, expectedUpdatedAt: EXACT_REVISION },
  });
  assert.equal(parsedCorrection.success, true);
  if (parsedCorrection.success) {
    const parsed = parsedCorrection.data as { correction: { expectedUpdatedAt: string } };
    assert.equal(parsed.correction.expectedUpdatedAt, EXACT_REVISION);
  }
});

test("stale generic and correction writes surface a 409 conflict", () => {
  for (const invoke of [
    () => applicationWriteValue({ status: 409, body: { error: "stale document revision" } }),
    () => domainFailure(new DocumentEditError(409, "stale document revision")),
  ]) {
    assert.throws(
      invoke,
      (error: unknown) => error instanceof ApplicationError
        && error.code === "conflict"
        && error.status === 409
        && error.message === "stale document revision",
    );
  }
});

test("REST writers and curated document tools reuse the exact SQL revision projection", () => {
  const recordsSource = readFileSync(new URL("./records.ts", import.meta.url), "utf8");
  const writersSource = readFileSync(new URL("../api/writers.ts", import.meta.url), "utf8");
  const toolsSource = readFileSync(new URL("../assistant/tools.ts", import.meta.url), "utf8");

  assert.match(recordsSource, /select \*\$\{documentRevisionProjection\(scope\.resolved\.table\)\}/);
  assert.match(writersSource, /documentRevisionSql\(sql\.raw\("updated_at"\)\).*as "updatedAt"/s);
  assert.equal(
    toolsSource.match(/documentRevisionSql\(sql\.raw\("d\.updated_at"\)\)/g)?.length,
    2,
  );
  assert.match(toolsSource, /updatedAt: r\.documentRevision/);
  assert.match(toolsSource, /updatedAt: d\.documentRevision/);
});

test("application corrections route flows inside the idempotent transaction", () => {
  const source = readFileSync(new URL("./documents.ts", import.meta.url), "utf8");
  const commandStart = source.indexOf("export async function correctPostedDocument")
  const command = source.slice(commandStart)
  const callbackStart = command.indexOf("execute: async () => {")
  const callbackEnd = command.indexOf("\n      }\n    },", callbackStart)
  const voidCall = command.indexOf("requestDocumentVoid(", callbackStart)
  const dispatch = command.indexOf("runPostedCorrectionDraftFlows(", callbackStart)
  assert.ok(callbackStart >= 0 && callbackEnd > callbackStart)
  assert.ok(voidCall > callbackStart && dispatch > voidCall && dispatch < callbackEnd)
  assert.equal(
    command.indexOf("if (!outcome.replayed)", callbackEnd),
    -1,
    "a completed idempotency replay must not bypass correction routing",
  )
});

const DB = !!process.env.OPENBOOKS_DB_URL;

type IdempotencyHarness = Awaited<ReturnType<typeof buildIdempotencyHarness>>;

async function buildIdempotencyHarness() {
  const { sql } = await import("drizzle-orm");
  const { randomUUID } = await import("node:crypto");
  const { db, pool } = await import("@openbooks/engine/src/db.ts");
  const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
    "@openbooks/engine/src/test-fixtures.ts"
  );
  const { requestDocumentVoid } = await import("@openbooks/engine/src/document-void.ts");
  const { executeIdempotent } = await import("./idempotency.ts");

  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Idempotent Void Controller", "admin");
  const context: ApplicationContext = {
    authz: {
      user: { id: actorId, orgId: org.orgId } as ApplicationContext["authz"]["user"],
      permissions: new Set<string>(["*"]),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };

  async function seedApprovedQuote(documentNumber: string): Promise<string> {
    const documentId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, currency, status, created_by)
      values (
        ${documentId}, ${org.orgId}, 'quote', ${documentNumber},
        ${org.customerId}, ${org.subsidiaryId}, ${org.date}, 'CAD',
        'approved', ${actorId}
      )
    `);
    return documentId;
  }

  async function seedSlowBeforeVoidScript(sleepSeconds: number): Promise<void> {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(settings, '{features,scripts}', 'true'::jsonb, true)
       where id = ${org.orgId}
    `);
    await db.execute(sql`
      insert into user_scripts
        (id, org_id, name, trigger_point, document_kind, source,
         timeout_ms, sort_order, is_active, created_by)
      values (
        ${randomUUID()}, ${org.orgId}, 'Idempotency pool probe', 'before_void',
        'quote',
        ${`function main() { ob.query("select pg_sleep(${sleepSeconds})::text as waited"); }`},
        10_000, 1, true, ${actorId}
      )
    `);
  }

  async function countRows(query: ReturnType<typeof sql>): Promise<number> {
    const result = await db.execute<{ count: number }>(query);
    return Number(result.rows[0]!.count);
  }

  return {
    org,
    actorId,
    context,
    db,
    pool,
    sql,
    executeIdempotent,
    requestDocumentVoid,
    seedApprovedQuote,
    seedSlowBeforeVoidScript,
    countRows,
    cleanup: () => dropScratchOrg(org.orgId),
  };
}

function deferred(): {
  claimed: Promise<void>;
  signalClaimed: () => void;
  release: Promise<void>;
  openRelease: () => void;
} {
  let signalClaimed!: () => void;
  let openRelease!: () => void;
  const claimed = new Promise<void>((resolve) => {
    signalClaimed = resolve;
  });
  const release = new Promise<void>((resolve) => {
    openRelease = resolve;
  });
  return { claimed, signalClaimed, release, openRelease };
}

test("a duplicate waits out an in-flight attempt without pinning a pool client, then replays", { skip: !DB }, async () => {
  const h = await buildIdempotencyHarness();
  try {
    const gate = deferred();
    const leaderValue = { status: "voided", marker: "leader" };
    const leader = h.executeIdempotent({
      context: h.context,
      operation: "documents.void",
      idempotencyKey: "wait-replay-leader-key",
      request: { documentId: "doc-1" },
      // Invoked strictly after the leader's claim insert, so awaiting this
      // signal proves the leader owns the uncommitted key row + advisory lock.
      execute: async () => {
        gate.signalClaimed();
        await gate.release;
        return leaderValue;
      },
    });
    await gate.claimed;

    const duplicate = h.executeIdempotent({
      context: h.context,
      operation: "documents.void",
      idempotencyKey: "wait-replay-leader-key",
      request: { documentId: "doc-1" },
      execute: async () => {
        throw new Error("the duplicate must wait out the rival, never execute the command");
      },
    });

    // The duplicate must be polling, holding no transaction of its own: its
    // only footprint is short-lived reads that leave no idle-in-transaction
    // session behind.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const pinned = await h.db.execute<{ pinned: number }>(h.sql`
      select count(*)::int as pinned
        from pg_stat_activity
       where datname = current_database()
         and state = 'idle in transaction'
         and xact_start < clock_timestamp() - interval '50 milliseconds'
         and pid <> pg_backend_pid()
    `);
    const waitingClients = h.pool.waitingCount;

    gate.openRelease();
    const [leaderOutcome, duplicateOutcome] = await Promise.allSettled([leader, duplicate]);

    assert.equal(leaderOutcome.status, "fulfilled");
    if (leaderOutcome.status === "fulfilled") {
      assert.equal(leaderOutcome.value.replayed, false);
      assert.deepEqual(leaderOutcome.value.value, leaderValue);
    }
    assert.equal(duplicateOutcome.status, "fulfilled");
    if (duplicateOutcome.status === "fulfilled") {
      assert.equal(duplicateOutcome.value.replayed, true, "the duplicate replays the committed response");
      assert.deepEqual(duplicateOutcome.value.value, leaderValue);
    }
    assert.ok(
      (pinned.rows[0]?.pinned ?? 0) <= 1,
      "only the in-flight claimant may hold an open transaction while duplicates wait",
    );
    assert.equal(waitingClients, 0, "no duplicate may queue for a pooled client while waiting");
  } finally {
    await h.cleanup();
  }
});

test("a rolled-back leader hands the command to the polling duplicate", { skip: !DB }, async () => {
  const h = await buildIdempotencyHarness();
  try {
    const gate = deferred();
    const leader = h.executeIdempotent({
      context: h.context,
      operation: "documents.void",
      idempotencyKey: "failover-leader-key",
      request: { documentId: "doc-2" },
      execute: async () => {
        gate.signalClaimed();
        await gate.release;
        throw new Error("leader aborted after claiming");
      },
    });
    await gate.claimed;

    const duplicate = h.executeIdempotent({
      context: h.context,
      operation: "documents.void",
      idempotencyKey: "failover-leader-key",
      request: { documentId: "doc-2" },
      execute: async () => ({ status: "voided", ranBy: "duplicate" }),
    });

    gate.openRelease();
    const [leaderOutcome, duplicateOutcome] = await Promise.allSettled([leader, duplicate]);

    assert.equal(leaderOutcome.status, "rejected", "the leader rolls back");
    assert.equal(duplicateOutcome.status, "fulfilled");
    if (duplicateOutcome.status === "fulfilled") {
      assert.deepEqual(
        duplicateOutcome.value,
        { replayed: false, value: { status: "voided", ranBy: "duplicate" } },
        "the duplicate claims the abandoned key and executes exactly once",
      );
    }

    // A third arrival after failover replays the duplicate's stored response.
    const third = await h.executeIdempotent({
      context: h.context,
      operation: "documents.void",
      idempotencyKey: "failover-leader-key",
      request: { documentId: "doc-2" },
      execute: async () => {
        throw new Error("must not run after the key completed");
      },
    });
    assert.equal(third.replayed, true);
    assert.deepEqual(third.value, { status: "voided", ranBy: "duplicate" });
  } finally {
    await h.cleanup();
  }
});

test("key reuse with different payload conflicts even against an in-flight rival", { skip: !DB }, async () => {
  const h = await buildIdempotencyHarness();
  try {
    const gate = deferred();
    const leader = h.executeIdempotent({
      context: h.context,
      operation: "documents.void",
      idempotencyKey: "payload-guard-key",
      request: { documentId: "doc-3", reason: "original" },
      execute: async () => {
        gate.signalClaimed();
        await gate.release;
        return { ok: true };
      },
    });
    await gate.claimed;

    const mismatched = h.executeIdempotent({
      context: h.context,
      operation: "documents.void",
      idempotencyKey: "payload-guard-key",
      request: { documentId: "doc-3", reason: "tampered" },
      execute: async () => {
        throw new Error("mismatched payload must never execute");
      },
    });

    gate.openRelease();
    const [leaderOutcome, mismatchOutcome] = await Promise.allSettled([leader, mismatched]);
    assert.equal(leaderOutcome.status, "fulfilled");
    assert.equal(mismatchOutcome.status, "rejected");
    if (mismatchOutcome.status === "rejected") {
      const error = mismatchOutcome.reason as { code?: string; message?: string };
      assert.equal(error.code, "conflict");
      assert.match(error.message ?? "", /different input/);
    }
  } finally {
    await h.cleanup();
  }
});

test("a duplicate gives up with a conflict once the rival wait budget lapses", { skip: !DB }, async () => {
  const h = await buildIdempotencyHarness();
  try {
    const gate = deferred();
    const leader = h.executeIdempotent({
      context: h.context,
      operation: "documents.void",
      idempotencyKey: "budget-expiry-key",
      request: { documentId: "doc-4" },
      execute: async () => {
        gate.signalClaimed();
        await gate.release;
        return { status: "voided" };
      },
    });
    await gate.claimed;

    await assert.rejects(
      h.executeIdempotent({
        context: h.context,
        operation: "documents.void",
        idempotencyKey: "budget-expiry-key",
        request: { documentId: "doc-4" },
        execute: async () => ({ status: "voided" }),
        rivalWaitBudgetMs: 120,
      }),
      (error: unknown) =>
        error instanceof Error
        && (error as { code?: string }).code === "conflict"
        && /still in progress/.test(error.message),
    );

    gate.openRelease();
    const leaderOutcome = await leader;
    assert.equal(leaderOutcome.replayed, false);

    const replayAfterLeader = await h.executeIdempotent({
      context: h.context,
      operation: "documents.void",
      idempotencyKey: "budget-expiry-key",
      request: { documentId: "doc-4" },
      execute: async () => {
        throw new Error("must not run after completion");
      },
    });
    assert.equal(replayAfterLeader.replayed, true);
    assert.deepEqual(replayAfterLeader.value, { status: "voided" });
  } finally {
    await h.cleanup();
  }
});

test("a duplicate-key void storm stays exact-once and leaves the request pool responsive", { skip: !DB }, async () => {
  const h: IdempotencyHarness = await buildIdempotencyHarness();
  try {
    const documentId = await h.seedApprovedQuote("QUOTE-VOID-STORM-1");
    await h.seedSlowBeforeVoidScript(0.5);

    const K = 10;
    const t0 = Date.now();
    const burst = Promise.all(
      Array.from({ length: K }, () =>
        h.executeIdempotent({
          context: h.context,
          operation: "documents.void",
          idempotencyKey: "storm-same-key-all-clients",
          request: { documentId, action: "void" },
          execute: () =>
            h.requestDocumentVoid({
              documentId,
              orgId: h.org.orgId,
              actorId: h.actorId,
              reason: "Storm probe duplicate void request",
              reversalDate: h.org.date,
              source: "api",
            }),
        }),
      ),
    );

    // Unrelated traffic must stay responsive throughout the storm. Before the
    // fix, every duplicate pinned a pool client while blocked on the claimant,
    // so these canaries queued behind the entire void (~script duration).
    const canaryLatencies: number[] = [];
    let settled = false;
    (async () => {
      while (Date.now() - t0 < 30_000) {
        const started = Date.now();
        try {
          await h.pool.query("select 1 as canary");
          canaryLatencies.push(Date.now() - started);
        } catch {
          break;
        }
        if (settled) break;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    })();

    const outcomes = await burst;
    settled = true;

    assert.equal(outcomes.length, K);
    assert.equal(outcomes.filter((outcome) => !outcome.replayed).length, 1, "exactly one claimant executes");
    assert.equal(outcomes.filter((outcome) => outcome.replayed).length, K - 1, "every duplicate replays");
    assert.ok(outcomes.every((outcome) => outcome.value.status === "voided"));

    assert.ok(canaryLatencies.length >= 3, "canaries sampled during the storm");
    const worstCanary = Math.max(...canaryLatencies);
    assert.ok(
      worstCanary < 250,
      `unrelated queries must not queue behind void duplicates (worst canary ${worstCanary}ms)`,
    );

    const status = await h.db.execute<{ status: string; void_requested_at: Date | null }>(h.sql`
      select status, void_requested_at from documents where id = ${documentId}
    `);
    assert.deepEqual(status.rows[0], { status: "voided", void_requested_at: null });
    assert.equal(
      await h.countRows(h.sql`
        select count(*)::int as count
          from audit_log
         where org_id = ${h.org.orgId}
           and table_name = 'documents'
           and row_id = ${documentId}
           and changes->>'mode' = 'void_request'
      `),
      1,
      "the storm commits exactly one durable void request",
    );
  } finally {
    await h.cleanup();
  }
});
