import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceDirectory = path.join(packageRoot, "src", "ui");
const outputDirectory = path.join(packageRoot, "dist", "ui");

fs.mkdirSync(outputDirectory, { recursive: true });
for (const filename of ["index.html", "styles.css"]) {
  fs.copyFileSync(path.join(sourceDirectory, filename), path.join(outputDirectory, filename));
}

if (process.platform !== "win32") {
  fs.chmodSync(path.join(packageRoot, "dist", "cli.js"), 0o755);
  fs.chmodSync(path.join(packageRoot, "dist", "integrations", "claude-hook.js"), 0o755);
}
