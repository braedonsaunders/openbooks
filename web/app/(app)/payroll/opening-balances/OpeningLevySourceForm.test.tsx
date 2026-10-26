import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bootJsdomEnvironment } from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";
import type { readOpeningLevySourceContext } from "@openbooks/engine/payroll/opening-levy-source-authority";

await bootJsdomEnvironment({ url: "http://localhost:4800/payroll/opening-balances" });
stubModules({
  intl: false,
  extra: {
    "../../../../components/cabinet-file-picker": `export function CabinetFilePicker(p){return globalThis.React.createElement('input',{id:'levy-source-file',value:p.value,disabled:p.disabled,onChange:e=>p.onChange(e.target.value),'aria-label':p.label})}`,
    sonner:
      "export const toast={success(){},error(){},info(){}};export function Toaster(){return null}",
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { OpeningLevySourceForm } = await import("./OpeningLevySourceForm");
type Context = Awaited<ReturnType<typeof readOpeningLevySourceContext>>;
type Props = React.ComponentProps<typeof OpeningLevySourceForm>;
const employeePartyId = "10000000-0000-4000-8000-000000000001";
const openingBalanceId = "10000000-0000-4000-8000-000000000002";
const einId = "10000000-0000-4000-8000-000000000003";
const sha = "a".repeat(64);
function source(): Context {
  return {
    record: {
      openingBalanceId,
      employeePartyId,
      taxYear: 2026,
      openingSha256: sha,
      employerAuthorityId: "10000000-0000-4000-8000-000000000004",
      subsidiaryId: "10000000-0000-4000-8000-000000000005",
      originalCountry: null,
      originalCurrency: null,
      coverageStart: null,
      coverageEnd: null,
      coverageComplete: null,
      sourceFileId: "10000000-0000-4000-8000-000000000006",
      sourceVersionId: "10000000-0000-4000-8000-000000000007",
      sourceSha256: "b".repeat(64),
      sourceReference: "Original payroll report, employee 42",
      levyAuthorityId: null,
      levyReason: null,
      allocationSha256: null,
      openingChildrenSha256: "e".repeat(64),
      sealed: null,
      levyMatches: null,
    },
    source: {
      id: "10000000-0000-4000-8000-000000000006",
      versionId: "10000000-0000-4000-8000-000000000007",
      sha256: "b".repeat(64),
      name: "Original payroll report",
    },
    countries: [
      { country: "CA", currency: "CAD" },
      { country: "US", currency: "USD" },
      { country: "GB", currency: "GBP" },
    ],
    allocations: [],
    eins: [{ id: einId, name: "Original EIN", isActive: false }],
    suiAccounts: [],
    openingSuiStates: [],
    openingSuiAccountIds: [],
    correctionRefusal: null,
  };
}
const props: Props = {
  employeePartyId,
  year: 2026,
  openingAmounts: {},
  canManage: true,
  annualDirty: false,
  onSaved() {},
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function stubFetch(t: TestContext, handler: typeof fetch) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = previous;
  });
}
async function mount(t: TestContext, initial = props) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let live = true;
  const unmount = async () => {
    if (live) {
      live = false;
      await act(async () => root.unmount());
      host.remove();
    }
  };
  t.after(unmount);
  const render = async (next: Props) =>
    act(async () =>
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <OpeningLevySourceForm {...next} />
        </NextIntlClientProvider>,
      ),
    );
  await render(initial);
  return { render, unmount };
}
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find((node) => node.textContent === label);
  assert.ok(found, `the ${label} action is available`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function type(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement | null;
  assert.ok(input, `${id} is available`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
function input(id: string) {
  return document.getElementById(id) as HTMLInputElement;
}
async function choose(id: string, value: string) {
  const control = document.getElementById(id);
  const select =
    control instanceof window.HTMLSelectElement
      ? control
      : control?.closest("span")?.querySelector("select");
  assert.ok(select);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(
      select,
      value,
    );
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}
async function authorFacts(country = "US", year = 2026) {
  await type("levy-source-file", "10000000-0000-4000-8000-000000000006");
  await choose("levy-source-country", country);
  await choose("levy-source-currency", country === "CA" ? "CAD" : country === "GB" ? "GBP" : "USD");
  if (country === "US") await choose("levy-source-0-account", einId);
  await type("levy-source-coverage-start", `${year}-${country === "GB" ? "04-06" : "01-01"}`);
  await type("levy-source-coverage-end", `${year}-05-30`);
  await type("levy-source-reference", "Original report, employee 42 statutory history");
  await act(async () =>
    (document.getElementById("levy-source-complete") as HTMLInputElement).click(),
  );
}
const seal = "Seal statutory opening allocations";

test("submits exact retained record, fingerprint and explicit operator amount without profile inference", async (t) => {
  const posts: Record<string, unknown>[] = [];
  const queries: URLSearchParams[] = [];
  let saved = 0;
  stubFetch(t, async (url, init) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return Response.json(
        { error: "The retained source file version is unavailable. Restore it in File Cabinet." },
        { status: 422 },
      );
    }
    queries.push(new URL(String(url), "http://localhost").searchParams);
    return Response.json(source());
  });
  await mount(t, {
    ...props,
    onSaved() {
      saved += 1;
    },
  });
  assert.equal(queries[0]!.get("employeePartyId"), employeePartyId);
  assert.equal(queries[0]!.get("taxYear"), "2026");
  assert.ok(document.body.textContent?.includes(source().record!.sourceVersionId!));
  assert.ok(document.body.textContent?.includes(source().record!.sourceSha256!));
  assert.match(
    document.body.textContent!,
    /Record only facts confirmed by the selected File Cabinet version/,
  );
  assert.equal(document.querySelectorAll('input[inputmode="decimal"]').length, 0);
  await authorFacts();
  assert.equal(input("levy-source-0-amount").value, "");
  assert.equal(button(seal).disabled, true);
  await type("levy-source-0-amount", "0");
  await type("levy-source-reason", "Verified original report");
  await click(seal);
  assert.deepEqual(posts, [
    {
      openingBalanceId,
      expectedOpeningSha256: sha,
      expectedOpeningChildrenSha256: "e".repeat(64),
      sourceFileId: source().source!.id,
      sourceVersionId: source().source!.versionId,
      sourceSha256: source().source!.sha256,
      sourceReference: "Original report, employee 42 statutory history",
      originalCountry: "US",
      originalCurrency: "USD",
      coverageStart: "2026-01-01",
      coverageEnd: "2026-05-30",
      coverageComplete: true,
      allocations: [
        {
          programKey: "us_futa",
          region: "US",
          filingAccountId: einId,
          federalAccountId: einId,
          amount: "0",
        },
      ],
      reason: "Verified original report",
    },
  ]);
  assert.equal(saved, 0);
  assert.match(document.body.textContent!, /Restore it in File Cabinet/);
  assert.equal(input("levy-source-0-amount").value, "0");
  assert.equal(input("levy-source-reason").value, "Verified original report");
  await click("Reload retained source");
  assert.equal(input("levy-source-0-amount").value, "0");
  assert.equal(input("levy-source-reason").value, "Verified original report");
});

test("all Canadian declarations require explicit amounts and missing aggregate totals stay unavailable", async (t) => {
  stubFetch(t, async () => Response.json(source()));
  await mount(t);
  await authorFacts("CA");
  const amounts = [...document.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]')];
  assert.equal(amounts.length, 18);
  assert.ok(amounts.every((field) => field.value === ""));
  assert.match(document.body.textContent!, /WCB total: Not available/);
  await type("levy-source-reason", "Verified all provinces");
  for (let index = 0; index < amounts.length - 1; index++)
    await type(`levy-source-${index}-amount`, "0");
  assert.equal(button(seal).disabled, true);
  await type("levy-source-17-amount", "0");
  assert.equal(button(seal).disabled, false);
});

test("read-only permission disables amount, reason, add and remove controls", async (t) => {
  stubFetch(t, async () => Response.json(source()));
  await mount(t, { ...props, canManage: false });
  assert.ok(
    [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")].every(
      (node) => node.disabled,
    ),
  );
  assert.equal(document.querySelectorAll('input[inputmode="decimal"]').length, 0);
  assert.ok(![...document.querySelectorAll("button")].some((node) => node.textContent === seal));
});

test("a sealed source hydrates immutable original allocations and a governed source correction action", async (t) => {
  const context = source();
  context.record = {
    ...context.record!,
    originalCountry: "US",
    originalCurrency: "USD",
    coverageStart: "2026-01-01",
    coverageEnd: "2026-05-30",
    coverageComplete: true,
    levyAuthorityId: "10000000-0000-4000-8000-000000000008",
    sealed: true,
    levyMatches: true,
    levyReason: "Report verified",
    allocationSha256: "c".repeat(64),
  };
  context.allocations = [
    {
      programKey: "us_futa",
      region: "US",
      subRegion: "",
      filingAccountId: einId,
      federalAccountId: einId,
      amount: "415.1200",
    },
  ];
  stubFetch(t, async () => Response.json(context));
  await mount(t);
  assert.equal(document.querySelectorAll("input, select").length, 0);
  assert.match(document.body.textContent!, /415\.1200/);
  assert.match(
    document.body.textContent!,
    /original certificate and source evidence remain immutable/,
  );
  assert.equal(button("Correct original source certificate").disabled, false);
  assert.ok(document.body.textContent?.includes(context.record.allocationSha256!));
});

test("wrong employee or year response refuses hydration and save", async (t) => {
  const context = source();
  context.record = { ...context.record!, taxYear: 2025 };
  stubFetch(t, async () => Response.json(context));
  await mount(t);
  assert.match(document.body.textContent!, /does not match this employee and year/);
  assert.equal(document.querySelectorAll("input").length, 0);
});

test("an earlier employee response cannot overwrite the newly selected employee", async (t) => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  let requests = 0;
  stubFetch(t, async () => (++requests === 1 ? first.promise : second.promise));
  const view = await mount(t);
  const nextEmployee = "10000000-0000-4000-8000-000000000009";
  await view.render({ ...props, employeePartyId: nextEmployee, year: 2027 });
  const nextContext = source();
  nextContext.record = { ...nextContext.record!, employeePartyId: nextEmployee, taxYear: 2027 };
  await act(async () => second.resolve(Response.json(nextContext)));
  await authorFacts("US", 2027);
  await type("levy-source-0-amount", "72.0001");
  await act(async () => first.resolve(Response.json(source())));
  assert.equal(input("levy-source-0-amount").value, "72.0001");
  assert.ok(document.body.textContent?.includes(nextEmployee));
  assert.equal(document.querySelectorAll('input[inputmode="decimal"]').length, 1);
});

test("a changed retained opening keeps the draft and blocks sealing until it is discarded", async (t) => {
  let context = source();
  stubFetch(t, async () => Response.json(context));
  await mount(t);
  await authorFacts();
  await type("levy-source-0-amount", "18.25");
  await type("levy-source-reason", "Original report");
  context = { ...context, record: { ...context.record!, openingSha256: "d".repeat(64) } };
  await click("Reload retained source");
  assert.equal(input("levy-source-0-amount").value, "18.25");
  assert.equal(button(seal).disabled, true);
  assert.match(document.body.textContent!, /draft is preserved/);
  await click("Discard draft and reload");
  assert.equal((document.getElementById("levy-source-country") as HTMLSelectElement).value, "");
  await authorFacts();
  assert.equal(input("levy-source-0-amount").value, "");
  assert.equal(input("levy-source-reason").value, "");
});

test("a load refusal preserves entries and a successful retry restores their editability", async (t) => {
  let refuse = false;
  stubFetch(t, async () =>
    refuse
      ? Response.json({ error: "Source is outside your payroll authority" }, { status: 422 })
      : Response.json(source()),
  );
  await mount(t);
  await authorFacts();
  await type("levy-source-0-amount", "45.0001");
  refuse = true;
  await click("Reload retained source");
  assert.equal(input("levy-source-0-amount").value, "45.0001");
  assert.equal(input("levy-source-0-amount").disabled, true);
  assert.match(document.body.textContent!, /outside your payroll authority/);
  refuse = false;
  await click("Retry");
  assert.equal(input("levy-source-0-amount").value, "45.0001");
  assert.equal(input("levy-source-0-amount").disabled, false);
});

test("save completion after unmount does not notify the newly selected record", async (t) => {
  const pending = deferred<Response>();
  let saved = 0;
  const capture: { signal?: AbortSignal | null } = {};
  stubFetch(t, async (_url, init) => {
    if (init?.method === "POST") {
      capture.signal = init.signal;
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
  await authorFacts();
  await type("levy-source-0-amount", "0");
  await type("levy-source-reason", "Original source verified");
  await click(seal);
  await view.unmount();
  assert.equal(capture.signal?.aborted, true);
  await act(async () => pending.resolve(Response.json({ record: { id: "sealed" } })));
  assert.equal(saved, 0);
});

test("an unqualified original country remains blank and can be authored for a fiscal pack without levy allocations", async (t) => {
  const posts: Record<string, unknown>[] = [];
  stubFetch(t, async (_url, init) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return Response.json({ record: { id: "sealed" } });
    }
    return Response.json(source());
  });
  await mount(t);
  assert.equal((document.getElementById("levy-source-country") as HTMLSelectElement).value, "");
  assert.equal((document.getElementById("levy-source-currency") as HTMLSelectElement).value, "");
  assert.equal(input("levy-source-coverage-start").value, "");
  assert.equal(document.querySelectorAll('input[inputmode="decimal"]').length, 0);
  await authorFacts("GB");
  await type("levy-source-reason", "Complete original UK opening report");
  await click(seal);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.originalCountry, "GB");
  assert.equal(posts[0]!.originalCurrency, "GBP");
  assert.equal(posts[0]!.coverageStart, "2026-04-06");
  assert.deepEqual(posts[0]!.allocations, []);
});

test("SUI and LST rows require an explicitly selected original federal EIN independently of current account choices", async (t) => {
  const context = source();
  context.eins.push({
    id: "10000000-0000-4000-8000-000000000010",
    name: "Second original EIN",
    isActive: true,
  });
  stubFetch(t, async () => Response.json(context));
  await mount(t);
  await authorFacts();
  await type("levy-source-0-amount", "0");
  await click("Add FUTA allocation");
  await choose("levy-source-1-account", "10000000-0000-4000-8000-000000000010");
  await type("levy-source-1-amount", "0");
  await click("Add SUI state");
  await choose("levy-source-2-region", "PA");
  await type("levy-source-2-amount", "0");
  await type("levy-source-reason", "Original PA wages by EIN");
  assert.equal(button(seal).disabled, true);
  assert.equal(
    (document.getElementById("levy-source-2-federal-account") as HTMLSelectElement).value,
    "",
  );
  await choose("levy-source-2-federal-account", einId);
  assert.equal(button(seal).disabled, false);
});

test("changed original child evidence preserves drafts and blocks the seal even when the parent opening bytes match", async (t) => {
  let context = source();
  stubFetch(t, async () => Response.json(context));
  await mount(t);
  await authorFacts();
  await type("levy-source-0-amount", "7.25");
  await type("levy-source-reason", "Reviewed original account carry-ins");
  context = { ...context, record: { ...context.record!, openingChildrenSha256: "f".repeat(64) } };
  await click("Reload retained source");
  assert.equal(input("levy-source-0-amount").value, "7.25");
  assert.equal(button(seal).disabled, true);
  assert.match(document.body.textContent!, /draft is preserved/);
});

test("source correction replaces the active body and retries the same exact native request", async (t) => {
  const context = source();
  const authorityId = "10000000-0000-4000-8000-000000000008";
  context.record = {
    ...context.record!,
    originalCountry: "US",
    originalCurrency: "USD",
    coverageStart: "2026-01-01",
    coverageEnd: "2026-05-30",
    coverageComplete: true,
    levyAuthorityId: authorityId,
    sealed: true,
    levyMatches: true,
    levyReason: "Original verified",
    allocationSha256: "c".repeat(64),
  };
  context.allocations = [
    {
      programKey: "us_futa",
      region: "US",
      subRegion: "",
      filingAccountId: einId,
      federalAccountId: einId,
      amount: "0.0000",
    },
  ];
  const requests: Record<string, unknown>[] = [];
  stubFetch(t, async (_url, init) => {
    if (init?.method === "PATCH") {
      requests.push(JSON.parse(String(init.body)));
      return Response.json(
        { error: "The retained source is unavailable; reload the source before retrying" },
        { status: 422 },
      );
    }
    return Response.json(context);
  });
  await mount(t);
  await click("Correct original source certificate");
  assert.equal(document.querySelectorAll("table").length, 0);
  assert.equal(input("levy-source-0-amount").value, "0.0000");
  await type("levy-source-file", context.source!.id);
  await type("levy-source-reason", "Correct the source-confirmed original EIN coverage");
  await click("Record replacement certificate");
  await click("Record replacement certificate");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0]!.expectedAuthorityId, authorityId);
  assert.equal(requests[0]!.expectedAllocationSha256, "c".repeat(64));
  assert.match(String(requests[0]!.requestId), UUID_RE);
  assert.equal(requests[0]!.sourceSha256, context.source!.sha256);
  assert.match(document.body.textContent!, /retained source is unavailable/);
  await click("Cancel source correction");
  assert.equal(document.querySelectorAll("table").length, 1);
  assert.equal(document.querySelectorAll("input, select").length, 0);
});

test("an issued-year source refusal preserves the sealed certificate and prevents replacement editing", async (t) => {
  const context = source();
  context.record = {
    ...context.record!,
    levyAuthorityId: "10000000-0000-4000-8000-000000000008",
    sealed: true,
    levyMatches: true,
    allocationSha256: "c".repeat(64),
  };
  context.correctionRefusal = "Source certificate replacement for an issued year is unavailable";
  stubFetch(t, async () => Response.json(context));
  await mount(t);
  assert.equal(button("Correct original source certificate").disabled, true);
  assert.match(document.body.textContent!, /issued year is unavailable/);
  assert.equal(document.querySelectorAll("input, select").length, 0);
});
