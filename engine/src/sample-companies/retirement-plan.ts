import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction } from "../platform/db.ts";
import { TENANT_TABLE_POLICIES } from "../sandbox/tenant-table-policies.ts";
import { retirementCatalogDigest } from "../organization/tenant-retirement.ts";
import { TENANT_RETIREMENT_GUARDS, TENANT_RETIREMENT_GUARD_ATTRIBUTES, TENANT_RETIREMENT_TRIGGER_CONTRACTS, TENANT_RETIREMENT_AUTHORITY_FUNCTIONS } from "../organization/tenant-retirement-guards.ts";
import { retirementFingerprint, unclassifiedRetirementChildren, retirementOutstandingWork, RETIREMENT_AUTH_TABLES, type RetirementFingerprint } from "./retirement-data.ts";
import { EXTRA_REBASE, loadCatalog } from "../sandbox/catalog.ts";
import { readSampleTenantInventory } from "./tenant-inventory.ts";
import { parseRetirementSelection, assertRetirementDatabase, assertRetirementPartition, retirementDigest } from "./retirement-contract.ts";

/** Read-only source and database evidence; this plan never grants deletion authority. */
export async function sampleRetirementPlan(input: unknown) {
  const selection = parseRetirementSelection(input);
  return withMaintenanceTransaction(null, async () => {
    await db.execute(sql`set transaction read only`);
    await db.execute(sql`set local statement_timeout='600000ms'`);
    const identity = (await db.execute<{ database: string; serverAddress: string; serverPort: number; clusterName: string }>(sql`
      select current_database() as database,inet_server_addr()::text as "serverAddress",inet_server_port() as "serverPort",current_setting('cluster_name') as "clusterName"
    `)).rows[0]!;
    assertRetirementDatabase(selection.database, identity);
    const inventory = await readSampleTenantInventory();
    assertRetirementPartition(selection, inventory.map(row => row.orgId));
    const targets = inventory.filter(row => selection.retireOrgIds.includes(row.orgId)).sort((a,b) => a.orgId.localeCompare(b.orgId));
    const retained = inventory.filter(row => selection.retainOrgIds.includes(row.orgId)).sort((a,b) => a.orgId.localeCompare(b.orgId));
    const migrations = (await db.execute<{ filename: string; sha256: string }>(sql`select filename,sha256 from public._applied_migrations order by filename`)).rows;
    const tables = (await db.execute<{ table: string; hasOrgId: boolean; columnsDigest: string }>(sql`
      select t.relname as table,bool_or(a.attname='org_id') as "hasOrgId",
        md5(string_agg(a.attname || ':' || format_type(a.atttypid,a.atttypmod) || ':' || a.attnotnull::text,',' order by a.attnum)) as "columnsDigest"
      from pg_class t join pg_namespace n on n.oid=t.relnamespace join pg_attribute a on a.attrelid=t.oid and a.attnum>0 and not a.attisdropped
      where n.nspname='public' and t.relkind in ('r','p') group by t.relname order by t.relname
    `)).rows;
    const triggers = (await db.execute<{ table: string; trigger: string; function: string; enabled: string; definitionDigest: string }>(sql`
      select c.relname as table,t.tgname as trigger,p.proname as function,t.tgenabled as enabled,
        md5(pg_get_triggerdef(t.oid) || pg_get_functiondef(p.oid)) as "definitionDigest"
      from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace join pg_proc p on p.oid=t.tgfoid
      where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname
    `)).rows;
    const constraints = (await db.execute<{ table: string; name: string; definitionDigest: string }>(sql`
      select c.relname as table,k.conname as name,md5(pg_get_constraintdef(k.oid)) as "definitionDigest"
      from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' order by c.relname,k.conname
    `)).rows;
    const tenantTables = tables.filter(table => table.hasOrgId || (EXTRA_REBASE as readonly string[]).includes(table.table));
    const policies = new Set(Object.keys(TENANT_TABLE_POLICIES));
    const actual = new Set(tenantTables.map(table => table.table));
    const policyDrift = { unclassified: [...actual].filter(table => !policies.has(table)).sort(), unavailable: [...policies].filter(table => !actual.has(table)).sort() };
    const dependencies = (await db.execute<{ orgId: string; sourceOrgId: string | null; templateOrgId: string | null; sandboxSourceOrgId: string | null }>(sql`
      select o.id as "orgId",o.sandbox_of as "sourceOrgId",o.settings->'sampleCompany'->>'templateOrgId' as "templateOrgId",
        s.production_org_id as "sandboxSourceOrgId" from orgs o left join sandboxes s on s.org_id=o.id order by o.id
    `)).rows;
    const retainedDependencies = dependencies.filter(row => selection.retainOrgIds.includes(row.orgId)
      && [row.sourceOrgId,row.templateOrgId,row.sandboxSourceOrgId].some(id => id != null && selection.retireOrgIds.includes(id)));
    const retainedAccessDependencies = (await db.execute<{ retiredIdentityOrgId: string; retainedAccessOrgId: string; accessCount: number }>(sql`
      select u.org_id as "retiredIdentityOrgId",a.org_id as "retainedAccessOrgId",count(distinct a.id)::int as "accessCount"
      from user_org_access a join users u on u.id=a.member_user_id or u.id=a.acting_user_id
      where u.org_id in (${sql.join(selection.retireOrgIds.map(id => sql`${id}::uuid`),sql`, `)})
        and a.org_id in (${sql.join(selection.retainOrgIds.map(id => sql`${id}::uuid`),sql`, `)})
      group by u.org_id,a.org_id order by u.org_id,a.org_id
    `)).rows;
    const immutableEvidence: Array<{ orgId: string; tables: string[] }> = [];
    for (const target of targets) {
      const present: string[] = [];
      for (const table of ["pay_run_bank_files", "ap_capture_runs", "ap_capture_fields", "ap_capture_corrections", "ap_capture_events"]) {
        if (!actual.has(table)) continue;
        const evidence = await db.execute(sql`select 1 from ${sql.identifier(table)} where org_id=${target.orgId} limit 1`);
        if (evidence.rows.length) present.push(table);
      }
      if (present.length) immutableEvidence.push({ orgId: target.orgId, tables: present });
    }
    const schemaDigest = retirementDigest({ migrations, tables, triggers, constraints, policies: [...policies].sort() });
    const inventoryDigest = retirementDigest(inventory.map(({ documents: _documents, postedEntries: _entries, activeUsers: _users, ...identity }) => identity).sort((a,b) => a.orgId.localeCompare(b.orgId)));
    const installed = (await db.execute<{ installed: boolean }>(sql`select to_regprocedure('tenant_retirement.openbooks_retirement_catalog_digest()') is not null as installed`)).rows[0]?.installed === true;
    const catalogDigest = installed ? await retirementCatalogDigest() : null;
    const guardDrift: string[] = [];
    if (installed) {
      const authority = (await db.execute<{ name: string; digest: string; securityDefiner: boolean; returns: string; language: string; volatility: string; config: string[]; strict: boolean; leakproof: boolean; parallel: string }>(sql`
        select p.proname as name,encode(digest(p.prosrc,'sha256'),'hex') as digest,p.prosecdef as "securityDefiner",
          p.prorettype::regtype::text as returns,l.lanname as language,p.provolatile as volatility,p.proisstrict as strict,p.proleakproof as leakproof,p.proparallel as parallel,
          coalesce((select array_agg(regexp_replace(value,'\\s','','g') order by value) from unnest(p.proconfig) value),'{}'::text[]) as config
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang where n.nspname='tenant_retirement' order by p.proname`)).rows;
      for (const fn of TENANT_RETIREMENT_AUTHORITY_FUNCTIONS) {
        const candidates = authority.filter(row => row.name === fn.name);
        const found = candidates[0];
        if (candidates.length !== 1 || !found || found.digest !== fn.sha256 || !found.securityDefiner
          || found.returns !== fn.returns || found.language !== fn.language || found.volatility !== fn.volatility
          || found.strict || found.leakproof || found.parallel !== "u" || JSON.stringify(found.config) !== JSON.stringify(fn.config)) guardDrift.push(`tenant_retirement.${fn.name}`);
      }
      if (authority.length !== TENANT_RETIREMENT_AUTHORITY_FUNCTIONS.length) guardDrift.push("tenant_retirement.function_catalog");
      const ownership = (await db.execute<{ isolated: boolean }>(sql`
        select not pg_has_role(ordinary.relowner,authority.relowner,'MEMBER') as isolated
        from pg_class ordinary join pg_namespace ordinary_ns on ordinary_ns.oid=ordinary.relnamespace
        cross join pg_class authority join pg_namespace authority_ns on authority_ns.oid=authority.relnamespace
        where ordinary_ns.nspname='public' and ordinary.relname='orgs' and authority_ns.nspname='tenant_retirement' and authority.relname='runs'`)).rows[0];
      if (!ownership?.isolated) guardDrift.push("tenant_retirement.owner_not_isolated_from_business_schema");
      const missingFences = (await db.execute<{ table: string }>(sql`
        select c.relname as table from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p') and (c.relname in ('orgs','file_versions','file_blobs','tax_group_members')
          or c.relname=any(${sql.param([...RETIREMENT_AUTH_TABLES])}::text[]) or exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='org_id' and not a.attisdropped))
        and not exists(select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_namespace pn on pn.oid=p.pronamespace
          where t.tgrelid=c.oid and t.tgenabled in ('O','A') and t.tgtype::integer=case when c.relname='orgs' then 27 else 31 end and pn.nspname='tenant_retirement' and p.proname='openbooks_tenant_retirement_fence')`)).rows;
      guardDrift.push(...missingFences.map(row => `${row.table}.missing_retirement_fence`));
      const attributes = (await db.execute<{ name: string; config: string[]; valid: boolean }>(sql`
        select p.proname as name,
          coalesce((select array_agg(regexp_replace(value,'\\s','','g') order by value) from unnest(p.proconfig) value),'{}'::text[]) as config,
          (not p.prosecdef and p.provolatile='v' and not p.proisstrict and not p.proleakproof and p.proparallel='u'
            and p.prorettype='trigger'::regtype and p.pronargs=0 and l.lanname='plpgsql') as valid
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
        where n.nspname='public' and p.proname=any(${sql.param(TENANT_RETIREMENT_GUARD_ATTRIBUTES.map(fn => fn.name))}::text[])`)).rows;
      for (const fn of TENANT_RETIREMENT_GUARD_ATTRIBUTES) {
        const found = attributes.filter(row => row.name === fn.name);
        if (found.some(row => !row.valid || JSON.stringify(row.config) !== JSON.stringify(fn.config)) || found.length > 1) guardDrift.push(`public.${fn.name}.attributes`);
      }
      const live = (await db.execute<{ table: string; trigger: string; function: string; namespace: string; digest: string; enabled: string }>(sql`
        select c.relname as table,t.tgname as trigger,p.proname as function,pn.nspname as namespace,
          encode(digest(p.prosrc,'sha256'),'hex') as digest,t.tgenabled as enabled
        from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
        join pg_proc p on p.oid=t.tgfoid join pg_namespace pn on pn.oid=p.pronamespace
        where n.nspname='public' and not t.tgisinternal and (t.tgtype::integer & 8)<>0 order by c.relname,t.tgname`)).rows;
      for (const row of live) {
        if (row.namespace === "tenant_retirement" && row.function === "openbooks_tenant_retirement_fence" && ["tenant_retirement_fence", "tenant_retirement_org_fence"].includes(row.trigger) && ["O", "A"].includes(row.enabled)) continue;
        const fn = TENANT_RETIREMENT_GUARDS.find(guard => guard.name === row.function);
        const trigger = TENANT_RETIREMENT_TRIGGER_CONTRACTS.some(guard => guard.table === row.table && guard.trigger === row.trigger && guard.function === row.function);
        if (!fn || !trigger || row.namespace !== "public" || row.digest !== fn.newSha256 || !["O", "A"].includes(row.enabled)) guardDrift.push(`${row.table}.${row.trigger}`);
      }
    }
    const unclassifiedChildren = await unclassifiedRetirementChildren(tenantTables.map(table => table.table));
    const outstandingWork = await retirementOutstandingWork(selection.retireOrgIds);
    const blockers = [
      ...(outstandingWork.length ? [{ code: "retirement_work_not_quiescent", remedy: "Resolve queued, retrying or leased work through its native cancellation/drain controls, verify retained storage recovery evidence, then review a fresh retirement plan." }] : []),
      ...(unclassifiedChildren.length ? [{ code: "unclassified_tenant_children", remedy: "Classify the listed global child tables in the native tenant ownership catalog before retirement." }] : []),
      ...(!installed ? [{ code: "retirement_schema_unavailable", remedy: "Qualify and install the reserved native retirement migration through the coordinated migration lane before admission." }] : []),
      ...(guardDrift.length ? [{ code: "retirement_guard_contract_changed", remedy: "Qualify the exact published guard bodies and trigger identities; unknown or disabled guards refuse retirement." }] : []),
      ...(policyDrift.unclassified.length || policyDrift.unavailable.length ? [{ code: "tenant_catalog_source_mismatch", remedy: "Use a release whose native tenant catalog exactly matches the applied schema; do not bypass classification or apply unrelated upcoming migrations." }] : []),
      ...(retainedDependencies.length || retainedAccessDependencies.length ? [{ code: "retained_tenant_dependency", remedy: "Resolve retained company lineage or identity dependencies through their native lifecycle before retiring the referenced company." }] : []),
    ];
    const targetFingerprints: Record<string, RetirementFingerprint> = {};
    if (blockers.length === 0) {
      const catalog = await loadCatalog();
      for (const target of targets) targetFingerprints[target.orgId] = await retirementFingerprint(catalog, target.orgId);
    }
    const plan = { version: 1, selection, database: identity, schemaDigest, catalogDigest, inventoryDigest, targets, retained, targetFingerprints, guardDrift, unclassifiedChildren, outstandingWork,
      dependencies, retainedDependencies, retainedAccessDependencies, immutableEvidence, policyDrift,
      nativeCandidates: targets.map(target => ({ orgId: target.orgId, sandboxId: target.sandboxId,
        lifecycle: "native-tenant-retirement" })), blockers };
    return { ...plan, digest: retirementDigest(plan), executable: false as const, admissible: blockers.length === 0, readOnly: true as const,
      requiredRecoveryEvidence: ["verified backup and full restore receipt", "retained tenant business-data fingerprints", "durable retirement and storage manifests outside deleted tenants", "qualified per-target rollback and crash-retry evidence"] };
  }, { isolationLevel: "REPEATABLE READ" });
}
