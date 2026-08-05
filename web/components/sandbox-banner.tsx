import { exitSandbox } from "../lib/sandbox-session";

/**
 * Persistent sandbox banner. Rendered by the app layout whenever the session is
 * inside a sandbox, so a user can never mistake a sandbox for production. The
 * exit button clears the env cookie via a server action.
 */
export function SandboxBanner({
  name,
  kind = "sandbox",
}: {
  name?: string;
  kind?: "sandbox" | "preview";
}) {
  const isPreview = kind === "preview";
  return (
    <div className="flex items-center justify-center gap-3 bg-amber-500 px-4 py-1.5 text-center text-sm font-medium text-amber-950">
      <span>
        {isPreview ? "Sample company" : "Sandbox environment"}{name ? ` · ${name}` : ""} — emails, payments, and integrations are disabled.
      </span>
      <form action={exitSandbox}>
        <button
          type="submit"
          className="rounded border border-amber-950/30 px-2 py-0.5 text-xs font-semibold hover:bg-amber-950/10"
        >
          Exit to production
        </button>
      </form>
    </div>
  );
}
