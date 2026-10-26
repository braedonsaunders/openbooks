import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  assertActorCommandExecutor,
  createActorPermissionRead,
  lockActorIdentity,
} from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { attachmentTargetInScope, loadAttachmentTarget } from "./file-attachment-target.ts";
import { DOC_KIND_FEATURE } from "./document-kind-features.ts";
import {
  accessAtLeast,
  apCaptureSubsidiaryScope,
  attachmentReadPermission,
  fileAccessLevel,
  fileReadPredicate,
  lockCabinetAuthorization,
  type FileViewer,
} from "./file-cabinet-access.ts";

/** Absence and denial share one refusal without disclosing a hidden resource. */
export class NativeFileReadRefusal extends Error {
  readonly status = 404;
  constructor() {
    super(
      "Source file is unavailable to this operator; select an accessible Cabinet file or request access from its owner",
    );
    this.name = "NativeFileReadRefusal";
  }
}

/**
 * Authorize a named operator's source read inside the consuming command's
 * organization transaction. Resource grants reopen privacy boundaries only;
 * they cannot confer another entity's records or an owning module's permission.
 * This proves source access, never the source's financial qualification.
 */
export async function requireNativeFileReadAuthority(
  input: { orgId: string; actorId: string; fileId: string },
  runner: SqlExecutor,
): Promise<void> {
  const { orgId, actorId, fileId } = input;
  assertActorCommandExecutor(runner, orgId);
  if (![orgId, actorId, fileId].every(isUuid)) throw new NativeFileReadRefusal();
  await lockCabinetAuthorization(runner, orgId);
  if (!(await lockActorIdentity(runner, orgId, actorId))) throw new NativeFileReadRefusal();
  await runner.execute(
    sql`select id from role_assignments where org_id=${orgId} and user_id=${actorId} order by id for share`,
  );
  await runner.execute(sql`select id from app_roles where org_id=${orgId} and id in
    (select role_id from role_assignments where org_id=${orgId} and user_id=${actorId}) order by id for share`);
  await runner.execute(
    sql`select id from user_permission_overrides where org_id=${orgId} and user_id=${actorId} order by id for share`,
  );
  await runner.execute(
    sql`select id from subsidiaries where org_id=${orgId} order by id for share`,
  );
  const permission = createActorPermissionRead(runner, orgId, actorId);
  const allowedSubsidiaryIds = await actorAllowedSubsidiaryIds(runner, orgId, actorId);
  const viewer: FileViewer = {
    userId: actorId,
    isAdmin: await permission("*"),
    baseline: (await permission("documents.manage"))
      ? "manager"
      : (await permission("documents.read"))
        ? "viewer"
        : "none",
    canReadApCapture: await permission("ap.read"),
    allowedSubsidiaryIds,
  };
  const resourceAccess = accessAtLeast(
    await fileAccessLevel(orgId, viewer, fileId, runner),
    "viewer",
  );
  const visible = await fileReadPredicate(orgId, viewer, runner);
  const source = (
    await runner.execute<{ folderId: string }>(
      sql`
    select fi.folder_id as "folderId" from files fi
      join folders fo on fo.id=fi.folder_id and fo.org_id=fi.org_id
     where fi.id=${fileId} and ${visible} and not fo.is_inactive
     for share of fi, fo`,
      "objects",
    )
  )[0];
  if (!source) throw new NativeFileReadRefusal();

  const captures = await runner.execute<{
    visible: boolean;
    vendorId: string | null;
    orderId: string | null;
  }>(
    sql`
    select (true ${apCaptureSubsidiaryScope(allowedSubsidiaryIds)}) as visible,
           ci.vendor_candidate_id as "vendorId",ci.purchase_order_id as "orderId"
      from ap_capture_items ci
      left join parties vendor on vendor.id=ci.vendor_candidate_id and vendor.org_id=ci.org_id
      left join documents po on po.id=ci.purchase_order_id and po.org_id=ci.org_id
     where ci.org_id=${orgId} and ci.file_id=${fileId} for share of ci`,
    "objects",
  );
  for (const capture of captures) {
    if (!viewer.canReadApCapture || !capture.visible) throw new NativeFileReadRefusal();
    // Pin matched records as well: a concurrent rehome cannot outlive the
    // packet's scope check, and an unresolved non-null reference refuses.
    for (const [table, id] of [
      ["parties", capture.vendorId],
      ["documents", capture.orderId],
    ] as const) {
      if (!id) continue;
      const target = await loadAttachmentTarget(orgId, table, id, runner, true);
      if (
        !target ||
        !subsidiaryScopeAllows(allowedSubsidiaryIds, target.subsidiaryId, { orgWideNull: true })
      )
        throw new NativeFileReadRefusal();
    }
  }

  // Resolve every record ancestor as well as every attachment. Moving a file
  // or adding a common-folder link cannot launder a protected record's source.
  const targets = await runner.execute<{
    targetTable: string;
    targetId: string | null;
    attached: boolean;
  }>(
    sql`
    with recursive ancestors as (
      select id,parent_folder_id,record_table,record_id from folders
       where org_id=${orgId} and id=${source.folderId}
      union all
      select f.id,f.parent_folder_id,f.record_table,f.record_id from folders f
        join ancestors a on f.id=a.parent_folder_id where f.org_id=${orgId}
    )
    select record_table as "targetTable",record_id as "targetId",false as attached from ancestors
     where record_id is not null or record_table is not null
    union
    select target_table as "targetTable",target_id as "targetId",true as attached from file_attachments
     where org_id=${orgId} and file_id=${fileId}`,
    "objects",
  );
  let assetAttachmentAccess = false;
  for (const reference of targets) {
    if (!reference.targetTable || !reference.targetId) throw new NativeFileReadRefusal();
    const target = await loadAttachmentTarget(
      orgId,
      reference.targetTable,
      reference.targetId,
      runner,
      true,
    );
    if (!target || !attachmentTargetInScope({ allowedSubsidiaryIds }, target))
      throw new NativeFileReadRefusal();
    const required = attachmentReadPermission(target.targetTable, target.kind);
    if (!required || !(await permission(required))) throw new NativeFileReadRefusal();
    const feature =
      target.targetTable === "documents"
        ? DOC_KIND_FEATURE[target.kind ?? ""]
        : target.targetTable === "fixed_assets"
          ? "fixedAssets"
          : undefined;
    if (feature && !(await lockAndCheckOrgFeature(runner, orgId, feature)))
      throw new NativeFileReadRefusal();
    if (reference.attached && target.targetTable === "fixed_assets") assetAttachmentAccess = true;
  }
  // Cabinet downloads also admit an assets.read operator through a real,
  // visible asset attachment. The proof is bound to this file and retains its
  // privacy predicate; it never supplies a broader Cabinet viewer baseline.
  if (!resourceAccess && !assetAttachmentAccess && captures.length === 0)
    throw new NativeFileReadRefusal();
}
