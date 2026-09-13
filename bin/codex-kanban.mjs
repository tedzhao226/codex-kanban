#!/usr/bin/env node
import { runCli } from '../lib/cli.mjs';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
