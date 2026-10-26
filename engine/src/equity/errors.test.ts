import assert from "node:assert/strict";
import test from "node:test";
import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { formatRefusalDate, renderRefusal } from "../platform/catalog-refusal.ts";
import { EquityError, equityError, fig } from "./errors.ts";
import { EQUITY_REFUSAL_AREAS, EQUITY_REFUSALS } from "./refusals/index.ts";
import { EQUITY_TERMS } from "./refusals/terms.ts";

test("a refusal renders its English text from its catalog entry, with share counts plural-selected and figures formatted", () => {
  const one = equityError(
    "exerciseExceedsVested",
    { ceiling: fig.shares(1n), date: fig.date("2026-03-01"), event: fig.choice("exercise") },
    { field: "quantity" },
  );
  const many = equityError(
    "exerciseExceedsVested",
    { ceiling: fig.shares(12500n), date: fig.date("2026-03-01"), event: fig.choice("exercise") },
    { field: "quantity" },
  );
  assert.ok(one instanceof EquityError);
  assert.equal(one.code, "equity_event_exceeds_vested");
  assert.equal(one.catalogKey, "equity.exerciseExceedsVested");
  assert.equal(one.field, "quantity");
  assert.match(one.message, /\b1 unit\b/);
  assert.doesNotMatch(one.message, /\b1 units\b/);
  assert.match(many.message, /12,500 units/);
  assert.match(many.message, /Mar 1, 2026/, "a date figure reads as a medium civil date");
});

test("figures render per locale without crossing binary floating point", () => {
  const values = {
    price: fig.price("3.5", "USD"),
    tiny: fig.price("0.0000100000", "USD"),
    amount: fig.money("73815000", "EUR"),
    big: fig.shares("12345678901234567890"),
    multiple: fig.multiple("0.5"),
    percent: fig.percent("12.5"),
    on: fig.date("2026-08-31"),
  };
  assert.equal(
    renderRefusal("{price} {tiny} {big}", values),
    "$3.5000 $0.00001 12,345,678,901,234,567,890",
    "prices read at four places, more only where four would show zero",
  );
  assert.equal(
    renderRefusal("{amount} {multiple} {percent}", values, "de-DE").replace(/\s/g, " "),
    "73.815.000,00 € 0,5× 12,5 %",
  );
  assert.equal(
    renderRefusal("{on}", values, "fr-FR"),
    new Intl.DateTimeFormat("fr-FR", {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date("2026-08-31T12:00:00Z")),
  );
  assert.equal(
    formatRefusalDate("0099-12-25", "en-US"),
    "Dec 25, 99",
    "early civil years are not moved into the twentieth century",
  );
  assert.equal(
    formatRefusalDate("2026-02-30", "en-US"),
    "2026-02-30",
    "an impossible date is left as written",
  );
});

test("a field a remedy names reads with the label the form shows", () => {
  const error = equityError(
    "preMoneyBasisTooShort",
    { field: fig.term("preMoneyBasisReason"), min: fig.count(5), max: fig.count(2000) },
    { field: "preMoneyBasisReason" },
  );
  assert.match(error.remedy, /under “Pre-money basis”/);
  assert.deepEqual(error.values.field, {
    kind: "term",
    key: "equity.fields.preMoneyBasisReason",
    text: "Pre-money basis",
  });
});

type Element = MessageFormatElement;

function walk(elements: readonly Element[], visit: (element: Element) => void): void {
  for (const element of elements) {
    visit(element);
    if (element.type === TYPE.plural || element.type === TYPE.select) {
      for (const option of Object.values(element.options)) walk(option.value, visit);
    }
  }
}

/** Whether every way a template can render ends with a full stop. */
function endsSentence(elements: readonly Element[]): boolean {
  const last = elements.at(-1);
  if (!last) return false;
  if (last.type === TYPE.literal) return /[.!?]\s*$/.test(last.value);
  if (last.type === TYPE.plural || last.type === TYPE.select)
    return Object.values(last.options).every((option) => endsSentence(option.value));
  return false;
}

test("every catalog entry is a valid ICU template whose arguments are exactly the figures it declares", () => {
  const offenders: string[] = [];
  for (const [key, spec] of Object.entries(EQUITY_REFUSALS)) {
    const params: Readonly<Record<string, string>> = "params" in spec ? spec.params : {};
    const used = new Set<string>();
    for (const [part, template] of [
      ["message", spec.message],
      ["remedy", spec.remedy],
    ] as const) {
      if (template.includes("#"))
        offenders.push(`${key}.${part} uses #; plural wording shows the exact figure instead`);
      let ast: Element[];
      try {
        ast = parse(template);
      } catch (error) {
        offenders.push(`${key}.${part} is not valid ICU: ${(error as Error).message}`);
        continue;
      }
      if (!endsSentence(ast)) offenders.push(`${key}.${part} does not end a sentence`);
      walk(ast, (element) => {
        if (element.type === TYPE.argument) {
          used.add(element.value);
          if (!(element.value in params))
            offenders.push(
              `${key}.${part} names {${element.value}}, which the entry does not declare`,
            );
        } else if (element.type === TYPE.plural) {
          const base = element.value.replace(/Count$/, "");
          used.add(base);
          if (
            !element.value.endsWith("Count") ||
            (params[base] !== "shares" && params[base] !== "count")
          )
            offenders.push(
              `${key}.${part} plural {${element.value}} is not a share or count figure`,
            );
          if (!("other" in element.options))
            offenders.push(`${key}.${part} plural {${element.value}} has no other branch`);
        } else if (element.type === TYPE.select) {
          used.add(element.value);
          if (params[element.value] !== "choice")
            offenders.push(
              `${key}.${part} selects on {${element.value}}, which is not a choice figure`,
            );
          if (!("other" in element.options))
            offenders.push(`${key}.${part} select {${element.value}} has no other branch`);
        } else if (element.type !== TYPE.literal) {
          offenders.push(`${key}.${part} uses an unsupported ICU element`);
        }
      });
    }
    for (const name of Object.keys(params))
      if (!used.has(name)) offenders.push(`${key} declares {${name}} but neither template uses it`);
    if (!/^equity_[a-z0-9_]+$/.test(spec.code)) offenders.push(`${key} has code ${spec.code}`);
  }
  assert.deepEqual(offenders, []);
});

test("catalog keys are unique across the areas, and every term names a catalog key", () => {
  const seen = new Map<string, string>();
  for (const [area, entries] of Object.entries(EQUITY_REFUSAL_AREAS)) {
    for (const key of Object.keys(entries)) {
      assert.equal(seen.get(key), undefined, `${key} is declared by ${seen.get(key)} and ${area}`);
      seen.set(key, area);
    }
  }
  assert.equal(seen.size, Object.keys(EQUITY_REFUSALS).length);
  for (const [name, term] of Object.entries(EQUITY_TERMS)) {
    assert.match(
      term.key,
      /^(equity\.|admin\.setup\.fields\.|refusals\.equity\.terms\.)/,
      `${name} names ${term.key}`,
    );
    if (term.key.startsWith("refusals.equity.terms."))
      assert.equal(term.key, `refusals.equity.terms.${name}`);
  }
});
