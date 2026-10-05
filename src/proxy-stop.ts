import { appendFileSync } from "node:fs";

export function writeShutdownMarker(logFile?: string): void {
  if (logFile) appendFileSync(logFile, "[proxy] stopped\n", { mode: 0o600 });
  else console.log("[proxy] stopped");
}
