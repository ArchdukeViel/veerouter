import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { getRequestId, handleUnhandledRequestError } from "@/sse/utils/unhandledError.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/responses - OpenAI Responses API format
 * Now handled by translator pattern (openai-responses format auto-detected)
 */
export async function POST(request) {
  const requestId = getRequestId(request);
  try {
    await ensureInitialized();
    return await handleChat(request, null, requestId);
  } catch (error) {
    return handleUnhandledRequestError({ requestId, error, phase: "route_init" });
  }
}
