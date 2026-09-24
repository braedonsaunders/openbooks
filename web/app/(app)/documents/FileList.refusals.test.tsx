import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __fileToasts: { kind: string; message: string }[] | undefined;
  var __fileRefreshed: boolean | undefined;
}

// F4-2: selecting 5 files where the caller lacks manager on 2 used to toast
// the deleted count as full success, clear the whole selection and refresh —
// the 2 skipped files looked trashed but remained. A partial bulk must toast
// moved + skipped counts with the reasons, keep exactly the refused rows
// selected, and name a refused whole-bulk through the server message.

// jsdom first: the list reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/documents",
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

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(){},refresh(){globalThis.__fileRefreshed=true},replace(){}}}export function usePathname(){return '/documents'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(){return null}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__fileToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__fileToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    if (specifier === "../../../lib/confirm") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { FileList } = await import("./FileList");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response> | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

const FILES = [
  { id: "f1", name: "a.txt", fileType: "text", sizeLabel: "1 KB", modifiedLabel: "today", versionCount: 1, folderName: null },
  { id: "f2", name: "b.txt", fileType: "text", sizeLabel: "1 KB", modifiedLabel: "today", versionCount: 1, folderName: null },
];

async function renderList() {
  document.body.innerHTML = "";
  globalThis.__fileRefreshed = false;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <FileList
          folders={[]}
          files={FILES}
          showLocation={false}
          canEdit={true}
          canDelete={true}
          currentParams={{}}
          sort="name"
          dir="asc"
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
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

test("a partial bulk delete toasts moved + skipped, keeps the refused rows selected", async (t) => {
  globalThis.__fileToasts = [];
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/file-cabinet/bulk" && init?.method === "POST") {
      return Response.json({
        ok: true,
        done: 1,
        skipped: 1,
        results: [
          { id: "f1", kind: "file", ok: true },
          { id: "f2", kind: "file", ok: false, error: "forbidden" },
        ],
      });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await renderList();
  t.after(unmount);

  const selectAll = document.querySelector('input[aria-label="Select all"]');
  assert.ok(selectAll, "a select-all checkbox must render");
  await click(selectAll);
  const bulkDelete = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Delete",
  );
  assert.ok(bulkDelete, "the bulk Delete button must render once rows are selected");
  await click(bulkDelete);
  await tick();
  await tick();

  const toasts = globalThis.__fileToasts ?? [];
  assert.ok(
    toasts.every((toast) => toast.kind !== "success"),
    `a partial bulk must never toast success, saw ${JSON.stringify(toasts)}`,
  );
  const errors = toasts.filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, `exactly one error toast must fire, saw ${JSON.stringify(toasts)}`);
  assert.match(errors[0]?.message ?? "", /1.*skipped|skipped.*1/, "the toast must name the skipped count");
  assert.match(errors[0]?.message ?? "", /forbidden/, "the toast must carry the refusal reason");
  assert.ok(
    !/Moved 1 to Trash$/.test(errors[0]?.message ?? "") && !toasts.some((toast) => /Moved 2 to Trash/.test(toast.message)),
    "the partial bulk must not report full success",
  );
  const bar = document.body.textContent ?? "";
  assert.match(bar, /1 selected/, "exactly the refused row must stay selected after the partial bulk");
  assert.equal(globalThis.__fileRefreshed, true, "the list must refresh so trashed rows disappear");
});

test("a refused bulk names the server refusal instead of the generic failure", async (t) => {
  globalThis.__fileToasts = [];
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/file-cabinet/bulk" && init?.method === "POST") {
      return Response.json({ error: "nothing selected" }, { status: 400 });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await renderList();
  t.after(unmount);

  const selectAll = document.querySelector('input[aria-label="Select all"]');
  assert.ok(selectAll, "a select-all checkbox must render");
  await click(selectAll);
  const bulkDelete = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Delete",
  );
  assert.ok(bulkDelete, "the bulk Delete button must render once rows are selected");
  await click(bulkDelete);
  await tick();
  await tick();

  const toasts = globalThis.__fileToasts ?? [];
  const errors = toasts.filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, `exactly one error toast must fire, saw ${JSON.stringify(toasts)}`);
  assert.match(errors[0]?.message ?? "", /nothing selected/, "the toast must carry the server refusal");
});

test("replace picker can be reopened after cancellation for the same file", async (t) => {
  const { unmount } = await renderList();
  t.after(unmount);
  const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
  assert.ok(input, "the hidden replace picker must render");
  const originalClick = window.HTMLInputElement.prototype.click;
  let opens = 0;
  window.HTMLInputElement.prototype.click = function () {
    if (this === input) opens += 1;
  };
  t.after(() => {
    window.HTMLInputElement.prototype.click = originalClick;
  });

  async function requestReplace() {
    const more = [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'More actions');
    assert.ok(more, "the file row's action menu must render");
    await click(more);
    const replace = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === 'Replace');
    assert.ok(replace, 'the file menu must offer Replace');
    await click(replace);
  }

  await requestReplace();
  assert.equal(opens, 1, 'the first Replace action opens the native picker');
  await requestReplace();
  assert.equal(opens, 2, 'cancelling the picker leaves Replace available for another attempt');
});
