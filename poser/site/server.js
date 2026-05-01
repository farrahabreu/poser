const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const ROOT = __dirname;

const mime = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'text/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
};

function getMostReplayedMs(videoId) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      videoId,
      context: { client: { clientName: 'WEB', clientVersion: '2.20231219.01.00', hl: 'en', gl: 'US' } }
    });
    const req = https.request({
      hostname: 'www.youtube.com',
      path: '/youtubei/v1/next',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': '2.20231219.01.00'
      }
    }, (r) => {
      let raw = '';
      r.on('data', d => raw += d);
      r.on('end', () => {
        try {
          const data = JSON.parse(raw);
          const mutations = data?.frameworkUpdates?.entityBatchUpdate?.mutations;
          if (!Array.isArray(mutations)) return resolve(null);

          let markersList = null;
          for (const m of mutations) {
            const ml = m?.payload?.macroMarkersListEntity?.markersList;
            if (ml?.markerType === 'MARKER_TYPE_HEATMAP') { markersList = ml; break; }
          }
          if (!markersList) return resolve(null);

          // Prefer the explicit "Most replayed" decoration label
          const decorations = markersList?.markersDecoration?.timedMarkerDecorations;
          if (Array.isArray(decorations)) {
            for (const d of decorations) {
              const label = (d?.label?.runs || []).map(r => r.text).join('');
              if (label.toLowerCase().includes('most replayed') && d.decorationTimeMillis) {
                return resolve(d.decorationTimeMillis);
              }
            }
          }

          // Fallback: find peak intensity marker
          const markers = markersList?.markers;
          if (!Array.isArray(markers) || !markers.length) return resolve(null);
          let bestMs = 0, bestScore = -1;
          for (const m of markers) {
            const score = m.intensityScoreNormalized || 0;
            if (score > bestScore) {
              bestScore = score;
              bestMs = (parseInt(m.startMillis) || 0) + (parseInt(m.durationMillis) || 0) / 2;
            }
          }
          resolve(bestMs > 0 ? bestMs : null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

const _serverCache = {}; // videoId -> ms value (persists for server lifetime)

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/most-replayed') {
    const videoId = url.searchParams.get('id');
    if (!videoId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing id' }));
    }
    if (!(videoId in _serverCache)) {
      _serverCache[videoId] = await getMostReplayedMs(videoId);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ms: _serverCache[videoId] }));
  }

  let urlPath = url.pathname;
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found');
    } else {
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
      res.end(data);
    }
  });
}).listen(PORT, () => console.log(`POSER running at http://localhost:${PORT}`));
