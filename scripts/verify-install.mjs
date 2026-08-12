import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = path.join(rootDir, "cli");
const cliMode = process.argv.includes("--cli");
const requireNative = process.argv.includes("--require-native") || process.env.REQUIRE_NATIVE_SQLITE === "1";
const errors = [];
const warnings = [];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath)) errors.push(`${label} is missing: ${filePath}`);
}

function report(label, value) {
  console.log(`[verify-install] ${label}: ${value}`);
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:\\-]+$/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function getSpawnInvocation(command, args) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args };
  }

  // .cmd/.bat files are shell entrypoints on Windows. Invoke cmd.exe
  // explicitly so Node never has to use the deprecated shell:true option.
  const commandLine = [command, ...args].map(quoteWindowsArg).join(" ");
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
  };
}

function runCommand(command, args, options = {}) {
  const invocation = getSpawnInvocation(command, args);
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    shell: false,
  });
}

const rootPackage = readJson(path.join(rootDir, "package.json"));
const allowScripts = rootPackage.allowScripts || {};
for (const packageKey of ["better-sqlite3@12.11.1", "unrs-resolver@1.12.2"]) {
  if (allowScripts[packageKey] !== true) {
    errors.push(`allowScripts is missing ${packageKey}`);
  }
}

const sqlWasmPath = path.join(rootDir, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
requireFile(sqlWasmPath, "sql.js WASM runtime");
if (fs.existsSync(sqlWasmPath)) {
  try {
    const initSqlJs = require("sql.js");
    const SQL = await initSqlJs({ locateFile: () => sqlWasmPath });
    const db = new SQL.Database();
    db.exec("SELECT 1");
    db.close();
    report("sql.js fallback", "ready");
  } catch (error) {
    errors.push(`sql.js fallback failed: ${error.message}`);
  }
}

try {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.prepare("SELECT 1 AS ok").get();
  db.close();
  report("better-sqlite3 native", "ready");
} catch (error) {
  const message = `better-sqlite3 native unavailable: ${error.message}`;
  if (requireNative) errors.push(message);
  else warnings.push(`${message}; sql.js fallback remains available`);
}

try {
  await import("unrs-resolver");
  report("unrs-resolver", "ready");
} catch (error) {
  errors.push(`unrs-resolver could not be loaded: ${error.message}`);
}

if (cliMode) {
  const cliPackage = readJson(path.join(cliDir, "package.json"));
  const cliArtifacts = [
    [path.join(cliDir, "app", "custom-server.js"), "CLI custom server"],
    [path.join(cliDir, "app", "server.js"), "CLI standalone server"],
  ];
  for (const [filePath, label] of cliArtifacts) requireFile(filePath, label);

  const builtAppPackagePath = path.join(cliDir, "app", "package.json");
  requireFile(builtAppPackagePath, "CLI built package metadata");
  if (fs.existsSync(builtAppPackagePath)) {
    try {
      const builtAppPackage = readJson(builtAppPackagePath);
      if (builtAppPackage.version !== cliPackage.version) {
        errors.push(
          `CLI built package version ${builtAppPackage.version || "unknown"} does not match ${cliPackage.version}`,
        );
      } else {
        report("CLI built package", `${builtAppPackage.version} matches`);
      }
    } catch (error) {
      errors.push(`CLI built package metadata is invalid: ${error.message}`);
    }
  }

  const staticAssetCandidates = [
    path.join(cliDir, "app", ".next-cli-build", "static"),
    path.join(cliDir, "app", ".next", "static"),
  ];
  if (!staticAssetCandidates.some((filePath) => fs.existsSync(filePath))) {
    errors.push(`CLI static assets are missing; checked: ${staticAssetCandidates.join(", ")}`);
  }

  const commandName = process.platform === "win32" ? "9router.cmd" : "9router";
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const extractVersion = (output) => {
    const matches = String(output).match(/\b\d+\.\d+\.\d+\b/g);
    return matches?.at(-1) || null;
  };
  const readNpmValue = (args) => {
    const result = runCommand(npmCommand, args, {
      cwd: rootDir,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    return `${result.stdout || ""}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || null;
  };
  const globalPrefix = readNpmValue(["config", "get", "prefix"]) || readNpmValue(["prefix", "-g"]);
  const globalRoot = readNpmValue(["root", "-g"]);
  const nodeBinDir = path.dirname(process.execPath);
  const npmExecPrefix = process.env.npm_execpath
    ? path.resolve(path.dirname(process.env.npm_execpath), "..", "..", "..", "..")
    : null;
  const configuredPrefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX;
  const windowsNpmBin = process.platform === "win32" && process.env.APPDATA
    ? path.join(process.env.APPDATA, "npm")
    : null;
  const globalPrefixes = [
    globalPrefix,
    configuredPrefix,
    npmExecPrefix,
    nodeBinDir,
    windowsNpmBin,
  ]
    .filter(Boolean)
    .filter((candidate, index, all) => all.indexOf(candidate) === index);
  const globalCommandPath = (process.platform === "win32"
    ? globalPrefixes.flatMap((prefix) => [path.join(prefix, commandName)])
    : globalPrefixes.flatMap((prefix) => [path.join(prefix, "bin", commandName), path.join(prefix, commandName)])
  ).find((candidate) => candidate && fs.existsSync(candidate));
  const globalPackageRoots = [
    globalRoot,
    ...globalPrefixes.flatMap((prefix) => [
      path.join(prefix, "node_modules"),
      path.join(prefix, "lib", "node_modules"),
    ]),
  ].filter(Boolean);
  const globalPackageEntry = globalPackageRoots
    .map((root) => path.join(root, cliPackage.name, "cli.js"))
    .find((candidate) => fs.existsSync(candidate));
  const invocations = [];
  if (globalPackageEntry) {
    invocations.push({
      command: process.execPath,
      args: [globalPackageEntry, "--version"],
      shell: false,
      label: globalPackageEntry,
    });
  }
  if (globalCommandPath) {
    invocations.push({
      command: globalCommandPath,
      args: ["--version"],
      shell: process.platform === "win32",
      label: globalCommandPath,
    });
  }
  // npm knows its own global package layout even when the shim directory is
  // not exported in PATH and npm's prefix output is not directly usable.
  invocations.push({
    command: npmCommand,
    args: ["exec", "--global", "--offline", "--", cliPackage.name, "--version"],
    label: "npm exec --global",
  });

  const failures = [];
  let verified = false;
  for (const invocation of invocations) {
    const result = runCommand(invocation.command, invocation.args, {
      cwd: rootDir,
      encoding: "utf8",
      windowsHide: true,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    const version = extractVersion(output);
    if (result.status === 0 && version === cliPackage.version) {
      report("global CLI", `${version} ready`);
      verified = true;
      break;
    }
    failures.push(`${invocation.label}: ${output || result.error?.message || "no output"}`);
  }
  if (!verified) {
    errors.push(`global ${commandName} --version failed: ${failures.join(" | ") || "no invocation available"}`);
  }
}

for (const warning of warnings) console.warn(`[verify-install] WARNING: ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`[verify-install] ERROR: ${error}`);
  process.exitCode = 1;
} else {
  report("result", "PASS");
}
