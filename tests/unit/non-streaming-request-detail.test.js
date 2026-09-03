import { beforeEach, describe, expect, it, vi } from "vitest";

const { saveRequestDetail } = vi.hoisted(() => ({
  saveRequestDetail: vi.fn(async () => {}),
}));

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail,
  saveRequestUsage: vi.fn(async () => {}),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

function makeContext(responseBody) {
  return {
    providerResponse: new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    provider: "nvidia",
    model: "moonshotai/kimi-k3",
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    body: { model: "nvidia/moonshotai/kimi-k3", messages: [{ role: "user", content: "hi" }] },
    stream: false,
    translatedBody: { model: "moonshotai/kimi-k3", messages: [{ role: "user", content: "hi" }] },
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    reqLogger: {
      logProviderResponse: vi.fn(),
      logConvertedResponse: vi.fn(),
    },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
  };
}

describe("non-streaming request detail outcomes", () => {
  beforeEach(() => {
    saveRequestDetail.mockClear();
  });

  it("records reasoning-only completions as successful and visible", async () => {
    await handleNonStreamingResponse(makeContext({
      id: "chatcmpl-reasoning",
      choices: [{
        message: { role: "assistant", content: "", reasoning_content: "internal reasoning" },
        finish_reason: "length",
      }],
    }));

    const detail = saveRequestDetail.mock.calls[0][0];
    expect(detail.status).toBe("success");
    expect(detail.response).toMatchObject({
      content: "[Reasoning-only response]",
      thinking: "internal reasoning",
      finish_reason: "length",
    });
    expect(detail.response).not.toHaveProperty("error");
  });

  it("records an empty completion choice as an error", async () => {
    await handleNonStreamingResponse(makeContext({
      id: "chatcmpl-empty",
      choices: [{
        message: { role: "assistant", content: "" },
        finish_reason: "stop",
      }],
    }));

    const detail = saveRequestDetail.mock.calls[0][0];
    expect(detail.status).toBe("error");
    expect(detail.response).toMatchObject({
      content: null,
      error: "Provider returned an empty completion",
      finish_reason: "stop",
    });
  });
});
