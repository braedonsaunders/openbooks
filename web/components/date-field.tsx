"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import { useLocale, useTranslations } from "next-intl";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Input, Popover, cn } from "@openbooks/ui";
import { isIsoCalendarDate, startOfMonth } from "@openbooks/engine/platform/civil-date";
import { useOptionalBusinessToday } from "./business-date-provider";
import { formatCivilDate } from "../lib/format";
import {
  applyDateEntryCommand,
  calendarWeeks,
  dateEntryCommand,
  endOfWeek,
  entryDatePattern,
  firstDayOfWeekForLocale,
  formatEntryDate,
  isCompleteTypedDate,
  parseTypedDate,
  regionalViewerLocale,
  shiftDays,
  shiftMonths,
  startOfWeek,
  startsMonthName,
  type DateEntryCommand,
  type IsoWeekday,
} from "../lib/date-entry";

type NativeInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "defaultValue" | "onChange" | "min" | "max" | "name" | "form" | "children"
>;

export interface DateFieldProps extends NativeInputProps {
  /** Controlled value: an ISO `YYYY-MM-DD` date, or '' for no date. */
  value?: string;
  /** Uncontrolled initial value (ISO `YYYY-MM-DD` or ''). */
  defaultValue?: string;
  /**
   * Receives the field's date whenever it settles on a new one: ISO
   * `YYYY-MM-DD`, or '' when cleared or when the typed text is not a date
   * the field accepts (the text stays on screen, marked invalid).
   */
  onChange?: (value: string) => void;
  /** Earliest accepted date (ISO). */
  min?: string;
  /** Latest accepted date (ISO). */
  max?: string;
  /** Form field name: the ISO value is submitted under it. */
  name?: string;
  /** Id of the form the submitted value belongs to, when outside it. */
  form?: string;
  /** A date in the month the calendar opens on while the field is empty. */
  openTo?: string;
  /** `cell` renders a borderless control that fills a grid cell. */
  appearance?: "field" | "cell";
  /**
   * The text being typed and not yet settled, or null once the field shows
   * its settled date again. For owners that must apply an unfinished entry
   * before a structural edit (a grid moving or removing rows); read it with
   * `useTypedDateResolver`.
   */
  onPendingTextChange?: (text: string | null) => void;
}

type FieldError =
  | { kind: "unreadable" | "impossible" | "needsYear"; text: string }
  | { kind: "beforeMin" | "afterMax" };

type Resolution = { ok: true; iso: string } | { ok: false; error: FieldError };

/** Read typed text as the field does: '' for cleared text, else one real date in range. */
function resolveTypedText(
  text: string,
  context: { today: string | null; locale: string; min: string | null; max: string | null },
): Resolution {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, iso: "" };
  const parsed = parseTypedDate(trimmed, { today: context.today, locale: context.locale });
  if (!parsed.ok) {
    const kind =
      parsed.reason === "impossible"
        ? "impossible"
        : parsed.reason === "needsYear"
          ? "needsYear"
          : "unreadable";
    return { ok: false, error: { kind, text: trimmed } };
  }
  if (context.min && parsed.iso < context.min) return { ok: false, error: { kind: "beforeMin" } };
  if (context.max && parsed.iso > context.max) return { ok: false, error: { kind: "afterMax" } };
  return { ok: true, iso: parsed.iso };
}

/**
 * Width, margin and placement utilities size the whole field (text box and
 * calendar button together); everything else styles the text box.
 */
const LAYOUT_UTILITY =
  /^(?:[\w[\]&:-]+:)?-?(?:w-|min-w-|max-w-|flex-|basis-|grow|shrink|self-|justify-self-|place-self-|col-|row-|order-|m[trblxyse]?-|block$|inline|hidden$|contents$)/;

function splitClassName(className: string | undefined): { layout: string; control: string } {
  const layout: string[] = [];
  const control: string[] = [];
  for (const token of (className ?? "").split(/\s+/).filter(Boolean)) {
    if (LAYOUT_UTILITY.test(token)) layout.push(token);
    else control.push(token);
  }
  return { layout: layout.join(" "), control: control.join(" ") };
}

/** Editing chords that never settle the typed text. */
const EDITING_CHORDS = new Set([
  "a",
  "c",
  "v",
  "x",
  "z",
  "y",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "Control",
  "Meta",
  "Alt",
  "Shift",
]);

function subscribeToLanguages(onChange: () => void) {
  window.addEventListener("languagechange", onChange);
  return () => window.removeEventListener("languagechange", onChange);
}

/**
 * The locale dates are typed and shown in: the viewer's language, refined
 * after hydration by the browser's region for the same language (an English
 * viewer on an en-GB browser writes day first).
 */
function useEntryLocale(): string {
  const viewer = useLocale();
  return React.useSyncExternalStore(
    subscribeToLanguages,
    () => regionalViewerLocale(viewer, navigator.languages ?? []),
    () => viewer,
  );
}

/**
 * The date a field's unsettled text stands for, read exactly as the field
 * will settle it: ISO, or '' when cleared or refused.
 */
export function useTypedDateResolver({ min, max }: { min?: string; max?: string } = {}): (
  text: string,
) => string {
  const locale = useEntryLocale();
  const today = useOptionalBusinessToday();
  const minIso = isoOrNull(min);
  const maxIso = isoOrNull(max);
  return React.useCallback(
    (text: string) => {
      const result = resolveTypedText(text, { today, locale, min: minIso, max: maxIso });
      return result.ok ? result.iso : "";
    },
    [today, locale, minIso, maxIso],
  );
}

function isoOrNull(value: string | undefined): string | null {
  return value && isIsoCalendarDate(value) ? value : null;
}

/**
 * The one date control. The viewer types a date the way they write it —
 * their locale's order and separators, month names, ordinals, a missing or
 * two-digit year read against the organization's business date — and it
 * settles on blur or Enter (cleared text and a complete ISO date report as
 * soon as they are typed or pasted). Text that is not exactly one real date in the
 * allowed range stays on screen, is marked invalid with the reason, blocks
 * native form submission and reports '' to the owner; it is never replaced
 * by a different day.
 *
 * While the text is untouched, single keys move the date: `+`/`-` a day
 * (also after a complete typed date), T the business date, W/K, M/H and Y/R
 * the first/last day of the week, month and year, repeating by a further
 * period. Alt+ArrowDown or the button opens a keyboard-navigable calendar.
 * With `name` the ISO value is submitted in a hidden input, so the field
 * works in native forms and server actions.
 */
export const DateField = React.forwardRef<HTMLInputElement, DateFieldProps>(function DateField(
  {
    value: controlledValue,
    defaultValue,
    onChange,
    min,
    max,
    name,
    form,
    openTo,
    appearance = "field",
    onPendingTextChange,
    className,
    disabled,
    readOnly,
    required,
    placeholder,
    onBlur,
    onKeyDown,
    id,
    "aria-describedby": describedBy,
    "aria-invalid": ariaInvalid,
    autoComplete = "off",
    ...inputProps
  },
  forwardedRef,
) {
  const t = useTranslations("shell.dateEntry");
  const locale = useEntryLocale();
  const today = useOptionalBusinessToday();
  const weekStartsOn = firstDayOfWeekForLocale(locale);
  const controlled = controlledValue !== undefined;
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue ?? "");
  const value = controlled ? controlledValue : uncontrolledValue;
  // Text being typed; null while the field shows its settled value.
  const [draft, setDraft] = React.useState<string | null>(null);
  const [error, setError] = React.useState<FieldError | null>(null);
  // A value the field reported while keeping its text on screen (a refused
  // entry, a month name being typed): when the owner passes it back, the
  // text stays instead of being replaced by the formatted value.
  const [keptTextValue, setKeptTextValue] = React.useState<string | null>(null);
  // Typed text not yet settled. The ref answers synchronously inside event
  // handlers; the state tells an owner through onPendingTextChange.
  const dirtyRef = React.useRef(false);
  const [pendingText, setPendingText] = React.useState<string | null>(null);
  const [seenValue, setSeenValue] = React.useState(value);
  if (seenValue !== value) {
    setSeenValue(value);
    // A new date from the owner replaces whatever was being typed.
    if (value !== keptTextValue) {
      setPendingText(null);
      setDraft(null);
      setError(null);
    }
    setKeptTextValue(null);
  }
  const [open, setOpen] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState("");

  const inputRef = React.useRef<HTMLInputElement | null>(null);
  function markTyped(text: string) {
    dirtyRef.current = true;
    setPendingText(text);
  }
  function markSettled() {
    dirtyRef.current = false;
    setPendingText(null);
  }
  const letterCommandRef = React.useRef<{ before: string; letter: string } | null>(null);
  const announceTimer = React.useRef<number | undefined>(undefined);
  const errorId = React.useId();
  const minIso = isoOrNull(min);
  const maxIso = isoOrNull(max);
  const display = draft ?? formatEntryDate(value, locale);
  // The month the calendar opens on: the field's date, the owner's hint, or
  // the business date kept inside the allowed range. With none of them the
  // calendar has no meaningful month and stays closed; typing still works.
  const calendarAnchor =
    isoOrNull(value) ?? isoOrNull(openTo) ?? clampDate(today, minIso, maxIso) ?? minIso ?? maxIso;
  const pattern = entryDatePattern(locale, {
    year: t("yearSymbol"),
    month: t("monthSymbol"),
    day: t("daySymbol"),
  });
  const editable = !disabled && !readOnly;

  const setRefs = React.useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  function errorMessage(problem: FieldError): string {
    switch (problem.kind) {
      case "unreadable":
        return t("unreadable", {
          text: problem.text.slice(0, 40),
          example: today ? formatEntryDate(today, locale) : pattern,
        });
      case "impossible":
        return t("impossible", { text: problem.text.slice(0, 40) });
      case "needsYear":
        return t("needsYear", { example: pattern });
      case "beforeMin":
        return t("beforeMin", { min: formatCivilDate(minIso!, locale) });
      case "afterMax":
        return t("afterMax", { max: formatCivilDate(maxIso!, locale) });
    }
  }
  const message = error ? errorMessage(error) : null;

  React.useEffect(() => {
    inputRef.current?.setCustomValidity(message ?? "");
  }, [message]);

  React.useEffect(() => () => window.clearTimeout(announceTimer.current), []);

  // Typing replaced by the owner's new date leaves nothing to settle.
  React.useLayoutEffect(() => {
    if (pendingText === null) dirtyRef.current = false;
  }, [pendingText]);

  const onPendingTextChangeRef = React.useRef(onPendingTextChange);
  React.useLayoutEffect(() => {
    onPendingTextChangeRef.current = onPendingTextChange;
  });
  React.useEffect(() => {
    onPendingTextChangeRef.current?.(pendingText);
  }, [pendingText]);

  function announce(text: string) {
    // Clearing first makes a repeated message speak again.
    setAnnouncement("");
    window.clearTimeout(announceTimer.current);
    announceTimer.current = window.setTimeout(() => setAnnouncement(text), 0);
  }

  function emit(iso: string) {
    if (!controlled) setUncontrolledValue(iso);
    if (iso !== value) onChange?.(iso);
  }

  function resolve(text: string): Resolution {
    return resolveTypedText(text, { today, locale, min: minIso, max: maxIso });
  }

  /** Settle typed text. Returns whether it was accepted. */
  function settle(text: string): boolean {
    markSettled();
    const result = resolve(text);
    if (result.ok) {
      setDraft(null);
      setError(null);
      emit(result.iso);
      return true;
    }
    setDraft(text);
    setError(result.error);
    if (value !== "") {
      setKeptTextValue("");
      emit("");
    }
    return false;
  }

  /** Move to a date chosen by a key or the calendar. */
  function choose(iso: string) {
    markSettled();
    setDraft(null);
    setError(null);
    emit(iso);
    announce(t("changed", { date: formatCivilDate(iso, locale) }));
  }

  const settleRef = React.useRef(settle);
  const latestKeyDown = React.useRef(onKeyDown);
  React.useLayoutEffect(() => {
    settleRef.current = settle;
    latestKeyDown.current = onKeyDown;
  });

  // Autofill and scripted entry announce a finished value with `change`
  // without the field losing focus; settle it then as well.
  React.useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    function onNativeChange() {
      queueMicrotask(() => {
        if (dirtyRef.current && inputRef.current) settleRef.current(inputRef.current.value);
      });
    }
    input.addEventListener("change", onNativeChange);
    return () => input.removeEventListener("change", onNativeChange);
  }, []);

  // A native form reset returns an uncontrolled field to its initial date.
  React.useEffect(() => {
    const owner = inputRef.current?.form;
    if (!owner || controlled) return;
    function onReset() {
      markSettled();
      setUncontrolledValue(defaultValue ?? "");
      setDraft(null);
      setError(null);
    }
    owner.addEventListener("reset", onReset);
    return () => owner.removeEventListener("reset", onReset);
  }, [controlled, defaultValue]);

  /** Apply a date key. Returns whether the key was consumed. */
  function runCommand(
    command: DateEntryCommand,
    event: React.KeyboardEvent<HTMLInputElement>,
  ): boolean {
    const untouched = draft === null;
    const dayStep = command === "nextDay" || command === "previousDay";
    if (!untouched && !(dayStep && isCompleteTypedDate(display, { today, locale }))) return false;
    event.preventDefault();
    const typed = untouched ? null : resolve(display);
    const base = typed?.ok ? typed.iso : value;
    const next = applyDateEntryCommand(command, base, { today, weekStartsOn });
    if (next === null) {
      announce(today === null ? t("needsYear", { example: pattern }) : t("outsideCalendar"));
      return true;
    }
    if ((minIso && next < minIso) || (maxIso && next > maxIso)) {
      announce(t("outsideAllowed"));
      return true;
    }
    letterCommandRef.current =
      !dayStep && untouched && event.key.length === 1 ? { before: value, letter: event.key } : null;
    choose(next);
    return true;
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || !editable) {
      onKeyDown?.(event);
      return;
    }
    const letterCommand = letterCommandRef.current;
    letterCommandRef.current = null;
    // A letter key that turns out to begin a month name ("M" then "a" for
    // March or May) is typing, not a date key: undo the key's date and keep
    // the letters.
    if (
      letterCommand &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      startsMonthName(letterCommand.letter + event.key, locale)
    ) {
      event.preventDefault();
      setKeptTextValue(letterCommand.before);
      emit(letterCommand.before);
      markTyped(letterCommand.letter + event.key);
      setDraft(letterCommand.letter + event.key);
      return;
    }
    if (event.key === "Escape" && (dirtyRef.current || error !== null)) {
      // The first Escape abandons the typing and shows the settled date
      // again; it does not also close the drawer or dialog behind the field.
      event.preventDefault();
      event.stopPropagation();
      markSettled();
      setDraft(null);
      setError(null);
      return;
    }
    // In a grid cell Alt+Arrow keys belong to the grid (they move rows).
    if (event.altKey && event.key === "ArrowDown" && appearance !== "cell") {
      event.preventDefault();
      if (dirtyRef.current) settle(display);
      if (calendarAnchor !== null) setOpen(true);
      return;
    }
    if (event.key === "Enter") {
      if (dirtyRef.current) {
        let accepted = false;
        flushSync(() => {
          accepted = settle(display);
        });
        if (!accepted) {
          // A refused entry never submits the form it sits in, and focus
          // stays on it rather than moving on with a grid or form.
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      latestKeyDown.current?.(event);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      // A save or command shortcut acts on the date the viewer can see.
      if (dirtyRef.current && !EDITING_CHORDS.has(event.key)) {
        flushSync(() => {
          settle(display);
        });
        latestKeyDown.current?.(event);
        return;
      }
      onKeyDown?.(event);
      return;
    }
    const command = dateEntryCommand(event.key);
    if (command && runCommand(command, event)) return;
    onKeyDown?.(event);
  }

  function handleBlur(event: React.FocusEvent<HTMLInputElement>) {
    letterCommandRef.current = null;
    if (dirtyRef.current) settle(display);
    onBlur?.(event);
  }

  function closeCalendar(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) inputRef.current?.focus();
  }

  const { layout, control } = splitClassName(className);
  const cell = appearance === "cell";
  const invalid = error !== null || ariaInvalid === true || ariaInvalid === "true";
  const describedByIds =
    [describedBy, message ? errorId : null].filter(Boolean).join(" ") || undefined;

  const field = (
    <span className={cn("relative block w-full", layout)}>
      <Input
        {...inputProps}
        ref={setRefs}
        id={id}
        type="text"
        data-date-field=""
        value={display}
        placeholder={placeholder ?? pattern}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        autoComplete={autoComplete}
        spellCheck={false}
        aria-invalid={invalid || undefined}
        aria-describedby={describedByIds}
        aria-keyshortcuts={editable && !cell ? "Alt+ArrowDown" : undefined}
        onChange={(event) => {
          const text = event.target.value;
          markTyped(text);
          letterCommandRef.current = null;
          setDraft(text);
          // Cleared text, or a complete ISO date typed or pasted, cannot grow
          // into another date, so it reports at once; the text keeps its
          // typed form until the entry settles.
          const typed = text.trim();
          const unambiguous =
            typed === "" ||
            (isIsoCalendarDate(typed) &&
              (!minIso || typed >= minIso) &&
              (!maxIso || typed <= maxIso));
          if (typed !== value && unambiguous) {
            setError(null);
            setKeptTextValue(typed);
            emit(typed);
          }
        }}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className={cn(
          "tabular-nums",
          cell &&
            "h-8 rounded-sm border-0 bg-transparent px-1.5 py-1 shadow-none focus:ring-2 focus:ring-teal-500/60 focus-visible:ring-2 dark:bg-transparent",
          control,
          !readOnly && (cell ? "pr-7" : "pr-8"),
        )}
      />
      {readOnly ? null : (
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled || calendarAnchor === null}
          aria-label={t("openCalendar")}
          aria-haspopup="dialog"
          aria-expanded={open}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (open) {
              closeCalendar(true);
              return;
            }
            if (dirtyRef.current) settle(display);
            setOpen(true);
          }}
          className={cn(
            "absolute top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:pointer-events-none disabled:opacity-50 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300",
            cell ? "right-1" : "right-1.5",
          )}
        >
          <CalendarDays aria-hidden className="h-4 w-4" />
        </button>
      )}
      {name !== undefined ? (
        <input type="hidden" name={name} form={form} value={value} disabled={disabled} />
      ) : null}
      {message ? (
        <span
          id={errorId}
          role="alert"
          className="absolute left-0 top-full z-20 mt-1 block w-max max-w-[18rem] rounded-md border border-red-200 bg-white px-2 py-1 text-xs leading-snug text-red-700 shadow-md dark:border-red-900 dark:bg-slate-900 dark:text-red-300"
        >
          {message}
        </span>
      ) : null}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </span>
  );

  return (
    <Popover
      trigger={field}
      open={open && editable && calendarAnchor !== null}
      onOpenChange={(next) => setOpen(next)}
      align="start"
      side="bottom"
      label={t("calendar")}
      className="w-auto min-w-0 p-3"
    >
      <DateCalendar
        selected={isoOrNull(value)}
        initial={calendarAnchor ?? ""}
        today={today}
        min={minIso}
        max={maxIso}
        locale={locale}
        weekStartsOn={weekStartsOn}
        onSelect={(iso) => {
          choose(iso);
          closeCalendar(true);
        }}
        onClose={() => closeCalendar(true)}
      />
    </Popover>
  );
});

DateField.displayName = "DateField";

function clampDate(iso: string | null, min: string | null, max: string | null): string | null {
  if (iso === null) return null;
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

const FOCUSABLE = 'button:not([disabled]), [tabindex="0"]';

const calendarFormats = new Map<string, Intl.DateTimeFormat>();

/** A cached UTC formatter for calendar labels. */
function calendarFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = calendarFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    calendarFormats.set(key, format);
  }
  return format;
}

function calendarText(iso: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  return calendarFormat(locale, options).format(new Date(`${iso}T12:00:00Z`));
}

/**
 * Month grid for choosing a date. Arrow keys move by day and week, Page
 * Up/Down by month (Shift for a year), Home/End to the ends of the week;
 * Enter or Space chooses, Esc closes. Tab stays inside the calendar.
 */
function DateCalendar({
  selected,
  initial,
  today,
  min,
  max,
  locale,
  weekStartsOn,
  onSelect,
  onClose,
}: {
  selected: string | null;
  initial: string;
  today: string | null;
  min: string | null;
  max: string | null;
  locale: string;
  weekStartsOn: IsoWeekday;
  onSelect: (iso: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("shell.dateEntry");
  const [focused, setFocused] = React.useState(initial);
  const moveFocus = React.useRef(true);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const month = startOfMonth(focused);
  const weeks = calendarWeeks(month, weekStartsOn);
  const monthLabel = calendarText(month, locale, { month: "long", year: "numeric" });
  const headingId = React.useId();
  const weekdays = (weeks[0] ?? []).map((iso) => ({
    iso,
    short: calendarText(iso, locale, { weekday: "narrow" }),
    long: calendarText(iso, locale, { weekday: "long" }),
  }));
  const allowed = (iso: string) => (!min || iso >= min) && (!max || iso <= max);
  const previousMonth = shiftMonths(focused, -1);
  const nextMonth = shiftMonths(focused, 1);
  const previousAllowed = previousMonth !== null && (!min || shiftDays(month, -1)! >= min);
  const nextAllowed = nextMonth !== null && (!max || startOfMonth(nextMonth) <= max);

  React.useEffect(() => {
    if (!moveFocus.current) return;
    panelRef.current?.querySelector<HTMLElement>(`[data-date="${focused}"]`)?.focus();
  }, [focused]);

  function go(next: string | null, focusGrid: boolean) {
    if (next === null) return;
    moveFocus.current = focusGrid;
    setFocused(next);
  }

  function onGridKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    let next: string | null | undefined;
    switch (event.key) {
      case "ArrowLeft":
        next = shiftDays(focused, -1);
        break;
      case "ArrowRight":
        next = shiftDays(focused, 1);
        break;
      case "ArrowUp":
        next = shiftDays(focused, -7);
        break;
      case "ArrowDown":
        next = shiftDays(focused, 7);
        break;
      case "PageUp":
        next = shiftMonths(focused, event.shiftKey ? -12 : -1);
        break;
      case "PageDown":
        next = shiftMonths(focused, event.shiftKey ? 12 : 1);
        break;
      case "Home":
        next = startOfWeek(focused, weekStartsOn);
        break;
      case "End":
        next = endOfWeek(focused, weekStartsOn);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (allowed(focused)) onSelect(focused);
        return;
      default:
        return;
    }
    event.preventDefault();
    go(next, true);
  }

  function onPanelKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    // The calendar is portaled out of its field; keys pressed in it belong
    // to it alone, never to a grid, drawer or shortcut behind it.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusables.length === 0) return;
    event.preventDefault();
    const index = focusables.indexOf(document.activeElement as HTMLElement);
    const step = event.shiftKey ? -1 : 1;
    focusables[(index + step + focusables.length) % focusables.length]!.focus();
  }

  const navButton =
    "grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:pointer-events-none disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200";
  const todayAllowed = today !== null && allowed(today);

  return (
    <div
      ref={panelRef}
      className="w-[17rem] select-none"
      onKeyDown={onPanelKeyDown}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          className={navButton}
          aria-label={t("previousMonth")}
          disabled={!previousAllowed}
          onClick={() => go(previousMonth, false)}
        >
          <ChevronLeft aria-hidden className="h-4 w-4" />
        </button>
        <div
          id={headingId}
          aria-live="polite"
          className="text-sm font-semibold text-slate-800 dark:text-slate-100"
        >
          {monthLabel}
        </div>
        <button
          type="button"
          className={navButton}
          aria-label={t("nextMonth")}
          disabled={!nextAllowed}
          onClick={() => go(nextMonth, false)}
        >
          <ChevronRight aria-hidden className="h-4 w-4" />
        </button>
      </div>
      <div role="grid" aria-labelledby={headingId} onKeyDown={onGridKeyDown}>
        <div role="row" className="grid grid-cols-7">
          {weekdays.map((day) => (
            <div
              key={day.iso}
              role="columnheader"
              aria-label={day.long}
              className="py-1 text-center text-[11px] font-medium uppercase text-slate-400 dark:text-slate-500"
            >
              <span aria-hidden>{day.short}</span>
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} role="row" className="grid grid-cols-7">
            {week.map((iso) => {
              const inMonth = iso.slice(0, 7) === month.slice(0, 7);
              const isSelected = iso === selected;
              const isToday = iso === today;
              const enabled = allowed(iso);
              return (
                <div
                  key={iso}
                  role="gridcell"
                  data-date={iso}
                  tabIndex={iso === focused ? 0 : -1}
                  aria-selected={isSelected}
                  aria-disabled={enabled ? undefined : true}
                  aria-current={isToday ? "date" : undefined}
                  aria-label={calendarText(iso, locale, {
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                  onClick={() => {
                    if (enabled) onSelect(iso);
                  }}
                  className={cn(
                    "m-0.5 grid h-8 cursor-pointer place-items-center rounded-md text-sm tabular-nums outline-none",
                    "focus-visible:ring-2 focus-visible:ring-teal-500/60",
                    inMonth
                      ? "text-slate-800 dark:text-slate-100"
                      : "text-slate-400 dark:text-slate-500",
                    enabled
                      ? "hover:bg-slate-100 dark:hover:bg-slate-800"
                      : "cursor-not-allowed text-slate-300 line-through dark:text-slate-600",
                    isToday &&
                      !isSelected &&
                      "font-semibold text-teal-700 ring-1 ring-inset ring-teal-500/50 dark:text-teal-300",
                    isSelected &&
                      "bg-teal-600 font-semibold text-white hover:bg-teal-600 dark:bg-teal-500 dark:text-white dark:hover:bg-teal-500",
                  )}
                >
                  {Number(iso.slice(8, 10))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-end border-t border-slate-100 pt-2 dark:border-slate-800">
        <button
          type="button"
          disabled={!todayAllowed}
          onClick={() => {
            if (today !== null) onSelect(today);
          }}
          className="rounded-md px-2 py-1 text-xs font-medium text-teal-700 hover:bg-teal-50 disabled:pointer-events-none disabled:opacity-40 dark:text-teal-300 dark:hover:bg-teal-950"
        >
          {t("keys.today")}
        </button>
      </div>
    </div>
  );
}
