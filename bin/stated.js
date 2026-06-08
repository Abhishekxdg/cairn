#!/usr/bin/env node
// Executable entry point for the `stated` CLI.
// Thin shim that defers to the compiled CLI in dist/.
import { run } from "../dist/cli/index.js";

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`stated: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  });
