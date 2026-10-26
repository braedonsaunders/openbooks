import { db } from "../platform/db.ts";
import { sql } from "drizzle-orm";
import { defineCommandSubject } from "./command-subject-adapter.ts";
import { tableScope } from "./subject-scope.ts";

function subcontractScope(table: string) {
  return {
    via: "custom" as const,
    worklistPredicate(idsJson: string) {
      return sql`exists(select 1 from ${sql.identifier(table)} child join subcontracts parent on parent.org_id=child.org_id and parent.id=child.subcontract_id join projects p on p.org_id=parent.org_id and p.id=parent.project_id where child.org_id=g.org_id and child.id=g.subject_id and p.subsidiary_id::text in(select jsonb_array_elements_text(${idsJson}::jsonb)))`;
    },
    async subsidiaryOf(
      orgId: string,
      ids: readonly string[],
      _allowed: ReadonlySet<string> | null,
      lock: boolean,
    ) {
      const rows = await db.execute<{
        id: string;
        subsidiary_id: string;
      }>(
        sql`select child.id,p.subsidiary_id from ${sql.identifier(table)} child
    join subcontracts parent on parent.org_id=child.org_id and parent.id=child.subcontract_id
    join projects p on p.org_id=parent.org_id and p.id=parent.project_id
    where child.org_id=${orgId} and child.id in(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
    ${lock ? sql`for share of child,parent,p` : sql``}`,
        "objects",
      );
      return new Map(rows.map((row) => [row.id, row.subsidiary_id]));
    },
  };
}
function complianceScope(table: "compliance_records" | "compliance_waivers") {
  return {
    via: "custom" as const,
    worklistPredicate(idsJson: string) {
      return sql`exists(select 1 from ${sql.identifier(table)} s join parties p on p.org_id=s.org_id and p.id=s.party_id
      left join projects j on j.org_id=s.org_id and j.id=s.project_id where s.org_id=g.org_id and s.id=g.subject_id
      and (p.subsidiary_id is null or p.subsidiary_id::text in(select jsonb_array_elements_text(${idsJson}::jsonb)))
      and (s.project_id is null or j.subsidiary_id::text in(select jsonb_array_elements_text(${idsJson}::jsonb)))
      and (p.subsidiary_id is not null or j.subsidiary_id is not null))`;
    },
    async subsidiaryOf(
      orgId: string,
      ids: readonly string[],
      allowed: ReadonlySet<string> | null,
      lock: boolean,
    ) {
      const rows = await db.execute<{
        id: string;
        partyEntity: string | null;
        projectEntity: string | null;
        project_id: string | null;
      }>(
        sql`
   select s.id,p.subsidiary_id as "partyEntity",j.subsidiary_id as "projectEntity",s.project_id from ${sql.identifier(table)} s
   join parties p on p.org_id=s.org_id and p.id=s.party_id left join projects j on j.org_id=s.org_id and j.id=s.project_id
   where s.org_id=${orgId} and s.id in(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
   ${lock ? sql`for share of s,p` : sql``}`,
        "objects",
      );
      if (lock) {
        const projects = rows.flatMap((row) => (row.project_id ? [row.project_id] : []));
        if (projects.length) {
          const locked = await db.execute<{ id: string; subsidiary_id: string | null }>(
            sql`select id,subsidiary_id from projects where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify(projects)}::jsonb)::uuid) order by id for share`,
            "objects",
          );
          const actual = new Map(locked.map((project) => [project.id, project.subsidiary_id]));
          for (const row of rows)
            if (row.project_id) row.projectEntity = actual.get(row.project_id) ?? null;
        }
      }
      return new Map(
        rows
          .filter(
            (row) =>
              (!row.project_id || row.projectEntity !== null) &&
              (allowed === null ||
                ((row.partyEntity === null || allowed.has(row.partyEntity)) &&
                  (!row.project_id ||
                    (row.projectEntity !== null && allowed.has(row.projectEntity))) &&
                  (row.partyEntity !== null || row.projectEntity !== null))),
          )
          .map((row) => [row.id, row.partyEntity ?? row.projectEntity]),
      );
    },
  };
}
function reconciliationScope() {
  return {
    via: "custom" as const,
    worklistPredicate(idsJson: string) {
      return sql`exists(select 1 from reconciliations r join accounts a on a.org_id=r.org_id and a.id=r.account_id where r.org_id=g.org_id and r.id=g.subject_id and a.subsidiary_id::text in(select jsonb_array_elements_text(${idsJson}::jsonb)))`;
    },
    async subsidiaryOf(
      orgId: string,
      ids: readonly string[],
      _allowed: ReadonlySet<string> | null,
      lock: boolean,
    ) {
      const rows = await db.execute<{
        id: string;
        subsidiary_id: string | null;
      }>(
        sql`select r.id,a.subsidiary_id from reconciliations r
    join accounts a on a.org_id=r.org_id and a.id=r.account_id where r.org_id=${orgId}
      and r.id in(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid) ${lock ? sql`for share of r,a` : sql``}`,
        "objects",
      );
      return new Map(rows.map((row) => [row.id, row.subsidiary_id]));
    },
  };
}
function calibrationSessionScope() {
  return {
    via: "custom" as const,
    worklistPredicate(idsJson: string) {
      return sql`exists(select 1 from hrm_calibration_sessions s where s.org_id=g.org_id and s.id=g.subject_id
      and cardinality(public.calibration_session_approval_entities(s.org_id,s.id))>0
      and not exists(select 1 from unnest(public.calibration_session_approval_entities(s.org_id,s.id)) entity(id)
        where not(entity.id in(select jsonb_array_elements_text(${idsJson}::jsonb)))))`;
    },
    async subsidiaryOf(
      orgId: string,
      ids: readonly string[],
      allowed: ReadonlySet<string> | null,
      lock: boolean,
    ) {
      const rows = await db.execute<{ id: string; entities: string[] }>(
        sql`select s.id,public.calibration_session_approval_entities(s.org_id,s.id) as entities
        from hrm_calibration_sessions s where s.org_id=${orgId} and s.id in(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
        ${lock ? sql`for share of s` : sql``}`,
        "objects",
      );
      return new Map(
        rows
          .filter(
            (row) =>
              allowed === null ||
              (row.entities.length > 0 && row.entities.every((id) => allowed.has(id))),
          )
          .map((row) => [
            row.id,
            allowed === null && row.entities.length !== 1 ? null : (row.entities[0] ?? null),
          ]),
      );
    },
  };
}
export const nativeCommandSubjects = [
  defineCommandSubject({
    kind: "hrm_calibration_session",
    label: "Calibration publication",
    table: "hrm_calibration_sessions",
    statusColumn: "status",
    statuses: ["draft", "open", "closed"],
    permissions: {
      read: "hrm.performance.read",
      edit: "hrm.performance.manage",
      approve: "hrm.performance.manage",
    },
    scope: calibrationSessionScope(),
    makerIds: sql`array(select distinct actor from (select s.created_by::text as actor union select u.id::text from users u where u.org_id=s.org_id and u.party_id=s.facilitator_party_id
      union select e.decided_by::text from hrm_calibration_entries e where e.org_id=s.org_id and e.session_id=s.id) makers where actor is not null)`,
    integrity: sql`public.calibration_session_approval_dependencies(s.org_id,s.id)`,
    fields: [
      { key: "name", column: "name", label: "Session", type: "text" },
      { key: "cycleId", column: "cycle_id", label: "Review cycle", type: "text" },
    ],
  }),
  defineCommandSubject({
    kind: "close_task",
    label: "Close task",
    table: "close_run_tasks",
    statusColumn: "status",
    statuses: [
      "blocked",
      "ready",
      "in_progress",
      "submitted",
      "complete",
      "changes_requested",
      "invalidated",
      "waived",
    ],
    permissions: { read: "close.read", edit: "close.run", approve: "close.approve" },
    scope: { via: "none" },
    makerColumn: "owner_id",
    makerIds: sql`array_remove(array[s.owner_id::text,s.completed_by::text,s.created_by::text],null)`,
    integrity: sql`public.close_task_approval_dependencies(s.org_id,s.id)`,
    fields: [
      { key: "name", column: "title", label: "Task", type: "text" },
      { key: "runId", column: "run_id", label: "Close run", type: "text" },
      { key: "workstream", column: "workstream", label: "Workstream", type: "text" },
      {
        key: "evidenceRequired",
        column: "evidence_required",
        label: "Evidence required",
        type: "bool",
      },
    ],
  }),
  defineCommandSubject({
    kind: "training_course",
    label: "Training course",
    table: "hrm_training_courses",
    statusColumn: "status",
    statuses: ["draft", "approved", "retired", "cancelled"],
    permissions: {
      read: "hrm.certifications.read",
      edit: "hrm.certifications.manage",
      approve: "hrm.certifications.manage",
    },
    scope: tableScope("column", "hrm_training_courses", "subsidiary_id"),

    makerIds: sql`array(select u.id::text from users u where u.org_id=s.org_id and u.party_id=s.author_party_id)`,
    fields: [
      { key: "name", column: "name", label: "Course", type: "text" },
      {
        key: "effectiveFrom",
        column: "effective_from",
        label: "Effective from",
        type: "date",
      },
      { key: "version", column: "version", label: "Version", type: "number" },
    ],
  }),
  ...(["sign_off", "review"] as const).map((action) =>
    defineCommandSubject({
      kind: action === "sign_off" ? "bank_reconciliation_sign_off" : "bank_reconciliation_review",
      label:
        action === "sign_off"
          ? "Bank reconciliation sign-off"
          : "Bank reconciliation evidence review",
      table: "reconciliations",
      statusColumn: "status",
      statuses: ["in_progress", "balanced", "signed_off"],
      makerColumn: action === "review" ? "signed_off_by" : "created_by",
      permissions: {
        read: "banking.read",
        edit: "banking.reconcile",
        approve: "banking.reconcile",
      },
      ...(action === "review"
        ? {
            decisionPermissions: ["banking.review_sign_off", "banking.reconcile"],
          }
        : {}),
      scope: reconciliationScope(),

      integrity: sql`public.reconciliation_approval_dependencies(s.org_id,s.id)`,
      fields: [
        {
          key: "amount",
          column: "statement_balance",
          label: "Statement balance",
          type: "number",
        },
        {
          key: "currency",
          column: "currency",
          label: "Currency",
          type: "text",
        },
        {
          key: "throughDate",
          column: "through_date",
          label: "Through date",
          type: "date",
        },
        {
          key: "accountId",
          column: "account_id",
          label: "Account",
          type: "text",
        },
      ],
    }),
  ),
  defineCommandSubject({
    kind: "payment_dispute_review",
    fingerprint: sql`public.provider_return_approval_fingerprint(s.org_id,s.id)`,
    label: "Provider return review",
    table: "payment_disputes",
    statusColumn: "status",
    statuses: ["pending_review", "posted", "rejected", "opened", "won", "lost"],
    permissions: {
      read: "banking.read",
      edit: "banking.reconcile",
      approve: "banking.reconcile",
    },

    scope: {
      via: "custom",
      worklistPredicate(idsJson: string) {
        return sql`exists(select 1 from payment_disputes r where r.org_id=g.org_id and r.id=g.subject_id
        and (r.invoice_document_id is not null or r.receipt_document_id is not null)
        and not exists(select 1 from unnest(array[r.invoice_document_id,r.receipt_document_id]) refs(id) where refs.id is not null
          and not exists(select 1 from documents d left join journal_entries j on j.org_id=d.org_id and j.id=d.posted_entry_id where d.org_id=r.org_id and d.id=refs.id
            and coalesce(d.subsidiary_id,j.subsidiary_id)::text in(select jsonb_array_elements_text(${idsJson}::jsonb)))))`;
      },
      async subsidiaryOf(orgId, ids, allowed, lock) {
        const rows = await db.execute<{
          id: string;
          entities: string[];
          unresolved: boolean;
        }>(
          sql`select r.id,
    array(select distinct coalesce(d.subsidiary_id,j.subsidiary_id)::text from documents d left join journal_entries j on j.org_id=d.org_id and j.id=d.posted_entry_id
      where d.org_id=r.org_id and d.id in(r.invoice_document_id,r.receipt_document_id) and coalesce(d.subsidiary_id,j.subsidiary_id) is not null) as entities,
    (not exists(select 1 from documents d where d.org_id=r.org_id and d.id in(r.invoice_document_id,r.receipt_document_id))
      or exists(select 1 from unnest(array[r.invoice_document_id,r.receipt_document_id]) refs(id) where refs.id is not null and not exists(select 1 from documents d left join journal_entries j on j.org_id=d.org_id and j.id=d.posted_entry_id where d.org_id=r.org_id and d.id=refs.id and coalesce(d.subsidiary_id,j.subsidiary_id) is not null))) as unresolved
    from payment_disputes r where r.org_id=${orgId} and r.id in(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
    ${lock ? sql`for share of r` : sql``}`,
          "objects",
        );
        return new Map(
          rows
            .filter(
              (row) =>
                !row.unresolved &&
                row.entities.length > 0 &&
                (allowed === null || row.entities.every((id) => allowed.has(id))),
            )
            .map((row) => [row.id, row.entities[0]!]),
        );
      },
    },
    fields: [
      { key: "provider", column: "provider", label: "Provider", type: "text" },
      { key: "returnKind", column: "kind", label: "Return type", type: "text" },
      { key: "amount", column: "amount", label: "Amount", type: "number" },
      { key: "currency", column: "currency", label: "Currency", type: "text" },
    ],
  }),
  defineCommandSubject({
    kind: "compliance_certificate",
    label: "Compliance certificate",
    table: "compliance_records",
    statusColumn: "status",
    statuses: ["pending_review", "active", "rejected", "superseded"],
    permissions: {
      read: "compliance.read",
      edit: "compliance.manage",
      approve: "compliance.verify",
    },
    scope: complianceScope("compliance_records"),

    fields: [
      { key: "issuer", column: "issuer_name", label: "Issuer", type: "text" },
      {
        key: "policyNumber",
        column: "policy_number",
        label: "Policy number",
        type: "text",
      },
      {
        key: "coverageAmount",
        column: "coverage_amount",
        label: "Coverage",
        type: "number",
      },
      { key: "expiresOn", column: "expires_on", label: "Expiry", type: "date" },
    ],
  }),
  defineCommandSubject({
    kind: "customer_change_order",
    label: "Customer change order",
    table: "change_orders",
    statusColumn: "status",
    statuses: ["draft", "approved", "void"],
    permissions: { read: "ar.read", edit: "ar.create", approve: "ar.approve" },
    scope: tableScope("project", "change_orders", "project_id"),

    integrity: sql`jsonb_build_object('contractValue',(select p.contract_value::text from projects p where p.org_id=s.org_id and p.id=s.project_id),
    'schedule',(select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]'::jsonb) from sov_lines l where l.org_id=s.org_id and l.project_id=s.project_id))`,
    fields: [
      { key: "number", column: "number", label: "Change order", type: "text" },
      { key: "amount", column: "amount", label: "Amount", type: "number" },
    ],
  }),
  defineCommandSubject({
    kind: "compliance_waiver",
    label: "Compliance exception",
    table: "compliance_waivers",
    statusColumn: "approved_at",
    statusSql: sql`case when s.revoked_at is not null then 'revoked' when s.approved_at is not null then 'approved' else 'pending_approval' end`,
    statuses: ["pending_approval", "approved", "revoked"],
    permissions: {
      read: "compliance.read",
      edit: "compliance.waive",
      approve: "compliance.waive",
    },
    scope: complianceScope("compliance_waivers"),

    fields: [
      { key: "reason", column: "reason", label: "Reason", type: "text" },
      {
        key: "effectiveFrom",
        column: "effective_from",
        label: "Starts",
        type: "date",
      },
      { key: "expiresOn", column: "expires_on", label: "Ends", type: "date" },
    ],
  }),
  defineCommandSubject({
    kind: "sandbox_change_set",
    label: "Sandbox promotion",
    table: "change_sets",
    statusColumn: "status",
    statuses: ["draft", "reviewed", "approved", "applied", "discarded"],
    permissions: {
      read: "admin.sandboxes.manage",
      edit: "admin.sandboxes.manage",
      approve: "admin.sandboxes.manage",
    },
    scope: { via: "none" },

    makerIds: sql`array_remove(array[s.created_by::text,s.reviewed_by::text],null)`,
    integrity: sql`(select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb) from change_set_items i where i.org_id=s.org_id and i.change_set_id=s.id)`,
    fields: [
      { key: "name", column: "name", label: "Change set", type: "text" },
      {
        key: "itemCount",
        column: "item_count",
        label: "Changes",
        type: "number",
      },
    ],
  }),
  defineCommandSubject({
    kind: "headcount_plan_line",
    label: "Headcount plan line",
    table: "hrm_headcount_plan_lines",
    statusColumn: "status",
    statuses: ["proposed", "approved", "opened", "filled", "cancelled"],
    permissions: {
      read: "hrm.compensation.read",
      edit: "hrm.compensation.manage",
      approve: "hrm.compensation.manage",
    },
    scope: tableScope("column", "hrm_headcount_plan_lines", "employer_subsidiary_id"),

    fields: [
      { key: "name", column: "title", label: "Role", type: "text" },
      {
        key: "amount",
        column: "est_annual_cost",
        label: "Annual cost",
        type: "number",
      },
      { key: "currency", column: "currency", label: "Currency", type: "text" },
    ],
  }),
  defineCommandSubject({
    kind: "headcount_plan",
    label: "Headcount plan",
    table: "hrm_headcount_plans",
    statusColumn: "status",
    statuses: ["draft", "submitted", "approved", "closed"],
    permissions: {
      read: "hrm.compensation.read",
      edit: "hrm.compensation.manage",
      approve: "hrm.compensation.manage",
    },
    scope: {
      via: "custom",
      worklistPredicate(idsJson: string) {
        return sql`exists(select 1 from hrm_headcount_plans p where p.org_id=g.org_id and p.id=g.subject_id
        and exists(select 1 from (select l.employer_subsidiary_id::text as entity from hrm_headcount_plan_lines l where l.org_id=p.org_id and l.plan_id=p.id union select p.scope->>'employer_subsidiary_id' where p.scope->>'employer_subsidiary_id' is not null) owners where entity is not null)
        and not exists(select 1 from (select l.employer_subsidiary_id::text as entity from hrm_headcount_plan_lines l where l.org_id=p.org_id and l.plan_id=p.id union select p.scope->>'employer_subsidiary_id' where p.scope->>'employer_subsidiary_id' is not null) owners where entity is null or entity not in(select jsonb_array_elements_text(${idsJson}::jsonb))))`;
      },
      async subsidiaryOf(orgId, ids, allowed, lock) {
        const rows = await db.execute<{
          id: string;
          entities: (string | null)[];
        }>(
          sql`select p.id,array(select distinct entity from (
      select l.employer_subsidiary_id::text as entity from hrm_headcount_plan_lines l where l.org_id=p.org_id and l.plan_id=p.id
      union select p.scope->>'employer_subsidiary_id' where p.scope->>'employer_subsidiary_id' is not null) owners) as entities
      from hrm_headcount_plans p where p.org_id=${orgId} and p.id in(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid) ${lock ? sql`for share of p` : sql``}`,
          "objects",
        );
        if (lock)
          await db.execute(
            sql`select id from hrm_headcount_plan_lines where org_id=${orgId} and plan_id in(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid) order by id for share`,
          );
        return new Map(
          rows
            .filter(
              (row) =>
                allowed === null ||
                (row.entities.length > 0 &&
                  row.entities.every((id) => id !== null && allowed.has(id))),
            )
            .map((row) => [row.id, row.entities[0] ?? null]),
        );
      },
    },

    integrity: sql`(select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]'::jsonb) from hrm_headcount_plan_lines l where l.org_id=s.org_id and l.plan_id=s.id)`,
    fields: [{ key: "name", column: "name", label: "Plan", type: "text" }],
  }),
  defineCommandSubject({
    kind: "compensation_cycle_line",
    label: "Compensation proposal",
    table: "hrm_comp_cycle_lines",
    statusColumn: "status",
    makerColumn: "proposed_by",
    statuses: ["pending", "proposed", "approved", "rejected", "pushed"],
    permissions: {
      read: "hrm.compensation.read",
      edit: "hrm.compensation.manage",
      approve: "hrm.compensation.approve",
    },
    scope: tableScope("employment", "hrm_comp_cycle_lines", "employment_id"),

    makerIds: sql`(select array_agg(u.id::text) from users u join worker_employments e on e.org_id=u.org_id and e.worker_party_id=u.party_id where e.org_id=s.org_id and e.id=s.employment_id)`,
    fields: [
      {
        key: "amount",
        column: "proposed_rate",
        label: "Proposed pay rate",
        type: "number",
      },
      { key: "currency", column: "currency", label: "Currency", type: "text" },
    ],
  }),
  ...(["per_diem", "travel"] as const).map((kind) =>
    defineCommandSubject({
      kind: kind === "per_diem" ? "per_diem_entry" : "travel_pay_entry",
      label: kind === "per_diem" ? "Per-diem allowance" : "Travel allowance",
      table: kind === "per_diem" ? "hrm_per_diem_entries" : "hrm_travel_pay_entries",
      statusColumn: "status",
      statuses: ["computed", "approved", "void"],
      permissions: {
        read: "hrm.construction.read",
        edit: "hrm.construction.manage",
        approve: "hrm.construction.manage",
      },
      scope: tableScope(
        "employment",
        kind === "per_diem" ? "hrm_per_diem_entries" : "hrm_travel_pay_entries",
        "employment_id",
      ),

      fields: [
        { key: "amount", column: "amount", label: "Allowance", type: "number" },
        {
          key: "currency",
          column: "currency",
          label: "Currency",
          type: "text",
        },
        {
          key: "workedOn",
          column: "worked_on",
          label: "Work date",
          type: "date",
        },
      ],
    }),
  ),
  defineCommandSubject({
    kind: "subcontract",
    label: "Subcontract",
    table: "subcontracts",
    statusColumn: "status",
    statuses: ["draft", "pending_approval", "active", "substantially_complete", "closed", "void"],
    permissions: { read: "ap.read", edit: "ap.create", approve: "ap.approve" },
    scope: tableScope("project", "subcontracts", "project_id"),

    integrity: sql`(select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]'::jsonb) from subcontract_sov_lines l where l.org_id=s.org_id and l.subcontract_id=s.id)`,
    fields: [
      { key: "number", column: "number", label: "Subcontract", type: "text" },
      {
        key: "amount",
        column: "original_commitment",
        label: "Commitment",
        type: "number",
      },
      { key: "currency", column: "currency", label: "Currency", type: "text" },
    ],
  }),
  defineCommandSubject({
    kind: "subcontract_change_order",
    label: "Subcontract change order",
    table: "subcontract_change_orders",
    statusColumn: "status",
    statuses: ["draft", "approved"],
    permissions: { read: "ap.read", edit: "ap.create", approve: "ap.approve" },
    scope: subcontractScope("subcontract_change_orders"),

    integrity: sql`public.subcontract_change_approval_dependencies(s.org_id,s.subcontract_id)`,
    fields: [
      { key: "number", column: "number", label: "Change order", type: "text" },
      { key: "amount", column: "amount", label: "Amount", type: "number" },
    ],
  }),
  defineCommandSubject({
    kind: "vendor_pay_application",
    label: "Vendor payment application",
    table: "vendor_pay_applications",
    statusColumn: "status",
    statuses: ["draft", "submitted", "approved", "billed", "void"],
    permissions: { read: "ap.read", edit: "ap.create", approve: "ap.approve" },
    scope: subcontractScope("vendor_pay_applications"),

    integrity: sql`(select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]'::jsonb) from vendor_pay_application_lines l where l.org_id=s.org_id and l.pay_application_id=s.id)`,
    fields: [
      {
        key: "number",
        column: "application_number",
        label: "Application",
        type: "number",
      },
      { key: "amount", column: "net_due", label: "Amount due", type: "number" },
      {
        key: "periodEnd",
        column: "period_end",
        label: "Period end",
        type: "date",
      },
    ],
  }),
  defineCommandSubject({
    kind: "customer_pay_application",
    label: "Customer payment application",
    table: "pay_applications",
    statusColumn: "status",
    statuses: ["draft", "submitted", "approved", "invoiced", "posted", "void"],
    permissions: { read: "ar.read", edit: "ar.create", approve: "ar.approve" },
    scope: tableScope("project", "pay_applications", "project_id"),

    integrity: sql`(select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]'::jsonb) from pay_application_lines l where l.org_id=s.org_id and l.pay_application_id=s.id)`,
    fields: [
      {
        key: "number",
        column: "application_number",
        label: "Application",
        type: "number",
      },
      {
        key: "periodEnd",
        column: "period_end",
        label: "Period end",
        type: "date",
      },
    ],
  }),
  ...(["customer", "vendor"] as const).flatMap((side) => [
    defineCommandSubject({
      kind: `${side}_rebate_agreement`,
      label: side === "customer" ? "Customer rebate agreement" : "Vendor rebate agreement",
      table: "rebate_agreements",
      statusColumn: "status",
      statuses: ["draft", "approved"],
      scope: tableScope("column", "rebate_agreements", "subsidiary_id"),
      where: sql`s.side=${side}`,
      permissions: {
        read: side === "vendor" ? "ap.read" : "ar.read",
        edit: side === "vendor" ? "ap.post" : "ar.post",
        approve: side === "vendor" ? "ap.post" : "ar.post",
      },

      fields: [
        { key: "name", column: "name", label: "Agreement", type: "text" },
        { key: "side", column: "side", label: "Side", type: "text" },
        {
          key: "currency",
          column: "currency",
          label: "Currency",
          type: "text",
        },
        {
          key: "effectiveFrom",
          column: "effective_from",
          label: "Starts",
          type: "date",
        },
      ],
    }),
    defineCommandSubject({
      kind: `${side}_rebate_claim`,
      label: side === "customer" ? "Customer rebate claim" : "Vendor rebate claim",
      table: "rebate_claims",
      statusColumn: "status",
      statuses: ["draft", "approved", "document_pending", "settled", "cancelled"],
      permissions: {
        read: side === "vendor" ? "ap.read" : "ar.read",
        edit: side === "vendor" ? "ap.post" : "ar.post",
        approve: side === "vendor" ? "ap.post" : "ar.post",
      },
      where: sql`exists(select 1 from rebate_agreements a where a.org_id=s.org_id and a.id=s.agreement_id and a.side=${side})`,
      scope: {
        via: "custom",
        worklistPredicate(idsJson: string) {
          return sql`exists(select 1 from rebate_claims c join rebate_agreements a on a.org_id=c.org_id and a.id=c.agreement_id where c.org_id=g.org_id and c.id=g.subject_id and a.side=${side} and a.subsidiary_id::text in(select jsonb_array_elements_text(${idsJson}::jsonb)))`;
        },
        async subsidiaryOf(orgId, ids, _allowed, lock) {
          return new Map(
            (
              await db.execute<{
                id: string;
                subsidiary_id: string;
              }>(
                sql`select c.id,a.subsidiary_id from rebate_claims c join rebate_agreements a on a.org_id=c.org_id and a.id=c.agreement_id
      where c.org_id=${orgId} and a.side=${side} and c.id in(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid) ${lock ? sql`for share of c,a` : sql``}`,
                "objects",
              )
            ).map((row) => [row.id, row.subsidiary_id]),
          );
        },
      },

      integrity: sql`(select to_jsonb(a) from rebate_agreements a where a.org_id=s.org_id and a.id=s.agreement_id)`,
      fields: [
        {
          key: "amount",
          column: "amount",
          label: "Claim amount",
          type: "number",
        },
        { key: "cutoffOn", column: "cutoff_on", label: "Cutoff", type: "date" },
      ],
    }),
  ]),
  defineCommandSubject({
    kind: "employment_change_action",
    label: "Employment history correction",
    table: "employment_changes",
    statusColumn: "verb",
    statuses: ["apply", "rescind", "correct", "cancel"],
    permissions: {
      read: "hrm.employment.read",
      edit: "hrm.employment.manage",
      approve: "hrm.employment.approve",
    },
    scope: tableScope("employment", "employment_changes", "employment_id"),

    integrity: sql`(select jsonb_build_object('revision',e.revision) from worker_employments e where e.org_id=s.org_id and e.id=s.employment_id)`,
    fields: [
      {
        key: "changeKind",
        column: "change_kind",
        label: "Change type",
        type: "text",
      },
      {
        key: "revision",
        column: "revision",
        label: "Revision",
        type: "number",
      },
    ],
  }),
];
export const nativeCommandSubjectProfiles = nativeCommandSubjects.map((adapter) => adapter.profile);
