import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
}

// The vendor's default account rides every new line the drawer starts, so a
// line started by Tab arrives already coded. That carried coding is not the
// operator's content: saving must ignore the untouched trailing line rather
// than refuse it for a missing amount, while a line the operator coded
// themselves still reaches the server and its line-named refusal.

// jsdom first: the drawer reads browser globals at render.
const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/ap/bills", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__drawerRouter}export function usePathname(){return '/ap/bills'}export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
});

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__drawerToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__drawerToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__drawerToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    if (specifier === "@/lib/confirm" || specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
      };
    }
    if (specifier === "@/lib/prompt" || specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return null}",
      };
    }
    if (specifier.endsWith("/lib/client-scripts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function runClientScripts(){return {ok:true,warnings:[]}}",
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
const messages = (await import("../messages/en")).default;
const { MoneyProvider } = await import("./money-provider");
const { DocumentDrawer } = await import("./document-drawer");
const { DOC_KINDS } = await import("../lib/document-kinds");
const { defaultFormLayout } = await import("@openbooks/customization");
const { isBlankDrawerLine } = await import("./document-drawer-lines");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const VENDOR_ID = "44444444-4444-4444-8444-444444444444";
const SHOP_SUPPLIES = "66666666-6666-4666-8666-666666666800";
const OFFICE = "66666666-6666-4666-8666-666666666100";
const ACCOUNTS = [
  { id: SHOP_SUPPLIES, number: "6800", name: "Shop Supplies & Small Tools" },
  { id: OFFICE, number: "6100", name: "Office Expense" },
];
const PARTIES = [{ id: VENDOR_ID, display_name: "usd vendor" }];
const NONE: never[] = [];

/** The vendor's history settles on 6800, as the defaults endpoint answers. */
function partyDefaults() {
  return {
    party: {
      line: {
        accountId: SHOP_SUPPLIES,
        accountSource: "party_history",
        taxCodeId: null,
        taxGroupId: null,
        taxSource: null,
        historyCount: 1,
      },
      recent: {
        id: "55555555-5555-4555-8555-555555555555",
        documentNumber: "BILL-00001",
        documentDate: "2026-10-01",
        referenceNumber: null,
        memo: null,
        total: "150.0000",
        currency: "USD",
        lines: [
          {
            accountId: SHOP_SUPPLIES,
            itemId: null,
            description: null,
            quantity: null,
            unitPrice: null,
            amount: "150.0000",
            departmentId: null,
            projectId: null,
            locationId: null,
            classId: null,
            taxCodeId: null,
          },
        ],
      },
    },
  };
}

async function mountNewBill() {
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  const prior = globalThis.fetch;
  const posts: { lines: Record<string, unknown>[] }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.startsWith("/api/documents/defaults?")) return Response.json(partyDefaults());
    if (url.startsWith("/api/documents/duplicates?")) return Response.json({ duplicates: [] });
    if (url === "/api/documents" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return Response.json({ error: "Recorded for inspection" }, { status: 422 });
    }
    return Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            payload={{
              doc: {
                id: "",
                kind: "vendor_bill",
                status: "draft",
                document_number: null,
                currency: "USD",
                party_id: VENDOR_ID,
                party_name: "usd vendor",
                updated_at: "",
                document_date: "2026-10-20",
                reference_number: null,
                memo: null,
                subtotal: "0.00",
                tax_total: "0.00",
                total: "0.00",
              },
              lines: [],
            }}
            config={DOC_KINDS["vendor_bill"]!}
            basePath="/ap/bills"
            recordType="vendor_bill"
            parties={PARTIES}
            accounts={ACCOUNTS}
            taxCodes={NONE}
            taxGroups={NONE}
            cards={NONE}
            bankAccounts={NONE}
            departments={NONE}
            projects={NONE}
            locations={NONE}
            classes={NONE}
            items={NONE}
            subsidiaries={NONE}
            headerDefs={NONE}
            lineDefs={NONE}
            segments={NONE}
            canCreate
            canPost
            createMode
            initialMode="edit"
            layout={defaultFormLayout("vendor_bill")}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await act(async () => {
    await tick();
    await tick();
  });
  return {
    posts,
    async done() {
      await act(async () => root.unmount());
      host.remove();
      globalThis.fetch = prior;
    },
  };
}

const lineControls = (row: number) =>
  [
    ...document.querySelectorAll<HTMLElement>(
      `[data-lg-row="${row}"] input, [data-lg-row="${row}"] button`,
    ),
  ].filter((element) => element.closest("[data-lg-col]"));

const amountInput = (row: number) => {
  const input = document.querySelector<HTMLInputElement>(
    `[data-lg-row="${row}"] input[inputmode="decimal"]`,
  );
  assert.ok(input, `line ${row + 1} renders an amount cell`);
  return input;
};

async function typeAmount(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
}

async function tabFrom(target: HTMLElement) {
  await act(async () => {
    target.focus();
    target.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );
    await tick();
  });
  // The new line and its focus land on the next animation frames.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    await tick();
  });
}

async function saveDraft() {
  const save = [...document.querySelectorAll("button")].find((button) =>
    ["Save", "Save draft"].includes(button.textContent?.trim() ?? ""),
  );
  assert.ok(save, "the new bill offers Save draft");
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await act(async () => {
    await tick();
    await tick();
  });
}

const lineAccountText = (row: number) =>
  document.querySelector(`[data-lg-row="${row}"][data-lg-col]`)?.textContent ?? "";

test("a line started by Tab carries the vendor default yet is left out of the save", async (t) => {
  const { posts, done } = await mountNewBill();
  t.after(done);
  assert.match(lineAccountText(0), /6800/, "line 1 takes the vendor's usual account");

  await typeAmount(amountInput(0), "200");
  const controls = lineControls(0);
  await tabFrom(controls[controls.length - 1]!);
  assert.match(lineAccountText(1), /6800/, "the Tab-started line 2 carries the default");

  await saveDraft();
  assert.equal(posts.length, 1, "Save draft writes once");
  const lines = posts[0]!.lines;
  assert.equal(lines.length, 1, "only the line the operator filled is saved");
  assert.equal(lines[0]!.accountId, SHOP_SUPPLIES);
  assert.equal(lines[0]!.amount, "200.0000");
});

test("carried coding alone never makes a line contentful, but an operator's choice does", () => {
  const carried = { accountId: SHOP_SUPPLIES, taxProfileId: "code:gst" };
  const untouched = {
    accountId: SHOP_SUPPLIES,
    taxProfileId: "code:gst",
    amount: "",
    partyDefault: carried,
  };
  assert.equal(isBlankDrawerLine(untouched), true);
  // A zero figure prices nothing either.
  assert.equal(isBlankDrawerLine({ ...untouched, amount: "0.00", quantity: "0" }), true);
  // Recoding, describing or pricing the line is the operator's content.
  for (const content of [
    { accountId: OFFICE },
    { taxProfileId: "code:hst" },
    { description: "Drill bits" },
    { amount: "15" },
    { quantity: "2" },
    { unitPrice: "7.50" },
    { departmentId: "d1" },
  ]) {
    assert.equal(isBlankDrawerLine({ ...untouched, ...content }), false, JSON.stringify(content));
  }
  // An account the operator chose with a zero amount still rides to the
  // server, which refuses it by line name.
  assert.equal(isBlankDrawerLine({ accountId: SHOP_SUPPLIES, amount: "0" }), false);
});
