import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { sealSecret, unsealSecret } from "../platform/secrets.ts";

/**
 * Payment-link at-rest seal (migration 0251's bootstrap half).
 *
 * 0251 backfills `token_hash` in SQL for rows that existed when it ran, but
 * the plaintext `token` stays (the seal half needs the data key, which never
 * enters a migration). So an upgraded install holds rows with hash present +
 * plaintext present + no seal — alongside rows created afterwards by code
 * still serving during a rolling deploy (plaintext, no hash at all). The
 * engine resolves links by hash only, so this step must handle every
 * unfinished row: seal AND hash where either is missing, null the plaintext
 * always. Sealing without hashing orphans the link (URL shown, checkout
 * 404s); leaving the plaintext sealed-nothing persists it at rest forever.
 *
 * It also heals rows that an older bootstrap sealed-without-hash (unseal
 * with the data key, then hash). A row whose link secret is recoverable by
 * neither path — or whose stored hash does not match the recovered secret —
 * refuses the whole bootstrap: a link that can neither resolve nor display,
 * or whose columns disagree, must never be left behind silently.
 */

/** The lookup hash. Single source of truth — acceptance.ts resolves through this exact encoding. */
export function paymentLinkTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type PaymentLinkSealRow = {
  id: string;
  token: string | null;
  token_sealed: string | null;
  token_hash: string | null;
};

export type PaymentLinkSealPlan =
  | { id: string; tokenHash: string; tokenSealed: string }
  | { id: string; unrecoverable: true; reason: "missing-secret" | "hash-mismatch" };

/**
 * Pure per-row decision: recover the link secret from whichever column
 * still carries it (plaintext preferred — no key needed) and derive the
 * hash + seal pair the engine resolves and displays through.
 *
 * - `missing-secret`: neither column yields a secret; the caller must
 *   refuse, never skip.
 * - `hash-mismatch`: the row already carries a hash but it is not the hash
 *   of the recovered secret. One of the two columns is wrong (or was sealed
 *   under a different data key and the plaintext since changed); overwriting
 *   either side would hide the corruption, so the caller must refuse.
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
  if (plain === null || plain.length === 0) return { id: row.id, unrecoverable: true, reason: "missing-secret" };
  const tokenHash = crypto.hash(plain);
  if (row.token_hash !== null && row.token_hash !== tokenHash) {
    return { id: row.id, unrecoverable: true, reason: "hash-mismatch" };
  }
  return {
    id: row.id,
    tokenHash,
    tokenSealed: row.token_sealed ?? crypto.seal(plain),
  };
}

/**
 * Finish every payment link the engine cannot yet resolve AND display.
 * Idempotent: rows already carrying hash + seal with no plaintext (written
 * by the engine from day one, or finished by an earlier run) are untouched.
 * Throws fail-closed listing unrecoverable links — the operator must reissue
 * those; there is no safe automatic repair for a lost or disagreeing secret.
 */
export async function sealLegacyPaymentLinkTokens(): Promise<void> {
  await withBypassContext(async () => {
    // 0251 backfilled the hash but left the plaintext, so "hash present" is
    // NOT "finished": any row still holding plaintext — or missing hash or
    // seal — needs this step.
    const pending = await db.execute<PaymentLinkSealRow>(sql`
      select id, token, token_sealed, token_hash from payment_links
       where token_hash is null or token is not null or token_sealed is null
       order by id
    `);
    if (pending.rows.length > 0) {
      console.log(`[bootstrap] sealing ${pending.rows.length} payment link token(s) at rest`);
    }
    const unrecoverable: Array<{ id: string; reason: string }> = [];
    for (const row of pending.rows) {
      const plan = planPaymentLinkSeal(row);
      if ("unrecoverable" in plan) {
        unrecoverable.push({ id: plan.id, reason: plan.reason });
        continue;
      }
      // Affected-row check: under RLS an unscoped UPDATE matches zero rows
      // and reports success. Zero matched rows here means the link changed
      // under us — refuse rather than report a seal no read can observe.
      const updated = (await db.execute(sql`
        update payment_links
           set token_hash = ${plan.tokenHash}, token_sealed = ${plan.tokenSealed}, token = null
         where id = ${plan.id}
           and (token_hash is null or token is not null or token_sealed is null)
      `)) as unknown as { rowCount?: number | null };
      if (updated.rowCount !== 1) {
        throw new Error(
          `[bootstrap] payment link ${plan.id} changed during at-rest sealing; refusing to continue`,
        );
      }
    }
    if (unrecoverable.length > 0) {
      const ids = unrecoverable.slice(0, 5).map((u) => `${u.id} (${u.reason})`).join(", ");
      throw new Error(
        `[bootstrap] ${unrecoverable.length} payment link(s) cannot be sealed at rest ` +
          `(missing secret, or a stored hash that does not match the recovered secret): ` +
          `${ids}${unrecoverable.length > 5 ? ", …" : ""}. ` +
          `Reissue those links from the receivables panel, then re-run bootstrap`,
      );
    }
    // Fail closed: no plaintext may persist at rest, and every row must
    // resolve by hash (the engine's only lookup) and display through the
    // seal. Anything less is an unresolvable or undisplayable link — refuse
    // to serve past that state.
    const broken = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from payment_links
       where token is not null or token_hash is null or token_sealed is null
    `);
    if (Number(broken.rows[0]?.n ?? 0) > 0) {
      throw new Error(
        "[bootstrap] payment_links has rows holding plaintext or missing their hash or seal; refusing to continue",
      );
    }
  });
}
