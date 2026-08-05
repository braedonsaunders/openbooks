import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { sealJson, unsealJson } from "./secrets.ts";
import { assertNotSandbox } from "./sandbox/guard.ts";

export type FxProviderKey = "bank_of_canada" | "ecb" | "open_exchange_rates";
export type FxSyncSchedule = "manual" | "daily" | "weekdays" | "weekly";
export type FxRunTrigger = "test" | "manual" | "scheduler";

export interface FxProviderConfigRow {
  id: string;
  orgId: string;
  provider: FxProviderKey;
  displayName: string;
  baseCurrency: string;
  currencies: string[];
  schedule: FxSyncSchedule;
  syncHourUtc: number;
  lookbackDays: number;
  isEnabled: boolean;
  secrets: string | null;
  nextSyncAt: Date | null;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastObservationDate: string | null;
  lastError: string | null;
}

export interface FxProviderConfigView extends Omit<FxProviderConfigRow, "secrets"> {
  hasSecret: boolean;
}

export interface FxSnapshot {
  date: string;
  /** Currency units per one unit of `anchor`. Includes anchor=1. */
  anchor: string;
  unitsPerAnchor: Record<string, string>;
}

export interface NormalizedFxRate {
  date: string;
  fromCurrency: string;
  toCurrency: string;
  rate: string;
}

export interface FxSyncResult {
  observationsReceived: number;
  normalizedRates: number;
  ratesInserted: number;
  ratesUpdated: number;
  manualOverridesPreserved: number;
  latestObservationDate: string;
}

export class FxProviderError extends Error {}

export const FX_PROVIDER_MANIFESTS: Record<FxProviderKey, { displayName: string; requiresSecret: boolean; anchor: string }> = {
  bank_of_canada: { displayName: "Bank of Canada", requiresSecret: false, anchor: "CAD" },
  ecb: { displayName: "European Central Bank", requiresSecret: false, anchor: "EUR" },
  open_exchange_rates: { displayName: "Open Exchange Rates", requiresSecret: true, anchor: "USD" },
};

const CONFIG_COLS = sql`id, org_id as "orgId", provider, display_name as "displayName",
  base_currency as "baseCurrency", currencies, schedule, sync_hour_utc as "syncHourUtc",
  lookback_days as "lookbackDays", is_enabled as "isEnabled", secrets,
  next_sync_at as "nextSyncAt", last_attempt_at as "lastAttemptAt",
  last_success_at as "lastSuccessAt", last_observation_date as "lastObservationDate", last_error as "lastError"`;

export async function readFxProviderConfig(orgId: string): Promise<FxProviderConfigRow | null> {
  const r = (await db.execute(sql`
    select ${CONFIG_COLS} from fx_provider_configs where org_id = ${orgId} limit 1
  `)) as unknown as { rows: FxProviderConfigRow[] };
  return r.rows[0] ?? null;
}

export async function readFxProviderConfigView(orgId: string): Promise<FxProviderConfigView | null> {
  const row = await readFxProviderConfig(orgId);
  if (!row) return null;
  const { secrets, ...safe } = row;
  return { ...safe, hasSecret: Boolean(secrets) };
}

export interface SaveFxProviderInput {
  provider: FxProviderKey;
  displayName?: string;
  baseCurrency: string;
  currencies: string[];
  schedule: FxSyncSchedule;
  syncHourUtc: number;
  lookbackDays: number;
  isEnabled: boolean;
  /** undefined keeps, null clears, string replaces. */
  apiKey?: string | null;
}

function cleanCurrency(value: unknown): string {
  const code = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new FxProviderError(`invalid currency code: ${code || "(blank)"}`);
  return code;
}

export async function saveFxProviderConfig(
  orgId: string,
  actorId: string,
  input: SaveFxProviderInput,
): Promise<string> {
  const manifest = FX_PROVIDER_MANIFESTS[input.provider];
  if (!manifest) throw new FxProviderError("unknown FX provider");
  if (!(["manual", "daily", "weekdays", "weekly"] as string[]).includes(input.schedule)) {
    throw new FxProviderError("invalid synchronization schedule");
  }
  if (!Number.isInteger(input.syncHourUtc) || input.syncHourUtc < 0 || input.syncHourUtc > 23) {
    throw new FxProviderError("synchronization hour must be between 0 and 23 UTC");
  }
  if (!Number.isInteger(input.lookbackDays) || input.lookbackDays < 1 || input.lookbackDays > 31) {
    throw new FxProviderError("lookback must be between 1 and 31 days");
  }
  const baseCurrency = cleanCurrency(input.baseCurrency);
  const currencies = [...new Set(input.currencies.map(cleanCurrency).filter((c) => c !== baseCurrency))].sort();
  if (currencies.length === 0) throw new FxProviderError("choose at least one foreign currency");

  const known = (await db.execute(sql`
    select code from currencies where code in (${sql.join([baseCurrency, ...currencies].map((c) => sql`${c}`), sql`, `)})
  `)) as unknown as { rows: { code: string }[] };
  if (known.rows.length !== currencies.length + 1) throw new FxProviderError("one or more currencies are not in the currency registry");

  const existing = await readFxProviderConfig(orgId);
  let sealed = existing?.secrets ?? null;
  if (input.apiKey === null || input.provider !== "open_exchange_rates") sealed = null;
  if (typeof input.apiKey === "string" && input.apiKey.trim()) sealed = sealJson({ apiKey: input.apiKey.trim() });
  if (input.isEnabled && manifest.requiresSecret && !unsealJson<{ apiKey?: string }>(sealed)?.apiKey) {
    throw new FxProviderError("an API key is required before enabling Open Exchange Rates");
  }
  const next = input.isEnabled ? computeNextSyncAt(input.schedule, input.syncHourUtc) : null;
  const displayName = String(input.displayName ?? "").trim() || manifest.displayName;
  const r = (await db.execute(sql`
    insert into fx_provider_configs
      (org_id, provider, display_name, base_currency, currencies, schedule, sync_hour_utc,
       lookback_days, is_enabled, secrets, next_sync_at, created_by, updated_by)
    values (${orgId}, ${input.provider}, ${displayName}, ${baseCurrency}, ${JSON.stringify(currencies)}::jsonb,
            ${input.schedule}, ${input.syncHourUtc}, ${input.lookbackDays}, ${input.isEnabled},
            ${sealed}, ${next}, ${actorId}, ${actorId})
    on conflict (org_id) do update set
      provider = excluded.provider, display_name = excluded.display_name,
      base_currency = excluded.base_currency, currencies = excluded.currencies,
      schedule = excluded.schedule, sync_hour_utc = excluded.sync_hour_utc,
      lookback_days = excluded.lookback_days, is_enabled = excluded.is_enabled,
      secrets = excluded.secrets, next_sync_at = excluded.next_sync_at,
      last_error = null, updated_at = now(), updated_by = excluded.updated_by
    returning id
  `)) as unknown as { rows: { id: string }[] };
  return r.rows[0]!.id;
}

export function computeNextSyncAt(schedule: FxSyncSchedule, hourUtc: number, now = new Date()): Date | null {
  if (schedule === "manual") return null;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0));
  if (schedule === "weekly") {
    next.setUTCDate(next.getUTCDate() + 7);
    return next;
  }
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  if (schedule === "weekdays") {
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function syncRange(config: FxProviderConfigRow, now = new Date()): { from: string; to: string } {
  const to = isoDate(now);
  const lookbackStart = addDays(to, -(config.lookbackDays - 1));
  const revisionStart = config.lastObservationDate ? addDays(config.lastObservationDate, -2) : lookbackStart;
  return { from: revisionStart > lookbackStart ? revisionStart : lookbackStart, to };
}

function expandScientific(value: string): string {
  const source = value.trim();
  const match = source.match(/^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/);
  if (!match) return source;
  const sign = match[1] === "-" ? "-" : "";
  const digits = `${match[2]}${match[3] ?? ""}`;
  const decimalAt = match[2]!.length + Number(match[4]);
  if (decimalAt <= 0) return `${sign}0.${"0".repeat(-decimalAt)}${digits}`;
  if (decimalAt >= digits.length) return `${sign}${digits}${"0".repeat(decimalAt - digits.length)}`;
  return `${sign}${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
}

const DECIMAL_SCALE = 18;
const DECIMAL_FACTOR = 10n ** BigInt(DECIMAL_SCALE);
const RATE_FACTOR = 10_000_000_000n;

function decimalUnits(input: string): bigint {
  const value = expandScientific(String(input));
  const match = value.match(/^\+?(\d+)(?:\.(\d*))?$/);
  if (!match) throw new FxProviderError(`provider returned an invalid rate: ${input}`);
  const fraction = match[2] ?? "";
  const head = fraction.slice(0, DECIMAL_SCALE).padEnd(DECIMAL_SCALE, "0");
  const units = BigInt(match[1]!) * DECIMAL_FACTOR + BigInt(head || "0");
  if (units <= 0n) throw new FxProviderError(`provider returned a non-positive rate: ${input}`);
  return units;
}

/** Exact positive decimal ratio, rounded to numeric(19,10). */
export function ratioRate(numerator: string, denominator: string): string {
  const n = decimalUnits(numerator);
  const d = decimalUnits(denominator);
  const scaled = (n * RATE_FACTOR + d / 2n) / d;
  const whole = scaled / RATE_FACTOR;
  const fraction = (scaled % RATE_FACTOR).toString().padStart(10, "0");
  return `${whole}.${fraction}`;
}

/** Build every directed pair so posting and any subsidiary tree need no triangulation. */
export function normalizeFxSnapshots(snapshots: FxSnapshot[], baseCurrency: string, currencies: string[]): NormalizedFxRate[] {
  const wanted = [...new Set([baseCurrency, ...currencies])].sort();
  const out: NormalizedFxRate[] = [];
  for (const snapshot of snapshots) {
    const missing = wanted.filter((currency) => !snapshot.unitsPerAnchor[currency]);
    if (missing.length) {
      throw new FxProviderError(`provider does not publish: ${missing.join(", ")}`);
    }
    for (const fromCurrency of wanted) {
      for (const toCurrency of wanted) {
        if (fromCurrency === toCurrency) continue;
        out.push({
          date: snapshot.date,
          fromCurrency,
          toCurrency,
          rate: ratioRate(snapshot.unitsPerAnchor[toCurrency]!, snapshot.unitsPerAnchor[fromCurrency]!),
        });
      }
    }
  }
  return out;
}

async function fetchText(url: URL): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { Accept: "application/json,text/csv" } });
  if (!response.ok) throw new FxProviderError(`provider request failed with HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 20_000_000) throw new FxProviderError("provider response exceeded 20 MB");
  return text;
}

function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { cells.push(cell); cell = ""; }
    else cell += char;
  }
  cells.push(cell);
  return cells;
}

export function parseEcbCsv(text: string): FxSnapshot[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = parseCsvRow(lines.shift() ?? "");
  const currencyAt = header.indexOf("CURRENCY");
  const dateAt = header.indexOf("TIME_PERIOD");
  const valueAt = header.indexOf("OBS_VALUE");
  if (currencyAt < 0 || dateAt < 0 || valueAt < 0) throw new FxProviderError("ECB response is missing required columns");
  const byDate = new Map<string, Record<string, string>>();
  for (const line of lines) {
    const row = parseCsvRow(line);
    const currency = row[currencyAt];
    const date = row[dateAt];
    const value = row[valueAt];
    if (!currency || !date || !value) continue;
    const rates = byDate.get(date) ?? { EUR: "1" };
    rates[currency] = value;
    byDate.set(date, rates);
  }
  return [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, unitsPerAnchor]) => ({ date, anchor: "EUR", unitsPerAnchor }));
}

export function parseBankOfCanadaJson(text: string): FxSnapshot[] {
  let payload: { observations?: Array<Record<string, unknown> & { d?: string }> };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new FxProviderError("Bank of Canada returned an invalid payload");
  }
  return (payload.observations ?? []).flatMap((observation) => {
    if (!observation.d) return [];
    const rates: Record<string, string> = { CAD: "1" };
    for (const [series, raw] of Object.entries(observation)) {
      const match = series.match(/^FX([A-Z]{3})CAD$/);
      const value = raw && typeof raw === "object" ? (raw as { v?: unknown }).v : null;
      if (match && value != null) rates[match[1]!] = ratioRate("1", String(value));
    }
    return [{ date: observation.d, anchor: "CAD", unitsPerAnchor: rates }];
  });
}

async function fetchProviderSnapshots(config: FxProviderConfigRow, from: string, to: string): Promise<FxSnapshot[]> {
  if (config.provider === "bank_of_canada") {
    const url = new URL("https://www.bankofcanada.ca/valet/observations/group/FX_RATES_DAILY/json");
    url.searchParams.set("start_date", from);
    url.searchParams.set("end_date", to);
    return parseBankOfCanadaJson(await fetchText(url));
  }
  if (config.provider === "ecb") {
    const url = new URL("https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A");
    url.searchParams.set("startPeriod", from);
    url.searchParams.set("endPeriod", to);
    url.searchParams.set("format", "csvdata");
    return parseEcbCsv(await fetchText(url));
  }
  const apiKey = unsealJson<{ apiKey?: string }>(config.secrets)?.apiKey;
  if (!apiKey) throw new FxProviderError("Open Exchange Rates API key is missing");
  const snapshots: FxSnapshot[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const url = new URL(`https://openexchangerates.org/api/historical/${date}.json`);
    url.searchParams.set("app_id", apiKey);
    let payload: { base?: string; rates?: Record<string, number> };
    try {
      payload = JSON.parse(await fetchText(url)) as typeof payload;
    } catch {
      throw new FxProviderError("Open Exchange Rates returned an invalid payload");
    }
    if (!payload.base || !payload.rates) throw new FxProviderError("Open Exchange Rates returned an invalid payload");
    const unitsPerAnchor = Object.fromEntries(Object.entries(payload.rates).map(([code, value]) => [code, String(value)]));
    unitsPerAnchor[payload.base] = "1";
    snapshots.push({ date, anchor: payload.base, unitsPerAnchor });
  }
  return snapshots;
}

async function createRun(config: FxProviderConfigRow, trigger: FxRunTrigger, from: string, to: string, actorId?: string): Promise<string> {
  try {
    const r = (await db.execute(sql`
      insert into fx_provider_runs (org_id, provider_config_id, trigger, requested_from, requested_to, created_by)
      values (${config.orgId}, ${config.id}, ${trigger}, ${from}, ${to}, ${actorId ?? null}) returning id
    `)) as unknown as { rows: { id: string }[] };
    return r.rows[0]!.id;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new FxProviderError("an FX provider run is already in progress");
    throw error;
  }
}

export async function runFxProvider(
  orgId: string,
  trigger: FxRunTrigger,
  actorId?: string,
  now = new Date(),
): Promise<FxSyncResult> {
  const config = await readFxProviderConfig(orgId);
  if (!config) throw new FxProviderError("configure an FX provider first");
  if (trigger !== "test" && !config.isEnabled) throw new FxProviderError("enable the FX provider before synchronizing");
  try {
    await assertNotSandbox(orgId, "FX provider synchronization");
  } catch {
    throw new FxProviderError("FX providers cannot contact external services from a sandbox");
  }
  const range = trigger === "test"
    ? { from: addDays(isoDate(now), -6), to: isoDate(now) }
    : syncRange(config, now);
  const runId = await createRun(config, trigger, range.from, range.to, actorId);
  await db.execute(sql`update fx_provider_configs set last_attempt_at = now() where id = ${config.id}`);
  try {
    const snapshots = await fetchProviderSnapshots(config, range.from, range.to);
    if (snapshots.length === 0) throw new FxProviderError("provider returned no observations for the requested period");
    const normalized = normalizeFxSnapshots(snapshots, config.baseCurrency, config.currencies);
    const latestObservationDate = snapshots.map((s) => s.date).sort().at(-1)!;
    const result: FxSyncResult = {
      observationsReceived: snapshots.length,
      normalizedRates: normalized.length,
      ratesInserted: 0,
      ratesUpdated: 0,
      manualOverridesPreserved: 0,
      latestObservationDate,
    };
    if (trigger !== "test") {
      await db.transaction(async (tx) => {
        const existing = (await tx.execute(sql`
          select from_currency, to_currency, as_of::text, source from fx_rates
           where org_id = ${orgId} and rate_type = 'spot'
             and as_of between ${range.from} and ${range.to}
        `)) as unknown as { rows: { from_currency: string; to_currency: string; as_of: string; source: string }[] };
        const byKey = new Map(existing.rows.map((row) => [`${row.as_of}|${row.from_currency}|${row.to_currency}`, row.source]));
        for (const rate of normalized) {
          const key = `${rate.date}|${rate.fromCurrency}|${rate.toCurrency}`;
          const source = byKey.get(key);
          if (source === "manual") { result.manualOverridesPreserved++; continue; }
          if (source) {
            await tx.execute(sql`
              update fx_rates set rate = ${rate.rate}, source = ${config.provider},
                     provider_config_id = ${config.id}, imported_at = now(), updated_at = now(), updated_by = ${actorId ?? null}
               where org_id = ${orgId} and from_currency = ${rate.fromCurrency}
                 and to_currency = ${rate.toCurrency} and as_of = ${rate.date} and rate_type = 'spot'
            `);
            result.ratesUpdated++;
          } else {
            await tx.execute(sql`
              insert into fx_rates
                (org_id, from_currency, to_currency, as_of, rate_type, rate, source,
                 provider_config_id, imported_at, created_by, updated_by)
              values (${orgId}, ${rate.fromCurrency}, ${rate.toCurrency}, ${rate.date}, 'spot', ${rate.rate},
                      ${config.provider}, ${config.id}, now(), ${actorId ?? null}, ${actorId ?? null})
            `);
            result.ratesInserted++;
          }
        }
      });
    }
    const next = config.isEnabled ? computeNextSyncAt(config.schedule, config.syncHourUtc, now) : null;
    await db.execute(sql`
      update fx_provider_runs set status = 'ok', finished_at = now(),
        observations_received = ${result.observationsReceived}, rates_inserted = ${result.ratesInserted},
        rates_updated = ${result.ratesUpdated}, manual_overrides_preserved = ${result.manualOverridesPreserved}
       where id = ${runId}
    `);
    await db.execute(sql`
      update fx_provider_configs set
        last_success_at = ${trigger === "test" ? sql`last_success_at` : sql`now()`},
        last_observation_date = ${trigger === "test" ? sql`last_observation_date` : latestObservationDate},
        last_error = null, next_sync_at = ${next}, updated_at = now()
       where id = ${config.id}
    `);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "FX provider synchronization failed";
    const retryAt = config.isEnabled && config.schedule !== "manual" ? new Date(now.getTime() + 60 * 60 * 1000) : null;
    await db.execute(sql`update fx_provider_runs set status = 'failed', error_message = ${message.slice(0, 1000)}, finished_at = now() where id = ${runId}`);
    await db.execute(sql`update fx_provider_configs set last_error = ${message.slice(0, 1000)}, next_sync_at = ${retryAt}, updated_at = now() where id = ${config.id}`);
    throw error;
  }
}

/** Scheduler scan with compare-and-swap claims; safe across multiple servers. */
export async function runDueFxProviders(now = new Date()): Promise<number> {
  const due = (await db.execute(sql`
    select ${CONFIG_COLS} from fx_provider_configs
     where is_enabled and schedule <> 'manual' and next_sync_at <= ${now}
       and exists (
         select 1 from orgs organization
          where organization.id = fx_provider_configs.org_id
            and organization.env_kind = 'production'
       )
     order by next_sync_at limit 20
  `)) as unknown as { rows: FxProviderConfigRow[] };
  let claimedCount = 0;
  for (const config of due.rows) {
    const next = computeNextSyncAt(config.schedule, config.syncHourUtc, now);
    const claim = (await db.execute(sql`
      update fx_provider_configs set next_sync_at = ${next}
       where id = ${config.id} and next_sync_at = ${config.nextSyncAt}
    `)) as unknown as { rowCount?: number };
    if (!claim.rowCount) continue;
    claimedCount++;
    try { await runFxProvider(config.orgId, "scheduler", undefined, now); }
    catch (error) { console.error(`[fx-provider] ${config.id} sync failed:`, error); }
  }
  return claimedCount;
}
