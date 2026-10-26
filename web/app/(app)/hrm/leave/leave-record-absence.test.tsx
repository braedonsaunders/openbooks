import assert from "node:assert/strict";
import test from "node:test";

// Manager absence recording: the form names its basis, shows the
// remaining-balance effect before saving, and confirms through the native
// mutation result (the saved record opens on the calendar, never a silent
// close). Calendar absence days open the same drawer on the fact.

const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/hrm/leave",
  matchMediaMatches: false,
  resizeObserver: false,
});

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation:
    "export function useRouter(){return globalThis.__leaveRouter}export function usePathname(){return '/hrm/leave'}export function useSearchParams(){return new URLSearchParams()}",
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (typeof specifier === "string" && specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return null}",
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
const messages = (await import("../../../../messages/en")).default;
const { LeaveDrawer } = await import("./LeaveDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const TYPE_ID = "00000000-0000-4000-8000-000000000022";
const EMP = "00000000-0000-4000-8000-0000000000a1";
const ABSENCE_ID = "00000000-0000-4000-8000-0000000000d1";

interface Script {
  posts: Array<{ url: string; body: unknown }>;
  balanceUrls: string[];
}

function installFetch(script: Script): () => void {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.includes("/api/hrm/options?source=leave-types")) {
      return Response.json({ options: [{ id: TYPE_ID, label: "VAC — Vacation" }] });
    }
    if (url.includes("/api/hrm/options?source=leave-filing-employments")) {
      return Response.json({ options: [{ id: EMP, label: "Mateo Cruz · Main · Porter" }] });
    }
    if (url.startsWith("/api/hrm/leave-balances?")) {
      script.balanceUrls.push(url);
      return Response.json({
        balances: [
          {
            leaveTypeId: TYPE_ID,
            code: "VAC",
            name: "Vacation",
            entitlement: "120",
            taken: "8",
            pending: "0",
            remaining: "112",
            balance: "112",
            unlimited: false,
          },
        ],
        asOf: "2026-08-03",
        effect: { leaveTypeId: TYPE_ID, remainingAfter: "104" },
      });
    }
    if (url === "/api/hrm/leave-absences" && init?.method === "POST") {
      script.posts.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({
        absence: {
          id: ABSENCE_ID,
          employmentId: EMP,
          onDate: "2026-08-03",
          hours: "8",
          leaveTypeCode: "VAC",
          source: "recorded",
          reason: "approved verbally by the owner",
        },
      });
    }
    if (url === `/api/hrm/leave-absences/${ABSENCE_ID}` && (init?.method ?? "GET") === "GET") {
      return Response.json({
        absence: {
          id: ABSENCE_ID,
          employmentId: EMP,
          onDate: "2026-08-03",
          hours: "8",
          leaveTypeCode: "VAC",
          leaveTypeName: "Vacation",
          workerName: "Mateo Cruz",
          source: "recorded",
          reason: "approved verbally by the owner",
          leaveRequestId: null,
          recordedAt: "2026-10-11T10:00:00.000Z",
        },
      });
    }
    return Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function setSelect(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function nativeSelectFor(id: string): HTMLSelectElement {
  const trigger = document.getElementById(id);
  assert.ok(trigger, `expected a select trigger with id ${id}`);
  const native = trigger.closest("span")?.querySelector("select");
  assert.ok(native, `expected a native select behind the ${id} trigger`);
  return native as HTMLSelectElement;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
    await tick();
  });
  await tick();
}

function buttonNamed(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement | undefined;
  assert.ok(found, `expected a button named ${name}`);
  return found;
}

function makeRouter() {
  const pushes: string[] = [];
  (globalThis as Record<string, unknown>).__leaveRouter = {
    push(url: string) {
      pushes.push(url);
    },
    refresh() {},
  };
  return pushes;
}

async function mountRecord(
  t: { after: (fn: () => void | Promise<void>) => void },
  absenceId: string | null = null,
) {
  const restoreFetch = installFetch({ posts: [], balanceUrls: [] });
  t.after(restoreFetch);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <LeaveDrawer
          requestId={null}
          absenceId={absenceId}
          canWithdrawCancel={false}
          record={absenceId === null}
          onClose={() => {}}
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
}

async function fillRecordForm() {
  const employmentPicker = nativeSelectFor("leave-record-employment");
  await act(async () => {
    setSelect(employmentPicker, EMP);
    await tick();
  });
  const typePicker = nativeSelectFor("leave-record-type");
  await act(async () => {
    setSelect(typePicker, TYPE_ID);
    await tick();
  });
  await act(async () => {
    setInput(document.querySelector("input#leave-record-date") as HTMLInputElement, "2026-08-03");
    setInput(document.querySelector("input#leave-record-hours") as HTMLInputElement, "8");
    setInput(
      document.querySelector("textarea#leave-record-reason") as HTMLTextAreaElement,
      "approved verbally by the owner",
    );
    await tick();
  });
  // The balance effect rides a debounced fetch behind the typing.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450));
  });
}

test("the record form names its basis and posts it with the save", async (t) => {
  const pushes = makeRouter();
  const script: Script = { posts: [], balanceUrls: [] };
  const restoreFetch = installFetch(script);
  t.after(restoreFetch);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <LeaveDrawer requestId={null} canWithdrawCancel={false} record onClose={() => {}} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  assert.match(document.body.textContent ?? "", /Why this absence is recorded/);
  await fillRecordForm();
  await click(buttonNamed("Record absence"));

  assert.equal(script.posts.length, 1, "the recording posts exactly once");
  assert.deepEqual(script.posts[0]!.body, {
    employmentId: EMP,
    leaveTypeId: TYPE_ID,
    onDate: "2026-08-03",
    hours: "8",
    reason: "approved verbally by the owner",
  });
  assert.equal(
    pushes.length,
    1,
    "the save confirms by opening the saved record, never a silent close",
  );
  const opened = new URL(pushes[0]!, "https://openbooks.test");
  assert.equal(opened.pathname, "/hrm/leave");
  assert.equal(opened.searchParams.get("view"), "calendar");
  assert.equal(opened.searchParams.get("from"), "2026-08-01");
  assert.equal(opened.searchParams.get("to"), "2026-08-31");
  assert.equal(
    opened.searchParams.get("absence"),
    ABSENCE_ID,
    "the record is visible and selected through the mutation result",
  );
});

test("a back-dated day marks the reason required and refuses an empty basis without posting", async (t) => {
  makeRouter();
  const script: Script = { posts: [], balanceUrls: [] };
  const restoreFetch = installFetch(script);
  t.after(restoreFetch);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <LeaveDrawer requestId={null} canWithdrawCancel={false} record onClose={() => {}} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  const reason = document.querySelector("textarea#leave-record-reason") as HTMLTextAreaElement;
  assert.ok(reason, "the record form carries a reason field");
  assert.equal(reason.required, false, "no date yet — nothing is visibly required");
  await act(async () => {
    setInput(document.querySelector("input#leave-record-date") as HTMLInputElement, "2020-01-01");
    await tick();
  });
  assert.equal(
    (document.querySelector("textarea#leave-record-reason") as HTMLTextAreaElement).required,
    true,
    "a back-dated day marks the basis required",
  );
  await click(buttonNamed("Record absence"));
  assert.equal(script.posts.length, 0, "an empty basis never posts");
  assert.match(document.body.textContent ?? "", /Why this absence is recorded/);
});

test("the form shows the remaining-balance effect before saving", async (t) => {
  makeRouter();
  const restoreFetch = installFetch({ posts: [], balanceUrls: [] });
  t.after(restoreFetch);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <LeaveDrawer requestId={null} canWithdrawCancel={false} record onClose={() => {}} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  await fillRecordForm();
  assert.match(
    document.body.textContent ?? "",
    /VAC remaining: 112 h → 104 h after recording/,
    "the manager sees the exact effect before saving",
  );
});

test("a calendar absence opens its record with the basis", async (t) => {
  makeRouter();
  await mountRecord(t, ABSENCE_ID);
  assert.match(document.body.textContent ?? "", /Mateo Cruz/);
  assert.match(document.body.textContent ?? "", /approved verbally by the owner/);
  assert.match(document.body.textContent ?? "", /Recorded/);
  assert.match(document.body.textContent ?? "", /Recorded absence/);
});
