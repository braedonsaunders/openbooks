import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import {
  applyTimeTicketLinks,
  classifyTimeTicketLinks,
  resolveTimeTicketLinks,
  type ApplyPlanRow,
} from "./field-ticket-time-links.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

interface Harness {
  orgId: string;
  projectId: string;
  ticketA: string;
  ticketB: string;
  ticketC: string;
}

async function ticket(
  orgId: string,
  currency: string,
  projectId: string,
  number: string,
): Promise<string> {
  const rows = (await db.execute<{ id: string }>(sql`
    insert into documents (org_id, kind, document_number, project_id, document_date, currency, status)
    values (${orgId}, 'field_ticket', ${number}, ${projectId}, '2024-06-10', ${currency}, 'approved')
    returning id
  `)).rows;
  return String(rows[0]!.id);
}

async function setup(orgId: string): Promise<Harness> {
  const currency = String(
    (await db.execute<{ base_currency: string }>(
      sql`select base_currency from orgs where id = ${orgId}`,
    )).rows[0]!.base_currency,
  );
  const projectId = String(
    (
      await db.execute<{ id: string }>(sql`
        insert into projects (org_id, name) values (${orgId}, 'Race Project') returning id
      `)
    ).rows[0]!.id,
  );
  const ticketA = await ticket(orgId, currency, projectId, `FT-A-${randomUUID().slice(0, 8)}`);
  const ticketB = await ticket(orgId, currency, projectId, `FT-B-${randomUUID().slice(0, 8)}`);
  const ticketC = await ticket(orgId, currency, projectId, `FT-C-${randomUUID().slice(0, 8)}`);
  return { orgId, projectId, ticketA, ticketB, ticketC };
}

async function entry(
  harness: Harness,
  sourceRef: string,
  ticketId: string,
): Promise<string> {
  const employeeId = String(
    (
      await db.execute<{ id: string }>(sql`
        insert into parties (org_id, kind, display_name) values (${harness.orgId}, 'employee', 'Race Hand') returning id
      `)
    ).rows[0]!.id,
  );
  return String(
    (
      await db.execute<{ id: string }>(sql`
        insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, field_ticket_id, custom)
        values (${harness.orgId}, ${employeeId}, '2024-06-10', '8', ${harness.projectId}, ${ticketId}, ${JSON.stringify({ nsId: sourceRef })}::jsonb)
        returning id
      `)
    ).rows[0]!.id,
  );
}

async function plan(
  harness: Harness,
  sourceRef: string,
  ticketNumber: string,
): Promise<ApplyPlanRow> {
  const resolved = await resolveTimeTicketLinks(harness.orgId, "nsId", [
    { sourceRef, ticketNumber },
  ]);
  const classified = classifyTimeTicketLinks(resolved, 1, 1);
  assert.equal(classified.applicableChanges.length, 1);
  const row = classified.applicableChanges[0]!;
  return {
    timeEntryId: row.timeEntryId!,
    sourceRef: row.sourceRef,
    ticketNumber: row.ticketNumber,
    fromTicketId: row.currentTicketId,
    fromTicketNumber: row.currentTicketNumber,
    toTicketId: row.targetTicketId!,
    entryProjectId: row.entryProjectId,
    ticketProjectId: row.ticketProjectId,
  };
}

async function currentTicket(orgId: string, entryId: string): Promise<string | null> {
  const rows = (await db.execute<{ field_ticket_id: string | null }>(
    sql`select field_ticket_id from time_entries where org_id = ${orgId} and id = ${entryId}`,
  )).rows;
  return rows[0]?.field_ticket_id ? String(rows[0].field_ticket_id) : null;
}

test("apply moves the entry and audits the locked before-state", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const harness = await setup(org.orgId);
    const ticketNumber = String(
      (await db.execute<{ document_number: string }>(
        sql`select document_number from documents where id = ${harness.ticketB}`,
      )).rows[0]!.document_number,
    );
    const entryId = await entry(harness, "SRC-APPLY", harness.ticketA);
    const batch = [await plan(harness, "SRC-APPLY", ticketNumber)];
    const runId = randomUUID();
    const applied = await withOrg(harness.orgId, () =>
      applyTimeTicketLinks(harness.orgId, batch, {
        reason: "test apply records locked before-state",
        inputSha256: "test",
        runId,
        actorId: null,
      }),
    );
    assert.equal(applied, 1);
    assert.equal(await currentTicket(harness.orgId, entryId), harness.ticketB);
    const audits = (
      await db.execute<{ actor_id: string | null; changes: unknown }>(
        sql`select actor_id, changes from audit_log where org_id = ${harness.orgId} and request_id = ${runId}`,
      )
    ).rows;
    assert.equal(audits.length, 1);
    const changes = audits[0]!.changes as {
      before: { fieldTicketId: string };
      after: { fieldTicketId: string };
    };
    assert.equal(changes.before.fieldTicketId, harness.ticketA);
    assert.equal(changes.after.fieldTicketId, harness.ticketB);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an entry billed between plan and apply refuses and keeps its ticket", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const harness = await setup(org.orgId);
    const ticketNumber = String(
      (await db.execute<{ document_number: string }>(
        sql`select document_number from documents where id = ${harness.ticketB}`,
      )).rows[0]!.document_number,
    );
    const entryId = await entry(harness, "SRC-BILLED", harness.ticketA);
    const batch = [await plan(harness, "SRC-BILLED", ticketNumber)];
    // The concurrent bill lands after the plan read.
    await db.execute(sql`
      update time_entries set billing_status = 'billed'
       where org_id = ${harness.orgId} and id = ${entryId}
    `);
    const runId = randomUUID();
    await assert.rejects(
      () =>
        withOrg(harness.orgId, () =>
          applyTimeTicketLinks(harness.orgId, batch, {
            reason: "test billed race refuses the entry",
            inputSha256: "test",
            runId,
            actorId: null,
          }),
        ),
      (error: unknown) => {
        const message = String((error as Error).message);
        assert.match(message, /now protected/);
        assert.match(message, new RegExp(entryId));
        return true;
      },
    );
    assert.equal(await currentTicket(harness.orgId, entryId), harness.ticketA);
    const audits = (
      await db.execute<{ id: string }>(
        sql`select id from audit_log where org_id = ${harness.orgId} and request_id = ${runId}`,
      )
    ).rows;
    assert.equal(audits.length, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an entry re-ticketed between plan and apply refuses instead of writing a false before-state", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const harness = await setup(org.orgId);
    const ticketNumber = String(
      (await db.execute<{ document_number: string }>(
        sql`select document_number from documents where id = ${harness.ticketB}`,
      )).rows[0]!.document_number,
    );
    const entryId = await entry(harness, "SRC-MOVED", harness.ticketA);
    const batch = [await plan(harness, "SRC-MOVED", ticketNumber)];
    // A concurrent ticket edit lands after the plan read.
    await db.execute(sql`
      update time_entries set field_ticket_id = ${harness.ticketC}
       where org_id = ${harness.orgId} and id = ${entryId}
    `);
    const runId = randomUUID();
    await assert.rejects(
      () =>
        withOrg(harness.orgId, () =>
          applyTimeTicketLinks(harness.orgId, batch, {
            reason: "test moved race refuses the entry",
            inputSha256: "test",
            runId,
            actorId: null,
          }),
        ),
      (error: unknown) => {
        const message = String((error as Error).message);
        assert.match(message, /moved from ticket/);
        assert.match(message, new RegExp(entryId));
        return true;
      },
    );
    assert.equal(await currentTicket(harness.orgId, entryId), harness.ticketC);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

const LINK_SCRIPT =
  process.env.G37_LINK_UNDER_TEST ??
  fileURLToPath(new URL("./link-field-ticket-time-by-source.ts", import.meta.url));

function runLinkTool(args: string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = fork(LINK_SCRIPT, args, {
      execArgv: [
        "--no-concurrent-sparkplug",
        "--no-concurrent-recompilation",
        "--import",
        "tsx",
        "--import",
        "./engine/src/testing/database-bypass.ts",
      ],
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr: `${stderr} (child timed out)` });
    }, 180_000);
    child.on("error", (error) => {
      clearTimeout(watchdog);
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(watchdog);
      resolve({ code, stdout, stderr });
    });
  });
}

async function ticketNumber(id: string): Promise<string> {
  return String(
    (
      await db.execute<{ document_number: string }>(
        sql`select document_number from documents where id = ${id}`,
      )
    ).rows[0]!.document_number,
  );
}

test("the apply without an operator refuses", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const harness = await setup(org.orgId);
    const entryId = await entry(harness, "SRC-NOACTOR", harness.ticketA);
    const dir = mkdtempSync(join(tmpdir(), "link-noactor-"));
    const input = join(dir, "links.json");
    writeFileSync(
      input,
      JSON.stringify([{ id: "SRC-NOACTOR", ticket_number: await ticketNumber(harness.ticketB) }]),
    );
    const result = await runLinkTool([
      `--org=${harness.orgId}`,
      `--input=${input}`,
      `--out=${join(dir, "report.json")}`,
      "--reason=test apply without an operator refuses",
      "--apply",
      // Scratch orgs are production-kind; the flag below is the test's
      // explicit decision to write to its own throwaway tenant.
      "--production",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--actor/);
    assert.equal(await currentTicket(harness.orgId, entryId), harness.ticketA);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the apply records the verified operator on every audit row", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const harness = await setup(org.orgId);
    const operatorId = await createScratchUser(org.orgId, "Link Operator", "link_operator");
    const entryId = await entry(harness, "SRC-ACTOR", harness.ticketA);
    const dir = mkdtempSync(join(tmpdir(), "link-actor-"));
    const input = join(dir, "links.json");
    writeFileSync(
      input,
      JSON.stringify([{ id: "SRC-ACTOR", ticket_number: await ticketNumber(harness.ticketB) }]),
    );
    const result = await runLinkTool([
      `--org=${harness.orgId}`,
      `--input=${input}`,
      `--out=${join(dir, "report.json")}`,
      "--reason=test apply records the verified operator",
      "--apply",
      // Scratch orgs are production-kind; the flag below is the test's
      // explicit decision to write to its own throwaway tenant.
      "--production",
      `--actor=${operatorId}`,
    ]);
    assert.equal(result.code, 0);
    assert.equal(await currentTicket(harness.orgId, entryId), harness.ticketB);
    const audits = (
      await db.execute<{ actor_id: string | null }>(
        sql`select actor_id from audit_log where org_id = ${harness.orgId} and table_name = 'time_entries'`,
      )
    ).rows;
    assert.ok(audits.length > 0);
    for (const audit of audits) {
      assert.equal(audit.actor_id, operatorId);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an entry deleted between plan and apply refuses by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const harness = await setup(org.orgId);
    const ticketNumber = String(
      (await db.execute<{ document_number: string }>(
        sql`select document_number from documents where id = ${harness.ticketB}`,
      )).rows[0]!.document_number,
    );
    const entryId = await entry(harness, "SRC-GONE", harness.ticketA);
    const batch = [await plan(harness, "SRC-GONE", ticketNumber)];
    await db.execute(sql`
      delete from time_entries where org_id = ${harness.orgId} and id = ${entryId}
    `);
    await assert.rejects(
      () =>
        withOrg(harness.orgId, () =>
          applyTimeTicketLinks(harness.orgId, batch, {
            reason: "test deleted race refuses the entry",
            inputSha256: "test",
            runId: randomUUID(),
            actorId: null,
          }),
        ),
      /no longer exists/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
