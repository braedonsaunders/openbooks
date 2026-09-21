"use client";

import { nextActionName } from "@/lib/apps/endpoint-names";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  FileCode2,
  Folder,
  Plus,
  Upload,
  Trash2,
  Pencil,
  Download,
} from "lucide-react";
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  Label,
  Select,
  Textarea,
  cn,
} from "@openbooks/ui";
import { AppWorkspaceTabs } from "./sections";
import { AppScreens } from "./AppScreens";
import { AppDefinitions } from "./AppDefinitions";
import { CodeEditor } from "@/components/code-editor";
import { readApiErrorMessage } from "@/lib/api-error";
import { promptDialog } from "@/lib/prompt";
import { confirmDialog } from "@/lib/confirm";
import {
  APP_PLATFORM_PERMISSIONS,
  contentTypeFor,
  parseManifest,
  type AppManifest,
} from "@/lib/apps/manifest";
import {
  packageFromSourceFiles,
  packageSourceFiles,
  validPackagePath,
  type EditableAppPackage,
  type AppPackageFile,
} from "@/lib/apps/package-files";

/** Same CodeMirror composition as Scripts, editing an unpublished whole package. */
export function AppPackageEditor({
  bundle,
  baseVersionId,
  initialTab = "general",
  sourceDraft,
  onDirtyChange,
}: {
  bundle: EditableAppPackage;
  baseVersionId: string | null;
  initialTab?: "general" | "files";
  onDirtyChange?: (dirty: boolean) => void;
  sourceDraft?: { id: string; contentHash: string };
}) {
  const t = useTranslations("apps.editor");
  const router = useRouter();
  const upload = useRef<HTMLInputElement>(null);
  const directoryUpload = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState(() => packageSourceFiles(bundle));
  const [selected, setSelected] = useState("manifest.json");
  const [tab, setTab] = useState<string>(initialTab);
  const [reason, setReason] = useState("");
  const [search, setSearch] = useState("");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState({
    screens: false,
    definitions: false,
  });
  const hasPending = pending.screens || pending.definitions;
  function pendingChanged(kind: "screens" | "definitions", value: boolean) {
    setPending((previous) => ({ ...previous, [kind]: value }));
    if (value) {
      setDirty(true);
      onDirtyChange?.(true);
    }
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<AppManifest | undefined>(
    () => parseManifest(bundle.manifest).manifest,
  );
  const [grants, setGrants] = useState<string[]>(
    () =>
      bundle.grantedPermissions ??
      parseManifest(bundle.manifest).manifest?.permissions ??
      [],
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const selectedFile = files.find((file) => file.path === selected);
  function change(next: AppPackageFile[]) {
    setFiles(next);
    setDirty(true);
    onDirtyChange?.(true);
    setError(null);
  }
  function patchManifest(patch: Partial<AppManifest>) {
    if (!manifest) return;
    const next = { ...manifest, ...patch };
    setManifest(next);
    change(
      files.map((file) =>
        file.path === "manifest.json"
          ? { ...file, content: JSON.stringify(next, null, 2) }
          : file,
      ),
    );
  }
  async function addFile() {
    const path = await promptDialog({
      title: t("newFile"),
      label: t("path"),
      placeholder: "frontend/styles.css",
    });
    if (!path) return;
    if (!validPackagePath(path) || files.some((file) => file.path === path)) {
      setError(t("invalidPath"));
      return;
    }
    change([...files, { path, content: "" }]);
    setSelected(path);
    setTab("files");
  }
  async function renameFile() {
    if (!selectedFile || selected === "manifest.json") return;
    const path = await promptDialog({
      title: t("renameFile"),
      label: t("path"),
      initialValue: selected,
    });
    if (!path || path === selected) return;
    if (!validPackagePath(path) || files.some((file) => file.path === path)) {
      setError(t("invalidPath"));
      return;
    }
    // Keep declared entry points in step with file moves. References within source remain visible for review.
    const nextManifest = manifest
      ? {
          ...manifest,
          frontend: {
            ...manifest.frontend,
            entry:
              manifest.frontend.entry === selected
                ? path
                : manifest.frontend.entry,
          },
          endpoints: manifest.endpoints.map((endpoint) =>
            endpoint.file === selected ? { ...endpoint, file: path } : endpoint,
          ),
        }
      : undefined;
    if (nextManifest) setManifest(nextManifest);
    change(
      files.map((file) =>
        file.path === selected
          ? { ...file, path }
          : file.path === "manifest.json" && nextManifest
            ? { ...file, content: JSON.stringify(nextManifest, null, 2) }
            : file,
      ),
    );
    setSelected(path);
  }
  async function removeFile() {
    if (!selectedFile || selected === "manifest.json") return;
    if (
      !(await confirmDialog({
        title: t("deleteFile"),
        message: t("deleteConfirm", { path: selected }),
        tone: "danger",
      }))
    )
      return;
    change(files.filter((file) => file.path !== selected));
    setSelected("manifest.json");
  }
  async function uploadFiles(list: FileList | null, directory = false) {
    if (!list?.length) return;
    try {
      const additions: AppPackageFile[] = [];
      const folder = selected.includes("/")
        ? selected.slice(0, selected.lastIndexOf("/") + 1)
        : "";
      for (const file of Array.from(list)) {
        if (file.size > 2 * 1024 * 1024) throw new Error(t("fileTooLarge"));
        const path = folder + (directory ? file.webkitRelativePath : file.name);
        if (!validPackagePath(path)) throw new Error(t("invalidPath"));
        const binary = contentTypeFor(path).binary;
        const bytes = new Uint8Array(await file.arrayBuffer());
        let content = "";
        if (binary) {
          for (const byte of bytes) content += String.fromCharCode(byte);
          content = btoa(content);
        } else
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (content.length > 2 * 1024 * 1024)
          throw new Error(t("fileTooLarge"));
        additions.push({ path, content, isBinary: binary });
      }
      const replaced = additions.filter((file) =>
        files.some((existing) => existing.path === file.path),
      );
      if (
        replaced.length &&
        !(await confirmDialog({
          message: t("replaceConfirm", {
            paths: replaced.map((file) => file.path).join(", "),
          }),
        }))
      )
        return;
      change([
        ...files.filter(
          (file) => !additions.some((addition) => addition.path === file.path),
        ),
        ...additions,
      ]);
      setSelected(additions[0]!.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("failed"));
    }
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const next = packageFromSourceFiles(
        files,
        grants.filter((permission) =>
          manifest?.permissions.includes(permission),
        ),
      );
      const response = await fetch("/api/apps/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "draft",
          bundle: next,
          reason,
          expectedBaseVersionId: baseVersionId,
          sourceDraft,
        }),
      });
      // Status first: a proxy/HTML/empty refusal must surface the HTTP
      // failure, never a SyntaxError from parsing the body.
      if (!response.ok)
        throw new Error(await readApiErrorMessage(response, t("failed")));
      const result = await response.json();
      onDirtyChange?.(false);
      setDirty(false);
      router.push(result.reviewUrl);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("failed"));
    } finally {
      setBusy(false);
    }
  }
  function downloadFile() {
    if (!selectedFile) return;
    const bytes = selectedFile.isBinary
      ? Uint8Array.from(atob(selectedFile.content), (character) =>
          character.charCodeAt(0),
        )
      : new TextEncoder().encode(selectedFile.content);
    const url = URL.createObjectURL(
      new Blob([bytes], { type: contentTypeFor(selected).contentType }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = selected.split("/").at(-1)!;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function download() {
    try {
      const next = packageFromSourceFiles(
        files,
        grants.filter((permission) =>
          manifest?.permissions.includes(permission),
        ),
      );
      const { zipSync, strToU8 } = await import("fflate");
      const entries: Record<string, Uint8Array> = {
        "manifest.json": strToU8(JSON.stringify(next.manifest, null, 2)),
      };
      for (const file of next.files)
        entries[file.path] = file.isBinary
          ? Uint8Array.from(atob(file.content), (character) =>
              character.charCodeAt(0),
            )
          : strToU8(file.content);
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(zipSync(entries))], {
          type: "application/zip",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${manifest?.key ?? "app"}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("failed"));
    }
  }
  const folders = new Map<string, AppPackageFile[]>();
  for (const file of [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .filter((file) => file.path.toLowerCase().includes(search.toLowerCase()))) {
    const folder = file.path.includes("/")
      ? file.path.slice(0, file.path.lastIndexOf("/"))
      : "";
    folders.set(folder, [...(folders.get(folder) ?? []), file]);
  }
  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800">
        <AppWorkspaceTabs
          label={t("tabsLabel")}
          selected={tab}
          tabs={["general", "screens", "data", "actions", "access", "files"].map(
            key => ({ key, label: key === "files" ? t("files") : t(`sections.${key}`) }),
          )}
          onSelect={value => {
            if (hasPending) setError(t("pendingDefinition"));
            else setTab(value);
          }}
        />
        <Button type="button" variant="ghost" size="sm" onClick={download}>
          <Download size={16} />
          {t("download")}
        </Button>
      </div>
      <Alert variant="info">
        <AlertDescription>{t("draftHelp")}</AlertDescription>
      </Alert>
      {tab !== "files" ? (
        manifest ? (
          <div className="space-y-6">
            <div hidden={tab !== "general"}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="app-name">{t("name")}</Label>
                  <Input
                    id="app-name"
                    value={manifest.name}
                    onChange={(e) => patchManifest({ name: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="app-key">{t("key")}</Label>
                  <Input
                    id="app-key"
                    value={manifest.key}
                    disabled={baseVersionId !== null || !!sourceDraft}
                    onChange={(e) => patchManifest({ key: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="app-version">{t("version")}</Label>
                  <Input
                    id="app-version"
                    value={manifest.version}
                    onChange={(e) => patchManifest({ version: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="app-icon">{t("icon")}</Label>
                  <Input
                    id="app-icon"
                    value={manifest.icon ?? ""}
                    onChange={(e) => patchManifest({ icon: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="app-description">{t("description")}</Label>
                  <Textarea
                    id="app-description"
                    className="w-full"
                    rows={3}
                    value={manifest.description ?? ""}
                    onChange={(e) =>
                      patchManifest({ description: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="app-renderer">{t("renderer")}</Label>
                  <Select
                    id="app-renderer"
                    value={manifest.frontend.renderer}
                    onChange={(e) =>
                      patchManifest({
                        frontend: {
                          ...manifest.frontend,
                          renderer: e.target.value as "native" | "sandbox",
                        },
                      })
                    }
                  >
                    <option value="native">{t("native")}</option>
                    <option value="sandbox">{t("sandbox")}</option>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="app-entry">{t("entry")}</Label>
                  <Select
                    id="app-entry"
                    value={manifest.frontend.entry}
                    onChange={(e) =>
                      patchManifest({
                        frontend: {
                          ...manifest.frontend,
                          entry: e.target.value,
                        },
                      })
                    }
                  >
                    {files
                      .filter(
                        (file) =>
                          file.path !== "manifest.json" && !file.isBinary,
                      )
                      .map((file) => (
                        <option key={file.path}>{file.path}</option>
                      ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="app-nav-label">{t("navLabel")}</Label>
                  <Input
                    id="app-nav-label"
                    value={manifest.nav?.label ?? ""}
                    onChange={(e) =>
                      patchManifest({
                        nav: { ...manifest.nav, label: e.target.value },
                      })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="app-nav-icon">{t("navIcon")}</Label>
                  <Input
                    id="app-nav-icon"
                    value={manifest.nav?.icon ?? ""}
                    onChange={(e) =>
                      patchManifest({
                        nav: { ...manifest.nav, icon: e.target.value },
                      })
                    }
                  />
                </div>
              </div>
            </div>
            <section
              hidden={tab !== "actions"}
              className="space-y-3"
            >
              <h3 className="text-sm font-semibold">{t("endpoints")}</h3>
              <p className="text-sm text-slate-500">{t("endpointsHelp")}</p>
              {manifest.endpoints.map((endpoint, index) => (
                <div
                  key={index}
                  className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_auto_auto] items-end gap-2"
                >
                  <Input
                    aria-label={t("endpointName")}
                    value={endpoint.name}
                    onChange={(e) =>
                      patchManifest({
                        endpoints: manifest.endpoints.map((value, i) =>
                          i === index
                            ? { ...value, name: e.target.value }
                            : value,
                        ),
                      })
                    }
                  />
                  <Select
                    aria-label={t("endpointFile")}
                    value={endpoint.file}
                    onChange={(e) =>
                      patchManifest({
                        endpoints: manifest.endpoints.map((value, i) =>
                          i === index
                            ? { ...value, file: e.target.value }
                            : value,
                        ),
                      })
                    }
                  >
                    {files
                      .filter((file) => /\.js$/.test(file.path))
                      .map((file) => (
                        <option key={file.path}>{file.path}</option>
                      ))}
                  </Select>
                  <Select
                    aria-label={t("method")}
                    value={endpoint.method}
                    onChange={(e) =>
                      patchManifest({
                        endpoints: manifest.endpoints.map((value, i) =>
                          i === index
                            ? {
                                ...value,
                                method: e.target.value as
                                  "GET" | "POST" | "ANY",
                              }
                            : value,
                        ),
                      })
                    }
                  >
                    {["GET", "POST", "ANY"].map((method) => (
                      <option key={method}>{method}</option>
                    ))}
                  </Select>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t("removeEndpoint")}
                    onClick={() =>
                      patchManifest({
                        endpoints: manifest.endpoints.filter(
                          (_, i) => i !== index,
                        ),
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const name = nextActionName(manifest.endpoints);
                  const path = `backend/${name}.js`;
                  if (files.some((file) => file.path === path)) {
                    setError(t("invalidPath"));
                    return;
                  }
                  const updated: AppManifest = {
                    ...manifest,
                    endpoints: [
                      ...manifest.endpoints,
                      { name, file: path, method: "POST" },
                    ],
                  };
                  setManifest(updated);
                  change([
                    ...files.map((file) =>
                      file.path === "manifest.json"
                        ? { ...file, content: JSON.stringify(updated, null, 2) }
                        : file,
                    ),
                    {
                      path,
                      content:
                        "function handler(request) {\n  return { ok: true };\n}\n",
                    },
                  ]);
                }}
              >
                <Plus size={16} />
                {t("addEndpoint")}
              </Button>
            </section>
            <div hidden={tab !== "access"} className="space-y-6">
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">{t("permissions")}</h3>
                <p className="text-sm text-slate-500">{t("permissionsHelp")}</p>
                <div className="grid max-h-64 gap-2 overflow-auto rounded-lg border border-slate-200 p-3 sm:grid-cols-2 dark:border-slate-800">
                  {APP_PLATFORM_PERMISSIONS.map((permission) => (
                    <label
                      key={permission}
                      className="flex items-start gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={manifest.permissions.includes(permission)}
                        onChange={(e) => {
                          patchManifest({
                            permissions: e.target.checked
                              ? [...manifest.permissions, permission]
                              : manifest.permissions.filter(
                                  (value) => value !== permission,
                                ),
                          });
                          setGrants((previous) =>
                            e.target.checked
                              ? [...previous, permission]
                              : previous.filter(
                                  (value) => value !== permission,
                                ),
                          );
                        }}
                      />
                      <span className="break-all">{permission}</span>
                    </label>
                  ))}
                </div>
              </section>
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">{t("grants")}</h3>
                <p className="text-sm text-slate-500">{t("grantsHelp")}</p>
                {manifest.permissions.map((permission) => (
                  <label key={permission} className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={grants.includes(permission)}
                      onChange={(e) => {
                        setGrants((previous) =>
                          e.target.checked
                            ? [...previous, permission]
                            : previous.filter((value) => value !== permission),
                        );
                        setDirty(true);
                        onDirtyChange?.(true);
                      }}
                    />
                    {permission}
                  </label>
                ))}
              </section>
            </div>
            <div hidden={tab !== "screens"} className="space-y-6">
              {manifest.frontend.renderer === "native" ? (
                <AppScreens
                  onPendingChange={(value) => pendingChanged("screens", value)}
                  files={files}
                  manifest={manifest}
                  onFiles={change}
                  onOpen={(path) => {
                    if (hasPending) {
                      setError(t("pendingDefinition"));
                      return;
                    }
                    setSelected(path);
                    setTab("files");
                  }}
                />
              ) : null}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">{t("definitions")}</h3>
                <p className="text-sm text-slate-500">{t("definitionsHelp")}</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (hasPending) {
                      setError(t("pendingDefinition"));
                      return;
                    }
                    setSelected(
                      manifest.frontend.renderer === "native"
                        ? manifest.frontend.entry
                        : "manifest.json",
                    );
                    setTab("files");
                  }}
                >
                  {t("editDefinitions")}
                </Button>
              </section>
            </div>
            <div hidden={tab !== "data"}>
              <AppDefinitions
                onPendingChange={(value) =>
                  pendingChanged("definitions", value)
                }
                files={files}
                manifest={manifest}
                onFiles={change}
                onManifest={patchManifest}
                onOpen={(path) => {
                  if (hasPending) {
                    setError(t("pendingDefinition"));
                    return;
                  }
                  setSelected(path);
                  setTab("files");
                }}
              />
            </div>
          </div>
        ) : (
          <Alert variant="destructive">
            <AlertDescription>
              {t("invalidManifest")}{" "}
              <Button variant="ghost" onClick={() => setTab("files")}>
                {t("files")}
              </Button>
            </AlertDescription>
          </Alert>
        )
      ) : (
        <div className="grid min-w-0 gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="min-w-0 space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <Input
              aria-label={t("searchFiles")}
              placeholder={t("searchFiles")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="flex gap-1">
              <Button
                size="icon"
                variant="outline"
                type="button"
                aria-label={t("newFile")}
                onClick={addFile}
              >
                <Plus size={16} />
              </Button>
              <Button
                size="icon"
                variant="outline"
                type="button"
                aria-label={t("uploadFiles")}
                onClick={() => upload.current?.click()}
              >
                <Upload size={16} />
              </Button>
              <Button
                size="icon"
                variant="outline"
                type="button"
                aria-label={t("uploadFolder")}
                onClick={() => directoryUpload.current?.click()}
              >
                <Folder size={16} />
              </Button>
              <input
                ref={(element) => {
                  directoryUpload.current = element;
                  element?.setAttribute("webkitdirectory", "");
                }}
                className="hidden"
                type="file"
                multiple
                onChange={(event) => {
                  void uploadFiles(event.target.files, true);
                  event.target.value = "";
                }}
              />
              <input
                ref={upload}
                className="hidden"
                type="file"
                multiple
                onChange={(e) => {
                  void uploadFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
            <nav
              aria-label={t("files")}
              className="max-h-96 overflow-auto text-sm"
            >
              {[...folders].map(([folder, entries]) => (
                <div key={folder} className="mb-2">
                  {folder ? (
                    <div className="flex items-center gap-1.5 py-1 text-xs text-slate-500">
                      <Folder size={14} />
                      {folder}
                    </div>
                  ) : null}
                  {entries.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => setSelected(file.path)}
                      aria-current={selected === file.path ? "true" : undefined}
                      title={file.path}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left",
                        selected === file.path
                          ? "bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200"
                          : "hover:bg-slate-100 dark:hover:bg-slate-800",
                      )}
                    >
                      <FileCode2 size={14} className="shrink-0" />
                      <span className="truncate">
                        {file.path.split("/").at(-1)}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </nav>
          </aside>
          <section className="min-w-0 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="truncate font-mono text-sm">{selected}</h3>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t("downloadFile")}
                  onClick={downloadFile}
                >
                  <Download size={16} />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={selected === "manifest.json"}
                  aria-label={t("renameFile")}
                  onClick={renameFile}
                >
                  <Pencil size={16} />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={selected === "manifest.json"}
                  aria-label={t("deleteFile")}
                  onClick={removeFile}
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            </div>
            {selectedFile?.isBinary ? (
              <p className="rounded-lg border border-dashed p-8 text-sm text-slate-500">
                {t("binaryHelp")}
              </p>
            ) : (
              <CodeEditor
                path={selected}
                value={selectedFile?.content ?? ""}
                onChange={(content) => {
                  change(
                    files.map((file) =>
                      file.path === selected ? { ...file, content } : file,
                    ),
                  );
                  if (selected === "manifest.json") {
                    try {
                      setManifest(parseManifest(JSON.parse(content)).manifest);
                    } catch {
                      setManifest(undefined);
                    }
                  }
                }}
              />
            )}
          </section>
        </div>
      )}
      <div className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
        <Label htmlFor="app-change-reason">{t("reason")}</Label>
        <Textarea
          id="app-change-reason"
          className="w-full"
          rows={2}
          maxLength={2000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("reasonPlaceholder")}
        />
      </div>
      {hasPending ? (
        <p role="status" className="text-sm text-amber-700">
          {t("pendingDefinition")}
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={busy || hasPending || !reason.trim()}
          onClick={save}
        >
          {busy ? t("saving") : t("saveDraft")}
        </Button>
        <span className="text-sm text-slate-500">
          {dirty ? t("unsaved") : t("notLive")}
        </span>
      </div>
    </div>
  );
}
