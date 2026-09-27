/**
 * Re-seal every sealed column under the active data key.
 *
 *   npx tsx scripts/rotate-data-key.ts                 # dry run: probe only, no writes
 *   npx tsx scripts/rotate-data-key.ts --apply         # re-seal and write
 *   npx tsx scripts/rotate-data-key.ts --org=<id>      # one tenant (plus its users' MFA factors)
 *
 * Rotation procedure: configure both keys (`OPENBOOKS_DATA_KEYS=k1=<old>,k2=<new>`
 * with `OPENBOOKS_DATA_KEY_ACTIVE=k2`), run this script with --apply, verify the
 * report shows every blob current, then remove the retired key id. Blobs already
 * sealed under the active key are verified but left untouched.
 *
 * Every table rotates inside ONE transaction with per-row compare-and-swap
 * writes (`... where id = <id> and <col> = <old>`): a row changed under the
 * script refuses the whole run instead of sealing over a concurrent edit, and
 * a write matching zero rows is a failure, never success. A blob that opens
 * under NO configured key refuses naming the table, row, purpose, and key
 * id — re-enter that credential (or restore the sealing key) and re-run.
 *
 * Email credentials sealed before the data-key move (`keyCiphertext` /
 * `keyNonce` under SESSION_SECRET) migrate to `keySealed` in the same run;
 * that leg needs the source SESSION_SECRET still configured.
 *
 * Year-end filing snapshots (`payroll_filing_submission_slips.reported`)
 * carry keyed fingerprints of confidential identifiers, not the identifiers
 * themselves, so they cannot be re-sealed — they are RE-FINGERPRINTED under
 * the active key in the same run, one transaction with compare-and-swap
 * row-count checks like every other leg. A snapshot is only rewritten when
 * the profile still holds exactly what it reported; an identifier that moved
 * since issue keeps its old fingerprint (still comparable while the retired
 * key is configured) so the pending change is never erased. A snapshot whose
 * key id is absent from the ring refuses naming the slip — restore the
 * retired key and re-run.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool, withBypassContext } from "../engine/src/platform/db.ts";
import {
  describeSealedBlob,
  KeyedFingerprintError,
  loadDataKeyRing,
  sealSecret,
  unsealSecret,
  type SecretScope,
} from "../engine/src/platform/secrets.ts";
import { planFingerprintReseal } from "../engine/src/payroll/yearend-amendments.ts";
import type { PayrollFilingReported } from "../engine/src/payroll/filing-registry.ts";
import { sealSecret as sealEmailSecret, unsealLegacyEmailSecret } from "@openbooks/emails";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const onlyOrg = args.find((a) => a.startsWith("--org="))?.slice("--org=".length) ?? null;

export type ResealReport = {
  table: string;
  column: string;
  rows: number;
  alreadyCurrent: number;
  resealed: number;
  /**
   * Fingerprint rows the run verified but left on their old key: the
   * identifier moved (or can no longer be proven) since the snapshot was
   * issued, so rewriting it from today's profile would erase a pending
   * change. Still comparable while the retired key is configured.
   */
  skipped?: number;
};

function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * Pure re-seal decision for one stored value. Null means nothing is stored
 * (unconfigured — skipped, never written). Otherwise the value must open
 * under a configured key or this throws naming table, row, purpose, and key
 * id; a v2 blob already under the active key is verified and returned
 * unchanged.
 */
export function planReseal(
  stored: string | null | undefined,
  scope: SecretScope,
  activeId: string,
  where: string,
): { sealed: string; changed: boolean } | null {
  if (stored == null || stored === "") return null;
  let plain: string;
  try {
    plain = unsealSecret(stored, scope);
  } catch (error) {
    throw new Error(
      `${where}: cannot unseal purpose ${scope.purpose} for org ${scope.orgId} ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const described = describeSealedBlob(stored);
  if (described?.version === "v2" && described.keyId === activeId) return { sealed: stored, changed: false };
  return { sealed: sealSecret(plain, scope), changed: true };
}

type TextTarget = {
  table: string;
  column: string;
  purpose: string;
  /** SELECT rows: id, org_id, value (+ user_id when userScoped). */
  select: (org: string | null) => Promise<Array<{ id: string; orgId: string; userId?: string; value: string | null }>>;
  update: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], id: string, oldValue: string, newValue: string) => Promise<number>;
};

async function selectTextColumn(
  table: string,
  column: string,
  orgColumn: string,
  org: string | null,
  userColumn?: string,
): Promise<Array<{ id: string; orgId: string; userId?: string; value: string | null }>> {
  // Table/column names come from the static TARGETS list below — never from
  // argv — so identifier interpolation here cannot carry operator input.
  const userSelect = userColumn ? `, t.${userColumn} as "userId"` : "";
  const orgFilter = org ? ` and t.${orgColumn} = '${org.replace(/'/g, "''")}'` : "";
  const r = await db.execute<{ id: string; orgId: string; userId?: string; value: string | null }>(sql.raw(
    `select t.id::text as id, t.${orgColumn}::text as "orgId"${userSelect}, t.${column} as value from ${table} t where t.${column} is not null${orgFilter} order by t.id`,
  ));
  return r.rows;
}

export async function rotateDataKey(options: { apply: boolean; org?: string | null }): Promise<ResealReport[]> {
  const ring = loadDataKeyRing();
  const activeId = ring.activeId;
  const reports: ResealReport[] = [];
  const applyRun = options.apply;
  const org = options.org ?? null;

  const textTargets: TextTarget[] = [
    {
      table: "connections",
      column: "secrets",
      purpose: "connection.secrets",
      select: (o) => selectTextColumn("connections", "secrets", "org_id", o),
      update: async (tx, id, oldValue, newValue) => {
        const r = (await tx.execute(sql`
          update connections set secrets = ${newValue}, updated_at = now()
           where id = ${id} and secrets = ${oldValue}`)) as unknown as { rowCount?: number | null };
        return r.rowCount ?? 0;
      },
    },
    {
      table: "bank_feed_connections",
      column: "credentials",
      purpose: "bankfeed.credentials",
      select: (o) => selectTextColumn("bank_feed_connections", "credentials", "org_id", o),
      update: async (tx, id, oldValue, newValue) => {
        const r = (await tx.execute(sql`
          update bank_feed_connections set credentials = ${newValue}, updated_at = now()
           where id = ${id} and credentials = ${oldValue}`)) as unknown as { rowCount?: number | null };
        return r.rowCount ?? 0;
      },
    },
    {
      table: "fx_provider_configs",
      column: "secrets",
      purpose: "fx.provider.secrets",
      select: (o) => selectTextColumn("fx_provider_configs", "secrets", "org_id", o),
      update: async (tx, id, oldValue, newValue) => {
        const r = (await tx.execute(sql`
          update fx_provider_configs set secrets = ${newValue}, updated_at = now()
           where id = ${id} and secrets = ${oldValue}`)) as unknown as { rowCount?: number | null };
        return r.rowCount ?? 0;
      },
    },
    {
      table: "payment_bank_profiles",
      column: "originator_secrets_encrypted",
      purpose: "payment.originator.secrets",
      select: (o) => selectTextColumn("payment_bank_profiles", "originator_secrets_encrypted", "org_id", o),
      update: async (tx, id, oldValue, newValue) => {
        const r = (await tx.execute(sql`
          update payment_bank_profiles set originator_secrets_encrypted = ${newValue}, updated_at = now()
           where id = ${id} and originator_secrets_encrypted = ${oldValue}`)) as unknown as {
          rowCount?: number | null;
        };
        return r.rowCount ?? 0;
      },
    },
    {
      table: "psp_provider_configs",
      column: "secrets",
      purpose: "payment.provider.secrets",
      select: (o) => selectTextColumn("psp_provider_configs", "secrets", "org_id", o),
      update: async (tx, id, oldValue, newValue) => {
        const r = (await tx.execute(sql`
          update psp_provider_configs set secrets = ${newValue}, updated_at = now()
           where id = ${id} and secrets = ${oldValue}`)) as unknown as { rowCount?: number | null };
        return r.rowCount ?? 0;
      },
    },
    {
      table: "payment_links",
      column: "token_sealed",
      purpose: "payment.link.token",
      select: (o) => selectTextColumn("payment_links", "token_sealed", "org_id", o),
      update: async (tx, id, oldValue, newValue) => {
        const r = (await tx.execute(sql`
          update payment_links set token_sealed = ${newValue}
           where id = ${id} and token_sealed = ${oldValue}`)) as unknown as { rowCount?: number | null };
        return r.rowCount ?? 0;
      },
    },
    {
      table: "employee_payroll_profiles",
      column: "sin_encrypted",
      purpose: "payroll.employee.sin",
      select: (o) => selectTextColumn("employee_payroll_profiles", "sin_encrypted", "org_id", o),
      update: async (tx, id, oldValue, newValue) => {
        const r = (await tx.execute(sql`
          update employee_payroll_profiles set sin_encrypted = ${newValue}, updated_at = now()
           where id = ${id} and sin_encrypted = ${oldValue}`)) as unknown as { rowCount?: number | null };
        return r.rowCount ?? 0;
      },
    },
    {
      table: "party_bank_accounts",
      column: "account_number_encrypted",
      purpose: "payment.counterparty.account",
      select: (o) => selectTextColumn("party_bank_accounts", "account_number_encrypted", "org_id", o),
      update: async (tx, id, oldValue, newValue) => {
        const r = (await tx.execute(sql`
          update party_bank_accounts set account_number_encrypted = ${newValue}, updated_at = now()
           where id = ${id} and account_number_encrypted = ${oldValue}`)) as unknown as {
          rowCount?: number | null;
        };
        return r.rowCount ?? 0;
      },
    },
    {
      table: "sftp_servers",
      column: "password_encrypted",
      purpose: "sftp.server.secret",
      select: (o) => selectTextColumn("sftp_servers", "password_encrypted", "org_id", o),
      update: async (tx, id, oldValue, newValue) => {
        const r = (await tx.execute(sql`
          update sftp_servers set password_encrypted = ${newValue}, updated_at = now()
           where id = ${id} and password_encrypted = ${oldValue}`)) as unknown as { rowCount?: number | null };
        return r.rowCount ?? 0;
      },
    },
    {
      table: "tax_rate_provider_configs",
      column: "secrets",
      purpose: "tax.provider.secrets",
      select: (o) => selectTextColumn("tax_rate_provider_configs", "secrets", "org_id", o),
      update: async (tx, id, oldValue, newValue) => {
        const r = (await tx.execute(sql`
          update tax_rate_provider_configs set secrets = ${newValue}, updated_at = now()
           where id = ${id} and secrets = ${oldValue}`)) as unknown as { rowCount?: number | null };
        return r.rowCount ?? 0;
      },
    },
    {
      table: "vendor_roles",
      column: "tin_encrypted",
      purpose: "compliance.vendor.tin",
      select: (o) => selectTextColumn("vendor_roles", "tin_encrypted", "org_id", o),
      update: async (tx, id, oldValue, newValue) => {
        // vendor_roles is keyed by party, not by a surrogate id.
        const r = (await tx.execute(sql`
          update vendor_roles set tin_encrypted = ${newValue}
           where party_id = ${id} and tin_encrypted = ${oldValue}`)) as unknown as { rowCount?: number | null };
        return r.rowCount ?? 0;
      },
    },
  ];

  // bypass: cross-org-by-design — data-key rotation re-seals ciphertext of every organization.
  await withBypassContext(async () => {
    for (const target of textTargets) {
      const rows = await target.select(org);
      let alreadyCurrent = 0;
      let resealed = 0;
      const writes: Array<{ id: string; oldValue: string; newValue: string }> = [];
      for (const row of rows) {
        const planned = planReseal(
          row.value,
          { orgId: row.orgId, purpose: target.purpose },
          activeId,
          `${target.table}.${target.column} row ${row.id}`,
        );
        if (!planned) continue;
        if (planned.changed) {
          resealed += 1;
          writes.push({ id: row.id, oldValue: row.value!, newValue: planned.sealed });
        } else {
          alreadyCurrent += 1;
        }
      }
      if (applyRun && writes.length > 0) {
        await db.transaction(async (tx) => {
          for (const w of writes) {
            const matched = await target.update(tx, w.id, w.oldValue, w.newValue);
            if (matched !== 1) {
              throw new Error(
                `${target.table}.${target.column} row ${w.id} changed during rotation (matched ${matched} rows); ` +
                  `refusing to seal over a concurrent edit — re-run`,
              );
            }
          }
        });
      }
      reports.push({ table: target.table, column: target.column, rows: rows.length, alreadyCurrent, resealed });
    }

    // MFA factors are user-level: the seal scope carries the user id, and an
    // --org run covers the org's users through the users join.
    {
      const orgFilter = org ? ` and user_row.org_id = '${org.replace(/'/g, "''")}'` : "";
      const factors = await db.execute<{ id: string; userId: string; value: string | null }>(sql.raw(
        `select factor.user_id::text as "userId", factor.user_id::text as id, factor.secret_encrypted as value
           from auth_mfa_factors factor join users user_row on user_row.id = factor.user_id
          where 1 = 1${orgFilter} order by factor.user_id`,
      ));
      let alreadyCurrent = 0;
      const writes: Array<{ userId: string; oldValue: string; newValue: string }> = [];
      for (const row of factors.rows) {
        const planned = planReseal(
          row.value,
          { orgId: row.userId, purpose: "auth.mfa.secret" },
          activeId,
          `auth_mfa_factors.secret_encrypted user ${row.userId}`,
        );
        if (!planned) continue;
        if (planned.changed) writes.push({ userId: row.userId, oldValue: row.value!, newValue: planned.sealed });
        else alreadyCurrent += 1;
      }
      if (applyRun && writes.length > 0) {
        await db.transaction(async (tx) => {
          for (const w of writes) {
            const r = (await tx.execute(sql`
              update auth_mfa_factors set secret_encrypted = ${w.newValue}, updated_at = now()
               where user_id = ${w.userId} and secret_encrypted = ${w.oldValue}`)) as unknown as {
              rowCount?: number | null;
            };
            if ((r.rowCount ?? 0) !== 1) {
              throw new Error(
                `auth_mfa_factors.secret_encrypted user ${w.userId} changed during rotation; ` +
                  `refusing to seal over a concurrent edit — re-run`,
              );
            }
          }
        });
      }
      reports.push({
        table: "auth_mfa_factors",
        column: "secret_encrypted",
        rows: factors.rows.length,
        alreadyCurrent,
        resealed: writes.length,
      });
    }

    // orgs.settings carries three sealed shapes: the AI key, the document
    // capture key, and the email credential (current keySealed plus legacy
    // SESSION_SECRET keyCiphertext/keyNonce, which migrates here too).
    {
      const orgFilter = org ? ` where id = '${org.replace(/'/g, "''")}'` : "";
      const orgs = await db.execute<{ id: string; settings: unknown }>(sql.raw(
        `select id::text as id, settings from orgs${orgFilter} order by id`,
      ));
      let checked = 0;
      let resealed = 0;
      const writes: Array<{ id: string; oldSettings: string; newSettings: string }> = [];
      for (const row of orgs.rows) {
        const settings = (row.settings && typeof row.settings === "object" ? row.settings : {}) as Record<string, unknown>;
        const next = rotateOrgSettings(row.id, settings, activeId);
        checked += 1;
        if (next.changed) {
          resealed += 1;
          writes.push({ id: row.id, oldSettings: JSON.stringify(row.settings ?? {}), newSettings: JSON.stringify(next.settings) });
        }
      }
      if (applyRun && writes.length > 0) {
        await db.transaction(async (tx) => {
          for (const w of writes) {
            const r = (await tx.execute(sql`
              update orgs set settings = ${w.newSettings}::jsonb, updated_at = now()
               where id = ${w.id} and settings = ${w.oldSettings}::jsonb`)) as unknown as {
              rowCount?: number | null;
            };
            if ((r.rowCount ?? 0) !== 1) {
              throw new Error(
                `orgs.settings org ${w.id} changed during rotation; refusing to seal over a concurrent edit — re-run`,
              );
            }
          }
        });
      }
      reports.push({ table: "orgs", column: "settings", rows: checked, alreadyCurrent: checked - resealed, resealed });
    }

    // Filing snapshots carry keyed fingerprints, not sealed blobs: each
    // one is verified against today's profile and, when it still proves,
    // rewritten under the active key — same per-table transaction and
    // compare-and-swap row-count checks as every sealed leg. Drifted rows
    // (an identifier that moved since issue) are counted and left alone.
    {
      const orgFilter = org ? ` and s.org_id = '${org.replace(/'/g, "''")}'` : "";
      const slips = await db.execute<{
        id: string;
        orgId: string;
        country: string;
        filingKey: string;
        taxYear: number;
        rowId: string;
        reported: unknown;
      }>(sql.raw(
        `select sl.id::text as id, s.org_id::text as "orgId", s.country as country,`
        + ` s.filing_key as "filingKey", s.tax_year as "taxYear", sl.row_id as "rowId", sl.reported as reported`
        + ` from payroll_filing_submission_slips sl`
        + ` join payroll_filing_submissions s on s.id = sl.submission_id and s.org_id = sl.org_id`
        + ` where 1 = 1${orgFilter} order by sl.id`,
      ));
      let alreadyCurrent = 0;
      let skipped = 0;
      const writes: Array<{ id: string; where: string; oldValue: string; newValue: string }> = [];
      for (const slip of slips.rows) {
        const where =
          `payroll_filing_submission_slips.reported row ${slip.id} (${slip.country} ${slip.filingKey} ${slip.taxYear} row ${slip.rowId})`;
        const raw = slip.reported as Partial<PayrollFilingReported> | null;
        if (!raw || typeof raw !== "object" || !Array.isArray(raw.confidential)) {
          throw new Error(`${where} holds no filing snapshot; restore it from backup and re-run`);
        }
        let plan: Awaited<ReturnType<typeof planFingerprintReseal>>;
        try {
          plan = await planFingerprintReseal(
            slip.orgId, slip.country, slip.filingKey, Number(slip.taxYear), slip.rowId, raw as PayrollFilingReported,
          );
        } catch (error) {
          if (error instanceof KeyedFingerprintError) {
            throw new Error(`${where}: ${error.message}`);
          }
          throw error;
        }
        if (plan.status === "rewritten") {
          writes.push({ id: slip.id, where, oldValue: JSON.stringify(slip.reported), newValue: JSON.stringify(plan.reported) });
        } else if (plan.status === "drifted") {
          skipped += 1;
        } else {
          alreadyCurrent += 1;
        }
      }
      if (applyRun && writes.length > 0) {
        await db.transaction(async (tx) => {
          for (const w of writes) {
            const r = (await tx.execute(sql`
              update payroll_filing_submission_slips set reported = ${w.newValue}::jsonb
               where id = ${w.id} and reported = ${w.oldValue}::jsonb`)) as unknown as {
              rowCount?: number | null;
            };
            if ((r.rowCount ?? 0) !== 1) {
              throw new Error(
                `${w.where} changed during rotation (matched ${r.rowCount ?? 0} rows); ` +
                  `refusing to re-fingerprint over a concurrent edit — re-run`,
              );
            }
          }
        });
      }
      reports.push({
        table: "payroll_filing_submission_slips",
        column: "reported",
        rows: slips.rows.length,
        alreadyCurrent,
        resealed: writes.length,
        ...(skipped > 0 ? { skipped } : {}),
      });
    }

    // The feedback token lives on the org-less platform_settings singleton;
    // an --org run skips it (nothing tenant-scoped to bind the write to).
    if (!org) {
      const single = await db.execute<{ settings: unknown }>(sql`
        select settings from platform_settings where id = 'platform'`);
      const settings = (single.rows[0]?.settings && typeof single.rows[0]?.settings === "object"
        ? single.rows[0]!.settings
        : {}) as Record<string, unknown>;
      const feedback = (settings.feedback && typeof settings.feedback === "object"
        ? settings.feedback
        : {}) as Record<string, unknown>;
      const stored = typeof feedback.token === "string" ? feedback.token : null;
      const planned = planReseal(
        stored,
        { orgId: "system", purpose: "feedback.token" },
        activeId,
        "platform_settings.settings feedback.token",
      );
      let resealed = 0;
      if (planned?.changed && applyRun) {
        const next = { ...settings, feedback: { ...feedback, token: planned.sealed } };
        const r = (await db.execute(sql`
          update platform_settings set settings = ${JSON.stringify(next)}::jsonb
           where id = 'platform' and settings = ${JSON.stringify(settings)}::jsonb`)) as unknown as {
          rowCount?: number | null;
        };
        if ((r.rowCount ?? 0) !== 1) throw new Error("platform_settings changed during rotation — re-run");
        resealed = 1;
      } else if (planned?.changed) {
        resealed = 1;
      }
      reports.push({
        table: "platform_settings",
        column: "settings",
        rows: stored ? 1 : 0,
        alreadyCurrent: stored && !planned?.changed ? 1 : 0,
        resealed: applyRun ? resealed : 0,
      });
    }
  });
  return reports;
}

/** Re-seal the sealed leaves inside one org's settings document. Pure. */
export function rotateOrgSettings(
  orgId: string,
  settings: Record<string, unknown>,
  activeId: string,
): { settings: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next: Record<string, unknown> = { ...settings };
  const ai = (next.ai && typeof next.ai === "object" ? { ...(next.ai as Record<string, unknown>) } : null);
  if (ai) {
    if (typeof ai.keyEncrypted === "string" && ai.keyEncrypted) {
      const planned = planReseal(ai.keyEncrypted, { orgId, purpose: "assistant.ai.key" }, activeId, `orgs.settings org ${orgId} ai.keyEncrypted`);
      if (planned?.changed) {
        ai.keyEncrypted = planned.sealed;
        changed = true;
      }
    }
    const capture = (ai.documentCapture && typeof ai.documentCapture === "object"
      ? { ...(ai.documentCapture as Record<string, unknown>) }
      : null);
    if (capture && typeof capture.keyEncrypted === "string" && capture.keyEncrypted) {
      const planned = planReseal(
        capture.keyEncrypted,
        { orgId, purpose: "payables.ap-capture.key" },
        activeId,
        `orgs.settings org ${orgId} ai.documentCapture.keyEncrypted`,
      );
      if (planned?.changed) {
        capture.keyEncrypted = planned.sealed;
        changed = true;
      }
    }
    if (capture) ai.documentCapture = capture;
    next.ai = ai;
  }
  const email = (next.email && typeof next.email === "object" ? { ...(next.email as Record<string, unknown>) } : null);
  if (email) {
    if (typeof email.keySealed === "string" && email.keySealed) {
      const planned = planReseal(
        email.keySealed,
        { orgId, purpose: "email.provider.secret" },
        activeId,
        `orgs.settings org ${orgId} email.keySealed`,
      );
      if (planned?.changed) {
        email.keySealed = planned.sealed;
        changed = true;
      }
    }
    const legacyCt = typeof email.keyCiphertext === "string" ? email.keyCiphertext : "";
    const legacyNonce = typeof email.keyNonce === "string" ? email.keyNonce : "";
    if (legacyCt || legacyNonce) {
      if (!legacyCt || !legacyNonce) {
        throw new Error(
          `orgs.settings org ${orgId} email credential is half-migrated (only one of keyCiphertext/keyNonce); ` +
            `re-enter the credential under Settings → Email before rotating`,
        );
      }
      const plain = unsealLegacyEmailSecret({ ciphertext: legacyCt, nonce: legacyNonce });
      if (plain === null) {
        throw new Error(
          `orgs.settings org ${orgId} legacy email credential cannot be unsealed; ` +
            `SESSION_SECRET must match the deployment that sealed it — re-enter the credential under Settings → Email and re-run`,
        );
      }
      email.keySealed = sealEmailSecret(plain, orgId);
      delete email.keyCiphertext;
      delete email.keyNonce;
      changed = true;
    }
    next.email = email;
  }
  return { settings: next, changed };
}

async function main(): Promise<number> {
  const reports = await rotateDataKey({ apply, org: onlyOrg });
  for (const r of reports) {
    console.log(
      `[rotate-data-key] ${r.table}.${r.column}: ${r.rows} row(s), ${r.alreadyCurrent} current, ${r.resealed} to re-seal`
      + (r.skipped ? `, ${r.skipped} left on their old key (identifier moved since issue — keep the retired key configured)` : ``),
    );
  }
  const total = reports.reduce((n, r) => n + r.resealed, 0);
  if (!apply) {
    console.log(
      `[rotate-data-key] dry run: ${total} value(s) would be re-sealed under the active key; re-run with --apply to write`,
    );
    return 0;
  }
  console.log(`[rotate-data-key] applied: ${total} value(s) re-sealed under the active key`);
  return 0;
}

if (isEntrypoint()) {
  void (async () => {
    try {
      // bypass: cross-org-by-design — data-key rotation re-seals ciphertext of every organization.
      process.exitCode = await withBypassContext(() => main());
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}
