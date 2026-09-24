import assert from 'node:assert/strict';
import test from 'node:test';
import { findLiteralCopy } from './check-admin-locale-jsx-copy.mjs';

test('admin copy guard catches visible and accessible literal copy', () => {
  const findings = findLiteralCopy('<button title="Re-pull data">Refresh now</button>');
  assert.deepEqual(findings.map(({ text }) => text), ['Re-pull data', 'Refresh now']);
});

test('admin copy guard accepts catalog-backed JSX expressions', () => {
  assert.deepEqual(findLiteralCopy('<button title={t("refreshTitle")}>{t("refresh")}</button>'), []);
});
