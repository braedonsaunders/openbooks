import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";

export class TaxMarketplaceError extends Error {}

/**
 * Marketplace facilitators: the marketplace collects the tax and remits it,
 * so OpenBooks records the tax for reporting and nexus but never posts it
 * as the merchant's liability. Posting routes facilitator-collected
 * components to the facilitator's clearing account (gross documents, where
 * the marketplace tax is inside the charged total) or emits no leg (net
 * documents, shown for reporting only). Which treatment applies is the
 * facilitator's collection_mode — set when the facilitator is configured
 * and documented on the record — never inferred from the document.
 */

export type MarketplaceCollectionMode = "gross" | "net";

export interface MarketplaceClearing {
  name: string;
  accountId: string;
  mode: MarketplaceCollectionMode;
}

type Runner = Pick<SqlExecutor, "execute">;

const ASSET_CLEARING_TYPES = new Set(["asset_receivable", "asset_current_other"]);

/**
 * Resolve facilitator names to their clearing accounts, failing closed on
 * anything misconfigured: an unknown or inactive facilitator, a missing or
 * unsuitable clearing account, or a clearing account that doubles as a tax
 * control (which would smuggle facilitator tax back into the merchant's
 * returns). Posting calls this before any journal is written.
 */
export async function resolveMarketplaceClearing(
  runner: Runner,
  orgId: string,
  names: string[],
  remedy = "configure the facilitator in Setup → Taxes → Marketplace facilitators",
): Promise<Map<string, MarketplaceClearing>> {
  const unique = [...new Set(names)];
  const out = new Map<string, MarketplaceClearing>();
  for (const name of unique) {
    const row = (await runner.execute<{
      name: string;
      clearingAccountId: string;
      mode: MarketplaceCollectionMode;
      isActive: boolean;
    }>(sql`
      select name, clearing_account_id as "clearingAccountId",
             collection_mode as mode, is_active as "isActive"
        from marketplace_facilitators
       where org_id = ${orgId} and name = ${name}
    `)).rows[0];
    if (!row) {
      throw new TaxMarketplaceError(
        `marketplace facilitator "${name}" is not configured — ${remedy}`,
      );
    }
    if (!row.isActive) {
      throw new TaxMarketplaceError(
        `marketplace facilitator "${name}" is inactive — reactivate it in Setup → Taxes → Marketplace facilitators or move the line back to merchant collection`,
      );
    }
    const account = (await runner.execute<{
      id: string;
      type: string;
      isActive: boolean;
      isSummary: boolean;
    }>(sql`
      select id, type, is_active as "isActive", is_summary as "isSummary"
        from accounts where org_id = ${orgId} and id = ${row.clearingAccountId}
    `)).rows[0];
    if (!account) {
      throw new TaxMarketplaceError(
        `marketplace facilitator "${name}" points at a clearing account that no longer exists — ${remedy}`,
      );
    }
    if (!account.isActive || account.isSummary) {
      throw new TaxMarketplaceError(
        `marketplace facilitator "${name}" points at a clearing account that is ${!account.isActive ? "inactive" : "a summary account"} — ${remedy}`,
      );
    }
    if (!ASSET_CLEARING_TYPES.has(account.type)) {
      throw new TaxMarketplaceError(
        `marketplace facilitator "${name}" needs an asset clearing account (the marketplace owes the merchant this tax) — ${remedy}`,
      );
    }
    const control = (await runner.execute<{ one: number }>(sql`
      select 1 as one
        from tax_codes
       where org_id = ${orgId}
         and (collected_account_id = ${row.clearingAccountId}
           or paid_account_id = ${row.clearingAccountId}
           or withholding_account_id = ${row.clearingAccountId})
       limit 1
    `)).rows[0];
    const orgControl = (await runner.execute<{ one: number }>(sql`
      select 1 as one from orgs
       where id = ${orgId}
         and (settings->'controlAccounts'->>'taxCollected' = ${row.clearingAccountId}
           or settings->'controlAccounts'->>'taxPaid' = ${row.clearingAccountId})
    `)).rows[0];
    if (control ?? orgControl) {
      throw new TaxMarketplaceError(
        `marketplace facilitator "${name}" uses an account that is also a tax control account — facilitator tax would re-enter the merchant's returns; ${remedy}`,
      );
    }
    out.set(name, { name, accountId: row.clearingAccountId, mode: row.mode });
  }
  return out;
}

export interface SaveMarketplaceFacilitatorInput {
  id?: string;
  name: string;
  clearingAccountId: string;
  collectionMode?: MarketplaceCollectionMode;
  states?: string[];
  isActive?: boolean;
}

const STATE_RE = /^[A-Z]{2}$/;

/**
 * Validate a facilitator write before it lands: names are unique per org,
 * the clearing account must exist and be an asset account that is not a tax
 * control, states are ISO-like region codes. The Setup registry calls this
 * through its validateWrite hook; direct callers get the same refusal.
 */
export function validateMarketplaceFacilitatorInput(input: SaveMarketplaceFacilitatorInput): void {
  if (!input.name.trim()) {
    throw new TaxMarketplaceError("a marketplace facilitator needs a name — enter the marketplace as customers know it");
  }
  if (!input.clearingAccountId.trim()) {
    throw new TaxMarketplaceError(
      `marketplace facilitator "${input.name.trim()}" needs a clearing account — pick the asset account the marketplace settlement relieves`,
    );
  }
  if (input.collectionMode !== undefined && input.collectionMode !== "gross" && input.collectionMode !== "net") {
    throw new TaxMarketplaceError(
      `marketplace facilitator "${input.name.trim()}" collection is "${input.collectionMode}" — choose "gross" (tax inside the charged total, posted to clearing) or "net" (document net of tax, no posting leg)`,
    );
  }
  for (const state of input.states ?? []) {
    if (!STATE_RE.test(state.trim())) {
      throw new TaxMarketplaceError(
        `marketplace facilitator "${input.name.trim()}" lists "${state}" as a collecting state — use two-letter state codes`,
      );
    }
  }
}

/**
 * Write a facilitator row. Runs inside the caller's transaction (the Setup
 * write path owns it); checks the affected row count like every guarded
 * write here.
 */
export async function saveMarketplaceFacilitator(
  runner: Runner,
  orgId: string,
  input: SaveMarketplaceFacilitatorInput,
  actorId: string | null,
): Promise<string> {
  validateMarketplaceFacilitatorInput(input);
  const name = input.name.trim();
  const mode = input.collectionMode ?? "gross";
  const states = [...new Set((input.states ?? []).map((s) => s.trim()))].sort();
  // The clearing account must exist in this org; resolveMarketplaceClearing
  // re-checks suitability at every posting, so setup stays fast.
  const account = (await runner.execute<{ id: string }>(sql`
    select id from accounts where org_id = ${orgId} and id = ${input.clearingAccountId}
  `)).rows[0];
  if (!account) {
    throw new TaxMarketplaceError(
      `marketplace facilitator "${name}" points at an account outside this organization — pick a clearing account from this organization's chart`,
    );
  }
  if (input.id) {
    const updated = (await runner.execute<{ id: string }>(sql`
      update marketplace_facilitators
         set name = ${name}, clearing_account_id = ${input.clearingAccountId},
             collection_mode = ${mode}, states = ${states}::text[],
             is_active = ${input.isActive ?? true},
             updated_at = now(), updated_by = ${actorId}
       where id = ${input.id} and org_id = ${orgId}
      returning id
    `));
    if (!updated.rows[0]) {
      throw new TaxMarketplaceError(`marketplace facilitator "${name}" was not updated — it may belong to another organization`);
    }
    return updated.rows[0].id;
  }
  const inserted = (await runner.execute<{ id: string }>(sql`
    insert into marketplace_facilitators
      (org_id, name, clearing_account_id, collection_mode, states, is_active, created_by, updated_by)
    values (${orgId}, ${name}, ${input.clearingAccountId}, ${mode}, ${states}::text[],
            ${input.isActive ?? true}, ${actorId}, ${actorId})
    returning id
  `));
  if (!inserted.rows[0]) throw new TaxMarketplaceError(`marketplace facilitator "${name}" was not stored — no row was written`);
  return inserted.rows[0].id;
}

export interface MarketplaceNexusRule {
  state: string;
  includeInThreshold: boolean;
  needsReview: boolean;
  source: string;
}

/** The verified per-state rules, keyed by state code. */
export async function readAllMarketplaceNexusRules(
  runner: Runner = db,
): Promise<Map<string, MarketplaceNexusRule>> {
  const rows = (await runner.execute<{
    state: string;
    includeInThreshold: boolean;
    needsReview: boolean;
    source: string;
  }>(sql`
    select state,
           include_in_threshold as "includeInThreshold",
           needs_review as "needsReview", source
      from marketplace_nexus_state_rules
  `)).rows;
  return new Map(rows.map((row) => [row.state, {
    state: row.state,
    includeInThreshold: row.includeInThreshold,
    needsReview: row.needsReview,
    source: row.source,
  }]));
}

/** Apply the verified-or-default rule: seeded rows govern, unlisted states
 * default to included pending review (see readMarketplaceNexusRule). */
export function marketplaceNexusRuleFor(
  state: string,
  seeded: Map<string, MarketplaceNexusRule>,
): MarketplaceNexusRule {
  return seeded.get(state.trim().toUpperCase()) ?? {
    state: state.trim().toUpperCase(),
    includeInThreshold: true,
    needsReview: true,
    source: "",
  };
}

/**
 * The marketplace treatment of one state's nexus threshold. A seeded row
 * carries the verified rule; a state with no row defaults to INCLUDED and
 * needing review — the ledger errs toward measuring, and the UI marks the
 * state so the operator verifies rather than inherits a silent guess.
 */
export async function readMarketplaceNexusRule(
  state: string,
  runner: Runner = db,
): Promise<MarketplaceNexusRule> {
  const code = state.trim().toUpperCase();
  const row = (await runner.execute<{
    includeInThreshold: boolean;
    needsReview: boolean;
    source: string;
  }>(sql`
    select include_in_threshold as "includeInThreshold",
           needs_review as "needsReview", source
      from marketplace_nexus_state_rules where state = ${code}
  `)).rows[0];
  return {
    state: code,
    includeInThreshold: row?.includeInThreshold ?? true,
    needsReview: row?.needsReview ?? true,
    source: row?.source ?? "",
  };
}
