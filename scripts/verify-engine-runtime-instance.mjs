// Proves the production server compilation did not inline the engine
// composition root. That root imports every domain; bundling it into each
// route is what exhausts the Next server build.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const marker =
  "The posted document has no intact native journal. Review its accounting history before retrying.";
const serverDir = join("web", ".next", "server");

function javascriptFiles(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) javascriptFiles(path, found);
    else if (name.endsWith(".js")) found.push(path);
  }
  return found;
}

const files = javascriptFiles(serverDir);
const inlined = files.filter((file) => readFileSync(file, "utf8").includes(marker));
if (inlined.length > 0) {
  console.error("composition install was bundled into the Next server output:");
  for (const file of inlined) console.error(`  ${file}`);
  process.exit(1);
}

const specifier = "@openbooks/engine/composition/install";
const external = files.filter((file) => readFileSync(file, "utf8").includes(specifier));
if (external.length === 0) {
  console.error(
    "no server chunk imports @openbooks/engine/composition/install from the package. The composition root is missing from the external load path.",
  );
  process.exit(1);
}

console.log(
  `engine composition stays external (${external.length} server chunk(s) import the package; none inline it)`,
);
