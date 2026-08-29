import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const generatedDirectories = [
  path.resolve(packageDirectory, "..", "api-client-react", "src", "generated"),
  path.resolve(packageDirectory, "..", "api-zod", "src", "generated"),
];

function normalizeDirectory(directory) {
  for (const name of readdirSync(directory)) {
    const filePath = path.join(directory, name);
    if (statSync(filePath).isDirectory()) {
      normalizeDirectory(filePath);
      continue;
    }
    if (!filePath.endsWith(".ts")) continue;
    const source = readFileSync(filePath, "utf8");
    writeFileSync(filePath, source.replace(/\n+$/, "\n"));
  }
}

for (const directory of generatedDirectories) {
  normalizeDirectory(directory);
}