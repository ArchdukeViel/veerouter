import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  classifyThrownError,
  FAILURE_KIND,
  isRetryableStatus,
} from "../../open-sse/utils/failureClassifier.js";

describe("central upstream failure classifier", () => {
  it.each([
    [400, "openai", FAILURE_KIND.DETERMINISTIC],
    [401, "openai", FAILURE_KIND.DETERMINISTIC],
    [401, "antigravity", FAILURE_KIND.ROTATE_ACCOUNT],
    [403, "antigravity", FAILURE_KIND.ROTATE_ACCOUNT],
    [404, "antigravity", FAILURE_KIND.ROTATE_ACCOUNT],
    [404, "openai", FAILURE_KIND.DETERMINISTIC],
    [408, "openai", FAILURE_KIND.RETRY_SAME_ACCOUNT],
    [409, "antigravity", FAILURE_KIND.RETRY_SAME_ACCOUNT],
    [429, "antigravity", FAILURE_KIND.ROTATE_ACCOUNT],
    [500, "antigravity", FAILURE_KIND.ROTATE_ACCOUNT],
    [501, "antigravity", FAILURE_KIND.DETERMINISTIC],
  ])("classifies HTTP %s from %s as %s", (status, provider, kind) => {
    const result = classifyFailure({ status, provider });
    expect(result.kind).toBe(kind);
    expect(result.status).toBe(status);
    expect(result.retryable).toBe(kind !== FAILURE_KIND.DETERMINISTIC);
  });

  it("treats OAuth authorization failures as account-scoped", () => {
    expect(classifyFailure({ status: 401, provider: "custom", authType: "oauth" }).kind)
      .toBe(FAILURE_KIND.ROTATE_ACCOUNT);
  });

  it("classifies a 200 response with no body as same-account empty recovery", () => {
    expect(classifyFailure({ status: 200, emptyBody: true })).toMatchObject({
      kind: FAILURE_KIND.RETRY_SAME_ACCOUNT,
      code: "EMPTY_BODY",
      emptyBody: true,
      retryable: true,
    });
  });

  it("classifies transport errors and preserves abort semantics", () => {
    const network = new Error("fetch failed");
    network.cause = { code: "ECONNRESET" };
    expect(classifyThrownError(network).kind).toBe(FAILURE_KIND.ROTATE_ACCOUNT);

    const abort = Object.assign(new Error("client disconnected"), { name: "AbortError" });
    expect(classifyThrownError(abort).kind).toBe(FAILURE_KIND.ABORT);
    expect(classifyThrownError(abort).retryable).toBe(false);
  });

  it("parses status prefixes used by rotated reexecute", () => {
    expect(classifyThrownError(new Error("[429] quota exceeded"), { provider: "antigravity" })).toMatchObject({
      kind: FAILURE_KIND.ROTATE_ACCOUNT,
      status: 429,
      code: "RATE_LIMITED",
    });
  });

  it("keeps the legacy status predicate behavior", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(501)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(undefined)).toBe(true);
  });
});
