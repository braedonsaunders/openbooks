import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { sealSecret, unsealSecret } from "../platform/secrets.ts";

/**
 * Payment-link at-rest seal (migration 0251's bootstrap half).
 *
 * 0251 backfills `token_hash` for rows that existed when it ran, but rows
 * created afterwards — notably by code still serving during a rolling deploy —
 * arrive with a plaintext `token` and no hash. The engine resolves links by
 * hash only, so sealing such a row (nulling the plaintext) without computing
 * its hash orphans the link permanently: the URL is shown, checkout 404s.
 *
 * This step therefore seals AND hashes every hash-less row in one UPDATE, and
 * also heals rows that were already sealed-without-hash by an older bootstrap
 * (unseal with the data key, then hash). A row whose link secret is
 * recoverable by neither path refuses the whole bootstrap: a link that can
 * neither resolve nor display must never be left behind silently.
 */

/** The lookup hash. Single source of truth — acceptance.ts resolves through this exact encoding. */
export function paymentLinkTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type PaymentLinkSealRow = {
  id: string;
  token: string | null;
  token_sealed: string | null;
};

export type PaymentLinkSealPlan =
  | { id: string; tokenHash: string; tokenSealed: string }
  | { id: string; unrecoverable: true };

/**
 * Pure per-row decision: recover the link secret from whichever column
 * still carries it (plaintext preferred — no key needed) and derive the
 * hash + seal pair the engine resolves and displays through. `unrecoverable`
 * means neither column yields a token and the caller must refuse, never skip.
 *
 * `crypto` is injectable so tests can pin the seal without the data key; the
 * production wiring below passes the real primitives.
 */
export function planPaymentLinkSeal(
  row: PaymentLinkSealRow,
  crypto: {
    seal: (plain: string) => string;
    unseal: (sealed: string) => string | null;
    hash: (plain: string) => string;
  } = { seal: sealSecret, unseal: unsealSecret, hash: paymentLinkTokenHash },
): PaymentLinkSealPlan {
  const plain = row.token ?? (row.token_sealed === null ? null : crypto.unseal(row.token_sealed));
  if (plain === null || plain.length === 0) return { id: row.id, unrecoverable: true };
  return {
    id: row.id,
    tokenHash: crypto.hash(plain),
    tokenSealed: row.token_sealed ?? crypto.seal(plain),
  };
}

/**
 * Seal + hash every payment link the engine cannot yet resolve by hash.
 * Idempotent: rows already carrying `token_hash` (written by the engine from
 * day one, or sealed by an earlier run) are untouched. Throws fail-closed
 * listing how many links are unrecoverable — the operator must reissue those
 * links; there is no safe automatic repair for a lost link secret
 */
export async function sealLegacyPaymentLinkTokens(): Promise<void> {
  await withBypassContext(async () => {
    const pending = await db.execute<PaymentLinkSealRow>(sql`
      select id, token, token_sealed from payment_links
       where token_hash is null
       order by id
    `);
    if (pending.rows.length > 0) {
      console.log(`[bootstrap] sealing ${pending.rows.length} payment link token(s) at rest`);
    }
    const unrecoverable: string[] = [];
    for (const row of pending.rows) {
      const plan = planPaymentLinkSeal(row);
      if ("unrecoverable" in plan) {
        unrecoverable.push(plan.id);
        continue;
      }
      // Affected-row check: under RLS an unscoped UPDATE matches zero rows
      // and reports success. Zero matched rows here means the link changed
      // under us — refuse rather than report a seal no read can observe.
      const updated = (await db.execute(sql`
        update payment_links
           set token_hash = ${plan.tokenHash}, token_sealed = ${plan.tokenSealed}, token = null
         where id = ${plan.id} and token_hash is null
      `)) as unknown as { rowCount?: number | null };
      if (updated.rowCount !== 1) {
        throw new Error(
          `[bootstrap] payment link ${plan.id} changed during at-rest sealing; refusing to continue`,
        );
      }
    }
    if (unrecoverable.length > 0) {
      throw new Error(
        `[bootstrap] ${unrecoverable.length} payment link(s) have no recoverable token ` +
          `(neither plaintext nor an unsealable seal) and would resolve to nothing: ` +
          `${unrecoverable.slice(0, 5).join(", ")}${unrecoverable.length > 5 ? ", …" : ""}. ` +
          `Reissue those links from the receivables panel, then re-run bootstrap`,
      );
    }
    // Fail closed: every remaining row must resolve by hash (the engine's
    // only lookup) and display through the seal. A row missing either is an
    // undisplayable or unresolvable link — refuse to serve past that state.
    const broken = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from payment_links
       where token_hash is null or (token is null and token_sealed is null)
    `);
    if (Number(broken.rows[0]?.n ?? 0) > 0) {
      throw new Error(
        "[bootstrap] payment_links has rows that cannot resolve by hash or display through a seal; refusing to continue",
      );
    }
  });
}
