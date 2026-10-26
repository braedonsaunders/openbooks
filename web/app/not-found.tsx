import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@openbooks/ui";
import { RouteStateStandalone } from "@/components/route-state";
import { currentUser } from "@/lib/auth";

/**
 * Root not-found for routes outside the authenticated app shell. A signed-in
 * visitor who mistypes an address is sent back to their dashboard, not to a
 * sign-in page that would only redirect them again.
 */
export default async function RootNotFound() {
  const t = await getTranslations("shell.routeState");
  const signedIn = Boolean(await currentUser().catch(() => null));

  return (
    <RouteStateStandalone
      icon={<FileQuestion />}
      title={t("notFoundTitle")}
      description={t("notFoundDescription")}
      action={
        <Button asChild>
          {signedIn ? (
            <Link href="/dashboard">{t("backToDashboard")}</Link>
          ) : (
            <Link href="/login">{t("backToSignIn")}</Link>
          )}
        </Button>
      }
    />
  );
}
