/**
 * codegen/wrangler — generateWranglerBindings
 *
 * Generates wrangler.toml binding declarations from ScaffoldBinding list.
 * Extracted from stackbilt-web/src/lib/scaffold-core.ts.
 */

import type { ScaffoldBinding } from '../types';

/**
 * Generate wrangler.toml binding TOML fragment for the given bindings.
 */
export function generateWranglerBindings(bindings: ScaffoldBinding[], pattern?: string): string {
  const blocks: string[] = [];

  for (const b of bindings) {
    if (b.type === 'D1') {
      blocks.push(
        `[[d1_databases]]\nbinding = "${b.binding}"\ndatabase_name = "app-db"\ndatabase_id = "REPLACE_ME"`,
      );
    } else if (b.type === 'KV') {
      blocks.push(`[[kv_namespaces]]\nbinding = "${b.binding}"\nid = "REPLACE_ME"`);
    } else if (b.type === 'R2') {
      blocks.push(`[[r2_buckets]]\nbinding = "${b.binding}"\nbucket_name = "REPLACE_ME"`);
    } else if (b.type === 'AI') {
      blocks.push(`[ai]\nbinding = "${b.binding}"`);
    } else if (b.type === 'DO') {
      blocks.push(
        [
          '[[durable_objects.bindings]]',
          `name = "${b.binding}"`,
          'class_name = "RoomDO"',
          '',
          '[[migrations]]',
          'tag = "v1"',
          'new_classes = ["RoomDO"]',
        ].join('\n'),
      );
    }
  }

  if (pattern === 'cron-worker') {
    blocks.push('[triggers]\ncrons = ["0 0 * * *"]');
  }

  return blocks.join('\n\n');
}
