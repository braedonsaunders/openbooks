import assert from "node:assert/strict";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/cash-sales", matchMediaMatches: false });
const { stubModules } = await import("../testing/stub-modules");
stubModules({
  navigation: true,
  intl: false,
  extra: { sonner: "export const toast={success(){},error(){},warning(){}}" },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { MoneyProvider } = await import("./money-provider");
const { DocumentDrawer } = await import("./document-drawer");
const { DOC_KINDS } = await import("../lib/document-kinds");
const { defaultFormLayout } = await import("@openbooks/customization");
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

test("cash-sale tenders have a separate active body and preserve unresolved code drafts in one dialog", async () => {
  const prior = globalThis.fetch;
  const writes: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") writes.push(String(input));
    return Response.json({ rows: [], attachments: [] });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <DocumentDrawer
              payload={{
                doc: {
                  id: "",
                  kind: "cash_sale",
                  status: "draft",
                  currency: "USD",
                  document_date: "2026-10-05",
                  document_number: "CASH-101",
                  subtotal: "10.00",
                  tax_total: "0.00",
                  total: "10.00",
                  custom: {
                    tenders: [{ kind: "stored_value", accountId: "clearing", amount: "10.00" }],
                  },
                },
                lines: [],
              }}
              config={DOC_KINDS.cash_sale!}
              basePath="/cash-sales"
              accounts={[]}
              departments={[]}
              projects={[]}
              headerDefs={[]}
              lineDefs={[]}
              canCreate
              canPost
              createMode
              layout={defaultFormLayout("cash_sale")}
              tenderAccounts={[{ id: "clearing", number: "1100", name: "Clearing" }]}
              storedValueEnabled
            />
          </MoneyProvider>
        </NextIntlClientProvider>,
      );
      await tick();
    });
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, "the cash-sale record must own one dialog");
    async function tab(label: string) {
      const button = [...dialog!.querySelectorAll("button")].find(
        (node) => node.hasAttribute("aria-pressed") && node.textContent?.trim() === label,
      );
      assert.ok(button, `expected a reachable ${label} tab`);
      await act(async () => {
        button.click();
        await tick();
      });
    }
    assert.equal(
      dialog.querySelector('input[placeholder="' + messages.ar.tenders.codePlaceholder + '"]'),
      null,
      "the unvisited tender editor must not mount beneath the lines body",
    );
    await tab(messages.ar.tenders.title);
    const code = dialog.querySelector<HTMLInputElement>(
      'input[placeholder="' + messages.ar.tenders.codePlaceholder + '"]',
    );
    assert.ok(code, "opening Tenders must expose the stored-value code editor");
    assert.equal(code.closest("[hidden]"), null);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
        code,
        "unresolved-gift-code",
      );
      code.dispatchEvent(new window.Event("input", { bubbles: true }));
      await tick();
    });
    await tab(messages.common.auditTrail.tabs.details);
    assert.ok(code.closest("[hidden]"));
    await tab(messages.ar.tenders.title);
    assert.equal(
      document.querySelector('[role="dialog"]'),
      dialog,
      "switching concepts cannot replace the drawer shell",
    );
    assert.equal(
      dialog.querySelector('input[placeholder="' + messages.ar.tenders.codePlaceholder + '"]'),
      code,
    );
    assert.equal(
      code.value,
      "unresolved-gift-code",
      "an unresolved code draft cannot disappear on a tab switch",
    );
    assert.deepEqual(writes, [], "switching tabs neither saves nor resolves a stored-value code");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = prior;
  }
});

test("a stored close-out reseeds its tender tips, balance and pooled server", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ rows: [], attachments: [] })) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    // Reload shape: tenders from the table carry gross amounts only, while
    // the stored close-out names the per-tender tips, fees and server.
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <DocumentDrawer
              payload={{
                doc: {
                  id: "sale-1",
                  kind: "cash_sale",
                  status: "draft",
                  currency: "USD",
                  document_date: "2026-10-05",
                  document_number: "CASH-102",
                  subtotal: "100.00",
                  tax_total: "0.00",
                  total: "100.00",
                  updated_at: "3",
                  custom: {
                    closeout: {
                      tipsTotal: "12.0000",
                      feeTotal: "2.0000",
                      overShort: "0.0000",
                      serverPartyId: "server-1",
                      parts: [{ position: 1, tip: "12.0000", fee: "2.0000" }],
                    },
                  },
                },
                lines: [
                  {
                    id: "line-1",
                    account_id: "clearing",
                    description: "Till sale",
                    quantity: "1",
                    unit_price: "100.00",
                    amount: "100.00",
                    tax_input_amount: "100.00",
                    tax_amount: "0",
                  },
                ],
                tenders: [
                  {
                    position: 1,
                    kind: "card",
                    methodLabel: "card",
                    accountId: "clearing",
                    amount: "110.00",
                    currency: "USD",
                    reference: null,
                    externalRef: null,
                  },
                ],
              }}
              config={DOC_KINDS.cash_sale!}
              basePath="/cash-sales"
              accounts={[]}
              departments={[]}
              projects={[]}
              headerDefs={[]}
              lineDefs={[]}
              canCreate
              canPost
              initialMode="edit"
              layout={defaultFormLayout("cash_sale")}
              tenderAccounts={[{ id: "clearing", number: "1100", name: "Clearing" }]}
              serverOptions={[{ value: "server-1", label: "Sam Server" }]}
            />
          </MoneyProvider>
        </NextIntlClientProvider>,
      );
      await tick();
    });
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, "the cash-sale record must own one dialog");
    const tabButton = [...dialog!.querySelectorAll("button")].find(
      (node) =>
        node.hasAttribute("aria-pressed") && node.textContent?.trim() === messages.ar.tenders.title,
    );
    assert.ok(tabButton, "expected a reachable Tenders tab");
    await act(async () => {
      tabButton.click();
      await tick();
    });
    const body = dialog!.textContent ?? "";
    const decimalValues = ([...dialog!.querySelectorAll("input")] as HTMLInputElement[])
      .filter((node) => node.placeholder === "0.00")
      .map((node) => node.value);
    // The stored tip and fee read back on their tender instead of blank,
    // and the balance derives total + tips − fees like the kernel.
    assert.ok(
      decimalValues.some((value) => value.includes("12")),
      "the stored card tip must reseed onto its tender",
    );
    assert.ok(
      decimalValues.some((value) => value.includes("2")),
      "the stored processor fee must reseed onto its tender",
    );
    assert.ok(body.includes(messages.ar.tenders.balanced), "reseeded tips must balance the till");
    assert.ok(body.includes("Sam Server"), "the stored server must reseed as the selection");
    // The pooled entry is selectable, so a named server can be cleared.
    const serverTrigger = [...dialog!.querySelectorAll("button")].find((node) =>
      (node.textContent ?? "").includes("Sam Server"),
    );
    assert.ok(serverTrigger, "expected a server picker showing the stored server");
    await act(async () => {
      serverTrigger.click();
      await tick();
    });
    const options = [...document.querySelectorAll('[role="option"]')].map((node) =>
      node.textContent?.trim(),
    );
    assert.ok(
      options.includes(messages.ar.tenders.serverPooled),
      "pooled must be a selectable server entry",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = prior;
  }
});

// A $24.47 tip attributed to Sam Server, with a $2.50 short count on the till.
const STORED_CLOSEOUT = {
  tipsTotal: "24.4700",
  feeTotal: "0.0000",
  overShort: "-2.5000",
  serverPartyId: "server-1",
  parts: [{ position: 1, tip: "24.4700", fee: "0.0000" }],
};

async function mountStoredCashSale(mode: "edit" | "view") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            payload={{
              doc: {
                id: "sale-1",
                kind: "cash_sale",
                status: "draft",
                currency: "USD",
                document_date: "2026-10-05",
                document_number: "CASH-103",
                subtotal: "244.71",
                tax_total: "0.00",
                total: "244.71",
                updated_at: "3",
                custom: { closeout: STORED_CLOSEOUT },
              },
              lines: [
                {
                  id: "line-1",
                  account_id: "clearing",
                  description: "Till sale",
                  quantity: "1",
                  unit_price: "244.71",
                  amount: "244.71",
                  tax_input_amount: "244.71",
                  tax_amount: "0",
                },
              ],
              tenders: [
                {
                  position: 1,
                  kind: "card",
                  methodLabel: "card",
                  accountId: "clearing",
                  amount: "266.68",
                  currency: "USD",
                  reference: null,
                  externalRef: null,
                },
              ],
            }}
            config={DOC_KINDS.cash_sale!}
            basePath="/cash-sales"
            accounts={[]}
            departments={[]}
            projects={[]}
            headerDefs={[]}
            lineDefs={[]}
            canCreate
            canPost
            initialMode={mode}
            layout={defaultFormLayout("cash_sale")}
            tenderAccounts={[{ id: "clearing", number: "1100", name: "Clearing" }]}
            serverOptions={[{ value: "server-1", label: "Sam Server" }]}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog, "the cash-sale record must own one dialog");
  const tabButton = [...dialog.querySelectorAll("button")].find(
    (node) =>
      node.hasAttribute("aria-pressed") && node.textContent?.trim() === messages.ar.tenders.title,
  );
  assert.ok(tabButton, "expected a reachable Tenders tab");
  await act(async () => {
    tabButton.click();
    await tick();
  });
  return {
    dialog,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("clearing the server to Pooled saves an explicit null and keeps the tip", async () => {
  const prior = globalThis.fetch;
  const patches: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ error: "capture only" }, { status: 422 });
    }
    return Response.json({ scripts: [], rows: [], attachments: [] });
  }) as typeof fetch;
  const { dialog, unmount } = await mountStoredCashSale("edit");
  try {
    const serverTrigger = [...dialog.querySelectorAll("button")].find((node) =>
      (node.textContent ?? "").includes("Sam Server"),
    );
    assert.ok(serverTrigger, "expected a server picker showing the stored server");
    await act(async () => {
      serverTrigger.click();
      await tick();
    });
    const pooled = [...document.querySelectorAll('[role="option"]')].find(
      (node) => node.textContent?.trim() === messages.ar.tenders.serverPooled,
    ) as HTMLElement | undefined;
    assert.ok(pooled, "Pooled must be offered as a choice in the server listbox");
    await act(async () => {
      pooled.click();
      await tick();
    });
    const save = [...dialog.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === messages.common.actions.save,
    );
    assert.ok(save, "edit mode must offer Save");
    await act(async () => {
      save.click();
      await tick();
    });
    await tick();
    assert.equal(patches.length, 1, "Save must send exactly one document write");
    const custom = patches[0]!.custom as {
      closeout: Record<string, unknown>;
      tenders: Record<string, unknown>[];
    };
    assert.equal(
      custom.closeout.serverPartyId,
      null,
      "clearing to Pooled must send an explicit null so the stored server is dropped",
    );
    assert.equal(
      custom.tenders[0]!.tipAmount,
      "24.4700",
      "clearing the server must not drop the tip on the tender",
    );
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});

test("view mode shows the stored cash over/short and server read-only", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ scripts: [], rows: [], attachments: [] })) as typeof fetch;
  const { dialog, unmount } = await mountStoredCashSale("view");
  try {
    const body = dialog.textContent ?? "";
    assert.ok(
      body.includes(messages.ar.tenders.overShort),
      "a recorded over/short must show in view mode",
    );
    assert.match(body, /2\.50/, "the recorded short amount must read back in view mode");
    assert.ok(body.includes("Sam Server"), "the recorded server must show in view mode");
    assert.equal(
      dialog.querySelector('input[placeholder="0.00"]'),
      null,
      "view mode must not expose editable close-out fields",
    );
  } finally {
    await unmount();
    globalThis.fetch = prior;
  }
});
