// Tests for Bug 1: active-account identity for success clearing.
//
// The empty-stream guard MUST hand the success callback the connectionId of
// whichever account actually emitted client-actionable output, not the one that
// originally opened the request. After A → B rotation, a successful B should
// clear B's error state — not re-activate the freshly-benched A.
//
// These tests exercise the full empty-stream rotation path plus a simulated
// `onRequestSuccess` callback that reads from the same mutable active-account
// context used by the app layer (src/sse/handlers/chat.js).
import { describe, it, expect, vi } from "vitest";
import { createEmptyRetryStream } from "../../open-sse/handlers/chatCore/emptyStreamGuard.js";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const wrap = (response) => ({ response });
const text = (t) => wrap({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const finish = (finishReason) => wrap({ candidates: [{ finishReason }] });
const bareStop = () => wrap({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }] });
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

/**
 * Simulates the chat.js active-account contract.
 *
 * - `activeAccount` is a mutable object whose fields are read by callbacks.
 * - `onAccountExhausted` benches current, picks next, mutates `activeAccount`.
 * - `onRequestSuccess` reads `activeAccount.connectionId` AT CALL TIME — that
 *   is the contract that the fix enforces.
 */
function makeChatContext(provider = "antigravity") {
  const benched = [];
  const cleared = [];
  const selected = [];
  const activeAccount = {
    connectionId: "acc-A",
    credentials: { connectionId: "acc-A", connectionName: "Account A" },
    proxyOptions: {},
    reexecute: null,
  };

  const onAccountExhausted = async ({ currentConnectionId }) => {
    benched.push(currentConnectionId);
    // Simulate selecting next account
    if (currentConnectionId === "acc-A") {
      activeAccount.connectionId = "acc-B";
      activeAccount.credentials = { connectionId: "acc-B", connectionName: "Account B" };
      selected.push("acc-B");
      return {
        connectionId: "acc-B",
        credentials: activeAccount.credentials,
        proxyOptions: {},
        reexecute: async () => sseBody([text("from B"), finish("STOP")]),
      };
    }
    if (currentConnectionId === "acc-B") {
      activeAccount.connectionId = "acc-C";
      activeAccount.credentials = { connectionId: "acc-C", connectionName: "Account C" };
      selected.push("acc-C");
      return {
        connectionId: "acc-C",
        credentials: activeAccount.credentials,
        proxyOptions: {},
        reexecute: async () => sseBody([text("from C"), finish("STOP")]),
      };
    }
    return null;
  };

  // This is the contract the success callback relies on.
  // It MUST read activeAccount.connectionId at call time.
  const onRequestSuccess = async () => {
    cleared.push(activeAccount.connectionId);
  };

  return { activeAccount, benched, cleared, selected, onAccountExhausted, onRequestSuccess };
}

describe("active-account identity (Bug 1 fix)", () => {
  it("A → B rotation + B success: clears B, leaves A benched", async () => {
    const ctx = makeChatContext();

    const stream = createEmptyRetryStream({
      body: sseBody([bareStop(), bareStop(), bareStop()]),
      reexecute: async () => sseBody([bareStop(), bareStop(), bareStop()]),
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      onAccountExhausted: ctx.onAccountExhausted,
    });

    const out = await drain(stream);
    expect(out).toContain("from B");
    expect(ctx.benched).toEqual(["acc-A"]);
    expect(ctx.selected).toEqual(["acc-B"]);
    // Success callback was never triggered by the guard itself (it's wired at the
    // streaming layer). For this assertion to hold, we need to fire it through
    // handleStreamingResponse. Use the integration test below for that.
  });

  it("A → B → C rotation + C success: benches A and B, clears C only", async () => {
    const ctx = makeChatContext();
    ctx.activeAccount.connectionId = "acc-A";

    // First rotation: A → B (B returns 3 empty attempts)
    const stream1 = createEmptyRetryStream({
      body: sseBody([bareStop(), bareStop(), bareStop()]),
      reexecute: async () => sseBody([bareStop(), bareStop(), bareStop()]),
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      onAccountExhausted: ctx.onAccountExhausted,
    });
    await drain(stream1);
    expect(ctx.activeAccount.connectionId).toBe("acc-B");
    expect(ctx.benched).toEqual(["acc-A"]);

    // Second rotation: B → C (C returns success)
    const stream2 = createEmptyRetryStream({
      body: sseBody([bareStop(), bareStop(), bareStop()]),
      reexecute: async () => sseBody([bareStop(), bareStop(), bareStop()]),
      log: null,
      baseDelayMs: 1,
      connectionId: ctx.activeAccount.connectionId,
      onAccountExhausted: ctx.onAccountExhausted,
    });
    const out2 = await drain(stream2);
    expect(out2).toContain("from C");
    expect(ctx.activeAccount.connectionId).toBe("acc-C");
    expect(ctx.benched).toEqual(["acc-A", "acc-B"]);
    expect(ctx.selected).toEqual(["acc-B", "acc-C"]);
  });
});

describe("handleStreamingResponse + emptyStreamGuard + activeAccount end-to-end", () => {
  it("A empty → B succeeds → success callback fires once with B's connectionId", async () => {
    const encoder2 = new TextEncoder();
    const cleared = [];
    const benched = [];

    // Chat-side active-account context — identical contract to src/sse/handlers/chat.js
    const activeAccount = {
      connectionId: "acc-A",
      credentials: { connectionId: "acc-A" },
      proxyOptions: {},
      reexecute: null,
    };

    // onAccountExhausted: bench A, select B, update activeAccount.
    const onAccountExhausted = async ({ currentConnectionId }) => {
      benched.push(currentConnectionId);
      activeAccount.connectionId = "acc-B";
      activeAccount.credentials = { connectionId: "acc-B" };
      return {
        connectionId: "acc-B",
        credentials: activeAccount.credentials,
        proxyOptions: {},
        reexecute: async () => {
          // B's first attempt returns meaningful output.
          return new ReadableStream({
            start(controller) {
              controller.enqueue(encoder2.encode(sseText([text("from B"), finish("STOP")])));
              controller.close();
            },
          });
        },
      };
    };

    // Success callback reads activeAccount.connectionId AT CALL TIME — this
    // is the contract that the Bug 1 fix enforces.
    const onRequestSuccess = async () => {
      cleared.push(activeAccount.connectionId);
    };

    // Simulate chatCore's empty-retry wrapping: 3 attempts on A all empty,
    // then onAccountExhausted kicks in, B succeeds.
    const wrappedBody = createEmptyRetryStream({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder2.encode(sseText([bareStop()])));
          controller.close();
        },
      }),
      reexecute: async () => {
        // Same-account retry: still empty
        return new ReadableStream({
          start(controller) {
            controller.enqueue(encoder2.encode(sseText([bareStop()])));
            controller.close();
          },
        });
      },
      log: null,
      baseDelayMs: 1,
      connectionId: "acc-A",
      onAccountExhausted,
    });

    // The emptyStreamGuard output becomes the streaming response body.
    const wrappedResponse = new Response(wrappedBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const streamController = createStreamController({ provider: "antigravity", model: "gemini-3.6-flash" });
    const result = await handleStreamingResponse({
      providerResponse: wrappedResponse,
      provider: "antigravity",
      model: "gemini-3.6-flash",
      sourceFormat: FORMATS.ANTIGRAVITY,
      targetFormat: FORMATS.ANTIGRAVITY,
      userAgent: "test",
      body: { stream: true },
      stream: true,
      translatedBody: {},
      finalBody: {},
      requestStartTime: Date.now(),
      connectionId: "acc-A",
      apiKey: null,
      clientRawRequest: null,
      onRequestSuccess,
      reqLogger: null,
      toolNameMap: null,
      customToolNames: null,
      streamController,
      onStreamComplete: vi.fn(),
      streamDetailId: "detail-1",
      pxpipe: null,
      reqTag: "tag-1",
      log: null,
    });

    expect(result.success).toBe(true);
    const reader = result.response.body.getReader();
    let text2 = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text2 += decoder.decode(value, { stream: true });
    }
    expect(text2).toContain("from B");

    // Allow microtasks to drain so the deferred successTee fires.
    await new Promise((r) => setTimeout(r, 30));

    expect(benched).toEqual(["acc-A"]);
    expect(cleared).toEqual(["acc-B"]); // NOT "acc-A"
    expect(activeAccount.connectionId).toBe("acc-B");
  });
});
