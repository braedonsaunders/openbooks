/**
 * Link every job to the rate card the source system says governs it.
 *
 * The card is named ON THE JOB in the source, which is more specific than any
 * customer-level mapping: two sites of the same customer run different cards,
 * and a customer-level guess silently picks the wrong one. That is why fuel and
 * markup went missing — the imported cards had customer assignments for only
 * 247 of 1,221 books, and some pointed at the wrong site.
 *
 * Also sets each project's type from the source's billing type, because markup
 * on rebilled vendor cost applies to time-and-materials work and not to fixed
 * price, where those bills are carried for cost accuracy alone.
 *
 * Reads /tmp/jobs-rate.json  [{ id, entityid, jobbillingtype, rate_id }]
 * Usage: npx tsx --conditions=react-server src/validation/link-job-rate-cards.ts [--apply]
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { resolveTargetOrg } from "./target-org.ts";

const ORG = process.env.TARGET_ORG ?? process.env.SANDBOX_ORG ?? (() => { throw new Error("SANDBOX_ORG is required"); })();
const APPLY = process.argv.includes("--apply");
/** Source billing type -> the project type that carries its invoicing rules. */
const BILLING_TYPE: Record<string, string> = { TM: "Time & Materials", FBI: "Fixed Price", FBM: "Fixed Price" };

async function retry<T>(fn: () => Promise<T>, n = 10): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const chain: string[] = [];
      for (let c: any = e; c; c = c.cause) chain.push(String(c?.message ?? ""));
      if (!/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection|socket/i.test(chain.join(" "))) throw e;
      await new Promise((r) => setTimeout(r, Math.min(15_000, 1500 * (i + 1))));
    }
  }
  throw last;
}

(async () => {
  await resolveTargetOrg(ORG);

  const jobs = JSON.parse(readFileSync("/tmp/jobs-rate.json", "utf8")) as any[];
  const actor = ((await retry(() => db.execute(sql`select id from users where org_id = ${ORG} order by created_at limit 1`))) as any).rows[0]?.id;

  const projects = new Map<string, string>(
    (((await retry(() => db.execute(sql`
      select custom->>'nsId' k, id from projects where org_id = ${ORG} and custom->>'nsId' is not null`))) as any).rows as any[])
      .map((r) => [String(r.k), String(r.id)]),
  );
  const books = new Map<string, string>(
    (((await retry(() => db.execute(sql`
      select code, id from item_rate_books where org_id = ${ORG}`))) as any).rows as any[])
      .map((r) => [String(r.code), String(r.id)]),
  );
  const types = new Map<string, string>(
    (((await retry(() => db.execute(sql`
      select name, id from project_types where org_id = ${ORG}`))) as any).rows as any[])
      .map((r) => [String(r.name), String(r.id)]),
  );

  const links: { project: string; book: string }[] = [];
  const retypes: { project: string; type: string }[] = [];
  let noProject = 0, noBook = 0, noType = 0;
  for (const j of jobs) {
    const projectId = projects.get(String(j.id));
    if (!projectId) { noProject++; continue; }
    const bookId = j.rate_id ? books.get(`LAB-${j.rate_id}`) : undefined;
    if (bookId) links.push({ project: projectId, book: bookId }); else noBook++;
    const typeId = types.get(BILLING_TYPE[String(j.jobbillingtype)] ?? "");
    if (typeId) retypes.push({ project: projectId, type: typeId }); else noType++;
  }
  console.log(`${jobs.length} source jobs: ${links.length} card links, ${retypes.length} billing types`);
  console.log(`  job absent here ${noProject}, card not found ${noBook}, billing type unmapped ${noType}`);
  if (!APPLY) { console.log("(plan only — pass --apply)"); process.exit(0); }

  let linked = 0;
  for (let i = 0; i < links.length; i += 400) {
    const b = links.slice(i, i + 400);
    const r = (await retry(() => db.execute(sql`
      insert into item_rate_book_assignments (org_id, rate_book_id, project_id, created_by, updated_by)
      select ${ORG}, v.book::uuid, v.project::uuid, ${actor}, ${actor}
        from (select unnest(${`{${b.map((x) => x.book).join(",")}}`}::uuid[]) book,
                     unnest(${`{${b.map((x) => x.project).join(",")}}`}::uuid[]) project) v
       where not exists (select 1 from item_rate_book_assignments a
                          where a.org_id = ${ORG} and a.project_id = v.project::uuid
                            and a.rate_book_id = v.book::uuid)`))) as any;
    linked += r.rowCount ?? 0;
  }
  let typed = 0;
  for (let i = 0; i < retypes.length; i += 400) {
    const b = retypes.slice(i, i + 400);
    const r = (await retry(() => db.execute(sql`
      update projects p set project_type_id = v.type::uuid, updated_at = now()
        from (select unnest(${`{${b.map((x) => x.project).join(",")}}`}::uuid[]) project,
                     unnest(${`{${b.map((x) => x.type).join(",")}}`}::uuid[]) type) v
       where p.id = v.project::uuid and p.org_id = ${ORG}
         and p.project_type_id is distinct from v.type::uuid`))) as any;
    typed += r.rowCount ?? 0;
  }
  console.log(`\nAPPLIED: ${linked} project->card assignments, ${typed} project types corrected`);
  process.exit(0);
})().catch((e) => {
  const chain: string[] = [];
  for (let c: any = e; c; c = c.cause) if (c?.message) chain.push(String(c.message).replace(/\s+/g, " ").slice(0, 250));
  console.error("FATAL:", chain.pop() ?? "unknown");
  process.exit(1);
});
