"use client";

// SearchSelect — a slick, mobile-first searchable select / typeahead.
//   • Desktop: anchored dropdown with a search box + keyboard nav.
//   • Mobile (<lg): an iOS/Android-style bottom sheet that slides up, with a
//     big search field and large tap targets + safe-area padding.
// Animated (framer-motion), portal'd sheet, Esc + click-out + scroll-lock.
// Supports disabled options and optgroup-style headers (via SelectOption.group).
// This is the single dropdown implementation behind both the people picker and
// the generic <Select> — there are no native <select> dropdowns in the app.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Camera, Check, ChevronDown, Loader2, Plus, ScanLine, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "./utils";
import { anchoredMenuPosition } from "./anchored-menu-position";
import { useHydrated } from "./use-hydrated";
import { useMediaQuery } from "./use-media-query";
import {
  hasExactMatch,
  matchTier,
  rankOptions,
  readRecentChoices,
  rememberRecentChoice,
} from "./search-select-ranking";
import { focusAdjacentField } from "./focus-navigation";

export type SelectOption = {
  value: string;
  label: string;
  hint?: string;
  /** Rendered greyed-out and non-selectable. */
  disabled?: boolean;
  /** Group header label (from <optgroup>); options sharing a group are batched. */
  group?: string;
  /**
   * Extra searchable text that is not displayed, such as a vendor code or an
   * account number shown separately. A keyword match ranks just below a
   * label prefix, so typing a code finds its record immediately.
   */
  keywords?: readonly string[];
};

/** Sentinel value for the inline "Create …" row; never a real option value. */
const CREATE_VALUE = "\u0000create";
/** Keys a picker never treats as typed text; `?` always opens the keyboard help. */
const NON_TEXT_KEYS = new Set([" ", "Enter", "Tab", "Escape", "?"]);

export type SearchSelectScanResult =
  | { ok: true; value: string; label?: string; unit?: string | null }
  | { ok: false; message: string; candidates?: string[] };

type BarcodeDetectorWindow = Window & {
  BarcodeDetector?: new (options?: { formats?: string[] }) => {
    detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
  };
};

/** Poll the camera for a barcode until one reads or the time runs out. */
async function detectBarcode(
  detector: { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> },
  video: HTMLVideoElement,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detections = await detector.detect(video);
    const value = detections.find((detection) => detection.rawValue)?.rawValue;
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return null;
}

export function SearchSelect({
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  disabled = false,
  clearable = false,
  emptyLabel,
  sheetTitle,
  ariaLabel,
  ariaLabelledBy,
  className,
  triggerClassName,
  searchable,
  remote = false,
  loading = false,
  statusMessage,
  statusTone = "muted",
  onSearchChange,
  invalid = false,
  id,
  scanResolver,
  advanceOnSelect = false,
  recentKey,
  onCreate,
  createLabel,
  autoFocus,
  "data-autofocus": dataAutofocus,
  arrowKeysOpen = true,
}: {
  value: string;
  onChange: (value: string, scan?: Extract<SearchSelectScanResult, { ok: true }>) => void;
  options: SelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  /** Adds a first option for the empty value (e.g. "No site"). */
  clearable?: boolean;
  emptyLabel?: string;
  /** Title shown at the top of the mobile bottom sheet. */
  sheetTitle?: string;
  ariaLabel?: string;
  /** IDs of visible labels that together name the trigger control. */
  ariaLabelledBy?: string;
  /** Classes for the outer wrapper (layout / width). */
  className?: string;
  /** Classes for the trigger button (height / text size overrides). */
  triggerClassName?: string;
  /** Force the search box on/off. Defaults to auto: shown when >7 options or any groups. */
  searchable?: boolean;
  /** Preserve server ordering and forward search text instead of filtering stale local rows. */
  remote?: boolean;
  /** Announces a remote lookup without disabling an already selected value. */
  loading?: boolean;
  /** Remote error or refinement guidance rendered below the option rows. */
  statusMessage?: string;
  /** Visual treatment for the remote status message. */
  statusTone?: "muted" | "error";
  /** Called when the in-menu search changes or resets. */
  onSearchChange?: (query: string) => void;
  /** Renders the trigger in an error state. */
  invalid?: boolean;
  id?: string;
  /** Exact keyboard-wedge or camera scan resolver. Omitted when scanning is gated off. */
  scanResolver?: (value: string) => Promise<SearchSelectScanResult>;
  /**
   * Data-entry forms: a keyboard choice (Enter or Tab) moves focus on to the
   * next field instead of returning it to this control, so a clerk types
   * "sta⏎" and is already in the next field.
   */
  advanceOnSelect?: boolean;
  /**
   * Remember choices under this key (per browser) and list them first when
   * the menu opens. Use one key per kind of record, e.g. "vendor".
   */
  recentKey?: string;
  /**
   * Inline creation: offered as the last row whenever the typed text matches
   * no option exactly. Resolve to the new value (the caller adds it to
   * `options`), or null when creation was cancelled or refused.
   */
  onCreate?: (query: string) => Promise<{ value: string; label: string } | null>;
  /** Label for the create row, e.g. q => `Create vendor "${q}"`. */
  createLabel?: (query: string) => string;
  autoFocus?: boolean;
  /** Marks the control as the form's first field for drawer initial focus. */
  "data-autofocus"?: boolean | string;
  /**
   * ↑/↓ and Alt+↓ open the closed menu. Grids turn this off so the arrows
   * move and reorder rows; F4, Enter, Space or typing still open it.
   */
  arrowKeysOpen?: boolean;
}) {
  const t = useTranslations("ui.select");
  const tCommon = useTranslations("common");
  const resolvedPlaceholder = placeholder ?? t("placeholder");
  const resolvedSearchPlaceholder = searchPlaceholder ?? t("searchPlaceholder");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  // Desktop layout ships on the server and corrects after hydration, exactly
  // like the previous effect-driven `matchMedia` copy — as an external-store
  // subscription instead of a render cascade.
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const mounted = useHydrated();
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Desktop dropdown is portaled to <body> and positioned from the trigger, so
  // it floats above any `overflow` container (e.g. the line-grid table) instead
  // of being clipped or expanding the row.
  const [pos, setPos] = useState<ReturnType<typeof anchoredMenuPosition> | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [scanFailed, setScanFailed] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // A record created inline is displayed by its own label until the caller's
  // options catch up, so the trigger never flashes the placeholder.
  const [createdOption, setCreatedOption] = useState<SelectOption | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  // The inline "Create …" row is never the default: a typo followed by
  // Enter must not create a record. Arrowing (or pointing) onto the row
  // arms it, and only then does Enter create.
  const [createArmed, setCreateArmed] = useState(false);
  const scanBuffer = useRef({ value: "", at: 0 });
  // Type-to-select on menus without a search box (≤7 options).
  const typeahead = useRef({ text: "", at: 0 });
  // Where focus goes once the menu closes: back to the trigger, onward to the
  // next field, or nowhere (a click elsewhere already moved it).
  const closeFocus = useRef<"trigger" | "next" | "previous" | "none">("trigger");
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraAvailable =
    mounted &&
    typeof window !== "undefined" &&
    Boolean((window as BarcodeDetectorWindow).BarcodeDetector);
  // Native modal dialogs make the rest of the document inert. Keep a menu
  // inside its owning dialog so its options remain visible and interactive;
  // portaling outside the scrolling content still prevents clipping.
  const [portalHost, setPortalHost] = useState<Element | null>(null);

  const noneLabel = tCommon("labels.none");
  const allOptions = useMemo(
    () => (clearable ? [{ value: "", label: emptyLabel ?? noneLabel }, ...options] : options),
    [clearable, emptyLabel, noneLabel, options],
  );
  const selected =
    options.find((o) => o.value === value) ??
    (createdOption?.value === value && value !== "" ? createdOption : undefined);
  const showEmpty = clearable && value === "" && !!emptyLabel;
  const display = selected?.label ?? (showEmpty ? emptyLabel : resolvedPlaceholder);
  const isPlaceholder = !selected && !showEmpty;

  const resolveTypedScan = async (raw: string) => {
    if (!scanResolver || disabled) return;
    const result = await scanResolver(raw);
    if (result.ok) {
      if (!allOptions.some((option) => option.value === result.value)) {
        setScanMessage(`${t("scanUnavailable")}${result.label ? `: ${result.label}` : ""}`);
        setScanFailed(true);
        return;
      }
      setScanMessage(null);
      setScanFailed(false);
      setQuery("");
      onSearchChange?.("");
      onChange(result.value, result);
      closeFocus.current = "trigger";
      setOpen(false);
      return;
    }
    const message =
      result.message === "scan_network_error"
        ? t("scanNetworkError")
        : result.message === "scan_not_found"
          ? t("scanNotFound")
          : result.message === "scan_ambiguous"
            ? t("scanAmbiguous")
            : result.message;
    const missingChoices =
      result.candidates?.filter((candidate) => !message.includes(candidate)) ?? [];
    const choices = missingChoices.length ? ` ${missingChoices.join("; ")}` : "";
    setScanMessage(`${message}${choices}`);
    setScanFailed(true);
  };

  /** Returns true when the key completed a keyboard-wedge scan. */
  // Keyboard-wedge scanners type faster than people: keys arriving within
  // 150 ms of each other (by the events' own timestamps) form one scan.
  const scannerKeyDown = (event: ReactKeyboardEvent<HTMLElement>): boolean => {
    if (!scanResolver || disabled || event.altKey || event.ctrlKey || event.metaKey) return false;
    const now = event.timeStamp;
    if (event.key === "Enter") {
      const { value, at } = scanBuffer.current;
      scanBuffer.current = { value: "", at: 0 };
      if (value.length >= 2 && now - at <= 150) {
        event.preventDefault();
        event.stopPropagation();
        void resolveTypedScan(value);
        return true;
      }
      return false;
    }
    if (event.key.length === 1) {
      const prior = scanBuffer.current;
      scanBuffer.current = {
        value: now - prior.at <= 150 ? `${prior.value}${event.key}`.slice(-200) : event.key,
        at: now,
      };
    } else if (event.key !== "Shift") {
      scanBuffer.current = { value: "", at: 0 };
    }
    return false;
  };

  const scanWithCamera = async () => {
    const Detector =
      typeof window === "undefined" ? undefined : (window as BarcodeDetectorWindow).BarcodeDetector;
    const video = videoRef.current;
    if (!Detector || !navigator.mediaDevices?.getUserMedia || !video) {
      setScanMessage(t("cameraUnavailable"));
      setScanFailed(true);
      return;
    }
    let stream: MediaStream | null = null;
    try {
      setCameraActive(true);
      setScanFailed(false);
      setScanMessage(t("scanResolving"));
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      const value = await detectBarcode(
        new Detector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39"] }),
        video,
        15000,
      );
      if (value) {
        await resolveTypedScan(value);
        return;
      }
      setScanMessage(t("cameraUnavailable"));
      setScanFailed(true);
    } catch {
      setScanMessage(t("cameraUnavailable"));
      setScanFailed(true);
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
      setCameraActive(false);
    }
  };

  const showSearch =
    searchable ??
    (Boolean(scanResolver) ||
      Boolean(onCreate) ||
      allOptions.length > 7 ||
      allOptions.some((o) => o.group));
  const place = useCallback(() => {
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const drop = dropRef.current;
    const list = listRef.current;
    // Measure unconstrained list content, so a growing result set can flip
    // above even when its current below-trigger container is constrained.
    const desiredHeight =
      drop && list
        ? Math.min(list.scrollHeight, 256) + drop.offsetHeight - list.offsetHeight
        : 258 + (showSearch ? 56 : 0);
    const next = anchoredMenuPosition(
      anchor,
      { width: window.innerWidth, height: window.innerHeight },
      desiredHeight,
    );
    setPos((previous) =>
      previous &&
      Object.keys(next).every(
        (key) => next[key as keyof typeof next] === previous[key as keyof typeof next],
      )
        ? previous
        : next,
    );
  }, [showSearch]);

  const trimmedQuery = query.trim();
  const canCreate =
    Boolean(onCreate) && trimmedQuery !== "" && !remote && !hasExactMatch(allOptions, trimmedQuery);
  // Strongest matches first; with nothing typed, recently chosen records
  // lead under their own heading and the full list follows.
  const filtered = useMemo<SelectOption[]>(() => {
    let list: SelectOption[];
    if (remote) list = allOptions;
    else if (trimmedQuery) list = rankOptions(allOptions, trimmedQuery, recent);
    else if (recent.length > 0 && !allOptions.some((o) => o.group)) {
      const byValue = new Map(allOptions.map((o) => [o.value, o]));
      const lead = recent
        .map((v) => byValue.get(v))
        .filter((o): o is SelectOption => Boolean(o) && !o!.disabled && o!.value !== "");
      if (lead.length === 0) list = allOptions;
      else {
        const leadValues = new Set(lead.map((o) => o.value));
        list = [
          ...lead.map((o) => ({ ...o, group: t("recent") })),
          ...allOptions
            .filter((o) => !leadValues.has(o.value))
            .map((o) => ({ ...o, group: t("allOptions") })),
        ];
      }
    } else list = allOptions;
    return canCreate
      ? [
          ...list,
          {
            value: CREATE_VALUE,
            label: createLabel?.(trimmedQuery) ?? t("create", { query: trimmedQuery }),
          },
        ]
      : list;
  }, [allOptions, canCreate, createLabel, recent, remote, t, trimmedQuery]);

  function firstEnabled(items: SelectOption[], start: number) {
    if (start >= 0 && start < items.length && !items[start]?.disabled) return start;
    const fwd = items.findIndex((o) => !o.disabled);
    return fwd === -1 ? 0 : fwd;
  }

  function openMenu(initialQuery = "") {
    if (disabled) return;
    setPortalHost(wrapRef.current?.closest("dialog[open]") ?? document.body);
    const nextRecent = readRecentChoices(recentKey);
    setRecent(nextRecent);
    setQuery(initialQuery);
    setScanMessage(null);
    setScanFailed(false);
    setCreateError(null);
    setCreateArmed(false);
    onSearchChange?.(initialQuery);
    closeFocus.current = "trigger";
    if (initialQuery) setHighlight(0);
    else {
      // The recent heading leads with the current value's neighbours; land
      // on the selected value when it is listed, else the first choice.
      setHighlight(
        firstEnabled(
          allOptions,
          allOptions.findIndex((o) => o.value === value),
        ),
      );
    }
    place();
    setOpen(true);
  }

  // The search box takes focus in the same commit the menu opens, so keys
  // typed in quick succession after the first (a fast typist, a scanner)
  // land in it instead of being lost on the trigger.
  const searchFocused = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      searchFocused.current = false;
      return;
    }
    const input = searchRef.current;
    if (!input || searchFocused.current) return;
    searchFocused.current = true;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange?.(end, end);
  }, [open, isDesktop, pos]);

  // After the menu closes, put focus where the closing gesture asked for it.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const target = closeFocus.current;
    closeFocus.current = "trigger";
    if (target === "none") return;
    const active = document.activeElement;
    // Only reclaim focus that the closing menu stranded (the unmounted search
    // box leaves it on <body>) or still holds; a click on another control
    // keeps its focus.
    const stranded =
      !active ||
      active === document.body ||
      active === trigger ||
      (dropRef.current?.contains(active) ?? false);
    if (!stranded) return;
    if (target === "trigger") trigger.focus();
    else if (!focusAdjacentField(trigger, target === "next" ? 1 : -1)) trigger.focus();
  }, [open]);

  function close(focus: "trigger" | "next" | "previous" | "none" = "trigger") {
    closeFocus.current = focus;
    setOpen(false);
  }

  async function createFromQuery(focus: "trigger" | "next" | "previous") {
    if (!onCreate || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await onCreate(trimmedQuery);
      if (!created) {
        searchRef.current?.focus();
        return;
      }
      setCreatedOption({ value: created.value, label: created.label });
      setRecent(rememberRecentChoice(recentKey, created.value));
      onChange(created.value);
      close(focus);
    } catch (error) {
      setCreateError(error instanceof Error && error.message ? error.message : t("createFailed"));
    } finally {
      setCreating(false);
    }
  }

  function choose(v: string, focus: "trigger" | "next" | "previous" = "trigger") {
    if (v === CREATE_VALUE) {
      void createFromQuery(focus);
      return;
    }
    if (v !== "") setRecent(rememberRecentChoice(recentKey, v));
    onChange(v);
    close(focus);
  }

  // Click-outside (desktop) — the dropdown is portaled, so check it too.
  useEffect(() => {
    if (!open || !isDesktop) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || dropRef.current?.contains(t)) return;
      close("none");
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, isDesktop]);

  // Reposition on content changes, nested drawer scrolls, and viewport resize.
  useLayoutEffect(() => {
    if (!open || !isDesktop) return;
    place();
    const observer = new ResizeObserver(place);
    if (dropRef.current) observer.observe(dropRef.current);
    if (triggerRef.current) observer.observe(triggerRef.current);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, isDesktop, place, filtered]);

  // Keep the highlighted row in view as the keyboard moves through a long list.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-option-index="${highlight}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [highlight, open]);

  // Scroll lock on the mobile sheet.
  useEffect(() => {
    if (!open || isDesktop) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isDesktop, open]);

  const nextEnabled = (from: number, dir: 1 | -1) => {
    let index = from;
    while (true) {
      index += dir;
      if (index < 0 || index >= filtered.length) return from;
      if (!filtered[index]?.disabled) return index;
    }
  };

  /**
   * Menu keys, handled where focus actually is (the search box, or the
   * trigger for short lists without one). Every key the menu consumes stops
   * here, so an enclosing grid or form never also acts on it — Enter picks
   * the option and nothing else.
   */
  function menuKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (scannerKeyDown(event)) return;
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case "Escape":
        consume();
        close("trigger");
        return;
      case "ArrowDown": {
        consume();
        if (!createArmed && filtered[highlight]?.value === CREATE_VALUE) {
          setCreateArmed(true);
          return;
        }
        const next = nextEnabled(highlight, 1);
        setCreateArmed(filtered[next]?.value === CREATE_VALUE);
        setHighlight(next);
        return;
      }
      case "ArrowUp": {
        consume();
        const next = nextEnabled(highlight, -1);
        setCreateArmed(filtered[next]?.value === CREATE_VALUE);
        setHighlight(next);
        return;
      }
      case "PageDown":
        consume();
        setHighlight((h) => Math.min(filtered.length - 1, h + 8));
        return;
      case "PageUp":
        consume();
        setHighlight((h) => Math.max(0, h - 8));
        return;
      case "Enter": {
        // ⌘/Ctrl+Enter belongs to the form (save, post): close the list
        // without choosing and let the command run.
        if (event.metaKey || event.ctrlKey) {
          consume();
          close("trigger");
          const forwarded = new KeyboardEvent("keydown", {
            key: event.key,
            code: event.code,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            bubbles: true,
            cancelable: true,
          });
          // Forward after the picker has closed, so its own key handler
          // cannot consume the form command a second time.
          requestAnimationFrame(() => {
            triggerRef.current?.focus();
            triggerRef.current?.dispatchEvent(forwarded);
          });
          return;
        }
        consume();
        const o = filtered[highlight];
        if (!o || o.disabled) return;
        if (o.value === CREATE_VALUE && !createArmed) return;
        choose(o.value, advanceOnSelect ? "next" : "trigger");
        return;
      }
      case "Tab": {
        // Tab accepts what the clerk narrowed to, as desktop accounting
        // packages do, and moves on; with nothing typed it just leaves,
        // keeping the value.
        consume();
        const direction = event.shiftKey ? "previous" : "next";
        const o = filtered[highlight];
        if (
          trimmedQuery &&
          o &&
          !o.disabled &&
          o.value !== CREATE_VALUE &&
          (matchTier(o, trimmedQuery) ?? Infinity) <= 2
        )
          choose(o.value, direction);
        else close(direction);
        return;
      }
      default:
        break;
    }
    // Short lists have no search box: printable keys jump to the first
    // option whose label starts with what was typed in quick succession.
    if (
      !showSearch &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key !== " "
    ) {
      consume();
      const now = event.timeStamp;
      const text =
        now - typeahead.current.at < 800
          ? typeahead.current.text + event.key.toLowerCase()
          : event.key.toLowerCase();
      typeahead.current = { text, at: now };
      const match = filtered.findIndex(
        (o) => !o.disabled && o.label.toLowerCase().startsWith(text),
      );
      if (match !== -1) setHighlight(match);
    }
  }

  /** Keys on the closed trigger: typing opens the menu already searching. */
  function triggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (open) {
      if (!showSearch || !searchRef.current) {
        menuKeyDown(event);
        return;
      }
      // Characters typed after the menu opened but before the search box
      // received focus still belong to the search.
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        scannerKeyDown(event);
        event.preventDefault();
        setQuery((current) => current + event.key);
        onSearchChange?.(query + event.key);
        setHighlight(0);
        return;
      }
      menuKeyDown(event);
      return;
    }
    scannerKeyDown(event);
    if (disabled || event.ctrlKey || event.metaKey) return;
    // Inside a grid the arrows (with or without Alt) belong to the grid:
    // moving between rows and reordering them. F4 still opens the list there.
    if (
      (arrowKeysOpen &&
        (event.key === "ArrowDown" || (!event.altKey && event.key === "ArrowUp"))) ||
      event.key === "F4"
    ) {
      event.preventDefault();
      event.stopPropagation();
      openMenu();
      return;
    }
    if (event.key === "Enter") {
      // Enter opens the list, never the enclosing form's or grid's Enter.
      event.preventDefault();
      event.stopPropagation();
      openMenu();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && clearable && value !== "") {
      event.preventDefault();
      event.stopPropagation();
      onChange("");
      return;
    }
    if (event.key.length === 1 && !event.altKey && !NON_TEXT_KEYS.has(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (showSearch) openMenu(event.key);
      else {
        openMenu();
        const text = event.key.toLowerCase();
        typeahead.current = { text, at: event.timeStamp };
        const match = allOptions.findIndex(
          (o) => !o.disabled && o.label.toLowerCase().startsWith(text),
        );
        if (match !== -1) setHighlight(match);
      }
    }
  }

  const optionList = (
    <>
      <ul role="listbox" className="py-1">
        {filtered.map((o, i) => {
          const isCreate = o.value === CREATE_VALUE;
          const active = !isCreate && o.value === value;
          const prevGroup = i > 0 ? filtered[i - 1]?.group : undefined;
          const header = o.group && o.group !== prevGroup ? o.group : null;
          return (
            <li key={`${o.group ?? ""}\u0000${o.value || `__opt-${i}`}`} role="presentation">
              {header ? (
                <div className="px-4 pt-2.5 pb-1 text-[11px] font-semibold tracking-wide text-slate-400 uppercase lg:px-3 dark:text-slate-500">
                  {header}
                </div>
              ) : null}
              <button
                type="button"
                role="option"
                tabIndex={-1}
                data-option-index={i}
                aria-selected={active}
                disabled={o.disabled || (isCreate && creating)}
                onMouseEnter={() => {
                  if (o.disabled) return;
                  setHighlight(i);
                  setCreateArmed(isCreate);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => !o.disabled && choose(o.value)}
                className={cn(
                  "flex h-12 w-full items-center gap-2.5 px-4 text-left text-[15px] transition-colors lg:h-9 lg:px-3 lg:text-sm",
                  isCreate &&
                    "border-t border-slate-100 text-teal-700 dark:border-slate-800 dark:text-teal-300",
                  o.disabled
                    ? "cursor-not-allowed text-slate-300 dark:text-slate-600"
                    : i === highlight && (!isCreate || createArmed)
                      ? "bg-teal-50 dark:bg-teal-950/50"
                      : "active:bg-slate-100 dark:active:bg-slate-700",
                  !o.disabled &&
                    !isCreate &&
                    (active
                      ? "font-medium text-teal-900 dark:text-teal-300"
                      : "text-slate-700 dark:text-slate-200"),
                )}
              >
                {isCreate ? (
                  creating ? (
                    <Loader2 size={15} className="shrink-0 animate-spin" />
                  ) : (
                    <Plus size={15} className="shrink-0" />
                  )
                ) : null}
                <span className="min-w-0 flex-1 truncate">
                  {o.label}
                  {o.hint ? (
                    <span className="ml-1.5 text-xs text-slate-400 dark:text-slate-500">
                      {o.hint}
                    </span>
                  ) : null}
                </span>
                {active ? <Check size={17} className="shrink-0 text-teal-600" /> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {filtered.length === 0 && !loading ? (
        <div
          role="status"
          className="px-3 py-8 text-center text-sm text-slate-400 dark:text-slate-500"
        >
          {t("noMatches")}
        </div>
      ) : null}
      {loading || statusMessage || scanMessage || createError ? (
        <div
          role={scanFailed || createError || statusTone === "error" ? "alert" : "status"}
          className={cn(
            "border-t border-slate-100 px-3 py-2 text-xs dark:border-slate-800",
            scanFailed || createError || statusTone === "error"
              ? "text-red-600 dark:text-red-400"
              : "text-slate-500 dark:text-slate-400",
          )}
        >
          {loading ? t("searching") : (createError ?? scanMessage ?? statusMessage)}
        </div>
      ) : null}
    </>
  );

  const searchBox = (largeText: boolean) => (
    <div className="relative flex items-center gap-2 px-3 pt-3">
      <div className="relative min-w-0 flex-1">
        <Search
          size={16}
          className="absolute top-1/2 left-3 -translate-y-1/2 text-slate-400 dark:text-slate-500"
        />
        <input
          ref={searchRef}
          value={query}
          onKeyDown={menuKeyDown}
          onChange={(e) => {
            const next = e.target.value;
            setQuery(next);
            onSearchChange?.(next);
            setHighlight(0);
            setCreateArmed(false);
            setCreateError(null);
          }}
          placeholder={resolvedSearchPlaceholder}
          aria-label={resolvedSearchPlaceholder}
          aria-busy={loading || undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          className={cn(
            "w-full rounded-lg border border-slate-200 bg-slate-50 pr-3 pl-9 transition outline-none focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-500/20 dark:border-slate-800 dark:bg-slate-900 dark:focus:bg-slate-900",
            // 16px below sm — anything smaller makes iOS Safari zoom on focus.
            largeText ? "h-11 text-base" : "h-9 text-base sm:text-sm",
          )}
        />
      </div>
      {scanResolver ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("scan")}
          title={t("scan")}
          onClick={() => {
            searchRef.current?.focus();
            setScanMessage(null);
            setScanFailed(false);
          }}
          className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <ScanLine size={15} />
          {t("scan")}
        </button>
      ) : null}
      {scanResolver && cameraAvailable ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("scanCamera")}
          title={t("scanCamera")}
          disabled={cameraActive}
          onClick={() => void scanWithCamera()}
          className="inline-flex h-9 shrink-0 items-center rounded-lg border border-slate-200 px-2 text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <Camera size={16} />
        </button>
      ) : null}
      {scanResolver && cameraAvailable ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className={
            cameraActive
              ? "absolute right-3 top-14 z-10 max-h-32 w-40 rounded-lg border border-slate-300 bg-black object-cover dark:border-slate-700"
              : "hidden"
          }
        />
      ) : null}
    </div>
  );

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        autoFocus={autoFocus}
        data-autofocus={dataAutofocus ? "" : undefined}
        onKeyDown={triggerKeyDown}
        onClick={() => (open ? close("trigger") : openMenu())}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-10 w-full items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-left text-sm shadow-sm transition dark:border-slate-700 dark:bg-slate-900",
          "focus:border-teal-500 focus:ring-2 focus:ring-teal-500/25 focus:outline-none",
          disabled && "cursor-not-allowed bg-slate-50 opacity-70 dark:bg-slate-800",
          open && "border-teal-500 ring-2 ring-teal-500/25",
          invalid && "border-red-400 focus:border-red-500 focus:ring-red-500/30",
          triggerClassName,
        )}
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            isPlaceholder
              ? "text-slate-400 dark:text-slate-500"
              : "text-slate-800 dark:text-slate-100",
          )}
        >
          {display}
        </span>
        <ChevronDown
          size={16}
          className={cn(
            "shrink-0 text-slate-400 transition-transform dark:text-slate-500",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Desktop dropdown — portaled outside the scrolling content and positioned from the
          trigger so it floats above any overflow container (e.g. the line grid)
          rather than being clipped or expanding the row. */}
      {mounted && open && isDesktop && pos
        ? createPortal(
            <div
              ref={dropRef}
              data-ui-overlay
              style={{ position: "fixed", ...pos }}
              className="z-[60] flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900"
            >
              {showSearch ? searchBox(false) : null}
              <div
                ref={listRef}
                className={cn("min-h-0 max-h-64 overflow-y-auto", showSearch && "mt-1")}
              >
                {optionList}
              </div>
            </div>,
            portalHost ?? document.body,
          )
        : null}

      {/* Mobile bottom sheet */}
      {mounted && !isDesktop
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <div data-ui-overlay className="fixed inset-0 z-[60]">
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
                    onClick={() => close("none")}
                  />
                  <motion.div
                    initial={{ y: "100%" }}
                    animate={{ y: 0 }}
                    exit={{ y: "100%" }}
                    transition={{ type: "spring", damping: 34, stiffness: 340, mass: 0.8 }}
                    className="absolute inset-x-0 bottom-0 flex max-h-[82vh] flex-col rounded-t-2xl border-t border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
                    onKeyDown={showSearch ? undefined : menuKeyDown}
                  >
                    <div className="flex items-center justify-center pt-2.5">
                      <span className="h-1.5 w-10 rounded-full bg-slate-300" />
                    </div>
                    <div className="flex items-center justify-between px-4 pt-2 pb-1">
                      <span className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        {sheetTitle ?? tCommon("actions.select")}
                      </span>
                      <button
                        type="button"
                        onClick={() => close("none")}
                        aria-label={tCommon("actions.close")}
                        className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                      >
                        <X size={18} />
                      </button>
                    </div>
                    {showSearch ? searchBox(true) : null}
                    <div
                      ref={listRef}
                      className="mt-1 min-h-0 flex-1 overflow-y-auto pb-[max(0.75rem,env(safe-area-inset-bottom))]"
                    >
                      {optionList}
                    </div>
                  </motion.div>
                </div>
              ) : null}
            </AnimatePresence>,
            portalHost ?? document.body,
          )
        : null}
    </div>
  );
}
