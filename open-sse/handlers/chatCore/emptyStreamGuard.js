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
import { classifyThrownError, FAILURE_KIND, isRetryableStatus } from "../../utils/failureClassifier.js";

// Mirrors oh-my-pi's empty-response policy: 2 retries, 500ms * 2^attempt backoff.
export const EMPTY_STREAM_MAX_RETRIES = 2;
export const EMPTY_STREAM_BASE_DELAY_MS = 500;

// Hard cap on in-stream account rotations per request. Prevents an unbounded
// loop even if the account selector keeps producing fresh ids (e.g. DB churn).
export const MAX_STREAM_ROTATIONS = 8;

export { isRetryableStatus };

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
 * Wrap the upstream SSE body so empty attempts are retried in-stream and
 * exhausted accounts rotate to the next one — ONE recovery state machine for
 * every hop: same-account empty retries, execute-time failures, rotated
 * first-execute failures (Hole A/B), and final exhaustion.
 *
 * @param {ReadableStream|null} options.body       attempt 1's body (null =
 *   immediate empty attempt)
 * @param {() => Promise<ReadableStream>} options.reexecute  re-issue the
 *   identical request; resolves to the new attempt's body (or null on empty
 *   200), throws on failure with [status] message or err.status
 * @param {AbortSignal} options.signal        client-disconnect signal
 * @param {object} options.log
 * @param {string} [options.provider]         provider id — enables
 *   account-scoped 4xx classification (401/403/404 → rotate)
 * @param {number} options.stallTimeoutMs     per-read stall escape
 * @param {string} [options.connectionId]     connectionId of initial account
 * @param {{ meaningful: boolean, exhausted: boolean }} [options.state] shared
 *   state used by the response pipeline to avoid clearing a failed account
 * @param {(reason: string, meta: { upstreamError: object|null }) => void|Promise<void>} [options.onExhausted]
 *   observer for "every attempt came back empty" when onAccountExhausted is not provided
 * @param {(info: { reason: string, upstreamError: object|null, currentConnectionId: string, resetsAtMs?: number }) => Promise<{ reexecute: () => Promise<ReadableStream>, connectionId?: string }|null>} [options.onAccountExhausted]
 *   server-side account recovery hook: called when same-account retries exhaust.
 *   Benches current account, excludes it, and returns the next account's reexecute factory.
 * @returns {ReadableStream} byte stream for the SSE transform pipeline
 */
export function createEmptyRetryStream({ body, reexecute, signal, log, provider, stallTimeoutMs = STREAM_STALL_TIMEOUT_MS, baseDelayMs = EMPTY_STREAM_BASE_DELAY_MS, connectionId = "", onExhausted, onAccountExhausted, state = null }) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let currentReader = null;
  let downstreamGone = false;
  let currentConnectionId = connectionId;
  let activeReexecute = reexecute;

  return new ReadableStream({
    async start(controller) {
      let meaningfulSeen = false;
      // Per-account held failure state. Reset on every rotation hop so a stale
      // error from account A is never emitted as if it came from account B.
      let lastHeld = null;
      if (state) {
        state.meaningful = false;
        state.exhausted = false;
      }

      let readerError = null;
      try {
        currentReader = (body || new ReadableStream({ start(c) { c.close(); } })).getReader();
      } catch (error) {
        readerError = error;
      }
      // Attempt 0 is the caller-provided body (that upstream request is ALREADY
      // issued — the guard only reads it). Consumed once: a rotated account's
      // first attempt must go through reexecute, never re-read this older body.
      let firstAttemptPending = body != null;

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
      const abortAwareWait = (delayMs) =>
        new Promise((resolve) => {
          let timer;
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener?.("abort", onAbort);
            resolve();
          };
          const onAbort = () => done();
          timer = setTimeout(done, delayMs);
           signal?.addEventListener?.("abort", onAbort, { once: true });
         });

      if (readerError) {
        if (signal?.aborted) return abortStream();
        log?.error?.("STREAM", `ANTIGRAVITY | unable to read upstream stream: ${readerError?.message || readerError}`);
        if (state) state.exhausted = true;
        emit(`data: ${JSON.stringify({ error: { code: 502, status: "STREAM_READ_ERROR", message: "Unable to read upstream stream" } })}\n\n`);
        closeStream();
        return;
      }

      const exhaust = async (reason, heldForCurrent) => {
        // Bench-before-emit: the error event triggers the client's automatic
        // retry, so the observer (account bench) must complete first or the
        // retry can land on the account that just failed. When rotation owns
        // benching (onAccountExhausted exists and already benched this hop's
        // account), skip onExhausted to guarantee ONE bench per account.
        const alreadyBenched = onAccountExhausted && benchedConnectionIds.has(currentConnectionId);
        if (!alreadyBenched) {
          try {
            await Promise.resolve(onExhausted?.(reason, { upstreamError: lastHeld?.error || null }));
          } catch { /* observer must not break the stream */ }
        }
        // Re-emit the real upstream error when the CURRENT account held one
        // (true status/message, e.g. RESOURCE_EXHAUSTED); otherwise synthesize
        // an embedded error. The gemini translator converts either into the
        // client-facing error finish.
        if (state) state.exhausted = true;
        const held = heldForCurrent || lastHeld;
        const line = held?.kind === "error_object"
          ? held.line
          : `data: ${JSON.stringify({ error: { code: 502, status: "EMPTY_RESPONSE", message: reason } })}\n\n`;
        emit(line);
        closeStream();
      };

      // Attempt one reexecute and classify any failure. Returns:
      //   { reader }        — new attempt ready to read
      //   { exhaust: { reason, held } } — deterministic/terminal failure
      //   { rotated: true } — account rotated; caller must loop
      const executeAttempt = async () => {
        let attemptBody;
        try {
          attemptBody = await activeReexecute();
        } catch (error) {
          if (error?.name === "AbortError" || signal?.aborted) return abortStream();
          const cls = classifyThrownError(error, { provider, signal });
          if (cls.kind === FAILURE_KIND.DETERMINISTIC || cls.kind === FAILURE_KIND.TERMINAL) {
            log?.warn?.("STREAM", `ANTIGRAVITY | deterministic fetch failure (${error?.message?.slice?.(0, 80) || "unknown"}) — no rotate`);
            return { exhaust: { reason: error?.message || "retry request failed" } };
          }
          if (cls.kind === FAILURE_KIND.ABORT) return abortStream();
          return { rotated: true, cls };
        }
        if (!attemptBody) {
          // 200 with no body IS the empty-stream problem: count as an empty
          // attempt (same-account bounded retry, then rotate) — never an
          // instant terminal failure (#Phase-7).
          return { emptyAttempt: true };
        }
        try {
          return { reader: attemptBody.getReader() };
        } catch (error) {
          log?.error?.("STREAM", `ANTIGRAVITY | unable to acquire retry reader: ${error?.message || error}`);
          return { exhaust: { reason: "upstream stream reader unavailable" } };
        }
      };

      // Rotate to the next account. Returns null when no (new) account is
      // available — caller exhausts. Rotations are counted and each selected
      // connection is registered so a broken selector can never loop A→B→A.
      let rotationCount = 0;
      const benchedConnectionIds = new Set();
      const tryRotate = async ({ reason, upstreamError, resetsAtMs }) => {
        if (!onAccountExhausted) return null;
        if (rotationCount >= MAX_STREAM_ROTATIONS) {
          log?.warn?.("STREAM", `ANTIGRAVITY | rotation budget exhausted (${MAX_STREAM_ROTATIONS}) — terminating`);
          return null;
        }
        if (signal?.aborted) return null;
        // The hook benches the current account as a documented side effect
        // (chat.js: markAccountUnavailable before selecting the next one).
        // Record it HERE — before the hook call — so exhaust() skips its own
        // onExhausted bench when rotation was attempted but refused (null).
        // Otherwise every exhausted account would be benched twice.
        if (currentConnectionId) benchedConnectionIds.add(currentConnectionId);
        let next;
        try {
          next = await onAccountExhausted({ reason, upstreamError, currentConnectionId, resetsAtMs });
        } catch (error) {
          log?.warn?.("STREAM", `ANTIGRAVITY | onAccountExhausted threw: ${error?.message || error}`);
          return null;
        }
        if (!next || typeof next.reexecute !== "function") return null;
        const nextId = next.connectionId || "";
        if (nextId && (nextId === currentConnectionId || benchedConnectionIds.has(nextId) || attemptedConnections.has(nextId))) {
          log?.warn?.("STREAM", `ANTIGRAVITY | selector returned already-attempted account ${nextId?.slice?.(0, 8)} — refusing revisit, terminating`);
          return null;
        }
        rotationCount++;
        if (nextId) attemptedConnections.add(nextId);
        activeReexecute = next.reexecute;
        currentConnectionId = nextId;
        // Account changed: per-account failure state must not leak across hops.
        lastHeld = null;
        log?.warn?.("STREAM", `ANTIGRAVITY | rotating account in-stream → ${nextId?.slice?.(0, 8) || "next"}`);
        log?.warn?.("STREAM", `    reason=${reason?.slice?.(0, 80)} | upstream=${upstreamError?.status || upstreamError?.code || "EMPTY"}`);
        return true;
      };

      const attemptedConnections = new Set(connectionId ? [connectionId] : []);

      for (let attempt = 0; ; attempt++) {
        let lineBuffer = "";
        let held = null; // this attempt's withheld terminal
        let terminalForwarded = false;
        let endReason = "empty";
        lastHeld = null;

        // SSE producers occasionally flush a final data event without a
        // newline. Process that tail with the same policy as complete lines so
        // a partial terminal cannot be mistaken for an empty response.
        const processTrailingLine = (line) => {
          if (held || !line) return;
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) { emit(line); return; }
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") { emit(line); return; }

          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            emit(line);
            return;
          }

          const decision = classifyEvent(parsed, meaningfulSeen);
          if (decision.meaningful) {
            meaningfulSeen = true;
            if (state) state.meaningful = true;
          }
          if (decision.action === "hold") {
            held = { kind: decision.kind, reason: decision.reason, error: decision.error || null, line: `${line}\n\n` };
            lastHeld = held;
            return;
          }
          if (decision.terminal) terminalForwarded = true;
          emit(line);
        };

        // § Execute the current attempt (same-account retry, or the first
        //   attempt of a freshly rotated account). Attempt 0 is NOT
        //   re-executed: the caller already issued that request and handed us
        //   its body — re-issuing it would fire a duplicate paid upstream
        //   request and let a client abort land after the re-issue.
        let executed;
        if (firstAttemptPending) {
          executed = { reader: currentReader };
          firstAttemptPending = false;
        } else {
          executed = await executeAttempt();
        }
        if (executed === undefined) return; // abortStream path
        if (executed.exhaust) return exhaust(executed.exhaust.reason, lastHeld);
        if (executed.rotated) {
          const rotated = await tryRotate({
            reason: `retryable fetch failure: ${executed.cls.reason || "unknown"}`,
            upstreamError: { code: executed.cls.code ?? executed.cls.status ?? 0, status: executed.cls.reason || "fetch failed" },
          });
          if (!rotated) {
            // No further account available (or rotation refused) — terminate
            // truthfully. The current account was already benched by rotation.
            return exhaust(`rotated reexecute failed: ${executed.cls.reason || "unknown"}`, lastHeld);
          }
          attempt = -1; // fresh account gets its own bounded retry budget
          continue;
        }
        if (executed.emptyAttempt) {
          // No-body 200: an empty attempt like any other (read nothing).
          // Fall through with endReason so the standard retry/rotate policy
          // applies instead of an instant terminal.
          currentReader = new ReadableStream({ start(c) { c.close(); } }).getReader();
          endReason = "no_body";
        } else {
          currentReader = executed.reader;
        }

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
            if (decision.meaningful) {
              meaningfulSeen = true;
              if (state) state.meaningful = true;
            }
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
        const trailing = lineBuffer + decoder.decode();
        if (trailing && !held) {
          for (const line of trailing.split("\n")) {
            if (line) processTrailingLine(line);
          }
          lineBuffer = "";
        }

        if (meaningfulSeen || terminalForwarded) {
          const remaining = lineBuffer + decoder.decode();
          if (!held && remaining) emit(remaining);
          closeStream();
          return;
        }

        const reason = held ? held.reason : endReason;
        log?.warn?.("STREAM", `ANTIGRAVITY | empty (${reason}) | attempt ${attempt + 1}/${EMPTY_STREAM_MAX_RETRIES + 1} | acc=${currentConnectionId?.slice?.(0, 8) || "-"}`);

        if (attempt >= EMPTY_STREAM_MAX_RETRIES) {
          const exhaustReason = `empty response from upstream (${reason}) after ${attempt + 1} attempts`;
          const rotated = await tryRotate({
            reason: exhaustReason,
            upstreamError: lastHeld?.error || null,
          });
          if (!rotated) {
            return exhaust(exhaustReason, lastHeld);
          }
          attempt = -1; // reset attempt counter for rotated account
          continue;
        }

        // Abort-aware backoff, then splice the retried attempt into this stream.
        await abortAwareWait(baseDelayMs * 2 ** attempt);
        if (signal?.aborted) return abortStream();
      }
    },

    cancel(reason) {
      downstreamGone = true;
      try { currentReader?.cancel(reason)?.catch?.(() => { }); } catch { /* already closed */ }
    },
  });
}
