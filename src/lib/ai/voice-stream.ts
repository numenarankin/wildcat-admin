import {
  parseJsonEventStream,
  readUIMessageStream,
  uiMessageChunkSchema,
  type UIMessage,
} from "ai";

/**
 * Consume a UI-message-stream HTTP response body as progressive {@link UIMessage}
 * snapshots. The voice loop isn't a `useChat` client — it drives audio itself —
 * so it reads the same stream the typed drawer does by hand: parse the SSE bytes
 * into UI-message chunks, then fold them into a single growing assistant message.
 * This is what lets voice see assistant text deltas (for TTS) *and* tool
 * approval-request parts (for the tap-to-approve card) on one connection.
 */
export function readVoiceMessageStream(
  body: ReadableStream<Uint8Array>,
  options: {
    onError?: (error: unknown) => void;
    /**
     * Existing assistant message to continue building on. Required when
     * resuming a tool-approval run: the resumed stream emits tool-output chunks
     * for the already-proposed tool call, and `readUIMessageStream` matches them
     * to a tool part on this seed. Without it the stream builds a fresh, empty
     * message and throws `No tool invocation found for tool call ID …`.
     */
    resumeFrom?: UIMessage;
  } = {},
): AsyncIterable<UIMessage> {
  const chunks = parseJsonEventStream({
    stream: body,
    schema: uiMessageChunkSchema,
  }).pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        if (!chunk.success) throw chunk.error;
        controller.enqueue(chunk.value);
      },
    }),
  );
  // An error part in the stream produces no message snapshot, so without the
  // onError hook a server-side failure looks identical to a stream that simply
  // yielded nothing. Surface it to the caller so it can throw the real reason.
  return readUIMessageStream({
    stream: chunks,
    onError: options.onError,
    message: options.resumeFrom,
  });
}

/**
 * Build a resume seed from a parked assistant message: a copy carrying only its
 * tool parts. The seed lets {@link readVoiceMessageStream} attach the resumed
 * run's tool-output chunks to the original tool call. Text parts are dropped on
 * purpose — the proposal text was already streamed and spoken on the first
 * turn, so keeping it would re-speak and duplicate it in the follow-up. Parts
 * are shallow-copied so the stream's in-place updates don't mutate the original.
 */
export function toolInvocationSeed(message: UIMessage): UIMessage {
  return {
    ...message,
    parts: message.parts
      .filter((p) => (p as { type: string }).type.startsWith("tool-"))
      .map((p) => ({ ...p })) as UIMessage["parts"],
  };
}

/** Concatenated spoken text of an assistant message (text parts only — tool
 *  parts carry no spoken content). */
export function messageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Return a copy of an assistant message with the approval-requested tool part
 * `id` marked approved/denied. Replaying this message to the server resumes the
 * run: the SDK executes the tool (approved) or records the denial, then Orion
 * continues. Immutable — the original message is untouched.
 */
export function applyApprovalResponse(
  message: UIMessage,
  id: string,
  approved: boolean,
): UIMessage {
  return {
    ...message,
    parts: message.parts.map((part) => {
      const p = part as {
        type: string;
        state?: string;
        approval?: { id: string };
      };
      if (
        p.type.startsWith("tool-") &&
        p.state === "approval-requested" &&
        p.approval?.id === id
      ) {
        return {
          ...part,
          state: "approval-responded",
          approval: { ...p.approval, approved },
        };
      }
      return part;
    }) as UIMessage["parts"],
  };
}
