import {currentSession, authErrorBody} from '@/lib/unified-auth';
import {startMessageWatcher, subscribeRealtime} from '@/lib/realtime/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Server-Sent Events stream for live table refreshes.
 *
 * One connection per browser tab. Events are deliberately minimal
 * ({domain, action, id, at}); the client refetches through the existing
 * authenticated read APIs. A 15-second comment heartbeat keeps proxies and
 * load balancers from closing an idle stream.
 */
export async function GET(request: Request) {
  try {
    await currentSession(request);
  } catch (error) {
    const mapped = authErrorBody(error);
    return new Response(JSON.stringify({error: mapped.error}), {
      status: mapped.status,
      headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
    });
  }

  startMessageWatcher();
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: string) => {
        try { controller.enqueue(encoder.encode(data)); } catch { /* stream closed */ }
      };
      send('retry: 5000\n\n');
      send(': connected\n\n');
      unsubscribe = subscribeRealtime((event) => {
        send(`event: domain\ndata: ${JSON.stringify(event)}\n\n`);
      });
      heartbeat = setInterval(() => send(': heartbeat\n\n'), 15_000);
      heartbeat.unref?.();
      request.signal.addEventListener('abort', () => {
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
