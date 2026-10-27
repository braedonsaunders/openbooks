import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { dataTransferJob } from "../../../../testing/data-transfer";

// Sample-company provisioning belongs in Company Setup. Import navigation
// and transfer restoration must never expose provisioning actions here.

declare global {
  var __sampleTestRouter: { pushes: string[]; refreshes: number } | undefined;
  var __sampleTestToasts: { kind: string; message: string }[] | undefined;
  var __sampleTestEnteredOrgs: string[] | undefined;
  var __sampleTestEntryRefusal: string | null | undefined;
}

const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/data/import",
  scrollIntoView: false,
  resizeObserver: false,
});

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation: {
    pathname: "/data/import",
    routerSource:
      "export function useRouter(){return {push(url){globalThis.__sampleTestRouter.pushes.push(String(url))},refresh(){globalThis.__sampleTestRouter.refreshes+=1}}}",
  },
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__sampleTestToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__sampleTestToasts.push({kind:"error",message:String(m)})},info(m){globalThis.__sampleTestToasts.push({kind:"info",message:String(m)})}};export function Toaster(){return null}',
      };
    }
    if (specifier.endsWith("lib/workspace-switch")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
          export class WorkspaceSwitchError extends Error { constructor(refusal) { super(refusal); this.refusal = refusal } }
          export function workspaceSwitchMessageKey(error) {
            return error instanceof WorkspaceSwitchError && error.refusal === 'workspace_unavailable' ? 'switchUnavailable' : 'switchFailed'
          }
          export async function switchWorkspace(orgId) {
            globalThis.__sampleTestEnteredOrgs.push(String(orgId))
            if (globalThis.__sampleTestEntryRefusal) throw new WorkspaceSwitchError(globalThis.__sampleTestEntryRefusal)
          }`),
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
const { BusinessDateProvider } = await import("../../../../components/business-date-provider");
const messages = (await import("../../../../messages/en")).default;
const { ImportWizard } = await import("./ImportWizard");
const { SampleCompanyPicker } = await import("../../../../components/sample-company-picker");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const PROFILE = {
  industryKey: "sim_atlas",
  profileId: "sim-atlas",
  companyName: "SIM Atlas",
  focus: ["Services"],
  templateReady: true,
  existingOrgId: null,
};
const NEW_ORG_ID = "8266d59c-2c23-4e6d-834e-54f463319196";

const script = {
  sampleGets: 0,
  samplePosts: 0,
  readyOrgId: null as string | null,
  postTransportFailure: false,
  postStatus: 500,
  postBody: { error: "sample-company-clone-failed", stage: "clone" } as Record<string, unknown>,
  listProvisioning: null as unknown,
  statusReads: [] as Record<string, unknown>[],
  statusGets: 0,
  resources: [] as { key: string; label: string; group: string; supportsImport?: boolean }[],
  importRequests: [] as { mode?: string }[],
  importFailureMode: null as string | null,
  previewFailed: 0,
  job: dataTransferJob(),
};

function stubFetch(): void {
  globalThis.fetch = (async (
    input: unknown,
    init?: { method?: string; body?: BodyInit | null },
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/data/resources" && method === "GET") {
      return Response.json({ resources: script.resources });
    }
    if (url === "/api/data/sample-companies?industry=sim_atlas" && method === "GET") {
      script.statusGets += 1;
      const read =
        script.statusReads.length > 1 ? script.statusReads.shift() : script.statusReads[0];
      return Response.json({ industryKey: "sim_atlas", ...read });
    }
    if (url === "/api/data/sample-companies" && method === "GET") {
      script.sampleGets += 1;
      return Response.json({
        profiles: [
          { ...PROFILE, existingOrgId: script.readyOrgId, provisioning: script.listProvisioning },
        ],
      });
    }
    if (url === "/api/data/sample-companies" && method === "POST") {
      script.samplePosts += 1;
      if (script.postTransportFailure) throw new Error("connection dropped");
      if (script.postStatus === 202) {
        return Response.json(
          { ok: true, provisioning: { state: "queued", stage: null } },
          { status: 202 },
        );
      }
      if (script.postStatus !== 200) {
        return new Response(JSON.stringify(script.postBody), {
          status: script.postStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      return Response.json({
        ok: true,
        orgId: NEW_ORG_ID,
        created: true,
        templateGenerated: false,
      });
    }
    if (url === "/api/data/transfers" && method === "GET") return Response.json({ jobs: [] });
    if (url === "/api/data/transfers" && method === "POST") {
      script.importRequests.push({ mode: "parse" });
      if (script.importFailureMode === "parse")
        return new Response("<html>upstream unavailable</html>", { status: 502 });
      const body = JSON.parse(String(init?.body));
      script.job = dataTransferJob({
        resource: body.resource,
        format: body.format,
        filename: body.filename,
        bytes: body.bytes,
      });
      return Response.json({ job: script.job });
    }
    if (url.includes("/chunks/") && method === "PUT") {
      script.job = { ...script.job, uploadedBytes: script.job.bytes };
      return Response.json({ job: script.job });
    }
    if (url.startsWith("/api/data/transfers/") && method === "GET") {
      if (script.job.state === "parsing")
        script.job = { ...script.job, state: "mapping", totalRows: 1, processedRows: 0 };
      if (script.job.state === "previewing")
        script.job = {
          ...script.job,
          state: "ready",
          processedRows: 1,
          approvalHash: "approved-source",
          preview: { created: 1, updated: 0, failed: script.previewFailed, errors: [] },
        };
      if (script.job.state === "committing")
        script.job = {
          ...script.job,
          state: "completed",
          processedRows: 1,
          outcome: { created: 1, updated: 0, failed: 0, errors: [] },
        };
      return Response.json({ job: script.job });
    }
    if (url.startsWith("/api/data/transfers/") && method === "POST") {
      const body = JSON.parse(String(init?.body));
      if (body.action === "preview" || body.action === "commit") {
        script.importRequests.push({ mode: body.action });
        if (body.action === script.importFailureMode)
          return new Response("<html>upstream unavailable</html>", { status: 502 });
      }
      script.job = {
        ...script.job,
        revision: script.job.revision + 1,
        state:
          body.action === "finish-upload"
            ? "parsing"
            : body.action === "preview"
              ? "previewing"
              : "committing",
        options: body.options ?? script.job.options,
      };
      return Response.json({ job: script.job });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  }) as typeof fetch;
}

async function mountWizard(
  t: TestContext,
  sample = false,
  back?: { backHref: string; backLabel: string },
): Promise<void> {
  globalThis.__sampleTestRouter = { pushes: [], refreshes: 0 };
  globalThis.__sampleTestToasts = [];
  globalThis.__sampleTestEnteredOrgs = [];
  globalThis.__sampleTestEntryRefusal = null;
  script.sampleGets = 0;
  script.samplePosts = 0;
  script.readyOrgId = null;
  script.postTransportFailure = false;
  script.postStatus = 500;
  script.postBody = { error: "sample-company-clone-failed", stage: "clone" };
  script.statusReads = [];
  script.statusGets = 0;
  script.importRequests = [];
  script.importFailureMode = null;
  script.previewFailed = 0;
  window.history.replaceState(null, "", "/data/import");
  stubFetch();
  const rootHandle = createRoot(document.body);
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount();
    });
    for (const node of [...document.body.children]) node.remove();
  });
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-23">
          {sample ? <SampleCompanyPicker /> : <ImportWizard {...back} />}
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  await tick();
}

function sampleSelect(): HTMLSelectElement {
  const selects = [...document.querySelectorAll("select")] as HTMLSelectElement[];
  const select = selects.find((candidate) =>
    [...candidate.options].some((option) => option.value === "sim_atlas"),
  );
  assert.ok(select, "the sample-company picker must render with the SIM Atlas profile");
  return select;
}

function createButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) =>
    /Create sample company|Open sample company|Check company status|Try again|Opening|Preparing/.test(
      (candidate.textContent ?? "").trim(),
    ),
  ) as HTMLButtonElement | undefined;
  assert.ok(button, "the sample-company create button must render");
  return button;
}

async function clickCreate(): Promise<void> {
  await act(async () => {
    createButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
  await tick();
}

function importAction(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) =>
    (candidate.textContent ?? "").includes(label),
  ) as HTMLButtonElement | undefined;
  assert.ok(button, `the ${label} action must render`);
  return button;
}

async function chooseImportSource(): Promise<void> {
  const resourceSelect = ([...document.querySelectorAll("select")] as HTMLSelectElement[]).find(
    (candidate) => [...candidate.options].some((option) => option.value === "customers"),
  );
  assert.ok(resourceSelect, "an import resource is available");
  assert.equal((document.querySelector("textarea") as HTMLTextAreaElement)?.placeholder, "");
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set?.call(
      resourceSelect,
      "customers",
    );
    resourceSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      "Name\nAcme",
    );
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    textarea.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

async function clickImportAction(label: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const ready = [...document.querySelectorAll("button")].find(
      (item) => (item.textContent ?? "").includes(label) && !item.disabled,
    );
    if (ready) break;
    await act(async () => {
      await tick();
    });
  }
  const button = importAction(label);
  assert.equal(button.disabled, false);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
}

test("a failed create shows a persistent inline error and keeps the selection", async (t) => {
  await mountWizard(t, true);
  assert.equal(sampleSelect().value, "sim_atlas", "the profile starts selected");
  await clickCreate();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the failure must render a persistent inline error, not just a toast");
  assert.match(alert.textContent ?? "", /copying the template[’']s posted history failed/);
  assert.match(alert.textContent ?? "", /readiness is unconfirmed/);
  assert.doesNotMatch(alert.textContent ?? "", /Nothing was created|you can retry/);
  assert.equal(createButton().disabled, false);
  assert.match(createButton().textContent ?? "", /Check company status/);
  assert.equal(
    sampleSelect().value,
    "sim_atlas",
    "the failed attempt must keep the chosen company",
  );
  assert.deepEqual(
    globalThis.__sampleTestEnteredOrgs,
    [],
    "the failed attempt must not enter any workspace",
  );
  assert.ok(
    (globalThis.__sampleTestToasts ?? []).some((toast) => toast.kind === "error"),
    "the failure must still surface as an error toast",
  );
});

test("an uncertain attempt checks readiness without replaying provisioning", async (t) => {
  await mountWizard(t, true);
  await clickCreate();
  assert.ok(document.querySelector('[role="alert"]'), "the failure must render first");
  await clickCreate();
  assert.equal(
    script.samplePosts,
    1,
    "an absent ready company is not evidence permitting a second POST",
  );
  assert.ok(document.querySelector('[role="alert"]'));
  assert.equal(createButton().disabled, false);
  script.readyOrgId = NEW_ORG_ID;
  await clickCreate();
  assert.equal(
    document.querySelector('[role="alert"]'),
    null,
    "opening a proven ready company clears the persistent refusal",
  );
  assert.deepEqual(globalThis.__sampleTestEnteredOrgs, [NEW_ORG_ID]);
  assert.equal(script.samplePosts, 1);
});

test("a named server remedy wins over generic stage copy and keeps its reference", async (t) => {
  await mountWizard(t, true);
  script.postBody = {
    error: "sample-company-clone-failed",
    stage: "clone",
    message: "Complete the native upgrade before provisioning.",
    requestId: "9cfa2170-6d06-4a49-8d8e-d73c33a4a9a9",
  };
  await clickCreate();
  const text = document.querySelector('[role="alert"]')?.textContent ?? "";
  assert.match(text, /Complete the native upgrade before provisioning/);
  assert.match(text, /Support reference: 9cfa2170-6d06-4a49-8d8e-d73c33a4a9a9/);
  assert.doesNotMatch(text, /Nothing was created/);
});

test("a dropped connection releases loading and preserves unknown provisioning outcome", async (t) => {
  await mountWizard(t, true);
  script.postTransportFailure = true;
  await clickCreate();
  assert.equal(createButton().disabled, false);
  assert.match(
    document.querySelector('[role="alert"]')?.textContent ?? "",
    /readiness is unconfirmed/,
  );
  await clickCreate();
  assert.equal(script.samplePosts, 1);
  assert.deepEqual(globalThis.__sampleTestEnteredOrgs, []);
});

test("a workspace entry refusal keeps the successful identity and never posts again", async (t) => {
  await mountWizard(t, true);
  script.postStatus = 200;
  globalThis.__sampleTestEntryRefusal = "workspace_unavailable";
  await clickCreate();
  assert.equal(script.samplePosts, 1);
  assert.match(createButton().textContent ?? "", /Open sample company/);
  assert.equal(createButton().disabled, false);
  assert.match(
    document.querySelector('[role="alert"]')?.textContent ?? "",
    /You no longer have access to that workspace/,
  );
  globalThis.__sampleTestEntryRefusal = null;
  await clickCreate();
  assert.equal(script.samplePosts, 1);
  assert.deepEqual(globalThis.__sampleTestEnteredOrgs, [NEW_ORG_ID, NEW_ORG_ID]);
});

test("synchronous repeated clicks share one provisioning attempt", async (t) => {
  await mountWizard(t, true);
  script.postStatus = 200;
  await act(async () => {
    const button = createButton();
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
  });
  assert.equal(script.samplePosts, 1);
  assert.deepEqual(globalThis.__sampleTestEnteredOrgs, [NEW_ORG_ID]);
});

/** Wait for the next background status reads to land. */
async function waitForPolls(reads: number): Promise<void> {
  const target = script.statusGets + reads;
  for (let attempt = 0; attempt < 200 && script.statusGets < target; attempt++) {
    await act(async () => {
      await tick();
    });
  }
  await act(async () => {
    await tick();
  });
  assert.ok(script.statusGets >= target, `expected ${reads} more status reads`);
}

function progressText(): string {
  return document.querySelector('[role="status"]')?.textContent ?? "";
}

test("a started company shows its stage while it prepares and offers to open it when ready", async (t) => {
  await mountWizard(t, true);
  script.postStatus = 202;
  script.statusReads = [
    { existingOrgId: null, provisioning: { state: "running", stage: "clone" } },
    { existingOrgId: NEW_ORG_ID, provisioning: null },
  ];
  await clickCreate();
  assert.equal(script.samplePosts, 1);
  assert.match(progressText(), /Preparing your sample company/);
  assert.match(progressText(), /Waiting for the background worker to start/);
  assert.equal(createButton().disabled, true, "a running preparation cannot be started again");
  assert.match(createButton().textContent ?? "", /Preparing company/);

  await waitForPolls(1);
  assert.match(progressText(), /Step 2 of 3: Copying the template’s posted history/);
  assert.equal(document.querySelector('[role="alert"]'), null);

  await waitForPolls(1);
  assert.equal(progressText(), "", "a ready company ends the progress display");
  assert.match(createButton().textContent ?? "", /Open sample company/);
  assert.equal(createButton().disabled, false);
  assert.ok(
    (globalThis.__sampleTestToasts ?? []).some(
      (toast) => toast.kind === "success" && /Sample company is ready/.test(toast.message),
    ),
  );
  assert.deepEqual(globalThis.__sampleTestEnteredOrgs, [], "readiness never switches by itself");
  await clickCreate();
  assert.deepEqual(globalThis.__sampleTestEnteredOrgs, [NEW_ORG_ID]);
  assert.equal(script.samplePosts, 1, "opening the ready company never provisions again");
});

const RECORDED_CLONE_FAILURE = {
  existingOrgId: null,
  provisioning: {
    state: "failed",
    failure: {
      error: "sample-company-clone-failed",
      stage: "clone",
      message:
        "Sample company preparation stopped: copying the template's posted history failed. Company readiness is unconfirmed.",
      requestId: "9cfa2170-6d06-4a49-8d8e-d73c33a4a9a9",
    },
  },
};

test("a failed background run keeps its staged message and offers Try again through to ready", async (t) => {
  await mountWizard(t, true);
  script.postStatus = 202;
  script.statusReads = [RECORDED_CLONE_FAILURE];
  await clickCreate();
  await waitForPolls(1);
  const alert = document.querySelector('[role="alert"]')?.textContent ?? "";
  assert.match(alert, /copying the template's posted history failed/);
  assert.match(alert, /Company readiness is unconfirmed/);
  assert.match(alert, /Support reference: 9cfa2170-6d06-4a49-8d8e-d73c33a4a9a9/);
  assert.equal(progressText(), "");
  assert.match(createButton().textContent ?? "", /Try again/);
  assert.equal(createButton().disabled, false);
  const reads = script.statusGets;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1700));
  });
  assert.equal(script.statusGets, reads, "a finished run is no longer re-read");

  script.statusReads = [
    { existingOrgId: null, provisioning: { state: "running", stage: "clone" } },
    { existingOrgId: NEW_ORG_ID, provisioning: null },
  ];
  await clickCreate();
  assert.equal(script.samplePosts, 2, "Try again starts a new run");
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.match(createButton().textContent ?? "", /Preparing company/);
  assert.equal(createButton().disabled, true, "a running retry cannot be started again");
  await waitForPolls(1);
  assert.match(progressText(), /Step 2 of 3: Copying the template’s posted history/);
  await waitForPolls(1);
  assert.equal(progressText(), "");
  assert.match(createButton().textContent ?? "", /Open sample company/);
  await clickCreate();
  assert.deepEqual(globalThis.__sampleTestEnteredOrgs, [NEW_ORG_ID]);
  assert.equal(script.samplePosts, 2);
});

test("a run that stranded an organization keeps its remedy and never offers another attempt", async (t) => {
  await mountWizard(t, true);
  script.postStatus = 202;
  script.statusReads = [
    {
      existingOrgId: null,
      provisioning: {
        state: "failed",
        failure: {
          error: "sample-company-stranded-org",
          message:
            "sample company clone failed and its incomplete shell (org 3f0c) could not be removed automatically; remove the shell org manually, then retry",
          requestId: "9cfa2170-6d06-4a49-8d8e-d73c33a4a9a9",
        },
      },
    },
  ];
  await clickCreate();
  await waitForPolls(1);
  assert.match(
    document.querySelector('[role="alert"]')?.textContent ?? "",
    /could not be removed automatically; remove the shell org manually/,
  );
  assert.match(createButton().textContent ?? "", /Check company status/);
  await clickCreate();
  assert.equal(script.samplePosts, 1, "a stranded organization is only re-read");
  assert.ok(document.querySelector('[role="alert"]'));
});

test("a request refused before anything started explains why and may be asked again", async (t) => {
  await mountWizard(t, true);
  script.postStatus = 503;
  script.postBody = { error: "sample-company-worker-unavailable" };
  await clickCreate();
  assert.match(
    document.querySelector('[role="alert"]')?.textContent ?? "",
    /background worker, which is not running, so preparation did not start/,
  );
  assert.match(createButton().textContent ?? "", /Try again/);
  script.postStatus = 202;
  script.statusReads = [{ existingOrgId: null, provisioning: { state: "running", stage: null } }];
  await clickCreate();
  assert.equal(script.samplePosts, 2, "nothing started, so the request may be made again");
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.match(progressText(), /Waiting for the background worker to start/);
});

test("a failure recorded before the panel opened is shown with Try again", async (t) => {
  script.listProvisioning = RECORDED_CLONE_FAILURE.provisioning;
  t.after(() => {
    script.listProvisioning = null;
  });
  await mountWizard(t, true);
  assert.match(
    document.querySelector('[role="alert"]')?.textContent ?? "",
    /copying the template's posted history failed/,
  );
  assert.match(createButton().textContent ?? "", /Try again/);
});

test("a run already in progress when the panel opens is followed without a new start", async (t) => {
  script.listProvisioning = { state: "running", stage: "template" };
  t.after(() => {
    script.listProvisioning = null;
  });
  await mountWizard(t, true);
  assert.match(progressText(), /Step 1 of 3: Preparing the verified industry template/);
  assert.equal(script.samplePosts, 0);
  assert.equal(createButton().disabled, true);
});

test("the durable server job preserves retry identity when session storage is unavailable", async (t) => {
  script.resources = [
    { key: "customers", label: "Customers", group: "Master data", supportsImport: true },
  ];
  const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    get() {
      throw new Error("session storage is disabled");
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(window, "sessionStorage", original);
    else Reflect.deleteProperty(window, "sessionStorage");
  });
  await mountWizard(t);

  assert.equal(script.sampleGets, 0, "file imports never load sample-company provisioning");
  assert.equal(document.querySelector("#sample-companies"), null);
  await chooseImportSource();

  await clickImportAction("Continue");
  await clickImportAction("Preview");
  await clickImportAction("Import 1 row");
  assert.deepEqual(
    script.importRequests.map(({ mode }) => mode),
    ["parse", "preview", "commit"],
  );
  assert.equal(new URL(window.location.href).searchParams.get("transfer"), script.job.id);
  assert.equal(document.querySelector('[role="alert"]'), null);
});

test("a preview with error rows names why it cannot be imported", async (t) => {
  script.resources = [
    { key: "customers", label: "Customers", group: "Master data", supportsImport: true },
  ];
  await mountWizard(t);
  script.previewFailed = 2;
  await chooseImportSource();
  await clickImportAction("Continue");
  await clickImportAction("Preview");

  const importButton = () =>
    [...document.querySelectorAll("button")].find((item) =>
      (item.textContent ?? "").includes("Import 1 row"),
    );
  for (let attempt = 0; attempt < 120 && !importButton(); attempt++)
    await act(async () => {
      await tick();
    });

  assert.equal(importAction("Import 1 row").disabled, true);
  assert.match(
    document.body.textContent ?? "",
    /2 rows have errors\. Fix them in the file and preview again/,
  );
  assert.deepEqual(
    script.importRequests.map(({ mode }) => mode),
    ["parse", "preview"],
  );
});

for (const stage of [
  {
    mode: "parse" as const,
    clicks: ["Continue"],
    requests: ["parse"],
    error: /The transfer request could not be completed\. \(status 502\)/,
  },
  {
    mode: "preview" as const,
    clicks: ["Continue", "Preview"],
    requests: ["parse", "preview"],
    error: /The transfer request could not be completed\. \(status 502\)/,
  },
]) {
  test(`a non-JSON ${stage.mode} refusal is shown by name instead of a JSON syntax error`, async (t) => {
    script.resources = [
      { key: "customers", label: "Customers", group: "Master data", supportsImport: true },
    ];
    await mountWizard(t);
    script.importFailureMode = stage.mode;
    await chooseImportSource();
    for (const label of stage.clicks) await clickImportAction(label);

    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", stage.error);
    assert.deepEqual(
      script.importRequests.map(({ mode }) => mode),
      stage.requests,
    );
    assert.doesNotMatch(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /Unexpected token|JSON syntax/,
    );
  });
}

test("the import header returns to Company Settings instead of history", async (t) => {
  await mountWizard(t, false, { backHref: "/admin/setup/company", backLabel: "Company Settings" });
  const back = document.querySelector<HTMLAnchorElement>('a[href="/admin/setup/company"]');
  assert.ok(back);
  assert.match(back.textContent ?? "", /Company Settings/);
  assert.equal(document.querySelector('a[href="/data/import/history"]'), null);
});

test("a committed import refreshes the cached lists and counters it changed", async (t) => {
  script.resources = [
    { key: "customers", label: "Customers", group: "Master data", supportsImport: true },
  ];
  await mountWizard(t);
  assert.equal(
    globalThis.__sampleTestRouter!.refreshes,
    0,
    "an unfinished import refreshes nothing",
  );
  await chooseImportSource();
  await clickImportAction("Continue");
  await clickImportAction("Preview");
  assert.equal(
    globalThis.__sampleTestRouter!.refreshes,
    0,
    "previewing writes nothing, so nothing refreshes",
  );
  await clickImportAction("Import 1 row");
  // The committing job completes on its next poll.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await tick();
  });
  assert.equal(script.job.state, "completed");
  assert.equal(globalThis.__sampleTestRouter!.refreshes, 1, "completion refreshes the router once");
});
