import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

// The vendor compliance class edits with the record: read-only until the
// drawer is in edit mode, saved by the drawer's single Save, and a refused
// save names the failure on the panel — never "[object Object]".

await bootJsdomEnvironment({ url: "http://localhost:4800/parties?party=party-1", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return {push(){},refresh(){},replace(){},prefetch(){},back(){},forward(){}}}" +
      "export function usePathname(){return '/parties'}" +
      "export function useSearchParams(){return new URLSearchParams()}" +
      "export function redirect(){throw new Error('redirect')}" +
      "export function notFound(){throw new Error('not-found')}" +
      "export function permanentRedirect(){throw new Error('redirect')}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return globalThis.React.createElement('a',{href:p.href},p.children)}",
    sonner: "export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}",
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { VendorCompliancePanel } = await import("./VendorCompliancePanel");
const { RecordSaveContext, useRecordSaveRegistry } = await import("../../../components/record-save-participants");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const CLASSES = [{ id: "c1", code: "C1", name: "Class one" }];

type Registry = ReturnType<typeof useRecordSaveRegistry>;
let recordSave: Registry | null = null;

function RecordHost({ children }: { children: React.ReactNode }) {
  const registry = useRecordSaveRegistry(true);
  recordSave = registry;
  return <RecordSaveContext.Provider value={registry.context}>{children}</RecordSaveContext.Provider>;
}

async function mount(editable: boolean, initialClassId: string | null = null) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <RecordHost>
          <VendorCompliancePanel partyId="party-1" initialClassId={initialClassId} classes={CLASSES} editable={editable} />
        </RecordHost>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      recordSave = null;
    },
  };
}

function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function stubFetch(response: () => Response, seen: Array<{ url: string; body: unknown }>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return response();
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

test("outside edit mode the class reads as a value with no picker and no Save", async (t) => {
  const view = await mount(false, "c1");
  t.after(view.done);
  assert.equal(view.host.querySelector("select"), null, "view mode offers no picker");
  assert.ok(view.host.textContent?.includes("C1 — Class one"), "the assigned class reads as a value");
  assert.equal([...view.host.querySelectorAll("button")].filter((button) => button.textContent === "Save").length, 0);
});

test("in edit mode the class saves through the record's single Save", async (t) => {
  const seen: Array<{ url: string; body: unknown }> = [];
  t.after(stubFetch(() => Response.json({ ok: true }), seen));
  const view = await mount(true);
  t.after(view.done);
  assert.equal([...view.host.querySelectorAll("button")].filter((button) => button.textContent === "Save").length, 0, "no Save of its own");
  await act(async () => {
    choose(view.host.querySelector("select")!, "c1");
    await tick();
  });
  assert.equal(recordSave?.dirty, true, "choosing a class marks the record dirty");
  let result: Awaited<ReturnType<Registry["saveAll"]>> | null = null;
  await act(async () => {
    result = await recordSave!.saveAll();
    await tick();
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen, [{ url: "/api/compliance/vendors/party-1", body: { complianceClassId: "c1" } }]);
  assert.equal(recordSave?.dirty, false, "the saved class becomes the baseline");
});

test("an object error payload names the save failure on the panel, never [object Object]", async (t) => {
  t.after(stubFetch(() => new Response(JSON.stringify({ error: { code: "LOCKED", fields: ["complianceClassId"] } }), {
    status: 422,
    headers: { "content-type": "application/json" },
  }), []));
  const view = await mount(true);
  t.after(view.done);
  await act(async () => {
    choose(view.host.querySelector("select")!, "c1");
    await tick();
  });
  let result: Awaited<ReturnType<Registry["saveAll"]>> | null = null;
  await act(async () => {
    result = await recordSave!.saveAll();
    await tick();
  });
  assert.deepEqual(result, { ok: false, key: "compliance" }, "the refusal keeps the record in edit mode on this tab");
  const text = view.host.textContent ?? "";
  assert.ok(text.includes("Saving the compliance class failed."), "the panel names the failure");
  assert.ok(!text.includes("[object Object]"));
  assert.equal(recordSave?.dirty, true, "the refused choice stays on the record");
});
