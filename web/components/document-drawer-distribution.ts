import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  apportionWithholdingMaterialsCost,
  collapseWithholdingLineMetadata,
} from "@openbooks/engine/allocations/withholding-cost";
import type { LineGridDistribution } from "./line-grid";
import {
  chipForRow,
  groupHeaderModels,
  groupIdOf,
  groupMembers,
  isGroupLocked,
  menuKeysForRow,
  reapportionGroupTotal,
  unsplitGroup as collapseDistributionGroup,
  type EntryDistributionCandidate,
} from "./allocations/distribution-groups";
import { useEntryCandidates } from "./allocations/use-entry-candidates";
import type { DistributionDialogChild } from "./allocations/DistributionDialog";
import { clearedDistributionFields, type LineRow, type Opt } from "./document-drawer-types";
import { emptyLine, hasDrawerLineAccount } from "./document-drawer-lines";
import type { DocumentDrawerDefaultsScope } from "./document-drawer-defaults";

/** Entry-mode distributions: candidate lookups, staging, and split groups. */
export function useDocumentDrawerDistribution(scope: DocumentDrawerDefaultsScope) {
  const {
    editable,
    isTransfer,
    config,
    documentDate,
    subsidiaryId,
    allocationsEntryEnabled,
    rows,
    setRows,
    tWithholdingLine,
    tCommon,
    departments,
    projects,
    locations,
    classes,
  } = scope;
  // -- entry-mode distributions -------------------------------------------
  // The server is the feature truth: every affordance below renders only
  // while entry-candidates answers. A 404/403 (gate off, out of scope)
  // hides everything, and the server refuses regardless of UI.
  const tAlloc = useTranslations("allocations");
  const distEditable = editable && !isTransfer && config.kind !== "project_charge";
  const [distApplying, setDistApplying] = useState(false);
  const [splitTarget, setSplitTarget] = useState<number | null>(null);
  const distContext = new URLSearchParams({
    documentKind: config.kind,
    documentDate,
    ...(subsidiaryId ? { subsidiaryId } : {}),
  }).toString();
  // Fail closed: a host that does not state the Allocations entry gate
  // never queries candidates, so a module that is off is never called.
  const dist = useEntryCandidates(
    distContext,
    distEditable && allocationsEntryEnabled === true && /^\d{4}-\d{2}-\d{2}$/.test(documentDate),
  );
  const {
    key: distKey,
    cache: distLineMap,
    failed: distLineFailed,
    load: loadDistCandidates,
  } = dist;
  const distOn = dist.on;
  const distAuto = dist.automatic;
  const distCoordinates = useCallback(
    (row: LineRow): Record<string, string> => ({
      accountId: row.accountId,
      ...(row.departmentId ? { departmentId: row.departmentId } : {}),
      ...(row.projectId ? { projectId: row.projectId } : {}),
      ...(row.locationId ? { locationId: row.locationId } : {}),
      ...(row.classId ? { classId: row.classId } : {}),
    }),
    [],
  );
  const distCoordKey = useCallback(
    (row: LineRow) => distKey(distCoordinates(row)),
    [distKey, distCoordinates],
  );
  const distLineSignature =
    distOn && distEditable
      ? JSON.stringify(
          [
            ...new Set(
              rows
                .filter((row) => hasDrawerLineAccount(row) && groupIdOf(row) === null)
                .map(distCoordKey),
            ),
          ].sort(),
        )
      : "[]";
  useEffect(() => {
    const queries = JSON.parse(distLineSignature) as string[];
    const timer = setTimeout(() => {
      for (const query of queries) {
        if (!distLineMap.has(query) && !distLineFailed.has(query))
          void loadDistCandidates(query).catch(() => {});
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [distLineSignature, distLineMap, distLineFailed, loadDistCandidates]);
  const distNameByKey = (key: string): string | null => {
    for (const rules of dist.cache.values()) {
      const rule = rules.find((candidate) => candidate.ruleKey === key);
      if (rule) return rule.ruleName;
    }
    return null;
  };
  const distSuggest = (row: LineRow): EntryDistributionCandidate | null =>
    dist.cache.get(distCoordKey(row))?.find((rule) => rule.applyPolicy === "suggest") ?? null;

  const stageDistributionKey = (index: number, ruleKey: string): void => {
    setRows((prev) => prev.map((r, j) => (j === index ? { ...r, distributionKey: ruleKey } : r)));
  };

  const applyDistSuggestion = (index: number): void => {
    const row = rows[index];
    if (!row) return;
    const pick = distSuggest(row);
    if (pick) stageDistributionKey(index, pick.ruleKey);
  };

  const applyDistAutomatic = async (): Promise<void> => {
    setDistApplying(true);
    try {
      const staged = new Map<string, string>();
      for (const row of rows) {
        if (!hasDrawerLineAccount(row) || groupIdOf(row) !== null || row.distributionKey) continue;
        const key = distCoordKey(row);
        try {
          // Explicit apply retries failed lookups. Fetch all policies so the
          // automatic action cannot poison the suggestion cache.
          const candidates = dist.cache.get(key) ?? (await dist.load(key));
          if (!dist.isCurrent()) return;
          const automatic = candidates.filter((rule) => rule.applyPolicy === "automatic");
          const winner = automatic.find((rule) => rule.recommended) ?? automatic[0];
          if (winner) staged.set(key, winner.ruleKey);
        } catch {
          if (!dist.isCurrent()) return;
        }
      }
      if (dist.isCurrent() && staged.size > 0) {
        setRows((prev) =>
          prev.map((row) => {
            if (!hasDrawerLineAccount(row) || groupIdOf(row) !== null || row.distributionKey)
              return row;
            const key = staged.get(distCoordKey(row));
            return key ? { ...row, distributionKey: key } : row;
          }),
        );
      }
    } finally {
      setDistApplying(false);
    }
  };

  const unsplitDistGroup = (groupKey: string): void => {
    setRows((prev) => {
      const collapsed = collapseDistributionGroup(prev, groupKey);
      if (!collapsed) return prev;
      const members = groupMembers(prev, groupKey);
      const keep = new Set(members.map((m) => m.index));
      const first = members[0]!;
      let withholding: ReturnType<typeof collapseWithholdingLineMetadata>;
      try {
        withholding = collapseWithholdingLineMetadata(
          members.map(({ row }) => ({
            amount: row.amount,
            withholdingTreatment: (row.withholdingTreatment || null) as
              "labour" | "materials" | "excluded" | null,
            withholdingMaterialsCost: row.withholdingMaterialsCost || null,
          })),
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : tWithholdingLine("splitRefusal"));
        return prev;
      }
      const next: LineRow[] = [];
      prev.forEach((r, j) => {
        if (!keep.has(j)) next.push(r);
        else if (j === first.index)
          next.push({
            ...first.row,
            ...clearedDistributionFields(),
            amount: collapsed.total,
            withholdingTreatment: withholding.withholdingTreatment || "",
            withholdingMaterialsCost: withholding.withholdingMaterialsCost || "",
          });
      });
      return next.length > 0 ? next : [emptyLine()];
    });
  };

  const toggleDistLock = (groupKey: string): void => {
    setRows((prev) => {
      const members = groupMembers(prev, groupKey);
      if (members.length === 0) return prev;
      const locked = !isGroupLocked(members.map((m) => m.row));
      const keep = new Set(members.map((m) => m.index));
      return prev.map((r, j) => (keep.has(j) ? { ...r, distributionLocked: locked } : r));
    });
  };

  const editDistGroupTotal = (groupKey: string, total: string): void => {
    setRows((prev) => {
      const members = groupMembers(prev, groupKey);
      if (members.length === 0 || isGroupLocked(members.map((m) => m.row))) return prev;
      const amounts = reapportionGroupTotal(
        members.map((m) => String(m.row.amount ?? "")),
        total,
      );
      const byIndex = new Map(members.map((m, k) => [m.index, amounts[k]!]));
      return prev.map((r, j) => (byIndex.has(j) ? { ...r, amount: byIndex.get(j)! } : r));
    });
  };

  const applyDialogRule = (ruleKey: string): void => {
    if (splitTarget !== null) stageDistributionKey(splitTarget, ruleKey);
    setSplitTarget(null);
  };

  const applyDialogChildren = (children: DistributionDialogChild[]): void => {
    if (splitTarget === null) return;
    const parent = rows[splitTarget];
    if (!parent) {
      setSplitTarget(null);
      return;
    }
    let costs: (string | null | undefined)[];
    try {
      costs = apportionWithholdingMaterialsCost(
        parent.withholdingMaterialsCost || null,
        children.map((child) => child.amount),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tWithholdingLine("splitRefusal"));
      return;
    }
    const groupKey = crypto.randomUUID();
    const built: LineRow[] = children.map((child, index) => {
      const base: LineRow = { ...emptyLine(), ...clearedDistributionFields() };
      for (const key of Object.keys(parent)) {
        if (key.startsWith("cf_") || key.startsWith("seg_")) base[key] = parent[key];
      }
      return {
        ...base,
        accountId: child.accountId,
        itemId: parent.itemId,
        description: child.description ?? parent.description,
        quantity: parent.quantity,
        unit: parent.unit,
        unitPrice: parent.unitPrice,
        costRate: parent.costRate,
        billRate: parent.billRate,
        billAmount: parent.billAmount,
        isBillable: parent.isBillable,
        departmentId: child.departmentId ?? parent.departmentId,
        projectId: child.projectId ?? parent.projectId,
        locationId: child.locationId ?? parent.locationId,
        classId: child.classId ?? parent.classId,
        taxProfileId: parent.taxProfileId,
        withholdingTreatment: parent.withholdingTreatment,
        withholdingMaterialsCost: costs[index] || "",
        marketplaceFacilitator: parent.marketplaceFacilitator,
        amount: child.amount,
        distributionGroupId: groupKey,
        // Hand-entered children are locked from birth: the operator tuned
        // them, so no later amount change re-explodes the group.
        distributionLocked: true,
      };
    });
    const at = splitTarget;
    setRows((prev) => [...prev.slice(0, at), ...built, ...prev.slice(at + 1)]);
    setSplitTarget(null);
  };

  const distCodings = useMemo(() => {
    const opts = (list: Opt[] | undefined): { value: string; label: string }[] =>
      (list ?? []).map((o) => ({ value: o.id, label: o.display_name ?? o.name ?? o.id }));
    return [
      {
        key: "department" as const,
        label: tCommon("labels.department"),
        options: opts(departments),
      },
      { key: "project" as const, label: tCommon("labels.project"), options: opts(projects) },
      { key: "location" as const, label: tCommon("labels.location"), options: opts(locations) },
      { key: "class" as const, label: tCommon("labels.class"), options: opts(classes) },
    ];
  }, [departments, projects, locations, classes, tCommon]);

  const distribution = useMemo<LineGridDistribution<LineRow> | undefined>(() => {
    if (!distOn || !distEditable) return undefined;
    const groups = groupHeaderModels(rows, {
      ruleNameOf: (member) => member.distributionRuleName || null,
    });
    const groupedIndexes = new Set<number>();
    for (const group of groups) {
      for (const member of groupMembers(rows, group.key)) groupedIndexes.add(member.index);
    }
    const lookup = {
      ruleNameOf: (row: LineRow) => row.distributionRuleName || null,
      pendingRuleNameOf: (row: LineRow) =>
        row.distributionKey ? (distNameByKey(row.distributionKey) ?? row.distributionKey) : null,
      suggestionOf: (row: LineRow) => {
        const found = distSuggest(row);
        return found ? { ruleName: found.ruleName } : null;
      },
      splittable: (row: LineRow) => hasDrawerLineAccount(row) && groupIdOf(row) === null,
    };
    return {
      groups,
      groupedIndexes,
      groupKeyOf: (row) => groupIdOf(row),
      chipOf: (row, index) => chipForRow(row, index, lookup),
      menuKeysOf: (row, index) => menuKeysForRow(row, index, lookup),
      onSplit: (index) => setSplitTarget(index),
      onUnsplit: (groupKey) => unsplitDistGroup(groupKey),
      onToggleLock: (groupKey) => toggleDistLock(groupKey),
      onApplySuggestion: (index) => applyDistSuggestion(index),
      onEditGroupTotal: (groupKey, total) => editDistGroupTotal(groupKey, total),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distOn, distEditable, rows, dist.cache]);

  return {
    tAlloc,
    distEditable,
    distApplying,
    splitTarget,
    setSplitTarget,
    dist,
    distOn,
    distAuto,
    distCoordKey,
    applyDistAutomatic,
    applyDialogRule,
    applyDialogChildren,
    distCodings,
    distribution,
  };
}

export type DocumentDrawerDistributionScope = DocumentDrawerDefaultsScope &
  ReturnType<typeof useDocumentDrawerDistribution>;
