import assert from "node:assert/strict";
import test from "node:test";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  FileBlobDeleteError,
  deleteS3Blobs,
  setFileBlobS3ClientForTests,
} from "./file-storage.ts";
import { createFakeS3, sentDeletes } from "../sftp/fake-s3.ts";

// C-45: the S3 blob driver swallowed every delete failure (transport errors
// caught and logged; per-key Errors in the 200 response never inspected) and
// resolved as success — operators watched rows vanish while bytes stayed in
// the bucket. These tests drive the real s3Store through the transport seam
// (mirrors setSftpS3ClientForTests): only the network is doubled.
test.after(() => {
  setFileBlobS3ClientForTests(null);
});

function storeKey(versionId: string): string {
  return `file-cabinet/${versionId}`;
}

function seed(fake: { objects: Map<string, { bytes: Buffer; lastModified: Date }> }, versionIds: string[]): void {
  for (const id of versionIds) {
    fake.objects.set(storeKey(id), { bytes: Buffer.from(`bytes-${id}`), lastModified: new Date() });
  }
}

test("a transport failure rejects with every unconfirmed version named", async () => {
  const transportFailure = Object.assign(new Error("ServiceUnavailable"), { name: "ServiceUnavailable" });
  setFileBlobS3ClientForTests({ send: async () => { throw transportFailure; } } as unknown as S3Client);
  const failure = await deleteS3Blobs(["v1", "v2"]).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof FileBlobDeleteError, `expected a named delete refusal, got ${String(failure)}`);
  assert.deepEqual([...failure.versionIds].sort(), ["v1", "v2"]);
  assert.match(failure.message, /ServiceUnavailable/, "the cause must be diagnosable from the message");
  assert.match(failure.message, /retry/i, "the refusal must name the remedy");
});

test("per-key errors reject with only the failed versions named", async () => {
  const fake = createFakeS3({ refuseDeleteKeys: new Set([storeKey("bad")]) });
  seed(fake, ["good", "bad"]);
  setFileBlobS3ClientForTests(fake.client);
  const failure = await deleteS3Blobs(["good", "bad"]).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof FileBlobDeleteError, `expected a named delete refusal, got ${String(failure)}`);
  assert.deepEqual([...failure.versionIds], ["bad"]);
  // The refused bytes stay; the confirmed ones are gone — the refusal's set
  // is exactly the retry set.
  assert.ok(fake.objects.has(storeKey("bad")), "a refused blob must still be stored");
  assert.ok(!fake.objects.has(storeKey("good")), "a confirmed blob must be deleted");
});

test("a clean delete resolves and removes every blob", async () => {
  const fake = createFakeS3();
  seed(fake, ["v1", "v2"]);
  setFileBlobS3ClientForTests(fake.client);
  await deleteS3Blobs(["v1", "v2"]);
  assert.equal(fake.objects.size, 0);
});

test("deletes still chunk at 1,000 keys per request", async () => {
  const fake = createFakeS3();
  const ids = Array.from({ length: 1_001 }, (_, index) => `v${index}`);
  seed(fake, ids);
  setFileBlobS3ClientForTests(fake.client);
  await deleteS3Blobs(ids);
  const batches = sentDeletes(fake);
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.length, 1_000);
  assert.equal(batches[1]!.length, 1);
  assert.equal(fake.objects.size, 0);
});
