import assert from "node:assert/strict";
import test from "node:test";
import { additiveRounding } from "./additive-rounding.ts";

test("compact parts add up to the compact total they make", () => {
  // $18.0M raised: $16.2M priced and $1.8M convertible would each round
  // on their own to $16M and $1.8M, which do not add to $18M.
  assert.deepEqual(additiveRounding("18012345.0000", ["16212345.0000", "1800000.0000"]), {
    total: "18000000.0000",
    parts: ["16200000.0000", "1800000.0000"],
  });
  // Remainders decide which part carries the rounding.
  assert.deepEqual(additiveRounding("5790000.0000", ["5360000.0000", "430000.0000"]), {
    total: "5790000.0000",
    parts: ["5360000.0000", "430000.0000"],
  });
  assert.deepEqual(additiveRounding("1004999.0000", ["500999.0000", "504000.0000"]), {
    total: "1000000.0000",
    parts: ["500000.0000", "500000.0000"],
  });
});

test("figures round to three significant digits, and parts that do not make the total round on their own", () => {
  assert.deepEqual(additiveRounding("12.3400", ["10.0000", "2.3400"]), {
    total: "12.3000",
    parts: ["10.0000", "2.3000"],
  });
  assert.deepEqual(additiveRounding("0.0000", ["0.0000", "0.0000"]), {
    total: "0.0000",
    parts: ["0.0000", "0.0000"],
  });
  assert.deepEqual(additiveRounding("1000000.0000", ["123456.0000"]), {
    total: "1000000.0000",
    parts: ["120000.0000"],
  });
});
