"use client";

import { useState } from "react";
import { UrlDrawer } from "@openbooks/ui";
import { DrawerTabStrip } from "@/components/drawer-tab-strip";
import {
  ProvisionDifferencesSection,
  ProvisionFrameworkBadge,
  ProvisionReconSection,
  ProvisionStatusBadge,
} from "./[id]/sections";
import { ProvisionPostButton } from "./[id]/ProvisionPostButton";
import type { ProvisionDetailData } from "./[id]/view";

export interface ProvisionRunDrawerData {
  detail: ProvisionDetailData;
  closeHref: string;
}

export function ProvisionRunDrawer({ drawer }: { drawer: ProvisionRunDrawerData | null }) {
  const [tab, setTab] = useState<"reconciliation" | "differences">("reconciliation");
  if (!drawer) return null;
  const { detail } = drawer;

  return (
    <UrlDrawer
      open
      openKey={detail.runId}
      closeHref={drawer.closeHref}
      title={detail.headerTitle}
      size="2xl"
      headerActions={
        <div className="flex items-center gap-2">
          <ProvisionFrameworkBadge label={detail.frameworkLabel} />
          <ProvisionStatusBadge label={detail.statusLabel} variant={detail.statusVariant} />
          {detail.canPost ? <ProvisionPostButton runId={detail.runId} /> : null}
        </div>
      }
      subtabs={
        <DrawerTabStrip
          ariaLabel={detail.headerTitle}
          activeKey={tab}
          onSelect={setTab}
          tabs={[
            { key: "reconciliation", label: detail.reconTitle },
            { key: "differences", label: detail.diffTitle },
          ]}
        />
      }
    >
      {tab === "reconciliation" ? (
        <ProvisionReconSection
          title={detail.reconTitle}
          pretaxLabel={detail.pretaxLabel}
          pretaxAmount={detail.pretaxAmount}
          enactedRateText={detail.enactedRateText}
          amountLabel={detail.amountLabel}
          percentLabel={detail.percentLabel}
          steps={detail.steps}
          summaries={detail.summaries}
        />
      ) : (
        <ProvisionDifferencesSection
          title={detail.diffTitle}
          emptyNote={detail.diffEmptyNote}
          columns={detail.diffColumns}
          differences={detail.differences}
        />
      )}
    </UrlDrawer>
  );
}
