/**
 * Speech gate: decides which microphone chunks belong to an utterance, so room noise (typing, a fan, a door, a cough) does not
 * start a conversation on its own.
 *
 * Every 40 ms chunk comes with two levels from the capture worklet: the RMS of the whole signal and the RMS below
 * ~900 Hz. A chunk "sounds like a voice" when it is clearly louder than the room's own noise floor (tracked
 * continuously) and most of its energy sits in the low band, where voiced speech lives; clicks, hiss and fans are
 * mostly high-frequency or steady. The gate opens after several voice-like chunks in a short window and then sends the
 * last ~0.3 s as well (so the first syllable is not lost). It stays open until the voice has been gone for longer than
 * the configured end-of-turn pause. Nothing is sent while it is closed.
 *
 * Pure logic (no DOM, no audio APIs) so it can be tested with synthetic levels.
 */

/** @typedef {"light" | "standard" | "strong"} NoiseFilter */

export const GATE_PROFILES = {
  // Everything goes to the streaming backend, as before (for very quiet voices or a clean headset mic).
  light: null,
  standard: { ratio: 3.2, minLevel: 0.012, voiced: 0.35, need: 3, of: 5 },
  strong: { ratio: 4, minLevel: 0.02, voiced: 0.45, need: 4, of: 6 },
};

export const CHUNK_MS = 40;
const PREROLL_CHUNKS = 8; // 320 ms of audio before the gate opened
const WARMUP_CHUNKS = 12; // first ~0.5 s after the mic opens: learn the room, never open
const FLOOR_MIN = 0.003;
const FLOOR_UP = 0.005; // per chunk while closed: the floor follows a louder room within ~8 s
const FLOOR_DOWN = 0.3; // per chunk: and a quieter room almost at once
const SPEAKING_FACTOR = 1.5; // while the pet talks, ask for more (echo left over after echo cancellation)
const HANGOVER_EXTRA_MS = 500;

export function createSpeechGate() {
  let open = false;
  let floor = 0.01;
  let warmup = WARMUP_CHUNKS;
  let warmupSum = 0;
  let recent = [];
  let preroll = [];
  let lastVoice = 0;
  let openedAt = 0;
  let utteranceChunks = 0;
  let voicedChunks = 0;
  let maxThresholdRatio = 0;

  return {
    get open() {
      return open;
    },
    get floor() {
      return floor;
    },
    /** Forget everything (a new microphone, or the filter changed). */
    reset() {
      open = false;
      floor = 0.01;
      warmup = WARMUP_CHUNKS;
      warmupSum = 0;
      recent = [];
      preroll = [];
      lastVoice = 0;
      openedAt = 0;
      utteranceChunks = 0;
      voicedChunks = 0;
      maxThresholdRatio = 0;
    },
    /**
     * @param {{ pcm: ArrayBuffer, level: number, low: number, now: number, filter: NoiseFilter, silenceMs: number, petSpeaking: boolean }} chunk
     * @returns {{ send: ArrayBuffer[], voice: boolean, ended: boolean, utterance?: {
     *   durationMs: number, voicedMs: number, voiceRatio: number, maxThresholdRatio: number
     * } }} what to send now; `ended` = the gate just closed
     */
    push({ pcm, level, low, now, filter, silenceMs, petSpeaking }) {
      const profile = filter in GATE_PROFILES ? GATE_PROFILES[filter] : GATE_PROFILES.standard;
      if (!profile) return { send: [pcm], voice: level > 0.02, ended: false };

      if (warmup > 0) {
        warmup--;
        warmupSum += level;
        if (warmup === 0) floor = Math.max(FLOOR_MIN, warmupSum / WARMUP_CHUNKS);
        return { send: [], voice: false, ended: false };
      }

      const threshold = Math.max(profile.minLevel, floor * profile.ratio) * (petSpeaking ? SPEAKING_FACTOR : 1);
      const voice = level > threshold && low / Math.max(level, 1e-9) > profile.voiced;
      if (voice) lastVoice = now;

      // The floor learns only from the room, never from your voice.
      if (!open && !voice) {
        if (level < floor) floor += (level - floor) * FLOOR_DOWN;
        else floor += (level - floor) * FLOOR_UP;
        floor = Math.max(FLOOR_MIN, floor);
      }

      if (!open) {
        recent.push(voice);
        if (recent.length > profile.of) recent.shift();
        preroll.push(pcm);
        if (preroll.length > PREROLL_CHUNKS) preroll.shift();
        if (recent.filter(Boolean).length >= profile.need) {
          open = true;
          openedAt = now - (preroll.length - 1) * CHUNK_MS;
          utteranceChunks = preroll.length;
          voicedChunks = recent.filter(Boolean).length;
          maxThresholdRatio = voice ? level / threshold : 0;
          const send = preroll;
          preroll = [];
          recent = [];
          return { send, voice, ended: false };
        }
        return { send: [], voice, ended: false };
      }

      utteranceChunks++;
      if (voice) {
        voicedChunks++;
        maxThresholdRatio = Math.max(maxThresholdRatio, level / threshold);
      }
      if (now - lastVoice > silenceMs + HANGOVER_EXTRA_MS) {
        open = false;
        const durationMs = Math.max(CHUNK_MS, now - openedAt + CHUNK_MS);
        const utterance = {
          durationMs,
          voicedMs: voicedChunks * CHUNK_MS,
          voiceRatio: voicedChunks / Math.max(1, utteranceChunks),
          maxThresholdRatio,
        };
        openedAt = 0;
        utteranceChunks = 0;
        voicedChunks = 0;
        maxThresholdRatio = 0;
        return { send: [pcm], voice, ended: true, utterance };
      }
      return { send: [pcm], voice, ended: false };
    },
  };
}
