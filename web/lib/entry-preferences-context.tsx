"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_ENTRY_PREFERENCES, type EntryPreferences } from "./entry-preferences";

interface EntryPreferencesValue {
  preferences: EntryPreferences;
  /** Persist a change for the signed-in person; resolves false when the server refused it. */
  update: (patch: Partial<EntryPreferences>) => Promise<boolean>;
}

const EntryPreferencesContext = createContext<EntryPreferencesValue>({
  preferences: DEFAULT_ENTRY_PREFERENCES,
  update: async () => false,
});

/**
 * Provides the signed-in person's data-entry preferences to every form. The
 * shell renders it once with the values read on the server, so the first
 * keystroke already behaves the way the person chose.
 */
export function EntryPreferencesProvider({
  initial,
  children,
}: {
  initial: EntryPreferences;
  children: ReactNode;
}) {
  const [preferences, setPreferences] = useState(initial);
  const update = useCallback(async (patch: Partial<EntryPreferences>) => {
    let response: Response;
    try {
      response = await fetch("/api/me/entry-preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch {
      return false;
    }
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as {
      preferences?: EntryPreferences;
    } | null;
    if (body?.preferences) setPreferences(body.preferences);
    return Boolean(body?.preferences);
  }, []);
  const value = useMemo(() => ({ preferences, update }), [preferences, update]);
  return (
    <EntryPreferencesContext.Provider value={value}>{children}</EntryPreferencesContext.Provider>
  );
}

export function useEntryPreferences(): EntryPreferencesValue {
  return useContext(EntryPreferencesContext);
}
