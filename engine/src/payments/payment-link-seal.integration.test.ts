import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { sealSecret, unsealSecret } from "../platform/secrets.ts";
import {
  paymentLinkTokenHash,
  planPaymentLinkSeal,
  sealLegacyPaymentLinkTokens,
} from "./payment-link-seal.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const priorDataKey = process.env.OPENBOOKS_DATA_KEY;

let org: Awaited<ReturnType<typeof createScratchOrg>> | null = null;

beforeEach(async () => {
  process.env.OPENBOOKS_DATA_KEY = "00".repeat(32);
  if (DB) org = await createScratchOrg();
});

afterEach(async () => {
  const leasedOrg = org; org = null;
  try { if (leasedOrg) await dropScratchOrg(leasedOrg.orgId); } finally {
    if (priorDataKey === undefined) delete process.env.OPENBOOKS_DATA_KEY;
    else process.env.OPENBOOKS_DATA_KEY = priorDataKey;
  }
});

type LinkSeed = { id: string; orgId: string; token: string | null; tokenSealed: string | null; tokenHash: string | null };

async function insertLink(seed: Partial<LinkSeed> & { token?: string | null }): Promise<LinkSeed> {
  const orgId = org!.orgId;
  // The composite foreign keys and account-class trigger require the acceptance suite's minimal draft invoice.
  const invoiceId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, currency, fx_rate, subtotal, tax_total, total, open_balance)
    values (${invoiceId}, ${orgId}, 'customer_invoice', 'draft', ${`SEAL-${randomUUID()}`},
            ${org!.subsidiaryId}, ${org!.customerId}, ${org!.date}, 'USD', '1',
            '100', '0', '100', '100')
  `));
  const row: LinkSeed = {
    id: randomUUID(), orgId,
    token: seed.token ?? null, tokenSealed: seed.tokenSealed ?? null,
    tokenHash: seed.tokenHash ?? null,
  };
  await withBypassContext(() => db.execute(sql`
    insert into payment_links
      (id, org_id, token, token_hash, token_sealed, document_id, party_id, subsidiary_id,
       provider, bank_account_id, amount, surcharge_amount, currency, status)
    values (${row.id}, ${row.orgId}, ${row.token}, ${row.tokenHash}, ${row.tokenSealed},
            ${invoiceId}, ${org!.customerId}, ${org!.subsidiaryId},
            'stripe', ${org!.accounts.bank}, 100, 0, 'USD', 'active')
  `));
  return row;
}

async function readLink(id: string): Promise<{ token: string | null; tokenSealed: string | null; tokenHash: string | null }> {
  const r = await withBypassContext(() => db.execute<{ token: string | null; tokenSealed: string | null; tokenHash: string | null }>(sql`
    select token, token_sealed as "tokenSealed", token_hash as "tokenHash"
      from payment_links where id = ${id}
  `));
  return r.rows[0]!;
}

async function removeLink(id: string): Promise<void> {
  await withBypassContext(() => db.execute(sql`delete from payment_links where id = ${id}`));
}

/** The engine's only public lookup: resolve by hash, exactly as checkout does. */
async function resolveByHash(hash: string): Promise<string | null> {
  const r = await withBypassContext(() => db.execute<{ id: string }>(sql`
    select id from payment_links where token_hash = ${hash} limit 1
  `));
  return r.rows[0]?.id ?? null;
}

test("deploy-window plaintext rows are sealed AND hashed in one step", { skip: !DB }, async () => {
  const secret = `link-secret-${randomUUID()}`;
  const row = await insertLink({ token: secret });
  try {
    await sealLegacyPaymentLinkTokens();
    const after = await readLink(row.id);
    assert.equal(after.token, null, "plaintext must not persist at rest");
    assert.ok(after.tokenSealed, "display seal must be set");
    assert.equal(after.tokenHash, paymentLinkTokenHash(secret), "lookup hash must match the secret");
    assert.equal(await resolveByHash(paymentLinkTokenHash(secret)), row.id, "link must resolve by hash after sealing");
    assert.equal(unsealSecret(after.tokenSealed!, { orgId: org!.orgId, purpose: "payment.link.token" }), secret, "display path must recover the secret");
  } finally {
    await removeLink(row.id);
  }
});

test("rows sealed-without-hash by an older bootstrap are healed, not re-sealed", { skip: !DB }, async () => {
  const secret = `link-secret-${randomUUID()}`;
  const sealed = sealSecret(secret, { orgId: org!.orgId, purpose: "payment.link.token" });
  const row = await insertLink({ token: null, tokenSealed: sealed });
  try {
    await sealLegacyPaymentLinkTokens();
    const after = await readLink(row.id);
    assert.equal(after.tokenHash, paymentLinkTokenHash(secret), "hash must be backfilled from the seal");
    assert.equal(after.tokenSealed, sealed, "existing seal must be kept, not rotated");
    assert.equal(await resolveByHash(paymentLinkTokenHash(secret)), row.id, "healed link must resolve by hash");
  } finally {
    await removeLink(row.id);
  }
});

test("node hash encoding is byte-identical to the 0251 migration SQL", { skip: !DB }, async () => {
  // Migration SQL and engine hashing must agree so migrated rows remain resolvable.
  const ascii = "AbC123xY-9_8qZ";
  const r = await withBypassContext(() => db.execute<{ h: string }>(sql`
    select encode(sha256(${ascii}::bytea), 'hex') as h
  `));
  assert.equal(paymentLinkTokenHash(ascii), r.rows[0]!.h);
  assert.equal(paymentLinkTokenHash(ascii).length, 64);
});

test("unrecoverable links refuse the bootstrap and name reissue as the remedy", { skip: !DB }, async () => {
  const goodSecret = `link-secret-${randomUUID()}`;
  const good = await insertLink({ token: goodSecret });
  const bad = await insertLink({ token: null, tokenSealed: "enc:v1:definitely-not-a-seal" });
  try {
    await assert.rejects(sealLegacyPaymentLinkTokens(), /Reissue those links/);
    // Recoverable links are sealed before one bad link causes refusal.
    const goodAfter = await readLink(good.id);
    assert.equal(goodAfter.token, null);
    assert.equal(goodAfter.tokenHash, paymentLinkTokenHash(goodSecret));
  } finally {
    await removeLink(good.id);
    await removeLink(bad.id);
  }
});

test("already-hashed rows are untouched (engine-written links)", { skip: !DB }, async () => {
  const secret = `link-secret-${randomUUID()}`;
  const sealed = sealSecret(secret, { orgId: org!.orgId, purpose: "payment.link.token" });
  const row = await insertLink({ token: null, tokenSealed: sealed, tokenHash: paymentLinkTokenHash(secret) });
  try {
    await sealLegacyPaymentLinkTokens();
    const after = await readLink(row.id);
    assert.equal(after.tokenHash, paymentLinkTokenHash(secret));
    assert.equal(after.tokenSealed, sealed);
  } finally {
    await removeLink(row.id);
  }
});

test("upgraded-install rows (migration hash + leftover plaintext) are sealed and nulled", { skip: !DB }, async () => {
  const secret = `link-secret-${randomUUID()}`;
  const row = await insertLink({ token: secret, tokenSealed: null, tokenHash: paymentLinkTokenHash(secret) });
  try {
    await sealLegacyPaymentLinkTokens();
    const after = await readLink(row.id);
    assert.equal(after.token, null, "no plaintext may persist at rest");
    assert.ok(after.tokenSealed, "display seal must be set");
    assert.equal(after.tokenHash, paymentLinkTokenHash(secret), "verified hash must be kept");
    assert.equal(await resolveByHash(paymentLinkTokenHash(secret)), row.id, "link must resolve by hash");
    assert.equal(unsealSecret(after.tokenSealed!, { orgId: org!.orgId, purpose: "payment.link.token" }), secret, "display path must recover the secret");
  } finally {
    await removeLink(row.id);
  }
});

test("a stored hash that does not match the secret refuses instead of overwriting", { skip: !DB }, async () => {
  const row = await insertLink({
    token: `link-secret-${randomUUID()}`,
    tokenSealed: null,
    tokenHash: "0".repeat(64),
  });
  try {
    await assert.rejects(sealLegacyPaymentLinkTokens(), /hash-mismatch/);
  } finally {
    await removeLink(row.id);
  }
});

test("planner prefers plaintext, keeps an existing seal, refuses empty rows", () => {
  const crypto = {
    seal: (plain: string) => `sealed(${plain})`,
    unseal: (sealed: string) => (sealed === "good-seal" ? "unsealed-secret" : null),
    hash: (plain: string) => `hash(${plain})`,
  };
  const input = (id: string, token: string | null, tokenSealed: string | null, tokenHash: string | null) =>
    ({ id, orgId: "org-1", token, token_sealed: tokenSealed, token_hash: tokenHash });
  const saved = (id: string, tokenHash: string, tokenSealed: string) => ({ id, tokenHash, tokenSealed });
  const refused = (id: string, reason: "missing-secret" | "hash-mismatch") => ({ id, unrecoverable: true, reason });
  const cases = [
    ["plaintext", input("a", "plain", null, null), saved("a", "hash(plain)", "sealed(plain)")],
    ["existing seal", input("b", "plain", "existing", null), saved("b", "hash(plain)", "existing")],
    ["upgraded row", input("b2", "plain", null, "hash(plain)"), saved("b2", "hash(plain)", "sealed(plain)")],
    ["recoverable seal", input("c", null, "good-seal", null), saved("c", "hash(unsealed-secret)", "good-seal")],
    ["bad seal", input("d", null, "bad-seal", null), refused("d", "missing-secret")],
    ["empty row", input("e", null, null, null), refused("e", "missing-secret")],
    ["mismatched hash", input("f", "plain", null, "hash(other)"), refused("f", "hash-mismatch")],
  ] as const;
  for (const [caseName, input, expected] of cases) {
    assert.deepEqual(planPaymentLinkSeal(input, crypto), expected, caseName);
  }
});
