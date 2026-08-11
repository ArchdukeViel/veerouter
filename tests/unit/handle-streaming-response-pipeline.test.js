import { describe, it, expect, vi } from "vitest";
import { handleStreamingResponse, validateSseContentType } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Corrected handleStreamingResponse pipeline", () => {
  it("pipes stream safely and fires onRequestSuccess on first chunk", async () => {
    const encoder = new TextEncoder();
    const providerResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"hello world"}]}}]}\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

    const streamController = createStreamController({ provider: "antigravity", model: "gemini-3.6-flash" });
    const onRequestSuccess = vi.fn();

    const result = await handleStreamingResponse({
      providerResponse,
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
      connectionId: "conn-1",
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
    let text = "";
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain("hello world");
    await new Promise((r) => setTimeout(r, 20));
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onRequestSuccess when stream produces zero bytes", async () => {
    const providerResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

    const streamController = createStreamController({ provider: "antigravity", model: "gemini-3.6-flash" });
    const onRequestSuccess = vi.fn();

    const result = await handleStreamingResponse({
      providerResponse,
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
      connectionId: "conn-1",
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
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("does NOT clear a guarded account on thought-only bytes", async () => {
    const encoder = new TextEncoder();
    const providerResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"thinking","thought":true}]}}]}\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

    const streamController = createStreamController({ provider: "antigravity", model: "gemini-3.6-flash" });
    const onRequestSuccess = vi.fn();
    const result = await handleStreamingResponse({
      providerResponse,
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
      connectionId: "conn-thought-only",
      apiKey: null,
      clientRawRequest: null,
      onRequestSuccess,
      reqLogger: null,
      toolNameMap: null,
      customToolNames: null,
      streamController,
      onStreamComplete: vi.fn(),
      streamDetailId: "detail-thought-only",
      pxpipe: null,
      reqTag: "tag-thought-only",
      log: null,
      emptyGuardState: { meaningful: false, exhausted: false },
    });

    const reader = result.response.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("rejects HTTP-200 text/html before empty-stream retry machinery", async () => {
    const streamController = createStreamController({ provider: "antigravity", model: "gemini-3.6-flash" });
    const result = await validateSseContentType({
      providerResponse: new Response("<html><title>Gateway error</title><body>bad gateway</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      provider: "antigravity",
      model: "gemini-3.6-flash",
      streamController,
      reqTag: "tag-html",
      log: null,
    });

    expect(result).toMatchObject({ status: 200, message: "Gateway error" });
    expect(await result.response.json()).toEqual({ error: { message: "[200]: Gateway error" } });
  });
});
