import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { createDocument, applyDocumentEdit } from "./document-write.ts";
import { loadDocumentEditCurrent } from "./document-service.ts";
import { postDocument } from "./posting-document.ts";
import type { DocumentEditInput } from "./document-input.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

async function usdBill(
  orgId: string,
  actor: string,
  vendorId: string,
  accountId: string,
  subsidiaryId: string,
  date: string,
) {
  const body = {
    partyId: vendorId,
    documentDate: date,
    currency: "USD",
    lines: [{ accountId, amount: "100" }],
  };
  return createDocument({
    orgId,
    userId: actor,
    kind: "vendor_bill",
    key: randomUUID(),
    body,
    subsidiaryId,
    requestBody: body,
  });
}

async function stored(orgId: string, id: string) {
  return (
    await db.execute<{ fx_rate: string; evidence: Record<string, unknown> | null }>(
      sql`
    select fx_rate::text as fx_rate, document_fx_rate_evidence as evidence
      from documents where org_id = ${orgId} and id = ${id}`,
      "objects",
    )
  )[0]!;
}

test(
  "an explicit bill rate is bound to its posting identity, posts its own entity and freezes with the bill",
  enabled,
  async () => {
    const org = await createScratchOrg();
    try {
      await withOrgContext(org.orgId, async () => {
        const actor = await createScratchUser(org.orgId, "FX accountant", "admin");
        await db.execute(
          sql`insert into currencies (code, name, minor_units) values ('USD', 'US Dollar', 2) on conflict (code) do nothing`,
        );
        await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"multiCurrency":true}'::jsonb)
      where id = ${org.orgId}`);
        const created = await usdBill(
          org.orgId,
          actor,
          org.vendorId,
          org.accounts.cogs,
          org.subsidiaryId,
          org.date,
        );
        const edit = async (patch: Omit<DocumentEditInput, "expectedUpdatedAt">) => {
          const current = (await loadDocumentEditCurrent(created.id, org.orgId))!;
          await applyDocumentEdit(
            created.id,
            current,
            { expectedUpdatedAt: current.updatedAt, ...patch },
            { orgId: org.orgId, userId: actor, source: "ui", runFlows: false },
          );
        };
        const explicitFx = {
          rate: "1.35",
          source: "Bank confirmation",
          reason: "Contracted conversion for this shipment",
          fromCurrency: "USD",
          toCurrency: "CAD",
          rateDate: org.date,
        };

        await assert.rejects(
          edit({ explicitFx: { ...explicitFx, toCurrency: "EUR" } }),
          /must convert USD to CAD/,
        );
        await edit({ explicitFx });
        let row = await stored(org.orgId, created.id);
        assert.equal(row.fx_rate, "1.3500000000");
        assert.deepEqual(row.evidence, {
          version: 1,
          ...explicitFx,
          subsidiaryId: org.subsidiaryId,
        });
        const audit = (
          await db.execute<{ before: unknown; after: unknown }>(
            sql`
      select changes->'before'->'document'->'document_fx_rate_evidence' as before,
             changes->'after'->'document'->'document_fx_rate_evidence' as after
        from audit_log where org_id = ${org.orgId} and table_name = 'documents' and row_id = ${created.id} and action = 'update'
       order by at desc limit 1`,
            "objects",
          )
        )[0];
        assert.deepEqual(
          [audit?.before, audit?.after],
          [null, row.evidence],
          "the recorded rate is in the audited before/after state",
        );

        // Moving the posting date without a replacement refuses; a replacement
        // recorded with the move binds the new date.
        await assert.rejects(
          edit({ documentDate: "2026-07-16" }),
          /previous posting date; record a rate for the new posting date/,
        );
        await edit({
          documentDate: "2026-07-16",
          explicitFx: { ...explicitFx, rate: "1.36", rateDate: "2026-07-16" },
        });
        row = await stored(org.orgId, created.id);
        assert.equal(row.fx_rate, "1.3600000000");
        assert.equal(row.evidence?.rateDate, "2026-07-16");

        await db.execute(
          sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${created.id}`,
        );
        // Approval freezes the evidence; only a return to draft reopens it.
        await assert.rejects(
          db.execute(
            sql`update documents set document_fx_rate_evidence = null, fx_rate = 1 where org_id = ${org.orgId} and id = ${created.id}`,
          ),
          (error) =>
            errorChainMatches(error, /recorded exchange rate evidence changes only on a draft/),
        );
        const entry = await postDocument(created.id, {
          control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
        });
        const lines = await db.execute<{ account_id: string; amount: string; fx_rate: string }>(
          sql`
      select account_id, amount::text as amount, fx_rate::text as fx_rate from journal_lines
       where org_id = ${org.orgId} and entry_id = ${entry} order by line_number`,
          "objects",
        );
        assert.deepEqual(
          lines.map((line) => [line.account_id, line.amount]).sort(),
          [
            [org.accounts.cogs, "136.0000"],
            [org.accounts.ap, "-136.0000"],
          ].sort(),
        );
        row = await stored(org.orgId, created.id);
        assert.equal(
          row.fx_rate,
          "1.3600000000",
          "posting keeps the recorded rate as the document rate",
        );

        const history = async () =>
          (
            await db.execute<{ evidence: unknown; audits: number; entries: number }>(
              sql`
      select d.document_fx_rate_evidence as evidence,
             (select count(*)::int from audit_log a where a.org_id = d.org_id and a.table_name = 'documents' and a.row_id = d.id) as audits,
             (select count(*)::int from journal_entries e where e.org_id = d.org_id and e.source_document_id = d.id) as entries
        from documents d where d.org_id = ${org.orgId} and d.id = ${created.id}`,
              "objects",
            )
          )[0]!;
        const recorded = await history();
        await assert.rejects(
          db.execute(
            sql`update documents set document_fx_rate_evidence = null where org_id = ${org.orgId} and id = ${created.id}`,
          ),
          (error) =>
            errorChainMatches(error, /recorded exchange rate evidence changes only on a draft/),
        );
        // The governed amendment setting admits no evidence change either.
        await assert.rejects(
          withMaintenanceTransaction(null, async () => {
            await db.execute(sql`select set_config('openbooks.amend', 'on', true)`);
            await db.execute(sql`update documents set document_fx_rate_evidence = ${JSON.stringify({ ...(recorded.evidence as object), source: "Amended source" })}::jsonb
        where org_id = ${org.orgId} and id = ${created.id}`);
          }),
          (error) =>
            errorChainMatches(error, /recorded exchange rate evidence changes only on a draft/),
        );
        assert.deepEqual(
          await history(),
          recorded,
          "the posted evidence, its audit trail and its ledger history are unchanged",
        );
        await assert.rejects(
          db.execute(
            sql`update documents set fx_rate = 1.4 where org_id = ${org.orgId} and id = ${created.id}`,
          ),
          (error) => errorChainMatches(error, /immutable outside the governed amend path/),
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "clearing an explicit rate returns the bill to the exchange rates and leaves other rates untouched",
  enabled,
  async () => {
    const org = await createScratchOrg();
    try {
      await withOrgContext(org.orgId, async () => {
        const actor = await createScratchUser(org.orgId, "FX accountant", "admin");
        await db.execute(
          sql`insert into currencies (code, name, minor_units) values ('USD', 'US Dollar', 2) on conflict (code) do nothing`,
        );
        await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"multiCurrency":true}'::jsonb)
      where id = ${org.orgId}`);
        const created = await usdBill(
          org.orgId,
          actor,
          org.vendorId,
          org.accounts.cogs,
          org.subsidiaryId,
          org.date,
        );
        const edit = async (patch: Omit<DocumentEditInput, "expectedUpdatedAt">) => {
          const current = (await loadDocumentEditCurrent(created.id, org.orgId))!;
          await applyDocumentEdit(
            created.id,
            current,
            { expectedUpdatedAt: current.updatedAt, ...patch },
            { orgId: org.orgId, userId: actor, source: "ui", runFlows: false },
          );
        };
        await edit({
          explicitFx: {
            rate: "1.35",
            source: "Bank confirmation",
            reason: "Contracted conversion for this shipment",
            fromCurrency: "USD",
            toCurrency: "CAD",
            rateDate: org.date,
          },
        });
        await edit({ explicitFx: null });
        assert.deepEqual(await stored(org.orgId, created.id), {
          fx_rate: "1.0000000000",
          evidence: null,
        });

        // A rate the document carries without recorded evidence is not evidence
        // to clear: null leaves it as it is.
        await db.execute(
          sql`update documents set fx_rate = 1.33 where org_id = ${org.orgId} and id = ${created.id}`,
        );
        await edit({ explicitFx: null, memo: "Reviewed" });
        assert.deepEqual(await stored(org.orgId, created.id), {
          fx_rate: "1.3300000000",
          evidence: null,
        });

        // Storage refuses evidence that does not match the document it is on.
        await assert.rejects(
          db.execute(sql`
      update documents set document_fx_rate_evidence = ${JSON.stringify({
        version: 1,
        rate: "1.35",
        source: "Bank",
        reason: "Mismatched stored rate",
        fromCurrency: "USD",
        toCurrency: "CAD",
        rateDate: org.date,
        subsidiaryId: org.subsidiaryId,
      })}::jsonb
       where org_id = ${org.orgId} and id = ${created.id}`),
          (error) => errorChainMatches(error, /documents_fx_rate_evidence_bound/),
        );

        // Every required key is required: evidence missing one, or carrying it
        // as JSON null, is refused rather than evaluating to unknown. The
        // complete object matching the document is admitted.
        const complete = {
          version: 1,
          rate: "1.33",
          source: "Bank confirmation",
          reason: "Contracted conversion for this shipment",
          fromCurrency: "USD",
          toCurrency: "CAD",
          rateDate: org.date,
          subsidiaryId: org.subsidiaryId,
        };
        const write = (evidence: unknown) =>
          db.execute(sql`
      update documents set document_fx_rate_evidence = ${JSON.stringify(evidence)}::jsonb
       where org_id = ${org.orgId} and id = ${created.id}`);
        for (const key of Object.keys(complete) as (keyof typeof complete)[]) {
          const { [key]: _omitted, ...missing } = complete;
          await assert.rejects(
            write(missing),
            (error) => errorChainMatches(error, /documents_fx_rate_evidence_bound/),
            `missing ${key} is refused`,
          );
          await assert.rejects(
            write({ ...complete, [key]: null }),
            (error) => errorChainMatches(error, /documents_fx_rate_evidence_bound/),
            `null ${key} is refused`,
          );
        }
        await assert.rejects(write({ ...complete, note: "extra" }), (error) =>
          errorChainMatches(error, /documents_fx_rate_evidence_bound/),
        );
        await assert.rejects(
          write("1.33"),
          (error) => errorChainMatches(error, /documents_fx_rate_evidence_bound/),
          "a scalar is not evidence",
        );
        await write(complete);
        assert.deepEqual((await stored(org.orgId, created.id)).evidence, complete);
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
