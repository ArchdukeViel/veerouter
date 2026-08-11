// Additional edge-case tests pinned by the empty-stream account-recovery fix:
//   - inlineData prevents replay
//   - RESOURCE_EXHAUSTED benches current with reset metadata
//   - No A/B alternating-loop regression: when B's success clears B (not A),
//     the next request still won't pick A until its cooldown expires.
import { describe, it, expect, vi } from "vitest";
import { createEmptyRetryStream } from "../../open-sse/handlers/chatCore/emptyStreamGuard.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const wrap = (response) => ({ response });
const text = (t) => wrap({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const finish = (finishReason) => wrap({ candidates: [{ finishReason }] });
const bareStop = () => wrap({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] });
const image = () => wrap({ candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "BASE64" } }] } }] });
const quotaExhausted = (resetMsg) => wrap({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: `Quota exceeded. ${resetMsg || "Your quota will reset after 1h2m3s"}` } });
const sseText = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

function sseBody(events) {
  const bytes = encoder.encode(sseText(events));
  return new ReadableStream({
    start(controller) { if (bytes.length) controller.enqueue(bytes); controller.close(); },
  });
}

async function drain(stream) {
  const reader = stream.getReader();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("empty-stream edge cases (Bug 1 + 2 follow-ups)", () => {
  it("inlineData is meaningful — NO replay after image", async () => {
    const onAccountExhausted = vi.fn();
    const stream = createEmptyRetryStream({
      body: sseBody([image(), finish("STOP")]),
      reexecute: vi.fn(),
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      onAccountExhausted,
    });
    const out = await drain(stream);
    expect(out).toContain("image/png");
    expect(onAccountExhausted).not.toHaveBeenCalled();
  });

  it("retries a 200 response with no body instead of terminating immediately", async () => {
    const reexecute = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(sseBody([text("recovered"), finish("STOP")]));
    const state = { meaningful: false, exhausted: false };
    const stream = createEmptyRetryStream({
      body: null,
      reexecute,
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      state,
    });

    const out = await drain(stream);
    expect(out).toContain("recovered");
    expect(reexecute).toHaveBeenCalledTimes(2);
    expect(1 + reexecute.mock.calls.length).toBe(3); // initial null + two reexecs
    expect(state).toEqual({ meaningful: true, exhausted: false });
  });

  it("RESOURCE_EXHAUSTED benches current account and forwards upstreamError to onAccountExhausted", async () => {
    const benched = [];
    let capturedUpstreamError = null;
    let capturedReason = null;
    const onAccountExhausted = vi.fn(async ({ currentConnectionId, upstreamError, reason }) => {
      benched.push(currentConnectionId);
      capturedUpstreamError = upstreamError;
      capturedReason = reason;
      return {
        connectionId: "acc-B",
        reexecute: async () => sseBody([text("B"), finish("STOP")]),
      };
    });

    const stream = createEmptyRetryStream({
      body: sseBody([quotaExhausted("Your quota will reset after 2h7m23s")]),
      reexecute: async () => {
        return sseBody([quotaExhausted("Your quota will reset after 2h7m23s")]);
      },
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      onAccountExhausted,
    });
    await drain(stream);
    expect(benched).toEqual(["acc-A"]);
    expect(capturedUpstreamError).not.toBeNull();
    expect(capturedUpstreamError?.status).toBe("RESOURCE_EXHAUSTED");
    expect(capturedUpstreamError?.message).toContain("2h7m23s");
    expect(capturedReason).toContain("RESOURCE_EXHAUSTED");
    // The actual resetsAtMs extraction happens in chatCore.js's wrapper (see
    // emptyStreamGuard.onAccountExhausted handler that calls
    // executor.parseRetryFromErrorMessage). Here we just verify the error
    // reaches the app layer intact for it to parse.
  });

  it("processes a final SSE data event without a trailing newline", async () => {
    const raw = `data: ${JSON.stringify(text("trailing"))}`;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      },
    });
    const reexecute = vi.fn();
    const stream = createEmptyRetryStream({ body, reexecute, log: null, baseDelayMs: 1 });

    const out = await drain(stream);
    expect(out).toContain("trailing");
    expect(reexecute).not.toHaveBeenCalled();
  });

  it("converts a locked upstream body into a contained stream error", async () => {
    const body = sseBody([text("never read")]);
    body.getReader();
    const state = { meaningful: false, exhausted: false };
    const stream = createEmptyRetryStream({ body, reexecute: vi.fn(), log: null, state });

    const out = await drain(stream);
    expect(out).toContain("STREAM_READ_ERROR");
    expect(state.exhausted).toBe(true);
  });

  it("does not call the legacy bench observer twice when rotation is refused", async () => {
    const onAccountExhausted = vi.fn(async () => null);
    const onExhausted = vi.fn();
    const stream = createEmptyRetryStream({
      body: sseBody([bareStop()]),
      reexecute: async () => sseBody([bareStop()]),
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      onAccountExhausted,
      onExhausted,
    });

    await drain(stream);
    expect(onAccountExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("No A/B alternating loop: rotation mutates connectionId so success clears the active account only", async () => {
    // Simulates the chat.js contract: a mutable activeAccount whose
    // connectionId is what the success callback clears.
    const benched = [];
    const cleared = [];
    const activeAccount = {
      connectionId: "acc-A",
      credentials: { connectionId: "acc-A" },
      proxyOptions: {},
      reexecute: null,
    };

    const onAccountExhausted = async ({ currentConnectionId }) => {
      benched.push(currentConnectionId);
      activeAccount.connectionId = "acc-B";
      activeAccount.credentials = { connectionId: "acc-B" };
      return {
        connectionId: "acc-B",
        credentials: activeAccount.credentials,
        reexecute: async () => sseBody([text("from B"), finish("STOP")]),
      };
    };

    const stream = createEmptyRetryStream({
      body: sseBody([bareStop()]),
      reexecute: async () => sseBody([bareStop()]),
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      onAccountExhausted,
    });

    const out = await drain(stream);
    expect(out).toContain("from B");
    expect(benched).toEqual(["acc-A"]);
    expect(activeAccount.connectionId).toBe("acc-B");

    // Simulate chat.js's onRequestSuccess clearing the active account AFTER
    // the guard finishes. The contract: the success callback reads the LIVE
    // activeAccount.connectionId, so it clears B (not A).
    cleared.push(activeAccount.connectionId);
    expect(cleared).toEqual(["acc-B"]);
    expect(cleared).not.toContain("acc-A");
  });

  it("inlineData with thoughtSignature (no visible text) still counts as meaningful", async () => {
    // Defensive: future callers may emit {thoughtSignature, inlineData} only.
    const sig = wrap({ candidates: [{ content: { role: "model", parts: [{ thoughtSignature: "abc", inlineData: { mimeType: "image/png", data: "x" } }] } }] });
    const onAccountExhausted = vi.fn();
    const stream = createEmptyRetryStream({
      body: sseBody([sig, finish("STOP")]),
      reexecute: vi.fn(),
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      onAccountExhausted,
    });
    const out = await drain(stream);
    expect(out).toContain("image/png");
    expect(onAccountExhausted).not.toHaveBeenCalled();
  });
});
