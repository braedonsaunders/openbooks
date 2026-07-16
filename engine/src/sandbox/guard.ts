import { sql } from "drizzle-orm";
import { db } from "../db.ts";

/**
 * The sandbox guard. A sandbox must never touch the outside world — no emails,
 * no payment files, no SFTP pushes, no live webhooks. Every outbound side-effect
 * path calls this before acting. Outbound integrations are neutered
 * automatically at clone time and enforced again at the point of egress
 * (defense in depth).
 */

// Small cache — env_kind is immutable for an org's lifetime.
const envCache = new Map<string, "production" | "sandbox" | "preview">();

export async function getEnvKind(
  orgId: string,
): Promise<"production" | "sandbox" | "preview"> {
  const hit = envCache.get(orgId);
  if (hit) return hit;
  const res = (await db.execute(sql`select env_kind from orgs where id = ${orgId}`)) as any;
  const kind = (res.rows[0]?.env_kind ?? "production") as "production" | "sandbox" | "preview";
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
 * Strip a freshly-cloned sandbox of every credential and integration that could
 * reach production systems: email provider, payment origination (EFT/NACHA/SEPA),
 * API keys, and SFTP secrets. Runs unscoped right after the clone copy.
 */
export async function neuterSandbox(sandboxOrgId: string): Promise<void> {
  // Drop outbound integration config from orgs.settings.
  await db.execute(sql`
    update orgs
       set settings = (settings - 'email' - 'eft' - 'nacha' - 'sepa')
     where id = ${sandboxOrgId}`);
  // Disable any copied API keys.
  await db.execute(sql`
    update api_keys set is_active = false where org_id = ${sandboxOrgId}`);
  // Wipe SFTP credentials if the table/column exists (best-effort).
  await db
    .execute(sql`update sftp_servers set password_encrypted = null where org_id = ${sandboxOrgId}`)
    .catch(() => {});
  envCache.delete(sandboxOrgId);
}
