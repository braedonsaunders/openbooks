import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const supportedTypescript = require("typescript-eslint-typescript");
const projectTypescriptId = require.resolve("typescript");

// The product is checked by TypeScript 7, while typescript-eslint currently
// requires the TypeScript 6 API. Preload its supported API under the canonical
// module id so ESLint can run without changing the compiler used by `tsc`.
require.cache[projectTypescriptId] = {
  id: projectTypescriptId,
  filename: projectTypescriptId,
  loaded: true,
  exports: supportedTypescript,
  children: [],
  paths: [],
};
