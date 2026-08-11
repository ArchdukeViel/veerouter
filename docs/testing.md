# Testing 9Router

## Default offline gate

The default test command is deterministic and does not require provider credentials or live upstream traffic:

```bash
npm test
```

This runs the unit suite through `tests/vitest.offline.config.js`. Tests that require live providers, credentials, or real upstream traffic are excluded from this gate.
Cloudflare Worker-only fixtures and the optional lowdb benchmark are also excluded because their runtime/dependency requirements are not part of the local Node gateway contract.

## Full diagnostic suite

To run every unit file, including environment-sensitive tests, use:

```bash
npm run test:unit:all
```

This is diagnostic rather than the default CI gate because provider credentials, operating-system paths, and external services can affect the result.

Windsurf is intentionally hidden from the runtime registry because its current
gRPC stream does not preserve tool-call chunks. Its historical endpoint
assertions are contract-review-only. The same explicit review mode is used for
the currently disabled got-scraping route and combo web-search capability:

```powershell
$env:CONTRACT_REVIEW="1"
npx vitest --config tests/vitest.config.js run tests/unit/windsurf-executor.test.js
npx vitest --config tests/vitest.config.js run tests/unit/claude-header-forwarding.test.js tests/unit/combo-autoswitch.test.js
```

## Live provider tests

Run live tests explicitly and only with credentials and runtime data already configured:

```bash
npm run test:live
npm run test:live -- tests/unit/mimo-free.live.test.js
```

The wrapper sets `RUN_LIVE=1` and `RUN_REAL=1`. Never place provider credentials in source files, CI logs, or test fixtures.

## Install verification

After a clean install, verify the local dependencies:

```bash
npm run verify:install
```

After building and installing the CLI, verify its packaged artifacts and command wiring:

```bash
npm run cli:build
npm run cli:install
npm run verify:cli
```

The CLI install intentionally passes `--allow-scripts=9router`; the package postinstall only warms the user-writable runtime, while startup self-healing and the `sql.js` fallback remain available.

## CI gate

`.github/workflows/test.yml` runs the offline gate, lint, production build, CLI
build/install, and runtime verification on Node 24 for both Ubuntu and Windows.
It does not require provider credentials or live traffic. Root and CLI lockfiles
are committed so `npm ci` is reproducible in CI.

The enforced lint scope covers gateway/backend code, scripts, and tests. The
existing dashboard-only `src/shared` lint debt is outside this change and is
not used to gate the install/test workflow.
