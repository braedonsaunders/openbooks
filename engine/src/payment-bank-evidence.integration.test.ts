import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { db, pool, withBypass } from "./db.ts";
import {
  generatePaymentFileArtifact,
  recordPaymentFileDownload,
} from "./payment-operations.ts";
import {
  encryptAccountNumber,
  loadCpa005RunFile,
  loadNachaRunFile,
  loadSepaRunFile,
  paymentRunReadiness,
  type RailBankMethod,
} from "./payments.ts";
import { sealJson } from "./secrets.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// ---------------------------------------------------------------------------
// Fixtures.
//
// One scratch org hosts one APPROVED payee bank account per rail. The
// "pending edit" below mirrors exactly what the bank-accounts PATCH route
// writes on a material change (new routing/account envelope + approval reset),
// so every assertion exercises the same row shape production produces.
// ---------------------------------------------------------------------------

const RAIL_BY_METHOD: Record<RailBankMethod, string> = {
  ach: "nacha_credit",
  sepa: "sepa_credit",
  eft: "cpa005_credit",
};

const ORIGINATOR_SECRETS: Record<RailBankMethod, Record<string, string>> = {
  ach: {
    odfiRouting: "021000021",
    immediateDestination: " 021000021",
    immediateOrigin: " 021000021",
    destinationName: "FIRST DESTINATION BANK",
    originName: "ORIGINATOR CO",
    companyName: "ORIGINATOR CO",
    companyId: "1234567890",
    entryDescription: "PAYMENT",
  },
  sepa: {
    originatorName: "Originator Co",
    originatorIban: "NL91ABNA0417164300",
    originatorBic: "ABNANL2AXXX",
  },
  eft: {
    originatorId: "ORIG123456",
    originatorShortName: "ORIG CO",
    originatorLongName: "The Originator Company Ltd",
    dataCentre: "12345",
    originatingDataCentre: "67890",
    institution: "123",
    transit: "45678",
    account: "111222333",
  },
};

/** Approved revision A — what the run and its instruction are built against. */
const APPROVED_A: Record<RailBankMethod, { routing: Record<string, string>; account: string; marker: string }> = {
  ach: { routing: { aba: "021000021", accountType: "checking" }, account: "111222333", marker: "111222333" },
  sepa: { routing: { iban: "DE89370400440532013000", bic: "COBADEFFXXX" }, account: "DE89370400440532013000", marker: "DE89370400440532013000" },
  eft: { routing: { institution: "123", transit: "45678" }, account: "999888777", marker: "999888777" },
};

/** Pending revision B — the fraud attempt: unapproved details that must never export. */
const PENDING_B: Record<RailBankMethod, { routing: Record<string, string>; account: string }> = {
  ach: { routing: { aba: "091000019", accountType: "checking" }, account: "777888999" },
  sepa: { routing: { iban: "FR1420041010050500013M02606", bic: "BNPAFRPPXXX" }, account: "FR1420041010050500013M02606" },
  eft: { routing: { institution: "987", transit: "54321" }, account: "555666777" },
};

interface RailFixture {
  method: RailBankMethod;
  actorId: string;
  runId: string;
  instructionId: string;
  accountId: string;
}

async function seedRailRun(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  method: RailBankMethod,
): Promise<RailFixture> {
  const actorId = await createScratchUser(org.orgId, "Payment Operator", "accountant");
  const formatId = randomUUID();
  const profileId = randomUUID();
  const runId = randomUUID();
  const instructionId = randomUUID();
  const accountId = randomUUID();

  await db.execute(sql`
    insert into payment_formats
      (id, org_id, code, name, rail, direction, country, currency, created_by, updated_by)
    values (${formatId}, ${org.orgId}, ${`BANK-EV-${method.toUpperCase()}-${runId.slice(0, 8)}`}, 'Bank evidence rail',
            ${RAIL_BY_METHOD[method]}, 'credit', 'CA', 'CAD', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into payment_bank_profiles
      (id, org_id, name, bank_account_id, payment_format_id, currency, country,
       originator_secrets_encrypted, require_run_approval, require_file_approval,
       is_active, created_by, updated_by)
    values (${profileId}, ${org.orgId}, ${`Bank evidence profile ${method} ${profileId.slice(0, 8)}`}, ${org.accounts.bank},
            ${formatId}, 'CAD', 'CA', ${sealJson(ORIGINATOR_SECRETS[method])},
            false, false, true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into party_bank_accounts
      (id, org_id, party_id, bank_name, country, currency, routing,
       account_number_encrypted, account_last_four,
       approval_status, is_active, approved_at, approved_by,
       submitted_by, submitted_at, created_by, updated_by)
    values (${accountId}, ${org.orgId}, ${org.vendorId}, 'Vendor Bank A', 'CA', 'CAD',
            ${JSON.stringify(APPROVED_A[method].routing)}::jsonb,
            ${encryptAccountNumber(APPROVED_A[method].account)},
            ${APPROVED_A[method].account.slice(-4)},
            'approved', true, ${org.date}, ${actorId},
            ${actorId}, now(), ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into payment_runs
      (id, org_id, run_number, bank_account_id, method, status, scheduled_for,
       currency, payment_bank_profile_id, subsidiary_id, created_by, updated_by)
    values (${runId}, ${org.orgId}, ${`BANKEV-${runId.slice(0, 8)}`}, ${org.accounts.bank},
            ${method}, 'approved', ${org.date}, 'CAD', ${profileId}, ${org.subsidiaryId},
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into payment_instructions
      (id, org_id, payment_run_id, payee_party_id, payee_bank_account_id,
       amount, currency, status, created_by, updated_by)
    values (${instructionId}, ${org.orgId}, ${runId}, ${org.vendorId}, ${accountId},
            '100.00', 'CAD', 'approved', ${actorId}, ${actorId})`);

  return { method, actorId, runId, instructionId, accountId };
}

/** The exact material-edit write the parties.manage PATCH route performs. */
async function applyPendingBankDetailEdit(
  orgId: string,
  fixture: RailFixture,
): Promise<void> {
  const b = PENDING_B[fixture.method];
  await db.execute(sql`
    update party_bank_accounts set
      routing = ${JSON.stringify(b.routing)}::jsonb,
      account_number_encrypted = ${encryptAccountNumber(b.account)},
      account_last_four = ${b.account.slice(-4)},
      approval_status = 'pending', is_active = false, approved_at = null, approved_by = null,
      submitted_by = ${fixture.actorId}, submitted_at = now(),
      updated_at = now(), updated_by = ${fixture.actorId}
    where id = ${fixture.accountId} and org_id = ${orgId}
  `);
}

/** Re-approve the edited revision B as an independent checker would. */
async function approveCurrentRevision(
  orgId: string,
  accountId: string,
  approverId: string,
): Promise<void> {
  await db.execute(sql`
    update party_bank_accounts set
      approval_status = 'approved', is_active = true, approved_at = current_date,
      approved_by = ${approverId}
     where id = ${accountId} and org_id = ${orgId}
  `);
}

/**
 * Hold OPEN (uncommitted) the exact UPDATE the PATCH route performs, so the
 * holder owns the party_bank_accounts row lock while an export is attempted.
 * The returned release is idempotent and either rolls back (export must then
 * win the race and carry the approved revision) or commits (the export must
 * hard-block).
 */
async function beginUncommittedBankEdit(
  orgId: string,
  fixture: RailFixture,
): Promise<{ pid: number; rollback: () => Promise<void>; commit: () => Promise<void> }> {
  const client: PoolClient = await pool.connect();
  await client.query("begin");
  await client.query("select set_config('app.bypass_rls', 'on', true)");
  const b = PENDING_B[fixture.method];
  await client.query(
    `update party_bank_accounts set
       routing = $1::jsonb,
       account_number_encrypted = $2,
       approval_status = 'pending', is_active = false, approved_at = null
      where id = $3 and org_id = $4`,
    [JSON.stringify(b.routing), encryptAccountNumber(b.account), fixture.accountId, orgId],
  );
  const pid = Number((await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid);
  let released = false;
  const finish = (verb: "rollback" | "commit") => async () => {
    if (released) return;
    released = true;
    try {
      await client.query(verb);
    } finally {
      client.release();
    }
  };
  return { pid, rollback: finish("rollback"), commit: finish("commit") };
}

/** Poll until some session is blocked by `blockerPid`, proving real contention. */
async function waitForBlockedBy(blockerPid: number, minimum = 1): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const blocked = await withBypass(() => db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from pg_stat_activity activity
       where ${blockerPid} = any(pg_blocking_pids(activity.pid))
    `));
    if ((blocked.rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for a query blocked by backend ${blockerPid}`);
}

function railLoader(method: RailBankMethod): (runId: string, orgId: string) => Promise<{ content: string; filename: string }> {
  if (method === "ach") return (runId, orgId) => loadNachaRunFile(runId, orgId);
  if (method === "sepa") return (runId, orgId) => loadSepaRunFile(runId, orgId, new Date());
  return (runId, orgId) => loadCpa005RunFile(runId, orgId);
}

/**
 * The generic scratch-org wipe clears file_versions/file_blobs before its
 * table passes reach payment_files, whose FK then blocks the version delete.
 * These artifact rows are this suite's own creation — clear them first.
 */
async function dropScratchOrgWithPaymentArtifacts(orgId: string): Promise<void> {
  // Same trusted-wipe contract the shared teardown uses: sandbox flag plus
  // the append-only-evidence bypass GUCs, so the artifact rows this suite
  // created (payment_events → payment_files → file_versions) can be cleared
  // before the generic passes reach them in FK-hostile order.
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      select set_config('openbooks.amend', 'on', true),
             set_config('openbooks.sandbox_wipe', 'on', true),
             set_config('app.bypass_rls', 'on', true)`);
    await tx.execute(sql`update orgs set env_kind = 'sandbox' where id = ${orgId} and name like 'Scratch %'`);
    await tx.execute(sql`delete from payment_file_deliveries where org_id = ${orgId}`);
    await tx.execute(sql`delete from payment_events where org_id = ${orgId}`);
    await tx.execute(sql`delete from payment_files where org_id = ${orgId}`);
  });
  await dropScratchOrgReporting(orgId);
}

test("payment files export only approved bank details on ACH, SEPA and EFT", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const fixtures = [] as RailFixture[];
    for (const method of ["ach", "sepa", "eft"] as RailBankMethod[]) {
      fixtures.push(await withBypass(() => seedRailRun(org, method)));
    }

    for (const fixture of fixtures) {
      const loader = railLoader(fixture.method);

      // The approved revision exports, carrying ONLY bank A's numbers.
      const file = await loader(fixture.runId, org.orgId);
      assert.match(file.content, new RegExp(APPROVED_A[fixture.method].marker));
      assert.doesNotMatch(file.content, new RegExp(PENDING_B[fixture.method].account));

      // A material edit re-enters approval exactly as the PATCH route does…
      await withBypass(() => applyPendingBankDetailEdit(org.orgId, fixture));
      const row = (await withBypass(() => db.execute<{ approvalStatus: string; isActive: boolean }>(sql`
        select approval_status as "approvalStatus", is_active as "isActive"
          from party_bank_accounts where id = ${fixture.accountId}
      `))).rows[0]!;
      assert.equal(row.approvalStatus, "pending");
      assert.equal(row.isActive, false);

      // …and the SAME rail now hard-blocks instead of exporting the pending
      // details. This is the regression: NACHA/SEPA previously exported the
      // unapproved edit and EFT raced it between readiness and build.
      await assert.rejects(
        () => loader(fixture.runId, org.orgId),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /bank account is not approved/);
          return true;
        },
      );

      // The run view agrees with the exporter because both speak through the
      // same shared control resolution.
      const readiness = await paymentRunReadiness(fixture.runId, org.orgId);
      const blocker = readiness.blockers.find((b) => b.instructionId === fixture.instructionId);
      assert.ok(blocker, "readiness must flag the unapproved revision");
      assert.equal(blocker.reason, "bank account is not approved");
      assert.equal(blocker.source, "bank");
    }
  } finally {
    await dropScratchOrgWithPaymentArtifacts(org.orgId);
  }
});

test("a concurrent maker edit can never steer an export: lock-first wins with approved details, edit-first blocks", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    for (const method of ["ach", "sepa", "eft"] as RailBankMethod[]) {
      const fixture = await withBypass(() => seedRailRun(org, method));
      const loader = railLoader(method);

      // Race 1 — the edit holds the row lock first. The export must really
      // CONTEND on that lock (not read a stale snapshot), and once the edit
      // rolls back, the export proceeds with the approved revision.
      const held = await beginUncommittedBankEdit(org.orgId, fixture);
      try {
        const racing = loader(fixture.runId, org.orgId).then(
          (file) => ({ ok: true as const, file }),
          (error) => ({ ok: false as const, error }),
        );
        await waitForBlockedBy(held.pid);
        await held.rollback();
        const outcome = await racing;
        assert.ok(outcome.ok, `${method}: export after losing the race should succeed, got ${outcome.ok ? "" : String(outcome.error)}`);
        assert.match(outcome.file.content, new RegExp(APPROVED_A[method].marker));
        assert.doesNotMatch(outcome.file.content, new RegExp(PENDING_B[method].account));
      } finally {
        await held.rollback();
      }

      // Race 2 — the edit COMMITS before the export locks. Only a hard block
      // is acceptable; exporting the pending details is the defect.
      const committedEdit = beginUncommittedBankEdit(org.orgId, fixture).then((h) => h.commit());
      await committedEdit;
      await assert.rejects(
        () => loader(fixture.runId, org.orgId),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /bank account is not approved/);
          assert.doesNotMatch(error.message, new RegExp(PENDING_B[method].account));
          return true;
        },
      );
    }
  } finally {
    await dropScratchOrgWithPaymentArtifacts(org.orgId);
  }
});

test("a blocked export writes no partial file and no partial audit, and delivery serves the locked-in evidence version", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const checkerId = await createScratchUser(org.orgId, "Independent Checker", "approver");

    // Run 1 generates successfully from the APPROVED revision.
    const good = await withBypass(() => seedRailRun(org, "ach"));
    const artifact = await generatePaymentFileArtifact(good.runId, org.orgId, good.actorId);
    assert.match(artifact.content.toString("utf8"), new RegExp(APPROVED_A.ach.marker));

    // The stored artifact binds to exactly those bytes.
    const storedBefore = (await withBypass(() => db.execute<{ contentHash: string; bytes: Buffer }>(sql`
      select pf.content_hash as "contentHash", fb.bytes
        from payment_files pf
        join file_versions fv on fv.id = pf.file_version_id and fv.file_id = pf.file_id
        join file_blobs fb on fb.version_id = fv.id
       where pf.payment_run_id = ${good.runId} and pf.org_id = ${org.orgId}
         and pf.id = ${artifact.id}
    `))).rows[0]!;
    assert.equal(storedBefore.contentHash, createHash("sha256").update(artifact.content).digest("hex"));

    // Run 2 shares the same bank account but has no artifact yet.
    const doomed = await withBypass(() => seedRailRun(org, "ach"));
    const countsBefore = (await withBypass(() => db.execute<{ files: number; events: number }>(sql`
      select
        (select count(*)::int from payment_files where payment_run_id = ${doomed.runId}) as files,
        (select count(*)::int from payment_events where payment_run_id = ${doomed.runId}) as events
    `))).rows[0]!;

    // Apply the pending edit, then attempt generation: rendering happens
    // BEFORE any artifact or event write, so the failure must leave zero rows.
    await withBypass(() => applyPendingBankDetailEdit(org.orgId, doomed));
    await assert.rejects(
      () => generatePaymentFileArtifact(doomed.runId, org.orgId, doomed.actorId),
      /bank account is not approved/,
    );
    const countsAfter = (await withBypass(() => db.execute<{ files: number; events: number; status: string; exportedFileRef: string | null }>(sql`
      select
        (select count(*)::int from payment_files where payment_run_id = ${doomed.runId}) as files,
        (select count(*)::int from payment_events where payment_run_id = ${doomed.runId}) as events,
        status,
        exported_file_ref as "exportedFileRef"
       from payment_runs where id = ${doomed.runId}
    `))).rows[0]!;
    assert.equal(countsAfter.files, countsBefore.files);
    assert.equal(countsAfter.events, countsBefore.events);
    assert.equal(countsAfter.status, "approved");
    assert.equal(countsAfter.exportedFileRef, null);

    // Meanwhile run 1's already-generated artifact is IMMUTABLE approved
    // evidence: even though the account row now holds pending B details,
    // download succeeds and serves byte-for-byte what was generated under the
    // approved-evidence lock — never the pending revision.
    await recordPaymentFileDownload(artifact.id, org.orgId, good.actorId);
    const delivered = (await withBypass(() => db.execute<{ status: string; bytes: Buffer; hash: string; deliveries: number }>(sql`
      select pf.status, fb.bytes, pf.content_hash as hash,
             (select count(*)::int from payment_file_deliveries d where d.payment_file_id = pf.id) as deliveries
        from payment_files pf
        join file_versions fv on fv.id = pf.file_version_id and fv.file_id = pf.file_id
        join file_blobs fb on fb.version_id = fv.id
       where pf.id = ${artifact.id} and pf.org_id = ${org.orgId}
    `))).rows[0]!;
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.deliveries >= 1, true);
    assert.equal(delivered.bytes.toString("utf8"), artifact.content.toString("utf8"));
    assert.doesNotMatch(delivered.bytes.toString("utf8"), new RegExp(PENDING_B.ach.account));

    // Once an independent checker approves revision B, the SAME rail may
    // legitimately export B — the control is approval state, not the values.
    // (Maker-checker itself is enforced upstream by the bank-account flow
    // gate's preventSelfApproval, untouched here.)
    await withBypass(() => approveCurrentRevision(org.orgId, doomed.accountId, checkerId));
    const regenerated = await generatePaymentFileArtifact(doomed.runId, org.orgId, doomed.actorId);
    assert.match(regenerated.content.toString("utf8"), new RegExp(PENDING_B.ach.account));
    assert.doesNotMatch(regenerated.content.toString("utf8"), new RegExp(APPROVED_A.ach.account));
  } finally {
    await dropScratchOrgWithPaymentArtifacts(org.orgId);
  }
});
