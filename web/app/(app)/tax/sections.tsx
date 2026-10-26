import { ModuleHomeTabs } from "@/components/module-home/tabs";
import { TaxFilingsView } from "./TaxFilingsView";
import { FilingHistoryDrawer, type FilingHistoryRecord } from "./FilingHistoryDrawer";

export type TaxFormOption = {
  code: string;
  name: string;
  country: string | null;
  submission_channel: string;
  government_format: string;
  submission_url: string | null;
  /** Pack-declared filing-notice catalog key; null renders no notice. */
  notice_key: string | null;
  has_official: boolean;
};

export interface TaxHistoryRow {
  id: string;
  formName: string;
  formCode: string;
  filingHref: string;
  period: string;
  version: number;
  status: "prepared" | "filed";
  statusVariant: "warning" | "success";
  statusLabel: string;
  reference: string;
  saved: string;
}

/** Filing subviews share the same route while OSS and Provisions live beside it. */
export function TaxTabs({
  tabs,
}: {
  tabs: { key: string; href: string; label: string; active: boolean; count: number | null }[];
}) {
  return <ModuleHomeTabs tabs={tabs} />;
}

/** The prepare panel: computation, export and save remain native client flows. */
export function TaxPreparePanel({
  forms,
  canSave,
  canManageSetup,
  conversionDate,
}: {
  forms: TaxFormOption[];
  canSave: boolean;
  canManageSetup: boolean;
  conversionDate?: string | null;
}) {
  return (
    <TaxFilingsView
      forms={forms}
      canSave={canSave}
      canManageSetup={canManageSetup}
      conversionDate={conversionDate ?? null}
    />
  );
}

/** A filing history record opens in the URL-addressed filing drawer. */
export function TaxFilingDrawer({
  drawer,
}: {
  drawer: {
    remountKey: string;
    filing: FilingHistoryRecord;
    closeHref: string;
    canFile: boolean;
  } | null;
}) {
  if (!drawer) return null;
  const { remountKey, ...rest } = drawer;
  return <FilingHistoryDrawer key={remountKey} {...rest} />;
}
