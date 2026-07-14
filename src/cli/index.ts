#!/usr/bin/env node
/**
 * CLI entrypoint. Loads environment, wires up commander, and delegates to the
 * per-command orchestrators. dotenv is loaded here (and only here) so the core
 * modules stay filesystem- and env-agnostic.
 */

import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import { runExplain } from './explain.js';
import { log } from '../utils/logger.js';

const program = new Command();

program
  .name('conflict-context')
  .description('Explain and resolve git conflicts by reconstructing why each side changed.')
  .version('0.1.0');

program
  .command('explain')
  .description('Explain, in plain English, what each side of every conflict was trying to do.')
  .option('--no-color', 'disable colored output')
  .option('--file <path>', 'scope to a single conflicted file')
  .action(async (options: { color?: boolean; file?: string }) => {
    if (options.color === false) chalk.level = 0;
    try {
      await runExplain({ file: options.file });
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
