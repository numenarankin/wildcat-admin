"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SpeechState = "idle" | "loading" | "playing";

/**
 * Drives a single shared <audio> element for "read aloud". Only one message can
 * play at a time: toggling a new one cancels any in-flight fetch/playback, and
 * toggling the active one stops it. `activeId` + `state` tell each message which
 * icon to show.
 */
export function useSpeech() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  // Bumped on every stop/new request; a stale in-flight load checks this and
  // bails so a late-arriving fetch can't hijack playback.
  const reqRef = useRef(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [state, setState] = useState<SpeechState>("idle");

  const stop = useCallback(() => {
    reqRef.current++;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setActiveId(null);
    setState("idle");
  }, []);

  // Stop playback if the component unmounts mid-stream.
  useEffect(() => stop, [stop]);

  const toggle = useCallback(
    async (id: string, text: string) => {
      // Clicking the message that's already active stops it.
      if (activeId === id) {
        stop();
        return;
      }
      stop();
      const myReq = reqRef.current;
      setActiveId(id);
      setState("loading");

      try {
        const res = await fetch("/api/voice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (reqRef.current !== myReq) return; // superseded while fetching
        if (!res.ok) throw new Error(await res.text());

        const blob = await res.blob();
        if (reqRef.current !== myReq) return; // superseded while reading body

        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = stop;
        audio.onerror = stop;
        await audio.play();
        if (reqRef.current !== myReq) return;
        setState("playing");
      } catch (error) {
        if (reqRef.current === myReq) {
          console.error("Read aloud failed", error);
          stop();
        }
      }
    },
    [activeId, stop]
  );

  return { activeId, state, toggle, stop };
}
