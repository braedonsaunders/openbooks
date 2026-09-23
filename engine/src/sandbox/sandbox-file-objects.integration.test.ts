import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  copyS3Blob,
  createInMemoryFileBlobStore,
  deleteS3Blobs,
  getS3Blob,
  putS3Blob,
  setFileBlobStoreForTests,
} from "../platform/file-storage.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { copyClonedFileObjects } from "./clone.ts";
import { createSandbox, deleteSandbox, refreshSandbox } from "./lifecycle.ts";

/**
 * Attempt every teardown step even when one fails, then report all failures
 * together. A swallowed drop strands a scratch org (and its sandbox rows)
 * on the shared test database for the next shard to trip over.
 */
async function runTeardowns(...steps: Array<() => Promise<unknown>>): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "test teardown failed");
}

// D3: S3-backed attachments must survive an unmasked clone (objects copied to
// the rebased keys), must never be copied for masked clones (see D2), must be
// cleaned up when the copy fails, and must die with the sandbox on
// delete/refresh. The object store is the in-memory test driver behind the
// real put/get/copy/delete dispatch — no network, same interface.
// No skip guard: a DB-owned test that self-skips turns CI red, so these
// fail loud without a database instead of skipping silently.

async function seedS3File(orgId: string, storageKind: string): Promise<{
  fileId: string;
  versionId: string;
  bytes: Buffer;
}> {
  const folderId = randomUUID();
  const fileId = randomUUID();
  const versionId = randomUUID();
  const bytes = Buffer.from(`cabinet-bytes-${versionId}`);
  await db.execute(sql`insert into folders (id, org_id, name) values (${folderId}, ${orgId}, 'Cabinet')`);
  await db.execute(sql`insert into files (id, org_id, folder_id, name, content_type, size_bytes, storage_kind, content_hash)
    values (${fileId}, ${orgId}, ${folderId}, 'statement.pdf', 'application/pdf', ${bytes.length}, ${storageKind}, 'hash-s3')`);
  await db.execute(sql`insert into file_versions (id, file_id, version_number, size_bytes, content_type, storage_kind, content_hash)
    values (${versionId}, ${fileId}, 1, ${bytes.length}, 'application/pdf', ${storageKind}, 'hash-s3')`);
  return { fileId, versionId, bytes };
}

async function sandboxVersionId(sandboxOrgId: string): Promise<{ id: string; storage_kind: string }> {
  const rows = (await db.execute<{ id: string; storage_kind: string }>(sql`
    select fv.id, fv.storage_kind from file_versions fv
     join files f on f.id = fv.file_id where f.org_id = ${sandboxOrgId}`)).rows;
  assert.equal(rows.length, 1);
  return rows[0]!;
}

test("unmasked clone copies S3 objects to the rebased keys", async () => {
  const store = createInMemoryFileBlobStore();
  setFileBlobStoreForTests(store);
  const org = await createScratchOrg();
  let sandboxId: string | null = null;
  try {
    const seeded = await seedS3File(org.orgId, "s3");
    await putS3Blob(seeded.versionId, seeded.bytes, "application/pdf");

    const created = await createSandbox({
      productionOrgId: org.orgId,
      name: `S3 Files ${randomUUID()}`,
      tier: "full",
      masked: false,
    });
    sandboxId = created.sandboxId;

    const sbx = await sandboxVersionId(created.sandboxOrgId);
    assert.equal(sbx.storage_kind, "s3");
    assert.notEqual(sbx.id, seeded.versionId);
    const copied = await getS3Blob(sbx.id);
    assert.ok(copied, "sandbox row must resolve to a copied object, not a 404");
    assert.equal(Buffer.from(copied).toString(), seeded.bytes.toString());
    // Production object untouched.
    assert.equal((await getS3Blob(seeded.versionId))?.toString(), seeded.bytes.toString());

    // Refresh keeps the cabinet readable (same deterministic keys).
    await refreshSandbox(sandboxId);
    assert.equal((await getS3Blob((await sandboxVersionId(created.sandboxOrgId)).id))?.toString(), seeded.bytes.toString());

    // Delete removes the sandbox's objects and keeps production's.
    await deleteSandbox(sandboxId);
    sandboxId = null;
    assert.equal(await getS3Blob(sbx.id), null);
    assert.equal((await getS3Blob(seeded.versionId))?.toString(), seeded.bytes.toString());
  } finally {
    const sid = sandboxId;
    await runTeardowns(
      ...(sid ? [() => deleteSandbox(sid)] : []),
      () => dropScratchOrg(org.orgId),
    );
    setFileBlobStoreForTests(null);
  }
});

test("masked clone copies no S3 objects", async () => {
  const store = createInMemoryFileBlobStore();
  setFileBlobStoreForTests(store);
  const org = await createScratchOrg();
  let sandboxId: string | null = null;
  try {
    const seeded = await seedS3File(org.orgId, "s3");
    await putS3Blob(seeded.versionId, seeded.bytes, "application/pdf");
    const keysBefore = store.keys().sort();

    const created = await createSandbox({
      productionOrgId: org.orgId,
      name: `S3 Masked ${randomUUID()}`,
      tier: "full",
      masked: true,
    });
    sandboxId = created.sandboxId;

    assert.deepEqual(store.keys().sort(), keysBefore);
    const sbx = await sandboxVersionId(created.sandboxOrgId);
    assert.equal(sbx.storage_kind, "masked");
  } finally {
    const sid = sandboxId;
    await runTeardowns(
      ...(sid ? [() => deleteSandbox(sid)] : []),
      () => dropScratchOrg(org.orgId),
    );
    setFileBlobStoreForTests(null);
  }
});

test("failed object copy cleans up partial keys and reports the failure", async () => {
  const store = createInMemoryFileBlobStore();
  setFileBlobStoreForTests(store);
  const prod = await createScratchOrg();
  const sbx = await createScratchOrg();
  try {
    const seed = randomUUID();
    // Production S3 version row with NO object behind it (simulates the
    // object missing mid-clone); the sandbox holds its rebased row.
    const seeded = await seedS3File(prod.orgId, "s3");
    const rebased = (await db.execute<{ id: string }>(sql`
      select ob_rebase(${seeded.versionId}, ${seed}) as id`)).rows[0]!.id;
    const folderId = randomUUID();
    const fileId = randomUUID();
    await db.execute(sql`insert into folders (id, org_id, name) values (${folderId}, ${sbx.orgId}, 'Cabinet')`);
    await db.execute(sql`insert into files (id, org_id, folder_id, name, content_type, size_bytes, storage_kind, content_hash)
      values (${fileId}, ${sbx.orgId}, ${folderId}, 'statement.pdf', 'application/pdf', 8, 's3', 'hash-s3')`);
    await db.execute(sql`insert into file_versions (id, file_id, version_number, size_bytes, content_type, storage_kind, content_hash)
      values (${rebased}, ${fileId}, 1, 8, 'application/pdf', 's3', 'hash-s3')`);

    await assert.rejects(
      copyClonedFileObjects({ productionOrgId: prod.orgId, sandboxOrgId: sbx.orgId, seed }),
      /has no object for version/,
    );
    assert.deepEqual(store.keys(), [], "a failed copy must leave no partial objects");

    // The store healthy again: the same copy succeeds and resolves.
    await putS3Blob(seeded.versionId, seeded.bytes, "application/pdf");
    const result = await copyClonedFileObjects({ productionOrgId: prod.orgId, sandboxOrgId: sbx.orgId, seed });
    assert.equal(result.objectsCopied, 1);
    assert.equal((await getS3Blob(rebased))?.toString(), seeded.bytes.toString());

    // Direct dispatch sanity: copy + delete through the real functions.
    await copyS3Blob(rebased, seeded.versionId);
    await deleteS3Blobs([rebased]);
    assert.equal(await getS3Blob(rebased), null);
  } finally {
    await runTeardowns(
      () => dropScratchOrg(sbx.orgId),
      () => dropScratchOrg(prod.orgId),
    );
    setFileBlobStoreForTests(null);
  }
});
