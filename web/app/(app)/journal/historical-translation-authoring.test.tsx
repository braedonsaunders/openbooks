import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";
import type { HistoricalTranslationAuthoringContext } from "@openbooks/engine/journal/historical-translation-evidence";

await bootJsdomEnvironment({ url: "http://localhost/journal", event: "jsdom" });
const state = { fileId: randomUUID(), versionId: randomUUID(), hash: "a".repeat(64) };
(
  globalThis as typeof globalThis & { historicalAuthoringFixture?: typeof state }
).historicalAuthoringFixture = state;
stubModules({
  extra: {
    "next-intl": `const t=(key)=>key; export function useTranslations(){return t}; export function useLocale(){return 'en'}`,
    "next/link": `const React=globalThis.React; export default function Link({href,children}){return React.createElement('a',{href},children)}`,
    "@/lib/confirm": `export async function confirmDialog(){return true}`,
    "./cabinet-file-picker": `const React=globalThis.React; export function CabinetFilePicker({onChange,disabled}){return React.createElement('button',{disabled,onClick:()=>onChange(globalThis.historicalAuthoringFixture.fileId)},'chooseCabinetFile')}`,
    "@openbooks/ui": `const React=globalThis.React;
    export function Input(p){return React.createElement('input',p)}
    export function Popover({trigger}){return trigger}
    export function cn(...classes){return classes.filter(Boolean).join(' ')}
    export function Label(p){return React.createElement('label',p)}
    export function Skeleton(){return React.createElement('div')}
    export function Badge({children}){return React.createElement('span',null,children)}
    export function Button({children,asChild,variant,size,...p}){return asChild?children:React.createElement('button',p,children)}
    export function SearchSelect({value,onChange,options,ariaLabel,disabled}){return React.createElement('select',{'aria-label':ariaLabel,value,disabled,onChange:e=>onChange(e.target.value)},React.createElement('option',{value:''},''),...options.map(o=>React.createElement('option',{key:o.value,value:o.value},o.label)))}
  `,
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { HistoricalTranslationPanel } = await import("./HistoricalTranslationPanel");

function context(): HistoricalTranslationAuthoringContext {
  return {
    source: {
      orgId: randomUUID(),
      lineId: randomUUID(),
      entryId: randomUUID(),
      bookId: randomUUID(),
      accountId: randomUUID(),
      subsidiaryId: randomUUID(),
      amount: "-100.0000",
      transactionCurrency: "EUR",
      transactionAmount: "-70.0000",
      transactionRate: "1.4285714286",
      postingDate: "2024-12-31",
      origin: "manual",
      reversesEntryId: null,
    },
    currencies: ["CAD", "USD", "EUR"],
    certificates: [],
    proposals: [],
    originalLayers: [],
  };
}
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((row) => row.textContent === text)!;
async function choose(host: HTMLElement, label: string, value: string) {
  await act(async () => {
    const select = host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
async function input(host: HTMLElement, prefix: string, value: string) {
  await act(async () => {
    const field = host.querySelector(`input[id^="${prefix}"]`) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      field,
      value,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function mount(t: TestContext, data: HistoricalTranslationAuthoringContext) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let dirty = false;
  await act(async () =>
    root.render(
      <HistoricalTranslationPanel
        sources={[{ id: data.source.lineId, label: "Physical equity source" }]}
        onDirtyChange={(value) => {
          dirty = value;
        }}
      />,
    ),
  );
  await settle();
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, dirty: () => dirty };
}

test("historical authoring refuses a response naming a different physical source", async (t) => {
  const data = context(),
    previous = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ ...data, source: { ...data.source, lineId: randomUUID() } });
  t.after(() => {
    globalThis.fetch = previous;
  });
  const { host } = await mount(t, data);
  assert.match(host.textContent ?? "", /loadFailed/);
  assert.equal(host.querySelector("input"), null);
});

test("failed historical proposal keeps documentary drafts and request identity without approving or applying", async (t) => {
  const data = context(),
    previous = globalThis.fetch,
    requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (request, init) => {
    const url = String(request);
    if (init?.method === "POST") {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json(
        { error: "Retained source changed; select its exact version." },
        { status: 422 },
      );
    }
    if (url.includes("/file-cabinet/"))
      return Response.json({
        file: {
          id: state.fileId,
          name: "Original contribution",
          versions: [{ id: state.versionId, versionNumber: 2, contentHash: state.hash }],
        },
      });
    return Response.json(data);
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  const mounted = await mount(t, data),
    host = mounted.host;
  assert.equal(
    (host.querySelector('select[aria-label="measurementCurrency"]') as HTMLSelectElement).value,
    "",
  );
  assert.equal((host.querySelector('input[id^="historical-rate-"]') as HTMLInputElement).value, "");
  await choose(host, "measurementCurrency", "USD");
  await choose(host, "presentationCurrency", "CAD");
  await input(host, "historical-rate-", "1.125");
  await input(host, "historical-date-", "2024-02-29");
  await input(host, "historical-provenance-", "Original contribution statement");
  await input(host, "historical-reason-", "Document the original contribution");
  await act(async () => button(host, "chooseCabinetFile").click());
  await settle();
  assert.equal(
    (host.querySelector('select[aria-label="sourceVersion"]') as HTMLSelectElement).value,
    "",
  );
  assert.equal(button(host, "propose").disabled, true);
  await choose(host, "sourceVersion", state.versionId);
  assert.equal(button(host, "propose").disabled, false);
  await act(async () => button(host, "propose").click());
  await settle();
  assert.match(host.textContent ?? "", /Retained source changed/);
  assert.equal(mounted.dirty(), true);
  assert.equal(
    (host.querySelector('input[id^="historical-rate-"]') as HTMLInputElement).value,
    "1.125",
  );
  await act(async () => button(host, "propose").click());
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.body.idempotencyKey, requests[1]!.body.idempotencyKey);
  assert.ok(requests.every((row) => row.url === "/api/journals/historical-translation"));
  const instruction = requests[0]!.body.instruction as {
    sourceLineId: string;
    layers: Array<{ source: unknown }>;
  };
  assert.equal(instruction.sourceLineId, data.source.lineId);
  assert.deepEqual(instruction.layers[0]!.source, {
    fileId: state.fileId,
    versionId: state.versionId,
    contentHash: state.hash,
  });
});

test("historical retained-version picker refuses a stale Cabinet response", async (t) => {
  const data = context(),
    previous = globalThis.fetch;
  globalThis.fetch = async (request) =>
    String(request).includes("/file-cabinet/")
      ? Response.json({
          file: {
            id: randomUUID(),
            name: "Wrong source",
            versions: [{ id: state.versionId, versionNumber: 1, contentHash: state.hash }],
          },
        })
      : Response.json(data);
  t.after(() => {
    globalThis.fetch = previous;
  });
  const { host } = await mount(t, data);
  await act(async () => button(host, "chooseCabinetFile").click());
  await settle();
  assert.match(host.textContent ?? "", /sourceFailed/);
  assert.equal(
    (host.querySelector('select[aria-label="sourceVersion"]') as HTMLSelectElement).disabled,
    true,
  );
  assert.equal(button(host, "propose").disabled, true);
});

test("historical review is an ordinary Accounting event and application requires an explicit approved action", async (t) => {
  const data = context(),
    previous = globalThis.fetch,
    changeId = randomUUID(),
    basisId = randomUUID(),
    appliedCalls: string[] = [];
  const layer = {
    amount: data.source.amount,
    rate: "1.1250000000",
    historicalDate: "2024-02-29",
    provenance: "Original contribution statement",
    source: { fileId: state.fileId, versionId: state.versionId, contentHash: state.hash },
    originalLayerId: null,
  };
  const evidence = {
    instruction: {
      sourceLineId: data.source.lineId,
      measurementCurrency: "USD",
      presentationCurrency: "CAD",
      kind: "contribution" as const,
      layers: [layer],
    },
    sourceFingerprint: data.source,
    retainedSources: [{ ...layer.source, versionNumber: 2 }],
    translatedAmounts: ["-112.50000000000000"],
    originalLayerStates: [],
  };
  let status = "pending",
    applied = false;
  globalThis.fetch = async (request, init) => {
    if (init?.method === "POST") {
      appliedCalls.push(String(request));
      applied = true;
      return Response.json({ basisId });
    }
    return Response.json({
      ...data,
      proposals: [{ changeId, status, reason: "Document original contribution", evidence }],
      certificates: applied
        ? [
            {
              basisId,
              changeId,
              evidence,
              evidenceHash: "b".repeat(64),
              layers: [
                {
                  ...layer,
                  id: randomUUID(),
                  versionNumber: 2,
                  translatedAmount: evidence.translatedAmounts[0],
                },
              ],
              translatedAmount: evidence.translatedAmounts[0],
            },
          ]
        : [],
    });
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  const { host } = await mount(t, data);
  await choose(host, "assessment", `proposal:${changeId}`);
  assert.equal(
    host.querySelector("a")?.getAttribute("href"),
    `/accounting/changes?change=${changeId}`,
  );
  assert.equal(button(host, "apply"), undefined);
  assert.deepEqual(appliedCalls, []);
  status = "approved";
  await act(async () => button(host, "refresh").click());
  await settle();
  assert.ok(button(host, "apply"));
  assert.deepEqual(appliedCalls, []);
  await act(async () => button(host, "apply").click());
  await settle();
  assert.deepEqual(appliedCalls, [`/api/journals/historical-translation/${changeId}/apply`]);
  assert.match(host.textContent ?? "", /statuses.applied/);
  assert.match(host.textContent ?? "", new RegExp(state.hash));
});

test("a reversal of an applied correction binds its immediate parent and retains locked documentary evidence", async (t) => {
  const data = context(),
    previous = globalThis.fetch,
    parentEntryId = randomUUID(),
    parentLayerId = randomUUID();
  data.source.reversesEntryId = parentEntryId;
  const parent = {
    id: parentLayerId,
    amount: "100.0000",
    rate: "1.1250000000",
    historicalDate: "2024-02-29",
    provenance: "Original contribution statement",
    source: { fileId: state.fileId, versionId: state.versionId, contentHash: state.hash },
    originalLayerId: randomUUID(),
    versionNumber: 2,
    translatedAmount: "112.50000000000000",
    sourceLineId: randomUUID(),
    entryId: parentEntryId,
    measurementCurrency: "USD",
    presentationCurrency: "CAD",
    remainingAmount: "100.0000",
  };
  data.originalLayers = [parent, { ...parent, id: randomUUID(), entryId: randomUUID() }];
  let submitted: Record<string, unknown> | undefined;
  globalThis.fetch = async (_request, init) => {
    if (init?.method === "POST") {
      submitted = JSON.parse(String(init.body));
      return Response.json({ error: "Preserve the source assessment draft." }, { status: 422 });
    }
    return Response.json(data);
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  const { host } = await mount(t, data);
  assert.equal(
    (host.querySelector('select[aria-label="kind"]') as HTMLSelectElement).value,
    "correction",
  );
  await choose(host, "measurementCurrency", "USD");
  await choose(host, "presentationCurrency", "CAD");
  const selector = host.querySelector('select[aria-label="originalLayer"]') as HTMLSelectElement;
  assert.deepEqual([...selector.options].map((option) => option.value).filter(Boolean), [
    parentLayerId,
  ]);
  await choose(host, "originalLayer", parentLayerId);
  for (const prefix of ["historical-rate-", "historical-date-", "historical-provenance-"])
    assert.equal((host.querySelector(`input[id^="${prefix}"]`) as HTMLInputElement).readOnly, true);
  assert.equal(button(host, "chooseCabinetFile"), undefined);
  await input(host, "historical-amount-", "-100");
  await input(host, "historical-reason-", "Restore the corrected contribution");
  assert.equal(button(host, "propose").disabled, false);
  await act(async () => button(host, "propose").click());
  await settle();
  assert.ok(submitted);
  const instruction = submitted.instruction as {
    kind: string;
    layers: Array<Record<string, unknown>>;
  };
  assert.equal(instruction.kind, "correction");
  assert.equal(instruction.layers[0]!.originalLayerId, parentLayerId);
  assert.equal(instruction.layers[0]!.rate, parent.rate);
  assert.equal(instruction.layers[0]!.historicalDate, parent.historicalDate);
  assert.equal(instruction.layers[0]!.provenance, parent.provenance);
  assert.deepEqual(instruction.layers[0]!.source, parent.source);
});
