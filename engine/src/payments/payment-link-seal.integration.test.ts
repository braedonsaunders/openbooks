import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
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

before(async () => {
  process.env.OPENBOOKS_DATA_KEY = "00".repeat(32);
  if (!DB) return;
  org = await createScratchOrg();
});

after(async () => {
  if (priorDataKey === undefined) delete process.env.OPENBOOKS_DATA_KEY;
  else process.env.OPENBOOKS_DATA_KEY = priorDataKey;
  if (org) await dropScratchOrg(org.orgId);
});

type LinkSeed = {
  id: string;
  orgId: string;
  token: string | null;
  tokenSealed: string | null;
  tokenHash: string | null;
};

async function insertLink(seed: Partial<LinkSeed> & { token?: string | null }): Promise<LinkSeed> {
  const orgId = org!.orgId;
  // payment_links carries composite foreign keys to documents/parties/
  // subsidiaries/accounts plus an account-class trigger, so each probe link
  // rides a minimal draft invoice on the scratch org (mirrors the acceptance
  // suite's own legacy-row inserts).
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
    id: randomUUID(),
    orgId,
    token: seed.token ?? null,
    tokenSealed: seed.tokenSealed ?? null,
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
  // Simulates a link created by code still serving while migrations ran:
  // plaintext present, no hash, no seal.
  const secret = `link-secret-${randomUUID()}`;
  const row = await insertLink({ token: secret });
  try {
    await sealLegacyPaymentLinkTokens();
    const after = await readLink(row.id);
    assert.equal(after.token, null, "plaintext must not persist at rest");
    assert.ok(after.tokenSealed, "display seal must be set");
    assert.equal(after.tokenHash, paymentLinkTokenHash(secret), "lookup hash must match the secret");
    assert.equal(await resolveByHash(paymentLinkTokenHash(secret)), row.id, "link must resolve by hash after sealing");
    assert.equal(unsealSecret(after.tokenSealed), secret, "display path must recover the secret");
  } finally {
    await removeLink(row.id);
  }
});

test("rows sealed-without-hash by an older bootstrap are healed, not re-sealed", { skip: !DB }, async () => {
  // This is the state the pre-fix bootstrap left behind: sealed, nulled, unresolvable.
  const secret = `link-secret-${randomUUID()}`;
  const sealed = sealSecret(secret);
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
  // The migration hashes in SQL (encode(sha256(token::bytea),'hex')); the
  // engine and the seal step hash in node. A divergence would make
  // migration-backfilled rows unresolvable by engine-computed hashes.
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
    // The refusal fires after recoverable rows are sealed: one bad link must
    // not strand every good link behind it.
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
  const sealed = sealSecret(secret);
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
  // This is the state 0251 itself leaves on an upgraded install: the
  // migration backfilled the hash in SQL but could not seal or null the
  // plaintext without the data key.
  const secret = `link-secret-${randomUUID()}`;
  const row = await insertLink({ token: secret, tokenSealed: null, tokenHash: paymentLinkTokenHash(secret) });
  try {
    await sealLegacyPaymentLinkTokens();
    const after = await readLink(row.id);
    assert.equal(after.token, null, "no plaintext may persist at rest");
    assert.ok(after.tokenSealed, "display seal must be set");
    assert.equal(after.tokenHash, paymentLinkTokenHash(secret), "verified hash must be kept");
    assert.equal(await resolveByHash(paymentLinkTokenHash(secret)), row.id, "link must resolve by hash");
    assert.equal(unsealSecret(after.tokenSealed), secret, "display path must recover the secret");
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
  const legacy = planPaymentLinkSeal({ id: "a", token: "plain", token_sealed: null, token_hash: null }, crypto);
  assert.deepEqual(legacy, { id: "a", tokenHash: "hash(plain)", tokenSealed: "sealed(plain)" });

  const partial = planPaymentLinkSeal({ id: "b", token: "plain", token_sealed: "existing", token_hash: null }, crypto);
  assert.deepEqual(partial, { id: "b", tokenHash: "hash(plain)", tokenSealed: "existing" });

  // The 0251-upgraded shape: hash already present and matching, plaintext
  // still present, no seal — seal it, null it, keep the verified hash.
  const upgraded = planPaymentLinkSeal(
    { id: "b2", token: "plain", token_sealed: null, token_hash: "hash(plain)" },
    crypto,
  );
  assert.deepEqual(upgraded, { id: "b2", tokenHash: "hash(plain)", tokenSealed: "sealed(plain)" });

  const healed = planPaymentLinkSeal({ id: "c", token: null, token_sealed: "good-seal", token_hash: null }, crypto);
  assert.deepEqual(healed, { id: "c", tokenHash: "hash(unsealed-secret)", tokenSealed: "good-seal" });

  assert.deepEqual(
    planPaymentLinkSeal({ id: "d", token: null, token_sealed: "bad-seal", token_hash: null }, crypto),
    { id: "d", unrecoverable: true, reason: "missing-secret" },
  );
  assert.deepEqual(
    planPaymentLinkSeal({ id: "e", token: null, token_sealed: null, token_hash: null }, crypto),
    { id: "e", unrecoverable: true, reason: "missing-secret" },
  );
  assert.deepEqual(
    planPaymentLinkSeal({ id: "f", token: "plain", token_sealed: null, token_hash: "hash(other)" }, crypto),
    { id: "f", unrecoverable: true, reason: "hash-mismatch" },
  );
});
