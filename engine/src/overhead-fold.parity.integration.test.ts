import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { db, inDbTransaction } from "./db.ts";
import { add, isZero, neg, normalizeMoney } from "./money.ts";
import {
  overheadApplicationSettings,
  overheadRateAppliesToTimeEntry,
  applyOverheadForTime,
  reverseOverheadForTime,
} from "./overhead-apply.ts";
import { OVERHEAD_SYSTEM_RULE_KEY } from "./allocations/overhead-sync.ts";
import { postProjectGlEntryWithinTransaction } from "./project-recognition.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

const DB = process.env.OPENBOOKS_DB_URL ? true : false;

/**
 * Parity oracle: the pre-fold builder, transcribed verbatim from
 * overhead-apply.ts at commit cc110ab5f (eligibility, math, plain lines,
 * stamp). The folded path must post byte-identical journal lines
 * (account, dims, signed amounts, count, memos, order) for a mirror entry
 * set while adding the kernel stamp + lineage the oracle lacks.
 */
async function legacyApplyOverheadForTime(
  orgId: string,
  actorId: string,
  timeEntryIds: string[],
): Promise<{ entryId: string | null; total: string }> {
  return inDbTransaction(async (tx) => {
    const settings = await overheadApplicationSettings(orgId);
    if (settings.mode !== "net_zero_pair" || !settings.accountId) return { entryId: null, total: "0" };
    const idArr = `{${timeEntryIds.join(",")}}`;
    const rows = (await tx.execute<{ id: string; project_id: string; worked_on: string; amount: string }>(sql`
      with locked as (
        select te.id, te.org_id, te.project_id, te.worked_on, te.hours, te.department_id
          from time_entries te
         where te.org_id = ${orgId} and te.id = any(${idArr}::uuid[])
           and te.status = 'approved' and te.project_id is not null
           and te.costing_basis = 'actual'
           and te.overhead_journal_entry_id is null
           and not exists (
             select 1 from projects p
             join project_types pt on pt.id = p.project_type_id and pt.org_id = te.org_id
            where p.id = te.project_id and p.org_id = te.org_id
              and (
                select v.financial_profile->'overhead'->>'method'
                  from project_financial_profile_versions v
                 where v.org_id = te.org_id
                   and v.project_type_id = pt.id
                   and v.effective_from <= te.worked_on
                   and (v.effective_to is null or v.effective_to >= te.worked_on)
                 order by v.effective_from desc
                 limit 1
              ) = 'none'
           )
         order by te.id
         for update of te
      )
      select entry.id, entry.project_id, entry.worked_on,
             sum(round(entry.hours * r.rate_percent, 4)) as amount
        from locked entry
        join overhead_rates r
          on r.rate_kind = 'per_hour'
         and ${overheadRateAppliesToTimeEntry("r", "entry")}
       group by entry.id, entry.project_id, entry.worked_on
       order by entry.id`));
    if (rows.rows.length === 0) return { entryId: null, total: "0" };
    const byProject = new Map<string, string>();
    const carried: string[] = [];
    let total = "0";
    let maxDate = "";
    for (const r of rows.rows) {
      const amt = normalizeMoney(String(r.amount));
      if (isZero(amt)) continue;
      byProject.set(r.project_id, add(byProject.get(r.project_id) ?? "0", amt));
      total = add(total, amt);
      carried.push(r.id);
      if (r.worked_on > maxDate) maxDate = r.worked_on;
    }
    if (isZero(total) || carried.length === 0) return { entryId: null, total: "0" };
    const lines: { accountId: string; amount: string; projectId?: string | null; memo?: string }[] = [];
    for (const [projectId, amt] of byProject) {
      lines.push({ accountId: settings.accountId!, amount: amt, projectId, memo: "Overhead applied" });
    }
    lines.push({ accountId: settings.accountId, amount: neg(total), projectId: null, memo: "Overhead applied — contra" });
    const entryId = await postProjectGlEntryWithinTransaction(tx, {
      orgId,
      actorId,
      origin: "overhead_applied",
      entryNumber: `OVH-${maxDate}-${carried[0]!.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
      postingDate: maxDate,
      memo: "Overhead applied with approved hours (net-zero pair)",
      lines,
    });
    if (!entryId) return { entryId: null, total: "0" };
    await tx.execute(sql`update time_entries set overhead_journal_entry_id = ${entryId},
        updated_at = now(), updated_by = ${actorId}
      where org_id = ${orgId} and id = any(${`{${carried.join(",")}}`}::uuid[]) and overhead_journal_entry_id is null`);
    return { entryId, total };
  });
}

interface Fixture {
  orgId: string;
  actorId: string;
  accountId: string;
  setA: string[];
  setB: string[];
  excluded: string[];
}

async function seed(): Promise<Fixture> {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const deptField = randomUUID();
    const deptShop = randomUUID();
    const projP1 = randomUUID();
    const projP2 = randomUUID();
    const projP3 = randomUUID();
    const optOutType = randomUUID();
    await db.execute(sql`update orgs set settings=settings || ${JSON.stringify({
      features: { projects: true, timeTracking: true },
      overheadApplication: { mode: "net_zero_pair", accountId: org.accounts.adjustment },
    })}::jsonb where id=${org.orgId}`);
    await db.execute(sql`insert into departments(id,org_id,name)
      values(${deptField},${org.orgId},'Field'),(${deptShop},${org.orgId},'Shop')`);
    // Stacked category rows (Field sums 10 + 2.5), an org-wide fallback, and
    // a percent row the hourly posting must ignore.
    await db.execute(sql`insert into overhead_rates(id,org_id,department_id,category,method,rate_kind,rate_percent,effective_from)
      values(${randomUUID()},${org.orgId},${deptField},'Facilities','standard','per_hour',10,'2026-01-01'),
            (${randomUUID()},${org.orgId},${deptField},'Admin','standard','per_hour',2.5,'2026-01-01'),
            (${randomUUID()},${org.orgId},${deptShop},'Facilities','standard','per_hour',20,'2026-01-01'),
            (${randomUUID()},${org.orgId},null,'Facilities','standard','per_hour',5,'2026-01-01'),
            (${randomUUID()},${org.orgId},${deptShop},'Burden','standard','percent',50,'2026-01-01')`);
    const profile = BUILTIN_PROJECT_TYPES.find((p) => p.key === "time_and_materials") ?? BUILTIN_PROJECT_TYPES[0]!;
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values(${optOutType},${org.orgId},'parity_opt_out','Parity opt-out','time_and_materials',
        ${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`);
    await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
      values(${org.orgId},${optOutType},'2026-01-01',
        ${JSON.stringify({ ...profile.financialProfile, overhead: { method: "none" } })}::jsonb,'Parity opt-out policy')`);
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
      values(${randomUUID()},${org.orgId},'person','Parity worker',${org.subsidiaryId},true,'{}'::jsonb)
      returning id`);
    const employeeId = (await db.execute<{ id: string }>(sql`select id from parties
      where org_id = ${org.orgId} and display_name = 'Parity worker'`)).rows[0]!.id;
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
      values(${projP1},${org.orgId},${org.subsidiaryId},'PAR-P1','Parity job one',${org.customerId},'active',true,'{}'::jsonb),
            (${projP2},${org.orgId},${org.subsidiaryId},'PAR-P2','Parity job two',${org.customerId},'active',true,'{}'::jsonb),
            (${projP3},${org.orgId},${org.subsidiaryId},'PAR-P3','Parity opt-out job',${org.customerId},'active',true,'{}'::jsonb)`);
    await db.execute(sql`update projects set project_type_id = ${optOutType}
      where org_id = ${org.orgId} and id = ${projP3}`);
    // Mirror entry sets: same departments, projects, hours and worked days.
    const specs: Array<{ dept: string | null; project: string; hours: string; workedOn: string }> = [
      { dept: deptField, project: projP1, hours: "2", workedOn: "2026-07-10" },
      { dept: deptField, project: projP1, hours: "1", workedOn: "2026-07-11" },
      { dept: deptShop, project: projP2, hours: "3", workedOn: "2026-07-10" },
      { dept: null, project: projP2, hours: "4", workedOn: "2026-07-12" },
      { dept: deptShop, project: projP3, hours: "5", workedOn: "2026-07-10" },
      { dept: deptField, project: projP1, hours: "0", workedOn: "2026-07-10" },
    ];
    const setA: string[] = [];
    const setB: string[] = [];
    // Order-preserving ids: both sets iterate in spec order (uuid comparison
    // is byte-wise, so a shared suffix sequence keeps the relative order),
    // which is what makes the two journals' leg order comparable.
    const detId = (prefix: string, n: number): string =>
      `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
    let n = 0;
    for (const spec of specs) {
      n += 1;
      const pair: Array<{ set: string[]; id: string }> = [
        { set: setA, id: detId("aaaaaaaa", n) },
        { set: setB, id: detId("bbbbbbbb", n) },
      ];
      for (const { set, id } of pair) {
        await db.execute(sql`insert into time_entries
          (id,org_id,employee_party_id,worked_on,hours,project_id,department_id,status,
           cost_rate,cost_rate_currency,cost_rate_subsidiary_id,costing_basis,is_billable,custom,created_by,updated_by)
          values(${id},${org.orgId},${employeeId},${spec.workedOn},${spec.hours},${spec.project},${spec.dept},
            'approved',25,'CAD',${org.subsidiaryId},'actual',false,'{}'::jsonb,${actorId},${actorId})`);
        set.push(id);
      }
    }
    return {
      orgId: org.orgId, actorId, accountId: org.accounts.adjustment,
      setA, setB,
      excluded: [setA[4]!, setA[5]!, setB[4]!, setB[5]!],
    };
  } catch (error) {
    await dropScratchOrg(org.orgId);
    throw error;
  }
}

interface LineProjection {
  line_number: number;
  account: string;
  amount: string;
  project: string | null;
  memo: string | null;
  department: string | null;
}

async function journalProjection(orgId: string, entryId: string): Promise<LineProjection[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    select l.line_number, a.number as account, l.amount::text as amount,
           p.code as project, l.memo, d.name as department
      from journal_lines l
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
      left join projects p on p.org_id = l.org_id and p.id = l.project_id
      left join departments d on d.org_id = l.org_id and d.id = l.department_id
     where l.org_id = ${orgId} and l.entry_id = ${entryId}
     order by l.line_number`);
  return rows.rows.map((row) => ({
    line_number: Number(row["line_number"]),
    account: String(row["account"]),
    amount: String(row["amount"]),
    project: (row["project"] as string | null) ?? null,
    memo: (row["memo"] as string | null) ?? null,
    department: (row["department"] as string | null) ?? null,
  }));
}

test("folded overhead posts byte-identical lines to the pre-fold builder", { skip: !DB }, async () => {
  const f = await seed();
  try {
    const oracle = await legacyApplyOverheadForTime(f.orgId, f.actorId, f.setB);
    assert.ok(oracle.entryId);
    assert.equal(oracle.total, "117.5000");
    const folded = await applyOverheadForTime(f.orgId, f.actorId, f.setA);
    assert.ok(folded.entryId);
    assert.equal(folded.total, oracle.total);
    assert.equal(folded.entries, 4);
    assert.equal(folded.projects, 2);

    const oracleLines = await journalProjection(f.orgId, oracle.entryId);
    const foldedLines = await journalProjection(f.orgId, folded.entryId);
    assert.equal(foldedLines.length, 3);
    assert.deepEqual(foldedLines, oracleLines);

    // The fold adds the kernel stamp the oracle lacks.
    const stamps = await db.execute<{ contributor_kind: string | null; contributor_ref: string | null }>(sql`
      select contributor_kind, contributor_ref from journal_lines
       where org_id = ${f.orgId} and entry_id = ${folded.entryId} order by line_number`);
    const versionId = (await db.execute<{ id: string }>(sql`select v.id from allocation_rule_versions v
      join allocation_rules r on r.org_id = v.org_id and r.id = v.rule_id
      where r.org_id = ${f.orgId} and r.key = ${OVERHEAD_SYSTEM_RULE_KEY} and v.status = 'published'`)).rows[0]!.id;
    for (const stamp of stamps.rows) {
      assert.equal(stamp.contributor_kind, "rule");
      assert.equal(stamp.contributor_ref, versionId);
    }
    const oracleStamps = await db.execute<{ contributor_kind: string | null }>(sql`
      select contributor_kind from journal_lines
       where org_id = ${f.orgId} and entry_id = ${oracle.entryId}`);
    for (const stamp of oracleStamps.rows) assert.equal(stamp.contributor_kind, null);

    // Idempotency stamps: carried entries claim their journal, the opt-out
    // and zero-hour entries stay free in both sets.
    for (const [set, entryId] of [[f.setA, folded.entryId], [f.setB, oracle.entryId]] as const) {
      const claimed = await db.execute<{ id: string; overhead_journal_entry_id: string | null }>(sql`
        select id, overhead_journal_entry_id from time_entries where org_id = ${f.orgId} and id = any(${`{${set.join(",")}}`}::uuid[])`);
      for (const row of claimed.rows) {
        const excluded = f.excluded.includes(row.id);
        assert.equal(row.overhead_journal_entry_id, excluded ? null : entryId);
      }
    }

    // Lineage: one row per carried entry against its project leg, plus
    // nothing for the oracle journal and nothing for the contra leg.
    const lineage = await db.execute<{
      source_time_entry_id: string | null; amount: string; share: string;
      journal_line_id: string; rule_key: string; driver_key: string | null;
    }>(sql`select l.source_time_entry_id, l.amount::text as amount, l.share::text as share,
             l.journal_line_id, r.key as rule_key, d.key as driver_key
        from allocation_lineage l
        join allocation_rules r on r.org_id = l.org_id and r.id = l.rule_id
        left join allocation_drivers d on d.org_id = l.org_id and d.id = l.driver_id
       where l.org_id = ${f.orgId} and l.journal_entry_id = ${folded.entryId}
       order by l.created_at`);
    assert.equal(lineage.rows.length, 4);
    const legs = await db.execute<{ id: string; project_code: string | null }>(sql`
      select l.id, p.code as project_code from journal_lines l
      left join projects p on p.org_id = l.org_id and p.id = l.project_id
      where l.org_id = ${f.orgId} and l.entry_id = ${folded.entryId} order by l.line_number`);
    const legByProject = new Map(legs.rows.map((r) => [r.project_code, r.id]));
    const expected: Array<{ entry: string; amount: string; share: string; leg: string }> = [
      { entry: f.setA[0]!, amount: "25.0000", share: "0.2127659574", leg: "PAR-P1" },
      { entry: f.setA[1]!, amount: "12.5000", share: "0.1063829787", leg: "PAR-P1" },
      { entry: f.setA[2]!, amount: "60.0000", share: "0.5106382979", leg: "PAR-P2" },
      { entry: f.setA[3]!, amount: "20.0000", share: "0.1702127660", leg: "PAR-P2" },
    ];
    for (const want of expected) {
      const got = lineage.rows.find((r) => r.source_time_entry_id === want.entry);
      assert.ok(got, `lineage row for ${want.entry}`);
      assert.equal(got.amount, want.amount);
      assert.equal(got.share, want.share);
      assert.equal(got.journal_line_id, legByProject.get(want.leg));
      assert.equal(got.rule_key, OVERHEAD_SYSTEM_RULE_KEY);
      assert.equal(got.driver_key, "overhead-labor-hours");
    }
    const oracleLineage = await db.execute<{ n: string }>(sql`select count(*) as n from allocation_lineage
      where org_id = ${f.orgId} and journal_entry_id = ${oracle.entryId}`);
    assert.equal(oracleLineage.rows[0]?.n, "0");
  } finally {
    await dropScratchOrg(f.orgId);
  }
});

test("folded overhead reversal nets to zero and releases the stamp", { skip: !DB }, async () => {
  const f = await seed();
  try {
    const folded = await applyOverheadForTime(f.orgId, f.actorId, f.setA);
    assert.ok(folded.entryId);
    await reverseOverheadForTime(f.orgId, f.actorId, [f.setA[0]!], "Controller approved historical correction", "2026-07-20");
    const nets = await db.execute<{ total: string }>(sql`
      select sum(l.amount)::text as total from journal_lines l
       join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
      where l.org_id = ${f.orgId}
        and (l.entry_id = ${folded.entryId} or e.reverses_entry_id = ${folded.entryId})`);
    assert.equal(nets.rows[0]?.total, "0.0000");
    const released = await db.execute<{ n: string }>(sql`select count(*) as n from time_entries
      where org_id = ${f.orgId} and overhead_journal_entry_id is null and id = any(${`{${f.setA.join(",")}}`}::uuid[])`);
    assert.equal(released.rows[0]?.n, String(f.setA.length));
    // History survives the reversal: the four lineage rows stay put.
    const kept = await db.execute<{ n: string }>(sql`select count(*) as n from allocation_lineage
      where org_id = ${f.orgId} and journal_entry_id = ${folded.entryId}`);
    assert.equal(kept.rows[0]?.n, "4");
    // And the released entries post again through the kernel path.
    const again = await applyOverheadForTime(f.orgId, f.actorId, f.setA);
    assert.ok(again.entryId);
    assert.notEqual(again.entryId, folded.entryId);
    assert.equal(again.total, folded.total);
  } finally {
    await dropScratchOrg(f.orgId);
  }
});
