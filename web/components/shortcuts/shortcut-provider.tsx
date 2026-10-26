"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import {
  availableShortcuts,
  currentPlatform,
  isApplePlatform,
  resolveShortcut,
  type RegisteredShortcut,
  type ShortcutCommand,
} from "./shortcut-keys";
import { ShortcutHelpSheet } from "./shortcut-help-sheet";
import { openFocusedFieldHelp } from "./field-help";

interface ShortcutEntry {
  order: number;
  read: () => ShortcutCommand | null;
}

interface ShortcutRegistry {
  register: (read: () => ShortcutCommand | null) => () => void;
  openHelp: (target?: Element | null) => void;
  apple: boolean;
}

const ShortcutContext = createContext<ShortcutRegistry | null>(null);

const subscribeNever = () => () => {};

/** Whether the viewer is on an Apple platform; false during server render. */
function useApplePlatform(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => isApplePlatform(currentPlatform()),
    () => false,
  );
}

function snapshot(entries: Iterable<ShortcutEntry>): RegisteredShortcut[] {
  const commands: RegisteredShortcut[] = [];
  for (const entry of entries) {
    const command = entry.read();
    if (command) commands.push({ ...command, order: entry.order });
  }
  return commands;
}

/**
 * The application's keyboard shortcut registry. Surfaces register commands
 * with `useShortcuts`; one document listener resolves each key press to the
 * winning command (form over page over global, innermost container, latest
 * registration) and `?` opens the help sheet listing what is available
 * where focus stands.
 */
export function ShortcutProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("shell.shortcuts");
  const entries = useRef(new Set<ShortcutEntry>());
  const sequence = useRef(0);
  const apple = useApplePlatform();
  const [help, setHelp] = useState<{ commands: RegisteredShortcut[] } | null>(null);

  const register = useCallback((read: () => ShortcutCommand | null) => {
    const entry: ShortcutEntry = { order: ++sequence.current, read };
    entries.current.add(entry);
    return () => {
      entries.current.delete(entry);
    };
  }, []);

  const openHelp = useCallback((target: Element | null = null) => {
    setHelp({ commands: availableShortcuts(snapshot(entries.current), target) });
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const command = resolveShortcut(
        snapshot(entries.current),
        event,
        isApplePlatform(currentPlatform()),
      );
      if (!command) return;
      event.preventDefault();
      // Any other command acts on the application: the help sheet steps aside.
      if (command.id !== "help") setHelp(null);
      command.run();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const registry = useMemo<ShortcutRegistry>(
    () => ({ register, openHelp, apple }),
    [register, openHelp, apple],
  );

  return (
    <ShortcutContext.Provider value={registry}>
      <HelpShortcut
        label={t("commands.help")}
        fieldHelpLabel={t("commands.fieldHelp")}
        onOpen={openHelp}
      />
      {children}
      <ShortcutHelpSheet
        open={help !== null}
        commands={help?.commands ?? []}
        apple={apple}
        onClose={() => setHelp(null)}
      />
    </ShortcutContext.Provider>
  );
}

function HelpShortcut({
  label,
  fieldHelpLabel,
  onOpen,
}: {
  label: string;
  fieldHelpLabel: string;
  onOpen: (target: Element | null) => void;
}) {
  useShortcuts([
    {
      id: "help",
      label,
      binding: { character: "?" },
      scope: "global",
      run: () => onOpen(document.activeElement),
    },
    {
      id: "fieldHelp",
      label: fieldHelpLabel,
      binding: { modifier: "none", code: "F1" },
      scope: "global",
      allowInEditable: true,
      // A field without help falls back to the shortcut sheet, so F1 always answers.
      run: () => {
        if (!openFocusedFieldHelp(document.activeElement)) onOpen(document.activeElement);
      },
    },
  ]);
  return null;
}

function signature(commands: readonly ShortcutCommand[]): string {
  return commands.map((command) => `${command.id}:${command.scope}`).join("|");
}

/**
 * Register commands for as long as the calling component is mounted.
 * Labels, handlers and predicates are read at key time, so passing fresh
 * closures every render is safe; the registration itself changes only when
 * the set of ids or scopes does. Outside a ShortcutProvider this is a no-op.
 */
export function useShortcuts(commands: readonly ShortcutCommand[]): void {
  const registry = useContext(ShortcutContext);
  const latest = useRef(commands);
  useLayoutEffect(() => {
    latest.current = commands;
  });
  const key = signature(commands);
  useEffect(() => {
    if (!registry || key === "") return;
    const ids = key.split("|").map((part) => part.slice(0, part.lastIndexOf(":")));
    const releases = ids.map((id) =>
      registry.register(() => latest.current.find((command) => command.id === id) ?? null),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [registry, key]);
}

/** Opens the help sheet from a menu entry; null outside a ShortcutProvider. */
export function useShortcutHelp(): ((target?: Element | null) => void) | null {
  return useContext(ShortcutContext)?.openHelp ?? null;
}

/** Whether key caps should render with Apple glyphs. */
export function useShortcutPlatform(): boolean {
  return useContext(ShortcutContext)?.apple ?? false;
}
