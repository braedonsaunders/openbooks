import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { fetchWithConnectorRetry } from "../connectors/http-retry.ts";
import { db, withBypassContext, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { sealJson, unsealJson } from "../platform/secrets.ts";
import { postProjectGlEntryWithinTransaction, reverseProjectGlEntryWithinTransaction } from "../journal/origin-entry.ts";
import {
  decimalToMinorUnits,
  minorUnitsToLedger,
  verifyRelaySignature,
  type CarrierAdapter,
  type CarrierAddress,
  type CarrierCustomsItem,
  type CarrierParcel,
  type CarrierRateRequest,
} from "../connectors/shipping.ts";
import { easyPostAdapter } from "../connectors/easypost.ts";
import { shippoAdapter } from "../connectors/shippo.ts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Scope = ReadonlySet<string> | null;

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
const QUOTE_TTL_MINUTES = 30;
const LABEL_PDF_MAX_BYTES = 20 * 1024 * 1024;

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

function adapterFor(provider: string): CarrierAdapter {
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
  const row = (await tx.execute<{
    id: string; provider: string; mode: string; status: string; name: string;
    secrets: string | null; webhook_secret: string | null; last_error: string | null;
  }>(accountId ? sql`
    select id, provider, mode, status, name, secrets, webhook_secret, last_error
      from shipping_accounts where org_id = ${orgId} and id = ${accountId} for share` : sql`
    select id, provider, mode, status, name, secrets, webhook_secret, last_error
      from shipping_accounts
     where org_id = ${orgId} and status = 'active'
     order by is_default desc, created_at asc limit 1 for share`)).rows[0];
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
    const parsed = await unsealJson<{ apiKey?: unknown }>(row.secrets, { orgId, purpose: SECRETS_PURPOSE });
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
      const relay = await unsealJson<{ relaySecret?: unknown }>(row.webhook_secret, { orgId, purpose: SECRETS_PURPOSE });
      webhookSecret = typeof relay?.relaySecret === "string" ? relay.relaySecret : null;
    } catch {
      throw new ShippingRefusal(
        `Carrier account ${row.name} stores a relay secret that cannot be unsealed`,
        "secret_missing",
        422,
        `Rotate the relay secret on ${row.name} in Setup → Shipping`,
      );
    }
  }
  return { id: row.id, provider: row.provider, mode: row.mode, status: row.status, name: row.name, apiKey, webhookSecret };
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
  lastError: string | null;
  lastCheckedAt: string | null;
}

/** Every carrier account with its health, for Setup. Keys never leave sealed. */
export async function listShippingAccounts(runner: SqlExecutor, orgId: string): Promise<ShippingAccountView[]> {
  await assertShippingFeature(runner, orgId);
  const rows = (await runner.execute<{
    id: string; name: string; provider: string; mode: string; status: string;
    is_default: boolean; secrets: string | null; last_error: string | null; last_checked_at: string | null;
  }>(sql`
    select id, name, provider, mode, status, is_default, secrets, last_error, last_checked_at
      from shipping_accounts where org_id = ${orgId} order by name`)).rows;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    mode: row.mode,
    status: row.status,
    isDefault: row.is_default,
    hasKey: row.secrets != null,
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
  const written = await tx.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'shipping_accounts', ${accountId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id`);
  if (written.rows.length === 0) throw new Error("shipping account change was not audited");
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
 */
export async function connectShippingAccount(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: ConnectAccountInput,
): Promise<{ accountId: string }> {
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
             is_default = ${input.makeDefault === true},
             updated_at = now(), updated_by = ${actorId}`;
    const keyed = input.apiKey
      ? sql`${base}, secrets = ${sealAccountSecrets(orgId, input.apiKey.trim())}`
      : base;
    const updated = await tx.execute<{ id: string }>(sql`
      ${keyed} where org_id = ${orgId} and id = ${input.accountId} returning id`);
    if (updated.rows.length === 0) throw new ShippingRefusal("Carrier account not found", "not_found", 404);
    await writeAccountAudit(tx, orgId, actorId, input.accountId, "update", {
      mode: "shipping_account_connect",
      name,
      provider: input.provider,
      accountMode: input.mode,
      keyReplaced: input.apiKey != null,
    });
    return { accountId: input.accountId };
  }
  if (!input.apiKey) {
    throw new ShippingRefusal("An API key is required to connect an account", "secret_missing", 422);
  }
  const created = await tx.execute<{ id: string }>(sql`
    insert into shipping_accounts
      (org_id, name, provider, mode, status, is_default, secrets, created_by, updated_by)
    values (${orgId}, ${name}, ${input.provider}, ${input.mode}, 'active',
            ${input.makeDefault === true}, ${sealAccountSecrets(orgId, input.apiKey.trim())},
            ${actorId}, ${actorId})
    returning id`);
  const accountId = created.rows[0]?.id;
  if (!accountId) throw new Error("shipping account was not connected");
  await writeAccountAudit(tx, orgId, actorId, accountId, "insert", {
    mode: "shipping_account_connect",
    name,
    provider: input.provider,
    accountMode: input.mode,
  });
  return { accountId };
}

/** Park an account without deleting its labels, quotes, or cost history. */
export async function disconnectShippingAccount(
  tx: Tx,
  orgId: string,
  actorId: string,
  accountId: string,
): Promise<void> {
  await assertShippingFeature(tx, orgId);
  const updated = await tx.execute<{ id: string }>(sql`
    update shipping_accounts
       set status = 'disabled', updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${accountId} and status <> 'disabled'
    returning id`);
  if (updated.rows.length === 0) throw new ShippingRefusal("Carrier account not found", "not_found", 404);
  await writeAccountAudit(tx, orgId, actorId, accountId, "update", { mode: "shipping_account_disconnect" });
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
    answer = await adapter.validateAddress({ apiKey: account.apiKey }, {
      name: "OpenBooks",
      street1: "228 Park Ave S",
      street2: null,
      city: "New York",
      state: "NY",
      zip: "10003",
      country: "US",
      phone: null,
      email: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection test failed";
    await tx.execute(sql`
      update shipping_accounts set status = 'error', last_error = ${message}, last_checked_at = now(),
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${account.id}`);
    throw new ShippingRefusal(`${account.name} connection test failed: ${message}`, "provider_failed", 422, message);
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
  return { plain, sealed: (orgId: string) => sealJson({ relaySecret: plain }, { orgId, purpose: SECRETS_PURPOSE }) };
}

// --- Shipment loading -------------------------------------------------------

interface ShipmentForRating {
  id: string;
  documentNumber: string;
  subsidiaryId: string;
  warehouseId: string;
  currency: string;
  orderId: string | null;
  orderNumber: string | null;
  shipTo: CarrierAddress;
  from: CarrierAddress;
}

/** Lock a draft, open shipment with its warehouse and ship-to addresses. */
async function lockShipmentForRating(
  tx: SqlExecutor,
  orgId: string,
  shipmentId: string,
  scope: Scope,
): Promise<Omit<ShipmentForRating, "shipTo" | "from"> & { shipToRaw: unknown }> {
  const row = (await tx.execute<{
    id: string; document_number: string; status: string; stage: string;
    subsidiary_id: string; warehouse_id: string; currency: string;
    order_id: string | null; order_number: string | null;
    ship_to_address: unknown;
  }>(sql`
    select d.id, d.document_number, d.status, fd.stage, d.subsidiary_id, fd.warehouse_id, d.currency,
           so.id as order_id, so.document_number as order_number, fd.ship_to_address
      from documents d
      join fulfillment_documents fd on fd.document_id = d.id and fd.org_id = d.org_id
      left join lateral (
        select up.id, up.document_number from document_links l
          join documents up on up.id = l.from_document_id and up.org_id = l.org_id
         where l.org_id = d.org_id and l.to_document_id = d.id and l.link_type in ('reserves', 'ships')
         limit 1) so on true
     where d.org_id = ${orgId} and d.id = ${shipmentId} and d.kind = 'shipment'`)).rows[0];
  if (!row) throw new ShippingRefusal("Shipment not found", "not_found", 404);
  if (scope !== null && scope !== undefined && !scope.has(row.subsidiary_id)) {
    throw new ShippingRefusal("Shipment not found", "not_found", 404);
  }
  if (row.status !== "draft" || row.stage !== "open") {
    const state = row.stage === "done" ? "complete" : row.status;
    throw new ShippingRefusal(
      `${row.document_number} is ${state}; only a draft shipment can be rated or labelled`,
      "wrong_stage",
      409,
      "Rate and buy labels before completing the shipment",
    );
  }
  return {
    id: row.id,
    documentNumber: row.document_number,
    subsidiaryId: row.subsidiary_id,
    warehouseId: row.warehouse_id,
    currency: row.currency,
    orderId: row.order_id,
    orderNumber: row.order_number,
    shipToRaw: row.ship_to_address,
  };
}

function toCarrierAddress(raw: unknown, what: string, remedy: string): CarrierAddress {
  const address = (raw ?? {}) as Record<string, unknown>;
  const pick = (field: string): string | null => {
    const value = address[field];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  // Warehouse rows use address_line1; shipment snapshots use line1.
  const street1 = pick("line1") ?? pick("address_line1") ?? pick("street1");
  const street2 = pick("line2") ?? pick("address_line2") ?? pick("street2");
  const city = pick("city");
  const state = pick("region") ?? pick("state");
  const zip = pick("postalCode") ?? pick("postal_code") ?? pick("zip");
  const country = pick("country");
  const lacking = [
    street1 ? null : "street",
    city ? null : "city",
    state ? null : "state",
    zip ? null : "postal code",
    country ? null : "country",
  ].filter(Boolean) as string[];
  if (lacking.length > 0) {
    throw new ShippingRefusal(`${what} is missing ${lacking.join(", ")}`, "address_missing", 422, remedy);
  }
  return {
    name: pick("label") ?? pick("name"),
    street1: street1!,
    street2,
    city: city!,
    state: state!,
    zip: zip!,
    country: country!.toUpperCase(),
    phone: pick("phone"),
    email: pick("email"),
  };
}

async function warehouseAddress(tx: SqlExecutor, orgId: string, warehouseId: string, documentNumber: string): Promise<CarrierAddress> {
  const row = (await tx.execute<{
    address_line1: string | null; address_line2: string | null; city: string | null;
    region: string | null; postal_code: string | null; country: string | null; name: string;
  }>(sql`
    select address_line1, address_line2, city, region, postal_code, country, name
      from warehouses where org_id = ${orgId} and stock_location_id = ${warehouseId}`)).rows[0];
  if (!row) {
    throw new ShippingRefusal(
      `${documentNumber} ships from a warehouse that no longer exists`,
      "address_missing",
      422,
      "Move the shipment to an active warehouse",
    );
  }
  return toCarrierAddress(
    {
      name: row.name,
      line1: row.address_line1,
      line2: row.address_line2,
      city: row.city,
      region: row.region,
      postalCode: row.postal_code,
      country: row.country,
    },
    `The ${row.name} warehouse address`,
    `Enter a full address on the warehouse in Warehouse → Warehouses`,
  );
}

interface ParcelLine {
  item_id: string;
  item_code: string | null;
  item_name: string;
  quantity: string;
  unit_price: string;
  weight: string | null;
  weight_unit: string | null;
  dimensions: { length: string | null; width: string | null; height: string | null; unit: "cm" | "in" } | null;
  hs_code: string | null;
  country_of_origin: string | null;
}

const WEIGHT_TO_KG: Record<string, string> = { g: "0.001", kg: "1", oz: "0.028349523125", lb: "0.45359237" };

/** Exact decimal multiplication, half-up to 6 places — parcel measures never touch floats. */
function mulExact(a: string, b: string): string {
  const parse = (value: string): { digits: bigint; scale: number } => {
    const [int = "0", frac = ""] = value.split(".");
    return { digits: BigInt(`${int}${frac}`), scale: frac.length };
  };
  const left = parse(a);
  const right = parse(b);
  const product = left.digits * right.digits;
  const productScale = left.scale + right.scale;
  const target = 6;
  const shift = productScale - target;
  const rounded = shift <= 0 ? product * 10n ** BigInt(-shift) : (product + 5n * 10n ** BigInt(shift - 1)) / 10n ** BigInt(shift);
  const whole = rounded / 1_000_000n;
  const rest = (rounded % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return rest === "" ? whole.toString() : `${whole}.${rest}`;
}

const IN_TO_CM = "2.54";

function weightToKg(weight: string, unit: string): string {
  const factor = WEIGHT_TO_KG[unit];
  if (!factor) throw new ShippingRefusal(`Unknown weight unit ${unit}`, "invalid_input", 422);
  return mulExact(weight, factor);
}

/** Unit weight times line quantity, exact. */
function mulQty(weightKg: string, quantity: string): string {
  return mulExact(weightKg, quantity);
}

/**
 * Build rating parcels from the shipment's lines. Item weights times line
 * quantities; a caller-chosen preset overrides per-item measures for the
 * whole shipment. An item with no weight refuses BY NAME — never zero.
 */
async function buildParcels(
  tx: SqlExecutor,
  orgId: string,
  shipment: { id: string; documentNumber: string },
  presetId: string | null | undefined,
): Promise<{ parcels: CarrierParcel[]; lines: ParcelLine[] }> {
  const lines = (await tx.execute<{
    item_id: string; item_code: string | null; item_name: string; quantity: string; unit_price: string;
    weight: string | null; weight_unit: string | null; dimensions: ParcelLine["dimensions"];
    hs_code: string | null; country_of_origin: string | null;
  }>(sql`
    select dl.item_id, i.code as item_code, i.name as item_name, dl.quantity::text as quantity,
           dl.unit_price::text as unit_price,
           i.weight::text as weight, i.weight_unit, i.dimensions, i.hs_code, i.country_of_origin
      from document_lines dl
      join items i on i.id = dl.item_id and i.org_id = dl.org_id
     where dl.org_id = ${orgId} and dl.document_id = ${shipment.id} and dl.item_id is not null
     order by dl.line_number`)).rows;
  if (lines.length === 0) {
    throw new ShippingRefusal(
      `${shipment.documentNumber} has no item lines to rate`,
      "invalid_input",
      422,
      "Add items to the shipment before getting rates",
    );
  }
  if (presetId) {
    const preset = (await tx.execute<{
      id: string; length: string | null; width: string | null; height: string | null;
      dim_unit: string; weight: string | null; weight_unit: string;
    }>(sql`
      select id, length::text, width::text, height::text, dim_unit, weight::text, weight_unit
        from package_presets where org_id = ${orgId} and id = ${presetId}`)).rows[0];
    if (!preset) throw new ShippingRefusal("Package preset not found", "not_found", 404);
    if (!preset.weight || !preset.weight_unit) {
      throw new ShippingRefusal("Package preset has no weight", "invalid_input", 422, "Set a weight on the preset in Setup → Shipping");
    }
    const parcels: CarrierParcel[] = lines.map(() => ({
      lengthCm: preset.dim_unit === "in" && preset.length ? mulExact(preset.length, IN_TO_CM) : preset.length,
      widthCm: preset.dim_unit === "in" && preset.width ? mulExact(preset.width, IN_TO_CM) : preset.width,
      heightCm: preset.dim_unit === "in" && preset.height ? mulExact(preset.height, IN_TO_CM) : preset.height,
      weightKg: weightToKg(preset.weight!, preset.weight_unit),
    }));
    return { parcels, lines: lines.map((line) => ({ ...line, quantity: line.quantity })) };
  }
  const parcels: CarrierParcel[] = lines.map((line) => {
    if (!line.weight || !line.weight_unit) {
      const label = line.item_code ? `${line.item_code} (${line.item_name})` : line.item_name;
      throw new ShippingRefusal(
        `Set a weight on item ${label} or choose a package preset`,
        "weight_missing",
        422,
        `Enter the weight on ${label} in Items, or pick a package preset when getting rates`,
      );
    }
    const unitWeightKg = weightToKg(line.weight, line.weight_unit);
    const dims = line.dimensions && typeof line.dimensions === "object" ? line.dimensions : null;
    const toCm = (value: string | null): string | null => {
      if (value == null) return null;
      return dims?.unit === "in" ? mulExact(value, IN_TO_CM) : value;
    };
    return {
      lengthCm: toCm(dims?.length ?? null),
      widthCm: toCm(dims?.width ?? null),
      heightCm: toCm(dims?.height ?? null),
      weightKg: mulQty(unitWeightKg, line.quantity),
    };
  });
  return { parcels, lines };
}

interface ShippingSettings {
  shippingExpenseAccountId: string | null;
  carrierPayableAccountId: string | null;
  defaultRateRule: string;
  markupBps: number;
  defaultInsurance: string;
  defaultSignature: string;
  customsContentsType: string | null;
  customsContentsExplanation: string | null;
}

async function loadSettings(tx: SqlExecutor, orgId: string): Promise<ShippingSettings> {
  const row = (await tx.execute<{
    shipping_expense_account_id: string | null; carrier_payable_account_id: string | null;
    default_rate_rule: string; markup_bps: number; default_insurance: string; default_signature: string;
    customs_defaults: { contentsType?: string; contentsExplanation?: string } | null;
  }>(sql`
    select shipping_expense_account_id, carrier_payable_account_id, default_rate_rule,
           markup_bps, default_insurance, default_signature, customs_defaults
      from shipping_settings where org_id = ${orgId} limit 1`)).rows[0];
  return {
    shippingExpenseAccountId: row?.shipping_expense_account_id ?? null,
    carrierPayableAccountId: row?.carrier_payable_account_id ?? null,
    defaultRateRule: row?.default_rate_rule ?? "cheapest",
    markupBps: row?.markup_bps ?? 0,
    defaultInsurance: row?.default_insurance ?? "none",
    defaultSignature: row?.default_signature ?? "none",
    customsContentsType: row?.customs_defaults?.contentsType ?? null,
    customsContentsExplanation: row?.customs_defaults?.contentsExplanation ?? null,
  };
}

/** Posting accounts must exist BEFORE the provider is charged, never after. */
async function requirePostingAccounts(
  tx: SqlExecutor,
  orgId: string,
  settings: ShippingSettings,
): Promise<{ expenseAccountId: string; payableAccountId: string }> {
  if (!settings.shippingExpenseAccountId || !settings.carrierPayableAccountId) {
    throw new ShippingRefusal(
      "Shipping cost accounts are not configured",
      "invalid_input",
      422,
      "Choose the shipping expense and carrier payable accounts in Setup → Shipping",
    );
  }
  const found = (await tx.execute<{ id: string }>(sql`
    select id from accounts
     where org_id = ${orgId} and id in (${settings.shippingExpenseAccountId}, ${settings.carrierPayableAccountId})
       and is_active for share`)).rows;
  if (found.length !== 2) {
    throw new ShippingRefusal(
      "A shipping cost account is missing or inactive",
      "invalid_input",
      422,
      "Choose active shipping expense and carrier payable accounts in Setup → Shipping",
    );
  }
  return { expenseAccountId: settings.shippingExpenseAccountId, payableAccountId: settings.carrierPayableAccountId };
}

// --- Rate shopping ----------------------------------------------------------

export type ShippingRateBadge = "cheapest" | "fastest" | "best_value";

export interface RankedShippingRate {
  providerRateId: string;
  providerShipmentId: string;
  parcelIndexes: number[];
  carrier: string;
  service: string;
  /** Carrier amount, exact decimal in `currency`. */
  amount: string;
  currency: string;
  /** Amount with the org markup applied, for customer-facing quotes. */
  markedUpAmount: string;
  deliveryDate: string | null;
  deliveryDays: number | null;
  badges: ShippingRateBadge[];
}

export interface ShipmentRateQuote {
  shipmentId: string;
  documentNumber: string;
  accountId: string;
  accountName: string;
  cached: boolean;
  rates: RankedShippingRate[];
}

function canonicalRequestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/** Compare exact decimal strings without floats: -1, 0, or 1. */
function cmpDecimal(a: string, b: string): number {
  const parse = (value: string): { neg: boolean; int: string; frac: string } => {
    const neg = value.startsWith("-");
    const [int = "0", frac = ""] = (neg ? value.slice(1) : value).split(".");
    return { neg, int: int.replace(/^0+(?=\d)/, ""), frac };
  };
  const left = parse(a);
  const right = parse(b);
  if (left.neg !== right.neg) return left.neg ? -1 : 1;
  const width = Math.max(left.frac.length, right.frac.length);
  const l = left.int + left.frac.padEnd(width, "0");
  const r = right.int + right.frac.padEnd(width, "0");
  const order = l.length !== r.length ? (l.length < r.length ? -1 : 1) : l < r ? -1 : l > r ? 1 : 0;
  return left.neg ? -order : order;
}

/** Landed comparison amount: carrier rate plus the org markup, exact. */
function markedUp(amount: string, markupBps: number): string {
  if (markupBps === 0) return amount;
  const bumped = mulExact(mulExact(amount, String(10000 + markupBps)), "0.0001");
  return bumped;
}

/** Rank one parcel's rates: cheapest, fastest, and best value badges. */
function rankRates(
  rates: { providerRateId: string; providerShipmentId: string; parcelIndexes: number[]; carrier: string; service: string; amount: string; currency: string; deliveryDate: string | null; deliveryDays: number | null }[],
  markupBps: number,
): RankedShippingRate[] {
  if (rates.length === 0) return [];
  const ranked = rates.map((rate) => ({ ...rate, markedUpAmount: markedUp(rate.amount, markupBps), badges: [] as ShippingRateBadge[] }));
  ranked.sort((a, b) => cmpDecimal(a.amount, b.amount) || (a.deliveryDays ?? 999) - (b.deliveryDays ?? 999));
  ranked[0]!.badges.push("cheapest");
  const withDays = ranked.filter((rate) => rate.deliveryDays != null);
  if (withDays.length > 0) {
    const fastest = Math.min(...withDays.map((rate) => rate.deliveryDays!));
    const winners = withDays.filter((rate) => rate.deliveryDays === fastest);
    winners.sort((a, b) => cmpDecimal(a.amount, b.amount));
    if (!winners[0]!.badges.includes("cheapest") || winners.length > 1 || withDays.length > 1) {
      winners[0]!.badges.push("fastest");
    }
    // Best value: the cheapest rate within one day of the fastest arrival.
    const contenders = withDays.filter((rate) => rate.deliveryDays! <= fastest + 1);
    contenders.sort((a, b) => cmpDecimal(a.amount, b.amount));
    if (contenders[0] && !contenders[0].badges.includes("cheapest")) contenders[0].badges.push("best_value");
  }
  return ranked;
}

/**
 * Pick one rate under a buying rule. `cheapest_by_date` needs a promised
 * date: the cheapest rate arriving on time, or null when none can.
 */
export function selectRateByRule(
  rates: RankedShippingRate[],
  rule: string,
  promisedDate?: string | null,
): RankedShippingRate | null {
  if (rates.length === 0) return null;
  if (rule === "fastest") {
    const withDays = rates.filter((rate) => rate.deliveryDays != null);
    if (withDays.length === 0) return rates[0]!;
    const fastest = Math.min(...withDays.map((rate) => rate.deliveryDays!));
    return withDays.filter((rate) => rate.deliveryDays === fastest).sort((a, b) => cmpDecimal(a.amount, b.amount))[0]!;
  }
  if (rule === "cheapest_by_date" && promisedDate) {
    const onTime = rates.filter((rate) => rate.deliveryDate != null && rate.deliveryDate <= promisedDate);
    if (onTime.length === 0) return null;
    return onTime.sort((a, b) => cmpDecimal(a.amount, b.amount))[0]!;
  }
  return rates[0]!;
}

function buildRateRequest(
  from: CarrierAddress,
  to: CarrierAddress,
  parcels: CarrierParcel[],
  lines: ParcelLine[],
  settings: ShippingSettings,
  direction: "outbound" | "return",
  currency: string,
): CarrierRateRequest {
  const international = from.country !== to.country;
  let customsItems: CarrierCustomsItem[] = [];
  if (international) {
    customsItems = lines.map((line) => {
      const label = line.item_code ? `${line.item_code} (${line.item_name})` : line.item_name;
      if (!line.hs_code || !line.country_of_origin) {
        throw new ShippingRefusal(
          `Enter an HS code and origin country on item ${label} to ship internationally`,
          "customs_missing",
          422,
          `Add the HS code and origin country on ${label} in Items`,
        );
      }
      // Quantities are exact decimal strings: the whole units cross the
      // border, and a fractional remainder still declares at least one.
      const wholeUnits = line.quantity.split(".")[0] ?? "0";
      const quantity = /^\d+$/.test(wholeUnits) && wholeUnits !== "0" ? Number(wholeUnits) : 1;
      return {
        description: line.item_name.slice(0, 200),
        quantity,
        valueAmount: line.unit_price,
        valueCurrency: currency,
        hsCode: line.hs_code,
        originCountry: line.country_of_origin.toUpperCase(),
      };
    });
  }
  const signature = settings.defaultSignature === "adult" || settings.defaultSignature === "direct"
    ? settings.defaultSignature
    : "none";
  const request: CarrierRateRequest = {
    fromAddress: direction === "return" ? to : from,
    toAddress: direction === "return" ? from : to,
    parcels,
    customsItems,
    customsContentsType: settings.customsContentsType,
    customsContentsExplanation: settings.customsContentsExplanation,
    insuranceAmount: null,
    insuranceCurrency: null,
    signature,
  };
  if (settings.defaultInsurance === "carrier_full") {
    const total = lines.reduce<string>((sum, line) => addDecimal(sum, mulExact(line.unit_price, line.quantity)), "0");
    request.insuranceAmount = total;
    request.insuranceCurrency = currency;
  }
  return request;
}

/** Exact decimal addition for goods-value totals. */
function addDecimal(a: string, b: string): string {
  const [aInt = "0", aFrac = ""] = a.split(".");
  const [bInt = "0", bFrac = ""] = b.split(".");
  const width = Math.max(aFrac.length, bFrac.length);
  const sum = BigInt(aInt + aFrac.padEnd(width, "0")) + BigInt(bInt + bFrac.padEnd(width, "0"));
  const negative = sum < 0n;
  const abs = (negative ? -sum : sum).toString().padStart(width + 1, "0");
  const int = abs.slice(0, abs.length - width) || "0";
  const frac = width === 0 ? "" : abs.slice(abs.length - width).replace(/0+$/, "");
  return `${negative ? "-" : ""}${int}${frac === "" ? "" : `.${frac}`}`;
}

export interface GetRatesInput {
  shipmentId: string;
  accountId?: string | null;
  presetId?: string | null;
  direction?: "outbound" | "return";
  allowedSubsidiaryIds: Scope;
  transport?: typeof fetch;
  baseUrl?: string;
}

/**
 * Ranked live rates for a draft shipment, cached short-term by request hash.
 * Everyday path: Get rates → cheapest/fastest/best-value badges → Buy label.
 */
export async function getShipmentRates(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: GetRatesInput,
): Promise<ShipmentRateQuote> {
  await assertShippingFeature(tx, orgId);
  const shipment = await lockShipmentForRating(tx, orgId, input.shipmentId, input.allowedSubsidiaryIds);
  const account = await loadShippingAccount(tx, orgId, input.accountId);
  const adapter = adapterFor(account.provider);
  const settings = await loadSettings(tx, orgId);
  const direction = input.direction ?? "outbound";
  const from = await warehouseAddress(tx, orgId, shipment.warehouseId, shipment.documentNumber);
  const shipTo = toCarrierAddress(
    shipment.shipToRaw,
    `Shipment ${shipment.documentNumber} has no ship-to address`,
    `Enter the ship-to address on ${shipment.documentNumber}`,
  );
  const { parcels, lines } = await buildParcels(tx, orgId, shipment, input.presetId);
  const request = buildRateRequest(from, shipTo, parcels, lines, settings, direction, shipment.currency);
  const hash = canonicalRequestHash({
    account: account.id,
    from,
    to: direction === "return" ? from : shipTo,
    parcels,
    customs: request.customsItems,
    insurance: [request.insuranceAmount, request.insuranceCurrency],
    signature: request.signature,
  });
  const cached = (await tx.execute<{ rates: RankedShippingRate[] }>(sql`
    select rates from shipping_rate_quotes
     where org_id = ${orgId} and shipment_document_id = ${shipment.id}
       and account_id = ${account.id} and request_hash = ${hash} and expires_at > now()
     order by quoted_at desc limit 1`)).rows[0];
  if (cached) {
    return {
      shipmentId: shipment.id,
      documentNumber: shipment.documentNumber,
      accountId: account.id,
      accountName: account.name,
      cached: true,
      rates: cached.rates as RankedShippingRate[],
    };
  }
  let options;
  try {
    options = await adapter.requestRates(
      { apiKey: account.apiKey, baseUrl: input.baseUrl, transport: input.transport },
      request,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "CarrierError") {
      throw new ShippingRefusal(`${account.name} rate shopping failed: ${error.message}`, "provider_failed", 422, error.message);
    }
    throw error;
  }
  const ranked = options.flatMap((option) =>
    rankRates(
      option.rates.map((rate) => ({
        providerRateId: rate.providerRateId,
        providerShipmentId: option.providerShipmentId,
        parcelIndexes: option.parcelIndexes,
        carrier: rate.carrier,
        service: rate.service,
        amount: rate.amount,
        currency: rate.currency,
        deliveryDate: rate.deliveryDate,
        deliveryDays: rate.deliveryDays,
      })),
      settings.markupBps,
    ),
  );
  if (ranked.length === 0) {
    throw new ShippingRefusal(
      `${account.name} returned no rates for ${shipment.documentNumber}`,
      "provider_failed",
      422,
      "Check the ship-to address and parcel weight, then try another carrier account",
    );
  }
  const stored = await tx.execute<{ id: string }>(sql`
    insert into shipping_rate_quotes
      (org_id, shipment_document_id, account_id, request_hash, rates, expires_at, created_by, updated_by)
    values (${orgId}, ${shipment.id}, ${account.id}, ${hash},
            ${JSON.stringify(ranked)}::jsonb, now() + (${QUOTE_TTL_MINUTES} || ' minutes')::interval,
            ${actorId}, ${actorId})
    returning id`);
  if (stored.rows.length === 0) throw new Error("rate quote was not recorded");
  return {
    shipmentId: shipment.id,
    documentNumber: shipment.documentNumber,
    accountId: account.id,
    accountName: account.name,
    cached: false,
    rates: ranked,
  };
}

/** A quoted rate still inside its short-lived window, for idempotent buying. */
export async function findQuotedRate(
  tx: SqlExecutor,
  orgId: string,
  shipmentId: string,
  accountId: string,
  providerRateId: string,
): Promise<RankedShippingRate> {
  const rows = (await tx.execute<{ rates: RankedShippingRate[] }>(sql`
    select rates from shipping_rate_quotes
     where org_id = ${orgId} and shipment_document_id = ${shipmentId} and account_id = ${accountId}
       and expires_at > now() order by quoted_at desc limit 5`)).rows;
  for (const row of rows) {
    const found = (row.rates as RankedShippingRate[]).find((rate) => rate.providerRateId === providerRateId);
    if (found) return found;
  }
  throw new ShippingRefusal(
    "That rate is no longer quoted — rates expire after 30 minutes",
    "quote_expired",
    409,
    "Get fresh rates for the shipment, then buy the label",
  );
}

// --- Label purchase ---------------------------------------------------------

export interface BoughtShippingLabel {
  id: string;
  shipmentId: string;
  documentNumber: string;
  orderId: string | null;
  carrier: string;
  service: string;
  trackingNumber: string | null;
  amountMinor: bigint;
  currency: string;
  costEntryId: string | null;
  duplicate: boolean;
}

async function writeLabelAudit(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  labelId: string,
  action: "insert" | "update",
  changes: Record<string, unknown>,
): Promise<void> {
  const written = await tx.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'shipment_labels', ${labelId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id`);
  if (written.rows.length === 0) throw new Error("shipping label change was not audited");
}

/** Tenant minor-unit precision; an unknown currency refuses instead of posting dust. */
async function minorUnitsFor(tx: SqlExecutor, currency: string): Promise<number> {
  const row = (await tx.execute<{ minor_units: number }>(sql`
    select minor_units from currencies where code = ${currency}`)).rows[0];
  const minorUnits = row?.minor_units;
  if (minorUnits == null || !Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) {
    throw new ShippingRefusal(
      `The ${currency} currency has unsupported minor-unit precision`,
      "currency_unsupported",
      422,
      "Buy the label in a supported billing currency",
    );
  }
  return minorUnits;
}

/** The subsidiary's booking currency must match the rate currency — no silent FX. */
async function requireFunctionalCurrency(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  rateCurrency: string,
): Promise<string> {
  const row = (await tx.execute<{ base_currency: string | null }>(sql`
    select nullif(trim(base_currency), '') as base_currency from subsidiaries
     where org_id = ${orgId} and id = ${subsidiaryId}`)).rows[0];
  const functional = row?.base_currency;
  if (!functional) {
    throw new ShippingRefusal("The shipment subsidiary has no functional currency", "invalid_input", 422);
  }
  if (functional !== rateCurrency) {
    throw new ShippingRefusal(
      `The ${rateCurrency} label cannot post to ${functional} books without a conversion`,
      "currency_unsupported",
      422,
      "Buy the label in the booking currency, or enable multi-currency conversion first",
    );
  }
  return functional;
}

/**
 * Store the provider's label PDF in the file cabinet in the SAME transaction
 * as the label row — the insert shapes mirror engine/src/hrm/documents/
 * cabinet.ts (files + file_versions + file_blobs + file_attachments under a
 * per-record folder), so the label reads through the normal download path.
 * Best-effort on the bytes: a bought label is financial truth even when its
 * PDF cannot be fetched right now, so a failed download keeps the provider
 * URL and leaves the file to a retry instead of losing the purchase.
 */
async function storeLabelPdf(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  labelId: string,
  documentNumber: string,
  labelUrl: string,
  transport?: typeof fetch,
): Promise<string | null> {
  let bytes: ArrayBuffer;
  try {
    const res = await fetchWithConnectorRetry(labelUrl, {}, {
      describe: "carrier label download",
      timeoutMs: 30_000,
      maxAttempts: 2,
      transport,
    });
    if (!res.ok) return null;
    const length = Number(res.headers.get("content-length") ?? "0");
    if (Number.isInteger(length) && length > LABEL_PDF_MAX_BYTES) return null;
    bytes = await res.arrayBuffer();
  } catch {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > LABEL_PDF_MAX_BYTES) return null;
  const content = Buffer.from(bytes);
  const contentHash = createHash("sha256").update(content).digest("hex");
  const lockKey = `shipping-label-folder:${orgId}:${labelId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
  const existing = (await tx.execute<{ id: string }>(sql`
    select id from folders
     where org_id = ${orgId} and record_table = 'shipment_labels' and record_id = ${labelId}
       and record_id is not null for share`)).rows[0];
  let folderId = existing?.id;
  if (!folderId) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"shipping-attachments-root:" + orgId}, 0))`);
    const root = (await tx.execute<{ id: string }>(sql`
      select id from folders where org_id = ${orgId} and system_kind = 'attachments'`)).rows[0];
    const rootId = root?.id ?? (await tx.execute<{ id: string }>(sql`
      insert into folders (org_id, name, is_system, system_kind, created_at, updated_at)
      values (${orgId}, 'Attachments', true, 'attachments', now(), now()) returning id`)).rows[0]!.id;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"shipping-attach-group:" + orgId}, 0))`);
    const group = (await tx.execute<{ id: string }>(sql`
      select id from folders where org_id = ${orgId} and parent_folder_id = ${rootId}
        and record_id is null and name = 'Shipping labels'`)).rows[0];
    const groupId = group?.id ?? (await tx.execute<{ id: string }>(sql`
      insert into folders (org_id, parent_folder_id, name, is_system, record_table, created_at, updated_at)
      values (${orgId}, ${rootId}, 'Shipping labels', true, 'shipment_labels', now(), now()) returning id`)).rows[0]!.id;
    folderId = (await tx.execute<{ id: string }>(sql`
      insert into folders (org_id, parent_folder_id, name, is_system, record_table, record_id, created_at, updated_at)
      values (${orgId}, ${groupId}, ${"shipment_labels / " + labelId.slice(0, 8)}, true, 'shipment_labels', ${labelId}, now(), now())
      returning id`)).rows[0]!.id;
  }
  const filename = `${documentNumber.replace(/[^A-Za-z0-9-]+/g, "-")}-label.pdf`;
  const fileId = (await tx.execute<{ id: string }>(sql`
    insert into files (org_id, folder_id, name, extension, file_type, content_type,
                       size_bytes, storage_kind, content_hash, created_by, updated_by, created_at, updated_at)
    values (${orgId}, ${folderId}, ${filename}, 'pdf', 'pdf', 'application/pdf',
            ${content.length}, 'db', ${contentHash}, ${actorId}, ${actorId}, now(), now())
    returning id`)).rows[0]!.id;
  const versionId = (await tx.execute<{ id: string }>(sql`
    insert into file_versions (file_id, version_number, size_bytes, content_type, storage_kind,
                               content_hash, created_by, created_at)
    values (${fileId}, 1, ${content.length}, 'application/pdf', 'db', ${contentHash}, ${actorId}, now())
    returning id`)).rows[0]!.id;
  const patched = await tx.execute<{ id: string }>(sql`
    update files set current_version_id = ${versionId} where id = ${fileId} and org_id = ${orgId} returning id`);
  if (patched.rows.length === 0) throw new Error("label file was not linked to its version");
  await tx.execute(sql`insert into file_blobs (version_id, bytes) values (${versionId}, ${content})`);
  // Justified: the file_attachments_unique key makes link creation idempotent,
  // so a retried unit converges instead of failing on its own earlier effect.
  await tx.execute(sql`
    insert into file_attachments (org_id, file_id, target_table, target_id, created_by, created_at)
    values (${orgId}, ${fileId}, 'shipment_labels', ${labelId}, ${actorId}, now())
    on conflict (org_id, file_id, target_table, target_id) do nothing`);
  return fileId;
}

export interface BuyLabelInput {
  shipmentId: string;
  providerRateId: string;
  accountId?: string | null;
  direction?: "outbound" | "return";
  allowedSubsidiaryIds: Scope;
  transport?: typeof fetch;
  baseUrl?: string;
}

/**
 * Buy a quoted label: idempotent per shipment and rate, costed to the
 * shipping expense account against the carrier payable, sourced to the
 * shipment with the order in the entry refs for later margin reads.
 * Posting accounts and booking currency are verified BEFORE the provider is
 * charged, so a bought label can never strand without its cost journal.
 */
export async function buyShipmentLabel(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: BuyLabelInput,
): Promise<BoughtShippingLabel> {
  await assertShippingFeature(tx, orgId);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"shipping-buy:" + orgId + ":" + input.shipmentId}, 0))`);
  const shipment = await lockShipmentForRating(tx, orgId, input.shipmentId, input.allowedSubsidiaryIds);
  const account = await loadShippingAccount(tx, orgId, input.accountId);
  const adapter = adapterFor(account.provider);
  const settings = await loadSettings(tx, orgId);
  const { expenseAccountId, payableAccountId } = await requirePostingAccounts(tx, orgId, settings);
  const quoted = await findQuotedRate(tx, orgId, shipment.id, account.id, input.providerRateId);
  await requireFunctionalCurrency(tx, orgId, shipment.subsidiaryId, quoted.currency);
  const minorUnits = await minorUnitsFor(tx, quoted.currency);

  const existing = (await tx.execute<{
    id: string; carrier: string; service: string; tracking_number: string | null;
    rate_minor: string; rate_currency: string; cost_entry_id: string | null;
  }>(sql`
    select id, carrier, service, tracking_number, rate_minor::text, rate_currency, cost_entry_id
      from shipment_labels
     where org_id = ${orgId} and shipment_document_id = ${shipment.id}
       and provider_rate_id = ${input.providerRateId} and status = 'purchased'
     limit 1 for share`)).rows[0];
  if (existing?.cost_entry_id) {
    return {
      id: existing.id,
      shipmentId: shipment.id,
      documentNumber: shipment.documentNumber,
      orderId: shipment.orderId,
      carrier: existing.carrier,
      service: existing.service,
      trackingNumber: existing.tracking_number,
      amountMinor: BigInt(existing.rate_minor),
      currency: existing.rate_currency,
      costEntryId: existing.cost_entry_id,
      duplicate: true,
    };
  }
  if (existing) {
    // The provider already charged this rate but the cost never posted
    // (interrupted buy): resume posting instead of charging twice.
    const resumedEntryId = await postLabelCost(tx, orgId, actorId, {
      labelId: existing.id,
      shipmentId: shipment.id,
      documentNumber: shipment.documentNumber,
      orderId: shipment.orderId,
      subsidiaryId: shipment.subsidiaryId,
      expenseAccountId,
      payableAccountId,
      rateMinor: BigInt(existing.rate_minor),
      currency: existing.rate_currency,
      minorUnits,
      isReturn: input.direction === "return",
    });
    return {
      id: existing.id,
      shipmentId: shipment.id,
      documentNumber: shipment.documentNumber,
      orderId: shipment.orderId,
      carrier: existing.carrier,
      service: existing.service,
      trackingNumber: existing.tracking_number,
      amountMinor: BigInt(existing.rate_minor),
      currency: existing.rate_currency,
      costEntryId: resumedEntryId,
      duplicate: true,
    };
  }

  let bought;
  try {
    bought = await adapter.buyLabel(
      { apiKey: account.apiKey, baseUrl: input.baseUrl, transport: input.transport },
      quoted.providerShipmentId,
      input.providerRateId,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "CarrierError") {
      throw new ShippingRefusal(`${account.name} label purchase failed: ${error.message}`, "provider_failed", 422, error.message);
    }
    throw error;
  }
  const rateMinor = decimalToMinorUnits(bought.amount, minorUnits);
  const labelId = (await tx.execute<{ id: string }>(sql`
    insert into shipment_labels
      (org_id, shipment_document_id, order_document_id, account_id, provider,
       provider_shipment_id, provider_rate_id, provider_label_id, carrier, service,
       rate_minor, rate_currency, label_url, tracking_number, tracking_status,
       status, purchased_at, created_by, updated_by)
    values (${orgId}, ${shipment.id}, ${shipment.orderId}, ${account.id}, ${account.provider},
            ${bought.providerShipmentId}, ${input.providerRateId}, ${bought.providerLabelId},
            ${bought.carrier}, ${bought.service}, ${rateMinor.toString()}, ${bought.currency},
            ${bought.labelUrl}, ${bought.trackingNumber},
            ${bought.trackingNumber ? "pre_transit" : "unknown"},
            'purchased', now(), ${actorId}, ${actorId})
    returning id`)).rows[0]?.id;
  if (!labelId) throw new Error("shipping label was not recorded");

  let labelFileId: string | null = null;
  if (bought.labelUrl) {
    labelFileId = await storeLabelPdf(tx, orgId, actorId, labelId, shipment.documentNumber, bought.labelUrl, input.transport);
    if (labelFileId) {
      const patched = await tx.execute<{ id: string }>(sql`
        update shipment_labels set label_file_id = ${labelFileId}, updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${labelId} returning id`);
      if (patched.rows.length === 0) throw new Error("shipping label file was not linked");
    }
  }

  // The native carriers registry stays the single home of carrier identity:
  // buying a hub label files the provider's carrier and service there (never
  // a second registry), so fulfillment_documents keeps its carrier invariant
  // (a service always rides a carrier row) and manual shipment screens read
  // hub labels without a special case.
  const carrierCode = bought.carrier.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!carrierCode) {
    throw new ShippingRefusal(
      `${account.name} returned a label with an unusable carrier name`,
      "provider_failed",
      422,
      "Buy the label again from another rate",
    );
  }
  const carrierRow = (await tx.execute<{ id: string }>(sql`
    insert into carriers (org_id, code, name, services, is_active, created_by, updated_by)
    values (${orgId}, ${carrierCode}, ${bought.carrier}, ARRAY[${bought.service}]::text[], true, ${actorId}, ${actorId})
    on conflict (org_id, code) do update
       set name = excluded.name,
           services = (select array_agg(distinct service order by service)
                         from unnest(carriers.services || excluded.services) as service),
           updated_at = now(), updated_by = ${actorId}
    returning id`)).rows[0];
  if (!carrierRow) throw new Error("carrier row was not filed for the shipping label");
  const stamped = await tx.execute<{ id: string }>(sql`
    update fulfillment_documents
       set carrier_id = ${carrierRow.id}, carrier_service = ${bought.service},
           tracking_number = ${bought.trackingNumber},
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and document_id = ${shipment.id} and stage = 'open'
    returning document_id`);
  if (stamped.rows.length === 0) {
    throw new ShippingRefusal(
      `${shipment.documentNumber} changed while its label was being bought`,
      "changed_concurrently",
      409,
      "Reload the shipment and try again",
    );
  }

  if (bought.currency !== quoted.currency) {
    throw new ShippingRefusal(
      `${account.name} charged ${bought.currency} for a ${quoted.currency} rate`,
      "provider_failed",
      422,
      "Void the label with the carrier, then buy it again from fresh rates",
    );
  }
  const entryId = await postLabelCost(tx, orgId, actorId, {
    labelId,
    shipmentId: shipment.id,
    documentNumber: shipment.documentNumber,
    orderId: shipment.orderId,
    subsidiaryId: shipment.subsidiaryId,
    expenseAccountId,
    payableAccountId,
    rateMinor,
    currency: bought.currency,
    minorUnits,
    isReturn: input.direction === "return",
  });

  await writeLabelAudit(tx, orgId, actorId, labelId, "insert", {
    mode: "shipping_label_buy",
    shipmentId: shipment.id,
    orderId: shipment.orderId,
    provider: account.provider,
    providerShipmentId: bought.providerShipmentId,
    providerRateId: input.providerRateId,
    carrier: bought.carrier,
    service: bought.service,
    amountMinor: rateMinor.toString(),
    currency: bought.currency,
    trackingNumber: bought.trackingNumber,
    costEntryId: entryId,
  });
  return {
    id: labelId,
    shipmentId: shipment.id,
    documentNumber: shipment.documentNumber,
    orderId: shipment.orderId,
    carrier: bought.carrier,
    service: bought.service,
    trackingNumber: bought.trackingNumber,
    amountMinor: rateMinor,
    currency: bought.currency,
    costEntryId: entryId,
    duplicate: false,
  };
}

interface LabelCostInput {
  labelId: string;
  shipmentId: string;
  documentNumber: string;
  orderId: string | null;
  subsidiaryId: string;
  expenseAccountId: string;
  payableAccountId: string;
  rateMinor: bigint;
  currency: string;
  minorUnits: number;
  isReturn: boolean;
}

/**
 * Post one label's carrier cost: DR shipping expense, CR carrier payable,
 * sourced to the shipment with the label and the order in the entry refs so
 * order margin reads it. The entry number derives from the label id, and the
 * idempotency key from the label too, so resuming an interrupted buy
 * converges instead of double-posting.
 */
async function postLabelCost(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: LabelCostInput,
): Promise<string> {
  // A crashed buy resumes here instead of double-posting: the label row is
  // the serialization point, and the entry number is stable per label.
  const resumed = (await tx.execute<{ cost_entry_id: string | null }>(sql`
    select cost_entry_id from shipment_labels
     where org_id = ${orgId} and id = ${input.labelId} for update`)).rows[0];
  if (!resumed) throw new Error("shipping label disappeared while its cost was being posted");
  if (resumed.cost_entry_id) return resumed.cost_entry_id;
  const carrier = input.isReturn ? "return " : "";
  const ledgerAmount = minorUnitsToLedger(input.rateMinor, input.minorUnits);
  const entryId = await postProjectGlEntryWithinTransaction(tx, {
    orgId,
    actorId,
    origin: "shipping_label",
    entryNumber: `SHPC-${input.documentNumber}-${input.labelId.slice(0, 8)}`,
    postingDate: await businessTodayInTx(tx, orgId),
    memo: `Carrier ${carrier}label for ${input.documentNumber}`,
    subsidiaryId: input.subsidiaryId,
    currency: input.currency,
    sourceDocumentId: input.shipmentId,
    custom: { labelId: input.labelId, shipmentId: input.shipmentId, orderId: input.orderId },
    idempotencyKey: `shipping-label-cost:${input.labelId}`,
    lines: [
      {
        accountId: input.expenseAccountId,
        amount: ledgerAmount,
        memo: `Carrier cost for ${input.documentNumber}`,
      },
      {
        accountId: input.payableAccountId,
        amount: ledgerAmount.startsWith("-") ? ledgerAmount.slice(1) : `-${ledgerAmount}`,
        memo: `Carrier payable for ${input.documentNumber}`,
      },
    ],
  });
  if (!entryId) throw new Error("shipping label cost was not posted");
  // A zero-row update is a failure, never a success: the label row is
  // locked above, so no row means it was deleted mid-flight.
  const linked = await tx.execute<{ id: string }>(sql`
    update shipment_labels set cost_entry_id = ${entryId}, updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${input.labelId} and cost_entry_id is null returning id`);
  if (linked.rows.length === 0) {
    const winner = (await tx.execute<{ cost_entry_id: string | null }>(sql`
      select cost_entry_id from shipment_labels where org_id = ${orgId} and id = ${input.labelId}`)).rows[0];
    if (winner?.cost_entry_id) return winner.cost_entry_id;
    throw new Error("shipping label cost was not linked");
  }
  return entryId;
}

// --- Label void -------------------------------------------------------------

export interface VoidLabelInput {
  labelId: string;
  reason: string;
  allowedSubsidiaryIds?: Scope;
  transport?: typeof fetch;
  baseUrl?: string;
}

/**
 * Void a purchased label: the provider refund is requested first, then the
 * label flips to voided and its cost journal reverses. Posted history stays
 * immutable — the void is a reversal, never an edit.
 */
export async function voidShipmentLabel(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: VoidLabelInput,
): Promise<{ labelId: string; reversalEntryId: string | null }> {
  await assertShippingFeature(tx, orgId);
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new ShippingRefusal("Give a void reason between 5 and 500 characters", "invalid_input", 422);
  }
  const label = (await tx.execute<{
    id: string; shipment_document_id: string; account_id: string; provider: string;
    provider_shipment_id: string; provider_label_id: string | null; status: string;
    tracking_number: string | null; cost_entry_id: string | null; subsidiary_id: string;
  }>(sql`
    select l.id, l.shipment_document_id, l.account_id, l.provider, l.provider_shipment_id,
           l.provider_label_id, l.status, l.tracking_number, l.cost_entry_id, d.subsidiary_id
      from shipment_labels l
      join documents d on d.id = l.shipment_document_id and d.org_id = l.org_id
     where l.org_id = ${orgId} and l.id = ${input.labelId} for update of l`)).rows[0];
  if (!label) throw new ShippingRefusal("Shipping label not found", "not_found", 404);
  if (input.allowedSubsidiaryIds && !input.allowedSubsidiaryIds.has(label.subsidiary_id)) {
    throw new ShippingRefusal("Shipping label not found", "not_found", 404);
  }
  if (label.status !== "purchased") {
    throw new ShippingRefusal(
      `That label is already ${label.status}`,
      "label_not_voidable",
      409,
      "Only a purchased label can be voided",
    );
  }
  const account = await loadShippingAccount(tx, orgId, label.account_id);
  const adapter = adapterFor(account.provider);
  let voided: { accepted: boolean; rawStatus: string };
  try {
    voided = await adapter.voidLabel(
      { apiKey: account.apiKey, baseUrl: input.baseUrl, transport: input.transport },
      { providerShipmentId: label.provider_shipment_id, providerLabelId: label.provider_label_id },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "CarrierError") {
      throw new ShippingRefusal(`${account.name} label refund failed: ${error.message}`, "provider_failed", 422, error.message);
    }
    throw error;
  }
  if (!voided.accepted) {
    throw new ShippingRefusal(
      `${account.name} refused the refund (provider status ${voided.rawStatus}) — the parcel may already be moving`,
      "label_not_voidable",
      409,
      "Leave the label purchased and record the charge as a carrier billing adjustment instead",
    );
  }
  const flipped = await tx.execute<{ id: string }>(sql`
    update shipment_labels
       set status = 'voided', voided_at = now(), updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${label.id} and status = 'purchased' returning id`);
  if (flipped.rows.length === 0) {
    throw new ShippingRefusal("That label changed while it was being voided", "changed_concurrently", 409, "Reload and try again");
  }
  let reversalEntryId: string | null = null;
  if (label.cost_entry_id) {
    const reversal = await reverseProjectGlEntryWithinTransaction(
      tx,
      orgId,
      actorId,
      label.cost_entry_id,
      `Label voided: ${reason}`,
    );
    if (reversal.status === "missing") throw new Error("shipping label cost entry is missing and cannot reverse");
    reversalEntryId = reversal.reversalId;
  }
  await writeLabelAudit(tx, orgId, actorId, label.id, "update", {
    mode: "shipping_label_void",
    reason,
    providerStatus: voided.rawStatus,
    reversedEntryId: label.cost_entry_id,
    reversalEntryId,
  });
  return { labelId: label.id, reversalEntryId };
}

// --- Tracking -----------------------------------------------------------------

export interface RefreshTrackingInput {
  labelId: string;
  transport?: typeof fetch;
  baseUrl?: string;
}

/** Re-read one label's tracker over the sealed API key and store what moved. */
export async function refreshLabelTracking(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: RefreshTrackingInput,
): Promise<{ labelId: string; trackingStatus: string; changed: boolean }> {
  await assertShippingFeature(tx, orgId);
  const label = (await tx.execute<{
    id: string; account_id: string; provider: string; provider_shipment_id: string;
    carrier: string; tracking_number: string | null; tracking_status: string;
    events: { id: string | null; status: string; detail: string | null; occurredAt: string | null }[];
  }>(sql`
    select id, account_id, provider, provider_shipment_id, carrier, tracking_number, tracking_status, events
      from shipment_labels where org_id = ${orgId} and id = ${input.labelId} for update`)).rows[0];
  if (!label) throw new ShippingRefusal("Shipping label not found", "not_found", 404);
  const account = await loadShippingAccount(tx, orgId, label.account_id);
  const adapter = adapterFor(account.provider);
  let state;
  try {
    state = await adapter.getTracker(
      { apiKey: account.apiKey, baseUrl: input.baseUrl, transport: input.transport },
      {
        carrier: label.carrier,
        trackingNumber: label.tracking_number ?? undefined,
        providerShipmentId: label.provider_shipment_id,
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "CarrierError") {
      throw new ShippingRefusal(`${account.name} tracker refresh failed: ${error.message}`, "provider_failed", 422, error.message);
    }
    throw error;
  }
  return applyTrackerState(tx, orgId, actorId, label, state.status, state.events);
}

async function applyTrackerState(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  label: {
    id: string; tracking_status: string;
    events: { id: string | null; status: string; detail: string | null; occurredAt: string | null }[];
  },
  status: string,
  incoming: { id: string | null; status: string; detail: string | null; occurredAt: string | null }[],
): Promise<{ labelId: string; trackingStatus: string; changed: boolean }> {
  const seen = new Set(label.events.map((event) => `${event.id ?? ""}|${event.occurredAt ?? ""}|${event.detail ?? ""}`));
  const merged = [...label.events];
  for (const event of incoming) {
    const key = `${event.id ?? ""}|${event.occurredAt ?? ""}|${event.detail ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(event);
    }
  }
  const changed = status !== label.tracking_status || merged.length !== label.events.length;
  if (!changed) return { labelId: label.id, trackingStatus: label.tracking_status, changed: false };
  // A zero-row update is a failure: the label row is locked above.
  const updated = await tx.execute<{ id: string }>(sql`
    update shipment_labels
       set tracking_status = ${status}, events = ${JSON.stringify(merged)}::jsonb,
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${label.id} returning id`);
  if (updated.rows.length === 0) throw new Error("shipping label tracking was not recorded");
  await writeLabelAudit(tx, orgId, actorId, label.id, "update", {
    mode: "shipping_tracking",
    trackingStatus: status,
    newEvents: merged.length - label.events.length,
  });
  return { labelId: label.id, trackingStatus: status, changed: true };
}

export interface TrackerDeliveryInput {
  provider: string;
  headers: Record<string, string>;
  rawBody: string;
  transport?: typeof fetch;
  baseUrl?: string;
}

/** Provider deliveries are system provenance: a null actor, never a user. */
export const TRACKER_SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Sessionless entry for inbound tracker deliveries: parse the delivery,
 * resolve its owning org by the refs it names, then run the scoped
 * delivery. The org lookup runs bypassed and returns org ids only — an
 * inbound delivery names nothing but its own provider refs and there is
 * no session to scope it by, the same model as provider payment webhooks.
 * Signature verification still runs inside the org scope, before any
 * state changes.
 */
export async function receiveTrackerDelivery(
  provider: string,
  headers: Record<string, string>,
  rawBody: string,
): Promise<TrackerDeliveryResult> {
  const adapter = adapterFor(provider);
  const parsed = adapter.parseInboundEvent(safeJsonParse(rawBody));
  if (!parsed) return { status: "ignored" };
  // bypass: connector-tracker — see the docblock above.
  const orgId = await withBypassContext(() => resolveTrackerOrgId(provider, parsed.tracker));
  if (!orgId) return { status: "ignored" };
  return withOrgTransaction(orgId, () =>
    handleTrackerDelivery(db, orgId, TRACKER_SYSTEM_ACTOR_ID, { provider, headers, rawBody }),
  );
}

/** Owning org of a tracker delivery, by provider shipment first, then tracking number. */
async function resolveTrackerOrgId(
  provider: string,
  tracker: { providerShipmentId?: string; trackingNumber?: string },
): Promise<string | null> {
  if (tracker.providerShipmentId) {
    const byShipment = (await db.execute<{ org_id: string }>(sql`
      select org_id from shipment_labels
       where provider = ${provider} and provider_shipment_id = ${tracker.providerShipmentId}
       limit 1`)).rows[0];
    if (byShipment) return byShipment.org_id;
  }
  if (tracker.trackingNumber) {
    const byTracking = (await db.execute<{ org_id: string }>(sql`
      select org_id from shipment_labels
       where provider = ${provider} and tracking_number = ${tracker.trackingNumber}
       limit 1`)).rows[0];
    if (byTracking) return byTracking.org_id;
  }
  return null;
}

export type TrackerDeliveryResult =
  | { status: "ignored" }
  | { status: "ok"; labelId: string; trackingStatus: string; changed: boolean };

/**
 * Handle an inbound tracker delivery. Aggregator callbacks carry no provider
 * signature, so the delivery is NEVER trusted on arrival: the label is
 * resolved locally, the optional relay signature is checked when the account
 * configures one, and the tracker is always re-read over the sealed API key
 * before any state changes. A bad signature is a 401 with no side effects.
 */
export async function handleTrackerDelivery(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: TrackerDeliveryInput,
  adapterOverride?: CarrierAdapter,
): Promise<TrackerDeliveryResult> {
  await assertShippingFeature(tx, orgId);
  const adapter = adapterOverride ?? adapterFor(input.provider);
  const parsed = adapter.parseInboundEvent(safeJsonParse(input.rawBody));
  if (!parsed) return { status: "ignored" };
  // Provider shipment id first, tracking number second: two plain lookups
  // instead of one nullable-parameter OR, which PostgreSQL cannot plan
  // (untyped null parameters) and which would hide precedence.
  const label = (await findLabelForTracker(tx, orgId, parsed.tracker.providerShipmentId, parsed.tracker.trackingNumber));
  if (!label || label.provider !== adapter.key) return { status: "ignored" };
  const account = await loadShippingAccount(tx, orgId, label.account_id);
  if (account.webhookSecret) {
    const signature = input.headers["openbooks-signature"] ?? input.headers["OpenBooks-Signature"] ?? null;
    if (!verifyRelaySignature(input.rawBody, signature, account.webhookSecret)) {
      throw new ShippingRefusal(
        "Tracker delivery signature verification failed",
        "signature_invalid",
        401,
        `Configure the relay secret from ${account.name} on the delivery sender in Setup → Shipping`,
      );
    }
  }
  let state;
  try {
    state = await adapter.getTracker(
      { apiKey: account.apiKey, baseUrl: input.baseUrl, transport: input.transport },
      {
        trackerId: parsed.tracker.trackerId,
        carrier: parsed.tracker.carrier ?? label.carrier,
        trackingNumber: parsed.tracker.trackingNumber ?? label.tracking_number ?? undefined,
        providerShipmentId: parsed.tracker.providerShipmentId ?? label.provider_shipment_id,
      },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "CarrierError") {
      throw new ShippingRefusal(`${account.name} tracker confirmation failed: ${error.message}`, "provider_failed", 422, error.message);
    }
    throw error;
  }
  const applied = await applyTrackerState(tx, orgId, actorId, label, state.status, state.events);
  return { status: "ok", labelId: applied.labelId, trackingStatus: applied.trackingStatus, changed: applied.changed };
}

type TrackedLabel = {
  id: string;
  account_id: string;
  provider: string;
  provider_shipment_id: string;
  carrier: string;
  tracking_number: string | null;
  tracking_status: string;
  events: { id: string | null; status: string; detail: string | null; occurredAt: string | null }[];
};

/** Resolve the label a tracker delivery belongs to, locking it for the update. */
async function findLabelForTracker(
  tx: SqlExecutor,
  orgId: string,
  providerShipmentId: string | undefined,
  trackingNumber: string | undefined,
): Promise<TrackedLabel | undefined> {
  const columns = sql`id, account_id, provider, provider_shipment_id, carrier, tracking_number, tracking_status, events`;
  if (providerShipmentId) {
    const byShipment = (await tx.execute<TrackedLabel>(sql`
      select ${columns} from shipment_labels
       where org_id = ${orgId} and provider_shipment_id = ${providerShipmentId}
       limit 1 for update`)).rows[0];
    if (byShipment) return byShipment;
  }
  if (trackingNumber) {
    const byTracking = (await tx.execute<TrackedLabel>(sql`
      select ${columns} from shipment_labels
       where org_id = ${orgId} and tracking_number = ${trackingNumber}
       limit 1 for update`)).rows[0];
    if (byTracking) return byTracking;
  }
  return undefined;
}

/** Parse without throwing: a malformed delivery is ignored, never a 500. */
function safeJsonParse(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
}

// --- Carrier billing adjustments -----------------------------------------------

export interface BillingAdjustmentInput {
  providerAdjustmentId: string;
  providerShipmentId: string;
  kind: string;
  /** Exact decimal string; positive = extra charge, negative = credit. */
  amount: string;
  currency: string;
  reason?: string | null;
  occurredAt?: string | null;
}

const ADJUSTMENT_KINDS = new Set([
  "weight_correction",
  "dimension_correction",
  "address_correction",
  "fuel",
  "duplicate",
  "other",
]);

/**
 * Import aggregator billing adjustments (weight/dimension corrections and
 * the like) against the label they correct. Replaying an import converges:
 * the provider identity is unique, so a repeated delivery skips instead of
 * double-booking.
 */
export async function importBillingAdjustments(
  tx: Tx,
  orgId: string,
  actorId: string,
  accountId: string,
  items: BillingAdjustmentInput[],
): Promise<{ imported: number; skipped: number }> {
  await assertShippingFeature(tx, orgId);
  const account = await loadShippingAccount(tx, orgId, accountId);
  let imported = 0;
  let skipped = 0;
  for (const item of items) {
    const identity = item.providerAdjustmentId.trim();
    if (!identity) {
      throw new ShippingRefusal("A billing adjustment is missing its provider id", "invalid_input", 422);
    }
    if (!ADJUSTMENT_KINDS.has(item.kind)) {
      throw new ShippingRefusal(
        `Unknown billing adjustment kind ${item.kind}`,
        "invalid_input",
        422,
        "Use one of weight_correction, dimension_correction, address_correction, fuel, duplicate, or other",
      );
    }
    const minorUnits = await minorUnitsFor(tx, item.currency);
    const amountMinor = decimalToMinorUnits(item.amount, minorUnits);
    if (amountMinor === 0n) {
      throw new ShippingRefusal(
        `Billing adjustment ${identity} carries a zero amount`,
        "invalid_input",
        422,
        "Drop zero-amount adjustments from the import",
      );
    }
    if (item.occurredAt != null && !/^\d{4}-\d{2}-\d{2}/.test(item.occurredAt)) {
      throw new ShippingRefusal(`Billing adjustment ${identity} has an invalid date`, "invalid_input", 422);
    }
    const label = (await tx.execute<{ id: string }>(sql`
      select l.id from shipment_labels l
       where l.org_id = ${orgId} and l.account_id = ${account.id}
         and l.provider_shipment_id = ${item.providerShipmentId} limit 1 for share`)).rows[0];
    if (!label) {
      throw new ShippingRefusal(
        `Billing adjustment ${identity} references an unknown label`,
        "adjustment_unknown",
        422,
        "Buy the label in OpenBooks first, or correct the shipment reference in the import",
      );
    }
    // Justified: the provider identity is the import's idempotency key, so a
    // replayed billing file converges on the first write instead of failing.
    const written = await tx.execute<{ id: string }>(sql`
      insert into shipping_adjustments
        (org_id, label_id, provider_adjustment_id, kind, amount_minor, currency,
         reason, status, occurred_at, created_by, updated_by)
      values (${orgId}, ${label.id}, ${identity}, ${item.kind}, ${amountMinor.toString()}, ${item.currency},
              ${item.reason ?? null}, 'pending', ${item.occurredAt ?? null}, ${actorId}, ${actorId})
      on conflict (org_id, provider_adjustment_id) do nothing
      returning id`);
    if (written.rows.length === 0) {
      skipped += 1;
    } else {
      imported += 1;
      await writeLabelAudit(tx, orgId, actorId, label.id, "update", {
        mode: "shipping_adjustment_import",
        adjustmentId: written.rows[0]!.id,
        providerAdjustmentId: identity,
        kind: item.kind,
        amountMinor: amountMinor.toString(),
        currency: item.currency,
      });
    }
  }
  return { imported, skipped };
}

/**
 * Post one imported adjustment against its label: extra charges DR expense /
 * CR payable, credits mirrored. The adjustment id is the entry's stable
 * identity, so reposting converges instead of doubling.
 */
export async function postBillingAdjustment(
  tx: Tx,
  orgId: string,
  actorId: string,
  adjustmentId: string,
): Promise<{ adjustmentId: string; entryId: string }> {
  await assertShippingFeature(tx, orgId);
  const adjustment = (await tx.execute<{
    id: string; label_id: string; kind: string; amount_minor: string; currency: string;
    status: string; entry_id: string | null; shipment_id: string; order_id: string | null;
    subsidiary_id: string;
  }>(sql`
    select a.id, a.label_id, a.kind, a.amount_minor::text, a.currency, a.status, a.entry_id,
           l.shipment_document_id as shipment_id, l.order_document_id as order_id, d.subsidiary_id
      from shipping_adjustments a
      join shipment_labels l on l.id = a.label_id and l.org_id = a.org_id
      join documents d on d.id = l.shipment_document_id and d.org_id = a.org_id
     where a.org_id = ${orgId} and a.id = ${adjustmentId} for update of a`)).rows[0];
  if (!adjustment) throw new ShippingRefusal("Billing adjustment not found", "not_found", 404);
  if (adjustment.entry_id) return { adjustmentId: adjustment.id, entryId: adjustment.entry_id };
  if (adjustment.status !== "pending") {
    throw new ShippingRefusal(
      `That adjustment is ${adjustment.status}`,
      "invalid_input",
      409,
      "Only a pending adjustment can be posted",
    );
  }
  const settings = await loadSettings(tx, orgId);
  const { expenseAccountId, payableAccountId } = await requirePostingAccounts(tx, orgId, settings);
  await requireFunctionalCurrency(tx, orgId, adjustment.subsidiary_id, adjustment.currency);
  const minorUnits = await minorUnitsFor(tx, adjustment.currency);
  const amount = minorUnitsToLedger(BigInt(adjustment.amount_minor), minorUnits);
  const extra = amount.startsWith("-");
  const unsigned = extra ? amount.slice(1) : amount;
  const entryId = await postProjectGlEntryWithinTransaction(tx, {
    orgId,
    actorId,
    origin: "shipping_adjustment",
    entryNumber: `SHPA-${adjustment.id.slice(0, 8)}`,
    postingDate: await businessTodayInTx(tx, orgId),
    memo: `Carrier ${adjustment.kind.replace(/_/g, " ")} for label ${adjustment.label_id.slice(0, 8)}`,
    subsidiaryId: adjustment.subsidiary_id,
    currency: adjustment.currency,
    sourceDocumentId: adjustment.shipment_id,
    custom: { adjustmentId: adjustment.id, labelId: adjustment.label_id, orderId: adjustment.order_id },
    idempotencyKey: `shipping-adjustment:${adjustment.id}`,
    lines: [
      {
        accountId: extra ? payableAccountId : expenseAccountId,
        amount: extra ? unsigned : amount,
        memo: `Carrier adjustment ${adjustment.kind}`,
      },
      {
        accountId: extra ? expenseAccountId : payableAccountId,
        amount: `-${extra ? unsigned : amount}`,
        memo: `Carrier adjustment ${adjustment.kind}`,
      },
    ],
  });
  if (!entryId) throw new Error("billing adjustment was not posted");
  // A zero-row update is a failure: the adjustment is locked above.
  const flipped = await tx.execute<{ id: string }>(sql`
    update shipping_adjustments
       set status = 'posted', entry_id = ${entryId}, updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${adjustment.id} and status = 'pending' returning id`);
  if (flipped.rows.length === 0) throw new Error("billing adjustment was not marked posted");
  await writeLabelAudit(tx, orgId, actorId, adjustment.label_id, "update", {
    mode: "shipping_adjustment_post",
    adjustmentId: adjustment.id,
    entryId,
  });
  return { adjustmentId: adjustment.id, entryId };
}

// --- Address validation ---------------------------------------------------------

/**
 * Validate the shipment's ship-to address against the provider and return
 * suggestions. A suggestion is never applied silently — the operator keeps
 * the address they entered until they choose otherwise.
 */
export async function validateShipmentAddress(
  tx: Tx,
  orgId: string,
  input: {
    shipmentId: string;
    accountId?: string | null;
    allowedSubsidiaryIds: Scope;
    transport?: typeof fetch;
    baseUrl?: string;
  },
): Promise<{ valid: boolean; messages: string[] }> {
  await assertShippingFeature(tx, orgId);
  const shipment = await lockShipmentForRating(tx, orgId, input.shipmentId, input.allowedSubsidiaryIds);
  const account = await loadShippingAccount(tx, orgId, input.accountId);
  const adapter = adapterFor(account.provider);
  const shipTo = toCarrierAddress(
    shipment.shipToRaw,
    `Shipment ${shipment.documentNumber} has no ship-to address`,
    `Enter the ship-to address on ${shipment.documentNumber}`,
  );
  let answer;
  try {
    answer = await adapter.validateAddress(
      { apiKey: account.apiKey, baseUrl: input.baseUrl, transport: input.transport },
      shipTo,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "CarrierError") {
      throw new ShippingRefusal(`${account.name} address check failed: ${error.message}`, "provider_failed", 422, error.message);
    }
    throw error;
  }
  return { valid: answer.valid, messages: answer.messages };
}

// --- Reporting --------------------------------------------------------------------

export interface CarrierAdjustmentRow {
  carrier: string;
  kind: string;
  adjustments: number;
  amountMinor: string;
  currency: string;
}

/**
 * Carrier billing adjustments by carrier and reason, over live ledger lines
 * only (posted and reversed), on the primary posting book — the first
 * version of the carrier invoice audit.
 */
export async function listAdjustmentsByCarrier(
  runner: SqlExecutor,
  orgId: string,
  input: { from: string; to: string },
): Promise<CarrierAdjustmentRow[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from) || !/^\d{4}-\d{2}-\d{2}$/.test(input.to)) {
    throw new ShippingRefusal("Report dates must be YYYY-MM-DD", "invalid_input", 422);
  }
  const book = (await runner.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary and is_active and posts_gl
     limit 1`)).rows[0];
  if (!book) throw new ShippingRefusal("No active primary posting book", "invalid_input", 422);
  const rows = (await runner.execute<{
    carrier: string; kind: string; adjustments: string; amount_minor: string; currency: string;
  }>(sql`
    select l.carrier, a.kind, count(*)::text as adjustments,
           coalesce(sum(a.amount_minor), 0)::text as amount_minor, a.currency
      from shipping_adjustments a
      join shipment_labels l on l.id = a.label_id and l.org_id = a.org_id
      join journal_entries je on je.id = a.entry_id and je.org_id = a.org_id
     where a.org_id = ${orgId} and a.status = 'posted'
       and je.book_id = ${book.id} and je.status in ('posted', 'reversed')
       and je.posting_date >= ${input.from}::date and je.posting_date <= ${input.to}::date
     group by l.carrier, a.kind, a.currency
     order by l.carrier, a.kind`)).rows;
  return rows.map((row) => ({
    carrier: row.carrier,
    kind: row.kind,
    adjustments: Number(row.adjustments),
    amountMinor: row.amount_minor,
    currency: row.currency,
  }));
}

export interface BulkCandidate {
  shipmentId: string;
  documentNumber: string;
  customerName: string | null;
  promisedDate: string | null;
  labelCount: number;
}

/** Draft, open shipments the bulk buyer can pick from. */
export async function listBulkCandidates(
  runner: SqlExecutor,
  orgId: string,
  scope: Scope,
): Promise<BulkCandidate[]> {
  await assertShippingFeature(runner, orgId);
  type CandidateRow = {
    shipment_id: string; document_number: string; customer_name: string | null;
    promised_date: string | null; label_count: string;
  };
  const base = sql`
    select d.id as shipment_id, d.document_number, p.display_name as customer_name,
           fd.promised_date::text, count(l.id)::text as label_count
      from documents d
      join fulfillment_documents fd on fd.document_id = d.id and fd.org_id = d.org_id
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join shipment_labels l on l.shipment_document_id = d.id and l.org_id = d.org_id
        and l.status = 'purchased'
     where d.org_id = ${orgId} and d.kind = 'shipment' and d.status = 'draft' and fd.stage = 'open'`;
  const tail = sql`
     group by d.id, d.document_number, p.display_name, fd.promised_date
     order by d.document_number`;
  const rows = scope
    ? (await runner.execute<CandidateRow>(sql`${base} and d.subsidiary_id = any(${[...scope]}) ${tail}`)).rows
    : (await runner.execute<CandidateRow>(sql`${base} ${tail}`)).rows;
  return rows
    .filter((row) => row.label_count === "0")
    .map((row) => ({
      shipmentId: row.shipment_id,
      documentNumber: row.document_number,
      customerName: row.customer_name,
      promisedDate: row.promised_date,
      labelCount: Number(row.label_count),
    }));
}

// --- Drawer and download reads --------------------------------------------------

export interface ShipmentLabelView {
  id: string;
  accountName: string;
  provider: string;
  carrier: string;
  service: string;
  trackingNumber: string | null;
  trackingStatus: string;
  status: string;
  amountMinor: string;
  currency: string;
  labelUrl: string | null;
  hasFile: boolean;
  costEntryId: string | null;
  purchasedAt: string;
  voidedAt: string | null;
  events: { id: string | null; status: string; detail: string | null; occurredAt: string | null }[];
}

/** Every label on a shipment, newest first, for the drawer timeline. */
export async function getShipmentLabels(
  runner: SqlExecutor,
  orgId: string,
  shipmentId: string,
): Promise<ShipmentLabelView[]> {
  await assertShippingFeature(runner, orgId);
  const rows = (await runner.execute<{
    id: string; account_name: string; provider: string; carrier: string; service: string;
    tracking_number: string | null; tracking_status: string; status: string;
    rate_minor: string; rate_currency: string; label_url: string | null; label_file_id: string | null;
    cost_entry_id: string | null; purchased_at: string; voided_at: string | null;
    events: ShipmentLabelView["events"];
  }>(sql`
    select l.id, a.name as account_name, l.provider, l.carrier, l.service,
           l.tracking_number, l.tracking_status, l.status,
           l.rate_minor::text, l.rate_currency, l.label_url,
           l.label_file_id, l.cost_entry_id,
           l.purchased_at::text, l.voided_at::text, l.events
      from shipment_labels l
      join shipping_accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${orgId} and l.shipment_document_id = ${shipmentId}
     order by l.purchased_at desc`)).rows;
  return rows.map((row) => ({
    id: row.id,
    accountName: row.account_name,
    provider: row.provider,
    carrier: row.carrier,
    service: row.service,
    trackingNumber: row.tracking_number,
    trackingStatus: row.tracking_status,
    status: row.status,
    amountMinor: row.rate_minor,
    currency: row.rate_currency,
    labelUrl: row.label_url,
    hasFile: row.label_file_id != null,
    costEntryId: row.cost_entry_id,
    purchasedAt: row.purchased_at,
    voidedAt: row.voided_at,
    events: row.events ?? [],
  }));
}

export interface LabelFile {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/**
 * The stored label PDF for download. Labels bought while the provider file
 * was unreachable have no file — the caller falls back to the provider
 * label URL instead of failing the download.
 */
export async function readLabelFile(
  runner: SqlExecutor,
  orgId: string,
  labelId: string,
): Promise<LabelFile> {
  await assertShippingFeature(runner, orgId);
  const row = (await runner.execute<{
    filename: string; content_type: string; bytes: Buffer; document_number: string;
  }>(sql`
    select f.name as filename, v.content_type, b.bytes, d.document_number
      from shipment_labels l
      join files f on f.id = l.label_file_id and f.org_id = l.org_id
      join file_versions v on v.id = f.current_version_id
      join file_blobs b on b.version_id = v.id
      join documents d on d.id = l.shipment_document_id and d.org_id = l.org_id
     where l.org_id = ${orgId} and l.id = ${labelId}`)).rows[0];
  if (!row) throw new ShippingRefusal("Shipping label file not found", "not_found", 404);
  return { filename: row.filename, contentType: row.content_type, bytes: row.bytes };
}
