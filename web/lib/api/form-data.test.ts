import assert from "node:assert/strict";
import { test } from "node:test";

const { parseFormDataBody } = await import("./form-data");

const BOUNDARY = "----openbooks-test-boundary";

function multipartPayload(fileBytes: number): Uint8Array {
  const head =
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="folderId"\r\n\r\n` +
    `folder-1\r\n` +
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="receipt.pdf"\r\n` +
    `Content-Type: application/pdf\r\n\r\n`;
  const tail = `\r\n--${BOUNDARY}--\r\n`;
  return new TextEncoder().encode(head + "x".repeat(fileBytes) + tail);
}

/** A chunked upload with no declared length, so only the streamed cap applies. */
function streamedRequest(payload: Uint8Array, chunkSize = 1024): Request {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= payload.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(payload.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  const req = new Request("http://localhost/api/upload", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: stream as unknown as BodyInit,
    // @ts-expect-error undici streaming-upload opt-in
    duplex: "half",
  });
  assert.equal(req.headers.get("content-length"), null);
  return req;
}

test("a multipart body under the ceiling parses into its fields and file", async () => {
  const parsed = await parseFormDataBody(streamedRequest(multipartPayload(4096)), {
    maxBodyBytes: 8192,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.data.get("folderId"), "folder-1");
  const file = parsed.data.get("file");
  assert.ok(file instanceof File);
  assert.equal(file.name, "receipt.pdf");
  assert.equal(file.size, 4096);
});

test("a streamed multipart body past the ceiling is refused with 413 before it is fully read", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(1024).fill(120);
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk);
    },
  });
  const req = new Request("http://localhost/api/upload", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: endless as unknown as BodyInit,
    // @ts-expect-error undici streaming-upload opt-in
    duplex: "half",
  });
  const parsed = await parseFormDataBody(req, { maxBodyBytes: 8192 });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.response.status, 413);
  const body = (await parsed.response.json()) as { error: string };
  assert.equal(body.error, "request body exceeds the 8 KiB limit");
  // The endless body would never finish; refusal means reading stopped near the cap.
  assert.ok(pulled < 32, `read ${pulled} chunks past an 8 KiB cap`);
});

test("a lying content-length does not lift the streamed ceiling", async () => {
  const req = streamedRequest(multipartPayload(16 * 1024));
  req.headers.set("content-length", "100");
  const parsed = await parseFormDataBody(req, { maxBodyBytes: 8192 });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.response.status, 413);
});

test("an oversized declared length is refused with the route's own 413 body", async () => {
  const req = new Request("http://localhost/api/upload", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      "content-length": "1000000",
    },
    body: new ReadableStream<Uint8Array>({ pull() {} }) as unknown as BodyInit,
    // @ts-expect-error undici streaming-upload opt-in
    duplex: "half",
  });
  const parsed = await parseFormDataBody(req, {
    maxBodyBytes: 8192,
    tooLarge: { error: "file exceeds 25 MB limit" },
  });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.response.status, 413);
  assert.deepEqual(await parsed.response.json(), { error: "file exceeds 25 MB limit" });
});

test("a non-multipart or malformed body is a 400, not a size refusal", async () => {
  const json = new Request("http://localhost/api/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const notMultipart = await parseFormDataBody(json, { maxBodyBytes: 8192 });
  assert.equal(notMultipart.ok, false);
  if (!notMultipart.ok) assert.equal(notMultipart.response.status, 400);

  const truncated = new Request("http://localhost/api/upload", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"`,
  });
  const malformed = await parseFormDataBody(truncated, {
    maxBodyBytes: 8192,
    invalid: { error: "Choose a photo or PDF to attach." },
  });
  assert.equal(malformed.ok, false);
  if (malformed.ok) return;
  assert.equal(malformed.response.status, 400);
  assert.deepEqual(await malformed.response.json(), { error: "Choose a photo or PDF to attach." });
});
