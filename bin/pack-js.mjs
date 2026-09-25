#!/usr/bin/env node
import { runCli } from '../src/pack.mjs';

runCli().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
