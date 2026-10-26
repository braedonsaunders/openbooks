import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../lib/auth";
import { sql } from "drizzle-orm";
import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";

// The real route resolves the caller from the session exactly as in
// production: the test supplies only the signed-in identity, and the user's
// roles grant its permissions and subsidiary scope.
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __quoteCrmLifecycleSession: session });
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__quoteCrmLifecycleSession.user}",
      };
    }
    return nextResolve(specifier, context);
  },
});

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { ensureCrmDefaults, promoteCrmAccount } = await import("@openbooks/engine/crm/crm");
const { createOrder } = await import("./create.ts");
const { orderEditServices } = await import("./handlers.ts");
const { PATCH } = await import("../estimates/[id]/route.ts");
const { applyOrderEdit, OrderEditError } = await import("../../../lib/order-draft-edit.ts");
const { CrmLifecycleRefusalError } = await import("@openbooks/engine/crm/crm");
const { convertOrder } = await import("../../../lib/order-cycle.ts");
const { postDocument } = await import("@openbooks/engine/ledger/posting-document");
const { createPaymentDocument, updateDraftPayment } =
  await import("@openbooks/engine/payments/payment-documents");
const { postPaymentWithApplications } = await import("@openbooks/engine/payments/payment-posting");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function enableCrm(orgId: string): Promise<void> {
  await withBypassContext(() =>
    db.execute(
      sql`update orgs set settings = settings || ${JSON.stringify({ features: { crm: true } })}::jsonb where id = ${orgId}`,
    ),
  );
  await withBypassContext(() => ensureCrmDefaults(orgId));
}

async function seedParty(orgId: string, name: string): Promise<string> {
  return (
    await withBypassContext(() =>
      db.execute<{ id: string }>(
        sql`
        insert into parties (org_id, kind, display_name, is_active)
        values (${orgId}, 'company', ${name}, true) returning id`,
        "objects",
      ),
    )
  )[0]!.id;
}

async function profileStage(orgId: string, partyId: string): Promise<string | null> {
  const rows = await withBypassContext(() =>
    db.execute<{ lifecycle_stage: string }>(
      sql`
        select lifecycle_stage from crm_account_profiles
         where org_id = ${orgId} and party_id = ${partyId}`,
      "objects",
    ),
  );
  return rows[0]?.lifecycle_stage ?? null;
}

async function roleActive(orgId: string, partyId: string): Promise<boolean> {
  const rows = await withBypassContext(() =>
    db.execute(
      sql`
        select 1 from customer_roles
         where org_id = ${orgId} and party_id = ${partyId} and is_active`,
      "objects",
    ),
  );
  return rows.length > 0;
}

async function openBalance(orgId: string, partyId: string): Promise<string> {
  const rows = await withBypassContext(() =>
    db.execute<{ balance: string }>(
      sql`
        select coalesce(sum(open_balance), 0)::text as balance from documents
         where org_id = ${orgId} and party_id = ${partyId} and status = 'posted'`,
      "objects",
    ),
  );
  return rows[0]!.balance;
}

function gateFor(orgId: string, actorId: string) {
  return { user: { orgId, id: actorId }, allowedSubsidiaryIds: null } as never;
}

async function postQuote(
  orgId: string,
  actorId: string,
  partyId: string,
  documentDate: string,
  itemId: string,
): Promise<Response> {
  return withOrgContext(
    orgId,
    () =>
      createOrder(
        { kind: "quote", createPerm: "ar.create", numberPrefix: "EST-" },
        gateFor(orgId, actorId),
        new Request("http://openbooks.test/api/estimates", {
          method: "POST",
          headers: { "Idempotency-Key": randomUUID() },
        }),
        {
          partyId,
          documentDate,
          lines: [{ itemId, quantity: "1", unitPrice: "100" }],
        } as never,
      ) as Promise<Response>,
  );
}

async function seedApprovedSalesOrder(
  orgId: string,
  actorId: string,
  partyId: string,
  subsidiaryId: string,
  documentDate: string,
  revenueAccountId: string,
  number: string,
): Promise<string> {
  return withBypassContext(async () => {
    const id = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, currency, status, subtotal, tax_total, total,
         created_by, updated_by)
      values (
        ${id}, ${orgId}, 'sales_order', ${number}, ${partyId},
        ${subsidiaryId}, ${documentDate}, 'CAD', 'draft', '100', '0', '100',
        ${actorId}, ${actorId}
      )`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity,
         quantity_billed, quantity_fulfilled, unit_price, amount,
         tax_input_amount, tax_amount, created_by, updated_by)
      values (
        ${orgId}, ${id}, 1, ${revenueAccountId}, '1',
        '0', '0', '100', '100', '100', '0', ${actorId}, ${actorId}
      )`);
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
       where id = ${id} and org_id = ${orgId}`);
    return id;
  });
}

async function approveAndPostInvoice(
  orgId: string,
  actorId: string,
  invoiceId: string,
  control: { ar: string; ap: string; bank: string },
): Promise<string> {
  return withBypassContext(async () => {
    await db.execute(
      sql`update documents set status = 'approved' where id = ${invoiceId} and org_id = ${orgId}`,
    );
    return postDocument(invoiceId, { control });
  });
}

/** Settle the invoice's open AR line in full, same currency: zero open balance with document history. */
async function payInvoiceInFull(
  orgId: string,
  actorId: string,
  partyId: string,
  subsidiaryId: string,
  documentDate: string,
  bankAccountId: string,
  entryId: string,
  amount: string,
): Promise<void> {
  await withBypassContext(async () => {
    const line = (
      await db.execute<{ id: string }>(
        sql`
        select id from journal_lines where entry_id = ${entryId} and is_open_item`,
        "objects",
      )
    )[0]!.id;
    const payment = await createPaymentDocument({
      allowedSubsidiaryIds: null,
      orgId,
      kind: "customer_payment",
      createdBy: actorId,
      partyId,
      bankAccountId,
      subsidiaryId,
      documentDate,
      currency: "CAD",
      fxRate: "1",
    });
    await updateDraftPayment(
      payment.id,
      {
        bankAccountId,
        allocations: [
          {
            openLineId: line,
            sourceTransactionAmount: amount,
            targetTransactionAmount: amount,
            settlementRate: "1",
            settlementRateSource: "same_currency",
            settlementRateReference: "same-currency settlement",
          },
        ],
      },
      actorId,
      orgId,
      { allowedSubsidiaryIds: null },
    );
    await db.execute(sql`
      update documents set status = 'approved', submitted_by = ${actorId}, submitted_at = now()
       where id = ${payment.id} and org_id = ${orgId}`);
    await postPaymentWithApplications(payment.id, undefined, actorId);
  });
}

test(
  "an estimate for a customer with an open balance saves and leaves the stage",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await enableCrm(org.orgId);
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Estimator", "admin"),
      );
      const customer = await seedParty(org.orgId, "Established Customer");
      await withBypassContext(() =>
        promoteCrmAccount(db, {
          orgId: org.orgId,
          partyId: customer,
          actorId,
          toStage: "customer",
          sourceKind: "sales_order",
        }),
      );
      assert.equal(await profileStage(org.orgId, customer), "customer");
      const soId = await seedApprovedSalesOrder(
        org.orgId,
        actorId,
        customer,
        org.subsidiaryId,
        org.date,
        org.accounts.revenue,
        "SO-CRM-1",
      );
      const invoice = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
      await approveAndPostInvoice(org.orgId, actorId, invoice.id, {
        ar: org.accounts.ar,
        ap: org.accounts.ap,
        bank: org.accounts.bank,
      });
      assert.notEqual(
        await openBalance(org.orgId, customer),
        "0",
        "the seed must leave an open balance, or the demotion guard would have nothing to refuse",
      );

      const res = await postQuote(org.orgId, actorId, customer, org.date, org.items.service);
      if (res.status !== 201)
        assert.fail(`estimating an established customer must save, got: ${await res.text()}`);
      assert.equal(
        await profileStage(org.orgId, customer),
        "customer",
        "quoting must never move a customer backwards",
      );
      assert.equal(
        await roleActive(org.orgId, customer),
        true,
        "quoting must keep the customer role active",
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "an estimate for a fully paid customer saves and leaves the stage",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await enableCrm(org.orgId);
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Estimator", "admin"),
      );
      const customer = await seedParty(org.orgId, "Fully Paid Customer");
      await withBypassContext(() =>
        promoteCrmAccount(db, {
          orgId: org.orgId,
          partyId: customer,
          actorId,
          toStage: "customer",
          sourceKind: "sales_order",
        }),
      );
      assert.equal(await profileStage(org.orgId, customer), "customer");
      const soId = await seedApprovedSalesOrder(
        org.orgId,
        actorId,
        customer,
        org.subsidiaryId,
        org.date,
        org.accounts.revenue,
        "SO-CRM-3",
      );
      const invoice = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
      const entryId = await approveAndPostInvoice(org.orgId, actorId, invoice.id, {
        ar: org.accounts.ar,
        ap: org.accounts.ap,
        bank: org.accounts.bank,
      });
      await payInvoiceInFull(
        org.orgId,
        actorId,
        customer,
        org.subsidiaryId,
        org.date,
        org.accounts.bank,
        entryId,
        "100",
      );
      assert.equal(
        await openBalance(org.orgId, customer),
        "0.0000",
        "the seed must leave zero open balance with posted history",
      );

      const res = await postQuote(org.orgId, actorId, customer, org.date, org.items.service);
      if (res.status !== 201)
        assert.fail(`estimating a fully paid customer must save, got: ${await res.text()}`);
      assert.equal(
        await profileStage(org.orgId, customer),
        "customer",
        "quoting must never move a customer backwards",
      );
      assert.equal(
        await roleActive(org.orgId, customer),
        true,
        "quoting must keep the customer role active",
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test("an estimate for a lead advances the lifecycle to prospect", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await enableCrm(org.orgId);
    const actorId = await withBypassContext(() =>
      createScratchUser(org.orgId, "Estimator", "admin"),
    );
    const lead = await seedParty(org.orgId, "New Lead");
    assert.equal(await profileStage(org.orgId, lead), null);

    const res = await postQuote(org.orgId, actorId, lead, org.date, org.items.service);
    if (res.status !== 201) assert.fail(`estimating a lead must save, got: ${await res.text()}`);
    assert.equal(
      await profileStage(org.orgId, lead),
      "prospect",
      "quoting a lead advances it to prospect",
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a lifecycle refusal on edit answers 422 with its message", { skip: !DB }, async () => {
  const refusal = "cannot demote this customer back to prospect while documents are in flight";
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await enableCrm(org.orgId);
    const actorId = await withBypassContext(() =>
      createScratchUser(org.orgId, "Estimator", "admin"),
    );
    const lead = await seedParty(org.orgId, "New Lead");
    const created = await postQuote(org.orgId, actorId, lead, org.date, org.items.service);
    if (created.status !== 201)
      assert.fail(`seed estimate must save, got: ${await created.text()}`);
    const quoteId = ((await created.json()) as { doc: { id: string } }).doc.id;
    const revision = await withOrgContext(
      org.orgId,
      async () =>
        (
          await db.execute<{ revision: string }>(
            sql`
            select ${documentRevisionCounterSql(sql`revision_seq`)} as revision
              from documents where id = ${quoteId}`,
            "objects",
          )
        )[0]!.revision,
    );
    const other = await seedParty(org.orgId, "Other Company");
    const services = {
      ...orderEditServices,
      crm: {
        promoteCrmAccount: async () => {
          throw new CrmLifecycleRefusalError(`${refusal} — resolve and retry`);
        },
      },
    };
    const error = await withOrgContext(org.orgId, () =>
      applyOrderEdit(
        {
          orgId: org.orgId,
          userId: actorId,
          user: { orgId: org.orgId, id: actorId } as never,
          allowedSubsidiaryIds: null,
          permissions: new Set<string>(),
          services,
        },
        { kind: "quote", createPerm: "ar.create", readPerm: "ar.read" },
        quoteId,
        { expectedUpdatedAt: revision, partyId: other } as never,
      ).then(
        () => null,
        (cause) => cause,
      ),
    );
    assert.ok(error instanceof OrderEditError, `expected an OrderEditError, got ${String(error)}`);
    assert.equal(error.status, 422);
    assert.match(
      String((error.body as { error?: unknown })?.error ?? ""),
      /cannot demote this customer/,
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("repointing an estimate at a customer with an open balance saves", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  session.user = null;
  try {
    await enableCrm(org.orgId);
    const actorId = await withBypassContext(() =>
      createScratchUser(org.orgId, "Estimator", "admin"),
    );
    const customer = await seedParty(org.orgId, "Established Customer");
    await withBypassContext(() =>
      promoteCrmAccount(db, {
        orgId: org.orgId,
        partyId: customer,
        actorId,
        toStage: "customer",
        sourceKind: "sales_order",
      }),
    );
    const soId = await seedApprovedSalesOrder(
      org.orgId,
      actorId,
      customer,
      org.subsidiaryId,
      org.date,
      org.accounts.revenue,
      "SO-CRM-2",
    );
    const invoice = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
    await approveAndPostInvoice(org.orgId, actorId, invoice.id, {
      ar: org.accounts.ar,
      ap: org.accounts.ap,
      bank: org.accounts.bank,
    });
    assert.notEqual(await openBalance(org.orgId, customer), "0");

    const lead = await seedParty(org.orgId, "New Lead");
    const created = await postQuote(org.orgId, actorId, lead, org.date, org.items.service);
    if (created.status !== 201)
      assert.fail(`seed estimate must save, got: ${await created.text()}`);
    const quoteId = ((await created.json()) as { doc: { id: string } }).doc.id;

    session.user = {
      id: actorId,
      orgId: org.orgId,
      name: "Estimator",
      email: "estimator@scratch.test",
      roles: [],
      isSuperAdmin: false,
      envKind: "production",
      productionOrgId: org.orgId,
      homeOrgId: org.orgId,
      homeUserId: actorId,
    };
    const revision = await withOrgContext(
      org.orgId,
      async () =>
        (
          await db.execute<{ revision: string }>(
            sql`
        select ${documentRevisionCounterSql(sql`revision_seq`)} as revision
          from documents where id = ${quoteId}`,
            "objects",
          )
        )[0]!.revision,
    );
    const res = await withOrgContext(org.orgId, async () =>
      PATCH(
        new Request(`http://openbooks.test/api/estimates/${quoteId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedUpdatedAt: revision, partyId: customer }),
        }),
        { params: Promise.resolve({ id: quoteId }) },
      ),
    );
    if (res.status !== 200)
      assert.fail(`repointing at the customer must save, got: ${await res.text()}`);
    assert.equal(await profileStage(org.orgId, customer), "customer");
    assert.equal(await roleActive(org.orgId, customer), true);
  } finally {
    session.user = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
