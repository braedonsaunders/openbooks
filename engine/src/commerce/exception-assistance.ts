import { sql } from "drizzle-orm";
import { upsertAccountMap } from "./account-maps.ts";
import { CommerceError } from "./errors.ts";
import { findNative, linkExternal } from "./external-links.ts";
import { upsertChannelLocation } from "./locations.ts";
import { loadChannelOrder, type ChannelOrderDetail } from "./orders.ts";
import { postChannelOrder } from "./order-posting.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { db, withOrg } from "../platform/db.ts";

/**
 * Classified exception assistance. Every parked channel order gets a
 * deterministic proposed fix with its evidence: the engine ranks exact
 * candidates first (SKU, barcode history, name, past mapping decisions) and
 * the in-app assistant only rewords the explanation — it never invents a
 * target. Approving applies the fix as an effective-dated mapping and
 * replays the affected orders; rejecting records the reason in the audit
 * log. Nothing here applies itself.
 */

const FEATURE_REMEDY = "Enable Sales Channels in Company Settings → Features.";

export type SuggestionConfidence = "high" | "medium" | "low";

export type SuggestionAction =
  | { type: "link_variant"; variantExternalId: string; itemId: string }
  | { type: "map_account"; role: string; key: string; accountId: string; effectiveFrom: string }
  | { type: "map_location"; externalLocationId: string; externalName: string; stockLocationId: string }
  | { type: "manual"; note: string };

export interface SuggestionCandidate {
  rank: number;
  kind: "link_variant" | "map_account" | "map_location" | "manual";
  /** The exact record the approval would write: item code, account or location name. */
  label: string;
  detail: string;
  confidence: SuggestionConfidence;
  /** Why this candidate: each bullet names an observed signal, never a guess. */
  evidence: string[];
  action: SuggestionAction;
}

export interface ExceptionSuggestion {
  orderId: string;
  channelId: string;
  code: string;
  /** Stable key grouping orders blocked by the same cause for fix-all-similar. */
  groupKey: string;
  candidates: SuggestionCandidate[];
  /** Orders parked under the same code and key, including this one. */
  similarCount: number;
  explanation: string;
  /** The engine never calls the model; the web layer may reword through it. */
  modelRanked: false;
}

export interface AssistanceReplay {
  replayed: number;
  posted: number;
  parked: number;
  waiting: number;
}

function refuse(code: string, message: string, remedy: string, field: string | null = null, status: 422 | 409 = 422): never {
  throw new CommerceError(code, message, remedy, { field, status });
}

/** Fold case and visual separators so "TEE-RED_M" and "tee red m" compare equal. */
export function normalizeExceptionSku(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const folded = value.trim().toUpperCase().replaceAll(/[-_\s]+/g, "");
  return folded === "" ? null : folded;
}

function wordTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/g).filter((token) => token !== "");
}

/** Deterministic SKU score: 100 exact, 90 separator-blind, else leading-overlap below 90. */
export function skuMatchScore(querySku: string, itemCode: string): { score: number; signals: string[] } {
  const query = querySku.trim();
  const code = itemCode.trim();
  if (query.toLowerCase() === code.toLowerCase() && query !== "") {
    return { score: 100, signals: [`SKU matches item code "${code}" exactly`] };
  }
  const foldedQuery = normalizeExceptionSku(query);
  const foldedCode = normalizeExceptionSku(code);
  if (foldedQuery && foldedQuery === foldedCode) {
    return { score: 90, signals: [`SKU matches "${code}" ignoring dashes, spaces and case`] };
  }
  const lowerQuery = query.toLowerCase();
  const lowerCode = code.toLowerCase();
  let prefix = 0;
  while (prefix < lowerQuery.length && prefix < lowerCode.length && lowerQuery[prefix] === lowerCode[prefix]) {
    prefix += 1;
  }
  const score = Math.floor((200 * prefix) / (lowerQuery.length + lowerCode.length || 1));
  if (score <= 0) return { score: 0, signals: [] };
  return { score: Math.min(score, 89), signals: [`SKU shares the first ${prefix} characters with "${code}"`] };
}

/** Deterministic title score: word-overlap share, 0 when no word is shared. */
export function titleMatchScore(queryTitle: string, itemName: string): { score: number; signals: string[] } {
  const queryWords = new Set(wordTokens(queryTitle));
  const nameWords = new Set(wordTokens(itemName));
  if (queryWords.size === 0 || nameWords.size === 0) return { score: 0, signals: [] };
  const shared = [...queryWords].filter((word) => nameWords.has(word));
  if (shared.length === 0) return { score: 0, signals: [] };
  const union = new Set([...queryWords, ...nameWords]);
  const score = Math.round((100 * shared.length) / union.size);
  return { score, signals: [`Title shares ${shared.length === 1 ? "word" : "words"} ${shared.map((word) => `"${word}"`).join(", ")} with "${itemName}"`] };
}

export function exceptionGroupKey(
  code: string,
  parts: { sku?: string | null; variantExternalId?: string | null; gateway?: string | null; role?: string | null; key?: string | null; jurisdiction?: string | null },
): string {
  const clean = (value: string | null | undefined): string | null =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  switch (code) {
    case "unmapped_item": {
      const variant = clean(parts.variantExternalId);
      if (variant) return `unmapped_item:variant:${variant}`;
      const sku = clean(parts.sku);
      return sku ? `unmapped_item:sku:${sku.toUpperCase()}` : "unmapped_item";
    }
    case "unmapped_account": {
      const gateway = clean(parts.gateway);
      if (gateway) return `unmapped_account:gateway:${gateway.toLowerCase()}`;
      const role = clean(parts.role);
      const key = clean(parts.key);
      return role ? `unmapped_account:role:${role}:${key ?? ""}` : "unmapped_account";
    }
    case "tax_mismatch": {
      const jurisdiction = clean(parts.jurisdiction);
      return jurisdiction ? `tax_mismatch:jurisdiction:${jurisdiction.toUpperCase()}` : "tax_mismatch";
    }
    default:
      return code;
  }
}

type ItemRow = Record<string, unknown> & { id: string; code: string | null; name: string };
type AccountRow = Record<string, unknown> & {
  id: string;
  name: string;
  type: string;
  currencyRestriction: string | null;
  subsidiaryId: string | null;
};
type ChannelRow = Record<string, unknown> & {
  id: string;
  kind: string;
  name: string;
  currency: string;
  external_account: string;
  subsidiary_id: string | null;
};

async function loadChannel(orgId: string, channelId: string): Promise<ChannelRow> {
  const row = (await db.execute<ChannelRow>(sql`
    select id, kind, name, currency, external_account, subsidiary_id from sales_channels
     where org_id = ${orgId} and id = ${channelId}`)).rows[0];
  if (!row) {
    refuse(
      "channel_not_found",
      "The sales channel does not belong to this organization.",
      "Choose a channel in this organization, or connect it first under Channels.",
      "channelId",
    );
  }
  return row;
}

async function requireExceptionOrder(orgId: string, orderId: string): Promise<ChannelOrderDetail> {
  const order = await loadChannelOrder(orgId, orderId);
  if (!order) {
    refuse(
      "channel_order_unknown",
      "The channel order does not belong to this organization.",
      "Choose an order from this organization's channel subledger.",
      "orderId",
    );
  }
  if (order.postingStatus !== "exception" || !order.exceptionCode) {
    refuse(
      "exception_assistance_not_parked",
      `Order ${order.externalNumber} is ${order.postingStatus}, not parked on the exception queue.`,
      "Open the Exceptions tab and choose an order that is still waiting for its fix.",
      "orderId",
    );
  }
  return order;
}

interface UnmappedLine {
  index: number;
  sku: string | null;
  variantExternalId: string | null;
  title: string;
}

/** The first line the posting resolver would park on: variant link, then exact SKU, else unmapped. */
async function findUnmappedLine(orgId: string, channel: ChannelRow, order: ChannelOrderDetail): Promise<UnmappedLine | null> {
  for (let index = 0; index < order.lines.length; index += 1) {
    const line = order.lines[index]!;
    if (line.variantExternalId) {
      const linked = await findNative(orgId, {
        provider: channel.kind,
        externalAccount: channel.external_account,
        objectType: "variant",
        externalId: line.variantExternalId,
      });
      if (linked?.nativeTable === "items") {
        const item = (await db.execute<{ id: string }>(sql`
          select id from items where org_id = ${orgId} and id = ${linked.nativeId} and is_active`)).rows[0];
        if (item) continue;
      }
    }
    const sku = typeof line.sku === "string" && line.sku.trim() !== "" ? line.sku.trim() : null;
    if (sku) {
      const item = (await db.execute<{ id: string }>(sql`
        select id from items
         where org_id = ${orgId} and code = ${sku} and is_active
         order by created_at limit 1`)).rows[0];
      if (item) continue;
    }
    return { index, sku, variantExternalId: line.variantExternalId, title: line.title };
  }
  return null;
}

function parseAccountRole(reason: string): { role: string; key: string } | null {
  const match = /has no (\w+) account(?: for "([^"]*)")?/.exec(reason);
  if (!match) return null;
  return { role: match[1]!, key: match[2] ?? "" };
}

function gatewayTokens(gateway: string): string[] {
  return gateway.toLowerCase().split(/[^a-z0-9]+/g).filter((token) => token !== "");
}

async function postableAccounts(orgId: string, channel: ChannelRow): Promise<AccountRow[]> {
  const rows = (await db.execute<AccountRow>(sql`
    select id, name, type, currency_restriction as "currencyRestriction", subsidiary_id as "subsidiaryId"
      from accounts
     where org_id = ${orgId} and is_active and not is_summary`)).rows;
  return rows.filter((account) => {
    if (account.currencyRestriction && account.currencyRestriction.toUpperCase() !== channel.currency.toUpperCase()) return false;
    if (channel.subsidiary_id && account.subsidiaryId && account.subsidiaryId !== channel.subsidiary_id) return false;
    return true;
  });
}

function rankAccount(goal: { types: string[]; tokens: RegExp[] }, account: AccountRow): { score: number; evidence: string } | null {
  const name = account.name;
  const typeHit = goal.types.includes(account.type);
  const nameHit = goal.tokens.some((pattern) => pattern.test(name));
  if (typeHit && nameHit) return { score: 100, evidence: `Type ${account.type} with a matching name ("${name}")` };
  if (nameHit) return { score: 70, evidence: `Name matches ("${name}"); confirm the type ${account.type} posts correctly here` };
  if (typeHit) return { score: 40, evidence: `Type ${account.type} fits; confirm "${name}" is the right account` };
  return null;
}

function accountGoalFor(role: string, key: string): { types: string[]; tokens: RegExp[] } {
  if (role === "gateway_clearing" || role === "refund_clearing") {
    const tokens = gatewayTokens(key).map((token) => new RegExp(token.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    return { types: ["asset_bank", "asset_current_other"], tokens: [...tokens, /clearing/i] };
  }
  if (role === "sales_tax_liability") {
    const keyToken = key.trim() !== "" ? [new RegExp(key.trim().replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")] : [];
    return { types: ["liability_payable", "liability_current_other", "liability_long_term"], tokens: [...keyToken, /sales tax|vat|gst|hst|tax payable/i] };
  }
  if (role === "revenue") return { types: ["income", "income_other"], tokens: [/sales|revenue|merchandise|product sales/i] };
  if (role === "discount") return { types: ["income", "income_other", "expense", "expense_other"], tokens: [/discount/i] };
  if (role === "shipping_income") return { types: ["income", "income_other"], tokens: [/shipping|delivery|freight/i] };
  if (role === "gift_card_liability") {
    return { types: ["liability_payable", "liability_current_other", "liability_long_term"], tokens: [/gift/i] };
  }
  return { types: [], tokens: [/clearing/i] };
}

function manualCandidate(rank: number, label: string, detail: string, evidence: string[]): SuggestionCandidate {
  return { rank, kind: "manual", label, detail, confidence: "low", evidence, action: { type: "manual", note: detail } };
}

async function suggestUnmappedItem(orgId: string, channel: ChannelRow, order: ChannelOrderDetail): Promise<{ candidates: SuggestionCandidate[]; groupKey: string }> {
  const line = await findUnmappedLine(orgId, channel, order);
  if (!line) {
    return {
      groupKey: exceptionGroupKey("unmapped_item", {}),
      candidates: [manualCandidate(0, "Replay the order", "Every line already maps; the park may predate the mapping.", ["Re-resolution finds no unmapped line"])],
    };
  }
  const groupKey = exceptionGroupKey("unmapped_item", { sku: line.sku, variantExternalId: line.variantExternalId });
  const querySku = typeof line.sku === "string" ? line.sku : "";
  const tokens = [...new Set([...wordTokens(querySku), ...wordTokens(line.title)])].slice(0, 6);
  const like = tokens.length > 0
    ? sql`and (${sql.join(tokens.map((token) => sql`lower(code) like ${`%${token}%`} or lower(name) like ${`%${token}%`}`), sql` or `)})`
    : sql``;
  const rows = (await db.execute<ItemRow>(sql`
    select id, code, name from items
     where org_id = ${orgId} and is_active ${like}
     order by code nulls last, name limit 50`)).rows;
  const scored = rows
    .map((row) => {
      const sku = querySku ? skuMatchScore(querySku, row.code ?? "") : { score: 0, signals: [] as string[] };
      const title = titleMatchScore(line.title, row.name);
      const score = Math.max(sku.score, Math.round(title.score * 0.8));
      return { row, score, signals: [...sku.signals, ...title.signals] };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (a.row.code ?? "").localeCompare(b.row.code ?? ""))
    .slice(0, 5);
  // A past mapping decision for this exact SKU outranks similarity: the
  // operator already answered this question on the Products tab.
  const past = line.sku ? (await db.execute<ItemRow>(sql`
    select i.id, i.code, i.name
      from external_links l
      join items i on i.org_id = l.org_id and i.id = l.native_id
      join shopify_catalog_entries q on q.org_id = l.org_id and q.channel_id = l.channel_id
        and q.object_type = 'variant' and q.sku = ${line.sku}
     where l.org_id = ${orgId} and l.channel_id = ${order.channelId}
       and l.object_type = 'variant' and l.native_table = 'items'
       and i.is_active
     limit 1`)).rows[0] : undefined;
  const candidates: SuggestionCandidate[] = [];
  if (past && line.variantExternalId) {
    candidates.push({
      rank: 0,
      kind: "link_variant",
      label: past.code ?? past.name,
      detail: `Link this storefront variant to ${past.code ?? past.name}.`,
      confidence: "high",
      evidence: [`The Products tab already maps SKU "${line.sku}" to "${past.code ?? past.id}"`],
      action: { type: "link_variant", variantExternalId: line.variantExternalId, itemId: past.id },
    });
  }
  for (const entry of scored) {
    if (past && entry.row.id === past.id) continue;
    if (!line.variantExternalId) break;
    candidates.push({
      rank: candidates.length,
      kind: "link_variant",
      label: entry.row.code ?? entry.row.name,
      detail: `Link this storefront variant to ${entry.row.code ?? entry.row.name} ("${entry.row.name}").`,
      confidence: entry.score >= 90 ? "high" : entry.score >= 50 ? "medium" : "low",
      evidence: entry.signals,
      action: { type: "link_variant", variantExternalId: line.variantExternalId, itemId: entry.row.id },
    });
    if (candidates.length >= 3) break;
  }
  if (candidates.length === 0) {
    candidates.push(manualCandidate(
      0,
      line.sku ? `Match SKU "${line.sku}"` : `Match "${line.title}"`,
      line.variantExternalId
        ? "No similar item found. Match the variant to an item under Channels → Products, or create the item from the exception row, then replay."
        : "This line carries no storefront variant id, so it cannot be linked automatically. Match SKU to an item code under Channels → Products, or create the item from the exception row, then replay.",
      line.sku ? [`No active item resembles SKU "${line.sku}" or title "${line.title}"`] : [`Line "${line.title}" names no SKU and no variant`],
    ));
  }
  return { candidates, groupKey };
}

async function suggestUnmappedAccount(orgId: string, channel: ChannelRow, order: ChannelOrderDetail): Promise<{ candidates: SuggestionCandidate[]; groupKey: string }> {
  const reason = order.exceptionReason ?? "";
  const parsed = parseAccountRole(reason);
  const gateway = order.tenders.find((tender) => gatewayTokens(tender.gateway).length > 0)?.gateway ?? null;
  if (!parsed) {
    if (/marketplace-collected tax/.test(reason)) {
      const jurisdiction = /for "([^"]+)"/.exec(reason)?.[1] ?? null;
      return {
        groupKey: exceptionGroupKey("tax_mismatch", { jurisdiction }),
        candidates: [manualCandidate(
          0,
          "Add the marketplace facilitator",
          "Add the marketplace facilitator in Setup → Taxes → Marketplace facilitators (named exactly as the storefront reports it), then replay the order.",
          [reason],
        )],
      };
    }
    return {
      groupKey: exceptionGroupKey("unmapped_account", { gateway }),
      candidates: [manualCandidate(0, "Set the posting account", reason || "The channel is missing a posting account.", [reason])],
    };
  }
  const groupKey = exceptionGroupKey("unmapped_account", { gateway: parsed.role === "gateway_clearing" ? (parsed.key || gateway) : null, role: parsed.role, key: parsed.key });
  const goal = accountGoalFor(parsed.role, parsed.role === "gateway_clearing" && !parsed.key ? (gateway ?? "") : parsed.key);
  const accounts = await postableAccounts(orgId, channel);
  const ranked = accounts
    .map((account) => ({ account, ranked: rankAccount(goal, account) }))
    .filter((entry): entry is { account: AccountRow; ranked: { score: number; evidence: string } } => entry.ranked !== null)
    .sort((a, b) => b.ranked.score - a.ranked.score || a.account.name.localeCompare(b.account.name))
    .slice(0, 3);
  // The map takes effect on the order's own date so the parked order is
  // covered; an unreadable date parks as tax_mismatch before any account
  // resolves, and the map writer re-validates the date on approve.
  const effectiveFrom = order.orderedAt.slice(0, 10);
  const candidates = ranked.map((entry, index): SuggestionCandidate => ({
    rank: index,
    kind: "map_account",
    label: entry.account.name,
    detail: `Map ${parsed.role}${parsed.key ? ` for "${parsed.key}"` : ""} to ${entry.account.name}, effective ${effectiveFrom}.`,
    confidence: entry.ranked.score >= 90 ? "high" : entry.ranked.score >= 60 ? "medium" : "low",
    evidence: [entry.ranked.evidence],
    action: { type: "map_account", role: parsed.role, key: parsed.key, accountId: entry.account.id, effectiveFrom },
  }));
  if (candidates.length === 0) {
    candidates.push(manualCandidate(
      0,
      "Set the posting account",
      `Map this role under Channels → Settings → Posting accounts, effective on or before the posting date.`,
      [`No active posting account fits role ${parsed.role}${parsed.key ? ` for "${parsed.key}"` : ""}`],
    ));
  }
  return { candidates, groupKey };
}

async function suggestUnmappedLocation(orgId: string, channel: ChannelRow, order: ChannelOrderDetail): Promise<{ candidates: SuggestionCandidate[]; groupKey: string }> {
  const groupKey = exceptionGroupKey("unmapped_location", {});
  const open = (await db.execute<{ external_location_id: string; external_name: string }>(sql`
    select external_location_id, external_name from sales_channel_locations
     where org_id = ${orgId} and channel_id = ${order.channelId} and stock_location_id is null
     order by external_name limit 5`)).rows;
  if (open.length === 0) {
    return {
      groupKey,
      candidates: [manualCandidate(
        0,
        "Map exactly one fulfilment location",
        "Map exactly one fulfilment location under Channels → Settings → Locations, then replay the order.",
        [order.exceptionReason ?? "The channel has no single fulfilment location"],
      )],
    };
  }
  const stocks = (await db.execute<{ id: string; name: string }>(sql`
    select id, name from stock_locations where org_id = ${orgId} and is_active order by name limit 20`)).rows;
  const channelWords = new Set(wordTokens(channel.name));
  const candidates: SuggestionCandidate[] = open.slice(0, 3).map((location, index) => {
    const scored = stocks
      .map((stock) => ({ stock, shared: wordTokens(stock.name).filter((word) => channelWords.has(word) || wordTokens(location.external_name).includes(word)) }))
      .sort((a, b) => b.shared.length - a.shared.length || a.stock.name.localeCompare(b.stock.name));
    const best = scored[0];
    const evidence = best && best.shared.length > 0
      ? [`"${location.external_name}" shares ${best.shared.map((word) => `"${word}"`).join(", ")} with "${best.stock.name}"`]
      : [`No stock location name resembles "${location.external_name}"; first alphabetically proposed — confirm before applying`];
    const target = best?.stock;
    if (!target) {
      return manualCandidate(index, `Map "${location.external_name}"`, "Create a stock location first, then map it under Channels → Settings → Locations.", [`No active stock location exists`]);
    }
    return {
      rank: index,
      kind: "map_location",
      label: `${location.external_name} → ${target.name}`,
      detail: `Point storefront location "${location.external_name}" at ${target.name} for fulfilment.`,
      confidence: best.shared.length > 0 ? "medium" : "low",
      evidence,
      action: { type: "map_location", externalLocationId: location.external_location_id, externalName: location.external_name, stockLocationId: target.id },
    } satisfies SuggestionCandidate;
  });
  return { candidates, groupKey };
}

function suggestManual(order: ChannelOrderDetail): { candidates: SuggestionCandidate[]; groupKey: string } {
  const code = order.exceptionCode ?? "exception";
  return {
    groupKey: exceptionGroupKey(code, {}),
    candidates: [manualCandidate(0, "Follow the remedy", order.exceptionRemedy ?? order.exceptionReason ?? "Resolve the cause, then replay.", [order.exceptionReason ?? code])],
  };
}

/**
 * Deterministic proposed fix for one parked order. Candidates are ranked
 * by observed signals only; the result is identical for identical data, so
 * the model can reword but never reorder by hidden judgment.
 */
export async function suggestExceptionFix(orgId: string, orderId: string): Promise<ExceptionSuggestion> {
  const order = await requireExceptionOrder(orgId, orderId);
  const channel = await loadChannel(orgId, order.channelId);
  const code = order.exceptionCode ?? "exception";
  let result: { candidates: SuggestionCandidate[]; groupKey: string };
  if (code === "unmapped_item") result = await suggestUnmappedItem(orgId, channel, order);
  else if (code === "unmapped_account") result = await suggestUnmappedAccount(orgId, channel, order);
  else if (code === "unmapped_location") result = await suggestUnmappedLocation(orgId, channel, order);
  else result = suggestManual(order);
  const similar = await similarExceptionOrderIds(orgId, code, result.groupKey, 200);
  const top = result.candidates[0];
  const explanation = top && top.kind !== "manual"
    ? `Proposed fix for order ${order.externalNumber}: ${top.detail} Evidence: ${top.evidence.join("; ")}. Approving replays ${similar.length === 1 ? "this order" : `${similar.length} similar orders`} — nothing posts until then.`
    : `Order ${order.externalNumber} needs ${order.exceptionReason ?? code} ${order.exceptionRemedy ?? ""}`.trim();
  return {
    orderId: order.id,
    channelId: order.channelId,
    code,
    groupKey: result.groupKey,
    candidates: result.candidates,
    similarCount: similar.length,
    explanation,
    modelRanked: false,
  };
}

/** Orders parked under the same code and grouping key, oldest first. */
export async function similarExceptionOrderIds(orgId: string, code: string, groupKey: string, limit = 200): Promise<string[]> {
  const rows = (await db.execute<{ id: string; exception_reason: string | null; lines: unknown; tenders: unknown }>(sql`
    select id, exception_reason, lines, tenders from channel_orders
     where org_id = ${orgId} and posting_status = 'exception' and exception_code = ${code}
     order by ordered_at limit ${limit}`)).rows;
  const out: string[] = [];
  for (const row of rows) {
    const key = groupKeyForRow(code, row.exception_reason, row.lines, row.tenders);
    if (key === groupKey) out.push(row.id);
  }
  return out;
}

function jsonText(value: unknown, field: string): string | null {
  if (!Array.isArray(value)) return null;
  const first = value[0] as Record<string, unknown> | undefined;
  const raw = first?.[field];
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

function groupKeyForRow(code: string, reason: string | null, lines: unknown, tenders: unknown): string {
  if (code === "unmapped_item") {
    const items = Array.isArray(lines) ? (lines as Record<string, unknown>[]) : [];
    const first = items[0];
    const variant = typeof first?.variantExternalId === "string" ? first.variantExternalId : null;
    const sku = typeof first?.sku === "string" ? first.sku : null;
    return exceptionGroupKey(code, { sku, variantExternalId: variant });
  }
  if (code === "unmapped_account") {
    const parsed = parseAccountRole(reason ?? "");
    const gateway = jsonText(tenders, "gateway");
    if (parsed) {
      return exceptionGroupKey(code, {
        gateway: parsed.role === "gateway_clearing" ? (parsed.key || gateway) : null,
        role: parsed.role,
        key: parsed.key,
      });
    }
    return exceptionGroupKey(code, { gateway });
  }
  if (code === "tax_mismatch") {
    const jurisdiction = /for "([^"]+)"/.exec(reason ?? "")?.[1] ?? null;
    return exceptionGroupKey(code, { jurisdiction });
  }
  return exceptionGroupKey(code, {});
}

async function writeApprovalAudit(orgId: string, actor: string, orderId: string, code: string, detail: string): Promise<void> {
  const inserted = await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'channel_orders', ${orderId}, 'update',
      ${JSON.stringify({ before: { exceptionCode: code }, after: { suggestionApproved: detail }, reason: "Operator approved the proposed exception fix" })}::jsonb, ${actor})`);
  if (inserted.rowCount !== 1) throw new Error("Approval audit insert matched no row; the decision was lost");
}

/**
 * Apply the approved candidate as an effective-dated mapping, then replay
 * the approved order — or every order blocked by the same cause when asked.
 * The candidate is recomputed server-side: the request names a rank, never
 * a target, so a tampered body cannot redirect the mapping.
 */
export async function approveExceptionSuggestion(
  orgId: string,
  actor: string,
  orderId: string,
  input: { rank: number; applyToSimilar: boolean },
): Promise<{ applied: string; replay: AssistanceReplay }> {
  if (!Number.isInteger(input.rank) || input.rank < 0) {
    refuse(
      "exception_assistance_candidate_unknown",
      "The chosen fix is not one of the proposed candidates.",
      "Reload the suggestion and approve one of the listed fixes.",
      "rank",
    );
  }
  return withOrg(orgId, async () => {
    const suggestion = await suggestExceptionFix(orgId, orderId);
    const candidate = suggestion.candidates[input.rank];
    if (!candidate) {
      refuse(
        "exception_assistance_candidate_unknown",
        "The chosen fix is not one of the proposed candidates.",
        "Reload the suggestion and approve one of the listed fixes.",
        "rank",
      );
    }
    const channel = await loadChannel(orgId, suggestion.channelId);
    const action = candidate.action;
    let applied: string;
    if (action.type === "link_variant") {
      const row = await linkExternal(orgId, actor, {
        channelId: suggestion.channelId,
        provider: channel.kind,
        externalAccount: channel.external_account,
        objectType: "variant",
        externalId: action.variantExternalId,
        nativeTable: "items",
        nativeId: action.itemId,
      }, "salesChannels");
      applied = `Variant ${action.variantExternalId} now maps to item ${row.nativeId}.`;
    } else if (action.type === "map_account") {
      await upsertAccountMap(orgId, actor, {
        channelId: suggestion.channelId,
        role: action.role,
        key: action.key,
        accountId: action.accountId,
        effectiveFrom: action.effectiveFrom,
      });
      applied = `${action.role}${action.key ? ` for "${action.key}"` : ""} now maps from ${action.effectiveFrom}; posted history keeps its accounts.`;
    } else if (action.type === "map_location") {
      await upsertChannelLocation(orgId, actor, {
        channelId: suggestion.channelId,
        externalLocationId: action.externalLocationId,
        externalName: action.externalName,
        stockLocationId: action.stockLocationId,
        fulfilsOrders: true,
      });
      applied = `Location "${action.externalName}" now fulfils from stock.`;
    } else {
      refuse(
        "exception_assistance_manual_only",
        "This exception has no mapping the assistant can apply.",
        candidate.detail,
        "rank",
      );
    }
    await writeApprovalAudit(orgId, actor, orderId, suggestion.code, `${applied} Similar: ${input.applyToSimilar ? suggestion.groupKey : "this order only"}.`);
    const targets = input.applyToSimilar
      ? await similarExceptionOrderIds(orgId, suggestion.code, suggestion.groupKey, 200)
      : [orderId];
    const replay: AssistanceReplay = { replayed: 0, posted: 0, parked: 0, waiting: 0 };
    for (const targetId of targets.includes(orderId) ? targets : [orderId, ...targets]) {
      const live = await loadChannelOrder(orgId, targetId);
      if (!live || live.postingStatus !== "exception") continue;
      const reset = await db.execute(sql`
        update channel_orders
           set posting_status = 'pending',
               posting_document_id = null, summary_id = null,
               exception_code = null, exception_reason = null, exception_remedy = null,
               updated_by = ${actor}, updated_at = now()
         where org_id = ${orgId} and id = ${targetId} and posting_status = 'exception'`);
      if (reset.rowCount !== 1) continue;
      replay.replayed += 1;
      const outcome = await postChannelOrder(orgId, actor, targetId);
      if (outcome.status === "posted") replay.posted += 1;
      else if (outcome.status === "exception") replay.parked += 1;
      else replay.waiting += 1;
    }
    return { applied: applied!, replay };
  });
}

/**
 * Decline the proposal with a reason. The order stays parked and the
 * decision lands in the audit log with who said no and why.
 */
export async function rejectExceptionSuggestion(orgId: string, actor: string, orderId: string, reason: string): Promise<void> {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why === "") {
    refuse(
      "exception_assistance_reason_missing",
      "A reason is required to reject a proposed fix.",
      "Say why the proposal is wrong so the audit record shows what the operator decided.",
      "reason",
    );
  }
  await withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
      refuse("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
    }
    const order = await requireExceptionOrder(orgId, orderId);
    const inserted = await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'channel_orders', ${orderId}, 'update',
        ${JSON.stringify({ before: { exceptionCode: order.exceptionCode }, after: { exceptionCode: order.exceptionCode, suggestionRejected: true }, reason: why })}::jsonb, ${actor})`);
    if (inserted.rowCount !== 1) throw new Error("Rejection audit insert matched no row; the decision was lost");
  });
}
