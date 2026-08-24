import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    settings: {
      next: {
        rootDir: "web",
      },
    },
  },
  globalIgnores([
    "web/.next/**",
    "web/next-env.d.ts",
    "playwright-report/**",
    "test-results/**",
    // Vendored third-party tarballs are not maintained in this repository.
    "vendor/**",
  ]),
  // Next.js route handlers are server request scopes, not React render scopes;
  // they contain no components or hooks. The use-prefixed helpers they call
  // (e.g. useSecureCookies in web/lib/auth-policy.ts) are plain functions whose
  // name is pinned by the auth-route-contract tests, so the hooks rules cannot
  // apply here. They remain at error severity everywhere else.
  {
    files: ["web/app/api/**/route.ts"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
  // Debt surfaced when lint coverage was extended to the whole tree. These are
  // warnings pinned by --max-warnings in the `lint` script: the totals may go
  // down but never up. New production code must not add to them.
  //
  // - @typescript-eslint/no-explicit-any is hard-gated separately by
  //   scripts/check-explicit-any.mjs (decreasing budget), which runs ahead of
  //   lint in verify:release; this config keeps it visible without two gates
  //   disagreeing.
  // - The react-hooks/* diagnostics below are React Compiler-era checks that
  //   flagged existing UI debt on first full-tree run; burn-down pending.
  // - prefer-const / no-html-link-for-pages: small tracked debt, same ratchet.
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "prefer-const": "warn",
      "@next/next/no-html-link-for-pages": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/refs": "warn",
    },
  },
  // `module` is an accounting domain noun throughout this codebase (period
  // close modules, GL modules, navigation modules), so the CommonJS
  // module-object mutation hazard this Next.js rule guards against does not
  // apply; every match is a domain identifier, never module.exports interop.
  {
    rules: {
      "@next/next/no-assign-module-variable": "off",
    },
  },
]);
