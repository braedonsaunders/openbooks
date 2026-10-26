import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { errorChainMatches } from "../testing/error-chain.ts";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import {
  AccountingContextError,
  accountLocalizationWriteError,
  BASE_CHART_CONTEXT,
  loadAccountLabels,
  resolveAccountingContext,
} from "./accounting-contexts.ts";

// Accounting contexts relabel the chart for reporting: localized numbers
// and names by effective date, subsidiary-specific over organization-wide,
// explicit base-chart fallbacks, and refusals for unknown or ambiguous
// contexts. Postings never change.

const DB = !!process.env.OPENBOOKS_DB_URL;

async function setFeature(orgId: string, enabled: boolean): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ accountingContexts: enabled })}::jsonb)
     where id = ${orgId}`);
}

async function context(
  org: ScratchOrg,
  code: string,
): Promise<{ id: string; code: string; name: string }> {
  const id = randomUUID();
  await db.execute(
    sql`insert into accounting_contexts (id, org_id, code, name) values (${id}, ${org.orgId}, ${code}, ${`Statutory ${code}`})`,
  );
  return { id, code, name: `Statutory ${code}` };
}

async function localize(
  org: ScratchOrg,
  contextId: string,
  accountId: string,
  values: {
    number?: string | null;
    name?: string | null;
    from: string;
    to?: string | null;
    subsidiaryId?: string | null;
  },
) {
  await db.execute(sql`
    insert into account_localizations (org_id, context_id, account_id, subsidiary_id, localized_number, localized_name, effective_from, effective_to)
    values (${org.orgId}, ${contextId}, ${accountId}, ${values.subsidiaryId ?? null}, ${values.number ?? null}, ${values.name ?? null}, ${values.from}, ${values.to ?? null})`);
}

test(
  "labels follow the effective localization, prefer the subsidiary's, and mark base fallbacks",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await withBypassContext(async () => {
        await setFeature(org.orgId, true);
        const pcg = await context(org, "PCG");
        await localize(org, pcg.id, org.accounts.bank, {
          number: "512",
          name: "Banque",
          from: "2026-01-01",
          to: "2026-06-30",
        });
        await localize(org, pcg.id, org.accounts.bank, {
          number: "5121",
          name: "Banque principale",
          from: "2026-07-01",
        });
        await localize(org, pcg.id, org.accounts.revenue, { name: "Ventes", from: "2026-01-01" });
        await localize(org, pcg.id, org.accounts.revenue, {
          number: "706",
          name: "Prestations",
          from: "2026-01-01",
          subsidiaryId: org.subsidiaryId,
        });

        const june = await loadAccountLabels(db, org.orgId, pcg, { asOf: "2026-06-15" });
        assert.deepEqual(june.get(org.accounts.bank), {
          number: "512",
          name: "Banque",
          localized: true,
        });
        const july = await loadAccountLabels(db, org.orgId, pcg, { asOf: "2026-07-15" });
        assert.deepEqual(july.get(org.accounts.bank), {
          number: "5121",
          name: "Banque principale",
          localized: true,
        });
        // Organization-wide name only: the base number stays, the row is localized.
        assert.equal(july.get(org.accounts.revenue)?.name, "Ventes");
        assert.equal(july.get(org.accounts.revenue)?.localized, true);
        // The subsidiary's own localization wins in that subsidiary's reports.
        const subsidiary = await loadAccountLabels(db, org.orgId, pcg, {
          asOf: "2026-07-15",
          subsidiaryId: org.subsidiaryId,
        });
        assert.deepEqual(subsidiary.get(org.accounts.revenue), {
          number: "706",
          name: "Prestations",
          localized: true,
        });
        // An account the context does not localize falls back explicitly.
        assert.equal(july.get(org.accounts.cogs)?.localized, false);
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "contexts resolve explicitly, by subsidiary or country default, or to the base chart",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await withBypassContext(async () => {
        await setFeature(org.orgId, true);
        const byCountry = await context(org, "CA-GAAP");
        const bySubsidiary = await context(org, "SUB");
        await db.execute(
          sql`insert into accounting_context_defaults (org_id, context_id, country) values (${org.orgId}, ${byCountry.id}, 'CA')`,
        );
        assert.equal(
          (await resolveAccountingContext(db, org.orgId, { subsidiaryId: org.subsidiaryId }))
            .context?.id,
          byCountry.id,
        );
        await db.execute(
          sql`insert into accounting_context_defaults (org_id, context_id, subsidiary_id) values (${org.orgId}, ${bySubsidiary.id}, ${org.subsidiaryId})`,
        );
        const resolved = await resolveAccountingContext(db, org.orgId, {
          subsidiaryId: org.subsidiaryId,
        });
        assert.equal(resolved.context?.id, bySubsidiary.id);
        assert.equal(resolved.source, "subsidiary");
        assert.equal(
          (
            await resolveAccountingContext(db, org.orgId, {
              requested: BASE_CHART_CONTEXT,
              subsidiaryId: org.subsidiaryId,
            })
          ).context,
          null,
        );
        assert.equal(
          (await resolveAccountingContext(db, org.orgId, { requested: byCountry.id })).context?.id,
          byCountry.id,
        );
        await assert.rejects(
          resolveAccountingContext(db, org.orgId, { requested: randomUUID() }),
          (error: unknown) =>
            error instanceof AccountingContextError && error.code === "accounting_context_unknown",
        );
        await setFeature(org.orgId, false);
        assert.equal(
          (await resolveAccountingContext(db, org.orgId, { subsidiaryId: org.subsidiaryId }))
            .context,
          null,
        );
        await assert.rejects(
          resolveAccountingContext(db, org.orgId, { requested: byCountry.id }),
          (error: unknown) =>
            error instanceof AccountingContextError &&
            error.code === "accounting_contexts_disabled",
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a localized number belongs to one account per scope and period, and ambiguity refuses the report",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const other = await createScratchOrg();
    try {
      await withBypassContext(async () => {
        await setFeature(org.orgId, true);
        const pcg = await context(org, "PCG");
        await localize(org, pcg.id, org.accounts.bank, { number: "512", from: "2026-01-01" });
        // Same scope, overlapping window: storage refuses.
        await assert.rejects(
          localize(org, pcg.id, org.accounts.cogs, { number: "512", from: "2026-03-01" }),
          (error: unknown) =>
            errorChainMatches(error, /account_localizations_unique_number|conflicting key/),
        );
        // Setup refuses a subsidiary-specific clash with an organization-wide number.
        const clash = await accountLocalizationWriteError(db, org.orgId, {
          contextId: pcg.id,
          accountId: org.accounts.cogs,
          subsidiaryId: org.subsidiaryId,
          localizedNumber: "512",
          localizedName: null,
          effectiveFrom: "2026-03-01",
          effectiveTo: null,
        });
        assert.match(clash ?? "", /already used by/);
        // Non-overlapping windows may reuse a number.
        assert.equal(
          await accountLocalizationWriteError(db, org.orgId, {
            contextId: pcg.id,
            accountId: org.accounts.cogs,
            subsidiaryId: null,
            localizedNumber: "512",
            localizedName: null,
            effectiveFrom: "2025-01-01",
            effectiveTo: "2025-12-31",
          }),
          null,
        );
        // Another organization's account or context is refused by name.
        assert.match(
          (await accountLocalizationWriteError(db, org.orgId, {
            contextId: pcg.id,
            accountId: other.accounts.bank,
            subsidiaryId: null,
            localizedNumber: "999",
            localizedName: null,
            effectiveFrom: "2026-01-01",
            effectiveTo: null,
          })) ?? "",
          /Choose an account of this company/,
        );
        // A clash that slipped in across scopes refuses the report rather than merging rows.
        await localize(org, pcg.id, org.accounts.cogs, {
          number: "512",
          from: "2026-01-01",
          subsidiaryId: org.subsidiaryId,
        });
        await assert.rejects(
          loadAccountLabels(db, org.orgId, pcg, {
            asOf: "2026-07-15",
            subsidiaryId: org.subsidiaryId,
          }),
          (error: unknown) =>
            error instanceof AccountingContextError &&
            error.code === "accounting_context_ambiguous",
        );
        // The organization-wide view is unaffected by the subsidiary's localization.
        await loadAccountLabels(db, org.orgId, pcg, { asOf: "2026-07-15" });
      });
    } finally {
      await dropScratchOrg(other.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);
