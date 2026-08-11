import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : ["tests/translator/real"];
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(command, [
  "vitest",
  "--config",
  "tests/vitest.config.js",
  "run",
  ...targets,
], {
  cwd: rootDir,
  env: { ...process.env, RUN_LIVE: "1", RUN_REAL: "1" },
  stdio: "inherit",
  windowsHide: false,
});

child.on("error", (error) => {
  console.error(`[live-tests] failed to start: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[live-tests] terminated by ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
