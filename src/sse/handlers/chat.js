import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { getExecutor } from "open-sse/executors/index.js";

/**
 * Classify an upstream HTTP status for account-rotation policy.
 *
 * Retryable across accounts (transient / quota / server-side problems):
 *   408 Request Timeout, 425 Too Early, 429 Too Many Requests, 500 Internal
 *   Server Error, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout,
 *   507 Insufficient Storage, 522/523/524 Cloudflare-style.
 *
 * Deterministic (do NOT rotate — every account will see the same outcome):
 *   400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found,
 *   405 Method Not Allowed, 406 Not Acceptable, 409 Conflict (when not a
 *   concurrent-write race), 410 Gone, 411 Length Required, 412 Precondition
 *   Failed, 413 Payload Too Large, 414 URI Too Long, 415 Unsupported Media,
 *   416 Range Not Satisfiable, 417 Expectation Failed, 418/421/422/426.
 */
export function isRetryableStatus(status) {
  if (typeof status !== "number" || !Number.isFinite(status)) return true; // unknown → give the next account a chance
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500 && status < 600) {
    // 501 Not Implemented is technically retryable-but-pointless on the same
    // upstream; rotating still costs a slot, so treat as not-retryable to
    // avoid burning accounts on a structurally-bad provider endpoint.
    return status !== 501;
  }
  return false;
}

/**
 * Classify a thrown error (no status code attached) for rotation policy.
 * Returns true when rotating to another account is worth attempting.
 */
export function isRetryableError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return false;
  if (typeof err.status === "number" && Number.isFinite(err.status)) return isRetryableStatus(err.status);
  const msg = String(err.message || "").toLowerCase();
  if (!msg) return true; // unknown → try
  // Network / transport / transient
  if (
    msg.includes("econnreset") || msg.includes("etimedout") || msg.includes("epipe") ||
    msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("eai_again") ||
    msg.includes("fetch failed") || msg.includes("network") || msg.includes("socket hang up") ||
    msg.includes("temporary unavailable") || msg.includes("capacity") ||
    msg.includes("high traffic") || msg.includes("timeout") || msg.includes("timed out") ||
    msg.includes("agent execution terminated") || msg.includes("terminated due to error") ||
    msg.includes("stream ended") || msg.includes("stream closed") || msg.includes("stream terminated") ||
    msg.includes("empty response") || msg.includes("und_err_socket") ||
    msg.includes("resource_exhausted") || msg.includes("quota")
  ) return true;
  // Deterministic upstream
  if (
    msg.includes("bad request") || msg.includes("[400]") ||
    msg.includes("unauthorized") || msg.includes("[401]") ||
    msg.includes("forbidden") || msg.includes("[403]") ||
    msg.includes("not found") || msg.includes("[404]") ||
    msg.includes("method not allowed") || msg.includes("not acceptable") ||
    msg.includes("payload too large") || msg.includes("uri too long") ||
    msg.includes("schema") || msg.includes("validation") ||
    msg.includes("invalid api key") || msg.includes("malformed")
  ) return false;
  return true; // unknown → try
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  const modelStr = body.model;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;

    // Mutable active-account context — threads the LIVE account identity through
    // every callback (success/refresh/rotate) so that after A → B rotation the
    // success callback clears B, not A. Capturing `credentials` directly in any
    // closure makes success clearing target the originally opened account, which
    // can resurrect a freshly benched account as soon as a sibling succeeds.
    const initialProxyOptions = {
      connectionProxyEnabled: refreshedCredentials?.providerSpecificData?.connectionProxyEnabled === true,
      connectionProxyUrl: refreshedCredentials?.providerSpecificData?.connectionProxyUrl || "",
      connectionNoProxy: refreshedCredentials?.providerSpecificData?.connectionNoProxy || "",
      vercelRelayUrl: refreshedCredentials?.providerSpecificData?.vercelRelayUrl || "",
    };
    const activeAccount = {
      connectionId: credentials.connectionId,
      credentials: refreshedCredentials,
      proxyOptions: initialProxyOptions,
      reexecute: null,
    };

    const chatCoreCtx = { activeAccount };

    const onAccountExhausted = async ({ reason, upstreamError, currentConnectionId, resetsAtMs }) => {
      // 1. Bench current account (the one whose empty retries just exhausted)
      await markAccountUnavailable(currentConnectionId, HTTP_STATUS.BAD_GATEWAY, reason, provider, model, resetsAtMs);

      // 2. Add current account to exclusion set
      excludeConnectionIds.add(currentConnectionId);

      // 3. Select next eligible account
      const next = await getProviderCredentials(provider, excludeConnectionIds, model);
      if (!next || next.allRateLimited) return null;

      // 4. Refresh token + resolve projectId for new account
      const nextRefreshed = await checkAndRefreshToken(provider, next);
      if ((provider === "antigravity" || provider === "gemini-cli") && !nextRefreshed.projectId) {
        const pid = await getProjectIdForConnection(next.connectionId, nextRefreshed.accessToken, provider);
        if (pid) {
          nextRefreshed.projectId = pid;
          updateProviderCredentials(next.connectionId, { projectId: pid }).catch(() => { });
        }
      }

      // 5. Recompute proxy options from new account credentials
      const nextProxyOptions = {
        connectionProxyEnabled: nextRefreshed?.providerSpecificData?.connectionProxyEnabled === true,
        connectionProxyUrl: nextRefreshed?.providerSpecificData?.connectionProxyUrl || "",
        connectionNoProxy: nextRefreshed?.providerSpecificData?.connectionNoProxy || "",
        vercelRelayUrl: nextRefreshed?.providerSpecificData?.vercelRelayUrl || "",
      };

      log.warn("ROTATE", `⇄ ACC:${currentConnectionId.slice(0, 8)} EMPTY-EXHAUSTED → ACC:${nextRefreshed.connectionName || next.connectionId.slice(0, 8)}`);
      log.warn("ROTATE", `    reason=${reason?.slice?.(0, 80)} | upstream=${upstreamError?.status || upstreamError?.code || "EMPTY"}`);

      // 6. Build reexecute factory bound to the NEW account. The empty-stream
      //    guard calls this on every retry after rotation; using live activeAccount
      //    fields ensures later rotation hops stay consistent.
      const rotatedReexecute = async () => {
        const retryResult = await getExecutor(provider).execute({
          model,
          body: chatCoreCtx.translatedBody,
          stream: true,
          credentials: nextRefreshed,
          signal: chatCoreCtx.streamControllerSignal,
          log,
          proxyOptions: nextProxyOptions,
        });
        if (!retryResult.response.ok) {
          const status = retryResult.response.status;
          const err = new Error(`[${status}] rotation upstream non-2xx`);
          err.status = status;
          err.isRetryable = isRetryableStatus(status);
          throw err;
        }
        if (!retryResult.response.body) {
          const err = new Error("rotation upstream returned no body");
          err.isRetryable = false;
          throw err;
        }
        return retryResult.response.body;
      };

      // 7. Update the active-account context so any later callback
      //    (success / refresh / rotate) targets the new account.
      activeAccount.connectionId = next.connectionId;
      activeAccount.credentials = nextRefreshed;
      activeAccount.proxyOptions = nextProxyOptions;
      activeAccount.reexecute = rotatedReexecute;

      return {
        connectionId: next.connectionId,
        credentials: nextRefreshed,
        proxyOptions: nextProxyOptions,
        reexecute: rotatedReexecute,
      };
    };

    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      // Active-account context (via chatCoreCtx) — every callback reads/writes
      // THIS object so success clearing targets whichever account actually
      // emitted the bytes, not the originally selected one.
      chatCoreCtx,
      onCredentialsRefreshed: async (newCreds) => {
        // Persist refreshed token to DB using the LIVE connectionId. The
        // chatCore already mutates the same credentials object passed in, so
        // activeAccount.credentials is kept in sync automatically.
        await updateProviderCredentials(activeAccount.connectionId, {
          ...newCreds,
          existingProviderSpecificData: activeAccount.credentials?.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        // Clear the account that ACTUALLY produced output, not the original.
        await clearAccountError(activeAccount.connectionId, activeAccount.credentials, model);
      },
      onUpstreamEmptyExhausted: async (reason, resetsAtMs) => {
        // Fallback path: legacy callback when rotation is unavailable. Use the
        // live active-account identity so a rotated account's failure benches
        // itself, not the original opener.
        await markAccountUnavailable(activeAccount.connectionId, HTTP_STATUS.BAD_GATEWAY, reason, provider, model, resetsAtMs);
      },
      onAccountExhausted,
    });

    if (result.success) return result.response;

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs);

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
