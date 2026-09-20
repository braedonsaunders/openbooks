// Run with:  env $OB_TEST_ENV node --no-concurrent-sparkplug --no-concurrent-recompilation --import tsx --import ./engine/src/testing/database-bypass.ts --test --test-force-exit --test-reporter=tap engine/src/scripting/custom-gl-lines.integration.test.ts   (from repo root)
//
// custom_gl_lines trigger (allocation kernel, shard A6): tenant-authored extra
// GL lines contributed to a document's own journal entry at posting. Scripts
// see the kernel lines read-only and return { lines: [...] }; the host
// validates (max 200 lines, account resolution, org ownership, per-subsidiary
// balance), stamps contributor_kind='script', and the first refusal halts
// posting with no partial write.
// Skipped unless OPENBOOKS_DB_URL is set.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { runScript } from "./scripting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("the custom-gl-lines path re-resolves gl.post live before any contribution", () => {
  const source = readFileSync(new URL("./scripting.ts", import.meta.url), "utf8");
  const hostStart = source.indexOf("runCustomGlLineScripts");
  assert.ok(hostStart > 0, "runCustomGlLineScripts must exist in scripting.ts");
  const boundary = source.slice(hostStart, hostStart + 4000);
  assert.match(
    boundary,
    /actorHasPermission\(db, [^,]+, [^,]+, "gl\.post"\)/,
    "custom_gl_lines must re-resolve the caller's live gl.post like ob.journal.create",
  );
});

test("custom_gl_lines applies the posting actor's subsidiary allowlist", () => {
  const source = readFileSync(new URL("./scripting.ts", import.meta.url), "utf8");
  const host = source.slice(source.indexOf("runCustomGlLineScripts"), source.indexOf("const CUSTOM_GL_LINE_UUID_RE"));
  assert.match(host, /actorAllowedSubsidiaryIds\(/);
  const resolve = source.slice(source.indexOf("export async function resolveCustomGlLines"), source.indexOf("return parsed.map"));
  assert.match(resolve, /allowedSubsidiaryIds/);
});

test("deterministic Date/Math locks are installed before user source and query is omitted", async () => {
  const source = readFileSync(new URL("./scripting.ts", import.meta.url), "utf8");
  const globalsAt = source.indexOf("const DETERMINISTIC_SCRIPT_GLOBALS");
  const evalAt = source.indexOf("vm.evalCode(DETERMINISTIC_SCRIPT_GLOBALS)");
  const programAt = source.indexOf("await vm.evalCodeAsync(program)");
  assert.ok(globalsAt >= 0, "DETERMINISTIC_SCRIPT_GLOBALS must lock Date/Math before tenant source");
  assert.ok(evalAt >= 0, "deterministic preparation must eval DETERMINISTIC_SCRIPT_GLOBALS");
  assert.ok(programAt >= 0, "user source must still run through evalCodeAsync(program)");
  assert.ok(
    evalAt < programAt,
    "Date/Math.random must be locked in a separate evaluation before tenant source runs",
  );

  const captured = await runScript(
    `const now = Date.now;
     function main(ctx) { return now(); }`,
    {
      trigger: "custom_gl_lines",
      document: { kind: "journal" },
      org: { id: "org", name: "Test org", baseCurrency: "CAD" },
    },
    2_000,
    { strict: true, forbidJournalCreate: true, deterministic: true },
  );
  assert.equal(captured.status, "error");
  assert.match(captured.abortReason ?? "", /deterministic: Date is not available/);

  const queried = await runScript(
    `function main(ctx) { return ob.query("select 1"); }`,
    {
      trigger: "custom_gl_lines",
      document: { kind: "journal" },
      org: { id: "org", name: "Test org", baseCurrency: "CAD" },
    },
    2_000,
    { strict: true, forbidJournalCreate: true, deterministic: true },
  );
  assert.equal(queried.status, "error");
  assert.match(queried.abortReason ?? "", /query is not available/);
});

test("strict scripts fail when they write to the frozen context", async () => {
  const res = await runScript(
    `function main(ctx) { ctx.document.memo = "mutated"; return {}; }`,
    {
      trigger: "custom_gl_lines",
      document: { kind: "journal", memo: "original" },
      org: { id: "org", name: "Test org", baseCurrency: "CAD" },
    },
    2_000,
    { strict: true },
  );
  assert.equal(res.status, "error");
  assert.match(res.abortReason ?? "", /read[- ]only| freezes|cannot assign/i);
});

/** Seed a balanced two-line draft journal and return its id. */
async function seedBalancedDraftJournal(
  org: ScratchOrg,
  documentNumber: string,
  createdBy: string,
  subsidiaryId: string = org.subsidiaryId,
): Promise<string> {
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id,
       document_date, currency, subtotal, tax_total, total, created_by)
    values (
      ${documentId}, ${org.orgId}, 'journal', 'draft', ${documentNumber},
      ${subsidiaryId}, ${org.date}, 'CAD', '10', '0', '10', ${createdBy}
    )
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, subsidiary_id,
       amount, quantity, unit_price, tax_amount, tax_input_amount)
    values
      (${org.orgId}, ${documentId}, 1, ${org.accounts.bank}, ${subsidiaryId},
       '10', '1', '10', '0', '10'),
      (${org.orgId}, ${documentId}, 2, ${org.accounts.cogs}, ${subsidiaryId},
       '-10', '1', '-10', '0', '-10')
  `);
  return documentId;
}

function postingControlDeps(org: ScratchOrg) {
  return {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  };
}

async function setFeatures(orgId: string, flags: Record<string, boolean>): Promise<void> {
  // jsonb_set per key: keeps every other org setting intact.
  for (const [key, value] of Object.entries(flags)) {
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, ${`{features,${key}}`}, ${String(value)}::jsonb)
       where id = ${orgId}
    `);
  }
}

async function enableAllocScripting(orgId: string): Promise<void> {
  // The allocations parent must be on for the allocationsAtPosting child to
  // resolve enabled (registry parentKey model).
  await setFeatures(orgId, { scripts: true, allocations: true, allocationsAtPosting: true });
}

async function seedCustomGlScript(
  orgId: string,
  source: string,
  opts: { name?: string; documentKind?: string | null; sortOrder?: number } = {},
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into user_scripts
      (id, org_id, name, trigger_point, document_kind, source, timeout_ms, sort_order, is_active)
    values (
      ${id}, ${orgId}, ${opts.name ?? "custom gl"}, 'custom_gl_lines',
      ${opts.documentKind ?? null}, ${source}, 2000, ${opts.sortOrder ?? 100}, true
    )
  `);
  return id;
}

async function accountNumber(accountId: string): Promise<string> {
  const r = await db.execute<{ number: string }>(sql`
    select number from accounts where id = ${accountId}`);
  return r.rows[0]!.number;
}

/** Balanced contributor: one leg by id, one by code. */
function balancedSource(debitAccountId: string, creditAccountCode: string): string {
  return `function main(ctx) {
    ob.log('kernel lines seen', ctx.kernelLines.length);
    return { lines: [
      { accountId: ${JSON.stringify(debitAccountId)}, amount: "7.50", memo: "script debit" },
      { accountCode: ${JSON.stringify(creditAccountCode)}, amount: "-7.50", memo: "script credit" },
    ] };
  }`;
}

async function postJournal(
  org: ScratchOrg,
  documentId: string,
  actorId: string | null,
): Promise<string> {
  await withOrgTransaction(org.orgId, async () => {
    await submitAndReleaseIfUngated("journal", documentId, actorId);
    await postDocument(documentId, postingControlDeps(org), {
      deferEffects: true,
      audit: { actorId, source: "test" },
    });
  });
  const r = await withOrgContext(org.orgId, () =>
    db.execute<{ entry_id: string }>(sql`
      select posted_entry_id as "entry_id" from documents where id = ${documentId}`),
  );
  return r.rows[0]!.entry_id;
}

test("custom_gl_lines land on the same journal entry with script stamps", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Poster", "poster"));
    await withOrgContext(org.orgId, async () => {
      await enableAllocScripting(org.orgId);
      await db.execute(sql`
        update app_roles set permissions = '["gl.post"]'::jsonb
         where org_id = ${org.orgId} and key = 'poster'`);
    });
    const creditCode = await withOrgContext(org.orgId, () => accountNumber(org.accounts.clearing));
    const scriptId = await withOrgContext(org.orgId, () =>
      seedCustomGlScript(org.orgId, balancedSource(org.accounts.freight, creditCode)),
    );
    const documentId = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-CGL-OK", actorId),
    );
    const entryId = await postJournal(org, documentId, actorId);

    const lines = await withOrgContext(org.orgId, () =>
      db.execute<{
        account_id: string;
        amount: string;
        contributor_kind: string | null;
        contributor_ref: string | null;
      }>(sql`
        select account_id, amount::text, contributor_kind, contributor_ref
          from journal_lines
         where org_id = ${org.orgId} and entry_id = ${entryId}
         order by line_number`),
    );
    assert.equal(lines.rows.length, 4, "kernel (2) + script (2) lines on one entry");
    const kernel = lines.rows.filter((l) => l.contributor_kind === null);
    const scripted = lines.rows.filter((l) => l.contributor_kind === "script");
    assert.equal(kernel.length, 2);
    assert.equal(scripted.length, 2);
    for (const l of scripted) assert.equal(l.contributor_ref, scriptId);
    assert.deepEqual(
      scripted.map((l) => l.account_id).sort(),
      [org.accounts.freight, org.accounts.clearing].sort(),
    );
    // The union still balances exactly.
    const total = await withOrgContext(org.orgId, () =>
      db.execute<{ total: string }>(sql`
        select sum(amount)::text as total from journal_lines
         where org_id = ${org.orgId} and entry_id = ${entryId}`),
    );
    assert.equal(toUnits(total.rows[0]!.total), 0n);

    const runs = await withOrgContext(org.orgId, () =>
      db.execute<{ status: string; logs: unknown }>(sql`
        select status, logs from script_runs
         where org_id = ${org.orgId} and script_id = ${scriptId} and target_id = ${documentId}`),
    );
    assert.equal(runs.rows.length, 1, "script_runs evidence recorded");
    assert.equal(runs.rows[0]!.status, "ok");
    assert.match(JSON.stringify(runs.rows[0]!.logs), /kernel lines seen/);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("unbalanced script lines refuse posting with no journal write", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Poster", "poster"));
    await withOrgContext(org.orgId, async () => {
      await enableAllocScripting(org.orgId);
      await db.execute(sql`
        update app_roles set permissions = '["gl.post"]'::jsonb
         where org_id = ${org.orgId} and key = 'poster'`);
      await seedCustomGlScript(
        org.orgId,
        `function main(ctx) { return { lines: [
          { accountId: ${JSON.stringify(org.accounts.freight)}, amount: "5" },
          { accountId: ${JSON.stringify(org.accounts.clearing)}, amount: "-4" },
        ] }; }`,
      );
    });
    const documentId = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-CGL-UNBAL", actorId),
    );
    // No outer transaction: the refusal evidence must persist while the
    // journal write must not.
    await withOrgContext(org.orgId, () =>
      submitAndReleaseIfUngated("journal", documentId, actorId),
    );
    await assert.rejects(
      withOrgContext(org.orgId, () =>
        postDocument(documentId, postingControlDeps(org), {
          deferEffects: true,
          audit: { actorId, source: "test" },
        }),
      ),
      /do not balance/,
    );
    const after = await withOrgContext(org.orgId, () =>
      db.execute<{ status: string; entries: number; runs: number; run_status: string }>(sql`
        select (select status from documents where id = ${documentId}) as status,
               (select count(*)::int from journal_entries where org_id = ${org.orgId}) as entries,
               (select count(*)::int from script_runs where org_id = ${org.orgId} and target_id = ${documentId}) as runs,
               (select status from script_runs where org_id = ${org.orgId} and target_id = ${documentId} limit 1) as run_status`),
    );
    assert.deepEqual(after.rows[0], {
      status: "approved",
      entries: 0,
      runs: 1,
      run_status: "ok",
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("unknown accountCode is refused with no write", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Poster", "poster"));
    await withOrgContext(org.orgId, async () => {
      await enableAllocScripting(org.orgId);
      await db.execute(sql`
        update app_roles set permissions = '["gl.post"]'::jsonb
         where org_id = ${org.orgId} and key = 'poster'`);
      await seedCustomGlScript(
        org.orgId,
        `function main(ctx) { return { lines: [
          { accountCode: "9999-NOPE", amount: "5" },
          { accountId: ${JSON.stringify(org.accounts.clearing)}, amount: "-5" },
        ] }; }`,
      );
    });
    const documentId = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-CGL-NOACCT", actorId),
    );
    await withOrgContext(org.orgId, () =>
      submitAndReleaseIfUngated("journal", documentId, actorId),
    );
    await assert.rejects(
      withOrgContext(org.orgId, () =>
        postDocument(documentId, postingControlDeps(org), {
          deferEffects: true,
          audit: { actorId, source: "test" },
        }),
      ),
      /unknown, inactive, or summary account code/,
    );
    const entries = await withOrgContext(org.orgId, () =>
      db.execute<{ n: number }>(sql`
        select count(*)::int as n from journal_entries where org_id = ${org.orgId}`),
    );
    assert.equal(entries.rows[0]!.n, 0);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a script that mutates kernelLines fails and halts posting", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Poster", "poster"));
    await withOrgContext(org.orgId, async () => {
      await enableAllocScripting(org.orgId);
      await db.execute(sql`
        update app_roles set permissions = '["gl.post"]'::jsonb
         where org_id = ${org.orgId} and key = 'poster'`);
      await seedCustomGlScript(
        org.orgId,
        `function main(ctx) {
          ctx.kernelLines[0].amount = "99999";
          ctx.kernelLines.push({ accountId: "x", amount: "1" });
          return { lines: [] };
        }`,
      );
    });
    const documentId = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-CGL-MUT", actorId),
    );
    await withOrgContext(org.orgId, () =>
      submitAndReleaseIfUngated("journal", documentId, actorId),
    );
    await assert.rejects(
      withOrgContext(org.orgId, () =>
        postDocument(documentId, postingControlDeps(org), {
          deferEffects: true,
          audit: { actorId, source: "test" },
        }),
      ),
      /custom_gl_lines script/,
    );
    const entries = await withOrgContext(org.orgId, () =>
      db.execute<{ n: number }>(sql`
        select count(*)::int as n from journal_entries where org_id = ${org.orgId}`),
    );
    assert.equal(entries.rows[0]!.n, 0, "the mutating script halted posting with no write");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("gates off: scripts run nowhere when any gate in the chain is disabled", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Poster", "poster"));
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`
        update app_roles set permissions = '["gl.post"]'::jsonb
         where org_id = ${org.orgId} and key = 'poster'`);
      await seedCustomGlScript(
        org.orgId,
        `function main(ctx) { throw new Error("must never run while gated off"); }`,
      );
    });
    // scripts feature off, allocations parent + child on: nothing fires.
    await withOrgContext(org.orgId, () =>
      setFeatures(org.orgId, { allocations: true, allocationsAtPosting: true }),
    );
    const first = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-CGL-GATE1", actorId),
    );
    await postJournal(org, first, actorId);
    // allocations parent off, scripts + child on: the child cannot resolve
    // enabled while its parent is off — nothing fires either.
    await withOrgContext(org.orgId, () =>
      setFeatures(org.orgId, { scripts: true, allocations: false, allocationsAtPosting: true }),
    );
    const second = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-CGL-GATE2", actorId),
    );
    await postJournal(org, second, actorId);
    // allocationsAtPosting child off, scripts + parent on: nothing fires.
    await withOrgContext(org.orgId, () =>
      setFeatures(org.orgId, { scripts: true, allocations: true, allocationsAtPosting: false }),
    );
    const third = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-CGL-GATE3", actorId),
    );
    await postJournal(org, third, actorId);

    const check = await withOrgContext(org.orgId, () =>
      db.execute<{ lines: number; runs: number }>(sql`
        select (select count(*)::int from journal_lines where org_id = ${org.orgId}) as lines,
               (select count(*)::int from script_runs where org_id = ${org.orgId}) as runs`),
    );
    assert.deepEqual(check.rows[0], { lines: 6, runs: 0 }, "kernel lines only, no script evidence");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("gl.post gate: a caller without ledger rights cannot contribute", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const clerkId = await withBypass(() => createScratchUser(org.orgId, "Clerk", "clerk"));
    const posterId = await withBypass(() => createScratchUser(org.orgId, "Poster", "poster"));
    await withOrgContext(org.orgId, async () => {
      await enableAllocScripting(org.orgId);
      await db.execute(sql`
        update app_roles set permissions = '["gl.post"]'::jsonb
         where org_id = ${org.orgId} and key = 'poster'`);
    });
    const creditCode = await withOrgContext(org.orgId, () => accountNumber(org.accounts.clearing));
    await withOrgContext(org.orgId, () =>
      seedCustomGlScript(org.orgId, balancedSource(org.accounts.freight, creditCode)),
    );
    const refused = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-CGL-NOPERM", clerkId),
    );
    await withOrgContext(org.orgId, () =>
      submitAndReleaseIfUngated("journal", refused, clerkId),
    );
    await assert.rejects(
      withOrgContext(org.orgId, () =>
        postDocument(refused, postingControlDeps(org), {
          deferEffects: true,
          audit: { actorId: clerkId, source: "test" },
        }),
      ),
      /gl\.post/,
    );
    const ok = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-CGL-PERM", posterId),
    );
    await postJournal(org, ok, posterId);
    const lines = await withOrgContext(org.orgId, () =>
      db.execute<{ n: number }>(sql`
        select count(*)::int as n from journal_lines
         where org_id = ${org.orgId} and contributor_kind = 'script'`),
    );
    assert.equal(lines.rows[0]!.n, 2, "the gl.post holder's contributions land");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("ob.journal.create is refused inside custom_gl_lines", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Poster", "poster"));
    await withOrgContext(org.orgId, async () => {
      await enableAllocScripting(org.orgId);
      await db.execute(sql`
        update app_roles set permissions = '["gl.post"]'::jsonb
         where org_id = ${org.orgId} and key = 'poster'`);
      await seedCustomGlScript(
        org.orgId,
        `function main(ctx) {
          return ob.journal.create({
            documentDate: "2026-07-15",
            lines: [
              { accountId: ${JSON.stringify(org.accounts.freight)}, amount: 5 },
              { accountId: ${JSON.stringify(org.accounts.clearing)}, amount: -5 },
            ],
          });
        }`,
      );
    });
    const documentId = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-CGL-NOJ", actorId),
    );
    await withOrgContext(org.orgId, () =>
      submitAndReleaseIfUngated("journal", documentId, actorId),
    );
    await assert.rejects(
      withOrgContext(org.orgId, () =>
        postDocument(documentId, postingControlDeps(org), {
          deferEffects: true,
          audit: { actorId, source: "test" },
        }),
      ),
      /journal\.create is not available in custom_gl_lines/,
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("more than 200 contributed lines are refused", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Poster", "poster"));
    await withOrgContext(org.orgId, async () => {
      await enableAllocScripting(org.orgId);
      await db.execute(sql`
        update app_roles set permissions = '["gl.post"]'::jsonb
         where org_id = ${org.orgId} and key = 'poster'`);
      await seedCustomGlScript(
        org.orgId,
        `function main(ctx) {
          var lines = [];
          for (var i = 0; i < 100; i++) {
            lines.push({ accountId: ${JSON.stringify(org.accounts.freight)}, amount: "1" });
            lines.push({ accountId: ${JSON.stringify(org.accounts.clearing)}, amount: "-1" });
          }
          lines.push({ accountId: ${JSON.stringify(org.accounts.freight)}, amount: "1" });
          return { lines: lines };
        }`,
      );
    });
    const documentId = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-CGL-MAX", actorId),
    );
    await withOrgContext(org.orgId, () =>
      submitAndReleaseIfUngated("journal", documentId, actorId),
    );
    await assert.rejects(
      withOrgContext(org.orgId, () =>
        postDocument(documentId, postingControlDeps(org), {
          deferEffects: true,
          audit: { actorId, source: "test" },
        }),
      ),
      /max 200/,
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("documentKind narrowing: a vendor_bill script does not fire on a journal", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Poster", "poster"));
    await withOrgContext(org.orgId, async () => {
      await enableAllocScripting(org.orgId);
      await db.execute(sql`
        update app_roles set permissions = '["gl.post"]'::jsonb
         where org_id = ${org.orgId} and key = 'poster'`);
      await seedCustomGlScript(
        org.orgId,
        `function main(ctx) { throw new Error("wrong kind fired"); }`,
        { documentKind: "vendor_bill" },
      );
    });
    const documentId = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-CGL-KIND", actorId),
    );
    await postJournal(org, documentId, actorId);
    const runs = await withOrgContext(org.orgId, () =>
      db.execute<{ n: number }>(sql`
        select count(*)::int as n from script_runs where org_id = ${org.orgId}`),
    );
    assert.equal(runs.rows[0]!.n, 0);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("the trigger is deterministic: clock access fails the run", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Poster", "poster"));
    await withOrgContext(org.orgId, async () => {
      await enableAllocScripting(org.orgId);
      await db.execute(sql`
        update app_roles set permissions = '["gl.post"]'::jsonb
         where org_id = ${org.orgId} and key = 'poster'`);
      await seedCustomGlScript(
        org.orgId,
        `function main(ctx) {
          var now = Date.now();
          return { lines: [] };
        }`,
      );
    });
    const documentId = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-CGL-DATE", actorId),
    );
    await withOrgContext(org.orgId, () =>
      submitAndReleaseIfUngated("journal", documentId, actorId),
    );
    await assert.rejects(
      withOrgContext(org.orgId, () =>
        postDocument(documentId, postingControlDeps(org), {
          deferEffects: true,
          audit: { actorId, source: "test" },
        }),
      ),
      /custom_gl_lines script/,
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("the first error halts the chain: later scripts never run", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Poster", "poster"));
    let secondId = "";
    await withOrgContext(org.orgId, async () => {
      await enableAllocScripting(org.orgId);
      await db.execute(sql`
        update app_roles set permissions = '["gl.post"]'::jsonb
         where org_id = ${org.orgId} and key = 'poster'`);
      await seedCustomGlScript(org.orgId, `function main(ctx) { throw new Error("first fails"); }`, {
        name: "first",
        sortOrder: 100,
      });
      secondId = await seedCustomGlScript(
        org.orgId,
        `function main(ctx) { ob.log("second ran"); return { lines: [] }; }`,
        { name: "second", sortOrder: 200 },
      );
    });
    const documentId = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-CGL-HALT", actorId),
    );
    await withOrgContext(org.orgId, () =>
      submitAndReleaseIfUngated("journal", documentId, actorId),
    );
    await assert.rejects(
      withOrgContext(org.orgId, () =>
        postDocument(documentId, postingControlDeps(org), {
          deferEffects: true,
          audit: { actorId, source: "test" },
        }),
      ),
      /first fails/,
    );
    const runs = await withOrgContext(org.orgId, () =>
      db.execute<{ script_id: string; status: string }>(sql`
        select script_id, status from script_runs
         where org_id = ${org.orgId} and target_id = ${documentId}`),
    );
    assert.equal(runs.rows.length, 1, "only the first script ran");
    assert.notEqual(runs.rows[0]!.script_id, secondId);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("an attributed custom_gl_lines run cannot stamp a subsidiary outside the actor allowlist", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Poster", "poster"));
    const childId = randomUUID();
    await withOrgContext(org.orgId, async () => {
      await enableAllocScripting(org.orgId);
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        select ${childId}, ${org.orgId}, ${org.subsidiaryId}, 'Child entity', base_currency, country
          from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
      await db.execute(sql`
        update app_roles
           set permissions = '["gl.post"]'::jsonb,
               subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [childId] })}::jsonb
         where org_id = ${org.orgId} and key = 'poster'`);
      const creditCode = await accountNumber(org.accounts.clearing);
      await seedCustomGlScript(
        org.orgId,
        `function main(ctx) {
          return { lines: [
            { accountId: ${JSON.stringify(org.accounts.freight)}, amount: "7.50", subsidiaryId: ${JSON.stringify(org.subsidiaryId)} },
            { accountCode: ${JSON.stringify(creditCode)}, amount: "-7.50", subsidiaryId: ${JSON.stringify(org.subsidiaryId)} },
          ] };
        }`,
      );
    });
    const documentId = await withOrgContext(org.orgId, () =>
      seedBalancedDraftJournal(org, "JE-CGL-SCOPE", actorId, childId),
    );
    await withOrgContext(org.orgId, () =>
      submitAndReleaseIfUngated("journal", documentId, actorId),
    );
    await assert.rejects(
      withOrgContext(org.orgId, () =>
        postDocument(documentId, postingControlDeps(org), {
          deferEffects: true,
          audit: { actorId, source: "test" },
        }),
      ),
      /subsidiary not found/,
    );
    const after = await withOrgContext(org.orgId, () =>
      db.execute<{ entries: number; scripted: number }>(sql`
        select (select count(*)::int from journal_entries where org_id = ${org.orgId}) as entries,
               (select count(*)::int from journal_lines where org_id = ${org.orgId} and contributor_kind = 'script') as scripted`),
    );
    assert.deepEqual(after.rows[0], { entries: 0, scripted: 0 });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
