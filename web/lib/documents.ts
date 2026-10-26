import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/database";
import { subsidiaryVisibleFilter } from "@openbooks/engine/organization/scope";
import { segmentRegistry } from "./segments";
import { loadSegmentDependencyRules } from "@openbooks/engine/organization/segment-dependencies";
import { resolveOrgId } from "./org-scope";
import { bankAccountMembership } from "./banking-accounts";
import type { DocKindConfig } from "./document-kinds";
import { taxProfileMap } from "@openbooks/engine/documents/totals";
import { businessToday } from "@openbooks/engine/platform/business-date";
import { receiptFundingAccountOptions } from "@openbooks/engine/payments/documents";

export * from "@openbooks/engine/documents/write";

export type Opt = {
  id: string;
  display_name?: string;
  number?: string;
  name?: string;
  code?: string;
  rate?: string;
  label?: string;
  last_four?: string | null;
  network?: string | null;
  liability_account_id?: string | null;
  /** Settlement currency the account accepts (null = any). Drawers read it
   * for form-level currency validation. */
  currency_restriction?: string | null;
  /** Party pickers carry the party's primary subsidiary (drafts default to it). */
  subsidiary_id?: string | null;
  /** The party's organization-defined short code; pickers match it as typed. */
  short_code?: string | null;
  tax_components?: import("@openbooks/engine/documents/totals").TaxComponentConfig[];
};

export async function partyOptions(
  role: "vendor" | "customer",
  orgId?: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId);
  const filter =
    role === "vendor"
      ? sql`exists (select 1 from vendor_roles vr
                     where vr.org_id = p.org_id
                       and vr.party_id = p.id
                       and vr.is_active)`
      : sql`exists (select 1 from customer_roles cr
                     where cr.org_id = p.org_id
                       and cr.party_id = p.id
                       and cr.is_active)`;
  const r = await db.execute<Opt>(
    sql`
    select p.id, p.display_name, p.subsidiary_id, p.short_code from parties p
     where p.org_id = ${resolvedOrgId} and ${filter} and p.is_active
       ${allowedSubsidiaryIds === undefined ? sql`` : subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     order by p.display_name limit 2000
  `,
    "objects",
  );
  return r;
}

export async function accountOptions(
  cfg: DocKindConfig,
  orgId?: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId);
  const typeFilter = cfg.accountTypes
    ? sql` and a.type in (${sql.join(
        cfg.accountTypes.map((ty) => sql`${ty}`),
        sql`, `,
      )})`
    : sql``;
  const r = await db.execute<Opt>(
    sql`
    select id, number, name, currency_restriction from accounts a
     where a.org_id = ${resolvedOrgId} and a.is_active and not a.is_summary ${typeFilter}
       ${allowedSubsidiaryIds === undefined ? sql`` : subsidiaryVisibleFilter(sql`a.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     order by a.number nulls last
  `,
    "objects",
  );
  return r;
}

/**
 * Tax code choices priced as of `asOfDate` — an open document's own date, so
 * a draft dated before a rate change keeps the rate it was priced at; today
 * in the organization's business time zone otherwise. A code with no rate
 * effective on that date carries no rate and no components.
 */
export async function taxCodeOptions(orgId?: string, asOfDate?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId);
  const date = asOfDate ?? (await businessToday(resolvedOrgId));
  const profiles = await taxProfileMap(resolvedOrgId, date);
  const r = await db.execute<Opt>(
    sql`
    select tc.id, tc.code, tc.name, tr.rate_percent as rate
      from tax_codes tc
      left join lateral (
        select rate_percent from tax_rates
         where org_id = ${resolvedOrgId} and tax_code_id = tc.id and effective_from <= ${date}::date
           and (effective_to is null or effective_to >= ${date}::date)
         order by effective_from desc limit 1) tr on true
     where tc.org_id = ${resolvedOrgId} and tc.is_active order by tc.code
  `,
    "objects",
  );
  return r.map((row) => ({ ...row, tax_components: profiles.codes.get(row.id) ?? [] }));
}

export async function taxGroupOptions(orgId?: string, asOfDate?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId);
  const profiles = await taxProfileMap(resolvedOrgId, asOfDate);
  const result = await db.execute<Opt>(
    sql`
    select id, code, name from tax_groups
     where org_id = ${resolvedOrgId} and is_active order by code
  `,
    "objects",
  );
  return result.map((row) => ({ ...row, tax_components: profiles.groups.get(row.id) ?? [] }));
}

export async function dimensionOptions(
  orgId?: string,
  _documentId?: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
) {
  const resolvedOrgId = await resolveOrgId(orgId);
  const [departments, projects, locations, classes, registry] = await Promise.all([
    db.execute(
      sql`select id, name from departments where org_id = ${resolvedOrgId} and is_active ${allowedSubsidiaryIds === undefined ? sql`` : subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })} order by name`,
      "objects",
    ),
    db.execute(
      sql`select id, name from projects where org_id = ${resolvedOrgId} and is_active ${allowedSubsidiaryIds === undefined ? sql`` : subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })} order by name limit 2000`,
      "objects",
    ),
    db.execute(
      sql`select id, name from locations where org_id = ${resolvedOrgId} and is_active ${allowedSubsidiaryIds === undefined ? sql`` : subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })} order by name`,
      "objects",
    ),
    db.execute(
      sql`select id, name from classes where org_id = ${resolvedOrgId} and is_active ${allowedSubsidiaryIds === undefined ? sql`` : subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })} order by name`,
      "objects",
    ),
    segmentRegistry(resolvedOrgId, allowedSubsidiaryIds),
  ]);
  // Each segment carries the dependency rules that restrict its values, so
  // line pickers filter by the line's other values (empty while the
  // Segment dependencies feature is off).
  const rules = await loadSegmentDependencyRules(db, resolvedOrgId);
  const withDependencies = registry.map((segment) => ({
    ...segment,
    dependencies: rules.filter((rule) => rule.segment.id === segment.id),
  }));
  return {
    departments: departments as Opt[],
    projects: projects as Opt[],
    locations: locations as Opt[],
    classes: classes as Opt[],
    segments: withDependencies.filter((segment) => segment.sourceKind === "custom"),
    builtinSegments: withDependencies.filter((segment) => segment.sourceKind === "builtin"),
  };
}

/** Active catalog items (for the optional line `item` column). */
export async function itemOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId);
  const r = await db.execute<Opt>(
    sql`
    select id, code, name from items where org_id = ${resolvedOrgId} and is_active order by coalesce(code, name), name limit 2000
  `,
    "objects",
  );
  return r;
}

/** Active corporate cards (for card_charge / card_refund funding source). */
export async function cardOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId);
  const r = await db.execute<{
    id: string;
    label: string;
    last_four: string | null;
    network: string | null;
    liability_account_id: string | null;
    holder: string | null;
  }>(
    sql`
    select pc.id, pc.label, pc.last_four, pc.network, pc.liability_account_id, p.display_name as holder
      from payment_cards pc
      left join parties p on p.id = pc.holder_party_id and p.org_id = pc.org_id
     where pc.org_id = ${resolvedOrgId} and pc.is_active
     order by pc.label
  `,
    "objects",
  );
  return r.map((c) => ({
    id: c.id,
    label: c.last_four ? `${c.label}` : c.label,
    display_name: c.last_four
      ? `${c.network ?? ""} •••• ${c.last_four} — ${c.holder ?? ""}`.trim()
      : c.label,
    last_four: c.last_four,
    network: c.network,
    liability_account_id: c.liability_account_id,
  }));
}

/** Reconcilable bank accounts (for check funding source + transfer legs). */
export async function bankAccountOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId);
  const r = await db.execute<Opt>(
    sql`
    select id, number, name, currency_restriction from accounts
     where org_id = ${resolvedOrgId} and is_active and not is_summary and reconcilable and type = 'asset_bank'
     order by number nulls last
  `,
    "objects",
  );
  return r;
}

/** Customer receipts add only the provider's explicitly scoped processor
 * pool. The ordinary bank option contract remains unchanged. */
export async function receiptAccountOptions(input: {
  orgId: string;
  actorId: string;
  kind: "customer_payment" | "vendor_payment";
  subsidiaryId: string;
  currency: string;
  onDate: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}) {
  return receiptFundingAccountOptions(input);
}

/**
 * Transfer legs (destination and source) name any active bank or credit-card
 * account the banking module manages, the same membership its registers list.
 * Debiting a card account pays its balance down; crediting it draws on the card.
 */
export async function transferAccountOptions(
  orgId?: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId);
  const r = await db.execute<Opt>(
    sql`
    select a.id, a.number, a.name, a.currency_restriction from accounts a
     where a.org_id = ${resolvedOrgId} and ${bankAccountMembership()}
       ${allowedSubsidiaryIds === undefined ? sql`` : subsidiaryVisibleFilter(sql`a.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     order by a.number nulls last
  `,
    "objects",
  );
  return r;
}

/**
 * Reconcilable card-liability accounts (the card-charge fallback when no
 * card instruments exist). Offered as the controlAccountId
 * override the engine cardRule reads first; fenced to this exact set by
 * the funding-override guard in applyDocumentEdit.
 */
export async function cardLiabilityAccountOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId);
  const r = await db.execute<Opt>(
    sql`
    select id, number, name, currency_restriction from accounts
     where org_id = ${resolvedOrgId} and is_active and not is_summary and reconcilable and type = 'liability_card'
     order by number nulls last
  `,
    "objects",
  );
  return r;
}
