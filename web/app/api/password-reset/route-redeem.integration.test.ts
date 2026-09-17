import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "@openbooks/engine/src/test-fixtures.ts";

// F-t01-013 activation block: redeeming a live set-password link from a
// browser on 127.0.0.1 answered 403 while localhost passed — the origin
// gates treated loopback literals as different origins. This redeems a
// minted token through the REAL route with a cross-loopback Origin header:
// the gate must admit it and the password must take.

const stateKey = Symbol.for("openbooks.password-reset-redeem-integration");
const state: { transport: boolean } = { transport: false };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const hooks = registerHooks({
  resolve(specifier, context, next) {
    const virtual = (source: string) => ({
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(source),
    });
    if (specifier === "server-only") return virtual("export {}");
    const parent = String(context.parentURL ?? "");
    if (parent.includes("auth-reset.ts") && specifier === "@openbooks/emails") {
      return virtual(`
        export const deriveEmailDeliveryKey = () => 'isolated-delivery';
        export const passwordResetEmail = ({ resetUrl }) => ({ subject: 'Set your password', text: resetUrl, html: resetUrl });
        export async function sendVia() { return { kind: 'sent', providerMessageId: 'isolated' }; }
      `);
    }
    if (parent.includes("auth-reset.ts") && specifier === "@openbooks/engine/src/email-config.ts") {
      return virtual(`
        const state = globalThis[Symbol.for('openbooks.password-reset-redeem-integration')];
        export async function resolveOrgEmailTransport() { return state.transport ? { provider: 'isolated' } : null; }
        export async function insertEmailLog() { return 'isolated-log'; }
        export async function markEmailSent() {}
        export async function markEmailUncertain() {}
        export async function markEmailFailed() {}
      `);
    }
    if (specifier === "./request-org" && parent.includes("/web/lib/auth.ts")) {
      return virtual("export function setRequestOrg() {}");
    }
    return next(specifier, context);
  },
});
const { PUT } = await import("./route");
const { issueInviteSetPasswordLink } = await import("../../../lib/auth-reset");
hooks.deregister();
const skip = !process.env.OPENBOOKS_DB_URL;

test("a live token redeems through the route from a cross-loopback Origin", { skip }, async () => {
  const seeded = await withBypassContext(async () => {
    const org = await createScratchOrg();
    const userId = await createScratchUser(org.orgId, "Redeem member", "redeem_member");
    await db.execute(sql`update orgs set env_kind = 'production' where id = ${org.orgId}`);
    return { org, userId };
  });
  try {
    const issuance = await issueInviteSetPasswordLink({
      user: {
        id: seeded.userId,
        org_id: seeded.org.orgId,
        name: "Redeem member",
        email: "redeem.member@scratch.test",
      },
      context: { networkAddress: null, userAgent: null },
    });
    assert.ok(issuance && !issuance.emailQueued);

    const put = (origin: string, raw: string) =>
      PUT(
        new NextRequest("http://localhost:4780/api/password-reset", {
          method: "PUT",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ token: raw, password: "A brand new password 1042" }),
        }),
      );

    // The fleet's failing shape: page on 127.0.0.1, app link on localhost.
    const crossLoopback = await put("http://127.0.0.1:4780", issuance.raw);
    assert.equal(crossLoopback.status, 200);
    assert.deepEqual(await crossLoopback.json(), { ok: true });

    // The token is single-use: replaying it is invalid, not forbidden.
    const replay = await put("http://localhost:4780", issuance.raw);
    assert.equal(replay.status, 422);

    // A genuinely foreign origin still fails closed at the gate.
    const forged = await put("http://attacker.test", issuance.raw);
    assert.equal(forged.status, 403);

    // The password actually took: the placeholder hash is gone.
    const hash = await withBypassContext(async () => (
      await db.execute<{ password_hash: string }>(sql`
        select password_hash from users where id = ${seeded.userId}`)
    ).rows[0]!.password_hash);
    assert.notEqual(hash, "unusable");
  } finally {
    await dropScratchOrg(seeded.org.orgId);
  }
});
