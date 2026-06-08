#!/usr/bin/env node
// Executable entry point for the `cairn` CLI.
import { run } from "../dist/cli/index.js";

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`cairn: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  });
