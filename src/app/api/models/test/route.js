import { NextResponse } from "next/server";
import { pingModelByKind } from "./ping";
import { MODEL_TEST_TIMEOUT_MS } from "open-sse/config/runtimeConfig.js";

// POST /api/models/test - Ping a single model via internal completions or embeddings
export async function POST(request) {
  try {
    const { model, kind } = await request.json();
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });
    const result = await pingModelByKind(model, kind || "llm", undefined, request.signal);
    return NextResponse.json(result);
  } catch (err) {
    const timedOut = err?.name === "TimeoutError";
    const cancelled = err?.name === "AbortError" || request.signal?.aborted;
    const status = timedOut ? 504 : (cancelled ? 499 : 500);
    const error = timedOut
      ? `Model test timed out after ${MODEL_TEST_TIMEOUT_MS}ms`
      : (cancelled ? "Model test cancelled" : err.message);
    return NextResponse.json({ ok: false, error }, { status });
  }
}
