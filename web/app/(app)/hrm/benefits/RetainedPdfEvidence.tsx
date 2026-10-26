"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Input, Label, Select, Textarea } from "@openbooks/ui";
import { CabinetFilePicker } from "../../../../components/cabinet-file-picker";
import { readApiErrorMessage } from "../../../../lib/api-error";
import type { RetainedSourceArtifactSelection } from "@openbooks/engine/hrm/benefits";

export type PdfEvidenceInput = RetainedSourceArtifactSelection & {
  pdfSelection: NonNullable<RetainedSourceArtifactSelection["pdfSelection"]>;
};
const facts = [
  "sourceRowRef",
  "value",
  "currency",
  "periodFrom",
  "periodTo",
  "sourceIssueDate",
  "sourcePaidDate",
] as const;
const labels = {
  sourceRowRef: "rowReferenceField",
  value: "amountField",
  currency: "currencyField",
  periodFrom: "periodFromField",
  periodTo: "periodToField",
  sourceIssueDate: "issueDateField",
  sourcePaidDate: "paidDateField",
} as const;

/** Related evidence stays scoped to the selected source obligation. */
export function RetainedPdfEvidence({
  value,
  onChange,
  disabled,
  onRemove,
}: {
  value: PdfEvidenceInput;
  onChange: (value: PdfEvidenceInput) => void;
  disabled: boolean;
  onRemove: () => void;
}) {
  const t = useTranslations("hrm.sourceFirst");
  const [versions, setVersions] = useState<{ id: string; number: string }[]>([]);
  const [error, setError] = useState("");
  const [newFact, setNewFact] = useState<(typeof facts)[number]>("value");
  useEffect(() => {
    if (!value.fileId) return;
    const controller = new AbortController();
    void fetch(`/api/file-cabinet/files/${encodeURIComponent(value.fileId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, t("fileLookupFailed")));
        const payload = (await response.json()) as {
          file?: { versions?: { id: string; versionNumber: unknown }[] };
        };
        if (!controller.signal.aborted)
          setVersions(
            (payload.file?.versions ?? []).map((v) => ({
              id: v.id,
              number: String(v.versionNumber),
            })),
          );
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : t("fileLookupFailed"));
      });
    return () => controller.abort();
  }, [value.fileId, t]);
  const selection = value.pdfSelection;
  return (
    <fieldset className="space-y-3 rounded border p-3" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">{t("pdfEvidence")}</legend>
      <CabinetFilePicker
        label={t("issuedFile")}
        value={value.fileId}
        onChange={(fileId) => {
          setError("");
          setVersions([]);
          onChange({ ...value, fileId, versionId: "" });
        }}
        disabled={disabled}
      />
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <Label>
        {t("fileVersion")}
        <Select
          value={value.versionId}
          onChange={(event) => onChange({ ...value, versionId: event.target.value })}
        >
          <option value="">{t("chooseRow")}</option>
          {versions.map((version) => (
            <option key={version.id} value={version.id}>
              {t("version", { number: version.number })}
            </option>
          ))}
        </Select>
      </Label>
      <Label>
        {t("pdfPage")}
        <Input
          type="number"
          min={1}
          max={2000}
          value={selection.page}
          onChange={(event) =>
            onChange({ ...value, pdfSelection: { ...selection, page: Number(event.target.value) } })
          }
        />
      </Label>
      <Label>
        {t("pdfAnchor")}
        <Textarea
          value={selection.anchor}
          onChange={(event) =>
            onChange({ ...value, pdfSelection: { ...selection, anchor: event.target.value } })
          }
        />
      </Label>
      <p className="text-xs text-slate-500">{t("pdfHint")}</p>
      {facts
        .filter((fact) => selection.fields[fact] !== undefined)
        .map((fact) => {
          const field = selection.fields[fact]!;
          const change = (patch: Partial<typeof field>) =>
            onChange({
              ...value,
              pdfSelection: {
                ...selection,
                fields: { ...selection.fields, [fact]: { ...field, ...patch } },
              },
            });
          return (
            <div key={fact} className="space-y-2 border-t pt-2">
              <p className="text-sm font-medium">{t(labels[fact])}</p>
              <Label>
                {t("pdfQuote")}
                <Textarea
                  value={field.quote}
                  onChange={(event) => change({ quote: event.target.value })}
                />
              </Label>
              <Label>
                {t("pdfLiteral")}
                <Input
                  value={field.value}
                  onChange={(event) => change({ value: event.target.value })}
                />
              </Label>
              <Label>
                {t("pdfFormat")}
                <Select
                  value={field.format}
                  onChange={(event) =>
                    change({ format: event.target.value as typeof field.format })
                  }
                >
                  <option value="text">{t("pdfText")}</option>
                  <option value="decimal">1234.56</option>
                  <option value="grouped-decimal">1,234.56</option>
                  <option value="iso-date">YYYY-MM-DD</option>
                  <option value="us-date">MM/DD/YYYY</option>
                  <option value="iso-timestamp-date">YYYY-MM-DD HH:mm:ss</option>
                </Select>
              </Label>
              <Button
                variant="ghost"
                type="button"
                onClick={() => {
                  const fields = { ...selection.fields };
                  delete fields[fact];
                  onChange({ ...value, pdfSelection: { ...selection, fields } });
                }}
              >
                {t("removeEvidenceField")}
              </Button>
            </div>
          );
        })}
      {facts.some((fact) => selection.fields[fact] === undefined) ? (
        <div className="flex gap-2">
          <Select
            value={newFact}
            onChange={(event) => setNewFact(event.target.value as typeof newFact)}
          >
            {facts
              .filter((fact) => selection.fields[fact] === undefined)
              .map((fact) => (
                <option key={fact} value={fact}>
                  {t(labels[fact])}
                </option>
              ))}
          </Select>
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              const fact = selection.fields[newFact]
                ? facts.find((fact) => !selection.fields[fact])!
                : newFact;
              onChange({
                ...value,
                pdfSelection: {
                  ...selection,
                  fields: {
                    ...selection.fields,
                    [fact]: {
                      quote: "",
                      value: "",
                      format:
                        fact === "value"
                          ? "grouped-decimal"
                          : fact.endsWith("Date") || fact === "periodFrom" || fact === "periodTo"
                            ? "iso-date"
                            : "text",
                    },
                  },
                },
              });
            }}
          >
            {t("addEvidenceField")}
          </Button>
        </div>
      ) : null}
      <Button variant="ghost" type="button" onClick={onRemove}>
        {t("removePdfEvidence")}
      </Button>
    </fieldset>
  );
}
