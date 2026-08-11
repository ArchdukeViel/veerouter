// Unit tests for the retryable-status / retryable-error classifier.
//
// The fix routes retryable failures through account rotation and exhausts
// deterministic ones immediately. These tests pin the exact boundaries used
// by the empty-stream guard so future changes don't silently regress.
import { describe, it, expect } from "vitest";
import { isRetryableStatus } from "../../open-sse/handlers/chatCore/emptyStreamGuard.js";

describe("isRetryableStatus (emptyStreamGuard)", () => {
  it("retries 408, 425, 429", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(425)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
  });

  it("retries 5xx except 501", () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(504)).toBe(true);
    expect(isRetryableStatus(507)).toBe(true);
    expect(isRetryableStatus(522)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
    expect(isRetryableStatus(501)).toBe(false);
  });

  it("does NOT retry deterministic 4xx", () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(405)).toBe(false);
    expect(isRetryableStatus(409)).toBe(false);
    expect(isRetryableStatus(410)).toBe(false);
    expect(isRetryableStatus(413)).toBe(false);
    expect(isRetryableStatus(422)).toBe(false);
  });

  it("treats unknown / null / undefined as retryable (be lenient)", () => {
    expect(isRetryableStatus(null)).toBe(true);
    expect(isRetryableStatus(undefined)).toBe(true);
    expect(isRetryableStatus(NaN)).toBe(true);
    expect(isRetryableStatus("foo")).toBe(true);
  });
});
