import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { sealJson, unsealJson } from "../platform/secrets.ts";
import { type CarrierAdapter } from "../connectors/shipping.ts";
import { easyPostAdapter } from "../connectors/easypost.ts";
import { shippoAdapter } from "../connectors/shippo.ts";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Scope = ReadonlySet<string> | null;

export type ShippingRefusalCode =
  | "feature_disabled"
  | "not_found"
  | "wrong_stage"
  | "account_missing"
  | "account_disabled"
  | "secret_missing"
  | "weight_missing"
  | "address_missing"
  | "customs_missing"
  | "currency_unsupported"
  | "provider_failed"
  | "quote_expired"
  | "label_not_voidable"
  | "signature_invalid"
  | "signature_required"
  | "adjustment_unknown"
  | "invalid_input"
  | "changed_concurrently";

/**
 * A carrier-hub request the business rules refuse. Like FulfillmentRefusal it
 * carries the HTTP status the route answers with, a stable code, and a
 * remedy naming an action that exists — a computed refusal is raised, never
 * dropped into a zero accrual or a silent skip.
 */
export class ShippingRefusal extends Error {
  readonly name = "ShippingRefusal";

  constructor(
    message: string,
    readonly code: ShippingRefusalCode,
    readonly status: 401 | 404 | 409 | 422,
    readonly remedy?: string,
  ) {
    super(message);
  }
}

const SHIPPING_FEATURE = "shippingHub";
export const SHIPPING_FEATURES_REMEDY = "Turn on Shipping hub on Company Settings → Features";
export const SHIPPING_SETUP_REMEDY = "Connect a carrier account in Setup → Shipping";
const SECRETS_PURPOSE = "shipping.account.secrets";

function fulfillmentDisabled(): ShippingRefusal {
  return new ShippingRefusal(
    "Shipping hub is turned off for this organization",
    "feature_disabled",
    409,
    SHIPPING_FEATURES_REMEDY,
  );
}

/**
 * Every carrier-hub write asserts the gate inside the caller's transaction.
 * shippingHub is subordinate to fulfillment in the registry, so rating a
 * shipment the org cannot ship is refused here, not hidden in the UI alone.
 */
export async function assertShippingFeature(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(runner, orgId, SHIPPING_FEATURE))) throw fulfillmentDisabled();
}

export function adapterFor(provider: string): CarrierAdapter {
  if (provider === "easypost") return easyPostAdapter;
  if (provider === "shippo") return shippoAdapter;
  throw new ShippingRefusal(
    `Unknown carrier provider ${provider}`,
    "account_missing",
    422,
    SHIPPING_SETUP_REMEDY,
  );
}

interface ShippingAccount {
  id: string;
  provider: string;
  mode: string;
  status: string;
  name: string;
  apiKey: string;
  webhookSecret: string | null;
}

/** Load the account plus its unsealed API key; refuses by name when anything is missing. */
export async function loadShippingAccount(
  tx: SqlExecutor,
  orgId: string,
  accountId: string | null | undefined,
): Promise<ShippingAccount> {
  const row = (
    await tx.execute<{
      id: string;
      provider: string;
      mode: string;
      status: string;
      name: string;
      secrets: string | null;
      webhook_secret: string | null;
      last_error: string | null;
    }>(
      accountId
        ? sql`
    select id, provider, mode, status, name, secrets, webhook_secret, last_error
      from shipping_accounts where org_id = ${orgId} and id = ${accountId} for share`
        : sql`
    select id, provider, mode, status, name, secrets, webhook_secret, last_error
      from shipping_accounts
     where org_id = ${orgId} and status = 'active'
     order by is_default desc, created_at asc limit 1 for share`,
      "objects",
    )
  )[0];
  if (!row) {
    throw new ShippingRefusal(
      accountId ? "Carrier account not found" : "No carrier account is connected",
      "account_missing",
      accountId ? 404 : 422,
      SHIPPING_SETUP_REMEDY,
    );
  }
  if (row.status === "disabled") {
    throw new ShippingRefusal(
      `Carrier account ${row.name} is disabled`,
      "account_disabled",
      409,
      `Enable ${row.name} in Setup → Shipping`,
    );
  }
  if (row.status === "error") {
    throw new ShippingRefusal(
      `Carrier account ${row.name} is in error${row.last_error ? `: ${row.last_error}` : ""}`,
      "account_disabled",
      409,
      `Fix ${row.name} in Setup → Shipping, then test the connection`,
    );
  }
  if (!row.secrets) {
    throw new ShippingRefusal(
      `Carrier account ${row.name} has no API key`,
      "secret_missing",
      422,
      `Add an API key to ${row.name} in Setup → Shipping`,
    );
  }
  let apiKey: string;
  try {
    const parsed = await unsealJson<{ apiKey?: unknown }>(row.secrets, {
      orgId,
      purpose: SECRETS_PURPOSE,
    });
    apiKey = typeof parsed?.apiKey === "string" ? parsed.apiKey : "";
  } catch {
    throw new ShippingRefusal(
      `Carrier account ${row.name} stores a credential that cannot be unsealed`,
      "secret_missing",
      422,
      `Re-enter the API key on ${row.name} in Setup → Shipping`,
    );
  }
  if (!apiKey) {
    throw new ShippingRefusal(
      `Carrier account ${row.name} has no API key`,
      "secret_missing",
      422,
      `Add an API key to ${row.name} in Setup → Shipping`,
    );
  }
  let webhookSecret: string | null = null;
  if (row.webhook_secret) {
    try {
      const relay = await unsealJson<{ relaySecret?: unknown }>(row.webhook_secret, {
        orgId,
        purpose: SECRETS_PURPOSE,
      });
      webhookSecret = typeof relay?.relaySecret === "string" ? relay.relaySecret : null;
    } catch {
      throw new ShippingRefusal(
        `Carrier account ${row.name} stores a relay secret that cannot be unsealed`,
        "secret_missing",
        422,
        `Rotate the relay secret on ${row.name} in Setup → Shipping, then configure the delivery sender with the new secret`,
      );
    }
  }
  return {
    id: row.id,
    provider: row.provider,
    mode: row.mode,
    status: row.status,
    name: row.name,
    apiKey,
    webhookSecret,
  };
}

/** Seal an API key for storage; the unseal side above reads this shape back. */
export function sealAccountSecrets(orgId: string, apiKey: string): string {
  return sealJson({ apiKey }, { orgId, purpose: SECRETS_PURPOSE });
}

// --- Carrier account management -------------------------------------------------

export interface ShippingAccountView {
  id: string;
  name: string;
  provider: string;
  mode: string;
  status: string;
  isDefault: boolean;
  hasKey: boolean;
  /** Tracker deliveries are accepted only when a relay secret is configured. */
  hasRelaySecret: boolean;
  lastError: string | null;
  lastCheckedAt: string | null;
}

/** Every carrier account with its health, for Setup. Keys never leave sealed. */
export async function listShippingAccounts(
  runner: SqlExecutor,
  orgId: string,
): Promise<ShippingAccountView[]> {
  await assertShippingFeature(runner, orgId);
  const rows = await runner.execute<{
    id: string;
    name: string;
    provider: string;
    mode: string;
    status: string;
    is_default: boolean;
    secrets: string | null;
    has_relay_secret: boolean;
    last_error: string | null;
    last_checked_at: string | null;
  }>(
    sql`
    select id, name, provider, mode, status, is_default, secrets, webhook_secret is not null as has_relay_secret, last_error, last_checked_at
      from shipping_accounts where org_id = ${orgId} order by name`,
    "objects",
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    mode: row.mode,
    status: row.status,
    isDefault: row.is_default,
    hasKey: row.secrets != null,
    hasRelaySecret: row.has_relay_secret,
    lastError: row.last_error,
    lastCheckedAt: row.last_checked_at,
  }));
}

async function writeAccountAudit(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  accountId: string,
  action: "insert" | "update",
  changes: Record<string, unknown>,
): Promise<void> {
  const written = await tx.execute<{ id: string }>(
    sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'shipping_accounts', ${accountId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id`,
    "objects",
  );
  if (written.length === 0) throw new Error("shipping account change was not audited");
}

export interface ConnectAccountInput {
  accountId?: string | null;
  name: string;
  provider: string;
  mode: string;
  apiKey?: string | null;
  makeDefault?: boolean;
}

/**
 * Connect (or reconnect) a carrier account: the API key is sealed on the
 * way in and never stored — or read — in plaintext. Connecting clears a
 * past error and reactivates the account.
 *
 * A new account is issued a relay secret (rotated later through
 * rotateShippingRelaySecret). Tracker deliveries are refused unless signed
 * with it, so the plain value is returned exactly once, for the operator to
 * configure on the delivery sender; only the sealed value is stored.
 */
export async function connectShippingAccount(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: ConnectAccountInput,
): Promise<{ accountId: string; relaySecret: string | null }> {
  await assertShippingFeature(tx, orgId);
  const name = input.name.trim();
  if (!name) throw new ShippingRefusal("Name the carrier account", "invalid_input", 422);
  if (input.provider !== "easypost" && input.provider !== "shippo") {
    throw new ShippingRefusal(`Unknown carrier provider ${input.provider}`, "invalid_input", 422);
  }
  if (input.mode !== "test" && input.mode !== "live") {
    throw new ShippingRefusal("Account mode is test or live", "invalid_input", 422);
  }
  if (input.apiKey != null && input.apiKey.trim().length < 8) {
    throw new ShippingRefusal("That API key is too short to be real", "invalid_input", 422);
  }
  if (input.makeDefault) {
    await tx.execute(sql`
      update shipping_accounts set is_default = false, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and is_default`);
  }
  if (input.accountId) {
    // A zero-row update is a failure: under RLS an unscoped id matches
    // nothing and must not report success. The key travels only when it is
    // replaced — a null parameter would leave its type unknown to the plan.
    const base = sql`
      update shipping_accounts
         set name = ${name}, provider = ${input.provider}, mode = ${input.mode},
             status = 'active', last_error = null,
             is_default = coalesce(${input.makeDefault ?? null}::boolean, is_default),
             updated_at = now(), updated_by = ${actorId}`;
    const keyed = input.apiKey
      ? sql`${base}, secrets = ${sealAccountSecrets(orgId, input.apiKey.trim())}`
      : base;
    const updated = await tx.execute<{ id: string }>(
      sql`
      ${keyed} where org_id = ${orgId} and id = ${input.accountId} returning id`,
      "objects",
    );
    if (updated.length === 0)
      throw new ShippingRefusal("Carrier account not found", "not_found", 404);
    await writeAccountAudit(tx, orgId, actorId, input.accountId, "update", {
      mode: "shipping_account_connect",
      name,
      provider: input.provider,
      accountMode: input.mode,
      keyReplaced: input.apiKey != null,
    });
    return { accountId: input.accountId, relaySecret: null };
  }
  if (!input.apiKey) {
    throw new ShippingRefusal(
      "An API key is required to connect an account",
      "secret_missing",
      422,
    );
  }
  const relay = mintRelaySecret();
  const created = await tx.execute<{ id: string }>(
    sql`
    insert into shipping_accounts
      (org_id, name, provider, mode, status, is_default, secrets, webhook_secret, created_by, updated_by)
    values (${orgId}, ${name}, ${input.provider}, ${input.mode}, 'active',
            ${input.makeDefault === true}, ${sealAccountSecrets(orgId, input.apiKey.trim())},
            ${relay.sealed(orgId)}, ${actorId}, ${actorId})
    returning id`,
    "objects",
  );
  const accountId = created[0]?.id;
  if (!accountId) throw new Error("shipping account was not connected");
  await writeAccountAudit(tx, orgId, actorId, accountId, "insert", {
    mode: "shipping_account_connect",
    name,
    provider: input.provider,
    accountMode: input.mode,
    relaySecretIssued: true,
  });
  return { accountId, relaySecret: relay.plain };
}

/**
 * Issue (or replace) an account's relay secret. Tracker deliveries signed
 * with the previous secret are refused from now on. The plain value is
 * returned once for the operator to configure on the delivery sender; only
 * the sealed value is stored, and the rotation is audited without it.
 */
export async function rotateShippingRelaySecret(
  tx: Tx,
  orgId: string,
  actorId: string,
  accountId: string,
): Promise<{ accountId: string; relaySecret: string }> {
  await assertShippingFeature(tx, orgId);
  const relay = mintRelaySecret();
  const updated = await tx.execute<{ id: string; had_secret: boolean }>(
    sql`
    update shipping_accounts a
       set webhook_secret = ${relay.sealed(orgId)}, updated_at = now(), updated_by = ${actorId}
      from (select id, webhook_secret is not null as had_secret from shipping_accounts
             where org_id = ${orgId} and id = ${accountId} for update) prior
     where a.org_id = ${orgId} and a.id = prior.id
    returning a.id, prior.had_secret`,
    "objects",
  );
  const row = updated[0];
  if (!row) throw new ShippingRefusal("Carrier account not found", "not_found", 404);
  await writeAccountAudit(tx, orgId, actorId, accountId, "update", {
    mode: "shipping_account_relay_secret",
    replacedExisting: row.had_secret,
  });
  return { accountId, relaySecret: relay.plain };
}

/** Park an account without deleting its labels, quotes, or cost history. */
export async function disconnectShippingAccount(
  tx: Tx,
  orgId: string,
  actorId: string,
  accountId: string,
): Promise<void> {
  await assertShippingFeature(tx, orgId);
  const updated = await tx.execute<{ id: string }>(
    sql`
    update shipping_accounts
       set status = 'disabled', updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${accountId} and status <> 'disabled'
    returning id`,
    "objects",
  );
  if (updated.length === 0)
    throw new ShippingRefusal("Carrier account not found", "not_found", 404);
  await writeAccountAudit(tx, orgId, actorId, accountId, "update", {
    mode: "shipping_account_disconnect",
  });
}

/**
 * Test the connection end to end: a real address validation over the
 * sealed key. An invalid verdict still proves the key works — only an
 * authentication or transport failure refuses.
 */
export async function testShippingConnection(
  tx: Tx,
  orgId: string,
  actorId: string,
  accountId: string,
): Promise<{ ok: true; detail: string }> {
  await assertShippingFeature(tx, orgId);
  const account = await loadShippingAccount(tx, orgId, accountId);
  const adapter = adapterFor(account.provider);
  let answer;
  try {
    answer = await adapter.validateAddress(
      { apiKey: account.apiKey },
      {
        name: "OpenBooks",
        street1: "228 Park Ave S",
        street2: null,
        city: "New York",
        state: "NY",
        zip: "10003",
        country: "US",
        phone: null,
        email: null,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection test failed";
    await tx.execute(sql`
      update shipping_accounts set status = 'error', last_error = ${message}, last_checked_at = now(),
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${account.id}`);
    throw new ShippingRefusal(
      `${account.name} connection test failed: ${message}`,
      "provider_failed",
      422,
      message,
    );
  }
  await tx.execute(sql`
    update shipping_accounts set status = 'active', last_error = null, last_checked_at = now(),
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${account.id}`);
  await writeAccountAudit(tx, orgId, actorId, account.id, "update", {
    mode: "shipping_account_test",
    valid: answer.valid,
  });
  return {
    ok: true,
    detail: answer.valid
      ? `${account.name} answered a live address check`
      : `${account.name} is reachable; the probe address itself did not validate (${answer.messages[0] ?? "no detail"})`,
  };
}

/**
 * Mint a relay secret for inbound tracker deliveries: the plain value is
 * shown once at connect time, the sealed value is what gets stored.
 */
export function mintRelaySecret(): { plain: string; sealed: (orgId: string) => string } {
  const plain = randomBytes(32).toString("hex");
  return {
    plain,
    sealed: (orgId: string) =>
      sealJson({ relaySecret: plain }, { orgId, purpose: SECRETS_PURPOSE }),
  };
}
