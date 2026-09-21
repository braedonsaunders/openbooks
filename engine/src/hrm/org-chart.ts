import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { requireOrgChartRead } from "./authorization.ts";
import { HrmOrgChartError } from "./documents/errors.ts";

/**
 * HR-19 org chart: a read over reporting_relationships line edges with
 * position titles, as of a date.
 *
 * tree() resolves every incumbent employment live at asOf (recorded-live
 * version covering the date, status active/on_leave/suspended), their
 * primary assignment title and department, and their line manager at
 * asOf — then builds the forest. Vacancy nodes are funded positions
 * (status open) live at asOf with no incumbent assignment: dashed nodes
 * in the widget, real rows here. Department grouping, span of control
 * per node, and layer depth ride on the nodes. A future-dated manager
 * change reads through automatically: only edges covering asOf join.
 *
 * Privacy: names, titles, departments and managers only — never pay or
 * private fields. Anyone with hrm.employment.read OR hrm.self.read may
 * read (self-service sees the same shape, narrowed by nothing because
 * the shape itself is public-inside-the-org).
 */

export interface OrgChartNode {
  employmentId: string | null;
  partyId: string | null;
  name: string;
  title: string | null;
  department: string | null;
  vacant: boolean;
  positionId: string | null;
  positionCode: string | null;
  spanOfControl: number;
  layer: number;
  children: OrgChartNode[];
}

export interface OrgChart {
  asOf: string;
  roots: OrgChartNode[];
  layers: number;
  headcount: number;
  vacancies: number;
}

export interface DirectoryEntry {
  employmentId: string;
  partyId: string;
  name: string;
  email: string | null;
  title: string | null;
  department: string | null;
  managerName: string | null;
}

type IncumbentRow = {
  employment_id: string;
  party_id: string;
  name: string;
  title: string | null;
  department: string | null;
  position_id: string | null;
  manager_employment_id: string | null;
};

function assertCivilDate(asOf: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(asOf))) {
    throw new HrmOrgChartError("VALIDATION", "asOf must be a civil date (YYYY-MM-DD) — the chart is an as-of read, never a live peek");
  }
}

export async function loadOrgChart(query: {
  orgId: string;
  actorId: string;
  asOf: string;
  rootEmploymentId?: string;
}): Promise<OrgChart> {
  assertCivilDate(query.asOf);
  await requireOrgChartRead(db, query.orgId, query.actorId);
  const incumbents = (await db.execute<IncumbentRow>(sql`
    with live_emp as (
      select distinct on (v.employment_id) v.employment_id
        from worker_employment_versions v
       where v.org_id = ${query.orgId} and v.recorded_until is null
         and v.effective_from <= ${query.asOf}::date
         and (v.effective_to is null or v.effective_to > ${query.asOf}::date)
         and v.status in ('active', 'on_leave', 'suspended')
       order by v.employment_id, v.version_no desc
    )
    select e.id as employment_id, e.worker_party_id as party_id,
           coalesce(p.display_name, p.legal_name, 'Unnamed') as name,
           a.job_title as title, d.name as department,
           a.position_id as position_id,
           (select r.manager_employment_id
              from reporting_relationships r
             where r.org_id = ${query.orgId} and r.employment_id = e.id
               and r.kind = 'line' and r.recorded_until is null
               and r.effective_from <= ${query.asOf}::date
               and (r.effective_to is null or r.effective_to > ${query.asOf}::date)
             order by r.effective_from desc
             limit 1) as manager_employment_id
      from worker_employments e
      join live_emp l on l.employment_id = e.id
      join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
      left join employment_assignment_versions a
        on a.org_id = e.org_id and a.employment_id = e.id and a.is_primary
           and a.recorded_until is null
           and a.effective_from <= ${query.asOf}::date
           and (a.effective_to is null or a.effective_to > ${query.asOf}::date)
      left join departments d on d.org_id = a.org_id and d.id = a.department_id
     where e.org_id = ${query.orgId}
     order by name
  `)).rows;

  // Funded-but-empty slots: positions open as of the date with no live
  // incumbent assignment. They hang at root level — positions carry no
  // manager edge of their own, so parenting one under a manager would be
  // invented lineage, and invented lineage is refused here.
  const vacant = (await db.execute<{
    position_id: string;
    position_code: string;
    title: string;
    department: string | null;
  }>(sql`
    select p.id as position_id, p.position_code, v.title, d.name as department
      from positions p
      join position_versions v
        on v.org_id = p.org_id and v.position_id = p.id and v.recorded_until is null
           and v.effective_from <= ${query.asOf}::date
           and (v.effective_to is null or v.effective_to > ${query.asOf}::date)
      left join departments d on d.org_id = v.org_id and d.id = v.department_id
     where p.org_id = ${query.orgId} and v.status = 'open'
       and not exists (
         select 1 from employment_assignment_versions a
          where a.org_id = p.org_id and a.position_id = p.id and a.recorded_until is null
            and a.effective_from <= ${query.asOf}::date
            and (a.effective_to is null or a.effective_to > ${query.asOf}::date)
       )
     order by v.title
  `)).rows;
  const nodes = new Map<string, OrgChartNode>();
  for (const row of incumbents) {
    nodes.set(row.employment_id, {
      employmentId: row.employment_id,
      partyId: row.party_id,
      name: row.name,
      title: row.title,
      department: row.department,
      vacant: false,
      positionId: row.position_id,
      positionCode: null,
      spanOfControl: 0,
      layer: 0,
      children: [],
    });
  }
  const vacancyNodes: OrgChartNode[] = vacant.map((v) => ({
    employmentId: null,
    partyId: null,
    name: `Vacant — ${v.title}`,
    title: v.title,
    department: v.department,
    vacant: true,
    positionId: v.position_id,
    positionCode: v.position_code,
    spanOfControl: 0,
    layer: 0,
    children: [],
  }));
  const roots: OrgChartNode[] = [];
  for (const row of incumbents) {
    const node = nodes.get(row.employment_id)!;
    const manager = row.manager_employment_id && nodes.has(row.manager_employment_id)
      ? nodes.get(row.manager_employment_id)!
      : null;
    // A manager outside the live set (terminated, future-dated) is not a
    // node: the report hangs at root rather than under a ghost.
    if (manager && manager.employmentId !== row.employment_id) {
      manager.children.push(node);
      manager.spanOfControl += 1;
    } else {
      roots.push(node);
    }
  }
  for (const v of vacancyNodes) {
    roots.push(v);
  }
  // Layers by BFS from every root; a cycle (corrupt lineage) is refused
  // instead of recursed forever.
  let layers = 0;
  const queue: { node: OrgChartNode; layer: number }[] = roots.map((node) => ({ node, layer: 0 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { node, layer } = queue.shift()!;
    node.layer = layer;
    layers = Math.max(layers, layer);
    const key = node.employmentId ?? `vacant:${node.positionId}`;
    if (seen.has(key)) {
      throw new HrmOrgChartError(
        "REFUSED",
        "the reporting lineage contains a cycle — fix the line relationships before the chart can render",
      );
    }
    seen.add(key);
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of node.children) queue.push({ node: child, layer: layer + 1 });
  }
  roots.sort((a, b) => a.name.localeCompare(b.name));
  let focus = roots;
  if (query.rootEmploymentId) {
    const root = nodes.get(query.rootEmploymentId);
    if (!root) {
      throw new HrmOrgChartError("NOT_FOUND", "the requested root employment is not on the chart as of this date");
    }
    focus = [root];
  }
  return {
    asOf: query.asOf,
    roots: focus,
    layers: layers + 1,
    headcount: incumbents.length,
    vacancies: vacancyNodes.length,
  };
}

export async function loadDirectory(query: {
  orgId: string;
  actorId: string;
  search?: string;
  limit?: number;
}): Promise<DirectoryEntry[]> {
  await requireOrgChartRead(db, query.orgId, query.actorId);
  const q = query.search?.trim() ?? "";
  const rows = (await db.execute<{
    employment_id: string;
    party_id: string;
    name: string;
    email: string | null;
    title: string | null;
    department: string | null;
    manager_name: string | null;
  }>(sql`
    select e.id as employment_id, e.worker_party_id as party_id,
           coalesce(p.display_name, p.legal_name, 'Unnamed') as name,
           p.email, a.job_title as title, d.name as department,
           (select coalesce(mp.display_name, mp.legal_name, 'Unnamed')
              from reporting_relationships r
              join worker_employments me on me.org_id = r.org_id and me.id = r.manager_employment_id
              join parties mp on mp.org_id = r.org_id and mp.id = me.worker_party_id
             where r.org_id = ${query.orgId} and r.employment_id = e.id
               and r.kind = 'line' and r.recorded_until is null
               and r.effective_from <= current_date
               and (r.effective_to is null or r.effective_to > current_date)
             order by r.effective_from desc
             limit 1) as manager_name
      from worker_employments e
      join worker_employment_versions v
        on v.org_id = e.org_id and v.employment_id = e.id and v.recorded_until is null
           and v.effective_from <= current_date
           and (v.effective_to is null or v.effective_to > current_date)
           and v.status in ('active', 'on_leave', 'suspended')
      join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
      left join employment_assignment_versions a
        on a.org_id = e.org_id and a.employment_id = e.id and a.is_primary
           and a.recorded_until is null
           and a.effective_from <= current_date
           and (a.effective_to is null or a.effective_to > current_date)
      left join departments d on d.org_id = a.org_id and d.id = a.department_id
     where e.org_id = ${query.orgId}
       ${q ? sql`and (p.display_name ilike ${"%" + q + "%"} or coalesce(a.job_title, '') ilike ${"%" + q + "%"})` : sql``}
     order by name
     limit ${Math.min(Math.max(query.limit ?? 50, 1), 200)}
  `)).rows;
  return rows.map((r) => ({
    employmentId: r.employment_id,
    partyId: r.party_id,
    name: r.name,
    email: r.email,
    title: r.title,
    department: r.department,
    managerName: r.manager_name,
  }));
}
