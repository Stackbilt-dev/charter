import { POINTER_CLAUDE_MD } from './adf';
import { parseAdf } from '@stackbilt/adf';

/** Identify the runtime artifact, not a hand-authored module named context.adf. */
export function isGeneratedContextModule(file: string, content: string, caseInsensitive = false): boolean {
  if ((caseInsensitive ? file.toLowerCase() : file) !== 'context.adf') return false;
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const generatedSections = new Set(['ROLE', 'STATE', 'OPEN_WORK', 'RECENT_ACTIVITY', 'PENDING_DECISIONS', 'WARNINGS']);
  if (parseAdf(content).sections.some(section => !generatedSections.has(section.key))) return false;
  return lines.includes('ROLE: Live session snapshot for warm-start context')
    && ['STATE:', 'OPEN_WORK:', 'RECENT_ACTIVITY:', 'PENDING_DECISIONS:'].every(line => lines.includes(line))
    && ['GENERATED_AT', 'EXPIRES_AT', 'SOURCES_REQUESTED', 'SOURCES_USED', 'REPO_ROOT']
      .every(key => lines.some(line => line.startsWith(`  ${key}: `)));
}

/** Remove one exact generated session preamble; leave additions and edits visible. */
export function stripGeneratedPointerSession(file: string, content: string): string {
  if (file !== 'CLAUDE.md') return content;
  const start = POINTER_CLAUDE_MD.indexOf('## Session Start\n');
  const end = POINTER_CLAUDE_MD.indexOf('## Environment\n', start);
  const session = POINTER_CLAUDE_MD.slice(start, end);
  return content.replace(/\r\n/g, '\n').replace(session, '');
}
