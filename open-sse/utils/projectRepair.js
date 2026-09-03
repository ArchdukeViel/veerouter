/**
 * Repair a cached Antigravity project binding after the provider reports a
 * 404. The resolver is deliberately injected so this helper can be used by
 * both the initial chat request and an in-stream rotated-account retry.
 */
export async function repairStaleProjectId({
  provider,
  credentials,
  connectionId,
  invalidateProjectId,
  resolveProjectId,
  persistProjectId,
  log,
} = {}) {
  if (provider !== "antigravity" || !credentials?.projectId || !connectionId) return false;

  const staleProjectId = credentials.projectId;
  credentials.projectId = null;
  invalidateProjectId?.(connectionId);

  let freshProjectId = null;
  try {
    freshProjectId = await resolveProjectId(connectionId, credentials.accessToken, provider);
  } catch (error) {
    log?.warn?.(`projectId repair failed for ${connectionId.slice(0, 8)}: ${error?.message || error}`);
  }

  if (!freshProjectId) {
    credentials.projectId = staleProjectId;
    return false;
  }

  // The current request can use a valid in-memory repair even if persistence
  // is temporarily unavailable. A later request will resolve it again.
  credentials.projectId = freshProjectId;
  try {
    await persistProjectId?.(connectionId, { projectId: freshProjectId });
  } catch (error) {
    log?.warn?.(`projectId persistence failed for ${connectionId.slice(0, 8)}: ${error?.message || error}`);
  }
  return true;
}

/**
 * Execute once, repair a stale Antigravity project after a 404, and execute
 * exactly once more. A second failure is returned to the caller so its normal
 * classifier can rotate/bench the account.
 */
export async function executeWithStaleProjectRepair({
  provider,
  credentials,
  connectionId,
  execute,
  ...repairOptions
} = {}) {
  const firstResult = await execute();
  if (provider !== "antigravity" || firstResult?.response?.status !== 404) return firstResult;

  const repaired = await repairStaleProjectId({
    provider,
    credentials,
    connectionId,
    ...repairOptions,
  });
  if (!repaired) return firstResult;
  return execute();
}
