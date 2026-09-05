import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { ScratchOrgPool, createScratchOrg } from './test-fixtures.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(size = 2) {
  const calls = { bootstrap: 0, reset: 0, teardown: 0 };
  const store = {
    bootstrap: async () => ({ orgId: `fixture-${++calls.bootstrap}` }),
    reset: async () => { calls.reset++; },
    teardown: async () => { calls.teardown++; },
  };
  const pool = new ScratchOrgPool({ size, isolatedDatabase: true, store });
  return { pool, store, calls };
}
for (const warm of [false, true]) {
  test(`concurrent ${warm ? 'warm' : 'initial'} fixture leases reserve distinct bounded slots`, async () => {
    const { pool, calls } = fixture();
    const leased: string[] = [];
    try {
      if (warm) await pool.start();
      leased.push(...(await Promise.all([pool.lease(), pool.lease()])).map(org => org.orgId));
      assert.equal(new Set(leased).size, 2, JSON.stringify(leased));
      assert.equal(calls.bootstrap, 2, 'concurrent starts share one initialization');
      assert.equal(pool.metrics.activeLeases, 2);
    } finally {
      for (const id of new Set(leased)) await pool.release(id);
      await pool.close().catch(() => {});
    }
  });
}
test('overlapping releases join one reset and count one returned lease', async () => {
  const { pool, store, calls } = fixture(1);
  const gate = deferred();
  store.reset = async () => { calls.reset++; await gate.promise; };
  const org = await pool.lease();
  const first = pool.release(org.orgId);
  const second = pool.release(org.orgId);
  await Promise.resolve();
  const resetsStarted = calls.reset;
  gate.resolve();
  try {
    await Promise.all([first, second]);
    assert.equal(resetsStarted, 1);
    assert.equal(pool.metrics.resets, 1);
    assert.equal(pool.metrics.releases, 1);
    assert.equal(pool.metrics.activeLeases, 0);
  } finally { await pool.close().catch(() => {}); }
});
test('queued concurrent borrowers never share a tenant', { timeout: 5000 }, async () => {
  const { pool, calls } = fixture();
  const active = new Set<string>();
  const overlaps: string[] = [];
  let peak = 0;
  await pool.start();
  try {
    await Promise.all(Array.from({ length: 20 }, async () => {
      const org = await pool.lease();
      if (active.has(org.orgId)) overlaps.push(org.orgId);
      active.add(org.orgId); peak = Math.max(peak, active.size);
      await new Promise(resolve => setTimeout(resolve, 1));
      active.delete(org.orgId);
      await pool.release(org.orgId);
    }));
    assert.deepEqual(overlaps, []);
    assert.equal(calls.bootstrap, 2);
    assert.ok(peak <= 2);
    assert.equal(pool.metrics.leases, 20);
    assert.equal(pool.metrics.releases, 20);
    assert.equal(pool.metrics.activeLeases, 0);
  } finally { await pool.close().catch(() => {}); }
});
test('failed initialization still tears down every completed fixture', async () => {
  const { pool, store, calls } = fixture();
  store.bootstrap = async () => {
    if (++calls.bootstrap === 2) throw new Error('bootstrap failed');
    return { orgId: 'partial-fixture' };
  };
  await assert.rejects(pool.start(), /bootstrap failed/);
  await assert.rejects(pool.close());
  assert.equal(calls.teardown, 1, 'partial bootstrap must not leak a tenant');
});
test('concurrent closes wait for the same complete teardown', async () => {
  const { pool, store, calls } = fixture(1);
  const gate = deferred();
  store.teardown = async () => { calls.teardown++; await gate.promise; };
  await pool.start();
  const first = pool.close();
  let secondDone = false;
  const second = pool.close().then(() => { secondDone = true; });
  await Promise.resolve(); await Promise.resolve();
  const finishedEarly = secondDone;
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(finishedEarly, false);
  assert.equal(calls.teardown, 1);
});
test('closing waits for an in-flight reset before teardown and final accounting', async () => {
  const { pool, store, calls } = fixture(1);
  const gate = deferred();
  store.reset = async () => { calls.reset++; await gate.promise; };
  const org = await pool.lease();
  const release = pool.release(org.orgId);
  const close = pool.close(); close.catch(() => {});
  await Promise.resolve(); await Promise.resolve();
  const earlyTeardowns = calls.teardown;
  gate.resolve();
  const results = await Promise.allSettled([release, close]);
  assert.equal(earlyTeardowns, 0);
  assert.ok(results.every(result => result.status === 'fulfilled'), JSON.stringify(results));
  assert.equal(pool.metrics.activeLeases, 0);
  assert.equal(pool.metrics.leakDetections, 0);
});
test('losing the last healthy slot rejects every queued borrower', async () => {
  const { pool, store } = fixture(1);
  store.reset = async () => { throw new Error('unusable fixture'); };
  const org = await pool.lease();
  let settled = 0;
  const borrowers = [pool.lease(), pool.lease()].map(promise => promise.then(
    () => { settled++; return 'leased'; },
    () => { settled++; return 'rejected'; },
  ));
  await assert.rejects(pool.release(org.orgId), /unusable fixture/);
  await new Promise(resolve => setTimeout(resolve, 0));
  const beforeClose = settled;
  await pool.close().catch(() => {});
  const outcomes = await Promise.all(borrowers);
  assert.equal(beforeClose, 2, 'a permanently unusable pool must not strand borrowers');
  assert.deepEqual(outcomes, ['rejected', 'rejected']);
});

for (const payload of ['', '{"ok":true']) {
  test(`fixture owner ${payload ? 'partial reply' : 'clean close'} rejects the pending request`, { timeout: 5000 }, async () => {
    const server = createServer(socket => { socket.on('data', () => socket.end(payload)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const previousPort = process.env.OPENBOOKS_TEST_FIXTURE_OWNER_PORT;
    process.env.OPENBOOKS_TEST_FIXTURE_OWNER_PORT = String(address.port);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const error = await Promise.race([
        createScratchOrg().then(() => new Error('unexpected lease'), error => error),
        new Promise<Error>(resolve => { timer = setTimeout(() => resolve(new Error('request remained pending')), 1000); }),
      ]);
      assert.match(String(error), /fixture owner closed without a complete response/);
    } finally {
      clearTimeout(timer);
      if (previousPort === undefined) delete process.env.OPENBOOKS_TEST_FIXTURE_OWNER_PORT;
      else process.env.OPENBOOKS_TEST_FIXTURE_OWNER_PORT = previousPort;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
