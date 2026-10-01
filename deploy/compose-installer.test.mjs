import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const digest = `ghcr.io/braedonsaunders/openbooks@sha256:${'a'.repeat(64)}`;

function installerFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'openbooks-compose-installer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'scripts'));
  mkdirSync(join(directory, 'bin'));
  copyFileSync(join(root, 'scripts/compose-up.sh'), join(directory, 'scripts/compose-up.sh'));
  writeFileSync(join(directory, 'bin/docker'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.INSTALLER_CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'image' && args[1] === 'inspect') process.stdout.write(${JSON.stringify(digest)} + '\\n');
`, { mode: 0o755 });
  const log = join(directory, 'docker-calls.jsonl');
  const env = {
    ...process.env,
    PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
    INSTALLER_CALL_LOG: log,
    OPENBOOKS_IMAGE: '',
    ORG_COUNTRY: 'ca',
    ORG_CURRENCY: 'cad',
  };
  return {
    directory,
    run: () => spawnSync('sh', [join(directory, 'scripts/compose-up.sh')], { env, encoding: 'utf8', timeout: 15_000 }),
    calls: () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
    readEnv: () => Object.fromEntries(readFileSync(join(directory, '.env.compose'), 'utf8').trim().split('\n').map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    })),
  };
}

test('first install generates separate database credentials and deploys the resolved image without building', (t) => {
  const fixture = installerFixture(t);
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const env = fixture.readEnv();
  const credentials = ['POSTGRES_OWNER_PASSWORD', 'OPENBOOKS_DB_PASSWORD', 'OPENBOOKS_BYPASS_DB_PASSWORD'].map((key) => env[key]);
  for (const credential of credentials) assert.match(credential, /^[a-f0-9]{48}$/);
  assert.equal(new Set(credentials).size, 3, 'database roles must have distinct credentials');
  assert.equal(env.OPENBOOKS_IMAGE, digest);
  assert.equal(env.ORG_COUNTRY, 'CA');
  assert.equal(env.ORG_CURRENCY, 'CAD');
  assert.equal(statSync(join(fixture.directory, '.env.compose')).mode & 0o777, 0o600);
  const calls = fixture.calls();
  assert.ok(calls.some(([command]) => command === 'pull'));
  assert.deepEqual(calls.at(-1), ['compose', '--env-file', join(fixture.directory, '.env.compose'), 'up', '-d', '--pull', 'always', '--wait', '--wait-timeout', '300']);
  assert.ok(calls.every((args) => !args.includes('build') && !args.includes('--build')));
});

test('rerunning the installer preserves the selected image and all credentials', (t) => {
  const fixture = installerFixture(t);
  assert.equal(fixture.run().status, 0);
  const before = fixture.readEnv();
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixture.readEnv(), before);
});

test('an older configuration missing the maintenance password refuses before starting services and names the repair', (t) => {
  const fixture = installerFixture(t);
  assert.equal(fixture.run().status, 0);
  const path = join(fixture.directory, '.env.compose');
  const existing = readFileSync(path, 'utf8').split('\n').filter((line) => !line.startsWith('OPENBOOKS_BYPASS_DB_PASSWORD=')).join('\n');
  writeFileSync(path, existing);
  const previousCalls = fixture.calls().length;
  const result = fixture.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENBOOKS_BYPASS_DB_PASSWORD is missing/);
  assert.match(result.stderr, /openssl rand -hex 24/);
  assert.match(result.stderr, /Keep the existing database passwords unchanged/);
  assert.equal(readFileSync(path, 'utf8'), existing);
  assert.equal(fixture.calls().length, previousCalls, 'refused installs must not start Docker services');
});
