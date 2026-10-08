const fs = require("node:fs");
const path = require("node:path");

function findCopilotCliPath({
  configured = process.env.COPILOT_CLI_PATH,
  searchPath = process.env.PATH,
  platform = process.platform,
} = {}) {
  if (configured) return configured;
  if (platform === "win32") return undefined;

  const directories = [
    ...(searchPath || "").split(path.delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter(Boolean);

  return directories
    .map((directory) => path.join(directory, "copilot"))
    .find((candidate) => fs.existsSync(candidate));
}

module.exports = { findCopilotCliPath };
