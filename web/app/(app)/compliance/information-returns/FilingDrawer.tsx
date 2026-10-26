"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { UrlDrawer } from "@openbooks/ui";
import { useDirtyClose } from "../../../../lib/use-dirty-close";
import { FilingWorksheet } from "./[id]/FilingWorksheet";
import type { FilingDetailData } from "./[id]/view";

export function InformationReturnFilingDrawer({
  detail,
  closeHref,
}: {
  detail: FilingDetailData | null;
  closeHref: string;
}) {
  if (!detail) return null;
  return <OpenFilingDrawer detail={detail} closeHref={closeHref} />;
}

function OpenFilingDrawer({ detail, closeHref }: { detail: FilingDetailData; closeHref: string }) {
  const common = useTranslations("common");
  const [dirtyFilingId, setDirtyFilingId] = useState<string | null>(null);
  const dirty = dirtyFilingId === detail.filing.id;
  const onDirtyChange = useCallback(
    (value: boolean) => {
      setDirtyFilingId(value ? detail.filing.id : null);
    },
    [detail.filing.id],
  );
  const closeGuard = useDirtyClose({
    dirty,
    onClose: () => setDirtyFilingId(null),
    message: common("feedback.unsavedChanges"),
    confirmLabel: common("confirm.discardChanges"),
  });
  return (
    <UrlDrawer
      open
      openKey={detail.filing.id}
      closeHref={closeHref}
      beforeClose={closeGuard.beforeClose}
      title={detail.title}
      description={detail.description}
      size="2xl"
    >
      <FilingWorksheet
        key={detail.filing.id}
        filing={detail.filing}
        boxes={detail.boxes}
        canManage={detail.canManage}
        canFile={detail.canFile}
        onDirtyChange={onDirtyChange}
      />
    </UrlDrawer>
  );
}
