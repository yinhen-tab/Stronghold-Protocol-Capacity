// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, sockets, sessions,
//     rooms, matches), never cached;
//   * everything else → the static files (static.js).
// A route that throws is logged and answers 500.

import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { isAnnouncementId } from '../../shared/announcements.js';
import { ANNOUNCEMENT_ASSET_URL_PREFIX } from '../../shared/announcementAssets.js';
import { serveAnnouncementAsset } from './announcementAssets.js';
import { ASSET_CACHE_PREFIX } from './assetCache.js';
import { buildTag } from './buildTag.js';
import { setSecurityHeaders, sendError, sendJson, splitUrl } from './common.js';

const MAX_URL_LENGTH = 4096;

/**
 * The GET /healthz body.
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby }} health
 */
export function healthReport({ startedAt, network, registry, lobby }) {
  return {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload
    build: buildTag(),
    sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
  };
}

/**
 * The request listener for `http.createServer`.
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], log: object,
 *           announcements?: ReturnType<typeof import('../announcements.js').createAnnouncementStore>,
 *           assetCache?: ReturnType<typeof import('./assetCache.js').createAssetCacheHandler> }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, log, announcements, assetCache }) {
  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/healthz') {
      sendJson(req, res, 200, healthReport(health));
      return;
    }
    if (parts.rawPath.startsWith(ASSET_CACHE_PREFIX)) {
      if (!assetCache) { sendJson(req, res, 503, { error: 'ASSET_CACHE_UNAVAILABLE' }); return; }
      await assetCache.serve(req, res, parts.rawPath, parts.query);
      return;
    }
    if (parts.rawPath === '/api/announcements') {
      sendJson(req, res, 200, announcements?.list() || { revision: '', pinnedId: null, items: [] });
      return;
    }
    if (parts.rawPath.startsWith('/api/announcements/')) {
      let id;
      try { id = decodeURIComponent(parts.rawPath.slice('/api/announcements/'.length)); } catch { /* invalid URL */ }
      const article = isAnnouncementId(id) ? announcements?.read(id) : null;
      sendJson(req, res, article ? 200 : 404, article || { error: 'ANNOUNCEMENT_NOT_FOUND' });
      return;
    }
    if (parts.rawPath === ANNOUNCEMENT_ASSET_URL_PREFIX.slice(0, -1) || parts.rawPath.startsWith(ANNOUNCEMENT_ASSET_URL_PREFIX)) {
      await serveAnnouncementAsset(req, res, parts.rawPath.slice(ANNOUNCEMENT_ASSET_URL_PREFIX.length), announcements, log);
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    setSecurityHeaders(res);
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  };
}
