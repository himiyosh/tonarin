export async function speakLocalText(text, language, { synthesis = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance, onStart = () => {}, onError = () => {}, onEnd = () => {},
  signal, voiceWaitMs = 2000, startWaitMs = 2500 } = {}) {
  if (!synthesis || typeof synthesis.getVoices !== "function" || typeof synthesis.speak !== "function" ||
      typeof synthesis.cancel !== "function" || typeof Utterance !== "function") {
    throw Object.assign(new Error("Local speech is unsupported"), { code: "unsupported" });
  }
  const installedVoice = () => synthesis.getVoices().find((candidate) =>
    candidate.localService === true && String(candidate.lang).toLowerCase().split("-")[0] === language);
  let voice = installedVoice();
  if (!voice && typeof synthesis.addEventListener === "function" && !signal?.aborted) {
    voice = await new Promise((resolve) => {
      let timer;
      const finish = (found) => {
        clearTimeout(timer);
        synthesis.removeEventListener("voiceschanged", onVoices);
        signal?.removeEventListener("abort", onAbort);
        resolve(found);
      };
      const onVoices = () => {
        const found = installedVoice();
        if (found) finish(found);
      };
      const onAbort = () => finish(null);
      synthesis.addEventListener("voiceschanged", onVoices);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish(installedVoice()), voiceWaitMs);
      onVoices();
    });
  }
  if (signal?.aborted) throw Object.assign(new Error("Local speech canceled"), { code: "canceled" });
  if (!voice) throw Object.assign(new Error("No installed local voice for this language"), { code: "no-local-voice" });
  const utterance = new Utterance(text);
  utterance.lang = voice.lang;
  utterance.voice = voice;
  await new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    let timer;
    const fail = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(Object.assign(new Error("Local speech could not start"), { code }));
    };
    const abort = () => {
      if (!started) fail("canceled");
      synthesis.cancel();
    };
    utterance.onstart = () => {
      if (signal?.aborted) return abort();
      started = true;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      onStart();
      resolve();
    };
    utterance.onerror = (event) => {
      if (event.error === "canceled" || event.error === "interrupted") {
        if (!started) fail("canceled");
      } else if (started) onError();
      else fail("failed");
    };
    utterance.onend = () => {
      if (started) onEnd();
      else fail("failed");
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      if (!started) {
        fail("failed");
        synthesis.cancel();
      }
    }, startWaitMs);
    try {
      synthesis.cancel();
      synthesis.speak(utterance);
    } catch {
      fail("failed");
    }
  });
}

export const speakLocalMockMetadata = speakLocalText;
