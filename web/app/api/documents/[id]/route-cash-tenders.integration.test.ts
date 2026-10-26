import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Paid-at-sale tenders ride custom.tenders on the wire but persist in
// document_tenders: the server consumes the key into the table and never
// stores it. Only the round trip through the real PATCH proves the
// consume-and-strip: a unit call to the writer cannot show the key is gone
// from the stored bag.
const root = pathToFileURL(process.cwd() + "/").href;
const state: { orgId: string; actorId: string } = { orgId: "", actorId: "" };
Object.assign(globalThis, { __cashTendersRoundTripState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
const { readFileSync } = await import("node:fs");
const engineExports = JSON.parse(readFileSync(process.cwd() + "/engine/package.json", "utf8"))
  .exports as Record<string, string>;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "../../../../lib/authz" || specifier === "@/lib/authz")
      return virtual(`
      export async function getAuthz() {
        const s = globalThis.__cashTendersRoundTripState;
        return { user: { roles: [], orgId: s.orgId, id: s.actorId, isSuperAdmin: false }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
      }
      export { can, guardSubsidiaryScope, subsidiariesInScope } from '${root}web/lib/authz.ts'
    `);
    // Pin the engine to THIS checkout (see route-recall for why). Named
    // export subpaths are not file paths, so resolve them through the
    // export map; everything else mirrors the worktree layout.
    if (specifier.startsWith("@openbooks/engine/")) {
      const subpath = "./" + specifier.slice("@openbooks/engine/".length);
      const target = engineExports[subpath];
      if (typeof target === "string") return next(root + "engine/" + target.slice(2), context);
      return next(root + specifier.slice("@openbooks/".length), context);
    }
    return next(specifier, context);
  },
});
const { db, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/testing/fixtures");
const { documentRevisionCounterSql } = await import("@openbooks/engine/records/revision");
const { PATCH } = await import("./route.ts");
// The route's web/lib chain re-registers the app RLS resolver at import
// time (see route-recall); re-install the test boundary after the imports.
const { installTrustedTestDatabaseBypass } =
  await import("@openbooks/engine/testing/database-bypass");
installTrustedTestDatabaseBypass();

async function revision(orgId: string, id: string): Promise<string> {
  return (
    await db.execute<{ revision: string }>(
      sql`select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents where id=${id} and org_id=${orgId}`,
      "objects",
    )
  )[0]!.revision;
}

async function patchDoc(
  orgId: string,
  id: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await withOrgContext(orgId, () =>
    PATCH(
      new Request(`http://documents.test/api/documents/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function fixture(): Promise<{
  orgId: string;
  saleId: string;
  bankId: string;
  cleanup: () => Promise<void>;
}> {
  const org = await createScratchOrg();
  state.orgId = org.orgId;
  state.actorId = randomUUID();
  await db.execute(sql`
    update orgs set settings = settings
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) || '{"cashSales": true}'::jsonb)
     where id = ${org.orgId}`);
  const bankId = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, currency_restriction, required_dimensions, custom, subsidiary_include_children)
    values (${bankId}, ${org.orgId}, '1010', 'Till Operating', 'asset_bank', false, true, false, true, 'CAD', '[]'::jsonb, '{}'::jsonb, true)`);
  const saleId = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
    values (${saleId}, ${org.orgId}, 'cash_sale', 'draft', 'CS-TABLE', ${org.date}, ${org.subsidiaryId}, 'CAD', '100.0000', '0', '100.0000', '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, account_id, description, quantity, unit_price, amount)
    values (${randomUUID()}, ${org.orgId}, ${saleId}, 1, ${bankId}, 'Till sale', '1', '100.0000', '100.0000')`);
  return { orgId: org.orgId, saleId, bankId, cleanup: () => dropScratchOrg(org.orgId) };
}

test("cash tenders persist in the table and never in custom", async () => {
  const { orgId, saleId, bankId, cleanup } = await fixture();
  try {
    const saved = await patchDoc(orgId, saleId, {
      expectedUpdatedAt: await revision(orgId, saleId),
      custom: { tenders: [{ kind: "cash", accountId: bankId, amount: "100" }] },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const rows = await db.execute<{ kind: string; minor: string; currency: string }>(
      sql`
      select kind, amount_minor::text as minor, currency from document_tenders
       where org_id = ${orgId} and document_id = ${saleId} order by position`,
      "objects",
    );
    assert.deepEqual(rows, [{ kind: "cash", minor: "1000000", currency: "CAD" }]);
    const custom = (
      await db.execute<{ custom: Record<string, unknown> }>(
        sql`
      select custom from documents where id = ${saleId} and org_id = ${orgId}`,
        "objects",
      )
    )[0]!.custom;
    assert.ok(!("tenders" in custom), "the tenders key must not persist in custom");
    // An unrelated edit keeps the tenders; a bad kind refuses by name.
    const kept = await patchDoc(orgId, saleId, {
      expectedUpdatedAt: await revision(orgId, saleId),
      memo: "still tendered",
    });
    assert.equal(kept.status, 200, JSON.stringify(kept.json));
    assert.equal(
      (
        await db.execute<{ n: string }>(
          sql`
      select count(*)::text as n from document_tenders where org_id = ${orgId} and document_id = ${saleId}`,
          "objects",
        )
      )[0]!.n,
      "1",
    );
    const refused = await patchDoc(orgId, saleId, {
      expectedUpdatedAt: await revision(orgId, saleId),
      custom: { tenders: [{ kind: "cheque", accountId: bankId, amount: "100" }] },
    });
    assert.equal(refused.status, 422, JSON.stringify(refused.json));
    assert.match(JSON.stringify(refused.json), /must be one of/);
  } finally {
    await cleanup();
  }
});

async function closeoutFixture(): Promise<{
  orgId: string;
  saleId: string;
  bankId: string;
  cleanup: () => Promise<void>;
}> {
  const org = await createScratchOrg();
  state.orgId = org.orgId;
  state.actorId = randomUUID();
  await db.execute(sql`
    update orgs set settings = settings
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) || '{"cashSales": true}'::jsonb)
     where id = ${org.orgId}`);
  const bankId = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, currency_restriction, required_dimensions, custom, subsidiary_include_children)
    values (${bankId}, ${org.orgId}, '1010', 'Till Operating', 'asset_bank', false, true, false, true, 'CAD', '[]'::jsonb, '{}'::jsonb, true)`);
  const saleId = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
    values (${saleId}, ${org.orgId}, 'cash_sale', 'draft', 'CS-CLOSEOUT', ${org.date}, ${org.subsidiaryId}, 'CAD', '100.0000', '0', '100.0000', '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, account_id, description, quantity, unit_price, amount)
    values (${randomUUID()}, ${org.orgId}, ${saleId}, 1, ${bankId}, 'Till sale', '1', '100.0000', '100.0000')`);
  return { orgId: org.orgId, saleId, bankId, cleanup: () => dropScratchOrg(org.orgId) };
}

async function storedCustom(orgId: string, saleId: string): Promise<Record<string, unknown>> {
  return (
    await db.execute<{ custom: Record<string, unknown> }>(
      sql`
    select custom from documents where id = ${saleId} and org_id = ${orgId}`,
      "objects",
    )
  )[0]!.custom;
}

test("card tip and fee persist and survive a table-reseeded save", async () => {
  const { orgId, saleId, bankId, cleanup } = await closeoutFixture();
  try {
    // The drawer collects 110 gross on the card tender: the 100 total plus
    // a 12 tip for staff, less a 2 processor fee.
    const saved = await patchDoc(orgId, saleId, {
      expectedUpdatedAt: await revision(orgId, saleId),
      custom: {
        tenders: [
          { kind: "card", accountId: bankId, amount: "110", tipAmount: "12", feeAmount: "2" },
        ],
        closeout: { overShort: "0", serverPartyId: null },
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const first = await storedCustom(orgId, saleId);
    assert.deepEqual((first.closeout as Record<string, unknown>).parts, [
      { position: 1, tip: "12.0000", fee: "2.0000" },
    ]);
    // A reload reseeds the editor from the tender table (gross amounts only)
    // plus the close-out's draft shape; resaving an unrelated edit must keep
    // the stored parts instead of blanking and wiping them.
    const reseeded = await patchDoc(orgId, saleId, {
      expectedUpdatedAt: await revision(orgId, saleId),
      memo: "counted twice",
      custom: {
        tenders: [
          { kind: "card", accountId: bankId, amount: "110", tipAmount: "12", feeAmount: "2" },
        ],
        closeout: { overShort: "0.0000" },
      },
    });
    assert.equal(reseeded.status, 200, JSON.stringify(reseeded.json));
    assert.deepEqual((await storedCustom(orgId, saleId)).closeout, first.closeout);
  } finally {
    await cleanup();
  }
});

test("a close-out resubmitted against stale stated totals recomputes from the tenders", async () => {
  const { orgId, saleId, bankId, cleanup } = await closeoutFixture();
  try {
    const saved = await patchDoc(orgId, saleId, {
      expectedUpdatedAt: await revision(orgId, saleId),
      custom: {
        tenders: [
          { kind: "card", accountId: bankId, amount: "110", tipAmount: "12", feeAmount: "2" },
        ],
        closeout: { overShort: "0", serverPartyId: null },
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    // The operator clears the tips and reduces the tender to the total while
    // the payload still states the stored totals: the header totals derive
    // from the fresh tenders in the same statement, so the save recomputes
    // the header instead of refusing — recovering the draft.
    const revert = await patchDoc(orgId, saleId, {
      expectedUpdatedAt: await revision(orgId, saleId),
      custom: {
        tenders: [{ kind: "card", accountId: bankId, amount: "100" }],
        closeout: (await storedCustom(orgId, saleId)).closeout,
      },
    });
    assert.equal(revert.status, 200, JSON.stringify(revert.json));
    assert.ok(
      !("closeout" in (await storedCustom(orgId, saleId))),
      "the emptied close-out must clear",
    );
  } finally {
    await cleanup();
  }
});

test("a close-out refusal names its message and remedy", async () => {
  const { orgId, saleId, bankId, cleanup } = await closeoutFixture();
  try {
    // A tip larger than its tender collects more than the till received:
    // the 422 must carry both the reason and the remedy the drawer renders.
    const refused = await patchDoc(orgId, saleId, {
      expectedUpdatedAt: await revision(orgId, saleId),
      custom: {
        tenders: [{ kind: "card", accountId: bankId, amount: "100", tipAmount: "200" }],
        closeout: { overShort: "0", serverPartyId: null },
      },
    });
    assert.equal(refused.status, 422, JSON.stringify(refused.json));
    assert.match(String((refused.json as Record<string, unknown>).error), /exceeds its tender/);
    assert.match(
      String((refused.json as Record<string, unknown>).remedy),
      /at most what the tender collected/,
    );
  } finally {
    await cleanup();
  }
});

test("clearing the close-out server pools the tips without wiping them", async () => {
  const { orgId, saleId, bankId, cleanup } = await closeoutFixture();
  try {
    const serverId = (
      await db.execute<{ id: string }>(
        sql`
      select id from parties where org_id = ${orgId} and is_active limit 1`,
        "objects",
      )
    )[0]!.id;
    const saved = await patchDoc(orgId, saleId, {
      expectedUpdatedAt: await revision(orgId, saleId),
      custom: {
        tenders: [
          { kind: "card", accountId: bankId, amount: "110", tipAmount: "12", feeAmount: "2" },
        ],
        closeout: { overShort: "0", serverPartyId: serverId },
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(
      ((await storedCustom(orgId, saleId)).closeout as Record<string, unknown>).serverPartyId,
      serverId,
    );
    // An explicit null pools the tips: the server clears and the tender
    // tips survive, so pooled is a selection, never a data loss.
    const pooled = await patchDoc(orgId, saleId, {
      expectedUpdatedAt: await revision(orgId, saleId),
      custom: {
        tenders: [
          { kind: "card", accountId: bankId, amount: "110", tipAmount: "12", feeAmount: "2" },
        ],
        closeout: { overShort: "0.0000", serverPartyId: null },
      },
    });
    assert.equal(pooled.status, 200, JSON.stringify(pooled.json));
    const stored = (await storedCustom(orgId, saleId)).closeout as Record<string, unknown>;
    assert.equal(stored.serverPartyId, null);
    assert.deepEqual(stored.parts, [{ position: 1, tip: "12.0000", fee: "2.0000" }]);
  } finally {
    await cleanup();
  }
});

test("a tip removal that derives the close-out from the tenders succeeds", async () => {
  const { orgId, saleId, bankId, cleanup } = await closeoutFixture();
  try {
    const saved = await patchDoc(orgId, saleId, {
      expectedUpdatedAt: await revision(orgId, saleId),
      custom: {
        tenders: [
          { kind: "card", accountId: bankId, amount: "110", tipAmount: "12", feeAmount: "2" },
        ],
        closeout: { overShort: "0", serverPartyId: null },
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    // The drawer reseeds the close-out as its draft shape (no stated
    // totals), so the writer derives the emptied close-out from the fresh
    // tenders and the wedged draft recovers through the UI.
    const revert = await patchDoc(orgId, saleId, {
      expectedUpdatedAt: await revision(orgId, saleId),
      custom: {
        tenders: [{ kind: "card", accountId: bankId, amount: "100" }],
        closeout: { overShort: "0.0000" },
      },
    });
    assert.equal(revert.status, 200, JSON.stringify(revert.json));
    assert.ok(
      !("closeout" in (await storedCustom(orgId, saleId))),
      "the emptied close-out must clear",
    );
  } finally {
    await cleanup();
  }
});
