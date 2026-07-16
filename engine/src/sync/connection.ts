import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { unsealJson } from "../secrets.ts";
import { netsuiteCredsFromEnvFile, type NetSuiteCreds } from "../netsuite.ts";
import { NetSuiteSource } from "./netsuite-source.ts";
import type { MigrationSource } from "./source.ts";

/**
 * Connection layer — the seam between a tenant's stored `connections` row and a
 * live `MigrationSource`. The PRODUCT knows nothing about specific vendors: the
 * platform page renders whatever `SOURCE_TYPES` declares, and this module turns
 * a saved connection into a working adapter. Adding a system = one manifest
 * entry + one `buildSource` case; zero UI changes.
 */

// --- Connector manifest (drives the "add connection" wizard) -----------------

export interface SourceFieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  help?: string;
  /** Render as a dropdown instead of a text input. */
  kind?: "text" | "select";
  /** Static options for a `select` field. */
  options?: { value: string; label: string }[];
  /** Populate a `select` from a live app list (resolved by the API layer). */
  optionsSource?: "currencies";
}

export interface SourceTypeManifest {
  source: string; // stable key, e.g. "netsuite"
  displayName: string;
  /** token = paste credentials; oauth2 = redirect flow (future adapters). */
  authKind: "token" | "oauth2";
  blurb: string;
  /** Non-secret settings stored in `connections.config`. */
  configFields: SourceFieldSpec[];
  /** Secret credentials sealed into `connections.secrets` (never returned). */
  secretFields: SourceFieldSpec[];
}

export const SOURCE_TYPES: SourceTypeManifest[] = [
  {
    source: "netsuite",
    displayName: "NetSuite",
    authKind: "token",
    blurb: "Token-based (TBA) access to SuiteQL. Create an integration + access token in NetSuite, then paste the four values. Native transactions, applications and orders migrate and mirror through the real posting engine.",
    configFields: [
      { key: "account", label: "Account ID", placeholder: "1234567", required: true, help: "Your NetSuite account id (the realm)." },
      { key: "host", label: "SuiteTalk host", placeholder: "https://<acct>.suitetalk.api.netsuite.com", required: true },
      { key: "baseCurrency", label: "Base currency", kind: "select", optionsSource: "currencies" },
    ],
    secretFields: [
      { key: "consumerKey", label: "Consumer key", required: true },
      { key: "consumerSecret", label: "Consumer secret", required: true },
      { key: "tokenKey", label: "Token ID", required: true },
      { key: "tokenSecret", label: "Token secret", required: true },
    ],
  },
];

export function sourceType(source: string): SourceTypeManifest | undefined {
  return SOURCE_TYPES.find((s) => s.source === source);
}

// --- Stored connections ------------------------------------------------------

export interface ConnectionRow {
  id: string;
  orgId: string;
  source: string;
  displayName: string;
  authKind: "token" | "oauth2";
  status: string;
  config: Record<string, unknown>;
  secrets: string | null;
  mirrorEnabled: boolean;
  mirrorSchedule: string;
  cursor: Date | null;
  lastRunAt: Date | null;
  lastError: string | null;
}

const SELECT_COLS = sql`id, org_id as "orgId", source, display_name as "displayName",
  auth_kind as "authKind", status, config, secrets, mirror_enabled as "mirrorEnabled",
  mirror_schedule as "mirrorSchedule", cursor, last_run_at as "lastRunAt", last_error as "lastError"`;

export async function listConnections(orgId: string): Promise<ConnectionRow[]> {
  const r = (await db.execute(sql`
    select ${SELECT_COLS} from connections where org_id = ${orgId} order by created_at`)) as unknown as {
    rows: ConnectionRow[];
  };
  return r.rows;
}

export async function getConnection(orgId: string, id: string): Promise<ConnectionRow | null> {
  const r = (await db.execute(sql`
    select ${SELECT_COLS} from connections where org_id = ${orgId} and id = ${id} limit 1`)) as unknown as {
    rows: ConnectionRow[];
  };
  return r.rows[0] ?? null;
}

/** Build a live adapter from a stored connection (credentials unsealed here). */
export function buildSource(conn: ConnectionRow): MigrationSource {
  if (conn.source === "netsuite") {
    const secret = unsealJson<Partial<NetSuiteCreds>>(conn.secrets);
    const cfg = conn.config as { account?: string; host?: string; baseCurrency?: string };
    let creds: NetSuiteCreds | null = null;
    if (secret?.consumerKey && cfg.account && cfg.host) {
      creds = {
        account: String(cfg.account),
        host: String(cfg.host),
        consumerKey: String(secret.consumerKey),
        consumerSecret: String(secret.consumerSecret ?? ""),
        tokenKey: String(secret.tokenKey ?? ""),
        tokenSecret: String(secret.tokenSecret ?? ""),
      };
    } else {
      // Dev bootstrap: the original .env.netsuite connection.
      creds = netsuiteCredsFromEnvFile();
    }
    if (!creds) throw new Error("NetSuite connection is missing credentials");
    return new NetSuiteSource(creds, { baseCurrency: cfg.baseCurrency });
  }
  throw new Error(`no adapter registered for source "${conn.source}"`);
}
