import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  InboundEmailError,
  type InboundSignatureEvidence,
  type ResolvedMailbox,
} from "@openbooks/engine/payables/ap-capture-service";
import { receiveInboundApEmail, type InboundDeps } from "./receive";

// The webhook's decisions are driven against the real adapters, signature
// checks and sender rules; only the database-backed address store, the
// message log, the owner's standing and the capture intake are replaced by
// in-memory fakes.

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const TOKEN = "abcdefghijklmnopqrstuvwxyz234567";

const MAILBOX: ResolvedMailbox = {
  id: "mbx-1",
  orgId: "org-1",
  subsidiaryId: "sub-1",
  provider: "generic",
  allowedSenders: [],
  isActive: true,
  ownerId: "user-1",
  signingSecret: null,
};

type Logged = {
  id: string;
  messageId: string;
  outcome: string;
  reason: string | null;
  captureItemIds: string[];
  signature: InboundSignatureEvidence;
  attempt: number;
};

function harness(mailbox: ResolvedMailbox | null, options: { allowDelivery?: boolean } = {}) {
  const log: Logged[] = [];
  const intakes: Array<Parameters<InboundDeps["ingestCaptureFiles"]>[0]> = [];
  const deps: InboundDeps = {
    resolveMailboxByToken: async (token) => (token === TOKEN ? mailbox : null),
    consumeMailboxDelivery: async () => options.allowDelivery ?? true,
    beginInboundMessage: async ({ email, signature }) => {
      const existing = log.find((entry) => entry.messageId === email.messageId);
      if (existing)
        return {
          status: "repeat",
          id: existing.id,
          outcome: existing.outcome,
          captureItemIds: existing.captureItemIds,
        };
      const entry = {
        id: `msg-${log.length + 1}`,
        messageId: email.messageId,
        outcome: "received",
        reason: null,
        captureItemIds: [],
        signature,
        attempt: 1,
      };
      log.push(entry);
      return { status: "new", id: entry.id, attempt: entry.attempt, reclaimed: false };
    },
    finishInboundMessage: async ({ id, attempt, outcome, reason, captureItemIds }) => {
      const entry = log.find((candidate) => candidate.id === id)!;
      assert.equal(entry.outcome, "received", "an outcome is recorded once");
      assert.equal(
        attempt,
        entry.attempt,
        "the outcome is written by the attempt holding the claim",
      );
      Object.assign(entry, {
        outcome,
        reason: reason ?? null,
        captureItemIds: captureItemIds ?? [],
      });
    },
    authorizeMailboxOwner: async (_orgId, _ownerId, subsidiaryId) => ({
      ok: true,
      allowedSubsidiaryIds: new Set([subsidiaryId]),
    }),
    ingestCaptureFiles: async (input) => {
      intakes.push(input);
      const ids = input.files.map((_, index) => `cap-${intakes.length}-${index + 1}`);
      return {
        ok: true,
        ids,
        results: input.files.map((file, index) => ({
          filename: file.filename,
          id: ids[index],
          status: "uploaded" as const,
        })),
      };
    },
    withOrgContext: (_orgId, fn) => fn(),
  };
  return { deps, log, intakes };
}

function genericDelivery(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://books.example/api/inbound/ap/${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const BILL = {
  from: "AP Desk <ap@vendor.example>",
  subject: "Invoice 501",
  messageId: "<501@vendor.example>",
  attachments: [
    { filename: "501.pdf", contentType: "application/pdf", contentBase64: PDF.toString("base64") },
  ],
};

test("an unknown token answers 404 with no detail and reads nothing", async () => {
  const { deps, log } = harness(MAILBOX);
  const response = await receiveInboundApEmail(
    genericDelivery(BILL),
    "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    deps,
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not found" });
  assert.equal(log.length, 0);
});

test("an inactive address refuses and logs nothing", async () => {
  const { deps, log } = harness({ ...MAILBOX, isActive: false });
  const response = await receiveInboundApEmail(genericDelivery(BILL), TOKEN, deps);
  assert.equal(response.status, 403);
  assert.equal(log.length, 0);
});

test("a delivered bill becomes captures for the address entity, attributed to its owner", async () => {
  const { deps, log, intakes } = harness(MAILBOX);
  const response = await receiveInboundApEmail(genericDelivery(BILL), TOKEN, deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "captured", captureIds: ["cap-1-1"] });
  assert.equal(intakes.length, 1);
  assert.equal(intakes[0]!.source, "email");
  assert.equal(intakes[0]!.subsidiaryId, "sub-1");
  assert.equal(intakes[0]!.actorId, "user-1");
  assert.deepEqual(
    [...intakes[0]!.allowedSubsidiaryIds!],
    ["sub-1"],
    "extraction is scoped to the receiving entity",
  );
  assert.equal(intakes[0]!.skipKnownContent, true);
  assert.deepEqual(
    log.map((entry) => [entry.messageId, entry.outcome, entry.captureItemIds]),
    [["<501@vendor.example>", "captured", ["cap-1-1"]]],
  );
});

test("the same message id delivered again is answered from the log without new captures", async () => {
  const { deps, log, intakes } = harness(MAILBOX);
  await receiveInboundApEmail(genericDelivery(BILL), TOKEN, deps);
  const repeat = await receiveInboundApEmail(genericDelivery(BILL), TOKEN, deps);
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), {
    status: "duplicate",
    outcome: "captured",
    captureIds: ["cap-1-1"],
  });
  assert.equal(intakes.length, 1, "no second intake");
  assert.equal(log.length, 1);
});

test("a sender outside the allow-list is recorded as rejected and never captured", async () => {
  const { deps, log, intakes } = harness({ ...MAILBOX, allowedSenders: ["@trusted.example"] });
  const response = await receiveInboundApEmail(genericDelivery(BILL), TOKEN, deps);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "rejected_sender");
  assert.equal(intakes.length, 0);
  assert.equal(log[0]!.outcome, "rejected_sender");
  assert.match(log[0]!.reason ?? "", /ap@vendor\.example/);
});

test("a message without a bill attachment is recorded as such", async () => {
  const { deps, log, intakes } = harness(MAILBOX);
  const response = await receiveInboundApEmail(
    genericDelivery({
      ...BILL,
      messageId: "no-att",
      attachments: [
        { filename: "invite.ics", contentType: "text/calendar", contentBase64: "QkVHSU4=" },
      ],
    }),
    TOKEN,
    deps,
  );
  assert.equal((await response.json()).status, "no_attachments");
  assert.equal(intakes.length, 0);
  assert.equal(log[0]!.outcome, "no_attachments");
});

test("a signing secret requires a valid signature before anything is logged", async () => {
  const secret = "generic-signing-secret-1";
  const { deps, log } = harness({ ...MAILBOX, signingSecret: secret });
  const unsigned = await receiveInboundApEmail(genericDelivery(BILL), TOKEN, deps);
  assert.equal(unsigned.status, 401);
  const forged = await receiveInboundApEmail(
    genericDelivery(BILL, { "x-openbooks-signature": `sha256=${"0".repeat(64)}` }),
    TOKEN,
    deps,
  );
  assert.equal(forged.status, 401);
  assert.equal(log.length, 0);
  const raw = JSON.stringify(BILL);
  const signed = new Request(`https://books.example/api/inbound/ap/${TOKEN}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openbooks-signature": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
    },
    body: raw,
  });
  const accepted = await receiveInboundApEmail(signed, TOKEN, deps);
  assert.equal(accepted.status, 200);
  assert.equal(log.length, 1);
});

test("a rate-limited address answers 429 before reading the message", async () => {
  const { deps, log } = harness(MAILBOX, { allowDelivery: false });
  const response = await receiveInboundApEmail(genericDelivery(BILL), TOKEN, deps);
  assert.equal(response.status, 429);
  assert.equal(log.length, 0);
});

test("an oversize payload is refused before parsing", async () => {
  const { deps, log } = harness(MAILBOX);
  const request = new Request(`https://books.example/api/inbound/ap/${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(200 * 1024 * 1024) },
    body: "{}",
  });
  const response = await receiveInboundApEmail(request, TOKEN, deps);
  assert.equal(response.status, 413);
  assert.equal(log.length, 0);
});

test("an intake refusal is recorded as the message outcome with its reason", async () => {
  const { deps, log } = harness(MAILBOX);
  deps.ingestCaptureFiles = async () => ({
    ok: false,
    status: 409,
    body: { error: "capture_not_configured" },
  });
  const response = await receiveInboundApEmail(genericDelivery(BILL), TOKEN, deps);
  assert.equal(response.status, 200);
  assert.equal(log[0]!.outcome, "error");
  assert.equal(log[0]!.reason, "capture_not_configured");
});

test("the webhook reply names only the outcome class; internal error detail stays in the recorded reason", async () => {
  const { deps, log } = harness({ ...MAILBOX, allowedSenders: ["@trusted.example"] });
  const rejected = await (await receiveInboundApEmail(genericDelivery(BILL), TOKEN, deps)).json();
  assert.deepEqual(rejected, {
    status: "rejected_sender",
    captureIds: [],
    message: "The sender is not allowed for this address.",
  });
  assert.match(
    log[0]!.reason ?? "",
    /ap@vendor\.example/,
    "the sender detail is recorded for administrators",
  );

  const failing = harness(MAILBOX);
  failing.deps.ingestCaptureFiles = async () => ({
    ok: false,
    thrown: new Error("PDF decoder failed reading /srv/openbooks/tmp/7f3a.pdf: xref offset 1844"),
  });
  const response = await receiveInboundApEmail(genericDelivery(BILL), TOKEN, failing.deps);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    status: "error",
    captureIds: [],
    message: "The message was received but could not be captured.",
  });
  assert.equal(
    JSON.stringify(body).includes("decoder"),
    false,
    "no internal detail reaches the sender",
  );
  assert.match(
    failing.log[0]!.reason ?? "",
    /PDF decoder failed reading/,
    "administrators still see the detailed reason",
  );
});

test("an owner who can no longer receive bills refuses the delivery as a recorded outcome naming the remedy", async () => {
  const { deps, log, intakes } = harness(MAILBOX);
  const owners: string[] = [];
  deps.authorizeMailboxOwner = async (_orgId, ownerId) => {
    owners.push(ownerId);
    return {
      ok: false,
      problem: "owner_inactive",
      message:
        "The owner of this inbound address is no longer an active user. An administrator can take ownership of the address on the Bill capture page, or re-create the address.",
    };
  };
  const response = await receiveInboundApEmail(genericDelivery(BILL), TOKEN, deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "error",
    captureIds: [],
    message: "The message was received but could not be captured.",
  });
  assert.deepEqual(owners, ["user-1"], "the owner is checked on every delivery");
  assert.equal(intakes.length, 0, "nothing is captured for a refused owner");
  assert.equal(log[0]!.outcome, "error");
  assert.match(log[0]!.reason ?? "", /take ownership/);
});

test("the capture scope is what the owner check grants, never wider than the address entity", async () => {
  const { deps, intakes } = harness(MAILBOX);
  deps.authorizeMailboxOwner = async () => ({ ok: true, allowedSubsidiaryIds: new Set(["sub-1"]) });
  await receiveInboundApEmail(genericDelivery(BILL), TOKEN, deps);
  assert.deepEqual([...intakes[0]!.allowedSubsidiaryIds!], ["sub-1"]);
});

test("the message log records whether the delivery signature verified", async () => {
  const unsigned = harness(MAILBOX);
  await receiveInboundApEmail(genericDelivery(BILL), TOKEN, unsigned.deps);
  assert.deepEqual(
    unsigned.log[0]!.signature,
    { verified: false, nonce: null },
    "an address without a secret receives unverified mail",
  );

  const secret = "generic-signing-secret-1";
  const signed = harness({ ...MAILBOX, signingSecret: secret });
  const raw = JSON.stringify(BILL);
  await receiveInboundApEmail(
    new Request(`https://books.example/api/inbound/ap/${TOKEN}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbooks-signature": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
      },
      body: raw,
    }),
    TOKEN,
    signed.deps,
  );
  assert.deepEqual(signed.log[0]!.signature, { verified: true, nonce: null });
});

test("a replayed signed token is refused with 401 and captures nothing", async () => {
  const { deps, intakes } = harness(MAILBOX);
  deps.beginInboundMessage = async () => {
    throw new InboundEmailError(
      "signature_replayed",
      "This signed delivery token was already used for another message.",
    );
  };
  const response = await receiveInboundApEmail(genericDelivery(BILL), TOKEN, deps);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "invalid signature" });
  assert.equal(intakes.length, 0);
});

test("a message another attempt is still processing asks the provider to retry after the lease", async () => {
  const { deps, intakes } = harness(MAILBOX);
  deps.beginInboundMessage = async () => ({
    status: "repeat",
    id: "msg-1",
    outcome: "received",
    captureItemIds: [],
  });
  const response = await receiveInboundApEmail(genericDelivery(BILL), TOKEN, deps);
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("retry-after"), "600");
  assert.equal(intakes.length, 0);
});

test("another provider envelope at a generic address is refused, not guessed", async () => {
  const { deps, log } = harness(MAILBOX);
  const response = await receiveInboundApEmail(
    genericDelivery({
      From: "a@b.example",
      FromFull: { Email: "a@b.example" },
      MessageID: "x",
      Attachments: [],
    }),
    TOKEN,
    deps,
  );
  assert.equal(response.status, 422);
  assert.equal(log.length, 0);
});
