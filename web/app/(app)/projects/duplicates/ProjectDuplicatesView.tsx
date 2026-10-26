"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, Label, Select, UrlDrawer } from "@openbooks/ui";
import type { DuplicateGroup } from "@openbooks/engine/projects/merge";
import { readApiErrorMessage } from "../../../../lib/api-error";

type Project = DuplicateGroup["projects"][number];

type MergePreview = {
  survivorId: string;
  duplicateId: string;
  moved: { table: string; rows: number }[];
  customRefs: { table: string; key: string; rows: number }[];
  alreadyMerged: boolean;
};

export function ProjectDuplicatesView({
  group,
  canMerge,
}: {
  group: DuplicateGroup;
  canMerge: boolean;
}) {
  const t = useTranslations("projects");
  const router = useRouter();
  const [survivorId, setSurvivorId] = useState(group.projects[0]?.id ?? "");
  const [duplicateId, setDuplicateId] = useState(group.projects[1]?.id ?? "");
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const duplicateCandidates = useMemo(
    () => group.projects.filter((project) => project.id !== survivorId),
    [group.projects, survivorId],
  );
  const effectiveDuplicateId = duplicateCandidates.some((project) => project.id === duplicateId)
    ? duplicateId
    : (duplicateCandidates[0]?.id ?? "");
  const activePreview =
    preview?.survivorId === survivorId && preview.duplicateId === effectiveDuplicateId
      ? preview
      : null;
  const movedCount = activePreview
    ? [...activePreview.moved, ...activePreview.customRefs].reduce((sum, row) => sum + row.rows, 0)
    : 0;

  function selectSurvivor(id: string) {
    setSurvivorId(id);
    setPreview(null);
    setError(null);
  }

  async function previewMerge() {
    if (!canMerge || !survivorId || !effectiveDuplicateId) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const query = new URLSearchParams({ survivorId, duplicateId: effectiveDuplicateId });
      const response = await fetch(`/api/projects/merge?${query}`);
      if (!response.ok) {
        setError(await readApiErrorMessage(response, t("duplicates.previewFailed")));
        return;
      }
      setPreview((await response.json()) as MergePreview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("duplicates.previewFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function merge() {
    if (!canMerge || !activePreview || activePreview.alreadyMerged) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/projects/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ survivorId, duplicateId: effectiveDuplicateId }),
      });
      if (!response.ok) {
        setError(await readApiErrorMessage(response, t("duplicates.mergeFailed")));
        return;
      }
      toast.success(t("duplicates.merged"));
      router.replace("/projects/duplicates");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("duplicates.mergeFailed"));
    } finally {
      setBusy(false);
    }
  }

  function projectOption(project: Project) {
    return `${project.name}${project.code ? ` · ${project.code}` : ""}`;
  }

  return (
    <UrlDrawer
      open
      closeHref="/projects/duplicates"
      size="xl"
      title={t(`duplicates.kind.${group.kind}`, { key: group.key })}
      description={t("duplicates.chooseSurvivor")}
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="duplicate-project-survivor">{t("duplicates.survivor")}</Label>
          <Select
            id="duplicate-project-survivor"
            value={survivorId}
            onChange={(event) => selectSurvivor(event.target.value)}
            disabled={busy || !canMerge}
          >
            {group.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {projectOption(project)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="duplicate-project-source">{t("duplicates.mergeSource")}</Label>
          <Select
            id="duplicate-project-source"
            value={effectiveDuplicateId}
            onChange={(event) => {
              setDuplicateId(event.target.value);
              setPreview(null);
              setError(null);
            }}
            disabled={busy || !canMerge}
          >
            {duplicateCandidates.map((project) => (
              <option key={project.id} value={project.id}>
                {projectOption(project)}
              </option>
            ))}
          </Select>
        </div>
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
          >
            {error}
          </p>
        ) : null}
        {activePreview ? (
          <p role="status" className="text-sm text-slate-600 dark:text-slate-300">
            {activePreview.alreadyMerged
              ? t("duplicates.alreadyMerged")
              : t("duplicates.moveCount", { count: movedCount })}
          </p>
        ) : null}
        {!canMerge ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t("duplicates.manageRequired")}
          </p>
        ) : null}
        {canMerge ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy || !effectiveDuplicateId}
              onClick={previewMerge}
            >
              {t("duplicates.preview")}
            </Button>
            {activePreview && !activePreview.alreadyMerged ? (
              <Button type="button" disabled={busy} onClick={merge}>
                {t("duplicates.merge", { count: movedCount })}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </UrlDrawer>
  );
}
