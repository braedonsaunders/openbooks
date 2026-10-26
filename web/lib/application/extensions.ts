import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, withTransactionSavepoint } from "@openbooks/engine/platform/db";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import { parseManifest, validateBundle, APP_PLATFORM_PERMISSIONS } from "../apps/manifest";
import { parseObjectSpecs } from "../apps/objects";
import { parseNativeExtension } from "../apps/native-ui";
import { backendSourceErrors } from "../apps/backend-check";
import { APP_HOST_API_REFERENCE } from "../apps/host-api-reference";
import { DASHBOARD_COMPOSITION, PRESENTATION_WIDGETS } from "../presentation-widgets";
import { RECORD_FIELD_TYPES } from "../record-schema";
import { NAV_GROUP_BY_KEY } from "@openbooks/engine/navigation/nav-registry";
import { extensionContributionTargetErrors } from "../apps/contribution-targets";
import {
  AppError,
  appSettingSnapshot,
  getAppByKey,
  listApps,
  installApp,
  type UploadBundle,
} from "../apps/store";
import { requestHash } from "./idempotency-core";
import { previewLayout } from "./page-layouts";
import { ExtensionProjectionError } from "@openbooks/engine/extensions/pages";
import { conflict, forbidden, invalidInput, notFound } from "./errors";
import type { ApplicationContext } from "./context";

const bundleSchema = z
  .object({
    manifest: z.unknown(),
    files: z
      .array(
        z
          .object({
            path: z.string().max(200),
            content: z.string().max(2 * 1024 * 1024),
            isBinary: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    grantedPermissions: z.array(z.string()).max(50).optional(),
  })
  .strict();

export async function requireExtensionAuthor(context: ApplicationContext) {
  if (!can(context.authz, "apps.manage") || !can(context.authz, "admin.customization.manage"))
    throw forbidden("apps.manage and admin.customization.manage");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "apps"))) throw notFound("apps");
}

/** One validation path for the agent, draft store, review and activation. */
export function validateExtensionBundle(input: unknown): UploadBundle {
  const shape = bundleSchema.safeParse(input);
  if (!shape.success)
    throw invalidInput(
      shape.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  const bundle = shape.data;
  if (Buffer.byteLength(JSON.stringify(bundle), "utf8") > 10 * 1024 * 1024)
    throw invalidInput("App package exceeds 10 MB");
  const parsed = parseManifest(bundle.manifest);
  if (!parsed.ok || !parsed.manifest) throw invalidInput(parsed.errors.join("; "));
  const manifest = parsed.manifest;
  const errors = [
    ...validateBundle(
      manifest,
      bundle.files.map((file) => file.path),
    ).errors,
    ...extensionContributionTargetErrors(manifest.contributions ?? []),
  ];
  if (new Set(bundle.files.map((file) => file.path)).size !== bundle.files.length)
    errors.push("Duplicate file path");
  const objects = parseObjectSpecs(bundle.files);
  errors.push(...objects.errors);
  for (const endpoint of manifest.endpoints) {
    const file = bundle.files.find((candidate) => candidate.path === endpoint.file);
    if (file && !file.isBinary) errors.push(...backendSourceErrors(file.path, file.content));
  }
  if (manifest.frontend.renderer === "native") {
    const entry = bundle.files.find((file) => file.path === manifest.frontend.entry);
    if (!entry || entry.isBinary) errors.push("Native UI entry must be a JSON text file");
    else
      try {
        const ui = parseNativeExtension(entry.content, manifest);
        if (
          ui.screens.some((screen) => screen.kind === "records") &&
          !manifest.permissions.includes("records.read")
        )
          errors.push("Native record screens require records.read");
      } catch (error) {
        errors.push(
          error instanceof z.ZodError
            ? error.issues
                .map((issue) => `${entry.path} ${issue.path.join(".")}: ${issue.message}`)
                .join("; ")
            : error instanceof Error
              ? error.message
              : "Invalid native UI",
        );
      }
  }
  if (manifest.permissions.some((permission) => !APP_PLATFORM_PERMISSIONS.includes(permission)))
    errors.push("Unknown app permission");
  const granted = bundle.grantedPermissions ?? manifest.permissions;
  if (granted.some((permission) => !manifest.permissions.includes(permission)))
    errors.push("Granted permissions must be requested by the package");
  if (errors.length) throw invalidInput(errors.join("; "));
  return { manifest, files: bundle.files, grantedPermissions: granted };
}

export type ExtensionDraft = {
  id: string;
  extension_key: string;
  bundle: UploadBundle;
  content_hash: string;
  base_version_id: string | null;
  reason: string;
  status: string;
  created_at: string;
  changes: { added: string[]; changed: string[]; removed: string[]; newPackage: boolean };
};

export async function getExtensionDraft(
  context: ApplicationContext,
  id: string,
): Promise<ExtensionDraft> {
  await requireExtensionAuthor(context);
  const row = (
    await db.execute<ExtensionDraft>(
      sql`select id,extension_key,bundle,content_hash,base_version_id,reason,status,created_at
    from extension_drafts where org_id=${context.authz.user.orgId} and created_by=${context.authz.user.id} and id=${id}`,
      "objects",
    )
  )[0];
  if (!row) throw notFound("app draft");
  const previous = row.base_version_id
    ? await db.execute<{ path: string; content: string; isBinary: boolean }>(
        sql`
    select path,content,is_binary as "isBinary" from app_files where org_id=${context.authz.user.orgId} and version_id=${row.base_version_id}`,
        "objects",
      )
    : [];
  const previousManifest = row.base_version_id
    ? (
        await db.execute<{ manifest: unknown }>(
          sql`select manifest from app_versions where org_id=${context.authz.user.orgId} and id=${row.base_version_id}`,
          "objects",
        )
      )[0]?.manifest
    : undefined;
  const before = new Map(previous.map((file) => [file.path, file]));
  const after = new Map(row.bundle.files.map((file) => [file.path, file]));
  row.changes = {
    newPackage: !row.base_version_id,
    added: [...after.keys()].filter((path) => !before.has(path)),
    changed: [
      ...(previousManifest && requestHash(previousManifest) !== requestHash(row.bundle.manifest)
        ? ["manifest.json"]
        : []),
      ...[...after.keys()].filter(
        (path) =>
          before.has(path) &&
          (before.get(path)!.content !== after.get(path)!.content ||
            !!before.get(path)!.isBinary !== !!after.get(path)!.isBinary),
      ),
    ],
    removed: [...before.keys()].filter((path) => !after.has(path)),
  };
  return row;
}

export async function draftExtension(
  context: ApplicationContext,
  input: {
    bundle: unknown;
    reason: string;
    expectedBaseVersionId?: string | null;
    sourceDraft?: { id: string; contentHash: string };
  },
) {
  await requireExtensionAuthor(context);
  const bundle = validateExtensionBundle(input.bundle);
  const manifest = parseManifest(bundle.manifest).manifest!;
  const reason = input.reason.trim();
  if (!reason || reason.length > 2000) throw invalidInput("A 1–2000 character reason is required");
  const hash = requestHash(bundle);
  const row = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"extension-package:" + context.authz.user.orgId + ":" + manifest.key}, 0))`,
    );
    const app = (
      await tx.execute<{ activeVersionId: string | null }>(
        sql`select active_version_id as "activeVersionId" from apps where org_id=${context.authz.user.orgId} and key=${manifest.key} for update`,
        "objects",
      )
    )[0];
    if (
      input.expectedBaseVersionId !== undefined &&
      input.expectedBaseVersionId !== (app?.activeVersionId ?? null)
    )
      throw conflict(
        "This app changed while you were editing. Reload its current version before preparing a draft.",
      );
    if (input.sourceDraft) {
      const source = (
        await tx.execute<{ id: string }>(
          sql`select id from extension_drafts where id=${input.sourceDraft.id} and content_hash=${input.sourceDraft.contentHash} and org_id=${context.authz.user.orgId} and created_by=${context.authz.user.id} and extension_key=${manifest.key} and status='draft' for update`,
          "objects",
        )
      )[0];
      if (!source)
        throw conflict(
          "This draft has changed or closed. Reload it before saving another revision.",
        );
    }
    await tx.execute(
      sql`update extension_drafts set status='discarded' where org_id=${context.authz.user.orgId} and created_by=${context.authz.user.id} and extension_key=${manifest.key} and status='draft'`,
    );
    return (
      await tx.execute<{ id: string }>(
        sql`insert into extension_drafts(org_id,created_by,extension_key,bundle,content_hash,base_version_id,reason)
      values(${context.authz.user.orgId},${context.authz.user.id},${manifest.key},${JSON.stringify(bundle)}::jsonb,${hash},${app?.activeVersionId ?? null},${reason}) returning id`,
        "objects",
      )
    )[0]!;
  });
  return {
    draftId: row.id,
    contentHash: hash,
    key: manifest.key,
    status: "draft",
    reviewUrl: `/admin/apps?draft=${row.id}`,
    previewUrl: `/admin/apps/preview/${row.id}`,
    requestedPermissions: manifest.permissions,
    activated: false,
  };
}

export async function activateExtensionDraft(
  context: ApplicationContext,
  input: { draftId: string; contentHash: string },
) {
  const draft = await getExtensionDraft(context, input.draftId);
  if (input.contentHash !== draft.content_hash)
    throw conflict("The reviewed package changed; reopen its review");
  if (draft.status === "applied")
    throw conflict(
      "This draft is already activated. Prepare a new draft to change the installed package.",
    );
  if (draft.status !== "draft") throw conflict("This extension draft is no longer available");
  const bundle = validateExtensionBundle(draft.bundle);
  const manifest = parseManifest(bundle.manifest).manifest!;
  for (const permission of bundle.grantedPermissions ?? manifest.permissions) {
    if (!can(context.authz, permission)) throw forbidden(permission);
  }
  try {
    const installed = await withOrgTransaction(context.authz.user.orgId, () =>
      withTransactionSavepoint(db, () =>
        installApp(context.authz.user.orgId, context.authz.user.id, bundle, {
          id: draft.id,
          hash: draft.content_hash,
        }),
      ),
    );
    return {
      ...installed,
      activated: true,
      reviewUrl: `/admin/apps?app=${installed.key}`,
      openUrl: `/apps/${installed.key}`,
    };
  } catch (error) {
    if (error instanceof AppError || error instanceof ExtensionProjectionError)
      throw conflict(error.message);
    if (error instanceof z.ZodError)
      throw conflict(error.issues.map((issue) => issue.message).join("; "));
    throw error;
  }
}

export async function describeExtensionVocabulary(context: ApplicationContext) {
  await requireExtensionAuthor(context);
  return {
    preferredRenderer: "native",
    workflow: [
      "describe_app_vocabulary",
      "draft_app",
      "test_app_endpoint",
      "get_app_draft",
      "activate_app_draft",
      "list_app_runs",
    ],
    rules: [
      "Use list_app_packages to discover installed packages. There is one package store and one version/review lifecycle for every renderer and contribution.",
      "manifest.contributions supports page (route, spec, scope org), nav (href, label, group, iconKey?), setting (key, label, valueType, defaultValue) and permission (key, label). The manifest must also request the contribution authority — page and nav: admin.customization.manage; setting: admin.setup.manage; permission: admin.roles.manage — and the activating administrator must hold it. Contributions and objects activate atomically with backend files. Do not invent unsupported contribution kinds.",
      "To restore an earlier package, read its version with get_app_package and prepare a new reviewed revision. Never mutate an active or historical version in place.",
      "Prefer native UI screens composed from the house page vocabulary and records workspaces. record screens use the native records loader, permissions, audience, filters and drawers.",
      'Every native screen renders in the house page shell with the app\'s screen tabs. Link between screens of the same app with href "/apps/<app key>?screen=<screen key>".',
      'Native page screens are dashboards: compose stat-tile, grid, panel, heading, text and table blocks with the presentation widgets in nativeScreens.widgets. Bind live values from a data endpoint as { "$": "data.<path>" }; app identity is available as app.name, app.key and app.description.',
      "objects/*.json files can provision owned record_type or custom_field definitions atomically with the package. Existing foreign-owned objects cannot be overwritten. Existing data is preserved during upgrades and removal.",
      'Native action forms submit {input, invocationId} to the declared backend as request.body. Return {message} for a user-readable result. Throw new Error("…") to refuse with that message and roll back every write. Transport retries replay the same invocation; another submission gets a new ID.',
      "Backend endpoints run in a sandbox with only the ob host API in hostApi; there is no network, file system, timer or database access. Calling anything outside hostApi is refused when the draft is saved.",
      "Record types use existing custom-record storage; never create SQL tables, run DDL, or request database credentials. Custom fields extend supported platform records through the same controlled definition system.",
      "list_record_types is the authoritative inventory for platform typeKeys and their fields. Do not probe guessed table names or infer record API support from page layouts. If a domain is absent, disclose that limitation.",
      'Record fields use FormSection[] (objects.recordFields). Select choices belong at validation.options as [{value:"planned",label:"Planned"}], never top-level options. Use type party for the native party reference picker. Read the returned validation errors and correct the complete draft before retrying.',
      'Do not name a record-type field "status": every custom record already carries a lifecycle status (active/inactive). Use a domain name such as checkout_state.',
      "draft_app stores an immutable author-owned proposal and returns review/preview URLs; a new draft of the same app supersedes your earlier open draft. It does not install objects, run backend code, or activate anything.",
      "Rehearse every endpoint with test_app_endpoint before activation: it installs the draft inside a transaction, runs the endpoint against live data with your permissions, returns the response or refusal with its ob.log lines, and rolls everything back.",
      "Sandbox HTML apps (frontend.renderer sandbox) receive openbooks.context.preview: true for draft previews and false for installed apps. In preview, use explicitly fictional in-memory sample state only; all host bridge calls are refused.",
      "Request explicit user approval of the returned draft before activate_app_draft. Activation binds its exact hash and base version. Never replace it with a direct install to bypass a stale-draft refusal.",
      "Version labels are unique. Read the existing package before upgrading, preserve its owned objects and fields, and append a version.",
    ],
    hostApi: APP_HOST_API_REFERENCE,
    nativeScreens: {
      entry:
        "frontend.entry names a JSON file { screens: Screen[] } (1–20 screens). The first screen opens by default.",
      kinds: {
        page: '{ key, title, kind: "page", description?, data?: { endpoint: <GET or ANY endpoint name> }, spec: PageSpec }. The data endpoint runs read-only as the viewer on each view; request.body is { screen, query } (query = the URL search params); its returned body binds as data.*. Writes are refused there.',
        records:
          '{ key, title, kind: "records", typeKey: <custom record type key> } — the native list, filters and drawer. Requires records.read; creating requires records.create.',
        action:
          '{ key, title, kind: "action", endpoint: <POST or ANY endpoint name>, fields: FormSection[], submitLabel, description?, confirmation? } — a native form drawer that submits to the endpoint.',
      },
      pageSpec:
        '{ specVersion: 1, layout: "detail" | "list", header: Block[] (leave empty to use the screen title), body: Block[] }. describe_page_layout_vocabulary documents every block\'s properties.',
      widgets: PRESENTATION_WIDGETS,
      composition: DASHBOARD_COMPOSITION,
      example: {
        key: "overview",
        title: "Overview",
        kind: "page",
        data: { endpoint: "overview-data" },
        spec: {
          specVersion: 1,
          layout: "detail",
          header: [],
          body: [
            {
              kind: "grid",
              className: "grid gap-4 sm:grid-cols-2 xl:grid-cols-4",
              blocks: [
                {
                  kind: "stat-tile",
                  iconKey: "clipboard-check",
                  accent: "teal",
                  label: "Checks this month",
                  value: { $: "data.monthCount" },
                },
                {
                  kind: "stat-tile",
                  iconKey: "triangle-alert",
                  accent: "amber",
                  label: "Open findings",
                  value: { $: "data.openFindings" },
                  tone: "warning",
                },
              ],
            },
            {
              kind: "grid",
              className: "grid gap-6 lg:grid-cols-3",
              blocks: [
                {
                  kind: "panel",
                  title: "Checks by week",
                  iconKey: "area-chart",
                  className: "lg:col-span-2",
                  blocks: [
                    {
                      kind: "widget",
                      widget: "trend-chart",
                      props: {
                        labels: { $: "data.weeks" },
                        series: { $: "data.series" },
                        format: "count",
                        area: true,
                      },
                    },
                  ],
                },
                {
                  kind: "panel",
                  title: "Findings by severity",
                  iconKey: "pie-chart",
                  blocks: [
                    {
                      kind: "widget",
                      widget: "donut-chart",
                      props: { data: { $: "data.bySeverity" }, format: "count" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
    objects: {
      recordType: '{ type: "record_type", key, name, pluralName, fields: FormSection[] }',
      customField: '{ type: "custom_field", key, label, targetTable, fieldType }',
      recordFields:
        "FormSection = { id, title?, fields: Field[] }; Field = { id, type, label, required?, description?, validation?: { min?, max?, options?: { value, label }[] } }",
      fieldTypes: [...RECORD_FIELD_TYPES],
    },
    contributions: {
      navGroups: [...NAV_GROUP_BY_KEY.keys()],
      settingValueTypes: ["boolean", "number", "string", "json"],
      settingNote:
        "A setting appears under Admin → Setup → app settings, where an administrator changes it. Backends read its current value with ob.settings.get(key), falling back to defaultValue until changed; get_app_package returns the installed app's current values. A draft's defaultValue never overrides a stored value.",
    },
    permissions: APP_PLATFORM_PERMISSIONS,
    example: {
      manifest: {
        key: "equipment-checks",
        name: "Equipment checks",
        version: "1.0.0",
        permissions: ["records.read", "records.create"],
        frontend: { renderer: "native", entry: "frontend/ui.json" },
        endpoints: [{ name: "create-check", file: "backend/create-check.js", method: "POST" }],
      },
      files: [
        {
          path: "frontend/ui.json",
          content: JSON.stringify({
            screens: [
              {
                key: "checks",
                title: "Equipment checks",
                kind: "records",
                typeKey: "equipment-check",
              },
              {
                key: "new-check",
                title: "New equipment check",
                kind: "action",
                endpoint: "create-check",
                submitLabel: "Create check",
                fields: [
                  {
                    id: "details",
                    fields: [
                      { id: "equipment", type: "text", label: "Equipment", required: true },
                      { id: "notes", type: "long_text", label: "Notes" },
                    ],
                  },
                ],
              },
            ],
          }),
        },
        {
          path: "backend/create-check.js",
          content:
            "function handler(request) { var input = request.body.input; if (!input.equipment) throw new Error('Equipment is required'); var created = ob.platform.create('equipment-check', { data: input, status: 'active' }); ob.storage.set('last-check', created.record.id); return { message: 'Equipment check ' + created.record.record_number + ' created' }; }",
        },
        {
          path: "objects/checks.json",
          content: JSON.stringify({
            type: "record_type",
            key: "equipment-check",
            name: "Equipment check",
            pluralName: "Equipment checks",
            fields: [
              {
                id: "details",
                title: "Details",
                fields: [
                  { id: "equipment", type: "text", label: "Equipment", required: true },
                  { id: "notes", type: "long_text", label: "Notes" },
                ],
              },
            ],
          }),
        },
      ],
    },
    documentation: "/docs/app-authoring",
  };
}

export async function getExtensionPackage(
  context: ApplicationContext,
  input: { key: string; versionId?: string },
) {
  await requireExtensionAuthor(context);
  const app = await getAppByKey(context.authz.user.orgId, input.key);
  if (!app) throw notFound("app");
  const version = (
    await db.execute<{ id: string; manifest: unknown }>(
      sql`select id,manifest from app_versions
    where org_id=${context.authz.user.orgId} and app_id=${app.id} and id=${input.versionId ?? app.activeVersionId}`,
      "objects",
    )
  )[0];
  if (!version) throw notFound("app version");
  const files = await db.execute<{ path: string; content: string; isBinary: boolean }>(
    sql`select path,content,is_binary as "isBinary" from app_files
    where org_id=${context.authz.user.orgId} and app_id=${app.id} and version_id=${version.id} order by path`,
    "objects",
  );
  // Current setting values ride along so an author sees the configuration
  // the installed backend actually reads through ob.settings.
  const settings =
    version.id === app.activeVersionId
      ? await appSettingSnapshot(context.authz.user.orgId, app.key, app.manifest)
      : undefined;
  return {
    key: input.key,
    versionId: version.id,
    bundle: { manifest: version.manifest, files, grantedPermissions: app.grantedPermissions },
    ...(settings ? { settings } : {}),
  };
}

export async function discardExtensionDraft(
  context: ApplicationContext,
  input: { draftId: string; contentHash: string },
) {
  const draft = await getExtensionDraft(context, input.draftId);
  if (draft.content_hash !== input.contentHash) throw conflict("The reviewed package changed");
  if (draft.status === "applied")
    throw conflict(
      "An activated version cannot be discarded. Prepare a new draft to change the installed package.",
    );
  if (draft.status === "discarded")
    throw conflict(
      "This draft is already discarded. Prepare a new draft if you still need a revision.",
    );
  if (draft.status !== "draft") throw conflict("This extension draft is no longer available");
  await db.transaction(async (tx) => {
    const changed = await tx.execute(
      sql`update extension_drafts set status='discarded' where org_id=${context.authz.user.orgId} and id=${draft.id} and created_by=${context.authz.user.id} and status='draft' returning id`,
      "objects",
    );
    if (!changed.length) {
      const status = (
        await tx.execute<{ status: string }>(
          sql`select status from extension_drafts where org_id=${context.authz.user.orgId} and id=${draft.id}`,
          "objects",
        )
      )[0]?.status;
      if (status === "applied")
        throw conflict(
          "An activated version cannot be discarded. Prepare a new draft to change the installed package.",
        );
      if (status === "discarded")
        throw conflict(
          "This draft is already discarded. Prepare a new draft if you still need a revision.",
        );
      throw conflict("This extension draft is no longer available");
    }
    await tx.execute(
      sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${context.authz.user.orgId},'extension_drafts',${draft.id},'update',${JSON.stringify({ event: "extension_draft_discarded", contentHash: draft.content_hash, before: { status: "draft" }, after: { status: "discarded" } })}::jsonb,${context.authz.user.id})`,
    );
  });
  return { discarded: true };
}

export async function listExtensions(context: ApplicationContext) {
  await requireExtensionAuthor(context);
  return {
    extensions: (await listApps(context.authz.user.orgId)).map((app) => ({
      key: app.key,
      name: app.name,
      status: app.status,
      version: app.version,
      reviewUrl: `/admin/apps?app=${app.key}`,
      openUrl: `/apps/${app.key}`,
    })),
  };
}

/** Reuse the author-scoped native page preview; never install the package to preview it. */
export async function previewExtensionPage(
  context: ApplicationContext,
  input: { draftId: string; route: string; params?: Record<string, string> },
) {
  const draft = await getExtensionDraft(context, input.draftId);
  const manifest = parseManifest(validateExtensionBundle(draft.bundle).manifest).manifest!;
  const page = manifest.contributions?.find(
    (item) => item.kind === "page" && item.route === input.route,
  );
  if (!page || page.kind !== "page") throw notFound("app page contribution");
  return previewLayout(context, { route: page.route, spec: page.spec, params: input.params });
}
