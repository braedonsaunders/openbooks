import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg, withOrgContext, type SqlExecutor } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import { NativeFileReadRefusal, requireNativeFileReadAuthority } from "./file-read-authority.ts";

test(
  "native source authority preserves privacy, grants, entity fences and owning permissions",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    const other = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Evidence operator", "clerk");
      const ownerId = await createScratchUser(org.orgId, "Private evidence owner", "admin");
      const roleId = (
        await db.execute<{ id: string }>(
          sql`
      select role_id as id from role_assignments where org_id=${org.orgId} and user_id=${actorId}`,
          "objects",
        )
      )[0]!.id;
      await db.execute(sql`update app_roles set permissions='["documents.read","gl.read"]'::jsonb,
      subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and id=${roleId}`);
      const read = (fileId: string) =>
        withOrg(org.orgId, () =>
          requireNativeFileReadAuthority({ orgId: org.orgId, actorId, fileId }, db),
        );
      const refused = (fileId: string) => assert.rejects(read(fileId), NativeFileReadRefusal);
      const folder = async (
        options: {
          parentId?: string;
          ownerId?: string;
          recordId?: string;
          systemKind?: string;
        } = {},
      ) => {
        const id = randomUUID();
        await db.execute(sql`insert into folders(id,org_id,name,parent_folder_id,is_private,owner_id,record_table,record_id,system_kind)
        values(${id},${org.orgId},'Evidence folder',${options.parentId ?? null},${!!options.ownerId},${options.ownerId ?? null},
          ${options.recordId ? "documents" : null},${options.recordId ?? null},${options.systemKind ?? null})`);
        return id;
      };
      const file = async (folderId: string) => {
        const id = randomUUID();
        await db.execute(sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes)
        values(${id},${org.orgId},${folderId},'evidence.pdf','application/pdf',1)`);
        return id;
      };
      const grant = async (
        resourceType: "file" | "folder",
        resourceId: string,
        principalType: "user" | "role" = "user",
      ) => {
        await db.execute(sql`insert into resource_grants(org_id,resource_type,resource_id,principal_type,principal_id,access,created_by)
        values(${org.orgId},${resourceType},${resourceId},${principalType},${principalType === "user" ? actorId : roleId},'viewer',${ownerId})`);
      };
      const document = async (
        kind: "journal" | "pay_run" | "purchase_order",
        subsidiaryId = org.subsidiaryId,
      ) => {
        const id = randomUUID();
        await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,document_date,currency,fx_rate)
        values(${id},${org.orgId},${kind},'draft',${id},${subsidiaryId},${org.date},'CAD',1)`);
        return id;
      };

      const publicFolder = await folder();
      const publicFile = await file(publicFolder);
      await read(publicFile);
      await refused(randomUUID());
      const privateFolder = await folder({ ownerId });
      const privateFile = await file(privateFolder);
      await refused(privateFile);
      const nestedOwnFile = await file(await folder({ parentId: privateFolder, ownerId: actorId }));
      await refused(nestedOwnFile);
      await grant("file", privateFile);
      await read(privateFile);
      await refused(nestedOwnFile);
      await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect)
      values(${org.orgId},${actorId},'documents.read','deny')`);
      await refused(publicFile);
      await read(privateFile);
      await db.execute(
        sql`delete from user_permission_overrides where org_id=${org.orgId} and user_id=${actorId} and permission='documents.read'`,
      );
      await grant("folder", privateFolder, "role");
      await read(nestedOwnFile);
      await db.execute(
        sql`delete from resource_grants where org_id=${org.orgId} and resource_type='folder' and resource_id=${privateFolder}`,
      );
      await refused(nestedOwnFile);

      // A callback supplied by a direct caller cannot claim a private file.
      let suppliedCalls = 0;
      const supplied = {
        orgId: org.orgId,
        actorId,
        fileId: nestedOwnFile,
        authorizeFile: async () => {
          suppliedCalls++;
          return true;
        },
      };
      await assert.rejects(
        withOrg(org.orgId, () => requireNativeFileReadAuthority(supplied, db)),
        NativeFileReadRefusal,
      );
      assert.equal(suppliedCalls, 0);

      const categoryId = randomUUID(),
        assetId = randomUUID();
      await db.execute(sql`insert into asset_categories
      (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,default_convention)
      values(${categoryId},${org.orgId},'Evidence category',${org.accounts.invAsset},${org.accounts.clearing},${org.accounts.adjustment},${org.accounts.adjustment},'straight_line',10,'full_month')`);
      await db.execute(sql`insert into fixed_assets(id,org_id,subsidiary_id,category_id,asset_number,name,acquisition_cost)
      values(${assetId},${org.orgId},${org.subsidiaryId},${categoryId},'SOURCE-ASSET','Evidence asset',1000)`);
      await grantScratchPermissions(org.orgId, actorId, ["assets.read"]);
      await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect)
      values(${org.orgId},${actorId},'documents.read','deny')`);
      await refused(publicFile);
      await db.execute(sql`insert into file_attachments(org_id,file_id,target_table,target_id,created_by)
      values(${org.orgId},${publicFile},'fixed_assets',${assetId},${ownerId}),
        (${org.orgId},${nestedOwnFile},'fixed_assets',${assetId},${ownerId})`);
      await read(publicFile);
      await refused(nestedOwnFile);
      await db.execute(
        sql`delete from file_attachments where org_id=${org.orgId} and target_id=${assetId}`,
      );
      await refused(publicFile);
      await db.execute(
        sql`delete from user_permission_overrides where org_id=${org.orgId} and user_id=${actorId} and permission='documents.read'`,
      );

      const branchId = randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
      values(${branchId},${org.orgId},${org.subsidiaryId},'Restricted branch','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb)`);
      const hiddenDocument = await document("journal", branchId);
      const recordFolder = await folder({ recordId: hiddenDocument });
      const hiddenFile = await file(recordFolder);
      await grant("file", hiddenFile);
      await db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
      where org_id=${org.orgId} and id=${roleId}`);
      await refused(hiddenFile);
      const inheritedFile = await file(await folder({ parentId: recordFolder }));
      await grant("file", inheritedFile);
      await refused(inheritedFile);
      await db.execute(sql`insert into file_attachments(org_id,file_id,target_table,target_id,created_by)
      values(${org.orgId},${publicFile},'documents',${hiddenDocument},${ownerId})`);
      await refused(publicFile);
      await db.execute(
        sql`delete from file_attachments where org_id=${org.orgId} and file_id=${publicFile}`,
      );
      await read(publicFile);
      await db.execute(
        sql`update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and id=${roleId}`,
      );
      await read(hiddenFile);
      await refused(await file(await folder({ recordId: randomUUID() })));

      // Cabinet access cannot disclose payroll-linked source evidence without
      // payroll authority, even when a direct share admits its privacy tier.
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"payroll":true}'::jsonb)
      where id=${org.orgId}`);
      const payrollFile = await file(await folder({ recordId: await document("pay_run") }));
      await grant("file", payrollFile);
      await refused(payrollFile);
      await grantScratchPermissions(org.orgId, actorId, ["payroll.read"]);
      await read(payrollFile);
      await db.execute(
        sql`update orgs set settings=jsonb_set(settings,'{features,payroll}','false'::jsonb) where id=${org.orgId}`,
      );
      await refused(payrollFile);

      const intakeFile = await file(await folder({ systemKind: "ap_capture" }));
      await grant("file", intakeFile);
      await refused(intakeFile);
      await grantScratchPermissions(org.orgId, actorId, ["ap.read"]);
      await read(intakeFile);
      const captureId = randomUUID();
      const hiddenOrder = await document("purchase_order", branchId);
      await db.execute(sql`insert into ap_capture_items
      (id,org_id,file_id,status,original_filename,content_hash,document_kind,normalized,validation_issues,purchase_order_id,created_by,updated_by)
      values(${captureId},${org.orgId},${intakeFile},'needs_review','intake.pdf',${"a".repeat(64)},'vendor_bill','{}'::jsonb,'[]'::jsonb,${hiddenOrder},${ownerId},${ownerId})`);
      await db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
      where org_id=${org.orgId} and id=${roleId}`);
      await refused(intakeFile);
      await db.execute(
        sql`update ap_capture_items set purchase_order_id=null where org_id=${org.orgId} and id=${captureId}`,
      );
      await read(intakeFile);
      // An emailed capture belongs to the entity whose address received it; a
      // caller fenced to another entity cannot read its source document.
      await db.execute(
        sql`update ap_capture_items set source='email', subsidiary_id=${branchId} where org_id=${org.orgId} and id=${captureId}`,
      );
      await refused(intakeFile);
      await db.execute(
        sql`update ap_capture_items set subsidiary_id=${org.subsidiaryId} where org_id=${org.orgId} and id=${captureId}`,
      );
      await read(intakeFile);
      await db.execute(
        sql`update app_roles set subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb where org_id=${org.orgId} and id=${roleId}`,
      );
      await refused(intakeFile);
      await db.execute(
        sql`update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and id=${roleId}`,
      );
      await db.execute(
        sql`delete from resource_grants where org_id=${org.orgId} and resource_type='file' and resource_id=${intakeFile}`,
      );
      await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect)
      values(${org.orgId},${actorId},'documents.read','deny')`);
      await read(intakeFile);
      await refused(publicFile);
      await db.execute(
        sql`delete from user_permission_overrides where org_id=${org.orgId} and user_id=${actorId} and permission='documents.read'`,
      );
      await db.execute(
        sql`update files set is_inactive=true where id=${publicFile} and org_id=${org.orgId}`,
      );
      await refused(publicFile);
      await db.execute(
        sql`update users set is_active=false where id=${actorId} and org_id=${org.orgId}`,
      );
      await refused(privateFile);
      await db.execute(
        sql`update users set is_active=true where id=${actorId} and org_id=${org.orgId}`,
      );
      const foreignFolder = randomUUID(),
        foreignFile = randomUUID();
      await db.execute(
        sql`insert into folders(id,org_id,name) values(${foreignFolder},${other.orgId},'Other tenant')`,
      );
      await db.execute(sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes)
      values(${foreignFile},${other.orgId},${foreignFolder},'other.pdf','application/pdf',1)`);
      await refused(foreignFile);
    } finally {
      await dropScratchOrg(other.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);

test("native source authority refuses unbound caller executors before consulting their answers", async () => {
  let queries = 0;
  const supplied = {
    execute: ((_query: unknown, mode?: string) => {
      const inMode = <T extends { rows: unknown }>(result: T) =>
        mode === "objects" ? result.rows : result;
      queries++;
      return Promise.resolve({ rows: [{ allowed: true }] }).then(inMode);
    }) as unknown as SqlExecutor["execute"],
  };
  const orgId = randomUUID();
  await withOrgContext(orgId, async () => {
    await assert.rejects(
      requireNativeFileReadAuthority(
        { orgId, actorId: randomUUID(), fileId: randomUUID() },
        supplied,
      ),
      /pinned transaction executor/,
    );
  });
  assert.equal(queries, 0);
});
