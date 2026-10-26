"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Input,
  PageHeader,
  Select,
  cn,
} from "@openbooks/ui";
import { abs, cmp } from "@openbooks/engine/money/money";
import type { TaxComponentConfig } from "@openbooks/engine/tax/tax";
import {
  LineGrid,
  type LineGridColumn,
  type LineGridOption,
} from "../../../../../components/line-grid";
import { ListPageLayout } from "../../../../../components/page-layout";
import { useShortcuts } from "../../../../../components/shortcuts/shortcut-provider";
import { useMoney } from "../../../../../components/money-provider";
import { readApiErrorMessage } from "../../../../../lib/api-error";
import { confirmDialog } from "../../../../../lib/confirm";
import { formatEntryDate } from "../../../../../lib/date-entry";
import { currencyMinorUnits } from "../../../../../lib/iso-currencies";
import { displayEnteredAmount } from "../../../../../lib/entry-amount";
import { useUnsavedNavigationGuard } from "../../../../../lib/use-unsaved-navigation-guard";
import {
  BATCH_SAVE_CONCURRENCY,
  applyVendorDefaults,
  batchDraftKey,
  batchEntered,
  batchRowIssues,
  batchRowTotal,
  fetchBatchTaxProfiles,
  type BatchTaxProfiles,
  blankBatchRow,
  clearFinishedRows,
  cloneBatchRow,
  controlVariance,
  fetchVendorDefaults,
  fetchVendorDuplicates,
  hasUnsavedWork,
  inBatchDuplicates,
  inheritBillDates,
  isBlankBatchRow,
  isFinishedBatchRow,
  isLockedBatchRow,
  normalizeVendorReference,
  readBatchDraft,
  runWithConcurrency,
  saveBatchRow,
  writeBatchDraft,
  type BatchBillRow,
  type BatchRowIssue,
  type ServerDuplicate,
  type VendorDefaults,
} from "./batch-bills";

export interface BatchVendorOption {
  id: string;
  display_name: string;
  short_code: string | null;
}

export interface BatchAccountOption {
  id: string;
  number: string | null;
  name: string;
}

export interface BatchTaxProfile {
  /** `code:<id>` or `group:<id>`, the bill drawer's tax choice values. */
  value: string;
  label: string;
  components: TaxComponentConfig[];
}

export interface BatchBillEntryProps {
  orgId: string;
  userId: string;
  today: string;
  minorUnits: number;
  currency: string;
  vendors: BatchVendorOption[];
  accounts: BatchAccountOption[];
  taxProfiles: BatchTaxProfile[];
  /** Multi-subsidiary organizations choose one legal entity per batch. */
  subsidiaries: { id: string; name: string; baseCurrency: string }[] | null;
  defaultSubsidiaryId: string | null;
  canPost: boolean;
  canCreateVendor: boolean;
  helpHref: string;
}

const browserFetch = (input: string, init?: RequestInit) => fetch(input, init);

type DefaultsEntry = VendorDefaults | "failed";
type DuplicatesEntry = ServerDuplicate[] | "failed";

function duplicateKey(row: BatchBillRow): string | null {
  const reference = normalizeVendorReference(row.referenceNumber);
  return row.partyId && reference ? `${row.partyId}|${reference}` : null;
}

/**
 * Batch bill entry: a keyboard-first grid with one vendor bill per row.
 * Every row saves through the bill drawer's own create and lifecycle
 * endpoints, so permissions, validation, numbering, approvals and audit are
 * exactly those of a bill entered one at a time.
 */
export function BatchBillEntry({
  orgId,
  userId,
  today,
  currency,
  vendors,
  accounts,
  taxProfiles,
  subsidiaries,
  defaultSubsidiaryId,
  canPost,
  canCreateVendor,
  helpHref,
}: BatchBillEntryProps) {
  const t = useTranslations("batchEntry");
  const locale = useLocale();
  const { money: formatMoney } = useMoney();
  const storageKey = batchDraftKey(orgId, userId);
  const hasTax = taxProfiles.length > 0;
  const rootRef = useRef<HTMLDivElement>(null);

  const [rows, setRowsState] = useState<BatchBillRow[]>(() => [blankBatchRow(today)]);
  const rowsRef = useRef(rows);
  const commitRows = useCallback((next: BatchBillRow[]) => {
    rowsRef.current = next;
    setRowsState(next);
  }, []);
  const patchRows = useCallback(
    (update: (current: BatchBillRow[]) => BatchBillRow[]) => {
      commitRows(update(rowsRef.current));
    },
    [commitRows],
  );
  const handleRowsChange = useCallback(
    (next: BatchBillRow[]) => {
      commitRows(inheritBillDates(rowsRef.current, next, today));
    },
    [commitRows, today],
  );

  const [controlCount, setControlCount] = useState("");
  const [controlTotal, setControlTotal] = useState("");
  const [subsidiaryId, setSubsidiaryId] = useState(defaultSubsidiaryId ?? "");
  const batchCurrency =
    subsidiaries?.find((entity) => entity.id === subsidiaryId)?.baseCurrency ?? currency;
  const money = useCallback(
    (...args: Parameters<typeof formatMoney>) =>
      formatMoney(args[0], { ...args[1], currency: batchCurrency }),
    [formatMoney, batchCurrency],
  );
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [restoredCount, setRestoredCount] = useState(0);
  const [storageFailed, setStorageFailed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [createdVendors, setCreatedVendors] = useState<BatchVendorOption[]>([]);

  // -- restore and keep the unsaved batch -----------------------------------
  useEffect(() => {
    const draft = readBatchDraft(window.localStorage, storageKey);
    if (draft) {
      // Restoring reads browser storage, which only exists after mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      commitRows(draft.rows.length > 0 ? draft.rows : [blankBatchRow(today)]);
      setControlCount(draft.controlCount);
      setControlTotal(draft.controlTotal);
      if (subsidiaries?.some((option) => option.id === draft.subsidiaryId))
        setSubsidiaryId(draft.subsidiaryId);
      setRestoredCount(
        draft.rows.filter((row) => !isBlankBatchRow(row) && !isFinishedBatchRow(row)).length,
      );
    }
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    const stored = writeBatchDraft(window.localStorage, storageKey, {
      rows,
      controlCount,
      controlTotal,
      subsidiaryId,
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStorageFailed(!stored);
  }, [hydrated, storageKey, rows, controlCount, controlTotal, subsidiaryId]);

  // Start where the clerk types: the first vendor cell.
  useEffect(() => {
    if (!hydrated) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    rootRef.current
      ?.querySelector<HTMLElement>(
        '[data-lg-row="0"][data-lg-col="0"] button, [data-lg-row="0"][data-lg-col="0"] input',
      )
      ?.focus();
  }, [hydrated]);

  const unsaved = hydrated && hasUnsavedWork(rows);
  useUnsavedNavigationGuard(unsaved, t("leave.message"), t("leave.confirm"));

  // -- picker choices ---------------------------------------------------------
  const vendorOptions = useMemo<LineGridOption[]>(() => {
    const known = new Set(vendors.map((vendor) => vendor.id));
    return [...vendors, ...createdVendors.filter((vendor) => !known.has(vendor.id))].map(
      (vendor) => ({
        value: vendor.id,
        label: vendor.display_name,
        hint: vendor.short_code ?? undefined,
        keywords: vendor.short_code ? [vendor.short_code] : undefined,
      }),
    );
  }, [vendors, createdVendors]);
  const accountOptions = useMemo<LineGridOption[]>(
    () =>
      accounts.map((account) => ({
        value: account.id,
        label: `${account.number ?? ""} ${account.name}`.trim(),
        keywords: account.number ? [account.number] : undefined,
      })),
    [accounts],
  );
  const taxOptions = useMemo<LineGridOption[]>(
    () => [
      { value: "", label: t("noTax") },
      ...taxProfiles.map((profile) => ({ value: profile.value, label: profile.label })),
    ],
    [taxProfiles, t],
  );
  const taxByProfile = useMemo(
    () =>
      new Map<string, readonly TaxComponentConfig[]>(
        taxProfiles.map((profile) => [profile.value, profile.components]),
      ),
    [taxProfiles],
  );
  const defaultsContext = useMemo(
    () => ({
      accountIds: new Set(accounts.map((account) => account.id)),
      taxProfileValues: new Set(taxProfiles.map((profile) => profile.value)),
      hasTax,
    }),
    [accounts, taxProfiles, hasTax],
  );
  const labelOf = (options: LineGridOption[], value: string) =>
    options.find((option) => option.value === value)?.label ?? "";

  const createVendor = useCallback(
    async (name: string) => {
      const response = await fetch("/api/parties", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          kind: "company",
          displayName: name,
          roles: { vendor: { enabled: true } },
        }),
      });
      if (!response.ok)
        throw new Error(await readApiErrorMessage(response, t("createVendorFailed")));
      const body = (await response.json().catch(() => null)) as {
        party?: { id?: unknown; display_name?: unknown };
      } | null;
      const id = typeof body?.party?.id === "string" ? body.party.id : null;
      if (!id) throw new Error(t("createVendorFailed"));
      const label = typeof body?.party?.display_name === "string" ? body.party.display_name : name;
      setCreatedVendors((current) => [...current, { id, display_name: label, short_code: null }]);
      return { value: id, label };
    },
    [t],
  );

  // -- vendor defaults: account, tax and terms due date ----------------------
  const [defaultsCache, setDefaultsCache] = useState<ReadonlyMap<string, DefaultsEntry>>(
    () => new Map(),
  );
  const defaultsInFlight = useRef(new Set<string>());
  const defaultsWarned = useRef(false);
  useEffect(() => {
    for (const row of rows) {
      if (!row.partyId || isLockedBatchRow(row)) continue;
      const key = `${row.partyId}|${row.documentDate}`;
      if (defaultsCache.has(key) || defaultsInFlight.current.has(key)) continue;
      defaultsInFlight.current.add(key);
      void fetchVendorDefaults(browserFetch, row.partyId, row.documentDate).then((result) => {
        defaultsInFlight.current.delete(key);
        if (!result && !defaultsWarned.current) {
          defaultsWarned.current = true;
          toast.warning(t("refusals.defaultsFailed"));
        }
        setDefaultsCache((cache) => new Map(cache).set(key, result ?? "failed"));
      });
    }
  }, [rows, defaultsCache, t]);
  useEffect(() => {
    const waiting = (row: BatchBillRow) =>
      row.partyId !== "" &&
      !isLockedBatchRow(row) &&
      row.defaultsFor !== row.partyId &&
      defaultsCache.has(`${row.partyId}|${row.documentDate}`);
    if (!rowsRef.current.some(waiting)) return;
    patchRows((current) =>
      current.map((row) => {
        if (!waiting(row)) return row;
        const entry = defaultsCache.get(`${row.partyId}|${row.documentDate}`)!;
        return entry === "failed"
          ? { ...row, defaultsFor: row.partyId }
          : applyVendorDefaults(row, entry, defaultsContext);
      }),
    );
  }, [rows, defaultsCache, defaultsContext, patchRows]);
  const termsDueDate = useCallback(
    (row: BatchBillRow): string | null => {
      const entry = defaultsCache.get(`${row.partyId}|${row.documentDate}`);
      return entry && entry !== "failed" ? entry.termsDueDate : null;
    },
    [defaultsCache],
  );

  // -- duplicates ---------------------------------------------------------------
  const [duplicatesCache, setDuplicatesCache] = useState<ReadonlyMap<string, DuplicatesEntry>>(
    () => new Map(),
  );
  const duplicatesInFlight = useRef(new Map<string, Promise<DuplicatesEntry>>());
  const duplicatesRef = useRef(duplicatesCache);
  useEffect(() => {
    duplicatesRef.current = duplicatesCache;
  }, [duplicatesCache]);
  /** Check each row's vendor and invoice number against bills on file; resolves
   *  with every answer so a save can decide on fresh results. */
  const checkDuplicates = useCallback(async (targets: readonly BatchBillRow[]) => {
    const answers = new Map<string, DuplicatesEntry>();
    await Promise.all(
      targets.map(async (row) => {
        const key = duplicateKey(row);
        if (key === null || isLockedBatchRow(row)) return;
        const cached = duplicatesRef.current.get(key);
        if (cached !== undefined && cached !== "failed") {
          answers.set(key, cached);
          return;
        }
        let request = duplicatesInFlight.current.get(key);
        if (!request) {
          request = fetchVendorDuplicates(browserFetch, row.partyId, row.referenceNumber).then(
            (result) => {
              duplicatesInFlight.current.delete(key);
              const entry: DuplicatesEntry = result ?? "failed";
              setDuplicatesCache((cache) => new Map(cache).set(key, entry));
              return entry;
            },
          );
          duplicatesInFlight.current.set(key, request);
        }
        answers.set(key, await request);
      }),
    );
    return answers;
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    const timer = setTimeout(() => void checkDuplicates(rowsRef.current), 400);
    return () => clearTimeout(timer);
  }, [rows, hydrated, checkDuplicates]);
  const batchDuplicates = useMemo(() => inBatchDuplicates(rows), [rows]);
  const filedDuplicates = (
    row: BatchBillRow,
    cache: ReadonlyMap<string, DuplicatesEntry> = duplicatesCache,
  ): ServerDuplicate[] => {
    if (isLockedBatchRow(row)) return [];
    const key = duplicateKey(row);
    const entry = key ? cache.get(key) : undefined;
    return Array.isArray(entry) ? entry : [];
  };

  // A backdated bill uses its own effective rates. Missing profiles remain
  // unresolved and refuse saving rather than treating unknown tax as zero.
  const [datedTaxes, setDatedTaxes] = useState<ReadonlyMap<string, BatchTaxProfiles>>(
    () => new Map([[today, taxByProfile]]),
  );
  const missingTaxes = useMemo(() => new Map<string, readonly TaxComponentConfig[]>(), []);
  const rowTaxes = useCallback(
    (row: BatchBillRow) => datedTaxes.get(row.documentDate) ?? missingTaxes,
    [datedTaxes, missingTaxes],
  );
  useEffect(() => {
    const dates = [
      ...new Set(
        rows
          .filter(
            (row) => row.taxProfileId && row.documentDate && !datedTaxes.has(row.documentDate),
          )
          .map((row) => row.documentDate),
      ),
    ];
    if (!dates.length) return;
    let live = true;
    void Promise.all(
      dates.map(async (date) => [date, await fetchBatchTaxProfiles(browserFetch, date)] as const),
    ).then((answers) => {
      if (live && answers.some(([, profiles]) => profiles !== null))
        setDatedTaxes((current) => {
          const next = new Map(current);
          for (const [date, profiles] of answers) if (profiles) next.set(date, profiles);
          return next;
        });
    });
    return () => {
      live = false;
    };
  }, [rows, datedTaxes]);
  const taxComplete = rows.every(
    (row) => isBlankBatchRow(row) || !row.taxProfileId || batchRowTotal(row, rowTaxes) !== null,
  );
  const entered = useMemo(() => batchEntered(rows, rowTaxes), [rows, rowTaxes]);
  const variance = controlVariance({ count: controlCount, total: controlTotal }, entered);

  // -- save and post ------------------------------------------------------------
  const refuse = (message: string) => {
    setRefusal(message);
    toast.error(message);
  };
  const issueText = (issue: BatchRowIssue) => t(`issues.${issue}`);
  const focusRow = (index: number) => {
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLElement>(
          `[data-lg-row="${index}"] button, [data-lg-row="${index}"] input`,
        )
        ?.focus();
    });
  };

  const run = async (post: boolean) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setRefusal(null);
    try {
      // Commit the cell being typed in before reading the rows.
      const active = document.activeElement as HTMLElement | null;
      if (active && rootRef.current?.contains(active)) active.blur();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // A saved draft whose post was refused is a finished draft once the
      // clerk chooses to keep drafts.
      if (!post) {
        patchRows((current) =>
          current.map((row) =>
            row.documentId && row.outcome === "saved" && row.error ? { ...row, error: "" } : row,
          ),
        );
      }
      const current = rowsRef.current;
      const targets = current.filter(
        (row) => !isBlankBatchRow(row) && (!row.documentId || (post && row.outcome === "saved")),
      );
      if (targets.length === 0) {
        toast.info(t("refusals.nothingToSave"));
        return;
      }
      const invalid = targets
        .map((row) => ({ index: current.indexOf(row), issues: batchRowIssues(row) }))
        .filter((entry) => entry.issues.length > 0);
      if (invalid.length > 0) {
        const first = invalid[0]!;
        refuse(
          t("refusals.rowsNeedAttention", {
            count: invalid.length,
            first: t("refusals.rowIssue", {
              row: first.index + 1,
              issue: issueText(first.issues[0]!),
            }),
          }),
        );
        focusRow(first.index);
        return;
      }
      const freshTaxes = new Map(datedTaxes);
      for (const date of new Set(
        current.filter((row) => row.taxProfileId).map((row) => row.documentDate),
      )) {
        const profiles = await fetchBatchTaxProfiles(browserFetch, date);
        if (!profiles) {
          refuse(t("refusals.taxUnresolved"));
          return;
        }
        freshTaxes.set(date, profiles);
      }
      setDatedTaxes(freshTaxes);
      const saveTaxes = (row: BatchBillRow) => freshTaxes.get(row.documentDate) ?? missingTaxes;
      if (current.some((row) => row.taxProfileId && batchRowTotal(row, saveTaxes) === null)) {
        refuse(t("refusals.taxUnresolved"));
        return;
      }
      const enteredNow = batchEntered(current, saveTaxes);
      const check = controlVariance({ count: controlCount, total: controlTotal }, enteredNow);
      if (check.countInvalid || check.totalInvalid) {
        refuse(t("refusals.controlInvalid"));
        return;
      }
      if (check.countDifference !== null && check.countDifference !== 0) {
        refuse(
          t("refusals.controlCount", {
            entered: enteredNow.count,
            control: Number(controlCount.trim()),
          }),
        );
        return;
      }
      if (check.totalDifference !== null && cmp(check.totalDifference, "0") !== 0) {
        refuse(
          t("refusals.controlTotal", {
            entered: money(enteredNow.total),
            difference: money(abs(check.totalDifference)),
            direction: cmp(check.totalDifference, "0") > 0 ? "over" : "under",
          }),
        );
        return;
      }

      const creating = targets.filter((row) => !row.documentId);
      const fresh = await checkDuplicates(creating);
      const inBatch = inBatchDuplicates(current);
      const flagged = creating.filter((row) => {
        const key = duplicateKey(row);
        const filed = key ? fresh.get(key) : undefined;
        return inBatch.has(row.key) || (Array.isArray(filed) && filed.length > 0);
      });
      if (flagged.length > 0) {
        const vendorName = (id: string) => labelOf(vendorOptions, id);
        const confirmed = await confirmDialog({
          title: t("duplicates.title"),
          message: (
            <div className="space-y-2">
              <p>{t("duplicates.message", { count: flagged.length })}</p>
              <ul className="max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5">
                {flagged.map((row) => (
                  <li key={row.key}>
                    {t("duplicates.row", {
                      row: current.indexOf(row) + 1,
                      vendor: vendorName(row.partyId),
                      reference: row.referenceNumber.trim(),
                    })}
                  </li>
                ))}
              </ul>
            </div>
          ),
          confirmLabel: t("duplicates.confirm"),
          tone: "danger",
          defaultAction: "cancel",
        });
        if (!confirmed) return;
      }

      setBusy(new Set(targets.map((row) => row.key)));
      setProgress({ done: 0, total: targets.length });
      const copy = {
        fallback: t("refusals.saveFailed"),
        unavailable: t("refusals.unavailable"),
        conflict: t("refusals.conflict"),
        totalChanged: t("refusals.totalChanged"),
      };
      const results = await runWithConcurrency(
        targets.map((row) => row.key),
        async (key) => {
          // Read the row as it is now: an earlier lane may have patched others.
          const row = rowsRef.current.find((candidate) => candidate.key === key);
          if (!row) return null;
          return saveBatchRow(row, {
            post,
            hasTax,
            expectedTotal: batchRowTotal(row, saveTaxes),
            subsidiaryId: subsidiaryId || defaultSubsidiaryId,
            currency: batchCurrency,
            transport: browserFetch,
            copy,
          });
        },
        {
          concurrency: BATCH_SAVE_CONCURRENCY,
          onSettled: (key, result, done) => {
            if (result)
              patchRows((rowsNow) =>
                rowsNow.map((row) => (row.key === key ? { ...row, ...result } : row)),
              );
            setBusy((keys) => {
              const next = new Set(keys);
              next.delete(key);
              return next;
            });
            setProgress({ done, total: targets.length });
          },
        },
      );
      const settled = results.filter(
        (result): result is NonNullable<typeof result> => result !== null,
      );
      const refused = settled.filter((result) => result.error !== "").length;
      const saved = settled.filter(
        (result) => result.outcome === "saved" && result.error === "",
      ).length;
      const posted = settled.filter((result) => result.outcome === "posted").length;
      const pending = settled.filter((result) => result.outcome === "pending").length;
      if (refused > 0) {
        setRefusal(t("refusals.refusedSummary", { count: refused }));
        toast.warning(t("refusals.refusedSummary", { count: refused }));
      }
      if (post && posted + pending > 0) toast.success(t("summary.posted", { posted, pending }));
      else if (saved > 0) toast.success(t("summary.saved", { count: saved }));
    } finally {
      runningRef.current = false;
      setRunning(false);
      setBusy(new Set());
      setProgress(null);
      // Bills saved by this run are now on file: check the rest again.
      setDuplicatesCache(new Map());
    }
  };

  useShortcuts([
    {
      id: "batchBillsSaveAll",
      label: () => t("shortcuts.saveAll"),
      binding: { modifier: "primary", code: "KeyS" },
      scope: "form",
      allowInEditable: true,
      container: () => rootRef.current,
      enabled: () => !runningRef.current,
      run: () => void run(false),
    },
    ...(canPost
      ? [
          {
            id: "batchBillsPostAll",
            label: () => t("shortcuts.postAll"),
            binding: { modifier: "primary" as const, code: "Enter" },
            scope: "form" as const,
            allowInEditable: true,
            container: () => rootRef.current,
            enabled: () => !runningRef.current,
            run: () => void run(true),
          },
        ]
      : []),
  ]);

  const finishedCount = rows.filter(isFinishedBatchRow).length;
  const clearFinished = () => {
    const next = clearFinishedRows(
      rows,
      { count: controlCount, total: controlTotal },
      rowTaxes,
      today,
    );
    commitRows(next.rows);
    setControlCount(next.control.count);
    setControlTotal(
      next.control.total === controlTotal
        ? controlTotal
        : displayEnteredAmount(next.control.total, currencyMinorUnits(batchCurrency)),
    );
    setRefusal(null);
  };
  const discardRestored = async () => {
    const confirmed = await confirmDialog({
      message: t("restore.discardConfirm"),
      confirmLabel: t("restore.discard"),
      tone: "danger",
      defaultAction: "cancel",
    });
    if (!confirmed) return;
    window.localStorage.removeItem(storageKey);
    commitRows([blankBatchRow(today)]);
    setControlCount("");
    setControlTotal("");
    setRestoredCount(0);
    setRefusal(null);
  };

  // -- columns --------------------------------------------------------------
  const editable = useCallback(
    (row: BatchBillRow) => !isLockedBatchRow(row) && !busy.has(row.key),
    [busy],
  );
  const dateText = useCallback(
    (iso: string) => (iso ? formatEntryDate(iso, locale) : ""),
    [locale],
  );
  const columns = useMemo<LineGridColumn<BatchBillRow>[]>(() => {
    const locked = (render: (row: BatchBillRow) => React.ReactNode) =>
      function LockedCell(row: BatchBillRow) {
        return <span className="truncate text-slate-600 dark:text-slate-300">{render(row)}</span>;
      };
    const cols: LineGridColumn<BatchBillRow>[] = [
      {
        key: "partyId",
        label: t("columns.vendor"),
        width: "minmax(190px,2fr)",
        type: "search-select",
        options: vendorOptions,
        recentKey: "party:vendor",
        required: true,
        ...(canCreateVendor
          ? {
              onCreate: createVendor,
              createLabel: (query: string) => t("createVendor", { name: query }),
            }
          : {}),
        isCellEditable: editable,
        lockedRender: locked((row) => labelOf(vendorOptions, row.partyId)),
      },
      {
        key: "referenceNumber",
        label: t("columns.reference"),
        width: "130px",
        type: "text",
        isCellEditable: editable,
        lockedRender: locked((row) => row.referenceNumber),
      },
      {
        key: "documentDate",
        label: t("columns.billDate"),
        width: "130px",
        type: "date",
        required: true,
        isCellEditable: editable,
        lockedRender: locked((row) => dateText(row.documentDate)),
      },
      {
        key: "dueDate",
        label: t("columns.dueDate"),
        help: t("columns.dueDateHelp"),
        width: "130px",
        type: "date",
        // Blank means "by terms": show the date the terms will give.
        placeholderFor: (row) => {
          const due = !row.dueDate && !isLockedBatchRow(row) ? termsDueDate(row) : null;
          return due ? dateText(due) : undefined;
        },
        isCellEditable: editable,
        lockedRender: locked((row) => dateText(row.dueDate)),
      },
      {
        key: "accountId",
        label: t("columns.account"),
        width: "minmax(190px,2fr)",
        type: "search-select",
        options: accountOptions,
        recentKey: "account:vendor_bill",
        required: true,
        isCellEditable: editable,
        lockedRender: locked((row) => labelOf(accountOptions, row.accountId)),
      },
      {
        key: "memo",
        label: t("columns.memo"),
        width: "minmax(150px,1.5fr)",
        type: "text",
        isCellEditable: editable,
        lockedRender: locked((row) => row.memo),
      },
      {
        key: "amount",
        label: t("columns.amount"),
        width: "120px",
        type: "amount",
        align: "right",
        required: true,
        isCellEditable: editable,
        lockedRender: (row) => (
          <span className="tabular-nums text-slate-600 dark:text-slate-300">
            {money(row.amount)}
          </span>
        ),
      },
    ];
    if (hasTax) {
      cols.push({
        key: "taxProfileId",
        label: t("columns.tax"),
        width: "110px",
        type: "select",
        options: taxOptions,
        isCellEditable: editable,
        lockedRender: locked((row) =>
          row.taxProfileId ? labelOf(taxOptions, row.taxProfileId) : "",
        ),
      });
    }
    cols.push({
      key: "status",
      label: t("columns.status"),
      width: "minmax(200px,1.6fr)",
      type: "readonly",
      render: (row) => (
        <RowStatus
          row={row}
          busy={busy.has(row.key)}
          issues={batchRowIssues(row)}
          inBatch={batchDuplicates.get(row.key) ?? []}
          filed={filedDuplicates(row)}
          termsDue={!row.dueDate && !isLockedBatchRow(row) ? termsDueDate(row) : null}
          dateText={dateText}
        />
      ),
    });
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    t,
    vendorOptions,
    accountOptions,
    taxOptions,
    hasTax,
    canCreateVendor,
    createVendor,
    editable,
    dateText,
    money,
    busy,
    batchDuplicates,
    duplicatesCache,
    defaultsCache,
    termsDueDate,
  ]);

  const controlTone = (matched: boolean) =>
    matched ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400";

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t("title")}
          description={t("description")}
          back={{ href: "/ap/bills", label: t("back") }}
          actions={
            <div className="flex items-center gap-2">
              {finishedCount > 0 ? (
                <Button type="button" variant="outline" onClick={clearFinished} disabled={running}>
                  {t("actions.clearFinished", { count: finishedCount })}
                </Button>
              ) : null}
              <Button
                type="button"
                variant={canPost ? "outline" : "default"}
                onClick={() => void run(false)}
                disabled={running}
              >
                {t("actions.saveAll")}
              </Button>
              {canPost ? (
                <Button type="button" onClick={() => void run(true)} disabled={running}>
                  {t("actions.postAll")}
                </Button>
              ) : null}
            </div>
          }
        />
      }
    >
      <div ref={rootRef} className="space-y-4">
        {restoredCount > 0 ? (
          <Alert variant="info">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <AlertTitle>{t("restore.title")}</AlertTitle>
                <AlertDescription>{t("restore.body", { count: restoredCount })}</AlertDescription>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setRestoredCount(0)}
                >
                  {t("restore.keep")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void discardRestored()}
                >
                  {t("restore.discard")}
                </Button>
              </div>
            </div>
          </Alert>
        ) : null}
        {storageFailed ? (
          <Alert variant="warning">
            <AlertDescription>{t("restore.storageFailed")}</AlertDescription>
          </Alert>
        ) : null}
        {refusal ? (
          <Alert variant="destructive">
            <AlertDescription>{refusal}</AlertDescription>
          </Alert>
        ) : null}

        <section
          aria-label={t("control.heading")}
          className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900"
        >
          {subsidiaries ? (
            <label className="space-y-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              <span>{t("control.subsidiary")}</span>
              <Select
                value={subsidiaryId}
                aria-label={t("control.subsidiary")}
                disabled={rows.some((row) => !isBlankBatchRow(row))}
                title={t("control.entityLocked")}
                onChange={(event) => setSubsidiaryId(event.target.value)}
                className="w-56"
              >
                {subsidiaries.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          <label className="space-y-1 text-xs font-medium text-slate-600 dark:text-slate-300">
            <span>{t("control.count")}</span>
            <Input
              value={controlCount}
              inputMode="numeric"
              onChange={(event) => setControlCount(event.target.value)}
              className="w-32 text-right tabular-nums"
              aria-invalid={variance.countInvalid || undefined}
            />
          </label>
          <label className="space-y-1 text-xs font-medium text-slate-600 dark:text-slate-300">
            <span>{t("control.total")}</span>
            <Input
              value={controlTotal}
              inputMode="decimal"
              onChange={(event) => setControlTotal(event.target.value)}
              className="w-40 text-right tabular-nums"
              aria-invalid={variance.totalInvalid || undefined}
            />
          </label>
          <div className="min-w-0 flex-1 space-y-0.5 text-sm" aria-live="polite">
            <p className="font-medium text-slate-800 tabular-nums dark:text-slate-100">
              {t("control.entered", {
                count: entered.count,
                total: taxComplete ? money(entered.total) : "—",
              })}{" "}
              · {batchCurrency}
            </p>
            <p className="flex flex-wrap gap-x-4 text-xs tabular-nums">
              {variance.countInvalid ? (
                <span className={controlTone(false)}>{t("control.countInvalid")}</span>
              ) : variance.countDifference !== null ? (
                <span className={controlTone(variance.countDifference === 0)}>
                  {variance.countDifference === 0
                    ? t("control.countMatched")
                    : t("control.countOff", { difference: variance.countDifference })}
                </span>
              ) : null}
              {variance.totalInvalid ? (
                <span className={controlTone(false)}>{t("control.totalInvalid")}</span>
              ) : taxComplete && variance.totalDifference !== null ? (
                <span className={controlTone(cmp(variance.totalDifference, "0") === 0)}>
                  {cmp(variance.totalDifference, "0") === 0
                    ? t("control.totalMatched")
                    : t("control.totalOff", {
                        difference: money(variance.totalDifference, { signDisplay: "always" }),
                      })}
                </span>
              ) : null}
            </p>
          </div>
          <div className="space-y-0.5 text-right text-xs text-slate-500 dark:text-slate-400">
            {progress ? (
              <p role="status" className="font-medium text-slate-700 dark:text-slate-200">
                {t("actions.progress", { done: progress.done, total: progress.total })}
              </p>
            ) : null}
            <Link
              href={helpHref}
              target="_blank"
              rel="noopener"
              className="text-teal-700 hover:underline dark:text-teal-300"
            >
              {t("helpLink")}
            </Link>
          </div>
        </section>

        {!taxComplete ? (
          <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
            {t("refusals.taxUnresolved")}
          </p>
        ) : null}
        <LineGrid<BatchBillRow>
          columns={columns}
          rows={rows}
          onRowsChange={handleRowsChange}
          emptyRow={() => blankBatchRow()}
          getRowKey={(row) => row.key}
          cloneRow={cloneBatchRow}
          minorUnits={currencyMinorUnits(batchCurrency)}
          showKeyboardHint={false}
          addLabel={t("actions.addBill")}
          formatAmount={(value) => money(value)}
        />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t(canPost ? "keyboardHintPost" : "keyboardHint")}
        </p>
      </div>
    </ListPageLayout>
  );
}

function RowStatus({
  row,
  busy,
  issues,
  inBatch,
  filed,
  termsDue,
  dateText,
}: {
  row: BatchBillRow;
  busy: boolean;
  issues: BatchRowIssue[];
  inBatch: number[];
  filed: ServerDuplicate[];
  termsDue: string | null;
  dateText: (iso: string) => string;
}) {
  const t = useTranslations("batchEntry");
  if (isBlankBatchRow(row)) return null;
  const duplicateTitle = [
    ...(inBatch.length > 0 ? [t("duplicates.inBatch", { rows: inBatch.join(", ") })] : []),
    ...filed.map((match) =>
      t("duplicates.onFile", {
        number: match.documentNumber ?? "",
        date: match.documentDate ? dateText(match.documentDate) : "",
      }),
    ),
  ].join("\n");
  return (
    <div className="flex min-w-0 flex-col gap-0.5 py-1 text-xs leading-snug">
      {busy ? (
        <span className="text-slate-500 dark:text-slate-400">{t("status.saving")}</span>
      ) : null}
      {row.documentId && !busy ? (
        <Link
          href={`/ap/bills?doc=${row.documentId}`}
          target="_blank"
          rel="noopener"
          className="font-medium text-teal-700 hover:underline dark:text-teal-300"
        >
          {t(`status.${row.outcome || "saved"}`, { number: row.documentNumber })}
        </Link>
      ) : null}
      {row.error && !busy ? (
        <span className="text-red-600 dark:text-red-400">
          {row.error}
          {row.conflict ? (
            <>
              {" "}
              <Link
                href={`/ap/bills?doc=${row.idempotencyKey}`}
                target="_blank"
                rel="noopener"
                className="font-medium underline"
              >
                {t("status.openExisting")}
              </Link>
            </>
          ) : null}
        </span>
      ) : null}
      {!busy && issues.length > 0 ? (
        <span className="text-amber-700 dark:text-amber-400">
          {issues.map((issue) => t(`issues.${issue}`)).join(" · ")}
        </span>
      ) : null}
      {duplicateTitle ? (
        <span className="flex flex-wrap items-center gap-1">
          <Badge variant="warning" title={duplicateTitle}>
            {t("duplicates.badge")}
          </Badge>
          <span className={cn("truncate text-amber-700 dark:text-amber-400")}>
            {duplicateTitle.split("\n")[0]}
          </span>
        </span>
      ) : null}
      {termsDue ? (
        <span className="text-slate-500 dark:text-slate-400">
          {t("status.termsDue", { date: dateText(termsDue) })}
        </span>
      ) : null}
    </div>
  );
}
