import { errorResponse } from "open-sse/utils/error.js";

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,96}$/;

export function getRequestId(request, candidate = null) {
  const headerId = request?.headers?.get?.("x-request-id");
  const value = headerId || candidate;
  if (REQUEST_ID_RE.test(String(value || ""))) return String(value);
  return globalThis.crypto?.randomUUID?.() || `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function maskConnectionId(connectionId) {
  const value = String(connectionId || "");
  return value ? `${value.slice(0, 8)}…` : "-";
}

export function redactErrorText(value) {
  return String(value || "")
    .replace(/Bearer\s+[^\s,]+/gi, "Bearer [REDACTED]")
    .replace(/(access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|password|secret)\s*[:=]\s*("[^"]*"|'[^']*'|[^,\s}]+)/gi, "$1=[REDACTED]")
    .replace(/([?&](?:token|key|secret|password|access_token|refresh_token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^/\s:@]+:[^@\s]+@/gi, "https://[REDACTED]@");
}

export function logUnhandledRequestError({ requestId, error, phase = "route", provider = null, model = null, connectionId = null } = {}) {
  const cause = error?.cause;
  const meta = {
    requestId,
    source: "router",
    phase,
    provider: provider || undefined,
    model: model || undefined,
    connectionId: maskConnectionId(connectionId),
    error: {
      name: error?.name || "Error",
      message: redactErrorText(error?.message || error),
      code: error?.code || null,
      status: Number.isFinite(error?.status) ? error.status : null,
      causeCode: cause?.code || null,
    },
    stack: redactErrorText(error?.stack || ""),
  };
  console.error(`[9router][uncaught] ${JSON.stringify(meta)}`);
  return meta;
}

export function internalErrorResponse(requestId) {
  return errorResponse(500, `Internal router error (request_id=${requestId})`);
}

export function handleUnhandledRequestError(options = {}) {
  logUnhandledRequestError(options);
  return internalErrorResponse(options.requestId);
}
