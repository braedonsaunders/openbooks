/**
 * Tenant-coherent pointers between flow, payroll and payment records.
 *
 * Each pointer below is a composite foreign key from (org_id, <column>) to
 * its parent's (org_id, key), so a row can only name a parent in its own
 * organization. The catalog test pins every definition and that each
 * constraint is validated against stored rows; the behavioral tests prove a
 * same-tenant pointer is accepted and a cross-tenant pointer is refused on
 * insert and update, leaving the stored row unchanged.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function adminConnectionString() {
  const explicit = process.env.OPENBOOKS_TEST_ADMIN_DB_URL;
  if (explicit) return explicit.trim();
  const runtime = process.env.OPENBOOKS_DB_URL;
  if (!runtime) return "";
  const url = new URL(runtime);
  url.username = "openbooks";
  url.password = process.env.PGPASSWORD || "openbooks";
  return url.href;
}

function postgresCode(error) {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if (current.code) return current.code;
    current = current.cause;
  }
  return undefined;
}

async function seedTenant(client, label) {
  const t = {
    orgId: randomUUID(),
    subsidiaryId: randomUUID(),
    employeeId: randomUUID(),
    employmentId: randomUUID(),
    payScheduleId: randomUUID(),
    payRunDocumentId: randomUUID(),
    componentId: randomUUID(),
    flowId: randomUUID(),
    flowRunId: randomUUID(),
    subjectId: randomUUID(),
    accountId: randomUUID(),
    formatId: randomUUID(),
    profileId: randomUUID(),
    paymentScheduleId: randomUUID(),
    paymentRunId: randomUUID(),
  };
  await client.query(
    `insert into orgs (id, name, base_currency, country, settings, env_kind)
     values ($1, $2, 'CAD', 'CA', '{}'::jsonb, 'production')`,
    [t.orgId, `Pointer tenant ${label}`],
  );
  await client.query(
    `insert into subsidiaries (id, org_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
     values ($1, $2, $3, 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`,
    [t.subsidiaryId, t.orgId, `Main ${label}`],
  );
  await client.query(
    `insert into parties (id, org_id, kind, display_name, is_active, subsidiary_id, custom)
     values ($1, $2, 'person', $3, true, $4, '{}'::jsonb)`,
    [t.employeeId, t.orgId, `Employee ${label}`, t.subsidiaryId],
  );
  await client.query(
    `insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id)
     values ($1, $2, $3, $4)`,
    [t.employmentId, t.orgId, t.employeeId, t.subsidiaryId],
  );
  await client.query(
    `insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active)
     values ($1, $2, $3, 'biweekly', 26, '2026-07-18', 3, true)`,
    [t.payScheduleId, t.orgId, `Biweekly ${label}`],
  );
  await client.query(
    `insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date, currency, status)
     values ($1, $2, 'pay_run', $3, $4, '2026-07-21', 'CAD', 'draft')`,
    [t.orgId, t.payRunDocumentId, `PAY-${label}-${t.payRunDocumentId.slice(0, 8)}`, t.subsidiaryId],
  );
  await client.query(
    `insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, run_status)
     values ($1, $2, $3, '2026-07-05', '2026-07-18', '2026-07-21', 2026, 'draft')`,
    [t.payRunDocumentId, t.orgId, t.payScheduleId],
  );
  await client.query(
    `insert into pay_components (id, org_id, code, name, kind) values ($1, $2, $3, $4, 'earning')`,
    [t.componentId, t.orgId, `BONUS-${label}`, `Bonus ${label}`],
  );
  await client.query(
    `insert into flows (id, org_id, name, subject_kind, graph)
     values ($1, $2, $3, 'vendor_bill', '{"nodes":[],"edges":[]}'::jsonb)`,
    [t.flowId, t.orgId, `Flow ${label}`],
  );
  await client.query(
    `insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger)
     values ($1, $2, $3, 'vendor_bill', $4, 'manual')`,
    [t.flowRunId, t.orgId, t.flowId, t.subjectId],
  );
  await client.query(
    `insert into accounts (id, org_id, name, type, reconcilable, currency_restriction)
     values ($1, $2, $3, 'asset_bank', true, 'CAD')`,
    [t.accountId, t.orgId, `Bank ${label}`],
  );
  await client.query(
    `insert into payment_formats (id, org_id, code, name, rail, direction)
     values ($1, $2, $3, $4, 'cpa005_credit', 'credit')`,
    [t.formatId, t.orgId, `fmt-${label}`, `Format ${label}`],
  );
  await client.query(
    `insert into payment_bank_profiles (id, org_id, name, bank_account_id, payment_format_id, currency)
     values ($1, $2, $3, $4, $5, 'CAD')`,
    [t.profileId, t.orgId, `Profile ${label}`, t.accountId, t.formatId],
  );
  await client.query(
    `insert into payment_schedules (id, org_id, name, payment_bank_profile_id, cron, timezone)
     values ($1, $2, $3, $4, '0 8 * * 1', 'UTC')`,
    [t.paymentScheduleId, t.orgId, `Schedule ${label}`, t.profileId],
  );
  await client.query(
    `insert into payment_runs (id, org_id, run_number, bank_account_id, method)
     values ($1, $2, $3, $4, 'eft')`,
    [t.paymentRunId, t.orgId, `RUN-${label}`, t.accountId],
  );
  return t;
}

/**
 * The frozen-policy guard refuses a gate that does not match its own run's
 * policy, which already excludes a foreign flow or run. Under sandbox clone
 * authority that guard abstains on insert and the composite keys alone keep
 * a copied gate inside its tenant, so gate rows are written under clone
 * authority to prove the keys themselves.
 */
async function withCloneAuthority(client, work) {
  // A refused write aborts the transaction; the caller's savepoint rollback
  // then also reverts these settings, so they are cleared only on success.
  await client.query(`select set_config('openbooks.clone', 'on', true),
    set_config('openbooks.migration', 'on', true), set_config('openbooks.amend', 'on', true)`);
  const result = await work();
  await client.query(`select set_config('openbooks.clone', 'off', true),
    set_config('openbooks.migration', 'off', true), set_config('openbooks.amend', 'off', true)`);
  return result;
}

function insertGate(client, tenant, { flowId = tenant.flowId, runId = tenant.flowRunId } = {}) {
  const id = randomUUID();
  const nodeId = `gate-${id.slice(0, 8)}`;
  return withCloneAuthority(client, () =>
    client.query(
      `insert into flow_gates (id, org_id, flow_id, run_id, node_id, subject_kind, subject_id, title, group_key)
     values ($1, $2, $3, $4, $5, 'vendor_bill', $6, 'Approve', $7)`,
      [id, tenant.orgId, flowId, runId, nodeId, tenant.subjectId, `${runId}:${nodeId}`],
    ),
  ).then(() => id);
}

async function insertRow(client, table, values) {
  const id = randomUUID();
  const columns = ["id", ...Object.keys(values)];
  const params = [id, ...Object.values(values)];
  await client.query(
    `insert into ${table} (${columns.join(", ")}) values (${params.map((_, i) => `$${i + 1}`).join(", ")})`,
    params,
  );
  return id;
}

/**
 * `insert(client, tenant, reference)` writes a row of `tenant` whose pointer
 * names `reference`; `parent` reads the referenced key from a tenant.
 * `updateCode` is the refusal for repointing an existing row: the composite
 * key (23503), or 23514 where an immutability guard refuses any repointing
 * before the key is consulted.
 */
const POINTERS = [
  {
    table: "flow_runs",
    column: "flow_id",
    constraint: "flow_runs_flow_id_fkey",
    parent: (t) => t.flowId,
    updateCode: "23514",
    definition:
      "FOREIGN KEY (org_id, flow_id) REFERENCES flows(org_id, id) ON DELETE CASCADE DEFERRABLE",
    insert: (c, t, ref) =>
      insertRow(c, "flow_runs", {
        org_id: t.orgId,
        flow_id: ref,
        subject_kind: "vendor_bill",
        subject_id: randomUUID(),
        trigger: "manual",
      }),
  },
  {
    table: "flow_locks",
    column: "flow_id",
    constraint: "flow_locks_flow_id_fkey",
    parent: (t) => t.flowId,
    updateCode: "23503",
    definition:
      "FOREIGN KEY (org_id, flow_id) REFERENCES flows(org_id, id) ON DELETE CASCADE DEFERRABLE",
    insert: (c, t, ref) =>
      insertRow(c, "flow_locks", {
        org_id: t.orgId,
        subject_kind: "vendor_bill",
        subject_id: randomUUID(),
        flow_id: ref,
      }),
  },
  {
    table: "flow_run_effects",
    column: "run_id",
    constraint: "flow_run_effects_run_id_fkey",
    parent: (t) => t.flowRunId,
    updateCode: "23503",
    definition:
      "FOREIGN KEY (org_id, run_id) REFERENCES flow_runs(org_id, id) ON DELETE CASCADE DEFERRABLE",
    insert: (c, t, ref) =>
      insertRow(c, "flow_run_effects", {
        org_id: t.orgId,
        run_id: ref,
        effect_key: `effect-${randomUUID()}`,
      }),
  },
  {
    table: "flow_gates",
    column: "flow_id",
    constraint: "flow_gates_flow_id_fkey",
    parent: (t) => t.flowId,
    updateCode: "23514",
    definition:
      "FOREIGN KEY (org_id, flow_id) REFERENCES flows(org_id, id) ON DELETE CASCADE DEFERRABLE",
    insert: (c, t, ref) => insertGate(c, t, { flowId: ref }),
  },
  {
    table: "flow_gates",
    column: "run_id",
    constraint: "flow_gates_run_id_fkey",
    parent: (t) => t.flowRunId,
    updateCode: "23514",
    definition:
      "FOREIGN KEY (org_id, run_id) REFERENCES flow_runs(org_id, id) ON DELETE CASCADE DEFERRABLE",
    insert: (c, t, ref) => insertGate(c, t, { runId: ref }),
  },
  {
    table: "pay_run_adjustments",
    column: "pay_run_document_id",
    constraint: "pay_run_adjustments_run_fkey",
    parent: (t) => t.payRunDocumentId,
    updateCode: "23503",
    definition:
      "FOREIGN KEY (org_id, pay_run_document_id) REFERENCES pay_runs(org_id, document_id) ON DELETE CASCADE DEFERRABLE",
    insert: (c, t, ref) =>
      insertRow(c, "pay_run_adjustments", {
        org_id: t.orgId,
        pay_run_document_id: ref,
        employee_party_id: t.employeeId,
        adjustment_type: "exclude",
      }),
  },
  {
    table: "pay_run_adjustments",
    column: "component_id",
    constraint: "pay_run_adjustments_component_fkey",
    parent: (t) => t.componentId,
    updateCode: "23503",
    definition:
      "FOREIGN KEY (org_id, component_id) REFERENCES pay_components(org_id, id) ON DELETE CASCADE DEFERRABLE",
    insert: (c, t, ref) =>
      insertRow(c, "pay_run_adjustments", {
        org_id: t.orgId,
        pay_run_document_id: t.payRunDocumentId,
        employee_party_id: t.employeeId,
        adjustment_type: "line",
        component_id: ref,
        amount: "100.0000",
      }),
  },
  {
    table: "pay_run_holiday_assertions",
    column: "pay_run_document_id",
    constraint: "pay_run_holiday_assertions_run_fkey",
    parent: (t) => t.payRunDocumentId,
    updateCode: "23503",
    definition:
      "FOREIGN KEY (org_id, pay_run_document_id) REFERENCES pay_runs(org_id, document_id) ON DELETE CASCADE DEFERRABLE",
    insert: (c, t, ref) =>
      insertRow(c, "pay_run_holiday_assertions", {
        org_id: t.orgId,
        pay_run_document_id: ref,
        employee_party_id: t.employeeId,
        holiday_key: `holiday-${randomUUID()}`,
        holiday_date: "2026-07-01",
        absent_without_consent: false,
      }),
  },
  {
    table: "pay_stubs",
    column: "pay_run_document_id",
    constraint: "pay_stubs_pay_run_document_id_fkey",
    parent: (t) => t.payRunDocumentId,
    updateCode: "23503",
    definition:
      "FOREIGN KEY (org_id, pay_run_document_id) REFERENCES pay_runs(org_id, document_id) ON DELETE CASCADE DEFERRABLE",
    insert: (c, t, ref) =>
      insertRow(c, "pay_stubs", {
        org_id: t.orgId,
        pay_run_document_id: ref,
        employee_party_id: t.employeeId,
        employment_id: t.employmentId,
        province: "ON",
        periods_per_year: 26,
        pay_date: "2026-07-21",
        tax_year: 2026,
        currency_code: "CAD",
        gross: "0",
        net_pay: "0",
        pensionable_earnings: "0",
        insurable_earnings: "0",
        factors: "{}",
      }),
  },
  {
    table: "payment_runs",
    column: "source_schedule_id",
    constraint: "payment_runs_source_schedule_id_fkey",
    parent: (t) => t.paymentScheduleId,
    updateCode: "23503",
    definition:
      "FOREIGN KEY (org_id, source_schedule_id) REFERENCES payment_schedules(org_id, id) DEFERRABLE",
    insert: (c, t, ref) =>
      insertRow(c, "payment_runs", {
        org_id: t.orgId,
        run_number: `RUN-${randomUUID()}`,
        bank_account_id: t.accountId,
        method: "eft",
        source_schedule_id: ref,
      }),
  },
  {
    table: "payment_schedules",
    column: "last_payment_run_id",
    constraint: "payment_schedules_last_payment_run_id_fkey",
    parent: (t) => t.paymentRunId,
    updateCode: "23503",
    definition:
      "FOREIGN KEY (org_id, last_payment_run_id) REFERENCES payment_runs(org_id, id) DEFERRABLE",
    insert: (c, t, ref) =>
      insertRow(c, "payment_schedules", {
        org_id: t.orgId,
        name: `Schedule ${randomUUID()}`,
        payment_bank_profile_id: t.profileId,
        cron: "0 8 * * 1",
        timezone: "UTC",
        last_payment_run_id: ref,
      }),
  },
];

async function inTransaction(work) {
  const client = new pg.Client({ connectionString: adminConnectionString() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls', 'on', true)");
    await work(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

async function refuses(client, operation, code) {
  await client.query("savepoint refused_pointer");
  await assert.rejects(operation(), (error) => {
    assert.equal(postgresCode(error), code, String(error));
    return true;
  });
  await client.query("rollback to savepoint refused_pointer");
}

test(
  "every flow, payroll and payment tenant pointer is a validated composite key",
  { skip: !DB },
  () =>
    inTransaction(async (client) => {
      for (const pointer of POINTERS) {
        const result = await client.query(
          `select contype, convalidated, pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = $1::regclass and conname = $2`,
          [`public.${pointer.table}`, pointer.constraint],
        );
        assert.equal(result.rows.length, 1, `${pointer.constraint} must exist`);
        assert.deepEqual(
          result.rows[0],
          { contype: "f", convalidated: true, definition: pointer.definition },
          pointer.constraint,
        );
      }
    }),
);

for (const pointer of POINTERS) {
  test(
    `${pointer.table}.${pointer.column} accepts a same-tenant parent and refuses a cross-tenant one`,
    { skip: !DB },
    () =>
      inTransaction(async (client) => {
        const tenant = await seedTenant(client, "A");
        const other = await seedTenant(client, "B");
        const id = await pointer.insert(client, tenant, pointer.parent(tenant));
        const read = async () =>
          (
            await client.query(
              `select org_id, ${pointer.column} as reference from ${pointer.table} where id = $1`,
              [id],
            )
          ).rows;
        const stored = await read();
        assert.deepEqual(stored, [{ org_id: tenant.orgId, reference: pointer.parent(tenant) }]);

        await refuses(client, () => pointer.insert(client, tenant, pointer.parent(other)), "23503");
        await refuses(
          client,
          () =>
            client.query(`update ${pointer.table} set ${pointer.column} = $1 where id = $2`, [
              pointer.parent(other),
              id,
            ]),
          pointer.updateCode,
        );
        assert.deepEqual(await read(), stored, "a refused repointing leaves the row unchanged");
      }),
  );
}
