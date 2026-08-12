#!/usr/bin/env node
import { run } from "../dist/src/cli/main.js";

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`zerogate: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
