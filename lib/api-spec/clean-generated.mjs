import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const generatedDirectories = [
  path.resolve(packageDirectory, "..", "api-client-react", "src", "generated"),
  path.resolve(packageDirectory, "..", "api-zod", "src", "generated"),
];

for (const directory of generatedDirectories) {
  rmSync(directory, { force: true, recursive: true });
}