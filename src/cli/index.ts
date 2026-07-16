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
import { runResolve } from './resolve.js';
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
    if (!process.env.ANTHROPIC_API_KEY) {
      log.error('ANTHROPIC_API_KEY is not set. Add it to your environment or a .env file.');
      process.exitCode = 1;
      return;
    }
    try {
      await runExplain({ file: options.file });
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command('resolve')
  .description('Propose a merged resolution per hunk and record your accept/edit/skip choices.')
  .option('--no-color', 'disable colored output')
  .option('--file <path>', 'scope to a single conflicted file')
  .option('--auto', 'apply hunks at or above --min-confidence without prompting')
  .option(
    '--min-confidence <level>',
    'confidence threshold for --auto: high, medium, or low',
    'high',
  )
  .option('--dry-run', 'show what would happen without writing, staging, or snapshotting')
  .action(async (options: { color?: boolean; file?: string; auto?: boolean; minConfidence?: string; dryRun?: boolean }) => {
    if (options.color === false) chalk.level = 0;
    if (!process.env.ANTHROPIC_API_KEY) {
      log.error('ANTHROPIC_API_KEY is not set. Add it to your environment or a .env file.');
      process.exitCode = 1;
      return;
    }
    const minConfidence = options.minConfidence ?? 'high';
    if (minConfidence !== 'high' && minConfidence !== 'medium' && minConfidence !== 'low') {
      log.error(`Invalid --min-confidence "${minConfidence}" — use high, medium, or low.`);
      process.exitCode = 1;
      return;
    }
    try {
      await runResolve({ file: options.file, auto: options.auto, minConfidence, dryRun: options.dryRun });
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command('undo')
  .description('Restore conflicted files to their pre-resolve state from the safety snapshot.')
  .option('--no-color', 'disable colored output')
  .action(async (options: { color?: boolean }) => {
    if (options.color === false) chalk.level = 0;
    try {
      const { restoreSnapshot } = await import('../git/snapshot.js');
      const restored = await restoreSnapshot();
      log.heading('Restored from snapshot:');
      for (const path of restored) log.info(`  ${path} — conflict markers and staging state are back`);
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
