// Bulk approval selects submitted weeks and reports per-week results:
// approved weeks count, refused weeks name their typed refusal and remedy.
import assert from "node:assert/strict";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/timesheets", matchMediaMatches: false });

const script = {
  posts: [] as { url: string; body: unknown }[],
  status: 200 as number,
  body: {} as Record<string, unknown>,
};
Object.assign(globalThis, {
  __bulkApprove: script,
  __bulkApproveRouter: { push() {}, replace() {}, refresh() {} },
});

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__bulkApproveRouter}export function usePathname(){return '/timesheets'}export function useSearchParams(){return new URLSearchParams()}",
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link":
      "export default function Link(p){return globalThis.React.createElement('a',{href:p.href,className:p.className},p.children)}",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { TimesheetBulkApprove } = await import("./TimesheetBulkApprove");

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const WEEKS = [
  { employeeId: "emp-1", weekStart: "2026-07-12", personName: "Crew One", hours: "8" },
  { employeeId: "emp-2", weekStart: "2026-07-12", personName: "Crew Two", hours: "6" },
];

async function mount() {
  script.posts = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url === "/api/timesheets/approve/bulk" && init?.method === "POST") {
      script.posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(script.body), {
        status: script.status,
        headers: { "content-type": "application/json" },
      });
    }
    return Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(
        NextIntlClientProvider,
        { locale: "en", messages, timeZone: "UTC" },
        React.createElement(TimesheetBulkApprove, { weeks: WEEKS }),
      ),
    );
    await tick();
  });
  await tick(60);
  return {
    cleanup: async () => {
      globalThis.fetch = prior;
      await act(async () => {
        root.unmount();
      });
      host.remove();
      for (const node of [...document.body.children]) node.remove();
    },
  };
}

function checkboxFor(name: string): HTMLInputElement | undefined {
  return [...document.querySelectorAll('input[type="checkbox"]')].find(
    (box) => (box as HTMLInputElement).getAttribute("aria-label")?.includes(name),
  ) as HTMLInputElement | undefined;
}

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === name,
  ) as HTMLButtonElement | undefined;
}

test("bulk approval posts the selection and reports per-week results", async (t) => {
  script.status = 200;
  script.body = {
    results: [
      { employee: "emp-1", week: "2026-07-12", ok: true },
      {
        employee: "emp-2", week: "2026-07-12", ok: false,
        error: "week already approved by Supervisor on 2026-07-20 — reopen or amend the week to change it",
        code: "already_approved",
        remedy: "Reopen or amend the week to change approved hours.",
      },
    ],
  };
  const { cleanup } = await mount();
  t.after(cleanup);
  t.after(() => {
    script.status = 200;
    script.body = {};
  });

  assert.ok(checkboxFor("Crew One"), "each submitted week has a checkbox");
  await act(async () => {
    checkboxFor("Crew One")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(60);
  });
  await act(async () => {
    checkboxFor("Crew Two")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(60);
  });
  const approve = buttonNamed("Approve selected");
  assert.ok(approve, "Approve selected renders");
  await act(async () => {
    approve.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(120);
  });
  await tick(120);

  assert.equal(script.posts.length, 1, "one bulk request for the selection");
  assert.deepEqual((script.posts[0]!.body as { weeks: unknown }).weeks, [
    { employee: "emp-1", week: "2026-07-12" },
    { employee: "emp-2", week: "2026-07-12" },
  ]);
  const text = document.body.textContent ?? "";
  assert.match(text, /1 week approved/);
  assert.match(text, /1 week needs attention/);
  assert.match(text, /already approved/);
  assert.match(text, /Reopen or amend/);
});
