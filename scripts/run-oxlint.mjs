import { spawnSync } from "node:child_process";
import path from "node:path";

const isLocalCheckEnabled = (env) => {
  const raw = env.OPENCLAW_LOCAL_CHECK?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
};

const hasFlag = (args, name) => args.some((arg) => arg === name || arg.startsWith(`${name}=`));

const args = process.argv.slice(2);
const env = { ...process.env };
const finalArgs = [...args];
const separatorIndex = finalArgs.indexOf("--");

const insertBeforeSeparator = (...items) => {
  const index = separatorIndex === -1 ? finalArgs.length : separatorIndex;
  finalArgs.splice(index, 0, ...items);
};

if (!hasFlag(finalArgs, "--type-aware")) {
  insertBeforeSeparator("--type-aware");
}
if (!hasFlag(finalArgs, "--tsconfig")) {
  insertBeforeSeparator("--tsconfig", "tsconfig.oxlint.json");
}
if (isLocalCheckEnabled(env) && !hasFlag(finalArgs, "--threads")) {
  insertBeforeSeparator("--threads=1");
}

const oxlintPath = path.resolve("node_modules", ".bin", "oxlint");
const renderOutput = (chunk) => {
  if (!chunk) {
    return "";
  }
  if (typeof chunk === "string") {
    return chunk;
  }
  return chunk.toString("utf8");
};

const writeOutput = (result) => {
  const stdout = renderOutput(result.stdout);
  const stderr = renderOutput(result.stderr);
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
};

const runOxlint = (argsToRun) =>
  spawnSync(oxlintPath, argsToRun, {
    stdio: "pipe",
    env,
    shell: process.platform === "win32",
  });

const isTsgolintCrash = (result) => {
  const combined = `${renderOutput(result.stdout)}\n${renderOutput(result.stderr)}`;
  return (
    result.signal === "SIGKILL" ||
    combined.includes("Error running tsgolint") ||
    combined.includes("tsgolint headless") ||
    combined.includes("oxlint-tsgolint/bin/tsgolint.js")
  );
};

const result = runOxlint(finalArgs);
if (result.error) {
  throw result.error;
}
if ((result.status ?? 1) === 0) {
  writeOutput(result);
  process.exit(0);
}
if (!isTsgolintCrash(result)) {
  writeOutput(result);
  process.exit(result.status ?? 1);
}

const fallbackArgs = finalArgs.filter((arg, index, values) => {
  if (arg === "--type-aware" || arg === "--type-check") {
    return false;
  }
  return !(arg === "true" && values[index - 1] === "--type-aware");
});
process.stderr.write(
  [
    "Warning: oxlint type-aware lint crashed in tsgolint; retrying without --type-aware.",
    "This preserves syntax linting locally while the upstream type-aware backend is unstable here.",
  ].join("\n") + "\n",
);
const fallback = runOxlint(fallbackArgs);
if (fallback.error) {
  throw fallback.error;
}
writeOutput(fallback);
process.exit(fallback.status ?? 1);
