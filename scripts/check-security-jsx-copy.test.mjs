import assert from 'node:assert/strict';
import test from 'node:test';
import { findLiteralCopy } from './check-security-jsx-copy.mjs';

test('security-page copy guard catches visible and accessible literal copy', () => {
  const findings = findLiteralCopy('<button aria-label="Revoke session">Disable MFA</button>');
  assert.deepEqual(findings.map(({ text }) => text), ['Revoke session', 'Disable MFA']);
});

test('security-page copy guard accepts translated expressions', () => {
  assert.deepEqual(findLiteralCopy('<button aria-label={t("revoke")}>{t("disableMfa")}</button>'), []);
});
