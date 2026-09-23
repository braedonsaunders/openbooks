import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "./route.ts";
import { QBD_MAX_BODY_BYTES } from "./body-limit.ts";

const CONNECTION_ID = "123e4567-e89b-12d3-a456-426614174000";

function post(body: BodyInit, headers?: Record<string, string>): Promise<Response> {
  return POST(new Request(`http://localhost/api/qbd/web-connector/${CONNECTION_ID}`, {
    method: "POST",
    headers: { "content-type": "text/xml; charset=utf-8", ...headers },
    body,
    // @ts-expect-error undici streaming-upload opt-in (ignored for string bodies)
    duplex: "half",
  }), { params: Promise.resolve({ id: CONNECTION_ID }) });
}

test("an oversized declared length is refused with 413 without waiting on the body", async () => {
  // A stream that never yields: if the route waited on the body, this hangs.
  const stream = new ReadableStream<Uint8Array>({ pull() {} });
  const response = await Promise.race([
    post(stream as unknown as BodyInit, {
      "content-length": String(QBD_MAX_BODY_BYTES + 1),
    }),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waited on the body")), 5000);
      (timer as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
  assert.equal(response.status, 413);
});

test("a chunked malformed body still reaches the SOAP fault (no regression)", async () => {
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(new TextEncoder().encode("<soap:Envelope><unclosed"));
    },
  });
  const req = new Request(`http://localhost/api/qbd/web-connector/${CONNECTION_ID}`, {
    method: "POST",
    headers: { "content-type": "text/xml; charset=utf-8" },
    body: stream as unknown as BodyInit,
    // @ts-expect-error undici streaming-upload opt-in
    duplex: "half",
  });
  assert.equal(req.headers.get("content-length"), null);
  const response = await POST(req, { params: Promise.resolve({ id: CONNECTION_ID }) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Malformed SOAP XML/);
});

test("an empty body faults instead of crashing", async () => {
  const response = await post("");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /soap:Fault/);
});

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
}

test("the version handshake is answered, not faulted", async () => {
  const version = await post(soapEnvelope("<serverVersion/>"));
  assert.equal(version.status, 200);
  assert.match(await version.text(), /<serverVersionResult>1\.0\.0<\/serverVersionResult>/);
});

test("the client version handshake is answered, not faulted", async () => {
  const client = await post(soapEnvelope('<clientVersion>1.5</clientVersion>'));
  assert.equal(client.status, 200);
  assert.match(await client.text(), /<clientVersionResult><\/clientVersionResult>/);
});

test("an oversized unauthenticated authenticate is refused with 413 and a SOAP fault", async () => {
  const big = soapEnvelope(`<authenticate xmlns="http://developer.intuit.com/"><strUserName>qbd:x</strUserName><strPassword>${"p".repeat(100 * 1024)}</strPassword></authenticate>`);
  assert.ok(big.length > 64 * 1024);
  const response = await post(big);
  assert.equal(response.status, 413);
  const text = await response.text();
  assert.match(text, /soap:Fault/);
  assert.match(text, /64 KiB unauthenticated limit/);
});

test("an oversized receiveResponseXML with a dead ticket is refused before buffering", async () => {
  const big = soapEnvelope(`<receiveResponseXML xmlns="http://developer.intuit.com/"><ticket>00000000-0000-4000-8000-000000000000</ticket><response>${"x".repeat(100 * 1024)}</response><hresult></hresult><message></message></receiveResponseXML>`);
  assert.ok(big.length > 64 * 1024);
  const response = await post(big);
  assert.equal(response.status, 413);
  assert.match(await response.text(), /soap:Fault/);
});

test("a deeply nested envelope is refused before full parsing", async () => {
  const deep = soapEnvelope(`<receiveResponseXML>${"<level>".repeat(200)}x${"</level>".repeat(200)}</receiveResponseXML>`);
  const response = await post(deep);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /nests deeper than 128 elements/);
});
