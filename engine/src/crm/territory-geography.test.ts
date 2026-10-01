import assert from "node:assert/strict";
import { test } from "node:test";
import {
  geographyMatches,
  geometryContains,
  validateDrawnGeometry,
} from "./territory-geography.ts";
import {
  EMPTY_TERRITORY_GEOGRAPHY,
  type AreaGeometry,
} from "./sales-contracts.ts";
const square: AreaGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
  ],
};
test("territory containment includes boundary edges and excludes holes", () => {
  assert.equal(geometryContains(square, [5, 5]), true);
  assert.equal(geometryContains(square, [0, 5]), true);
  assert.equal(geometryContains(square, [11, 5]), false);
  assert.equal(
    geometryContains(
      {
        type: "Polygon",
        coordinates: [
          square.coordinates[0]!,
          [
            [2, 2],
            [8, 2],
            [8, 8],
            [2, 8],
            [2, 2],
          ],
        ],
      },
      [5, 5],
    ),
    false,
  );
});
test("dateline coverage contains either side without covering Greenwich", () => {
  const dateline: AreaGeometry = {
    type: "Polygon",
    coordinates: [
      [
        [170, -10],
        [-170, -10],
        [-170, 10],
        [170, 10],
        [170, -10],
      ],
    ],
  };
  assert.equal(geometryContains(dateline, [179, 0]), true);
  assert.equal(geometryContains(dateline, [-179, 0]), true);
  assert.equal(geometryContains(dateline, [0, 0]), false);
});
test("geographic coverage fails closed without a verified location and exclusions win", () => {
  const boundary = {
    country: "CAN",
    level: "ADM1" as const,
    id: "area",
    name: "Area",
    version: "2023",
    geometry: square,
  };
  const geo = { ...EMPTY_TERRITORY_GEOGRAPHY, includes: [boundary] };
  assert.equal(geographyMatches(geo, null), false);
  assert.equal(geographyMatches(geo, [5, 5]), true);
  assert.equal(
    geographyMatches({ ...geo, excludes: [boundary] }, [0, 5]),
    false,
  );
  assert.equal(geographyMatches(EMPTY_TERRITORY_GEOGRAPHY, null), true);
});
test("drawn area validation names invalid, unclosed, degenerate and crossing boundaries", () => {
  assert.equal(validateDrawnGeometry(square), null);
  assert.match(
    validateDrawnGeometry({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
      ],
    })!,
    /Close/,
  );
  assert.match(
    validateDrawnGeometry({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [2, 2],
          [3, 3],
          [0, 0],
        ],
      ],
    })!,
    /nonzero/,
  );
  assert.match(
    validateDrawnGeometry({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [10, 10],
          [0, 8],
          [10, 0],
          [0, 0],
        ],
      ],
    })!,
    /crossing|nonzero/,
  );
  assert.match(
    validateDrawnGeometry({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [181, 0],
          [0, 10],
          [0, 0],
        ],
      ],
    })!,
    /longitude/,
  );
});
