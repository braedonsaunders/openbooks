/**
 * Keyboard shortcut bindings and resolution.
 *
 * Bindings match the physical key (`KeyboardEvent.code`) so a chord works
 * the same on every keyboard layout and is not swallowed by macOS Option
 * dead keys. Three modifier conventions keep clear of browser and OS
 * commands:
 *
 * - `chord`: Ctrl+Alt (⌃⌥ on macOS) for application commands;
 * - `primary`: ⌘ on macOS, Ctrl elsewhere, for the few editor conventions
 *   people expect (Save, Search);
 * - `none`: an unmodified non-text key (F1, F8) for entry aids that must
 *   work while typing in a field;
 * - `alt`: Alt (⌥) with a non-text key such as an arrow, for moving between
 *   records in a review queue;
 * - a bare character (`?`) for the help sheet, matched on the produced
 *   character because its physical key differs between layouts.
 *
 * Windows reports AltGr as Ctrl+Alt. An AltGr press types a character on
 * many layouts, so it never matches a chord.
 */

export type ShortcutScope = "global" | "page" | "form";

export type ShortcutBinding =
  | { modifier: "chord" | "primary" | "none" | "alt"; code: string; shift?: boolean }
  | { character: string };

export interface ShortcutCommand {
  /** Stable identifier; a later registration with the same id replaces the earlier one in the help sheet. */
  id: string;
  /**
   * Localized label shown in the help sheet. A function is read only when
   * the sheet opens, so surfaces embedded everywhere resolve no copy per render.
   */
  label: string | (() => string);
  binding: ShortcutBinding;
  scope: ShortcutScope;
  run: () => void;
  /** Evaluated at key time; a disabled command neither runs nor appears in the help sheet. */
  enabled?: () => boolean;
  /**
   * The element a form- or page-scoped command belongs to. The command is
   * active while focus is inside it, or while nothing in particular holds
   * focus. When several active commands share a binding and scope, the one
   * whose container is innermost wins.
   */
  container?: () => Element | null;
  /**
   * Fire even while an editable field has focus. Only for bindings that
   * cannot type text (primary-modifier commands, and chords, which still
   * yield to AltGr). Global commands without it stay quiet while typing.
   */
  allowInEditable?: boolean;
}

export interface RegisteredShortcut extends ShortcutCommand {
  /** Registration sequence; later registrations win ties. */
  order: number;
}

const SCOPE_RANK: Record<ShortcutScope, number> = { form: 3, page: 2, global: 1 };

export const SCOPE_ORDER: readonly ShortcutScope[] = ["form", "page", "global"];

export function shortcutLabel(command: Pick<ShortcutCommand, "label">): string {
  return typeof command.label === "function" ? command.label() : command.label;
}

export function isApplePlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The platform string the browser reports, preferring client hints. */
export function currentPlatform(): string {
  if (typeof navigator === "undefined") return "";
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
    ?.platform;
  return hinted || navigator.platform || "";
}

type KeyEventLike = Pick<
  KeyboardEvent,
  "code" | "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey"
> & {
  getModifierState?: (key: string) => boolean;
};

export function bindingMatches(
  binding: ShortcutBinding,
  event: KeyEventLike,
  apple: boolean,
): boolean {
  if ("character" in binding) {
    return event.key === binding.character && !event.ctrlKey && !event.metaKey && !event.altKey;
  }
  if (event.code !== binding.code || event.shiftKey !== (binding.shift === true)) return false;
  if (binding.modifier === "chord") {
    if (event.getModifierState?.("AltGraph")) return false;
    return event.ctrlKey && event.altKey && !event.metaKey;
  }
  if (binding.modifier === "none") return !event.ctrlKey && !event.altKey && !event.metaKey;
  if (binding.modifier === "alt") {
    if (event.getModifierState?.("AltGraph")) return false;
    return event.altKey && !event.ctrlKey && !event.metaKey;
  }
  return apple
    ? event.metaKey && !event.ctrlKey && !event.altKey
    : event.ctrlKey && !event.metaKey && !event.altKey;
}

/** True for targets where a keystroke is text entry. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (element as HTMLInputElement).type;
    return ![
      "button",
      "checkbox",
      "radio",
      "reset",
      "submit",
      "image",
      "file",
      "range",
      "color",
    ].includes(type);
  }
  return element.closest('[contenteditable=""],[contenteditable="true"]') !== null;
}

function focusIsUnclaimed(target: Element | null): boolean {
  return !target || target === document.body || target === document.documentElement;
}

/** The container a command is scoped to while it is connected to the document. */
function liveContainer(command: ShortcutCommand): Element | null | undefined {
  if (!command.container) return undefined;
  const element = command.container();
  return element && element.isConnected ? element : null;
}

/** Whether the command may act on a key event aimed at `target`. */
export function commandIsActive(command: ShortcutCommand, target: Element | null): boolean {
  if (command.enabled && !command.enabled()) return false;
  const container = liveContainer(command);
  if (container === null) return false;
  // A key aimed into an open menu, popover or confirmation belongs to that
  // overlay; only commands scoped inside it may act.
  const overlay = target?.closest("[data-ui-overlay]:not([data-overlay-exiting])") ?? null;
  if (overlay && !(container && overlay.contains(container))) return false;
  if (container === undefined) return true;
  return container.contains(target) || focusIsUnclaimed(target);
}

function precedes(a: RegisteredShortcut, b: RegisteredShortcut): boolean {
  if (SCOPE_RANK[a.scope] !== SCOPE_RANK[b.scope]) return SCOPE_RANK[a.scope] > SCOPE_RANK[b.scope];
  const containerA = liveContainer(a);
  const containerB = liveContainer(b);
  if (containerA && containerB && containerA !== containerB) {
    if (containerB.contains(containerA)) return true;
    if (containerA.contains(containerB)) return false;
  }
  return a.order > b.order;
}

/**
 * The command a key event triggers: matching binding, active for the event
 * target, and allowed in editable fields when the target is one. Form scope
 * beats page scope beats global; within a scope the innermost container,
 * then the latest registration, wins.
 */
export function resolveShortcut(
  commands: Iterable<RegisteredShortcut>,
  event: KeyEventLike & { target: EventTarget | null },
  apple: boolean,
): RegisteredShortcut | null {
  const target = event.target instanceof Element ? event.target : null;
  const editable = isEditableTarget(event.target);
  let best: RegisteredShortcut | null = null;
  for (const command of commands) {
    if (!bindingMatches(command.binding, event, apple)) continue;
    if (editable && !command.allowInEditable) continue;
    if (
      editable &&
      "code" in command.binding &&
      command.binding.modifier === "chord" &&
      producesText(event, command.binding.code)
    )
      continue;
    if (!commandIsActive(command, target)) continue;
    if (!best || precedes(command, best)) best = command;
  }
  return best;
}

/**
 * A chord whose key still produced a different character (a layout that
 * maps Ctrl+Alt+letter to text) is typing, not a command.
 */
function producesText(event: KeyEventLike, code: string): boolean {
  if (event.key.length !== 1) return false;
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  const expected = (letter ?? digit)?.toLowerCase();
  return expected !== undefined && event.key.toLowerCase() !== expected;
}

/**
 * Commands available for the help sheet: enabled, active for the element
 * that held focus, one entry per id (the winning registration).
 */
export function availableShortcuts(
  commands: Iterable<RegisteredShortcut>,
  target: Element | null,
): RegisteredShortcut[] {
  const byId = new Map<string, RegisteredShortcut>();
  for (const command of commands) {
    if (!commandIsActive(command, target)) continue;
    const existing = byId.get(command.id);
    if (!existing || precedes(command, existing)) byId.set(command.id, command);
  }
  return [...byId.values()].sort((a, b) => a.order - b.order);
}

const CODE_LABELS: Record<string, string> = {
  Slash: "/",
  Enter: "Enter",
  Escape: "Esc",
  Space: "Space",
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Quote: "'",
  Backspace: "⌫",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

function codeLabel(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter) return letter;
  const digit = /^Digit([0-9])$/.exec(code)?.[1];
  if (digit) return digit;
  return CODE_LABELS[code] ?? code;
}

/**
 * The key caps a binding is pressed with, in platform order: ⌃ ⌥ ⇧ ⌘ glyphs
 * on Apple platforms, Ctrl / Alt / Shift words elsewhere.
 */
export function bindingKeys(binding: ShortcutBinding, apple: boolean): string[] {
  if ("character" in binding) return [binding.character];
  const keys: string[] = [];
  if (binding.modifier === "chord") keys.push(...(apple ? ["⌃", "⌥"] : ["Ctrl", "Alt"]));
  else if (binding.modifier === "primary") keys.push(apple ? "⌘" : "Ctrl");
  else if (binding.modifier === "alt") keys.push(apple ? "⌥" : "Alt");
  if (binding.shift) keys.push(apple ? "⇧" : "Shift");
  keys.push(codeLabel(binding.code));
  return keys;
}

/** The `aria-keyshortcuts` value for a binding (WAI-ARIA key names). */
export function ariaKeyShortcut(binding: ShortcutBinding, apple: boolean): string {
  if ("character" in binding) return binding.character;
  const parts: string[] =
    binding.modifier === "chord"
      ? ["Control", "Alt"]
      : binding.modifier === "none"
        ? []
        : binding.modifier === "alt"
          ? ["Alt"]
          : [apple ? "Meta" : "Control"];
  if (binding.shift) parts.push("Shift");
  parts.push(codeLabel(binding.code));
  return parts.join("+");
}
