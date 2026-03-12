import { describe, it, expect } from 'vitest';
import { filePathToKeywords } from '../commands/adf-context';

describe('filePathToKeywords', () => {
  it('extracts react/frontend keywords from .tsx files', () => {
    const kw = filePathToKeywords(['src/components/Button.tsx']);
    expect(kw).toContain('react');
    expect(kw).toContain('frontend');
  });

  it('extracts css/frontend keywords from .css files', () => {
    const kw = filePathToKeywords(['src/styles/main.css']);
    expect(kw).toContain('css');
    expect(kw).toContain('frontend');
  });

  it('extracts api/backend keywords from api directory paths', () => {
    const kw = filePathToKeywords(['src/api/handler.ts']);
    expect(kw).toContain('api');
    expect(kw).toContain('backend');
  });

  it('extracts test/qa keywords from test directory paths', () => {
    const kw = filePathToKeywords(['src/__tests__/foo.test.ts']);
    expect(kw).toContain('test');
    expect(kw).toContain('qa');
  });

  it('extracts deploy/infra keywords from infra directories', () => {
    const kw = filePathToKeywords(['deploy/Dockerfile']);
    expect(kw).toContain('deploy');
    expect(kw).toContain('infra');
  });

  it('extracts auth/security keywords from auth directories', () => {
    const kw = filePathToKeywords(['src/auth/session.ts']);
    expect(kw).toContain('auth');
    expect(kw).toContain('security');
  });

  it('extracts db/backend keywords from .prisma files', () => {
    const kw = filePathToKeywords(['prisma/schema.prisma']);
    expect(kw).toContain('db');
    expect(kw).toContain('backend');
  });

  it('deduplicates keywords across multiple files', () => {
    const kw = filePathToKeywords(['src/components/A.tsx', 'src/components/B.tsx']);
    const reactCount = kw.filter(k => k === 'react').length;
    expect(reactCount).toBe(1);
  });

  it('returns empty array for unknown file types and directories', () => {
    const kw = filePathToKeywords(['README.md']);
    expect(kw).toHaveLength(0);
  });

  it('extracts cloudflare/deploy keywords from wrangler.toml', () => {
    const kw = filePathToKeywords(['wrangler.toml']);
    expect(kw).toContain('deploy');
    expect(kw).toContain('cloudflare');
  });

  it('handles component directory signal', () => {
    const kw = filePathToKeywords(['src/ui/widget/DatePicker.ts']);
    expect(kw).toContain('frontend');
  });
});
