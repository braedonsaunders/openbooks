/**
 * STEP 3.1–3.2 — DESTRUCTIVE ledger reset.
 *
 * Wipes the transactional ledger (documents, document_lines, document_links,
 * journal_entries, journal_lines, applications) so the native importer can
 * rebuild it. Leaves ALL master data untouched: accounts, parties, items,
 * tax_codes, departments, accounting_periods/books, orgs, users, roles,
 * projects.
 *
 * The kernel's je_guard/jl_guard forbid deleting posted entries. We are not a
 * DB superuser (no `session_replication_role`), so we DROP the two guard
 * triggers, delete, then RESTORE them exactly (kernel-guards.mts). The
 * balance/account/application triggers stay in force throughout.
 *
 * REVERSIBLE: the shortcut GL is reproducible via engine/src/replay-gl.ts and
 * everything here is git-committed.
 *
 * Run: node_modules/.bin/tsx engine/reset-ledger.mts --yes
 */
import { sql } from "drizzle-orm";
import { db, pool } from "./src/db.ts";
import { dropGuards, restoreGuards, guardsPresent } from "./src/kernel-guards.mts";

if (!process.argv.includes("--yes")) {
  console.error("refusing to run without --yes (DESTRUCTIVE). Re-run: … reset-ledger.mts --yes");
  await pool.end();
  process.exit(1);
}

const count = async (t: string) => (await db.execute(sql.raw(`select count(*)::int n from ${t}`))).rows[0].n as number;
const TABLES = ["applications", "document_links", "journal_lines", "journal_entries", "document_lines", "documents"];

console.log("=== SNAPSHOT (before) ===");
const before: Record<string, number> = {};
for (const t of TABLES) { before[t] = await count(t); console.log(`  ${t.padEnd(18)} ${before[t]}`); }
console.log(`  journal_entries by origin:`, JSON.stringify((await db.execute(sql`select origin, count(*)::int n from journal_entries group by origin`)).rows));

console.log("\ndropping guard triggers…");
await dropGuards();

let deleted: Record<string, number> = {};
try {
  // Break the documents<->journal_entries FK cycle first (both cleared anyway).
  await db.execute(sql`update documents set posted_entry_id = null where posted_entry_id is not null`);
  await db.execute(sql`update journal_entries set source_document_id = null where source_document_id is not null`);

  // document_lines.billed_by_line_id is a SELF-FK with no index; deleting 200k+
  // rows would seq-scan for every row (O(n²) → hangs). A temp index makes the
  // FK re-check a lookup. Dropped again after.
  await db.execute(sql`create index if not exists _tmp_docline_billedby on document_lines(billed_by_line_id)`);

  // FK-safe delete order.
  deleted.applications   = (await db.execute(sql`delete from applications`)).rowCount ?? 0;
  deleted.document_links = (await db.execute(sql`delete from document_links`)).rowCount ?? 0;
  deleted.journal_lines  = (await db.execute(sql`delete from journal_lines`)).rowCount ?? 0;
  deleted.journal_entries= (await db.execute(sql`delete from journal_entries`)).rowCount ?? 0;
  deleted.document_lines = (await db.execute(sql`delete from document_lines`)).rowCount ?? 0;
  deleted.documents      = (await db.execute(sql`delete from documents`)).rowCount ?? 0;
  await db.execute(sql`drop index if exists _tmp_docline_billedby`);
} finally {
  console.log("restoring guard triggers…");
  await restoreGuards();
}

console.log("\n=== DELETED ===");
for (const t of TABLES) console.log(`  ${t.padEnd(18)} ${deleted[t] ?? 0}`);

console.log("\n=== SNAPSHOT (after) ===");
for (const t of TABLES) console.log(`  ${t.padEnd(18)} ${await count(t)}`);

// master data sanity — must be UNCHANGED
console.log("\n=== MASTER DATA (unchanged) ===");
for (const t of ["accounts", "parties", "items", "tax_codes", "departments", "accounting_periods", "accounting_books", "orgs", "users"]) {
  try { console.log(`  ${t.padEnd(18)} ${await count(t)}`); } catch { /* table may not exist */ }
}

const g = await guardsPresent();
console.log(`\nguards restored: je_guard=${g.je} jl_guard=${g.jl}`);
if (!g.je || !g.jl) { console.error("FATAL: a guard trigger did not restore!"); process.exit(1); }

console.log("\nledger reset complete.");
await pool.end();
