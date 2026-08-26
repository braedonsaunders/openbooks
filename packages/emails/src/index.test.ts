import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { documentEmail, sendVia, type EmailTransport } from "./index";

test("documentEmail renders the payment link as a call-to-action in html and text", () => {
  const withLink = documentEmail({
    orgName: "Acme Corp",
    docTitle: "Invoice",
    reference: "INV-1042",
    partyName: "Dana",
    attachmentName: "Invoice-INV-1042.pdf",
    paymentUrl: "https://books.example.com/pay/abc123",
  });
  assert.ok(withLink.html.includes("https://books.example.com/pay/abc123"));
  assert.ok(withLink.html.includes("Pay online"));
  assert.ok(withLink.text.includes("Pay online: https://books.example.com/pay/abc123"));

  const without = documentEmail({
    orgName: "Acme Corp",
    docTitle: "Invoice",
    reference: "INV-1043",
    attachmentName: "Invoice-INV-1043.pdf",
  });
  assert.ok(!without.html.includes("Pay online"));
  assert.ok(!without.text.includes("Pay online"));
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

// A provider origin answering 307 with a cross-origin Location must be refused,
// not followed: 307 preserves method AND body, so a followed redirect would hand
// the customer message (and try the API key) to whichever host it names.
test("email provider sends refuse a cross-origin redirect without delivering the message", async () => {
  let attackerRequests = 0;
  const attacker = createServer((req, res) => {
    attackerRequests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "stolen" }));
  });
  const attackerOrigin = await listen(attacker);

  let respondWithRedirect = true;
  const redirectModes: Array<RequestRedirect | undefined> = [];
  const redirector = createServer((req, res) => {
    if (respondWithRedirect) {
      res.writeHead(307, { location: `${attackerOrigin}/credential-capture` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "email_123" }));
  });
  const redirectorOrigin = await listen(redirector);

  // Remap the hardcoded Resend host onto the local redirector while recording
  // the exact redirect mode each request is issued with.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requested = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    redirectModes.push(init?.redirect);
    if (requested.host !== "api.resend.com") return originalFetch(input, init);
    requested.protocol = "http:";
    requested.host = new URL(redirectorOrigin).host;
    return originalFetch(requested, init);
  }) as typeof fetch;

  const transport: EmailTransport = {
    provider: "resend",
    apiKey: "re_secret_REDIRECT_PROOF",
    from: "Ops <ops@example.com>",
  };
  const message = {
    to: "dana@example.com",
    subject: "Invoice INV-1042",
    html: "<p>Customer statement attached.</p>",
    text: "Customer statement attached.",
  };

  try {
    await assert.rejects(sendVia(transport, message), /Resend: network request failed/);
    assert.deepEqual(redirectModes, ["error"]);
    assert.equal(attackerRequests, 0, "the redirect target must never receive a request");

    // Happy path: with redirects out of the picture the same guarded send works.
    respondWithRedirect = false;
    const sent = await sendVia(transport, message);
    assert.equal(sent.id, "email_123");
    assert.equal(attackerRequests, 0, "the API key must never leave for any third host");
    assert.deepEqual(redirectModes, ["error", "error"]);
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.all([
      new Promise<void>((resolve) => redirector.close(() => resolve())),
      new Promise<void>((resolve) => attacker.close(() => resolve())),
    ]);
  }
});
