import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction, withOrgContext } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import { createDocument, applyDocumentEdit } from "../ledger/document-write.ts";
import { loadDocumentEditCurrent } from "../ledger/document-service.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";

installEngineSeams();
const DB = !!process.env.OPENBOOKS_DB_URL;

async function cloneFlags() {
  await db.execute(sql`select set_config('openbooks.clone','on',true),
    set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`);
}

for (const masked of [false, true])
  test(
    `${masked ? "masked" : "full"} sandbox copies recorded exchange rate evidence only from its exact source`,
    { skip: !DB },
    async () => {
      const org = await createScratchOrg();
      const name = `Recorded FX evidence ${randomUUID()}`;
      try {
        const actor = await createScratchUser(org.orgId, "Sandbox FX owner", "admin");
        await db.execute(
          sql`insert into currencies (code, name, minor_units) values ('USD', 'US Dollar', 2) on conflict (code) do nothing`,
        );
        await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"multiCurrency":true}'::jsonb)
      where id = ${org.orgId}`);
        const explicitFx = {
          rate: "1.35",
          source: "Bank confirmation",
          reason: "Contracted conversion for this shipment",
          fromCurrency: "USD",
          toCurrency: "CAD",
          rateDate: org.date,
        };
        const sources: Record<"vendor_bill" | "customer_invoice", string> = {
          vendor_bill: "",
          customer_invoice: "",
        };
        await withOrgContext(org.orgId, async () => {
          for (const [kind, partyId, accountId] of [
            ["vendor_bill", org.vendorId, org.accounts.cogs],
            ["customer_invoice", org.customerId, org.accounts.revenue],
          ] as const) {
            const body = {
              partyId,
              documentDate: org.date,
              currency: "USD",
              lines: [{ accountId, amount: "100" }],
            };
            const created = await createDocument({
              orgId: org.orgId,
              userId: actor,
              kind,
              key: randomUUID(),
              body,
              subsidiaryId: org.subsidiaryId,
              requestBody: body,
            });
            const current = (await loadDocumentEditCurrent(created.id, org.orgId))!;
            await applyDocumentEdit(
              created.id,
              current,
              { expectedUpdatedAt: current.updatedAt, explicitFx },
              { orgId: org.orgId, userId: actor, source: "ui", runFlows: false },
            );
            sources[kind] = created.id;
          }
        });

        // Evidence is never inserted outside native copying.
        await assert.rejects(
          db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate,
         subtotal, tax_total, total, created_by, document_fx_rate_evidence)
      values (${randomUUID()}, ${org.orgId}, 'vendor_bill', 'draft', 'INSERTED-FX', ${org.subsidiaryId}, ${org.vendorId},
              ${org.date}, 'USD', 1.35, 0, 0, 0, ${actor},
              ${JSON.stringify({ version: 1, ...explicitFx, subsidiaryId: org.subsidiaryId })}::jsonb)`),
          (error) => errorChainMatches(error, /recorded on a draft through the document editor/),
        );

        const created = await createSandbox({
          productionOrgId: org.orgId,
          name,
          tier: masked ? "masked" : "full",
          masked,
          createdBy: actor,
          lifecycleAuthority: { actorId: actor },
        });
        const target = created.sandboxOrgId;
        const rebased = (
          await db.execute<{ subsidiary: string }>(
            sql`
      select ob_rebase(${org.subsidiaryId}::uuid, sandbox_seed)::text as subsidiary from orgs where id = ${target}`,
            "objects",
          )
        )[0]!.subsidiary;
        const expected = {
          version: 1,
          ...explicitFx,
          subsidiaryId: rebased,
          ...(masked ? { source: "REDACTED", reason: "REDACTED" } : {}),
        };
        for (const id of Object.values(sources)) {
          const copied = (
            await db.execute<{ evidence: unknown; fx_rate: string }>(
              sql`
        select d.document_fx_rate_evidence as evidence, d.fx_rate::text as fx_rate
          from documents d join orgs o on o.id = d.org_id
         where d.org_id = ${target} and d.id = ob_rebase(${id}::uuid, o.sandbox_seed)`,
              "objects",
            )
          )[0]!;
          assert.deepEqual(
            copied,
            { evidence: expected, fx_rate: "1.3500000000" },
            "the copy keeps the exact rate, currencies and date with its rebased legal entity",
          );
        }

        await withMaintenanceTransaction(null, async () => {
          await cloneFlags();
          const matches = await db.execute<{
            kind: string;
            exact: boolean;
            other_source: boolean;
            other_rate_date: boolean;
            dropped: boolean;
            sales: boolean | null;
            sales_altered: boolean | null;
          }>(
            sql`
        select d.kind,
          document_fx_rate_evidence_clone_matches(d) as exact,
          document_fx_rate_evidence_clone_matches(jsonb_populate_record(null::documents, to_jsonb(d)
            || jsonb_build_object('document_fx_rate_evidence', d.document_fx_rate_evidence || '{"source":"Another source"}'::jsonb))) as other_source,
          document_fx_rate_evidence_clone_matches(jsonb_populate_record(null::documents, to_jsonb(d)
            || jsonb_build_object('document_fx_rate_evidence', d.document_fx_rate_evidence || '{"rateDate":"2026-07-14"}'::jsonb))) as other_rate_date,
          document_fx_rate_evidence_clone_matches(jsonb_populate_record(null::documents, to_jsonb(d)
            || jsonb_build_object('document_fx_rate_evidence', null))) as dropped,
          case when d.kind = 'customer_invoice' then sales_document_clone_matches(d) end as sales,
          case when d.kind = 'customer_invoice' then sales_document_clone_matches(jsonb_populate_record(null::documents, to_jsonb(d)
            || jsonb_build_object('document_fx_rate_evidence', d.document_fx_rate_evidence || '{"reason":"Substituted copied reason"}'::jsonb))) end as sales_altered
          from documents d join orgs o on o.id = d.org_id
         where d.org_id = ${target} and d.id in (ob_rebase(${sources.vendor_bill}::uuid, o.sandbox_seed), ob_rebase(${sources.customer_invoice}::uuid, o.sandbox_seed))
         order by d.kind`,
            "objects",
          );
          assert.deepEqual(
            matches,
            [
              {
                kind: "customer_invoice",
                exact: true,
                other_source: false,
                other_rate_date: false,
                dropped: false,
                sales: true,
                sales_altered: false,
              },
              {
                kind: "vendor_bill",
                exact: true,
                other_source: false,
                other_rate_date: false,
                dropped: false,
                sales: null,
                sales_altered: null,
              },
            ],
            "clone authority admits only the source's exact projected evidence",
          );

          // A document with no source in the production organization cannot
          // carry evidence under clone authority either.
          await assert.rejects(
            db.execute(sql`insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate,
           subtotal, tax_total, total, document_fx_rate_evidence)
        select ${randomUUID()}, ${target}, 'vendor_bill', 'draft', 'FORGED-FX', ob_rebase(${org.subsidiaryId}::uuid, o.sandbox_seed),
               ob_rebase(${org.vendorId}::uuid, o.sandbox_seed), ${org.date}, 'USD', 1.35, 0, 0, 0,
               ${JSON.stringify(expected)}::jsonb
          from orgs o where o.id = ${target}`),
            (error) => errorChainMatches(error, /must retain its source document's exact evidence/),
          );
        });
        await deleteSandbox(created.sandboxId, { actorId: actor });
      } finally {
        const shells = await db.execute<{ id: string }>(
          sql`select id from sandboxes where production_org_id = ${org.orgId} and name = ${name}`,
          "objects",
        );
        for (const shell of shells)
          await deleteSandbox(shell.id, {
            systemReason: "Remove recorded exchange rate clone fixture",
          });
        await dropScratchOrg(org.orgId);
      }
    },
  );
