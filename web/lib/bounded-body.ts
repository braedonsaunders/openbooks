/**
 * Bounded raw-body reader for sessionless raw-body routes (third-party
 * webhooks, connector SOAP endpoints).
 *
 * A `content-length` header is sender-declared and absent on chunked uploads,
 * so it can only ever justify an early refusal — never acceptance. This
 * reader keeps the cheap early refusal for oversized declared lengths, then
 * streams everything else through a byte cap: the accumulation never holds
 * more than the cap plus one in-flight chunk, and the stream is cancelled as
 * soon as the cap is crossed. Callers pass their own cap so tests pin the
 * behaviour with small limits instead of production-sized bodies.
 */

export type BoundedBodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "unreadable" };

export type BoundedBytesResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "too_large" | "unreadable" };

/**
 * Byte twin of the text reader for signature-verified deliveries: HMAC
 * verifies over the RAW bytes, so decoding to text first would verify
 * something the sender never signed. Same cap discipline as the text path.
 */
export async function readBoundedBodyBytes(
  req: Request,
  maxBytes: number,
): Promise<BoundedBytesResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    return { ok: false, reason: "too_large" };
  }
  const declared = req.headers.get("content-length");
  if (declared != null && declared.trim() !== "") {
    const length = Number(declared);
    if (Number.isSafeInteger(length) && length > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
  }
  const body = req.body;
  if (!body) return { ok: true, bytes: Buffer.alloc(0) };
  const reader = body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: "unreadable" };
  } finally {
    reader.releaseLock();
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

export async function readBoundedBodyText(
  req: Request,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    return { ok: false, reason: "too_large" };
  }
  const declared = req.headers.get("content-length");
  if (declared != null && declared.trim() !== "") {
    const length = Number(declared);
    if (Number.isSafeInteger(length) && length > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
  }
  const body = req.body;
  if (!body) return { ok: true, text: "" };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: "unreadable" };
  } finally {
    reader.releaseLock();
  }
  text += decoder.decode();
  return { ok: true, text };
}
