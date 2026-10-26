import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  seedApprovalFlow,
  seedPostingAccount,
} from "../testing/fixtures.ts";
import { ScopeNotFoundError, UnrestrictedScopeError } from "../organization/subsidiary-scope.ts";
import { resolveReceiptFunding } from "../payments-core/receipt-funding.ts";
import { withOrgTransaction } from "../platform/db.ts";
import { decideGate } from "../flows/gates.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { openItemsForParty } from "./payment-queries.ts";
import { sameCurrencyAllocation } from "./settlement-policy.ts";
import { receiptFundingAccountOptions, saveProcessorReceiptPolicy } from "./processor-receipts.ts";
import { importSettlementBatch, postSettlementBatch } from "./psp-settlement.ts";
import { settleHarness, invoiceOpen } from "./refund-test-fixtures.ts";
import { saveAcceptanceConfig } from "./acceptance.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture(org: Awaited<ReturnType<typeof createScratchOrg>>, currency = "CAD") {
  // The invoice carries its own agreed rate. Receipt collection still needs
  // an independent dated quote from the native exchange-rate policy.
  const h = await settleHarness(org, {
    invoiceTotal: "459.96",
    currency,
    ...(currency === "USD" ? { invoiceFxRate: "1.25" } : {}),
  });
  await grantScratchPermissions(org.orgId, h.userId, ["ar.pay", "ap.pay", "admin.setup.manage"]);
  const clearing = await seedPostingAccount(
    org.orgId,
    "1040",
    "Processor clearing",
    "asset_current_other",
  );
  await db.execute(
    sql`update accounts set reconcilable = false where org_id = ${org.orgId} and id = ${clearing}`,
  );
  const policy = {
    id: randomUUID(),
    accountId: clearing,
    subsidiaryId: org.subsidiaryId,
    currency,
    effectiveFrom: org.date,
    effectiveTo: null,
  };
  await saveProcessorReceiptPolicy(
    org.orgId,
    "stripe",
    policy,
    h.userId,
    "Collect card receipts into the provider clearing pool",
    null,
  );
  const receipt = await createPaymentDocument({
    orgId: org.orgId,
    kind: "customer_payment",
    createdBy: h.userId,
    allowedSubsidiaryIds: null,
    partyId: org.customerId,
    bankAccountId: clearing,
    subsidiaryId: org.subsidiaryId,
    currency,
    documentDate: org.date,
  });
  const item = (
    await withOrgTransaction(org.orgId, () =>
      openItemsForParty(org.customerId, "ar", org.orgId, null),
    )
  ).find((row) => row.documentId === h.invoiceId)!;
  const save = () =>
    updateDraftPayment(
      receipt.id,
      { allocations: [sameCurrencyAllocation(item.lineId, "459.96")] },
      h.userId,
      org.orgId,
      { allowedSubsidiaryIds: null },
    );
  return { h, clearing, policy, receipt, save };
}

test(
  "a scoped processor receipt applies the invoice and the native payout clears its exact pool once",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { h, clearing, receipt, save, policy } = await fixture(org);
      const options = {
        orgId: org.orgId,
        actorId: h.userId,
        kind: "customer_payment" as const,
        subsidiaryId: org.subsidiaryId,
        currency: "CAD",
        onDate: org.date,
        allowedSubsidiaryIds: null,
      };
      assert.ok(
        (await receiptFundingAccountOptions(options)).some(
          (row) => row.id === clearing && row.provider === "stripe",
        ),
      );
      assert.ok(
        !(await receiptFundingAccountOptions({ ...options, kind: "vendor_payment" })).some(
          (row) => row.id === clearing,
        ),
      );
      const saved = await save();
      assert.equal(
        (saved!.doc.custom as { processorFunding: { id: string } }).processorFunding.id,
        policy.id,
      );
      await submitAndReleaseIfUngated("customer_payment", receipt.id, h.userId);
      await postPaymentWithApplications(receipt.id, undefined, h.userId, "api");
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      const batch = await importSettlementBatch(
        org.orgId,
        h.userId,
        {
          provider: "stripe",
          externalRef: `processor-${randomUUID()}`,
          settlementDate: org.date,
          currency: "CAD",
          raw: {},
          lines: [
            { kind: "charge", amount: "459.96", currency: "CAD", documentId: receipt.id },
            { kind: "fee", amount: "18.44", currency: "CAD" },
          ],
        },
        {
          bankAccountId: org.accounts.bank,
          clearingAccountId: clearing,
          feeAccountId: org.accounts.freight,
          subsidiaryId: org.subsidiaryId,
        },
      );
      const posted = await postSettlementBatch(org.orgId, batch.batchId, h.userId, null);
      assert.deepEqual(await postSettlementBatch(org.orgId, batch.batchId, h.userId, null), posted);
      const balance = async (accountId: string) =>
        (
          await db.execute<{ amount: string }>(
            sql`
      select coalesce(sum(jl.amount),0)::numeric(19,4)::text as amount from journal_lines jl
        join journal_entries e on e.id = jl.entry_id and e.org_id = jl.org_id and e.status in ('posted','reversed')
       where jl.org_id = ${org.orgId} and jl.account_id = ${accountId}`,
            "objects",
          )
        )[0]!.amount;
      assert.equal(await balance(clearing), "0.0000");
      assert.equal(await balance(org.accounts.bank), "441.5200");
      assert.equal(await balance(org.accounts.freight), "18.4400");
      assert.deepEqual(
        (
          await db.execute<{ type: string; reconcilable: boolean }>(
            sql`select type, reconcilable from accounts
      where org_id = ${org.orgId} and id = ${clearing}`,
            "objects",
          )
        )[0],
        { type: "asset_current_other", reconcilable: false },
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a foreign-currency processor receipt refuses missing quotes and retains its approved functional basis on posting replay",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { h, clearing, receipt, save } = await fixture(org, "USD");
      await assert.rejects(save(), /No spot exchange rate converts USD to CAD/);
      assert.equal(
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from document_lines
      where org_id = ${org.orgId} and document_id = ${receipt.id}`,
            "objects",
          )
        )[0]!.count,
        0,
      );
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, rate, as_of, source)
      values (${org.orgId}, 'USD', 'CAD', '1.25', ${org.date}, 'manual')`);
      const saved = await save();
      assert.equal(saved!.doc.fx_rate, "1.2500000000");
      const custom = saved!.doc.custom as {
        paymentCurrencyEvidence: { rate: string; observations: { storedRate: string }[] };
      };
      assert.equal(custom.paymentCurrencyEvidence.observations[0]!.storedRate, "1.2500000000");
      await submitAndReleaseIfUngated("customer_payment", receipt.id, h.userId);
      await db.execute(
        sql`update fx_rates set rate = '1.4' where org_id = ${org.orgId} and from_currency = 'USD' and to_currency = 'CAD'`,
      );
      const posted = await postPaymentWithApplications(receipt.id, undefined, h.userId, "api", {
        deferEffects: true,
      });
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from posting_effects
      where org_id = ${org.orgId} and document_id = ${receipt.id}`,
            "objects",
          )
        )[0]!.status,
        "pending",
      );
      const accounting = async () =>
        (
          await db.execute<{
            entries: number;
            applications: number;
            links: number;
            payment_audits: number;
          }>(
            sql`
      select (select count(*)::int from journal_entries where org_id = ${org.orgId}) as entries,
        (select count(*)::int from applications where org_id = ${org.orgId}) as applications,
        (select count(*)::int from document_links where org_id = ${org.orgId}) as links,
        (select count(*)::int from audit_log where org_id = ${org.orgId} and table_name = 'documents' and row_id = ${receipt.id}) as payment_audits`,
            "objects",
          )
        )[0]!;
      const original = await accounting();
      const effect = async () =>
        (
          await db.execute<{ id: string; status: string; attempt_count: number }>(
            sql`
      select id, status, attempt_count from posting_effects where org_id = ${org.orgId} and document_id = ${receipt.id}`,
            "objects",
          )
        )[0]!;
      const pending = await effect();
      await db.execute(
        sql`update orgs set settings = jsonb_set(settings, '{features,banking}', 'false'::jsonb) where id = ${org.orgId}`,
      );
      await assert.rejects(
        postPaymentWithApplications(receipt.id, undefined, h.userId),
        /Enable Banking/,
      );
      assert.deepEqual(
        await effect(),
        pending,
        "disabled Banking refuses before claiming or draining the native receipt effect",
      );
      assert.deepEqual(await accounting(), original);
      await db.execute(
        sql`update orgs set settings = jsonb_set(settings, '{features,banking}', 'true'::jsonb) where id = ${org.orgId}`,
      );
      assert.deepEqual(await postPaymentWithApplications(receipt.id, undefined, h.userId), posted);
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from posting_effects
      where org_id = ${org.orgId} and document_id = ${receipt.id}`,
            "objects",
          )
        )[0]!.status,
        "succeeded",
        "posted replay drains the actual native receipt effect",
      );
      const item = (
        saved!.doc.custom as { allocations: Parameters<typeof postPaymentWithApplications>[1] }
      ).allocations![0]!;
      await assert.rejects(
        postPaymentWithApplications(
          receipt.id,
          [{ ...item, settlementRateReference: "Changed collection contract" }],
          h.userId,
        ),
        /posted document/,
      );
      await db.execute(sql`update user_permission_overrides set effect = 'deny' where org_id = ${org.orgId}
      and user_id = ${h.userId} and permission = 'ar.pay'`);
      await assert.rejects(
        postPaymentWithApplications(receipt.id, undefined, h.userId),
        ScopeNotFoundError,
      );
      await grantScratchPermissions(org.orgId, h.userId, ["ar.pay"]);
      await db.execute(sql`update app_roles set subsidiary_restriction = '{"mode":"list","subsidiaryIds":[]}'::jsonb
      where org_id = ${org.orgId} and key = 'admin'`);
      await assert.rejects(
        postPaymentWithApplications(receipt.id, undefined, h.userId),
        ScopeNotFoundError,
      );
      await db.execute(
        sql`update app_roles set subsidiary_restriction = '{"mode":"all"}'::jsonb where org_id = ${org.orgId} and key = 'admin'`,
      );
      await assert.rejects(postPaymentWithApplications(receipt.id), /authorized posting actor/);
      // Historical accounting does not depend on the current collection policy.
      await db.execute(
        sql`update psp_provider_configs set is_enabled = false where org_id = ${org.orgId} and provider = 'stripe'`,
      );
      assert.deepEqual(await postPaymentWithApplications(receipt.id, undefined, h.userId), posted);
      assert.deepEqual(
        await accounting(),
        original,
        "replay and refusals cannot allocate cash, links, journals or payment audit again",
      );
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      const amount = (
        await db.execute<{ amount: string }>(
          sql`select jl.amount::text as amount from journal_lines jl
      join journal_entries e on e.id = jl.entry_id and e.org_id = jl.org_id
      where jl.org_id = ${org.orgId} and e.source_document_id = ${receipt.id} and jl.account_id = ${clearing}`,
          "objects",
        )
      )[0]!.amount;
      assert.equal(amount, "574.9500");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "processor receipt policy refuses overlap, foreign scope, currency and unauthorized configuration",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const other = await createScratchOrg();
    try {
      const { h, clearing, policy } = await fixture(org);
      assert.deepEqual(
        await saveProcessorReceiptPolicy(
          org.orgId,
          "stripe",
          policy,
          h.userId,
          "Retry the original receipt policy",
          null,
        ),
        policy,
      );
      await assert.rejects(
        saveProcessorReceiptPolicy(
          org.orgId,
          "stripe",
          { ...policy, id: randomUUID() },
          h.userId,
          "Duplicate effective policy",
          null,
        ),
        /overlap/,
      );
      await assert.rejects(
        saveProcessorReceiptPolicy(
          org.orgId,
          "stripe",
          policy,
          h.userId,
          "Restricted setup authority",
          new Set(),
        ),
        UnrestrictedScopeError,
      );
      await assert.rejects(
        saveProcessorReceiptPolicy(
          org.orgId,
          "stripe",
          { ...policy, subsidiaryId: other.subsidiaryId },
          h.userId,
          "Wrong legal entity",
          null,
        ),
        ScopeNotFoundError,
      );
      const resolve = (changes = {}) =>
        withOrgTransaction(org.orgId, () =>
          resolveReceiptFunding(db, {
            orgId: org.orgId,
            accountId: clearing,
            kind: "customer_payment",
            subsidiaryId: org.subsidiaryId,
            currency: "CAD",
            onDate: org.date,
            allowedSubsidiaryIds: null,
            ...changes,
          }),
        );
      await assert.rejects(resolve({ currency: "USD" }), /No unique effective/);
      await assert.rejects(resolve({ onDate: "2000-01-01" }), /No unique effective/);
      await assert.rejects(resolve({ allowedSubsidiaryIds: new Set() }), /not available/);
      await assert.rejects(
        resolve({ snapshot: { ...policy, id: randomUUID(), provider: "stripe" } }),
        /funding changed/,
      );
      await db.execute(
        sql`update user_permission_overrides set effect = 'deny' where org_id = ${org.orgId} and user_id = ${h.userId} and permission = 'admin.setup.manage'`,
      );
      await assert.rejects(
        saveProcessorReceiptPolicy(
          org.orgId,
          "stripe",
          policy,
          h.userId,
          "Revoked setup authority",
          null,
        ),
        ScopeNotFoundError,
      );
      const count = (
        await db.execute<{ count: number }>(
          sql`select count(*)::int as count from audit_log where org_id = ${org.orgId}
      and changes->>'mode' = 'processor_receipt_policy'`,
          "objects",
        )
      )[0]!.count;
      assert.equal(
        count,
        1,
        "refusals and an identical configuration retry cannot write new financial policy",
      );
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);

test(
  "a refused receipt policy rolls back provider initialization when its caller retains the transaction",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(
        org.orgId,
        "Receipt administrator",
        "receipt_administrator",
      );
      await grantScratchPermissions(org.orgId, actorId, ["admin.setup.manage"]);
      await withOrgTransaction(org.orgId, async () => {
        await assert.rejects(
          saveProcessorReceiptPolicy(
            org.orgId,
            "square",
            {
              id: randomUUID(),
              accountId: org.accounts.bank,
              subsidiaryId: org.subsidiaryId,
              currency: "CAD",
              effectiveFrom: org.date,
              effectiveTo: null,
            },
            actorId,
            "Configure processor-funded customer receipts",
            null,
          ),
          /other-current-asset/,
        );
        assert.equal(
          (
            await db.execute<{ count: number }>(
              sql`select count(*)::int as count from psp_provider_configs
        where org_id = ${org.orgId} and provider = 'square'`,
              "objects",
            )
          )[0]!.count,
          0,
        );
        assert.equal(
          (
            await db.execute<{ count: number }>(
              sql`select count(*)::int as count from audit_log
        where org_id = ${org.orgId} and changes->>'mode' = 'processor_receipt_policy'`,
              "objects",
            )
          )[0]!.count,
          0,
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "concurrent native provider edits preserve dated receipt funding and its independent settings",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { h, policy } = await fixture(org);
      const next = { ...policy, id: randomUUID(), currency: "USD" };
      await Promise.all([
        withBypassContext(() =>
          saveAcceptanceConfig(
            org.orgId,
            h.userId,
            {
              provider: "stripe",
              isEnabled: true,
              acceptanceEnabled: true,
              defaultBankAccountId: org.accounts.bank,
              settings: { statementDescriptor: "NATIVE RECEIPTS" },
            },
            null,
          ),
        ),
        withBypassContext(() =>
          saveProcessorReceiptPolicy(
            org.orgId,
            "stripe",
            next,
            h.userId,
            "Admit USD receipts into the processor pool",
            null,
          ),
        ),
      ]);
      const config = (
        await db.execute<{ settings: Record<string, unknown> }>(
          sql`select settings from psp_provider_configs
      where org_id = ${org.orgId} and provider = 'stripe'`,
          "objects",
        )
      )[0]!;
      assert.equal(config.settings.statementDescriptor, "NATIVE RECEIPTS");
      assert.deepEqual(
        (config.settings.processorReceiptPolicies as { id: string }[]).map((row) => row.id).sort(),
        [policy.id, next.id].sort(),
      );
      await assert.rejects(
        saveAcceptanceConfig(
          org.orgId,
          h.userId,
          {
            provider: "stripe",
            isEnabled: true,
            acceptanceEnabled: true,
            settings: { processorReceiptPolicies: [] },
          },
          null,
        ),
        /native processor receipt funding command/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "processor receipts retain native approval gates and refuse revoked funding or actor duty before posting",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { h, receipt, save } = await fixture(org);
      await save();
      const approver = await createScratchUser(org.orgId, "Receipt approver", "receipt_approver");
      await grantScratchPermissions(org.orgId, approver, ["ar.pay", "ar.approve"]);
      await seedApprovalFlow(org.orgId, {
        subjectKind: "customer_payment",
        mode: "any",
        assignees: [{ type: "user", userId: approver }],
      });
      assert.equal(
        (await submitAndReleaseIfUngated("customer_payment", receipt.id, h.userId)).gated,
        true,
      );
      await assert.rejects(
        postPaymentWithApplications(receipt.id, undefined, h.userId),
        /approval/,
      );
      const gate = (
        await db.execute<{ id: string }>(
          sql`select id from flow_gates where org_id = ${org.orgId} and subject_id = ${receipt.id} and status = 'pending'`,
          "objects",
        )
      )[0]!;
      await decideGate({
        gateId: gate.id,
        decision: "approved",
        userId: approver,
        allowedSubsidiaryIds: null,
      });
      await db.execute(
        sql`update psp_provider_configs set is_enabled = false where org_id = ${org.orgId} and provider = 'stripe'`,
      );
      await assert.rejects(
        postPaymentWithApplications(receipt.id, undefined, h.userId),
        /No unique effective/,
      );
      await db.execute(
        sql`update psp_provider_configs set is_enabled = true where org_id = ${org.orgId} and provider = 'stripe'`,
      );
      await db.execute(
        sql`update user_permission_overrides set effect = 'deny' where org_id = ${org.orgId} and user_id = ${h.userId} and permission = 'ar.pay'`,
      );
      await assert.rejects(
        postPaymentWithApplications(receipt.id, undefined, h.userId),
        ScopeNotFoundError,
      );
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "459.9600");
      assert.equal(
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from journal_entries where org_id = ${org.orgId} and source_document_id = ${receipt.id}`,
            "objects",
          )
        )[0]!.count,
        0,
      );
      await grantScratchPermissions(org.orgId, h.userId, ["ar.pay"]);
      await postPaymentWithApplications(receipt.id, undefined, h.userId);
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
