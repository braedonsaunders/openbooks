"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ListPageLayout } from "../../../../components/page-layout";
import { PagedTable } from "../../../../components/paged-table";
import { enumLabel } from "@/lib/enum-label";
import { toast } from "sonner";
import { GitMerge, Play } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from "@openbooks/ui";

type DuplicateProject = {
  id: string;
  code: string | null;
  name: string;
  customerId: string | null;
  status: string;
  isActive: boolean;
};

type DuplicateGroup = {
  kind: "source_ref" | "name_customer" | "job_number";
  key: string;
  projects: DuplicateProject[];
};

type Preview = {
  groupKey: string;
  survivorId: string;
  duplicateId: string;
  moved: { table: string; rows: number }[];
  customRefs: { table: string; key: string; rows: number }[];
  alreadyMerged: boolean;
};

function withoutKey(
  current: Record<string, string>,
  key: string,
): Record<string, string> {
  if (!(key in current)) return current;
  const next = { ...current };
  delete next[key];
  return next;
}

function withoutPreview(
  current: Record<string, Preview>,
  key: string,
): Record<string, Preview> {
  if (!(key in current)) return current;
  const next = { ...current };
  delete next[key];
  return next;
}

export function ProjectDuplicatesView({ canMerge }: { canMerge: boolean }) {
  const t = useTranslations("projects");
  const tCommon = useTranslations("common");
  // The full project lifecycle, not just the pre-award trio: duplicates can
  // group active, closed and cancelled projects, and those rendered as an
  // unknown-value fallback read as a data defect.
  const projectStatusLabels = {
    quoted: t("status.quoted"),
    awarded: t("status.awarded"),
    active: t("status.active"),
    substantially_complete: t("status.substantially_complete"),
    closed: t("status.closed"),
    cancelled: t("status.cancelled"),
  } satisfies Record<
    | "quoted"
    | "awarded"
    | "active"
    | "substantially_complete"
    | "closed"
    | "cancelled",
    string
  >;
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [survivors, setSurvivors] = useState<Record<string, string>>({});
  // One cached preview per group + duplicate row. The survivor direction is
  // part of the identity: a count previewed for the other direction must
  // never render as this direction's impact.
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  // A refused preview/merge pins here, per group, until the next action in
  // that group — a toast alone left the previous direction's success on
  // screen as if it were the answer.
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>(
    {},
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    // Own catch: merge awaits this after a successful POST, and a reload
    // failure must toast as a load failure, never as a merge failure.
    try {
      const response = await fetch("/api/projects/duplicates");
      if (!response.ok) {
        toast.error(t("duplicates.loadFailed"));
        return;
      }
      const payload = (await response.json()) as { groups: DuplicateGroup[] };
      setGroups(payload.groups);
      setPreviews({});
      setPreviewErrors({});
    } catch {
      toast.error(t("duplicates.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/projects/duplicates")
      .then((r) => (r.ok ? r.json() : null))
      .then((payload: { groups: DuplicateGroup[] } | null) => {
        if (cancelled) return;
        if (!payload) {
          setLoadFailed(true);
          return;
        }
        setGroups(payload.groups);
        setPreviews({});
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function preview(
    groupKey: string,
    survivorId: string,
    duplicateId: string,
  ) {
    const key = `${groupKey}:${duplicateId}`;
    setBusy(duplicateId);
    setPreviewErrors((current) => withoutKey(current, groupKey));
    try {
      const response = await fetch(
        `/api/projects/merge?survivorId=${encodeURIComponent(survivorId)}&duplicateId=${encodeURIComponent(duplicateId)}`,
      );
      // The status is checked before the body parses: a non-JSON error page
      // must name the translated failure, never throw out of .json() and
      // leave the previous direction's success on screen.
      if (!response.ok) {
        const refused = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        const message = refused?.error ?? t("duplicates.previewFailed");
        toast.error(message);
        // The refusal replaces the cached preview for this pair: the last
        // good direction's counts must not survive as a stale success.
        setPreviews((current) => withoutPreview(current, key));
        setPreviewErrors((current) => ({ ...current, [groupKey]: message }));
        return;
      }
      const payload = (await response.json()) as Preview;
      setPreviews((current) => ({
        ...current,
        [key]: { ...payload, groupKey, survivorId, duplicateId },
      }));
    } catch {
      const message = t("duplicates.previewFailed");
      toast.error(message);
      setPreviews((current) => withoutPreview(current, key));
      setPreviewErrors((current) => ({ ...current, [groupKey]: message }));
    } finally {
      setBusy(null);
    }
  }

  async function merge(
    groupKey: string,
    survivorId: string,
    duplicateId: string,
  ) {
    setBusy(duplicateId);
    setPreviewErrors((current) => withoutKey(current, groupKey));
    try {
      const response = await fetch("/api/projects/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ survivorId, duplicateId }),
      });
      // The status is checked before the body parses, like preview above.
      if (!response.ok) {
        const refused = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        const message = refused?.error ?? t("duplicates.mergeFailed");
        toast.error(message);
        setPreviewErrors((current) => ({ ...current, [groupKey]: message }));
        return;
      }
      toast.success(t("duplicates.merged"));
      setPreviews((current) =>
        withoutPreview(current, `${groupKey}:${duplicateId}`),
      );
      await load();
    } catch {
      const message = t("duplicates.mergeFailed");
      toast.error(message);
      setPreviewErrors((current) => ({ ...current, [groupKey]: message }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t("duplicates.title")}
          description={t("duplicates.description")}
        />
      }
      className="space-y-4"
    >
      {loadFailed ? (
        <p className="text-sm text-red-600">{t("duplicates.loadFailed")}</p>
      ) : groups === null ? (
        <p className="text-sm text-slate-500">{t("duplicates.loading")}</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-slate-500">{t("duplicates.empty")}</p>
      ) : (
        groups.map((group, index) => {
          const groupKey = `${group.kind}:${group.key}:${index}`;
          const survivorId = survivors[groupKey] ?? group.projects[0]?.id ?? "";
          return (
            <Card key={groupKey}>
              <CardHeader>
                <CardTitle>
                  {t(`duplicates.kind.${group.kind}`, { key: group.key })}
                </CardTitle>
                <CardDescription>
                  {t("duplicates.chooseSurvivor")}
                </CardDescription>
              </CardHeader>
              {previewErrors[groupKey] ? (
                <div className="px-6 pb-2">
                  <p
                    role="alert"
                    className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
                  >
                    {previewErrors[groupKey]}
                  </p>
                </div>
              ) : null}
              <CardContent>
                <PagedTable
                  source="projects_duplicate_candidates"
                  emptyAsRow
                  rows={group.projects}
                  rowKey={(project) => project.id}
                  empty={t("duplicates.empty")}
                  searchable
                  columns={[
                    {
                      key: "survivor",
                      header: t("duplicates.survivor"),
                      cell: (project) => (
                        <input
                          type="radio"
                          name={groupKey}
                          checked={survivorId === project.id}
                          onChange={() => {
                            setSurvivors((current) => ({
                              ...current,
                              [groupKey]: project.id,
                            }));
                            setPreviewErrors((current) =>
                              withoutKey(current, groupKey),
                            );
                          }}
                          aria-label={t("duplicates.survivor")}
                        />
                      ),
                    },
                    {
                      key: "code",
                      header: t("duplicates.code"),
                      cell: (project) => (
                        <span className="font-mono">{project.code ?? "—"}</span>
                      ),
                      search: (project) => project.code ?? "",
                    },
                    {
                      key: "name",
                      header: t("duplicates.name"),
                      cell: (project) => project.name,
                      search: (project) => project.name,
                    },
                    {
                      key: "status",
                      header: t("duplicates.status"),
                      cell: (project) => (
                        <Badge
                          variant={project.isActive ? "success" : "warning"}
                        >
                          {enumLabel(
                            project.status,
                            projectStatusLabels,
                            tCommon("labels.unknownValue"),
                          )}
                        </Badge>
                      ),
                    },
                    {
                      key: "action",
                      header: t("duplicates.action"),
                      cell: (project) => {
                        const cached = previews[`${groupKey}:${project.id}`];
                        const previewResult =
                          cached && cached.survivorId === survivorId
                            ? cached
                            : null;
                        const movedTotal = previewResult
                          ? previewResult.moved.reduce(
                              (sum, item) => sum + item.rows,
                              0,
                            )
                          : 0;
                        return project.id === survivorId ? (
                          <span className="text-xs text-slate-500">
                            {t("duplicates.kept")}
                          </span>
                        ) : (
                          <div className="flex items-center gap-2">
                            {canMerge ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy !== null}
                                onClick={() =>
                                  preview(groupKey, survivorId, project.id)
                                }
                              >
                                {t("duplicates.preview")}
                              </Button>
                            ) : null}
                            {canMerge &&
                            previewResult &&
                            !previewResult.alreadyMerged ? (
                              <Button
                                size="sm"
                                disabled={busy !== null}
                                onClick={() =>
                                  merge(groupKey, survivorId, project.id)
                                }
                              >
                                <GitMerge size={13} />
                                {t("duplicates.merge", { count: movedTotal })}
                              </Button>
                            ) : null}
                            {previewResult ? (
                              <span className="text-xs text-slate-500">
                                {previewResult.alreadyMerged
                                  ? t("duplicates.alreadyMerged")
                                  : t("duplicates.moveCount", {
                                      count: movedTotal,
                                    })}
                              </span>
                            ) : null}
                          </div>
                        );
                      },
                    },
                  ]}
                />
              </CardContent>
            </Card>
          );
        })
      )}
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Play size={13} />
        {t("duplicates.impactNote")}
      </div>
    </ListPageLayout>
  );
}
