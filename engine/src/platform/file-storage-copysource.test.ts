import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CopyObjectCommand } from "@aws-sdk/client-s3";
import {
  createInMemoryFileBlobStore,
  encodeS3CopySource,
} from "./file-storage.ts";

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

test("every server-side copy in the engine shares the one helper", () => {
  const storage = readFileSync(new URL("./file-storage.ts", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../sftp/backend.ts", import.meta.url), "utf8");
  assert.match(storage, /CopySource: encodeS3CopySource\(/);
  assert.match(backend, /CopySource: encodeS3CopySource\(/);
  assert.doesNotMatch(storage, /CopySource: `\$\{/);
  assert.doesNotMatch(backend, /CopySource: `\$\{/);
});
