import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import pg from "pg";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "../locale" && context.parentURL?.includes("/pdf-templates/values"))
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function resolveLocale(){return "en-CA"}',
      };
    return next(specifier, context);
  },
});
const { sql } = await import("drizzle-orm");
const { db, pool, withBypassContext, withOrgContext, withBypass } =
  await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/testing/fixtures");
const { loadPdfRecordValues, MissingPdfOrgError } = await import("./values");
const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "document PDF amounts print in the document currency, not a fallback",
  { skip: !DB },
  async () => {
    // One policy: the document's currency, else the org's base. A EUR invoice
    // in a CAD org prints € amounts with a EUR merge value — the formatter and
    // the printed currency once disagreed (USD vs CAD) because each named its
    // own literal.
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const id = randomUUID();
      await withBypassContext(() =>
        db.execute(sql`
      insert into documents (id, org_id, kind, document_number, document_date, currency, subtotal, tax_total, total)
      values (${id}, ${org.orgId}, 'customer_invoice', 'INV-EUR-1', '2026-07-15', 'EUR', '100', '0', '100')`),
      );
      // Reads through a web reader run inside withOrgContext — importing the
      // reader pulls the web request-org resolver, which denies outside a scope.
      const loaded = await withOrgContext(org.orgId, () =>
        loadPdfRecordValues("customer_invoice", org.orgId, id, null),
      );
      assert.ok(loaded, "expected values for the inserted invoice");
      assert.equal(loaded.values["currency"], "EUR");
      assert.match(String(loaded.values["total"]), /€/);
      assert.doesNotMatch(String(loaded.values["total"]), /\$/);
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a record whose org row is gone is refused, never printed in an invented currency",
  { skip: !DB },
  async () => {
    // base_currency is NOT NULL, so the only way the org lookup misses is a
    // missing org row — a state the schema forbids. The loader must refuse by
    // name instead of falling back to an invented denomination (it once
    // printed CAD for a missing org).
    //
    // Production writes cannot reach that state: the tenant retirement fence
    // refuses any write that points a record at an organization without an
    // active fence. The orphan is therefore planted the way a restored or
    // hand-repaired database could hold one: the privileged test login moves
    // the record with trigger enforcement suspended for that one session, and
    // restores it before teardown so the scratch organization drops cleanly.
    const admin = new pg.Client({
      connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL ?? process.env.OPENBOOKS_DB_URL,
    });
    await admin.connect();
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const id = randomUUID();
      const orphanOrg = randomUUID();
      await withBypassContext(() =>
        db.execute(sql`
      insert into documents (id, org_id, kind, document_number, document_date, currency, subtotal, tax_total, total)
      values (${id}, ${org.orgId}, 'customer_invoice', 'INV-ORPHAN-1', '2026-07-15', 'EUR', '100', '0', '100')`),
      );
      try {
        await admin.query("set session_replication_role = 'replica'");
        await withBypass(() =>
          admin.query("update documents set org_id = $1 where id = $2", [orphanOrg, id]),
        );
        await admin.query("set session_replication_role = 'origin'");
        await assert.rejects(
          withOrgContext(orphanOrg, () =>
            loadPdfRecordValues("customer_invoice", orphanOrg, id, null),
          ),
          (e: unknown) => {
            assert.ok(e instanceof MissingPdfOrgError, `expected MissingPdfOrgError, got ${e}`);
            assert.match((e as Error).message, /invented currency/);
            return true;
          },
        );
      } finally {
        await admin.query("set session_replication_role = 'replica'");
        await withBypass(() =>
          admin.query("update documents set org_id = $1 where id = $2", [org.orgId, id]),
        );
        await admin.query("set session_replication_role = 'origin'");
      }
    } finally {
      await admin.end();
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test.after(async () => {
  await pool.end();
});
