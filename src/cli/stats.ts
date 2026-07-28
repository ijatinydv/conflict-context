import { loadPatternStore } from '../core/patternStore.js';
import { log } from '../utils/logger.js';

export async function runStats(options: { cwd?: string } = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const store = await loadPatternStore(cwd);

  log.rule();
  log.heading('Conflict Pattern Memory Stats');

  if (store.patterns.length === 0) {
    log.info('No patterns learned yet. Run `cctx resolve` and accept resolutions to teach the tool.');
    return;
  }

  const totalPatterns = store.patterns.length;
  const llmCallsSaved = store.patterns.reduce((sum, p) => sum + p.useCount, 0);
  
  // Sort patterns by useCount (descending)
  const byUsage = [...store.patterns].sort((a, b) => b.useCount - a.useCount);
  
  // Group by file
  const fileCounts = new Map<string, number>();
  for (const p of store.patterns) {
    fileCounts.set(p.filePath, (fileCounts.get(p.filePath) ?? 0) + 1);
  }
  const topFiles = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  log.info(`Patterns learned:  ${totalPatterns}`);
  log.info(`LLM calls saved:   ${llmCallsSaved}`);
  console.log();

  if (topFiles.length > 0) {
    log.heading('Top files with conflicts');
    for (const [file, count] of topFiles) {
      log.info(`  ${String(count).padEnd(4)} ${file}`);
    }
    console.log();
  }

  const mostUsed = byUsage.filter(p => p.useCount > 0).slice(0, 3);
  if (mostUsed.length > 0) {
    log.heading('Most applied patterns');
    for (const p of mostUsed) {
      log.info(`  ${String(p.useCount).padEnd(4)} times: ${p.filePath} (${p.conflictClass})`);
    }
  }
}
