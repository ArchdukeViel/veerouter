// Unit & Integration tests for Antigravity empty-stream account recovery and streaming handler.
import { describe, it, expect, vi } from "vitest";
import { createEmptyRetryStream } from "../../open-sse/handlers/chatCore/emptyStreamGuard.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const wrap = (response) => ({ response });
const bareStop = () => wrap({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] });
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

function buildWrapper({ attempts, onAccountExhausted, onExhausted, connectionId = "acc-A", baseDelayMs = 1 }) {
  let attemptsFired = 0;
  let reexecuteCallCount = 0;
  const calls = { reexecute: [], exhausted: [] };

  const reexecute = async () => {
    reexecuteCallCount++;
    calls.reexecute.push(reexecuteCallCount);
    attemptsFired++;
    const next = attempts[attemptsFired];
    if (!next) throw new Error(`scripted attempts exhausted at attempt ${attemptsFired}`);
    return sseBody(next);
  };

  const wrapper = async () => {
    const stream = createEmptyRetryStream({
      body: sseBody(attempts[0]),
      reexecute,
      signal: undefined,
      log: null,
      baseDelayMs,
      connectionId,
      onExhausted,
      onAccountExhausted: onAccountExhausted ? async (info) => {
        calls.exhausted.push(info);
        return onAccountExhausted(info);
      } : undefined,
    });
    return drain(stream);
  };

  return { run: wrapper, calls };
}

describe("empty-stream guard: corrected server-side account rotation state machine", () => {
  it("Account A empty → retry succeeds on A → no rotation", async () => {
    const attempt2 = [text("Hello from A"), finish("STOP")];
    const onAccountExhausted = vi.fn();
    const { run } = buildWrapper({
      attempts: [[bareStop()], attempt2],
      onAccountExhausted,
    });
    const out = await run();
    expect(out).toBe(sseText(attempt2));
    expect(onAccountExhausted).not.toHaveBeenCalled();
  });

  it("Account A exhausts → A benched FIRST → Account B selected and succeeds", async () => {
    const benched = [];
    const selected = [];

    const onAccountExhausted = vi.fn(async ({ currentConnectionId }) => {
      benched.push(currentConnectionId);
      const nextId = "acc-B";
      selected.push(nextId);
      return {
        connectionId: nextId,
        reexecute: async () => sseBody([text("from B"), finish("STOP")]),
      };
    });

    const { run } = buildWrapper({
      attempts: [[bareStop()], [bareStop()], [bareStop()]],
      connectionId: "acc-A",
      onAccountExhausted,
    });

    const out = await run();
    expect(out).toContain("from B");
    expect(benched).toEqual(["acc-A"]);
    expect(selected).toEqual(["acc-B"]);
  });

  it("Account A RESOURCE_EXHAUSTED → A benched → B succeeds", async () => {
    const benched = [];
    const quota = wrap({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } });

    const onAccountExhausted = vi.fn(async ({ currentConnectionId }) => {
      benched.push(currentConnectionId);
      return {
        connectionId: "acc-B",
        reexecute: async () => sseBody([text("B-OK"), finish("STOP")]),
      };
    });

    const { run } = buildWrapper({
      attempts: [[quota], [quota], [quota]],
      connectionId: "acc-A",
      onAccountExhausted,
    });

    const out = await run();
    expect(out).toContain("B-OK");
    expect(benched).toEqual(["acc-A"]);
  });

  it("Multi-hop rotation: A exhausts → A benched → B exhausts → B benched → C succeeds", async () => {
    const benched = [];
    const selected = [];

    const onAccountExhausted = vi.fn(async ({ currentConnectionId }) => {
      benched.push(currentConnectionId);
      if (currentConnectionId === "acc-A") {
        selected.push("acc-B");
        return {
          connectionId: "acc-B",
          // Account B also returns 3 empty attempts
          reexecute: async () => sseBody([bareStop(), bareStop(), bareStop()]),
        };
      } else if (currentConnectionId === "acc-B") {
        selected.push("acc-C");
        return {
          connectionId: "acc-C",
          reexecute: async () => sseBody([text("C-OK"), finish("STOP")]),
        };
      }
      return null;
    });

    const { run } = buildWrapper({
      attempts: [[bareStop()], [bareStop()], [bareStop()]],
      connectionId: "acc-A",
      onAccountExhausted,
    });

    const out = await run();
    expect(out).toContain("C-OK");
    expect(benched).toEqual(["acc-A", "acc-B"]);
    expect(selected).toEqual(["acc-B", "acc-C"]);
  });

  it.each([408, 409])("HTTP %s consumes same-account retry budget before rotation", async (status) => {
    const reexecute = vi.fn(async () => {
      const error = new Error(`[${status}] transient upstream failure`);
      error.status = status;
      throw error;
    });
    const onAccountExhausted = vi.fn(async () => ({
      connectionId: "acc-B",
      reexecute: async () => sseBody([text("B recovered"), finish("STOP")]),
    }));

    const stream = createEmptyRetryStream({
      body: sseBody([bareStop()]),
      reexecute,
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      onAccountExhausted,
    });

    const out = await drain(stream);
    expect(out).toContain("B recovered");
    expect(reexecute).toHaveBeenCalledTimes(2);
    expect(onAccountExhausted).toHaveBeenCalledWith(expect.objectContaining({ currentConnectionId: "acc-A" }));
  });

  it("All accounts exhaust → final error event emitted to client", async () => {
    const benched = [];
    const onAccountExhausted = vi.fn(async ({ currentConnectionId }) => {
      benched.push(currentConnectionId);
      return null; // no more accounts available
    });

    const { run } = buildWrapper({
      attempts: [[bareStop()], [bareStop()], [bareStop()]],
      connectionId: "acc-A",
      onAccountExhausted,
    });

    const out = await run();
    const events = dataEvents(out);
    expect(events).toHaveLength(1);
    expect(events[0].error.status).toBe("EMPTY_RESPONSE");
    expect(benched).toEqual(["acc-A"]);
  });

  it("Only one account → bounded retries then benched and error", async () => {
    const benched = [];
    const onAccountExhausted = vi.fn(async ({ currentConnectionId }) => {
      benched.push(currentConnectionId);
      return null;
    });

    const { run, calls } = buildWrapper({
      attempts: [[bareStop()], [bareStop()], [bareStop()]],
      connectionId: "acc-A",
      onAccountExhausted,
    });

    const out = await run();
    expect(dataEvents(out)).toHaveLength(1);
    expect(benched).toEqual(["acc-A"]);
    expect(calls.reexecute.length).toBe(2);
  });

  it("visible text then truncation → NO rotation (safety: never replay meaningful output)", async () => {
    const onAccountExhausted = vi.fn();
    const { run } = buildWrapper({
      attempts: [[text("partial answer")]],
      onAccountExhausted,
    });
    const out = await run();
    expect(out).toContain("partial answer");
    expect(onAccountExhausted).not.toHaveBeenCalled();
  });

  it("functionCall then truncation → NO rotation (never duplicate a tool call)", async () => {
    const fc = wrap({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call_x", name: "read", args: {} } }] }, finishReason: "STOP", index: 0 }] });
    const onAccountExhausted = vi.fn();
    const { run } = buildWrapper({
      attempts: [[fc]],
      onAccountExhausted,
    });
    const out = await run();
    expect(out).toContain("call_x");
    expect(onAccountExhausted).not.toHaveBeenCalled();
  });

  it("client abort → all work stops, no rotation", async () => {
    const ac = new AbortController();
    let ctrl;
    const body = new ReadableStream({ start(c) { ctrl = c; } });
    ac.signal.addEventListener("abort", () => {
      ctrl.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
    const onAccountExhausted = vi.fn();
    const stream = createEmptyRetryStream({
      body,
      reexecute: vi.fn(),
      signal: ac.signal,
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      onAccountExhausted,
    });
    const drained = drain(stream);
    setTimeout(() => ac.abort(), 10);
    await expect(drained).rejects.toMatchObject({ name: "AbortError" });
    expect(onAccountExhausted).not.toHaveBeenCalled();
  });

  it("refuses an A to B to A selector loop and emits one terminal error", async () => {
    const selected = [];
    const onAccountExhausted = vi.fn(async ({ currentConnectionId }) => {
      selected.push(currentConnectionId);
      const nextId = currentConnectionId === "acc-A" ? "acc-B" : "acc-A";
      return {
        connectionId: nextId,
        reexecute: async () => sseBody([bareStop()]),
      };
    });

    const { run } = buildWrapper({
      attempts: [[bareStop()], [bareStop()], [bareStop()]],
      connectionId: "acc-A",
      onAccountExhausted,
    });

    const out = await run();
    expect(dataEvents(out)[0].error.status).toBe("EMPTY_RESPONSE");
    expect(selected).toEqual(["acc-A", "acc-B"]);
  });
});
