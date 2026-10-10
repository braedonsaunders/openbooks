import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Object storage is the external boundary; native transactions and isolation stay real.
const storageUrl = new URL('../platform/file-storage.ts', import.meta.url).href;
const blobs = new Map<string, Buffer>();
Object.assign(globalThis, { __transactionFileBlobs: blobs });
const stubUrl = `data:text/javascript,${encodeURIComponent(`
  export * from ${JSON.stringify(storageUrl)};
  export const s3Enabled = true;
  export async function putS3Blob(id, bytes) { globalThis.__transactionFileBlobs.set(id, bytes); if (globalThis.__transactionFilePutFailure) throw new Error("Object write response failed"); }
  export async function getS3Blob(id) { return globalThis.__transactionFileBlobs.get(id) ?? null; }
  export async function deleteS3Blobs(ids) { for (const id of ids) globalThis.__transactionFileBlobs.delete(id); }
`)}`;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL !== stubUrl && (specifier === storageUrl || specifier.endsWith('/file-storage.ts'))) return { shortCircuit: true, url: stubUrl };
  return next(specifier, context);
} });
const { db, withBypassContext, withOrgContext } = await import('../platform/db.ts');
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('../testing/fixtures.ts');
const { sql } = await import('drizzle-orm');
const { syncTransactionAttachments, linkExistingTransactionFiles } = await import('./transaction-attachments.ts');
const { persistTransactionFile, verifyTransactionFiles } = await import('./transaction-file-storage.ts');

test('transaction files backfill old records, reconcile links without downloading, retain versions and audit, and refuse foreign targets', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const foreign = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, 'File sync administrator', 'file_sync_admin');
    const connectionId = randomUUID(), docId = randomUUID(), secondId = randomUUID(), foreignId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`insert into connections(id, org_id, source, display_name) values(${connectionId}, ${org.orgId}, 'qbo', 'Transaction evidence')`);
      for (const [owner, id, ref, kind] of [[org, docId, 'Bill:2', 'vendor_bill'], [org, secondId, 'Purchase:3', 'expense_report'], [foreign, foreignId, 'Bill:2', 'vendor_bill']] as const) {
        await db.execute(sql`insert into documents(id, org_id, subsidiary_id, kind, document_number, document_date, currency, status, subtotal, tax_total, total, custom)
          values(${id}, ${owner.orgId}, ${owner.subsidiaryId}, ${kind}, ${id}, '2026-01-01', 'CAD', 'draft', 0, 0, 0,
            ${JSON.stringify({ qboId: ref, connectionId })}::jsonb)`);
      }
    });
    let bytes = Buffer.from('%PDF-1.7 original'), modifiedAt = new Date('2026-10-01T00:00:00Z'), downloads = 0;
    let attachSecond = false;
    const options = { orgId: org.orgId, connectionId, actorId };
    const provider = { source: 'qbo', refKey: 'qboId', inventory: async (transactions: { id: string; sourceRef: string }[]) => {
      assert.deepEqual(new Set(transactions.map((row) => row.id)), new Set([docId, secondId]), 'all old native records are inventoried without the financial cursor or foreign records');
      return [{ id: '7', name: 'bill.pdf', modifiedAt, size: bytes.length, transactionRefs: attachSecond ? ['Bill:2', 'Purchase:3'] : ['Bill:2'] }];
    }, download: async () => { downloads++; return bytes; } };
    await withOrgContext(org.orgId, async () => {
      const first = await syncTransactionAttachments(provider, options);
      assert.equal(first.createdFiles, 1); assert.equal(first.createdLinks, 1);
      attachSecond = true;
      const second = await syncTransactionAttachments(provider, options);
      assert.equal(second.skippedUnchanged, 1); assert.equal(second.createdLinks, 1); assert.equal(downloads, 1);
      const replay = await syncTransactionAttachments(provider, options);
      assert.equal(replay.createdLinks, 0); assert.equal(downloads, 1);
      bytes = Buffer.from('%PDF-1.7 corrected'); modifiedAt = new Date('2026-10-02T00:00:00Z');
      const updated = await syncTransactionAttachments(provider, options);
      assert.equal(updated.newVersions, 1);
      const id = `${connectionId}:7`;
      await verifyTransactionFiles(org.orgId, 'qbo', new Map([[id, new Set([docId, secondId])]]), true);
      const counts = (await db.execute<{ files: number; versions: number; links: number; audits: number }>(sql`select
        (select count(*)::int from files where org_id=${org.orgId}) as files,
        (select count(*)::int from file_versions v join files f on f.id=v.file_id where f.org_id=${org.orgId}) as versions,
        (select count(*)::int from file_attachments where org_id=${org.orgId}) as links,
        (select count(*)::int from audit_log where org_id=${org.orgId} and actor_id=${actorId} and table_name in ('files','file_attachments')) as audits`)).rows[0]!;
      assert.deepEqual(counts, { files: 1, versions: 2, links: 2, audits: 3 });
      await assert.rejects(linkExistingTransactionFiles(org.orgId, 'qbo', actorId, [{ sourceId: id, documentId: foreignId }]), /unavailable in this organization/);
      await assert.rejects(syncTransactionAttachments(provider, { ...options, actorId: randomUUID() }), /active user/);
      const source = { id: `${connectionId}:concurrent`, name: 'receipt.pdf' };
      const input = { orgId: org.orgId, sourceSystem: 'qbo', actorId, source, targetDocumentIds: [secondId], bytes, contentType: 'application/pdf', sourceModifiedAt: modifiedAt };
      const simultaneous = await Promise.all([persistTransactionFile(input), persistTransactionFile(input)]);
      assert.equal(simultaneous.filter((result) => result.created).length, 1);
      assert.equal(simultaneous.filter((result) => result.unchanged).length, 1);
      const older = await persistTransactionFile({ ...input, bytes: Buffer.from('older snapshot'), sourceModifiedAt: new Date('2026-10-01T00:00:00Z') });
      assert.equal(older.stale, true); assert.equal(older.versioned, false);
      await assert.rejects(persistTransactionFile({ ...input, source: { id: 'foreign-target', name: 'bill.pdf' }, targetDocumentIds: [foreignId] }), /not a transaction in this organization/);
      Object.assign(globalThis, { __transactionFilePutFailure: true });
      try { await assert.rejects(persistTransactionFile({ ...input, source: { id: 'failed-write', name: 'bill.pdf' } }), /Object write response failed/); }
      finally { Object.assign(globalThis, { __transactionFilePutFailure: false }); }
      assert.equal((await db.execute(sql`select id from files where org_id=${org.orgId} and source_id='failed-write'`)).rows.length, 0, 'the file row and version roll back together');
      const cleanup = (await db.execute<{ object_key: string }>(sql`select object_key from storage_cleanup_outbox where org_id=${org.orgId}`)).rows;
      assert.equal(cleanup.length, 1, 'a blob whose write response failed has a durable cleanup intent');
      assert.ok(cleanup[0]!.object_key.startsWith('file-cabinet/'));

    });
    await withOrgContext(foreign.orgId, () => assert.rejects(syncTransactionAttachments(provider, { ...options, orgId: foreign.orgId }), /does not match this organization/));
  } finally { await dropScratchOrg(foreign.orgId); await dropScratchOrg(org.orgId); blobs.clear(); }
});
