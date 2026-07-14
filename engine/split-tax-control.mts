/**
 * Step 1.1 — PERMANENT config change: split the collapsed tax control accounts.
 *
 * NetSuite keeps purchase-side (recoverable ITC) tax on account 1200
 * "GST/HST on Purchases" (nsId 210) and sales-side tax on 2100 "GST/HST
 * Payable" (nsId 212). openbooks had both collapsed onto 2100. Point
 * controlAccounts.taxPaid at 1200 and taxCollected at 2100 so the posting
 * rules route purchase vs sales tax exactly as NetSuite does.
 *
 * Idempotent. Run: node_modules/.bin/tsx engine/split-tax-control.mts
 */
import { sql } from "drizzle-orm";
import { db, pool } from "./src/db.ts";

const [purchase] = (await db.execute(sql`
  select id, number, name from accounts where custom->>'nsId' = '210'`)).rows as any[];
const [payable] = (await db.execute(sql`
  select id, number, name from accounts where custom->>'nsId' = '212'`)).rows as any[];

if (!purchase || purchase.number !== "1200") throw new Error(`expected acct 1200 for taxPaid, got ${JSON.stringify(purchase)}`);
if (!payable || payable.number !== "2100") throw new Error(`expected acct 2100 for taxCollected, got ${JSON.stringify(payable)}`);

const [before] = (await db.execute(sql`select settings->'controlAccounts' ctrl from orgs limit 1`)).rows as any[];
console.log("before:", JSON.stringify(before.ctrl));

await db.execute(sql`
  update orgs set settings = jsonb_set(
    jsonb_set(settings, '{controlAccounts,taxPaid}', to_jsonb(${purchase.id}::text)),
    '{controlAccounts,taxCollected}', to_jsonb(${payable.id}::text))`);

const [after] = (await db.execute(sql`select settings->'controlAccounts' ctrl from orgs limit 1`)).rows as any[];
console.log("after: ", JSON.stringify(after.ctrl));
console.log(`taxPaid -> ${purchase.number} ${purchase.name}`);
console.log(`taxCollected -> ${payable.number} ${payable.name}`);
await pool.end();
