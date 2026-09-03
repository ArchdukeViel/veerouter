// Tests for the empty-stream guard's retry-fetch-exception classification (Bug 2).
//
// Background: when the rotated reexecute() throws (HTTP 5xx, network reset, etc.)
// the guard used to exhaust immediately, bypassing account recovery. The fix
// classifies each error: retryable → onAccountExhausted; deterministic → exhaust.
import { describe, it, expect, vi } from "vitest";
import { createEmptyRetryStream } from "../../open-sse/handlers/chatCore/emptyStreamGuard.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const wrap = (response) => ({ response });
const text = (t) => wrap({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const finish = (finishReason) => wrap({ candidates: [{ finishReason }] });
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

const dataEvents = (out) => out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim()));

describe("empty-stream guard: reexecute exception classification", () => {
  it("first attempt empty → reexecute throws 503 → rotates to B", async () => {
    const bareStop = () => wrap({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] });

    const benched = [];
    const onAccountExhausted = vi.fn(async ({ currentConnectionId }) => {
      benched.push(currentConnectionId);
      return {
        connectionId: "acc-B",
        reexecute: async () => sseBody([text("B recovered"), finish("STOP")]),
      };
    });

    let reexecuteCalls = 0;
    const reexecute = async () => {
      reexecuteCalls++;
      // First call (in-stream retry on A): throw 503
      const err = new Error("[503] upstream 503");
      err.status = 503;
      throw err;
    };

    const stream = createEmptyRetryStream({
      body: sseBody([bareStop()]),
      reexecute,
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      onAccountExhausted,
    });

    const out = await drain(stream);
    expect(benched).toEqual(["acc-A"]);
    expect(out).toContain("B recovered");
    expect(reexecuteCalls).toBeGreaterThanOrEqual(1);
  });

  it("first attempt empty → reexecute throws 400 (deterministic) → exhaust (no rotate)", async () => {
    const bareStop = () => wrap({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] });

    const benched = [];
    const onAccountExhausted = vi.fn(async ({ currentConnectionId }) => {
      benched.push(currentConnectionId);
      return {
        connectionId: "acc-B",
        reexecute: async () => sseBody([text("B"), finish("STOP")]),
      };
    });

    let reexecuteCalls = 0;
    const reexecute = async () => {
      reexecuteCalls++;
      const err = new Error("[400] Bad Request: schema invalid");
      err.status = 400;
      throw err;
    };

    const stream = createEmptyRetryStream({
      body: sseBody([bareStop()]),
      reexecute,
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      onAccountExhausted,
    });

    const out = await drain(stream);
    expect(benched).toEqual([]); // 400 must NOT rotate
    expect(onAccountExhausted).not.toHaveBeenCalled();
    expect(reexecuteCalls).toBe(1); // only the in-stream retry on A was attempted
    expect(dataEvents(out)).toHaveLength(1);
    expect(dataEvents(out)[0].error.message).toContain("400");
  });

  it("first attempt empty → reexecute throws ECONNRESET → rotates", async () => {
    const bareStop = () => wrap({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] });

    const benched = [];
    const onAccountExhausted = vi.fn(async ({ currentConnectionId }) => {
      benched.push(currentConnectionId);
      return {
        connectionId: "acc-B",
        reexecute: async () => sseBody([text("B"), finish("STOP")]),
      };
    });

    const reexecute = async () => {
      const err = new Error("fetch failed: ECONNRESET");
      throw err;
    };

    const stream = createEmptyRetryStream({
      body: sseBody([bareStop()]),
      reexecute,
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      onAccountExhausted,
    });

    const out = await drain(stream);
    expect(benched).toEqual(["acc-A"]);
    expect(out).toContain("B");
  });

  it("first attempt empty → reexecute throws 401 (deterministic) → exhaust (no rotate)", async () => {
    const bareStop = () => wrap({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] });

    const onAccountExhausted = vi.fn();
    const reexecute = async () => {
      const err = new Error("[401] Unauthorized: invalid api key");
      err.status = 401;
      throw err;
    };

    const stream = createEmptyRetryStream({
      body: sseBody([bareStop()]),
      reexecute,
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      onAccountExhausted,
    });

    const out = await drain(stream);
    expect(onAccountExhausted).not.toHaveBeenCalled();
    expect(dataEvents(out)).toHaveLength(1);
  });

  it("abort during retry fetch is honored (no rotation)", async () => {
    const ac = new AbortController();
    const onAccountExhausted = vi.fn();

    const reexecute = async () => {
      ac.abort();
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };

    const bareStop = () => wrap({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] });
    const stream = createEmptyRetryStream({
      body: sseBody([bareStop()]),
      reexecute,
      signal: ac.signal,
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      onAccountExhausted,
    });

    await expect(drain(stream)).rejects.toMatchObject({ name: "AbortError" });
    expect(onAccountExhausted).not.toHaveBeenCalled();
  });
});
