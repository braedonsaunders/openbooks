import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test, { before } from "node:test";
import { sql } from "drizzle-orm";

// The storage backend resolves its data root from the engine env snapshot
// (taken when db.ts first loads), so hand that snapshot a throwaway directory
// before seeding any published files.
const scratchDataDir = mkdtempSync(join(tmpdir(), "openbooks-sftp-delIVERY-claim-"));
const { env } = await import("../platform/db.ts");
env.OPENBOOKS_DATA_DIR = scratchDataDir;

const {
  claimPaymentFileDelivery,
  generatePaymentFileArtifact,
  markDeliveryUncertain,
  reclaimExpiredDeliveryClaims,
  releaseDeliveryClaim,
  resolveUncertainDelivery,
  rollbackPaymentRun,
  recordPaymentFileSftpDelivery,
} = await import("./operations.ts");
const { PaymentError } = await import("./payment-errors.ts");
const { deliverRunToSftp } = await import("../sftp/import-job.ts");
const { db, pool, withBypass, withOrgContext } = await import("../platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("../testing/fixtures.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const migration0290 = readFileSync(
  "schema/migrations/generated/0290_payment_file_delivery_claim.sql",
  "utf8",
);

before(async () => {
  if (!DB) return;
  const client = await pool.connect();
  try {
    await client.query(migration0290);
  } finally {
    client.release();
  }
});

interface DeliveryFixture {
  orgId: string;
  actorId: string;
  runId: string;
  profileId: string;
  serverId: string;
  rootPrefix: string;
}

async function seedDeliveryFixture(): Promise<DeliveryFixture> {
  const leased = await withBypass(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Delivery Operator", "admin");
    return { org, actorId };
  });
  const { org, actorId } = leased;
  const formatId = randomUUID();
  const profileId = randomUUID();
  const runId = randomUUID();
  const instructionId = randomUUID();
  const serverId = randomUUID();
  const rootPrefix = `sftp/${org.orgId}/delivery-${randomUUID()}`;
  await withOrgContext(org.orgId, async () => {
    await db.execute(sql`
      insert into payment_formats
        (id, org_id, code, name, rail, direction, file_extension, content_type,
         created_by, updated_by)
      values (${formatId}, ${org.orgId}, ${`WIRE-${formatId.slice(0, 8)}`},
              'Delivery claim wire', 'wire', 'credit', 'csv', 'text/csv',
              ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into sftp_servers (id, org_id, name, username, backend, bucket, root_prefix, is_active, created_by)
      values (${serverId}, ${org.orgId}, 'Delivery bank', ${`delivery-${serverId.slice(0, 8)}`},
              'local', null, ${rootPrefix}, true, ${actorId})
    `);
    await db.execute(sql`
      insert into payment_bank_profiles
        (id, org_id, name, bank_account_id, payment_format_id, currency,
         require_run_approval, require_file_approval, sftp_server_id, sftp_folder,
         created_by, updated_by)
      values (${profileId}, ${org.orgId}, 'Delivery profile', ${org.accounts.bank},
              ${formatId}, 'CAD', false, false, ${serverId}, 'outbound',
              ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into payment_runs
        (id, org_id, run_number, bank_account_id, payment_bank_profile_id,
         subsidiary_id, method, direction, purpose, currency, status,
         payment_count, total_amount, created_by, updated_by)
      values (${runId}, ${org.orgId}, ${`DLV-RUN-${runId}`}, ${org.accounts.bank},
              ${profileId}, ${org.subsidiaryId}, 'wire', 'outbound', 'vendor_payments',
              'CAD', 'approved', 1, '25', ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into payment_instructions
        (id, org_id, payment_run_id, payee_party_id, amount, currency, status,
         created_by, updated_by)
      values (${instructionId}, ${org.orgId}, ${runId}, ${org.vendorId},
              '25', 'CAD', 'pending', ${actorId}, ${actorId})
    `);
  });
  return { orgId: org.orgId, actorId, runId, profileId, serverId, rootPrefix };
}

async function teardown(fixture: DeliveryFixture): Promise<void> {
  // The scratch-org teardown does not know about payment artifacts; drop
  // them first (evidence before files, deliveries before the files they
  // reference), mirroring payments.integration.test.ts.
  await withBypass(() => db.transaction(async (tx) => {
    await tx.execute(sql`
      select set_config('openbooks.amend', 'on', true),
             set_config('openbooks.sandbox_wipe', 'on', true),
             set_config('app.bypass_rls', 'on', true)`);
    await tx.execute(sql`update orgs set env_kind = 'sandbox' where id = ${fixture.orgId} and name like 'Scratch %'`);
    await tx.execute(sql`delete from payment_events where org_id = ${fixture.orgId} and payment_file_id is not null`);
    await tx.execute(sql`delete from payment_file_deliveries where org_id = ${fixture.orgId}`);
    await tx.execute(sql`delete from payment_files where org_id = ${fixture.orgId}`);
  }));
  await withBypass(() => dropScratchOrg(fixture.orgId));
}

async function fileState(fixture: DeliveryFixture, fileId: string) {
  return withOrgContext(fixture.orgId, async () =>
    (await db.execute<{ status: string; delivery_claim_token: string | null; delivery_claim_owner: string | null }>(sql`
      select status, delivery_claim_token, delivery_claim_owner from payment_files where id = ${fileId}
    `)).rows[0]!,
  );
}

async function generateApprovedFile(fixture: DeliveryFixture) {
  return withOrgContext(fixture.orgId, () =>
    generatePaymentFileArtifact(fixture.runId, fixture.orgId, fixture.actorId),
  );
}

test("a voided file cannot be claimed, so a raced delivery never publishes", { skip: !DB }, async () => {
  const fixture = await seedDeliveryFixture();
  try {
    const file = await generateApprovedFile(fixture);
    await withOrgContext(fixture.orgId, () =>
      rollbackPaymentRun(fixture.runId, fixture.orgId, fixture.actorId, "void before delivery"),
    );
    // RED before the fix: delivery checked approval with a plain SELECT and
    // published anyway; the claim now refuses on the voided state.
    await assert.rejects(
      withOrgContext(fixture.orgId, () =>
        claimPaymentFileDelivery({ fileId: file.id, orgId: fixture.orgId, userId: fixture.actorId, owner: "sftp:test" }),
      ),
      (e: unknown) => e instanceof PaymentError && /voided/.test(e.message),
    );
    assert.equal((await fileState(fixture, file.id)).status, "voided");
    const deliveries = await withOrgContext(fixture.orgId, async () =>
      (await db.execute<{ n: number }>(sql`select count(*)::int as n from payment_file_deliveries where payment_file_id = ${file.id}`)).rows[0]!.n,
    );
    assert.equal(deliveries, 0);
  } finally {
    await teardown(fixture);
  }
});

test("a claim blocks the void; releasing the claim unblocks it", { skip: !DB }, async () => {
  const fixture = await seedDeliveryFixture();
  try {
    const file = await generateApprovedFile(fixture);
    const claim = await withOrgContext(fixture.orgId, () =>
      claimPaymentFileDelivery({ fileId: file.id, orgId: fixture.orgId, userId: fixture.actorId, owner: "sftp:test" }),
    );
    assert.equal((await fileState(fixture, file.id)).status, "delivering");
    // Second claimant names the owner instead of publishing over it.
    await assert.rejects(
      withOrgContext(fixture.orgId, () =>
        claimPaymentFileDelivery({ fileId: file.id, orgId: fixture.orgId, userId: fixture.actorId, owner: "sftp:other" }),
      ),
      (e: unknown) => e instanceof PaymentError && /sftp:test/.test(e.message),
    );
    // The void refuses while the claim is held (claim first → void refused).
    await assert.rejects(
      withOrgContext(fixture.orgId, () =>
        rollbackPaymentRun(fixture.runId, fixture.orgId, fixture.actorId, "race the delivery"),
      ),
      (e: unknown) => e instanceof PaymentError && /in-flight SFTP delivery/.test(e.message),
    );
    await withOrgContext(fixture.orgId, () =>
      releaseDeliveryClaim({ fileId: file.id, orgId: fixture.orgId, userId: fixture.actorId, token: claim.token }),
    );
    assert.equal((await fileState(fixture, file.id)).status, "approved");
    await withOrgContext(fixture.orgId, () =>
      rollbackPaymentRun(fixture.runId, fixture.orgId, fixture.actorId, "void after release"),
    );
    assert.equal((await fileState(fixture, file.id)).status, "voided");
  } finally {
    await teardown(fixture);
  }
});

test("a supersede refuses while the delivery is claimed", { skip: !DB }, async () => {
  const fixture = await seedDeliveryFixture();
  try {
    const file = await generateApprovedFile(fixture);
    await withOrgContext(fixture.orgId, () =>
      claimPaymentFileDelivery({ fileId: file.id, orgId: fixture.orgId, userId: fixture.actorId, owner: "sftp:test" }),
    );
    await assert.rejects(
      withOrgContext(fixture.orgId, () =>
        generatePaymentFileArtifact(fixture.runId, fixture.orgId, fixture.actorId, { reprocessFileId: file.id }),
      ),
      (e: unknown) => e instanceof PaymentError && /delivery/.test(e.message),
    );
    assert.equal((await fileState(fixture, file.id)).status, "delivering");
  } finally {
    await teardown(fixture);
  }
});

test("a successful delivery publishes under the claim and records delivered", { skip: !DB }, async () => {
  const fixture = await seedDeliveryFixture();
  try {
    const now = new Date();
    const res = await withOrgContext(fixture.orgId, () =>
      deliverRunToSftp(fixture.runId, fixture.serverId, fixture.orgId, fixture.actorId, now),
    );
    assert.equal(res.path, `outbound/${res.filename}`);
    const onDisk = readFileSync(join(scratchDataDir, "sftp", fixture.rootPrefix, res.path));
    const file = await withOrgContext(fixture.orgId, async () =>
      (await db.execute<{ id: string; status: string }>(sql`
        select id, status from payment_files where payment_run_id = ${fixture.runId} and org_id = ${fixture.orgId}
      `)).rows[0]!,
    );
    assert.equal(file.status, "delivered");
    assert.deepEqual(onDisk.subarray(0, 9).toString("utf8"), "reference");
    const delivery = await withOrgContext(fixture.orgId, async () =>
      (await db.execute<{ status: string; target_ref: string }>(sql`
        select status, target_ref from payment_file_deliveries where payment_file_id = ${file.id}
      `)).rows[0]!,
    );
    assert.equal(delivery.status, "delivered");
    assert.equal(delivery.target_ref, `${fixture.serverId}:${res.path}`);
    const run = await withOrgContext(fixture.orgId, async () =>
      (await db.execute<{ status: string }>(sql`select status from payment_runs where id = ${fixture.runId}`)).rows[0]!,
    );
    assert.equal(run.status, "delivered");
  } finally {
    await teardown(fixture);
  }
});

test("a failed write releases the claim and records the failure", { skip: !DB }, async () => {
  const fixture = await seedDeliveryFixture();
  try {
    // Plant a regular file where the outbound folder must be: staging the
    // publish underneath it fails deterministically.
    const rootDir = join(scratchDataDir, "sftp", fixture.rootPrefix);
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(join(rootDir, "blocked"), Buffer.from("in the way"));
    await withOrgContext(fixture.orgId, async () =>
      db.execute(sql`update payment_bank_profiles set sftp_folder = 'blocked' where id = ${fixture.profileId}`),
    );
    await assert.rejects(
      withOrgContext(fixture.orgId, () =>
        deliverRunToSftp(fixture.runId, fixture.serverId, fixture.orgId, fixture.actorId, new Date()),
      ),
    );
    const file = await withOrgContext(fixture.orgId, async () =>
      (await db.execute<{ id: string; status: string; delivery_claim_token: string | null }>(sql`
        select id, status, delivery_claim_token from payment_files where payment_run_id = ${fixture.runId}
      `)).rows[0]!,
    );
    // Nothing published, so the claim is released: the file is deliverable again.
    assert.equal(file.status, "approved");
    assert.equal(file.delivery_claim_token, null);
    const failure = await withOrgContext(fixture.orgId, async () =>
      (await db.execute<{ status: string; channel: string }>(sql`
        select status, channel from payment_file_deliveries where payment_file_id = ${file.id}
      `)).rows[0]!,
    );
    assert.deepEqual(failure, { status: "failed", channel: "sftp" });
  } finally {
    await teardown(fixture);
  }
});

test("a failed record after publish parks the file uncertain — never undelivered", { skip: !DB }, async () => {
  const fixture = await seedDeliveryFixture();
  const trigger = `sftp_delivery_claim_record_failure_${process.pid}`;
  try {
    // Force every record commit to fail AFTER the bytes publish: the
    // delivery must still be recorded as published (uncertain), never as
    // undelivered, and re-delivery must block.
    await withBypass(() =>
      db.execute(sql.raw(`
        create function public."${trigger}"() returns trigger language plpgsql as $$
        begin
          -- Break only the record step (delivering -> delivered under the
          -- claim); the uncertain park and the operator resolution below
          -- must still commit.
          if old.status = 'delivering' and new.status = 'delivered' then raise exception 'forced delivery record failure'; end if;
          return new;
        end $$;
        create trigger "${trigger}_trg" before update on payment_files
          for each row execute function public."${trigger}"();
      `)),
    );
    const res = await withOrgContext(fixture.orgId, () =>
      deliverRunToSftp(fixture.runId, fixture.serverId, fixture.orgId, fixture.actorId, new Date()).then(
        () => { throw new Error("delivery should have failed to record"); },
        (e: unknown) => e,
      ),
    );
    assert.match((res as Error).message, /delivery-uncertain/);
    const file = await withOrgContext(fixture.orgId, async () =>
      (await db.execute<{ id: string; status: string; delivery_claim_owner: string | null }>(sql`
        select id, status, delivery_claim_owner from payment_files where payment_run_id = ${fixture.runId}
      `)).rows[0]!,
    );
    assert.equal(file.status, "delivery_uncertain");
    // The bytes ARE on the endpoint even though no delivered record exists.
    const listed = await withOrgContext(fixture.orgId, async () =>
      deliverRunToSftp(fixture.runId, fixture.serverId, fixture.orgId, fixture.actorId, new Date()).then(
        () => { throw new Error("re-delivery of an uncertain file must refuse"); },
        (e: unknown) => e,
      ),
    );
    assert.match((listed as Error).message, /uncertain/);
    // Operator recovery with a reason: confirm the bank has the file.
    await assert.rejects(
      withOrgContext(fixture.orgId, () =>
        resolveUncertainDelivery({ fileId: file.id, orgId: fixture.orgId, userId: fixture.actorId, outcome: "delivered", reason: "  " }),
      ),
      (e: unknown) => e instanceof PaymentError && /requires a reason/.test(e.message),
    );
    await withOrgContext(fixture.orgId, () =>
      resolveUncertainDelivery({ fileId: file.id, orgId: fixture.orgId, userId: fixture.actorId, outcome: "delivered", reason: "bank confirmed receipt by phone" }),
    );
    assert.equal((await fileState(fixture, file.id)).status, "delivered");
  } finally {
    await withBypass(() =>
      db.execute(sql.raw(`drop trigger if exists "${trigger}_trg" on payment_files; drop function if exists public."${trigger}"();`)),
    );
    await teardown(fixture);
  }
});

test("an expired lease reclaims to uncertain and never silently republishes", { skip: !DB }, async () => {
  const fixture = await seedDeliveryFixture();
  try {
    const file = await generateApprovedFile(fixture);
    // A crashed worker: claim with a 1s lease, then age it past expiry.
    await withOrgContext(fixture.orgId, () =>
      claimPaymentFileDelivery({ fileId: file.id, orgId: fixture.orgId, userId: fixture.actorId, owner: "sftp:crashed", ttlSeconds: 1 }),
    );
    await withOrgContext(fixture.orgId, async () =>
      db.execute(sql`update payment_files set delivery_claim_expires_at = now() - interval '1 minute' where id = ${file.id}`),
    );
    const reclaimed = await withOrgContext(fixture.orgId, () =>
      reclaimExpiredDeliveryClaims({ orgId: fixture.orgId, userId: fixture.actorId }),
    );
    assert.deepEqual(reclaimed, [{ fileId: file.id, runId: fixture.runId }]);
    assert.equal((await fileState(fixture, file.id)).status, "delivery_uncertain");
    // Uncertain blocks the claim (no silent re-publish of bytes the bank
    // may already hold) and blocks the void (evidence must survive).
    await assert.rejects(
      withOrgContext(fixture.orgId, () =>
        claimPaymentFileDelivery({ fileId: file.id, orgId: fixture.orgId, userId: fixture.actorId, owner: "sftp:retry" }),
      ),
      (e: unknown) => e instanceof PaymentError && /uncertain/.test(e.message),
    );
    await assert.rejects(
      withOrgContext(fixture.orgId, () =>
        rollbackPaymentRun(fixture.runId, fixture.orgId, fixture.actorId, "void the uncertain file"),
      ),
      (e: unknown) => e instanceof PaymentError && /in-flight SFTP delivery/.test(e.message),
    );
    // The operator verifies with the bank that nothing arrived, then
    // releases the file back to approved for a careful re-delivery.
    await withOrgContext(fixture.orgId, () =>
      resolveUncertainDelivery({ fileId: file.id, orgId: fixture.orgId, userId: fixture.actorId, outcome: "approved", reason: "bank confirms nothing arrived; safe to re-deliver" }),
    );
    assert.equal((await fileState(fixture, file.id)).status, "approved");
    const retry = await withOrgContext(fixture.orgId, () =>
      claimPaymentFileDelivery({ fileId: file.id, orgId: fixture.orgId, userId: fixture.actorId, owner: "sftp:retry" }),
    );
    assert.ok(retry.token);
    await withOrgContext(fixture.orgId, () =>
      markDeliveryUncertain({ fileId: file.id, orgId: fixture.orgId, userId: fixture.actorId, token: retry.token, error: "test cleanup" }),
    );
  } finally {
    await teardown(fixture);
  }
});

test("recording against a lost claim refuses instead of inventing delivery", { skip: !DB }, async () => {
  const fixture = await seedDeliveryFixture();
  try {
    const file = await generateApprovedFile(fixture);
    await assert.rejects(
      withOrgContext(fixture.orgId, () =>
        recordPaymentFileSftpDelivery({ fileId: file.id, orgId: fixture.orgId, userId: fixture.actorId, targetRef: "sftp:nowhere", claimToken: randomUUID() }),
      ),
      (e: unknown) => e instanceof PaymentError && /lost claim|not approved|delivering/.test(e.message),
    );
    assert.equal((await fileState(fixture, file.id)).status, "approved");
  } finally {
    await teardown(fixture);
  }
});

test.after(() => {
  rmSync(scratchDataDir, { recursive: true, force: true });
});
