/**
 * Measures how fast each Copilot model starts talking, to choose COPILOT_MODEL for voice chat.
 *
 *   npm run bench                                  # default candidates
 *   npm run bench -- gpt-5.4-mini:none claude-haiku-4.5
 *
 * Each argument is "model" or "model:reasoningEffort". Two short turns are sent per model;
 * "first" is the time until the first streamed text, which is what you feel in a voice chat.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, ToolSet, type SessionConfig } from "@github/copilot-sdk";

const DEFAULT_CANDIDATES = ["claude-haiku-4.5", "gpt-5.4-mini:none", "gpt-5-mini:low", "gpt-5.6-luna:none", "claude-sonnet-5:low"];
const PROMPTS = ["こんにちは。今日の気分を一言で教えて。", "ありがとう。テック系ニュースで最近気になる話題を一つだけ挙げて。"];
const TURN_TIMEOUT_MS = 60_000;
// Same folder as the proxy: outside the repo, so project instruction files are not picked up.
const SANDBOX_DIR = process.env.COPILOT_SANDBOX_DIR ?? join(tmpdir(), "copilot-proxy-sandbox");
mkdirSync(SANDBOX_DIR, { recursive: true });

const candidates = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_CANDIDATES;
const client = new CopilotClient({ workingDirectory: SANDBOX_DIR, logLevel: "error" });
await client.start();

try {
  for (const spec of candidates) {
    const [model, effort] = spec.split(":");
    try {
      const session = await client.createSession({
        model,
        ...(effort ? { reasoningEffort: effort as SessionConfig["reasoningEffort"] } : {}),
        streaming: true,
        workingDirectory: SANDBOX_DIR,
        memory: { enabled: false },
        availableTools: new ToolSet().addCustom("*"),
        onPermissionRequest: () => ({ kind: "reject" }),
        systemMessage: {
          mode: "customize",
          sections: {
            tone: { action: "replace", content: "返答は1〜2文の短い日本語の話し言葉にする。" },
            code_change_rules: { action: "remove" },
          },
        },
      });

      for (const [index, prompt] of PROMPTS.entries()) {
        const started = performance.now();
        let firstAt = 0;
        let text = "";
        let error = "";
        const done = new Promise<void>((resolve) => {
          const offs = [
            session.on("assistant.message_delta", (event) => {
              if (!firstAt) firstAt = performance.now();
              text += event.data.deltaContent;
            }),
            session.on("session.error", (event) => {
              error = event.data.message;
            }),
            session.on("session.idle", () => {
              offs.forEach((off) => off());
              resolve();
            }),
          ];
        });
        await session.send({ prompt });
        const timedOut = await Promise.race([
          done.then(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), TURN_TIMEOUT_MS)),
        ]);
        const first = firstAt ? `${Math.round(firstAt - started)}ms` : "-";
        const total = timedOut ? "timeout" : `${Math.round(performance.now() - started)}ms`;
        const preview = error ? `ERROR ${error}` : text.replace(/\s+/g, " ").slice(0, 36);
        console.log(`${spec.padEnd(22)} turn${index + 1}  first=${first.padStart(7)}  total=${total.padStart(7)}  ${preview}`);
        if (timedOut) await session.abort().catch(() => {});
      }
      await session.disconnect();
    } catch (err) {
      console.log(`${spec.padEnd(22)} failed: ${String(err).slice(0, 120)}`);
    }
  }
} finally {
  await client.stop().catch(() => {});
}
