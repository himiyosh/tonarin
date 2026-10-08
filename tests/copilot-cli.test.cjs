const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { findCopilotCliPath } = require("../pet/copilot-cli.cjs");

test("an explicit Copilot CLI path wins without filesystem validation", () => {
  assert.equal(
    findCopilotCliPath({ configured: "/custom/copilot", searchPath: "", platform: "darwin" }),
    "/custom/copilot",
  );
});

test("macOS discovers Copilot CLI from PATH", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tonarin-copilot-cli-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "copilot");
  fs.writeFileSync(executable, "");

  assert.equal(
    findCopilotCliPath({ configured: "", searchPath: directory, platform: "darwin" }),
    executable,
  );
});

test("Windows keeps the SDK bundled runtime unless explicitly configured", () => {
  assert.equal(
    findCopilotCliPath({ configured: "", searchPath: "C:\\tools", platform: "win32" }),
    undefined,
  );
});
