// Modo Chrome: reemplaza el puente de Electron (preload.js) por llamadas al servidor local (server.js).
(function () {
  if (window.tryon) return; // dentro de Electron ya existe
  const H = { 'x-probador': '1' };
  async function call(url, body) {
    const opts = body === undefined
      ? { headers: H }
      : { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch(url, opts);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  }
  window.tryon = {
    isWeb: true,
    getSettings: () => call('/api/settings'),
    setApiKey: (key) => call('/api/key', { key }),
    setPrefs: (prefs) => call('/api/prefs', prefs).then((d) => d.prefs),
    getToken: () => call('/api/token', {}).then((d) => d.apiKey),
    fetchImage: async (url) => {
      const r = await fetch('/api/image?url=' + encodeURIComponent(url), { headers: H });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'No se pudo descargar la imagen');
      return { data: await r.arrayBuffer(), type: r.headers.get('content-type') || 'image/jpeg' };
    },
    log: (level, msg, data) => {
      fetch('/api/log', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ level, msg: String(msg), data }) }).catch(() => {});
    },
    close: () => window.__closePip?.(),
    minimize: () => {},
    pin: () => window.__togglePip?.(),
    openExternal: (url) => window.open(url, '_blank', 'noopener'),
  };
})();
