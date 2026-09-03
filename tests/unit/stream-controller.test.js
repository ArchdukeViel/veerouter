import { describe, expect, it, vi } from "vitest";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

describe("createStreamController request lifecycle", () => {
  it("aborts the executor signal when the route request is aborted", () => {
    const requestController = new AbortController();
    const onDisconnect = vi.fn();
    const streamController = createStreamController({
      provider: "nvidia",
      model: "moonshotai/kimi-k3",
      requestSignal: requestController.signal,
      onDisconnect,
    });

    requestController.abort();

    expect(streamController.signal.aborted).toBe(true);
    expect(streamController.isConnected()).toBe(false);
    expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ reason: "request_aborted" }));
  });

  it("does not abort after normal completion when the request later closes", () => {
    const requestController = new AbortController();
    const streamController = createStreamController({
      provider: "nvidia",
      model: "moonshotai/kimi-k3",
      requestSignal: requestController.signal,
    });

    streamController.handleComplete();
    requestController.abort();

    expect(streamController.signal.aborted).toBe(false);
    expect(streamController.isConnected()).toBe(false);
  });

  it("starts aborted when the route request is already closed", () => {
    const requestController = new AbortController();
    requestController.abort();

    const streamController = createStreamController({
      provider: "nvidia",
      model: "moonshotai/kimi-k3",
      requestSignal: requestController.signal,
    });

    expect(streamController.signal.aborted).toBe(true);
    expect(streamController.isConnected()).toBe(false);
  });
});
