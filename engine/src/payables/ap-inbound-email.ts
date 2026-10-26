import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Inbound AP email: provider adapters, signature verification, sender
 * allow-lists and address tokens. Pure apart from crypto, so every rule a
 * delivery is judged by is testable without a database or a network.
 *
 * Each provider posts the same facts in its own envelope — sender, subject,
 * message id and attachments — and the adapters reduce all of them to one
 * `InboundEmail`. Attachments then flow into the same capture intake the
 * upload button uses; nothing here reads a document.
 */

export const INBOUND_EMAIL_PROVIDERS = ["postmark", "mailgun", "sendgrid", "generic"] as const;
export type InboundEmailProvider = (typeof INBOUND_EMAIL_PROVIDERS)[number];

export type InboundAttachment = {
  filename: string;
  contentType: string;
  bytes: Buffer;
};

export type InboundEmail = {
  provider: InboundEmailProvider;
  /** Bare sender address, lower-cased; null when the envelope names none. */
  from: string | null;
  subject: string | null;
  /** Provider or RFC 5322 message id; a content digest when the envelope carries none. */
  messageId: string;
  attachments: InboundAttachment[];
  /** Mailgun signs each delivery with these three form fields. */
  mailgunSignature?: { timestamp: string; token: string; signature: string };
};

export type InboundEmailErrorCode =
  | "malformed"
  | "unsupported_format"
  | "provider_mismatch"
  | "unsupported_delivery"
  | "signature_required"
  | "signature_invalid"
  | "signature_replayed";

/** A delivery the adapters cannot accept, with an operator-facing remedy. */
export class InboundEmailError extends Error {
  constructor(
    readonly code: InboundEmailErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InboundEmailError";
  }
}

/** Attachment types the capture intake reads, matching the upload button. */
export const INBOUND_CAPTURE_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "application/xml",
  "text/xml",
]);

const EXTENSION_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
  xml: "application/xml",
};

/**
 * The capture type an attachment declares, or the one its extension names
 * when the provider sends a generic octet stream. Anything else is not a
 * bill document (signatures, calendar invites, inline logos) and is skipped.
 */
export function captureContentType(
  filename: string,
  declared: string | null | undefined,
): string | null {
  const type = (declared ?? "").split(";")[0]!.trim().toLowerCase();
  if (INBOUND_CAPTURE_TYPES.has(type)) return type === "text/xml" ? "text/xml" : type;
  if (type && type !== "application/octet-stream" && type !== "binary/octet-stream") return null;
  const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return EXTENSION_TYPES[extension] ?? null;
}

/** Keep only attachments the capture intake can read. */
export function captureAttachments(attachments: readonly InboundAttachment[]): InboundAttachment[] {
  const accepted: InboundAttachment[] = [];
  for (const attachment of attachments) {
    const contentType = captureContentType(attachment.filename, attachment.contentType);
    if (contentType && attachment.bytes.length > 0) accepted.push({ ...attachment, contentType });
  }
  return accepted;
}

/** `"Name" <a@b.com>` and `a@b.com` both reduce to `a@b.com`. */
export function bareAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const angled = value.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  const candidate = (angled?.[1] ?? value).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(candidate) ? candidate.slice(0, 320) : null;
}

/**
 * Normalize an allowed-sender entry: an exact address (`ap@vendor.com`) or a
 * whole domain (`@vendor.com`). Returns null for anything else so the setup
 * write can refuse it by name.
 */
export function normalizeSenderRule(rule: string): string | null {
  const value = rule.trim().toLowerCase();
  if (/^@[a-z0-9.-]+\.[a-z0-9-]+$/.test(value)) return value;
  if (/^[^\s@]+@[a-z0-9.-]+\.[a-z0-9-]+$/.test(value)) return value;
  return null;
}

/**
 * Whether a sender may submit through an address. An empty list admits every
 * sender (the token alone authenticates the delivery); otherwise the bare
 * address must equal an entry, or its domain must equal a `@domain` entry
 * exactly — a subdomain is a different sender.
 */
export function senderAllowed(from: string | null, allowed: readonly string[]): boolean {
  const rules = allowed.map(normalizeSenderRule).filter((rule): rule is string => rule !== null);
  if (rules.length === 0) return allowed.length === 0;
  const address = bareAddress(from);
  if (!address) return false;
  const domain = `@${address.slice(address.lastIndexOf("@") + 1)}`;
  return rules.some((rule) => (rule.startsWith("@") ? rule === domain : rule === address));
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A fresh 160-bit address token, 32 lower-case base32 characters. */
export function newMailboxToken(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let token = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      token += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return token;
}

/** Shape check before any lookup: a malformed token names nothing. */
export function isMailboxToken(value: string): boolean {
  return /^[a-z2-7]{32}$/.test(value);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Mailgun timestamps older than this are replays, not deliveries. */
export const MAILGUN_SIGNATURE_MAX_AGE_SECONDS = 15 * 60;

/** The password half of an HTTP Basic credential, or null. */
export function basicAuthPassword(authorization: string | null | undefined): string | null {
  const match = authorization?.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator < 0 ? null : decoded.slice(separator + 1);
}

/** What signature verification established about one delivery. */
export type InboundSignatureEvidence = {
  /** The address has a signing secret and the delivery's signature verified against it. */
  verified: boolean;
  /**
   * The one-time value the signature covers when the provider signs only a
   * timestamp and token (Mailgun). It is recorded with the message so the
   * same signed token cannot authenticate a second message.
   */
  nonce: string | null;
};

/**
 * Verify a delivery against the address's signing secret. With no secret
 * configured the unguessable token is the only credential and the delivery
 * is unverified. With one:
 *
 * - Mailgun: HMAC-SHA256 of timestamp + token under the signing key, within
 *   the replay window; the token is returned as the nonce to record;
 * - Postmark and SendGrid: HTTP Basic credentials in the webhook URL, whose
 *   password must equal the secret;
 * - generic: `X-OpenBooks-Signature: sha256=<hex>`, an HMAC-SHA256 of the raw
 *   request body under the secret.
 */
export function verifyInboundSignature(input: {
  provider: InboundEmailProvider;
  secret: string | null;
  headers: Record<string, string>;
  rawBody: Buffer;
  email: Pick<InboundEmail, "mailgunSignature">;
  now?: Date;
}): InboundSignatureEvidence {
  if (!input.secret) return { verified: false, nonce: null };
  if (input.provider === "mailgun") {
    const signed = input.email.mailgunSignature;
    if (!signed)
      throw new InboundEmailError(
        "signature_required",
        "The delivery carries no Mailgun signature.",
      );
    const timestamp = Number(signed.timestamp);
    const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
    if (
      !Number.isSafeInteger(timestamp) ||
      Math.abs(nowSeconds - timestamp) > MAILGUN_SIGNATURE_MAX_AGE_SECONDS
    ) {
      throw new InboundEmailError(
        "signature_invalid",
        "The Mailgun signature timestamp is outside the accepted window.",
      );
    }
    const expected = createHmac("sha256", input.secret)
      .update(`${signed.timestamp}${signed.token}`)
      .digest("hex");
    if (!safeEqual(expected, signed.signature.toLowerCase())) {
      throw new InboundEmailError(
        "signature_invalid",
        "The Mailgun signature does not match this address's signing key.",
      );
    }
    if (!signed.token || signed.token.length > 512) {
      throw new InboundEmailError(
        "signature_invalid",
        "The Mailgun signature token is missing or too long.",
      );
    }
    return { verified: true, nonce: signed.token };
  }
  if (input.provider === "generic") {
    const header = input.headers["x-openbooks-signature"] ?? "";
    const supplied = header.match(/^sha256=([0-9a-f]{64})$/i)?.[1]?.toLowerCase();
    if (!supplied)
      throw new InboundEmailError(
        "signature_required",
        "The delivery carries no X-OpenBooks-Signature header.",
      );
    const expected = createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
    if (!safeEqual(expected, supplied)) {
      throw new InboundEmailError(
        "signature_invalid",
        "The X-OpenBooks-Signature does not match this address's secret.",
      );
    }
    return { verified: true, nonce: null };
  }
  const password = basicAuthPassword(input.headers["authorization"]);
  if (password === null) {
    throw new InboundEmailError(
      "signature_required",
      "The delivery carries no HTTP Basic credentials.",
    );
  }
  if (!safeEqual(password, input.secret)) {
    throw new InboundEmailError(
      "signature_invalid",
      "The HTTP Basic credentials do not match this address's secret.",
    );
  }
  return { verified: true, nonce: null };
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function safeFilename(value: unknown, fallback: string): string {
  const name = typeof value === "string" ? (value.split(/[\\/]/).pop() ?? "") : "";
  return (
    name
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 240) || fallback
  );
}

function decodeBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/\r\n]*={0,2}\s*$/.test(value)) {
    throw new InboundEmailError("malformed", `${label} is not base64 content.`);
  }
  return Buffer.from(value, "base64");
}

/** Message-ID from a raw header block (SendGrid) or a header list (Postmark). */
function headerMessageId(value: unknown): string | null {
  if (typeof value === "string") {
    const match = value.match(/^message-id:\s*(.+)$/im);
    return text(match?.[1], 998);
  }
  if (Array.isArray(value)) {
    for (const header of value) {
      if (
        header &&
        typeof header === "object" &&
        String((header as { Name?: unknown }).Name).toLowerCase() === "message-id"
      ) {
        return text((header as { Value?: unknown }).Value, 998);
      }
    }
  }
  return null;
}

/**
 * A stable id for an envelope that names none: the same sender, subject and
 * attachment bytes always derive the same id, so a provider retry is still
 * recognized as the message already logged.
 */
export function derivedMessageId(
  email: Pick<InboundEmail, "from" | "subject" | "attachments">,
): string {
  const hash = createHash("sha256");
  hash.update(`${email.from ?? ""}\n${email.subject ?? ""}\n`);
  for (const attachment of email.attachments) {
    hash.update(`${attachment.filename}\n`);
    hash.update(createHash("sha256").update(attachment.bytes).digest("hex"));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

function finish(
  provider: InboundEmailProvider,
  fields: {
    from: string | null;
    subject: string | null;
    messageId: string | null;
    attachments: InboundAttachment[];
  },
  extra: Partial<InboundEmail> = {},
): InboundEmail {
  const from = bareAddress(fields.from);
  const base = { from, subject: fields.subject, attachments: fields.attachments };
  return { provider, ...base, messageId: fields.messageId ?? derivedMessageId(base), ...extra };
}

function parsePostmark(body: Record<string, unknown>): InboundEmail {
  const attachments = Array.isArray(body.Attachments) ? body.Attachments : [];
  const fromFull =
    body.FromFull && typeof body.FromFull === "object"
      ? (body.FromFull as { Email?: unknown }).Email
      : null;
  return finish("postmark", {
    from: text(fromFull, 320) ?? text(body.From, 320),
    subject: text(body.Subject, 998),
    messageId: headerMessageId(body.Headers) ?? text(body.MessageID, 998),
    attachments: attachments.map((entry, index) => {
      const attachment = (entry ?? {}) as Record<string, unknown>;
      return {
        filename: safeFilename(attachment.Name, `attachment-${index + 1}`),
        contentType: String(attachment.ContentType ?? ""),
        bytes: decodeBase64(attachment.Content, `Attachment ${index + 1}`),
      };
    }),
  });
}

function parseGenericJson(body: Record<string, unknown>): InboundEmail {
  if (!Array.isArray(body.attachments)) {
    throw new InboundEmailError("malformed", "The delivery must carry an attachments array.");
  }
  return finish("generic", {
    from: text(body.from, 320),
    subject: text(body.subject, 998),
    messageId: text(body.messageId, 998),
    attachments: body.attachments.map((entry, index) => {
      const attachment = (entry ?? {}) as Record<string, unknown>;
      return {
        filename: safeFilename(attachment.filename, `attachment-${index + 1}`),
        contentType: String(attachment.contentType ?? ""),
        bytes: decodeBase64(attachment.contentBase64, `Attachment ${index + 1}`),
      };
    }),
  });
}

async function fileBytes(
  value: FormDataEntryValue | null,
): Promise<{ name: string; type: string; bytes: Buffer } | null> {
  if (!value || typeof value === "string") return null;
  return { name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) };
}

async function parseMailgun(form: FormData): Promise<InboundEmail> {
  if (typeof form.get("attachments") === "string" && !form.get("attachment-1")) {
    throw new InboundEmailError(
      "unsupported_delivery",
      "Mailgun sent stored-message links instead of the attachments. Set the route action to forward() so attachments arrive with the message.",
    );
  }
  const declared = Number(form.get("attachment-count") ?? 0);
  const count = Number.isSafeInteger(declared) && declared > 0 ? Math.min(declared, 200) : 0;
  const attachments: InboundAttachment[] = [];
  for (let index = 1; index <= count; index += 1) {
    const file = await fileBytes(form.get(`attachment-${index}`));
    if (file)
      attachments.push({
        filename: safeFilename(file.name, `attachment-${index}`),
        contentType: file.type,
        bytes: file.bytes,
      });
  }
  const timestamp = form.get("timestamp");
  const token = form.get("token");
  const signature = form.get("signature");
  return finish(
    "mailgun",
    {
      from: text(form.get("sender"), 320) ?? text(form.get("from"), 320),
      subject: text(form.get("subject"), 998),
      messageId: text(form.get("Message-Id"), 998) ?? text(form.get("message-id"), 998),
      attachments,
    },
    typeof timestamp === "string" && typeof token === "string" && typeof signature === "string"
      ? { mailgunSignature: { timestamp, token, signature } }
      : {},
  );
}

async function parseSendgrid(form: FormData): Promise<InboundEmail> {
  if (typeof form.get("email") === "string") {
    throw new InboundEmailError(
      "unsupported_delivery",
      'SendGrid posted the raw MIME message. Turn off "POST the raw, full MIME message" in the Inbound Parse settings.',
    );
  }
  let info: Record<string, { filename?: unknown; name?: unknown; type?: unknown }> = {};
  const rawInfo = form.get("attachment-info");
  if (typeof rawInfo === "string" && rawInfo.trim()) {
    try {
      info = JSON.parse(rawInfo) as typeof info;
    } catch {
      throw new InboundEmailError("malformed", "The attachment-info field is not JSON.");
    }
  }
  const declared = Number(form.get("attachments") ?? 0);
  const count = Number.isSafeInteger(declared) && declared > 0 ? Math.min(declared, 200) : 0;
  const attachments: InboundAttachment[] = [];
  for (let index = 1; index <= count; index += 1) {
    const key = `attachment${index}`;
    const file = await fileBytes(form.get(key));
    if (!file) continue;
    const described = info[key] ?? {};
    attachments.push({
      filename: safeFilename(described.filename ?? described.name ?? file.name, key),
      contentType: String(described.type ?? file.type ?? ""),
      bytes: file.bytes,
    });
  }
  return finish("sendgrid", {
    from: text(form.get("from"), 320),
    subject: text(form.get("subject"), 998),
    messageId: headerMessageId(form.get("headers")),
    attachments,
  });
}

/** Which provider envelope a delivery is, from its content type and fields. */
export function detectJsonProvider(body: Record<string, unknown>): InboundEmailProvider | null {
  if ("FromFull" in body || "MessageID" in body || ("Attachments" in body && "From" in body))
    return "postmark";
  if ("attachments" in body && ("from" in body || "messageId" in body)) return "generic";
  return null;
}

export function detectFormProvider(form: FormData): InboundEmailProvider | null {
  if (form.has("signature") && form.has("token") && form.has("timestamp")) return "mailgun";
  if (form.has("attachment-count") || form.has("Message-Id") || form.has("body-plain"))
    return "mailgun";
  if (form.has("attachment-info") || form.has("envelope") || form.has("headers")) return "sendgrid";
  return null;
}

/**
 * Parse one delivery and confirm it is the envelope the address is configured
 * for. A Postmark address receiving a Mailgun form is refused rather than
 * guessed at: the signature scheme follows the configured provider.
 */
export async function parseInboundEmail(input: {
  contentType: string;
  body: Buffer;
  expectedProvider: InboundEmailProvider;
}): Promise<InboundEmail> {
  const mediaType = input.contentType.split(";")[0]!.trim().toLowerCase();
  let email: InboundEmail;
  if (mediaType === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.body.toString("utf8"));
    } catch {
      throw new InboundEmailError("malformed", "The delivery body is not JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new InboundEmailError("malformed", "The delivery body must be a JSON object.");
    }
    const body = parsed as Record<string, unknown>;
    const provider = detectJsonProvider(body);
    if (!provider)
      throw new InboundEmailError(
        "unsupported_format",
        "The JSON delivery is neither a Postmark inbound message nor the generic format.",
      );
    assertProvider(provider, input.expectedProvider);
    email = provider === "postmark" ? parsePostmark(body) : parseGenericJson(body);
  } else if (
    mediaType === "multipart/form-data" ||
    mediaType === "application/x-www-form-urlencoded"
  ) {
    let form: FormData;
    try {
      form = await new Request("https://inbound.invalid/", {
        method: "POST",
        headers: { "content-type": input.contentType },
        body: new Uint8Array(input.body),
      }).formData();
    } catch {
      throw new InboundEmailError("malformed", "The form delivery could not be read.");
    }
    const provider = detectFormProvider(form);
    if (!provider)
      throw new InboundEmailError(
        "unsupported_format",
        "The form delivery is neither a Mailgun nor a SendGrid inbound message.",
      );
    assertProvider(provider, input.expectedProvider);
    email = provider === "mailgun" ? await parseMailgun(form) : await parseSendgrid(form);
  } else {
    throw new InboundEmailError(
      "unsupported_format",
      "Inbound messages must be JSON or a multipart form.",
    );
  }
  return email;
}

function assertProvider(detected: InboundEmailProvider, expected: InboundEmailProvider): void {
  if (detected !== expected) {
    throw new InboundEmailError(
      "provider_mismatch",
      `This address is configured for ${expected} deliveries but received a ${detected} message.`,
    );
  }
}
