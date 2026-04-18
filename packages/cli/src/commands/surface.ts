/**
 * charter surface
 *
 * Extracts the API surface from the current project:
 *   - HTTP routes (Hono, Express, itty-router)
 *   - D1/SQLite schema tables (from schema.sql)
 *
 * Output modes:
 *   - text (default): human-readable summary
 *   - json: structured output for tooling (cc-taskrunner, CI, etc.)
 *   - markdown: formatted for `.ai/surface.adf` or AI context injection
 */

import * as path from 'path';
import type { CLIOptions } from '../index';
import { CLIError, EXIT_CODE } from '../index';
import { getFlag } from '../flags';
import { analyze, SurfaceInputSchema, formatSurfaceMarkdown } from '@stackbilt/surface';
import { z } from 'zod';

export async function surfaceCommand(options: CLIOptions, args: string[]): Promise<number> {
  const rootArg = getFlag(args, '--root') || '.';
  const schemaFlag = getFlag(args, '--schema');
  const asMarkdown = args.includes('--markdown') || args.includes('--md');

  let input;
  try {
    input = SurfaceInputSchema.parse({
      root: rootArg,
      schemaPaths: schemaFlag ? [path.resolve(schemaFlag)] : undefined,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const msg = err.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new CLIError(`Invalid arguments: ${msg}`);
    }
    throw err;
  }

  const surface = analyze(input);

  if (asMarkdown) {
    console.log(formatSurfaceMarkdown(surface));
    return EXIT_CODE.SUCCESS;
  }

  if (options.format === 'json') {
    console.log(
      JSON.stringify(
        {
          ...surface,
          root: path.relative(process.cwd(), surface.root),
        },
        null,
        2
      )
    );
    return EXIT_CODE.SUCCESS;
  }

  console.log('');
  console.log(`  API Surface`);
  console.log(`  root:    ${path.relative(process.cwd(), surface.root) || '.'}`);
  console.log(`  routes:  ${surface.summary.routeCount}`);
  console.log(`  tables:  ${surface.summary.schemaTableCount}`);
  console.log('');

  if (surface.summary.routeCount > 0) {
    console.log('  Routes by framework:');
    for (const [fw, count] of Object.entries(surface.summary.routesByFramework)) {
      console.log(`    ${fw.padEnd(10)} ${count}`);
    }
    console.log('');
    console.log('  Routes by method:');
    for (const [method, count] of Object.entries(surface.summary.routesByMethod)) {
      console.log(`    ${method.padEnd(7)} ${count}`);
    }
    console.log('');

    const limit = 30;
    console.log('  Registered routes:');
    for (const r of surface.routes.slice(0, limit)) {
      const fullPath = r.prefix ? `${r.prefix}${r.path}` : r.path;
      console.log(`    ${r.method.padEnd(6)} ${fullPath.padEnd(40)} ${r.file}:${r.line}`);
    }
    if (surface.routes.length > limit) {
      console.log(`    ... (${surface.routes.length - limit} more)`);
    }
    console.log('');
  }

  if (surface.summary.schemaTableCount > 0) {
    console.log('  Schema tables:');
    for (const t of surface.schemas) {
      const pk = t.columns.filter((c) => c.primaryKey).map((c) => c.name).join(', ');
      console.log(`    ${t.name.padEnd(24)} ${t.columns.length} columns${pk ? `, pk: ${pk}` : ''}`);
    }
    console.log('');
  }

  if (surface.summary.routeCount === 0 && surface.summary.schemaTableCount === 0) {
    throw new CLIError(
      'No routes or schema tables detected. This command is designed for ' +
        'Cloudflare Worker / Hono / Express projects with a schema.sql file.'
    );
  }

  return EXIT_CODE.SUCCESS;
}
