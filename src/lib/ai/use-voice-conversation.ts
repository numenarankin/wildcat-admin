"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { chartSpecsFromMessage, type ChartSpec } from "@/lib/ai/chart-spec";
import { saveMessages } from "@/lib/ai/conversation-actions";
import { buildPageContext } from "@/lib/ai/page-context";
import { uuid } from "@/lib/utils";
import { currentSlices } from "@/lib/ai/use-ai-context";
import {
  applyApprovalResponse,
  messageText,
  readVoiceMessageStream,
  toolInvocationSeed,
} from "@/lib/ai/voice-stream";
import { logToolParts } from "@/lib/ai/tool-log";
import { looksLikeSelfEcho } from "@/lib/ai/voice-echo";
import {
  pendingApprovals,
  type PendingApproval,
} from "@/components/ai/tool-approval";

/**
 * Whether this browser can capture mic audio for the voice loop. We use
 * MediaRecorder + getUserMedia (widely supported, incl. WSL/Linux browsers)
 * rather than the Web Speech API, whose recognition depends on Google's speech
 * service and fails with a `network` error in many environments.
 */
export function isVoiceInputSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    typeof window.MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";
export type VoiceTurn = {
  role: "user" | "assistant";
  text: string;
  /** Charts Orion drew this turn (from render_chart) — spoken answers are silent,
   * so a chart is shown in the turn's bubble. Not persisted across reload. */
  charts?: ChartSpec[];
};

// Verbose tracing so we can see exactly where a voice turn stalls. Every line
// carries milliseconds since the session started, because the failures that
// only show up on a deployed app are timing ones: locally every round trip is
// ~20ms and the loop's races never open, while in production transcribe + model
// + TTS can each take a second. A bare log line can't tell you a clip started
// late; a timestamped one can.
let sessionStart = 0;
const log = (...args: unknown[]) =>
  console.log(`[voice +${Math.round(performance.now() - sessionStart)}ms]`, ...args);

// --- Turn-taking / VAD tuning -----------------------------------------------
// The user is always in charge. Two-stage endpointing keeps latency low without
// interrupting: at SPECULATE_MS of silence Orion starts *processing* a response
// (transcribe + LLM + speech synthesis) but holds all audio output; only at the
// full SILENCE_MS does it actually start speaking. If the user resumes talking
// before SILENCE_MS, the half-built response is scrapped and the utterance
// continues — so a mid-thought pause never triggers an interruption, yet the
// reply is ready the instant the user is truly done.
// Playback is gated on this, but the on-screen text is NOT — so when this was
// 3000ms the whole reply had finished streaming and sat on screen for ~2s of
// dead air before a word was spoken, which read as "it waits for all the text".
// Speculation already starts at SPECULATE_MS and a resumed utterance scraps the
// half-built response, so a short window here is cheap: the cost of ending a
// turn early is a scrapped speculation, not a cut-off user.
const SILENCE_MS = 700; // silence that ends your turn → Orion may speak
const SPECULATE_MS = 350; // silence after which Orion starts processing (no output yet)
const RMS_THRESHOLD = 0.02; // loudness counted as (candidate) speech while listening
const MIN_SPEECH_FRAMES = 3; // consecutive voiced frames before "speech started"
const MAX_UTTERANCE_MS = 120000; // hard cap so a turn can't run forever

// Spectral gate — ignores breath/noise without deafening us to speech. Energy
// alone can't tell a loud breath from a word, so we also require that most of
// the energy sits in the speech band. The ratio is measured over a RESTRICTED
// analysis band (not the whole spectrum): the denominator spans ~120 Hz–4 kHz,
// which includes the sub-speech rumble where breath/handling noise lives but
// excludes the high-frequency hiss floor that would otherwise dilute the score.
// Within that band, voiced speech (300–3000 Hz) dominates → high ratio; a breath
// (mostly <300 Hz) or clatter → low ratio.
const SPEECH_LOW_HZ = 300;
const SPEECH_HIGH_HZ = 3000;
const ANALYSIS_LOW_HZ = 120;
const ANALYSIS_HIGH_HZ = 4000;
const VOICE_BAND_RATIO = 0.5; // min speech-band share to count as speech
const BARGE_BAND_RATIO = 0.55; // slightly stricter for interrupts

// Barge-in: interrupt Orion by speaking over it. Higher bar + sustained frames
// so the mic picking up Orion's own voice (residual echo) doesn't self-trigger.
const BARGE_THRESHOLD = 0.07;
const BARGE_FRAMES = 14; // ~230ms of sustained speech
const BARGE_GRACE_MS = 300; // brief guard against a clip's own onset

// Self-echo. Orion's spoken reply is real speech, so the spectral gate can't
// tell its echo from the user. Three layers handle it now that the TTS is no
// longer routed through the audio graph (that routing double-played every clip
// on Brave): the browser's own echo canceller on the mic stream, the
// ECHO_TAIL_MS guard below that refuses to hear anything while Orion is
// audible, and `looksLikeSelfEcho` as the last check before a transcript
// becomes a turn.
// Speakers keep reaching the mic after a clip's `ended` fires (output buffering
// + room reverb). While listening, frames this close behind Orion's own audio
// are treated as its tail, never as the user starting to talk.
const ECHO_TAIL_MS = 400;

// --- Streaming-speech tuning ------------------------------------------------
const MIN_FLUSH_CHARS = 30; // min buffered before a sentence is sent to TTS
const MAX_FLUSH_CHARS = 220; // force a flush mid-clause past this

function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

export interface UseVoiceConversationOptions {
  /** Master switch — the mic loop runs only while this is true. */
  enabled: boolean;
  /** Prior conversation to seed Orion's context (full-page mode carries the
   *  open thread into voice). */
  initialTurns?: VoiceTurn[];
  /** Called whenever the committed history changes. When provided the hook does
   *  NOT self-persist — the caller owns persistence (e.g. into the active Orion
   *  conversation). When omitted, the hook saves to its own conversation row so
   *  a standalone voice session still shows up in chat history. */
  onCommit?: (turns: VoiceTurn[]) => void;
  /** Asks the host to turn voice mode off (mic blocked / unsupported / ended). */
  onEnd?: () => void;
  /**
   * The org ran out of AI credits mid-call (any voice route answering 402).
   *
   * Voice is the one surface where silence is indistinguishable from a bug: the
   * mic simply stops answering. So the loop ends and the host is told, rather
   * than retrying a call that will be refused every time.
   */
  onOutOfCredits?: () => void;
}

export interface VoiceConversation {
  status: VoiceStatus;
  error: string | null;
  /** The in-progress user utterance (transcript), shown live. */
  lastUser: string;
  /** The in-progress assistant reply text as it streams. */
  liveReply: string;
  /** True while `lastUser`/`liveReply` describe an uncommitted, in-flight turn
   *  (so a full-page UI can render them as a provisional pair without
   *  double-rendering the committed history). */
  liveActive: boolean;
  /** Committed back-and-forth so far. */
  turns: VoiceTurn[];
  /** Inject a typed message as the user's turn (type-or-speak). */
  submitText: (text: string) => void;
  /** Write actions Orion has proposed and is waiting on the user to approve or
   *  deny (tap-to-confirm). Empty unless a turn is parked on approval. */
  pendingApprovals: PendingApproval[];
  /** Approve or deny a proposed action by its approval id. Once every pending
   *  action in the turn is answered, Orion resumes and (if approved) acts. */
  respondToApproval: (id: string, approved: boolean) => void;
}

/**
 * Hands-free, interruptible Orion voice loop, as a hook so it can drive either
 * the small status overlay or the full-page Orion chat. While enabled: capture
 * speech (MediaRecorder + Web-Audio silence detection) → transcribe
 * (/api/transcribe) → ask Orion (/api/voice-chat, read-only tools, streamed) →
 * speak each sentence as it arrives (/api/voice). The mic is analyzed
 * continuously, so you can talk over Orion to interrupt it (barge-in). Typed
 * input is accepted via `submitText`, processed as a normal user turn.
 */
export function useVoiceConversation(
  options: UseVoiceConversationOptions,
): VoiceConversation {
  const { enabled } = options;

  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [lastUser, setLastUser] = useState("");
  const [liveReply, setLiveReply] = useState("");
  const [liveActive, setLiveActive] = useState(false);
  const [turns, setTurns] = useState<VoiceTurn[]>(options.initialTurns ?? []);
  const [error, setError] = useState<string | null>(null);
  const [pendingApprovalReqs, setPendingApprovalReqs] = useState<
    PendingApproval[]
  >([]);

  // Latest callbacks/seed without restarting the engine on every render.
  const onCommitRef = useRef(options.onCommit);
  onCommitRef.current = options.onCommit;
  const onEndRef = useRef(options.onEnd);
  onEndRef.current = options.onEnd;
  const onOutOfCreditsRef = useRef(options.onOutOfCredits);
  onOutOfCreditsRef.current = options.onOutOfCredits;
  const initialTurnsRef = useRef(options.initialTurns);
  initialTurnsRef.current = options.initialTurns;

  // Conversation history survives across turns so Orion has follow-up context.
  const historyRef = useRef<VoiceTurn[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  // Bridge so the stable `submitText` returned below reaches the live engine.
  const submitTextRef = useRef<(text: string) => void>(() => {});
  // Bridge for the stable `respondToApproval` returned below.
  const respondRef = useRef<(id: string, approved: boolean) => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    sessionStart = performance.now();
    log("voice mode ENABLED");

    let disposed = false;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let recorder: MediaRecorder | null = null;
    let rafId: number | null = null;
    let chunks: Blob[] = [];
    let mimeType = "";

    // Bin ranges for the spectral gate, resolved once the mic's sample rate is
    // known: [speechLowBin, speechHighBin] is the numerator (speech band),
    // [anaLowBin, anaHighBin] the denominator (restricted analysis band).
    // Reused frame buffers avoid per-frame allocation.
    let speechLowBin = 0;
    let speechHighBin = 0;
    let anaLowBin = 0;
    let anaHighBin = 0;
    let timeBuf: Uint8Array<ArrayBuffer> | null = null;
    let freqBuf: Uint8Array<ArrayBuffer> | null = null;

    // Seed context from the host (the open Orion thread, if any).
    historyRef.current = initialTurnsRef.current
      ? [...initialTurnsRef.current]
      : [];
    setTurns(historyRef.current);
    setLastUser("");
    setLiveReply("");
    setLiveActive(false);

    // Phase + timing (phase is the source of truth; status mirrors it for UI).
    let phase: VoiceStatus = "idle";
    let phaseStart = 0;
    function setPhase(p: VoiceStatus) {
      if (p !== phase) log(`phase ${phase} → ${p}`);
      phase = p;
      phaseStart = performance.now();
      setStatus(p);
    }

    // Listening / endpointing state.
    let speechFrames = 0;
    let hadSpeech = false;
    let silenceStart = 0;
    let recordStart = 0;

    // Barge-in state.
    let bargeFrames = 0;

    // Self-echo state. `lastClipEndAt` is when Orion's audio last stopped and
    // `lastSpokenText` what it said across the whole turn — together they let a
    // transcript be checked against Orion's own words before it becomes a turn
    // (see `looksLikeSelfEcho`). Speakers keep leaking into the mic for a moment
    // after playback ends (room reverb + output buffering), so frames inside
    // ECHO_TAIL_MS of a clip are not counted as speech at all.
    let lastClipEndAt = 0;
    let lastSpokenText = "";

    // Turn control: each turn gets a monotonically increasing id; barge-in /
    // teardown / scrapped speculation bump it so stale async work (LLM stream,
    // queued clips) no-ops.
    let turnSeq = 0;
    let currentAbort: AbortController | null = null;
    let ttsChain: Promise<void> = Promise.resolve();
    let prevSentence = "";
    // Resolver for the clip currently playing, so an interrupt can unblock the
    // playback queue immediately (pause() doesn't fire `ended`).
    let playFinish: (() => void) | null = null;

    // Speculative-turn state. While `speculating`, a response is being built but
    // not yet voiced; `commitResolve` is its output gate — resolve(true) to let
    // it speak (silence reached SILENCE_MS), resolve(false) to scrap it (user
    // resumed). `pendingSnapshot` captures the in-progress recording mid-stream.
    let speculating = false;
    let commitResolve: ((release: boolean) => void) | null = null;
    let pendingSnapshot: ((b: Blob) => void) | null = null;

    // A turn parked on the user's approval. When Orion proposes a write action,
    // the run halts; we hold everything needed to resume it the moment the user
    // taps Approve/Deny: the messages leading up to the assistant turn, the
    // assistant message carrying the approval-request part(s), the committed
    // convo to fold the result into, and how much assistant text was already
    // spoken (so the post-approval confirmation isn't re-voiced from the top).
    interface ParkedApproval {
      turnId: number;
      baseMessages: UIMessage[];
      assistantMessage: UIMessage;
      convo: VoiceTurn[];
      spokenText: string;
    }
    let parked: ParkedApproval | null = null;
    function clearParked() {
      parked = null;
      setPendingApprovalReqs([]);
    }

    // One saved conversation per voice session when self-persisting (no host
    // owner), so the back-and-forth shows up in chat history.
    const conversationId = uuid();
    function turnsToMessages(list: VoiceTurn[]): UIMessage[] {
      return list.map((t, i) => ({
        id: `${t.role}-${i}`,
        role: t.role,
        parts: [{ type: "text", text: t.text }],
      }));
    }
    async function selfPersist() {
      if (historyRef.current.length === 0) return;
      try {
        await saveMessages(conversationId, turnsToMessages(historyRef.current));
      } catch (err) {
        console.error("voice save failed", err);
      }
    }

    // A turn's data is final: publish it to the committed list, hide the live
    // pair, and persist (host-owned or self).
    function commit() {
      setTurns([...historyRef.current]);
      setLiveActive(false);
      const onCommit = onCommitRef.current;
      if (onCommit) onCommit([...historyRef.current]);
      else void selfPersist();
    }

    function cleanupAudio() {
      if (audioRef.current) {
        try {
          audioRef.current.pause();
        } catch {
          // ignore
        }
      }
      if (playFinish) {
        playFinish();
      } else {
        audioRef.current = null;
        if (audioUrlRef.current) {
          URL.revokeObjectURL(audioUrlRef.current);
          audioUrlRef.current = null;
        }
      }
    }

    function startListening() {
      if (disposed || !stream) return;
      if (phase === "listening" && recorder && recorder.state === "recording") {
        return;
      }
      chunks = [];
      hadSpeech = false;
      speechFrames = 0;
      silenceStart = 0;
      bargeFrames = 0;
      speculating = false;
      commitResolve = null;
      pendingSnapshot = null;
      recordStart = performance.now();
      setError(null);
      setPhase("listening");

      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
        // `requestData()` (snapshot mid-utterance) and `stop()` both land here.
        if (pendingSnapshot) {
          const resolve = pendingSnapshot;
          pendingSnapshot = null;
          resolve(new Blob(chunks, { type: mimeType || "audio/webm" }));
        }
      };
      recorder.start();
      log("listening");
    }

    /**
     * Grab the audio recorded so far WITHOUT stopping (so the user can keep
     * talking). Used to start processing speculatively after a short pause.
     */
    function snapshot(): Promise<Blob> {
      return new Promise((resolve) => {
        if (!recorder || recorder.state !== "recording") {
          resolve(new Blob(chunks, { type: mimeType || "audio/webm" }));
          return;
        }
        pendingSnapshot = resolve;
        try {
          recorder.requestData();
        } catch {
          pendingSnapshot = null;
          resolve(new Blob(chunks, { type: mimeType || "audio/webm" }));
        }
      });
    }

    // Short pause: start building a response, but gate its audio until commit.
    function startSpeculation() {
      if (speculating || disposed || !hadSpeech) return;
      speculating = true;
      const my = ++turnSeq;
      currentAbort = new AbortController();
      const signal = currentAbort.signal;
      let release!: (v: boolean) => void;
      const gate = new Promise<boolean>((r) => (release = r));
      commitResolve = release;
      log("speculating @", SPECULATE_MS, "ms — processing, output held");
      void snapshot().then((blob) => {
        if (disposed || my !== turnSeq) return;
        void handleTurn(blob, my, gate, signal);
      });
    }

    // Full silence reached: let the (likely already-built) response speak.
    function commitUtterance() {
      if (phase !== "listening") return;
      if (!speculating) startSpeculation(); // edge: jumped straight to commit
      log("commit — releasing Orion's response");
      speculating = false;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch {
          // ignore
        }
      }
      setPhase("thinking"); // until the first clip starts playing
      if (commitResolve) {
        commitResolve(true);
        commitResolve = null;
      }
    }

    // User resumed talking before commit: throw away the half-built response.
    function cancelSpeculation() {
      if (!speculating) return;
      log("user resumed — scrapping speculative response");
      speculating = false;
      turnSeq++; // invalidate the speculative turn
      currentAbort?.abort();
      ttsChain = Promise.resolve();
      // Drop the scrapped provisional turn from the live UI.
      setLiveActive(false);
      setLiveReply("");
      setLastUser("");
      if (commitResolve) {
        commitResolve(false);
        commitResolve = null;
      }
      // Recorder keeps running; the utterance continues.
    }

    function interrupt() {
      log("barge-in — user interrupted");
      bargeFrames = 0;
      speculating = false;
      commitResolve = null;
      turnSeq++; // invalidate the in-flight turn
      currentAbort?.abort();
      ttsChain = Promise.resolve();
      cleanupAudio();
      startListening();
    }

    function monitor() {
      if (disposed || !analyser || !timeBuf || !freqBuf) return;
      rafId = requestAnimationFrame(monitor);

      // Overall loudness (time domain).
      analyser.getByteTimeDomainData(timeBuf);
      let sum = 0;
      for (let i = 0; i < timeBuf.length; i++) {
        const v = (timeBuf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / timeBuf.length);

      // Spectral shape (frequency domain): within the restricted analysis band,
      // what fraction of the energy sits in the speech band. Breath/rumble and
      // clatter score low; voiced speech scores high.
      analyser.getByteFrequencyData(freqBuf);
      let bandSum = 0;
      let totalSum = 0;
      for (let i = anaLowBin; i <= anaHighBin; i++) {
        const m = freqBuf[i];
        totalSum += m;
        if (i >= speechLowBin && i <= speechHighBin) bandSum += m;
      }
      const bandRatio = totalSum > 0 ? bandSum / totalSum : 0;

      // Speech must be both loud enough AND spectrally voice-shaped. A loud
      // breath clears the energy bar but not the band ratio, so it's ignored.
      const voiced = rms > RMS_THRESHOLD && bandRatio > VOICE_BAND_RATIO;
      const now = performance.now();

      if (phase === "listening") {
        // Orion's own audio must never open a user turn. Either a clip is
        // still attached and playing, or one just stopped and the room is still
        // ringing — speakers reach the mic after a delay, so the tail outlives
        // `ended`. Either way the mic is hearing Orion, so the frame is not
        // speech. Without this the reply gets transcribed as a user turn and
        // Orion answers itself, which is what "double talking" sounds like.
        const orionAudible =
          !!audioRef.current || now - lastClipEndAt < ECHO_TAIL_MS;
        if (orionAudible) {
          speechFrames = 0;
          return;
        }
        if (voiced) {
          speechFrames++;
          silenceStart = 0;
          if (speechFrames >= MIN_SPEECH_FRAMES) {
            if (!hadSpeech) {
              hadSpeech = true;
              log("speech detected");
            }
            // Sustained speech after a pause → the turn isn't over; scrap any
            // response we'd speculatively started building.
            if (speculating) cancelSpeculation();
          }
        } else {
          speechFrames = 0;
          if (hadSpeech) {
            if (!silenceStart) silenceStart = now;
            else {
              const elapsed = now - silenceStart;
              // Stage 1: start processing early (no audio yet).
              if (!speculating && elapsed > SPECULATE_MS) startSpeculation();
              // Stage 2: full silence → let the response speak.
              if (elapsed > SILENCE_MS) {
                commitUtterance();
                return;
              }
            }
          }
        }
        if (hadSpeech && now - recordStart > MAX_UTTERANCE_MS)
          commitUtterance();
      } else if (phase === "thinking" || phase === "speaking") {
        // An interruption must be loud AND voice-shaped, well above the
        // conversational threshold — coughs, clatter and room noise don't cut
        // Orion off. Orion's own voice leaking back is handled upstream of this
        // by the browser's echo canceller (`echoCancellation: true` on the mic),
        // which is now the only defense: the learned echo-path gain that used to
        // refine this needed the TTS routed through the AudioContext, and that
        // routing is what doubled every clip on Brave. Losing it costs
        // sensitivity in a loud room, not correctness.
        const bargeVoiced =
          rms > BARGE_THRESHOLD && bandRatio > BARGE_BAND_RATIO;
        if (now - phaseStart > BARGE_GRACE_MS && bargeVoiced) {
          bargeFrames++;
          if (bargeFrames >= BARGE_FRAMES) interrupt();
        } else if (!bargeVoiced) {
          bargeFrames = 0;
        }
      }
    }

    /**
     * End the call because the org is out of AI credits.
     *
     * Ending, not retrying: every subsequent request would be refused the same
     * way, and a mic that keeps listening while nothing can answer is the
     * failure mode this exists to remove. The host is told so it can offer the
     * top-up, which is the only thing that makes the call possible again.
     */
    function endForNoCredits() {
      setError("You're out of AI credits.");
      onOutOfCreditsRef.current?.();
      onEndRef.current?.();
    }

    /** The sentinel a 402 throws, so a turn's catch can tell it apart. */
    const NO_CREDITS = "voice:no-credits";
    function outOfCredits(): Error {
      endForNoCredits();
      return new Error(NO_CREDITS);
    }

    async function transcribe(
      blob: Blob,
      signal: AbortSignal,
    ): Promise<string> {
      log("POST /api/transcribe …", blob.size, "bytes");
      const startedAt = performance.now();
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
        signal,
      });
      log(
        "/api/transcribe response",
        res.status,
        `in ${Math.round(performance.now() - startedAt)}ms`
      );
      if (res.status === 402) throw outOfCredits();
      if (!res.ok) {
        throw new Error(
          `transcribe ${res.status}: ${await res.text().catch(() => "")}`,
        );
      }
      const data = (await res.json()) as { text?: string };
      return (data.text ?? "").trim();
    }

    function synthesize(
      text: string,
      previousText: string,
      signal: AbortSignal,
    ): Promise<Blob | null> {
      log("POST /api/voice …", text.length, "chars:", JSON.stringify(text));
      const startedAt = performance.now();
      return fetch("/api/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, previousText: previousText || undefined }),
        signal,
      })
        .then(async (res) => {
          log(
            "/api/voice response",
            res.status,
            `in ${Math.round(performance.now() - startedAt)}ms`
          );
          if (res.status === 402) {
            // The words are already on screen; only the voice is refused.
            endForNoCredits();
            return null;
          }
          if (!res.ok) {
            setError(
              "Orion couldn't speak. If you just added the ElevenLabs key, restart the dev server.",
            );
            return null;
          }
          return await res.blob();
        })
        .catch((err) => {
          if (signal.aborted) return null;
          console.error("Voice synthesis failed", err);
          setError("Orion couldn't speak.");
          return null;
        });
    }

    function playBlob(blob: Blob): Promise<void> {
      return new Promise((resolve) => {
        if (disposed) return resolve();
        // Two clips must never sound at once. Every path that starts one is
        // supposed to have stopped the last, but those paths are timing-
        // dependent (an abandoned TTS chain, a clip whose fetch landed after
        // its turn was superseded) and the failure is exactly the reported
        // "double talking". Log it loudly — this line names the cause outright
        // — and stop the old clip rather than talk over it.
        if (audioRef.current) {
          log("OVERLAP: a clip was still playing; stopping it first");
          cleanupAudio();
        }
        const url = URL.createObjectURL(blob);
        audioUrlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        if (phase !== "speaking") setPhase("speaking");

        // The clip plays straight to the default output and is NEVER routed
        // through the AudioContext. Routing it (createMediaElementSource →
        // analyser → destination) is supposed to move the element's audio into
        // the graph, and in Chrome it does. Brave, whose Shields farble the Web
        // Audio API, left the element's own output running as well: the same
        // sentence came out twice, the graph copy trailing the direct one by
        // the context's output latency. That is the reported "double talking",
        // and it cost us the echo analyser to fix — see the barge-in note.

        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          lastClipEndAt = performance.now();
          URL.revokeObjectURL(url);
          if (audioRef.current === audio) {
            audioRef.current = null;
            audioUrlRef.current = null;
          }
          if (playFinish === finish) playFinish = null;
          resolve();
        };
        playFinish = finish;
        audio.onended = () => {
          log("clip ended");
          finish();
        };
        audio.onerror = () => {
          log("clip playback error");
          finish();
        };
        audio
          .play()
          .then(() => log("clip playing"))
          .catch((err) => {
            console.error("Audio playback blocked", err);
            setError(
              "Couldn't auto-play audio — click the mic once more to enable sound.",
            );
            finish();
          });
      });
    }

    // Synthesize immediately (parallel) so audio is ready the moment the turn
    // commits; play strictly in arrival order, but only AFTER the output gate
    // releases (so nothing is voiced until the user is truly done). Skips if the
    // turn was scrapped (resume) or superseded (barge-in).
    function enqueueSpeech(
      sentence: string,
      turn: number,
      gate: Promise<boolean>,
      signal: AbortSignal,
    ) {
      const previous = prevSentence;
      prevSentence = sentence;
      const queuedAt = performance.now();
      const blobPromise = synthesize(sentence, previous, signal);
      ttsChain = ttsChain.then(async () => {
        const release = await gate;
        if (!release || disposed || turn !== turnSeq) return;
        const blob = await blobPromise;
        if (!blob || disposed || turn !== turnSeq) return;
        // The gap between queueing a sentence and speaking it is the whole
        // local-vs-deployed difference: on localhost it is tens of ms, in
        // production it is TTS latency plus everything ahead of it in the
        // chain. A clip that waited seconds is one that may be landing after
        // its turn is over.
        log(
          `clip start turn=${turn} phase=${phase} waited=${Math.round(
            performance.now() - queuedAt
          )}ms`
        );
        lastSpokenText = lastSpokenText
          ? `${lastSpokenText} ${sentence}`
          : sentence;
        await playBlob(blob);
      });
    }

    // Stream one assistant turn from the model: speak its text as it arrives and
    // return the final message (text + any tool-approval parts). `displayPrefix`
    // is prepended to the on-screen transcript only — used when resuming after an
    // approval so the proposal already spoken stays visible above the follow-up.
    async function streamAssistant(
      messages: UIMessage[],
      turn: number,
      gate: Promise<boolean>,
      signal: AbortSignal,
      displayPrefix = "",
      resumeFrom?: UIMessage,
    ): Promise<UIMessage> {
      log("POST /api/voice-chat …", { turn, turns: messages.length });
      const startedAt = performance.now();
      const res = await fetch("/api/voice-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          pageContext: buildPageContext(
            window.location.pathname,
            currentSlices(),
          ),
        }),
        signal,
      });
      log(
        "/api/voice-chat response",
        res.status,
        "hasBody:",
        !!res.body,
        `in ${Math.round(performance.now() - startedAt)}ms`
      );
      if (res.status === 402) throw outOfCredits();
      if (!res.ok || !res.body) {
        throw new Error(
          `voice-chat ${res.status}: ${await res.text().catch(() => "")}`,
        );
      }
      let pending = ""; // spoken text buffered but not yet flushed to TTS
      let spokenLen = 0; // chars of this message's text already sent to TTS

      function flushReady(force: boolean) {
        for (;;) {
          if (!pending) return;
          if (force) {
            const s = pending.trim();
            pending = "";
            if (s) enqueueSpeech(s, turn, gate, signal);
            return;
          }
          let cut = -1;
          const re = /[.!?](?=\s|$)|\n/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(pending)) !== null) {
            const end = m.index + 1;
            if (end >= MIN_FLUSH_CHARS) {
              cut = end;
              break;
            }
          }
          if (cut === -1) {
            if (pending.length > MAX_FLUSH_CHARS) {
              let sp = pending.lastIndexOf(" ", MAX_FLUSH_CHARS);
              if (sp < MIN_FLUSH_CHARS) sp = MAX_FLUSH_CHARS;
              const head = pending.slice(0, sp).trim();
              pending = pending.slice(sp);
              if (head) enqueueSpeech(head, turn, gate, signal);
              continue;
            }
            return;
          }
          let end = cut;
          while (end < pending.length && /\s/.test(pending[end] ?? "")) end++;
          const head = pending.slice(0, end).trim();
          pending = pending.slice(end);
          if (head) enqueueSpeech(head, turn, gate, signal);
        }
      }

      let last: UIMessage | null = null;
      let streamErr: string | null = null;
      for await (const snapshot of readVoiceMessageStream(res.body, {
        onError: (err) => {
          streamErr = err instanceof Error ? err.message : String(err);
        },
        resumeFrom,
      })) {
        if (disposed || turn !== turnSeq) break;
        last = snapshot;
        // Voice runs the same tools as the drawer, and a failed one is even
        // harder to notice here: the answer is spoken, so there is nothing on
        // screen to look thin. Deduped by tool call id inside the logger, which
        // matters because a snapshot stream re-delivers the whole message on
        // every chunk.
        logToolParts(snapshot);
        const text = messageText(snapshot);
        setLiveReply(displayPrefix + text);
        if (text.length > spokenLen) {
          pending += text.slice(spokenLen);
          spokenLen = text.length;
          flushReady(false);
        }
      }
      flushReady(true);
      if (!last) {
        throw new Error(
          streamErr
            ? `voice-chat: ${streamErr}`
            : "voice-chat: empty response stream",
        );
      }
      log("/api/voice-chat done —", messageText(last).length, "chars");
      return last;
    }

    // Build a response speculatively. Transcription, the LLM stream, and speech
    // synthesis all run NOW; playback (and committing the turn to history) waits
    // on `gate`. If the gate releases false (user resumed → scrapped) or the
    // turn is superseded, everything no-ops. `gate` true = the user finished and
    // Orion may speak.
    async function handleTurn(
      blob: Blob,
      my: number,
      gate: Promise<boolean>,
      signal: AbortSignal,
    ) {
      setLiveReply("");
      ttsChain = Promise.resolve();
      prevSentence = "";
      lastSpokenText = ""; // a new reply — echo is judged against THIS turn's words

      try {
        const text = await transcribe(blob, signal);
        const sinceSpoken = performance.now() - lastClipEndAt;
        log(
          `transcript turn=${my} ${Math.round(sinceSpoken)}ms after Orion stopped:`,
          JSON.stringify(text)
        );
        if (disposed || my !== turnSeq) return;

        // Last line against self-echo: the mic heard Orion's own reply back.
        // The acoustic guards are frame-level and can only discount audio this
        // tab is playing right now; a clip that leaked into a fresh recording
        // reaches here looking exactly like a user turn. Answering it is what
        // starts Orion talking to itself.
        if (looksLikeSelfEcho(text, lastSpokenText, sinceSpoken)) {
          log("SELF-ECHO: transcript matches Orion's own reply — ignoring turn");
          const release = await gate;
          if (release && !disposed && my === turnSeq) startListening();
          return;
        }

        if (!text) {
          // Nothing recognized (e.g. a tiny/silent clip). Wait for the turn to
          // resolve; if it committed (user really is done), just relisten.
          const release = await gate;
          if (release && !disposed && my === turnSeq) startListening();
          return;
        }
        setLastUser(text);
        setLiveActive(true);

        // The user message isn't committed to history until the turn does — a
        // scrapped speculation must leave history untouched (the next, longer
        // utterance becomes the real message).
        const convo: VoiceTurn[] = [
          ...historyRef.current,
          { role: "user", text },
        ];

        const assistant = await streamAssistant(
          turnsToMessages(convo),
          my,
          gate,
          signal,
        );
        log("Orion reply:", JSON.stringify(messageText(assistant)));
        if (disposed || my !== turnSeq) return;

        // Wait for the user to actually finish before keeping anything.
        const release = await gate;
        if (!release || disposed || my !== turnSeq) return;

        // Orion proposed one or more write actions — park the turn until the
        // user taps Approve/Deny, then resume from `respondToApproval`.
        const approvals = pendingApprovals(assistant);
        if (approvals.length > 0) {
          await ttsChain; // finish speaking the spoken heads-up first
          if (disposed || my !== turnSeq) return;
          parked = {
            turnId: my,
            baseMessages: turnsToMessages(convo),
            assistantMessage: assistant,
            convo,
            spokenText: messageText(assistant),
          };
          setPendingApprovalReqs(approvals);
          setPhase("idle"); // quiescent: no endpointing/barge-in until resolved
          return;
        }

        historyRef.current = [
          ...convo,
          {
            role: "assistant",
            text: messageText(assistant),
            charts: chartSpecsFromMessage(assistant),
          },
        ];
        commit();

        await ttsChain; // let every queued clip finish speaking
        if (disposed || my !== turnSeq) return;
        startListening();
      } catch (err) {
        if (signal.aborted || my !== turnSeq || disposed) {
          log("turn aborted");
          return;
        }
        // Out of credits already ended the call and said so; anything else is
        // a hiccup we recover from by listening again.
        if (err instanceof Error && err.message === NO_CREDITS) return;
        console.error("Voice turn failed", err);
        setError("Something went wrong — listening again.");
        startListening();
      }
    }

    // The user tapped Approve/Deny on a proposed action. Record the decision on
    // the parked assistant message; once every action in the turn is answered,
    // replay the message to /api/voice-chat so the SDK runs (or skips) the tool
    // and Orion confirms out loud, then fold the finished turn into history.
    async function respondToApproval(id: string, approved: boolean) {
      if (!parked || disposed) return;
      const ctx = parked;

      const answered = applyApprovalResponse(
        ctx.assistantMessage,
        id,
        approved,
      );
      const stillPending = pendingApprovals(answered);
      // Multiple actions in one turn: hold until the user has answered them all.
      if (stillPending.length > 0) {
        parked = { ...ctx, assistantMessage: answered };
        setPendingApprovalReqs(stillPending);
        return;
      }

      clearParked();
      const my = ++turnSeq;
      currentAbort?.abort();
      currentAbort = new AbortController();
      const signal = currentAbort.signal;
      ttsChain = Promise.resolve();
      prevSentence = "";
      lastSpokenText = ""; // a new reply — echo is judged against THIS turn's words
      setPhase("thinking");

      const gate = Promise.resolve(true); // the tap is the commit
      const prefix = ctx.spokenText ? `${ctx.spokenText} ` : "";
      try {
        const followUp = await streamAssistant(
          [...ctx.baseMessages, answered],
          my,
          gate,
          signal,
          prefix,
          // Seed the stream with the proposed tool call so the resumed run's
          // tool-output chunks attach to it instead of erroring with
          // "No tool invocation found for tool call ID …".
          toolInvocationSeed(answered),
        );
        if (disposed || my !== turnSeq) return;

        const spoken = [ctx.spokenText, messageText(followUp)]
          .filter(Boolean)
          .join(" ")
          .trim();
        historyRef.current = [
          ...ctx.convo,
          { role: "assistant", text: spoken },
        ];
        commit();

        await ttsChain;
        if (disposed || my !== turnSeq) return;
        startListening();
      } catch (err) {
        if (signal.aborted || my !== turnSeq || disposed) return;
        // Out of credits already ended the call and said so; anything else is
        // a hiccup we recover from by listening again.
        if (err instanceof Error && err.message === NO_CREDITS) return;
        console.error("Voice approval resume failed", err);
        setError("Something went wrong — listening again.");
        startListening();
      }
    }
    respondRef.current = (id, approved) => void respondToApproval(id, approved);

    // Typed input: treat it exactly like a finished spoken turn. Interrupt
    // anything in flight, then process the text straight through (no transcribe).
    async function injectText(text: string) {
      const trimmed = text.trim();
      if (!trimmed || disposed) return;
      log("typed turn:", JSON.stringify(trimmed));

      // A new spoken/typed turn abandons any action still awaiting approval.
      clearParked();

      // Supersede whatever is happening (listening, speculating, speaking).
      speculating = false;
      commitResolve = null;
      const my = ++turnSeq;
      currentAbort?.abort();
      currentAbort = new AbortController();
      const signal = currentAbort.signal;
      ttsChain = Promise.resolve();
      prevSentence = "";
      lastSpokenText = ""; // a new reply — echo is judged against THIS turn's words
      cleanupAudio();
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch {
          // ignore
        }
      }

      setLastUser(trimmed);
      setLiveReply("");
      setLiveActive(true);
      setPhase("thinking");

      const gate = Promise.resolve(true); // typed = already committed
      try {
        const convo: VoiceTurn[] = [
          ...historyRef.current,
          { role: "user", text: trimmed },
        ];
        const assistant = await streamAssistant(
          turnsToMessages(convo),
          my,
          gate,
          signal,
        );
        if (disposed || my !== turnSeq) return;

        const approvals = pendingApprovals(assistant);
        if (approvals.length > 0) {
          await ttsChain;
          if (disposed || my !== turnSeq) return;
          parked = {
            turnId: my,
            baseMessages: turnsToMessages(convo),
            assistantMessage: assistant,
            convo,
            spokenText: messageText(assistant),
          };
          setPendingApprovalReqs(approvals);
          setPhase("idle");
          return;
        }

        historyRef.current = [
          ...convo,
          {
            role: "assistant",
            text: messageText(assistant),
            charts: chartSpecsFromMessage(assistant),
          },
        ];
        commit();
        await ttsChain;
        if (disposed || my !== turnSeq) return;
        startListening();
      } catch (err) {
        if (signal.aborted || my !== turnSeq || disposed) return;
        // Out of credits already ended the call and said so; anything else is
        // a hiccup we recover from by listening again.
        if (err instanceof Error && err.message === NO_CREDITS) return;
        console.error("Typed voice turn failed", err);
        setError("Something went wrong — listening again.");
        startListening();
      }
    }
    submitTextRef.current = (text) => void injectText(text);

    // Boot: mic (with echo cancellation for barge-in) → analyser → listen.
    (async () => {
      // A browser that can't record is the same failure as a blocked mic — say
      // so and hand voice mode back off. Checked inside the boot rather than in
      // the effect body so the state update happens in a callback (a synchronous
      // setState in an effect body cascades a render, and the effect does
      // nothing but declare functions before this point).
      if (!isVoiceInputSupported()) {
        log("voice input unsupported in this browser");
        setError("Voice input isn't supported in this browser.");
        onEndRef.current?.();
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (disposed) return;
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        audioCtx = new Ctx();
        if (audioCtx.state === "suspended") await audioCtx.resume();
        const source = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);

        // Map the speech + analysis bands to FFT bins now that the sample rate
        // is known, and allocate the reusable analysis buffers.
        const binHz = audioCtx.sampleRate / analyser.fftSize;
        const maxBin = analyser.frequencyBinCount - 1;
        const toBin = (hz: number) =>
          Math.min(maxBin, Math.max(1, Math.round(hz / binHz)));
        speechLowBin = toBin(SPEECH_LOW_HZ);
        speechHighBin = toBin(SPEECH_HIGH_HZ);
        anaLowBin = toBin(ANALYSIS_LOW_HZ);
        anaHighBin = toBin(ANALYSIS_HIGH_HZ);
        timeBuf = new Uint8Array(analyser.fftSize);
        freqBuf = new Uint8Array(analyser.frequencyBinCount);

        mimeType = pickMimeType();
        log("mic ready, mimeType:", mimeType || "(browser default)");
        monitor(); // continuous analysis (endpointing + barge-in)
        startListening();
      } catch (err) {
        log("getUserMedia failed:", err);
        setError("Microphone access was blocked.");
        onEndRef.current?.();
      }
    })();

    return () => {
      disposed = true;
      turnSeq++;
      submitTextRef.current = () => {};
      respondRef.current = () => {};
      clearParked();
      if (rafId !== null) cancelAnimationFrame(rafId);
      currentAbort?.abort();
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch {
          // ignore
        }
      }
      stream?.getTracks().forEach((t) => t.stop());
      void audioCtx?.close().catch(() => {});
      cleanupAudio();
      setStatus("idle");
      setLastUser("");
      setLiveReply("");
      setLiveActive(false);
      setError(null);
    };
  }, [enabled]);

  const submitText = useCallback((text: string) => {
    submitTextRef.current(text);
  }, []);

  const respondToApproval = useCallback((id: string, approved: boolean) => {
    respondRef.current(id, approved);
  }, []);

  return {
    status,
    error,
    lastUser,
    liveReply,
    liveActive,
    turns,
    submitText,
    pendingApprovals: pendingApprovalReqs,
    respondToApproval,
  };
}
