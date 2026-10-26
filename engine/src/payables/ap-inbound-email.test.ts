import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  bareAddress,
  captureAttachments,
  derivedMessageId,
  InboundEmailError,
  isMailboxToken,
  newMailboxToken,
  normalizeSenderRule,
  parseInboundEmail,
  senderAllowed,
  verifyInboundSignature,
} from "./ap-inbound-email.ts";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function json(body: unknown): { contentType: string; body: Buffer } {
  return {
    contentType: "application/json; charset=utf-8",
    body: Buffer.from(JSON.stringify(body)),
  };
}

async function multipart(form: FormData): Promise<{ contentType: string; body: Buffer }> {
  const request = new Request("https://fixture.invalid/", { method: "POST", body: form });
  return {
    contentType: request.headers.get("content-type")!,
    body: Buffer.from(await request.arrayBuffer()),
  };
}

const POSTMARK_FIXTURE = {
  From: '"Acme Billing" <billing@acme.example>',
  FromFull: { Email: "Billing@Acme.example", Name: "Acme Billing" },
  Subject: "Invoice INV-1001",
  MessageID: "73e6d360-66eb-11e1-8e72-a8904824019b",
  Headers: [{ Name: "Message-ID", Value: "<CAF1001@mail.acme.example>" }],
  Attachments: [
    {
      Name: "INV-1001.pdf",
      Content: PDF.toString("base64"),
      ContentType: "application/pdf",
      ContentLength: PDF.length,
    },
    {
      Name: "logo.gif",
      Content: Buffer.from("GIF89a").toString("base64"),
      ContentType: "image/gif",
      ContentLength: 6,
    },
  ],
};

test("a Postmark inbound message reduces to its sender, subject, RFC message id and attachments", async () => {
  const email = await parseInboundEmail({
    ...json(POSTMARK_FIXTURE),
    expectedProvider: "postmark",
  });
  assert.equal(email.provider, "postmark");
  assert.equal(email.from, "billing@acme.example");
  assert.equal(email.subject, "Invoice INV-1001");
  assert.equal(
    email.messageId,
    "<CAF1001@mail.acme.example>",
    "the RFC Message-ID wins over the provider id",
  );
  assert.equal(email.attachments.length, 2);
  assert.deepEqual(email.attachments[0]!.bytes, PDF);
  assert.deepEqual(
    captureAttachments(email.attachments).map((a) => a.filename),
    ["INV-1001.pdf"],
    "the inline logo is not a bill document",
  );
});

test("the generic JSON format carries base64 attachments and its own message id", async () => {
  const email = await parseInboundEmail({
    ...json({
      from: "ap@vendor.example",
      subject: "Bill",
      messageId: "msg-42",
      attachments: [
        {
          filename: "scan.png",
          contentType: "application/octet-stream",
          contentBase64: PNG.toString("base64"),
        },
      ],
    }),
    expectedProvider: "generic",
  });
  assert.equal(email.messageId, "msg-42");
  const accepted = captureAttachments(email.attachments);
  assert.equal(accepted[0]!.contentType, "image/png", "an octet stream is typed by its extension");
});

test("a Mailgun forward() delivery reads numbered attachments and its signature fields", async () => {
  const form = new FormData();
  form.append("sender", "billing@acme.example");
  form.append("from", "Acme <billing@acme.example>");
  form.append("subject", "Invoice 77");
  form.append("Message-Id", "<77@acme.example>");
  form.append("attachment-count", "1");
  form.append("attachment-1", new File([PDF], "77.pdf", { type: "application/pdf" }));
  form.append("timestamp", "1700000000");
  form.append("token", "tok");
  form.append("signature", "abc");
  const email = await parseInboundEmail({
    ...(await multipart(form)),
    expectedProvider: "mailgun",
  });
  assert.equal(email.provider, "mailgun");
  assert.equal(email.messageId, "<77@acme.example>");
  assert.equal(email.attachments[0]!.filename, "77.pdf");
  assert.deepEqual(email.mailgunSignature, {
    timestamp: "1700000000",
    token: "tok",
    signature: "abc",
  });
});

test("Mailgun stored-message links are refused with the forward() remedy", async () => {
  const form = new FormData();
  form.append("sender", "billing@acme.example");
  form.append("Message-Id", "<78@acme.example>");
  form.append("attachments", JSON.stringify([{ url: "https://storage.mailgun.example/1" }]));
  await assert.rejects(
    parseInboundEmail({ ...(await multipart(form)), expectedProvider: "mailgun" }),
    (error: unknown) =>
      error instanceof InboundEmailError &&
      error.code === "unsupported_delivery" &&
      /forward\(\)/.test(error.message),
  );
});

test("a SendGrid Inbound Parse delivery names attachments through attachment-info and its headers", async () => {
  const form = new FormData();
  form.append("from", "Vendor AP <ap@vendor.example>");
  form.append("subject", "Statement and bill");
  form.append(
    "headers",
    "Received: by mx\nMessage-ID: <sg-1@vendor.example>\nSubject: Statement and bill\n",
  );
  form.append(
    "envelope",
    JSON.stringify({ from: "ap@vendor.example", to: ["bills@inbound.example"] }),
  );
  form.append("attachments", "1");
  form.append(
    "attachment-info",
    JSON.stringify({ attachment1: { filename: "bill.pdf", type: "application/pdf" } }),
  );
  form.append("attachment1", new File([PDF], "attachment1", { type: "application/pdf" }));
  const email = await parseInboundEmail({
    ...(await multipart(form)),
    expectedProvider: "sendgrid",
  });
  assert.equal(email.from, "ap@vendor.example");
  assert.equal(email.messageId, "<sg-1@vendor.example>");
  assert.equal(email.attachments[0]!.filename, "bill.pdf");
});

test("an address refuses another provider's envelope instead of guessing its signature scheme", async () => {
  await assert.rejects(
    parseInboundEmail({ ...json(POSTMARK_FIXTURE), expectedProvider: "generic" }),
    (error: unknown) => error instanceof InboundEmailError && error.code === "provider_mismatch",
  );
  await assert.rejects(
    parseInboundEmail({
      contentType: "text/plain",
      body: Buffer.from("hello"),
      expectedProvider: "generic",
    }),
    (error: unknown) => error instanceof InboundEmailError && error.code === "unsupported_format",
  );
});

test("an envelope without a message id derives the same id for the same content", () => {
  const base = {
    from: "a@b.example",
    subject: "Bill",
    attachments: [{ filename: "x.pdf", contentType: "application/pdf", bytes: PDF }],
  };
  assert.equal(derivedMessageId(base), derivedMessageId({ ...base }));
  assert.notEqual(derivedMessageId(base), derivedMessageId({ ...base, subject: "Other" }));
  assert.match(derivedMessageId(base), /^sha256:[0-9a-f]{64}$/);
});

test("Mailgun signatures verify under the signing key, name the token to record, and refuse a wrong key or a stale timestamp", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const signature = createHmac("sha256", "key-1").update(`${timestamp}tok`).digest("hex");
  const email = { mailgunSignature: { timestamp, token: "tok", signature } };
  const base = { provider: "mailgun" as const, headers: {}, rawBody: Buffer.alloc(0), email, now };
  assert.deepEqual(verifyInboundSignature({ ...base, secret: "key-1" }), {
    verified: true,
    nonce: "tok",
  });
  assert.throws(
    () => verifyInboundSignature({ ...base, secret: "key-2" }),
    (error: unknown) => (error as InboundEmailError).code === "signature_invalid",
  );
  assert.throws(
    () =>
      verifyInboundSignature({
        ...base,
        secret: "key-1",
        now: new Date(now.getTime() + 16 * 60_000),
      }),
    (error: unknown) => (error as InboundEmailError).code === "signature_invalid",
  );
  assert.throws(
    () => verifyInboundSignature({ ...base, secret: "key-1", email: {} }),
    (error: unknown) => (error as InboundEmailError).code === "signature_required",
  );
});

test("Postmark and SendGrid authenticate with the Basic password; generic with a body HMAC", () => {
  const basic = (password: string) =>
    `Basic ${Buffer.from(`inbound:${password}`).toString("base64")}`;
  for (const provider of ["postmark", "sendgrid"] as const) {
    assert.deepEqual(
      verifyInboundSignature({
        provider,
        secret: "s3cret",
        headers: { authorization: basic("s3cret") },
        rawBody: Buffer.alloc(0),
        email: {},
      }),
      { verified: true, nonce: null },
    );
    assert.throws(
      () =>
        verifyInboundSignature({
          provider,
          secret: "s3cret",
          headers: { authorization: basic("guess") },
          rawBody: Buffer.alloc(0),
          email: {},
        }),
      (error: unknown) => (error as InboundEmailError).code === "signature_invalid",
    );
    assert.throws(
      () =>
        verifyInboundSignature({
          provider,
          secret: "s3cret",
          headers: {},
          rawBody: Buffer.alloc(0),
          email: {},
        }),
      (error: unknown) => (error as InboundEmailError).code === "signature_required",
    );
  }
  const rawBody = Buffer.from('{"attachments":[]}');
  const good = `sha256=${createHmac("sha256", "s3cret").update(rawBody).digest("hex")}`;
  assert.deepEqual(
    verifyInboundSignature({
      provider: "generic",
      secret: "s3cret",
      headers: { "x-openbooks-signature": good },
      rawBody,
      email: {},
    }),
    { verified: true, nonce: null },
  );
  assert.throws(
    () =>
      verifyInboundSignature({
        provider: "generic",
        secret: "s3cret",
        headers: { "x-openbooks-signature": good },
        rawBody: Buffer.from("{}"),
        email: {},
      }),
    (error: unknown) => (error as InboundEmailError).code === "signature_invalid",
  );
});

test("with no signing secret the token alone authenticates, and the delivery is unverified", () => {
  assert.deepEqual(
    verifyInboundSignature({
      provider: "mailgun",
      secret: null,
      headers: {},
      rawBody: Buffer.alloc(0),
      email: {},
    }),
    { verified: false, nonce: null },
  );
});

test("the sender allow-list matches exact addresses and whole domains, never subdomains", () => {
  assert.equal(
    senderAllowed('"AP" <ap@vendor.example>', []),
    true,
    "an empty list admits every sender",
  );
  assert.equal(senderAllowed("ap@vendor.example", ["AP@Vendor.example"]), true);
  assert.equal(senderAllowed("billing@vendor.example", ["@vendor.example"]), true);
  assert.equal(senderAllowed("billing@mail.vendor.example", ["@vendor.example"]), false);
  assert.equal(senderAllowed("ap@vendor.example.evil", ["@vendor.example"]), false);
  assert.equal(
    senderAllowed(null, ["@vendor.example"]),
    false,
    "an unnamed sender cannot satisfy a list",
  );
  assert.equal(
    senderAllowed("ap@vendor.example", ["not a rule"]),
    false,
    "a list of unusable rules admits no one",
  );
  assert.equal(normalizeSenderRule(" @Vendor.Example "), "@vendor.example");
  assert.equal(normalizeSenderRule("vendor.example"), null);
  assert.equal(bareAddress("Name <A@B.example>"), "a@b.example");
});

test("address tokens are 32 base32 characters and never repeat", () => {
  const tokens = new Set(Array.from({ length: 200 }, () => newMailboxToken()));
  assert.equal(tokens.size, 200);
  for (const token of tokens) assert.ok(isMailboxToken(token), token);
  assert.equal(isMailboxToken("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"), false);
  assert.equal(isMailboxToken("short"), false);
});
