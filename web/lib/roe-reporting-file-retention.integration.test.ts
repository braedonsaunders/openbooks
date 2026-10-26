import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import {
  dropScratchOrg,
  seedPayrollSettings,
  grantScratchPermissions,
} from "@openbooks/engine/testing/fixtures";
import { importRoePriorPeriod } from "@openbooks/engine/payroll/roe-history";
import { saveRoeSeparationFacts } from "@openbooks/engine/payroll/roe-separation-facts";
import { saveRoeSubsequentService } from "@openbooks/engine/payroll/canada/roe-subsequent-service";
import { seedAdoption } from "@openbooks/engine/testing/payroll/filing-test-fixtures";
import {
  createFile,
  deleteFile,
  getFileBlob,
  isRetainedFileEvidence,
  purgeFile,
  replaceFile,
  restoreFile,
} from "./file-cabinet";

test(
  "qualified ROE reporting sources refuse cabinet trash, replacement and purge while preserving pinned bytes",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await withBypassContext(() => seedAdoption());
    try {
      await withOrgContext(f.orgId, async () => {
        await seedPayrollSettings(f.orgId, { features: { payroll: true } });
        await grantScratchPermissions(f.orgId, f.actorId, ["payroll.read", "payroll.run"]);
        const account = randomUUID(),
          folder = randomUUID(),
          file = randomUUID(),
          version = randomUUID();
        const bytes = Buffer.from(
          "Original employee reporting period: insured earnings 80; insured hours 4",
        );
        const hash = createHash("sha256").update(bytes).digest("hex");
        const accounts = await db.execute(
          sql`insert into payroll_filing_accounts
          (id,org_id,subsidiary_id,country,program_type,account_number,name,remitter_type,is_default,is_active,created_by,updated_by)
          values(${account},${f.orgId},${f.subsidiaryId},'CA','ca_rp','123456789RP0001','Employer payroll account','regular',true,true,${f.actorId},${f.actorId}) returning id`,
          "objects",
        );
        assert.equal(accounts.length, 1);
        const folders = await db.execute(
          sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
          values(${folder},${f.orgId},'Original reporting evidence',true,${f.actorId},${f.actorId},${f.actorId}) returning id`,
          "objects",
        );
        assert.equal(folders.length, 1);
        const files = await db.execute(
          sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
          values(${file},${f.orgId},${folder},'original-period.txt','text/plain',${bytes.length},${f.actorId},${f.actorId}) returning id`,
          "objects",
        );
        assert.equal(files.length, 1);
        const versions = await db.execute(
          sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
          values(${version},${file},1,${bytes.length},'text/plain',${hash},${f.actorId}) returning id`,
          "objects",
        );
        assert.equal(versions.length, 1);
        const blobs = await db.execute(
          sql`insert into file_blobs(version_id,bytes) values(${version},${bytes}) returning id`,
          "objects",
        );
        assert.equal(blobs.length, 1);
        const current = await db.execute(
          sql`update files set current_version_id=${version} where org_id=${f.orgId} and id=${file} returning id`,
          "objects",
        );
        assert.equal(current.length, 1);
        const viewer = {
          userId: f.actorId,
          isAdmin: true as const,
          baseline: "manager" as const,
          allowedSubsidiaryIds: null,
        };
        const audit = { actorId: f.actorId, viewer };
        assert.equal(await isRetainedFileEvidence(f.orgId, file), false);
        const evidence = await importRoePriorPeriod(
          {
            orgId: f.orgId,
            actorId: f.actorId,
            employeePartyId: f.employeeId,
            employmentId: f.employmentId,
            subsidiaryId: f.subsidiaryId,
            allowedSubsidiaryIds: null,
          },
          {
            sourceFileId: file,
            sourceVersionId: version,
            sourceSha256: hash,
            sourceReference: "Original reporting period and employee declaration",
            insuranceReference: "Original employer insurable earnings declaration",
            hoursReference: "Original employer insurable hours declaration",
            reason: "Retain qualified original reporting facts",
            filingAccountId: account,
            payScheduleId: f.scheduleId,
            frequency: "biweekly",
            periodStart: "2026-07-05",
            periodEnd: "2026-07-18",
            payDate: "2026-07-21",
            earnedFrom: "2026-07-14",
            earnedTo: "2026-07-14",
            insurableEarnings: "80",
            insurableHours: "4",
            nilPeriod: false,
            expectedId: null,
            expectedUpdatedAt: null,
          },
        );
        assert.equal(await isRetainedFileEvidence(f.orgId, file), true);
        assert.equal(await deleteFile(f.orgId, file, audit), false);
        assert.equal(
          await replaceFile({
            orgId: f.orgId,
            fileId: file,
            filename: "changed.txt",
            contentType: "text/plain",
            bytes: Buffer.from("Changed source"),
            updatedBy: f.actorId,
            audit,
          }),
          false,
        );
        assert.equal(await purgeFile(f.orgId, file, audit), "retained");
        const retained = await getFileBlob(f.orgId, file, viewer, version);
        assert.ok(retained);
        assert.deepEqual(retained.bytes, bytes);
        const rows = await db.execute<{ id: string; sourceSha256: string }>(
          sql`select id,source_sha256 as "sourceSha256"
          from payroll_roe_historical_periods where org_id=${f.orgId} and id=${evidence.id}`,
          "objects",
        );
        assert.deepEqual(rows, [{ id: evidence.id, sourceSha256: hash }]);
        const subject = {
          orgId: f.orgId,
          actorId: f.actorId,
          employeePartyId: f.employeeId,
          employmentId: f.employmentId,
          subsidiaryId: f.subsidiaryId,
          allowedSubsidiaryIds: null,
        };
        const event = await saveRoeSeparationFacts({
          ...subject,
          firstDayWorked: "2026-07-05",
          interruptionOn: "2026-07-18",
          lastInsurableEarningsOn: "2026-07-18",
          salaryContinuanceEndOn: null,
          status: "confirmed",
          sourceReference: "Original service interruption",
          reason: "Retain original event facts",
          expectedId: null,
          expectedUpdatedAt: null,
        });
        const returnBytes = Buffer.from(
          "Original returned-work declaration: first day worked 2026-07-19",
        );
        const returned = await createFile({
          orgId: f.orgId,
          folderId: folder,
          filename: "returned-work.txt",
          contentType: "text/plain",
          bytes: returnBytes,
          createdBy: f.actorId,
          audit,
        });
        const returnVersions = await db.execute<{ id: string; hash: string }>(
          sql`select v.id,v.content_hash as hash
          from files f join file_versions v on v.file_id=f.id and v.id=f.current_version_id
          where f.org_id=${subject.orgId} and f.id=${returned.id}`,
          "objects",
        );
        assert.equal(returnVersions.length, 1);
        const certificate = {
          precedingEventId: event.id,
          firstDayWorked: "2026-07-19",
          sourceFileId: returned.id,
          sourceVersionId: returnVersions[0]!.id,
          sourceSha256: returnVersions[0]!.hash,
          sourceReference: "Original returned-work record",
          reason: "Retain returned service separately from an interruption",
          expectedId: null,
          expectedUpdatedAt: null,
        };
        assert.equal(await deleteFile(f.orgId, returned.id, audit), true);
        await assert.rejects(
          saveRoeSubsequentService(subject, certificate),
          /active original return-to-work source/,
        );
        assert.equal(await restoreFile(f.orgId, returned.id, audit), true);
        await saveRoeSubsequentService(subject, certificate);
        assert.equal(await isRetainedFileEvidence(f.orgId, returned.id), true);
        assert.equal(await deleteFile(f.orgId, returned.id, audit), false);
        assert.equal(
          await replaceFile({
            orgId: f.orgId,
            fileId: returned.id,
            filename: "changed-return.txt",
            contentType: "text/plain",
            bytes: Buffer.from("Changed return"),
            updatedBy: f.actorId,
            audit,
          }),
          false,
        );
        assert.equal(await purgeFile(f.orgId, returned.id, audit), "retained");
        const originalReturn = await getFileBlob(
          f.orgId,
          returned.id,
          viewer,
          returnVersions[0]!.id,
        );
        assert.ok(originalReturn);
        assert.deepEqual(originalReturn.bytes, returnBytes);
      });
    } finally {
      // Retained certificates must also leave an owned disposable fixture
      // cleanly; teardown verifies its complete org-scoped removal or reset.
      await withBypassContext(() => dropScratchOrg(f.orgId));
    }
  },
);
