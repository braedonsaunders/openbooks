import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bootJsdomEnvironment } from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";
import type { readCanadianOpeningReportingSourceContext } from "@openbooks/engine/payroll/canada/opening-reporting-authority";

await bootJsdomEnvironment({ url: "http://localhost:4800/payroll/opening-balances" });
stubModules({
  intl: false,
  extra: {
    "../../../../components/cabinet-file-picker": `export function CabinetFilePicker(p){return globalThis.React.createElement('input',{id:'reporting-source-file',value:p.value,disabled:p.disabled,onChange:e=>p.onChange(e.target.value),'aria-label':p.label})}`,
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { OpeningReportingSourceForm } = await import("./OpeningReportingSourceForm");
type Context = Awaited<ReturnType<typeof readCanadianOpeningReportingSourceContext>>;
type Props = React.ComponentProps<typeof OpeningReportingSourceForm>;
const id = (last: number) => `10000000-0000-4000-8000-${String(last).padStart(12, "0")}`;
const employeePartyId = id(1),
  openingBalanceId = id(2),
  rpId = id(3),
  componentId = id(4);
function source(): Context {
  return {
    original: {
      employeePartyId,
      taxYear: 2026,
      openingBalanceId,
      subsidiaryId: id(5),
      authorityId: id(6),
      employerAuthorityId: id(7),
      sourceFileId: id(8),
      sourceVersionId: id(9),
      sourceSha256: "a".repeat(64),
      sourceReference: "Original levy source",
      openingSha256: "b".repeat(64),
      openingChildrenSha256: "c".repeat(64),
      levyAllocationSha256: "d".repeat(64),
      employerSourceFileId: id(8),
      originalCountry: "CA",
      originalCurrency: "CAD",
      coverageStart: "2026-01-01",
      coverageEnd: "2026-05-31",
      coverageComplete: true,
      annualAmounts: { gross_ytd: "72.0001" },
      children: {
        components: [{ component_id: componentId, ytd_amount: "72.0001" }],
        programBases: [{ program_key: "ei", insurable_ytd: "72.0001" }],
        accountBases: [],
        suiStates: [],
      },
    },
    reporting: null,
    allocations: [],
    filingAccounts: [
      {
        id: rpId,
        orgId: id(10),
        subsidiaryId: id(5),
        country: "CA",
        programType: "ca_rp",
        name: "Original RP",
        accountNumber: "123456789RP0001",
      },
    ],
    selectedSource: {
      id: id(11),
      versionId: id(12),
      sha256: "e".repeat(64),
      name: "Original Canadian reporting register",
    },
  };
}
const props: Props = {
  employeePartyId,
  year: 2026,
  canQualify: true,
  annualDirty: false,
  active: true,
  fields: [{ column: "gross_ytd", label: "Gross pay" }],
  components: [{ componentId, name: "Regular earnings" }],
  programs: [{ key: "ei", label: "EI earnings" }],
  onSaved() {},
  onDirtyChange() {},
  onBusyChange() {},
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function stubFetch(t: TestContext, handler: typeof fetch) {
  const old = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = old;
  });
}
async function mount(t: TestContext, initial = props) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let live = true;
  const render = async (next: Props) =>
    act(async () =>
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <OpeningReportingSourceForm {...next} />
        </NextIntlClientProvider>,
      ),
    );
  const unmount = async () => {
    if (live) {
      live = false;
      await act(async () => root.unmount());
      host.remove();
    }
  };
  t.after(unmount);
  await render(initial);
  return { render, unmount };
}
function button(label: string) {
  const result = [...document.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  assert.ok(result, label);
  return result;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function input(id: string) {
  const result = document.getElementById(id) as HTMLInputElement;
  assert.ok(result, id);
  return result;
}
async function type(id: string, value: string) {
  await act(async () => {
    const node = input(id);
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      node,
      value,
    );
    node.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function choose(id: string, value: string) {
  await act(async () => {
    const control = document.getElementById(id);
    const node =
      control instanceof window.HTMLSelectElement
        ? control
        : control?.closest("span")?.querySelector("select");
    assert.ok(node, id);
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(
      node,
      value,
    );
    node.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}
const qualify = "Qualify original reporting source";
async function authorAllocation() {
  await type("reporting-source-file", id(11));
  await type("reporting-source-reference", "Original RP/province register, employee 42");
  await click("Add RP/province allocation");
  await choose("reporting-source-rp", rpId);
  await choose("reporting-source-province", "ON");
  await type("reporting-source-ordinal", "1");
  await type("reporting-source-first-pay", "2026-01-16");
  await type("reporting-source-annual-0", "72.0001");
  await click("Capped reporting bases");
  await type("reporting-source-reportableBases-0", "72.0001");
  await type("reporting-source-reportableBases-1", "0");
  await type("reporting-source-reportableBases-2", "0.0000");
  await click("Component amounts");
  await type("reporting-source-components-0", "72.0001");
  await click("Program bases");
  await type("reporting-source-programBases-0", "72.0001");
  await type("reporting-source-reason", "Original source verified");
}

test("qualification submits native source/head identity and explicit exact allocations with a stable retry request", async (t) => {
  const posts: Record<string, unknown>[] = [];
  let saved = 0;
  stubFetch(t, async (_url, init) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return Response.json(
        { error: "The original source is unavailable. Restore it in File Cabinet." },
        { status: 422 },
      );
    }
    return Response.json(source());
  });
  await mount(t, {
    ...props,
    onSaved() {
      saved++;
    },
  });
  assert.match(document.body.textContent!, /Current levy certificate/);
  assert.match(document.body.textContent!, /d{64}/);
  await click("Add RP/province allocation");
  assert.equal(input("reporting-source-annual-0").value, "");
  assert.equal(input("reporting-source-ordinal").value, "");
  assert.equal(input("reporting-source-first-pay").value, "");
  assert.equal(button(qualify).disabled, true);
  await click("Remove selected allocation");
  await authorAllocation();
  await click(qualify);
  await click(qualify);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0], posts[1]);
  assert.match(String(posts[0]!.requestId), UUID_RE);
  const { requestId: _requestId, ...payload } = posts[0]!;
  assert.deepEqual(payload, {
    openingBalanceId,
    expectedLevyAuthorityId: id(6),
    expectedLevyAllocationSha256: "d".repeat(64),
    expectedOpeningSha256: "b".repeat(64),
    expectedOpeningChildrenSha256: "c".repeat(64),
    sourceFileId: id(11),
    sourceVersionId: id(12),
    sourceSha256: "e".repeat(64),
    sourceReference: "Original RP/province register, employee 42",
    reason: "Original source verified",
    allocations: [
      {
        sourceOrdinal: 1,
        firstCoveredPayDate: "2026-01-16",
        filingAccountId: rpId,
        province: "ON",
        annualAmounts: { gross_ytd: "72.0001" },
        reportableBases: { ei: "72.0001", cpp: "0", qpip: "0.0000" },
        children: {
          components: [{ component_id: componentId, ytd_amount: "72.0001" }],
          programBases: [{ program_key: "ei", insurable_ytd: "72.0001" }],
          accountBases: [],
          suiStates: [],
        },
      },
    ],
  });
  assert.equal(saved, 0);
  assert.match(document.body.textContent!, /Restore it in File Cabinet/);
  assert.equal(input("reporting-source-programBases-0").value, "72.0001");
});

test("selected allocation and native amount tabs replace the active body while retaining all draft amounts", async (t) => {
  stubFetch(t, async () => Response.json(source()));
  const view = await mount(t);
  await authorAllocation();
  assert.equal(document.querySelectorAll("table").length, 1);
  assert.equal(document.getElementById("reporting-source-annual-0"), null);
  await click("Add RP/province allocation");
  await choose("reporting-source-allocation", "0");
  assert.equal(input("reporting-source-programBases-0").value, "72.0001");
  await click("Annual amounts");
  assert.equal(input("reporting-source-annual-0").value, "72.0001");
  await view.render({ ...props, active: false });
  await view.render(props);
  assert.equal(input("reporting-source-annual-0").value, "72.0001");
  assert.match(document.body.textContent!, /123456789RP0001/);
});

test("certified exact zeros prefill every allocation while positive amounts and source identities remain blank", async (t) => {
  const context = source();
  context.original.annualAmounts = {
    gross_ytd: "72.0001",
    insurable_ytd: "0",
    pensionable_ytd: "0.0000",
  };
  context.original.children = {
    components: [{ component_id: componentId, ytd_amount: "0.00" }],
    programBases: [
      { program_key: "ei", insurable_ytd: "0" },
      { program_key: "qpip", insurable_ytd: "0.0000" },
    ],
    accountBases: [
      { program_key: "ei", filing_account_id: rpId, region: "ON", insurable_ytd: "0.0" },
    ],
    suiStates: [{ state: "PA", insurable_ytd: "0.0000" }],
  };
  stubFetch(t, async () => Response.json(context));
  await mount(t);
  for (let allocation = 0; allocation < 2; allocation++) {
    await click("Add RP/province allocation");
    await click("Annual amounts");
    assert.equal(input("reporting-source-annual-0").value, "");
    assert.equal(input("reporting-source-annual-1").value, "0.0000");
    assert.equal(input("reporting-source-annual-2").value, "0.0000");
    assert.equal(input("reporting-source-ordinal").value, "");
    assert.equal(input("reporting-source-first-pay").value, "");
    assert.equal((document.getElementById("reporting-source-rp") as HTMLSelectElement).value, "");
    assert.equal(
      (document.getElementById("reporting-source-province") as HTMLSelectElement).value,
      "",
    );
    await click("Capped reporting bases");
    for (let index = 0; index < 3; index++)
      assert.equal(input(`reporting-source-reportableBases-${index}`).value, "0.0000");
    for (const [label, key] of [
      ["Component amounts", "components"],
      ["Program bases", "programBases"],
      ["Account bases", "accountBases"],
      ["State unemployment bases", "suiStates"],
    ]) {
      await click(label!);
      assert.equal(input(`reporting-source-${key}-0`).value, "0.0000");
    }
    assert.equal(button(qualify).disabled, true);
  }
});

test("positive and unavailable raw reporting bases never become source-proven zeros", async (t) => {
  const context = source();
  context.original.annualAmounts = { gross_ytd: "72.0001", insurable_ytd: "72.0001" };
  context.original.children!.programBases.push({ program_key: "qpip", insurable_ytd: "12.0001" });
  stubFetch(t, async () => Response.json(context));
  await mount(t);
  await click("Add RP/province allocation");
  await click("Capped reporting bases");
  for (let index = 0; index < 3; index++)
    assert.equal(input(`reporting-source-reportableBases-${index}`).value, "");
  assert.equal(button(qualify).disabled, true);
});

test("a complete certified child list without QPIP identities proves its original aggregate is zero", async (t) => {
  stubFetch(t, async () => Response.json(source()));
  await mount(t);
  await click("Add RP/province allocation");
  await click("Capped reporting bases");
  assert.equal(input("reporting-source-reportableBases-0").value, "");
  assert.equal(input("reporting-source-reportableBases-1").value, "");
  assert.equal(input("reporting-source-reportableBases-2").value, "0.0000");
});

test("changed current levy certificate or opening child hash preserves drafts and blocks qualification", async (t) => {
  let context = source();
  stubFetch(t, async () => Response.json(context));
  await mount(t);
  await authorAllocation();
  context = {
    ...context,
    original: { ...context.original, authorityId: id(20), openingChildrenSha256: "f".repeat(64) },
  };
  await click("Reload reporting source");
  assert.equal(input("reporting-source-programBases-0").value, "72.0001");
  assert.equal(button(qualify).disabled, true);
  assert.match(document.body.textContent!, /draft is preserved/);
  await click("Discard draft and reload");
  assert.equal(document.getElementById("reporting-source-programBases-0"), null);
});

test("read-only and unsaved annual openings cannot qualify a reporting source", async (t) => {
  stubFetch(t, async () => Response.json(source()));
  const view = await mount(t);
  await authorAllocation();
  await view.render({ ...props, annualDirty: true });
  assert.equal(button(qualify).disabled, true);
  await view.render({ ...props, canQualify: false });
  assert.equal(
    [...document.querySelectorAll("button")].some((node) => node.textContent === qualify),
    false,
  );
  assert.ok(
    [...document.querySelectorAll<HTMLInputElement>("input")].every((node) => node.disabled),
  );
});

test("wrong employee or year response refuses hydration and offers a retry in the same body", async (t) => {
  const context = source();
  context.original.employeePartyId = id(99);
  stubFetch(t, async () => Response.json(context));
  await mount(t);
  assert.match(document.body.textContent!, /does not match this employee and year/);
  assert.equal(document.querySelectorAll("input").length, 0);
  assert.ok(button("Retry"));
});

test("a selected Cabinet source refusal preserves the draft and permits selecting supported replacement evidence", async (t) => {
  const rejected = id(50);
  stubFetch(t, async (url) =>
    new URL(String(url), "http://localhost").searchParams.get("sourceFileId") === rejected
      ? Response.json(
          {
            error:
              "This Cabinet source is outside your file authority. Select a readable original report.",
          },
          { status: 422 },
        )
      : Response.json(source()),
  );
  await mount(t);
  await authorAllocation();
  await type("reporting-source-file", rejected);
  assert.match(document.body.textContent!, /outside your file authority/);
  assert.equal(input("reporting-source-programBases-0").value, "72.0001");
  assert.equal(input("reporting-source-programBases-0").disabled, true);
  assert.equal(input("reporting-source-file").disabled, false);
  await type("reporting-source-file", id(11));
  assert.equal(input("reporting-source-programBases-0").value, "72.0001");
  assert.equal(button(qualify).disabled, false);
});

test("sealed original reporting allocations expose retained evidence and disable qualification edits", async (t) => {
  const context = source();
  context.reporting = {
    id: id(30),
    openingBalanceId,
    levyAuthorityId: id(6),
    levyAllocationSha256: "d".repeat(64),
    employerAuthorityId: id(7),
    employeePartyId,
    taxYear: 2026,
    subsidiaryId: id(5),
    originalCountry: "CA",
    originalCurrency: "CAD",
    coverageStart: "2026-01-01",
    coverageEnd: "2026-05-31",
    openingSha256: "b".repeat(64),
    openingChildrenSha256: "c".repeat(64),
    allocationSha256: "f".repeat(64),
    sourceFileId: id(11),
    sourceVersionId: id(12),
    sourceSha256: "e".repeat(64),
    sourceReference: "Original RP/province report",
  };
  context.allocations = [
    {
      sourceOrdinal: 1,
      firstCoveredPayDate: "2026-01-16",
      filingAccountId: rpId,
      province: "ON",
      annualAmounts: { gross_ytd: "72.0001" },
      reportableBases: { ei: "72.0001", cpp: "0", qpip: "0" },
      children: context.original.children!,
    },
  ];
  stubFetch(t, async () => Response.json(context));
  await mount(t);
  assert.match(document.body.textContent!, /sealed and retained/);
  assert.match(document.body.textContent!, /f{64}/);
  assert.equal(document.querySelectorAll('input[inputmode="decimal"]').length, 0);
  assert.equal(document.getElementById("reporting-source-file"), null);
  assert.equal(input("reporting-source-ordinal").disabled, true);
  await click("Capped reporting bases");
  assert.match(document.body.textContent!, /72\.0001/);
});

test("pending save aborts on drawer unmount and cannot notify the next selected employee", async (t) => {
  const pending = deferred<Response>();
  let saved = 0;
  let signal: AbortSignal | null | undefined;
  stubFetch(t, async (_url, init) => {
    if (init?.method === "POST") {
      signal = init.signal;
      return pending.promise;
    }
    return Response.json(source());
  });
  const view = await mount(t, {
    ...props,
    onSaved() {
      saved++;
    },
  });
  await authorAllocation();
  await click(qualify);
  await view.unmount();
  assert.equal(signal?.aborted, true);
  await act(async () => pending.resolve(Response.json({ record: { id: id(30) } })));
  assert.equal(saved, 0);
});
