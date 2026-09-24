// source-pin-contract: every on-screen book-scoped report threads the selected book into its reader and drills; subjects derived by scanning reports views for the book picker, never hand-listed
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Every on-screen report whose export resolves one accounting book
// (resolveReport validates ?book= and threads detailBookId for all nine
// journal-backed detail kinds) must offer the same book on screen: the P&L /
// balance-sheet precedent is reportBookSelection + a primaryFilter book picker
// + bookId threaded into the reader and every ledger drill + the book name in
// the paper header. Otherwise a shared ?book= URL shows primary-book data on
// screen while the export returns the selected book.
//
// Project-profitability is excluded by construction: it offers no book picker
// (its primaryFilter slot is taken by the project-scope picker), so the
// subject scan below never selects it.

import ts from 'typescript';

const REPORTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Every reports view that offers the book picker — derived, never hand-listed. */
function viewsUsingBookPicker(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'view.ts' && readFileSync(full, 'utf8').includes('reportBookSelection(')) {
        found.push(relative(REPORTS_DIR, full));
      }
    }
  };
  walk(REPORTS_DIR);
  return found.sort();
}

for (const file of viewsUsingBookPicker()) {
  test(`${file} scopes on-screen data and drills to the selected accounting book`, () => {
    const source = readFileSync(join(REPORTS_DIR, file), 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    // The reader is whichever awaited data call takes the selected book id —
    // an options object (bookId: selectedBook?.id) or a positional trailing
    // argument. The module never matters: statement pages read through
    // lib/statement-matrix, detail pages through lib/reports. Awaited only
    // (through Promise.all too): drill-embedding spec builders carry the
    // same text nested in their arguments but never fetch.
    const isAwaited = (node: ts.Node): boolean => {
      let current = node.parent;
      while (current) {
        if (ts.isAwaitExpression(current)) return true;
        if (ts.isFunctionLike(current)) return false;
        current = current.parent;
      }
      return false;
    };
    let reads = 0;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        isAwaited(node) &&
        // Promise.all is the await-driver, not a data call: its array
        // argument textually contains the reader's threading.
        node.expression.getText(tree) !== 'Promise.all'
      ) {
        const args = node.arguments.map((arg) => arg.getText(tree)).join(',');
        if (/selectedBook\??\.id/.test(args)) reads++;
      }
      if (ts.isObjectLiteralExpression(node)) {
        const properties = node.properties.filter(ts.isPropertyAssignment);
        const kind = properties.find((prop) => prop.name.getText(tree) === 'kind');
        if (kind && ts.isStringLiteral(kind.initializer) && kind.initializer.text === 'ledger') {
          const book = properties.find((prop) => prop.name.getText(tree) === 'bookId');
          assert.ok(book, 'every ledger drill carries its accounting book');
          assert.match(book.initializer.getText(tree), /selectedBook\??\.id/);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.equal(reads, 1);
    assert.match(source, /reportBookSelection\(/);
    assert.match(source, /sp\.book/);
    assert.match(source, /primaryFilter:\s*f\('primaryFilter'\)/);
    assert.match(source, /paramKey:\s*'book'/);
    assert.match(source, /selectedBook\.name/);
  });
}

test("detail exports label the book basis when an org holds more than one book", () => {
  // P&L/Balance Sheet prefix the book name into periodPhrase; a secondary-book
  // detail CSV/PDF without the same label is not self-describing. Single-book
  // orgs stay byte-identical, so the prefix applies only when books.length > 1.
  const source = readFileSync(new URL("../../api/reports/statement/[kind]/export/route.ts", import.meta.url), "utf8");
  assert.match(source, /books\.length\s*>\s*1/);
  assert.match(source, /dateRangeLabel/);
  assert.match(source, /selectedBook\.name/);
});
