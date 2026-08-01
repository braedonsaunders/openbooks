import "server-only";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { env } from "@openbooks/engine/src/db.ts";
import type { Authz } from "../authz";
import { canonicalJson } from "../application/idempotency-core";

const KEY = Buffer.from(hkdfSync(
  "sha256",
  Buffer.from(env.SESSION_SECRET),
  Buffer.alloc(0),
  Buffer.from("openbooks.assistant-application-command.v1"),
  32,
));
const TTL_MS = 10 * 60 * 1000;

interface TokenBody {
  exp: number;
  signature: string;
}

function signature(args: {
  toolName: string;
  input: unknown;
  userId: string;
  orgId: string;
  exp: number;
}): string {
  return createHmac("sha256", KEY).update(canonicalJson(args)).digest("hex");
}

/** Bind a proposed command to the exact actor, tenant, input, and expiry. */
export function signApplicationCommand(
  toolName: string,
  input: unknown,
  authz: Authz,
): string {
  const exp = Date.now() + TTL_MS;
  const body: TokenBody = {
    exp,
    signature: signature({
      toolName,
      input,
      userId: authz.user.id,
      orgId: authz.user.orgId,
      exp,
    }),
  };
  return Buffer.from(JSON.stringify(body)).toString("base64url");
}

export function verifyApplicationCommand(
  toolName: string,
  input: unknown,
  token: string,
  authz: Authz,
): boolean {
  let body: TokenBody;
  try {
    body = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as TokenBody;
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(body.exp) || body.exp < Date.now() || typeof body.signature !== "string") {
    return false;
  }
  const expected = Buffer.from(signature({
    toolName,
    input,
    userId: authz.user.id,
    orgId: authz.user.orgId,
    exp: body.exp,
  }), "hex");
  const received = Buffer.from(body.signature, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
