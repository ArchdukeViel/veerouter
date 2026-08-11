// Empty-stream guard for Antigravity — oh-my-pi parity.
//
// Gemini occasionally answers HTTP 200 with a stream that carries no usable
// output (no candidates at all, thought-only parts, a bare STOP with empty
// text) or aborts the turn (MALFORMED_FUNCTION_CALL) before emitting anything.
// Delivered as-is the client receives a blank turn and silently halts
// (#2188, #2229, #2250, #2259, #2431).
//
// Mirrors oh-my-pi: every byte — thinking included — streams to the client
// live; emptiness is judged per upstream attempt, after the fact. An attempt
// that ends without meaningful content has its terminal event withheld and is
// retried in place with the identical request; the retried attempt splices
// into the same client stream (the translator inits its message once, so the
// splice continues the same client message). Accepted wart, same as oh-my-pi:
// the client may see thinking from a discarded attempt followed by the retry's
// thinking inside one message. On exhaustion an {error:{...}} event is emitted
// in-stream — the gemini translator turns it into the client-facing error
// finish, which Anthropic clients treat as retryable.
import { GEMINI_FINISH, GEMINI_ERROR_FINISH_REASONS, GEMINI_CONTENT_FILTER_FINISH_REASONS } from "../../translator/schema/finishReasons.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";

// Mirrors oh-my-pi's empty-response policy: 2 retries, 500ms * 2^attempt backoff.
export const EMPTY_STREAM_MAX_RETRIES = 2;
export const EMPTY_STREAM_BASE_DELAY_MS = 500;

// Account-rotation policy: only retry/rotate for upstream conditions that are
// likely to differ between accounts. Deterministic errors (bad request,
// unauthorized, schema validation, malformed client payload) hit every
// account the same way and waste rotation slots.
export function isRetryableStatus(status) {
  if (typeof status !== "number" || !Number.isFinite(status)) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500 && status < 600) return status !== 501;
  return false;
}

// A part is meaningful when it carries output the client can act on: a tool
// call, inline data, or non-whitespace visible text. Thought-only parts are
// not — thinking that never produced an answer IS the empty-response failure
// (#2229). Thought parts still stream to the client live; they just don't mark
// the attempt as non-empty.
export function isMeaningfulPart(part) {
  if (!part) return false;
  if (part.functionCall) return true;
  if (part.inlineData?.data || part.inline_data?.data) return true;
  if (part.thought === true) return false;
  return typeof part.text === "string" && part.text.trim().length > 0;
}

// Decide what to do with one parsed SSE event.
// - forward: pass the original line through (optionally marking the stream
//   terminal so the attempt is never retried)
// - hold: withhold it — it is the terminal of an empty attempt; the message
//   must stay open so the retried attempt can splice in.
function classifyEvent(parsed, meaningfulSeen) {
  // Antigravity wrapper
  const response = parsed.response || parsed;
  if (!response || typeof response !== "object") return { action: "forward" };

  const errorObj = response.error || parsed.error;
  if (errorObj) {
    // Embedded error object in a 200 stream. After content: forward — the
    // translator closes the message with the error finish. Before content:
    // withhold and retry (usually transient, e.g. RESOURCE_EXHAUSTED blips).
    if (meaningfulSeen) return { action: "forward", terminal: true };
    return { action: "hold", kind: "error_object", reason: errorObj.status || errorObj.message || "error", error: errorObj };
  }

  // Prompt blocked by policy: deterministic for this prompt — never retried.
  // Forward so the translator closes the stream as content_filter (#2188).
  if (!response.candidates?.length && response.promptFeedback?.blockReason) {
    return { action: "forward", terminal: true };
  }

  const candidate = response.candidates?.[0];
  if (!candidate) return { action: "forward" }; // keep-alive / usage-only

  let meaningful = false;
  for (const part of candidate.content?.parts || []) {
    if (isMeaningfulPart(part)) { meaningful = true; break; }
  }

  const finishReason = candidate.finishReason && String(candidate.finishReason).toUpperCase();
  if (!finishReason) return { action: "forward", meaningful };

  // Content blocks and token exhaustion are deterministic whatever the content
  // — retrying re-runs the same outcome (oh-my-pi never retries these either).
  if (GEMINI_CONTENT_FILTER_FINISH_REASONS.has(finishReason) || finishReason === GEMINI_FINISH.MAX_TOKENS) {
    return { action: "forward", meaningful, terminal: true };
  }

  // Any other finish (bare STOP, MALFORMED_FUNCTION_CALL family, unknown) with
  // content forwards normally — the translator emits the tool_calls upgrade or
  // the error event. Without content it is the empty attempt's terminal.
  if (meaningful || meaningfulSeen) return { action: "forward", meaningful, terminal: true };
  return {
    action: "hold",
    kind: GEMINI_ERROR_FINISH_REASONS.has(finishReason) ? "error_finish" : "stop",
    reason: finishReason,
  };
}

/**
 * Wrap the upstream SSE body so empty attempts are retried in-stream.
 *
 * @param {ReadableStream} options.body       attempt 1's body
 * @param {() => Promise<ReadableStream>} options.reexecute  re-issue the
 *   identical request; resolves to the new attempt's body, throws on failure
 * @param {AbortSignal} options.signal        client-disconnect signal
 * @param {object} options.log
 * @param {number} options.stallTimeoutMs     per-read stall escape
 * @param {string} [options.connectionId]     connectionId of initial account
 * @param {(reason: string, meta: { upstreamError: object|null }) => void|Promise<void>} [options.onExhausted]
 *   observer for "every attempt came back empty" when onAccountExhausted is not provided
 * @param {(info: { reason: string, upstreamError: object|null, currentConnectionId: string }) => Promise<{ reexecute: () => Promise<ReadableStream>, connectionId?: string }|null>} [options.onAccountExhausted]
 *   server-side account recovery hook: called when same-account retries exhaust.
 *   Benches current account, excludes it, and returns the next account's reexecute factory.
 * @returns {ReadableStream} byte stream for the SSE transform pipeline
 */
export function createEmptyRetryStream({ body, reexecute, signal, log, stallTimeoutMs = STREAM_STALL_TIMEOUT_MS, baseDelayMs = EMPTY_STREAM_BASE_DELAY_MS, connectionId = "", onExhausted, onAccountExhausted }) {
  const encoder = new TextEncoder();
  let currentReader = null;
  let downstreamGone = false;
  let currentConnectionId = connectionId;
  let activeReexecute = reexecute;

  return new ReadableStream({
    async start(controller) {
      currentReader = body.getReader();
      let meaningfulSeen = false;
      let lastHeld = null; // last withheld terminal, kept for the exhaustion event

      const emit = (text) => {
        if (downstreamGone) return;
        try { controller.enqueue(encoder.encode(text)); } catch { downstreamGone = true; }
      };
      const closeStream = () => {
        if (downstreamGone) return;
        try { controller.close(); } catch { /* already closed */ }
      };
      const abortStream = () => {
        // cancel() rejects when the stream already errored — swallow the promise too
        try { currentReader.cancel().catch(() => { }); } catch { /* already closed */ }
        if (downstreamGone) return;
        const err = new Error("Request aborted");
        err.name = "AbortError";
        try { controller.error(err); } catch { /* already closed */ }
      };

      // Parse "[NNN] message" prefix from chatCore's reexecute-thrown errors
      // so we can classify retryable vs deterministic upstream failures.
      const parseStatusFromMessage = (msg) => {
        if (typeof msg !== "string") return null;
        const m = msg.match(/^\s*\[(\d{3})\]\s*/);
        return m ? Number(m[1]) : null;
      };
      const classifyError = (error) => {
        const status = error?.status ?? parseStatusFromMessage(error?.message) ?? null;
        if (status !== null && status !== undefined) return { status, retryable: isRetryableStatus(status) };
        // Network / transport — rotate to next account
        const name = error?.name || "";
        if (name === "AbortError") return { status: null, retryable: false };
        const lower = String(error?.message || "").toLowerCase();
        const retryable =
          lower.includes("econnreset") || lower.includes("etimedout") || lower.includes("epipe") ||
          lower.includes("fetch failed") || lower.includes("network") || lower.includes("socket hang up") ||
          lower.includes("temporary") || lower.includes("capacity") ||
          lower.includes("high traffic") || lower.includes("timeout") || lower.includes("timed out") ||
          lower.includes("agent execution terminated") || lower.includes("terminated due to error") ||
          lower.includes("stream ended") || lower.includes("stream closed") ||
          lower.includes("und_err_socket") || lower.includes("empty response") ||
          lower.includes("resource_exhausted") || lower.includes("quota");
        const deterministic =
          lower.includes("bad request") || lower.includes("unauthorized") || lower.includes("forbidden") ||
          lower.includes("not found") || lower.includes("method not allowed") || lower.includes("not acceptable") ||
          lower.includes("payload too large") || lower.includes("schema") || lower.includes("validation") ||
          lower.includes("malformed");
        return { status: null, retryable: retryable && !deterministic };
      };

      const exhaust = async (reason) => {
        // Bench-before-emit: the error event triggers the client's automatic
        // retry, so the observer (account bench) must complete first or the
        // retry can land on the account that just failed.
        try {
          await Promise.resolve(onExhausted?.(reason, { upstreamError: lastHeld?.error || null }));
        } catch { /* observer must not break the stream */ }
        // Re-emit the real upstream error when we held one (true status/message,
        // e.g. RESOURCE_EXHAUSTED); otherwise synthesize an embedded error. The
        // gemini translator converts either into the client-facing error finish.
        const line = lastHeld?.kind === "error_object"
          ? lastHeld.line
          : `data: ${JSON.stringify({ error: { code: 502, status: "EMPTY_RESPONSE", message: reason } })}\n\n`;
        emit(line);
        closeStream();
      };

      for (let attempt = 0; ; attempt++) {
        const decoder = new TextDecoder();
        let lineBuffer = "";
        let held = null; // this attempt's withheld terminal
        let terminalForwarded = false;
        let endReason = "empty";

        readAttempt: while (true) {
          if (signal?.aborted) return abortStream();

          let readResult;
          let stallTimer;
          try {
            // Defensive stall escape: a byte-silent upstream must not hang the pipe.
            readResult = await Promise.race([
              currentReader.read(),
              new Promise((resolve) => { stallTimer = setTimeout(() => resolve({ __stalled: true }), stallTimeoutMs); }),
            ]);
          } catch {
            // A client abort rejects the pending read — never treat it as an
            // empty attempt or a disconnect turns into a retry/error.
            if (signal?.aborted) return abortStream();
            endReason = "read_error";
            break readAttempt; // truncated attempt
          } finally {
            clearTimeout(stallTimer);
          }
          if (readResult.__stalled) {
            try { currentReader.cancel().catch(() => { }); } catch { /* already closed */ }
            endReason = "stall";
            break readAttempt;
          }

          const { done, value } = readResult;
          if (done) break readAttempt;

          lineBuffer += decoder.decode(value, { stream: true });
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop(); // trailing partial line

          for (const line of lines) {
            // Empty-attempt tail: everything after the withheld terminal is
            // part of the discarded attempt (usage trailers etc.) — drop it.
            if (held) continue;

            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) { emit(line + "\n"); continue; }
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") { emit(line + "\n"); continue; }

            let parsed;
            try {
              parsed = JSON.parse(payload);
            } catch {
              emit(line + "\n"); // not ours to judge — forward verbatim
              continue;
            }

            const decision = classifyEvent(parsed, meaningfulSeen);
            if (decision.meaningful) meaningfulSeen = true;
            if (decision.action === "hold") {
              held = { kind: decision.kind, reason: decision.reason, error: decision.error || null, line: `${line}\n\n` };
              lastHeld = held;
              continue;
            }
            if (decision.terminal) terminalForwarded = true;
            emit(line + "\n");
          }
        }

        // Attempt over. Content or a forwarded terminal ends the stream here —
        // a truncated-with-content attempt is closed by the translator's flush
        // finalization and is never retried (replay-unsafe, as in oh-my-pi).
        if (meaningfulSeen || terminalForwarded) {
          const remaining = lineBuffer + decoder.decode();
          if (!held && remaining) emit(remaining);
          closeStream();
          return;
        }

        const reason = held ? held.reason : endReason;
        log?.warn?.("STREAM", `ANTIGRAVITY | empty (${reason}) | attempt ${attempt + 1}/${EMPTY_STREAM_MAX_RETRIES + 1}`);

        if (attempt >= EMPTY_STREAM_MAX_RETRIES) {
          const exhaustReason = `empty response from upstream (${reason}) after ${attempt + 1} attempts`;
          if (onAccountExhausted) {
            try {
              const next = await onAccountExhausted({
                reason: exhaustReason,
                upstreamError: lastHeld?.error || null,
                currentConnectionId,
              });
              if (next && typeof next.reexecute === "function") {
                if (signal?.aborted) return abortStream();
                activeReexecute = next.reexecute;
                if (next.connectionId) currentConnectionId = next.connectionId;
                log?.warn?.("STREAM", `ANTIGRAVITY | rotating account in-stream after ${attempt + 1} empty attempts → ${currentConnectionId?.slice?.(0, 8) || "next"}`);
                attempt = -1; // reset attempt counter for rotated account
                try {
                  currentReader = (await activeReexecute()).getReader();
                  continue;
                } catch (err) {
                  if (err?.name === "AbortError" || signal?.aborted) return abortStream();
                  return exhaust(err?.message || "rotated reexecute failed");
                }
              }
            } catch (error) {
              log?.warn?.("STREAM", `ANTIGRAVITY | onAccountExhausted threw: ${error?.message || error}`);
            }
          }
          return exhaust(exhaustReason);
        }

        // Abort-aware backoff, then splice the retried attempt into this stream.
        await new Promise((resolve) => {
          const t = setTimeout(resolve, baseDelayMs * 2 ** attempt);
          signal?.addEventListener?.("abort", () => { clearTimeout(t); resolve(); }, { once: true });
        });
        if (signal?.aborted) return abortStream();

        try {
          currentReader = (await activeReexecute()).getReader();
        } catch (error) {
          if (error?.name === "AbortError" || signal?.aborted) return abortStream();

          // Classify the failure: retryable (rotate to next account) or
          // deterministic (exhaust immediately). Reusing the same rotation
          // path as the empty-retry case keeps both behaviors consistent.
          const cls = classifyError(error);
          if (cls.retryable && onAccountExhausted) {
            log?.warn?.("STREAM", `ANTIGRAVITY | retryable fetch failure (${error?.message?.slice?.(0, 80) || "unknown"}) on attempt ${attempt + 1} — rotating`);
            try {
              const next = await onAccountExhausted({
                reason: `retryable fetch failure: ${error?.message || "unknown"}`,
                upstreamError: { code: cls.status ?? 0, status: error?.message || "fetch failed" },
                currentConnectionId,
              });
              if (next && typeof next.reexecute === "function") {
                if (signal?.aborted) return abortStream();
                activeReexecute = next.reexecute;
                if (next.connectionId) currentConnectionId = next.connectionId;
                attempt = -1;
                try {
                  currentReader = (await activeReexecute()).getReader();
                  continue;
                } catch (err) {
                  if (err?.name === "AbortError" || signal?.aborted) return abortStream();
                  const inner = classifyError(err);
                  if (inner.retryable) {
                    log?.warn?.("STREAM", `ANTIGRAVITY | rotated reexecute still retryable (${err?.message?.slice?.(0, 80) || "unknown"}) — falling through to exhaust`);
                  }
                  return exhaust(err?.message || "rotated reexecute failed");
                }
              }
            } catch (rotErr) {
              log?.warn?.("STREAM", `ANTIGRAVITY | onAccountExhausted threw during fetch-failure recovery: ${rotErr?.message || rotErr}`);
            }
          } else if (!cls.retryable) {
            log?.warn?.("STREAM", `ANTIGRAVITY | deterministic fetch failure (${error?.message?.slice?.(0, 80) || "unknown"}) on attempt ${attempt + 1} — no rotate`);
          }
          return exhaust(error?.message || "retry request failed");
        }
      }
    },

    cancel(reason) {
      downstreamGone = true;
      try { currentReader?.cancel(reason)?.catch?.(() => { }); } catch { /* already closed */ }
    },
  });
}
