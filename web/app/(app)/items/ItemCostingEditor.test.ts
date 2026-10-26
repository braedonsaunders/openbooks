import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ReactNode } from "react";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

await bootJsdomEnvironment({ url: "http://localhost/items/item-1" });

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next-intl": "export function useTranslations() { return (key) => key }",
    sonner: "export const toast = { success() {}, error() {} }",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

// the costing form must refuse — inline, before any submit — an
// account combination the PUT route is known to reject with 422 (any offset
// account equal to the inventory asset account). A transient toast after a
// failed save is not a substitute for inline validation.
const { ItemCostingEditor, costingOffsetConflicts, validateConversionRows } =
  await import("./ItemCostingEditor.tsx");
const { RecordSaveContext, useRecordSaveRegistry } =
  await import("../../../components/record-save-participants");

let recordSave: ReturnType<typeof useRecordSaveRegistry> | null = null;
/** The item drawer's side of the contract: one registry, one Save. */
function RecordHost({ children }: { children?: ReactNode }) {
  const registry = useRecordSaveRegistry(true);
  React.useLayoutEffect(() => {
    recordSave = registry;
  }, [registry]);
  return React.createElement(RecordSaveContext.Provider, { value: registry.context }, children);
}

/** The item drawer's Save: every dirty section saves through the registry. */
async function saveRecord() {
  let result: Awaited<ReturnType<NonNullable<typeof recordSave>["saveAll"]>> | null = null;
  await act(async () => {
    result = await recordSave!.saveAll();
  });
  return result;
}

const ASSET = "11111111-1111-4111-8111-111111111111";
const COGS = "22222222-2222-4222-8222-222222222222";
const ADJUST = "33333333-3333-4333-8333-333333333333";
const VARIANCE = "44444444-4444-4444-8444-444444444444";
const GRNI = "55555555-5555-4555-8555-555555555555";

function valid() {
  return {
    assetAccountId: ASSET,
    cogsAccountId: COGS,
    adjustmentAccountId: ADJUST,
    varianceAccountId: VARIANCE,
    receivedNotBilledAccountId: GRNI,
  };
}

for (const [name, selection] of [
  ["a valid account combination reports no conflicts", valid()],
  [
    "an empty optional offset is not a conflict",
    { ...valid(), adjustmentAccountId: "", varianceAccountId: "", receivedNotBilledAccountId: "" },
  ],
] as Array<[string, Parameters<typeof costingOffsetConflicts>[0]]>) {
  test(name, () => {
    assert.deepEqual(costingOffsetConflicts(selection), []);
  });
}

for (const [name, field] of [
  ["an adjustment account copying the asset account is a conflict", "adjustmentAccountId"],
  ["a variance account copying the COGS-selected asset is a conflict", "varianceAccountId"],
  ["a COGS account equal to the asset account is a conflict", "cogsAccountId"],
  [
    "a received-not-billed account equal to the asset account is a conflict",
    "receivedNotBilledAccountId",
  ],
] as Array<
  [
    string,
    "adjustmentAccountId" | "varianceAccountId" | "cogsAccountId" | "receivedNotBilledAccountId",
  ]
>) {
  test(name, () => {
    assert.deepEqual(costingOffsetConflicts({ ...valid(), [field]: ASSET }), [field]);
  });
}

test("the comparison matches the server rule regardless of id casing", () => {
  assert.deepEqual(
    costingOffsetConflicts({ ...valid(), adjustmentAccountId: ASSET.toUpperCase() }),
    ["adjustmentAccountId"],
  );
});

// Unit conversions: the form mirrors the server's parseUnitConversions rule
// inline, so a row the PUT would answer 422 never submits.

test("well-formed conversion rows validate clean", () => {
  assert.deepEqual(validateConversionRows([{ unit: "box", factor: "12" }]), []);
  assert.deepEqual(
    validateConversionRows([
      { unit: "Each", factor: "1" },
      { unit: "kg", factor: "2.5" },
    ]),
    [],
  );
  assert.deepEqual(validateConversionRows([]), []);
});

test("a blank unit name is refused", () => {
  assert.deepEqual(validateConversionRows([{ unit: "   ", factor: "12" }]), [
    { index: 0, field: "unit", code: "required" },
  ]);
});

test("a non-positive or inexact factor is refused", () => {
  for (const factor of ["", "0", "-12", "abc", "1/3", "0.00001", "Infinity"]) {
    assert.deepEqual(
      validateConversionRows([{ unit: "box", factor }]),
      [{ index: 0, field: "factor", code: "invalid" }],
      `factor ${JSON.stringify(factor)} must be refused`,
    );
  }
});

test("factors the server receives as exact decimals are accepted", () => {
  // ".5" and "12." arrive as the JSON numbers 0.5 and 12 — both exactly
  // representable, so the form must not refuse what the server accepts.
  assert.deepEqual(validateConversionRows([{ unit: "half", factor: ".5" }]), []);
  assert.deepEqual(validateConversionRows([{ unit: "dozen", factor: "12." }]), []);
});

test("a repeated unit under any spelling is refused", () => {
  assert.deepEqual(
    validateConversionRows([
      { unit: "box", factor: "12" },
      { unit: "BOX", factor: "12" },
    ]),
    [{ index: 1, field: "unit", code: "duplicate" }],
  );
});

async function mountEditor(
  t: TestContext,
  accounts: { id: string; number: string; name: string }[] = [],
  options: {
    profile?: Record<string, unknown> | null;
    onRequestEdit?: () => void;
    canManage?: boolean;
  } = {},
) {
  const priorFetch = globalThis.fetch;
  const requests: Array<{ method: string; body?: Record<string, unknown> }> = [];
  const stored = options.profile === undefined ? null : options.profile;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({
      method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
    });
    if (method === "GET")
      return Response.json({ profile: stored, companyReceivedNotBilledAccountId: null });
    return Response.json({ ok: true, updatedAt: "rev-2" });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = priorFetch;
  });
  const root = createRoot(document.body);
  t.after(async () => {
    await act(async () => root.unmount());
    for (const node of [...document.body.children]) node.remove();
  });
  await act(async () => {
    root.render(
      React.createElement(
        RecordHost,
        null,
        React.createElement(ItemCostingEditor, {
          itemId: "item-1",
          kind: "inventory",
          accounts,
          canManage: options.canManage ?? true,
          onRequestEdit: options.onRequestEdit,
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return requests;
}

async function mountEditingEditor(
  t: TestContext,
  accounts: { id: string; number: string; name: string }[] = [],
  options: { profile?: Record<string, unknown> | null; onRequestEdit?: () => void } = {},
) {
  const requests = await mountEditor(t, accounts, options);
  assert.ok(
    document.querySelector('button[aria-haspopup="listbox"]'),
    "item edit mode opens the costing fields directly",
  );
  assert.equal(
    [...document.querySelectorAll("button")].some((button) =>
      ["actions.save", "actions.edit", "configure"].includes(button.textContent?.trim() ?? ""),
    ),
    false,
    "the costing section carries no Edit or Save of its own",
  );
  return requests;
}

async function chooseAccount(label: string) {
  const trigger = [...document.querySelectorAll('button[aria-haspopup="listbox"]')].find(
    (button) => button.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;
  assert.ok(trigger, `${label} picker renders`);
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll('button[role="option"]')].find((button) =>
    button.textContent?.includes("100 Stock asset"),
  ) as HTMLButtonElement | undefined;
  assert.ok(option, "the inventory asset account is selectable");
  await act(async () => option.click());
}

test("an offset equal to the asset account shows an inline refusal without submitting", async (t) => {
  const requests = await mountEditingEditor(t, [{ id: ASSET, number: "100", name: "Stock asset" }]);
  await chooseAccount("assetAccount");
  await chooseAccount("cogsAccount");
  assert.equal(recordSave?.dirty, true, "the edited profile marks the item dirty");
  assert.deepEqual(
    await saveRecord(),
    { ok: false, key: "costing" },
    "the item Save stops on the refused section",
  );
  // Reads (the profile and its shortfall accounts) may load; no write is sent.
  assert.deepEqual(
    requests.filter((request) => request.method !== "GET").map((request) => request.method),
    [],
    "the invalid account pair never reaches the PUT route",
  );
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /separationConflict/);
});

test("a malformed conversion row is refused inline before the costing PUT", async (t) => {
  const requests = await mountEditingEditor(t);
  const add = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "addConversion",
  );
  assert.ok(add, "the conversion editor can add a row");
  await act(async () => add.click());
  const unit = document.querySelector(
    'input[aria-label="conversionUnit"]',
  ) as HTMLInputElement | null;
  const factor = document.querySelector(
    'input[aria-label="conversionFactor"]',
  ) as HTMLInputElement | null;
  assert.ok(unit);
  assert.ok(factor);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(unit, "box");
    unit.dispatchEvent(new window.Event("input", { bubbles: true }));
    setter.call(factor, "0");
    factor.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.deepEqual(await saveRecord(), { ok: false, key: "costing" });
  // Reads (the profile and its shortfall accounts) may load; no write is sent.
  assert.deepEqual(
    requests.filter((request) => request.method !== "GET").map((request) => request.method),
    [],
    "an invalid factor never reaches the PUT route",
  );
  assert.match(
    document.querySelector('[role="alert"]')?.textContent ?? "",
    /conversionFactorInvalid|conversionsBlocked/,
  );
});

test("a conversion row adds, edits, removes, and persists through the costing PUT", async (t) => {
  const requests = await mountEditingEditor(t, [], { profile: storedProfile() });
  const setInput = (element: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  const rowInputs = () => ({
    unit: [...document.querySelectorAll('input[aria-label="conversionUnit"]')].at(
      -1,
    ) as HTMLInputElement,
    factor: [...document.querySelectorAll('input[aria-label="conversionFactor"]')].at(
      -1,
    ) as HTMLInputElement,
  });
  const puts = () => requests.filter((request) => request.method === "PUT");

  await act(async () => {
    (
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "addConversion",
      ) as HTMLButtonElement
    ).click();
  });
  // Add box=12, edit it to 24, add case=6, then remove box: one save
  // carries the add, the edit, and the removal together.
  await act(async () => {
    const { unit, factor } = rowInputs();
    setInput(unit, "box");
    setInput(factor, "12");
  });
  await act(async () => setInput(rowInputs().factor, "24"));
  await act(async () => {
    (
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "addConversion",
      ) as HTMLButtonElement
    ).click();
  });
  await act(async () => {
    const { unit, factor } = rowInputs();
    setInput(unit, "case");
    setInput(factor, "6");
  });
  await act(async () => {
    const removeButtons = [...document.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === "removeConversion",
    );
    assert.equal(removeButtons.length, 2, "both added rows offer remove");
    (removeButtons[0] as HTMLButtonElement).click();
  });
  assert.deepEqual(await saveRecord(), { ok: true }, "the added, edited, and removed rows save");
  assert.deepEqual(
    puts().at(-1)?.body?.unitConversions,
    { case: 6 },
    "the PUT carries the edit and the removal",
  );
});

const NEWCOGS = "66666666-6666-4666-8666-666666666666";

function storedProfile() {
  return {
    abc_class: null,
    updated_at: "rev-1",
    costing_method: "fifo",
    tracking: "none",
    asset_account_id: ASSET,
    cogs_account_id: COGS,
    adjustment_account_id: ADJUST,
    variance_account_id: VARIANCE,
    received_not_billed_account_id: GRNI,
    standard_cost: null,
    base_unit: "ea",
    unit_conversions: {},
    reorder_point: null,
    preferred_stock_level: null,
    allow_negative_inventory: false,
    negative_cost_basis: "last_receipt",
    provisional_unit_cost: null,
  };
}

async function chooseAccountByLabel(label: string, match: string) {
  const trigger = [...document.querySelectorAll('button[aria-haspopup="listbox"]')].find(
    (button) => button.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;
  assert.ok(trigger, `${label} picker renders`);
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll('button[role="option"]')].find((button) =>
    button.textContent?.includes(match),
  ) as HTMLButtonElement | undefined;
  assert.ok(option, `${match} is selectable`);
  await act(async () => option.click());
}

test("the drawer Save persists edited costing accounts through the costing PUT", async (t) => {
  const accounts = [
    { id: ASSET, number: "100", name: "Stock asset" },
    { id: COGS, number: "5000", name: "Old COGS" },
    { id: NEWCOGS, number: "5010", name: "New COGS" },
  ];
  const requests = await mountEditingEditor(
    t,
    accounts.map((a) => ({ id: a.id, number: a.number, name: a.name })),
    { profile: storedProfile() },
  );
  await chooseAccountByLabel("cogsAccount", "New COGS");
  assert.equal(recordSave?.dirty, true, "the edited accounts mark the item dirty");
  assert.deepEqual(await saveRecord(), { ok: true }, "the item Save commits the costing section");
  const puts = requests.filter((request) => request.method === "PUT");
  assert.equal(puts.length, 1, "one PUT carries the whole profile");
  assert.equal(puts[0]?.body?.assetAccountId, ASSET, "the untouched asset account rides along");
  assert.equal(puts[0]?.body?.cogsAccountId, NEWCOGS, "the edited COGS account is persisted");
  assert.equal(puts[0]?.body?.expectedUpdatedAt, "rev-1", "the save fences on the loaded revision");
});

test("an item without a profile offers Configure inventory costing when edit can be requested", async (t) => {
  let requested = 0;
  await mountEditor(t, [], {
    canManage: false,
    onRequestEdit: () => {
      requested += 1;
    },
  });
  const configure = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "configureAction",
  );
  assert.ok(configure, "the empty state names its next step: configuring inventory costing");
  await act(async () => configure.click());
  assert.equal(
    requested,
    1,
    "the action enters the drawer edit mode that reveals the costing form",
  );
});

test("an item without a profile shows no Configure action when edit cannot be requested", async (t) => {
  await mountEditor(t, [], { canManage: false });
  assert.match(
    document.body.textContent ?? "",
    /empty/,
    "the empty state still names the missing profile",
  );
  assert.equal(
    [...document.querySelectorAll("button")].filter(
      (button) => (button.textContent ?? "").trim().length > 0,
    ).length,
    0,
    "a viewer who cannot configure keeps the text alone",
  );
});

test("outside item edit mode the costing profile reads as values with no controls", async (t) => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ profile: null })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = priorFetch;
  });
  const root = createRoot(document.body);
  t.after(async () => {
    await act(async () => root.unmount());
    for (const node of [...document.body.children]) node.remove();
  });
  await act(async () => {
    root.render(
      React.createElement(
        RecordHost,
        null,
        React.createElement(ItemCostingEditor, {
          itemId: "item-1",
          kind: "inventory",
          accounts: [],
          canManage: false,
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(
    document.querySelectorAll('input, select, button[aria-haspopup="listbox"]').length,
    0,
    "view mode renders no editable controls",
  );
  assert.equal(recordSave?.dirty, false);
});
