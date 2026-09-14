"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  UrlDrawer,
} from "@openbooks/ui";
import type { ExtensionDraft } from "@/lib/application/extensions";
import { AppPackageEditor } from "./AppPackageEditor";
import { AppWorkspaceTabs } from "./sections";
import { confirmDialog } from "@/lib/confirm";
import { parseManifest } from "@/lib/apps/manifest";
import {
  Package,
  ArrowUpRight,
  ShieldCheck,
  GitCompareArrows,
} from "lucide-react";
import { LiveDirectory } from "@/components/module-home/ui";
import {
  parseNativeExtension,
  type NativeExtension,
} from "@/lib/apps/native-ui";
import { parseObjectSpecs } from "@/lib/apps/objects";

export function ExtensionReview({ draft }: { draft: ExtensionDraft }) {
  const t = useTranslations("admin.extensions.draft");
  const tm = useTranslations("apps.management");
  const router = useRouter();
  const [tab, setTab] = useState<"overview" | "package" | "changes">(
    "overview",
  );
  const editing = tab === "package";
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manifest = parseManifest(draft.bundle.manifest).manifest!;
  const objects = parseObjectSpecs(draft.bundle.files);
  let screens: NativeExtension["screens"] = [];
  try {
    const entry = draft.bundle.files.find(
      (file) => file.path === manifest.frontend.entry,
    );
    if (manifest.frontend.renderer === "native" && entry)
      screens = parseNativeExtension(entry.content, manifest).screens;
  } catch {
    /* Package editor retains invalid source for repair. */
  }
  const previewHref = `/admin/apps/preview/${draft.id}`;
  async function activate(action: "activate" | "discard") {
    if (dirty && action === "activate") {
      setError(t("saveEditsFirst"));
      return;
    }
    if (
      dirty &&
      action === "discard" &&
      !(await confirmDialog(t("discardEdits")))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/apps/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          draftId: draft.id,
          contentHash: draft.content_hash,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? t("failed"));
      router.push(data.reviewUrl ?? "/admin/apps");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("failed"));
    } finally {
      setBusy(false);
    }
  }
  async function previewPage(route: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/apps/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "preview-page",
          draftId: draft.id,
          route,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.staged)
        throw new Error(data.error ?? data.errors?.join("; ") ?? t("failed"));
      router.push(data.previewUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("failed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <UrlDrawer
      open
      closeHref="/admin/apps"
      size="2xl"
      beforeClose={() => !dirty || confirmDialog(t("discardEdits"))}
      title={manifest.name}
      description={`${manifest.key} · ${manifest.version}`}
      headerActions={
        <Button asChild variant="outline">
          <Link href={`/admin/apps/preview/${draft.id}` as never}>
            {t("preview")}
          </Link>
        </Button>
      }
      subtabs={
        <AppWorkspaceTabs<"overview" | "package" | "changes">
          label={tm("workspace")}
          selected={tab}
          tabs={[
            { key: "overview", label: tm("overview") },
            { key: "changes", label: t("reviewTab") },
            ...(draft.status === "draft"
              ? [{ key: "package" as const, label: tm("package") }]
              : []),
          ]}
          onSelect={setTab}
        />
      }
      footer={
        !editing && draft.status === "draft" ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-4">
            <label className="flex min-w-0 items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={reviewed}
                onChange={(event) => setReviewed(event.target.checked)}
              />
              {t("confirm")}
            </label>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => activate("discard")}
              >
                {t("discard")}
              </Button>
              <Button
                disabled={busy || !reviewed}
                onClick={() => activate("activate")}
              >
                {t("activate")}
              </Button>
            </div>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-5">
        {draft.status === "draft" ? (
          <div hidden={!editing}>
            <AppPackageEditor
              bundle={draft.bundle}
              baseVersionId={draft.base_version_id}
              sourceDraft={{ id: draft.id, contentHash: draft.content_hash }}
              onDirtyChange={setDirty}
            />
          </div>
        ) : null}
        <div hidden={editing} className="space-y-5">
          <div hidden={tab !== "overview"} className="space-y-6">
            <Card className="overflow-hidden border-teal-200 dark:border-teal-900">
              <CardHeader className="bg-gradient-to-br from-teal-50 via-white to-sky-50 dark:from-teal-950/50 dark:via-slate-900 dark:to-sky-950/30">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <span className="grid h-12 w-12 place-items-center rounded-xl bg-teal-600 text-white shadow-sm">
                    <Package size={24} aria-hidden />
                  </span>
                  <Badge variant="outline">
                    {t(draft.status === "draft" ? "pending" : "closed")}
                  </Badge>
                </div>
                <CardTitle className="text-2xl">{manifest.name}</CardTitle>
                <CardDescription className="max-w-prose leading-relaxed">
                  {manifest.description || t("unpublished")}
                </CardDescription>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <Badge variant="outline">v{manifest.version}</Badge>
                  <span>
                    {t(
                      manifest.frontend.renderer === "native"
                        ? "nativeApp"
                        : "customApp",
                    )}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="border-t pt-4">
                <div className="grid grid-cols-3 gap-4">
                  {[
                    {
                      label: t("screenCount"),
                      value:
                        manifest.frontend.renderer === "native"
                          ? screens.length
                          : 1,
                    },
                    {
                      label: t("workspaceCount"),
                      value: objects.recordTypes.length,
                    },
                    {
                      label: t("actionCount"),
                      value: manifest.endpoints.length,
                    },
                  ].map((item) => (
                    <div key={item.label}>
                      <div className="text-2xl font-semibold tabular-nums">
                        {item.value}
                      </div>
                      <div className="text-xs text-slate-500">{item.label}</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold">{t("explore")}</h3>
                <p className="mt-1 text-sm text-slate-500">
                  {t("exploreHelp")}
                </p>
              </div>
              <LiveDirectory
                items={
                  screens.length
                    ? screens.map((screen) => ({
                        href: `${previewHref}?screen=${encodeURIComponent(screen.key)}`,
                        label: screen.title,
                        iconKey:
                          screen.kind === "records"
                            ? "clipboard"
                            : screen.kind === "action"
                              ? "code"
                              : "grid",
                        badge: { value: t(`screenKind.${screen.kind}`) },
                      }))
                    : [
                        {
                          href: previewHref,
                          label: manifest.name,
                          iconKey: "grid",
                          badge: { value: t("preview") },
                        },
                      ]
                }
              />
            </section>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <ShieldCheck size={18} aria-hidden />
                  {t("reviewReady")}
                </CardTitle>
                <CardDescription>{t("unpublished")}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setTab("changes")}>
                  <GitCompareArrows size={16} />
                  {t("reviewTab")}
                </Button>
                <Button asChild variant="ghost">
                  <Link
                    href={
                      `/assistant?q=${encodeURIComponent(`Revise app draft ${draft.id}. Read it with get_app_draft, ask what I want changed, and prepare a new draft for review. Do not activate it.`)}` as never
                    }
                  >
                    {t("revise")}
                    <ArrowUpRight size={16} />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </div>
          <div hidden={tab !== "changes"} className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t("proposalNotes")}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">
                  {draft.reason}
                </p>
              </CardContent>
            </Card>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{t("changes")}</h3>
              {draft.changes.newPackage ? <p>{t("newPackage")}</p> : null}
              {(["added", "changed", "removed"] as const).map((kind) =>
                draft.changes[kind].length ? (
                  <div key={kind} className="space-y-2">
                    <Badge variant="outline">
                      {t(kind)} · {draft.changes[kind].length}
                    </Badge>
                    <ul className="divide-y rounded-lg border px-3">
                      {draft.changes[kind].map((path) => (
                        <li
                          key={path}
                          className="break-all py-2 font-mono text-xs"
                        >
                          {path}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null,
              )}
              <p className="text-sm text-slate-500">{t("retainedData")}</p>
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{t("contents")}</h3>
              <ul className="list-inside list-disc text-sm">
                {objects.recordTypes.map((type) => (
                  <li key={type.key}>{t("recordType", { name: type.name })}</li>
                ))}
                {objects.customFields.map((field) => (
                  <li key={`${field.targetTable}:${field.key}`}>
                    {t("field", { name: field.label })}
                  </li>
                ))}
                {manifest.endpoints.map((endpoint) => (
                  <li key={endpoint.name}>
                    {t("action", { name: endpoint.name })}
                  </li>
                ))}
                {(manifest.contributions ?? []).map((item, index) => (
                  <li key={`contribution:${index}`}>
                    {t(item.kind, {
                      name: item.kind === "page" ? item.route : item.label,
                    })}
                  </li>
                ))}
                <li>{t("files", { count: draft.bundle.files.length })}</li>
              </ul>
            </section>
            {(manifest.contributions ?? [])
              .filter(
                (item) => item.kind === "page" && !item.route.includes("["),
              )
              .map((item) =>
                item.kind === "page" ? (
                  <Button
                    key={item.route}
                    variant="outline"
                    disabled={busy}
                    onClick={() => previewPage(item.route)}
                  >
                    {t("previewPage", { route: item.route })}
                  </Button>
                ) : null,
              )}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{t("permissions")}</h3>
              <p className="text-sm">
                {t("grants", {
                  permissions:
                    (
                      draft.bundle.grantedPermissions ?? manifest.permissions
                    ).join(", ") || t("noPermissions"),
                })}
              </p>
              {manifest.permissions.length ? (
                <ul className="list-inside list-disc text-sm">
                  {manifest.permissions.map((permission) => (
                    <li key={permission}>{permission}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm">{t("noPermissions")}</p>
              )}
            </section>
            <details>
              <summary className="cursor-pointer text-sm">
                {t("source")}
              </summary>
              <pre className="max-h-72 overflow-auto text-xs">
                {JSON.stringify(draft.bundle, null, 2)}
              </pre>
              <code className="break-all text-xs">{draft.content_hash}</code>
            </details>
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </div>
    </UrlDrawer>
  );
}
