import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withBypassContext, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/testing/fixtures.ts";

const deliveriesKey = Symbol.for("openbooks.reset-delivery-order-test");
const gateKey = Symbol.for("openbooks.reset-delivery-order-gate");
const enteredKey = Symbol.for("openbooks.reset-delivery-order-entered");
type Shared = Record<symbol, unknown>;
const shared = globalThis as typeof globalThis & Shared;

// Substitute only delivery: identity resolution, transaction scopes, locks,
// reset-token persistence and password changes use the real implementation.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (context.parentURL?.includes("auth-reset.ts") && specifier === "@openbooks/emails") {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
        export const deriveEmailDeliveryKey = () => 'isolated-delivery';
        export const passwordResetEmail = ({resetUrl}) => ({subject:'Reset',text:resetUrl,html:resetUrl});
        export async function sendVia(transport, message) {
          globalThis[Symbol.for('openbooks.reset-delivery-order-entered')] = true;
          await globalThis[Symbol.for('openbooks.reset-delivery-order-gate')]();
          globalThis[Symbol.for('openbooks.reset-delivery-order-test')].push(message.text);
          return {kind:'sent',providerMessageId:'isolated'};
        }
      `)}` };
    }
    if (context.parentURL?.includes("auth-reset.ts") && specifier === "@openbooks/engine/src/delivery/email-config.ts") {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
        export async function resolveOrgEmailTransport() { return {provider:'isolated'}; }
        export const insertEmailLog = async () => 'isolated-log';
        export const markEmailSent = async () => {};
        export const markEmailUncertain = async () => {};
        export const markEmailFailed = async () => {};
      `)}` };
    }
    return nextResolve(specifier, context);
  },
});

async function seedUser(orgId: string) {
  return withBypassContext(async () => {
    const userId = (await seedFlowActors(orgId)).adminId;
    const email = (await db.execute<{ email: string }>(sql`select email from users where id=${userId}`)).rows[0]!.email;
    await db.execute(sql`update orgs set env_kind='production' where id=${orgId}`);
    return { userId, email };
  });
}

function tokenOf(delivery: string): string {
  return new URL(delivery).searchParams.get("token")!;
}

test("a stalled first reset delivery lands before the superseding link", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const priorSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  const deliveries: string[] = [];
  shared[deliveriesKey] = deliveries;
  // One-shot gate: the first delivery stalls until the superseding mint
  // commits; every later delivery passes through, or the second send would
  // wait on a fresh promise nobody releases.
  let gateOpen = false;
  let releaseGate!: () => void;
  const gatePromise = new Promise<void>((resolve) => { releaseGate = resolve; });
  shared[gateKey] = () => (gateOpen ? Promise.resolve() : gatePromise);
  shared[enteredKey] = false;
  try {
    const { userId, email } = await seedUser(org.orgId);
    const { requestPasswordReset, completePasswordReset } = await import("./auth-reset");
    const context = { networkAddress: "127.0.0.1", userAgent: "isolated delivery order test" };
    // The first request mints and stalls inside provider delivery while
    // holding the per-user delivery lock.
    const first = requestPasswordReset(email, context);
    const enteredDeadline = Date.now() + 10_000;
    while (!shared[enteredKey] && Date.now() < enteredDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(shared[enteredKey], "first delivery must reach the provider");
    // The second request supersedes the first, then waits for the delivery
    // lock. Only after its mint commits is the gate released.
    const second = requestPasswordReset(email, { networkAddress: "127.0.0.2", userAgent: "isolated delivery order test" });
    const mintedDeadline = Date.now() + 10_000;
    let minted = 0;
    while (minted < 2 && Date.now() < mintedDeadline) {
      minted = await withBypass(async () => (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from auth_password_resets where user_id=${userId}`)).rows[0]!.n);
      if (minted < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(minted, 2);
    gateOpen = true;
    releaseGate();
    await Promise.all([first, second]);
    // Both sends completed in mint order: the most recent email holds the
    // live link, and only that link completes a reset.
    assert.equal(deliveries.length, 2);
    const [staleToken, liveToken] = [tokenOf(deliveries[0]!), tokenOf(deliveries[1]!)];
    assert.notEqual(staleToken, liveToken);
    assert.deepEqual(await completePasswordReset(staleToken, "Stale isolated password 4410"), {
      ok: false, reason: "invalid_token",
    });
    assert.deepEqual(await completePasswordReset(liveToken, "Live isolated password 4411"), { ok: true });
  } finally {
    delete shared[gateKey];
    delete shared[enteredKey];
    delete shared[deliveriesKey];
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("delivering a superseded reset token sends nothing", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const priorSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  const deliveries: string[] = [];
  shared[deliveriesKey] = deliveries;
  shared[gateKey] = async () => {};
  try {
    const { userId, email } = await seedUser(org.orgId);
    const { requestPasswordReset, deliverResetEmail } = await import("./auth-reset");
    const context = { networkAddress: "127.0.0.1", userAgent: "isolated superseded delivery test" };
    await requestPasswordReset(email, context);
    await requestPasswordReset(email, { networkAddress: "127.0.0.2", userAgent: "isolated superseded delivery test" });
    assert.equal(deliveries.length, 2);
    const staleToken = tokenOf(deliveries[0]!);
    const sent = await withOrgContext(org.orgId, async () => {
      const user = (await db.execute<{ id: string; org_id: string; name: string | null; email: string }>(sql`
        select id, org_id, name, email from users where id=${userId}`)).rows[0]!;
      return deliverResetEmail(user, { provider: "isolated" } as never, staleToken);
    });
    assert.equal(sent, false);
    assert.equal(deliveries.length, 2, "no additional send may follow a superseded delivery");
  } finally {
    delete shared[gateKey];
    delete shared[deliveriesKey];
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
