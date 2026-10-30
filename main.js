// Proceso principal de Electron: ventana flotante, clave de API y descarga de imágenes.
const { app, BrowserWindow, ipcMain, net, safeStorage, session, systemPreferences, screen, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
// Diagnóstico en la Terminal: siempre en desarrollo; en la app instalada solo con PROBADOR_DEBUG=1.
const DEBUG = !app.isPackaged || process.env.PROBADOR_DEBUG === '1';
let win;

// ---------- Ajustes (la clave se guarda cifrada con el llavero del sistema) ----------
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); } catch { return {}; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2), { mode: 0o600 });
}
async function getApiKey() {
  if (process.env.DECART_API_KEY) return process.env.DECART_API_KEY.trim();
  const s = readSettings();
  if (!s.apiKeyEnc) return null;
  try {
    const buf = Buffer.from(s.apiKeyEnc, 'base64');
    if (!s.encrypted) return buf.toString('utf8');
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(buf);
    if (shouldReEncrypt) await setApiKey(result);
    return result;
  } catch { return null; }
}
async function setApiKey(key) {
  const s = readSettings();
  if (!key) { delete s.apiKeyEnc; delete s.encrypted; writeSettings(s); return; }
  const canEncrypt = await safeStorage.isAsyncEncryptionAvailable().catch(() => false);
  s.apiKeyEnc = (canEncrypt ? await safeStorage.encryptStringAsync(key) : Buffer.from(key, 'utf8')).toString('base64');
  s.encrypted = canEncrypt;
  writeSettings(s);
}

// ---------- Ventana ----------
// Recupera el tamaño y la posición de la última vez, si todavía caben en alguna pantalla.
function savedBounds() {
  const b = readSettings().bounds;
  if (!b || !b.width || !b.height) return null;
  const fits = screen.getAllDisplays().some(({ workArea: w }) =>
    b.x >= w.x - 50 && b.y >= w.y - 50 && b.x + b.width <= w.x + w.width + 50 && b.y + b.height <= w.y + w.height + 50);
  return fits ? b : null;
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(480, workArea.width - 48);
  const height = Math.min(820, workArea.height - 60);
  const bounds = savedBounds() || {
    width, height,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + Math.max(20, Math.round((workArea.height - height) / 2)),
  };
  win = new BrowserWindow({
    ...bounds, minWidth: 320, minHeight: 420,
    frame: false,
    transparent: false,
    backgroundColor: '#111114',
    alwaysOnTop: true,
    hasShadow: true,
    title: 'Probador Virtual',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Sin esto, macOS frena la ventana cuando estás en Chrome y la cámara deja de enviar cuadros.
      backgroundThrottling: false,
    },
  });
  // Encima del navegador, incluso en pantalla completa y en todos los escritorios.
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'index.html'));

  // Guarda tamaño y posición cuando el usuario mueve o agranda la ventana.
  let saveTimer;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      const s = readSettings(); s.bounds = win.getBounds(); writeSettings(s);
    }, 500);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // Los enlaces externos se abren en el navegador, nunca dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Soltar una imagen no debe navegar fuera de la app.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(async () => {
  // Solo se concede cámara/micrófono a nuestra propia ventana.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(wc === win?.webContents && (permission === 'media' || permission === 'clipboard-read'));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) =>
    wc === win?.webContents && (permission === 'media' || permission === 'clipboard-read'));

  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('camera'); } catch {}
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());

// ---------- IPC ----------
ipcMain.handle('settings:get', async () => ({
  hasApiKey: !!(await getApiKey()),
  fromEnv: !!process.env.DECART_API_KEY,
  prefs: readSettings().prefs || {},
}));
ipcMain.handle('settings:setApiKey', async (_e, key) => {
  if (key != null && typeof key !== 'string') throw new Error('Clave inválida');
  await setApiKey(key ? key.trim() : null);
  return { hasApiKey: !!(await getApiKey()) };
});
ipcMain.handle('settings:setPrefs', (_e, prefs) => {
  const s = readSettings();
  s.prefs = { ...(s.prefs || {}), ...(prefs || {}) };
  writeSettings(s);
  return s.prefs;
});

// Crea un token efímero: la clave permanente nunca llega a la ventana.
ipcMain.handle('decart:token', async () => {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('Falta la clave de API de Decart. Agrégala en Ajustes (⚙︎).');
  // Misma petición que hace client.tokens.create() del SDK de Decart.
  const res = await net.fetch('https://api.decart.ai/v1/client/tokens', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ expiresIn: 300 }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`No se pudo crear el token (HTTP ${res.status}) ${detail}`);
  }
  const t = await res.json();
  if (!t?.apiKey) throw new Error('Decart no devolvió un token válido.');
  return t.apiKey;
});

// Descarga una imagen desde el proceso principal (evita CORS y bloqueos de hotlinking).
ipcMain.handle('image:fetch', async (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('URL de imagen no válida');
  const u = new URL(url);
  const res = await net.fetch(u.href, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      Referer: u.origin + '/',
    },
  });
  if (!res.ok) throw new Error(`No se pudo descargar la imagen (HTTP ${res.status})`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (type && !type.startsWith('image/')) throw new Error('El enlace no apunta a una imagen');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('La imagen es demasiado grande');
  return { data: buf, type: type || 'image/jpeg' };
});

// Diagnóstico: todo lo que pasa en la ventana se imprime en la Terminal.
ipcMain.on('log', (_e, level, msg, data) => {
  if (!DEBUG) return;
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}] ${String(level).toUpperCase().padEnd(5)} ${msg} ${data || ''}`);
});

ipcMain.on('window:close', () => win?.close());
ipcMain.on('window:minimize', () => win?.minimize());
ipcMain.on('window:pin', (_e, on) => win?.setAlwaysOnTop(!!on, 'floating'));
ipcMain.on('open:external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
