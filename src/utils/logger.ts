/**
 * Small terminal logging helpers. Centralising chalk here keeps color handling
 * in one place and lets the CLI toggle color off globally via chalk's level.
 */

import chalk from 'chalk';

export const log = {
  error: (msg: string) => console.error(chalk.red(msg)),
  warn: (msg: string) => console.warn(chalk.yellow(msg)),
  info: (msg: string) => console.log(msg),
  heading: (msg: string) => console.log(chalk.bold.cyan(msg)),
  narrative: (msg: string) => console.log(chalk.green(msg)),
  rule: () => console.log(chalk.dim('─'.repeat(60))),
  code: (msg: string) => console.log(chalk.dim(msg)),
};
