/**
 * Seed a tenant's negotiated surcharges as rate-card configuration.
 *
 * A surcharge is an ordinary priced term of a customer agreement: an item, a
 * percentage, and the work it is measured against. This turns a legacy
 * customer->rate export into exactly that — one rate book per distinct rate,
 * one commercial adjustment on its active version, and one assignment per
 * customer — so the billing engine produces the line from configuration alone.
 *
 * Reads /tmp/custfuel.tsv  (legacy customer id, rate as a fraction)
 * Usage: npx tsx --conditions=react-server src/validation/seed-rate-adjustments.ts [--apply]
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";

const ORG = process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const APPLY = process.argv.includes("--apply");
const SOURCE = process.env.RATE_SOURCE ?? "/tmp/custfuel.tsv";
const ITEM_NAME = process.env.SURCHARGE_ITEM ?? "Fuel Surcharge";
const CODE = process.env.SURCHARGE_CODE ?? "fuel";

async function retry<T>(fn: () => Promise<T>, n = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const chain: string[] = [];
      for (let c: any = e; c; c = c.cause) chain.push(String(c?.message ?? ""));
      if (!/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection/i.test(chain.join(" "))) throw e;
      await new Promise((r) => setTimeout(r, 900 * (i + 1)));
    }
  }
  throw last;
}

(async () => {
  const env = (await retry(() => db.execute(sql`select env_kind from orgs where id = ${ORG}`))) as any;
  if (env.rows[0]?.env_kind !== "sandbox") throw new Error("refusing: target org is not a sandbox");

  // legacy customer ref -> rate, as a PERCENTAGE (the export carries a fraction)
  const pairs = readFileSync(SOURCE, "utf8").split("\n").map((l) => l.split("\t"))
    .filter((c) => c.length >= 2 && /^\d+$/.test(c[0]!))
    .map((c) => ({ ref: c[0]!, percent: Number(c[1]) * 100 }))
    .filter((p) => p.percent > 0.01); // a zero rate is simply no assignment

  const byRate = new Map<string, string[]>();
  for (const p of pairs) {
    const key = p.percent.toFixed(4);
    byRate.set(key, [...(byRate.get(key) ?? []), p.ref]);
  }
  console.log(`${pairs.length} customers with a surcharge, ${byRate.size} distinct rates: ${[...byRate.keys()].join(", ")}`);
  if (!APPLY) { console.log("(plan only — pass --apply)"); process.exit(0); }

  const one = async (q: any) => ((await retry(() => db.execute(q))) as any).rows[0];
  const actor = (await one(sql`select id from users where org_id = ${ORG} order by created_at limit 1`))?.id;
  const currency = (await one(sql`select base_currency from orgs where id = ${ORG}`))?.base_currency ?? "CAD";

  // The charge needs a real item so it lands on a revenue account like any
  // other billed line; reuse the tenant's own item when it already exists.
  let item = await one(sql`select id from items where org_id = ${ORG} and name = ${ITEM_NAME} limit 1`);
  if (!item) {
    const income = await one(sql`
      select id from accounts where org_id = ${ORG} and type = 'revenue' and is_active order by number limit 1`);
    item = await one(sql`
      insert into items (org_id, kind, name, category, income_account_id, created_by, updated_by)
      values (${ORG}, 'other_charge', ${ITEM_NAME}, 'Surcharges', ${income?.id ?? null}, ${actor}, ${actor})
      returning id`);
    console.log(`created item ${ITEM_NAME}`);
  }

  const parties = new Map<string, string>(
    (((await retry(() => db.execute(sql`
      select custom->>'nsId' k, id from parties where org_id = ${ORG} and custom->>'nsId' is not null`))) as any).rows as any[])
      .map((r) => [String(r.k), String(r.id)]),
  );

  let books = 0, assigned = 0, unmapped = 0;
  for (const [percent, refs] of byRate) {
    const code = `${CODE.toUpperCase()}-${percent.replace(/\.?0+$/, "")}`;
    let book = await one(sql`select id from item_rate_books where org_id = ${ORG} and code = ${code}`);
    if (!book) {
      book = await one(sql`
        insert into item_rate_books (org_id, code, name, currency, created_by, updated_by)
        values (${ORG}, ${code}, ${`${ITEM_NAME} ${percent.replace(/0+$/, "").replace(/\.$/, "")}%`}, ${currency}, ${actor}, ${actor})
        returning id`);
      books++;
    }
    let version = await one(sql`select id from item_rate_versions where org_id = ${ORG} and rate_book_id = ${book.id} order by effective_from limit 1`);
    if (!version) {
      version = await one(sql`
        insert into item_rate_versions (org_id, rate_book_id, effective_from, status, created_by, updated_by)
        values (${ORG}, ${book.id}, '1900-01-01', 'active', ${actor}, ${actor}) returning id`);
    }
    // percent of billable time, billed as its own line
    const adj = await one(sql`
      insert into labor_rate_adjustments (org_id, version_id, code, name, category, calculation, value,
                                          presentation, item_id, created_by, updated_by)
      values (${ORG}, ${version.id}, ${CODE}, ${ITEM_NAME}, 'surcharge', 'percent', ${percent},
              'separate', ${item.id}, ${actor}, ${actor})
      on conflict (version_id, code) do update set value = excluded.value, item_id = excluded.item_id,
              presentation = excluded.presentation, is_active = true
      returning id`);
    await retry(() => db.execute(sql`
      insert into labor_rate_adjustment_targets (org_id, adjustment_id, target_type, target_value_text, created_by, updated_by)
      values (${ORG}, ${adj.id}, 'labor', 'labor', ${actor}, ${actor})
      on conflict do nothing`));

    const ids = refs.map((r) => parties.get(r)).filter(Boolean) as string[];
    unmapped += refs.length - ids.length;
    if (ids.length) {
      const r = (await retry(() => db.execute(sql`
        insert into item_rate_book_assignments (org_id, rate_book_id, customer_id, created_by, updated_by)
        select ${ORG}, ${book.id}, c, ${actor}, ${actor}
          from unnest(${`{${ids.join(",")}}`}::uuid[]) c
         where not exists (select 1 from item_rate_book_assignments a
                            where a.org_id = ${ORG} and a.rate_book_id = ${book.id} and a.customer_id = c)`))) as any;
      assigned += r.rowCount ?? 0;
    }
    console.log(`  ${code}: ${ids.length} customers (${refs.length - ids.length} unmapped)`);
  }
  console.log(`\nbooks created ${books}, assignments created ${assigned}, customers not in this tenant ${unmapped}`);
  process.exit(0);
})().catch((e) => {
  const chain: string[] = [];
  for (let c: any = e; c; c = c.cause) if (c?.message) chain.push(String(c.message).replace(/\s+/g, " ").slice(0, 200));
  console.error("FATAL:", chain.pop() ?? "unknown");
  process.exit(1);
});
