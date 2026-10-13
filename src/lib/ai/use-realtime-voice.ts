"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Hands-free Orion over the OpenAI Realtime API — the speech-to-speech
 * alternative to the Anthropic cascade in `use-voice-conversation.ts`.
 *
 * The shapes are worth contrasting, because almost every difference in this
 * file follows from it. The Anthropic loop owns the whole pipeline: it records,
 * detects the end of a turn itself, POSTs the audio to be transcribed, streams
 * the model's text, then POSTs each sentence back for speech — three HTTP round
 * trips per turn, and no audio until the last of them returns. Here the browser
 * opens ONE WebRTC connection, publishes the microphone track to it, and plays
 * whatever audio comes back. Endpointing, transcription, thinking and speech
 * all happen on the far side of that connection, so there is no cascade to wait
 * on and nothing here that needs to know when the user stopped talking.
 *
 * What this file is therefore responsible for is small: get a mic, negotiate
 * the peer connection, play the remote track, and relay tool calls. What it
 * does NOT do is the interesting part — no VAD, no silence timers, no barge-in
 * detection, no echo-path estimation, no TTS queue. Those exist in the
 * Anthropic loop because a cascade has to reconstruct turn-taking from scratch;
 * the Realtime session does it natively (`semantic_vad`, set server-side).
 *
 * Trade-off, stated plainly: this path runs on OpenAI's model, so it is NOT
 * Orion's usual mind — the wildcat convention is Anthropic for agent work. It
 * also carries read-only tools, since Realtime has no equivalent of the AI
 * SDK's approval pause. Experimental, and gated off by default.
 */

export type RealtimeStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "error";

/** One line of the spoken conversation, for on-screen display. */
export interface RealtimeTurn {
  role: "user" | "assistant";
  text: string;
}

export interface UseRealtimeVoiceOptions {
  /** Master switch — the connection is open only while this is true. */
  enabled: boolean;
  /** Asks the host to turn voice off (mic blocked, session failed, ended). */
  onEnd?: () => void;
}

export interface RealtimeVoice {
  status: RealtimeStatus;
  error: string | null;
  /** Committed back-and-forth so far. */
  turns: RealtimeTurn[];
  /** The assistant's reply as it is being spoken, before it is committed. */
  liveReply: string;
}

/** Whether this browser can open the connection at all. */
export function isRealtimeSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    typeof window.RTCPeerConnection !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

const log = (...args: unknown[]) => console.log("[realtime]", ...args);

export function useRealtimeVoice(
  options: UseRealtimeVoiceOptions
): RealtimeVoice {
  const { enabled } = options;

  const [status, setStatus] = useState<RealtimeStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<RealtimeTurn[]>([]);
  const [liveReply, setLiveReply] = useState("");

  // Kept in a ref so a caller passing a fresh closure each render doesn't tear
  // down and re-open the connection. Synced in an effect rather than during
  // render — writing a ref while rendering is what `refs-during-render` flags.
  const onEndRef = useRef(options.onEnd);
  useEffect(() => {
    onEndRef.current = options.onEnd;
  }, [options.onEnd]);

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let pc: RTCPeerConnection | null = null;
    let channel: RTCDataChannel | null = null;
    let mic: MediaStream | null = null;
    let audioEl: HTMLAudioElement | null = null;

    /**
     * Whether the server currently has a response in flight.
     *
     * `turn_detection.create_response` is true, so the server starts responses
     * on its own when it decides the user has finished. A client that also
     * sends `response.create` — as the tool-result flow must, to get the answer
     * spoken — can collide with one already running, and the session rejects it
     * with "Conversation already has an active response in progress". That
     * error aborts the turn mid-task, which reads as the agent giving up.
     */
    let responseActive = false;

    /** Send one client event up the data channel. */
    function send(event: Record<string, unknown>) {
      if (channel?.readyState === "open") channel.send(JSON.stringify(event));
    }

    /**
     * Run a tool the model asked for and hand the result back.
     *
     * The call is relayed to our own server, which re-gates it and executes it
     * under the user's RLS session — OpenAI never touches the database, and the
     * browser never gains a capability it didn't already have. `response.create`
     * at the end is what makes the model actually speak the result; without it
     * the session sits idle holding an answer.
     */
    async function handleToolCall(name: string, callId: string, rawArgs: string) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
      } catch {
        // Malformed arguments are the model's error to recover from, so they
        // travel back as a tool result rather than throwing here.
        log("unparseable tool arguments", name, rawArgs);
      }

      let output: unknown;
      try {
        const res = await fetch("/api/voice/realtime/tool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, arguments: parsed }),
        });
        const body = (await res.json()) as { result?: unknown; error?: string };
        output = res.ok
          ? body.result
          : { ok: false, error: body.error ?? `tool ${name} failed` };
      } catch (err) {
        output = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (disposed) return;

      send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(output),
        },
      });
      // Only ask for a response if the server isn't already producing one.
      // Handing back the tool result is always required; requesting a second
      // concurrent response is what breaks the turn.
      if (!responseActive) {
        send({ type: "response.create" });
      } else {
        log("   response already in flight; not requesting another");
      }
    }

    /** Server events we act on. Everything else is ignored by design. */
    function handleEvent(event: Record<string, unknown>) {
      const type = event.type as string;
      // Every event type, so a turn that goes quiet shows where it stopped.
      // Transcript deltas are omitted — they arrive per token and would bury
      // everything else.
      if (type !== "response.output_audio_transcript.delta") log("<-", type);
      if (type === "response.created") responseActive = true;
      if (type === "response.done") responseActive = false;

      switch (type) {
        // The user's own words, transcribed by the far side. We never run STT.
        case "conversation.item.input_audio_transcription.completed": {
          const text = String(event.transcript ?? "").trim();
          if (text) setTurns((prev) => [...prev, { role: "user", text }]);
          break;
        }
        // Assistant transcript, streamed alongside the audio it is speaking.
        case "response.output_audio_transcript.delta": {
          setStatus("speaking");
          setLiveReply((prev) => prev + String(event.delta ?? ""));
          break;
        }
        case "response.output_audio_transcript.done": {
          const text = String(event.transcript ?? "").trim();
          if (text) setTurns((prev) => [...prev, { role: "assistant", text }]);
          setLiveReply("");
          break;
        }
        // The user started talking over Orion. The far side stops generating on
        // its own; all we do is drop the half-spoken line from the screen.
        case "input_audio_buffer.speech_started": {
          setStatus("listening");
          setLiveReply("");
          break;
        }
        case "response.done": {
          setStatus("listening");
          // The whole payload, because an empty turn is the failure we are
          // chasing: `status_details` names a refusal, a cancellation or an
          // API error, and `output` distinguishes "said nothing" from "called
          // a tool". Summary line, not the raw object, so it survives paste.
          {
            const r = event.response as
              | { status?: string; status_details?: unknown; output?: unknown[] }
              | undefined;
            log("   response summary", {
              status: r?.status,
              outputTypes: (r?.output ?? []).map(
                (o) => (o as { type?: string }).type
              ),
              statusDetails: JSON.stringify(r?.status_details ?? null),
            });
          }
          const output = (event.response as { output?: unknown[] } | undefined)?.output;
          for (const item of output ?? []) {
            const call = item as { type?: string; name?: string; call_id?: string; arguments?: string };
            if (call.type === "function_call" && call.name && call.call_id) {
              void handleToolCall(call.name, call.call_id, call.arguments ?? "");
            }
          }
          break;
        }
        case "error": {
          const message =
            (event.error as { message?: string } | undefined)?.message ??
            "The voice session hit an error.";
          log("session error", event.error);
          setError(message);
          break;
        }
      }
    }

    log("session starting — enabled");

    (async () => {
      if (!isRealtimeSupported()) {
        log("ABORT: browser lacks RTCPeerConnection or getUserMedia");
        setError("This browser can't open a realtime voice session.");
        onEndRef.current?.();
        return;
      }

      setStatus("connecting");
      try {
        // 1. Ephemeral credential. The real API key stays on the server.
        log("1/4 minting ephemeral session…");
        const tokenRes = await fetch("/api/voice/realtime/session", { method: "POST" });
        log("   session route responded", tokenRes.status);
        if (!tokenRes.ok) {
          const body = (await tokenRes.json().catch(() => ({}))) as { reason?: string };
          throw new Error(body.reason ?? `session ${tokenRes.status}`);
        }
        const secret = (await tokenRes.json()) as { value?: string };
        const key = secret.value;
        if (!key) throw new Error("session response carried no client secret");
        if (disposed) return;

        // 2. Microphone. Echo cancellation matters more here than in the
        // cascade: Orion's audio plays continuously while the mic stays open,
        // and the far side is listening the whole time.
        log("2/4 requesting microphone…");
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (disposed) return;

        // 3. Peer connection: publish the mic, play whatever comes back.
        log("3/4 mic granted; negotiating peer connection…");
        pc = new RTCPeerConnection();
        audioEl = new Audio();
        audioEl.autoplay = true;
        // Muted-by-default autoplay rules do not apply here (the mic toggle is
        // a user gesture), but the element still needs to be in the DOM.
        audioEl.style.display = "none";
        document.body.appendChild(audioEl);
        pc.ontrack = (e) => {
          if (!audioEl) return;
          // `autoplay` alone does not reliably start a detached element fed by
          // a MediaStream — play() must be called, and the element has to be in
          // the document for the browser to treat it as real playback. This is
          // why the connection could succeed with nothing audible.
          audioEl.srcObject = e.streams[0];
          audioEl
            .play()
            .then(() => log("audio track playing"))
            .catch((err) => log("audio play blocked", err));
        };
        for (const track of mic.getTracks()) pc.addTrack(track, mic);

        channel = pc.createDataChannel("oai-events");
        channel.onmessage = (e) => {
          if (disposed) return;
          try {
            handleEvent(JSON.parse(e.data as string) as Record<string, unknown>);
          } catch {
            log("unparseable server event");
          }
        };
        channel.onopen = () => {
          log("data channel open");
          setStatus("listening");
        };

        // 4. SDP exchange. The session's instructions and tools were fixed when
        // the secret was minted, so nothing configurable is sent from here.
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        log("4/4 exchanging SDP with OpenAI…");
        const sdpRes = await fetch("https://api.openai.com/v1/realtime/calls", {
          method: "POST",
          body: offer.sdp,
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/sdp" },
        });
        if (!sdpRes.ok) throw new Error(`sdp exchange ${sdpRes.status}`);
        if (disposed) return;
        await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });
        log("CONNECTED — speak now. Audio is OpenAI's voice, not ElevenLabs.");

        // Is the microphone actually feeding the connection?
        //
        // A session can connect, open its data channel and receive Orion's
        // audio track while sending nothing at all — and it looks identical
        // from the outside: no error, no speech events, silence forever. The
        // only way to tell is to read what the peer connection is really
        // sending, so sample `outbound-rtp` for a few seconds after connecting.
        //
        // Reading it: bytesSent climbing means the mic is live and the problem
        // is downstream (turn detection, the far side). bytesSent stuck at 0
        // means nothing is leaving this browser, and the mic track is the
        // thing to look at — see the track state logged alongside it.
        const track = mic.getAudioTracks()[0];
        log("mic track", {
          label: track?.label,
          readyState: track?.readyState,
          enabled: track?.enabled,
          muted: track?.muted,
        });

        let samples = 0;
        const statsTimer = setInterval(async () => {
          if (disposed || !pc || ++samples > 5) {
            clearInterval(statsTimer);
            return;
          }
          const stats = await pc.getStats();
          let sent = 0;
          let level: number | undefined;
          stats.forEach((r) => {
            if (r.type === "outbound-rtp" && r.kind === "audio") {
              sent = (r as { bytesSent?: number }).bytesSent ?? 0;
            }
            if (r.type === "media-source" && r.kind === "audio") {
              level = (r as { audioLevel?: number }).audioLevel;
            }
          });
          log(
            `mic → OpenAI: ${sent} bytes sent, input level ${
              level === undefined ? "n/a" : level.toFixed(4)
            }, pc=${pc.connectionState}/${pc.iceConnectionState}`
          );
        }, 3_000);
      } catch (err) {
        if (disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        log("FAILED at the step above:", message);
        console.error("Realtime voice failed", err);
        setError(
          message.includes("Permission") || message.includes("NotAllowed")
            ? "Microphone access was blocked."
            : "Couldn't start the voice session."
        );
        setStatus("error");
        onEndRef.current?.();
      }
    })();

    return () => {
      disposed = true;
      channel?.close();
      mic?.getTracks().forEach((t) => t.stop());
      pc?.close();
      if (audioEl) {
        audioEl.pause();
        audioEl.srcObject = null;
        audioEl.remove();
      }
      setStatus("idle");
      setLiveReply("");
      setError(null);
      // The transcript goes too, so the NEXT session starts clean.
      //
      // This host stays mounted for the life of the app — toggling voice only
      // flips `enabled` — so anything not cleared here survives into the next
      // session. Leaving it meant reopening voice showed the previous
      // conversation's reply sitting under a "listening" indicator, as though
      // Orion had just said it. Cleared on teardown rather than on the way in
      // because a cleanup function may set state; an effect body may not.
      setTurns([]);
    };
  }, [enabled]);

  return { status, error, turns, liveReply };
}
