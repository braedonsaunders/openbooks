import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

/**
 * The sandbox guard. A sandbox must never touch the outside world — no emails,
 * no payment files, no SFTP pushes, no live webhooks. Every outbound side-effect
 * path calls this before acting. Outbound integrations are neutered
 * automatically at clone time and enforced again at the point of egress
 * (defense in depth).
 */

// Small cache — env_kind is immutable for an org's lifetime. Unknown orgs
// are never cached: every guarded egress re-proves them (and refuses).
const envCache = new Map<string, "production" | "sandbox" | "preview">();

const KNOWN_ENV_KINDS = ["production", "sandbox", "preview"] as const;

export async function getEnvKind(
  orgId: string,
): Promise<"production" | "sandbox" | "preview"> {
  const hit = envCache.get(orgId);
  if (hit) return hit;
  const res = (await db.execute(sql`select env_kind from orgs where id = ${orgId}`));
  // B3-ORG-01: an UNKNOWN org (no row: deleted or forged id) must fail
  // CLOSED with a named refusal. Defaulting it to 'production' let
  // assertNotSandbox pass, so email, payment files, SFTP and webhooks
  // proceeded for an org nobody can vouch for.
  const raw = res.rows[0]?.env_kind as string | undefined;
  if (raw == null) {
    throw new Error(`refusing guarded egress for unknown organization ${orgId}: no org row exists`);
  }
  const kind = raw.toLowerCase() as "production" | "sandbox" | "preview";
  if (!KNOWN_ENV_KINDS.includes(kind)) {
    throw new Error(
      `refusing guarded egress for organization ${orgId}: unknown env_kind ${JSON.stringify(raw)}`,
    );
  }
  envCache.set(orgId, kind);
  return kind;
}

export async function isSandboxOrg(orgId: string): Promise<boolean> {
  return (await getEnvKind(orgId)) !== "production";
}

export class SandboxEgressError extends Error {
  readonly name = "SandboxEgressError";
  constructor(action: string) {
    super(`Blocked: '${action}' is not permitted from a sandbox environment.`);
  }
}

/** Throw if the org is a sandbox — call before any real-world side-effect. */
export async function assertNotSandbox(orgId: string, action: string): Promise<void> {
  if (await isSandboxOrg(orgId)) throw new SandboxEgressError(action);
}

/**
 * Strip a sandbox of every credential and integration that could reach
 * production systems: email provider, payment origination (EFT/NACHA/SEPA),
 * API keys, SFTP secrets, bank-feed / PSP / tax / FX provider secrets and
 * schedules. Runs unscoped after EVERY copy from production — create, refresh
 * and reset alike — inside the caller's unit of work. Every statement targets
 * a baseline table, and every failure propagates: a neuter that half-applied
 * must fail the provisioning, never leave a sandbox that can call out.
 * (api_keys and sftp_* rows are no longer cloned at all; these updates remain
 * as the safety net for rows that reach a sandbox by other means.)
 */
export async function neuterSandbox(sandboxOrgId: string): Promise<void> {
  // Drop outbound integration config from orgs.settings.
  await db.execute(sql`
    update orgs
       set settings = (settings - 'email' - 'eft' - 'nacha' - 'sepa')
     where id = ${sandboxOrgId}`);
  await db.execute(sql`
    update api_keys set is_active = false where org_id = ${sandboxOrgId}`);
  await db.execute(sql`
    update sftp_servers
       set password_encrypted = null, authorized_keys = null, is_active = false
     where org_id = ${sandboxOrgId}`);
  await db.execute(sql`
    update sftp_import_schedules set is_active = false where org_id = ${sandboxOrgId}`);
  await db.execute(sql`
    update connections
       set status = 'paused', secrets = null, mirror_enabled = false, last_error = null
     where org_id = ${sandboxOrgId}`);
  await db.execute(sql`
    update bank_feed_connections
       set status = 'disconnected', credentials = null, is_active = false,
           next_sync_at = null, last_error = null
     where org_id = ${sandboxOrgId}`);
  await db.execute(sql`
    update tax_rate_provider_configs
       set is_enabled = false, secrets = null, last_error = null
     where org_id = ${sandboxOrgId}`);
  await db.execute(sql`
    update psp_provider_configs
       set is_enabled = false, acceptance_enabled = false, secrets = null,
           publishable_key = null, last_error = null
     where org_id = ${sandboxOrgId}`);
  await db.execute(sql`
    update payment_bank_profiles
       set originator_secrets_encrypted = null, is_active = false,
           auto_remittance = false
     where org_id = ${sandboxOrgId}`);
  // Provider credentials are tenant secrets and scheduled synchronization is
  // real network egress. Preserve the non-secret configuration for testing,
  // but make cloned providers inert and credential-free.
  await db.execute(sql`
    update fx_provider_configs
       set is_enabled = false, secrets = null, next_sync_at = null,
           last_error = null, updated_at = now()
     where org_id = ${sandboxOrgId}`);
  envCache.delete(sandboxOrgId);
}
