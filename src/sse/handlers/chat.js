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
import { getProjectIdForConnection, invalidateProjectId } from "open-sse/services/projectId.js";
import { getExecutor } from "open-sse/executors/index.js";
import { classifyFailure, classifyThrownError, isRetryableStatus } from "open-sse/utils/failureClassifier.js";
import { executeWithStaleProjectRepair, repairStaleProjectId } from "open-sse/utils/projectRepair.js";
import { getRequestId, handleUnhandledRequestError } from "../utils/unhandledError.js";

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
export function isRetryableError(err) {
  return !!classifyThrownError(err).retryable;
}

export { isRetryableStatus };

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null, requestIdOverride = null) {
  const requestId = getRequestId(request, requestIdOverride || clientRawRequest?.requestId);
  try {
    return await handleChatInternal(request, clientRawRequest, requestId);
  } catch (error) {
    return handleUnhandledRequestError({
      requestId,
      error,
      phase: "route",
      model: clientRawRequest?.body?.model,
    });
  }
}

async function handleChatInternal(request, clientRawRequest = null, requestId) {
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
  clientRawRequest = { ...clientRawRequest, requestId };
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
  const attemptedConnectionIds = new Set();
  const MAX_ACCOUNT_ATTEMPTS = 8;
  let lastError = null;
  let lastStatus = null;

  const requestId = clientRawRequest?.requestId || getRequestId(request);
  const accountIdOf = (account) => account?.connectionId || account?.id || "";
  const logRecoveryError = (error, phase, connectionId = "") => {
    handleUnhandledRequestError({
      requestId,
      error,
      phase,
      provider,
      model,
      connectionId,
    });
  };
  const benchAccount = async (connectionId, status, reason, resetsAtMs) => {
    if (connectionId) excludeConnectionIds.add(connectionId);
    if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
    try {
      return await markAccountUnavailable(connectionId, status, reason, provider, model, resetsAtMs);
    } catch (error) {
      // Persistence failure must not make the selector eligible again in this
      // request. The local exclusion set is the safety net.
      logRecoveryError(error, "bench", connectionId);
      return { shouldFallback: true, cooldownMs: 0, persistenceFailed: true };
    }
  };
  const prepareAccount = async (candidate, phase) => {
    const connectionId = accountIdOf(candidate);
    let refreshedCredentials;
    try {
      refreshedCredentials = await checkAndRefreshToken(provider, candidate);
    } catch (error) {
      logRecoveryError(error, "refresh_token", connectionId);
      return { ok: false, connectionId, error, phase: "refresh_token" };
    }
    if (!refreshedCredentials) {
      const error = new Error("credential refresh returned no credentials");
      logRecoveryError(error, "refresh_token", connectionId);
      return { ok: false, connectionId, error, phase: "refresh_token" };
    }

    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      let projectId = null;
      try {
        projectId = await getProjectIdForConnection(connectionId, refreshedCredentials.accessToken, provider);
      } catch (error) {
        logRecoveryError(error, "resolve_project", connectionId);
      }
      if (!projectId) {
        const error = new Error(`${phase}: projectId resolution failed`);
        logRecoveryError(error, "resolve_project", connectionId);
        return { ok: false, connectionId, error, phase: "resolve_project" };
      }
      refreshedCredentials.projectId = projectId;
      try {
        const persisted = await updateProviderCredentials(connectionId, { projectId });
        if (!persisted) log.warn("RECOVERY", `projectId persistence failed for ${connectionId.slice(0, 8)}`);
      } catch (error) {
        // The current request has a valid in-memory projectId; persistence is
        // best effort and must not convert a good provider response into 500.
        logRecoveryError(error, "persist_project", connectionId);
      }
    }

    return {
      ok: true,
      connectionId,
      credentials: refreshedCredentials,
      proxyOptions: {
        connectionProxyEnabled: refreshedCredentials?.providerSpecificData?.connectionProxyEnabled === true,
        connectionProxyUrl: refreshedCredentials?.providerSpecificData?.connectionProxyUrl || "",
        connectionNoProxy: refreshedCredentials?.providerSpecificData?.connectionNoProxy || "",
        vercelRelayUrl: refreshedCredentials?.providerSpecificData?.vercelRelayUrl || "",
      },
    };
  };

  for (let accountAttempt = 0; accountAttempt < MAX_ACCOUNT_ATTEMPTS; accountAttempt++) {
    let credentials;
    try {
      credentials = await getProviderCredentials(provider, excludeConnectionIds, model);
    } catch (error) {
      logRecoveryError(error, "select_account");
      return errorResponse(500, `Internal routing error (request_id=${requestId})`);
    }

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
    const connectionId = accountIdOf(credentials);
    if (connectionId && attemptedConnectionIds.has(connectionId)) {
      excludeConnectionIds.add(connectionId);
      continue;
    }
    if (connectionId) attemptedConnectionIds.add(connectionId);

    const prepared = await prepareAccount(credentials, "initial");
    if (!prepared.ok) {
      await benchAccount(prepared.connectionId, prepared.phase === "refresh_token" ? HTTP_STATUS.UNAUTHORIZED : HTTP_STATUS.SERVICE_UNAVAILABLE, prepared.error.message);
      lastError = prepared.error.message;
      lastStatus = prepared.phase === "refresh_token" ? HTTP_STATUS.UNAUTHORIZED : HTTP_STATUS.SERVICE_UNAVAILABLE;
      continue;
    }
    const refreshedCredentials = prepared.credentials;

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;

    // Mutable active-account context — threads the LIVE account identity through
    // every callback (success/refresh/rotate) so that after A → B rotation the
    // success callback clears B, not A. Capturing `credentials` directly in any
    // closure makes success clearing target the originally opened account, which
    // can resurrect a freshly benched account as soon as a sibling succeeds.
    const initialProxyOptions = prepared.proxyOptions;
    const activeAccount = {
      connectionId: prepared.connectionId,
      credentials: refreshedCredentials,
      proxyOptions: initialProxyOptions,
      reexecute: null,
    };

    const chatCoreCtx = { activeAccount };

    const onAccountExhausted = async ({ reason, upstreamError, currentConnectionId, resetsAtMs }) => {
      // Bench locally before persistence so a failed DB update cannot make the
      // account eligible again during this request.
      const currentId = currentConnectionId || activeAccount.connectionId;
      if (currentId) {
        excludeConnectionIds.add(currentId);
        attemptedConnectionIds.add(currentId);
      }
      try {
        await benchAccount(currentId, HTTP_STATUS.BAD_GATEWAY, reason, resetsAtMs);
      } catch (error) {
        logRecoveryError(error, "bench_rotation", currentId);
      }

      // Select the next eligible account. A candidate can fail refresh or
      // project setup; keep searching within a bounded request-local budget.
      for (let rotationAttempt = 0; rotationAttempt < MAX_ACCOUNT_ATTEMPTS; rotationAttempt++) {
      let next;
      try {
        next = await getProviderCredentials(provider, excludeConnectionIds, model);
      } catch (error) {
        logRecoveryError(error, "select_rotation_account", currentId);
        return null;
      }
      if (!next || next.allRateLimited) return null;

      const nextId = accountIdOf(next);
      if (!nextId || attemptedConnectionIds.has(nextId) || excludeConnectionIds.has(nextId)) {
        if (nextId) excludeConnectionIds.add(nextId);
        continue;
      }
      attemptedConnectionIds.add(nextId);

      // Refresh the candidate and resolve any account-scoped project binding.
      let nextRefreshed;
      try {
        nextRefreshed = await checkAndRefreshToken(provider, next);
      } catch (error) {
        logRecoveryError(error, "refresh_rotation", nextId);
        await benchAccount(nextId, HTTP_STATUS.UNAUTHORIZED, error?.message || "rotation refresh failed");
        continue;
      }
      if (!nextRefreshed) {
        await benchAccount(nextId, HTTP_STATUS.UNAUTHORIZED, "rotation refresh returned no credentials");
        continue;
      }
      if ((provider === "antigravity" || provider === "gemini-cli") && !nextRefreshed.projectId) {
        let pid = null;
        try {
          pid = await getProjectIdForConnection(nextId, nextRefreshed.accessToken, provider);
        } catch (error) {
          logRecoveryError(error, "resolve_project_rotation", nextId);
        }
        if (!pid) {
          await benchAccount(nextId, HTTP_STATUS.SERVICE_UNAVAILABLE, "rotation projectId resolution failed");
          continue;
        }
        nextRefreshed.projectId = pid;
        updateProviderCredentials(nextId, { projectId: pid }).catch((error) => {
          logRecoveryError(error, "persist_project_rotation", nextId);
        });
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
        const retryResult = await executeWithStaleProjectRepair({
          provider,
          credentials: nextRefreshed,
          connectionId: nextId,
          execute: () => getExecutor(provider).execute({
            model,
            body: chatCoreCtx.translatedBody,
            stream: true,
            credentials: nextRefreshed,
            signal: chatCoreCtx.streamControllerSignal,
            log,
            proxyOptions: nextProxyOptions,
          }),
          invalidateProjectId,
          resolveProjectId: getProjectIdForConnection,
          persistProjectId: updateProviderCredentials,
          log,
        });
        if (!retryResult.response.ok) {
          const status = retryResult.response.status;
          const err = new Error(`[${status}] rotation upstream non-2xx`);
          err.status = status;
          err.failure = classifyFailure({ status, provider, authType: nextRefreshed.authType, message: err.message });
          throw err;
        }
        if (!retryResult.response.body) {
          return null;
        }
        return retryResult.response.body;
      };

      // 7. Update the active-account context so any later callback
      //    (success / refresh / rotate) targets the new account.
      activeAccount.connectionId = nextId;
      activeAccount.credentials = nextRefreshed;
      activeAccount.proxyOptions = nextProxyOptions;
      activeAccount.reexecute = rotatedReexecute;

      return {
        connectionId: nextId,
        credentials: nextRefreshed,
        proxyOptions: nextProxyOptions,
        reexecute: rotatedReexecute,
      };
      }
      return null;
    };

    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: prepared.connectionId,
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
      onStaleProject: async () => repairStaleProjectId({
        provider,
        credentials: activeAccount.credentials,
        connectionId: activeAccount.connectionId,
        invalidateProjectId,
        resolveProjectId: getProjectIdForConnection,
        persistProjectId: updateProviderCredentials,
        log,
      }),
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
        try {
          await clearAccountError(activeAccount.connectionId, activeAccount.credentials, model);
        } catch (error) {
          logRecoveryError(error, "clear_account", activeAccount.connectionId);
        }
      },
      onUpstreamEmptyExhausted: async (reason, resetsAtMs) => {
        // Fallback path: legacy callback when rotation is unavailable. Use the
        // live active-account identity so a rotated account's failure benches
        // itself, not the original opener.
        await benchAccount(activeAccount.connectionId, HTTP_STATUS.BAD_GATEWAY, reason, resetsAtMs);
      },
      onAccountExhausted,
    });

    if (result.success) return result.response;

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const failedConnectionId = activeAccount.connectionId || prepared.connectionId;
    let benchResult;
    try {
      benchResult = (await benchAccount(failedConnectionId, result.status, result.error, result.resetsAtMs)) || { shouldFallback: false };
    } catch (error) {
      logRecoveryError(error, "bench_result", failedConnectionId);
      benchResult = { shouldFallback: true, persistenceFailed: true };
    }
    const { shouldFallback } = benchResult;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(failedConnectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
