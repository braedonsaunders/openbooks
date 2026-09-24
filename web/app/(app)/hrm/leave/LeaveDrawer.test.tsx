import assert from "node:assert/strict";
import test from "node:test";

// OM-11: managers could not file leave on an employee's behalf — the drawer
// posted without onBehalf and offered no manager mode, while the engine
// refusal named a remedy the UI could not perform. The drawer now renders
// an explicit on-behalf mode (visible only when the actor holds manageable
// employments) with an employee picker limited to those employments, and
// posts onBehalf: true with the chosen employmentId. Self-service actors
// never see the mode and post without onBehalf.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/hrm/leave",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}
if (typeof window.requestAnimationFrame !== "function") {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__leaveRouter}export function usePathname(){return '/hrm/leave'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
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
    if (specifier === "./confirm" || (typeof specifier === "string" && specifier.endsWith("/lib/confirm"))) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return globalThis.__leaveConfirmVerdict}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { LeaveDrawer } = await import("./LeaveDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const TYPE_ID = "00000000-0000-4000-8000-000000000022";
const REQUEST_ID = "00000000-0000-4000-8000-000000000032";
// Two employments the manager may manage, plus one they may not: the
// picker must name exactly the manageable two, never the third.
const MANAGED_A = "00000000-0000-4000-8000-0000000000a1";
const MANAGED_B = "00000000-0000-4000-8000-0000000000a2";
const UNMANAGED = "00000000-0000-4000-8000-0000000000b9";
// The actor's own employments: self-service files only through these ids,
// never a free-text uuid.
const OWN_A = "00000000-0000-4000-8000-0000000000c1";
const OWN_B = "00000000-0000-4000-8000-0000000000c2";

interface Script {
  posts: Array<{ url: string; body: unknown }>;
}

function installFetch(script: Script, manageable: boolean, own: "two" | "one" | "none" = "two"): () => void {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url === `/api/hrm/leave-requests/${REQUEST_ID}` && (init?.method ?? "GET") === "GET") {
      return Response.json({
        request: { id: REQUEST_ID, employmentId: OWN_A, leaveTypeCode: "PPL-VAC", startsOn: "2026-10-20", endsOn: "2026-10-21", hours: "8", reason: null, status: "submitted", decidedBy: null, decisionReason: null },
        timeBalance: null, valueBalances: [], asOf: "2026-10-01",
      });
    }
    if (url.includes("/api/hrm/options?source=leave-types")) {
      return Response.json({ options: [{ id: TYPE_ID, label: "PPL-VAC — Vacation" }] });
    }
    if (url.includes("/api/hrm/options?source=leave-own-employments")) {
      const options =
        own === "two"
          ? [
              { id: OWN_A, label: "Quinn Vidal · Main · Nurse" },
              { id: OWN_B, label: "Rae Smith · Main · Clerk" },
            ]
          : own === "one"
            ? [{ id: OWN_A, label: "Quinn Vidal · Main · Nurse" }]
            : [];
      return Response.json({ options });
    }
    if (url.includes("/api/hrm/options?source=leave-filing-employments")) {
      if (!manageable) return Response.json({ error: "denied" }, { status: 403 });
      return Response.json({
        options: [
          { id: MANAGED_A, label: "Quinn Vidal · Main · Nurse" },
          { id: MANAGED_B, label: "Rae Smith · Main · Clerk" },
        ],
      });
    }
    if (url === "/api/hrm/leave-requests" && init?.method === "POST") {
      script.posts.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ request: { id: "request-1", status: "draft" } });
    }
    return Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function mountFiling(requestId: string | null = null, onClose: () => void = () => {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <LeaveDrawer requestId={requestId} canWithdrawCancel onClose={onClose} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("leave request details render a localized status name", async (t) => {
  (globalThis as Record<string, unknown>).__leaveRouter = { push() {}, refresh() {} };
  const restoreFetch = installFetch({ posts: [] }, true);
  t.after(restoreFetch);
  const { unmount } = await mountFiling(REQUEST_ID);
  t.after(unmount);

  assert.match(document.body.textContent ?? "", /Submitted/);
  assert.doesNotMatch(document.body.textContent ?? "", /\bsubmitted\b/);
});

function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function setSelect(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("change", { bubbles: true }));
}

// The shared Select renders a visible trigger (carrying the id) plus a
// hidden native <select> proxying the change event. Drive the native leg —
// the component's own pick() path — rather than the dropdown sheet.
function nativeSelectFor(id: string): HTMLSelectElement {
  const trigger = document.getElementById(id);
  assert.ok(trigger, `expected a select trigger with id ${id}`);
  const native = trigger.closest("span")?.querySelector("select");
  assert.ok(native, `expected a native select behind the ${id} trigger`);
  return native as HTMLSelectElement;
}

function radios(): HTMLInputElement[] {
  return [...document.querySelectorAll('input[name="leave-filing-for"]')] as HTMLInputElement[];
}

function radioLabels(): string[] {
  return radios().map((radio) => radio.closest("label")?.textContent?.trim() ?? "");
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

test("a manager-capable actor sees the on-behalf mode and files with onBehalf", async (t) => {
  (globalThis as Record<string, unknown>).__leaveRouter = { push() {}, refresh() {} };
  const script: Script = { posts: [] };
  const restoreFetch = installFetch(script, true);
  t.after(restoreFetch);
  const { unmount } = await mountFiling();
  t.after(unmount);

  // The mode names both shapes, and the hint points at the mode — the form
  // itself is the pointer the old refusal lacked.
  assert.deepEqual(radioLabels(), ["My own leave", "On behalf of an employee"]);
  assert.match(document.body.textContent ?? "", /with you recorded as the filer/);

  // The on-behalf picker lists exactly the manageable employments: the two
  // ids the capability probe returned, never the unmanaged third.
  await click(radios()[1]!);
  assert.ok(
    document.getElementById("leave-onbehalf-employment"),
    "the on-behalf mode names the target employee in a picker",
  );
  const picker = nativeSelectFor("leave-onbehalf-employment");
  const values = [...picker.querySelectorAll("option")].map((o) => o.value);
  assert.deepEqual(values, ["", MANAGED_A, MANAGED_B]);
  assert.ok(!values.includes(UNMANAGED), "the picker never offers an unmanageable employment");

  await act(async () => {
    setSelect(picker, MANAGED_A);
    await tick();
  });
  const typePicker = nativeSelectFor("leave-type");
  await act(async () => {
    setSelect(typePicker, TYPE_ID);
    await tick();
  });
  await act(async () => {
    setInput(document.querySelector("input#leave-starts") as HTMLInputElement, "2026-10-20");
    setInput(document.querySelector("input#leave-ends") as HTMLInputElement, "2026-10-21");
    setInput(document.querySelector("input#leave-hours") as HTMLInputElement, "8");
    setInput(document.querySelector("textarea#leave-reason") as HTMLTextAreaElement, "covering the ward");
    await tick();
  });
  await click(buttonNamed("New request"));

  assert.equal(script.posts.length, 1, "filing posts exactly once");
  assert.deepEqual(script.posts[0]!.body, {
    employmentId: MANAGED_A,
    leaveTypeId: TYPE_ID,
    startsOn: "2026-10-20",
    endsOn: "2026-10-21",
    hours: "8",
    reason: "covering the ward",
    onBehalf: true,
  });
});

test("the on-behalf mode refuses to file without naming the employee", async (t) => {
  (globalThis as Record<string, unknown>).__leaveRouter = { push() {}, refresh() {} };
  const script: Script = { posts: [] };
  const restoreFetch = installFetch(script, true);
  t.after(restoreFetch);
  const { unmount } = await mountFiling();
  t.after(unmount);

  await click(radios()[1]!);
  await click(buttonNamed("New request"));

  assert.equal(script.posts.length, 0, "no POST leaves without a named target employee");
  assert.match(document.body.textContent ?? "", /Pick the employee this request is filed for/);
});

test("a self-service actor has no mode and posts without onBehalf", async (t) => {
  (globalThis as Record<string, unknown>).__leaveRouter = { push() {}, refresh() {} };
  const script: Script = { posts: [] };
  const restoreFetch = installFetch(script, false);
  t.after(restoreFetch);
  const { unmount } = await mountFiling();
  t.after(unmount);

  // The 403 capability probe is the self-service shape, not an error: no
  // mode, no alert — and the employment is a picker over the actor's own
  // employments, never a free-text uuid.
  assert.deepEqual(radios(), [], "a self-service actor never sees the on-behalf mode");
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(document.querySelector("input#leave-employment") === null, true, "no uuid text input remains");
  const employmentPicker = nativeSelectFor("leave-employment");
  assert.deepEqual(
    [...employmentPicker.querySelectorAll("option")].map((o) => o.value),
    ["", OWN_A, OWN_B],
    "the picker names exactly the actor's own employments",
  );

  await act(async () => {
    setSelect(employmentPicker, OWN_B);
    await tick();
  });
  const typePicker = nativeSelectFor("leave-type");
  await act(async () => {
    setSelect(typePicker, TYPE_ID);
    await tick();
  });
  await act(async () => {
    setInput(document.querySelector("input#leave-starts") as HTMLInputElement, "2026-10-20");
    setInput(document.querySelector("input#leave-ends") as HTMLInputElement, "2026-10-21");
    setInput(document.querySelector("input#leave-hours") as HTMLInputElement, "8");
    setInput(document.querySelector("textarea#leave-reason") as HTMLTextAreaElement, "rest");
    await tick();
  });
  await click(buttonNamed("New request"));

  assert.equal(script.posts.length, 1);
  const body = script.posts[0]!.body as Record<string, unknown>;
  assert.ok(!("onBehalf" in body), "self-service filing posts without onBehalf");
  assert.equal(body.employmentId, OWN_B);
});

test("self-service filing refuses to save without naming the employment", async (t) => {
  (globalThis as Record<string, unknown>).__leaveRouter = { push() {}, refresh() {} };
  const script: Script = { posts: [] };
  const restoreFetch = installFetch(script, false);
  t.after(restoreFetch);
  const { unmount } = await mountFiling();
  t.after(unmount);

  await click(buttonNamed("New request"));

  assert.equal(script.posts.length, 0, "no POST leaves without a named employment");
  assert.match(document.body.textContent ?? "", /Pick the employment this request is filed for/);
});

test("a rejected filing request shows failure and releases the submit button", async (t) => {
  (globalThis as Record<string, unknown>).__leaveRouter = { push() {}, refresh() {} };
  const script: Script = { posts: [] };
  const restoreFetch = installFetch(script, false, "one");
  t.after(restoreFetch);
  const { unmount } = await mountFiling();
  t.after(unmount);
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url === "/api/hrm/leave-requests" && init?.method === "POST") throw new Error("network unavailable");
    return priorFetch(input, init);
  }) as typeof fetch;

  await act(async () => {
    setSelect(nativeSelectFor("leave-type"), TYPE_ID);
    setInput(document.querySelector("input#leave-starts") as HTMLInputElement, "2026-10-20");
    setInput(document.querySelector("input#leave-ends") as HTMLInputElement, "2026-10-21");
    setInput(document.querySelector("input#leave-hours") as HTMLInputElement, "8");
    await tick();
  });
  await click(buttonNamed("New request"));

  assert.equal(buttonNamed("New request").disabled, false, "the submit button must be available for retry");
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /The request could not be filed/);
});

test("filing Cancel keeps edited values until discard is confirmed", async (t) => {
  (globalThis as Record<string, unknown>).__leaveRouter = { push() {}, refresh() {} };
  (globalThis as Record<string, unknown>).__leaveConfirmVerdict = false;
  const restoreFetch = installFetch({ posts: [] }, false, "one");
  t.after(restoreFetch);
  let closes = 0;
  const { unmount } = await mountFiling(null, () => { closes += 1 });
  t.after(unmount);

  const reason = document.querySelector("textarea#leave-reason") as HTMLTextAreaElement;
  await act(async () => {
    setInput(reason, "Keep this leave request draft");
    await tick();
  });
  await click(buttonNamed("Cancel"));

  assert.equal(closes, 0, "declining discard keeps the drawer open");
  assert.equal((document.querySelector("textarea#leave-reason") as HTMLTextAreaElement).value, "Keep this leave request draft");

  (globalThis as Record<string, unknown>).__leaveConfirmVerdict = true;
  await click(buttonNamed("Cancel"));
  assert.equal(closes, 1, "confirmed discard closes the drawer");
});

test("a single own employment preselects, and none explains instead of an empty picker", async (t) => {
  (globalThis as Record<string, unknown>).__leaveRouter = { push() {}, refresh() {} };
  const script: Script = { posts: [] };
  const restoreFetch = installFetch(script, false, "one");
  t.after(restoreFetch);
  const first = await mountFiling();
  try {
    const picker = nativeSelectFor("leave-employment");
    assert.equal((picker as HTMLSelectElement).value, OWN_A, "the single employment preselects");
  } finally {
    await first.unmount();
  }
  restoreFetch();
  const restoreEmpty = installFetch(script, false, "none");
  t.after(restoreEmpty);
  const second = await mountFiling();
  try {
    assert.equal(document.getElementById("leave-employment"), null, "no empty picker renders");
    assert.match(
      document.body.textContent ?? "",
      /None of your employments can take leave requests/,
      "the empty shape names the remedy",
    );
  } finally {
    await second.unmount();
  }
});
