import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

declare global {
  var __allocGateRouter: { push(url: string): void; refresh(): void } | undefined;
}

// Entry distributions belong to the Allocations module. A bill editor in an
// organization without the module must never call the entry-candidates
// endpoint (which refuses while the module is off); only a host that states
// the gate is on queries it.
const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/ap/bills", matchMediaMatches: false });

stubModules({ navigation: { source: 'export function useRouter(){return globalThis.__allocGateRouter}export function usePathname(){return \'/ap/bills\'}export function useSearchParams(){return new URLSearchParams()}' }, intl: false, authz: false, features: false });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return { shortCircuit: true, url: "data:text/javascript,export default function Link(p){return p.children}" };
    }
    if (specifier === "sonner") {
      return { shortCircuit: true, url: "data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}" };
    }
    if (specifier === "@/lib/confirm" || specifier.endsWith("/lib/confirm")) {
      return { shortCircuit: true, url: "data:text/javascript,export async function confirmDialog(){return true}" };
    }
    if (specifier === "@/lib/prompt" || specifier.endsWith("/lib/prompt")) {
      return { shortCircuit: true, url: "data:text/javascript,export async function promptDialog(){return null}" };
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function candidateCalls(allocationsEntryEnabled: boolean | undefined, t: import("node:test").TestContext): Promise<number> {
  globalThis.__allocGateRouter = { push() {}, refresh() {} };
  const calls: string[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return url.startsWith("/api/allocations/entry-candidates") ? Response.json({ rules: [] }) : Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    globalThis.fetch = prior;
    await act(async () => root.unmount());
    host.remove();
  });
  const doc = {
    id: randomUUID(),
    kind: "vendor_bill",
    status: "draft",
    document_number: "BILL-00001",
    currency: "USD",
    updated_at: "2026-09-17T12:00:00.000000Z",
    document_date: "2026-09-17",
    subtotal: "0.00",
    tax_total: "0.00",
    total: "0.00",
  };
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            payload={{ doc, lines: [] }}
            config={DOC_KINDS["vendor_bill"]!}
            basePath="/ap/bills"
            parties={[]}
            accounts={[]}
            taxCodes={[]}
            taxGroups={[]}
            departments={[]}
            projects={[]}
            locations={[]}
            classes={[]}
            items={[]}
            subsidiaries={[]}
            headerDefs={[]}
            lineDefs={[]}
            segments={[]}
            canCreate
            canPost={false}
            initialMode="edit"
            allocationsEntryEnabled={allocationsEntryEnabled}
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
  return calls.filter((url) => url.startsWith("/api/allocations/entry-candidates")).length;
}

test("a bill editor with Allocations off never queries entry candidates", async (t) => {
  assert.equal(await candidateCalls(false, t), 0);
});

test("a host that does not state the Allocations gate fails closed", async (t) => {
  assert.equal(await candidateCalls(undefined, t), 0);
});

test("with entry distributions on the editor queries its candidates", async (t) => {
  assert.ok(await candidateCalls(true, t) > 0);
});
