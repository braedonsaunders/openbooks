import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// A stored custom-field `false` reaches the list as the TEXT 'false' today
// (custom->> extraction), and the list view renders booleans by JS
// truthiness — so a stored false displays "Yes". The descriptor must extract
// a real boolean. SQL builders and storage are real; only the server-only
// seam is stubbed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { columnDescriptors, DOCUMENT_BUILT_IN_EXPR } = await import("./list-query.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;

const booleanDef = {
  targetTable: "documents",
  targetKind: "vendor_bill",
  key: "flag",
  label: "Flag",
  fieldType: "boolean",
  config: { showInList: true },
  isRequired: false,
  sortOrder: 0,
} as const;

test("boolean custom columns extract real booleans, so stored false is falsy", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const base = defaultListView("vendor_bill");
    const view = {
      ...base,
      columns: [...base.columns, { key: "cf_flag", visible: true }],
    };
    const cols = columnDescriptors("vendor_bill", view, [booleanDef] as never, DOCUMENT_BUILT_IN_EXPR, {}, "d");
    const flag = cols.find((c) => c.key === "cf_flag");
    assert.ok(flag?.expr, "the boolean custom column must produce a select expression");

    const insert = async (custom: string): Promise<string> => {
      const id = randomUUID();
      await db.execute(sql`insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, currency, subtotal, tax_total, total, custom)
        values (${id}, ${org.orgId}, 'vendor_bill', 'draft', ${`BILL-${id.slice(0, 8)}`}, ${org.date}, ${org.subsidiaryId}, 'CAD', '10', '0', '10', ${custom}::jsonb)`);
      return id;
    };
    const read = async (id: string): Promise<unknown> => {
      const rows = (
        await db.execute<{ v: unknown }>(sql`select ${flag.expr} as v from documents d where d.id = ${id}`)
      ).rows;
      return rows[0]!.v;
    };

    // Strict equality: the text 'false' is truthy and renders "Yes".
    assert.equal(await read(await insert('{"flag": false}')), false, "stored false must extract as boolean false");
    assert.equal(await read(await insert('{"flag": true}')), true, "stored true must extract as boolean true");
    assert.equal(await read(await insert('{}')), null, "missing value must stay null");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
