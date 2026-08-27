import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "./db.ts";
import { add, fromUnits, mul, mulRatio, normalizeDecimal, normalizeMoney, toUnits } from "./money.ts";
import { sealJson, unsealJson } from "./secrets.ts";
import { assertNotSandbox } from "./sandbox/guard.ts";
import { businessToday } from "./business-date.ts";
import { canonicalDecimal } from "./exact-decimal.ts";

/**
 * External sales-tax rate providers. Quotes are persisted as immutable evidence;
 * document posting still uses tax_code component tables (or a synthetic component
 * built from the quote). Avalara/TaxJar call outs are real HTTP when secrets
 * are configured; `manual` and dry-run quotes use explicit rate components.
 */

export type TaxRateProviderKey = "avalara" | "taxjar" | "custom_http" | "manual";

export class TaxRateProviderError extends Error {}

function persistRatePercent(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new TaxRateProviderError("rate percent must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new TaxRateProviderError("rate percent must be an exact decimal");
  }
}

export interface Address {
  line1?: string | null;
  city?: string | null;
  region?: string | null; // state / province
  postalCode?: string | null;
  country?: string | null; // ISO-2
}

export interface TaxComponentQuote {
  jurisdiction: string;
  ratePercent: string;
  taxAmount: string;
  taxName?: string;
  /** True when no jurisdiction-specific rate came back and the blended rate was stamped instead. */
  rateIsBlendedFallback?: boolean;
}

export interface TaxQuoteRequest {
  taxableAmount: string;
  currency?: string | null;
  shipFrom: Address;
  shipTo: Address;
  /** Optional line item code for reduced/zero bands. */
  itemCode?: string | null;
  quotedOn?: string;
  /** Optional immutable document-line provenance for persisted quotes. */
  documentLineId?: string | null;
}

export interface TaxQuoteResult {
  taxAmount: string;
  components: TaxComponentQuote[];
  externalRef: string | null;
  raw: Record<string, unknown> | null;
  provider: TaxRateProviderKey;
}

export type TaxRateProviderConfigRow = {
  id: string;
  orgId: string;
  provider: TaxRateProviderKey;
  displayName: string;
  isEnabled: boolean;
  settings: Record<string, unknown>;
  secrets: string | null;
  preferProvider: boolean;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  /**
   * Exact write revision — `updated_at` serialized with microsecond precision
   * so a caller can pass it back as `expectedUpdatedAt` for optimistic
   * concurrency without a float/truncation mismatch.
   */
  updatedAt: string | null;
};

const CONFIG_COLS = sql`
  id, org_id as "orgId", provider, display_name as "displayName", is_enabled as "isEnabled",
  settings, secrets, prefer_provider as "preferProvider",
  last_attempt_at as "lastAttemptAt", last_success_at as "lastSuccessAt", last_error as "lastError",
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"`;

export async function readTaxRateProviderConfig(
  orgId: string,
  runner: Pick<typeof db, "execute"> = db,
): Promise<TaxRateProviderConfigRow | null> {
  const r = (await runner.execute<TaxRateProviderConfigRow>(sql`
    select ${CONFIG_COLS} from tax_rate_provider_configs where org_id = ${orgId} limit 1
  `));
  return r.rows[0] ?? null;
}

export async function readTaxRateProviderConfigView(orgId: string) {
  const row = await readTaxRateProviderConfig(orgId);
  if (!row) return null;
  const { secrets, ...safe } = row;
  return { ...safe, hasSecret: Boolean(secrets) };
}

export interface SaveTaxRateProviderInput {
  provider: TaxRateProviderKey;
  displayName?: string;
  isEnabled: boolean;
  preferProvider?: boolean;
  settings?: Record<string, unknown>;
  /** undefined keeps, null clears, string replaces. */
  apiKey?: string | null;
  accountId?: string | null;
  licenseKey?: string | null;
}

function persistableTaxProviderSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  if (!("defaultRatePercent" in settings) || settings.defaultRatePercent == null || settings.defaultRatePercent === "") {
    return settings;
  }
  try {
    const rate = normalizeDecimal(settings.defaultRatePercent as string | number, 4);
    if (rate.startsWith("-")) {
      throw new TaxRateProviderError("settings.defaultRatePercent cannot be negative");
    }
    return { ...settings, defaultRatePercent: rate };
  } catch (error) {
    if (error instanceof TaxRateProviderError) throw error;
    throw new TaxRateProviderError("settings.defaultRatePercent must be a finite non-negative decimal");
  }
}

export interface SaveTaxRateProviderOptions {
  /**
   * Optimistic-concurrency token: the `updatedAt` revision the caller read
   * before editing. If another administrator committed a write since then, the
   * save is rejected instead of silently overwriting their change. `null`
   * asserts the config does not exist yet. Omitted → transactional row
   * serialization alone guards the write.
   */
  expectedUpdatedAt?: string | null;
  /** Why the change was made, recorded verbatim in the audit evidence. */
  reason?: string | null;
}

/** Non-secret audit shape: field values plus which credential KEYS changed — never their values. */
interface TaxProviderConfigAuditState {
  provider: TaxRateProviderKey;
  displayName: string;
  isEnabled: boolean;
  preferProvider: boolean;
  settings: Record<string, unknown>;
  hasSecret: boolean;
  revision: string | null;
  secretKeys?: string[];
  secretChange?: { added: string[]; removed: string[] };
}

export async function saveTaxRateProviderConfig(
  orgId: string,
  input: SaveTaxRateProviderInput,
  actorId: string | null,
  options: SaveTaxRateProviderOptions = {},
): Promise<string> {
  return withOrgTransaction(orgId, async () => {
    // One locked, versioned unit: the row lock is held to commit, so a
    // competing administrator save either merges against this write or waits
    // for it — concurrent edits can never silently overwrite each other, and
    // the config row, its sealed secret, and the audit evidence commit or roll
    // back together.
    const locked = (await db.execute<TaxRateProviderConfigRow>(sql`
      select ${CONFIG_COLS} from tax_rate_provider_configs where org_id = ${orgId} for update
    `));
    const existing = locked.rows[0] ?? null;

    if (options.expectedUpdatedAt !== undefined) {
      const expected = options.expectedUpdatedAt ?? null;
      const current = existing?.updatedAt ?? null;
      if (current !== expected) {
        throw new TaxRateProviderError(
          existing
            ? "tax provider config was modified concurrently — reload it and retry"
            : "tax provider config does not exist at the expected revision — reload and retry",
        );
      }
    }

    let previousSecretKeys: string[] | null = null;
    let nextSecretKeys: string[] | null = null;
    let secretChange: TaxProviderConfigAuditState["secretChange"];
    let sealedSecrets: string | null = existing?.secrets ?? null;
    if (input.apiKey !== undefined || input.accountId !== undefined || input.licenseKey !== undefined) {
      const prev = existing?.secrets ? ((await unsealJson(existing.secrets)) as Record<string, string>) : {};
      previousSecretKeys = Object.keys(prev).sort();
      const next: Record<string, string> = { ...prev };
      if (input.apiKey === null) delete next.apiKey;
      else if (typeof input.apiKey === "string" && input.apiKey) next.apiKey = input.apiKey;
      if (input.accountId === null) delete next.accountId;
      else if (typeof input.accountId === "string" && input.accountId) next.accountId = input.accountId;
      if (input.licenseKey === null) delete next.licenseKey;
      else if (typeof input.licenseKey === "string" && input.licenseKey) next.licenseKey = input.licenseKey;
      nextSecretKeys = Object.keys(next).sort();
      secretChange = {
        added: nextSecretKeys.filter((k) => !(k in prev)).sort(),
        removed: previousSecretKeys.filter((k) => !(k in next)).sort(),
      };
      sealedSecrets = nextSecretKeys.length ? await sealJson(next) : null;
    }

    const displayName =
      input.displayName?.trim() ||
      ({ avalara: "Avalara AvaTax", taxjar: "TaxJar", custom_http: "Custom tax HTTP", manual: "Manual rates" } as const)[
        input.provider
      ];
    const settings = persistableTaxProviderSettings(input.settings ?? existing?.settings ?? {});

    const before: TaxProviderConfigAuditState | null = existing
      ? {
          provider: existing.provider,
          displayName: existing.displayName,
          isEnabled: existing.isEnabled,
          preferProvider: existing.preferProvider,
          settings: existing.settings,
          hasSecret: Boolean(existing.secrets),
          revision: existing.updatedAt,
          ...(previousSecretKeys ? { secretKeys: previousSecretKeys } : {}),
        }
      : null;

    let configId: string;
    let afterRevision: string;
    if (existing) {
      // Single statement: general config and the sealed secret move together,
      // so a clear can never be half-applied by a failure between two writes.
      const updated = (await db.execute<{ updatedAt: string }>(sql`
        update tax_rate_provider_configs set
          provider = ${input.provider},
          display_name = ${displayName},
          is_enabled = ${input.isEnabled},
          prefer_provider = ${input.preferProvider ?? true},
          settings = ${JSON.stringify(settings)}::jsonb,
          secrets = ${sealedSecrets},
          updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId}
        returning id,
                  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
      `));
      if (!updated.rows[0]) throw new TaxRateProviderError("tax provider config row vanished while saving");
      configId = existing.id;
      afterRevision = updated.rows[0].updatedAt;
    } else {
      const inserted = (await db.execute<{ id: string; updatedAt: string }>(sql`
        insert into tax_rate_provider_configs
          (org_id, provider, display_name, is_enabled, settings, secrets, prefer_provider, created_by, updated_by)
        values (${orgId}, ${input.provider}, ${displayName}, ${input.isEnabled},
                ${JSON.stringify(settings)}::jsonb, ${sealedSecrets}, ${input.preferProvider ?? true},
                ${actorId}, ${actorId})
        returning id, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
      `));
      configId = inserted.rows[0]!.id;
      afterRevision = inserted.rows[0]!.updatedAt;
    }

    const after: TaxProviderConfigAuditState = {
      provider: input.provider,
      displayName,
      isEnabled: input.isEnabled,
      preferProvider: input.preferProvider ?? true,
      settings,
      hasSecret: Boolean(sealedSecrets),
      revision: afterRevision,
      ...(secretChange ? { secretKeys: nextSecretKeys ?? [], secretChange } : {}),
    };

    // Attributable, redacted evidence in the SAME transaction as the write: a
    // forced audit failure rolls the configuration change back with it.
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'tax_rate_provider_configs', ${configId}, ${existing ? "update" : "insert"},
              ${JSON.stringify({
                reason: options.reason ?? null,
                before,
                after,
              })}::jsonb,
              ${actorId})
    `);
    return afterRevision;
  });
}

/** Pure: aggregate component taxes with ledger scale. */
export function sumComponentTax(components: TaxComponentQuote[]): string {
  let t = 0n;
  for (const c of components) t += toUnits(c.taxAmount);
  return fromUnits(t);
}

/**
 * Provider wire formats are JSON numbers, so an outbound ledger amount must
 * survive the Number() round trip unchanged: String(n) is JS's shortest
 * round-trip representation, so equality here proves the float carries the
 * exact four-decimal value. Anything else is refused rather than misstated.
 */
function wireAmountOrThrow(amount: string): number {
  const canonical = normalizeMoney(amount);
  const wire = Number(canonical);
  if (!Number.isFinite(wire) || fromUnits(toUnits(String(wire))) !== canonical) {
    throw new TaxRateProviderError(`provider wire format cannot represent ${canonical} exactly`);
  }
  return wire;
}

/**
 * Inbound provider amounts may be JSON numbers or decimal strings; either way
 * they parse through String() → toUnits so no arithmetic crosses a float.
 * Responses finer than the ledger's 4dp scale fail closed instead of being
 * silently rounded into posted calculation evidence.
 */
function providerMoney(value: unknown, field: string): string {
  if (value == null) return "0.0000";
  try {
    return fromUnits(toUnits(String(value)));
  } catch (e) {
    throw new TaxRateProviderError(
      `provider ${field} ${String(value)} is not a ledger-scale amount (${(e as Error).message})`,
    );
  }
}

/**
 * Providers report rates as decimal FRACTIONS of one (0.0825 = 8.25%). Shift
 * the decimal point two places on the exact string form — never rate*100 float
 * math — and fail closed beyond the 4dp percent scale.
 */
function percentFromRateFraction(value: unknown): string {
  if (value == null) return "0.0000";
  const raw = String(value).trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(raw)) {
    throw new TaxRateProviderError(`provider returned a non-decimal rate: "${raw}"`);
  }
  const negative = raw.startsWith("-");
  const [whole = "0", fraction = ""] = raw.replace(/^[-+]/, "").split(".");
  const fracPadded = fraction.padEnd(2, "0");
  const shiftedWhole = `${whole || "0"}${fracPadded.slice(0, 2)}`;
  const shiftedFrac = fracPadded.slice(2);
  if (shiftedFrac.length > 4 && /[1-9]/.test(shiftedFrac.slice(4))) {
    throw new TaxRateProviderError(`provider rate ${raw} exceeds the 4-decimal percent scale`);
  }
  const percent = `${shiftedWhole.replace(/^0+(?=\d)/, "")}.${shiftedFrac.padEnd(4, "0")}`;
  return negative ? `-${percent}` : percent;
}

/**
 * Pure: build a single-component quote from a known rate percent.
 *
 * The percent crosses as its exact decimal STRING: the ratio numerator is
 * derived by digit surgery on that string (strip '.', pad to 4dp) instead of
 * `Math.round(rate * 10_000)`, which crosses JavaScript floats. JSON-number
 * inputs arrive via String(n) — JS's shortest round-trip representation — so
 * the boundary neither invents nor loses digits.
 */
export function quoteFromRate(
  taxableAmount: string,
  ratePercent: string | number,
  jurisdiction: string,
  name?: string,
): TaxQuoteResult {
  const percentText = normalizeDecimal(ratePercent, 4);
  const [whole = "0", fraction = ""] = percentText.split(".");
  const numerator = BigInt(`${whole}${fraction}`);
  if (numerator < 0n) throw new TaxRateProviderError("tax rate cannot be negative");
  const taxAmount = mulRatio(taxableAmount, numerator, 1_000_000n);
  const components: TaxComponentQuote[] = [
    {
      jurisdiction,
      ratePercent: percentText,
      taxAmount,
      taxName: name ?? jurisdiction,
    },
  ];
  return { taxAmount, components, externalRef: null, raw: null, provider: "manual" };
}

async function secretsOf(row: TaxRateProviderConfigRow): Promise<Record<string, string>> {
  if (!row.secrets) return {};
  return (await unsealJson(row.secrets)) as Record<string, string>;
}

/**
 * Tax provider credentials must never cross an HTTP redirect boundary. Even a
 * trusted provider origin can answer a quote POST with a 3xx, and fetch would
 * then replay the `Authorization` header — the Avalara account's license key,
 * the TaxJar API key, or the custom hook's bearer secret — to whichever host
 * the Location names. Every credential-bearing tax call goes through here so
 * a redirect fails closed instead of leaking.
 */
function taxProviderFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, redirect: "error" });
}

export interface AvalaraQuoteConfig {
  accountId: string;
  licenseKey: string;
  baseUrl?: string;
  companyCode?: string;
  /** Resolved quoting date; the wire layer stays free of org-calendar lookups. */
  quotedOn: string;
}

/** Wire-level Avalara quote: basic-auth accountId:licenseKey create-transaction. */
export async function quoteViaAvalara(
  req: TaxQuoteRequest,
  config: AvalaraQuoteConfig,
): Promise<TaxQuoteResult> {
  const body = {
    type: "SalesOrder",
    companyCode: String(config.companyCode ?? "DEFAULT"),
    date: config.quotedOn,
    customerCode: "OPENBOOKS",
    currencyCode: req.currency ?? "USD",
    addresses: {
      singleLocation: {
        line1: req.shipTo.line1 ?? undefined,
        city: req.shipTo.city ?? undefined,
        region: req.shipTo.region ?? undefined,
        postalCode: req.shipTo.postalCode ?? undefined,
        country: req.shipTo.country ?? "US",
      },
    },
    lines: [
      {
        number: "1",
        quantity: 1,
        amount: wireAmountOrThrow(req.taxableAmount),
        taxCode: req.itemCode ?? undefined,
      },
    ],
  };
  const auth = Buffer.from(`${config.accountId}:${config.licenseKey}`).toString("base64");
  const res = await taxProviderFetch(
    `${String(config.baseUrl ?? "https://rest.avatax.com")}/api/v2/transactions/create`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new TaxRateProviderError(`Avalara ${res.status}: ${JSON.stringify(raw).slice(0, 400)}`);
  const totalTax = providerMoney((raw as { totalTax?: number }).totalTax, "totalTax");
  const details = ((raw as { summary?: { jurisdictionType?: string; rate?: number; tax?: number; taxName?: string }[] }).summary ??
    []) as { jurisdictionType?: string; rate?: number; tax?: number; taxName?: string }[];
  const components: TaxComponentQuote[] = details.length
    ? details.map((d) => ({
        jurisdiction: d.jurisdictionType ?? "unknown",
        // Avalara reports the rate as a decimal fraction (0.065 = 6.5%); parse
        // it and the amounts on their exact string forms, never via float math.
        ratePercent: percentFromRateFraction(d.rate),
        taxAmount: providerMoney(d.tax, "summary.tax"),
        taxName: d.taxName,
      }))
    : [
        {
          jurisdiction: req.shipTo.region ?? "US",
          ratePercent: "0.0000",
          taxAmount: totalTax,
        },
      ];
  return {
    taxAmount: totalTax,
    components,
    externalRef: String((raw as { code?: string }).code ?? (raw as { id?: string }).id ?? ""),
    raw,
    provider: "avalara",
  };
}

async function quoteAvalara(row: TaxRateProviderConfigRow, req: TaxQuoteRequest): Promise<TaxQuoteResult> {
  await assertNotSandbox(row.orgId, "avalara tax quote");
  const secrets = await secretsOf(row);
  if (!secrets.accountId || !secrets.licenseKey) throw new TaxRateProviderError("Avalara accountId and licenseKey required");
  return quoteViaAvalara(req, {
    accountId: secrets.accountId,
    licenseKey: secrets.licenseKey,
    baseUrl: row.settings.baseUrl == null ? undefined : String(row.settings.baseUrl),
    companyCode: row.settings.companyCode == null ? undefined : String(row.settings.companyCode),
    quotedOn: req.quotedOn ?? (await businessToday(row.orgId)),
  });
}

/** Wire-level TaxJar quote: bearer API key, JSON v2/taxes. */
export async function quoteViaTaxJar(
  req: TaxQuoteRequest,
  config: { apiKey: string; baseUrl?: string },
): Promise<TaxQuoteResult> {
  const body = {
    from_country: req.shipFrom.country ?? req.shipTo.country ?? "US",
    from_zip: req.shipFrom.postalCode ?? req.shipTo.postalCode,
    from_state: req.shipFrom.region ?? req.shipTo.region,
    to_country: req.shipTo.country ?? "US",
    to_zip: req.shipTo.postalCode,
    to_state: req.shipTo.region,
    to_city: req.shipTo.city,
    amount: wireAmountOrThrow(req.taxableAmount),
    shipping: 0,
  };
  const res = await taxProviderFetch(`${String(config.baseUrl ?? "https://api.taxjar.com")}/v2/taxes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new TaxRateProviderError(`TaxJar ${res.status}: ${JSON.stringify(raw).slice(0, 400)}`);
  const tax = (raw as { tax?: Record<string, unknown> }).tax ?? {};
  const amountToCollect = providerMoney(tax.amount_to_collect, "amount_to_collect");
  // Blended combined rate; each jurisdiction's own rate takes precedence below.
  const blendedRate = percentFromRateFraction(tax.rate);
  const breakdown = (tax.breakdown as Record<string, unknown> | undefined) ?? {};
  const components: TaxComponentQuote[] = [];
  for (const [key, value] of Object.entries(breakdown)) {
    if (value == null || !key.endsWith("_tax_collectable")) continue;
    const jurisdiction = key.replace(/_tax_collectable$/, "");
    // TaxJar keys each jurisdiction's own rate `<j>_tax_rate` (special
    // districts use its `remitance` spelling). Fall back to the blended rate
    // only when the payload omits it, and flag that fact on the component.
    const ownRate = breakdown[`${jurisdiction}_tax_rate`] ?? breakdown[`${jurisdiction}_tax_remitance_rate`];
    components.push({
      jurisdiction,
      ratePercent: ownRate == null ? blendedRate : percentFromRateFraction(ownRate),
      taxAmount: providerMoney(value, `breakdown.${key}`),
      ...(ownRate == null ? { rateIsBlendedFallback: true } : {}),
    });
  }
  if (!components.length) {
    components.push({
      jurisdiction: req.shipTo.region ?? "US",
      ratePercent: blendedRate,
      taxAmount: amountToCollect,
    });
  }
  return {
    taxAmount: amountToCollect,
    components,
    externalRef: null,
    raw,
    provider: "taxjar",
  };
}

async function quoteTaxJar(row: TaxRateProviderConfigRow, req: TaxQuoteRequest): Promise<TaxQuoteResult> {
  await assertNotSandbox(row.orgId, "taxjar tax quote");
  const secrets = await secretsOf(row);
  if (!secrets.apiKey) throw new TaxRateProviderError("TaxJar apiKey required");
  return quoteViaTaxJar(req, {
    apiKey: secrets.apiKey,
    baseUrl: row.settings.baseUrl == null ? undefined : String(row.settings.baseUrl),
  });
}

/** Wire-level custom hook quote: optional bearer API key, JSON request echo. */
export async function quoteViaCustomHttp(
  req: TaxQuoteRequest,
  config: { url: string; apiKey?: string },
): Promise<TaxQuoteResult> {
  const wireRequest = { ...req };
  delete wireRequest.documentLineId;
  const res = await taxProviderFetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(wireRequest),
  });
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new TaxRateProviderError(`custom tax hook ${res.status}`);
  const components = (Array.isArray(raw.components) ? raw.components : []) as TaxComponentQuote[];
  const hasHeadline = raw.taxAmount !== undefined && raw.taxAmount !== null && raw.taxAmount !== "";
  if (!hasHeadline && components.length === 0) {
    throw new TaxRateProviderError("custom tax hook response must include taxAmount or components");
  }
  const taxAmount = hasHeadline ? fromUnits(toUnits(String(raw.taxAmount))) : sumComponentTax(components);
  if (components.length > 0 && toUnits(taxAmount) !== toUnits(sumComponentTax(components))) {
    throw new TaxRateProviderError("custom tax hook taxAmount does not match its components");
  }
  return {
    taxAmount,
    components,
    externalRef: raw.externalRef ? String(raw.externalRef) : null,
    raw,
    provider: "custom_http",
  };
}

async function quoteCustomHttp(row: TaxRateProviderConfigRow, req: TaxQuoteRequest): Promise<TaxQuoteResult> {
  await assertNotSandbox(row.orgId, "custom tax quote");
  const url = String(row.settings.quoteUrl ?? "");
  if (!url) throw new TaxRateProviderError("custom_http requires settings.quoteUrl");
  const secrets = await secretsOf(row);
  return quoteViaCustomHttp(req, { url, apiKey: secrets.apiKey || undefined });
}

/** Resolve the configured provider without mutating provider or quote rows. */
async function resolveConfiguredTax(
  _orgId: string,
  req: TaxQuoteRequest,
  cfg: TaxRateProviderConfigRow,
): Promise<TaxQuoteResult> {
  let result: TaxQuoteResult;
  if (cfg.provider === "avalara") result = await quoteAvalara(cfg, req);
  else if (cfg.provider === "taxjar") result = await quoteTaxJar(cfg, req);
  else if (cfg.provider === "custom_http") result = await quoteCustomHttp(cfg, req);
  else {
    // A missing default is NOT zero-rated: quoting would post statutory-looking
    // evidence at 0%. Only a profile that explicitly declares 0 stays legal.
    const configured = cfg.settings.defaultRatePercent;
    if (typeof configured !== "number" && typeof configured !== "string") {
      throw new TaxRateProviderError(
        "manual provider requires settings.defaultRatePercent; refusing to quote at an implied 0%",
      );
    }
    result = quoteFromRate(req.taxableAmount, configured, req.shipTo.region ?? req.shipTo.country ?? "LOCAL");
  }
  validateTaxQuoteResult(result, cfg.provider);
  return result;
}

function validateTaxQuoteResult(result: TaxQuoteResult, expectedProvider: TaxRateProviderKey): void {
  if (result.provider !== expectedProvider || !Array.isArray(result.components)) {
    throw new TaxRateProviderError("provider returned an ambiguous tax quote");
  }
  try {
    toUnits(result.taxAmount);
    for (const component of result.components) {
      if (!component || typeof component.jurisdiction !== "string" || component.jurisdiction.trim() === "") {
        throw new Error("component jurisdiction is missing");
      }
      if (toUnits(component.ratePercent) < 0n) throw new Error("component rate cannot be negative");
      toUnits(component.taxAmount);
    }
  } catch (error) {
    throw new TaxRateProviderError(
      `provider returned an invalid tax quote: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface PersistedTaxQuote {
  id: string;
  providerConfigId: string;
  provider: TaxRateProviderKey;
  quotedOn: string;
  currency: string | null;
  shipFrom: Address;
  shipTo: Address;
  taxableAmount: string;
  taxAmount: string;
  components: TaxComponentQuote[];
  externalRef: string | null;
  raw: Record<string, unknown> | null;
}

/** Read immutable provider evidence linked to a document line for retry/replay. */
export async function readTaxQuoteForDocumentLine(
  orgId: string,
  documentLineId: string,
  runner: Pick<typeof db, "execute"> = db,
): Promise<PersistedTaxQuote | null> {
  const result = await runner.execute<{
    id: string;
    provider_config_id: string;
    provider: TaxRateProviderKey;
    quoted_on: string;
    currency: string | null;
    ship_from: Address;
    ship_to: Address;
    taxable_amount: string;
    tax_amount: string;
    components: TaxComponentQuote[];
    external_ref: string | null;
    raw_payload: Record<string, unknown> | null;
  }>(sql`
    select id, provider_config_id, provider, quoted_on::text, currency,
           ship_from, ship_to, taxable_amount::text, tax_amount::text,
           components, external_ref, raw_payload
      from tax_rate_quotes
     where org_id = ${orgId} and document_line_id = ${documentLineId}
     order by created_at desc, id desc
     limit 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    providerConfigId: row.provider_config_id,
    provider: row.provider,
    quotedOn: row.quoted_on,
    currency: row.currency,
    shipFrom: row.ship_from,
    shipTo: row.ship_to,
    taxableAmount: String(row.taxable_amount),
    taxAmount: String(row.tax_amount),
    components: row.components,
    externalRef: row.external_ref,
    raw: row.raw_payload,
  };
}

/** Persist one provider result as immutable line-linked evidence. */
export async function persistTaxQuote(
  orgId: string,
  providerConfigId: string,
  req: TaxQuoteRequest,
  result: TaxQuoteResult,
  actorId: string | null,
  runner: Pick<typeof db, "execute"> = db,
): Promise<string> {
  const quotedOn = req.quotedOn ?? await businessToday(orgId);
  const inserted = await runner.execute<{ id: string }>(sql`
    insert into tax_rate_quotes
      (org_id, provider_config_id, provider, quoted_on, currency, ship_from, ship_to,
       taxable_amount, tax_amount, components, external_ref, raw_payload, document_line_id,
       created_by, updated_by)
    values (${orgId}, ${providerConfigId}, ${result.provider}, ${quotedOn}, ${req.currency ?? null},
            ${JSON.stringify(req.shipFrom)}::jsonb, ${JSON.stringify(req.shipTo)}::jsonb,
            ${req.taxableAmount}, ${result.taxAmount}, ${JSON.stringify(result.components)}::jsonb,
            ${result.externalRef}, ${result.raw ? JSON.stringify(result.raw) : null}::jsonb,
            ${req.documentLineId ?? null}, ${actorId}, ${actorId})
    returning id
  `);
  const id = inserted.rows[0]?.id;
  if (!id) throw new TaxRateProviderError("provider tax evidence insert returned no id");
  return id;
}

/**
 * Resolve a tax quote for the org's configured provider. Manual provider uses
 * settings.defaultRatePercent or a matching tax_code headline rate.
 */
export async function quoteExternalTax(
  orgId: string,
  req: TaxQuoteRequest,
  actorId: string | null = null,
  options: {
    /** Existing transaction, so quote/config evidence commits atomically with the document. */
    runner?: Pick<typeof db, "execute">;
    /** Resolve and validate the provider without writing quote/config evidence. */
    persist?: boolean;
    /** Provider row selected by the caller; avoids a config-change race between planning and quoting. */
    config?: TaxRateProviderConfigRow;
  } = {},
): Promise<TaxQuoteResult & { quoteId: string | null }> {
  const runner = options.runner ?? db;
  const cfg = options.config ?? await readTaxRateProviderConfig(orgId, runner);
  if (!cfg || !cfg.isEnabled) {
    throw new TaxRateProviderError("no enabled tax rate provider");
  }
  const persist = options.persist ?? true;
  if (!persist) {
    return {
      ...(await resolveConfiguredTax(orgId, req, cfg)),
      quoteId: null,
    };
  }
  await runner.execute(sql`
    update tax_rate_provider_configs set last_attempt_at = now(), last_error = null where id = ${cfg.id} and org_id = ${orgId}
  `);
  try {
    const result = await resolveConfiguredTax(orgId, req, cfg);

    const quoteId = await persistTaxQuote(orgId, cfg.id, req, result, actorId, runner);

    await runner.execute(sql`
      update tax_rate_provider_configs set last_success_at = now(), last_error = null where id = ${cfg.id} and org_id = ${orgId}
    `);
    return { ...result, quoteId };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await runner.execute(sql`
      update tax_rate_provider_configs set last_error = ${message} where id = ${cfg.id} and org_id = ${orgId}
    `);
    throw e;
  }
}

/**
 * Locale pack rate-band seeds used when provisioning depth packs (UK reduced/zero,
 * AU GST-free, CA HST combined rates, US placeholder for sealed provider).
 */
export const LOCALE_RATE_BANDS: Record<string, { code: string; name: string; ratePercent: number }[]> = {
  CA_GST34: [
    { code: "CA-GST", name: "GST 5%", ratePercent: 5 },
    { code: "CA-HST-ON", name: "Ontario HST 13%", ratePercent: 13 },
    { code: "CA-HST-NB", name: "New Brunswick HST 15%", ratePercent: 15 },
    { code: "CA-HST-NL", name: "Newfoundland and Labrador HST 15%", ratePercent: 15 },
    { code: "CA-HST-NS", name: "Nova Scotia HST 14%", ratePercent: 14 },
    { code: "CA-HST-PE", name: "Prince Edward Island HST 15%", ratePercent: 15 },
    { code: "CA-ZERO", name: "Zero-rated", ratePercent: 0 },
    { code: "CA-EXEMPT", name: "Exempt", ratePercent: 0 },
  ],
  GB_VAT100: [
    { code: "GB-VAT-STD", name: "VAT standard 20%", ratePercent: 20 },
    { code: "GB-VAT-RED", name: "VAT reduced 5%", ratePercent: 5 },
    { code: "GB-VAT-ZERO", name: "VAT zero-rated 0%", ratePercent: 0 },
    { code: "GB-VAT-EXEMPT", name: "VAT exempt", ratePercent: 0 },
  ],
  AU_BAS_GST: [
    { code: "AU-GST", name: "GST 10%", ratePercent: 10 },
    { code: "AU-GST-FREE", name: "GST-free", ratePercent: 0 },
    { code: "AU-INPUT-TAXED", name: "Input-taxed", ratePercent: 0 },
  ],
  US_SALES_TAX_WORKPAPER: [
    { code: "US-SALES", name: "US sales (provider or state pack)", ratePercent: 0 },
  ],
};

export const LOCALE_FILING_CHANNELS: Record<
  string,
  { channel: string; digitalSubmissionReady: boolean; notes: string }
> = {
  CA_GST34: {
    channel: "ca_cra_gst34",
    digitalSubmissionReady: false,
    notes: "CRA GST/HST NETFILE / GST34 workpaper; HST bands seed as separate codes under the federal return.",
  },
  GB_VAT100: {
    channel: "uk_mtd_vat",
    digitalSubmissionReady: true,
    notes: "VAT100 boxes map 1–9 for Making Tax Digital. Submit via compatible MTD software using efile_api channel.",
  },
  AU_BAS_GST: {
    channel: "au_bas_sbr",
    digitalSubmissionReady: true,
    notes: "BAS G1–G11 / 1A–1B labels for ATO Online or SBR-enabled software.",
  },
  US_SALES_TAX_WORKPAPER: {
    channel: "us_streamlined_or_provider",
    digitalSubmissionReady: false,
    notes: "Wire Avalara or TaxJar for destination rates; state return packs remain per-state workpapers.",
  },
};

/** Idempotently seed rate-band tax codes + locale meta after a pack install. */
export async function provisionLocaleDepth(
  orgId: string,
  packCode: string,
  country: string,
  actorId: string | null,
): Promise<{ bandsCreated: number }> {
  const bands = LOCALE_RATE_BANDS[packCode] ?? [];
  let bandsCreated = 0;
  for (const b of bands) {
    const ratePercent = persistRatePercent(b.ratePercent);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into tax_codes (org_id, code, name, country, applies_to, is_active, created_by, updated_by)
      select ${orgId}, ${b.code}, ${b.name}, ${country}, 'both', true, ${actorId}, ${actorId}
       where not exists (select 1 from tax_codes where org_id = ${orgId} and code = ${b.code})
      returning id
    `));
    const codeId = inserted.rows[0]?.id;
    if (codeId) {
      bandsCreated++;
      await db.execute(sql`
        insert into tax_rates (org_id, tax_code_id, rate_percent, effective_from, created_by, updated_by)
        values (${orgId}, ${codeId}, ${ratePercent}, '2000-01-01', ${actorId}, ${actorId})
      `);
    } else {
      const existing = (await db.execute<{ id: string }>(sql`
        select id from tax_codes where org_id = ${orgId} and code = ${b.code} limit 1
      `));
      const id = existing.rows[0]?.id;
      if (id) {
        const has = (await db.execute(sql`
          select 1 from tax_rates where org_id = ${orgId} and tax_code_id = ${id} limit 1
        `));
        if (!has.rows.length) {
          await db.execute(sql`
            insert into tax_rates (org_id, tax_code_id, rate_percent, effective_from, created_by, updated_by)
            values (${orgId}, ${id}, ${ratePercent}, '2000-01-01', ${actorId}, ${actorId})
          `);
        }
      }
    }
  }

  const filing = LOCALE_FILING_CHANNELS[packCode];
  if (filing) {
    await db.execute(sql`
      insert into tax_locale_pack_meta
        (org_id, pack_code, country, filing_channel, digital_submission_ready, rate_bands, notes, created_by, updated_by)
      values (${orgId}, ${packCode}, ${country}, ${filing.channel}, ${filing.digitalSubmissionReady},
              ${JSON.stringify(bands)}::jsonb, ${filing.notes}, ${actorId}, ${actorId})
      on conflict (org_id, pack_code) do update set
        filing_channel = excluded.filing_channel,
        digital_submission_ready = excluded.digital_submission_ready,
        rate_bands = excluded.rate_bands,
        notes = excluded.notes,
        updated_at = now(), updated_by = ${actorId}
      where tax_locale_pack_meta.org_id = ${orgId}
    `);
  }
  return { bandsCreated };
}

// silence unused import if add not used firefoxman's souls
void add;
void mul;
