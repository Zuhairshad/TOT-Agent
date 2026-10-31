import { handleAdminDelete } from './admin.js';
import { handleEvents } from './events.js';
import { handleHealth } from './health.js';
import { handleIngest } from './ingest.js';
import { handleInteractions } from './interactions.js';
import { handleScheduled } from './scheduled.js';
import type { Env } from './types.js';
import { isReservedPath, routeV2 } from './v2/router.js';

const ADMIN_TENDER = /^\/admin\/tenders\/([^/]+)$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;
    if (pathname === '/health' && method === 'GET') return handleHealth(env);
    if (pathname === '/ingest' && method === 'POST') return handleIngest(request, env, ctx);
    if (pathname === '/slack/interactions' && method === 'POST')
      return handleInteractions(request, env, ctx);
    if (pathname === '/slack/events' && method === 'POST') return handleEvents(request, env, ctx);
    const admin = ADMIN_TENDER.exec(pathname);
    if (admin?.[1] && method === 'DELETE') return handleAdminDelete(request, env, admin[1]);

    // v2: /scans/start, /ingest/v2 (INGEST_SECRET) and /api/* (APP_TOKEN).
    const v2 = await routeV2(request, env, ctx);
    if (v2) return v2;

    // Everything else is the web UI (single-page app) when the [assets] binding exists.
    // API-looking paths never fall through to it, so a typo gets a 404, not index.html.
    if (env.ASSETS && !isReservedPath(pathname) && (method === 'GET' || method === 'HEAD')) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleScheduled(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
