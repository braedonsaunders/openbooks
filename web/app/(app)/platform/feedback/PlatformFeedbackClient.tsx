"use client";

// Operator console for the in-app issue reporter. The form itself belongs to
// @braedonsaunders/appkit-feedback (the same package the header control comes
// from, so the two can never disagree about what a destination is); this
// wrapper owns the host's half: the server actions, the saved/failed status,
// and the token-removal control the package deliberately leaves to the host.

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  FeedbackSettingsForm,
  type FeedbackSettingsValue,
} from "@braedonsaunders/appkit-feedback/react";
import { Button } from "@openbooks/ui";
import { PageContainer, PageHeader } from "@braedonsaunders/appkit-ui";
import { clearFeedbackTokenAction, saveFeedbackSettingsAction } from "./actions";
import type { FeedbackSettingsView } from "../../../../lib/feedback/config";

function toFormValue(settings: FeedbackSettingsView): FeedbackSettingsValue {
  return {
    enabled: settings.enabled,
    owner: settings.owner,
    repo: settings.repo,
    // Never round-trips: the stored token is sealed, and an empty field means
    // "keep what is stored".
    token: "",
    hasToken: settings.hasToken,
    labels: settings.labels,
    searchDuplicates: settings.searchDuplicates,
  };
}

export function PlatformFeedbackClient({ settings }: { settings: FeedbackSettingsView }) {
  const t = useTranslations("platform.feedback");
  const [value, setValue] = useState<FeedbackSettingsValue>(() => toFormValue(settings));
  const [hasToken, setHasToken] = useState(settings.hasToken);
  const [pending, startTransition] = useTransition();

  function apply(result: Awaited<ReturnType<typeof saveFeedbackSettingsAction>>, success: string) {
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    setValue(toFormValue(result.settings));
    setHasToken(result.settings.hasToken);
    toast.success(success);
  }

  // The same operator shell the sibling platform pages render through
  // (ListPageLayout/PageContainer): the shell owns the scroll container,
  // page padding and max-width; PageHeader owns the title and the way back.
  // The AppShell main is overflow-hidden, so a bare div here can never
  // scroll — which is exactly the defect. Title and description repeat the
  // console nav entry for this module, the way the access page repeats its
  // own.
  return (
    <PageContainer>
      <div className="space-y-5">
        <PageHeader
          title={t("title")}
          description={t("description")}
          back={{ href: "/platform", label: t("backToPlatform") }}
        />
        <div className="flex flex-col gap-4">
          <FeedbackSettingsForm
            value={value}
            onChange={setValue}
            saving={pending}
            onSave={(next) =>
              startTransition(async () => {
                apply(
                  await saveFeedbackSettingsAction({
                    enabled: next.enabled,
                    owner: next.owner,
                    repo: next.repo,
                    labels: next.labels,
                    searchDuplicates: next.searchDuplicates,
                    token: next.token.trim() || undefined,
                  }),
                  t("saved"),
                );
              })
            }
            labels={{
              settingsDescription: t("settingsDescription"),
              tokenHelp: t("tokenHelp"),
            }}
          />
          {hasToken ? (
            <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
              <div>
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {t("storedToken")}
                </p>
                <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                  {t("storedTokenDescription")}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    apply(await clearFeedbackTokenAction(), t("tokenRemoved"));
                  })
                }
              >
                {t("removeToken")}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </PageContainer>
  );
}
