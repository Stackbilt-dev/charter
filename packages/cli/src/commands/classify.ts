/**
 * charter classify <subject>
 *
 * Classifies a change description as SURFACE/LOCAL/CROSS_CUTTING.
 * Pure heuristic - no LLM required.
 */

import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { heuristicClassify, determineRecommendation } from '@charter/classify';

export async function classifyCommand(options: CLIOptions, args: string[]): Promise<number> {
  const subject = args.filter((a) => !a.startsWith('--')).join(' ');

  if (!subject) {
    throw new CLIError(
      'Usage: charter classify <change description>\nExample: charter classify "Add OAuth2 integration for partner API"'
    );
  }

  const result = heuristicClassify(subject);
  const recommendation = determineRecommendation(result.suggestedClass, 'CLEAR', false);

  if (options.format === 'json') {
    console.log(JSON.stringify({ ...result, recommendation }, null, 2));
    return EXIT_CODE.SUCCESS;
  }

  const icon = result.suggestedClass === 'CROSS_CUTTING' ? '[high]'
    : result.suggestedClass === 'LOCAL' ? '[mid]'
    : '[low]';

  const recIcon = recommendation === 'APPROVE' ? '[ok]'
    : recommendation === 'ESCALATE' ? '[escalate]'
    : '[warn]';

  console.log('');
  console.log(`  ${icon} Classification: ${result.suggestedClass}`);
  console.log(`     Confidence: ${result.confidence}`);
  console.log(`     Recommendation: ${recIcon} ${recommendation}`);
  console.log('');
  console.log('  Signals:');
  for (const signal of result.signals) {
    console.log(`    - ${signal}`);
  }
  console.log('');

  if (result.suggestedClass === 'CROSS_CUTTING') {
    console.log('  [warn] Cross-cutting changes require architectural review.');
    console.log('');
  }

  return EXIT_CODE.SUCCESS;
}
