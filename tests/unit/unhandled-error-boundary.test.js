import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRequestId,
  internalErrorResponse,
  logUnhandledRequestError,
  redactErrorText,
} from "../../src/sse/utils/unhandledError.js";

afterEach(() => vi.restoreAllMocks());

describe("router unhandled-error boundary", () => {
  it("redacts credentials and query secrets without exposing request content", () => {
    const value = redactErrorText(
      "Bearer bearer-secret access_token=access-secret https://user:pass@example.test/path?token=query-secret"
    );
    expect(value).not.toContain("bearer-secret");
    expect(value).not.toContain("access-secret");
    expect(value).not.toContain("user");
    expect(value).not.toContain("pass");
    expect(value).not.toContain("query-secret");
    expect(value).toContain("[REDACTED]");
  });

  it("logs a request id and safe error metadata only", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logUnhandledRequestError({
      requestId: "req-test-1",
      phase: "route",
      provider: "antigravity",
      model: "gemini-test",
      connectionId: "connection-secret-123",
      error: Object.assign(new Error("Bearer bearer-secret access_token=access-secret"), {
        code: "ECONNRESET",
        cause: { code: "UND_ERR_SOCKET" },
      }),
    });

    const line = errorSpy.mock.calls[0][0];
    expect(line).toContain('"requestId":"req-test-1"');
    expect(line).toContain('"causeCode":"UND_ERR_SOCKET"');
    expect(line).toContain("connecti");
    expect(line).not.toContain("bearer-secret");
    expect(line).not.toContain("access-secret");
    expect(line).not.toContain("connection-secret-123");
  });

  it("returns a structured internal error with the correlation id", async () => {
    const response = internalErrorResponse("req-test-2");
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.error.message).toBe("Internal router error (request_id=req-test-2)");
  });

  it("accepts a safe client correlation id and replaces unsafe ids", () => {
    const request = new Request("https://router.test/v1/chat/completions", {
      headers: { "x-request-id": "safe.req-1" },
    });
    expect(getRequestId(request)).toBe("safe.req-1");
    expect(getRequestId(request, "unsafe id")).toBe("safe.req-1");
    expect(getRequestId(new Request("https://router.test"), "unsafe id")).not.toBe("unsafe id");
  });
});
