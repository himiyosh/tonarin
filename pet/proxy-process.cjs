async function stopProxy(graceful, kill, exited, { forceAfterMs = 8000, timeoutMs = 10000 } = {}) {
  let forced = false;
  let killError;
  const force = () => {
    if (forced) return;
    forced = true;
    try {
      kill();
    } catch (error) {
      killError = error;
    }
  };
  let sendError;
  let forceTimer;
  let deadlineTimer;
  try {
    try {
      graceful(force);
    } catch (error) {
      sendError = error;
      force();
    }
    forceTimer = setTimeout(force, forceAfterMs);
    const code = await Promise.race([
      exited,
      new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => {
          force();
          reject(new Error("the proxy did not exit after the shutdown request"));
        }, timeoutMs);
      }),
    ]);
    if (sendError) throw new Error("could not request graceful proxy shutdown", { cause: sendError });
    if (killError) throw new Error("could not force-stop the proxy", { cause: killError });
    if (forced) throw new Error("the proxy required a forced stop");
    if (code !== 0) throw new Error(`the proxy exited with code ${code}`);
  } finally {
    clearTimeout(forceTimer);
    clearTimeout(deadlineTimer);
  }
}

module.exports = { stopProxy };
