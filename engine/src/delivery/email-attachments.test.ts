import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { isEmailAttachmentRef } from "@openbooks/emails";
import {
  deleteStoredEmailAttachments,
  loadEmailAttachments,
  storeEmailAttachments,
} from "./email-attachments.ts";

const priorDataKey = process.env.OPENBOOKS_DATA_KEY;

before(() => {
  process.env.OPENBOOKS_DATA_KEY = "00".repeat(32);
});

after(() => {
  if (priorDataKey === undefined) delete process.env.OPENBOOKS_DATA_KEY;
  else process.env.OPENBOOKS_DATA_KEY = priorDataKey;
});

const payload = (content: string) => ({
  filename: "pay-stub.pdf",
  content: Buffer.from(content).toString("base64"),
  contentType: "application/pdf",
});

test("stored attachments carry references, never file bytes", async () => {
  // Unit processes have no object storage configured, so this exercises the
  // sealed fallback; the object-storage branch differs only in where the
  // bytes land, which the integration test covers through dispatch.
  const stored = await storeEmailAttachments([payload("stub-bytes")]);
  assert.equal(stored.length, 1);
  const ref = stored[0]!;
  assert.ok(isEmailAttachmentRef(ref));
  assert.ok(!("content" in ref), "no file bytes may remain on the queue payload");
  assert.equal(ref.filename, "pay-stub.pdf");

  const loaded = await loadEmailAttachments(stored);
  assert.deepEqual(loaded, [payload("stub-bytes")]);
});

test("storing validates before anything is staged", async () => {
  await assert.rejects(
    storeEmailAttachments([{ filename: "x.pdf", content: "!!!not-base64!!!", contentType: "application/pdf" }]),
    /bounded base64/,
  );
  await assert.rejects(
    storeEmailAttachments([{ filename: "../evil.pdf", content: "eA==", contentType: "application/pdf" }]),
    /invalid filename/,
  );
  await assert.rejects(
    storeEmailAttachments(Array.from({ length: 11 }, () => payload("x"))),
    /exceeds the 10-attachment limit/,
  );
  assert.deepEqual(await storeEmailAttachments(undefined), []);
  assert.deepEqual(await storeEmailAttachments([]), []);
});

test("legacy inline payloads still drain exactly once", async () => {
  const loaded = await loadEmailAttachments([payload("old-job-bytes")]);
  assert.deepEqual(loaded, [payload("old-job-bytes")]);
  assert.deepEqual(await loadEmailAttachments(undefined), []);
});

test("an unresolvable reference refuses instead of sending a truncated message", async () => {
  await assert.rejects(
    loadEmailAttachments([{ filename: "x.pdf", contentType: "application/pdf", sealed: "enc:v1:bogus" }]),
    /cannot be unsealed/,
  );
  await assert.rejects(
    loadEmailAttachments([{ filename: "x.pdf", sealed: "" }]),
    /cannot be unsealed/,
  );
});

test("deleting without staged ids is a no-op", async () => {
  await deleteStoredEmailAttachments(undefined);
  await deleteStoredEmailAttachments([]);
  await deleteStoredEmailAttachments([{ filename: "x.pdf", sealed: "enc:v1:anything" }]);
});
