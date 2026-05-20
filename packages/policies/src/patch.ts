import { exec } from 'node:child_process';

export interface PatchReplacement {
  original: string;
  sha: string;
  tag: string;
}

export interface PatchResult {
  patched: string;
  replacements: PatchReplacement[];
}

// Matches any non-SHA ref (@vN, @main, @master, semver) — excludes local (./) and Stackbilt-dev refs.
// A 40-char hex SHA is the only exempt form.
const FLOATING_USES_RE = /^(\s*-?\s*uses:\s+)((?!Stackbilt-dev\/)(?!\.\/)[^\s@]+)@(?![0-9a-f]{40}(?:\s|$|#))([^\s#]+)(.*)$/;

export async function patchFloatingActionPins(content: string): Promise<PatchResult> {
  const replacements: PatchReplacement[] = [];
  const shaCache = new Map<string, string>();

  const lines = content.split('\n');
  const patched = await Promise.all(
    lines.map(async (line) => {
      const m = line.match(FLOATING_USES_RE);
      if (!m) return line;

      const [, prefix, action, tag, suffix] = m;
      const cacheKey = `${action}@${tag}`;

      let sha = shaCache.get(cacheKey);
      if (!sha) {
        const resolved = await resolveActionSha(action, tag);
        if (!resolved) return line; // can't resolve — leave unchanged
        sha = resolved;
        shaCache.set(cacheKey, sha);
      }

      replacements.push({ original: line.trim(), sha, tag });
      return `${prefix}${action}@${sha} # ${tag}${suffix}`;
    }),
  );

  return { patched: patched.join('\n'), replacements };
}

function resolveActionSha(action: string, tag: string): Promise<string | null> {
  return new Promise((resolve) => {
    const url = `https://github.com/${action}`;
    // Try annotated tag deref, plain tag, then branch head (covers @main, @master, etc.)
    const cmd = `git ls-remote "${url}" "refs/tags/${tag}" "refs/tags/${tag}^{}" "refs/heads/${tag}"`;
    exec(cmd, { timeout: 20000 }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve(null); return; }
      const lines = stdout.trim().split('\n');
      const deref = lines.find((l) => l.includes(`refs/tags/${tag}^{}`));
      const plain = lines.find((l) => l.includes(`refs/tags/${tag}`) && !l.includes('^{}'));
      const branch = lines.find((l) => l.includes(`refs/heads/${tag}`));
      const winner = deref ?? plain ?? branch;
      if (!winner) { resolve(null); return; }
      const sha = winner.split('\t')[0].trim();
      resolve(sha.length === 40 ? sha : null);
    });
  });
}
