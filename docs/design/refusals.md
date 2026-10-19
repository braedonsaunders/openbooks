# Catalog-backed refusals

A domain refusal reaches the operator in the operator's language: its message
and remedy render from the locale catalogs, with every figure formatted for
the reader and every field name read from the same catalog key as the form
label it names.

## The contract

- The engine raises a refusal by **catalog key** and **typed figures**. The
  contract is `CatalogRefusal` in
  [`engine/src/platform/catalog-refusal.ts`](../../engine/src/platform/catalog-refusal.ts):
  a stable API `code`, a `catalogKey` (`<module>.<key>`), the `values`, and an
  English `message` and `remedy` for logs and callers that have no reader.
- Figures are typed: `shares`, `count`, `money` (with its currency), `price`
  (a price per share, four places), `decimal`, `multiple`, `percent`, `date`,
  `period`, `text` (recorded text such as a security number), `list`, `choice`
  (an enum value the template selects wording by) and `term` (a catalog key,
  usually a form field label). Templates never interpolate free text.
- Each module keeps a registry of its entries — code, status, English ICU
  templates and the kind of each figure — and a typed factory, so a call site
  cannot pass a figure of the wrong kind. Equity's registry is
  [`engine/src/equity/refusals/`](../../engine/src/equity/refusals/index.ts).

## Templates

Templates are ICU messages. `{name}` inserts a formatted figure. A share or
count figure `x` selects plural wording as `{xCount, plural, one {…} other {…}}`
— the digits shown always come from the exact value, never from `#`. A choice
figure selects wording with `{name, select, … other {…}}`. A field the remedy
tells the reader to fill is a `term` figure, quoted in the template.

## Rendering

- The locale catalogs hold the entries under `refusals.<module>.<key>.message`
  and `.remedy` (`web/messages/<locale>/refusals.json`). The English catalog
  carries the engine's English text verbatim; a test pins the two together.
- `apiErrorResponse` renders any catalog refusal through
  [`web/lib/reader-refusal.ts`](../../web/lib/reader-refusal.ts); server views
  render refusals they hold (a run that cannot post, an attention item) the
  same way. A refusal whose entry is missing keeps its English text.
- Surfaces that show a refusal on one line join it with its remedy through
  [`joinRefusal`](../../web/lib/refusal-sentence.ts), which keeps sentence
  punctuation in every script.

## Adding a refusal

Add the entry to the module's registry, raise it through the factory, and add
the entry to `refusals.json` in every locale (English verbatim). The catalog
tests refuse a missing locale, an English drift, an unfilled argument and an
English sentence in a translated catalog.
