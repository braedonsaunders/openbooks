/**
 * 0741 carries the earlier roster and attendance rows into Unified
 * Scheduling and retires their tables. The test recreates the earlier tables
 * from the published 0552 bytes inside one transaction, records a
 * representative roster history for a scratch organization, runs the real
 * 0741 preflight and migration bytes, checks every carried fact, and rolls
 * the whole transaction back so the database is unchanged.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { withBypassContext } from "@openbooks/engine/platform/db";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "@openbooks/engine/testing/fixtures";

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const legacy = read("0552_hrm_shift_attendance.sql");
const migration = read("0741_carry_legacy_roster_into_unified_scheduling.sql");
const preflight = readFileSync(new URL("../preflight/0741_carry_legacy_roster_into_unified_scheduling.sql", import.meta.url), "utf8");
const hex = (seed: string) => `${seed.padEnd(32, "0").slice(0, 32)}${"a".repeat(32)}`.replace(/[^0-9a-f]/g, "b");

type Seed = { orgId: string; subsidiaryId: string; userId: string; reviewerId: string };

async function withLegacyRoster(seed: Seed, run: (client: pg.Client, ids: Record<string, string>) => Promise<void>, overrides: { breakSeconds?: number } = {}): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL });
  await client.connect();
  try {
    await client.query("begin");
    // Replay the carry-forward at its published schema boundary. The later
    // Flow migration retires governed timing; its current constraint cannot
    // validate the earlier migration's output before that forward step runs.
    // Every predecessor object and row below is rolled back together.
    await client.query(`alter table public.schedule_boards drop constraint schedule_boards_publish_policy_check,
      add constraint schedule_boards_publish_policy_check check (publish_policy in ('live','staged','governed'))`);
    await client.query(legacy);
    await client.query("set local session_replication_role = replica");
    const ids = {
      worker: randomUUID(), employment: randomUUID(), schedule: randomUUID(), templateOld: randomUUID(), templateNew: randomUUID(), assignment: randomUUID(),
      publication: randomUUID(), shiftA: randomUUID(), shiftB: randomUUID(), shiftClosed: randomUUID(), shiftChanged: randomUUID(), request: randomUUID(),
      pendingRequest: randomUUID(), device: randomUUID(), identity: randomUUID(), batch: randomUUID(), eventIn: randomUUID(), eventOut: randomUUID(),
      observation: randomUUID(), claimIn: randomUUID(), claimOut: randomUUID(),
    };
    const { orgId, subsidiaryId, userId, reviewerId } = seed;
    const q = (text: string, values: unknown[]) => client.query(text, values);
    await q(`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values ($1, $2, 'person', 'Robin Carer', $3, true, '{}'::jsonb)`, [ids.worker, orgId, subsidiaryId]);
    await q(`insert into employee_roles (org_id, party_id, job_title, hired_on, is_active) values ($1, $2, 'Carer', '2026-01-01', true)`, [orgId, ids.worker]);
    await q(`insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id) values ($1, $2, $3, $4)`, [ids.employment, orgId, ids.worker, subsidiaryId]);
    const policy = { captureBeforeSeconds: 3600, captureAfterSeconds: 3600, lateGraceSeconds: 300, earlyGraceSeconds: 300 };
    const pattern = (breakSeconds: number) => ({ schedule: { id: ids.schedule, name: "Weekly", pattern: "cycle", cycleDays: 7, cycleAnchor: "2026-03-02", days: [] },
      timeZone: "America/Toronto", slots: [{ position: 0, starts: "08:00:00", ends: "16:30:00", endDayOffset: 0, plannedBreakSeconds: breakSeconds, qualificationTypeIds: [] }] });
    for (const [id, version, status] of [[ids.templateOld, 1, "retired"], [ids.templateNew, 2, "approved"]] as const) {
      await q(`insert into hrm_shift_templates (id, org_id, subsidiary_id, normal_work_schedule_id, code, version, name, effective_from, effective_to, pattern, attendance_policy,
        definition_hash, status, author_party_id, decided_by, decided_at, request_hash, reason, created_by, updated_by)
        values ($1, $2, $3, $4, 'CARE', $5, ' Weekday care ', $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, now(), $10, 'Care cover', $14, $13)`,
        [id, orgId, subsidiaryId, ids.schedule, version, version === 1 ? "2026-01-05" : "2026-03-02", version === 1 ? "2026-03-02" : null,
          JSON.stringify(pattern(version === 2 ? (overrides.breakSeconds ?? 1800) : 1800)), JSON.stringify(policy), hex(`${version}`), status, ids.worker, reviewerId, userId]);
    }
    await q(`insert into hrm_shift_assignments (id, org_id, template_id, subsidiary_id, employment_id, worker_party_id, effective_from, status, author_party_id, decided_by, decided_at,
      request_hash, reason, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, '2026-03-02', 'approved', $6, $7, now(), $8, 'Robin covers weekdays', $9, $7)`,
      [ids.assignment, orgId, ids.templateNew, subsidiaryId, ids.employment, ids.worker, reviewerId, hex("a"), userId]);
    await q(`insert into hrm_shift_publications (id, org_id, assignment_id, from_on, through_on, assignment_revision, definition_hash, occurrence_selections, request_hash, reason, created_by)
      values ($1, $2, $3, '2026-03-02', '2026-03-22', 1, $4, $5::jsonb, $6, 'March roster', $7)`,
      [ids.publication, orgId, ids.assignment, hex("2"), JSON.stringify({ "2026-03-16:0": { omitReason: "Training day" } }), hex("p"), reviewerId]);
    const shift = (id: string, day: string, status: string, extra: { publication?: boolean; supersedes?: string | null; origin?: string | null; starts?: string; ends?: string } = {}) =>
      q(`insert into hrm_shifts (id, org_id, subsidiary_id, employment_id, worker_party_id, template_id, publication_id, slot_index, supersedes_id, origin_request_id, name, time_zone,
        starts_on, ends_on, starts_at, ends_at, planned_break_seconds, qualification_type_ids, attendance_policy, definition_hash, status, author_party_id, decided_by, decided_at,
        request_hash, reason, created_by, updated_by)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Weekday care', 'America/Toronto', $11, $11, $12, $13, 1800, '[]'::jsonb, $14::jsonb, $15, $16, $5,
          case when $16 = 'draft' then null else $17::uuid end, case when $16 = 'draft' then null else now() end, $18, 'Published roster', $19, $17)`,
        [id, orgId, subsidiaryId, ids.employment, ids.worker, extra.publication ? ids.templateNew : null, extra.publication ? ids.publication : null, extra.publication ? 0 : null,
          extra.supersedes ?? null, extra.origin ?? null, day, `${day}T${extra.starts ?? "12:00"}:00.000Z`, `${day}T${extra.ends ?? "20:30"}:00.000Z`, JSON.stringify(policy), hex("2"),
          status, reviewerId, hex(id.replaceAll("-", "")), userId]);
    await shift(ids.shiftA, "2026-03-02", "published", { publication: true });
    await shift(ids.shiftClosed, "2026-03-09", "closed", { publication: true });
    await shift(ids.shiftB, "2026-03-23", "cancelled", { publication: true });
    await shift(ids.shiftChanged, "2026-03-23", "published", { supersedes: ids.shiftB, origin: ids.request, starts: "13:00", ends: "21:30" });
    await q(`insert into hrm_shift_requests (id, org_id, shift_id, subsidiary_id, employment_id, worker_party_id, shift_revision, kind, proposed_starts_at, proposed_ends_at,
      outcome_shift_id, status, author_party_id, decided_by, decided_at, request_hash, reason, created_by, updated_by)
      values ($1, $2, $3, $4, $5, $6, 1, 'change', '2026-03-23T13:00:00.000Z', '2026-03-23T21:30:00.000Z', $7, 'approved', $6, $8, now(), $9, 'Approved for school pickup', $10, $8)`,
      [ids.request, orgId, ids.shiftB, subsidiaryId, ids.employment, ids.worker, ids.shiftChanged, reviewerId, hex("r"), userId]);
    await q(`insert into audit_log (org_id, table_name, row_id, action, actor_id, changes) values ($1, 'hrm_shift_requests', $2, 'insert', $3, $4::jsonb)`,
      [orgId, ids.request, userId, JSON.stringify({ after: { reason: "School pickup" } })]);
    await q(`insert into hrm_shift_requests (id, org_id, shift_id, subsidiary_id, employment_id, worker_party_id, shift_revision, kind, status, author_party_id, request_hash, reason, created_by, updated_by)
      values ($1, $2, $3, $4, $5, $6, 1, 'release', 'pending', $6, $7, 'Family event', $8, $8)`, [ids.pendingRequest, orgId, ids.shiftChanged, subsidiaryId, ids.employment, ids.worker, hex("q"), userId]);
    await q(`insert into hrm_attendance_devices (id, org_id, subsidiary_id, code, name, time_zone, is_active, request_hash, reason, created_by, updated_by)
      values ($1, $2, $3, 'CLINIC-CLOCK', 'Clinic clock', 'America/Toronto', false, $4, 'Install', $5, $5)`, [ids.device, orgId, subsidiaryId, hex("d"), userId]);
    await q(`insert into hrm_attendance_identities (id, org_id, device_id, source_worker_id, subsidiary_id, employment_id, worker_party_id, effective_from, request_hash, reason, created_by, updated_by)
      values ($1, $2, $3, 'R-1', $4, $5, $6, '2026-01-01', $7, 'Badge', $8, $8)`, [ids.identity, orgId, ids.device, subsidiaryId, ids.employment, ids.worker, hex("i"), userId]);
    await q(`insert into hrm_attendance_batches (id, org_id, device_id, complete_through, source_evidence, event_count, request_hash, reason, created_by)
      values ($1, $2, $3, '2026-03-03T00:00:00.000Z', '{"source":"clock export"}'::jsonb, 2, $4, 'Sync', $5)`, [ids.batch, orgId, ids.device, hex("b"), userId]);
    for (const [id, kind, at, sourceId] of [[ids.eventIn, "clock_in", "2026-03-02T12:10:00.000Z", "S1"], [ids.eventOut, "clock_out", "2026-03-02T20:30:00.000Z", "S2"]] as const) {
      await q(`insert into hrm_attendance_events (id, org_id, device_id, batch_id, identity_id, subsidiary_id, employment_id, worker_party_id, source_event_id, source_version, kind,
        occurred_at, source_local_date, source_payload, request_hash, reason, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, '2026-03-02', '{}'::jsonb, $12, 'Sync', $13)`,
        [id, orgId, ids.device, ids.batch, ids.identity, subsidiaryId, ids.employment, ids.worker, sourceId, kind, at, hex(sourceId), userId]);
    }
    await q(`insert into hrm_attendance_watermarks (org_id, device_id, batch_id, complete_through, request_hash, reason, created_by, updated_by)
      values ($1, $2, $3, '2026-03-03T00:00:00.000Z', $4, 'Sync', $5, $5)`, [orgId, ids.device, ids.batch, hex("w"), userId]);
    await q(`insert into hrm_attendance_observations (id, org_id, shift_id, subsidiary_id, employment_id, worker_party_id, status, complete_through, first_in, last_out,
      presence_milliseconds, break_milliseconds, late, left_early, source_evidence, evidence_hash, request_hash, reason, created_by)
      values ($1, $2, $3, $4, $5, $6, 'present', '2026-03-03T00:00:00.000Z', '2026-03-02T12:10:00.000Z', '2026-03-02T20:30:00.000Z', 30000000, 0, true, false, '{}'::jsonb, $7, $8, 'Processed', $9)`,
      [ids.observation, orgId, ids.shiftA, subsidiaryId, ids.employment, ids.worker, hex("e"), hex("o"), userId]);
    for (const [claim, event] of [[ids.claimIn, ids.eventIn], [ids.claimOut, ids.eventOut]] as const) {
      await q(`insert into hrm_attendance_event_claims (id, org_id, event_id, shift_id, request_hash, reason, created_by) values ($1, $2, $3, $4, $5, 'Processed', $6)`,
        [claim, orgId, event, ids.shiftA, hex(claim.replaceAll("-", "")), userId]);
      await q(`insert into hrm_attendance_observation_events (org_id, observation_id, event_claim_id, request_hash, reason, created_by) values ($1, $2, $3, $4, 'Processed', $5)`,
        [orgId, ids.observation, claim, hex(`x${claim.replaceAll("-", "")}`), userId]);
    }
    await client.query("set local session_replication_role = origin");
    await run(client, ids);
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

async function scratch(run: (seed: Seed) => Promise<void>): Promise<void> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const userId = await withBypassContext(() => createScratchUser(org.orgId, "Scheduler", "scheduler"));
    const reviewerId = await withBypassContext(() => createScratchUser(org.orgId, "Reviewer", "reviewer"));
    await run({ orgId: org.orgId, subsidiaryId: org.subsidiaryId, userId, reviewerId });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

test("the earlier roster and attendance history moves into Unified Scheduling with its identities and decisions", async () => scratch(async (seed) => {
  await withLegacyRoster(seed, async (client, ids) => {
    const findings = (await client.query<{ code: string; severity: string }>(preflight)).rows;
    assert.deepEqual(findings.filter((row) => row.severity === "refuse"), [], JSON.stringify(findings));
    assert.ok(findings.some((row) => row.code === "0741.roster_board_created"));
    await client.query(migration);
    const one = async <T,>(text: string, values: unknown[] = []) => (await client.query(text, values)).rows[0] as T;
    for (const table of ["hrm_shift_templates", "hrm_shifts", "hrm_attendance_events"]) {
      assert.equal((await one<{ found: string | null }>(`select to_regclass($1)::text as found`, [`public.${table}`])).found, null, `${table} is retired`);
    }
    const patterns = (await client.query(`select id, code, is_active as active, name, slots from schedule_patterns where org_id = $1 order by code`, [seed.orgId])).rows;
    assert.deepEqual(patterns.map((row) => [row.id, row.code, row.active, row.name]), [[ids.templateOld, "CARE.1", false, "Weekday care"], [ids.templateNew, "CARE.2", true, "Weekday care"]]);
    assert.deepEqual(patterns[1].slots, [{ position: 0, starts: "08:00", ends: "16:30", breakMinutes: 30, qualificationTypeIds: [] }]);
    const board = await one<{ id: string; type: string; policy: string; governedFrom: string; tz: string }>(`select id, board_type as type, publish_policy as policy,
      governed_from::text as "governedFrom", time_zone as tz from schedule_boards where org_id = $1 and code like 'ROSTER-%'`, [seed.orgId]);
    assert.deepEqual([board.type, board.policy, board.governedFrom, board.tz], ["shift_roster", "governed", "2026-01-05", "America/Toronto"]);
    const policy = await one<{ before: number; late: number; from: string }>(`select capture_before_minutes as before, late_grace_minutes as late, effective_from::text as "from"
      from schedule_attendance_policies where org_id = $1`, [seed.orgId]);
    assert.deepEqual(policy, { before: 60, late: 5, from: "2026-01-05" });
    const assignment = await one<{ board: string; status: string; through: string }>(`select board_id as board, status, generated_through::text as through
      from schedule_pattern_assignments where org_id = $1 and id = $2`, [seed.orgId, ids.assignment]);
    assert.deepEqual(assignment, { board: board.id, status: "active", through: "2026-03-22" });
    const omission = await one<{ kind: string; reason: string }>(`select kind, reason from schedule_pattern_exceptions where org_id = $1 and occurs_on = '2026-03-16'`, [seed.orgId]);
    assert.deepEqual(omission, { kind: "omit", reason: "Training day" });
    const entries = (await client.query(`select id, status, governed, pattern_assignment_id as pattern, closed_at is not null as closed, break_minutes as break, supersedes_id as supersedes,
      origin_request_id as origin, detail from schedule_entries where org_id = $1 order by starts_at, id`, [seed.orgId])).rows;
    const byId = new Map(entries.map((row) => [row.id, row]));
    assert.deepEqual([byId.get(ids.shiftA)?.status, byId.get(ids.shiftA)?.governed, byId.get(ids.shiftA)?.pattern, byId.get(ids.shiftA)?.break], ["published", true, ids.assignment, 30]);
    assert.deepEqual([byId.get(ids.shiftClosed)?.status, byId.get(ids.shiftClosed)?.closed], ["published", true]);
    assert.deepEqual([byId.get(ids.shiftChanged)?.supersedes, byId.get(ids.shiftChanged)?.origin, byId.get(ids.shiftChanged)?.detail], [ids.shiftB, ids.request, "Weekday care"]);
    const requests = (await client.query(`select id, status, reason, decision_reason as decision, proposed_break_minutes as break from schedule_entry_requests where org_id = $1 order by created_at, id`, [seed.orgId])).rows;
    assert.deepEqual(requests.find((row) => row.id === ids.request), { id: ids.request, status: "approved", reason: "School pickup", decision: "Approved for school pickup", break: 30 });
    assert.equal(requests.find((row) => row.id === ids.pendingRequest)?.status, "pending");
    const device = await one<{ active: boolean; code: string }>(`select is_active as active, code from schedule_attendance_devices where org_id = $1 and id = $2`, [seed.orgId, ids.device]);
    assert.deepEqual(device, { active: false, code: "CLINIC-CLOCK" });
    const observation = await one<{ entry: string; late: boolean; overBreak: boolean; policy: string | null }>(`select entry_id as entry, late, over_break as "overBreak", policy_id as policy
      from schedule_attendance_observations where org_id = $1`, [seed.orgId]);
    assert.equal(observation.entry, ids.shiftA);
    assert.deepEqual([observation.late, observation.overBreak, observation.policy !== null], [true, false, true]);
    assert.equal((await one<{ n: number }>(`select count(*)::int as n from schedule_attendance_observation_events where org_id = $1`, [seed.orgId])).n, 2);
    // The suspended guards are back in force once the history is carried.
    await assert.rejects(client.query(`delete from schedule_entries where org_id = $1 and id = $2`, [seed.orgId, ids.shiftA]), /cannot be deleted/);
  });
}));

test("the preflight refuses a template whose break is not whole minutes, before anything moves", async () => scratch(async (seed) => {
  await withLegacyRoster(seed, async (client) => {
    const refusals = (await client.query<{ code: string; severity: string }>(preflight)).rows.filter((row) => row.severity === "refuse");
    assert.deepEqual(refusals.map((row) => row.code), ["0741.template_clock_precision"]);
  }, { breakSeconds: 1830 });
}));

test("a draft template and an inactive device move without creating a roster board", async () => scratch(async (seed) => {
  const client = new pg.Client({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL });
  await client.connect();
  try {
    await client.query("begin");
    // Replay the carry-forward at its published schema boundary. The later
    // Flow migration retires governed timing; its current constraint cannot
    // validate the earlier migration's output before that forward step runs.
    // Every predecessor object and row below is rolled back together.
    await client.query(`alter table public.schedule_boards drop constraint schedule_boards_publish_policy_check,
      add constraint schedule_boards_publish_policy_check check (publish_policy in ('live','staged','governed'))`);
    await client.query(legacy);
    await client.query("set local session_replication_role = replica");
    const template = randomUUID(), device = randomUUID(), person = randomUUID();
    await client.query(`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values ($1, $2, 'person', 'Author', $3, true, '{}'::jsonb)`, [person, seed.orgId, seed.subsidiaryId]);
    await client.query(`insert into hrm_shift_templates (id, org_id, subsidiary_id, normal_work_schedule_id, code, version, name, description, effective_from, pattern, definition_hash,
      status, author_party_id, request_hash, reason, created_by, updated_by) values ($1, $2, $3, $4, 'DEMO-CARE-TEAM', 1, 'Weekday care team', 'Review before publishing.', '2026-10-01', $5::jsonb, $6, 'draft', $7, $6, 'Prepare', $8, $8)`,
      [template, seed.orgId, seed.subsidiaryId, randomUUID(), JSON.stringify({ schedule: { cycleDays: 7, cycleAnchor: "2026-09-28" }, timeZone: "America/New_York",
        slots: [1, 2, 3, 4, 5].map((position) => ({ position, starts: "08:00:00", ends: "16:30:00", endDayOffset: 0, plannedBreakSeconds: 1800, qualificationTypeIds: [] })) }), hex("t"), person, seed.userId]);
    await client.query(`insert into hrm_attendance_devices (id, org_id, subsidiary_id, code, name, time_zone, is_active, request_hash, reason, created_by, updated_by)
      values ($1, $2, $3, 'DEMO-CLINIC-CLOCK', 'Clinic attendance import — disconnected', 'America/New_York', false, $4, 'Prepare', $5, $5)`, [device, seed.orgId, seed.subsidiaryId, hex("d"), seed.userId]);
    await client.query("set local session_replication_role = origin");
    const findings = (await client.query<{ code: string; severity: string }>(preflight)).rows;
    assert.deepEqual(findings.map((row) => [row.code, row.severity]).sort(), [["0741.attendance_devices_carried", "notice"], ["0741.shift_templates_carried", "notice"]]);
    await client.query(migration);
    const pattern = (await client.query(`select code, is_active as active, cycle_days as days, cycle_anchor::text as anchor, time_zone as tz, jsonb_array_length(slots) as slots
      from schedule_patterns where org_id = $1 and id = $2`, [seed.orgId, template])).rows[0];
    assert.deepEqual(pattern, { code: "DEMO-CARE-TEAM", active: false, days: 7, anchor: "2026-09-28", tz: "America/New_York", slots: 5 });
    assert.equal((await client.query(`select is_active from schedule_attendance_devices where org_id = $1 and id = $2`, [seed.orgId, device])).rows[0]?.is_active, false);
    assert.equal((await client.query(`select count(*)::int as n from schedule_boards where org_id = $1 and board_type = 'shift_roster'`, [seed.orgId])).rows[0]?.n, 0);
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}));
