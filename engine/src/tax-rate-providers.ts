import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, fromUnits, mul, mulRatio, toUnits } from "./money.ts";
import { sealJson, unsealJson } from "./secrets.ts";
import { assertNotSandbox } from "./sandbox/guard.ts";

/**
 * External sales-tax rate providers. Quotes are persisted as immutable evidence;
 * document posting still uses tax_code component tables (or a synthetic component
 * built from the quote). Avalara/TaxJar call outs are real HTTP when secrets
 * are configured; `manual` and dry-run quotes use explicit rate components.
 */

export type TaxRateProviderKey = "avalara" | "taxjar" | "custom_http" | "manual";

export class TaxRateProviderError extends Error {}

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
}

export interface TaxQuoteRequest {
  taxableAmount: string;
  currency?: string | null;
  shipFrom: Address;
  shipTo: Address;
  /** Optional line item code for reduced/zero bands. */
  itemCode?: string | null;
  quotedOn?: string;
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
};

const CONFIG_COLS = sql`
  id, org_id as "orgId", provider, display_name as "displayName", is_enabled as "isEnabled",
  settings, secrets, prefer_provider as "preferProvider",
  last_attempt_at as "lastAttemptAt", last_success_at as "lastSuccessAt", last_error as "lastError"`;

export async function readTaxRateProviderConfig(orgId: string): Promise<TaxRateProviderConfigRow | null> {
  const r = (await db.execute<TaxRateProviderConfigRow>(sql`
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

export async function saveTaxRateProviderConfig(
  orgId: string,
  input: SaveTaxRateProviderInput,
  actorId: string | null,
): Promise<void> {
  const existing = await readTaxRateProviderConfig(orgId);
  let secrets: string | null | undefined = undefined;
  if (input.apiKey !== undefined || input.accountId !== undefined || input.licenseKey !== undefined) {
    const prev = existing?.secrets ? ((await unsealJson(existing.secrets)) as Record<string, string>) : {};
    const next: Record<string, string> = { ...prev };
    if (input.apiKey === null) delete next.apiKey;
    else if (typeof input.apiKey === "string" && input.apiKey) next.apiKey = input.apiKey;
    if (input.accountId === null) delete next.accountId;
    else if (typeof input.accountId === "string" && input.accountId) next.accountId = input.accountId;
    if (input.licenseKey === null) delete next.licenseKey;
    else if (typeof input.licenseKey === "string" && input.licenseKey) next.licenseKey = input.licenseKey;
    secrets = Object.keys(next).length ? await sealJson(next) : null;
  }

  const displayName =
    input.displayName?.trim() ||
    ({ avalara: "Avalara AvaTax", taxjar: "TaxJar", custom_http: "Custom tax HTTP", manual: "Manual rates" } as const)[
      input.provider
    ];

  if (existing) {
    await db.execute(sql`
      update tax_rate_provider_configs set
        provider = ${input.provider},
        display_name = ${displayName},
        is_enabled = ${input.isEnabled},
        prefer_provider = ${input.preferProvider ?? true},
        settings = ${JSON.stringify(input.settings ?? existing.settings)}::jsonb,
        secrets = coalesce(${secrets === undefined ? null : secrets}, secrets),
        updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId}
    `);
    if (secrets === null) {
      await db.execute(sql`update tax_rate_provider_configs set secrets = null where org_id = ${orgId}`);
    } else if (typeof secrets === "string") {
      await db.execute(sql`update tax_rate_provider_configs set secrets = ${secrets} where org_id = ${orgId}`);
    }
  } else {
    const sealed =
      secrets === undefined
        ? null
        : secrets;
    await db.execute(sql`
      insert into tax_rate_provider_configs
        (org_id, provider, display_name, is_enabled, settings, secrets, prefer_provider, created_by, updated_by)
      values (${orgId}, ${input.provider}, ${displayName}, ${input.isEnabled},
              ${JSON.stringify(input.settings ?? {})}::jsonb, ${sealed}, ${input.preferProvider ?? true},
              ${actorId}, ${actorId})
    `);
  }
}

/** Pure: aggregate component taxes with ledger scale. */
export function sumComponentTax(components: TaxComponentQuote[]): string {
  let t = 0n;
  for (const c of components) t += toUnits(c.taxAmount);
  return fromUnits(t);
}

/** Pure: build a single-component quote from a known rate percent. */
export function quoteFromRate(taxableAmount: string, ratePercent: number, jurisdiction: string, name?: string): TaxQuoteResult {
  const taxAmount = mulRatio(taxableAmount, BigInt(Math.round(ratePercent * 10_000)), 1_000_000n);
  const components: TaxComponentQuote[] = [
    {
      jurisdiction,
      ratePercent: ratePercent.toFixed(4),
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

async function quoteAvalara(row: TaxRateProviderConfigRow, req: TaxQuoteRequest): Promise<TaxQuoteResult> {
  await assertNotSandbox(row.orgId, "avalara tax quote");
  const secrets = await secretsOf(row);
  if (!secrets.accountId || !secrets.licenseKey) throw new TaxRateProviderError("Avalara accountId and licenseKey required");
  const companyCode = String(row.settings.companyCode ?? "DEFAULT");
  const body = {
    type: "SalesOrder",
    companyCode,
    date: req.quotedOn ?? new Date().toISOString().slice(0, 10),
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
        amount: Number(req.taxableAmount),
        taxCode: req.itemCode ?? undefined,
      },
    ],
  };
  const auth = Buffer.from(`${secrets.accountId}:${secrets.licenseKey}`).toString("base64");
  const base = String(row.settings.baseUrl ?? "https://rest.avatax.com");
  const res = await fetch(`${base}/api/v2/transactions/create`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new TaxRateProviderError(`Avalara ${res.status}: ${JSON.stringify(raw).slice(0, 400)}`);
  const totalTax = String((raw as { totalTax?: number }).totalTax ?? 0);
  const details = ((raw as { summary?: { jurisdictionType?: string; rate?: number; tax?: number; taxName?: string }[] }).summary ??
    []) as { jurisdictionType?: string; rate?: number; tax?: number; taxName?: string }[];
  const components: TaxComponentQuote[] = details.length
    ? details.map((d) => ({
        jurisdiction: d.jurisdictionType ?? "unknown",
        ratePercent: String(((d.rate ?? 0) * 100).toFixed(4)),
        taxAmount: fromUnits(toUnits(String(d.tax ?? 0))),
        taxName: d.taxName,
      }))
    : [
        {
          jurisdiction: req.shipTo.region ?? "US",
          ratePercent: "0",
          taxAmount: fromUnits(toUnits(totalTax)),
        },
      ];
  return {
    taxAmount: fromUnits(toUnits(totalTax)),
    components,
    externalRef: String((raw as { code?: string }).code ?? (raw as { id?: string }).id ?? ""),
    raw,
    provider: "avalara",
  };
}

async function quoteTaxJar(row: TaxRateProviderConfigRow, req: TaxQuoteRequest): Promise<TaxQuoteResult> {
  await assertNotSandbox(row.orgId, "taxjar tax quote");
  const secrets = await secretsOf(row);
  if (!secrets.apiKey) throw new TaxRateProviderError("TaxJar apiKey required");
  const body = {
    from_country: req.shipFrom.country ?? req.shipTo.country ?? "US",
    from_zip: req.shipFrom.postalCode ?? req.shipTo.postalCode,
    from_state: req.shipFrom.region ?? req.shipTo.region,
    to_country: req.shipTo.country ?? "US",
    to_zip: req.shipTo.postalCode,
    to_state: req.shipTo.region,
    to_city: req.shipTo.city,
    amount: Number(req.taxableAmount),
    shipping: 0,
  };
  const base = String(row.settings.baseUrl ?? "https://api.taxjar.com");
  const res = await fetch(`${base}/v2/taxes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secrets.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new TaxRateProviderError(`TaxJar ${res.status}: ${JSON.stringify(raw).slice(0, 400)}`);
  const tax = (raw as { tax?: Record<string, unknown> }).tax ?? {};
  const amountToCollect = String(tax.amount_to_collect ?? 0);
  const rate = Number(tax.rate ?? 0) * 100;
  const breakdown = (tax.breakdown as Record<string, number> | undefined) ?? {};
  const components: TaxComponentQuote[] = [];
  for (const [k, v] of Object.entries(breakdown)) {
    if (typeof v === "number" && k.endsWith("_tax_collectable")) {
      components.push({
        jurisdiction: k.replace(/_tax_collectable$/, ""),
        ratePercent: rate.toFixed(4),
        taxAmount: fromUnits(toUnits(String(v))),
      });
    }
  }
  if (!components.length) {
    components.push({
      jurisdiction: req.shipTo.region ?? "US",
      ratePercent: rate.toFixed(4),
      taxAmount: fromUnits(toUnits(amountToCollect)),
    });
  }
  return {
    taxAmount: fromUnits(toUnits(amountToCollect)),
    components,
    externalRef: null,
    raw,
    provider: "taxjar",
  };
}

async function quoteCustomHttp(row: TaxRateProviderConfigRow, req: TaxQuoteRequest): Promise<TaxQuoteResult> {
  await assertNotSandbox(row.orgId, "custom tax quote");
  const url = String(row.settings.quoteUrl ?? "");
  if (!url) throw new TaxRateProviderError("custom_http requires settings.quoteUrl");
  const secrets = await secretsOf(row);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secrets.apiKey ? { Authorization: `Bearer ${secrets.apiKey}` } : {}),
    },
    body: JSON.stringify(req),
  });
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new TaxRateProviderError(`custom tax hook ${res.status}`);
  const taxAmount = fromUnits(toUnits(String(raw.taxAmount ?? "0")));
  const components = (Array.isArray(raw.components) ? raw.components : []) as TaxComponentQuote[];
  return {
    taxAmount: components.length ? sumComponentTax(components) : taxAmount,
    components,
    externalRef: raw.externalRef ? String(raw.externalRef) : null,
    raw,
    provider: "custom_http",
  };
}

/**
 * Resolve a tax quote for the org's configured provider. Manual provider uses
 * settings.defaultRatePercent or a matching tax_code headline rate.
 */
export async function quoteExternalTax(
  orgId: string,
  req: TaxQuoteRequest,
  actorId: string | null = null,
): Promise<TaxQuoteResult & { quoteId: string | null }> {
  const cfg = await readTaxRateProviderConfig(orgId);
  if (!cfg || !cfg.isEnabled) {
    throw new TaxRateProviderError("no enabled tax rate provider");
  }
  await db.execute(sql`
    update tax_rate_provider_configs set last_attempt_at = now(), last_error = null where id = ${cfg.id}
  `);
  try {
    let result: TaxQuoteResult;
    if (cfg.provider === "avalara") result = await quoteAvalara(cfg, req);
    else if (cfg.provider === "taxjar") result = await quoteTaxJar(cfg, req);
    else if (cfg.provider === "custom_http") result = await quoteCustomHttp(cfg, req);
    else {
      const rate = Number(cfg.settings.defaultRatePercent ?? 0);
      result = quoteFromRate(req.taxableAmount, rate, req.shipTo.region ?? req.shipTo.country ?? "LOCAL");
    }

    const quotedOn = req.quotedOn ?? new Date().toISOString().slice(0, 10);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into tax_rate_quotes
        (org_id, provider_config_id, provider, quoted_on, currency, ship_from, ship_to,
         taxable_amount, tax_amount, components, external_ref, raw_payload, created_by, updated_by)
      values (${orgId}, ${cfg.id}, ${result.provider}, ${quotedOn}, ${req.currency ?? null},
              ${JSON.stringify(req.shipFrom)}::jsonb, ${JSON.stringify(req.shipTo)}::jsonb,
              ${req.taxableAmount}, ${result.taxAmount}, ${JSON.stringify(result.components)}::jsonb,
              ${result.externalRef}, ${result.raw ? JSON.stringify(result.raw) : null}::jsonb,
              ${actorId}, ${actorId})
      returning id
    `));

    await db.execute(sql`
      update tax_rate_provider_configs set last_success_at = now(), last_error = null where id = ${cfg.id}
    `);
    return { ...result, quoteId: inserted.rows[0]?.id ?? null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.execute(sql`
      update tax_rate_provider_configs set last_error = ${message} where id = ${cfg.id}
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
        values (${orgId}, ${codeId}, ${b.ratePercent}, '2000-01-01', ${actorId}, ${actorId})
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
            values (${orgId}, ${id}, ${b.ratePercent}, '2000-01-01', ${actorId}, ${actorId})
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
    `);
  }
  return { bandsCreated };
}

// silence unused import if add not used firefoxman's souls
void add;
void mul;
