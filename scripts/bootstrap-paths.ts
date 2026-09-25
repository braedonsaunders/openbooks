/** Bootstrap path and hash helpers (the repoRoot trap: this file stays in scripts/). Split from scripts/bootstrap.ts (ARCH-FILE-SPLIT; pure moves only). */
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type RuntimeDatabaseConfig } from "./bootstrap-roles.ts"
import { env, pool } from "../engine/src/platform/db.ts"

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const migrationsDir = join(repoRoot, "schema", "migrations");

export function runtimeDatabaseConfig(): RuntimeDatabaseConfig | null {
  const connectionString = env.OPENBOOKS_RUNTIME_DB_URL?.trim();
  if (!connectionString) return null;
  const parsed = new URL(connectionString);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("OPENBOOKS_RUNTIME_DB_URL must be a PostgreSQL URL");
  }
  const roleName = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(roleName)) {
    throw new Error("OPENBOOKS_RUNTIME_DB_URL contains an invalid PostgreSQL role name");
  }
  if (password.length < 24) {
    throw new Error("the runtime database password must contain at least 24 characters");
  }
  return { connectionString, roleName, password };
}

/**
 * Parse OPENBOOKS_BYPASS_DB_URL into the dedicated cross-tenant login.
 * Production web/worker processes refuse at import without this credential
 * (engine/src/platform/db.ts), so every production deployment path must
 * provision the login it names; the one-shot installer itself never serves
 * tenant traffic and works without it. Null when unset.
 */
export function bypassDatabaseConfig(): RuntimeDatabaseConfig | null {
  const connectionString = env.OPENBOOKS_BYPASS_DB_URL?.trim();
  if (!connectionString) return null;
  const parsed = new URL(connectionString);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("OPENBOOKS_BYPASS_DB_URL must be a PostgreSQL URL");
  }
  const roleName = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(roleName)) {
    throw new Error("OPENBOOKS_BYPASS_DB_URL contains an invalid PostgreSQL role name");
  }
  // The length rule guards a password bootstrap SETS. An aliased URL (the
  // bypass naming the migration-owner or runtime login) sets nothing and
  // only verifies, so the rule is enforced where the dedicated login is
  // created: ensureBypassRoleExists.
  return { connectionString, roleName, password };
}

export async function quoted(value: string, kind: "identifier" | "literal"): Promise<string> {
  const fn = kind === "identifier" ? "quote_ident" : "quote_literal";
  const result = await pool.query<{ value: string }>(
    `select ${fn}($1) as value`,
    [value],
  );
  return result.rows[0]!.value;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
