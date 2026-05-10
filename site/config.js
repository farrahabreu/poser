// POSER frontend config
// Since the API and frontend are served from the same Express server,
// all API calls use relative paths — no hardcoded URLs needed.
window.POSER_CONFIG = {
  API_BASE: '/api/v1',
  WS_URL: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
};
