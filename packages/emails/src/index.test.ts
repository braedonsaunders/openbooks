import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { deriveEmailDeliveryKey, EMAIL_DELIVERY_ID_HEADER } from "./outcome";
import { documentEmail, sendVia, type EmailTransport } from "./index";

const TEST_ORG = "018f6b2a-7c1d-7d3e-9f4a-2b8c4d5e6f70";
const testKey = (scope: string) => deriveEmailDeliveryKey({ orgId: TEST_ORG, scope, to: "dana@example.com" });

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
    await assert.rejects(sendVia(transport, message, { deliveryKey: testKey("redirect-proof") }), /Resend: network request failed/);
    assert.deepEqual(redirectModes, ["error"]);
    assert.equal(attackerRequests, 0, "the redirect target must never receive a request");

    // Happy path: with redirects out of the picture the same guarded send works.
    respondWithRedirect = false;
    const sent = await sendVia(transport, message, { deliveryKey: testKey("redirect-proof") });
    assert.equal(sent.kind, "sent");
    if (sent.kind === "sent") assert.equal(sent.providerMessageId, "email_123");
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

// --- Provider identity + uncertain outcomes (audit finding #52) -------------
//
// A client-side timeout may fire AFTER the provider has accepted a message.
// Every transport must (1) carry one stable identity for all attempts of the
// same logical delivery and (2) surface an unresolved outcome as `uncertain`
// instead of a thrown "failure" that invites a blind duplicate re-send.

type CapturedRequest = {
  host: string;
  url: string;
  headers: Record<string, string>;
  bodyText: string;
};

const PROVIDER_HOSTS = ["api.resend.com", "api.sendgrid.com", "api.mailgun.net", "api.postmarkapp.com"] as const;

const CANNED_SUCCESS: Record<string, { status: number; body?: string; respondHeaders?: Record<string, string> }> = {
  "api.resend.com": { status: 200, body: JSON.stringify({ id: "email_re" }) },
  // SendGrid answers 202 with an empty body; its message id rides a header.
  "api.sendgrid.com": { status: 202, respondHeaders: { "x-message-id": "sg_msg_1" } },
  "api.mailgun.net": { status: 200, body: JSON.stringify({ id: "<mailgun@example>" }) },
  "api.postmarkapp.com": { status: 200, body: JSON.stringify({ ErrorCode: 0, MessageID: "postmark_x" }) },
};

const transportByProvider: Record<"resend" | "sendgrid" | "mailgun" | "postmark", EmailTransport> = {
  resend: { provider: "resend", apiKey: "re_test", from: "Ops <ops@example.com>" },
  sendgrid: { provider: "sendgrid", apiKey: "SG.test", from: "Ops <ops@example.com>" },
  mailgun: { provider: "mailgun", apiKey: "mg-key", domain: "mg.example.com", region: "us", from: "Ops <ops@example.com>" },
  postmark: { provider: "postmark", serverToken: "pm-token", from: "Ops <ops@example.com>" },
};

type TransportScenario = {
  name: "resend" | "sendgrid" | "mailgun" | "postmark";
  /** Extract the stable delivery id carried on THIS attempt's request. */
  identityOf(req: CapturedRequest): string | null;
};

const SCENARIOS: TransportScenario[] = [
  {
    name: "resend",
    identityOf: (req) => req.headers["idempotency-key"] ?? null,
  },
  {
    name: "sendgrid",
    identityOf: (req) => {
      const parsed = JSON.parse(req.bodyText || "{}") as { headers?: Record<string, string> };
      return parsed.headers?.[EMAIL_DELIVERY_ID_HEADER] ?? null;
    },
  },
  {
    name: "mailgun",
    identityOf: (req) => req.bodyText.match(/"h:X-Openbooks-Delivery-Id"\r?\n\r?\n([^\r\n]+)/u)?.[1] ?? null,
  },
  {
    name: "postmark",
    identityOf: (req) => {
      const parsed = JSON.parse(req.bodyText || "{}") as { Headers?: Array<{ Name: string; Value: string }> };
      return parsed.Headers?.find((h) => h.Name === EMAIL_DELIVERY_ID_HEADER)?.Value ?? null;
    },
  },
];

function startCaptureServer(): Promise<{ server: Server; requests: CapturedRequest[]; origin: string }> {
  return new Promise((resolve) => {
    const requests: CapturedRequest[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        // remapProviders preserves the original provider host here.
        const host = String(req.headers["x-test-provider-host"] ?? "");
        requests.push({
          host,
          url: req.url ?? "",
          headers: Object.fromEntries(
            Object.entries({ ...req.headers }).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(",") : v ?? ""]),
          ),
          bodyText: Buffer.concat(chunks).toString("utf8"),
        });
        const canned = CANNED_SUCCESS[host];
        if (!canned) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(canned.status, { "content-type": "application/json", ...canned.respondHeaders });
        res.end(canned.body ?? "");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, requests, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

/** Redirect every known provider host onto a local capture server (or short-circuit with a TimeoutError). */
function remapProviders(original: typeof fetch, captureOrigin: string, timeoutHosts: ReadonlySet<string> = new Set()): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const requested = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!(PROVIDER_HOSTS as readonly string[]).includes(requested.host)) return original(input, init);
    if (timeoutHosts.has(requested.host)) {
      void init;
      return Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    }
    const capture = new URL(captureOrigin);
    const headers = new Headers(init?.headers);
    headers.set("x-test-provider-host", requested.host);
    requested.protocol = "http:";
    requested.host = capture.host;
    return original(requested, { ...init, headers });
  }) as typeof fetch;
}

const PROVIDER_HOST_BY_SCENARIO: Record<TransportScenario["name"], string> = {
  resend: "api.resend.com",
  sendgrid: "api.sendgrid.com",
  mailgun: "api.mailgun.net",
  postmark: "api.postmarkapp.com",
};

for (const scenario of SCENARIOS) {
  test(`${scenario.name}: attempts of one logical delivery carry one stable provider identity`, async () => {
    const capture = await startCaptureServer();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = remapProviders(originalFetch, capture.origin);
    try {
      const key = testKey(`identity-${scenario.name}`);
      const message = { to: "dana@example.com", subject: "Stable identity", html: "<p>x</p>", text: "x" };
      const first = await sendVia(transportByProvider[scenario.name], message, { deliveryKey: key });
      const second = await sendVia(transportByProvider[scenario.name], message, { deliveryKey: key });

      assert.equal(first.kind, "sent");
      assert.equal(second.kind, "sent");
      assert.equal(capture.requests.length, 2);
      const [attemptOne, attemptTwo] = capture.requests;
      assert.ok(attemptOne && attemptTwo);
      const identityOne = scenario.identityOf(attemptOne);
      assert.ok(identityOne, `${scenario.name}: attempt one carries no stable identity`);
      assert.equal(identityOne, key, `${scenario.name}: wire identity must equal the derived delivery key`);
      assert.equal(scenario.identityOf(attemptTwo), identityOne, `${scenario.name}: retry must reuse the same identity`);
    } finally {
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => capture.server.close(() => resolve()));
    }
  });

  test(`${scenario.name}: a response deadline after transmission resolves uncertain instead of failing forward`, async () => {
    const originalFetch = globalThis.fetch;
    const capture = await startCaptureServer();
    globalThis.fetch = remapProviders(originalFetch, capture.origin, new Set([PROVIDER_HOST_BY_SCENARIO[scenario.name]]));
    try {
      const key = testKey(`timeout-${scenario.name}`);
      const message = { to: "dana@example.com", subject: "Timeout proof", html: "<p>x</p>", text: "x" };
      const outcome = await sendVia(transportByProvider[scenario.name], message, { deliveryKey: key });
      assert.equal(outcome.kind, "uncertain", `${scenario.name}: timeout must record uncertainty`);
      if (outcome.kind === "uncertain") {
        assert.match(outcome.reason, /timed out|unresolved|confirmation/iu);
      }
      assert.equal(capture.requests.length, 0, "an aborted attempt never hands the message to the provider server in this harness");
    } finally {
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => capture.server.close(() => resolve()));
    }
  });
}

test("resend acceptance whose success body is unusable reconciles to uncertainty without a throw", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({}));
  });
  const origin = await listen(server);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = remapProviders(originalFetch, origin);
  try {
    const outcome = await sendVia(
      transportByProvider.resend,
      { to: "dana@example.com", subject: "s", html: "<p/>", text: "t" },
      { deliveryKey: testKey("contract-id") },
    );
    assert.equal(outcome.kind, "uncertain");
    if (outcome.kind === "uncertain") assert.match(outcome.reason, /id was missing/iu);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("resend confirmation lost mid-body after acceptance resolves uncertain", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength('{"id":"never-received"}') + 512),
    });
    res.write('{"id":"');
    setTimeout(() => res.destroy(), 10);
  });
  const origin = await listen(server);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = remapProviders(originalFetch, origin);
  try {
    const outcome = await sendVia(
      transportByProvider.resend,
      { to: "dana@example.com", subject: "cut", html: "<p/>", text: "t" },
      { deliveryKey: testKey("lost-body") },
    );
    assert.equal(outcome.kind, "uncertain");
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
