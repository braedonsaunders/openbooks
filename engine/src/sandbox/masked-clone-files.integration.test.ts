import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  isMaskedFileContentError,
  MASKED_STORAGE_KIND,
  MaskedFileContentError,
  refuseMaskedStorageKind,
} from "../platform/file-storage.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";

// D2: a masked sandbox never receives production file bytes. The blob table
// is not copied at all and version/file rows carry the MASKED_STORAGE_KIND
// tombstone instead of 'db'/'s3'; every bytes-dispatch site must refuse the
// tombstone by name (never fall through to a bytea/S3 fetch).
// No skip guard: a DB-owned test that self-skips turns CI red, so these
// fail loud without a database instead of skipping silently.

test("refuseMaskedStorageKind throws the named refusal only for the tombstone", async () => {
  assert.throws(() => refuseMaskedStorageKind(MASKED_STORAGE_KIND), MaskedFileContentError);
  assert.throws(() => refuseMaskedStorageKind(MASKED_STORAGE_KIND), /re-upload the file here/);
  assert.doesNotThrow(() => refuseMaskedStorageKind("db"));
  assert.doesNotThrow(() => refuseMaskedStorageKind("s3"));
  assert.doesNotThrow(() => refuseMaskedStorageKind(null));
  assert.doesNotThrow(() => refuseMaskedStorageKind(undefined));
});

test("isMaskedFileContentError identifies the refusal across module graphs", async () => {
  assert.equal(isMaskedFileContentError(new MaskedFileContentError()), true);
  // The web layer may load the engine twice (workspace alias + relative
  // import), defeating instanceof — the stable error name still matches.
  assert.equal(isMaskedFileContentError({ name: "MaskedFileContentError", message: "x" }), true);
  assert.equal(isMaskedFileContentError(new Error("boom")), false);
  assert.equal(isMaskedFileContentError(null), false);
});

test("masked clone tombstones file rows and copies no bytes", async () => {
  const org = await createScratchOrg();
  let sandboxId: string | null = null;
  try {
    const folderId = randomUUID();
    const fileId = randomUUID();
    const versionId = randomUUID();
    await db.execute(sql`insert into folders (id, org_id, name) values (${folderId}, ${org.orgId}, 'Cabinet')`);
    await db.execute(sql`insert into files (id, org_id, folder_id, name, content_type, size_bytes, storage_kind, content_hash)
      values (${fileId}, ${org.orgId}, ${folderId}, 'contract.pdf', 'application/pdf', 17, 'db', 'prod-hash')`);
    await db.execute(sql`insert into file_versions (id, file_id, version_number, size_bytes, content_type, storage_kind, content_hash)
      values (${versionId}, ${fileId}, 1, 17, 'application/pdf', 'db', 'prod-hash')`);
    await db.execute(sql`insert into file_blobs (version_id, bytes) values (${versionId}, ${Buffer.from("production-bytes")})`);

    const created = await createSandbox({
      productionOrgId: org.orgId,
      name: `Masked Files ${randomUUID()}`,
      tier: "full",
      masked: true,
    });
    sandboxId = created.sandboxId;

    const sbxFiles = (await db.execute<{ storage_kind: string; name: string; content_hash: string }>(sql`
      select storage_kind, name, content_hash from files where org_id = ${created.sandboxOrgId}`)).rows;
    assert.equal(sbxFiles.length, 1);
    assert.equal(sbxFiles[0]!.storage_kind, MASKED_STORAGE_KIND);
    // Metadata stays browsable test data; only the bytes are tombstoned.
    assert.equal(sbxFiles[0]!.name, "contract.pdf");
    assert.equal(sbxFiles[0]!.content_hash, "prod-hash");

    const sbxVersions = (await db.execute<{ storage_kind: string }>(sql`
      select fv.storage_kind from file_versions fv join files f on f.id = fv.file_id
       where f.org_id = ${created.sandboxOrgId}`)).rows;
    assert.equal(sbxVersions.length, 1);
    assert.equal(sbxVersions[0]!.storage_kind, MASKED_STORAGE_KIND);

    const sbxBlobs = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from file_blobs fb
       where fb.version_id in (select fv.id from file_versions fv join files f on f.id = fv.file_id
                                where f.org_id = ${created.sandboxOrgId})`)).rows[0]!.n;
    assert.equal(sbxBlobs, 0, "masked clone must copy no file bytes");

    // The tombstoned row dispatches to the named refusal, never to a fetch.
    assert.throws(() => refuseMaskedStorageKind(sbxVersions[0]!.storage_kind), /masked sandboxes never receive/);

    // Production bytes are untouched by the clone.
    const prodBlobs = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from file_blobs where version_id = ${versionId}`)).rows[0]!.n;
    assert.equal(prodBlobs, 1);
  } finally {
    if (sandboxId) await deleteSandbox(sandboxId).catch(() => undefined);
    await dropScratchOrg(org.orgId);
  }
});
