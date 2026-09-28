/**
 * Lists the Copilot models your account (or your organization's policy) allows,
 * so you can choose COPILOT_MODEL. Faster models make voice chat feel more natural.
 */
import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient({ logLevel: "error" });
await client.start();
try {
  const models = await client.listModels();
  for (const model of models) {
    const state = model.policy?.state ?? "unknown";
    const efforts = model.supportedReasoningEfforts?.join("/") ?? "-";
    console.log(`${model.id.padEnd(32)} policy=${state.padEnd(12)} reasoningEffort=${efforts}  ${model.name}`);
  }
} finally {
  await client.stop();
}
