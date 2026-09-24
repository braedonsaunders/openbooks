import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// applyDocumentEdit + convertOrder are server-only code exercised through the
// same module hooks as the neighbouring documents suites.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} = await import("@openbooks/engine/src/testing/fixtures.ts");
import type { ScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";
const { convertOrder } = await import("./order-cycle.ts");
const { applyDocumentEdit } = await import("./documents.ts");
const { DocumentEditError } = await import("../../engine/src/records/document-edit-policy.ts");
const { loadDocumentEditCurrent } = await import("../../engine/src/ledger/document-service.ts");
const { issueSalesOrder, SalesOrderIssueError } = await import(
  "@openbooks/engine/src/sales/sales-orders.ts"
);
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { deleteDocument } = await import("@openbooks/engine/src/ledger/document-delete.ts");
const { createPaymentDocument, updateDraftPayment } = await import(
  "@openbooks/engine/src/payments/payment-documents.ts"
);
const { postPaymentWithApplications } = await import(
  "@openbooks/engine/src/payments/payment-posting.ts"
);
const { sameCurrencyAllocation } = await import(
  "@openbooks/engine/src/payments/settlement-policy.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableSalesFx(orgId: string, date: string): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into currencies (code, name, minor_units)
      values ('USD', 'US Dollar', 2), ('EUR', 'Euro', 2)
      on conflict (code) do nothing`);
    await db.execute(sql`
      update orgs set settings = (coalesce(settings, '{}'::jsonb) || '{"features": {"payroll": true, "orders": true, "multiCurrency": true}}'::jsonb)
       where id = ${orgId}`);
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${orgId}, 'USD', 'CAD', ${date}, 'spot', '1.3600', 'manual'),
             (${orgId}, 'EUR', 'CAD', ${date}, 'spot', '1.4800', 'manual')
      on conflict do nothing`);
  });
}

async function seedCustomerRole(org: ScratchOrg, actorId: string): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into customer_roles
        (org_id, party_id, ar_account_id, credit_limit, currency, is_on_hold, created_by, updated_by)
      values (${org.orgId}, ${org.customerId}, ${org.accounts.ar}, '10000', 'USD', false, ${actorId}, ${actorId})`);
  });
}

async function seedOtherCustomer(org: ScratchOrg, actorId: string): Promise<string> {
  const otherParty = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${otherParty}, ${org.orgId}, 'customer', 'Distinct Customer B', true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into customer_roles (org_id, party_id, ar_account_id, credit_limit, currency, is_on_hold, created_by, updated_by)
      values (${org.orgId}, ${otherParty}, ${org.accounts.ar}, '20000', 'USD', false, ${actorId}, ${actorId})`);
  });
  return otherParty;
}

async function seedOrder(org: ScratchOrg, actorId: string, number: string, total: string): Promise<string> {
  const id = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, currency, fx_rate, status, subtotal, tax_total, total,
         created_by, updated_by)
      values (${id}, ${org.orgId}, 'sales_order', ${number}, ${org.customerId},
              ${org.subsidiaryId}, ${org.date}, 'USD', '1', 'draft',
              ${total}, '0', ${total}, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity,
         quantity_billed, unit_price, amount, tax_input_amount, tax_amount,
         created_by, updated_by)
      values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, '1', '0',
              ${total}, ${total}, ${total}, '0', ${actorId}, ${actorId})`);
  });
  return id;
}

async function revisionOf(orgId: string, id: string): Promise<string> {
  return withOrgContext(orgId, async () => {
    const r = await db.execute<{ updated_at: string }>(sql`
      select (revision_seq)::text as updated_at from documents
       where id = ${id} and org_id = ${orgId}`);
    return r.rows[0]!.updated_at;
  });
}

async function issue(orgId: string, orderId: string, actorId: string, creditOverrideReason?: string) {
  return issueSalesOrder({
    orgId,
    salesOrderId: orderId,
    actorId,
    expectedUpdatedAt: await revisionOf(orgId, orderId),
    ...(creditOverrideReason === undefined ? {} : { creditOverrideReason }),
  });
}

async function approveAndPost(org: ScratchOrg, actorId: string, invoiceId: string): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
       where id = ${invoiceId} and org_id = ${org.orgId}`);
    await postDocument(invoiceId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });
  });
}

async function payInFull(
  org: ScratchOrg,
  actorId: string,
  invoiceId: string,
  currency: string,
  amount: string,
): Promise<void> {
  const openLineId = await withOrgContext(org.orgId, async () => {
    const r = await db.execute<{ id: string }>(sql`
      select jl.id from journal_lines jl
        join journal_entries je on je.id = jl.entry_id
       where je.source_document_id = ${invoiceId} and jl.org_id = ${org.orgId}
         and jl.is_open_item`);
    return r.rows[0]!.id;
  });
  await withBypassContext(async () => {
    const receipt = await createPaymentDocument({ allowedSubsidiaryIds: null,
      orgId: org.orgId,
      kind: "customer_payment",
      createdBy: actorId,
      partyId: org.customerId,
      bankAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId,
      documentDate: org.date,
      currency,
      fxRate: "1",
    });
    await updateDraftPayment(
      receipt.id,
      {
        partyId: org.customerId,
        bankAccountId: org.accounts.bank,
        allocations: [sameCurrencyAllocation(openLineId, amount)],
      },
      actorId,
      org.orgId,
    );
    await db.execute(sql`
      update documents set status = 'approved', submitted_by = ${actorId}, submitted_at = now()
       where id = ${receipt.id} and org_id = ${org.orgId}`);
    await postPaymentWithApplications(receipt.id, undefined, actorId);
  });
}

async function invoiceState(orgId: string, id: string) {
  return withOrgContext(orgId, async () => {
    const doc = (
      await db.execute<{ party: string | null; currency: string; total: string; status: string; number: string }>(sql`
        select party_id as party, currency, total::text as total, status, document_number as number from documents
         where id = ${id} and org_id = ${orgId}`)
    ).rows[0]!;
    const edge = (
      await db.execute<{ n: number }>(sql`
        select count(*)::int as n from document_links
         where org_id = ${orgId} and to_document_id = ${id} and link_type = 'bills'`)
    ).rows[0]!.n;
    const lines = (
      await db.execute<{ n: number }>(sql`
        select count(*)::int as n from document_lines
         where org_id = ${orgId} and document_id = ${id}`)
    ).rows[0]!.n;
    return { ...doc, edgeCount: edge, lineCount: lines };
  });
}

async function grantRolePermissions(orgId: string, roleKey: string, permissions: string[]): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`
      update app_roles
         set permissions = ${JSON.stringify(permissions)}::jsonb
       where org_id = ${orgId} and key = ${roleKey}`);
  });
}

async function expectIssueError(promise: Promise<unknown>, code: string, status = 422) {
  let captured: InstanceType<typeof SalesOrderIssueError> | undefined;
  await assert.rejects(promise, (error: unknown) => {
    if (!(error instanceof SalesOrderIssueError)) return false;
    captured = error;
    return error.code === code && error.status === status;
  });
  return captured!;
}

async function editParty(
  orgId: string,
  actorId: string,
  id: string,
  partyId: string,
): Promise<void> {
  await withOrgContext(orgId, async () => {
    const current = await loadDocumentEditCurrent(id, orgId);
    assert.ok(current);
    await applyDocumentEdit(
      id,
      current,
      { partyId, expectedUpdatedAt: current.updatedAt },
      { orgId, userId: actorId, source: "ui", runFlows: false },
    );
  });
}

test(
  "a converted draft invoice cannot be moved to another party",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Party exposure clerk", "party_exposure_clerk"),
      );
      await enableSalesFx(org.orgId, org.date);
      await seedCustomerRole(org, actorId);
      const otherParty = await seedOtherCustomer(org, actorId);

      const so1 = await seedOrder(org, actorId, "SO-PTY-1", "10000");
      const first = await issue(org.orgId, so1, actorId);
      assert.equal(first.credit?.resultingExposure, "10000.0000");

      const converted = await convertOrder(org.orgId, actorId, so1, "customer_invoice");
      const before = await invoiceState(org.orgId, converted.id);
      assert.equal(before.party, org.customerId);
      assert.equal(before.total, "10000.0000");
      assert.equal(before.edgeCount, 1);
      const sourceBefore = await withOrgContext(org.orgId, async () => {
        const r = await db.execute<{ status: string; total: string; party: string }>(sql`
          select status, total::text as total, party_id as party from documents
           where id = ${so1} and org_id = ${org.orgId}`);
        return r.rows[0]!;
      });

      // The move is refused and names the source order plus the remedy.
      let refusal: InstanceType<typeof DocumentEditError> | undefined;
      await assert.rejects(editParty(org.orgId, actorId, converted.id, otherParty), (error: unknown) => {
        if (!(error instanceof DocumentEditError)) return false;
        refusal = error;
        return error.status === 422;
      });
      assert.match(refusal!.message, /SO-PTY-1/);
      assert.match(refusal!.message, /sales order/);
      assert.match(refusal!.message, /must keep the source order party/);
      assert.match(refusal!.message, /Delete this draft and reconvert/);

      // The refused edit leaves source, invoice, links, and totals unchanged.
      const after = await invoiceState(org.orgId, converted.id);
      assert.deepEqual(after, before);
      const sourceAfter = await withOrgContext(org.orgId, async () => {
        const r = await db.execute<{ status: string; total: string; party: string }>(sql`
          select status, total::text as total, party_id as party from documents
           where id = ${so1} and org_id = ${org.orgId}`);
        return r.rows[0]!;
      });
      assert.deepEqual(sourceAfter, sourceBefore);

      // Same-party header edits still work: a memo-only save and an explicit
      // no-op party save both succeed.
      await withOrgContext(org.orgId, async () => {
        const current = await loadDocumentEditCurrent(converted.id, org.orgId);
        assert.ok(current);
        await applyDocumentEdit(
          converted.id,
          current,
          { memo: "Billing hold for review", expectedUpdatedAt: current.updatedAt },
          { orgId: org.orgId, userId: actorId, source: "ui", runFlows: false },
        );
      });
      await editParty(org.orgId, actorId, converted.id, org.customerId);
      const settled = await invoiceState(org.orgId, converted.id);
      assert.equal(settled.party, org.customerId);
      assert.equal(settled.total, "10000.0000");
      assert.equal(settled.edgeCount, 1);

      // Drafts without an order-conversion source stay freely reassignable:
      // the guard binds only conversion children to their source party.
      const standalone = await withBypassContext(async () => {
        const draftId = randomUUID();
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, document_number, party_id, subsidiary_id,
             document_date, currency, status, subtotal, tax_total, total,
             created_by, updated_by)
          values (${draftId}, ${org.orgId}, 'customer_invoice', 'INV-STANDALONE-PTY-1', ${org.customerId},
                  ${org.subsidiaryId}, ${org.date}, 'USD', 'draft', '10', '0', '10', ${actorId}, ${actorId})`);
        await db.execute(sql`
          insert into document_lines
            (org_id, document_id, line_number, account_id, quantity, unit_price, amount,
             tax_input_amount, tax_amount, created_by, updated_by)
          values (${org.orgId}, ${draftId}, 1, ${org.accounts.revenue}, '1', '10',
                  '10', '10', '0', ${actorId}, ${actorId})`);
        return draftId;
      });
      await editParty(org.orgId, actorId, standalone, otherParty);
      const reassigned = await invoiceState(org.orgId, standalone);
      assert.equal(reassigned.party, otherParty);
      assert.equal(reassigned.total, "10.0000");
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "delete-and-reconvert remedy restores the source party billing end to end",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Party remedy clerk", "party_remedy_clerk"),
      );
      const approverId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Party remedy approver", "party_remedy_approver"),
      );
      await grantRolePermissions(org.orgId, "party_remedy_approver", ["ar.create", "ar.approve"]);
      await enableSalesFx(org.orgId, org.date);
      await seedCustomerRole(org, actorId);
      const otherParty = await seedOtherCustomer(org, actorId);

      const so1 = await seedOrder(org, actorId, "SO-PTY-REM-1", "10000");
      await issue(org.orgId, so1, actorId);
      const converted = await convertOrder(org.orgId, actorId, so1, "customer_invoice");

      // The drift is refused, so the operator deletes the draft (restoring
      // the source billed cover) and reconverts in the source party.
      await assert.rejects(editParty(org.orgId, actorId, converted.id, otherParty), (error: unknown) => {
        if (!(error instanceof DocumentEditError)) return false;
        return error.status === 422 && /reconvert/.test(error.message);
      });
      await withBypassContext(() =>
        deleteDocument(converted.id, actorId, org.orgId, { reason: "Wrong billing party requested", allowedSubsidiaryIds: null }),
      );
      const billed = await withOrgContext(org.orgId, async () => {
        const r = await db.execute<{ quantity_billed: string }>(sql`
          select quantity_billed::text from document_lines
           where org_id = ${org.orgId} and document_id = ${so1}`);
        return r.rows[0]!.quantity_billed;
      });
      assert.equal(billed, "0.00000000");
      const reconverted = await convertOrder(org.orgId, actorId, so1, "customer_invoice");
      const rebilled = await invoiceState(org.orgId, reconverted.id);
      assert.equal(rebilled.party, org.customerId);
      assert.equal(rebilled.edgeCount, 1);

      // Same-party billing still relieves exposure once posted and paid.
      await approveAndPost(org, actorId, reconverted.id);
      await payInFull(org, actorId, reconverted.id, "USD", "10000");
      const so2 = await seedOrder(org, actorId, "SO-PTY-REM-2", "5000");
      const second = await issue(org.orgId, so2, actorId);
      assert.equal(second.credit?.openOrderExposure, "0.0000");
      assert.equal(second.credit?.resultingExposure, "5000.0000");

      // The limit still engages past the threshold, and an authorized
      // override with a reason still issues.
      const so3 = await seedOrder(org, actorId, "SO-PTY-REM-3", "6000");
      const refused = await expectIssueError(
        issue(org.orgId, so3, actorId),
        "CUSTOMER_CREDIT_LIMIT_EXCEEDED",
      );
      assert.equal(refused.details?.resultingExposure, "11000.0000");
      await expectIssueError(
        issue(org.orgId, so3, actorId, "Customer deposit confirmed by treasury"),
        "CUSTOMER_CREDIT_OVERRIDE_FORBIDDEN",
        403,
      );
      const overridden = await issue(org.orgId, so3, approverId, "Customer deposit confirmed by treasury");
      assert.equal(overridden.credit?.overridden, true);
      assert.equal(overridden.credit?.resultingExposure, "11000.0000");
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "legacy mismatched-party billing does not release the source order exposure",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Legacy party clerk", "legacy_party_clerk"),
      );
      await enableSalesFx(org.orgId, org.date);
      await seedCustomerRole(org, actorId);
      const otherParty = await seedOtherCustomer(org, actorId);

      const so1 = await seedOrder(org, actorId, "SO-PTY-LEG-1", "10000");
      await issue(org.orgId, so1, actorId);
      const converted = await convertOrder(org.orgId, actorId, so1, "customer_invoice");

      // Legacy simulation: rows relabelled through the pre-fix unguarded path
      // bypass the edit guard, so raw SQL stands in for those inconsistent
      // rows. The credit math must still fail closed on them.
      await withBypassContext(async () => {
        await db.execute(sql`
          update documents set party_id = ${otherParty}, updated_at = now(), updated_by = ${actorId}
           where id = ${converted.id} and org_id = ${org.orgId}`);
      });
      await approveAndPost(org, actorId, converted.id);

      // No same-party billing ever relieved SO-PTY-LEG-1, so the second order
      // must refuse even though the stray invoice is still open against B.
      const so2 = await seedOrder(org, actorId, "SO-PTY-LEG-2", "5000");
      const refused = await expectIssueError(
        issue(org.orgId, so2, actorId),
        "CUSTOMER_CREDIT_LIMIT_EXCEEDED",
      );
      assert.equal(refused.details?.existingExposure, "10000.0000");
      assert.equal(refused.details?.resultingExposure, "15000.0000");
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
