import { SecurityPanel } from "./security-panel";

/**
 * The native page body, moved out of `page.tsx` so the page and the widget registry share one
 * implementation. The `security-panel` widget renders it with no props — the
 * header copy is static English owned here, not loader data, the same call the
 * `query-console` spec makes.
 *
 * The wrapper is a `<div>`, not the `<main>` it used to be. The app shell
 * already renders a `<main>`, so this page was emitting a second landmark
 * inside the first — invalid, and it makes a screen reader's "skip to main"
 * ambiguous. This was the only page in the app doing it; the conformance
 * harness surfaced it by refusing to resolve `main` to one element. Fixed
 * here rather than worked around in the harness, because the harness was
 * right.
 */
export function SecurityPageContent() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-950 dark:text-white">Sign-in security</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Protect your account with an authenticator and review active browser sessions.
        </p>
      </div>
      <SecurityPanel />
    </div>
  );
}
