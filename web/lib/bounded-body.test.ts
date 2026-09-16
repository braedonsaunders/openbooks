import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedBodyText } from "./bounded-body";

function chunkedRequest(chunk: string, repeats: number): Request {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= repeats) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new TextEncoder().encode(chunk));
    },
  });
  const req = new Request("http://localhost/inbound", {
    method: "POST",
    body: stream as unknown as BodyInit,
    // @ts-expect-error undici streaming-upload opt-in
    duplex: "half",
  });
  // A streamed upload must not carry a declared length — otherwise the test
  // would exercise the header fast path instead of the streaming cap.
  assert.equal(req.headers.get("content-length"), null);
  return req;
}

test("a chunked body past a small cap is refused without buffering it", async () => {
  const result = await readBoundedBodyText(chunkedRequest("x".repeat(1024), 100), 1024);
  assert.deepEqual(result, { ok: false, reason: "too_large" });
});

test("a chunked body under the cap streams through exactly", async () => {
  const result = await readBoundedBodyText(chunkedRequest("hello ", 3), 1024);
  assert.deepEqual(result, { ok: true, text: "hello hello hello " });
});

test("a lying content-length (small header, large body) is still capped", async () => {
  const req = chunkedRequest("y".repeat(1024), 100);
  req.headers.set("content-length", "10");
  const result = await readBoundedBodyText(req, 1024);
  assert.deepEqual(result, { ok: false, reason: "too_large" });
});

test("an oversized declared length is refused without waiting on the body", async () => {
  // A stream that never yields: if the reader waited on the body, this hangs.
  const stream = new ReadableStream<Uint8Array>({ pull() {} });
  const req = new Request("http://localhost/inbound", {
    method: "POST",
    headers: { "content-length": "1000000" },
    body: stream as unknown as BodyInit,
    // @ts-expect-error undici streaming-upload opt-in
    duplex: "half",
  });
  const result = await Promise.race([
    readBoundedBodyText(req, 1024),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waited on the body")), 1000);
      (timer as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
  assert.deepEqual(result, { ok: false, reason: "too_large" });
});

test("a body exactly at the cap is accepted (boundary)", async () => {
  const result = await readBoundedBodyText(chunkedRequest("z".repeat(512), 2), 1024);
  assert.deepEqual(result, { ok: true, text: "z".repeat(1024) });
});

test("an empty body reads as empty text", async () => {
  const result = await readBoundedBodyText(
    new Request("http://localhost/inbound", { method: "POST" }),
    1024,
  );
  assert.deepEqual(result, { ok: true, text: "" });
});

test("a body that errors mid-stream reports unreadable, not too_large", async () => {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(new TextEncoder().encode("partial"));
        return;
      }
      throw new Error("connection reset");
    },
  });
  const req = new Request("http://localhost/inbound", {
    method: "POST",
    body: stream as unknown as BodyInit,
    // @ts-expect-error undici streaming-upload opt-in
    duplex: "half",
  });
  const result = await readBoundedBodyText(req, 1024 * 1024);
  assert.deepEqual(result, { ok: false, reason: "unreadable" });
});
