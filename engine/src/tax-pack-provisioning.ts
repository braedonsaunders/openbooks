import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalDecimal } from "./exact-decimal.ts";
import { db, withOrgTransaction } from "./db.ts";
import { normalizeMoney } from "./money.ts";
import { installTaxReturnPacks, taxReturnPack, TAX_RETURN_PACKS } from "./seed-tax-forms.ts";
import {
  COUNTRY_TAX_PACKS,
  countryTaxPack,
  countryTaxPackForReturn,
  jurisdictionSelectionKey,
  resolveJurisdictionSelection,
} from "./country-tax-packs/index.ts";
import type { CountryPackCoverage, CountryTaxCodeDefinition, CountryTaxPackDefinition } from "./country-tax-packs/index.ts";

/** Persist a pack JSON rate through exact decimal then ledger money — never as an IEEE-754 number. */
function persistPackRatePercent(ratePercent: string | number): string {
  const exact = canonicalDecimal(ratePercent, 4);
  if (exact === null) throw new Error("rate percent must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new Error("rate percent must be an exact decimal");
  }
}

function packRateSchedule(
  rates: ReadonlyArray<{ ratePercent: string | number; effectiveFrom: string; effectiveTo?: string | null }>,
): Array<{ ratePercent: string; effectiveFrom: string; effectiveTo: string | null }> {
  return rates.map((rate) => ({
    ratePercent: persistPackRatePercent(rate.ratePercent),
    effectiveFrom: rate.effectiveFrom,
    effectiveTo: rate.effectiveTo ?? null,
  }));
}

/**
 * One-click country provisioning for INDIRECT tax (sales tax / GST / VAT).
 *
 * Picking a country (and, where supported, its states/provinces) installs the
 * whole indirect-tax stack for that jurisdiction: the jurisdiction record, a
 * standard tax code with its rate, the government return form and boxes (mapped
 * to that code), and a nexus registration. This turns "set up tax for the places
 * I do business" into a single action instead of hand-building every entity.
 *
 * Everything is idempotent, so re-running for an already-provisioned country
 * adds nothing and never duplicates.
 */

export type DefaultTaxCode = CountryTaxCodeDefinition;

/**
 * The standard tax code seeded per pack. One code per jurisdiction at its
 * headline rate — a working starting point the user refines (extra rate bands,
 * local/district rates, exemptions). US state rates are the STATE base rate only;
 * local/district rates are layered on per the workpaper.
 */
export const PACK_DEFAULT_CODES: Record<string, DefaultTaxCode> = {
  ...Object.fromEntries(COUNTRY_TAX_PACKS.flatMap((pack) => Object.entries(pack.returnPackTaxCodes))),
};

export interface SupportedSubJurisdiction {
  /** A detailed return-pack code, or a JURISDICTION:<ISO-3166-2> setup key. */
  packCode: string;
  region: string;
  name: string;
  coverage: CountryPackCoverage;
}

export interface SupportedCountry {
  country: string;
  name: string;
  /** A directly installable country-level return with an effective-dated rate schedule. */
  countryPack: string | null;
  countryStatus: "ready" | "subdivisions" | "in_development";
  /** State/province packs available under this country. */
  subs: SupportedSubJurisdiction[];
}

export const TAX_SUBDIVISION_CATALOG = COUNTRY_TAX_PACKS.flatMap((pack) =>
  pack.jurisdictions.map((jurisdiction) => ({ ...jurisdiction, country: pack.country })),
);

export const taxSubdivisionSelection = resolveJurisdictionSelection;

type TaxPackExecutor = Pick<typeof db, "execute">;

async function assertTaxCodeMatchesPack(
  tx: TaxPackExecutor,
  args: {
    orgId: string;
    codeId: string;
    jurisdictionId: string;
    country: string;
    region: string | null;
    definition: CountryTaxCodeDefinition;
  },
): Promise<void> {
  const result = (await tx.execute<{
      name: string;
      jurisdictionId: string | null;
      country: string | null;
      region: string | null;
      appliesTo: string;
      isActive: boolean;
      rates: Array<{ ratePercent: string; effectiveFrom: string; effectiveTo: string | null }>;
    }>(sql`
    select code.name, code.jurisdiction_id as "jurisdictionId",
           code.country, code.region, code.applies_to as "appliesTo",
           code.is_active as "isActive",
           coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'ratePercent', rate.rate_percent::text,
                 'effectiveFrom', rate.effective_from::text,
                 'effectiveTo', rate.effective_to::text
               ) order by rate.effective_from, rate.id
             ) filter (where rate.id is not null),
             '[]'::jsonb
           ) as rates
      from tax_codes code
      left join tax_rates rate
        on rate.org_id = code.org_id and rate.tax_code_id = code.id
     where code.org_id = ${args.orgId} and code.id = ${args.codeId}
     group by code.id, code.name, code.jurisdiction_id, code.country,
              code.region, code.applies_to, code.is_active
  `));
  const actual = result.rows[0];
  const expectedRates = packRateSchedule(args.definition.rates ?? []);
  const actualRates = packRateSchedule(actual?.rates ?? []);
  const metadataMatches = actual
    && actual.name === args.definition.name
    && actual.jurisdictionId === args.jurisdictionId
    && actual.country === args.country
    && actual.region === args.region
    && actual.appliesTo === "both"
    && actual.isActive;
  if (!metadataMatches || JSON.stringify(actualRates) !== JSON.stringify(expectedRates)) {
    throw new Error(
      `tax code ${args.definition.code} conflicts with the versioned country pack; rename or retire the existing code before installation`,
    );
  }
}

type PackCodeRateRefreshArgs = {
  tx: TaxPackExecutor;
  orgId: string;
  codeId: string;
  jurisdictionId: string;
  country: string;
  region: string | null;
  packCode: string;
  actorId: string | null;
  definition: CountryTaxCodeDefinition;
};

/**
 * Pre-existing pack-owned codes skip the insert above, so a newer pack version's
 * updated statutory rates never reached the org — and assertTaxCodeMatchesPack
 * then hard-errored against the very pack being installed. For a code whose
 * metadata still matches the pack AND that this org has never posted against,
 * rewrite the stored rate history to the pack's current definition here, with
 * before/after audit evidence: an unused rate schedule is configuration, not
 * filed history, so replacement (rather than closing rows, which would leave
 * the strict history assert permanently unsatisfiable) is the sound correction.
 *
 * Usage proxy, chosen as the cheapest sound check: any document_line_tax_components
 * row referencing the code counts as posted history — it is the direct keyed
 * probe (document_line_tax_components_code index). journal_lines only reference
 * the code indirectly through its accounts, and tax_rate_quotes carry no code
 * key at all. A used code keeps today's hard error — silently changing
 * filed-history rates is forbidden — reported by the caller naming every stale
 * code and the archive-then-re-run way out.
 */
async function refreshPackCodeRatesIfUnused(args: PackCodeRateRefreshArgs): Promise<string | null> {
  const result = (await args.tx.execute<{
      name: string;
      jurisdictionId: string | null;
      country: string | null;
      region: string | null;
      appliesTo: string;
      isActive: boolean;
      rates: Array<{ ratePercent: string; effectiveFrom: string; effectiveTo: string | null }>;
    }>(sql`
    select code.name, code.jurisdiction_id as "jurisdictionId",
           code.country, code.region, code.applies_to as "appliesTo",
           code.is_active as "isActive",
           coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'ratePercent', rate.rate_percent::text,
                 'effectiveFrom', rate.effective_from::text,
                 'effectiveTo', rate.effective_to::text
               ) order by rate.effective_from, rate.id
             ) filter (where rate.id is not null),
             '[]'::jsonb
           ) as rates
      from tax_codes code
      left join tax_rates rate
        on rate.org_id = code.org_id and rate.tax_code_id = code.id
     where code.org_id = ${args.orgId} and code.id = ${args.codeId}
     group by code.id, code.name, code.jurisdiction_id, code.country,
              code.region, code.applies_to, code.is_active
  `));
  const actual = result.rows[0];
  if (!actual) return null;
  // Metadata drift means the tenant customized or renamed the code; that is not
  // pack-owned anymore and belongs to the conflict assert below, not to us.
  if (
    actual.name !== args.definition.name
    || actual.jurisdictionId !== args.jurisdictionId
    || actual.country !== args.country
    || actual.region !== args.region
    || actual.appliesTo !== "both"
    || !actual.isActive
  ) {
    return null;
  }
  const expectedRates = packRateSchedule(args.definition.rates ?? []);
  const actualRates = packRateSchedule(actual.rates ?? []);
  if (JSON.stringify(actualRates) === JSON.stringify(expectedRates)) return null;

  const used = (await args.tx.execute(sql`
    select 1 from document_line_tax_components
     where org_id = ${args.orgId} and tax_code_id = ${args.codeId}
     limit 1`));
  if (used.rows.length > 0) return args.definition.code;

  await args.tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, 'tax_codes', ${args.codeId}, 'update',
            ${JSON.stringify({
              source: "tax_setup",
              reason: `pack ${args.packCode} updated the statutory rate history for ${args.definition.code}; no posted documents reference the code`,
              before: { rates: actualRates },
              after: { rates: expectedRates },
            })}::jsonb,
            ${args.actorId})`);
  await args.tx.execute(sql`
    delete from tax_rates
     where org_id = ${args.orgId} and tax_code_id = ${args.codeId}`);
  for (const rate of args.definition.rates ?? []) {
    const insertedRate = (await args.tx.execute<{ id: string }>(sql`
      insert into tax_rates
        (org_id, tax_code_id, rate_percent, effective_from, effective_to, created_by, updated_by)
      values (${args.orgId}, ${args.codeId}, ${persistPackRatePercent(rate.ratePercent)}, ${rate.effectiveFrom}, ${rate.effectiveTo ?? null}, ${args.actorId}, ${args.actorId})
      returning id`));
    await args.tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${args.orgId}, 'tax_rates', ${insertedRate.rows[0]!.id}, 'insert',
              ${JSON.stringify({ source: "tax_setup", pack: args.packCode, taxCode: args.definition.code, refreshed: true, after: rate })}::jsonb,
              ${args.actorId})`);
  }
  return null;
}

function countryPackHash(pack: CountryTaxPackDefinition): string {
  return createHash("sha256").update(JSON.stringify(pack)).digest("hex");
}

function countryPacksForSelections(selections: readonly string[]): CountryTaxPackDefinition[] {
  const packs = new Map<string, CountryTaxPackDefinition>();
  for (const selection of selections) {
    const subdivision = taxSubdivisionSelection(selection);
    const pack = subdivision ? countryTaxPack(subdivision.country) : countryTaxPackForReturn(selection);
    if (pack) packs.set(pack.code, pack);
  }
  return [...packs.values()];
}

async function assertCountryPackVersionIntegrity(orgId: string, packs: readonly CountryTaxPackDefinition[]): Promise<void> {
  for (const pack of packs) {
    const existing = (await db.execute<{ status: "active" | "superseded"; contentHash: string }>(sql`
      select status, content_hash as "contentHash"
        from tax_country_pack_installations
       where org_id = ${orgId} and pack_code = ${pack.code} and version = ${pack.version}
       limit 1
    `));
    const row = existing.rows[0];
    if (row && row.contentHash !== countryPackHash(pack)) {
      throw new Error(`country pack ${pack.code} version ${pack.version} changed after installation; publish a new version`);
    }
    if (row?.status === "superseded") {
      throw new Error(`country pack ${pack.code} version ${pack.version} is superseded and cannot be reactivated`);
    }
  }
}

async function recordCountryPackInstallations(
  orgId: string,
  packs: readonly CountryTaxPackDefinition[],
  actorId: string | null,
): Promise<void> {
  if (!packs.length) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks:tax-setup:${orgId}`}, 0))`);
    for (const pack of packs) {
      const hash = countryPackHash(pack);
      const active = (await tx.execute<{ id: string; version: string; contentHash: string }>(sql`
        select id, version, content_hash as "contentHash"
          from tax_country_pack_installations
         where org_id = ${orgId} and pack_code = ${pack.code} and status = 'active'
         limit 1
      `));
      if (active.rows[0]?.version === pack.version) {
        if (active.rows[0].contentHash !== hash) {
          throw new Error(`country pack ${pack.code} version ${pack.version} content hash mismatch`);
        }
        continue;
      }

      const superseded = (await tx.execute<{ id: string; version: string; contentHash: string }>(sql`
        update tax_country_pack_installations
           set status = 'superseded', superseded_at = now(), superseded_by = ${actorId}
         where org_id = ${orgId} and pack_code = ${pack.code} and status = 'active'
        returning id, version, content_hash as "contentHash"
      `));
      for (const previous of superseded.rows) {
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'tax_country_pack_installations', ${previous.id}, 'update',
                  ${JSON.stringify({ source: "tax_setup", before: { status: "active", version: previous.version, contentHash: previous.contentHash }, after: { status: "superseded" }, supersededByPack: { code: pack.code, version: pack.version, contentHash: hash } })}::jsonb,
                  ${actorId})`);
      }

      const installed = (await tx.execute<{ id: string }>(sql`
        insert into tax_country_pack_installations
          (org_id, pack_code, country, version, content_hash, manifest, status, installed_by)
        values (${orgId}, ${pack.code}, ${pack.country}, ${pack.version}, ${hash}, ${JSON.stringify(pack)}::jsonb, 'active', ${actorId})
        returning id
      `));
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'tax_country_pack_installations', ${installed.rows[0]!.id}, 'insert',
                ${JSON.stringify({ source: "tax_setup", after: { packCode: pack.code, country: pack.country, version: pack.version, contentHash: hash, status: "active", completeness: pack.completeness } })}::jsonb,
                ${actorId})`);
    }
  });
}

export function isTaxProvisionSelection(code: string): boolean {
  if (taxSubdivisionSelection(code)) return true;
  const defaultCode = PACK_DEFAULT_CODES[code];
  return Boolean(taxReturnPack(code) && defaultCode?.rates?.length);
}

/**
 * The catalog of countries the setup wizard can provision, derived from the
 * installed packs. Country-level packs (level country/federal) become the country
 * entry; state-level packs become selectable sub-jurisdictions.
 */
export function supportedTaxCountries(): SupportedCountry[] {
  const byCountry = new Map<string, SupportedCountry>();
  for (const countryPack of COUNTRY_TAX_PACKS) {
    const parentCode = countryPack.parentReturnPackCode;
    const parentReady = Boolean(parentCode && PACK_DEFAULT_CODES[parentCode]?.rates?.length);
    byCountry.set(countryPack.country, {
      country: countryPack.country,
      name: countryPack.name,
      countryPack: parentReady ? parentCode : null,
      countryStatus: parentReady
        ? "ready"
        : countryPack.jurisdictions.length > 0
          ? "subdivisions"
          : "in_development",
      subs: countryPack.jurisdictions.map((jurisdiction) => ({
        packCode: jurisdiction.returnPackCode ?? jurisdictionSelectionKey(countryPack.country, jurisdiction.region),
        region: jurisdiction.region,
        name: jurisdiction.name,
        coverage: jurisdiction.coverage,
      })),
    });
  }
  for (const pack of TAX_RETURN_PACKS) {
    const j = pack.jurisdiction;
    if (countryTaxPack(j.country)) continue;
    let entry = byCountry.get(j.country);
    if (!entry) {
      entry = { country: j.country, name: j.country, countryPack: null, countryStatus: "in_development", subs: [] };
      byCountry.set(j.country, entry);
    }
    if (j.level === "state" || j.level === "county" || j.level === "city") {
      entry.subs.push({ packCode: pack.code, region: j.region ?? j.code, name: j.name, coverage: "detailed_pack" });
    } else {
      if (PACK_DEFAULT_CODES[pack.code]?.rates?.length) {
        entry.countryPack = pack.code;
        entry.countryStatus = "ready";
      }
      // Prefer the country jurisdiction's own name for the country label.
      entry.name = j.name;
    }
  }
  for (const entry of byCountry.values()) entry.subs.sort((a, b) => a.name.localeCompare(b.name));
  return [...byCountry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface ProvisionResult {
  packs: string[];
  jurisdictionsCreated: number;
  taxCodesCreated: number;
  taxGroupsCreated: number;
  registrationsCreated: number;
}

/**
 * Provision the full indirect-tax stack for a set of packs: jurisdiction, tax
 * code + rate, return form + boxes, and a nexus registration. Idempotent.
 */
export async function provisionTaxPacks(
  orgId: string,
  packCodes: readonly string[],
  actorId: string | null = null,
): Promise<ProvisionResult> {
  return withOrgTransaction(orgId, () => provisionTaxPacksInTenant(orgId, packCodes, actorId));
}

/**
 * Entire country-pack installation participates in one tenant-scoped database
 * transaction. The nested helpers reuse the pinned transaction, so a failure
 * in rates, return forms, registrations, audit evidence, or the manifest rolls
 * back the complete installation instead of leaving a partially configured
 * tax stack.
 */
async function provisionTaxPacksInTenant(
  orgId: string,
  packCodes: readonly string[],
  actorId: string | null,
): Promise<ProvisionResult> {
  const requestedCodes = [...new Set(packCodes)];
  if (requestedCodes.some((code) => !isTaxProvisionSelection(code))) {
    throw new Error("unknown or incomplete tax setup selection");
  }
  const requiredParentReturnPacks = requestedCodes.flatMap((code) => {
    const subdivision = taxSubdivisionSelection(code);
    const localization = subdivision
      ? countryTaxPack(subdivision.country)
      : countryTaxPackForReturn(code);
    const returnPack = taxReturnPack(code);
    const isSubdivision = Boolean(subdivision) || returnPack?.jurisdiction.level === "state";
    return isSubdivision && localization?.parentReturnPackCode ? [localization.parentReturnPackCode] : [];
  });
  const codes = [...new Set([...requestedCodes, ...requiredParentReturnPacks])];
  const localizedCountryPacks = countryPacksForSelections(codes);
  await assertCountryPackVersionIntegrity(orgId, localizedCountryPacks);
  const packs = codes.map((c) => taxReturnPack(c)).filter((p) => p !== undefined);
  const subdivisions = codes.map((c) => taxSubdivisionSelection(c)).filter((s) => s !== undefined);
  if (packs.length + subdivisions.length !== codes.length) {
    throw new Error("unknown tax setup selection");
  }

  let jurisdictionsCreated = 0;
  let taxCodesCreated = 0;
  let taxGroupsCreated = 0;
  // Pack versions that update statutory rates for codes this org has already
  // posted against; collected across both loops so one error names them all.
  const staleUsedCodes: string[] = [];

  // 1) Jurisdictions + tax codes + rates + a per-jurisdiction tax group BEFORE
  //    installing packs, so each pack's boxes map to the jurisdiction's own code.
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks:tax-setup:${orgId}`}, 0))`);
    const subdivisionCountries = new Set([
      ...packs
        .filter((pack) => pack.jurisdiction.level === "state")
        .map((pack) => pack.jurisdiction.country),
      ...subdivisions.map((subdivision) => subdivision.country),
    ]);
    for (const country of subdivisionCountries) {
      const localization = countryTaxPack(country);
      const countryName = localization?.name ?? country;
      const countryTaxType = localization?.countryTaxType ?? "other";
      const parent = (await tx.execute<{ id: string }>(sql`
        insert into tax_jurisdictions
          (org_id, code, name, country, level, tax_type, is_active, created_by, updated_by)
        values (${orgId}, ${country}, ${countryName}, ${country}, 'country', ${countryTaxType}, true, ${actorId}, ${actorId})
        on conflict (org_id, code) do nothing
        returning id`));
      if (parent.rows[0]) {
        jurisdictionsCreated++;
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'tax_jurisdictions', ${parent.rows[0].id}, 'insert',
                  ${JSON.stringify({ source: "tax_setup", countryPack: localization?.code ?? null, countryPackVersion: localization?.version ?? null, after: { code: country, name: countryName, country, level: "country", taxType: countryTaxType, isActive: true } })}::jsonb,
                  ${actorId})`);
      }
    }

    for (const pack of packs) {
      const j = pack.jurisdiction;
      const parentId = j.level === "state"
        ? ((await tx.execute<{ id: string }>(sql`
            select id from tax_jurisdictions where org_id = ${orgId} and code = ${j.country} limit 1
          `))).rows[0]?.id ?? null
        : null;
      const jur = (await tx.execute<{ id: string; inserted: boolean }>(sql`
        insert into tax_jurisdictions
          (org_id, code, name, country, region, level, tax_type, parent_id, is_active, created_by, updated_by)
        values (${orgId}, ${j.code}, ${j.name}, ${j.country}, ${j.region ?? null}, ${j.level}, ${j.taxType}, ${parentId}, true, ${actorId}, ${actorId})
        on conflict (org_id, code) do update
          set name = excluded.name,
              parent_id = coalesce(tax_jurisdictions.parent_id, excluded.parent_id),
              updated_at = now(), updated_by = ${actorId}
        where tax_jurisdictions.org_id = ${orgId}
        returning id, (xmax = 0) as inserted`));
      const jurisdictionId = jur.rows[0]?.id ?? null;
      if (jur.rows[0]?.inserted) {
        jurisdictionsCreated++;
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'tax_jurisdictions', ${jurisdictionId}, 'insert',
                  ${JSON.stringify({ source: "tax_setup", pack: pack.code, after: { code: j.code, name: j.name, country: j.country, region: j.region ?? null, level: j.level, taxType: j.taxType, parentId, isActive: true } })}::jsonb,
                  ${actorId})`);
      }

      const def = PACK_DEFAULT_CODES[pack.code];
      if (!def) continue;

      // Tax code (idempotent) + its rate.
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into tax_codes (org_id, code, name, jurisdiction_id, country, region, applies_to, is_active, created_by, updated_by)
        select ${orgId}, ${def.code}, ${def.name}, ${jurisdictionId}, ${j.country}, ${j.region ?? null}, 'both', true, ${actorId}, ${actorId}
         where not exists (select 1 from tax_codes where org_id = ${orgId} and code = ${def.code})
        returning id`));
      let codeId = inserted.rows[0]?.id ?? null;
      if (codeId) {
        taxCodesCreated++;
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'tax_codes', ${codeId}, 'insert',
                  ${JSON.stringify({ source: "tax_setup", pack: pack.code, after: { code: def.code, name: def.name, jurisdictionCode: j.code, country: j.country, region: j.region ?? null, appliesTo: "both", isActive: true } })}::jsonb,
                  ${actorId})`);
        if (!def.rates?.length) {
          throw new Error(`country pack ${pack.code} does not define an effective-dated rate schedule for ${def.code}`);
        }
        for (const rate of def.rates) {
          const insertedRate = (await tx.execute<{ id: string }>(sql`
            insert into tax_rates
              (org_id, tax_code_id, rate_percent, effective_from, effective_to, created_by, updated_by)
            values (${orgId}, ${codeId}, ${persistPackRatePercent(rate.ratePercent)}, ${rate.effectiveFrom}, ${rate.effectiveTo ?? null}, ${actorId}, ${actorId})
            returning id`));
          await tx.execute(sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'tax_rates', ${insertedRate.rows[0]!.id}, 'insert',
                    ${JSON.stringify({ source: "tax_setup", pack: pack.code, taxCode: def.code, after: rate })}::jsonb,
                    ${actorId})`);
        }
      } else {
        const existing = (await tx.execute<{ id: string }>(sql`
          select id from tax_codes where org_id = ${orgId} and code = ${def.code} limit 1`));
        codeId = existing.rows[0]?.id ?? null;
      }
      if (!codeId || !jurisdictionId) {
        throw new Error(`tax code ${def.code} could not be created or resolved`);
      }
      const staleCode = await refreshPackCodeRatesIfUnused({
        tx,
        orgId,
        codeId,
        jurisdictionId,
        country: j.country,
        region: j.region ?? null,
        packCode: pack.code,
        actorId,
        definition: def,
      });
      if (staleCode) {
        staleUsedCodes.push(staleCode);
      } else {
        await assertTaxCodeMatchesPack(tx, {
          orgId,
          codeId,
          jurisdictionId,
          country: j.country,
          region: j.region ?? null,
          definition: def,
        });
      }

      // Tax group bundling the jurisdiction's code — ready for compound cases
      // (extra rate bands / local taxes applied together on a line).
      const groupCode = `${j.code}-TAX`;
      const grp = (await tx.execute<{ id: string }>(sql`
        insert into tax_groups (org_id, code, name, is_active)
        select ${orgId}, ${groupCode}, ${`${j.name} tax`}, true
         where not exists (select 1 from tax_groups where org_id = ${orgId} and code = ${groupCode})
        returning id`));
      if (grp.rows[0]) taxGroupsCreated++;
      if (grp.rows[0]) {
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'tax_groups', ${grp.rows[0].id}, 'insert',
                  ${JSON.stringify({ source: "tax_setup", pack: pack.code, after: { code: groupCode, name: `${j.name} tax`, taxCodes: [def.code], isActive: true } })}::jsonb,
                  ${actorId})`);
      }
      const groupId =
        grp.rows[0]?.id ??
        ((await tx.execute<{ id: string }>(sql`select id from tax_groups where org_id = ${orgId} and code = ${groupCode} limit 1`))).rows[0]?.id ??
        null;
      if (groupId && codeId) {
        await tx.execute(sql`
          insert into tax_group_members (tax_group_id, tax_code_id, sequence)
          select ${groupId}, ${codeId}, 1
           where not exists (select 1 from tax_group_members where tax_group_id = ${groupId} and tax_code_id = ${codeId})`);
      }
    }

    // Complete jurisdiction coverage without fabricating statutory rates or
    // government forms. A detailed pack may be added later without changing
    // the jurisdiction identity or rewriting history.
    for (const subdivision of subdivisions) {
      const localization = countryTaxPack(subdivision.country);
      const jurisdictionCode = `${subdivision.country}-${subdivision.region}`;
      const parentId = ((await tx.execute<{ id: string }>(sql`
        select id from tax_jurisdictions where org_id = ${orgId} and code = ${subdivision.country} limit 1
      `))).rows[0]?.id ?? null;
      const jur = (await tx.execute<{ id: string }>(sql`
        insert into tax_jurisdictions
          (org_id, code, name, country, region, level, tax_type, parent_id, is_active, created_by, updated_by)
        values (${orgId}, ${jurisdictionCode}, ${subdivision.name}, ${subdivision.country}, ${subdivision.region}, 'state', ${subdivision.taxType}, ${parentId}, true, ${actorId}, ${actorId})
        on conflict (org_id, code) do nothing
        returning id`));
      if (jur.rows[0]) {
        jurisdictionsCreated++;
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'tax_jurisdictions', ${jur.rows[0].id}, 'insert',
                  ${JSON.stringify({ source: "tax_setup", countryPack: subdivision.countryPackCode, countryPackVersion: subdivision.countryPackVersion, coverage: subdivision.coverage, after: { code: jurisdictionCode, name: subdivision.name, country: subdivision.country, region: subdivision.region, level: "state", taxType: subdivision.taxType, parentId, isActive: true } })}::jsonb,
                  ${actorId})`);
      } else if (parentId) {
        const linked = (await tx.execute<{ id: string }>(sql`
          update tax_jurisdictions
             set parent_id = ${parentId}, updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and code = ${jurisdictionCode} and parent_id is null
          returning id`));
        if (linked.rows[0]) {
          await tx.execute(sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'tax_jurisdictions', ${linked.rows[0].id}, 'update',
                    ${JSON.stringify({ source: "tax_setup", countryPack: subdivision.countryPackCode, countryPackVersion: subdivision.countryPackVersion, before: { parentId: null }, after: { parentId } })}::jsonb,
                    ${actorId})`);
        }
      }
      const reactivated = (await tx.execute<{ id: string }>(sql`
        update tax_jurisdictions
           set is_active = true, updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and code = ${jurisdictionCode} and not is_active
        returning id`));
      if (reactivated.rows[0]) {
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'tax_jurisdictions', ${reactivated.rows[0].id}, 'update',
                  ${JSON.stringify({ source: "tax_setup", countryPack: subdivision.countryPackCode, countryPackVersion: subdivision.countryPackVersion, before: { isActive: false }, after: { isActive: true } })}::jsonb,
                  ${actorId})`);
      }

      const jurisdictionId = jur.rows[0]?.id ??
        ((await tx.execute<{ id: string }>(sql`
          select id from tax_jurisdictions where org_id = ${orgId} and code = ${jurisdictionCode} limit 1
        `))).rows[0]?.id ?? null;
      const def = subdivision.defaultTaxCode;
      if (jurisdictionId && def) {
        if (!def.rates?.length) throw new Error(`country pack ${localization?.code ?? subdivision.country} has no effective-dated rates for ${def.code}`);
        const code = (await tx.execute<{ id: string }>(sql`
          insert into tax_codes
            (org_id, code, name, jurisdiction_id, country, region, applies_to, is_active, created_by, updated_by)
          select ${orgId}, ${def.code}, ${def.name}, ${jurisdictionId}, ${subdivision.country}, ${subdivision.region}, 'both', true, ${actorId}, ${actorId}
           where not exists (select 1 from tax_codes where org_id = ${orgId} and code = ${def.code})
          returning id`));
        let codeId = code.rows[0]?.id ?? null;
        if (codeId) {
          taxCodesCreated++;
          await tx.execute(sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'tax_codes', ${code.rows[0]!.id}, 'insert',
                    ${JSON.stringify({ source: "tax_setup", after: { code: def.code, name: def.name, jurisdictionCode, country: subdivision.country, region: subdivision.region, appliesTo: "both", isActive: true } })}::jsonb,
                    ${actorId})`);
          for (const rate of def.rates) {
            const insertedRate = (await tx.execute<{ id: string }>(sql`
              insert into tax_rates
                (org_id, tax_code_id, rate_percent, effective_from, effective_to, created_by, updated_by)
              values (${orgId}, ${codeId}, ${persistPackRatePercent(rate.ratePercent)}, ${rate.effectiveFrom}, ${rate.effectiveTo ?? null}, ${actorId}, ${actorId})
              returning id`));
            await tx.execute(sql`
              insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
              values (${orgId}, 'tax_rates', ${insertedRate.rows[0]!.id}, 'insert',
                      ${JSON.stringify({ source: "tax_setup", taxCode: def.code, after: rate })}::jsonb,
                      ${actorId})`);
          }
        } else {
          const existingCode = (await tx.execute<{ id: string }>(sql`
            select id from tax_codes where org_id = ${orgId} and code = ${def.code} limit 1
          `));
          codeId = existingCode.rows[0]?.id ?? null;
        }
        if (!codeId) throw new Error(`tax code ${def.code} could not be created or resolved`);
        const staleSubdivisionCode = await refreshPackCodeRatesIfUnused({
          tx,
          orgId,
          codeId,
          jurisdictionId,
          country: subdivision.country,
          region: subdivision.region,
          packCode: localization?.code ?? subdivision.country,
          actorId,
          definition: def,
        });
        if (staleSubdivisionCode) {
          staleUsedCodes.push(staleSubdivisionCode);
        } else {
          await assertTaxCodeMatchesPack(tx, {
            orgId,
            codeId,
            jurisdictionId,
            country: subdivision.country,
            region: subdivision.region,
            definition: def,
          });
        }

        const groupCode = `${jurisdictionCode}-TAX`;
        const insertedGroup = (await tx.execute<{ id: string }>(sql`
          insert into tax_groups (org_id, code, name, is_active)
          select ${orgId}, ${groupCode}, ${`${subdivision.name} tax`}, true
           where not exists (select 1 from tax_groups where org_id = ${orgId} and code = ${groupCode})
          returning id`));
        const groupId = insertedGroup.rows[0]?.id ??
          ((await tx.execute<{ id: string }>(sql`
            select id from tax_groups where org_id = ${orgId} and code = ${groupCode} limit 1
          `))).rows[0]?.id ?? null;
        if (!groupId) {
          throw new Error(`tax group ${groupCode} could not be created or resolved`);
        }
        if (insertedGroup.rows[0]) taxGroupsCreated++;
        await tx.execute(sql`
          insert into tax_group_members (tax_group_id, tax_code_id, sequence)
          select ${groupId}, ${codeId}, 1
           where not exists (
               select 1 from tax_group_members
                where tax_group_id = ${groupId} and tax_code_id = ${codeId})`);
        if (insertedGroup.rows[0]) {
          await tx.execute(sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'tax_groups', ${insertedGroup.rows[0].id}, 'insert',
                    ${JSON.stringify({ source: "tax_setup", after: { code: groupCode, name: `${subdivision.name} tax`, taxCodes: [def.code], isActive: true } })}::jsonb,
                    ${actorId})`);
        }
      }
    }

    // Fail the whole installation atomically when a pack updates rates for
    // codes with filed history — rolled back like any other configuration
    // conflict, but naming every stale code and the required way out.
    if (staleUsedCodes.length > 0) {
      throw new Error(
        `country tax packs update statutory rate history for tax codes ${staleUsedCodes.join(", ")}, ` +
          `but documents in this organization already reference them; filed-history rates cannot be rewritten — ` +
          `archive or retire those usages, then re-run provisioning`,
      );
    }
  });

  // 2) Install the return forms + boxes (maps to the codes just created).
  await installTaxReturnPacks(orgId, packs.map((pack) => pack.code), actorId);

  // 3) Nexus registrations — one per jurisdiction/return, if not already present.
  let registrationsCreated = 0;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks:tax-setup:${orgId}`}, 0))`);
    for (const pack of packs.filter((entry) => PACK_DEFAULT_CODES[entry.code]?.rates?.length)) {
      const res = (await tx.execute<{ id: string }>(sql`
        insert into tax_registrations
          (org_id, jurisdiction_id, filing_frequency, return_form_code, is_active, created_by, updated_by)
        select ${orgId}, j.id, ${pack.defaultFrequency}, ${pack.code}, true, ${actorId}, ${actorId}
          from tax_jurisdictions j
         where j.org_id = ${orgId} and j.code = ${pack.jurisdiction.code}
           and not exists (
             select 1 from tax_registrations r
              where r.org_id = ${orgId} and r.jurisdiction_id = j.id and r.return_form_code = ${pack.code})
        returning id`));
      if (res.rows[0]) {
        registrationsCreated++;
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'tax_registrations', ${res.rows[0].id}, 'insert',
                  ${JSON.stringify({ source: "tax_setup", pack: pack.code, after: { jurisdictionCode: pack.jurisdiction.code, filingFrequency: pack.defaultFrequency, returnFormCode: pack.code, isActive: true } })}::jsonb,
                  ${actorId})`);
      }
    }

    for (const subdivision of subdivisions.filter((entry) => entry.createDraftRegistration)) {
      const jurisdictionCode = `${subdivision.country}-${subdivision.region}`;
      const res = (await tx.execute<{ id: string }>(sql`
        insert into tax_registrations
          (org_id, jurisdiction_id, filing_frequency, return_form_code, is_active, created_by, updated_by)
        select ${orgId}, j.id, 'quarterly', null, false, ${actorId}, ${actorId}
          from tax_jurisdictions j
         where j.org_id = ${orgId} and j.code = ${jurisdictionCode}
           and not exists (
             select 1 from tax_registrations r
              where r.org_id = ${orgId} and r.jurisdiction_id = j.id)
        returning id`));
      if (res.rows[0]) {
        registrationsCreated++;
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'tax_registrations', ${res.rows[0].id}, 'insert',
                  ${JSON.stringify({ source: "tax_setup", status: "draft", jurisdictionCode, after: { filingFrequency: "quarterly", returnFormCode: null, isActive: false } })}::jsonb,
                  ${actorId})`);
      }
    }
  });

  await recordCountryPackInstallations(orgId, localizedCountryPacks, actorId);

  return { packs: codes, jurisdictionsCreated, taxCodesCreated, taxGroupsCreated, registrationsCreated };
}
