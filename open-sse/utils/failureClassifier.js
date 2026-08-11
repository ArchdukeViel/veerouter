// Authoritative upstream-failure classification for account-aware recovery.
//
// Single policy used by BOTH the empty-stream guard (open-sse) and the
// app-side account loop (src/sse/handlers/chat.js). Kept provider-agnostic
// by default, with account-scoped rules for OAuth providers (antigravity /
// gemini-cli) where a 401/403/404 can be ACCOUNT-specific rather than
// request-deterministic.
//
// Structured result:
//   {
//     kind: "abort" | "deterministic" | "retry_same_account" |
//           "rotate_account" | "terminal",
//     status,          // numeric upstream status when known, else null
//     code,            // stable machine code (e.g. "EMPTY_BODY", "ECONNRESET")
//     reason,          // human-safe classification reason
//     retryable,       // boolean: is a retry/rotation attempt worth it
//     emptyBody,       // true when upstream returned 200 with no usable body
//   }
//
// kind semantics:
//   abort             — client disconnected / signal aborted. Never retry.
//   deterministic     — request-shape corruption every account would repeat
//                       (schema, malformed tool declaration, bad signature
//                       history). Terminal for the request.
//   retry_same_account— transient blip worth one bounded same-account retry
//                       (408/425/409). Falls through to rotation afterwards.
//   rotate_account    — account-scoped or server-side failure worth trying on
//                       the next account (429 quota, 401/403 OAuth, 404 stale
//                       projectId, 5xx, network).
//   terminal          — recovery itself is not possible (no accounts left,
//                       budget exceeded). Maps to a truthful final error.
export const FAILURE_KIND = Object.freeze({
  ABORT: "abort",
  DETERMINISTIC: "deterministic",
  RETRY_SAME_ACCOUNT: "retry_same_account",
  ROTATE_ACCOUNT: "rotate_account",
  TERMINAL: "terminal",
});

// Providers whose 4xx statuses are commonly ACCOUNT-scoped (multi-account
// OAuth gateways): a 401 can mean "this account's token was revoked" while a
// sibling account is healthy.
export const ACCOUNT_SCOPED_4XX_PROVIDERS = new Set(["antigravity", "gemini-cli"]);

// Compat: keep the historical empty-stream-guard retryable predicate intact
// (tests + chat.js rely on its exact behavior). It only answers "worth trying
// on another account" — not the richer kind classification.
export function isRetryableStatus(status) {
  if (typeof status !== "number" || !Number.isFinite(status)) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500 && status < 600) return status !== 501;
  return false;
}

const RETRYABLE_MESSAGE_HINTS = [
  "econnreset", "etimedout", "epipe", "econnrefused", "enotfound", "eai_again",
  "fetch failed", "network", "socket hang up", "temporary", "capacity",
  "high traffic", "timeout", "timed out", "agent execution terminated",
  "terminated due to error", "stream ended", "stream closed",
  "stream terminated", "und_err_socket", "empty response",
  "resource_exhausted", "quota", "no body", "empty body", "overloaded",
];
const DETERMINISTIC_MESSAGE_HINTS = [
  "bad request", "[400]", "unauthorized", "[401]", "forbidden", "[403]",
  "not found", "[404]", "method not allowed", "not acceptable",
  "payload too large", "uri too long", "schema", "validation",
  "invalid api key", "malformed", "improperly formed", "not allowed",
];

function parseStatusFromMessage(message) {
  if (typeof message !== "string") return null;
  const m = message.match(/^\s*\[(\d{3})\]\s*/);
  return m ? Number(m[1]) : null;
}

function isAbortError(error, signal) {
  if (error?.name === "AbortError") return true;
  if (signal?.aborted) return true;
  return false;
}

/**
 * Classify one upstream failure into recovery semantics.
 *
 * @param {object} options
 * @param {number|null} [options.status]  upstream HTTP status (may be null)
 * @param {Error|null} [options.error]    thrown error object, if any
 * @param {string} [options.message]      error message / upstream error text
 * @param {string} [options.provider]     provider id, enables account-scoped 4xx
 * @param {string} [options.authType]     "oauth" | "apikey" | ... (when known)
 * @param {AbortSignal} [options.signal]  request abort signal
 * @param {boolean} [options.emptyBody]   upstream returned 200 with no body
 * @returns {{kind: string, status: number|null, code: string, reason: string,
 *            retryable: boolean, emptyBody: boolean}}
 */
export function classifyFailure({ status, error, message, provider, authType, signal, emptyBody = false } = {}) {
  const msg = typeof message === "string" ? message : error?.message || "";
  const low = msg.toLowerCase();

  if (isAbortError(error, signal)) {
    return { kind: FAILURE_KIND.ABORT, status: status ?? null, code: "ABORT", reason: "request aborted", retryable: false, emptyBody: false };
  }

  // 200 with no usable body IS the empty-stream problem, not a determinism
  // signal. Callers convert this into the empty-attempt recovery path.
  if (emptyBody || (status === 200 && (low.includes("no body") || low.includes("empty body")))) {
    return { kind: FAILURE_KIND.RETRY_SAME_ACCOUNT, status: status ?? null, code: "EMPTY_BODY", reason: "upstream returned no body", retryable: true, emptyBody: true };
  }

  if (typeof status === "number" && Number.isFinite(status)) {
    return classifyStatus(status, provider, authType, msg);
  }

  // Message-only classification (thrown transport errors etc.)
  const retryable = RETRYABLE_MESSAGE_HINTS.some((h) => low.includes(h));
  const deterministic = DETERMINISTIC_MESSAGE_HINTS.some((h) => low.includes(h));
  if (deterministic && !retryable) {
    return { kind: FAILURE_KIND.DETERMINISTIC, status: null, code: "DETERMINISTIC", reason: msg || "deterministic upstream failure", retryable: false, emptyBody: false };
  }
  // Unknown / network → generous: give the next account a chance.
  return {
    kind: FAILURE_KIND.ROTATE_ACCOUNT,
    status: null,
    code: error?.cause?.code || error?.code || (retryable ? "RETRYABLE" : "UNKNOWN"),
    reason: msg || "unknown upstream failure",
    retryable: true,
    emptyBody: false,
  };
}

function classifyStatus(status, provider, authType, msg) {
  const accountScoped = ACCOUNT_SCOPED_4XX_PROVIDERS.has(provider) || authType === "oauth";
  const base = { status, emptyBody: false };

  if (status === 408 || status === 425) {
    return { ...base, kind: FAILURE_KIND.RETRY_SAME_ACCOUNT, code: "TRANSIENT", reason: `upstream ${status}`, retryable: true };
  }
  if (status === 429) {
    return { ...base, kind: FAILURE_KIND.ROTATE_ACCOUNT, code: "RATE_LIMITED", reason: msg || "rate limited", retryable: true };
  }
  if (status >= 500 && status < 600) {
    if (status === 501) {
      return { ...base, kind: FAILURE_KIND.DETERMINISTIC, code: "NOT_IMPLEMENTED", reason: "upstream 501", retryable: false };
    }
    return { ...base, kind: FAILURE_KIND.ROTATE_ACCOUNT, code: "UPSTREAM_5XX", reason: msg || `upstream ${status}`, retryable: true };
  }
  if (status === 401 || status === 403) {
    // OAuth gateways: expired/revoked token or permission mismatch is
    // account-specific — repair (refresh) happened upstream; bench + rotate.
    if (accountScoped) {
      return { ...base, kind: FAILURE_KIND.ROTATE_ACCOUNT, code: status === 401 ? "AUTH_REVOKED" : "PERMISSION", reason: msg || `upstream ${status}`, retryable: true };
    }
    return { ...base, kind: FAILURE_KIND.DETERMINISTIC, code: status === 401 ? "AUTH" : "FORBIDDEN", reason: `upstream ${status}`, retryable: false };
  }
  if (status === 404) {
    // Multi-account gateways: stale per-account projectId/project binding.
    if (accountScoped) {
      return { ...base, kind: FAILURE_KIND.ROTATE_ACCOUNT, code: "STALE_PROJECT", reason: msg || "upstream 404", retryable: true };
    }
    return { ...base, kind: FAILURE_KIND.DETERMINISTIC, code: "NOT_FOUND", reason: "upstream 404", retryable: false };
  }
  if (status === 409) {
    // Concurrent/transient state (Antigravity can 409 on racing writes).
    return { ...base, kind: FAILURE_KIND.RETRY_SAME_ACCOUNT, code: "CONFLICT", reason: msg || "upstream 409", retryable: true };
  }
  // Everything else 4xx: request-shape deterministic.
  return { ...base, kind: FAILURE_KIND.DETERMINISTIC, code: `HTTP_${status}`, reason: msg || `upstream ${status}`, retryable: false };
}

/**
 * Convenience: classify a thrown error (status may live on err.status or be
 * embedded as "[429] ..." in the message — both used by rotation reexecutes).
 */
export function classifyThrownError(error, { provider, authType, signal } = {}) {
  const status = typeof error?.status === "number" && Number.isFinite(error.status)
    ? error.status
    : parseStatusFromMessage(error?.message);
  return classifyFailure({ status, error, message: error?.message, provider, authType, signal });
}