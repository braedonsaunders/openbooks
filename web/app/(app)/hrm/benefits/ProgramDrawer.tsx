"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { Alert, Badge, Button, Drawer, Input, Label, Select, Textarea } from "@openbooks/ui";
import { parseExactJson } from "@openbooks/engine/platform/exact-json";
import { SublistAddButton } from "../../../../components/drawer-sublist";
import { readApiErrorMessage } from "../../../../lib/api-error";
import { promptDialog } from "../../../../lib/prompt";
import { useDirtyClose } from "../../../../lib/use-dirty-close";
import {
  isProgramEditable,
  programResourceUrl,
  validateMembershipDraft,
  type MembershipDraft,
} from "../../../../lib/hrm/benefits-portfolio";
import type { BuilderOption } from "../../../../lib/hrm/benefits-portfolio";
import { TransactionDrawer } from "../../../../components/transaction-drawer";
import { InspectorPanel } from "../../../../components/builder/builder-kit";
import { PagedTable } from "../../../../components/paged-table";
import { AwardPortfolioTable, useEffectiveRangeLabel } from "./PortfolioTables";
import type { ProgramDetailDrawer } from "../../../../lib/hrm/benefits-workspace";
import { CabinetFilePicker } from "../../../../components/cabinet-file-picker";
import { RetainedPdfEvidence, type PdfEvidenceInput } from "./RetainedPdfEvidence";
import { DateField } from "../../../../components/date-field";

type RetainedRowOption = { pointer: string; label: string; row: Record<string, unknown> };
type RetainedFieldOption = { pointer: string; label: string; sample: string };
type RetainedVersionOption = { id: string; label: string };
type RetainedFieldName =
  | "sourceRowRef"
  | "amount"
  | "currency"
  | "periodFrom"
  | "periodTo"
  | "sourceIssueDate"
  | "sourcePaidDate";
type SourceEvidenceClass = "missing-source-identity" | "source-paid-above-native-measure";
const ROOT_ROW_SELECTION = "$root";

function pointerEscape(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function humanFieldName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function retainedRowOptions(
  document: unknown,
  rowName: (number: number) => string,
): RetainedRowOption[] {
  const rows: RetainedRowOption[] = [];
  const visit = (value: unknown, pointer: string, depth: number) => {
    if (depth > 12 || rows.length >= 2000) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        const childPointer = `${pointer}/${index}`;
        if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
          const row = entry as Record<string, unknown>;
          const summary = Object.entries(row)
            .filter(([, item]) => ["string", "number", "boolean"].includes(typeof item))
            .slice(0, 2)
            .map(([key, item]) => `${humanFieldName(key)}: ${String(item).slice(0, 48)}`)
            .join(" · ");
          const number = rows.length + 1;
          rows.push({
            pointer: childPointer,
            label: summary ? `${rowName(number)} · ${summary}` : rowName(number),
            row,
          });
        } else if (entry !== null && typeof entry === "object")
          visit(entry, childPointer, depth + 1);
      });
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (child !== null && typeof child === "object")
          visit(child, `${pointer}/${pointerEscape(key)}`, depth + 1);
      }
    }
  };
  visit(document, "", 0);
  if (
    rows.length === 0 &&
    document !== null &&
    typeof document === "object" &&
    !Array.isArray(document)
  ) {
    rows.push({
      pointer: ROOT_ROW_SELECTION,
      label: rowName(1),
      row: document as Record<string, unknown>,
    });
  }
  return rows;
}

function retainedFieldOptions(row: Record<string, unknown> | undefined): RetainedFieldOption[] {
  if (!row) return [];
  const fields: RetainedFieldOption[] = [];
  const visit = (value: unknown, pointer: string, label: string, depth: number) => {
    if (depth > 6 || fields.length >= 200) return;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      fields.push({
        pointer,
        label: humanFieldName(label),
        sample: String(value ?? "").slice(0, 48),
      });
      return;
    }
    if (Array.isArray(value)) return;
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(
          child,
          `${pointer}/${pointerEscape(key)}`,
          label ? `${label}.${key}` : key,
          depth + 1,
        );
      }
    }
  };
  for (const [key, value] of Object.entries(row)) visit(value, `/${pointerEscape(key)}`, key, 0);
  return fields;
}

function suggestedFieldPointer(
  fields: readonly RetainedFieldOption[],
  field: RetainedFieldName,
): string {
  const aliases: Record<RetainedFieldName, readonly string[]> = {
    sourceRowRef: [
      "sourcerowref",
      "sourcecard",
      "awardref",
      "sourceref",
      "externalid",
      "card",
      "awardid",
      "transactionid",
      "reference",
      "id",
    ],
    amount: ["amount", "value", "awardamount", "grossamount"],
    currency: ["currency", "currencycode"],
    periodFrom: ["periodfrom", "earningfrom", "startdate", "fromdate"],
    periodTo: ["periodto", "earningto", "enddate", "todate"],
    sourceIssueDate: ["sourceissuedate", "issuedate", "paiddate", "checkdate"],
    sourcePaidDate: ["sourcepaiddate", "paiddate", "paymentdate", "checkdate", "chequedate"],
  };
  return (
    fields.find((entry) =>
      aliases[field].includes(entry.label.toLowerCase().replace(/[^a-z0-9]/g, "")),
    )?.pointer ?? ""
  );
}

/**
 * Program detail drawer, opened from a row through the `program=<id>`
 * search param. Loader-resolved policy, memberships, and incentive source
 * accounts with their amounts; closing navigates the param away.
 * Lifecycle moves sit in the header: Edit for any open program, Activate
 * for drafts, and Close for active programs (its required reason is asked
 * for in the shared prompt). Lifecycle and membership writes ride the
 * benefit-programs route, and the list refreshes after every transition.
 * Preview reads the posted financial and approved time sources; settlement
 * records controlled awards only after the period has closed.
 */
export function ProgramDrawer({
  drawer,
  closeHref,
  canManage,
  employmentOptions,
}: {
  drawer: ProgramDetailDrawer;
  closeHref: string;
  /** Holds hrm.benefits.manage (mirrors the program route guards). */
  canManage: boolean;
  employmentOptions: BuilderOption[];
}) {
  const t = useTranslations("hrm");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const searchParams = useSearchParams();
  const [tab, setTab] = useState(() => {
    const requested = searchParams.get("transactionTab");
    return ["participants", "activity", "audit"].includes(requested ?? "") ? requested! : "details";
  });
  const [adding, setAdding] = useState(false);
  const [simulateFrom, setSimulateFrom] = useState(drawer.simulation?.periodFrom ?? "");
  const [simulateTo, setSimulateTo] = useState(drawer.simulation?.periodTo ?? "");
  const [member, setMember] = useState<MembershipDraft>({
    employmentId: "",
    effectiveFrom: drawer.program.effectiveFrom,
    effectiveTo: "",
    weight: "",
    role: "",
    excluded: false,
  });
  const [memberError, setMemberError] = useState<string | null>(null);
  const [sourceFileId, setSourceFileId] = useState("");
  const [sourceVersionId, setSourceVersionId] = useState("");
  const [sourceVersions, setSourceVersions] = useState<RetainedVersionOption[]>([]);
  const [sourceRows, setSourceRows] = useState<RetainedRowOption[]>([]);
  const [corroborationFileId, setCorroborationFileId] = useState("");
  const [corroborationVersionId, setCorroborationVersionId] = useState("");
  const [corroborationVersions, setCorroborationVersions] = useState<RetainedVersionOption[]>([]);
  const [corroborationRows, setCorroborationRows] = useState<RetainedRowOption[]>([]);
  const [corroborationRowPointer, setCorroborationRowPointer] = useState("");
  const [sourceRowPointer, setSourceRowPointer] = useState("");
  const [sourceFields, setSourceFields] = useState<Record<RetainedFieldName, string>>({
    sourceRowRef: "",
    amount: "",
    currency: "",
    periodFrom: "",
    periodTo: "",
    sourceIssueDate: "",
    sourcePaidDate: "",
  });
  const [sourceEvidenceClass, setSourceEvidenceClass] =
    useState<SourceEvidenceClass>("missing-source-identity");
  const [sourceEmploymentId, setSourceEmploymentId] = useState("");
  const [sourceAsOf, setSourceAsOf] = useState("");
  const [sourceMappingBasis, setSourceMappingBasis] = useState("");
  const [sourceMappingReason, setSourceMappingReason] = useState("");
  const [sourceGoverningBasis, setSourceGoverningBasis] = useState("");
  const [sourceGoverningReason, setSourceGoverningReason] = useState("");
  const [sourceReason, setSourceReason] = useState("");
  const [pdfEvidence, setPdfEvidence] = useState<{ key: string; input: PdfEvidenceInput }[]>([]);
  const [nativeCurrencySelected, setNativeCurrencySelected] = useState(false);
  const [nativeCurrencyReason, setNativeCurrencyReason] = useState("");
  const sourceRequestRef = useRef<{ signature: string; requestKey: string } | null>(null);
  const [sourceConfirmedReviewKey, setSourceConfirmedReviewKey] = useState("");
  const [sourcePreview, setSourcePreview] = useState<{
    reviewKey: string;
    sourceRowRef: string;
    sourceIssueDate: string;
    sourcePaidDate?: string;
    periodFrom: string;
    periodTo: string;
    value: string;
    currency: string;
    sourceRow: Record<string, unknown>;
    nativeMeasurementAsOf: string | null;
    artifacts: {
      filename: string;
      sha256: string;
      rowPointer: string;
      rowSha256: string;
      row: Record<string, unknown>;
    }[];
    nativePreview: {
      currentProgramRevision: number;
      effectivePolicyRevision: number;
      digest: string;
      targetRecipient: { value: string; capped: boolean; explanation: string } | null;
      measuredValue: string;
      nativePoolAvailable: boolean;
      targetCarryForward: string | null;
      canRecordFirstObligation: boolean;
    };
  } | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const program = drawer.program;
  const effectiveRange = useEffectiveRangeLabel();
  const sourceRow = sourceRows.find((entry) => entry.pointer === sourceRowPointer)?.row;
  const sourceFieldOptions = retainedFieldOptions(sourceRow);
  const isAboveNativeMeasure = sourceEvidenceClass === "source-paid-above-native-measure";
  const claimForField = {
    sourceRowRef: "sourceRowRef",
    amount: "value",
    currency: "currency",
    periodFrom: "periodFrom",
    periodTo: "periodTo",
    sourceIssueDate: "sourceIssueDate",
    sourcePaidDate: "sourcePaidDate",
  } as const;
  const sourceFieldsComplete =
    (
      [
        "sourceRowRef",
        "amount",
        "currency",
        "periodFrom",
        "periodTo",
        "sourceIssueDate",
        ...(isAboveNativeMeasure ? ["sourcePaidDate"] : []),
      ] as RetainedFieldName[]
    ).every(
      (field) =>
        sourceFields[field] !== "" ||
        (field === "currency" &&
          nativeCurrencySelected &&
          nativeCurrencyReason.trim().length >= 8) ||
        pdfEvidence.some(
          (entry) => entry.input.pdfSelection.fields[claimForField[field]] !== undefined,
        ),
    ) &&
    pdfEvidence.every(
      (entry) =>
        entry.input.fileId &&
        entry.input.versionId &&
        entry.input.pdfSelection.anchor.trim() &&
        Object.values(entry.input.pdfSelection.fields).every(
          (field) => field?.quote.trim() && field.value.trim(),
        ),
    );
  const sourceReviewKey = JSON.stringify([
    program.id,
    program.revision,
    drawer.simulation?.periodFrom ?? "",
    drawer.simulation?.periodTo ?? "",
    sourceAsOf,
    sourceEvidenceClass,
    sourceEmploymentId,
    sourceFileId,
    sourceVersionId,
    sourceRowPointer,
    sourceFields.sourceRowRef,
    sourceFields.amount,
    sourceFields.currency,
    sourceFields.periodFrom,
    sourceFields.periodTo,
    sourceFields.sourceIssueDate,
    sourceFields.sourcePaidDate,
    corroborationFileId,
    corroborationVersionId,
    corroborationRowPointer,
    sourceMappingBasis,
    sourceMappingReason,
    sourceGoverningBasis,
    sourceGoverningReason,
    sourceReason,
    pdfEvidence,
    nativeCurrencySelected,
    nativeCurrencyReason,
  ]);
  const sourceConfirmationKey = JSON.stringify([
    sourceReviewKey,
    program.legalEntityId,
    sourcePreview?.reviewKey === sourceReviewKey
      ? [
          sourcePreview.sourceRowRef,
          sourcePreview.sourceIssueDate,
          sourcePreview.sourcePaidDate ?? null,
          sourcePreview.periodFrom,
          sourcePreview.periodTo,
          sourcePreview.value,
          sourcePreview.currency,
          sourcePreview.nativePreview.digest,
        ]
      : null,
    sourceMappingBasis,
    sourceMappingReason,
    sourceGoverningBasis,
    sourceGoverningReason,
    sourceReason,
  ]);
  const sourceReviewKeyRef = useRef(sourceReviewKey);
  useEffect(() => {
    sourceReviewKeyRef.current = sourceReviewKey;
  }, [sourceReviewKey]);
  const previousSourceReviewKey = useRef(sourceReviewKey);

  useEffect(() => {
    if (previousSourceReviewKey.current !== sourceReviewKey) {
      previousSourceReviewKey.current = sourceReviewKey;
      setSourcePreview(null);
      setSourceConfirmedReviewKey("");
      sourceRequestRef.current = null;
      setSourceError(null);
    }
  }, [sourceReviewKey]);

  useEffect(() => {
    if (!sourceFileId) return;
    const controller = new AbortController();
    let active = true;
    void fetch(`/api/file-cabinet/files/${encodeURIComponent(sourceFileId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, t("sourceFirst.fileLookupFailed")));
        const payload = (await response.json()) as {
          file?: { versions?: { id?: unknown; versionNumber?: unknown }[] };
        };
        const versions = (payload.file?.versions ?? [])
          .filter(
            (entry): entry is { id: string; versionNumber?: unknown } =>
              typeof entry.id === "string",
          )
          .map((entry) => ({
            id: entry.id,
            label: t("sourceFirst.version", { number: String(entry.versionNumber ?? "") }),
          }));
        const version = versions[0];
        if (!version) throw new Error(t("sourceFirst.noRetainedVersion"));
        if (active) {
          setSourceVersions(versions);
          setSourceVersionId(version.id);
        }
      })
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted) {
          setSourceVersionId("");
          setSourceVersions([]);
          setSourceError(
            error instanceof Error ? error.message : t("sourceFirst.fileLookupFailed"),
          );
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [sourceFileId, t]);

  useEffect(() => {
    if (!sourceFileId || !sourceVersionId) return;
    const controller = new AbortController();
    let active = true;
    const fileId = sourceFileId;
    const versionId = sourceVersionId;
    void fetch(
      `/api/file-cabinet/files/${encodeURIComponent(fileId)}/download?versionId=${encodeURIComponent(versionId)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, t("sourceFirst.fileReadFailed")));
        const bytes = await response.arrayBuffer();
        const parsed = parseExactJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
          rejectDuplicateKeys: true,
        });
        const rows = retainedRowOptions(parsed, (number) => t("sourceFirst.row", { number }));
        if (active && sourceFileId === fileId && sourceVersionId === versionId) setSourceRows(rows);
      })
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted) {
          setSourceRows([]);
          setSourceError(error instanceof Error ? error.message : t("sourceFirst.fileReadFailed"));
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [sourceFileId, sourceVersionId, t]);

  useEffect(() => {
    if (!corroborationFileId) return;
    const controller = new AbortController();
    let active = true;
    void fetch(`/api/file-cabinet/files/${encodeURIComponent(corroborationFileId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, t("sourceFirst.fileLookupFailed")));
        const payload = (await response.json()) as {
          file?: { versions?: { id?: unknown; versionNumber?: unknown }[] };
        };
        const versions = (payload.file?.versions ?? [])
          .filter(
            (entry): entry is { id: string; versionNumber?: unknown } =>
              typeof entry.id === "string",
          )
          .map((entry) => ({
            id: entry.id,
            label: t("sourceFirst.version", { number: String(entry.versionNumber ?? "") }),
          }));
        const version = versions[0];
        if (!version) throw new Error(t("sourceFirst.noRetainedVersion"));
        if (active) {
          setCorroborationVersions(versions);
          setCorroborationVersionId(version.id);
        }
      })
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted) {
          setCorroborationVersionId("");
          setSourceError(
            error instanceof Error ? error.message : t("sourceFirst.fileLookupFailed"),
          );
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [corroborationFileId, t]);

  useEffect(() => {
    if (!corroborationFileId || !corroborationVersionId) return;
    const controller = new AbortController();
    let active = true;
    const fileId = corroborationFileId;
    const versionId = corroborationVersionId;
    void fetch(
      `/api/file-cabinet/files/${encodeURIComponent(fileId)}/download?versionId=${encodeURIComponent(versionId)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, t("sourceFirst.fileReadFailed")));
        const parsed = parseExactJson(
          new TextDecoder("utf-8", { fatal: true }).decode(await response.arrayBuffer()),
          { rejectDuplicateKeys: true },
        );
        const rows = retainedRowOptions(parsed, (number) => t("sourceFirst.row", { number }));
        if (active && corroborationFileId === fileId && corroborationVersionId === versionId)
          setCorroborationRows(rows);
      })
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted) {
          setCorroborationRows([]);
          setSourceError(error instanceof Error ? error.message : t("sourceFirst.fileReadFailed"));
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [corroborationFileId, corroborationVersionId, t]);

  function close() {
    router.push(closeHref as never);
    router.refresh();
  }

  const closeGuard = useDirtyClose({
    dirty: adding,
    busy: working,
    onClose: close,
    message: tCommon("feedback.unsavedChanges"),
    confirmLabel: tCommon("confirm.discardChanges"),
  });

  async function act(body: Record<string, unknown>, method: "PATCH" | "POST" = "PATCH") {
    setWorking(true);
    try {
      // Activation and closure patch the program resource and membership
      // removal posts to it; the id rides the path, never the body.
      const res = await fetch(programResourceUrl(program.id), {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t("portfolio.programActionFailed")));
        return;
      }
      setAdding(false);
      router.refresh();
    } catch {
      toast.error(t("portfolio.programActionFailed"));
    } finally {
      setWorking(false);
    }
  }

  async function addMember() {
    const errors = validateMembershipDraft(member);
    if (program.allocation === "role" && !member.excluded && member.weight.trim() === "")
      errors.weight = "portfolio.validation.weight";
    const first =
      errors.employmentId ?? errors.effectiveFrom ?? errors.effectiveTo ?? errors.weight;
    if (first) {
      setMemberError(t(first));
      return;
    }
    setMemberError(null);
    setWorking(true);
    try {
      // Membership writes post the program resource; the program id rides
      // the path, never the body.
      const res = await fetch(programResourceUrl(program.id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "addMember",
          employmentId: member.employmentId,
          effectiveFrom: member.effectiveFrom,
          effectiveTo: member.effectiveTo === "" ? null : member.effectiveTo,
          weight: member.weight.trim() === "" ? null : member.weight.trim(),
          role: member.role.trim() === "" ? null : member.role.trim(),
          excluded: member.excluded === true,
        }),
      });
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t("portfolio.programActionFailed")));
        return;
      }
      setAdding(false);
      setMember({
        employmentId: "",
        effectiveFrom: program.effectiveFrom,
        effectiveTo: "",
        weight: "",
        role: "",
        excluded: false,
      });
      router.refresh();
    } catch {
      toast.error(t("portfolio.programActionFailed"));
    } finally {
      setWorking(false);
    }
  }

  async function settle() {
    if (!drawer.simulation) return;
    setWorking(true);
    try {
      // Settlement records one draft award per payable recipient,
      // atomically and idempotently: a retried settlement returns the
      // existing awards when revision, sources, and values match.
      const res = await fetch(programResourceUrl(program.id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "settle",
          periodFrom: drawer.simulation.periodFrom,
          periodTo: drawer.simulation.periodTo,
        }),
      });
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t("portfolio.programActionFailed")));
        return;
      }
      // Settlement opens the delivery workspace with the recorded obligations.
      const base = closeHref.split("?")[0];
      router.push(`${base}?view=delivery` as never);
      router.refresh();
    } catch {
      toast.error(t("portfolio.programActionFailed"));
    } finally {
      setWorking(false);
    }
  }

  function sourceEvidenceBody(action: "previewSourceEvidence" | "recordSourceEvidenceFirst") {
    if (
      !drawer.simulation ||
      !sourceFileId ||
      !sourceVersionId ||
      !sourceEmploymentId ||
      !sourceAsOf ||
      !sourceRowPointer ||
      !sourceFieldsComplete ||
      (corroborationFileId && (!corroborationVersionId || !corroborationRowPointer))
    )
      return null;
    const reviewKey = sourceReviewKeyRef.current;
    const requestSignature = sourceConfirmationKey;
    let requestKey: string | undefined;
    if (action === "recordSourceEvidenceFirst") {
      requestKey =
        sourceRequestRef.current?.signature === requestSignature
          ? sourceRequestRef.current.requestKey
          : crypto.randomUUID();
      sourceRequestRef.current = { signature: requestSignature, requestKey };
    }
    return {
      action,
      expectedProgramRevision: program.revision,
      employmentId: sourceEmploymentId,
      periodFrom: drawer.simulation.periodFrom,
      periodTo: drawer.simulation.periodTo,
      asOf: sourceAsOf,
      sourceEvidenceClass,
      ...(nativeCurrencySelected
        ? { nativeCurrencyBasis: { confirmed: true, reason: nativeCurrencyReason } }
        : {}),
      sourceArtifacts: [
        {
          fileId: sourceFileId,
          versionId: sourceVersionId,
          rowPointer: sourceRowPointer === ROOT_ROW_SELECTION ? "" : sourceRowPointer,
          sourceFields: Object.fromEntries(
            Object.entries({
              sourceRowRefPointer: sourceFields.sourceRowRef,
              amountPointer: sourceFields.amount,
              currencyPointer: sourceFields.currency,
              periodFromPointer: sourceFields.periodFrom,
              periodToPointer: sourceFields.periodTo,
              sourceIssueDatePointer: sourceFields.sourceIssueDate,
              ...(isAboveNativeMeasure
                ? { sourcePaidDatePointer: sourceFields.sourcePaidDate }
                : {}),
            }).filter(([, pointer]) => pointer !== ""),
          ),
        },
        ...(corroborationFileId && corroborationVersionId
          ? [
              {
                fileId: corroborationFileId,
                versionId: corroborationVersionId,
                rowPointer: corroborationRowPointer,
              },
            ]
          : []),
        ...pdfEvidence.map((entry) => entry.input),
      ],
      ...(action === "recordSourceEvidenceFirst"
        ? {
            ...(requestKey ? { requestKey } : {}),
            ...(sourcePreview?.reviewKey === reviewKey
              ? { expectedNativePreviewDigest: sourcePreview.nativePreview.digest }
              : {}),
            mappingAttestation: {
              basis: sourceMappingBasis,
              reason: sourceMappingReason,
              confirmed: sourceConfirmedReviewKey === requestSignature,
            },
            ...(isAboveNativeMeasure
              ? {
                  governingDecisionAttestation: {
                    basis: sourceGoverningBasis,
                    reason: sourceGoverningReason,
                    confirmed: sourceConfirmedReviewKey === requestSignature,
                  },
                }
              : {}),
            reason: sourceReason,
          }
        : {}),
    };
  }

  async function previewSourceEvidence() {
    const body = sourceEvidenceBody("previewSourceEvidence");
    if (!body) {
      setSourceError(t("sourceFirst.completeSelection"));
      return;
    }
    setWorking(true);
    setSourceError(null);
    setSourcePreview(null);
    const reviewedKey = sourceReviewKeyRef.current;
    try {
      const response = await fetch(programResourceUrl(program.id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const message = await readApiErrorMessage(response, t("sourceFirst.previewFailed"));
        if (sourceReviewKeyRef.current === reviewedKey) setSourceError(message);
        return;
      }
      const payload = (await response.json()) as { sourceEvidencePreview?: typeof sourcePreview };
      if (!payload.sourceEvidencePreview) throw new Error(t("sourceFirst.previewIncomplete"));
      if (sourceReviewKeyRef.current === reviewedKey) {
        setSourcePreview({ ...payload.sourceEvidencePreview, reviewKey: reviewedKey });
      }
    } catch (error) {
      if (sourceReviewKeyRef.current === reviewedKey)
        setSourceError(error instanceof Error ? error.message : t("sourceFirst.previewFailed"));
    } finally {
      setWorking(false);
    }
  }

  async function recordSourceEvidenceFirst() {
    const reviewedKey = sourceReviewKeyRef.current;
    if (
      !sourcePreview ||
      sourcePreview.reviewKey !== reviewedKey ||
      sourceConfirmedReviewKey !== sourceConfirmationKey ||
      sourceMappingBasis.trim().length < 8 ||
      sourceMappingReason.trim().length < 8 ||
      sourceReason.trim().length < 8 ||
      (isAboveNativeMeasure &&
        (sourceGoverningBasis.trim().length < 8 || sourceGoverningReason.trim().length < 8))
    ) {
      setSourceError(t("sourceFirst.confirmReviewedRow"));
      return;
    }
    const body = sourceEvidenceBody("recordSourceEvidenceFirst");
    if (!body) {
      setSourceError(t("sourceFirst.completeSelection"));
      return;
    }
    setWorking(true);
    setSourceError(null);
    try {
      const response = await fetch(programResourceUrl(program.id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const message = await readApiErrorMessage(response, t("sourceFirst.recordFailed"));
        if (sourceReviewKeyRef.current === reviewedKey) setSourceError(message);
        return;
      }
      if (sourceReviewKeyRef.current !== reviewedKey) return;
      toast.success(t("sourceFirst.recorded"));
      const base = closeHref.split("?")[0];
      router.push(`${base}?view=delivery` as never);
      router.refresh();
    } catch (error) {
      if (sourceReviewKeyRef.current === reviewedKey)
        setSourceError(error instanceof Error ? error.message : t("sourceFirst.recordFailed"));
    } finally {
      setWorking(false);
    }
  }

  function simulate() {
    if (!simulateFrom || !simulateTo) {
      toast.error(t("portfolio.simulatePeriodRequired"));
      return;
    }
    const separator = drawer.simulateHref.includes("?") ? "&" : "?";
    router.push(
      `${drawer.simulateHref}${separator}simulate=1&periodFrom=${encodeURIComponent(simulateFrom)}&periodTo=${encodeURIComponent(simulateTo)}` as never,
    );
  }

  async function closeProgram() {
    const reason = await promptDialog({
      title: t("portfolio.closeProgramTitle", { name: program.name }),
      label: t("portfolio.closeReasonLabel"),
      multiline: true,
      confirmLabel: t("portfolio.closeProgram"),
    });
    // The shared prompt resolves null on cancel or an empty reason; closing
    // never proceeds without the reason the service records.
    if (reason === null || reason.trim() === "") return;
    await act({ action: "close", reason: reason.trim() });
  }

  const manageable = canManage && !drawer.drawerRefusal;
  const headerActions =
    manageable && program.status !== "closed" ? (
      <>
        {isProgramEditable(program.status) ? (
          <Button
            variant="outline"
            size="sm"
            disabled={working}
            onClick={() => router.push(drawer.editHref as never)}
          >
            {t("portfolio.editProgram")}
          </Button>
        ) : null}
        {program.status === "active" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={working}
            onClick={() => void closeProgram()}
          >
            {t("portfolio.closeProgram")}
          </Button>
        ) : null}
        {program.status === "draft" ? (
          <Button size="sm" disabled={working} onClick={() => void act({ action: "activate" })}>
            {t("portfolio.activateProgram")}
          </Button>
        ) : null}
      </>
    ) : null;
  // The Actions menu renders only when it holds an entry.
  const menuActions =
    program.metric === "transactions" ? (
      <Button asChild variant="ghost">
        <Link href={`/hrm/benefits?view=programs&transactionRules=${program.id}` as never}>
          {t("portfolio.transactionRules")}
        </Link>
      </Button>
    ) : undefined;

  const tableText = {
    program: t("portfolio.columns.program"),
    recipient: t("portfolio.columns.recipient"),
    period: t("portfolio.columns.period"),
    value: t("portfolio.columns.value"),
    status: t("portfolio.columns.status"),
    emptyTitle: t("portfolio.awardsEmptyTitle"),
    emptyDescription: t("programWorkspace.activityEmpty"),
    totalLabel: t("portfolio.totalLabel"),
    truncatedLabel: t("portfolio.awardsTruncated"),
  };

  // One toolbar row: the table's search sits at the left, then the period
  // pickers, then the run action at the right.
  const simulateControls =
    !drawer.drawerRefusal && program.family === "incentive" ? (
      <>
        <div className="flex items-center gap-1.5">
          <Label
            htmlFor="program-simulate-from"
            className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400"
          >
            {t("portfolio.simulate.periodFrom")}
          </Label>
          <DateField
            id="program-simulate-from"
            className="w-40"
            value={simulateFrom}
            onChange={(value) => setSimulateFrom(value)}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Label
            htmlFor="program-simulate-to"
            className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400"
          >
            {t("portfolio.simulate.periodTo")}
          </Label>
          <DateField
            id="program-simulate-to"
            className="w-40"
            value={simulateTo}
            onChange={(value) => setSimulateTo(value)}
          />
        </div>
        <Button variant="outline" className="ml-auto" onClick={simulate}>
          {t("portfolio.simulate.run")}
        </Button>
      </>
    ) : null;
  const grantAction =
    program.family !== "incentive" && canManage && program.status === "active" ? (
      <Button asChild className="ml-auto">
        <Link href={`${program.programHref}&award=new` as never}>
          {t(
            program.family === "reward"
              ? "programWorkspace.giveReward"
              : "programWorkspace.createGrant",
          )}
        </Link>
      </Button>
    ) : null;
  const activityToolbar = simulateControls ?? grantAction ?? undefined;

  const simulation = drawer.simulation ? (
    <section
      className="flex flex-col gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
      aria-label={t("portfolio.simulate.title")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t("portfolio.simulate.title")}
        </h3>
        <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {effectiveRange(drawer.simulation.periodFrom, drawer.simulation.periodTo)}
        </span>
      </div>
      {drawer.simulation.isEstimate ? (
        <Alert variant="default" className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{t("portfolio.simulate.estimate")}</span>
        </Alert>
      ) : null}
      <ul className="space-y-1">
        {drawer.simulation.summaryLines.map((line) => (
          <li key={line} className="text-xs text-slate-600 dark:text-slate-300">
            {line}
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {drawer.simulation.measuredLines.map((line) => (
          <div key={line.label} className="flex items-baseline justify-between gap-2">
            <dt className="text-slate-500 dark:text-slate-400">{line.label}</dt>
            <dd className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
              {line.value}
            </dd>
          </div>
        ))}
      </dl>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-xs dark:border-slate-800">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-slate-500 dark:text-slate-400">
            {t("sourceFirst.nativeMeasuredHistory")}
          </dt>
          <dd className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
            {drawer.simulation.reconciliation.nativeMeasuredHistoryTotal}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-slate-500 dark:text-slate-400">
            {t("sourceFirst.sourceEvidencedHistory")}
          </dt>
          <dd className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
            {drawer.simulation.reconciliation.sourceEvidencedFirstTotal}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-slate-500 dark:text-slate-400">
            {t("sourceFirst.obligationVariance")}
          </dt>
          <dd className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
            {drawer.simulation.reconciliation.obligationHistoryMinusCurrentMeasurement}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-slate-500 dark:text-slate-400">
            {t("portfolio.simulate.processedPayrollTotal")}
          </dt>
          <dd className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
            {drawer.simulation.reconciliation.processedPayrollTotal}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-slate-500 dark:text-slate-400">
            {t("portfolio.simulate.payrollMinusCurrentMeasurement")}
          </dt>
          <dd className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
            {drawer.simulation.reconciliation.payrollMinusCurrentMeasurement}
          </dd>
        </div>
      </dl>
      {drawer.simulation.recipients.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t("portfolio.simulate.noRecipients")}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {drawer.simulation.recipients.map((recipient) => (
            <li key={recipient.employmentId} className="py-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  {recipient.employeeLabel}
                </span>
                <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  {recipient.share}
                </span>
                <span className="ml-auto text-sm font-medium tabular-nums text-slate-900 dark:text-slate-100">
                  {recipient.netValue}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {recipient.explanation}
              </p>
            </li>
          ))}
        </ul>
      )}
      {drawer.simulation.excluded.length > 0 ? (
        <ul className="space-y-1">
          {drawer.simulation.excluded.map((line) => (
            <li key={line} className="text-xs text-amber-700 dark:text-amber-300">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-slate-500 dark:text-slate-400">
          {t("portfolio.simulate.totalAwarded")}
        </span>
        <span className="flex items-center gap-3">
          <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {drawer.simulation.totalAwarded}
          </span>
          {canManage &&
          program.status === "active" &&
          !drawer.simulation.isEstimate &&
          drawer.simulation.canSettle ? (
            <Button size="sm" disabled={working} onClick={settle}>
              {t("portfolio.simulate.settle")}
            </Button>
          ) : null}
        </span>
      </div>
      {canManage && program.status === "active" && !drawer.simulation.isEstimate ? (
        <details className="border-t border-slate-100 pt-3 dark:border-slate-800">
          <summary className="cursor-pointer text-sm font-medium text-slate-800 dark:text-slate-100">
            {t("sourceFirst.title")}
          </summary>
          <div className="mt-3 flex flex-col gap-3 text-sm">
            <p className="text-xs text-slate-600 dark:text-slate-300">
              {isAboveNativeMeasure
                ? t("sourceFirst.descriptionAboveNativeMeasure")
                : t("sourceFirst.description")}
            </p>
            <div>
              <Label htmlFor="source-first-evidence-class">{t("sourceFirst.evidenceClass")}</Label>
              <Select
                id="source-first-evidence-class"
                value={sourceEvidenceClass}
                onChange={(event) =>
                  setSourceEvidenceClass(event.target.value as SourceEvidenceClass)
                }
              >
                <option value="missing-source-identity">
                  {t("sourceFirst.classMissingIdentity")}
                </option>
                <option value="source-paid-above-native-measure">
                  {t("sourceFirst.classPaidAboveMeasure")}
                </option>
              </Select>
            </div>
            <div>
              <Label htmlFor="source-first-native-as-of">{t("sourceFirst.asOf")}</Label>
              <DateField
                id="source-first-native-as-of"
                value={sourceAsOf}
                required
                onChange={(value) => setSourceAsOf(value)}
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {t("sourceFirst.asOfHint")}
              </p>
            </div>
            <div>
              <Label htmlFor="source-first-employment">{t("sourceFirst.recipient")}</Label>
              <Select
                id="source-first-employment"
                value={sourceEmploymentId}
                onChange={(event) => setSourceEmploymentId(event.target.value)}
              >
                <option value="">{t("sourceFirst.chooseRecipient")}</option>
                {employmentOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              {t("sourceFirst.legalPayer")}:{" "}
              {drawer.legalEntityLabel ?? t("sourceFirst.payerNotConfigured")}
            </p>
            <div>
              <Label htmlFor="source-first-file">{t("sourceFirst.issuedFile")}</Label>
              <CabinetFilePicker
                id="source-first-file"
                label={t("sourceFirst.issuedFile")}
                value={sourceFileId}
                onChange={(value) => {
                  setSourceFileId(value);
                  setSourceVersionId("");
                  setSourceVersions([]);
                  setSourceRows([]);
                  setSourceRowPointer("");
                  setSourceFields({
                    sourceRowRef: "",
                    amount: "",
                    currency: "",
                    periodFrom: "",
                    periodTo: "",
                    sourceIssueDate: "",
                    sourcePaidDate: "",
                  });
                  setSourceFields({
                    sourceRowRef: "",
                    amount: "",
                    currency: "",
                    periodFrom: "",
                    periodTo: "",
                    sourceIssueDate: "",
                    sourcePaidDate: "",
                  });
                }}
                disabled={working}
              />
              {sourceFileId && sourceVersions.length > 0 ? (
                <div className="mt-2">
                  <Label htmlFor="source-first-version">{t("sourceFirst.fileVersion")}</Label>
                  <Select
                    id="source-first-version"
                    value={sourceVersionId}
                    onChange={(event) => {
                      setSourceVersionId(event.target.value);
                      setSourceRowPointer("");
                      setSourceRows([]);
                      setSourceFields({
                        sourceRowRef: "",
                        amount: "",
                        currency: "",
                        periodFrom: "",
                        periodTo: "",
                        sourceIssueDate: "",
                        sourcePaidDate: "",
                      });
                      setSourceFields({
                        sourceRowRef: "",
                        amount: "",
                        currency: "",
                        periodFrom: "",
                        periodTo: "",
                        sourceIssueDate: "",
                        sourcePaidDate: "",
                      });
                    }}
                  >
                    {sourceVersions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.label}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
            </div>
            <div>
              <Label htmlFor="source-first-row">{t("sourceFirst.issuedRow")}</Label>
              <Select
                id="source-first-row"
                value={sourceRowPointer}
                onChange={(event) => {
                  const pointer = event.target.value;
                  setSourceRowPointer(pointer);
                  const row = sourceRows.find((entry) => entry.pointer === pointer)?.row;
                  const options = retainedFieldOptions(row);
                  setSourceFields({
                    sourceRowRef: suggestedFieldPointer(options, "sourceRowRef"),
                    amount: suggestedFieldPointer(options, "amount"),
                    currency: suggestedFieldPointer(options, "currency"),
                    periodFrom: suggestedFieldPointer(options, "periodFrom"),
                    periodTo: suggestedFieldPointer(options, "periodTo"),
                    sourceIssueDate: suggestedFieldPointer(options, "sourceIssueDate"),
                    sourcePaidDate: suggestedFieldPointer(options, "sourcePaidDate"),
                  });
                }}
                disabled={!sourceVersionId || sourceRows.length === 0}
              >
                <option value="">{t("sourceFirst.chooseRow")}</option>
                {sourceRows.map((row) => (
                  <option key={row.pointer} value={row.pointer}>
                    {row.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(
                [
                  ["sourceRowRef", "rowReferenceField"],
                  ["amount", "amountField"],
                  ["currency", "currencyField"],
                  ["periodFrom", "periodFromField"],
                  ["periodTo", "periodToField"],
                  ["sourceIssueDate", "issueDateField"],
                  ...(isAboveNativeMeasure ? [["sourcePaidDate", "paidDateField"] as const] : []),
                ] as const
              ).map(([field, labelKey]) => (
                <div key={field}>
                  <Label htmlFor={`source-first-${field}`}>{t(`sourceFirst.${labelKey}`)}</Label>
                  <Select
                    id={`source-first-${field}`}
                    value={sourceFields[field]}
                    onChange={(event) =>
                      setSourceFields((current) => ({ ...current, [field]: event.target.value }))
                    }
                    disabled={!sourceRowPointer || sourceFieldOptions.length === 0}
                  >
                    <option value="">{t("sourceFirst.chooseField")}</option>
                    {sourceFieldOptions.map((option) => (
                      <option key={option.pointer} value={option.pointer}>
                        {option.label}
                        {option.sample ? ` · ${option.sample}` : ""}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>
            <div>
              <Label htmlFor="source-first-corroboration">
                {t("sourceFirst.corroborationFile")}
              </Label>
              <CabinetFilePicker
                id="source-first-corroboration"
                label={t("sourceFirst.corroborationFile")}
                value={corroborationFileId}
                onChange={(value) => {
                  setCorroborationFileId(value);
                  setCorroborationVersionId("");
                  setCorroborationVersions([]);
                  setCorroborationRows([]);
                  setCorroborationRowPointer("");
                }}
                disabled={working}
              />
              {corroborationFileId && corroborationVersions.length > 0 ? (
                <div className="mt-2">
                  <Label htmlFor="source-first-corroboration-version">
                    {t("sourceFirst.fileVersion")}
                  </Label>
                  <Select
                    id="source-first-corroboration-version"
                    value={corroborationVersionId}
                    onChange={(event) => {
                      setCorroborationVersionId(event.target.value);
                      setCorroborationRows([]);
                      setCorroborationRowPointer("");
                    }}
                  >
                    {corroborationVersions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.label}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              {corroborationFileId && corroborationVersionId ? (
                <div className="mt-2">
                  <Label htmlFor="source-first-corroboration-row">
                    {t("sourceFirst.corroboratingRow")}
                  </Label>
                  <Select
                    id="source-first-corroboration-row"
                    value={corroborationRowPointer}
                    onChange={(event) => setCorroborationRowPointer(event.target.value)}
                    disabled={corroborationRows.length === 0}
                  >
                    <option value="">{t("sourceFirst.chooseRow")}</option>
                    {corroborationRows.map((row) => (
                      <option key={row.pointer} value={row.pointer}>
                        {row.label}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
            </div>
            <div className="space-y-3">
              {pdfEvidence.map((entry, index) => (
                <RetainedPdfEvidence
                  key={entry.key}
                  value={entry.input}
                  disabled={working}
                  onChange={(input) =>
                    setPdfEvidence((current) =>
                      current.map((item, position) =>
                        position === index ? { ...item, input } : item,
                      ),
                    )
                  }
                  onRemove={() =>
                    setPdfEvidence((current) => current.filter((_, position) => position !== index))
                  }
                />
              ))}
              <Button
                variant="outline"
                type="button"
                disabled={working || pdfEvidence.length + (corroborationFileId ? 1 : 0) >= 4}
                onClick={() =>
                  setPdfEvidence((current) => [
                    ...current,
                    {
                      key: crypto.randomUUID(),
                      input: {
                        fileId: "",
                        versionId: "",
                        rowPointer: "",
                        pdfSelection: { page: 1, anchor: "", fields: {} },
                      },
                    },
                  ])
                }
              >
                {t("sourceFirst.addPdfEvidence")}
              </Button>
              <Label>
                {t("sourceFirst.currencyBasis")}
                <Select
                  value={nativeCurrencySelected ? "native" : "source"}
                  onChange={(event) => setNativeCurrencySelected(event.target.value === "native")}
                >
                  <option value="source">{t("sourceFirst.currencyFromSource")}</option>
                  <option value="native">{t("sourceFirst.currencyFromPayroll")}</option>
                </Select>
              </Label>
              {nativeCurrencySelected ? (
                <>
                  <p className="text-xs text-slate-500">
                    {t("sourceFirst.currencyBasisHint", { currency: program.currency })}
                  </p>
                  <Label>
                    {t("sourceFirst.currencyBasisReason")}
                    <Textarea
                      value={nativeCurrencyReason}
                      onChange={(event) => setNativeCurrencyReason(event.target.value)}
                    />
                  </Label>
                </>
              ) : null}
            </div>
            {sourcePreview ? (
              <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
                <h4 className="font-medium">{t("sourceFirst.reviewedRow")}</h4>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <dt>{t("sourceFirst.rowReference")}</dt>
                  <dd>{sourcePreview.sourceRowRef}</dd>
                  <dt>{t("sourceFirst.recipient")}</dt>
                  <dd>
                    {employmentOptions.find((option) => option.value === sourceEmploymentId)
                      ?.label ?? t("sourceFirst.selectedRecipient")}
                  </dd>
                  <dt>{t("sourceFirst.legalPayer")}</dt>
                  <dd>{drawer.legalEntityLabel ?? t("sourceFirst.payerNotConfigured")}</dd>
                  <dt>{t("sourceFirst.earningPeriod")}</dt>
                  <dd>
                    {sourcePreview.periodFrom} – {sourcePreview.periodTo}
                  </dd>
                  <dt>{t("sourceFirst.sourceIssueDate")}</dt>
                  <dd>{sourcePreview.sourceIssueDate}</dd>
                  {isAboveNativeMeasure ? (
                    <>
                      <dt>{t("sourceFirst.sourcePaidDate")}</dt>
                      <dd>{sourcePreview.sourcePaidDate ?? ""}</dd>
                    </>
                  ) : null}
                  <dt>{t("sourceFirst.issuedAmount")}</dt>
                  <dd className="font-semibold tabular-nums">
                    {sourcePreview.value} {sourcePreview.currency}
                  </dd>
                  <dt>{t("sourceFirst.nativeRecipient")}</dt>
                  <dd>
                    {sourcePreview.nativePreview.targetRecipient
                      ? t("sourceFirst.nativeRecipientAmount", {
                          value: sourcePreview.nativePreview.targetRecipient.value,
                          currency: sourcePreview.currency,
                        })
                      : t("sourceFirst.noNativeRecipient")}
                  </dd>
                  {isAboveNativeMeasure ? (
                    <>
                      <dt>{t("sourceFirst.nativeCarry")}</dt>
                      <dd>
                        {sourcePreview.nativePreview.targetCarryForward
                          ? `${sourcePreview.nativePreview.targetCarryForward} ${sourcePreview.currency}`
                          : t("sourceFirst.noNativeCarry")}
                      </dd>
                    </>
                  ) : (
                    <>
                      <dt>{t("sourceFirst.nativePool")}</dt>
                      <dd>
                        {sourcePreview.nativePreview.nativePoolAvailable
                          ? t("sourceFirst.positivePool")
                          : t("sourceFirst.noPayablePool")}
                      </dd>
                    </>
                  )}
                  <dt>{t("sourceFirst.nativeMeasure")}</dt>
                  <dd>
                    {sourcePreview.nativePreview.measuredValue} {sourcePreview.currency}
                  </dd>
                  <dt>{t("sourceFirst.measurementCutoff")}</dt>
                  <dd>
                    {sourcePreview.nativeMeasurementAsOf ?? t("sourceFirst.currentNativeState")}
                  </dd>
                </dl>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs">
                    {t("sourceFirst.showSelectedRow")}
                  </summary>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    {Object.entries(sourcePreview.sourceRow).map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt>{humanFieldName(key)}</dt>
                        <dd className="break-words">
                          {typeof value === "object" && value !== null
                            ? JSON.stringify(value)
                            : String(value ?? "")}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
                {sourcePreview.artifacts.length > 1 ? (
                  <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    {t("sourceFirst.corroborationSelected", {
                      count: sourcePreview.artifacts.length - 1,
                    })}
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                  {t("sourceFirst.nativeIdentityUnknown")}
                </p>
                {sourcePreview.nativePreview.targetRecipient &&
                sourcePreview.nativePreview.canRecordFirstObligation === false ? (
                  <Alert variant="destructive">
                    {t("sourceFirst.nativeRecipientAlreadyPayable")}
                  </Alert>
                ) : null}
                {!isAboveNativeMeasure && !sourcePreview.nativePreview.nativePoolAvailable ? (
                  <Alert variant="destructive">{t("sourceFirst.positivePoolRequired")}</Alert>
                ) : null}
                {isAboveNativeMeasure &&
                !sourcePreview.nativePreview.canRecordFirstObligation &&
                !sourcePreview.nativePreview.targetRecipient ? (
                  <Alert variant="destructive">{t("sourceFirst.negativeMeasureRequired")}</Alert>
                ) : null}
              </div>
            ) : null}
            <div>
              <Label htmlFor="source-first-mapping-basis">{t("sourceFirst.mappingBasis")}</Label>
              <Textarea
                id="source-first-mapping-basis"
                value={sourceMappingBasis}
                onChange={(event) => setSourceMappingBasis(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="source-first-mapping-reason">{t("sourceFirst.mappingReason")}</Label>
              <Textarea
                id="source-first-mapping-reason"
                value={sourceMappingReason}
                onChange={(event) => setSourceMappingReason(event.target.value)}
              />
            </div>
            {isAboveNativeMeasure ? (
              <>
                <div>
                  <Label htmlFor="source-first-governing-basis">
                    {t("sourceFirst.governingBasis")}
                  </Label>
                  <Textarea
                    id="source-first-governing-basis"
                    value={sourceGoverningBasis}
                    onChange={(event) => setSourceGoverningBasis(event.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="source-first-governing-reason">
                    {t("sourceFirst.governingReason")}
                  </Label>
                  <Textarea
                    id="source-first-governing-reason"
                    value={sourceGoverningReason}
                    onChange={(event) => setSourceGoverningReason(event.target.value)}
                  />
                </div>
              </>
            ) : null}
            <label className="flex items-start gap-2 text-xs">
              <Input
                id="source-first-mapping-confirmed"
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 p-0"
                checked={sourceConfirmedReviewKey === sourceConfirmationKey}
                onChange={(event) =>
                  setSourceConfirmedReviewKey(event.target.checked ? sourceConfirmationKey : "")
                }
                disabled={!sourcePreview || sourcePreview.reviewKey !== sourceReviewKey}
              />
              <span>{t("sourceFirst.mappingConfirmation")}</span>
            </label>
            <div>
              <Label htmlFor="source-first-reason">{t("sourceFirst.obligationReason")}</Label>
              <Textarea
                id="source-first-reason"
                value={sourceReason}
                onChange={(event) => setSourceReason(event.target.value)}
              />
            </div>
            {sourceError ? <Alert variant="destructive">{sourceError}</Alert> : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={
                  working ||
                  !sourceAsOf ||
                  !sourceFileId ||
                  !sourceVersionId ||
                  !sourceRowPointer ||
                  !sourceFieldsComplete
                }
                onClick={() => void previewSourceEvidence()}
              >
                {t("sourceFirst.verifyRow")}
              </Button>
              {sourcePreview ? (
                <Button
                  disabled={
                    working ||
                    sourceConfirmedReviewKey !== sourceConfirmationKey ||
                    !sourcePreview.nativePreview.canRecordFirstObligation
                  }
                  onClick={() => void recordSourceEvidenceFirst()}
                >
                  {t("sourceFirst.recordDraft")}
                </Button>
              ) : null}
            </div>
          </div>
        </details>
      ) : null}
    </section>
  ) : null;

  const activity = (
    <div className="flex flex-col gap-4 p-4">
      {!drawer.drawerRefusal && drawer.simulationRefusal ? (
        <Alert variant="destructive" className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            <span className="block font-medium">{drawer.simulationRefusal.title}</span>
            <span className="block text-xs">{drawer.simulationRefusal.message}</span>
          </span>
        </Alert>
      ) : null}
      {!drawer.drawerRefusal ? simulation : null}
      {drawer.activityRefusal ? (
        <>
          {activityToolbar ? (
            <div className="flex flex-wrap items-center gap-2">{activityToolbar}</div>
          ) : null}
          <Alert variant="destructive">{drawer.activityRefusal.message}</Alert>
        </>
      ) : (
        <AwardPortfolioTable
          rows={drawer.activity}
          text={tableText}
          total={drawer.activity.length}
          truncated={drawer.activityTruncated}
          toolbarAfter={activityToolbar}
        />
      )}
    </div>
  );
  const memberManageable = canManage && program.status !== "closed";

  const participants = (
    <div className="p-4">
      {!drawer.drawerRefusal ? (
        <>
          {program.eligibility === "all_employees" ? (
            <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
              {t("portfolio.members.employerWide")}
            </p>
          ) : null}
          <PagedTable
            searchable
            source="hrm_benefit_program_participants"
            rows={drawer.members}
            rowKey={(m) => m.id}
            searchText={(m) => `${m.employeeLabel} ${m.role ?? ""}`}
            toolbarAfter={
              memberManageable ? (
                <div className="ml-auto flex items-center">
                  <SublistAddButton
                    label={t("portfolio.addMember")}
                    onClick={() => setAdding(true)}
                  />
                </div>
              ) : undefined
            }
            columns={[
              {
                key: "employee",
                header: t("benefits.columns.employee"),
                cell: (m) =>
                  m.employeeHref ? (
                    <Link
                      href={m.employeeHref as never}
                      className="font-medium text-teal-700 hover:underline"
                    >
                      {m.employeeLabel}
                    </Link>
                  ) : (
                    m.employeeLabel
                  ),
              },
              {
                key: "effective",
                header: t("portfolio.columns.effective"),
                className: "whitespace-nowrap tabular-nums",
                cell: (m) => <span className="whitespace-nowrap tabular-nums">{m.rangeLabel}</span>,
              },
              { key: "role", header: t("portfolio.members.role"), cell: (m) => m.role ?? "—" },
              {
                key: "weight",
                header: t("portfolio.members.weight"),
                align: "right",
                cell: (m) => m.weight ?? "—",
              },
              {
                key: "actions",
                header: "",
                cell: (m) =>
                  memberManageable ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={working}
                      onClick={async () => {
                        const removal = await promptDialog({
                          title: t("portfolio.removeReasonPrompt"),
                          label: t("portfolio.removeReasonPrompt"),
                          confirmLabel: t("portfolio.removeMember"),
                        });
                        if (removal === null) return;
                        if (!removal.trim()) {
                          toast.error(t("portfolio.removeReasonRequired"));
                          return;
                        }
                        await act(
                          { action: "removeMember", membershipId: m.id, reason: removal.trim() },
                          "POST",
                        );
                      }}
                    >
                      {t("portfolio.removeMember")}
                    </Button>
                  ) : null,
              },
            ]}
            empty={<p>{drawer.membersEmpty}</p>}
          />
          <Drawer
            open={adding && memberManageable}
            onClose={() => {
              if (!working) setAdding(false);
            }}
            stacked
            size="md"
            title={t("portfolio.addMember")}
            footer={
              <>
                <Button variant="outline" disabled={working} onClick={() => setAdding(false)}>
                  {t("portfolio.builder.cancel")}
                </Button>
                <Button disabled={working} onClick={addMember}>
                  {t("portfolio.addMember")}
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-3">
              <div>
                <Label htmlFor="program-member-employment">
                  {t("portfolio.awardFields.recipient")}
                </Label>
                <Select
                  id="program-member-employment"
                  value={member.employmentId}
                  onChange={(e) => setMember((c) => ({ ...c, employmentId: e.target.value }))}
                >
                  <option value="">{t("portfolio.builder.chooseRecipient")}</option>
                  {employmentOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
              {program.eligibility === "all_employees" ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={member.excluded === true}
                    onChange={(e) => setMember((c) => ({ ...c, excluded: e.target.checked }))}
                  />
                  {t("portfolio.members.excludeLabel")}
                </label>
              ) : null}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="program-member-from">
                    {t("portfolio.builder.fields.effectiveFrom")}
                  </Label>
                  <DateField
                    id="program-member-from"
                    value={member.effectiveFrom}
                    onChange={(value) => setMember((c) => ({ ...c, effectiveFrom: value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="program-member-to">
                    {t("portfolio.builder.fields.effectiveTo")}
                  </Label>
                  <DateField
                    id="program-member-to"
                    value={member.effectiveTo}
                    onChange={(value) => setMember((c) => ({ ...c, effectiveTo: value }))}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="program-member-weight">{t("portfolio.members.weight")}</Label>
                  <Input
                    id="program-member-weight"
                    inputMode="decimal"
                    value={member.weight}
                    onChange={(e) => setMember((c) => ({ ...c, weight: e.target.value }))}
                    placeholder={t("portfolio.members.weightPlaceholder")}
                  />
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {t("portfolio.members.weightHint")}
                  </p>
                </div>
                <div>
                  <Label htmlFor="program-member-role">{t("portfolio.members.role")}</Label>
                  <Input
                    id="program-member-role"
                    value={member.role}
                    onChange={(e) => setMember((c) => ({ ...c, role: e.target.value }))}
                    placeholder={t("portfolio.members.rolePlaceholder")}
                  />
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {t("portfolio.members.roleHint")}
                  </p>
                </div>
              </div>
              {memberError ? (
                <p role="alert" className="text-xs text-red-700 dark:text-red-300">
                  {memberError}
                </p>
              ) : null}
            </div>
          </Drawer>
        </>
      ) : null}
    </div>
  );

  return (
    <TransactionDrawer
      recordId={program.id}
      targetTable="hrm_benefit_programs"
      closeHref={closeHref}
      title={
        <span className="flex items-center gap-2">
          {program.name}
          <Badge variant={program.statusVariant}>{program.statusLabel}</Badge>
        </span>
      }
      description={program.code}
      beforeClose={closeGuard.beforeClose}
      primaryAction={headerActions}
      actions={menuActions}
      showAttachments={false}
      detailsLabel={t("programWorkspace.rules")}
      activeTab={tab}
      onActiveTabChange={setTab}
      mountAllRecordTabs
      auditRefreshKey={drawer}
      detailTabs={[
        { key: "participants", label: t("programWorkspace.participants"), content: participants },
        {
          key: "activity",
          label: t(
            program.family === "incentive"
              ? "programWorkspace.calculations"
              : "programWorkspace.activity",
          ),
          content: activity,
        },
      ]}
    >
      <div className="flex flex-col gap-4 p-4">
        {drawer.drawerRefusal ? (
          <Alert variant="destructive" className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span className="flex flex-col items-start gap-2">
              <span>
                <span className="block font-medium">{drawer.drawerRefusal.title}</span>
                <span className="block text-xs">{drawer.drawerRefusal.message}</span>
              </span>
              <Button variant="outline" size="sm" onClick={() => router.refresh()}>
                {tCommon("actions.retry")}
              </Button>
            </span>
          </Alert>
        ) : null}
        <InspectorPanel title={program.familyLabel}>
          <dl className="grid gap-x-4 gap-y-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-slate-500 dark:text-slate-400">
                {t("portfolio.columns.value")}
              </dt>
              <dd className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
                {program.valueLabel}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500 dark:text-slate-400">
                {t("portfolio.columns.effective")}
              </dt>
              <dd className="whitespace-nowrap font-medium tabular-nums text-slate-900 dark:text-slate-100">
                {effectiveRange(program.effectiveFrom, program.effectiveTo)}
              </dd>
            </div>
            {drawer.policyLines.map((line) => (
              <div key={`${line.label}:${line.value}`}>
                <dt className="text-xs text-slate-500 dark:text-slate-400">{line.label}</dt>
                <dd className="font-medium text-slate-900 dark:text-slate-100">{line.value}</dd>
              </div>
            ))}
          </dl>
        </InspectorPanel>

        <InspectorPanel title={t("portfolio.approvalControls.title")}>
          {drawer.approvalPoliciesRefusal ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {drawer.approvalPoliciesRefusal.message}
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t(
                  drawer.approvalPolicies?.configured
                    ? "portfolio.approvalControls.policiesHint"
                    : "portfolio.approvalControls.unconfiguredStatus",
                )}
              </p>
              {drawer.approvalPolicies?.policies.map((policy) =>
                drawer.canConfigureApprovalPolicies ? (
                  <Link
                    key={policy.id}
                    href={policy.href as never}
                    className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
                  >
                    {policy.name}
                  </Link>
                ) : (
                  <p key={policy.id} className="text-sm font-medium">
                    {policy.name}
                  </p>
                ),
              )}
              {drawer.canConfigureApprovalPolicies ? (
                <div>
                  <Button asChild variant="outline" size="sm">
                    <Link href={(drawer.approvalPolicies?.href ?? "/admin/flows") as never}>
                      {t("portfolio.approvalControls.openFlows")}
                    </Link>
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {t("portfolio.approvalControls.administratorRemedy")}
                </p>
              )}
            </>
          )}
        </InspectorPanel>

        {!drawer.drawerRefusal &&
        program.family === "incentive" &&
        program.metric !== "approved_hours" &&
        program.metric !== "transactions" ? (
          <InspectorPanel title={t("portfolio.sourcesTitle")}>
            {drawer.sources.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{drawer.sourcesEmpty}</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {drawer.sources.map((s) => (
                  <li key={s.id} className="py-1.5 text-sm text-slate-600 dark:text-slate-300">
                    {s.accountLabel}
                  </li>
                ))}
              </ul>
            )}
          </InspectorPanel>
        ) : null}
      </div>
    </TransactionDrawer>
  );
}
