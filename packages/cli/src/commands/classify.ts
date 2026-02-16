/**
 * charter classify <subject>
 *
 * Classifies a change description as SURFACE/LOCAL/CROSS_CUTTING.
 * Pure heuristic — no LLM required.
 */

import type { CLIOptions } from '../index';
import { heuristicClassify, determineRecommendation } from '@charter/classify';

export async function classifyCommand(options: CLIOptions, args: string[]): Promise<void> {
  // Collect subject from remaining args (skip flags)
  const subject = args.filter(a => !a.startsWith('--')).join(' ');

  if (!subject) {
    console.error('  Usage: charter classify <change description>');
    console.error('  Example: charter classify "Add OAuth2 integration for partner API"');
    process.exit(1);
  }

  const result = heuristicClassify(subject);
  const recommendation = determineRecommendation(result.suggestedClass, 'CLEAR', false);

  if (options.format === 'json') {
    console.log(JSON.stringify({ ...result, recommendation }, null, 2));
    return;
  }

  const icon = result.suggestedClass === 'CROSS_CUTTING' ? '🔴'
    : result.suggestedClass === 'LOCAL' ? '🟡'
    : '🟢';

  const recIcon = recommendation === 'APPROVE' ? '✅'
    : recommendation === 'ESCALATE' ? '🔄'
    : '⚠️';

  console.log(`
  ${icon} Classification: ${result.suggestedClass}
     Confidence: ${result.confidence}
     Recommendation: ${recIcon} ${recommendation}

  Signals:
${result.signals.map(s => `    - ${s}`).join('\n')}
`);

  if (result.suggestedClass === 'CROSS_CUTTING') {
    console.log('  ⚠️  Cross-cutting changes require architectural review.');
    console.log('     Connect to CSA Cloud for temporal analysis: https://stackbilt.dev');
    console.log('');
  }
}
