import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../../../../../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../../../../../testing/jsdom-env.ts";

declare global {
  var __batchConfirm: { calls: Record<string, unknown>[]; next: boolean[] } | undefined;
}

// The batch grid end to end in a browser document: a spreadsheet paste fills
// bills, vendor defaults code them, control totals gate the save, possible
// duplicates need an explicit confirmation, and each bill saves through the
// document create path with its own key.
await bootJsdomEnvironment({
  url: "http://localhost:4800/ap/bills/batch",
  matchMediaMatches: false,
});
stubModules({
  navigation: { pathname: "/ap/bills/batch" },
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(){},error(){},warning(){},info(){}};export function Toaster(){return null}",
  },
});
const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(o){const s=(globalThis.__batchConfirm??={calls:[],next:[]});s.calls.push(o);return s.next.length?s.next.shift():true}",
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../../components/money-provider");
const { ShortcutProvider } = await import("../../../../../components/shortcuts/shortcut-provider");
const { BatchBillEntry } = await import("./BatchBillEntry");
const { batchDraftKey, blankBatchRow } = await import("./batch-bills");
const { currentPlatform, isApplePlatform } =
  await import("../../../../../components/shortcuts/shortcut-keys");

// The primary modifier is Cmd on Apple platforms and Ctrl elsewhere.
const PRIMARY: KeyboardEventInit = isApplePlatform(currentPlatform())
  ? { metaKey: true }
  : { ctrlKey: true };

const ORG = "org-1";
const USER = "user-1";
const ACME = "11111111-1111-4111-8111-111111111111";
const BIRCH = "22222222-2222-4222-8222-222222222222";
const SUPPLIES = "33333333-3333-4333-8333-333333333333";
const FREIGHT = "44444444-4444-4444-8444-444444444444";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

type Call = { url: string; method: string; key: string | null; body: Record<string, unknown> };

function scriptFetch(
  options: { duplicates?: (url: string) => unknown[]; post?: () => Record<string, unknown> } = {},
) {
  const prior = globalThis.fetch;
  const calls: Call[] = [];
  let number = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      key: headers.get("Idempotency-Key"),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    };
    calls.push(call);
    if (url.startsWith("/api/documents/defaults")) {
      const partyId = new URL(url, "http://x").searchParams.get("partyId");
      return Response.json({
        terms: { dueDate: "2026-11-20", source: "party" },
        lines: [],
        party: {
          line: {
            accountId: partyId === BIRCH ? FREIGHT : SUPPLIES,
            accountSource: "party_default",
            taxCodeId: null,
            taxSource: null,
          },
          recent: null,
        },
      });
    }
    if (url.startsWith("/api/documents/duplicates"))
      return Response.json({ duplicates: options.duplicates?.(url) ?? [] });
    if (url === "/api/documents" && call.method === "POST") {
      number += 1;
      return Response.json(
        {
          doc: {
            id: call.key,
            document_number: `BILL-0004${number}`,
            total: (call.body.lines as { amount: string }[])[0]?.amount,
          },
          lines: [],
        },
        { status: 201 },
      );
    }
    if (url === "/api/documents/actions") {
      return Response.json(
        call.body.action === "post" ? (options.post?.() ?? { ok: true }) : { ok: true },
      );
    }
    return Response.json({});
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = prior;
    },
  };
}

async function mount({
  canPost = true,
  subsidiaries = null,
}: {
  canPost?: boolean;
  subsidiaries?: React.ComponentProps<typeof BatchBillEntry>["subsidiaries"];
} = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <ShortcutProvider>
            <BatchBillEntry
              currency="USD"
              orgId={ORG}
              userId={USER}
              today="2026-10-21"
              minorUnits={2}
              vendors={[
                { id: ACME, display_name: "Acme Supply", short_code: "ACME" },
                { id: BIRCH, display_name: "Birch Freight", short_code: "BIRCH" },
              ]}
              accounts={[
                { id: SUPPLIES, number: "6100", name: "Office supplies" },
                { id: FREIGHT, number: "6200", name: "Freight" },
              ]}
              taxProfiles={[]}
              subsidiaries={subsidiaries}
              defaultSubsidiaryId={subsidiaries?.[0]?.id ?? null}
              canPost={canPost}
              canCreateVendor={false}
              helpHref="/docs/batch-bill-entry"
            />
          </ShortcutProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await settle();
  return {
    host,
    async done() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i += 1)
    await act(async () => {
      await tick();
    });
}

function cell(host: HTMLElement, row: number, col: number): HTMLElement {
  const found = host.querySelector<HTMLElement>(`div[data-lg-row="${row}"][data-lg-col="${col}"]`);
  assert.ok(found, `row ${row} col ${col} renders a cell`);
  return found;
}

async function paste(target: HTMLElement, text: string) {
  await act(async () => {
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
    target.dispatchEvent(event);
    await tick();
  });
  await settle();
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
}

async function press(init: KeyboardEventInit) {
  await act(async () => {
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
    await tick();
  });
  await settle(8);
}

function labelledInput(host: HTMLElement, label: string): HTMLInputElement {
  const found = [...host.querySelectorAll("label")].find((element) =>
    element.textContent?.startsWith(label),
  );
  const input = found?.querySelector("input");
  assert.ok(input, `${label} input renders`);
  return input as HTMLInputElement;
}

function resetBrowserState() {
  window.localStorage.clear();
  globalThis.__batchConfirm = { calls: [], next: [] };
}

const SHEET = "Vendor\tVendor ref #\tAmount\nACME\tINV-1\t100.00\nBirch Freight\tINV-2\t250.50";

test("a pasted block becomes coded bills, and Ctrl+S saves each one once the control totals match", async (t) => {
  resetBrowserState();
  const fetchScript = scriptFetch();
  t.after(fetchScript.restore);
  const { host, done } = await mount();
  t.after(done);

  await paste(cell(host, 0, 0), SHEET);
  assert.match(host.textContent ?? "", /Entered: 2 bills · \$350\.50/);
  assert.match(
    host.textContent ?? "",
    /Due Nov 20, 2026 by terms|Due .*2026.* by terms/,
    "a blank due date shows the date the terms give",
  );
  const account = (row: number) => cell(host, row, 4).textContent ?? "";
  assert.match(account(0), /6100 Office supplies/, "the vendor default codes the bill");
  assert.match(account(1), /6200 Freight/);
  const bodyDate = (row: number) => cell(host, row, 2).querySelector("input")?.value ?? "";
  assert.equal(bodyDate(1), bodyDate(0), "a pasted row takes the bill date of the row above");

  await typeInto(labelledInput(host, "Number of bills"), "3");
  await press({ key: "s", code: "KeyS", ...PRIMARY });
  assert.match(host.textContent ?? "", /The batch has 2 bills but the control count is 3/);
  assert.equal(
    fetchScript.calls.filter((call) => call.url === "/api/documents").length,
    0,
    "nothing saves while the count is off",
  );

  await typeInto(labelledInput(host, "Number of bills"), "2");
  await typeInto(labelledInput(host, "Batch total"), "350.50");
  assert.match(host.textContent ?? "", /Bill count matches/);
  assert.match(host.textContent ?? "", /Batch total matches/);
  await press({ key: "s", code: "KeyS", ...PRIMARY });

  const creates = fetchScript.calls.filter((call) => call.url === "/api/documents");
  assert.equal(creates.length, 2);
  assert.notEqual(creates[0]!.key, creates[1]!.key, "each bill has its own create key");
  assert.deepEqual(
    creates.map((call) => call.body.kind),
    ["vendor_bill", "vendor_bill"],
  );
  assert.deepEqual(
    creates.map((call) => (call.body.lines as { accountId: string; amount: string }[])[0]),
    [
      {
        accountId: SUPPLIES,
        amount: "100.0000",
        description: null,
        quantity: null,
        unitPrice: null,
        taxCodeId: null,
        taxGroupId: null,
        taxOverridden: false,
        taxAmount: null,
      },
      {
        accountId: FREIGHT,
        amount: "250.5000",
        description: null,
        quantity: null,
        unitPrice: null,
        taxCodeId: null,
        taxGroupId: null,
        taxOverridden: false,
        taxAmount: null,
      },
    ],
  );
  assert.equal(
    fetchScript.calls.filter((call) => call.url === "/api/documents/actions").length,
    0,
    "drafts are not submitted",
  );
  assert.match(host.textContent ?? "", /Saved BILL-0004/);
  assert.equal(cell(host, 0, 0).querySelector("button, input"), null, "a saved bill is read-only");
  assert.equal(
    window.localStorage.getItem(batchDraftKey(ORG, USER)),
    null,
    "a fully saved batch is forgotten",
  );
});

test("a possible duplicate needs confirmation, with Cancel as the default choice", async (t) => {
  resetBrowserState();
  const fetchScript = scriptFetch({
    duplicates: (url) =>
      url.includes("INV-1")
        ? [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              documentNumber: "BILL-00007",
              documentDate: "2026-09-01",
              total: "100.0000",
              status: "posted",
              referenceNumber: "INV-1",
              reason: "reference",
            },
          ]
        : [],
  });
  t.after(fetchScript.restore);
  const { host, done } = await mount();
  t.after(done);

  await paste(cell(host, 0, 0), SHEET);
  await settle(20);
  assert.match(host.textContent ?? "", /Possible duplicate/);
  globalThis.__batchConfirm!.next.push(false);
  await press({ key: "s", code: "KeyS", ...PRIMARY });
  const [confirm] = globalThis.__batchConfirm!.calls;
  assert.equal(confirm?.defaultAction, "cancel");
  assert.equal(
    fetchScript.calls.filter((call) => call.url === "/api/documents").length,
    0,
    "cancelling saves nothing",
  );
  assert.ok(window.localStorage.getItem(batchDraftKey(ORG, USER)), "the unsaved batch is kept");
});

test("Ctrl+Enter posts each bill, and a bill held for approval is not posted around it", async (t) => {
  resetBrowserState();
  const fetchScript = scriptFetch({ post: () => ({ ok: true, pendingApproval: true }) });
  t.after(fetchScript.restore);
  const { host, done } = await mount();
  t.after(done);

  await paste(cell(host, 0, 0), "Vendor\tVendor ref #\tAmount\nACME\tINV-9\t40");
  await press({ key: "Enter", code: "Enter", ...PRIMARY });
  const actions = fetchScript.calls
    .filter((call) => call.url === "/api/documents/actions")
    .map((call) => call.body.action);
  assert.deepEqual(actions, ["post"]);
  assert.match(host.textContent ?? "", /BILL-00041 awaiting approval/);
});

test("without the post permission there is no Post all and Ctrl+Enter does nothing", async (t) => {
  resetBrowserState();
  const fetchScript = scriptFetch();
  t.after(fetchScript.restore);
  const { host, done } = await mount({ canPost: false });
  t.after(done);

  assert.equal(
    [...host.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Post all",
    ),
    false,
  );
  await paste(cell(host, 0, 0), "Vendor\tVendor ref #\tAmount\nACME\tINV-9\t40");
  await press({ key: "Enter", code: "Enter", ...PRIMARY });
  assert.equal(fetchScript.calls.filter((call) => call.url === "/api/documents").length, 0);
});

test("an unsaved batch is restored from the browser with an offer to discard it", async (t) => {
  resetBrowserState();
  const fetchScript = scriptFetch();
  t.after(fetchScript.restore);
  const row = {
    ...blankBatchRow("2026-10-20"),
    partyId: ACME,
    defaultsFor: ACME,
    accountId: SUPPLIES,
    referenceNumber: "INV-77",
    amount: "12.3400",
  };
  window.localStorage.setItem(
    batchDraftKey(ORG, USER),
    JSON.stringify({
      version: 1,
      rows: [row],
      controlCount: "1",
      controlTotal: "12.34",
      subsidiaryId: "",
    }),
  );
  const { host, done } = await mount();
  t.after(done);

  assert.match(host.textContent ?? "", /Unsaved batch restored/);
  assert.match(host.textContent ?? "", /1 unsaved bill from your last session was restored/);
  assert.equal(labelledInput(host, "Number of bills").value, "1");
  assert.match(host.textContent ?? "", /Entered: 1 bill · \$12\.34/);
  assert.ok(
    [...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Discard"),
  );
});

test("a batch uses its legal entity currency and cannot reinterpret entered amounts by changing entity", async (t) => {
  resetBrowserState();
  const scripted = scriptFetch();
  t.after(scripted.restore);
  const { host, done } = await mount({
    subsidiaries: [
      { id: "entity-us", name: "US company", baseCurrency: "USD" },
      { id: "entity-jp", name: "Japan company", baseCurrency: "JPY" },
    ],
  });
  t.after(done);
  const entity = host.querySelector<HTMLSelectElement>("select")!;
  assert.ok(entity);
  await act(async () => {
    entity.value = "entity-jp";
    entity.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick();
  });
  await paste(cell(host, 0, 0), "Vendor\tVendor ref #\tAmount\nACME\tJPY-1\t1785");
  assert.equal(entity.disabled, true);
  assert.ok(host.textContent?.includes("JPY"));
  await press({ key: "s", code: "KeyS", ...PRIMARY });
  const create = scripted.calls.find(
    (call) => call.url === "/api/documents" && call.method === "POST",
  );
  assert.ok(create);
  assert.equal(create.body.currency, "JPY");
  assert.equal(create.body.subsidiaryId, "entity-jp");
});
