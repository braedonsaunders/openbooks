import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { postEntry } from "../journal/post-entry.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  seedPostingAccount,
} from "../testing/fixtures.ts";
import { capitalizeCip, createCipRecord, linkCipCosts } from "./asset-cip.ts";
import { acceptAssetProposals, proposeJournalLine } from "./asset-proposals.ts";
import { AssetRefusal } from "./asset-refusal.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

for (const capability of ["cip", "proposals"] as const) {
  test(
    `${capability} capitalization replay enforces current permission, feature and legal-entity scope`,
    { skip: !DB },
    async () => {
      const org = await createScratchOrg();
      try {
        const actorId = await createScratchUser(org.orgId, "Asset accountant", "asset_accountant");
        await grantScratchPermissions(org.orgId, actorId, ["assets.capitalize"]);
        const replay = await withOrgContext(org.orgId, async () => {
          await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"fixedAssets":true,"assetProposals":true,"constructionInProgress":true}'::jsonb)
          where id = ${org.orgId}`);
          const source = await seedPostingAccount(
            org.orgId,
            "1650",
            "Capitalization source",
            capability === "cip" ? "asset_fixed" : "asset_current_other",
          );
          const asset = await seedPostingAccount(org.orgId, "1610", "Equipment", "asset_fixed");
          const accumulated = await seedPostingAccount(
            org.orgId,
            "1619",
            "Accumulated depreciation",
            "asset_fixed",
          );
          const expense = await seedPostingAccount(org.orgId, "6110", "Depreciation", "expense");
          const categoryId = randomUUID();
          await db.execute(sql`insert into asset_categories
          (id, org_id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id,
           gain_loss_account_id, default_method, default_life_months, default_convention, tax_attributes, is_active)
          values (${categoryId}, ${org.orgId}, 'Equipment', ${asset}, ${accumulated}, ${expense}, ${expense},
                  'straight_line', 60, 'full_month', '{}'::jsonb, true)`);
          const entry = await postEntry(db, {
            orgId: org.orgId,
            bookId: org.bookId,
            subsidiaryId: org.subsidiaryId,
            entryNumber: `CAPITALIZE-${randomUUID()}`,
            postingDate: org.date,
            periodId: org.periodId,
            origin: "manual",
            currency: "CAD",
            lines: [
              { accountId: source, amount: "100" },
              { accountId: org.accounts.bank, amount: "-100" },
            ],
          });
          if (capability === "cip") {
            const cip = await createCipRecord(org.orgId, {
              actorId,
              subsidiaryId: org.subsidiaryId,
              categoryId,
              name: "Equipment installation",
              cipAccountId: source,
            });
            await linkCipCosts(org.orgId, {
              actorId,
              cipAssetId: cip.id,
              journalLineIds: [entry.lines[0]!.id],
            });
            const request = {
              idempotencyKey: randomUUID(),
              cipAssetId: cip.id,
              capitalizedOn: org.date,
              reason: "Installation complete",
              lines: [{ kind: "asset" as const, name: "Equipment", categoryId, amount: "100" }],
            };
            await capitalizeCip(org.orgId, request, { actorId });
            return (allowedSubsidiaryIds: readonly string[] | null = null) =>
              capitalizeCip(org.orgId, request, { actorId, allowedSubsidiaryIds });
          }
          const proposal = await proposeJournalLine(org.orgId, {
            actorId,
            journalLineId: entry.lines[0]!.id,
            categoryId,
          });
          const request = {
            idempotencyKey: randomUUID(),
            operation: "asset" as const,
            proposalIds: [proposal.proposalId],
            acceptedOn: org.date,
            targets: [{ name: "Equipment", categoryId, amount: "100" }],
          };
          await acceptAssetProposals(org.orgId, request, { actorId });
          return (allowedSubsidiaryIds: readonly string[] | null = null) =>
            acceptAssetProposals(org.orgId, request, { actorId, allowedSubsidiaryIds });
        });
        const journalCount = async () =>
          (
            await withOrgContext(org.orgId, () =>
              db.execute<{ count: number }>(
                sql`
        select count(*)::int as count from journal_entries where org_id = ${org.orgId}`,
                "objects",
              ),
            )
          )[0]!.count;
        const count = await journalCount();
        assert.equal((await replay()).replayed, true);
        const refused = async (code: string, work: () => Promise<unknown>) => {
          await assert.rejects(
            work,
            (error: unknown) => error instanceof AssetRefusal && error.code === code,
          );
          assert.equal(await journalCount(), count, "replay refusals cannot change posted history");
        };
        await refused(capability === "cip" ? "cip_not_found" : "proposal_not_found", () =>
          replay([]),
        );
        await withOrgContext(org.orgId, () =>
          db.execute(sql`update app_roles
        set subsidiary_restriction = '{"mode":"list","subsidiaryIds":[]}'::jsonb
        where org_id = ${org.orgId} and key = 'asset_accountant'`),
        );
        await refused("subsidiary_scope", () => replay());
        await withOrgContext(org.orgId, async () => {
          await db.execute(
            sql`update app_roles set subsidiary_restriction = '{"mode":"all"}'::jsonb where org_id = ${org.orgId} and key = 'asset_accountant'`,
          );
          await db.execute(sql`update user_permission_overrides set effect = 'deny'
          where org_id = ${org.orgId} and user_id = ${actorId} and permission = 'assets.capitalize'`);
        });
        await refused("permission_required", () => replay());
        await grantScratchPermissions(org.orgId, actorId, ["assets.capitalize"]);
        await withOrgContext(org.orgId, () =>
          db.execute(sql`update orgs
        set settings = jsonb_set(settings, '{features,fixedAssets}', 'false'::jsonb) where id = ${org.orgId}`),
        );
        await refused("feature_disabled", () => replay());
      } finally {
        await dropScratchOrg(org.orgId);
      }
    },
  );
}
