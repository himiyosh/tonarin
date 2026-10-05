import type { CopilotClient } from "@github/copilot-sdk";

class StartupTimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StartupTimeoutError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type AuthClient = Pick<CopilotClient, "getAuthStatus" | "getStatus">;

export async function getAuthStatusWithRecovery(
  client: AuthClient,
  limits: { authMs: number; statusMs: number } = { authMs: 15_000, statusMs: 3_000 },
): ReturnType<AuthClient["getAuthStatus"]> {
  const check = async () => {
    const auth = await client.getAuthStatus();
    if (typeof auth?.isAuthenticated !== "boolean") throw new Error("the sign-in check returned an invalid response");
    return auth;
  };
  const first = check();
  try {
    return await withTimeout(first, limits.authMs, `no answer to the sign-in check within ${limits.authMs / 1000} s`);
  } catch (error) {
    if (!(error instanceof StartupTimeoutError)) throw error;
    console.warn(`[copilot] ${error.message}; checking runtime health before one retry`);
  }

  // A responsive runtime is not enough: the second sign-in check must still return a real answer.
  await withTimeout(client.getStatus(), limits.statusMs, `no answer to the runtime status check within ${limits.statusMs / 1000} s`);
  try {
    return await withTimeout(Promise.any([first, check()]), limits.authMs,
      `no valid sign-in response after retry within ${limits.authMs / 1000} s`);
  } catch (error) {
    if (error instanceof AggregateError) {
      throw new Error(`sign-in checks failed: ${error.errors.map((failure) => failure instanceof Error ? failure.message : String(failure)).join("; ")}`, {
        cause: error,
      });
    }
    throw error;
  }
}
