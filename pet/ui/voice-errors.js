export function voiceErrorKey({ backend, code, message = "" } = {}) {
  if (code === "local-asr") return "pet.errorLocalVoice";
  if (code === "local-tts") return "pet.localSpeechError";
  if (code === "copilot-timeout") return "pet.errorCopilotTimeout";
  if (code === "copilot-unavailable") return "pet.errorCopilotVoice";

  if (backend === "copilot-local") {
    if (/speech recognition|whisper|local voice/i.test(message)) return "pet.errorLocalVoice";
    if (/signed in|license|authentication|unauthorized/i.test(message)) return "pet.errorCopilotVoice";
    if (/session\.idle|timeout/i.test(message)) return "pet.errorCopilotTimeout";
    return "pet.errorCopilotGeneric";
  }

  if (backend === "gemini") {
    if (/quota|exhausted|429|rate/i.test(message)) return "pet.errorQuota";
    if (/api key|permission|denied|401|403|unauthenticated/i.test(message)) return "pet.errorKey";
    return "pet.errorGemini";
  }

  return "pet.errorGeneric";
}
