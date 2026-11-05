import {NextResponse} from 'next/server';
import {row} from '@/lib/standalone/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public health probe: database reachability + schema version. No business data. */
export async function GET() {
  try {
    const version = await row<{value: string}>("SELECT value FROM schema_meta WHERE key = 'schema_version'");
    return NextResponse.json(
      {status: 'ok', database: 'ok', schemaVersion: version?.value ?? null},
      {headers: {'Cache-Control': 'no-store'}},
    );
  } catch (error) {
    console.error('health check failed:', error instanceof Error ? error.message : error);
    return NextResponse.json(
      {status: 'error', database: 'unavailable'},
      {status: 503, headers: {'Cache-Control': 'no-store'}},
    );
  }
}
