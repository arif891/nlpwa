#!/usr/bin/env node
import { runCLI } from '../src/cli/index.js';

runCLI(process.argv.slice(2)).catch((err) => {
  console.error('[NLPWA CLI Error]:', err);
  process.exit(1);
});
