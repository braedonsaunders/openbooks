import assert from "node:assert/strict";
import test from "node:test";
import { fromUnits, toUnits } from "../money/money.ts";
import {
  computeLineTaxes,
  TaxCalculationError,
  type ComputedLineTax,
  type TaxComponentConfig,
} from "./tax.ts";

function component(
  taxCodeId: string,
  sequence: number,
  options: Partial<TaxComponentConfig> = {},
): TaxComponentConfig {
  return { taxCodeId, sequence, ratePercent: "10", ...options };
}

function assertCrossFoot(result: ComputedLineTax): void {
  let standard = 0n;
  let withholding = 0n;
  for (const tax of result.components) {
    assert.equal(
      toUnits(tax.recoverableAmount) + toUnits(tax.nonrecoverableAmount),
      toUnits(tax.taxAmount),
      `${tax.taxCodeId} recovery must reconcile to its tax`,
    );
    if (tax.calculationType === "standard") standard += toUnits(tax.taxAmount);
    if (tax.calculationType === "withholding") withholding += toUnits(tax.taxAmount);
  }
  assert.equal(toUnits(result.taxTotal), standard - withholding);
  assert.equal(toUnits(result.total), toUnits(result.netAmount) + standard - withholding);
}

function assertCreditSymmetry(
  input: string,
  profile: TaxComponentConfig[],
  override?: string,
): void {
  const debit = computeLineTaxes(
    input,
    profile,
    override === undefined ? undefined : { overridden: true, taxAmount: override },
  );
  const credit = computeLineTaxes(
    fromUnits(-toUnits(input)),
    profile,
    override === undefined
      ? undefined
      : { overridden: true, taxAmount: fromUnits(-toUnits(override)) },
  );
  assert.deepEqual(credit, {
    ...debit,
    inputAmount: fromUnits(-toUnits(debit.inputAmount)),
    netAmount: fromUnits(-toUnits(debit.netAmount)),
    taxTotal: fromUnits(-toUnits(debit.taxTotal)),
    total: fromUnits(-toUnits(debit.total)),
    components: debit.components.map((tax) => ({
      ...tax,
      taxableAmount: fromUnits(-toUnits(tax.taxableAmount)),
      taxAmount: fromUnits(-toUnits(tax.taxAmount)),
      recoverableAmount: fromUnits(-toUnits(tax.recoverableAmount)),
      nonrecoverableAmount: fromUnits(-toUnits(tax.nonrecoverableAmount)),
    })),
  });
  assertCrossFoot(debit);
  assertCrossFoot(credit);
}

test("manual recovery rounds from the configured ratio at the four-decimal boundary", () => {
  const cases = [
    ["0.0001", "50", "0.0001", "0.0000"],
    ["0.0003", "50", "0.0002", "0.0001"],
    ["1.2345", "33.3333", "0.4115", "0.8230"],
    ["1.2345", "0", "0.0000", "1.2345"],
    ["1.2345", "100", "1.2345", "0.0000"],
  ] as const;
  for (const [override, recovery, recoverable, nonrecoverable] of cases) {
    const profile = [
      component("recoverable", 1, {
        ratePercent: "0",
        recoverablePercent: recovery,
      }),
    ];
    const result = computeLineTaxes("0.0001", profile, {
      overridden: true,
      taxAmount: override,
    });
    assert.equal(result.components[0]!.recoverableAmount, recoverable);
    assert.equal(result.components[0]!.nonrecoverableAmount, nonrecoverable);
    assert.equal(result.components[0]!.taxAmount, override);
    assertCreditSymmetry("0.0001", profile, override);
  }
});

test("inclusive compound overrides retain the entered gross and ordered taxable bases", () => {
  const profile = [
    component("compound", 2, {
      ratePercent: "9.975",
      priceIncludesTax: true,
      compoundOnPrevious: true,
      recoverablePercent: "40",
    }),
    component("first", 1, { ratePercent: "5", priceIncludesTax: true }),
  ];
  const result = computeLineTaxes("115.47", profile, {
    overridden: true,
    taxAmount: "15",
  });
  assert.equal(result.netAmount, "100.4700");
  assert.equal(result.total, "115.4700");
  assert.deepEqual(
    result.components.map((tax) => ({
      id: tax.taxCodeId,
      basis: tax.taxableAmount,
      tax: tax.taxAmount,
      recoverable: tax.recoverableAmount,
      nonrecoverable: tax.nonrecoverableAmount,
      overridden: tax.overridden,
    })),
    [
      {
        id: "first",
        basis: "100.4700",
        tax: "5.0200",
        recoverable: "5.0200",
        nonrecoverable: "0.0000",
        overridden: false,
      },
      {
        id: "compound",
        basis: "105.4900",
        tax: "9.9800",
        recoverable: "3.9920",
        nonrecoverable: "5.9880",
        overridden: true,
      },
    ],
  );
  assertCreditSymmetry("115.47", profile, "15");
});

test("a standard override excludes independent reverse charge and withholding from settlement tax", () => {
  const profile = [
    component("withholding", 1, { ratePercent: "10", calculationType: "withholding" }),
    component("reverse", 2, {
      ratePercent: "20",
      calculationType: "reverse_charge",
      recoverablePercent: "75",
    }),
    component("standard", 3, { ratePercent: "5", recoverablePercent: "0" }),
  ];
  const result = computeLineTaxes("100", profile, {
    overridden: true,
    taxAmount: "7",
  });
  assert.deepEqual(
    result.components.map((tax) => tax.taxAmount),
    ["10.0000", "20.0000", "7.0000"],
  );
  assert.equal(result.components[1]!.recoverableAmount, "15.0000");
  assert.equal(result.components[2]!.nonrecoverableAmount, "7.0000");
  assert.equal(result.taxTotal, "-3.0000");
  assert.equal(result.total, "97.0000");
  assertCreditSymmetry("100", profile, "7");
});

test("withholding never increases the basis of a later compound standard tax", () => {
  const profile = [
    component("withholding", 1, { calculationType: "withholding" }),
    component("first", 2, { ratePercent: "5" }),
    component("compound", 3, { compoundOnPrevious: true }),
  ];
  const result = computeLineTaxes("100", profile, {
    overridden: true,
    taxAmount: "15",
  });
  assert.deepEqual(
    result.components.map((tax) => [tax.taxableAmount, tax.taxAmount]),
    [
      ["100.0000", "10.0000"],
      ["100.0000", "5.0000"],
      ["105.0000", "10.0000"],
    ],
  );
  assert.equal(result.total, "105.0000");
  assertCreditSymmetry("100", profile, "15");
});

test("downstream compound taxes use the overridden standard amount and exclude withholding from their basis", () => {
  const profile = [
    component("standard", 1, { recoverablePercent: "50" }),
    component("reverse", 2, {
      ratePercent: "20",
      calculationType: "reverse_charge",
      compoundOnPrevious: true,
      recoverablePercent: "75",
    }),
    component("withholding", 3, {
      calculationType: "withholding",
      compoundOnPrevious: true,
    }),
    component("final-reverse", 4, {
      ratePercent: "5",
      calculationType: "reverse_charge",
      compoundOnPrevious: true,
    }),
  ];
  const result = computeLineTaxes("100", profile, {
    overridden: true,
    taxAmount: "20",
  });
  assert.deepEqual(
    result.components.map((tax) => [tax.taxableAmount, tax.taxAmount]),
    [
      ["100.0000", "20.0000"],
      ["120.0000", "24.0000"],
      ["144.0000", "14.4000"],
      ["144.0000", "7.2000"],
    ],
  );
  assert.equal(result.components[0]!.recoverableAmount, "10.0000");
  assert.equal(result.components[1]!.recoverableAmount, "18.0000");
  assert.equal(result.taxTotal, "5.6000");
  assert.equal(result.total, "105.6000");
  assertCreditSymmetry("100", profile, "20");
});

test("inclusive manual overrides reprice downstream compound bases without changing the entered gross", () => {
  const profile = [
    component("standard", 1, { priceIncludesTax: true }),
    component("reverse", 2, {
      ratePercent: "20",
      calculationType: "reverse_charge",
      compoundOnPrevious: true,
    }),
    component("withholding", 3, {
      calculationType: "withholding",
      compoundOnPrevious: true,
    }),
  ];
  const result = computeLineTaxes("110", profile, {
    overridden: true,
    taxAmount: "8",
  });
  assert.equal(result.netAmount, "102.0000");
  assert.deepEqual(
    result.components.map((tax) => [tax.taxableAmount, tax.taxAmount]),
    [
      ["102.0000", "8.0000"],
      ["110.0000", "22.0000"],
      ["132.0000", "13.2000"],
    ],
  );
  assert.equal(result.total, "96.8000");
  assertCreditSymmetry("110", profile, "8");
});

test("mixed inclusive and exclusive standard components refuse regardless of ordering or override", () => {
  const included = component("included", 1, { priceIncludesTax: true });
  const excluded = component("excluded", 2);
  for (const profile of [
    [included, excluded],
    [excluded, included],
  ]) {
    for (const input of ["100", "-100"]) {
      assert.throws(
        () =>
          computeLineTaxes(input, profile, {
            overridden: true,
            taxAmount: input.startsWith("-") ? "-5" : "5",
          }),
        (error) =>
          error instanceof TaxCalculationError &&
          /cannot mix inclusive and exclusive/.test(error.message),
      );
    }
  }
});

test("manual aggregate overrides cannot erase an earlier fixed standard component", () => {
  const profile = [component("fixed", 1, { ratePercent: "5" }), component("adjustable", 2)];
  for (const sign of [1n, -1n]) {
    assert.throws(
      () =>
        computeLineTaxes(fromUnits(1000000n * sign), profile, {
          overridden: true,
          taxAmount: fromUnits(49999n * sign),
        }),
      (error) =>
        error instanceof TaxCalculationError &&
        /cannot make a component negative/.test(error.message),
    );
  }
  const zeroLast = computeLineTaxes("100", profile, { overridden: true, taxAmount: "5" });
  assert.deepEqual(
    zeroLast.components.map((tax) => tax.taxAmount),
    ["5.0000", "0.0000"],
  );
  assertCrossFoot(zeroLast);
});

test("inclusive manual tax refuses when the gross leaves no feasible nonnegative last component", () => {
  const profile = [
    component("fixed", 1, { priceIncludesTax: true }),
    component("adjustable", 2, { priceIncludesTax: true }),
  ];
  // An aggregate tax of 1 leaves net 99, whose fixed first tax alone is 9.90.
  for (const [input, override] of [
    ["100", "1"],
    ["-100", "-1"],
  ]) {
    assert.throws(
      () =>
        computeLineTaxes(input!, profile, {
          overridden: true,
          taxAmount: override!,
        }),
      (error) => error instanceof TaxCalculationError && /cannot reconcile/.test(error.message),
    );
  }
});

test("sub-cent inclusive reconciliation changes only standard tax and preserves credit symmetry", () => {
  const profile = [
    component("included", 1, {
      ratePercent: "100",
      priceIncludesTax: true,
      recoverablePercent: "50",
    }),
    component("reverse", 2, {
      ratePercent: "20",
      calculationType: "reverse_charge",
      roundingScale: 4,
    }),
    component("withholding", 3, {
      ratePercent: "10",
      calculationType: "withholding",
      roundingScale: 4,
    }),
  ];
  const result = computeLineTaxes("0.0050", profile);
  assert.equal(result.netAmount, "0.0049");
  assert.deepEqual(
    result.components.map((tax) => [tax.taxAmount, tax.overridden]),
    [
      ["0.0001", true],
      ["0.0010", false],
      ["0.0005", false],
    ],
  );
  assert.equal(result.components[0]!.recoverableAmount, "0.0001");
  assert.equal(result.total, "0.0045");
  assertCreditSymmetry("0.0050", profile);
});

test("automatic inclusive rounding residues feed the actual downstream compound basis", () => {
  const profile = [
    component("included", 1, { ratePercent: "100", priceIncludesTax: true }),
    component("reverse", 2, {
      ratePercent: "100",
      calculationType: "reverse_charge",
      compoundOnPrevious: true,
      roundingScale: 4,
    }),
    component("withholding", 3, {
      calculationType: "withholding",
      compoundOnPrevious: true,
      roundingScale: 4,
    }),
  ];
  const result = computeLineTaxes("0.0050", profile);
  assert.deepEqual(
    result.components.map((tax) => [tax.taxableAmount, tax.taxAmount]),
    [
      ["0.0049", "0.0001"],
      ["0.0050", "0.0050"],
      ["0.0100", "0.0010"],
    ],
  );
  assert.equal(result.total, "0.0040");
  assertCreditSymmetry("0.0050", profile);
});

test("credit symmetry and component settlement cross-foot hold across rounding and recovery profiles", () => {
  for (const scale of [0, 1, 2, 3, 4]) {
    for (const recovery of ["0", "33.3333", "100"]) {
      const profile = [
        component("reverse", 1, {
          ratePercent: "7.125",
          calculationType: "reverse_charge",
          roundingScale: scale,
          recoverablePercent: recovery,
        }),
        component("first", 2, {
          ratePercent: "5.125",
          compoundOnPrevious: true,
          roundingScale: scale,
        }),
        component("withholding", 3, {
          ratePercent: "3.3333",
          calculationType: "withholding",
          roundingScale: scale,
        }),
        component("last", 4, {
          ratePercent: "9.975",
          compoundOnPrevious: true,
          roundingScale: scale,
          recoverablePercent: recovery,
        }),
      ];
      for (const input of ["0.0001", "0.0050", "1.2345", "123456789012345.6789"]) {
        assertCreditSymmetry(input, profile);
      }
    }
  }
});

test("manual tax requires a standard component even when the profile is empty", () => {
  for (const profile of [
    [],
    [component("reverse", 1, { calculationType: "reverse_charge" })],
    [component("withholding", 1, { calculationType: "withholding" })],
  ]) {
    assert.throws(
      () =>
        computeLineTaxes("100", profile, {
          overridden: true,
          taxAmount: "5",
        }),
      (error) =>
        error instanceof TaxCalculationError &&
        /requires a standard tax component/.test(error.message),
    );
  }
});
