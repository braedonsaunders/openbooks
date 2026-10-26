"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button, EmptyState } from "@openbooks/ui";
import shell from "@/messages/en/shell.json";
import { isStaleDeploymentError } from "@/lib/stale-deployment";

/** Catches root-layout failures; must define its own document (no app providers). */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = shell.routeState;
  const stale = isStaleDeploymentError(error);

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="h-full bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <div className="flex min-h-screen items-center justify-center p-6">
          <div className="w-full max-w-lg">
            {stale ? (
              <EmptyState
                icon={<RefreshCw />}
                title={t.updatedTitle}
                description={t.updatedDescription}
                action={<Button onClick={() => window.location.reload()}>{t.reload}</Button>}
              />
            ) : (
              <EmptyState
                icon={<AlertTriangle />}
                title={t.errorTitle}
                description={t.errorDescription}
                action={<Button onClick={reset}>Retry</Button>}
              />
            )}
            {!stale && error.digest ? (
              <p className="mt-4 text-center text-xs text-slate-500 dark:text-slate-400">
                {t.errorReference.replace("{id}", error.digest)}
              </p>
            ) : null}
          </div>
        </div>
      </body>
    </html>
  );
}
