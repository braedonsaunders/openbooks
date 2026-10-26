import assert from "node:assert/strict";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/contractor-withholding",
  matchMediaMatches: false,
});

const state = { fetches: 0, pushes: [] as string[] };
Object.assign(globalThis, {
  __withholdingTestRouter: {
    push(path: string) {
      state.pushes.push(path);
    },
    refresh() {},
  },
});
globalThis.fetch = (async () => {
  state.fetches += 1;
  throw new Error("unexpected request");
}) as typeof fetch;

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    const source =
      specifier === "@openbooks/ui"
        ? `
      export function Badge(p){return globalThis.React.createElement('span',{},p.children)}
      export function Button(p){return globalThis.React.createElement('button',p,p.children)}
      export function Input(p){return globalThis.React.createElement('input',p)}
      export function Label(p){return globalThis.React.createElement('label',p,p.children)}
      export function Select(p){return globalThis.React.createElement('select',{value:p.value,onChange:p.onChange},p.children)}
    `
        : specifier === "next/navigation"
          ? `
      export function useRouter(){return globalThis.__withholdingTestRouter}
      export function usePathname(){return '/contractor-withholding'}
      export function useSearchParams(){return new URLSearchParams('enrollment=enrollment-1')}
    `
          : specifier === "next/link"
            ? `
      export default function Link(p){return globalThis.React.createElement('a',p,p.children)}
    `
            : specifier === "@/components/paged-table"
              ? `
      export function PagedTable(p){return globalThis.React.createElement('table',{},globalThis.React.createElement('tbody',{},p.rows.map((row,index)=>globalThis.React.createElement('tr',{key:index},p.columns.map(column=>globalThis.React.createElement('td',{key:column.key},typeof column.cell==='function'?column.cell(row):''))))))}
    `
              : specifier === "@/components/async-url-drawer"
                ? `
      export function AsyncUrlDrawer(p){return p.open?globalThis.React.createElement('section',{},p.children):null}
    `
                : specifier === "@/components/money-provider"
                  ? `
      export function useMoney(){return {money(value){return String(value)}}}
    `
                  : specifier === "@/components/date-field"
                    ? `
      export function DateField(p){return globalThis.React.createElement('input',{value:p.value,onChange:e=>p.onChange(e.target.value)})}
    `
                    : specifier === "@/components/doc-type-badge"
                      ? `
      export function DocTypeBadge(p){return globalThis.React.createElement('span',{},p.kind)}
    `
                      : specifier === "@/components/drawer-tab-strip"
                        ? `
      export function DrawerTabStrip(){return null}
    `
                        : specifier === "@/lib/confirm"
                          ? `
      export async function confirmDialog(){return false}
    `
                          : specifier === "@/lib/prompt"
                            ? `
      export async function promptDialog(){return null}
    `
                            : specifier === "@/lib/api-error"
                              ? `
      export async function readApiErrorMessage(){return 'Request failed'}
    `
                              : null;
    if (source === null) return next(specifier, context);
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { WithholdingWorkspace } = await import("./WithholdingWorkspace");

test("server-provided period rows render without a client fetch waterfall", async (t) => {
  state.fetches = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    for (const node of [...document.body.children]) node.remove();
  });

  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <WithholdingWorkspace
          enrollments={[
            {
              id: "enrollment-1",
              subsidiaryId: "entity-1",
              entityName: "North",
              schemeCode: "CA-ON",
              contractorReference: "123",
              currency: "CAD",
              schemeName: "Ontario",
              returnKind: "statutory_periodic",
              filingNotice: "",
              canDeposit: false,
            },
          ]}
          canManage={false}
          canReadJournal={false}
          standings={[]}
          selected="enrollment-1"
          activeTab="periods"
          periods={[
            {
              periodStart: "2026-01-01",
              periodEnd: "2026-01-31",
              returnDue: "2026-02-15",
              paymentDue: null,
              deductionCount: 1,
              deducted: "25.00",
              latestReturn: null,
              changedSinceFiled: false,
            },
          ]}
          deposits={[]}
          loadFailure={null}
          returnId={null}
        />
      </NextIntlClientProvider>,
    );
  });

  assert.match(host.textContent ?? "", /2026-01-01/);
  assert.match(host.textContent ?? "", /25\.00/);
  assert.equal(state.fetches, 0);
});
