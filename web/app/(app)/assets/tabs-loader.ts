import "server-only";

import { isFeatureEnabled } from "@/lib/features";
import { assetWorkspaceTabs, type AssetWorkspaceLabels, type AssetWorkspaceTab } from "./tabs";

/** Resolve the shared route set from the current organization feature gates. */
export async function loadAssetWorkspaceTabs(
  orgId: string,
  active: AssetWorkspaceTab,
  labels: AssetWorkspaceLabels,
) {
  const [
    showFixedAssets,
    showEquipment,
    showProposals,
    showConstruction,
    showMaintenance,
    showInsurance,
  ] = await Promise.all([
    isFeatureEnabled(orgId, "fixedAssets"),
    isFeatureEnabled(orgId, "equipment"),
    isFeatureEnabled(orgId, "assetProposals"),
    isFeatureEnabled(orgId, "constructionInProgress"),
    isFeatureEnabled(orgId, "assetMaintenance"),
    isFeatureEnabled(orgId, "assetInsurance"),
  ]);
  return assetWorkspaceTabs({
    active,
    labels,
    showFixedAssets,
    showEquipment,
    showProposals,
    showConstruction,
    // Leases are part of the fixed-assets feature; there is no separate gate.
    showLeases: showFixedAssets,
    showMaintenance,
    showInsurance,
  });
}
