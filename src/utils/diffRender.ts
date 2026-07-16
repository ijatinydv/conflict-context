/**
 * Colorized line diffs for the terminal: proposed resolution vs each original
 * side, so the user can see exactly what accepting would change.
 */

import { diffLines } from 'diff';
import chalk from 'chalk';

export function renderDiff(label: string, from: string, to: string): string {
  const parts = diffLines(from.endsWith('\n') ? from : from + '\n', to.endsWith('\n') ? to : to + '\n');
  const body = parts
    .flatMap((part) => {
      const lines = part.value.replace(/\n$/, '').split('\n');
      if (part.added) return lines.map((l) => chalk.green(`+ ${l}`));
      if (part.removed) return lines.map((l) => chalk.red(`- ${l}`));
      return lines.map((l) => chalk.dim(`  ${l}`));
    })
    .join('\n');
  return `${chalk.bold(label)}\n${body}`;
}
