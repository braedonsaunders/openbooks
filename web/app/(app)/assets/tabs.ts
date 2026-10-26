export type AssetWorkspaceTab =
  | "register"
  | "tax-depreciation"
  | "equipment"
  | "proposals"
  | "construction"
  | "leases"
  | "maintenance"
  | "insurance";

export interface AssetWorkspaceLabels {
  register: string;
  taxDepreciation: string;
  equipment: string;
  proposals: string;
  construction: string;
  leases: string;
  maintenance: string;
  insurance: string;
}

/**
 * One route switcher for asset registers and sub-workspaces. Feature-disabled
 * destinations are omitted so the shared header strip never offers a route
 * the viewer cannot open.
 */
export function assetWorkspaceTabs({
  active,
  labels,
  showFixedAssets,
  showEquipment,
  showProposals,
  showConstruction,
  showLeases,
  showMaintenance,
  showInsurance,
}: {
  active: AssetWorkspaceTab;
  labels: AssetWorkspaceLabels;
  showFixedAssets: boolean;
  showEquipment: boolean;
  showProposals: boolean;
  showConstruction: boolean;
  showLeases: boolean;
  showMaintenance: boolean;
  showInsurance: boolean;
}) {
  return [
    ...(showFixedAssets
      ? [
          {
            key: "register",
            href: "/assets",
            label: labels.register,
            active: active === "register",
          },
          {
            key: "tax-depreciation",
            href: "/assets?tab=tax-depreciation",
            label: labels.taxDepreciation,
            active: active === "tax-depreciation",
          },
        ]
      : []),
    ...(showEquipment
      ? [
          {
            key: "equipment",
            href: "/assets/equipment",
            label: labels.equipment,
            active: active === "equipment",
          },
        ]
      : []),
    ...(showProposals
      ? [
          {
            key: "proposals",
            href: "/assets/proposals",
            label: labels.proposals,
            active: active === "proposals",
          },
        ]
      : []),
    ...(showConstruction
      ? [
          {
            key: "construction",
            href: "/assets/construction",
            label: labels.construction,
            active: active === "construction",
          },
        ]
      : []),
    ...(showLeases
      ? [
          {
            key: "leases",
            href: "/assets/leases",
            label: labels.leases,
            active: active === "leases",
          },
        ]
      : []),
    ...(showMaintenance
      ? [
          {
            key: "maintenance",
            href: "/assets/maintenance",
            label: labels.maintenance,
            active: active === "maintenance",
          },
        ]
      : []),
    ...(showInsurance
      ? [
          {
            key: "insurance",
            href: "/assets/insurance",
            label: labels.insurance,
            active: active === "insurance",
          },
        ]
      : []),
  ];
}
