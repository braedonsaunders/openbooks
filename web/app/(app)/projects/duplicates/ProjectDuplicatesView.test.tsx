import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bootJsdomEnvironment } from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";

declare global {
  var __duplicatesToasts: { kind: string; message: string }[] | undefined;
  var __duplicateNavigation: string[] | undefined;
}

await bootJsdomEnvironment({
  url: "http://localhost:4800/projects/duplicates?group=source_ref%3Alegacy-ref",
  matchMediaMatches: false,
});

const { join: joinPath } = await import("node:path");
const { pathToFileURL: toFileUrl } = await import("node:url");
const worktreeUiSource = `export * from "${toFileUrl(joinPath(process.cwd(), "packages", "ui", "src", "index.ts")).href}"`;
stubModules({
  navigation: {
    source:
      "export function useRouter(){return{push(h){(globalThis.__duplicateNavigation??=[]).push(h)},replace(h){(globalThis.__duplicateNavigation??=[]).push(h)},refresh(){}}}" +
      "export function usePathname(){return '/projects/duplicates'}" +
      "export function useSearchParams(){return new URLSearchParams('group=source_ref%3Alegacy-ref')}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "@openbooks/ui": worktreeUiSource,
    sonner:
      'export const toast={success(m){(globalThis.__duplicatesToasts??=[]).push({kind:"success",message:String(m)})},error(m){(globalThis.__duplicatesToasts??=[]).push({kind:"error",message:String(m)})}}',
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { ProjectDuplicatesView } = await import("./ProjectDuplicatesView");

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const group = {
  kind: "source_ref" as const,
  key: "legacy-ref",
  projects: [
    {
      id: "project-a",
      code: "P-A",
      name: "Alpha",
      customerId: "customer-1",
      status: "active",
      isActive: true,
    },
    {
      id: "project-b",
      code: "P-B",
      name: "Bravo",
      customerId: "customer-1",
      status: "active",
      isActive: true,
    },
    {
      id: "project-c",
      code: "P-C",
      name: "Charlie",
      customerId: "customer-1",
      status: "active",
      isActive: true,
    },
  ],
};

function installFetch(handler: (url: URL, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost:4800");
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function mount(t: TestContext, handler: (url: URL, init?: RequestInit) => Response | null) {
  document.body.innerHTML = "";
  globalThis.__duplicatesToasts = [];
  globalThis.__duplicateNavigation = [];
  const restoreFetch = installFetch(handler);
  t.after(restoreFetch);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ProjectDuplicatesView group={group} canMerge />
      </NextIntlClientProvider>,
    );
    await tick();
  });
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
}

function previewButton() {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Preview",
  );
  assert.ok(button, "the drawer offers a merge preview");
  return button as HTMLButtonElement;
}

test("the URL drawer previews the selected direction and clears stale impact when its survivor changes", async (t) => {
  const requests: URL[] = [];
  await mount(t, (url) => {
    if (url.pathname === "/api/projects/merge" && url.search) {
      requests.push(url);
      return Response.json({
        survivorId: "project-a",
        duplicateId: "project-b",
        moved: [{ table: "documents", rows: 3 }],
        customRefs: [],
        alreadyMerged: false,
      });
    }
    return null;
  });

  await click(previewButton());
  assert.match(document.body.textContent ?? "", /3 references will move\./);
  assert.equal(requests[0]?.searchParams.get("survivorId"), "project-a");
  assert.equal(requests[0]?.searchParams.get("duplicateId"), "project-b");

  const survivor = document.body.querySelector<HTMLButtonElement>("#duplicate-project-survivor");
  assert.ok(survivor, "the survivor can be selected from the group");
  await click(survivor);
  const charlie = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (option) => option.textContent?.includes("Charlie"),
  );
  assert.ok(charlie, "the other project is available as a survivor");
  await click(charlie);
  assert.doesNotMatch(document.body.textContent ?? "", /3 references will move\./);
  assert.equal(
    [...document.body.querySelectorAll("button")].some((button) =>
      button.textContent?.startsWith("Merge ("),
    ),
    false,
  );
});

test("a refused merge preview replaces the stale preview with the actionable server refusal", async (t) => {
  let previewCalls = 0;
  await mount(t, (url) => {
    if (url.pathname === "/api/projects/merge" && url.search) {
      previewCalls += 1;
      if (previewCalls === 1) {
        return Response.json({
          survivorId: "project-a",
          duplicateId: "project-b",
          moved: [{ table: "documents", rows: 2 }],
          customRefs: [],
          alreadyMerged: false,
        });
      }
      return Response.json(
        { error: "A posted document prevents this merge direction" },
        { status: 422 },
      );
    }
    return null;
  });

  await click(previewButton());
  assert.match(document.body.textContent ?? "", /2 references will move\./);
  await click(previewButton());

  const alert = document.body.querySelector('[role="alert"]');
  assert.ok(alert, "the server refusal stays visible in the drawer");
  assert.equal(alert.textContent, "A posted document prevents this merge direction");
  assert.doesNotMatch(document.body.textContent ?? "", /2 references will move\./);
  assert.equal(
    [...document.body.querySelectorAll("button")].some((button) =>
      button.textContent?.startsWith("Merge ("),
    ),
    false,
  );
});
