import { afterAll } from "vitest";
import { closeAdapter } from "../src/lib/db/driver.js";

// Close the process-wide SQLite adapter after each test file. This is needed
// for DATA_DIR-isolated suites on Windows, where an open native handle keeps
// the temporary directory undeletable and can leak state into the next file.
afterAll(() => {
  closeAdapter();
});
