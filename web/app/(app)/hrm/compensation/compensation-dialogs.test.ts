import assert from "node:assert/strict";
import test from "node:test";

import { installCompensationReadFixture } from '../../../../testing/compensation-read-fixture';
const fixture = installCompensationReadFixture();

const { loadCompensationHome, loadCompCycleDetail, loadHeadcountPlanDetail, loadEquity, lineActionAvailability } =
  await import("../../../../lib/hrm/compensation.ts");


function authzWith(permissions: string[]) {
  return {
    user: { orgId: "org-comp-dlg", id: "actor-comp-dlg" },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  } as never;
}

const MANAGER = authzWith(["hrm.compensation.read", "hrm.compensation.manage", "admin.setup.manage"]);
const MANAGER_NO_SETUP = authzWith(["hrm.compensation.read", "hrm.compensation.manage"]);
const READER = authzWith(["hrm.compensation.read"]);

function features(flags: Record<string, boolean>) {
  fixture.features = flags;
}

test('plan register batches line reads and preserves exact per-plan costs', async () => {
  fixture.plans = ['one', 'two', 'empty'].map((id) => ({
    id, name: id, fiscalPeriodFrom: '2026-01-01', fiscalPeriodTo: '2026-12-31', status: 'draft',
  }));
  fixture.planLines = [
    { planId: 'one', estAnnualCost: '90071992547409.01' },
    { planId: 'one', estAnnualCost: '0.01' },
    { planId: 'two', estAnnualCost: '-0.02' },
    { planId: 'unlisted', estAnnualCost: '999.00' },
  ];
  fixture.planLineReads = [];
  try {
    const data = await loadCompensationHome(READER, { view: 'plans' });
    assert.deepEqual(fixture.planLineReads, [{ orgId: 'org-comp-dlg', actorId: 'actor-comp-dlg', planIds: ['one', 'two', 'empty'] }]);
    assert.deepEqual(data?.plans.map((row) => [row.id, row.totalCost]), [
      ['one', '90071992547409.02'], ['two', '-0.02'], ['empty', '0.00'],
    ]);
  } finally {
    fixture.plans = null;
    fixture.planLines = [];
    fixture.planLineReads = [];
  }
});

test("?plan=new resolves an open plan dialog with the existing create form", async () => {
  features({ payroll: true });
  const data = await loadCompensationHome(MANAGER, { plan: "new" });
  assert.ok(data, "the home loader still resolves");
  assert.equal(data.planOpen, true, "?plan=new opens the plan dialog");
  assert.equal(data.cycleOpen, false, "the cycle dialog stays shut");
  assert.equal(data.cycleDialog, null, "no cycle state leaks across dialogs");
  const dialog = data.planDialog;
  assert.ok(dialog, "the plan dialog resolves instead of nothing");
  assert.equal(dialog.open, true, "the widget's open state is set");
  assert.equal(dialog.closeHref, "/hrm/compensation", "closing navigates the param away");
  assert.equal(dialog.title, "New plan", "the title reuses the existing button copy");
  assert.equal(dialog.nameLabel, "Name", "labels reuse the existing catalog, never new keys");
  assert.ok(dialog.fromLabel.length > 0 && dialog.toLabel.length > 0, "the period labels resolve");
  assert.equal(dialog.refusal, null, "every prerequisite holds, so no refusal rides along");
  assert.equal(dialog.remedyHref, null, "no remedy link beside a form");
});

test("?cycle=new resolves an open cycle dialog over the four engine kinds", async () => {
  features({ payroll: true });
  fixture.baseCurrency = "USD";
  const data = await loadCompensationHome(MANAGER, { cycle: "new" });
  assert.ok(data, "the home loader still resolves");
  assert.deepEqual([data.cycleOpen, data.planOpen], [true, false], "?cycle=new opens only the requested dialog");
  const dialog = data.cycleDialog;
  assert.ok(dialog, "the cycle dialog resolves instead of nothing");
  assert.equal(dialog.defaultCurrency, "USD", "cycle creation inherits the organization's configured currency");
  assert.equal(dialog.closeHref, "/hrm/compensation", "closing navigates the param away");
  assert.deepEqual(
    dialog.kinds.map((k) => k.value),
    ["merit", "promotion", "adjustment", "cola"],
    "the kind picker covers the engine's closed kind set",
  );
  for (const kind of dialog.kinds) {
    assert.ok(!kind.label.includes("."), `kind ${kind.value} resolves to prose, never a key path`);
  }
  assert.equal(dialog.refusal, null, "every prerequisite holds, so no refusal rides along");
});

test("a requested dialog without the manage grant names the grant and its remedy", async () => {
  features({ payroll: true });
  const plan = await loadCompensationHome(READER, { plan: "new" });
  assert.equal(plan?.planOpen, true, "the dialog still opens — a refusal, never nothing");
  assert.ok(plan?.planDialog, "the plan dialog resolves");
  assert.equal(plan.planDialog.refusal?.title, "You don't have access", "the shared denial title, not a new key");
  assert.match(plan.planDialog.refusal?.message ?? "", /hrm\.compensation\.manage/, "the missing grant is named");
  assert.match(
    plan.planDialog.refusal?.message ?? "",
    /ask your administrator/,
    "the remedy names the person to ask",
  );
  assert.equal(plan.planDialog.remedyHref, null, "a missing grant is remedied by a person, never a link");

  const cycle = await loadCompensationHome(READER, { cycle: "new" });
  assert.equal(cycle?.cycleOpen, true, "the cycle dialog still opens");
  assert.match(cycle?.cycleDialog?.refusal?.message ?? "", /hrm\.compensation\.manage/, "the grant is named there too");
});

test("Payroll off names Payroll with the real switch for setup managers", async () => {
  // Merit cycles read current pay and push new rates, so the cycle dialog
  // needs Payroll beside Compensation.
  features({ payroll: false });
  const cycle = await loadCompensationHome(MANAGER, { cycle: "new" });
  assert.equal(cycle?.cycleOpen, true, "the dialog still opens");
  assert.equal(cycle?.cycleDialog?.refusal?.title, "Payroll is turned off", "the switchboard display name, not the key");
  assert.match(
    cycle?.cycleDialog?.refusal?.message ?? "",
    /needs the Payroll feature/,
    "the message names the feature with the shared feature-off copy",
  );
  assert.equal(cycle?.cycleDialog?.remedyHref, "/admin/setup/features", "setup managers get the real switch");
  assert.ok(
    (cycle?.cycleDialog?.remedyLabel ?? "").length > 0,
    "the switch link carries prose, never a key path",
  );
});

test("Payroll off without setup rights names the administrator instead", async () => {
  features({ payroll: false });
  const data = await loadCompensationHome(MANAGER_NO_SETUP, { cycle: "new" });
  assert.ok(data?.cycleDialog?.refusal, "the refusal still rides along");
  assert.equal(data.cycleDialog.remedyHref, null, "no switch link for viewers who cannot toggle it");
  assert.match(
    data.cycleDialog.refusal.message,
    /ask your administrator/,
    "the message names the person to ask instead",
  );
});

test("permission refusal wins over feature-off: the switch cannot help without the grant", async () => {
  features({ payroll: false });
  const data = await loadCompensationHome(READER, { cycle: "new" });
  assert.match(
    data?.cycleDialog?.refusal?.message ?? "",
    /hrm\.compensation\.manage/,
    "the grant is named first",
  );
  assert.equal(data?.cycleDialog?.remedyHref, null, "no switch link beside a grant refusal");
});

test("no dialog params means no dialog state", async () => {
  features({ payroll: true });
  const data = await loadCompensationHome(MANAGER, {});
  assert.equal(data?.planOpen, false, "plan stays shut");
  assert.equal(data?.cycleOpen, false, "cycle stays shut");
  assert.equal(data?.planDialog, null, "no plan payload");
  assert.equal(data?.cycleDialog, null, "no cycle payload");
});

test("equity ?generate=1 resolves the snapshot dialog, or its named refusal", async () => {
  features({});
  const open = await loadEquity(MANAGER, { generate: "1" });
  assert.equal(open?.generateOpen, true, "?generate=1 opens the dialog");
  assert.ok(open?.generateDialog, "the dialog resolves instead of nothing");
  assert.equal(open.generateDialog.open, true, "the widget's open state is set");
  assert.equal(open.generateDialog.closeHref, "/hrm/compensation/equity", "closing navigates the param away");
  assert.equal(open.generateDialog.groupALabel, "Group A", "the group labels resolve, never key paths");
  assert.equal(open.generateDialog.groupBLabel, "Group B", "the group labels resolve, never key paths");
  assert.equal(open.generateDialog.refusal, null, "managers get the form");

  const refused = await loadEquity(READER, { generate: "1" });
  assert.equal(refused?.generateOpen, true, "the dialog still opens for readers");
  assert.match(
    refused?.generateDialog?.refusal?.message ?? "",
    /hrm\.compensation\.manage/,
    "the missing grant is named",
  );

  const shut = await loadEquity(MANAGER, {});
  assert.equal(shut?.generateOpen, false, "no param, no dialog");
  assert.equal(shut?.generateDialog, null, "no payload either");
});

interface SpecBlock {
  widget?: string;
  when?: unknown;
}

function widgetBlocks(spec: unknown, name: string): SpecBlock[] {
  const body = (spec as { body: SpecBlock[] }).body;
  return body.filter((block) => block.widget === name);
}

test("both specs emit the dialog widgets gated on the loader-derived open state", async () => {
  features({ payroll: true });
  const { compensationSpec } = await import("./view.ts");
  const { equitySpec } = await import("./equity/view.ts");
  // The open state lives in the loader data (proven above); the spec carries
  // the widget with a `when` gate on that flag — ModuleView resolves the
  // field refs at render, so the assertion is on the gate, not on prose.
  const home = await loadCompensationHome(MANAGER, { plan: "new", cycle: "new" });
  assert.equal(home?.cycleOpen, true, "the loader reports the cycle dialog open");
  assert.equal(home?.planOpen, true, "the loader reports the plan dialog open");
  assert.equal(home?.cycleDialog?.open, true, "the cycle payload carries its open state");
  assert.equal(home?.planDialog?.open, true, "the plan payload carries its open state");
  const homeSpec = compensationSpec(home!);
  assert.deepEqual(widgetBlocks(homeSpec, "hrm-comp-cycle-dialog").map((b) => b.when), [{ $: "cycleOpen" }], "the cycle widget renders once, gated on its open state");
  assert.deepEqual(widgetBlocks(homeSpec, "hrm-comp-plan-dialog").map((b) => b.when), [{ $: "planOpen" }], "the plan widget renders once, gated on its open state");

  const shut = await loadCompensationHome(MANAGER, {});
  assert.equal(shut?.cycleOpen, false, "no param, no open state");
  assert.equal(shut?.planOpen, false, "no param, no open state");
  assert.equal(shut?.cycleDialog, null, "no payload either");
  assert.equal(shut?.planDialog, null, "no payload either");

  const equity = await loadEquity(MANAGER, { generate: "1" });
  assert.equal(equity?.generateOpen, true, "the loader reports the generate dialog open");
  const equitySpecOut = equitySpec(equity!);
  assert.deepEqual(
    widgetBlocks(equitySpecOut, "hrm-comp-equity-dialog").map((b) => b.when),
    [{ $: "generateOpen" }],
    "the equity widget renders once, gated on its open state",
  );
});

function tableHeaders(spec: unknown): unknown[][] {
  const found: unknown[][] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (node !== null && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (record.kind === "table" && Array.isArray(record.columns)) {
        found.push((record.columns as { header: unknown }[]).map((column) => column.header));
      }
      for (const value of Object.values(record)) visit(value);
    }
  };
  visit((spec as { body: unknown }).body);
  return found;
}

function assertProse(value: unknown, label: string) {
  assert.equal(typeof value, "string", `${label} resolves to a string, never a key path`);
  assert.ok(!(value as string).includes("."), `${label} resolves to prose, never a key path`);
}

test("home tables head their columns from the resolved catalog, never literals", async () => {
  features({ payroll: true });
  const data = await loadCompensationHome(MANAGER, {});
  assert.ok(data, "the home loader still resolves");
  const { CompensationCycleRegister, CompensationPlanRegister } = await import("./CompensationRegisters.tsx");
  const cycle = await CompensationCycleRegister({ data });
  const plan = await CompensationPlanRegister({ data });
  assert.deepEqual(
    cycle.props.columns.map((column: { header: string }) => column.header),
    ["Name", "Kind", "Status", "Effective"],
    "the native cycle register uses translated headers",
  );
  assert.deepEqual(
    plan.props.columns.map((column: { header: string }) => column.header),
    ["Name", "Planning period", "Status", "Cost"],
    "the native plan register uses translated headers",
  );
});

for (const [name, load, loadedMessage, header, loadSpec, expected, specMessage] of [
  [
    "the team grid heads its seven columns from the resolved catalog, never literals",
    () => loadCompCycleDetail(MANAGER, "cycle-1", {}),
    "the cycle detail loader resolves the canned round",
    ["employee", "Employee", "the employee header resolves from the en catalog"],
    async () => (await import("./cycles/[id]/view.ts")).compCycleSpec,
    [
      [
        { $: "columns.employee" },
        { $: "columns.current" },
        { $: "columns.placement" },
        { $: "columns.rating" },
        { $: "columns.guideline" },
        { $: "columns.proposed" },
        { $: "columns.status" },
      ],
    ],
    "the team grid heads all seven columns from the loader-resolved fields",
  ],
  [
    "the plan lines head their seven columns from the resolved catalog, never literals",
    () => loadHeadcountPlanDetail(MANAGER, "plan-1"),
    "the plan detail loader resolves the canned plan",
    ["title", "Title", "the title header resolves from the en catalog"],
    async () => (await import("./plans/[id]/view.ts")).compPlanSpec,
    [
      [
        { $: "columns.title" },
        { $: "columns.kind" },
        { $: "columns.fte" },
        { $: "columns.start" },
        { $: "columns.cost" },
        { $: "columns.status" },
        { $: "columns.action" },
      ],
    ],
    "the plan lines head all seven columns from the loader-resolved fields",
  ],
] as Array<
  [
    string,
    () => Promise<{ columns: Record<string, string> } | null>,
    string,
    [string, string, string],
    () => Promise<(data: never) => unknown>,
    unknown,
    string,
  ]
>) {
  test(name, async () => {
    features({ payroll: true });
    fixture.detail = true;
    try {
      const data = await load();
      assert.ok(data, loadedMessage);
      for (const [key, value] of Object.entries(data.columns)) assertProse(value, `columns.${key}`);
      assert.equal(data.columns[header[0]], header[1], header[2]);
      const spec = await loadSpec();
      assert.deepEqual(tableHeaders(spec(data as never)), expected, specMessage);
    } finally {
      fixture.detail = false;
    }
  });
}

test("the line drawer arms only the actions the transition table allows", () => {
  // Propose while the round is live and the line is undecided;
  // decide while the round is live or approved and the line is proposed.
  // Anything else hides the forms — the engine refuses them anyway.
  const cases: Array<[string, string | null, boolean, boolean]> = [
    ["open", "pending", true, false],
    ["open", "proposed", true, true],
    ["in_review", "proposed", true, true],
    ["approved", "proposed", false, true],
    ["approved", "approved", false, false],
    ["pushed", "proposed", false, false],
    ["pushed", "pushed", false, false],
    ["closed", "approved", false, false],
    ["cancelled", "pending", false, false],
    ["open", null, false, false],
  ];
  for (const [cycle, line, canPropose, canDecideLine] of cases) {
    assert.deepEqual(
      lineActionAvailability(cycle, line),
      { canPropose, canDecideLine },
      `${cycle}/${line ?? "none"} arms exactly its actions`,
    );
  }
});
