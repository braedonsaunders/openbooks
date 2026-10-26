import { DATE_ENTRY_KEYS } from "../../lib/date-entry";
import type { ShortcutBinding } from "./shortcut-keys";

export interface ShortcutReference {
  id: string;
  labelKey: string;
  labelValueKey?: string;
  editorBinding?: { key?: string; mac?: string; win?: string; linux?: string };
  binding?: ShortcutBinding;
  keys?: readonly string[];
  appleKeys?: readonly string[];
  separator?: string;
}
export interface ShortcutReferenceGroup {
  id: string;
  entries: readonly ShortcutReference[];
}

const chord = (code: string): ShortcutBinding => ({ modifier: "chord", code });
const primary = (code: string, shift = false): ShortcutBinding => ({
  modifier: "primary",
  code,
  ...(shift ? { shift } : {}),
});
const item = (id: string, labelKey: string, binding: ShortcutBinding): ShortcutReference => ({
  id,
  labelKey,
  binding,
});
const keys = (
  id: string,
  labelKey: string,
  value: string[],
  appleKeys?: string[],
  separator?: string,
): ShortcutReference => ({ id, labelKey, keys: value, appleKeys, separator });
const ref = (id: string) => `shell.shortcuts.reference.actions.${id}`;
const command = (id: string) => `shell.shortcuts.commands.${id}`;
const entry = (id: string) => `entry.keys.${id}`;

/** Shared command definitions keep the full reference aligned with command registration. */
export const GLOBAL_CREATE_SHORTCUTS = [
  { id: "newInvoice", create: "invoice", code: "KeyI" },
  { id: "newBill", create: "bill", code: "KeyB" },
  { id: "newJournal", create: "journal", code: "KeyJ" },
  { id: "newExpense", create: "expense", code: "KeyX" },
  { id: "newCustomerPayment", create: "customerPayment", code: "KeyR" },
] as const;
export const GLOBAL_GO_SHORTCUTS = [
  { id: "goDashboard", href: "/dashboard", code: "KeyH" },
  { id: "goReports", href: "/reports", code: "KeyP" },
  { id: "goBanking", href: "/banking", code: "KeyK" },
] as const;
export const FORM_SHORTCUT_BINDINGS = {
  save: primary("KeyS"),
  saveAndNew: chord("KeyS"),
  saveAndClose: chord("KeyD"),
  postAndNew: primary("Enter"),
  post: primary("Enter", true),
  addLine: chord("KeyG"),
  recallLast: chord("KeyL"),
} as const;

/** Reference entries describe their owning surface; they do not grant permission or register commands. */
export const SHORTCUT_REFERENCE_GROUPS: readonly ShortcutReferenceGroup[] = [
  {
    id: "global",
    entries: [
      item("help", command("help"), { character: "?" }),
      item("search", command("search"), primary("KeyK")),
      item("fieldHelp", command("fieldHelp"), { modifier: "none", code: "F1" }),
      ...GLOBAL_CREATE_SHORTCUTS.map((key) => item(key.id, command(key.id), chord(key.code))),
      ...GLOBAL_GO_SHORTCUTS.map((key) => item(key.id, command(key.id), chord(key.code))),
    ],
  },
  {
    id: "forms",
    entries: [
      ...Object.entries(FORM_SHORTCUT_BINDINGS).map(([id, binding]) =>
        item(id, command(id === "post" ? "postRecord" : id), binding),
      ),
      keys("nextField", ref("nextField"), ["Tab"]),
      keys("previousField", ref("previousField"), ["Shift", "Tab"], ["⇧", "Tab"]),
      keys("activate", ref("activate"), ["Enter", "Space"], undefined, "/"),
      keys("close", ref("close"), ["Esc"]),
    ],
  },
  {
    id: "lines",
    entries: [
      keys("gridEnter", entry("gridEnter"), ["Enter"]),
      keys("gridShiftEnter", entry("gridShiftEnter"), ["Shift", "Enter"], ["⇧", "Enter"]),
      keys("gridArrows", entry("gridArrows"), ["↑", "↓"], undefined, "/"),
      keys("gridTab", entry("gridTab"), ["Tab"]),
      keys("gridInsertBelow", entry("gridInsertBelow"), ["Alt", "Enter"], ["⌥", "Enter"]),
      keys(
        "gridInsertAbove",
        entry("gridInsertAbove"),
        ["Alt", "Shift", "Enter"],
        ["⌥", "⇧", "Enter"],
      ),
      keys("copyAboveF8", entry("gridCopyAbove"), ["F8"]),
      item("copyAboveQuote", entry("gridCopyAbove"), primary("Quote")),
      item("duplicate", entry("gridDuplicate"), primary("KeyD")),
      item("remove", entry("gridRemove"), primary("Backspace")),
      keys("move", entry("gridMove"), ["Alt", "↑/↓"], ["⌥", "↑/↓"]),
      keys("menu", entry("gridMenu"), ["Shift", "F10"], ["⇧", "F10"]),
      keys("menuKey", entry("gridMenu"), ["ContextMenu"]),
      item("paste", entry("gridPaste"), primary("KeyV")),
      keys("math", entry("amountMath"), ["+", "−", "×", "÷"], undefined, "/"),
    ],
  },
  {
    id: "pickers",
    entries: [
      keys("type", entry("pickerType"), ["A–Z", "0–9"], undefined, "/"),
      keys("open", ref("pickerOpen"), ["Enter", "Space", "F4"], undefined, "/"),
      keys("openArrow", ref("pickerOpenArrow"), ["↑", "↓", "Alt+↓"], ["↑", "↓", "⌥↓"], "/"),
      keys("choose", ref("choose"), ["Enter"]),
      keys("tab", entry("pickerTab"), ["Tab"]),
      keys("previous", ref("pickerPrevious"), ["Shift", "Tab"], ["⇧", "Tab"]),
      keys("arrows", ref("optionsMove"), ["↑", "↓"], undefined, "/"),
      keys("pages", ref("optionsPage"), ["PageUp", "PageDown"], undefined, "/"),
      keys("close", entry("pickerClose"), ["Esc"]),
      keys("create", entry("pickerCreate"), ["↓", "Enter"], undefined, "→"),
      keys("clear", entry("pickerClear"), ["Delete", "Backspace"], undefined, "/"),
    ],
  },
  {
    id: "dates",
    entries: [
      ...DATE_ENTRY_KEYS.map((date) =>
        keys(
          date.command,
          `shell.dateEntry.keys.${date.command}`,
          date.keys.map((key) => key.toUpperCase()),
          undefined,
          "/",
        ),
      ),
      keys("commit", ref("dateCommit"), ["Enter", "Tab"], undefined, "/"),
      keys("revert", ref("dateRevert"), ["Esc"]),
      keys("calendar", "shell.dateEntry.calendarKey", ["Alt", "↓"], ["⌥", "↓"]),
    ],
  },
  {
    id: "calendar",
    entries: [
      keys("days", ref("calendarDay"), ["←", "→"], undefined, "/"),
      keys("weeks", ref("calendarWeek"), ["↑", "↓"], undefined, "/"),
      keys("months", ref("calendarMonth"), ["PageUp", "PageDown"], undefined, "/"),
      keys(
        "years",
        ref("calendarYear"),
        ["Shift+PageUp", "Shift+PageDown"],
        ["⇧PageUp", "⇧PageDown"],
        "/",
      ),
      keys("weekStart", ref("calendarStart"), ["Home"]),
      keys("weekEnd", ref("calendarEnd"), ["End"]),
      keys("select", ref("choose"), ["Enter", "Space"], undefined, "/"),
      keys("close", ref("close"), ["Esc"]),
      keys("cycle", ref("calendarCycle"), ["Tab", "Shift+Tab"], ["Tab", "⇧Tab"], "/"),
    ],
  },
  {
    id: "lists",
    entries: [
      item("next", "entry.bulk.keys.next", { character: "j" }),
      item("previous", "entry.bulk.keys.previous", { character: "k" }),
      item("toggle", "entry.bulk.keys.toggle", { character: "x" }),
      item("extend", "entry.bulk.keys.extend", { character: "X" }),
      keys("open", ref("openRecord"), ["Enter", "Space"], undefined, "/"),
    ],
  },
  {
    id: "capture",
    entries: [
      item("next", "apInbox.keyboard.next", { character: "j" }),
      item("previous", "apInbox.keyboard.previous", { character: "k" }),
      item("nextField", "apInbox.keyboard.next", { modifier: "alt", code: "ArrowDown" }),
      item("previousField", "apInbox.keyboard.previous", { modifier: "alt", code: "ArrowUp" }),
      item("draft", "apInbox.keyboard.createDraft", primary("Enter")),
      item("post", "apInbox.keyboard.createAndPost", primary("Enter", true)),
      item("reject", "apInbox.keyboard.reject", primary("Backspace")),
      keys("attention", ref("captureAttention"), ["Enter"]),
    ],
  },
  {
    id: "batch",
    entries: [
      item("save", "batchEntry.shortcuts.saveAll", primary("KeyS")),
      item("post", "batchEntry.shortcuts.postAll", primary("Enter")),
    ],
  },
  {
    id: "scheduling",
    entries: [
      keys("move", ref("scheduleMove"), ["↑", "↓", "←", "→"], undefined, "/"),
      keys("extend", ref("scheduleExtend"), ["Shift", "↑/↓/←/→"], ["⇧", "↑/↓/←/→"]),
      item("edge", ref("scheduleEdge"), primary("ArrowLeft")),
      item("edgeRight", ref("scheduleEdge"), primary("ArrowRight")),
      item("edgeUp", ref("scheduleEdge"), primary("ArrowUp")),
      item("edgeDown", ref("scheduleEdge"), primary("ArrowDown")),
      keys("tab", ref("scheduleTab"), ["Tab", "Shift+Tab"], ["Tab", "⇧Tab"], "/"),
      keys("edit", ref("scheduleEdit"), ["Enter", "F2"], undefined, "/"),
      keys("details", "scheduling.menu.details", ["Shift", "Enter"], ["⇧", "Enter"]),
      keys("type", ref("scheduleType"), ["A–Z", "0–9"], undefined, "/"),
      item("all", ref("selectAll"), primary("KeyA")),
      item("down", "scheduling.menu.fillDown", primary("KeyD")),
      item("right", "scheduling.menu.fillRight", primary("KeyR")),
      item("copy", "scheduling.menu.copy", primary("KeyC")),
      item("cut", "scheduling.menu.cut", primary("KeyX")),
      item("paste", "scheduling.menu.paste", primary("KeyV")),
      keys("clear", "scheduling.menu.clear", ["Delete", "Backspace"], undefined, "/"),
      item("undo", "scheduling.toolbar.undo", primary("KeyZ")),
      item("redo", "scheduling.toolbar.redo", primary("KeyZ", true)),
      item("redoY", "scheduling.toolbar.redo", primary("KeyY")),
      keys("collapse", ref("scheduleCollapse"), ["Esc"]),
    ],
  },
  {
    id: "triage",
    entries: [
      keys("next", ref("triageNext"), ["j"]),
      keys("previous", ref("triagePrevious"), ["k"]),
      keys("open", ref("openRecord"), ["Enter"]),
      keys("select", ref("triageSelect"), ["x"]),
      keys("apply", ref("triageApply"), ["a"]),
      keys("dismiss", ref("triageDismiss"), ["d"]),
      keys("review", "agents.triage.review", ["s"]),
      keys("clear", "agents.triage.clear", ["Esc"]),
    ],
  },
  {
    id: "navigation",
    entries: [
      keys("tab", ref("nextField"), ["Tab"]),
      keys("back", ref("previousField"), ["Shift", "Tab"], ["⇧", "Tab"]),
      keys("arrows", ref("menuMove"), ["↑", "↓"], undefined, "/"),
      keys("first", ref("firstOption"), ["Home"]),
      keys("last", ref("lastOption"), ["End"]),
      keys("submenus", ref("submenu"), ["→"]),
      keys("tabs", ref("tabMove"), ["←", "→"], undefined, "/"),
      keys("choose", ref("activate"), ["Enter", "Space"], undefined, "/"),
      keys("close", ref("close"), ["Esc"]),
      keys("tag", ref("tagAdd"), ["Enter", ","], undefined, "/"),
      keys("tagRemove", ref("tagRemove"), ["Backspace"]),
    ],
  },
  {
    id: "query",
    entries: [
      item("run", ref("queryRun"), primary("Enter")),
      keys("indent", ref("queryIndent"), ["Tab"]),
      keys("snippet", ref("querySnippet"), ["Enter"]),
      keys("report", ref("reportApply"), ["Enter"]),
    ],
  },
  {
    id: "assistant",
    entries: [
      keys("send", ref("chatSend"), ["Enter"]),
      keys("newline", ref("chatNewline"), ["Shift", "Enter"], ["⇧", "Enter"]),
      keys("rename", ref("renameSave"), ["Enter"]),
      keys("cancel", ref("renameCancel"), ["Esc"]),
    ],
  },
];
