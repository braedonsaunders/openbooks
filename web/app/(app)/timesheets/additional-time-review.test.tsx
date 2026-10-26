import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { isUuid } from "@openbooks/engine/platform/identifiers";
import type { ComponentProps } from "react";
import { readFile } from "node:fs/promises";

const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost/timesheets", matchMediaMatches: false });
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = Object.fromEntries(
  await Promise.all(
    ["common", "ui", "timesheets"].map(async (name) => [
      name,
      JSON.parse(
        await readFile(new URL(`../../../messages/en/${name}.json`, import.meta.url), "utf8"),
      ),
    ]),
  ),
);
const { AdditionalTimeReview } = await import("./AdditionalTimeReview");
type Props = ComponentProps<typeof AdditionalTimeReview>;
const pickers: Props["pickers"] = {
  employees: [],
  projects: [{ value: "project", label: "Service project" }],
  internalProjectIds: [],
  items: [{ value: "labor", label: "Service labor" }],
  timeTypes: [],
  departments: [],
};
const revision = "2026-04-12T10:00:00.000000Z";
const rows: Props["entries"] = [
  {
    id: "reviewed",
    updatedAt: revision,
    workedOn: "2026-04-06",
    hours: "1.5000",
    status: "draft",
    projectId: "project",
    itemId: "labor",
    fieldTicketId: "ticket1",
    fieldTicketNumber: "FT-101",
    fieldTicketStatus: "approved",
  },
  {
    id: "unreviewed",
    updatedAt: revision,
    workedOn: "2026-04-07",
    hours: "2.0000",
    status: "draft",
    projectId: "project",
    itemId: "labor",
    fieldTicketId: "ticket2",
    fieldTicketNumber: "FT-102",
    fieldTicketStatus: "draft",
  },
];

async function mount(t: TestContext, options: Partial<Props> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const submitted: { selections: Parameters<Props["onSubmit"]>[0]; reason: string }[] = [];
  let props: Props = {
    entries: rows,
    pickers,
    busy: false,
    refusal: null,
    onBack() {},
    async onSubmit(selections, reason) {
      submitted.push({ selections, reason });
    },
    ...options,
  };
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const render = async (change: Partial<Props> = {}) => {
    props = { ...props, ...change };
    await act(async () =>
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <AdditionalTimeReview {...props} />
        </NextIntlClientProvider>,
      ),
    );
  };
  await render();
  return { host, submitted, render };
}

function submitButton(host: HTMLElement) {
  const button = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Submit"),
  );
  assert.ok(Boolean(button), "the selective submission action is present");
  return button!;
}
async function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    input.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

test("search selection submits reviewed source time and leaves unrelated draft sources unselected", async (t) => {
  const f = await mount(t);
  assert.equal(submitButton(f.host).disabled, true, "nothing is selected by default");
  await setValue(f.host.querySelector<HTMLInputElement>('input[aria-label="Search"]')!, "Approved");
  const boxes = f.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  assert.equal(boxes.length, 2, "the filtered source has one row and its select-all control");
  await act(async () => boxes[0]!.click());
  await setValue(
    f.host.querySelector("textarea")!,
    "Submit the independently reviewed service time",
  );
  await act(async () => submitButton(f.host).click());
  assert.deepEqual(f.submitted, [
    {
      selections: [{ id: "reviewed", updatedAt: revision }],
      reason: "Submit the independently reviewed service time",
    },
  ]);
});

test("a refreshed entry must be reviewed again while a refused submission retains the reason and choice", async (t) => {
  const f = await mount(t);
  await act(async () =>
    f.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click(),
  );
  await setValue(f.host.querySelector("textarea")!, "Reviewed after the service ticket approval");
  await f.render({
    refusal: {
      message: "The approval workflow could not start.",
      remedy: "Correct its approver configuration.",
    },
  });
  assert.equal(
    f.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.checked,
    true,
  );
  assert.equal(
    f.host.querySelector("textarea")!.value,
    "Reviewed after the service ticket approval",
  );
  assert.match(f.host.querySelector('[role="alert"]')?.textContent ?? "", /approver configuration/);
  const newer = "2026-04-12T11:00:00.000000Z";
  await f.render({
    entries: rows.map((row) =>
      row.id === "reviewed" ? { ...row, updatedAt: newer, hours: "2.5000" } : row,
    ),
  });
  assert.equal(submitButton(f.host).disabled, true, "a changed revision is not silently selected");
  await act(async () =>
    f.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click(),
  );
  await f.render({ busy: true });
  assert.equal(submitButton(f.host).disabled, true);
  assert.equal(f.host.querySelector("textarea")!.disabled, true);
  await f.render({ busy: false, refusal: null });
  await act(async () => submitButton(f.host).click());
  assert.deepEqual(f.submitted[0]?.selections, [{ id: "reviewed", updatedAt: newer }]);
});

test("returned ticket time uses one scoped correction body and keeps reviewed identities through a refusal", async (t) => {
  const corrected: unknown[][] = [];
  const f = await mount(t, {
    canSubmit: false,
    entries: rows.map((row) => ({ ...row, timeTypeId: "regular" })),
    pickers: {
      ...pickers,
      timeTypes: [
        {
          value: "regular",
          label: "Regular",
          classification: "regular",
          isDefault: true,
          isBillableDefault: true,
          costMultiplier: "1.0000",
          billMultiplier: "1.0000",
          excludeFromWages: false,
          updatedAt: revision,
        },
        {
          value: "overtime",
          label: "Overtime",
          classification: "overtime",
          isDefault: false,
          isBillableDefault: true,
          costMultiplier: "1.5000",
          billMultiplier: "1.0000",
          excludeFromWages: false,
          updatedAt: revision,
        },
      ],
    },
    async onCorrect(...args) {
      corrected.push(args);
      return false;
    },
  });
  assert.equal(f.host.querySelectorAll('input[type="checkbox"]').length, 0);
  const actions = [...f.host.querySelectorAll("button")].filter(
    (button) => button.textContent === "Correct type",
  );
  assert.equal(actions.length, 1, "draft source tickets are corrected on their own crew grid");
  await act(async () => actions[0]!.click());
  assert.equal(
    f.host.querySelectorAll("table").length,
    0,
    "the selected entry replaces the review table",
  );
  assert.equal(
    f.host.querySelectorAll('[role="dialog"]').length,
    0,
    "the caller owns the existing drawer shell",
  );
  const select = f.host.querySelector("select")!;
  await act(async () => {
    select.value = "overtime";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  assert.match(
    f.host.textContent ?? "",
    /Cost multiplier: 1.5000; default billing multiplier: 1.0000/,
  );
  await setValue(
    f.host.querySelector("textarea")!,
    "Apply the independently reviewed worked-time classification",
  );
  const save = [...f.host.querySelectorAll("button")].find(
    (button) => button.textContent === "Save correction",
  )!;
  await act(async () => save.click());
  await f.render({
    refusal: { message: "The reviewed time entry changed.", remedy: "Reload the week." },
  });
  assert.equal(corrected.length, 1);
  assert.equal((corrected[0]![0] as Props["entries"][number]).id, "reviewed");
  assert.equal(corrected[0]![1], "overtime");
  assert.equal(corrected[0]![2], revision);
  assert.equal(isUuid(corrected[0]![3]), true);
  assert.equal(
    f.host.querySelector("textarea")!.value,
    "Apply the independently reviewed worked-time classification",
  );
  assert.match(f.host.querySelector('[role="alert"]')?.textContent ?? "", /Reload the week/);
  await act(async () => save.click());
  assert.equal(
    corrected[1]![3],
    corrected[0]![3],
    "a refused retry keeps the native command identity",
  );
  await f.render({ busy: true });
  assert.equal(f.host.querySelector("select")!.disabled, true);
  assert.equal(f.host.querySelector("textarea")!.disabled, true);
});

test("a changed correction revision requires review again and does not silently move selection", async (t) => {
  const f = await mount(t, {
    canSubmit: false,
    async onCorrect() {
      throw new Error("Stale time must not be sent");
    },
  });
  const action = [...f.host.querySelectorAll("button")].find(
    (button) => button.textContent === "Correct type",
  )!;
  await act(async () => action.click());
  await f.render({
    entries: rows.map((row) => ({ ...row, updatedAt: "2026-04-12T12:00:00.000000Z" })),
  });
  assert.equal(f.host.querySelector("select")!.disabled, true);
  assert.match(
    f.host.querySelector('[role="alert"]')?.textContent ?? "",
    /review its current revision/,
  );
});

test("time correction shows the declared class when a name and premium multiplier suggest another class", async (t) => {
  const f = await mount(t, {
    canSubmit: false,
    entries: rows.map((row) => ({ ...row, timeTypeId: "regular" })),
    pickers: {
      ...pickers,
      timeTypes: [
        {
          value: "regular",
          label: "Regular",
          classification: "regular",
          isDefault: true,
          isBillableDefault: true,
          costMultiplier: "1.0000",
          billMultiplier: "1.0000",
          excludeFromWages: false,
          updatedAt: revision,
        },
        {
          value: "premium",
          label: "Overtime",
          classification: "regular",
          isDefault: false,
          isBillableDefault: true,
          costMultiplier: "1.5000",
          billMultiplier: "1.5000",
          excludeFromWages: false,
          updatedAt: revision,
        },
      ],
    },
    async onCorrect() {
      return false;
    },
  });
  const action = [...f.host.querySelectorAll("button")].find(
    (button) => button.textContent === "Correct type",
  )!;
  await act(async () => action.click());
  const select = f.host.querySelector("select")!;
  assert.equal(
    [...select.options].find((option) => option.value === "premium")?.textContent,
    "Overtime · Regular",
  );
  await act(async () => {
    select.value = "premium";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  assert.equal((f.host.textContent ?? "").includes("Declared classification: Regular"), true);
  assert.equal((f.host.textContent ?? "").includes("Declared classification: Overtime"), false);
  assert.match(
    f.host.textContent ?? "",
    /Cost multiplier: 1.5000; default billing multiplier: 1.5000/,
  );
});
