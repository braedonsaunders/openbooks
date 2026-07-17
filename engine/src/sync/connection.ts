import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { unsealJson } from "../secrets.ts";
import { netsuiteCredsFromEnvFile, type NetSuiteCreds } from "../netsuite.ts";
import { NetSuiteSource } from "./netsuite-source.ts";
import { OdooSource } from "./odoo-source.ts";
import type { OdooCreds } from "../odoo.ts";
import { ErpNextSource } from "./erpnext-source.ts";
import type { ErpNextCreds } from "../erpnext.ts";
import { QboClient, type QboApp, type QboTokens } from "../qbo.ts";
import { QboSource } from "./qbo-source.ts";
import { XeroClient, type XeroApp, type XeroTokens } from "../xero.ts";
import { XeroSource } from "./xero-source.ts";
import { sealJson } from "../secrets.ts";
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
  /**
   * OAuth app-registration guidance rendered in the connection drawer: where
   * to create the app and exactly what to register. The redirect URI is
   * deployment-relative — the UI composes it from the browser origin +
   * `/api/platform/connections/oauth/<source>/callback`.
   */
  oauthSetup?: {
    portalUrl: string;
    portalLabel: string;
    steps: string[];
  };
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
  {
    source: "odoo",
    displayName: "Odoo",
    authKind: "token",
    blurb: "Connect with your Odoo URL, database, user and an API key (Settings → My Profile → Account Security → API Keys). Invoices, bills, payments and journals migrate and mirror natively through the real posting engine.",
    configFields: [
      { key: "url", label: "Odoo URL", placeholder: "https://mycompany.odoo.com", required: true },
      { key: "database", label: "Database", placeholder: "mycompany", required: true },
      { key: "username", label: "User (login email)", placeholder: "admin@mycompany.com", required: true },
      { key: "baseCurrency", label: "Base currency", kind: "select", optionsSource: "currencies" },
    ],
    secretFields: [{ key: "apiKey", label: "API key", required: true }],
  },
  {
    source: "erpnext",
    displayName: "ERPNext",
    authKind: "token",
    blurb: "Connect with your ERPNext URL and an API key + secret (User → Settings → API Access). Invoices, bills, payment entries and journals migrate and mirror natively through the real posting engine.",
    configFields: [
      { key: "url", label: "ERPNext URL", placeholder: "https://mycompany.erpnext.com", required: true },
      { key: "baseCurrency", label: "Base currency", kind: "select", optionsSource: "currencies" },
    ],
    secretFields: [
      { key: "apiKey", label: "API key", required: true },
      { key: "apiSecret", label: "API secret", required: true },
    ],
  },
  {
    source: "qbo",
    displayName: "QuickBooks Online",
    authKind: "oauth2",
    blurb: "Enter your Intuit app's Client ID + Secret (developer.intuit.com → Keys & credentials), save, then click Connect to authorize a company. Invoices, bills, payments, credits, journals and deposits migrate and mirror natively.",
    configFields: [
      {
        key: "environment",
        label: "Environment",
        kind: "select",
        options: [
          { value: "sandbox", label: "Sandbox" },
          { value: "production", label: "Production" },
        ],
      },
      { key: "baseCurrency", label: "Base currency", kind: "select", optionsSource: "currencies" },
    ],
    secretFields: [
      { key: "clientId", label: "Client ID", required: true },
      { key: "clientSecret", label: "Client Secret", required: true },
    ],
    oauthSetup: {
      portalUrl: "https://developer.intuit.com",
      portalLabel: "Intuit Developer portal",
      steps: [
        "Create an app (QuickBooks Online and Payments) with the com.intuit.quickbooks.accounting scope.",
        "Under Keys & credentials, add the Redirect URI shown below (use Development keys for a sandbox company, Production keys for a live one).",
        "Copy the Client ID and Client Secret into this form, save, then click Connect.",
      ],
    },
  },
  {
    source: "xero",
    displayName: "Xero",
    authKind: "oauth2",
    blurb: "Enter your Xero app's Client ID + Secret (developer.xero.com → My Apps), save, then click Connect to authorize an organisation. Invoices, bills, credit notes, payments, journals and bank transactions migrate and mirror natively.",
    configFields: [
      { key: "baseCurrency", label: "Base currency", kind: "select", optionsSource: "currencies" },
    ],
    secretFields: [
      { key: "clientId", label: "Client ID", required: true },
      { key: "clientSecret", label: "Client Secret", required: true },
    ],
    oauthSetup: {
      portalUrl: "https://developer.xero.com/app/manage",
      portalLabel: "Xero developer portal",
      steps: [
        "Create a new app (integration type: Web app); the company URL can be this site's address.",
        "Add the Redirect URI shown below to the app's OAuth 2.0 redirect URIs.",
        "Copy the Client ID, generate a Client Secret, paste both into this form, save, then click Connect.",
      ],
    },
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

/** Sealed `secrets` blob for a QBO connection: app creds + (once authorized) tokens. */
interface QboSecrets extends Partial<QboTokens> {
  clientId: string;
  clientSecret: string;
}

/** Sealed `secrets` blob for a Xero connection: app creds + (once authorized) tokens. */
interface XeroSecrets extends Partial<XeroTokens> {
  clientId: string;
  clientSecret: string;
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

  if (conn.source === "odoo") {
    const cfg = conn.config as { url?: string; database?: string; username?: string; baseCurrency?: string };
    const secret = unsealJson<{ apiKey?: string }>(conn.secrets);
    if (!cfg.url || !cfg.database || !cfg.username || !secret?.apiKey) {
      throw new Error("Odoo connection is missing its URL, database, user or API key");
    }
    const creds: OdooCreds = {
      url: String(cfg.url),
      database: String(cfg.database),
      username: String(cfg.username),
      apiKey: String(secret.apiKey),
    };
    return new OdooSource(creds, { baseCurrency: cfg.baseCurrency });
  }

  if (conn.source === "erpnext") {
    const cfg = conn.config as { url?: string; baseCurrency?: string };
    const secret = unsealJson<{ apiKey?: string; apiSecret?: string }>(conn.secrets);
    if (!cfg.url || !secret?.apiKey || !secret?.apiSecret) {
      throw new Error("ERPNext connection is missing its URL, API key or API secret");
    }
    const creds: ErpNextCreds = { url: String(cfg.url), apiKey: String(secret.apiKey), apiSecret: String(secret.apiSecret) };
    return new ErpNextSource(creds, { baseCurrency: cfg.baseCurrency });
  }

  if (conn.source === "qbo") {
    const cfg = conn.config as { realmId?: string; environment?: string; baseCurrency?: string };
    const secret = unsealJson<QboSecrets>(conn.secrets);
    if (!secret?.clientId || !secret?.clientSecret) {
      throw new Error("QuickBooks connection is missing its app credentials (Client ID / Secret)");
    }
    if (!cfg.realmId || !secret.refreshToken || !secret.accessToken || !secret.expiresAt) {
      throw new Error("QuickBooks connection is not authorized yet — click Connect to grant access");
    }
    const app: QboApp = {
      clientId: secret.clientId,
      clientSecret: secret.clientSecret,
      redirectUri: "", // only the authorize/exchange steps need it
      environment: cfg.environment === "production" ? "production" : "sandbox",
    };
    const tokens: QboTokens = {
      accessToken: secret.accessToken,
      refreshToken: secret.refreshToken,
      expiresAt: secret.expiresAt,
    };
    // Refreshed tokens re-seal onto the connection, preserving the app creds.
    const onRefresh = async (t: QboTokens) => {
      const merged: QboSecrets = { clientId: secret.clientId, clientSecret: secret.clientSecret, ...t };
      await db.execute(sql`update connections set secrets = ${sealJson(merged)}, updated_at = now() where id = ${conn.id}`);
    };
    return new QboSource(new QboClient(app, String(cfg.realmId), tokens, onRefresh), { baseCurrency: cfg.baseCurrency });
  }

  if (conn.source === "xero") {
    const cfg = conn.config as { tenantId?: string; baseCurrency?: string };
    const secret = unsealJson<XeroSecrets>(conn.secrets);
    if (!secret?.clientId || !secret?.clientSecret) {
      throw new Error("Xero connection is missing its app credentials (Client ID / Secret)");
    }
    if (!cfg.tenantId || !secret.refreshToken || !secret.accessToken || !secret.expiresAt) {
      throw new Error("Xero connection is not authorized yet — click Connect to grant access");
    }
    const app: XeroApp = { clientId: secret.clientId, clientSecret: secret.clientSecret, redirectUri: "" };
    const tokens: XeroTokens = {
      accessToken: secret.accessToken,
      refreshToken: secret.refreshToken,
      expiresAt: secret.expiresAt,
    };
    // Xero refresh tokens ROTATE — re-sealing on refresh is load-bearing.
    const onRefresh = async (t: XeroTokens) => {
      const merged: XeroSecrets = { clientId: secret.clientId, clientSecret: secret.clientSecret, ...t };
      await db.execute(sql`update connections set secrets = ${sealJson(merged)}, updated_at = now() where id = ${conn.id}`);
    };
    return new XeroSource(new XeroClient(app, String(cfg.tenantId), tokens, onRefresh), { baseCurrency: cfg.baseCurrency });
  }

  throw new Error(`no adapter registered for source "${conn.source}"`);
}
