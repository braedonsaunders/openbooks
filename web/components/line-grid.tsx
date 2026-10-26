"use client";

/**
 * LineGrid — the transaction line editor used by every document type
 * (vendor bills, invoices, journals, expense reports):
 *
 *  - spreadsheet keyboard model: Enter commits + moves down (appending a row
 *    at the bottom; with the personal "Enter moves to next field" preference
 *    it walks across the line instead), Shift+Enter moves up, ↑/↓ move
 *    between rows, Tab past the last cell of a filled last line starts a new
 *    line, Alt+Enter / Alt+Shift+Enter insert a line below / above,
 *    F8 or ⌘/Ctrl+' copies the field from the line above, Alt+↑/↓ moves the
 *    row, ⌘/Ctrl+D duplicates it, ⌘/Ctrl+Backspace deletes it
 *  - paste a block copied from a spreadsheet: rows and columns land from the
 *    focused cell (or by matching a header row), lists resolve by name or
 *    code, and anything that cannot be matched is flagged on its cell
 *  - amount cells accept arithmetic (200+47.83) and optional auto decimal
 *  - per-row action button and right-click menu: insert above/below, duplicate, remove
 *  - amount cells retain ledger scale; decimal cells preserve commercial
 *    precision while hiding insignificant storage-scale zeroes
 *  - column model is data: text / amount / decimal / select / search-select / readonly
 *    — custom-field columns are just more columns
 *  - controlled component: rows in, rows out; parent owns persistence and
 *    computed values (tax, totals) via readonly columns
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Lock,
  LockOpen,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Split,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  ContextMenu,
  FieldLabel,
  SearchSelect,
  Select,
  cn,
  matchTier,
  useContextMenu,
  type ContextMenuEntry,
  type SearchSelectScanResult,
} from "@openbooks/ui";
import { cmp, normalizeMoney } from "@openbooks/engine/money/money";
import {
  displayLineDecimal,
  invalidLineDecimal,
  normalizeLineDecimal,
} from "../lib/line-grid-decimal";
import type {
  DistributionMenuKey,
  GroupHeaderModel,
  RowDistributionChip,
} from "./allocations/distribution-groups";
import { useShortcuts } from "./shortcuts/shortcut-provider";
import { DateField, useTypedDateResolver } from "./date-field";
import { displayEnteredAmount, parsePastedAmount, resolveEnteredAmount } from "../lib/entry-amount";
import { useEntryPreferences } from "../lib/entry-preferences-context";

export interface LineGridOption {
  value: string;
  label: string;
  /** Searchable codes or aliases (account number, vendor code) not shown in the label. */
  keywords?: readonly string[];
  hint?: string;
}

export interface LineGridColumn<Row extends Record<string, unknown>> {
  key: string;
  /** Optional empty columns may be disclosed with Details; values stay in rows. */
  secondary?: boolean;
  /** A stored default does not disclose optional detail until the operator changes it. */
  secondaryDefaultValue?: string | number | boolean;
  label: string;
  /** Optional explanation shown from the column heading. */
  help?: React.ReactNode;
  /** CSS grid track, e.g. 'minmax(180px,2fr)' or '110px'. */
  width: string;
  type: "text" | "date" | "amount" | "decimal" | "select" | "search-select" | "readonly" | "tax";
  /** Maximum exact scale for non-money decimal cells such as quantity/rate. */
  decimalScale?: number;
  align?: "left" | "right";
  options?: LineGridOption[];
  /** Optional exact item/bin scan resolver; absent while Barcode scanning is off. */
  scanResolver?: (value: string, row: Row, index: number) => Promise<SearchSelectScanResult>;
  /** Additional line fields supplied by a successful scan, such as an identifier unit. */
  onScanResolved?: (
    row: Row,
    index: number,
    result: Extract<SearchSelectScanResult, { ok: true }>,
  ) => Partial<Row> | void;
  /**
   * Per-row choices for `select` / `search-select` columns whose valid values
   * depend on the line (the bins that hold a line's item). When present it
   * replaces `options` for that row, in both the control and the read-only
   * label lookup.
   */
  optionsFor?: (row: Row, index: number) => LineGridOption[];
  placeholder?: string;
  /** A row-specific placeholder (a due date the terms would derive), falling back to `placeholder`. */
  placeholderFor?: (row: Row, index: number) => string | undefined;
  /** `search-select`: remember choices under this key and list them first. */
  recentKey?: string;
  /** `search-select`: inline creation from the typed text (see SearchSelect `onCreate`). */
  onCreate?: (query: string) => Promise<{ value: string; label: string } | null>;
  createLabel?: (query: string) => string;
  required?: boolean;
  /**
   * Per-row edit gate for editable cells (line warehouse pickers): when
   * present and false for a row, the cell renders empty instead of a
   * control, so a picker never appears on a line it does not apply to
   * (e.g. a non-stocked item). The empty cell keeps its grid position, so
   * every declared column still renders a cell on every row. Read-only
   * grids and readonly columns are unaffected. Defaults to editable.
   */
  isCellEditable?: (row: Row, index: number) => boolean;
  /**
   * What a cell shows on a row whose `isCellEditable` is false, when the
   * value is still meaningful there but derived rather than typed (an
   * expense line's converted amount). Without it the cell stays empty.
   */
  lockedRender?: (row: Row, index: number) => React.ReactNode;
  /** Renderer for readonly columns (computed cells, e.g. line tax). */
  render?: (row: Row, index: number) => React.ReactNode;
  /**
   * For `type: 'tax'` columns: the tax the engine computes from the code's
   * rate. When the user edits the cell to anything other than this value, the
   * line is flagged overridden; a reset affordance clears the override and
   * falls back to this computed value.
   */
  computeTax?: (row: Row) => string;
  /**
   * For `type: 'tax'` columns: apply a manual override to a line — set the
   * explicit tax amount and the overridden flag. `overridden: false` clears the
   * override (reset to computed).
   */
  onTaxChange?: (index: number, next: { taxAmount: string; overridden: boolean }) => void;
}

function invalidAmount(value: unknown): boolean {
  if (value === "" || value == null) return false;
  try {
    normalizeMoney(String(value));
    return false;
  } catch {
    return true;
  }
}

/**
 * What a tax cell shows for a computed or stored value. A non-decimal value
 * is a leaked lookup error code, never an amount: an em dash, never the code
 * (and never a crash in the zero comparison). Empty (an untaxed line) and
 * every real amount pass through unchanged.
 */
function taxDisplayValue(value: string): string {
  if (value === "") return "";
  return invalidAmount(value) ? "—" : value;
}

/**
 * The settled (non-draft) tax cell content: the display value with exact-zero
 * suppressed to blank, exactly as before, through an optional formatter.
 */
function settledTaxDisplay<T = string>(
  computed: string,
  format?: (value: string) => T,
): T | string {
  const shown = taxDisplayValue(computed);
  if (shown === "" || shown === "—") return shown;
  return cmp(shown, "0") !== 0 ? (format?.(shown) ?? shown) : "";
}

/**
 * A cell edit folded back into its row. Cells publish theirs while a draft is
 * uncommitted so a reorder/remove/duplicate can carry the typed value along
 * with its row instead of leaving it behind at the old position.
 */
export type LineGridDraftApplier<Row extends Record<string, unknown>> = (row: Row) => Row;

function applyRowFields<Row extends Record<string, unknown>>(
  row: Row,
  fields: Record<string, unknown>,
): Row {
  return Object.assign({}, row, fields);
}

/**
 * A date cell. Typed text settles on blur or Enter like every date field;
 * until then it is published as a draft, so a reorder or delete applies the
 * date the operator typed to this line (by identity) before rows move.
 */
function DateCell<Row extends Record<string, unknown>>({
  value,
  placeholder,
  onChange,
  rowKey,
  colKey,
  registerDraft,
  ariaLabelledBy,
}: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  rowKey: string;
  colKey: string;
  registerDraft: (rowKey: string, colKey: string, apply: LineGridDraftApplier<Row> | null) => void;
  ariaLabelledBy: string;
}) {
  const resolveTypedDate = useTypedDateResolver();
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    if (pending === null) {
      registerDraft(rowKey, colKey, null);
      return;
    }
    const date = resolveTypedDate(pending);
    registerDraft(rowKey, colKey, (row) => applyRowFields(row, { [colKey]: date }));
    return () => {
      registerDraft(rowKey, colKey, null);
    };
  }, [pending, rowKey, colKey, registerDraft, resolveTypedDate]);
  return (
    <DateField
      appearance="cell"
      aria-labelledby={ariaLabelledBy}
      value={value}
      placeholder={placeholder}
      onPendingTextChange={setPending}
      onChange={onChange}
    />
  );
}

/**
 * A money cell. Shows the stored amount at the currency's precision, takes
 * arithmetic and (optionally) auto-decimal entry, and publishes the resolved
 * amount while typing so totals follow along. Text that is not an amount is
 * kept verbatim and flagged, so the save refuses it instead of booking a
 * different figure.
 */
function AmountCell<Row extends Record<string, unknown>>({
  value,
  placeholder,
  inputBase,
  onChange,
  rowKey,
  colKey,
  registerDraft,
  ariaLabelledBy,
  autoDecimal,
  minorUnits,
  flagged,
}: {
  value: unknown;
  placeholder?: string;
  inputBase: string;
  onChange: (value: string) => void;
  rowKey: string;
  colKey: string;
  registerDraft: (rowKey: string, colKey: string, apply: LineGridDraftApplier<Row> | null) => void;
  ariaLabelledBy: string;
  autoDecimal: boolean;
  minorUnits: number;
  flagged?: string;
}) {
  const t = useTranslations("ui.lineGrid");
  const [draft, setDraft] = useState<string | null>(null);
  const resolve = useCallback(
    (text: string) => {
      const resolved = resolveEnteredAmount(text, { autoDecimal, minorUnits });
      return resolved.kind === "amount" ? resolved.value : resolved.kind === "empty" ? "" : text;
    },
    [autoDecimal, minorUnits],
  );
  const shown =
    draft ?? (invalidAmount(value) ? String(value ?? "") : displayEnteredAmount(value, minorUnits));
  const preview = draft !== null ? resolveEnteredAmount(draft, { autoDecimal, minorUnits }) : null;
  const invalid = preview ? preview.kind === "invalid" : invalidAmount(value);

  useEffect(() => {
    if (draft === null) {
      registerDraft(rowKey, colKey, null);
      return;
    }
    const committed = resolve(draft);
    registerDraft(rowKey, colKey, (row) => applyRowFields(row, { [colKey]: committed }));
    return () => {
      registerDraft(rowKey, colKey, null);
    };
  }, [draft, rowKey, colKey, registerDraft, resolve]);

  return (
    <div className="relative w-full">
      <input
        inputMode="decimal"
        aria-labelledby={ariaLabelledBy}
        value={shown}
        placeholder={placeholder ?? "0.00"}
        aria-invalid={invalid || Boolean(flagged) || undefined}
        title={flagged ? t("paste.unmatchedCell", { value: flagged }) : undefined}
        onFocus={(event) => {
          setDraft(event.currentTarget.value);
          // Typing replaces the amount rather than appending to it.
          event.currentTarget.select();
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange(resolve(event.target.value));
        }}
        onBlur={(event) => {
          setDraft(null);
          onChange(resolve(event.target.value));
        }}
        className={cn(
          inputBase,
          "text-right tabular-nums",
          (invalid || flagged) &&
            "text-red-600 ring-1 ring-red-400/70 focus:ring-red-500/60 dark:text-red-400",
        )}
      />
      {preview?.kind === "amount" && preview.computed ? (
        <span className="pointer-events-none absolute -bottom-3.5 right-1 rounded bg-slate-800 px-1 text-[10px] leading-4 text-white tabular-nums shadow dark:bg-slate-200 dark:text-slate-900">
          = {displayEnteredAmount(preview.value, minorUnits)}
        </span>
      ) : null}
    </div>
  );
}

function DecimalCell<Row extends Record<string, unknown>>({
  value,
  scale,
  inputBase,
  onChange,
  rowKey,
  colKey,
  registerDraft,
  ariaLabelledBy,
}: {
  value: unknown;
  scale: number;
  inputBase: string;
  onChange: (value: string) => void;
  rowKey: string;
  colKey: string;
  registerDraft: (rowKey: string, colKey: string, apply: LineGridDraftApplier<Row> | null) => void;
  ariaLabelledBy: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? displayLineDecimal(value, scale);
  const invalid = invalidLineDecimal(shown, scale);

  // While a draft is uncommitted the grid may reorder the rows underneath
  // this input (Alt+↑/↓, delete). The applier carries the normalized commit
  // value so the structural edit applies it to this row first — a late blur
  // then re-commits the same value to the same row by identity (idempotent),
  // never to whichever row now occupies the old position.
  useEffect(() => {
    if (draft === null) {
      registerDraft(rowKey, colKey, null);
      return;
    }
    const snapshot = draft;
    const normalized = normalizeLineDecimal(snapshot, scale) ?? snapshot;
    registerDraft(rowKey, colKey, (row) => applyRowFields(row, { [colKey]: normalized }));
    return () => {
      registerDraft(rowKey, colKey, null);
    };
  }, [draft, rowKey, colKey, scale, registerDraft]);

  return (
    <input
      inputMode="decimal"
      value={shown}
      placeholder="0"
      aria-invalid={invalid || undefined}
      aria-labelledby={ariaLabelledBy}
      onFocus={() => setDraft(displayLineDecimal(value, scale))}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(event.target.value);
      }}
      onBlur={(event) => {
        const normalized = normalizeLineDecimal(event.target.value, scale);
        setDraft(null);
        onChange(normalized ?? event.target.value);
      }}
      className={cn(
        inputBase,
        "text-right tabular-nums",
        invalid && "text-red-600 focus:ring-red-500/60 dark:text-red-400",
      )}
    />
  );
}

/**
 * Entry-mode distribution affordances for one grid. The grid owns
 * pixels only: group headers, the per-row distribution cell (applied-rule /
 * staged / suggest / Split…), and the Split… ContextMenu. The owning drawer
 * supplies the data closures, which it builds on
 * `./allocations/distribution-groups`. Absent (or read-only) means today's
 * grid exactly — children stay real lines and the read-only view is
 * untouched.
 */
export interface LineGridDistribution<Row extends Record<string, unknown>> {
  /** Synthetic group headers in grid order (firstIndex points at rows). */
  groups: GroupHeaderModel[];
  /** Row indexes whose cells indent under a group header. */
  groupedIndexes: Set<number>;
  chipOf: (row: Row, index: number) => RowDistributionChip | null;
  menuKeysOf: (row: Row, index: number) => DistributionMenuKey[];
  /** Group key for a grouped row (null for standalone rows). */
  groupKeyOf: (row: Row, index: number) => string | null;
  onSplit: (index: number) => void;
  onUnsplit: (groupKey: string) => void;
  onToggleLock: (groupKey: string) => void;
  onApplySuggestion: (index: number) => void;
  onEditGroupTotal: (groupKey: string, total: string) => void;
}

export function LineGrid<Row extends Record<string, unknown>>({
  columns: allColumns,
  rows,
  onRowsChange,
  emptyRow,
  readOnly = false,
  minRows = 1,
  footer,
  addLabel,
  addPlacement = "bottom",
  formatAmount,
  distribution,
  getRowKey,
  selection,
  cloneRow,
  fixedRows = false,
  hideRemove = false,
  minorUnits = 2,
  showKeyboardHint = true,
}: {
  columns: LineGridColumn<Row>[];
  rows: Row[];
  onRowsChange: (rows: Row[]) => void;
  emptyRow: () => Row;
  readOnly?: boolean;
  minRows?: number;
  footer?: React.ReactNode;
  addLabel?: string;
  /** Put the primary add action before long configuration grids. */
  addPlacement?: "top" | "bottom";
  /**
   * Currency-aware read-only presentation supplied by the owning transaction.
   * Editable cells intentionally retain the exact ledger string.
   */
  formatAmount?: (value: string) => React.ReactNode;
  distribution?: LineGridDistribution<Row>;
  /**
   * Stable per-row identity used for React keys and for addressing cell
   * commits. It must survive reorder/duplicate/remove: a server line id, or
   * a client id minted when the row is created (which the save payload must
   * NOT send unless it is the server's own line id). Without it rows are
   * keyed by position and a reorder can only carry committed values — the
   * draft flush below still protects every caller, but focus follows the
   * position rather than the row.
   */
  getRowKey?: (row: Row, index: number) => string;
  /**
   * Opt-in row selection (variant grids, bulk edits). Renders a leading
   * checkbox column bound to the same identities as `getRowKey`; callers own
   * the set. Absent for every transaction line grid today.
   */
  selection?: {
    selected: ReadonlySet<string>;
    onChange: (next: ReadonlySet<string>) => void;
  };
  /**
   * The caller owns the row set (a generated preview): cells stay editable
   * and selection stays available, but no row may be added, duplicated or
   * removed — skipping happens through the selection, never by deleting.
   */
  fixedRows?: boolean;
  /** Hide row removal when the owning workflow cannot persist deleted rows. */
  hideRemove?: boolean;
  /**
   * Clone a row for duplicate. The default shallow copy preserves a
   * caller-supplied identity field, so callers that pass `getRowKey` must
   * also mint a fresh identity here.
   */
  cloneRow?: (row: Row) => Row;
  /** Decimal places of the document currency, for amount display and auto decimal. */
  minorUnits?: number;
  /** Hide the key summary under the grid when the host page shows its own. */
  showKeyboardHint?: boolean;
}) {
  const t = useTranslations("ui.lineGrid");
  const { preferences } = useEntryPreferences();
  const resolveTypedDate = useTypedDateResolver();
  // Pasted values that matched no choice or did not read as a number, by
  // row identity then column. A flagged cell shows what was pasted until the
  // operator edits it.
  const [flags, setFlags] = useState<Map<string, Map<string, string>>>(() => new Map());
  const tShortcuts = useTranslations("shell.shortcuts.commands");
  const tEntry = useTranslations("allocations");
  const tCommon = useTranslations("common");
  const [showDetails, setShowDetails] = useState(false);
  const columns = allColumns.filter(
    (column) =>
      !column.secondary ||
      column.required ||
      readOnly ||
      showDetails ||
      rows.some(
        (row) =>
          row[column.key] != null &&
          row[column.key] !== "" &&
          row[column.key] !== column.secondaryDefaultValue,
      ),
  );
  const headerIdPrefix = useId();
  const headerIds = columns.map((_column, index) => `${headerIdPrefix}-column-${index}`);
  const rowLabelPrefix = `${headerIdPrefix}-row`;
  const containerRef = useRef<HTMLDivElement>(null);
  const rowMenu = useContextMenu();
  const [menuRowKey, setMenuRowKey] = useState<string | null>(null);

  // The distribution column and group headers are edit-mode UX only: the
  // read-only document view and the PDF data shape stay exactly as today.
  const showDist = distribution !== undefined && !readOnly;

  const selectColumn = selection ? "36px " : "";
  const template = readOnly
    ? `${selectColumn}${columns.map((c) => c.width).join(" ")}`
    : `${selectColumn}52px ${columns.map((c) => c.width).join(" ")}${showDist ? " 150px" : ""}`;

  const clone: (row: Row) => Row = cloneRow ?? ((row: Row): Row => ({ ...row }));
  const resolveKey = useCallback(
    (row: Row, index: number) => getRowKey?.(row, index) ?? String(index),
    [getRowKey],
  );
  // The latest committed rows, for commit handlers that fire after the rows
  // have moved (a blur landing after a reorder): commits resolve the row by
  // identity against this ref, never by a stale render-time position. All
  // readers run in event handlers, which always fire after effects flush.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const rowKeys = rows.map((row, i) => resolveKey(row, i));
  const menuIndex = menuRowKey === null ? -1 : rowKeys.indexOf(menuRowKey);

  /**
   * Uncommitted cell drafts by row identity, then column. A reorder or
   * delete moves focus (which fires the cell's blur commit), but the blur
   * may land after the rows have already moved — so every structural edit
   * first folds the published drafts into the array it operates on. Either
   * order is then correct: an early blur commits to the pre-move position,
   * a late blur re-commits the same value to the same row by identity.
   */
  const pendingDrafts = useRef(new Map<string, Map<string, LineGridDraftApplier<Row>>>());
  const registerDraft = useCallback(
    (rowKey: string, colKey: string, apply: LineGridDraftApplier<Row> | null) => {
      const byRow = pendingDrafts.current;
      if (apply === null) {
        const cols = byRow.get(rowKey);
        if (cols) {
          cols.delete(colKey);
          if (cols.size === 0) byRow.delete(rowKey);
        }
        return;
      }
      let cols = byRow.get(rowKey);
      if (!cols) {
        cols = new Map();
        byRow.set(rowKey, cols);
      }
      cols.set(colKey, apply);
    },
    [],
  );

  const clearFlag = useCallback((rowKey: string, key: string) => {
    setFlags((current) => {
      if (!current.get(rowKey)?.has(key)) return current;
      const next = new Map(current);
      const cols = new Map(next.get(rowKey));
      cols.delete(key);
      if (cols.size === 0) next.delete(rowKey);
      else next.set(rowKey, cols);
      return next;
    });
  }, []);
  const commitCell = useCallback(
    (rowKey: string, key: string, value: unknown) => {
      const current = rowsRef.current;
      const index = current.findIndex((row, i) => resolveKey(row, i) === rowKey);
      if (index === -1) return;
      clearFlag(rowKey, key);
      onRowsChange(current.map((r, j) => (j === index ? applyRowFields(r, { [key]: value }) : r)));
    },
    [resolveKey, onRowsChange, clearFlag],
  );
  const commitRowPatch = useCallback(
    (rowKey: string, patch: Partial<Row>) => {
      const current = rowsRef.current;
      const index = current.findIndex((row, i) => resolveKey(row, i) === rowKey);
      if (index === -1) return;
      onRowsChange(
        current.map((row, i) =>
          i === index ? applyRowFields(row, patch as Record<string, unknown>) : row,
        ),
      );
    },
    [resolveKey, onRowsChange],
  );

  const commitTax = useCallback(
    (
      rowKey: string,
      column: LineGridColumn<Row>,
      next: { taxAmount: string; overridden: boolean },
    ) => {
      const current = rowsRef.current;
      const index = current.findIndex((row, i) => resolveKey(row, i) === rowKey);
      if (index === -1) return;
      column.onTaxChange?.(index, next);
    },
    [resolveKey],
  );

  /**
   * The rows with every published draft folded in, in current order. Blurs
   * the grid's focused cell first so its commit lands pre-move; the fold
   * covers a blur that lands late. Clears the registry: the folded values
   * ride in the returned array, and a late blur re-commits them idempotently
   * through the identity path above.
   */
  const takeCommittedRows = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active && containerRef.current?.contains(active) && typeof active.blur === "function") {
      active.blur();
    }
    const base = rowsRef.current;
    if (pendingDrafts.current.size === 0) return base;
    const drafts = pendingDrafts.current;
    pendingDrafts.current = new Map();
    const liveKeys = new Set(base.map((row, i) => resolveKey(row, i)));
    for (const key of [...drafts.keys()]) {
      if (!liveKeys.has(key)) drafts.delete(key);
    }
    if (drafts.size === 0) return base;
    return base.map((row, i) => {
      const cols = drafts.get(resolveKey(row, i));
      if (!cols) return row;
      let next = row;
      for (const apply of cols.values()) next = apply(next);
      return next;
    });
  }, [resolveKey]);

  const insertRow = (at: number) => {
    const base = takeCommittedRows();
    const next = [...base];
    next.splice(at, 0, emptyRow());
    onRowsChange(next);
    focusCell(at, 0);
  };

  // Ctrl+Alt+G (⌃⌥G) appends a line from anywhere in the grid's form. With
  // several grids in one drawer, the grid holding focus takes it.
  const rootRef = useRef<HTMLDivElement>(null);
  useShortcuts([
    {
      id: "formAddLine",
      label: () => tShortcuts("addLine"),
      binding: { modifier: "chord", code: "KeyG" },
      scope: "form",
      allowInEditable: true,
      enabled: () => !readOnly && !fixedRows,
      container: () => {
        const root = rootRef.current;
        if (!root) return null;
        return root.contains(document.activeElement)
          ? root
          : (root.closest('[role="dialog"]') ?? root);
      },
      run: () => insertRow(rowsRef.current.length),
    },
  ]);
  const duplicateRow = (i: number) => {
    const base = takeCommittedRows();
    if (i < 0 || i >= base.length) return;
    const next = [...base];
    next.splice(i + 1, 0, clone(base[i]!));
    onRowsChange(next);
    focusCell(i + 1, 0);
  };
  const removeRow = (i: number) => {
    const base = takeCommittedRows();
    if (i < 0 || i >= base.length) return;
    if (base.length <= minRows) {
      onRowsChange(base.map((r, j) => (j === i ? emptyRow() : r)));
      return;
    }
    const removedKey = resolveKey(base[i]!, i);
    pendingDrafts.current.delete(removedKey);
    onRowsChange(base.filter((_, j) => j !== i));
  };
  const moveRow = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= rowsRef.current.length) return;
    const base = takeCommittedRows();
    const next = [...base];
    const [row] = next.splice(i, 1);
    next.splice(j, 0, row!);
    onRowsChange(next);
    focusCell(j, focusedCol.current);
  };

  const focusedCol = useRef(0);
  const cellControl = (row: number, col: number) =>
    containerRef.current?.querySelector<HTMLElement>(
      `[data-lg-row="${row}"][data-lg-col="${col}"] input, [data-lg-row="${row}"][data-lg-col="${col}"] button, [data-lg-row="${row}"][data-lg-col="${col}"] select`,
    ) ?? null;
  function focusCell(row: number, col: number) {
    requestAnimationFrame(() => {
      const el = cellControl(row, col);
      el?.focus();
      if (el instanceof HTMLInputElement) el.select();
    });
  }
  /** The first (or last) column of a row that has a control to focus. */
  function edgeEditableColumn(row: number, from: "start" | "end"): number {
    const order = columns.map((_c, index) => index);
    if (from === "end") order.reverse();
    return order.find((index) => cellControl(row, index) !== null) ?? 0;
  }
  function nextEditableColumn(row: number, col: number): number | null {
    for (let index = col + 1; index < columns.length; index += 1)
      if (cellControl(row, index)) return index;
    return null;
  }
  /** Whether a line holds anything the operator typed or chose. */
  function rowHasContent(row: Row | undefined): boolean {
    if (!row) return false;
    return columns.some((column) => {
      if (column.type === "readonly" || column.type === "tax") return false;
      const value = row[column.key];
      if (value == null || value === "" || value === column.secondaryDefaultValue) return false;
      if (column.type === "amount" || column.type === "decimal") {
        try {
          return cmp(normalizeMoney(String(value)), "0") !== 0;
        } catch {
          return true;
        }
      }
      return true;
    });
  }
  /** Move to the next line's first field, starting one when this is the last line. */
  function advanceToNextLine(i: number) {
    if (i === rowsRef.current.length - 1) {
      if (fixedRows) return;
      onRowsChange([...takeCommittedRows(), emptyRow()]);
      requestAnimationFrame(() => focusCell(i + 1, edgeEditableColumn(i + 1, "start")));
      return;
    }
    focusCell(i + 1, edgeEditableColumn(i + 1, "start"));
  }
  function copyFromAbove(i: number, colIndex: number) {
    const column = columns[colIndex];
    const base = takeCommittedRows();
    const above = base[i - 1];
    const row = base[i];
    if (!column || !above || !row || column.type === "readonly") return;
    if (column.type === "tax") {
      column.onTaxChange?.(i, {
        taxAmount: String(above.taxAmount ?? ""),
        overridden: above.taxOverridden === true,
      });
      return;
    }
    onRowsChange(
      base.map((current, index) =>
        index === i ? applyRowFields(current, { [column.key]: above[column.key] ?? "" }) : current,
      ),
    );
    focusCell(i, colIndex);
  }

  function handleKeyDown(e: React.KeyboardEvent, i: number, colIndex: number) {
    focusedCol.current = colIndex;
    const mod = e.metaKey || e.ctrlKey;
    const target = e.target as HTMLElement;
    // A key an open list consumed never reaches here; this guards the rest.
    if (target.getAttribute("aria-expanded") === "true") return;
    if (e.key === "Enter" && e.altKey && !mod) {
      e.preventDefault();
      if (!fixedRows) insertRow(e.shiftKey ? i : i + 1);
      return;
    }
    if (e.key === "Enter" && !mod) {
      e.preventDefault();
      if (e.shiftKey) {
        if (i > 0) focusCell(i - 1, colIndex);
        return;
      }
      if (preferences.enterMovesToNextField) {
        const next = nextEditableColumn(i, colIndex);
        if (next !== null) focusCell(i, next);
        else advanceToNextLine(i);
        return;
      }
      if (i === rowsRef.current.length - 1) {
        if (fixedRows) return;
        onRowsChange([...takeCommittedRows(), emptyRow()]);
      }
      focusCell(i + 1, colIndex);
      return;
    }
    if (!e.altKey && !mod && !e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const to = e.key === "ArrowDown" ? i + 1 : i - 1;
      if (to < 0 || to >= rowsRef.current.length) return;
      e.preventDefault();
      focusCell(to, colIndex);
      return;
    }
    if (e.key === "Tab" && !e.shiftKey && !mod && !e.altKey) {
      // Tab past the last cell of a filled last line starts the next line
      // (spreadsheet entry); from an empty last line Tab leaves the grid.
      if (
        i === rowsRef.current.length - 1 &&
        colIndex >= edgeEditableColumn(i, "end") &&
        !fixedRows &&
        rowHasContent(rowsRef.current[i])
      ) {
        e.preventDefault();
        advanceToNextLine(i);
      }
      return;
    }
    if (e.key === "F8" || (mod && e.key === "'")) {
      e.preventDefault();
      copyFromAbove(i, colIndex);
      return;
    }
    if (e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      moveRow(i, -1);
      return;
    }
    if (e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      moveRow(i, 1);
      return;
    }
    if (mod && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      duplicateRow(i);
      return;
    }
    if (mod && e.key === "Backspace" && !hideRemove) {
      e.preventDefault();
      removeRow(i);
      focusCell(Math.max(0, i - 1), colIndex);
    }
  }

  // -- spreadsheet paste ----------------------------------------------------
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  function resolveChoice(
    column: LineGridColumn<Row>,
    row: Row,
    index: number,
    text: string,
  ): string | null {
    const choices = column.optionsFor?.(row, index) ?? column.options ?? [];
    const wanted = text.trim();
    if (!wanted) return "";
    const exact = choices.find(
      (option) =>
        option.value === wanted || option.label.trim().toLowerCase() === wanted.toLowerCase(),
    );
    if (exact) return exact.value;
    // The strongest unique match: an exact code, a label or code prefix.
    let best: { tier: number; values: string[] } = { tier: Number.POSITIVE_INFINITY, values: [] };
    for (const option of choices) {
      const tier = matchTier(option, wanted);
      if (tier === null || tier > 2) continue;
      if (tier < best.tier) best = { tier, values: [option.value] };
      else if (tier === best.tier) best.values.push(option.value);
    }
    return best.values.length === 1 ? best.values[0]! : null;
  }
  function pastedCellValue(
    column: LineGridColumn<Row>,
    row: Row,
    index: number,
    text: string,
  ): { ok: true; value: unknown } | { ok: false } {
    const raw = text.trim();
    switch (column.type) {
      case "amount": {
        if (raw === "") return { ok: true, value: "" };
        const amount = parsePastedAmount(raw);
        return amount === null ? { ok: false } : { ok: true, value: amount };
      }
      case "decimal": {
        if (raw === "") return { ok: true, value: "" };
        const normalized = normalizeLineDecimal(raw, column.decimalScale ?? 8);
        return normalized === null ? { ok: false } : { ok: true, value: normalized };
      }
      case "date": {
        if (raw === "") return { ok: true, value: "" };
        const iso = resolveTypedDate(raw);
        return iso ? { ok: true, value: iso } : { ok: false };
      }
      case "select":
      case "search-select": {
        const value = resolveChoice(column, row, index, raw);
        return value === null ? { ok: false } : { ok: true, value };
      }
      case "text":
        return { ok: true, value: text };
      default:
        return { ok: false };
    }
  }
  function handlePaste(event: React.ClipboardEvent) {
    if (readOnly) return;
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-lg-row][data-lg-col]");
    if (!cell) return;
    const text = event.clipboardData.getData("text/plain");
    const startRow = Number(cell.dataset.lgRow);
    const startCol = Number(cell.dataset.lgCol);
    const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
    const isBlock = lines.length > 1 || lines[0]!.includes("\t");
    const target = event.target as HTMLElement;
    // A single value into a text box pastes natively; into a list it resolves.
    if (!isBlock && target.tagName === "INPUT" && columns[startCol]?.type !== "amount") return;
    event.preventDefault();
    const grid = lines.map((line) => line.split("\t"));
    const pastable = columns
      .map((column, index) => ({ column, index }))
      .filter(({ column }) => column.type !== "readonly" && column.type !== "tax");
    // A header row naming the grid's columns maps by name, in any order.
    const header = grid[0]!.map((value) => value.trim().toLowerCase());
    const byHeader = header.map(
      (name) =>
        pastable.find(
          ({ column }) =>
            column.label.trim().toLowerCase() === name || column.key.toLowerCase() === name,
        )?.index ?? -1,
    );
    const headerMatches = byHeader.filter((index) => index !== -1).length;
    const useHeader =
      grid.length > 1 && headerMatches >= Math.min(2, header.length) && headerMatches > 0;
    const body = useHeader ? grid.slice(1) : grid;
    if (body.length > 500) {
      setPasteNotice(t("paste.tooManyRows", { count: 500 }));
      return;
    }
    const firstPastable = pastable.findIndex(({ index }) => index >= startCol);
    const mapping = useHeader
      ? byHeader
      : grid[0]!.length === columns.length - startCol
        ? grid[0]!.map((_value, offset) => startCol + offset)
        : grid[0]!.map(
            (_value, offset) =>
              pastable[(firstPastable === -1 ? pastable.length : firstPastable) + offset]?.index ??
              -1,
          );
    const next = [...takeCommittedRows()];
    const nextFlags = new Map(flags);
    let unmatched = 0;
    body.forEach((cells, offset) => {
      const rowIndex = startRow + offset;
      if (rowIndex >= next.length) {
        if (fixedRows) {
          unmatched += cells.filter((raw) => raw.trim() !== "").length;
          return;
        }
        next.push(emptyRow());
      }
      let row = next[rowIndex]!;
      const rowKey = resolveKey(row, rowIndex);
      cells.forEach((raw, cellOffset) => {
        const colIndex = mapping[cellOffset] ?? -1;
        const column = colIndex === -1 ? undefined : columns[colIndex];
        if (
          !column ||
          column.type === "readonly" ||
          column.type === "tax" ||
          (column.isCellEditable && !column.isCellEditable(row, rowIndex))
        ) {
          if (raw.trim() !== "") unmatched += 1;
          return;
        }
        const resolved = pastedCellValue(column, row, rowIndex, raw);
        const cols = new Map(nextFlags.get(rowKey));
        if (resolved.ok) {
          row = applyRowFields(row, { [column.key]: resolved.value });
          cols.delete(column.key);
        } else {
          unmatched += 1;
          cols.set(column.key, raw.trim());
        }
        if (cols.size === 0) nextFlags.delete(rowKey);
        else nextFlags.set(rowKey, cols);
      });
      next[rowIndex] = row;
    });
    setFlags(nextFlags);
    onRowsChange(next);
    focusCell(startRow, startCol);
    setPasteNotice(
      unmatched > 0
        ? t("paste.unmatched", { count: unmatched })
        : t("paste.done", { count: body.length }),
    );
  }

  const headersByIndex = useMemo(() => {
    const map = new Map<number, GroupHeaderModel>();
    if (showDist) {
      for (const group of distribution?.groups ?? []) {
        if (group.firstIndex >= 0 && group.firstIndex < rows.length && !map.has(group.firstIndex)) {
          map.set(group.firstIndex, group);
        }
      }
    }
    return map;
  }, [showDist, distribution, rows.length]);

  function openRowMenu(anchor: HTMLElement, rowKey: string) {
    setMenuRowKey(rowKey);
    rowMenu.openBelow(anchor);
  }

  const distMenuItems: ContextMenuEntry[] = (() => {
    if (!showDist || !distribution || menuIndex === -1) return [];
    const row = rows[menuIndex];
    if (!row) return [];
    const chip = distribution.chipOf(row, menuIndex);
    const suggestName = chip?.kind === "suggest" ? chip.ruleName : null;
    const groupKey = distribution.groupKeyOf(row, menuIndex);
    return distribution.menuKeysOf(row, menuIndex).map((key) => {
      if (key === "split") {
        return {
          key,
          label: tEntry("entry.split"),
          icon: Split,
          onSelect: () => distribution.onSplit(menuIndex),
        };
      }
      if (key === "unsplit" && groupKey !== null) {
        return {
          key,
          label: tEntry("entry.unSplit"),
          onSelect: () => distribution.onUnsplit(groupKey),
        };
      }
      if (key === "lock" && groupKey !== null) {
        return {
          key,
          label: tEntry("entry.lockGroup"),
          icon: Lock,
          onSelect: () => distribution.onToggleLock(groupKey),
        };
      }
      if (key === "unlock" && groupKey !== null) {
        return {
          key,
          label: tEntry("entry.unlockGroup"),
          icon: LockOpen,
          onSelect: () => distribution.onToggleLock(groupKey),
        };
      }
      return {
        key,
        label:
          suggestName !== null
            ? tEntry("entry.suggestSplit", { rule: suggestName })
            : tEntry("entry.split"),
        icon: Split,
        onSelect: () => distribution.onApplySuggestion(menuIndex),
      };
    });
  })();

  const rowMenuItems: ContextMenuEntry[] =
    readOnly || fixedRows || menuIndex === -1
      ? []
      : [
          {
            key: "insert-above",
            label: t("insertAbove"),
            icon: ArrowUp,
            onSelect: () => insertRow(menuIndex),
          },
          {
            key: "insert-below",
            label: t("insertBelow"),
            icon: ArrowDown,
            onSelect: () => insertRow(menuIndex + 1),
          },
          {
            key: "duplicate",
            label: tCommon("actions.duplicate"),
            icon: Copy,
            onSelect: () => duplicateRow(menuIndex),
          },
          // The column toggle stays off the Tab path; the line menu reaches it from the keyboard.
          ...(allColumns.some((column) => column.secondary)
            ? [
                {
                  key: "details",
                  label: showDetails ? t("fewerColumns") : t("moreColumns"),
                  onSelect: () => setShowDetails((value) => !value),
                },
              ]
            : []),
          ...(distMenuItems.length > 0
            ? [{ key: "distribution-separator", separator: true } as const, ...distMenuItems]
            : []),
          ...(!hideRemove
            ? [
                { key: "remove-separator", separator: true } as const,
                {
                  key: "remove",
                  label: rows.length > minRows ? t("removeLine") : t("clearLine"),
                  icon: Trash2,
                  danger: true,
                  onSelect: () => removeRow(menuIndex),
                },
              ]
            : []),
        ];

  const cellBase =
    "flex min-h-[38px] items-center border-b border-slate-100 px-1 dark:border-slate-800";
  const inputBase =
    "w-full rounded-sm border-0 bg-transparent px-1.5 py-1 text-sm outline-none focus:ring-2 focus:ring-teal-500/60 dark:text-slate-100";

  return (
    <div ref={rootRef}>
      {allColumns.some((column) => column.secondary) && !readOnly ? (
        <div className="mb-2 flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            tabIndex={-1}
            aria-pressed={showDetails}
            onClick={() => setShowDetails((value) => !value)}
          >
            {tCommon("auditTrail.tabs.details")}
          </Button>
        </div>
      ) : null}
      {!readOnly && !fixedRows && addPlacement === "top" ? (
        <div className="mb-2 flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={() => insertRow(rows.length)}>
            <Plus size={14} /> {addLabel ?? t("addLine")}
          </Button>
        </div>
      ) : null}
      {pasteNotice ? (
        <div
          role="status"
          className="mb-2 flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300"
        >
          <span>{pasteNotice}</span>
          <button
            type="button"
            className="text-slate-400 hover:text-slate-600"
            aria-label={tCommon("actions.close")}
            onClick={() => setPasteNotice(null)}
          >
            ×
          </button>
        </div>
      ) : null}
      <div
        ref={containerRef}
        onPaste={readOnly ? undefined : handlePaste}
        className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
      >
        <div role="grid" className="grid min-w-fit" style={{ gridTemplateColumns: template }}>
          <div role="row" className="contents">
            {/* header */}
            {selection ? (
              <div
                role="columnheader"
                className="border-b border-slate-200 px-2 py-2 dark:border-slate-800"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-teal-600"
                  aria-label={t("selectAll")}
                  checked={
                    rowKeys.length > 0 && rowKeys.every((key) => selection.selected.has(key))
                  }
                  ref={(input) => {
                    if (input)
                      input.indeterminate =
                        rowKeys.some((key) => selection.selected.has(key)) &&
                        !rowKeys.every((key) => selection.selected.has(key));
                  }}
                  onChange={(event) => {
                    selection.onChange(event.target.checked ? new Set(rowKeys) : new Set<string>());
                  }}
                />
              </div>
            ) : null}
            {!readOnly && (
              <div role="columnheader" className="border-b border-slate-200 dark:border-slate-800">
                <span className="sr-only">{t("lineNumberHeader")}</span>
              </div>
            )}
            {columns.map((c, columnIndex) => (
              <div
                key={c.key}
                id={headerIds[columnIndex]}
                role="columnheader"
                className={cn(
                  "border-b border-slate-200 px-2.5 py-2 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400",
                  c.align === "right" && "text-right",
                )}
              >
                <FieldLabel
                  help={c.help}
                  fieldName={c.label}
                  className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
                >
                  {c.label}
                  {c.required && !readOnly ? <span className="text-red-500"> *</span> : null}
                </FieldLabel>
              </div>
            ))}
            {showDist ? (
              <div
                role="columnheader"
                className="border-b border-slate-200 px-2.5 py-2 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400"
              >
                {tEntry("entry.distributionColumn")}
              </div>
            ) : null}
          </div>

          {/* rows */}
          {rows.map((row, i) => (
            <div
              key={rowKeys[i]!}
              role="row"
              className="contents"
              onContextMenu={
                readOnly
                  ? undefined
                  : (event) => {
                      setMenuRowKey(rowKeys[i]!);
                      rowMenu.onContextMenu(event);
                    }
              }
              onKeyDown={
                readOnly
                  ? undefined
                  : (event) => {
                      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                        event.preventDefault();
                        event.stopPropagation();
                        openRowMenu(event.target as HTMLElement, rowKeys[i]!);
                      }
                    }
              }
            >
              {selection ? (
                <div role="gridcell" className={cellBase}>
                  <input
                    type="checkbox"
                    className="ml-2 h-4 w-4 accent-teal-600"
                    aria-label={t("selectRow", { row: i + 1 })}
                    checked={selection.selected.has(rowKeys[i]!)}
                    onChange={() => {
                      const next = new Set(selection.selected);
                      if (next.has(rowKeys[i]!)) next.delete(rowKeys[i]!);
                      else next.add(rowKeys[i]!);
                      selection.onChange(next);
                    }}
                  />
                </div>
              ) : null}
              <RowCells
                row={row}
                rowKey={rowKeys[i]!}
                index={i}
                columns={columns}
                headerIds={headerIds}
                rowLabelId={`${rowLabelPrefix}-${i}`}
                readOnly={readOnly}
                cellBase={cellBase}
                inputBase={inputBase}
                commitCell={commitCell}
                commitRowPatch={commitRowPatch}
                commitTax={commitTax}
                registerDraft={registerDraft}
                handleKeyDown={handleKeyDown}
                flags={flags.get(rowKeys[i]!)}
                autoDecimal={preferences.autoDecimal}
                minorUnits={minorUnits}
                menuOpen={rowMenu.open && menuIndex === i}
                onOpenMenu={(anchor) => openRowMenu(anchor, rowKeys[i]!)}
                formatAmount={formatAmount}
                groupHeader={showDist ? (headersByIndex.get(i) ?? null) : null}
                indented={showDist && (distribution?.groupedIndexes.has(i) ?? false)}
                dist={
                  showDist && distribution
                    ? {
                        chip: distribution.chipOf(row, i),
                        onSplitBelow: (anchor) => openRowMenu(anchor, rowKeys[i]!),
                        onApplySuggestion: () => distribution.onApplySuggestion(i),
                      }
                    : null
                }
                onEditGroupTotal={
                  showDist && distribution ? distribution.onEditGroupTotal : undefined
                }
                onToggleGroupLock={showDist && distribution ? distribution.onToggleLock : undefined}
                onUnsplitGroup={showDist && distribution ? distribution.onUnsplit : undefined}
              />
            </div>
          ))}
        </div>
      </div>
      <ContextMenu
        open={!readOnly && !fixedRows && menuIndex !== -1 && rowMenu.open}
        position={rowMenu.position}
        items={rowMenuItems}
        onClose={rowMenu.close}
      />

      <div className="mt-2 flex items-center justify-between gap-3">
        {!readOnly && !fixedRows && addPlacement === "bottom" ? (
          <Button type="button" variant="outline" size="sm" onClick={() => insertRow(rows.length)}>
            <Plus size={14} /> {addLabel ?? t("addLine")}
          </Button>
        ) : (
          <span />
        )}
        {footer}
      </div>
      {showKeyboardHint && !readOnly && !fixedRows && !hideRemove ? (
        <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">
          {preferences.enterMovesToNextField ? t("keyboardHintEnterAdvances") : t("keyboardHint")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Editable per-line tax cell. Displays the engine-computed tax from the code's
 * rate until the user types a different value — then the line is flagged
 * overridden and the typed value is kept verbatim. An amber dot + a reset button
 * make the override transparent; reset clears the flag and recomputes.
 */
/**
 * The override a raw tax-cell entry resolves to. Shared by the blur commit
 * and the published draft applier so a reorder carries the same outcome the
 * blur would have produced.
 */
function taxDraftOutcome(
  raw: string,
  computed: string,
): { taxAmount: string; overridden: boolean } {
  let normalized: string;
  try {
    normalized = normalizeMoney(raw);
  } catch {
    normalized = "";
  }
  if (raw.trim() === "" || normalized === "") {
    // Empty / invalid → treat as "reset to computed".
    return { taxAmount: computed, overridden: false };
  }
  // Only an actual divergence from the computed value flags an override.
  return { taxAmount: normalized, overridden: cmp(normalized, computed) !== 0 };
}

function TaxCell<Row extends Record<string, unknown>>({
  row,
  column,
  rowKey,
  inputBase,
  registerDraft,
  onCommit,
  ariaLabelledBy,
}: {
  row: Row;
  column: LineGridColumn<Row>;
  rowKey: string;
  inputBase: string;
  registerDraft: (rowKey: string, colKey: string, apply: LineGridDraftApplier<Row> | null) => void;
  onCommit: (next: { taxAmount: string; overridden: boolean }) => void;
  ariaLabelledBy: string;
}) {
  const t = useTranslations("ui.lineGrid.tax");
  const overridden = row.taxOverridden === true;
  const computed = column.computeTax?.(row) ?? "0.0000";
  // While overridden, show the explicit amount; otherwise mirror the computed
  // value so the cell always reflects what will post. A live draft passes
  // through untouched so typing is never replaced mid-keystroke.
  const [draft, setDraft] = useState<string | null>(null);
  const stored = overridden ? String(row.taxAmount ?? "") : computed;
  const shown =
    draft != null ? draft : overridden ? taxDisplayValue(stored) : settledTaxDisplay(computed);
  const colKey = "tax";

  // Same draft-carry contract as DecimalCell: a reorder folds the pending
  // override into this row before moving it.
  useEffect(() => {
    if (draft === null) {
      registerDraft(rowKey, colKey, null);
      return;
    }
    const outcome = taxDraftOutcome(draft, computed);
    registerDraft(rowKey, colKey, (r) =>
      applyRowFields(r, { taxAmount: outcome.taxAmount, taxOverridden: outcome.overridden }),
    );
    return () => {
      registerDraft(rowKey, colKey, null);
    };
  }, [draft, computed, rowKey, registerDraft]);

  const commit = (raw: string) => {
    setDraft(null);
    onCommit(taxDraftOutcome(raw, computed));
  };

  return (
    <div className="flex w-full items-center gap-1">
      {overridden ? (
        <span
          aria-label={t("overriddenAria")}
          title={t("overriddenTitle")}
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
        />
      ) : null}
      <input
        inputMode="decimal"
        value={shown}
        placeholder="0.00"
        aria-invalid={(shown !== "—" && invalidAmount(shown)) || undefined}
        aria-labelledby={ariaLabelledBy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        title={overridden ? t("computedOverriddenTitle", { amount: computed }) : undefined}
        className={cn(
          inputBase,
          "text-right tabular-nums",
          overridden && "font-medium text-amber-700 dark:text-amber-400",
          shown !== "—" &&
            invalidAmount(shown) &&
            "text-red-600 focus:ring-red-500/60 dark:text-red-400",
        )}
      />
      {overridden ? (
        <button
          type="button"
          aria-label={t("resetAria")}
          title={t("resetTitle", { amount: computed })}
          onClick={() => {
            setDraft(null);
            onCommit({ taxAmount: computed, overridden: false });
          }}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
        >
          <RotateCcw size={12} />
        </button>
      ) : null}
    </div>
  );
}

function RowCells<Row extends Record<string, unknown>>({
  row,
  rowKey,
  index: i,
  columns,
  headerIds,
  rowLabelId,
  readOnly,
  cellBase,
  inputBase,
  commitCell,
  commitRowPatch,
  commitTax,
  registerDraft,
  handleKeyDown,
  flags,
  autoDecimal,
  minorUnits,
  menuOpen,
  onOpenMenu,
  formatAmount,
  groupHeader,
  indented,
  dist,
  onEditGroupTotal,
  onToggleGroupLock,
  onUnsplitGroup,
}: {
  row: Row;
  rowKey: string;
  index: number;
  columns: LineGridColumn<Row>[];
  headerIds: string[];
  rowLabelId: string;
  readOnly: boolean;
  cellBase: string;
  inputBase: string;
  commitCell: (rowKey: string, key: string, value: unknown) => void;
  commitRowPatch: (rowKey: string, patch: Partial<Row>) => void;
  commitTax: (
    rowKey: string,
    column: LineGridColumn<Row>,
    next: { taxAmount: string; overridden: boolean },
  ) => void;
  registerDraft: (rowKey: string, colKey: string, apply: LineGridDraftApplier<Row> | null) => void;
  handleKeyDown: (e: React.KeyboardEvent, i: number, col: number) => void;
  /** Pasted values on this row that matched nothing, by column key. */
  flags?: ReadonlyMap<string, string>;
  autoDecimal: boolean;
  minorUnits: number;
  menuOpen: boolean;
  onOpenMenu: (anchor: HTMLElement) => void;
  formatAmount?: (value: string) => React.ReactNode;
  groupHeader: GroupHeaderModel | null;
  indented: boolean;
  dist: {
    chip: RowDistributionChip | null;
    onSplitBelow: (anchor: HTMLElement) => void;
    onApplySuggestion: () => void;
  } | null;
  onEditGroupTotal?: (groupKey: string, total: string) => void;
  onToggleGroupLock?: (groupKey: string) => void;
  onUnsplitGroup?: (groupKey: string) => void;
}) {
  const t = useTranslations("ui.lineGrid");
  const tScan = useTranslations("ui.select");
  return (
    <>
      {groupHeader ? (
        <DistributionGroupHeader
          group={groupHeader}
          onEditTotal={onEditGroupTotal}
          onToggleLock={onToggleGroupLock}
          onUnsplit={onUnsplitGroup}
        />
      ) : null}
      {!readOnly ? (
        <div className={cn(cellBase, "justify-center px-0")}>
          <span id={rowLabelId} className="sr-only">
            {t("lineActionsAria", { number: i + 1 })}
          </span>
          <button
            type="button"
            // Line actions stay off the Tab path (one stop per line would
            // double the keystrokes between lines); Shift+F10 or the context
            // menu key opens the same menu from any cell.
            tabIndex={-1}
            aria-label={t("lineActionsAria", { number: i + 1 })}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => onOpenMenu(event.currentTarget)}
            className="flex h-7 w-11 items-center justify-center gap-1 rounded text-slate-500 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/60 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <span className="text-[11px] tabular-nums">{i + 1}</span>
            <MoreHorizontal size={13} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {columns.map((c, colIndex) => {
        const ariaLabelledBy = `${headerIds[colIndex]} ${rowLabelId}`;
        const value = row[c.key];
        if (readOnly || c.type === "readonly") {
          // Resolve select/search-select values to their human label — never
          // render a raw id/uuid in a read-only cell.
          let display: React.ReactNode;
          if (c.type === "tax") {
            const overridden = row.taxOverridden === true;
            const computed = overridden
              ? String(row.taxAmount ?? "0.0000")
              : (c.computeTax?.(row) ?? "0.0000");
            display = (
              <span className="inline-flex items-center gap-1.5">
                {overridden ? (
                  <span
                    aria-label={t("tax.overriddenAria")}
                    title={t("tax.overriddenShortTitle")}
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                  />
                ) : null}
                {settledTaxDisplay(computed, formatAmount)}
              </span>
            );
          } else if (c.render) display = c.render(row, i);
          else if ((c.type === "select" || c.type === "search-select") && value)
            display =
              (c.optionsFor?.(row, i) ?? c.options)?.find((o) => o.value === value)?.label ?? "";
          else if (c.type === "decimal") display = displayLineDecimal(value, c.decimalScale ?? 8);
          else if (c.type === "amount")
            display =
              value == null || value === "" ? "" : (formatAmount?.(String(value)) ?? String(value));
          else display = (value as string) ?? "";
          return (
            <div
              key={c.key}
              role="gridcell"
              className={cn(
                cellBase,
                "px-2.5 text-sm",
                c.align === "right" && "justify-end tabular-nums",
              )}
            >
              {display}
            </div>
          );
        }
        // A row the column does not apply to keeps an empty cell — never a
        // control with one meaningless choice, and never a stale label. The
        // cell keeps its grid position (role and row/column address) so a
        // declared column can never render a header with no body cell.
        if (c.isCellEditable && !c.isCellEditable(row, i)) {
          return (
            <div
              key={c.key}
              data-lg-row={i}
              data-lg-col={colIndex}
              role="gridcell"
              className={cn(
                cellBase,
                "px-2.5 text-sm",
                c.lockedRender && c.align === "right" && "justify-end tabular-nums",
              )}
            >
              {c.lockedRender?.(row, i)}
            </div>
          );
        }
        const flagged = flags?.get(c.key);
        return (
          <div
            key={c.key}
            data-lg-row={i}
            data-lg-col={colIndex}
            role="gridcell"
            title={
              flagged !== undefined && c.type !== "amount"
                ? t("paste.unmatchedCell", { value: flagged })
                : undefined
            }
            className={cn(
              cellBase,
              indented && colIndex === 0 && "pl-6",
              flagged !== undefined &&
                c.type !== "amount" &&
                "bg-red-50 ring-1 ring-inset ring-red-300 dark:bg-red-950/30 dark:ring-red-800",
            )}
            onKeyDown={(e) => handleKeyDown(e, i, colIndex)}
          >
            {c.type === "search-select" ? (
              <SearchSelect
                options={c.optionsFor?.(row, i) ?? c.options ?? []}
                ariaLabelledBy={ariaLabelledBy}
                value={(value as string) ?? ""}
                onChange={(v, scan) => {
                  const patch = scan ? c.onScanResolved?.(row, i, scan) : undefined;
                  if (patch) commitRowPatch(rowKey, { ...patch, [c.key]: v ?? "" } as Partial<Row>);
                  else commitCell(rowKey, c.key, v ?? "");
                }}
                searchable={c.scanResolver ? true : undefined}
                advanceOnSelect
                arrowKeysOpen={false}
                recentKey={c.recentKey}
                onCreate={c.onCreate}
                createLabel={c.createLabel}
                scanResolver={
                  c.scanResolver
                    ? async (scanned) => {
                        const result = await c.scanResolver!(scanned, row, i);
                        if (!result.ok) return result;
                        const choices = c.optionsFor?.(row, i) ?? c.options ?? [];
                        if (choices.some((option) => option.value === result.value)) return result;
                        return {
                          ok: false,
                          message: tScan("scanUnavailable"),
                          candidates: choices.map((option) => option.label),
                        };
                      }
                    : undefined
                }
                placeholder={c.placeholder ?? "—"}
                className="w-full"
                triggerClassName="h-auto min-h-0 rounded-sm border-0 bg-transparent px-1.5 py-1 shadow-none focus:ring-0"
              />
            ) : c.type === "date" ? (
              <DateCell<Row>
                value={typeof value === "string" ? value : ""}
                placeholder={c.placeholderFor?.(row, i) ?? c.placeholder}
                onChange={(next) => commitCell(rowKey, c.key, next)}
                rowKey={rowKey}
                colKey={c.key}
                registerDraft={registerDraft}
                ariaLabelledBy={ariaLabelledBy}
              />
            ) : c.type === "select" ? (
              <Select
                aria-labelledby={ariaLabelledBy}
                advanceOnSelect
                arrowKeysOpen={false}
                value={(value as string) ?? ""}
                onChange={(e) => commitCell(rowKey, c.key, e.target.value)}
                className="w-full border-0 bg-transparent shadow-none"
              >
                {(c.optionsFor?.(row, i) ?? c.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : c.type === "amount" ? (
              <AmountCell<Row>
                value={value}
                placeholder={c.placeholderFor?.(row, i) ?? c.placeholder}
                inputBase={inputBase}
                onChange={(next) => commitCell(rowKey, c.key, next)}
                rowKey={rowKey}
                colKey={c.key}
                registerDraft={registerDraft}
                ariaLabelledBy={ariaLabelledBy}
                autoDecimal={autoDecimal}
                minorUnits={minorUnits}
                flagged={flagged}
              />
            ) : c.type === "decimal" ? (
              <DecimalCell<Row>
                value={value}
                scale={c.decimalScale ?? 8}
                inputBase={inputBase}
                onChange={(next) => commitCell(rowKey, c.key, next)}
                rowKey={rowKey}
                colKey={c.key}
                registerDraft={registerDraft}
                ariaLabelledBy={ariaLabelledBy}
              />
            ) : c.type === "tax" ? (
              <TaxCell
                row={row}
                column={c}
                rowKey={rowKey}
                inputBase={inputBase}
                registerDraft={registerDraft}
                ariaLabelledBy={ariaLabelledBy}
                onCommit={(next) => commitTax(rowKey, c, next)}
              />
            ) : (
              <input
                value={(value as string) ?? ""}
                aria-labelledby={ariaLabelledBy}
                placeholder={c.placeholderFor?.(row, i) ?? c.placeholder}
                onChange={(e) => commitCell(rowKey, c.key, e.target.value)}
                className={inputBase}
              />
            )}
          </div>
        );
      })}
      {dist ? (
        <div className={cn(cellBase, "px-1.5")}>
          <DistributionCell
            chip={dist.chip}
            rowNumber={i + 1}
            onSplitBelow={dist.onSplitBelow}
            onApplySuggestion={dist.onApplySuggestion}
          />
        </div>
      ) : null}
    </>
  );
}

/**
 * One row's distribution affordance: the applied-rule chip for a group
 * child, the staged-rule chip for a line carrying a distributionKey the
 * server has not exploded yet, the "Split by <rule>?" suggest chip, or the
 * plain Split… entry point.
 */
function DistributionCell({
  chip,
  rowNumber,
  onSplitBelow,
  onApplySuggestion,
}: {
  chip: RowDistributionChip | null;
  rowNumber: number;
  onSplitBelow: (anchor: HTMLElement) => void;
  onApplySuggestion: () => void;
}) {
  const t = useTranslations("allocations");
  if (chip === null) return <span />;
  if (chip.kind === "rule") {
    return (
      <Badge
        variant="secondary"
        className="max-w-full gap-1 px-2 py-0.5 text-[11px] font-medium"
        title={chip.locked ? t("entry.groupLockedHint") : undefined}
      >
        {chip.locked ? (
          <Lock size={11} className="shrink-0" />
        ) : (
          <Split size={11} className="shrink-0" />
        )}
        <span className="truncate">{chip.ruleName}</span>
      </Badge>
    );
  }
  if (chip.kind === "pending") {
    return (
      <Badge
        variant="outline"
        className="max-w-full gap-1 border-dashed px-2 py-0.5 text-[11px] font-medium"
        title={t("entry.pendingRule", { rule: chip.ruleName })}
      >
        <Split size={11} className="shrink-0" />
        <span className="truncate">{chip.ruleName}</span>
      </Badge>
    );
  }
  if (chip.kind === "suggest") {
    return (
      <button
        type="button"
        onClick={onApplySuggestion}
        title={t("entry.suggestSplit", { rule: chip.ruleName })}
        aria-label={t("entry.groupActionsAria", { number: rowNumber })}
        className="inline-flex max-w-full items-center gap-1 rounded-full border border-teal-200/70 bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-800 hover:bg-teal-100 dark:border-teal-800/60 dark:bg-teal-950/50 dark:text-teal-300 dark:hover:bg-teal-950"
      >
        <Split size={11} className="shrink-0" />
        <span className="truncate">{t("entry.suggestSplit", { rule: chip.ruleName })}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => onSplitBelow(e.currentTarget)}
      aria-label={t("entry.groupActionsAria", { number: rowNumber })}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
    >
      <Split size={12} /> {t("entry.split")}
    </button>
  );
}

/**
 * The synthetic header row above one distribution group's children: the
 * applied rule, the editable group total (re-explodes unless locked), the
 * lock toggle, and Un-split.
 */
function DistributionGroupHeader({
  group,
  onEditTotal,
  onToggleLock,
  onUnsplit,
}: {
  group: GroupHeaderModel;
  onEditTotal?: (groupKey: string, total: string) => void;
  onToggleLock?: (groupKey: string) => void;
  onUnsplit?: (groupKey: string) => void;
}) {
  const t = useTranslations("allocations");
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? group.total;
  const invalid = invalidAmount(shown);

  const commit = () => {
    const raw = shown.trim();
    setDraft(null);
    if (raw === "") return;
    try {
      const normalized = normalizeMoney(raw);
      if (cmp(normalized, group.total) !== 0) onEditTotal?.(group.key, normalized);
    } catch {
      // Malformed totals stay in the cell until fixed; the save boundary
      // rejects them exactly like a malformed line amount.
    }
  };

  return (
    <div
      style={{ gridColumn: "1 / -1" }}
      className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/70 px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-800/40"
    >
      <Split size={12} className="shrink-0 text-slate-400" />
      {group.ruleName ? (
        <span className="truncate text-xs font-semibold text-slate-600 dark:text-slate-300">
          {group.ruleName}
        </span>
      ) : null}
      <span className="ml-auto shrink-0 text-[11px] text-slate-400">
        {t("entry.groupTotalLabel")}
      </span>
      <input
        inputMode="decimal"
        value={shown}
        disabled={group.locked}
        aria-label={t("entry.groupTotalAria")}
        aria-invalid={invalid || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className={cn(
          "w-28 rounded-sm border border-slate-200 bg-white px-1.5 py-0.5 text-right text-sm tabular-nums outline-none focus:ring-2 focus:ring-teal-500/60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
          invalid && "text-red-600 focus:ring-red-500/60 dark:text-red-400",
          group.locked && "opacity-60",
        )}
      />
      <button
        type="button"
        aria-label={group.locked ? t("entry.unlockGroup") : t("entry.lockGroup")}
        title={group.locked ? t("entry.unlockGroup") : t("entry.lockGroup")}
        onClick={() => onToggleLock?.(group.key)}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-300"
      >
        {group.locked ? <LockOpen size={13} /> : <Lock size={13} />}
      </button>
      <button
        type="button"
        onClick={() => onUnsplit?.(group.key)}
        className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-slate-500 hover:bg-slate-200/70 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200"
      >
        {t("entry.unSplit")}
      </button>
    </div>
  );
}
