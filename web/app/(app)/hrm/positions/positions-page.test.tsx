import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * Behaviour contract for /hrm/positions creation. The create form posts
 * the form body to the positions route and opens the new row's drawer on
 * success; a refused create pins the refusal instead of swallowing it.
 * Page-shell composition (gates, toolbar, table block, drawer wiring)
 * and the read-service plumbing underneath stay covered by the engine
 * position tests and the route tests, not pinned here.
 */

// jsdom first: the form reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/hrm/positions",
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

declare global {
  var __positionPushes: string[] | undefined;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return { push(url){ globalThis.__positionPushes = [...(globalThis.__positionPushes || []), url] }, refresh(){} }}",
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
// Dynamic: the form resolves next/navigation through the stub above, so
// it must load after the hook registers.
const { PositionCreateForm } = await import("./PositionCreateForm");

const ENTITY_ID = "d726d187-0000-0000-0000-000000000001";

const LABELS = {
  code: "Code",
  title: "Title",
  employer: "Employer",
  department: "Department",
  noDepartment: "No department",
  plannedFte: "Planned FTE",
  status: "Status",
  effectiveFrom: "Effective from",
  reason: "Reason",
  reasonPlaceholder: "Why is this position needed?",
  submit: "Create position",
  failed: "Could not create the position",
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function provider(children: React.ReactNode): React.ReactNode {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {children}
    </NextIntlClientProvider>
  );
}

interface Post {
  url: string;
  method: string;
  body: unknown;
}

function installFetch(handler: (post: Post) => Response): () => void {
  const prior = globalThis.fetch;
  const posts: Post[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const post: Post = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    posts.push(post);
    (globalThis as Record<string, unknown>).__positionPosts = posts;
    return handler(post);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

function posts(): Post[] {
  return ((globalThis as Record<string, unknown>).__positionPosts as Post[] | undefined) ?? [];
}

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function mountForm(): Promise<() => Promise<void>> {
  (globalThis as Record<string, unknown>).__positionPushes = [];
  (globalThis as Record<string, unknown>).__positionPosts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      provider(
        <PositionCreateForm
          basePath="/hrm/positions"
          effectiveDate="2026-09-22"
          employers={[{ value: ENTITY_ID, label: "Main" }]}
          employerRefusal={null}
          departments={[]}
          statuses={[{ value: "planned", label: "Planned" }]}
          labels={LABELS}
        />,
      ),
    );
    await tick();
  });
  await tick();
  return async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  };
}

async function fillAndSubmit(): Promise<void> {
  await act(async () => {
    setInput(document.querySelector("input#position-code") as HTMLInputElement, "ENG-1");
    setInput(document.querySelector("input#position-title") as HTMLInputElement, "Engineer");
    const reason = document.querySelector("textarea#position-reason") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(reason, "Backfill the dinner shift");
    reason.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  const submit = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Create position");
  assert.ok(submit, "the form offers its submit");
  await act(async () => {
    (submit as HTMLElement).click();
    await tick();
  });
  await tick();
}

test("creating a position posts the form body and opens its drawer", async (t) => {
  const restoreFetch = installFetch(() => Response.json({ position: { id: "pos-1" } }));
  t.after(restoreFetch);
  const unmount = await mountForm();
  t.after(unmount);

  await fillAndSubmit();

  assert.deepEqual(posts(), [
    {
      url: "/api/hrm/positions",
      method: "POST",
      body: {
        positionCode: "ENG-1",
        title: "Engineer",
        employerSubsidiaryId: ENTITY_ID,
        departmentId: null,
        plannedFte: "1.0000",
        status: "planned",
        effectiveFrom: "2026-09-22",
        reason: "Backfill the dinner shift",
      },
    },
  ]);
  assert.deepEqual(
    globalThis.__positionPushes,
    ["/hrm/positions?effectiveDate=2026-09-22&position=pos-1"],
    "success navigates to the new row's drawer, keeping the as-of date",
  );
  assert.equal(document.querySelector('[role="alert"]'), null, "no refusal beside success");
});

test("a refused create pins the refusal, never a silent form", async (t) => {
  const refusal = "a position code is already in use — pick a code that is not taken";
  const restoreFetch = installFetch(() => Response.json({ error: refusal }, { status: 409 }));
  t.after(restoreFetch);
  const unmount = await mountForm();
  t.after(unmount);

  await fillAndSubmit();

  assert.equal(posts().length, 1, "the refused body still posted once");
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refusal pins as an accessible alert");
  assert.ok((alert?.textContent ?? "").includes(refusal), "the refusal message renders intact");
  assert.deepEqual(globalThis.__positionPushes, [], "no drawer navigation beside a refusal");
});

test("the create copy ships in every locale", () => {
  for (const locale of ["de", "en", "es", "fr", "ja", "pt-BR", "zh"]) {
    const catalog = JSON.parse(readFileSync(new URL(`../../../../messages/${locale}/hrm.json`, import.meta.url), "utf8")) as {
      positions: { add?: string; create?: Record<string, string> };
    };
    assert.ok(catalog.positions.add, `${locale} carries positions.add`);
    for (const key of ["title", "code", "titleField", "employer", "department", "noDepartment", "plannedFte", "status", "effectiveFrom", "reason", "reasonPlaceholder", "submit", "failed"]) {
      assert.ok(catalog.positions.create?.[key], `${locale} carries positions.create.${key}`);
    }
  }
});
