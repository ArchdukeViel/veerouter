import { describe, expect, it, vi } from "vitest";
import { executeWithStaleProjectRepair } from "../../open-sse/utils/projectRepair.js";

describe("stale Antigravity projectId repair", () => {
  it("invalidates, resolves once, retries the same account once, then succeeds", async () => {
    const credentials = { accessToken: "token", projectId: "stale-project" };
    const execute = vi.fn()
      .mockResolvedValueOnce({ response: new Response("stale", { status: 404 }) })
      .mockResolvedValueOnce({ response: new Response("ok", { status: 200 }) });
    const invalidateProjectId = vi.fn();
    const resolveProjectId = vi.fn().mockResolvedValue("fresh-project");
    const persistProjectId = vi.fn().mockResolvedValue(true);

    const result = await executeWithStaleProjectRepair({
      provider: "antigravity",
      credentials,
      connectionId: "conn-A",
      execute,
      invalidateProjectId,
      resolveProjectId,
      persistProjectId,
      log: null,
    });

    expect(result.response.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(resolveProjectId).toHaveBeenCalledTimes(1);
    expect(invalidateProjectId).toHaveBeenCalledWith("conn-A");
    expect(persistProjectId).toHaveBeenCalledWith("conn-A", { projectId: "fresh-project" });
    expect(credentials.projectId).toBe("fresh-project");
  });

  it("does not loop when the repaired project still returns 404", async () => {
    const credentials = { accessToken: "token", projectId: "stale-project" };
    const execute = vi.fn().mockResolvedValue({ response: new Response("still stale", { status: 404 }) });

    const result = await executeWithStaleProjectRepair({
      provider: "antigravity",
      credentials,
      connectionId: "conn-A",
      execute,
      invalidateProjectId: vi.fn(),
      resolveProjectId: vi.fn().mockResolvedValue("fresh-project"),
      persistProjectId: vi.fn().mockResolvedValue(true),
      log: null,
    });

    expect(result.response.status).toBe(404);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
