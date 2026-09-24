import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";

// Rendering a recipient copy used to stamp it furnished: the GET (behind
// `compliance.read` only) called stampRecipientCopiesPrinted after rendering,
// so a read-only holder, a crawler, or a preview marked statutory copies as
// handed over. GET is now side-effect free; marking furnished is POST behind
// `compliance.manage`, audited. These tests prove against the REAL ROUTE that
// a read-only GET leaves printed_at alone and that the POST without the grant
// is refused before any write.

const stateKey = Symbol.for("openbooks.ir-copies-furnish-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  import { NextResponse } from 'next/server';
  import { permissionSetCovers } from '@openbooks/engine/src/organization/permissions.ts';
  const state = globalThis[Symbol.for('openbooks.ir-copies-furnish-test')]
  export async function guardPermission(permission) {
    if (!state.authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    if (!permissionSetCovers(state.authz.permissions, permission)) {
      return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 });
    }
    return state.authz;
  }
  export async function getAuthz() {
    return state.authz;
  }
  export function can(_authz, permission) {
    return state.authz?.permissions?.has(permission) ?? false;
  }
  export function guardSubsidiaryScope(authz, subsidiaryId) {
    const scope = authz?.allowedSubsidiaryIds ?? null;
    if (scope === null) return null;
    if (subsidiaryId && scope.has(subsidiaryId)) return null;
    return Response.json({ error: 'not found' }, { status: 404 });
  }
`;

const mockPdf = `
  export async function renderInformationReturnPdf() { return Buffer.from('FAKE-ONE') }
  export async function renderInformationReturnBatchPdf() { return Buffer.from('FAKE-BATCH') }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "@/lib/authz") {
      return { url: "mock:ir-copies-authz", shortCircuit: true };
    }
    if (specifier === "@/lib/information-return-pdf") {
      return { url: "mock:ir-copies-pdf", shortCircuit: true };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts").href, context);
    }
    if (context.parentURL?.startsWith("mock:") && (specifier.startsWith("@openbooks/") || specifier === "next/server")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:ir-copies-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:ir-copies-pdf") {
      return { format: "module", source: mockPdf, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?ir-copies-furnish-test";
const { GET, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const {
  ensureFiling,
  finalizeFiling,
  recomputeFiling,
} = await import("@openbooks/engine/src/compliance/information-returns.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

/** Seed one posted vendor payment so the fixture's compute evidence is current. */
async function seedInformationReturnPayment(
  org: Org,
  actorId: string,
  amount: string,
  suffix: string,
  partyId: string,
  taxYear: number,
  tinLast4: string,
): Promise<void> {
  return withBypassContext(async () => {
    const sourceDate = `${taxYear}-07-15`;
    await db.execute(sql`
      insert into vendor_roles
        (org_id, party_id, is_t4a, information_return_form, tin_last4, tin_type,
         created_by, updated_by)
      values (${org.orgId}, ${partyId}, true, '1099-NEC', ${tinLast4}, 'ein',
              ${actorId}, ${actorId})
      on conflict (party_id) do update set
        is_t4a = true, information_return_form = '1099-NEC',
        tin_last4 = excluded.tin_last4, tin_type = 'ein', updated_by = ${actorId}
      where vendor_roles.org_id = ${org.orgId}
    `);
    const paymentId = randomUUID();
    const journalEntryId = randomUUID();
    const journalLineIds = [randomUUID(), randomUUID()];
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, posting_date, currency, subtotal, tax_total, total,
           custom, created_by, updated_by)
        values (${paymentId}, ${org.orgId}, 'vendor_payment', 'approved',
                ${`IR-SOURCE-${suffix}`}, ${org.subsidiaryId}, ${partyId},
                ${sourceDate}, ${sourceDate}, 'CAD', ${amount}, '0', ${amount},
                ${JSON.stringify({ bankAccountId: org.accounts.bank, allocations: [] })}::jsonb,
                ${actorId}, ${actorId})
      `);
      await tx.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, source_document_id, origin, created_by, updated_by)
        values (${journalEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
                ${`IR-SOURCE-${suffix}`}, ${sourceDate}, ${org.periodId},
                'Information-return route fixture', 'draft', ${paymentId}, 'document',
                ${actorId}, ${actorId})
      `);
      await tx.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount,
           currency, txn_amount, fx_rate, party_id, is_open_item, memo)
        values
          (${journalLineIds[0]!}, ${org.orgId}, ${journalEntryId}, 1,
           ${org.accounts.ap}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, 1,
           ${partyId}, true, 'Information-return route control'),
          (${journalLineIds[1]!}, ${org.orgId}, ${journalEntryId}, 2,
           ${org.accounts.bank}, ${org.subsidiaryId}, ${`-${amount}`}, 'CAD',
           ${`-${amount}`}, 1, null, false, 'Information-return route cash source')
      `);
      await tx.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now(), posted_by = ${actorId}
         where org_id = ${org.orgId} and id = ${journalEntryId}
      `);
      await tx.execute(sql`
        update documents
           set status = 'posted', posted_entry_id = ${journalEntryId},
               posting_period_id = ${org.periodId}
         where org_id = ${org.orgId} and id = ${paymentId}
      `);
    });
  });
}

/** Seed a FINALIZED 1099-NEC filing with two included recipients (TINs on file). */
async function seedFinalizedFiling(
  org: Org,
  actorId: string,
  taxYear: number,
): Promise<{ filingId: string; recipientIds: string[] }> {
  return withBypassContext(async () => {
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb),
        '{features,subcontractorCompliance}', 'true'::jsonb, true)
       where id = ${org.orgId}`);
    const filing = await ensureFiling({ orgId: org.orgId, taxYear, formType: "1099-NEC", currency: "USD", actorId });
    for (let i = 0; i < 2; i++) {
      const partyId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${partyId}, ${org.orgId}, 'vendor', ${`Recipient ${taxYear}-${i}`},
                null, true, '{}'::jsonb)`);
      await seedInformationReturnPayment(
        org,
        actorId,
        `${3000 + i}`,
        `ROUTE-FURNISH-${taxYear}-${i}`,
        partyId,
        taxYear,
        i === 0 ? "1234" : "5678",
      );
    }
    await recomputeFiling({ orgId: org.orgId, filingId: filing.id, actorId });
    await finalizeFiling({ orgId: org.orgId, filingId: filing.id, actorId });
    const recipients = await db.execute<{ id: string }>(sql`
      select id from information_return_recipients
       where org_id = ${org.orgId} and filing_id = ${filing.id}
       order by party_id`);
    return { filingId: filing.id, recipientIds: recipients.rows.map((row) => row.id) };
  });
}

async function printedAts(orgId: string, filingId: string): Promise<(string | null)[]> {
  const rows = (await withBypassContext(() =>
    db.execute<{ printed_at: string | null }>(sql`
      select printed_at::text as printed_at from information_return_recipients
       where org_id = ${orgId} and filing_id = ${filingId} order by party_id`),
  )).rows;
  return rows.map((row) => row.printed_at);
}

async function auditCount(orgId: string, filingId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log
       where org_id = ${orgId} and table_name = 'information_return_recipients'
         and row_id in (select id from information_return_recipients where filing_id = ${filingId})`),
  )).rows;
  return rows[0]!.n;
}

const getCopies = (filingId: string) =>
  withOrgContext(routeState.authz!.user.orgId, () =>
    GET(
      new Request(`http://copies.test/api/compliance/information-returns/${filingId}/copies`, {
        headers: { "content-type": "application/pdf" },
      }),
      { params: Promise.resolve({ id: filingId }) },
    ),
  );

const postFurnished = (filingId: string, body: unknown) =>
  withOrgContext(routeState.authz!.user.orgId, () =>
    POST(
      new Request(`http://copies.test/api/compliance/information-returns/${filingId}/copies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: filingId }) },
    ),
  );

test("a read-only GET renders without marking copies furnished", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = randomUUID();
    routeState.authz = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(["compliance.read"]), allowedSubsidiaryIds: null };
    const { filingId, recipientIds } = await seedFinalizedFiling(org, actorId, 2071);
    assert.equal(recipientIds.length, 2);
    const response = await getCopies(filingId);
    assert.equal(response.status, 200, `expected a rendered PDF, got ${response.status}`);
    assert.deepEqual(await printedAts(org.orgId, filingId), [null, null]);
    assert.equal(await auditCount(org.orgId, filingId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the furnish POST without the manage grant is refused before any write", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = randomUUID();
    routeState.authz = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(["compliance.read"]), allowedSubsidiaryIds: null };
    const { filingId } = await seedFinalizedFiling(org, actorId, 2072);
    const response = await postFurnished(filingId, {});
    assert.equal(response.status, 403, `expected 403, got ${response.status}`);
    assert.deepEqual(await printedAts(org.orgId, filingId), [null, null]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the furnish POST with the manage grant stamps and audits both copies", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = randomUUID();
    routeState.authz = {
      user: { orgId: org.orgId, id: actorId },
      permissions: new Set(["compliance.read", "compliance.manage"]),
      allowedSubsidiaryIds: null,
    };
    const { filingId } = await seedFinalizedFiling(org, actorId, 2073);
    const response = await postFurnished(filingId, {});
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.deepEqual(await response.json(), { furnished: 2 });
    for (const printed of await printedAts(org.orgId, filingId)) {
      assert.ok(printed !== null);
    }
    assert.equal(await auditCount(org.orgId, filingId), 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the furnish POST for one recipient stamps only that copy", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = randomUUID();
    routeState.authz = {
      user: { orgId: org.orgId, id: actorId },
      permissions: new Set(["compliance.read", "compliance.manage"]),
      allowedSubsidiaryIds: null,
    };
    const { filingId, recipientIds } = await seedFinalizedFiling(org, actorId, 2074);
    const response = await postFurnished(filingId, { recipientId: recipientIds[0] });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.deepEqual(await response.json(), { furnished: 1 });
    assert.deepEqual(
      (await printedAts(org.orgId, filingId)).map((printed) => printed !== null),
      [true, false],
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
