// Modo Chrome: servidor local que sirve la interfaz y guarda la clave de API.
// Uso: npm run web  → abre http://localhost:5174 en Chrome.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT) || 5174;
const HOST = '127.0.0.1';
const ORIGIN = `http://localhost:${PORT}`;
const DIR = __dirname;
const CONF_DIR = path.join(os.homedir(), '.probador-virtual');
const CONF = path.join(CONF_DIR, 'settings.json');
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

// Solo estos archivos se sirven; nada más de la carpeta queda expuesto.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/web-shim.js': ['web-shim.js', 'text/javascript; charset=utf-8'],
  '/dist/renderer.js': ['dist/renderer.js', 'text/javascript; charset=utf-8'],
};

function readConf() { try { return JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch { return {}; } }
function writeConf(c) {
  fs.mkdirSync(CONF_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONF, JSON.stringify(c, null, 2), { mode: 0o600 });
}
const apiKey = () => (process.env.DECART_API_KEY || readConf().apiKey || '').trim() || null;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new Error('Cuerpo demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);

  if (!url.pathname.startsWith('/api/')) {
    const entry = req.method === 'GET' && STATIC[url.pathname];
    if (!entry) return send(res, 404, 'No encontrado', 'text/plain; charset=utf-8');
    try { return send(res, 200, fs.readFileSync(path.join(DIR, entry[0])), entry[1]); }
    catch { return send(res, 500, 'Falta compilar: corre "npm run web".', 'text/plain; charset=utf-8'); }
  }

  // Protección: solo nuestra propia página puede usar la API (otras webs no pueden pedir tokens).
  const origin = req.headers.origin;
  if (req.headers['x-probador'] !== '1' || (origin && origin !== ORIGIN && origin !== `http://127.0.0.1:${PORT}`)) {
    return send(res, 403, { error: 'Prohibido' });
  }

  try {
    if (url.pathname === '/api/settings' && req.method === 'GET') {
      return send(res, 200, { hasApiKey: !!apiKey(), fromEnv: !!process.env.DECART_API_KEY, prefs: readConf().prefs || {} });
    }
    if (url.pathname === '/api/key' && req.method === 'POST') {
      const { key } = await readBody(req);
      const c = readConf();
      if (key) c.apiKey = String(key).trim(); else delete c.apiKey;
      writeConf(c);
      return send(res, 200, { hasApiKey: !!apiKey() });
    }
    if (url.pathname === '/api/prefs' && req.method === 'POST') {
      const prefs = await readBody(req);
      const c = readConf();
      c.prefs = { ...(c.prefs || {}), ...prefs };
      writeConf(c);
      return send(res, 200, { prefs: c.prefs });
    }
    if (url.pathname === '/api/token' && req.method === 'POST') {
      const key = apiKey();
      if (!key) return send(res, 400, { error: 'Falta la clave de API de Decart. Agrégala en Ajustes (⚙︎).' });
      const r = await fetch('https://api.decart.ai/v1/client/tokens', {
        method: 'POST', headers: { 'X-API-KEY': key, 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn: 300 }),
      });
      if (!r.ok) return send(res, r.status === 401 || r.status === 403 ? 401 : 502, { error: `No se pudo crear el token (HTTP ${r.status}) ${(await r.text().catch(() => '')).slice(0, 300)}` });
      const t = await r.json();
      return send(res, 200, { apiKey: t.apiKey });
    }
    if (url.pathname === '/api/image' && req.method === 'GET') {
      const target = url.searchParams.get('url') || '';
      if (!/^https?:\/\//i.test(target)) return send(res, 400, { error: 'URL de imagen no válida' });
      const u = new URL(target);
      const r = await fetch(u, { headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', Referer: u.origin + '/',
      } });
      if (!r.ok) return send(res, 502, { error: `No se pudo descargar la imagen (HTTP ${r.status})` });
      const type = (r.headers.get('content-type') || '').split(';')[0].trim();
      if (type && !type.startsWith('image/')) return send(res, 415, { error: 'El enlace no apunta a una imagen' });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) return send(res, 413, { error: 'La imagen es demasiado grande' });
      return send(res, 200, buf, type || 'image/jpeg');
    }
    if (url.pathname === '/api/log' && req.method === 'POST') {
      const { level, msg, data } = await readBody(req);
      const t = new Date().toISOString().slice(11, 23);
      console.log(`[${t}] ${String(level || 'info').toUpperCase().padEnd(5)} ${msg} ${data !== undefined ? JSON.stringify(data).slice(0, 1500) : ''}`);
      return send(res, 204, '');
    }
    return send(res, 404, { error: 'No encontrado' });
  } catch (e) {
    return send(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Probador Virtual (modo Chrome) en ${ORIGIN}`);
  console.log('Deja esta Terminal abierta. Para cerrar: Ctrl+C.\n');
  if (process.platform === 'darwin' && !process.env.NO_OPEN) {
    const p = spawn('open', ['-a', 'Google Chrome', ORIGIN], { stdio: 'ignore' });
    p.on('error', () => {});
    p.on('exit', (code) => { if (code) spawn('open', [ORIGIN], { stdio: 'ignore' }).on('error', () => {}); });
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`El puerto ${PORT} está ocupado. ¿Ya está abierto? Cierra la otra Terminal o usa PORT=5175 npm run web.`);
  else console.error(e);
  process.exit(1);
});
