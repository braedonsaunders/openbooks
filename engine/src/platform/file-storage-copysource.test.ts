import assert from "node:assert/strict";
import test from "node:test";
import { CopyObjectCommand } from "@aws-sdk/client-s3";
import {
  copyS3Blob,
  createInMemoryFileBlobStore,
  encodeS3CopySource,
  getS3Blob,
  s3Bucket,
  setFileBlobS3ClientForTests,
} from "./file-storage.ts";
import { createFakeS3, sentCopies } from "../sftp/fake-s3.ts";

test("encodeS3CopySource URL-encodes each key segment and preserves separators", () => {
  assert.equal(
    encodeS3CopySource("acme-bucket", "sftp/acme/Bank Statements/2024/Q1 #final?.pdf"),
    "acme-bucket/sftp/acme/Bank%20Statements/2024/Q1%20%23final%3F.pdf",
  );
  assert.equal(
    encodeS3CopySource("acme-bucket", "file-cabinet/a+b"),
    "acme-bucket/file-cabinet/a%2Bb",
  );
  assert.equal(
    encodeS3CopySource("acme-bucket", "sftp/acme/Zürich-contrat.pdf"),
    "acme-bucket/sftp/acme/Z%C3%BCrich-contrat.pdf",
  );
  assert.equal(
    encodeS3CopySource("acme-bucket", "plain/key.pdf"),
    "acme-bucket/plain/key.pdf",
  );
});

test("the serialized CopyObject request carries the encoded source", () => {
  const command = new CopyObjectCommand({
    Bucket: "acme-bucket",
    CopySource: encodeS3CopySource("acme-bucket", "sftp/acme/a b#c?.pdf"),
    Key: "sftp/acme/a b#c?.pdf",
  });
  assert.equal(command.input.CopySource, "acme-bucket/sftp/acme/a%20b%23c%3F.pdf");
  // The destination key is sent as a structured field, never encoded.
  assert.equal(command.input.Key, "sftp/acme/a b#c?.pdf");
});

test("a versioned blob copy round-trips its bytes", async () => {
  const store = createInMemoryFileBlobStore();
  const bytes = Buffer.from("%PDF-1.7\nversioned copy evidence");
  await store.putObject("v1", bytes, "application/pdf");
  await store.copyObject("v1", "v2");
  assert.deepEqual(await store.getObject("v2"), bytes);
  assert.deepEqual(await store.getObject("v1"), bytes);
  await store.deleteObjects(["v1", "v2"]);
  assert.equal(await store.getObject("v2"), null);
});

test("file-cabinet server-side copy sends an encoded source and preserves its bytes", async () => {
  const fake = createFakeS3();
  setFileBlobS3ClientForTests(fake.client);
  const sourceId = "v 1#";
  fake.objects.set(`file-cabinet/${sourceId}`, {
    bytes: Buffer.from("immutable file version"),
    lastModified: new Date("2026-01-01T00:00:00Z"),
  });
  try {
    await copyS3Blob(sourceId, "v2");

    assert.deepEqual(sentCopies(fake), [{
      CopySource: `${s3Bucket()}/file-cabinet/v%201%23`,
      Key: "file-cabinet/v2",
    }]);
    assert.deepEqual(await getS3Blob("v2"), Buffer.from("immutable file version"));
    assert.deepEqual(await getS3Blob(sourceId), Buffer.from("immutable file version"));
  } finally {
    setFileBlobS3ClientForTests(null);
  }
});
