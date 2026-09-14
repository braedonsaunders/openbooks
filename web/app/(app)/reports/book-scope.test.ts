import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Every on-screen report whose export resolves one accounting book
// (resolveReport validates ?book= and threads detailBookId for all nine
// journal-backed detail kinds) must offer the same book on screen: the P&L /
// balance-sheet precedent is reportBookSelection + a primaryFilter book picker
// + bookId threaded into the reader and every ledger drill + the book name in
// the paper header. Otherwise a shared ?book= URL shows primary-book data on
// screen while the export returns the selected book.
//
// Project-profitability is excluded: its primaryFilter slot is taken by the
// project-scope picker, so a book picker needs bar vocabulary, not a loader
// edit.

import ts from 'typescript';

const PAGES: Record<string, string> = {
  'general-ledger/view.ts': 'generalLedger', 'journal/view.ts': 'journalReport',
  'registers/view.ts': 'partyRegister', 'trial-balance/view.ts': 'trialBalance',
  'partners/view.ts': 'partnerBalances', 'cash-flow/view.ts': 'cashFlow',
  'cash-flow-indirect/view.ts': 'cashFlowIndirect', 'statements/[partyId]/view.ts': 'partnerStatement',
};
for (const [file, reader] of Object.entries(PAGES)) {
  test(`${file} scopes on-screen data and drills to the selected accounting book`, () => {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    let reads = 0;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === reader) {
        reads++;
        assert.match(node.arguments.map((arg) => arg.getText(tree)).join(','), /selectedBook\??\.id/);
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
