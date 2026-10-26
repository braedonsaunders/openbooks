"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  FileText,
  Keyboard,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Input,
  SearchSelect,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  UrlDrawer,
} from "@openbooks/ui";
import { Field } from "@/components/field";
import type { CaptureIssue, NormalizedCapture } from "@openbooks/engine/payables/ap-capture";
import { ReadOnlyValue } from "../../../../components/read-only-value";
import { readApiErrorMessage } from "../../../../lib/api-error";
import { confirmDialog } from "../../../../lib/confirm";
import { DateField } from "@/components/date-field";
import { useShortcuts } from "../../../../components/shortcuts/shortcut-provider";
import { captureAttentionKeys, captureFieldOrder, nextAttentionKey } from "./attention";

type Evidence = {
  fieldKey: string;
  lineIndex: number | null;
  confidence: string | null;
  pageNumber: number | null;
  polygon: { points: number[]; width: number; height: number } | null;
};

export type CaptureDetail = {
  id: string;
  status: string;
  /** Opaque optimistic-concurrency token: the capture's canonical revision when read. */
  updatedAt: string;
  file_id: string;
  original_filename: string;
  document_kind: "vendor_bill" | "vendor_credit";
  normalized: NormalizedCapture;
  validation_issues: CaptureIssue[];
  overall_confidence: string | null;
  vendor_candidate_id: string | null;
  purchase_order_id: string | null;
  document_id: string | null;
  last_error: string | null;
  contentType: string;
  sizeBytes: number;
  resolvedVendor: string | null;
  purchaseOrderNumber: string | null;
  evidence: Evidence[];
};

type Option = { id: string; label: string };

/** Where keyboard review goes next, in the list's own filter and order. */
export type CaptureNavigation = {
  listHref: string;
  previousHref: string | null;
  nextHref: string | null;
  /** The next capture still awaiting review, wrapping to an earlier one. */
  nextReviewHref: string | null;
};

/** The vendor's earned trust, read from its capture history. */
export type CaptureTrustState = {
  trusted: boolean;
  cleanStreak: number;
  threshold: number;
  policyEnabled: boolean;
  brokenBy: "edited" | "voided" | "not_posted" | null;
};

/** The latest auto-post decision recorded on this capture. */
export type CaptureAutoPostState = {
  kind: "auto_posted" | "auto_post_submitted" | "auto_post_refused" | "auto_post_skipped";
  reason: string | null;
  message: string | null;
};

const SKIP_REASONS = new Set([
  "policy_off",
  "unsigned_email",
  "not_a_bill",
  "needs_review",
  "duplicate",
  "vendor_unmatched",
  "vendor_not_trusted",
  "amount_unreadable",
  "over_limit",
  "currency_differs",
  "actor_not_permitted",
]);

/** A field's own control: its text, date or select input first, else its picker button (never the label's help button). */
const FIELD_CONTROLS = [
  'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]),textarea:not([disabled]),select:not([disabled])',
  'button:not([disabled]):not([tabindex="-1"]):not([data-field-help]),[role="combobox"]:not([tabindex="-1"])',
];

/** A failed capture save carrying the status so the drawer can tell a revision conflict (pause + remedy) from a transport failure. */
class CaptureSaveError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, status: number) {
    super(code);
    this.name = "CaptureSaveError";
    this.code = code;
    this.status = status;
  }
}

const STATUS_VARIANT: Record<
  string,
  "success" | "warning" | "destructive" | "outline" | "secondary"
> = {
  ready: "success",
  materialized: "success",
  needs_review: "warning",
  duplicate: "warning",
  failed: "destructive",
  extracting: "secondary",
  queued: "secondary",
  rejected: "outline",
};

export function CaptureReviewDrawer({
  initial,
  vendors,
  accounts,
  purchaseOrders,
  canLookupPurchaseOrders = true,
  canCreate,
  canApprovePriceOverride = false,
  canPost = false,
  navigation,
  trust = null,
  autoPost = null,
  attentionThreshold = "0.9000",
}: {
  initial: CaptureDetail;
  vendors: Option[];
  accounts: Option[];
  purchaseOrders: Option[];
  canLookupPurchaseOrders?: boolean;
  canCreate: boolean;
  canApprovePriceOverride?: boolean;
  canPost?: boolean;
  navigation?: CaptureNavigation;
  trust?: CaptureTrustState | null;
  autoPost?: CaptureAutoPostState | null;
  attentionThreshold?: string;
}) {
  const t = useTranslations("ap.capture");
  const ti = useTranslations("apInbox");
  const tc = useTranslations("common");
  const router = useRouter();
  const listHref = navigation?.listHref ?? "/ap/capture";
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [confirmedFields, setConfirmedFields] = useState<ReadonlySet<string>>(new Set());
  const [refusal, setRefusal] = useState<{ message: string; documentId: string | null } | null>(
    null,
  );
  const [createdDocumentId, setCreatedDocumentId] = useState<string | null>(initial.document_id);
  const [form, setForm] = useState(initial.normalized);
  const [vendorId, setVendorId] = useState(initial.vendor_candidate_id ?? "");
  const [purchaseOrderId, setPurchaseOrderId] = useState(initial.purchase_order_id ?? "");
  const [documentKind, setDocumentKind] = useState(initial.document_kind);
  const [status, setStatus] = useState(initial.status);
  const [revision, setRevision] = useState(initial.updatedAt);
  const [issues, setIssues] = useState<CaptureIssue[]>(
    Array.isArray(initial.validation_issues) ? initial.validation_issues : [],
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [activeEvidence, setActiveEvidence] = useState<Evidence | null>(null);
  const editable =
    canCreate && !["queued", "extracting", "materialized", "rejected"].includes(status);
  const options = (values: Option[]) =>
    values.map((value) => ({ value: value.id, label: value.label }));
  const optionLabel = (values: Option[], id: string | null | undefined) =>
    values.find((value) => value.id === id)?.label ?? "";
  const evidence = useMemo(
    () =>
      new Map(
        initial.evidence.map((value) => [`${value.fieldKey}:${value.lineIndex ?? ""}`, value]),
      ),
    [initial.evidence],
  );

  /**
   * Autosave races it must survive: the operator keeps typing while a PATCH
   * is in flight, and a PATCH can take longer than the 800 ms debounce, so
   * a second save must never run concurrently with the first.
   *
   * Discipline: saves serialize through one `flight` promise. A save started
   * while another is in flight joins it instead of sending a stale revision
   * (which the server would 409). Every successful response's revision is
   * adopted — even a superseded one — so the next save never 409s against
   * the save that just succeeded. The server-normalized form is adopted only
   * when nothing was typed after the request was sent; otherwise the
   * operator's newer keystrokes are kept and the loop persists them.
   */
  const editVersion = useRef(0);
  const flight = useRef<Promise<boolean> | null>(null);
  const saveQueued = useRef(false);
  // A revision conflict (another session changed the capture) pauses the
  // debounce until the operator edits again: retrying the same stale write
  // every 800 ms would 409 forever and toast-spam the whole time.
  const conflictAtVersion = useRef<number | null>(null);
  // Latest-render mirrors so the serialized loop always sends current values
  // even though it was entered from a stale closure.
  const formRef = useRef(form);
  const vendorRef = useRef(vendorId);
  const purchaseOrderRef = useRef(purchaseOrderId);
  const kindRef = useRef(documentKind);
  const revisionRef = useRef(revision);
  const dirtyRef = useRef(dirty);
  const statusRef = useRef(status);
  useEffect(() => {
    formRef.current = form;
  }, [form]);
  useEffect(() => {
    vendorRef.current = vendorId;
  }, [vendorId]);
  useEffect(() => {
    purchaseOrderRef.current = purchaseOrderId;
  }, [purchaseOrderId]);
  useEffect(() => {
    kindRef.current = documentKind;
  }, [documentKind]);
  useEffect(() => {
    revisionRef.current = revision;
  }, [revision]);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  /** Every local edit path runs through here: it versions the change the save loop compares against. */
  function markEdited() {
    editVersion.current += 1;
    conflictAtVersion.current = null;
    setDirty(true);
  }

  function update(next: NormalizedCapture) {
    setForm(next);
    markEdited();
  }

  const save = useCallback((): Promise<boolean> => {
    if (!editable) return Promise.resolve(true);
    if (flight.current) {
      // Join the active flight: it persists whatever is latest when its
      // in-flight request returns, so sending now would only 409.
      saveQueued.current = true;
      return flight.current;
    }
    const run = (async (): Promise<boolean> => {
      setSaving(true);
      try {
        for (;;) {
          saveQueued.current = false;
          if (!dirtyRef.current) return true;
          const sentVersion = editVersion.current;
          const response = await fetch(`/api/ap-capture/${initial.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              normalized: formRef.current,
              vendorId: vendorRef.current || null,
              purchaseOrderId: purchaseOrderRef.current || null,
              documentKind: kindRef.current,
              expectedUpdatedAt: revisionRef.current,
            }),
          });
          // The status is checked before the body is parsed: a proxy 502/504
          // HTML page is not JSON, and parsing first would turn the refusal
          // into a syntax error. The named refusal (or the translated
          // fallback with the status) rides in the error, never a
          // SyntaxError.
          if (!response.ok) {
            throw new CaptureSaveError(
              await readApiErrorMessage(response, t("saveFailed")),
              response.status,
            );
          }
          let body: {
            normalized?: NormalizedCapture;
            validationIssues?: CaptureIssue[];
            vendorId?: string | null;
            purchaseOrderId?: string | null;
            status?: string;
            updatedAt?: string;
          };
          try {
            body = (await response.json()) as typeof body;
          } catch {
            throw new CaptureSaveError(t("saveFailed"), response.status);
          }
          // Always adopt the newest revision — even when the operator typed
          // meanwhile. Dropping it here is what wedged every later autosave
          // on 409 after one slow response.
          if (body.updatedAt) {
            revisionRef.current = body.updatedAt;
            setRevision(body.updatedAt);
          }
          if (editVersion.current !== sentVersion || saveQueued.current) continue;
          // Quiet period: nothing newer exists, so the server-normalized
          // form (and only then) replaces the local one.
          if (body.normalized) {
            formRef.current = body.normalized;
            setForm(body.normalized);
          }
          setIssues(body.validationIssues ?? []);
          if (body.vendorId !== undefined) {
            vendorRef.current = body.vendorId ?? "";
            setVendorId(body.vendorId ?? "");
          }
          if (body.purchaseOrderId !== undefined) {
            purchaseOrderRef.current = body.purchaseOrderId ?? "";
            setPurchaseOrderId(body.purchaseOrderId ?? "");
          }
          if (body.status !== undefined) {
            statusRef.current = body.status;
            setStatus(body.status);
          }
          setDirty(false);
          return true;
        }
      } catch (error) {
        if (error instanceof CaptureSaveError && error.status === 409) {
          // Someone else (or another tab) changed the capture: pause the
          // debounce at this version and say so once, with the server's
          // own remedy, instead of 409ing every 800 ms until reload.
          conflictAtVersion.current = editVersion.current;
        }
        const message =
          error instanceof CaptureSaveError && error.code !== "save_failed"
            ? error.code
            : t("saveFailed");
        toast.error(message);
        return false;
      } finally {
        flight.current = null;
        setSaving(false);
      }
    })();
    flight.current = run;
    return run;
  }, [editable, initial.id, t]);

  useEffect(() => {
    if (!dirty || !editable) return;
    if (conflictAtVersion.current === editVersion.current) return;
    const timer = window.setTimeout(() => void save(), 800);
    return () => window.clearTimeout(timer);
  }, [dirty, editable, save, form, vendorId, purchaseOrderId, documentKind]);

  // Closing with a debounced edit still pending must not drop it: flush the
  // serialized save first (it joins any in-flight request, so it never 409s
  // against itself). If the flush fails, name the loss and keep the capture
  // open on refusal instead of silently discarding the edit.
  const beforeClose = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    if (await save()) return true;
    return confirmDialog({
      message: t("unsavedClose"),
      confirmLabel: tc("confirm.discardChanges"),
      tone: "danger",
    });
  }, [save, t, tc]);

  async function runBulkAction(kind: "reprocess" | "reject", extra: Record<string, unknown> = {}) {
    const response = await fetch("/api/ap-capture/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: kind, ids: [initial.id], ...extra }),
    });
    // The status is checked before the body parses, and the single
    // item's named refusal is toasted — never a SyntaxError, never the
    // generic fallback that hides which document failed and why.
    if (!response.ok) throw new Error(await readApiErrorMessage(response, t("actionFailed")));
    return (await response.json()) as {
      results?: Array<{ ok: boolean; error?: string; errorCode?: string; corrections?: number }>;
    };
  }

  async function action(kind: "reprocess" | "reject") {
    setActing(kind);
    try {
      let body = await runBulkAction(kind);
      const first = body?.results?.[0];
      // Reprocessing would silently discard the operator's review
      // corrections, so the route requires explicit confirmation naming
      // the loss. Confirm here with the server's message (no new copy —
      // the count and remedy live in it) and retry once with the flag.
      if (first && !first.ok && first.errorCode === "confirm_required" && kind === "reprocess") {
        const confirmed = await confirmDialog({
          message: first.error ?? t("actionFailed"),
          tone: "danger",
        });
        if (!confirmed) return;
        body = await runBulkAction(kind, { confirmDiscardCorrections: true });
      }
      if (!body?.results?.[0]?.ok) throw new Error(body?.results?.[0]?.error ?? t("actionFailed"));
      toast.success(t(kind === "reject" ? "rejected" : "reprocessQueued"));
      // A rejection finishes this capture, so review moves on to the next
      // one waiting; a reprocess returns to the list while extraction runs.
      if (kind === "reject") advance();
      else {
        router.push(listHref);
        router.refresh();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("actionFailed"));
    } finally {
      setActing(null);
    }
  }

  /** Move to the next capture awaiting review, or back to the list when none remain. */
  function advance() {
    if (!navigation?.nextReviewHref) toast.success(ti("keyboard.allReviewed"));
    router.push(navigation?.nextReviewHref ?? listHref);
    router.refresh();
  }

  /** Leave for another capture without dropping a pending edit. */
  async function go(href: string | null | undefined) {
    if (!href) return;
    if (dirtyRef.current && !(await save())) return;
    router.push(href);
  }

  /**
   * Create the draft, then either open it (the button), move on to the next
   * capture awaiting review (⌘Enter), or submit and post it through the
   * documents action — the same command a person uses on the bill, so an
   * approval Flow holds it and a posting refusal is pinned here with the
   * draft kept (⌘⇧Enter).
   */
  async function createDraft(priceOverride = false, mode: "open" | "advance" | "post" = "open") {
    if (dirty && !(await save())) return;
    if (priceOverride && !(await confirmDialog(t("priceOverrideConfirm")))) return;
    setActing(mode === "post" ? "post" : "materialize");
    setRefusal(null);
    try {
      const response = await fetch(`/api/ap-capture/${initial.id}/materialize`, {
        method: "POST",
        ...(priceOverride
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ priceOverride: true }),
            }
          : {}),
      });
      if (!response.ok) {
        const failure = (await response
          .clone()
          .json()
          .catch(() => null)) as { code?: string; details?: { line?: number } } | null;
        if (failure?.code === "purchase_order_unresolved")
          throw new Error(t("issues.purchase_order_unresolved"));
        if (failure?.code === "po_line_unmatched")
          throw new Error(t("issues.po_line_unmatched", { line: failure.details?.line ?? 1 }));
        throw new Error(await readApiErrorMessage(response, t("actionFailed")));
      }
      const body = (await response.json()) as { documentId?: string };
      if (!body?.documentId) throw new Error(t("actionFailed"));
      const documentId = body.documentId;
      setCreatedDocumentId(documentId);
      statusRef.current = "materialized";
      setStatus("materialized");
      if (mode === "open") {
        toast.success(t("draftCreated"));
        router.push(`/ap/bills?doc=${documentId}&mode=edit`);
        return;
      }
      if (mode === "post") {
        const posted = await fetch("/api/documents/actions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "post", documentId }),
        });
        // The status is checked before the body parses; a refusal keeps the
        // draft and stays pinned on this capture with its own remedy.
        if (!posted.ok) {
          const message = await readApiErrorMessage(posted, t("actionFailed"));
          setRefusal({ message, documentId });
          toast.error(ti("keyboard.postRefused", { message }));
          router.refresh();
          return;
        }
        const outcome = (await posted.json().catch(() => ({}))) as { pendingApproval?: boolean };
        toast.success(
          posted.status === 202 || outcome.pendingApproval
            ? ti("keyboard.submittedForApproval")
            : ti("keyboard.posted"),
        );
      } else {
        toast.success(t("draftCreated"));
      }
      advance();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("actionFailed"));
    } finally {
      setActing(null);
    }
  }

  /**
   * Localized label for an issue's engine field id, for interpolation into
   * catalog issue text. Line-amount fields reuse the lines column headers;
   * header fields reuse the form labels; anything unknown stays an id.
   */
  const issueFieldLabel = (field?: string): string => {
    if (!field) return "";
    const lineKey = `lines.${field === "taxAmount" ? "tax" : field}`;
    if (t.has(lineKey)) return t(lineKey);
    if (t.has(`fields.${field}`)) return t(`fields.${field}`);
    return field;
  };
  /**
   * Stable issue codes render through the active locale catalog with the
   * server-supplied interpolation data (line, expected/actual, decimal cause
   * tokens); the raw supplied value stays visible as {actual} so a decimal
   * refusal names exactly what the operator typed. The server English
   * message is the fallback for codes or causes this bundle does not know.
   */
  const issueText = (value: CaptureIssue): string => {
    const line = (value.lineIndex ?? 0) + 1;
    const params = { line, expected: value.expected ?? "", actual: value.actual ?? "" };
    if (value.code === "invalid_amount" && value.cause) {
      const key = `issues.invalid_amount_${value.cause.replace(/-/g, "_")}`;
      if (t.has(key)) {
        return t(key, {
          ...params,
          detail: value.detail ?? "",
          field: issueFieldLabel(value.field),
          noun: value.field === "quantity" ? t("issues.nounQuantity") : t("issues.nounAmount"),
        });
      }
    } else if (t.has(`issues.${value.code}`)) {
      return t(`issues.${value.code}`, params);
    }
    return value.message ?? t(`issues.${value.code}`, params);
  };
  const confidence = (fieldKey: string, lineIndex: number | null = null) => {
    const fieldEvidence = evidence.get(`${fieldKey}:${lineIndex ?? ""}`);
    const value = fieldEvidence?.confidence;
    if (!value) return null;
    const percent = Math.round(Number(value) * 100);
    const badge = (
      <Badge variant={percent >= 90 ? "success" : percent >= 70 ? "warning" : "destructive"}>
        {t("confidencePercent", { percent })}
      </Badge>
    );
    const canHighlight =
      initial.contentType.startsWith("image/") &&
      initial.contentType !== "image/tiff" &&
      fieldEvidence?.pageNumber === 1 &&
      fieldEvidence.polygon;
    return canHighlight ? (
      <button
        type="button"
        title={t("highlightEvidence")}
        aria-label={t("highlightEvidence")}
        onClick={() => setActiveEvidence(fieldEvidence)}
        className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
      >
        {badge}
      </button>
    ) : (
      badge
    );
  };
  const blockingIssues = issues.filter((value) => value.severity === "blocking");
  const priceOverrideAvailable =
    canApprovePriceOverride &&
    blockingIssues.length > 0 &&
    blockingIssues.every((value) => value.code === "po_price_variance");
  const draftable =
    canCreate && ["ready", "needs_review"].includes(status) && blockingIssues.length === 0;
  const rejectable =
    canCreate && !["materialized", "rejected", "queued", "extracting"].includes(status);

  // Fields needing attention, in form order. Enter in a field confirms it and
  // moves to the next one still needing attention; once none remain it lands
  // on Create draft. The first one takes focus when the drawer opens.
  const attention = useMemo(
    () =>
      captureAttentionKeys({
        form,
        vendorId,
        issues,
        evidence: initial.evidence,
        threshold: attentionThreshold,
      }),
    [form, vendorId, issues, initial.evidence, attentionThreshold],
  );
  const fieldOrder = useMemo(() => captureFieldOrder(form.lines.length), [form.lines.length]);
  const [initialFocusKey] = useState(() =>
    editable
      ? nextAttentionKey(
          captureFieldOrder(initial.normalized.lines.length),
          captureAttentionKeys({
            form: initial.normalized,
            vendorId: initial.vendor_candidate_id ?? "",
            issues: Array.isArray(initial.validation_issues) ? initial.validation_issues : [],
            evidence: initial.evidence,
            threshold: attentionThreshold,
          }),
          new Set(),
          null,
        )
      : null,
  );
  const needsAttention = (key: string) =>
    editable && attention.has(key) && !confirmedFields.has(key);
  const fieldProps = (key: string) => ({
    "data-capture-field": key,
    "data-attention": needsAttention(key) ? "true" : undefined,
  });
  const attentionRing = (key: string) =>
    needsAttention(key)
      ? "rounded-md ring-2 ring-amber-300 ring-offset-2 ring-offset-white dark:ring-amber-700 dark:ring-offset-slate-950"
      : undefined;
  const dialog = () => rootRef.current?.closest('[role="dialog"]') ?? rootRef.current;

  function focusField(key: string): boolean {
    const wrapper = rootRef.current?.querySelector<HTMLElement>(`[data-capture-field="${key}"]`);
    const control = FIELD_CONTROLS.map((selector) =>
      wrapper?.querySelector<HTMLElement>(selector),
    ).find(Boolean);
    if (!control) return false;
    control.focus();
    if (control instanceof HTMLInputElement) control.select();
    return true;
  }

  // The drawer places its own initial focus once it opens; the first field
  // needing attention then takes it, unless the reviewer is already in a field.
  useEffect(() => {
    if (!initialFocusKey) return;
    let inner: number | undefined;
    const outer = window.setTimeout(() => {
      inner = window.setTimeout(() => {
        if ((document.activeElement as HTMLElement | null)?.closest?.("[data-capture-field]"))
          return;
        focusField(initialFocusKey);
      }, 0);
    }, 0);
    return () => {
      window.clearTimeout(outer);
      if (inner !== undefined) window.clearTimeout(inner);
    };
    // Initial focus belongs to the opening of this capture only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onFieldKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (
      event.key !== "Enter" ||
      event.defaultPrevented ||
      event.shiftKey ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.nativeEvent.isComposing
    )
      return;
    const target = event.target as HTMLElement;
    // A multi-line memo keeps its newline, and an open picker owns its Enter.
    if (target.tagName === "TEXTAREA" || target.getAttribute("aria-expanded") === "true") return;
    const wrapper = target.closest<HTMLElement>("[data-capture-field]");
    if (!wrapper) return;
    const current = wrapper.dataset.captureField!;
    event.preventDefault();
    const confirmed = new Set(confirmedFields);
    confirmed.add(current);
    setConfirmedFields(confirmed);
    const next = nextAttentionKey(fieldOrder, attention, confirmed, current);
    if (next && focusField(next)) return;
    dialog()?.querySelector<HTMLElement>("[data-capture-primary]:not([disabled])")?.focus();
  }

  async function rejectFromKeyboard() {
    if (
      !(await confirmDialog({
        message: ti("keyboard.rejectConfirm", { name: initial.original_filename }),
        tone: "danger",
      }))
    )
      return;
    await action("reject");
  }

  useShortcuts([
    {
      id: "apCaptureNext",
      label: () => ti("keyboard.next"),
      binding: { character: "j" },
      scope: "form",
      container: dialog,
      enabled: () => Boolean(navigation?.nextHref) && acting === null,
      run: () => void go(navigation?.nextHref),
    },
    {
      id: "apCapturePrevious",
      label: () => ti("keyboard.previous"),
      binding: { character: "k" },
      scope: "form",
      container: dialog,
      enabled: () => Boolean(navigation?.previousHref) && acting === null,
      run: () => void go(navigation?.previousHref),
    },
    // Alt+↓ / Alt+↑ move through the queue even while a field holds focus.
    {
      id: "apCaptureNextFromField",
      label: () => ti("keyboard.next"),
      binding: { modifier: "alt", code: "ArrowDown" },
      scope: "form",
      allowInEditable: true,
      container: dialog,
      enabled: () => Boolean(navigation?.nextHref) && acting === null,
      run: () => void go(navigation?.nextHref),
    },
    {
      id: "apCapturePreviousFromField",
      label: () => ti("keyboard.previous"),
      binding: { modifier: "alt", code: "ArrowUp" },
      scope: "form",
      allowInEditable: true,
      container: dialog,
      enabled: () => Boolean(navigation?.previousHref) && acting === null,
      run: () => void go(navigation?.previousHref),
    },
    {
      id: "apCaptureCreateDraft",
      label: () => ti("keyboard.createDraft"),
      binding: { modifier: "primary", code: "Enter" },
      scope: "form",
      allowInEditable: true,
      container: dialog,
      enabled: () => draftable && acting === null,
      run: () => void createDraft(false, "advance"),
    },
    {
      id: "apCaptureCreateAndPost",
      label: () => ti("keyboard.createAndPost"),
      binding: { modifier: "primary", code: "Enter", shift: true },
      scope: "form",
      allowInEditable: true,
      container: dialog,
      enabled: () => draftable && canPost && acting === null,
      run: () => void createDraft(false, "post"),
    },
    {
      id: "apCaptureReject",
      label: () => ti("keyboard.reject"),
      binding: { modifier: "primary", code: "Backspace" },
      scope: "form",
      container: dialog,
      enabled: () => rejectable && acting === null,
      run: () => void rejectFromKeyboard(),
    },
  ]);

  const headerActions = canCreate ? (
    <div className="flex items-center gap-2">
      {["failed", "needs_review", "ready", "duplicate"].includes(status) ? (
        <Button
          variant="outline"
          size="sm"
          disabled={acting !== null}
          onClick={() => void action("reprocess")}
        >
          {acting === "reprocess" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <RefreshCw size={13} />
          )}
          {t("reprocess")}
        </Button>
      ) : null}
      {rejectable ? (
        <Button
          variant="outline"
          size="sm"
          disabled={acting !== null}
          onClick={() => void action("reject")}
        >
          <X size={13} />
          {t("reject")}
        </Button>
      ) : null}
      {draftable && canPost ? (
        <Button
          variant="outline"
          size="sm"
          disabled={acting !== null || saving}
          onClick={() => void createDraft(false, "post")}
        >
          {acting === "post" ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
          {ti("keyboard.createAndPostButton")}
        </Button>
      ) : null}
      {draftable ? (
        <Button
          size="sm"
          data-capture-primary=""
          disabled={acting !== null || saving || dirty}
          onClick={() => void createDraft()}
        >
          {acting === "materialize" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Check size={13} />
          )}
          {t("createDraft")}
        </Button>
      ) : null}
      {["ready", "needs_review"].includes(status) && priceOverrideAvailable ? (
        <Button
          size="sm"
          disabled={acting !== null || saving || dirty}
          onClick={() => void createDraft(true)}
        >
          {acting === "materialize" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Check size={13} />
          )}
          {t("createDraftPriceOverride")}
        </Button>
      ) : null}
    </div>
  ) : undefined;

  const trustLine = trust
    ? trust.trusted
      ? ti("trust.trusted", { count: trust.cleanStreak })
      : ti("trust.building", { count: trust.cleanStreak, threshold: trust.threshold })
    : null;
  const autoPostLine = (() => {
    if (!autoPost) return null;
    if (autoPost.kind === "auto_posted") return ti("autoPost.posted");
    if (autoPost.kind === "auto_post_submitted") return ti("autoPost.submitted");
    if (autoPost.kind === "auto_post_refused")
      return ti("autoPost.refused", { message: autoPost.message ?? "" });
    return autoPost.reason && SKIP_REASONS.has(autoPost.reason)
      ? ti(`autoPost.skipped.${autoPost.reason}`)
      : null;
  })();

  return (
    <UrlDrawer
      open
      closeHref={listHref}
      size="full"
      initialFullscreen
      beforeClose={beforeClose}
      title={
        <span className="flex items-center gap-2">
          <FileText size={17} />
          {initial.original_filename}
          <Badge variant={STATUS_VARIANT[status] ?? "outline"}>{t(`status.${status}`)}</Badge>
        </span>
      }
      description={saving ? t("saving") : dirty ? t("unsaved") : t("saved")}
      headerActions={headerActions}
      bodyClassName="overflow-hidden p-0"
    >
      <div
        ref={rootRef}
        className="grid h-full min-h-0 lg:grid-cols-[minmax(0,1.05fr)_minmax(32rem,.95fr)]"
      >
        <section className="min-h-[38vh] border-b border-slate-200 bg-slate-100 lg:min-h-0 lg:border-r lg:border-b-0 dark:border-slate-800 dark:bg-slate-950">
          {initial.contentType.startsWith("image/") && initial.contentType !== "image/tiff" ? (
            <div className="relative h-full w-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/ap-capture/${initial.id}/file`}
                alt={t("sourcePreviewAlt", { name: initial.original_filename })}
                className="h-full w-full object-contain"
              />
              {activeEvidence?.polygon ? (
                <svg
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  viewBox={`0 0 ${activeEvidence.polygon.width} ${activeEvidence.polygon.height}`}
                  preserveAspectRatio="xMidYMid meet"
                  aria-hidden="true"
                >
                  <polygon
                    points={activeEvidence.polygon.points
                      .reduce<string[]>(
                        (points, value, index, values) =>
                          index % 2 === 0 ? [...points, `${value},${values[index + 1]}`] : points,
                        [],
                      )
                      .join(" ")}
                    className="fill-teal-400/25 stroke-teal-500"
                    strokeWidth={
                      Math.max(activeEvidence.polygon.width, activeEvidence.polygon.height) / 250
                    }
                  />
                </svg>
              ) : null}
            </div>
          ) : (
            <iframe
              src={`/api/ap-capture/${initial.id}/file`}
              title={t("sourcePreview")}
              className="h-full min-h-[38vh] w-full border-0"
            />
          )}
        </section>
        <section
          className="app-scroll min-h-0 overflow-y-auto p-4 sm:p-5"
          onKeyDown={onFieldKeyDown}
        >
          {["queued", "extracting"].includes(status) ? (
            <div className="flex h-full min-h-72 items-center justify-center gap-3 text-slate-500">
              <Loader2 className="animate-spin" />
              {t("processing")}
            </div>
          ) : status === "failed" ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              {t("processingFailed")}
            </div>
          ) : (
            <div className="space-y-5">
              {refusal ? (
                <div
                  role="alert"
                  className="flex flex-wrap items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200"
                >
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    {ti("keyboard.postRefused", { message: refusal.message })}
                  </span>
                  {refusal.documentId ? (
                    <Link
                      href={`/ap/bills?doc=${refusal.documentId}&mode=edit`}
                      className="font-medium underline"
                    >
                      {ti("keyboard.openDraft")}
                    </Link>
                  ) : null}
                </div>
              ) : null}
              {issues.length ? (
                <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                  {issues.map((value, index) => (
                    <div
                      key={`${value.code}-${value.lineIndex ?? ""}-${index}`}
                      className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200"
                    >
                      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                      <span>{issueText(value)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {trustLine || autoPostLine ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {trustLine ? (
                    <Badge variant={trust?.trusted ? "success" : "outline"} className="gap-1">
                      {trust?.trusted ? <BadgeCheck size={12} /> : null}
                      {trustLine}
                    </Badge>
                  ) : null}
                  {autoPostLine ? (
                    <span className="text-slate-600 dark:text-slate-300">{autoPostLine}</span>
                  ) : null}
                </div>
              ) : null}
              {createdDocumentId ? (
                <Button variant="outline" asChild>
                  <Link href={`/ap/bills?doc=${createdDocumentId}`}>{t("openDraft")}</Link>
                </Button>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("fields.kind")}>
                  {editable ? (
                    <Select
                      value={documentKind}
                      onChange={(event) => {
                        setDocumentKind(
                          event.target.value === "vendor_credit" ? "vendor_credit" : "vendor_bill",
                        );
                        markEdited();
                      }}
                    >
                      <option value="vendor_bill">{t("bill")}</option>
                      <option value="vendor_credit">{t("credit")}</option>
                    </Select>
                  ) : (
                    <ReadOnlyValue
                      value={documentKind === "vendor_credit" ? t("credit") : t("bill")}
                    />
                  )}
                </Field>
                <div {...fieldProps("vendor")} className={attentionRing("vendor")}>
                  <Field label={t("fields.vendor")} aside={confidence("vendorName")}>
                    {editable ? (
                      <SearchSelect
                        value={vendorId}
                        onChange={(value) => {
                          setVendorId(value);
                          markEdited();
                        }}
                        options={options(vendors)}
                        clearable
                        placeholder={t("fields.vendorPlaceholder")}
                        sheetTitle={t("fields.vendor")}
                        ariaLabel={t("fields.vendor")}
                      />
                    ) : (
                      <ReadOnlyValue
                        value={optionLabel(vendors, vendorId) || initial.resolvedVendor}
                      />
                    )}
                  </Field>
                </div>
                <div {...fieldProps("invoiceNumber")} className={attentionRing("invoiceNumber")}>
                  <Field label={t("fields.invoiceNumber")} aside={confidence("invoiceNumber")}>
                    {editable ? (
                      <Input
                        value={form.invoiceNumber ?? ""}
                        onChange={(event) => update({ ...form, invoiceNumber: event.target.value })}
                      />
                    ) : (
                      <ReadOnlyValue value={form.invoiceNumber} className="font-mono" />
                    )}
                  </Field>
                </div>
                <div {...fieldProps("invoiceDate")} className={attentionRing("invoiceDate")}>
                  <Field label={t("fields.invoiceDate")} aside={confidence("invoiceDate")}>
                    {editable ? (
                      <DateField
                        value={form.invoiceDate ?? ""}
                        onChange={(value) => update({ ...form, invoiceDate: value })}
                      />
                    ) : (
                      <ReadOnlyValue value={form.invoiceDate} />
                    )}
                  </Field>
                </div>
                <div {...fieldProps("dueDate")} className={attentionRing("dueDate")}>
                  <Field label={t("fields.dueDate")} aside={confidence("dueDate")}>
                    {editable ? (
                      <DateField
                        value={form.dueDate ?? ""}
                        onChange={(value) => update({ ...form, dueDate: value || null })}
                      />
                    ) : (
                      <ReadOnlyValue value={form.dueDate} />
                    )}
                  </Field>
                </div>
                <div {...fieldProps("currency")} className={attentionRing("currency")}>
                  <Field label={t("fields.currency")} aside={confidence("currency")}>
                    {editable ? (
                      <Input
                        value={form.currency ?? ""}
                        maxLength={3}
                        onChange={(event) =>
                          update({ ...form, currency: event.target.value.toUpperCase() })
                        }
                      />
                    ) : (
                      <ReadOnlyValue value={form.currency} className="font-mono" />
                    )}
                  </Field>
                </div>
                <div
                  {...fieldProps("purchaseOrder")}
                  className={["sm:col-span-2", attentionRing("purchaseOrder")]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <Field
                    label={t("fields.purchaseOrder")}
                    aside={confidence("purchaseOrderNumber")}
                  >
                    {editable && canLookupPurchaseOrders ? (
                      <SearchSelect
                        value={purchaseOrderId}
                        onChange={(value) => {
                          setPurchaseOrderId(value);
                          markEdited();
                        }}
                        options={options(purchaseOrders)}
                        clearable
                        placeholder={t("fields.purchaseOrderPlaceholder")}
                        sheetTitle={t("fields.purchaseOrder")}
                        ariaLabel={t("fields.purchaseOrder")}
                      />
                    ) : (
                      <ReadOnlyValue
                        value={
                          optionLabel(purchaseOrders, purchaseOrderId) ||
                          initial.purchaseOrderNumber
                        }
                      />
                    )}
                  </Field>
                </div>
                <div {...fieldProps("memo")} className="sm:col-span-2">
                  <Field label={t("fields.memo")}>
                    {editable ? (
                      <Textarea
                        value={form.memo ?? ""}
                        onChange={(event) => update({ ...form, memo: event.target.value || null })}
                        rows={2}
                      />
                    ) : (
                      <ReadOnlyValue value={form.memo} className="whitespace-pre-wrap" />
                    )}
                  </Field>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">{t("lines.title")}</h3>
                  {editable ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        update({
                          ...form,
                          lines: [
                            ...form.lines,
                            {
                              description: "",
                              productCode: null,
                              quantity: "1.0000",
                              unit: null,
                              unitPrice: "0.0000",
                              amount: "0.0000",
                              taxAmount: "0.0000",
                              accountId: null,
                              itemId: null,
                              purchaseOrderLineId: null,
                              confidence: null,
                            },
                          ],
                        })
                      }
                    >
                      <Plus size={13} />
                      {t("lines.add")}
                    </Button>
                  ) : null}
                </div>
                <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("lines.description")}</TableHead>
                        <TableHead>{t("lines.account")}</TableHead>
                        <TableHead className="w-24">{t("lines.quantity")}</TableHead>
                        <TableHead className="w-28">{t("lines.unitPrice")}</TableHead>
                        <TableHead className="w-28">{t("lines.amount")}</TableHead>
                        <TableHead className="w-24">{t("lines.tax")}</TableHead>
                        {editable ? (
                          <TableHead className="w-10">
                            <span className="sr-only">{tc("actions.delete")}</span>
                          </TableHead>
                        ) : null}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {form.lines.map((line, lineIndex) => (
                        <TableRow key={lineIndex}>
                          <TableCell className="min-w-44">
                            <div className="mb-1 flex justify-end">
                              {confidence("lines.description", lineIndex) ??
                                confidence("lines.amount", lineIndex)}
                            </div>
                            <div
                              {...fieldProps(`line:${lineIndex}:description`)}
                              className={attentionRing(`line:${lineIndex}:description`)}
                            >
                              {editable ? (
                                <Input
                                  aria-label={`${t("lines.description")} ${lineIndex + 1}`}
                                  value={line.description}
                                  onChange={(event) =>
                                    update({
                                      ...form,
                                      lines: form.lines.map((value, index) =>
                                        index === lineIndex
                                          ? { ...value, description: event.target.value }
                                          : value,
                                      ),
                                    })
                                  }
                                />
                              ) : (
                                line.description || "—"
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="min-w-48">
                            <div
                              {...fieldProps(`line:${lineIndex}:account`)}
                              className={attentionRing(`line:${lineIndex}:account`)}
                            >
                              {editable ? (
                                <SearchSelect
                                  value={line.accountId ?? ""}
                                  onChange={(value) =>
                                    update({
                                      ...form,
                                      lines: form.lines.map((current, index) =>
                                        index === lineIndex
                                          ? {
                                              ...current,
                                              accountId: value || null,
                                              itemId: value ? null : current.itemId,
                                            }
                                          : current,
                                      ),
                                    })
                                  }
                                  options={options(accounts)}
                                  disabled={Boolean(line.purchaseOrderLineId)}
                                  clearable
                                  placeholder={t("lines.accountPlaceholder")}
                                  sheetTitle={t("lines.account")}
                                  ariaLabel={`${t("lines.account")} ${lineIndex + 1}`}
                                />
                              ) : (
                                optionLabel(accounts, line.accountId) || "—"
                              )}
                            </div>
                          </TableCell>
                          {(["quantity", "unitPrice", "amount", "taxAmount"] as const).map(
                            (key) => (
                              <TableCell key={key} className="text-right tabular-nums">
                                <div
                                  {...fieldProps(`line:${lineIndex}:${key}`)}
                                  className={attentionRing(`line:${lineIndex}:${key}`)}
                                >
                                  {editable ? (
                                    <Input
                                      aria-label={`${t(`lines.${key === "taxAmount" ? "tax" : key}`)} ${lineIndex + 1}`}
                                      inputMode="decimal"
                                      value={line[key]}
                                      onChange={(event) =>
                                        update({
                                          ...form,
                                          lines: form.lines.map((current, index) =>
                                            index === lineIndex
                                              ? { ...current, [key]: event.target.value }
                                              : current,
                                          ),
                                        })
                                      }
                                      className="text-right tabular-nums"
                                    />
                                  ) : (
                                    line[key] || "—"
                                  )}
                                </div>
                              </TableCell>
                            ),
                          )}
                          {editable ? (
                            <TableCell>
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={t("lines.remove", { line: lineIndex + 1 })}
                                onClick={() =>
                                  update({
                                    ...form,
                                    lines: form.lines.filter((_, index) => index !== lineIndex),
                                  })
                                }
                              >
                                <Trash2 size={14} />
                              </Button>
                            </TableCell>
                          ) : null}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div {...fieldProps("subtotal")} className={attentionRing("subtotal")}>
                  <Field label={t("fields.subtotal")} aside={confidence("subtotal")}>
                    {editable ? (
                      <Input
                        inputMode="decimal"
                        value={form.subtotal ?? ""}
                        onChange={(event) => update({ ...form, subtotal: event.target.value })}
                        className="text-right tabular-nums"
                      />
                    ) : (
                      <ReadOnlyValue value={form.subtotal} className="text-right tabular-nums" />
                    )}
                  </Field>
                </div>
                <div {...fieldProps("taxTotal")} className={attentionRing("taxTotal")}>
                  <Field label={t("fields.taxTotal")} aside={confidence("taxTotal")}>
                    {editable ? (
                      <Input
                        inputMode="decimal"
                        value={form.taxTotal ?? ""}
                        onChange={(event) => update({ ...form, taxTotal: event.target.value })}
                        className="text-right tabular-nums"
                      />
                    ) : (
                      <ReadOnlyValue value={form.taxTotal} className="text-right tabular-nums" />
                    )}
                  </Field>
                </div>
                <div {...fieldProps("total")} className={attentionRing("total")}>
                  <Field label={t("fields.total")} aside={confidence("total")}>
                    {editable ? (
                      <Input
                        inputMode="decimal"
                        value={form.total ?? ""}
                        onChange={(event) => update({ ...form, total: event.target.value })}
                        className="text-right font-semibold tabular-nums"
                      />
                    ) : (
                      <ReadOnlyValue
                        value={form.total}
                        className="text-right font-semibold tabular-nums"
                      />
                    )}
                  </Field>
                </div>
              </div>
              {editable ? (
                <p className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <Keyboard size={13} className="shrink-0" />
                  {ti("keyboard.hint")}
                </p>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </UrlDrawer>
  );
}
