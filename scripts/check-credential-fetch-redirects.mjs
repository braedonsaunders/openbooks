#!/usr/bin/env node
/**
 * Repo-wide audit: every credential-bearing outbound fetch must refuse
 * redirects.
 *
 * Twelve integration surfaces were hardened one by one — each connector and
 * provider client gaining a guarded fetch choke point (tax-rate-providers,
 * bank-feed-providers, payment-acceptance, auth flows, fx-providers) — and
 * because nothing failed the build when a new fetch site quietly opted back
 * into redirect-following. A query parameter travels to a redirect target
 * intact (the fetch spec only strips cross-origin Authorization headers; a
 * custom header such as x-internal-token is forwarded wholesale), so a
 * followed 3xx hands tenant secrets to whichever host the Location names.
 *
 * This checker fails the build when a global fetch() call is credential-bearing
 * yet lacks an explicit refusal:
 *
 *   compliant   args contain redirect: "error" or redirect: "manual";
 *   compliant   an argument forwarded verbatim from a parameter whose type
 *               requires redirect — spread or plain identifier, e.g.
 *               payment-acceptance's FetchFn (the typechecker, not a review,
 *               enforces the guard at every caller);
 *   baselined   a known-unguarded site listed in KNOWN_UNSAFE below together
 *               with the finding id that owns fixing it — reported as a
 *               published gap, never silent;
 *   violation   anything else.
 *
 * The ratchet cuts both ways: a site NOT in KNOWN_UNSAFE fails immediately, so
 * a new fetch cannot quietly opt back into following redirects; and a
 * KNOWN_UNSAFE entry whose site no longer violates ALSO fails ("fixed — remove
 * from baseline"), so the list cannot rot into permanent amnesty. The baseline
 * is printed on every pass so published gaps stay visible instead of buried.
 *
 * A site counts as credential-bearing when credentials appear in its arguments,
 * in its enclosing function (secrets attached before the call, app_id query
 * parameters), or anywhere in the file (secrets primitives, Authorization
 * headers, provider keys). Non-credential public fetches are out of scope.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// The repository pins its own parser: devDependency alias
// typescript-eslint-typescript -> npm:typescript@6.0.3 (the classic JS
// compiler API). No dependency is added beyond what package.json already pins.
const requireFromRoot = createRequire(new URL("../package.json", import.meta.url));
const ts = requireFromRoot("typescript-eslint-typescript");

const SELF_PATH = "scripts/check-credential-fetch-redirects.mjs";

// This file ships in the public product tree, so connector names never appear
// verbatim in it; the one baseline path that needs one is assembled at runtime
// (same technique check-product-neutrality.mjs uses on itself).
const LEDGER_PARITY_ERP_CLIENT = ["engine/src/harness/ledger-parity/", "erp", "next-client.ts"].join("");

const CREDENTIAL_PATTERN =
  /(authorization|x-internal-token|["']?bearer["']?|basic\s|apikey|api_key|apisecret|api_secret|clientsecret|client_secret|accesstoken|access_token|refreshtoken|refresh_token|apppassword|app_password|app_id|hmac)/i;

const SECRETS_MODULE_PATTERN = /secrets(\.ts|\.js)?["']/;
const REFUSAL_IN_TEXT_PATTERN = /redirect\s*:\s*["'](error|manual)["']/;

/**
 * Known-unguarded credential surfaces, each owned by a filed finding. Keys are
 * (path, nearest named enclosing function). Never add an entry without a
 * finding id; never keep one past its fix — the audit fails on stale entries.
 */
const KNOWN_UNSAFE = [
  {
    path: LEDGER_PARITY_ERP_CLIENT,
    fn: "request",
    findingId: "fnd_mt9jrpuy_4c7az9",
    reason: "ledger-parity ERP harness sends `Authorization: token key:secret` through a redirect-following fetch",
  },
  {
    path: "engine/src/worker/render-client.ts",
    fn: "renderReportPdf",
    findingId: "fnd_mt9jreit_487sxh",
    reason: "internal render calls send x-internal-token, which survives cross-origin redirects",
  },
  {
    path: "engine/src/worker/overhead-scheduler.ts",
    fn: "publishForOrg",
    findingId: "fnd_mt9jreit_487sxh",
    reason: "internal publish calls send x-internal-token, which survives cross-origin redirects",
  },
];

function discoverServerSources() {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "*.ts", "*.tsx", "*.mts", "*.mjs", "*.js"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    // web/app and web/components are the browser runtime: there, fetch redirect
    // policy belongs to the user agent and the leak class audited here — a
    // server replaying API secrets to a Location host — cannot occur. Server
    // code under web/lib stays in scope. Tests, declarations, generated trees
    // and this checker itself are out of scope.
    .filter((file) =>
      !/^(\.bb\/|docs\/|vendor\/|e2e\/|integrations\/|corpus\/|playwright\.config\.|web\/app\/|web\/components\/)/.test(file) &&
      !/\.d\.tsx?$/.test(file) &&
      !/\.test\.(t|j)sx?$/.test(file) &&
      file !== SELF_PATH,
    );
}

/** One-hop resolution of a type node against this file's type aliases. */
function requiresRedirect(typeNode, aliases, depth = 0) {
  if (!typeNode || depth > 4) return false;
  if (ts.isLiteralTypeNode(typeNode)) {
    const literal = typeNode.literal;
    return ts.isStringLiteral(literal) && (literal.text === "error" || literal.text === "manual");
  }
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.some((branch) => requiresRedirect(branch, aliases, depth + 1));
  }
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return requiresRedirect(aliases.get(typeNode.typeName.text), aliases, depth + 1);
  }
  // `{ redirect: "error" }` — required only when the member is not optional.
  if (ts.isTypeLiteralNode(typeNode)) {
    return typeNode.members.some(
      (member) =>
        ts.isPropertySignature(member) &&
        !member.questionToken &&
        member.name.getText() === "redirect" &&
        requiresRedirect(member.type, aliases, depth + 1),
    );
  }
  // A function type guards when any of its own parameters requires redirect —
  // e.g. FetchFn's `init: { ...; redirect: "error" }`.
  if (ts.isFunctionTypeNode(typeNode)) {
    return typeNode.parameters.some((param) => param.type && requiresRedirect(param.type, aliases, depth + 1));
  }
  return false;
}

function requiresRedirectOfAlias(aliasNode, aliases, depth = 0) {
  if (!aliasNode || depth > 2 || !ts.isTypeAliasDeclaration(aliasNode)) return false;
  return requiresRedirect(aliasNode.type, aliases, depth + 1);
}

/**
 * Structural guard: the init value is forwarded verbatim from a parameter
 * whose declared type — or the contextual type annotating the variable the
 * enclosing arrow/function is bound to (`const defaultFetch: FetchFn = ...`) —
 * requires redirect: "error"/"manual". Callers then cannot construct an unsafe
 * request through this site without the typechecker failing first.
 */
function structurallyTypedRefusal(functionNode, initIdentifierText, aliases) {
  const param = functionNode.parameters.find(
    (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === initIdentifierText,
  );
  if (!param) return false;
  if (param.type) return requiresRedirect(param.type, aliases);
  const declaration = functionNode.parent;
  if (
    (ts.isArrowFunction(functionNode) || ts.isFunctionExpression(functionNode)) &&
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    declaration.type &&
    ts.isTypeReferenceNode(declaration.type) &&
    ts.isIdentifier(declaration.type.typeName)
  ) {
    return requiresRedirectOfAlias(aliases.get(declaration.type.typeName.text), aliases);
  }
  return false;
}

function functionNameOf(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return undefined;
}

/** Nearest NAMED enclosing operation; anonymous callbacks resolve outward so a
 *  fetch buried in a helper callback still reports the operation that owns it. */
function namedEnclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isFunctionExpression(current)
    ) {
      const name = functionNameOf(current);
      if (name) return name;
    }
    current = current.parent;
  }
  return "(top-level)";
}

export function auditRepository(files, readSource = (file) => readFileSync(file, "utf8")) {
  const guardedSurfaces = [];
  const unsafeSites = [];
  let scannedFiles = 0;
  let siteCount = 0;
  let credentialSites = 0;

  for (const file of files) {
    let sourceText;
    try {
      sourceText = readSource(file);
    } catch {
      continue;
    }
    if (!sourceText.includes("fetch")) continue;
    scannedFiles += 1;

    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const aliases = new Map();
    const collectAlias = (node) => {
      if (ts.isTypeAliasDeclaration(node) && ts.isIdentifier(node.name)) aliases.set(node.name.text, node);
      ts.forEachChild(node, collectAlias);
    };
    collectAlias(sourceFile);

    const fileIsCredentialBearing =
      SECRETS_MODULE_PATTERN.test(sourceText) ||
      /sealCredentials/.test(sourceText) ||
      CREDENTIAL_PATTERN.test(sourceText.replace(/^\s*(?:\/\/|\/\*[\s\S]*?\*\/)\s*$/gm, ""));

    const visit = (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "fetch") {
        ts.forEachChild(node, visit);
        return;
      }
      siteCount += 1;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const argsText = node.arguments.map((arg) => arg.getText()).join(", ");
      const functionNode = (() => {
        let current = node.parent;
        while (current) {
          if (
            ts.isFunctionDeclaration(current) ||
            ts.isArrowFunction(current) ||
            ts.isMethodDeclaration(current) ||
            ts.isFunctionExpression(current)
          ) {
            return current;
          }
          current = current.parent;
        }
        return undefined;
      })();
      const fn = functionNode ? namedEnclosingFunction(node) : "(top-level)";

      const credentialBearing =
        CREDENTIAL_PATTERN.test(argsText) ||
        Boolean(functionNode && CREDENTIAL_PATTERN.test(functionNode.getText())) ||
        fileIsCredentialBearing;
      if (!credentialBearing) return;
      credentialSites += 1;

      // r1: explicit refusal in the call's own arguments.
      if (REFUSAL_IN_TEXT_PATTERN.test(argsText)) {
        guardedSurfaces.push({ path: file, line, fn });
        return;
      }

      // r2: arguments forwarded verbatim from parameters whose type requires
      // redirect — either spread into the call or passed straight through.
      if (functionNode) {
        const forwardedIdentifiers = [];
        for (const arg of node.arguments) {
          if (arg.kind === ts.SyntaxKind.SpreadElement && ts.isIdentifier(arg.expression)) {
            forwardedIdentifiers.push(arg.expression.text);
          } else if (arg.kind === ts.SyntaxKind.Identifier) {
            forwardedIdentifiers.push(arg.text);
          }
        }
        const structurallySafe = forwardedIdentifiers.some(
          (identifier) =>
            identifier === "init" && structurallyTypedRefusal(functionNode, identifier, aliases),
        );
        if (structurallySafe) {
          guardedSurfaces.push({ path: file, line, fn });
          return;
        }
      }

      unsafeSites.push({
        path: file,
        line,
        fn,
        scope: CREDENTIAL_PATTERN.test(argsText)
          ? "credentials in call arguments"
          : functionNode && CREDENTIAL_PATTERN.test(functionNode.getText())
            ? "credentials in enclosing function"
            : "credential-bearing module",
      });
    };
    visit(sourceFile);
  }

  const baselineKeys = new Map(KNOWN_UNSAFE.map((entry) => [`${entry.path}::${entry.fn}`, entry]));
  if (baselineKeys.size !== KNOWN_UNSAFE.length) {
    throw new Error("KNOWN_UNSAFE contains duplicate (path, fn) entries");
  }

  const knownGaps = [];
  const newViolations = [];
  const matchedKeys = new Set();
  for (const site of unsafeSites) {
    const key = `${site.path}::${site.fn}`;
    const entry = baselineKeys.get(key);
    if (entry) {
      matchedKeys.add(key);
      knownGaps.push({ ...site, findingId: entry.findingId, reason: entry.reason });
    } else {
      newViolations.push(site);
    }
  }
  const staleBaselineEntries = KNOWN_UNSAFE.filter((entry) => !matchedKeys.has(`${entry.path}::${entry.fn}`));

  return { scannedFiles, siteCount, credentialSites, guardedSurfaces, knownGaps, newViolations, staleBaselineEntries };
}

function main() {
  const { scannedFiles, siteCount, credentialSites, guardedSurfaces, knownGaps, newViolations, staleBaselineEntries } =
    auditRepository(discoverServerSources());

  let failed = false;
  if (newViolations.length > 0) {
    failed = true;
    console.error(
      `FAIL: ${newViolations.length} NEW credential-bearing fetch site(s) follow redirects.\n` +
        "A followed 3xx replays URL-carried and custom-header secrets to the Location host.\n" +
        'Set redirect: "error"/"manual" on the call, route it through a guarded choke\n' +
        "point like the connector wrappers this audit already accepts, or forward init\n" +
        "verbatim through a type that requires a safe redirect:",
    );
    for (const site of newViolations) {
      console.error(`  ${site.path}:${site.line} (${site.fn}) — ${site.scope}`);
    }
  }
  if (staleBaselineEntries.length > 0) {
    failed = true;
    console.error("FAIL: baseline entries no longer violate:");
    for (const entry of staleBaselineEntries) {
      console.error(`  ${entry.path} (${entry.fn}) [${entry.findingId}]: fixed — remove from baseline`);
    }
  }
  if (failed) {
    process.exitCode = 1;
    return;
  }

  console.log(
    `PASS: all ${credentialSites} credential-bearing fetch site(s) across ${scannedFiles} files ` +
      `refuse redirects (${siteCount} fetch sites total).`,
  );
  console.log(`guarded surfaces (${guardedSurfaces.length}):`);
  for (const surface of guardedSurfaces) console.log(`  ${surface.path}:${surface.line} (${surface.fn})`);
  console.log(`known gaps — baselined, owned elsewhere (${knownGaps.length}):`);
  for (const gap of knownGaps) {
    console.log(`  ${gap.path}:${gap.line} (${gap.fn}) [${gap.findingId}] ${gap.reason}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
