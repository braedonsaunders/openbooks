import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { FormLayoutConfig, HeaderFieldPlacement } from "@openbooks/customization";
import { add, cmp, neg, normalizeMoney } from "@openbooks/engine/money/money";
import { useEntryPreferences } from "../lib/entry-preferences-context";
import { resolveEnteredAmount } from "../lib/entry-amount";
import { stashEntryCarry, takeEntryCarry } from "../lib/entry-carry";
import { civilDateParams } from "../lib/format";
import { emptyLine, isBlankDrawerLine } from "./document-drawer-lines";
import type { LineRow } from "./document-drawer-types";
import type { DocumentDrawerPickersScope } from "./document-drawer-pickers";

/** The party's default coding for item-less lines, as the server resolved it. */
export interface PartyLineDefault {
  accountId: string | null;
  accountSource: "party_default" | "party_history" | null;
  taxCodeId: string | null;
  /** A tax group the party's history settles on; never set with `taxCodeId`. */
  taxGroupId?: string | null;
  taxSource: "party" | "party_history" | null;
  historyCount?: number;
  taxHistoryCount?: number;
}

/** The party's most recent document of this kind, for recall. */
export interface RecentPartyDocument {
  id: string;
  documentNumber: string | null;
  documentDate: string | null;
  referenceNumber: string | null;
  memo: string | null;
  total: string;
  currency: string | null;
  lines: {
    accountId: string | null;
    itemId: string | null;
    description: string | null;
    quantity: string | null;
    unitPrice: string | null;
    amount: string | null;
    departmentId: string | null;
    projectId: string | null;
    locationId: string | null;
    classId: string | null;
    taxCodeId: string | null;
  }[];
}

export interface DuplicateMatch {
  id: string;
  documentNumber: string;
  documentDate: string | null;
  total: string | null;
  status: string | null;
  referenceNumber: string | null;
  reason: "reference" | "party_date_total";
}

/**
 * Header fields that matter on most documents stay in view; the rest open
 * under "More details" on a new document. A field the form marks required,
 * a custom field, or a group an administrator arranged themselves is never
 * moved.
 */
const DETAIL_HEADER_KEYS = new Set([
  "posting_date",
  "department_id",
  "project_id",
  "location_id",
  "class_id",
  "internal_notes",
  "expected_pay_date",
  "payment_hold_reason",
  "billing_method",
  "is_final_invoice",
  "work_completed_on",
]);

export function entryHeaderLayout(
  layout: FormLayoutConfig,
  detailsLabel: string,
  extraDetails: readonly HeaderFieldPlacement[] = [],
): FormLayoutConfig {
  const groups = layout.header.groups;
  if (groups.length !== 1 || groups[0]!.collapsible) return layout;
  const [group] = groups;
  const isDetail = (field: HeaderFieldPlacement) =>
    DETAIL_HEADER_KEYS.has(field.key) && field.required !== true;
  const details = [...group!.fields.filter(isDetail), ...extraDetails];
  if (details.length === 0) return layout;
  return {
    ...layout,
    header: {
      ...layout.header,
      groups: [
        { ...group!, fields: group!.fields.filter((field) => !isDetail(field)) },
        { id: "entry-details", label: detailsLabel, collapsible: true, fields: details },
      ],
    },
  };
}

/** The document's receivable/payable account choice, placed with the other header details. */
export const CONTROL_ACCOUNT_DETAIL: HeaderFieldPlacement = {
  key: "control_account",
  visible: true,
  required: null,
  labelOverride: null,
  colSpan: 2,
};

/** Line columns that open only with Details (or when a line uses them) unless a form says otherwise. */
export const ENTRY_SECONDARY_LINE_KEYS = new Set([
  "quantity",
  "unit",
  "unit_price",
  "department_id",
  "project_id",
  "location_id",
  "class_id",
  "work_from",
  "work_to",
]);

/**
 * Entry-speed behaviour for transaction documents: the party's default
 * coding on new lines, recall of the party's last document, a live
 * duplicate-reference check, the carried date and party for Save & new, and
 * an optional control total the lines must reach before saving.
 */
export function useDocumentDrawerEntry(scope: DocumentDrawerPickersScope) {
  const {
    config,
    isCreate,
    editable,
    partyId,
    changeParty,
    rows,
    setRows,
    accounts,
    taxProfiles,
    referenceNumber,
    memo,
    setMemo,
    documentDate,
    setDocumentDate,
    doc,
    currency,
    effectiveTotals,
    items,
    parties,
  } = scope;
  const t = useTranslations("entry");
  const locale = useLocale();
  const { preferences } = useEntryPreferences();
  /** Civil dates in entry banners read in the viewer's locale. */
  const localDate = useCallback(
    (value: string | null) => (value ? String(civilDateParams({ value }, locale).value) : "—"),
    [locale],
  );
  const lineSide = config.lineDefaults ?? null;
  const accountIds = useMemo(() => new Set(accounts.map((account) => account.id)), [accounts]);
  const taxValues = useMemo(
    () => new Set(taxProfiles.map((profile) => profile.value)),
    [taxProfiles],
  );
  const itemIds = useMemo(() => new Set((items ?? []).map((item) => item.id)), [items]);

  // -- party defaults and recall ------------------------------------------
  // Answers are kept with the party they were asked for, so a slow answer
  // for the previous vendor is never applied to the current one.
  const partyKey = editable && lineSide && partyId ? partyId : null;
  const [partyAnswer, setPartyAnswer] = useState<{
    partyId: string;
    line: PartyLineDefault | null;
    recent: RecentPartyDocument | null;
  } | null>(null);
  const current = partyAnswer && partyAnswer.partyId === partyKey ? partyAnswer : null;
  const partyLine = current?.line ?? null;
  const recent = current?.recent ?? null;
  const [recallState, setRecall] = useState<{
    key: string;
    documentNumber: string | null;
    undo: { rows: LineRow[]; memo: string };
  } | null>(null);
  const recallKey = recent ? `${partyId}:${recent.id}` : null;
  const recall = recallState && recallState.key === recallKey ? recallState : null;
  // The latest rows and memo, for recall applied when an answer arrives.
  const latest = useRef({ rows, memo });
  useEffect(() => {
    latest.current = { rows, memo };
  }, [rows, memo]);

  const defaultAccount =
    partyLine?.accountId && accountIds.has(partyLine.accountId) ? partyLine.accountId : "";
  const partyTaxValue = partyLine?.taxCodeId
    ? `code:${partyLine.taxCodeId}`
    : partyLine?.taxGroupId
      ? `group:${partyLine.taxGroupId}`
      : "";
  const defaultTax =
    config.hasTax && partyTaxValue && taxValues.has(partyTaxValue) ? partyTaxValue : "";

  // Each line takes the party default once: when it first appears without
  // an item or account, or when the party changes while the line still
  // carries the previous party's default. A line the clerk recoded keeps
  // the clerk's choice. The line records what it was given (`partyDefault`)
  // so the coding alone never makes an otherwise untouched line contentful.
  const appliedParty = useRef<string | null>(null);
  useEffect(() => {
    if (!editable || !lineSide || config.kind === "project_charge") return;
    const partyChanged = appliedParty.current !== partyId;
    if (!partyLine && !partyChanged) return;
    let changed = false;
    const next = rows.map((row) => {
      const previous = row.partyDefault;
      // An item codes its own line: release a party default the line still holds.
      if (row.itemId) {
        if (previous && row.accountId === previous.accountId && row.accountId !== "") {
          changed = true;
          return { ...row, accountId: "", partyDefault: undefined };
        }
        return row;
      }
      if (!partyLine) return row;
      const follows = (value: string, prior: string | undefined) =>
        value === "" || (prior !== undefined && value === prior);
      if (previous === undefined && row.accountId !== "") return row;
      if (previous !== undefined && !partyChanged) return row;
      let accountId = row.accountId;
      let taxProfileId = row.taxProfileId;
      if (follows(row.accountId, previous?.accountId)) accountId = defaultAccount;
      if (config.hasTax && follows(row.taxProfileId, previous?.taxProfileId))
        taxProfileId = defaultTax;
      // A default that placed nothing leaves the line exactly as untouched.
      const given = accountId || taxProfileId ? { accountId, taxProfileId } : undefined;
      if (
        accountId === row.accountId &&
        taxProfileId === row.taxProfileId &&
        given?.accountId === previous?.accountId &&
        given?.taxProfileId === previous?.taxProfileId
      )
        return row;
      changed = true;
      return { ...row, accountId, taxProfileId, partyDefault: given };
    });
    if (partyLine) appliedParty.current = partyId;
    if (changed) setRows(next);
  }, [
    rows,
    partyLine,
    partyId,
    editable,
    lineSide,
    config.kind,
    config.hasTax,
    defaultAccount,
    defaultTax,
    setRows,
  ]);

  const recentToRows = useCallback(
    (source: RecentPartyDocument): LineRow[] => {
      const lines = source.lines.map((line) => ({
        ...emptyLine(),
        accountId: line.accountId && accountIds.has(line.accountId) ? line.accountId : "",
        itemId: line.itemId && itemIds.has(line.itemId) ? line.itemId : "",
        description: line.description ?? "",
        // An item line recalls its quantity and price; an account line recalls
        // its amount only, as the clerk entered it.
        quantity: line.itemId ? (line.quantity ?? "") : "",
        unitPrice: line.itemId ? (line.unitPrice ?? "") : "",
        amount: line.amount ?? "",
        departmentId: line.departmentId ?? "",
        projectId: line.projectId ?? "",
        locationId: line.locationId ?? "",
        classId: line.classId ?? "",
        taxProfileId:
          config.hasTax && line.taxCodeId && taxValues.has(`code:${line.taxCodeId}`)
            ? `code:${line.taxCodeId}`
            : "",
      }));
      return lines.length > 0 ? lines : [emptyLine()];
    },
    [accountIds, itemIds, taxValues, config.hasTax],
  );

  const recallFrom = useCallback(
    (source: RecentPartyDocument, forParty: string) => {
      if (!source.currency || source.currency !== currency) return;
      const undo = { ...latest.current };
      const next = recentToRows(source);
      // Recalled coding belongs to the source lines, never to party defaults.
      appliedParty.current = forParty;
      setRows(next);
      if (!undo.memo && source.memo) setMemo(source.memo);
      setRecall({ key: `${forParty}:${source.id}`, documentNumber: source.documentNumber, undo });
    },
    [recentToRows, setRows, setMemo, currency],
  );
  const applyRecall = useCallback(() => {
    if (recent) recallFrom(recent, partyId);
  }, [recent, partyId, recallFrom]);

  const undoRecall = useCallback(() => {
    if (!recall) return;
    setRows(recall.undo.rows);
    setMemo(recall.undo.memo);
    setRecall(null);
  }, [recall, setRows, setMemo]);

  // "Apply" recalls automatically when the party's answer arrives on a new
  // document whose lines are still empty; "suggest" offers the same as a
  // one-key action.
  const carriedParty = useRef<string | null>(null);
  const autoRecall = isCreate && preferences.recallLastDocument === "apply";
  useEffect(() => {
    if (!partyKey) return;
    let live = true;
    const query = new URLSearchParams({ kind: config.kind, partyId: partyKey, include: "party" });
    fetch(`/api/documents/defaults?${query.toString()}`, {
      headers: { accept: "application/json" },
    })
      .then(async (response) => (response.ok ? response.json() : null))
      .then(
        (
          body: {
            party?: { line?: PartyLineDefault | null; recent?: RecentPartyDocument | null } | null;
          } | null,
        ) => {
          if (!live) return;
          const answer = {
            partyId: partyKey,
            line: body?.party?.line ?? null,
            recent: body?.party?.recent ?? null,
          };
          setPartyAnswer(answer);
          if (
            autoRecall &&
            carriedParty.current !== partyKey &&
            answer.recent &&
            latest.current.rows.every((row) => isBlankDrawerLine(row))
          )
            recallFrom(answer.recent, partyKey);
        },
      )
      // Defaults are a convenience: an unavailable lookup leaves lines blank
      // for the clerk to code, and the save validates them as always.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [config.kind, partyKey, autoRecall, recallFrom]);

  const recallAvailable =
    Boolean(recent?.currency && recent.currency === currency) &&
    editable &&
    preferences.recallLastDocument !== "off" &&
    recall === null;

  // -- live duplicate reference --------------------------------------------
  const referenceKinds = config.kind === "vendor_bill" || config.kind === "vendor_credit";
  const trimmedReference = referenceNumber.trim();
  const duplicateKey =
    editable && referenceKinds && partyId && trimmedReference
      ? `${partyId}|${trimmedReference}`
      : null;
  const [duplicateAnswer, setDuplicateAnswer] = useState<{
    key: string;
    matches: DuplicateMatch[];
  } | null>(null);
  const duplicates =
    duplicateAnswer && duplicateAnswer.key === duplicateKey ? duplicateAnswer.matches : [];
  useEffect(() => {
    if (!duplicateKey) return;
    let live = true;
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({
        kind: config.kind,
        partyId,
        referenceNumber: trimmedReference,
      });
      if (!isCreate && doc.id) query.set("excludeId", String(doc.id));
      fetch(`/api/documents/duplicates?${query.toString()}`, {
        headers: { accept: "application/json" },
      })
        .then(async (response) => (response.ok ? response.json() : null))
        .then((body: { duplicates?: DuplicateMatch[] } | null) => {
          if (live)
            setDuplicateAnswer({
              key: duplicateKey,
              matches: Array.isArray(body?.duplicates)
                ? body.duplicates.filter((match) => match.reason === "reference")
                : [],
            });
        })
        // The save-time check still runs; a failed probe only hides the banner.
        .catch(() => undefined);
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [duplicateKey, partyId, trimmedReference, config.kind, isCreate, doc.id]);

  // -- Save & new carry ---------------------------------------------------
  const carryLoaded = useRef(false);
  useEffect(() => {
    if (carryLoaded.current || !isCreate) return;
    carryLoaded.current = true;
    const carry = takeEntryCarry(config.kind);
    if (!carry) return;
    if (carry.documentDate) setDocumentDate(carry.documentDate);
    if (carry.partyId && (parties ?? []).some((party) => party.id === carry.partyId)) {
      carriedParty.current = carry.partyId;
      changeParty(carry.partyId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const stashCarry = useCallback(() => {
    stashEntryCarry(config.kind, {
      documentDate: preferences.keepDateOnNew ? documentDate : null,
      partyId: preferences.keepPartyOnNew ? partyId : null,
    });
  }, [config.kind, documentDate, partyId, preferences.keepDateOnNew, preferences.keepPartyOnNew]);

  // -- control total ------------------------------------------------------
  const [controlTotal, setControlTotal] = useState("");
  const controlResolved = resolveEnteredAmount(controlTotal);
  // Control total minus the lines' total: zero means the bill is complete.
  const controlDifference = useMemo(() => {
    if (controlResolved.kind !== "amount") return null;
    try {
      return add(controlResolved.value, neg(normalizeMoney(String(effectiveTotals.total ?? "0"))));
    } catch {
      return null;
    }
  }, [controlResolved, effectiveTotals.total]);
  const controlMismatch = controlDifference !== null && cmp(controlDifference, "0") !== 0;

  const partyDefaultLabel = defaultAccount
    ? (() => {
        const account = accounts.find((option) => option.id === defaultAccount);
        return `${account?.number ?? ""} ${account?.name ?? ""}`.trim();
      })()
    : null;
  const partyName = (parties ?? []).find((party) => party.id === partyId)?.display_name ?? "";
  const partyDefaultHint = partyDefaultLabel
    ? partyLine?.accountSource === "party_history"
      ? t("partyDefault.history", {
          account: partyDefaultLabel,
          party: partyName,
          count: partyLine.historyCount ?? 0,
        })
      : t("partyDefault.configured", { account: partyDefaultLabel, party: partyName })
    : null;
  const partyTaxLabel = defaultTax
    ? (taxProfiles.find((profile) => profile.value === defaultTax)?.code ?? "")
    : "";
  const partyTaxHint = partyTaxLabel
    ? partyLine?.taxSource === "party_history"
      ? t("partyDefault.taxHistory", {
          tax: partyTaxLabel,
          party: partyName,
          count: partyLine.taxHistoryCount ?? 0,
        })
      : t("partyDefault.taxConfigured", { tax: partyTaxLabel, party: partyName })
    : null;

  return {
    tEntry: t,
    localDate,
    partyLineDefault: partyLine,
    partyDefaultHint,
    partyTaxHint,
    recentDocument: recent,
    recallAvailable,
    recall,
    applyRecall,
    undoRecall,
    duplicates,
    stashCarry,
    controlTotal,
    setControlTotal,
    controlDifference,
    controlMismatch,
    controlInvalid: controlResolved.kind === "invalid",
  };
}

export type DocumentDrawerEntryScope = DocumentDrawerPickersScope &
  ReturnType<typeof useDocumentDrawerEntry>;
