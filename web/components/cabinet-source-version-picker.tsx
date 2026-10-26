"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Label, SearchSelect } from "@openbooks/ui";
import { CabinetFilePicker } from "./cabinet-file-picker";
import { readApiErrorMessage } from "@/lib/api-error";
import { isUuid } from "@/lib/list-params";
import type { HistoricalTranslationSourceReference } from "@openbooks/engine/journal/historical-translation-evidence";

type Version = { id: string; versionNumber: number; contentHash: string };

/** Explicit version selection binds documentary evidence to retained Cabinet bytes. */
export function CabinetSourceVersionPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: HistoricalTranslationSourceReference;
  onChange: (source: HistoricalTranslationSourceReference) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("journal.historicalTranslation");
  const [result, setResult] = useState<{
    fileId: string;
    name?: string;
    versions?: Version[];
    error?: string;
  } | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!value.fileId) return;
    const controller = new AbortController();
    const fileId = value.fileId;
    fetch(`/api/file-cabinet/files/${encodeURIComponent(fileId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t("sourceFailed")));
        const payload = (await response.json()) as {
          file?: { id?: unknown; name?: unknown; versions?: unknown };
        };
        if (
          payload.file?.id !== fileId ||
          typeof payload.file.name !== "string" ||
          !Array.isArray(payload.file.versions)
        )
          throw new Error(t("sourceFailed"));
        const versions = payload.file.versions.flatMap((candidate: unknown) => {
          if (!candidate || typeof candidate !== "object") return [];
          const row = candidate as { id?: unknown; versionNumber?: unknown; contentHash?: unknown };
          return typeof row.id === "string" &&
            isUuid(row.id) &&
            typeof row.versionNumber === "number" &&
            Number.isSafeInteger(row.versionNumber) &&
            row.versionNumber > 0 &&
            typeof row.contentHash === "string" &&
            /^[a-f0-9]{64}$/.test(row.contentHash)
            ? [{ id: row.id, versionNumber: row.versionNumber, contentHash: row.contentHash }]
            : [];
        });
        if (!controller.signal.aborted) setResult({ fileId, name: payload.file.name, versions });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setResult({ fileId, error: error instanceof Error ? error.message : t("sourceFailed") });
      });
    return () => controller.abort();
  }, [value.fileId, reload, t]);
  const current = result?.fileId === value.fileId ? result : null;
  return (
    <div className="space-y-2">
      <Label>{t("sourceFile")}</Label>
      <CabinetFilePicker
        value={value.fileId}
        label={t("sourceFile")}
        disabled={disabled}
        onChange={(fileId) => onChange({ fileId, versionId: "", contentHash: "" })}
      />
      {value.fileId ? (
        <>
          {current?.name ? <p className="text-sm">{current.name}</p> : null}
          <Label>{t("sourceVersion")}</Label>
          <SearchSelect
            ariaLabel={t("sourceVersion")}
            value={value.versionId}
            disabled={disabled || !current?.versions}
            loading={!current}
            placeholder={t("chooseVersion")}
            options={(current?.versions ?? []).map((version) => ({
              value: version.id,
              label: t("version", { number: version.versionNumber }),
            }))}
            onChange={(versionId) => {
              const version = current?.versions?.find((row) => row.id === versionId);
              if (version)
                onChange({
                  fileId: value.fileId,
                  versionId: version.id,
                  contentHash: version.contentHash,
                });
            }}
          />
          {current?.versions?.length === 0 ? (
            <p role="alert" className="text-sm text-destructive">
              {t("noHashedVersion")}
            </p>
          ) : null}
          {value.contentHash ? (
            <p className="break-all font-mono text-xs text-muted-foreground">
              {t("sourceHash")}: {value.contentHash}
            </p>
          ) : null}
          {current?.error ? (
            <div role="alert" className="text-sm text-destructive">
              {current.error}{" "}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setResult(null);
                  setReload((n) => n + 1);
                }}
              >
                {t("retry")}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
