// Lógica de la ventana: cámara, arrastrar prendas y sesión en tiempo real con Decart.
import { createDecartClient, models } from '@decartai/sdk';

const MODEL = models.realtime('lucy-vton-3.5');

// Diagnóstico: guardamos las conexiones WebRTC para revisar si los paquetes salen de verdad.
const trackedPCs = [];
if (window.RTCPeerConnection && !window.RTCPeerConnection.__tracked) {
  const NativePC = window.RTCPeerConnection;
  class TrackedPC extends NativePC { constructor(...a) { super(...a); trackedPCs.push(this); } }
  TrackedPC.__tracked = true;
  window.RTCPeerConnection = TrackedPC;
}
async function iceDiag() {
  const out = [];
  for (const pc of trackedPCs) {
    if (pc.connectionState === 'closed') continue;
    try {
      const st = await pc.getStats();
      const byId = new Map(); st.forEach((r) => byId.set(r.id, r));
      let pair = null, videoBytes = 0;
      st.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId);
        if (r.type === 'outbound-rtp' && r.kind === 'video') videoBytes += r.bytesSent || 0;
      });
      const cand = (id) => { const c = byId.get(id); return c ? `${c.candidateType}/${c.protocol}${c.relayProtocol ? '/' + c.relayProtocol : ''}` : null; };
      out.push({
        ice: pc.iceConnectionState, conn: pc.connectionState,
        par: pair ? { estado: pair.state, local: cand(pair.localCandidateId), remoto: cand(pair.remoteCandidateId), rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null, bytesEnviados: pair.bytesSent, bytesRecibidos: pair.bytesReceived } : 'sin par seleccionado',
        videoBytesEnviados: videoBytes,
      });
    } catch {}
  }
  return out;
}
const MAX_SIDE = 1200;     // la extensión original también reduce a ~1200 px
const MAX_HISTORY = 8;

const $ = (id) => document.getElementById(id);
const log = (level, msg, data) => { try { window.tryon.log(level, msg, data); } catch {} };
const sdkLogger = {
  debug: (m, d) => log('debug', '[sdk] ' + m, d), info: (m, d) => log('info', '[sdk] ' + m, d),
  warn: (m, d) => log('warn', '[sdk] ' + m, d), error: (m, d) => log('error', '[sdk] ' + m, d),
};
const els = {
  local: $('local'), remote: $('remote'), placeholder: $('placeholder'), dropHint: $('drop-hint'),
  busy: $('busy'), busyText: $('busy-text'), status: $('status'), statusText: $('status-text'), timer: $('timer'),
  thumb: $('garment-thumb'), type: $('garment-type'), desc: $('garment-desc'), history: $('history'),
  start: $('btn-start'), stop: $('btn-stop'), error: $('error'), fileBtn: $('btn-file'), fileInput: $('file-input'),
  settings: $('settings'), apiKey: $('api-key'), keyState: $('key-state'), autoStop: $('auto-stop'), mirror: $('mirror'),
};

const state = {
  camera: null,        // MediaStream local
  rt: null,            // cliente realtime de Decart
  garment: null,       // { blob, url }
  history: [],
  startedAt: 0,
  lastActivity: 0,
  tick: null,
  prefs: { autoStop: 120, mirror: true },
  hasApiKey: false,
};

// ---------------- Utilidades de UI ----------------
function showError(msg) {
  // Los errores se muestran en el panel de controles: si está oculto, se vuelve a mostrar.
  if (msg && document.body.classList.contains('cam-big')) setBig(false);
  els.error.textContent = msg || '';
  els.error.classList.toggle('hidden', !msg);
}
function setBusy(text) {
  els.busy.classList.toggle('hidden', !text);
  if (text) els.busyText.textContent = text;
}
function fmt(sec) { return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }
function setLive(live) {
  const fb = document.getElementById('btn-float') || els.floatBtn;
  if (fb) { fb.textContent = live ? 'Detener' : 'Probar'; fb.className = live ? 'danger' : 'primary'; }
  els.start.classList.toggle('hidden', live);
  els.stop.classList.toggle('hidden', !live);
  els.status.classList.toggle('hidden', !live);
  if (!live) els.remote.classList.remove('live');
}

// ---------------- Prompt ----------------
// Sin descripción ni tipo, se envía solo la imagen: el modelo viste a la persona según la foto.
function buildPrompt() {
  const d = els.desc.value.trim();
  if (!d && els.type.value === 'auto') return null;
  const ref = (what) => d || `the ${what} shown in the reference image`;
  switch (els.type.value) {
    case 'top': return `Substitute the current top with ${ref('top')}`;
    case 'bottom': return `Substitute the current pants or skirt with ${ref('bottoms')}`;
    case 'dress': return `Substitute the current outfit with ${ref('dress')}`;
    case 'outerwear': return `Add ${ref('jacket')} over the current outfit`;
    case 'outfit': return `Substitute the entire outfit with ${ref('outfit')}`;
    default: return `Substitute the matching clothing item with ${ref('garment')}`;
  }
}

// ---------------- Imágenes ----------------
// Convierte cualquier imagen a JPEG de máximo 1200 px (el modelo no necesita más).
const MIN_SIDE = 250;  // miniaturas más chicas que esto no le sirven al modelo
async function normalizeImage(blob) {
  const bmp = await createImageBitmap(blob);
  if (Math.max(bmp.width, bmp.height) < MIN_SIDE) {
    const { width, height } = bmp;
    bmp.close();
    const err = new Error(`La imagen es muy pequeña (${width}×${height}). Abre la foto del producto en grande y arrástrala desde ahí.`);
    err.tooSmall = true;
    throw err;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';               // fondo blanco para PNG transparentes
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
}

function cleanUrl(raw) {
  if (!raw) return null;
  let u = raw.trim();
  if (u.startsWith('//')) u = 'https:' + u;
  try {
    const parsed = new URL(u);
    // Google Imágenes envuelve la imagen real en ?imgurl=
    const inner = parsed.searchParams.get('imgurl') || parsed.searchParams.get('mediaurl');
    if (inner) return inner;
    return /^(https?|data):$/.test(parsed.protocol) ? parsed.href : null;
  } catch { return null; }
}

// Elige la imagen más grande de un srcset.
function largestFromSrcset(srcset) {
  let best = null, bestW = -1;
  for (const part of srcset.split(',')) {
    const [url, size] = part.trim().split(/\s+/);
    const w = parseFloat(size) || 1;
    if (url && w > bestW) { best = url; bestW = w; }
  }
  return best;
}

// Extrae candidatos de imagen de lo que se arrastró o pegó.
function candidatesFrom(dt) {
  const out = { files: [], urls: [] };
  for (const f of dt.files || []) if (f.type.startsWith('image/')) out.files.push(f);
  const html = dt.getData('text/html');
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const img of doc.querySelectorAll('img')) {
      const fromSet = img.getAttribute('srcset') && largestFromSrcset(img.getAttribute('srcset'));
      for (const c of [fromSet, img.getAttribute('src'), img.getAttribute('data-src')]) {
        const u = cleanUrl(c); if (u) out.urls.push(u);
      }
    }
  }
  for (const line of (dt.getData('text/uri-list') || '').split(/\r?\n/)) {
    if (line && !line.startsWith('#')) { const u = cleanUrl(line); if (u) out.urls.push(u); }
  }
  const plain = cleanUrl(dt.getData('text/plain'));
  if (plain) out.urls.push(plain);
  out.urls = [...new Set(out.urls)];
  return out;
}

async function blobFromUrl(url) {
  if (url.startsWith('data:')) return (await fetch(url)).blob();
  const { data, type } = await window.tryon.fetchImage(url);
  return new Blob([data], { type });
}

async function loadGarment(dt) {
  const { files, urls } = candidatesFrom(dt);
  let lastErr = null;
  // Se prueban todos los candidatos (archivo, srcset, src…) y se usa el primero con tamaño útil.
  for (const src of [...files, ...urls]) {
    try {
      const raw = src instanceof Blob ? src : await blobFromUrl(src);
      const img = await normalizeImage(raw);
      log('info', 'Prenda cargada', { origen: src instanceof Blob ? 'archivo' : String(src).slice(0, 120), bytes: img.size });
      return img;
    } catch (e) { if (!lastErr || !lastErr.tooSmall || !e.tooSmall) lastErr = e; }
  }
  throw new Error(lastErr ? cleanIpcError(lastErr) : 'No encontré una imagen. Arrastra la foto de la prenda, no el texto ni el enlace.');
}

function cleanIpcError(e) {
  return String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---------------- Prenda activa ----------------
async function applyGarment() {
  const prompt = buildPrompt();
  const input = { image: state.garment.blob, enhance: false };
  if (prompt) input.prompt = prompt;
  const t0 = performance.now();
  log('info', 'Enviando prenda', { bytes: state.garment.blob.size, type: state.garment.blob.type, prompt: prompt || '(solo imagen)' });
  try {
    await state.rt.set(input);
    log('info', `Prenda confirmada por el servidor en ${Math.round(performance.now() - t0)} ms`);
  } catch (e) {
    log('error', 'El servidor no confirmó la prenda', { error: String(e?.message || e) });
    throw e;
  }
}

async function useGarment(blob, { fromHistory = false } = {}) {
  showError('');
  let entry = state.history.find((h) => h.blob === blob);
  if (!entry) {
    entry = { blob, url: URL.createObjectURL(blob) };
    state.history.unshift(entry);
    while (state.history.length > MAX_HISTORY) URL.revokeObjectURL(state.history.pop().url);
  }
  state.garment = entry;
  els.thumb.src = entry.url;
  els.thumb.classList.remove('hidden');
  renderHistory();
  await ensureCamera();

  if (state.rt) {
    state.lastActivity = Date.now();
    setBusy('Cambiando prenda…');
    try {
      await applyGarment();
    } catch (e) {
      showError('No se pudo aplicar la prenda: ' + cleanIpcError(e));
    } finally { setBusy(null); }
  } else if (!fromHistory) {
    els.start.focus();
  }
}

function renderHistory() {
  els.history.replaceChildren(...state.history.map((h) => {
    const img = document.createElement('img');
    img.src = h.url;
    img.title = 'Volver a probar';
    img.className = h === state.garment ? 'active' : '';
    img.onclick = () => useGarment(h.blob, { fromHistory: true });
    return img;
  }));
}

// ---------------- Cámara ----------------
async function ensureCamera() {
  if (state.camera && state.camera.getVideoTracks().some((t) => t.readyState === 'live')) return state.camera;
  const fps = typeof MODEL.fps === 'number' ? MODEL.fps : (MODEL.fps.ideal || MODEL.fps.max || 30);
  try {
    state.camera = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: MODEL.width }, height: { ideal: MODEL.height }, frameRate: { ideal: fps }, facingMode: 'user' },
    });
  } catch (e) {
    throw new Error('No pude abrir la cámara. Revisa Ajustes del Sistema → Privacidad y seguridad → Cámara.');
  }
  els.local.srcObject = state.camera;
  els.placeholder.classList.add('hidden');
  return state.camera;
}

function stopCamera() {
  state.camera?.getTracks().forEach((t) => t.stop());
  state.camera = null;
  els.local.srcObject = null;
}

// ---------------- Sesión en tiempo real ----------------
async function start() {
  showError('');
  if (!state.hasApiKey) { openSettings(); return; }
  if (!state.garment) { showError('Primero arrastra o pega una prenda.'); return; }
  els.start.disabled = true;
  setBusy('Conectando con el modelo…');
  try {
    const stream = await ensureCamera();
    const client = createDecartClient({ apiKeyProvider: () => window.tryon.getToken(), logger: sdkLogger });
    log('info', 'Conectando', { codec: state.prefs.codec || 'vp8', model: MODEL.name, w: MODEL.width, h: MODEL.height, mirror: state.prefs.mirror });
    const rt = await client.realtime.connect(stream, {
      model: MODEL,
      // El espejo se hace solo en pantalla (CSS); al modelo se le envía la cámara tal cual.
      mirror: false,
      // VP8: Electron codifica H.264 por software (OpenH264) y el servidor no lo procesaba.
      preferredVideoCodec: state.prefs.codec || 'vp8',
      onRemoteStream: (remote) => showRemote(remote),
      onConnectionChange: (s) => {
        if (s === 'reconnecting') els.statusText.textContent = 'Reconectando…';
        else if (s === 'connected' || s === 'generating') updateStatus();
      },
      onQueuePosition: (q) => setBusy(`En cola… posición ${q?.position ?? ''}`.trim()),
      onCapacityWait: (w) => setBusy(`Servidores ocupados, reintentando en ${Math.ceil((w?.retryAfterMs || 0) / 1000)} s…`),
    });
    state.rt = rt;
    log('info', 'Conectado', { sessionId: rt.sessionId, state: rt.getConnectionState() });
    let ticks = 0;
    rt.on('generationTick', (g) => { if (ticks++ % 10 === 0) log('info', 'Generando (créditos corriendo)', g); });
    rt.on('generationEnded', (g) => log('warn', 'Generación terminada', g));
    rt.on('connectionChange', (c) => log('info', 'Estado de conexión: ' + c));
    let lastStats = 0;
    rt.on('stats', (st) => {
      if (Date.now() - lastStats < 5000) return;
      lastStats = Date.now();
      const o = st.outboundVideo, v = st.video;
      log('info', 'Stats', {
        enviado: o ? { fps: o.framesPerSecond, res: `${o.frameWidth}x${o.frameHeight}`, kbps: Math.round((o.bitrate || 0) / 1000), limit: o.qualityLimitationReason } : null,
        recibido: v ? { fps: v.framesPerSecond, frames: v.framesReceived, res: `${v.frameWidth}x${v.frameHeight}` } : null,
      });
      iceDiag().then((d) => log('info', 'WebRTC', d));
    });
    setBusy('Aplicando la prenda…');
    await applyGarment();
    rt.on('error', (err) => { if (state.rt !== rt) return; /* errores tardíos de una sesión ya cerrada */ log('error', 'Error del servicio', { code: err?.code, message: err?.message }); showError(friendlyError(err?.message || 'Error del servicio')); });
    rt.on('sessionEnded', (ev) => { if (state.rt !== rt) return; log('warn', 'Sesión terminada por el servidor', ev); stop(false); showError(sessionEndMessage(ev?.reason)); });

    state.startedAt = state.lastActivity = Date.now();
    clearInterval(state.tick);
    state.tick = setInterval(onTick, 1000);
    els.timer.textContent = '0:00';
    setLive(true);
    updateStatus();
  } catch (e) {
    log('error', 'Falló el inicio', { error: String(e?.message || e) });
    showError(friendlyError(e));
    stop(false);
  } finally {
    setBusy(null);
    els.start.disabled = false;
  }
}

// Muestra el video de la IA solo cuando llegan cuadros reales.
function showRemote(remote) {
  state.remoteLive = false;
  els.remote.srcObject = remote;
  els.remote.play?.().catch(() => {});
  log('info', 'Llegó el stream de la IA', { video: remote.getVideoTracks().length, audio: remote.getAudioTracks().length });
  const cam = state.camera?.getVideoTracks()[0];
  log('info', 'Cámara enviada', cam ? { ...cam.getSettings(), readyState: cam.readyState, muted: cam.muted } : { error: 'sin cámara' });
  setTimeout(() => { if (!state.remoteLive && state.rt) log('warn', 'Pasaron 10 s sin cuadros de la IA', { remoteTracks: remote.getVideoTracks().map((t) => ({ readyState: t.readyState, muted: t.muted })) }); }, 10000);
  const mark = () => {
    state.remoteLive = true; els.remote.classList.add('live'); updateStatus();
    log('info', 'Primer cuadro de la IA visible', { w: els.remote.videoWidth, h: els.remote.videoHeight });
  };
  if (els.remote.requestVideoFrameCallback) els.remote.requestVideoFrameCallback(mark);
  else els.remote.addEventListener('playing', mark, { once: true });
}
function updateStatus() {
  if (!state.rt) return;
  els.statusText.textContent = state.remoteLive ? 'IA activa' : 'Esperando video de la IA…';
  els.status.classList.toggle('waiting', !state.remoteLive);
}

const NO_CREDITS = 'Se acabaron los créditos de tu cuenta de Decart. Puedes cargar más en platform.decart.ai (no se cobra nada sin que agregues una tarjeta).';
function sessionEndMessage(reason) {
  switch (reason) {
    case 'insufficient_credits': return NO_CREDITS;
    case 'moderation_violation':
    case 'policy_violation': return 'Decart cortó la sesión porque la imagen no cumple sus reglas de contenido. Prueba con otra prenda.';
    case 'session_limit': return 'Se alcanzó el tiempo máximo de sesión. Presiona Probar para seguir.';
    default: return `La sesión terminó (${reason || 'servidor'}).`;
  }
}
function friendlyError(e) {
  const msg = cleanIpcError(e);
  if (/401|403|unauthor|invalid api key|forbidden/i.test(msg)) return 'La clave de API no es válida o no tiene permisos. Revísala en Ajustes (⚙︎).';
  if (/402|credit|insufficient|quota|balance/i.test(msg)) return NO_CREDITS;
  if (/fetch failed|network|ENOTFOUND|ECONN|timed? ?out/i.test(msg)) return 'No se pudo conectar con Decart. Revisa tu internet y vuelve a presionar Probar.';
  return msg;
}

function onTick() {
  const sec = Math.floor((Date.now() - state.startedAt) / 1000);
  els.timer.textContent = fmt(sec);
  const limit = Number(state.prefs.autoStop) || 0;
  if (limit && Date.now() - state.lastActivity > limit * 1000) {
    stop();
    showError(`Se detuvo tras ${fmt(limit)} sin cambiar de prenda, para no gastar créditos.`);
  }
}

function stop(clearErr = true) {
  clearInterval(state.tick);
  try { state.rt?.disconnect(); } catch {}
  state.rt = null;
  els.remote.srcObject = null;
  state.remoteLive = false;
  setLive(false);
  setBusy(null);
  if (clearErr) showError('');
}

// ---------------- Arrastrar, pegar y archivo ----------------
let dragDepth = 0;
const isExternalDrag = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'Files' || t.startsWith('text/'));
function bindDocEvents(doc) {
  if (doc.__tryonBound) return;
  doc.__tryonBound = true;
  doc.addEventListener('dragenter', (e) => {
    if (!isExternalDrag(e)) return;
    e.preventDefault();
    if (dragDepth++ === 0) els.dropHint.classList.remove('hidden');
  });
  doc.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  doc.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; els.dropHint.classList.add('hidden'); } });
  doc.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.dropHint.classList.add('hidden');
    await handleTransfer(e.dataTransfer);
  });
  doc.addEventListener('paste', async (e) => {
    if (e.target?.tagName === 'INPUT') return; // pegar texto en los campos funciona normal
    e.preventDefault();
    await handleTransfer(e.clipboardData);
  });
}
bindDocEvents(document);
els.fileBtn.onclick = () => els.fileInput.click();
els.fileInput.onchange = async () => {
  const f = els.fileInput.files[0];
  els.fileInput.value = '';
  if (f) await runGuarded(async () => useGarment(await normalizeImage(f)), 'Leyendo imagen…');
};

async function handleTransfer(dt) {
  if (!dt) return;
  await runGuarded(async () => useGarment(await loadGarment(dt)), 'Cargando prenda…');
}

async function runGuarded(fn, busyText) {
  showError('');
  setBusy(busyText);
  try { await fn(); } catch (e) { showError(cleanIpcError(e)); } finally { if (!state.rt) setBusy(null); }
}

// Cambiar tipo o descripción con la sesión activa vuelve a enviar la prenda.
let promptTimer;
function resendPrompt() {
  clearTimeout(promptTimer);
  promptTimer = setTimeout(() => { if (state.rt && state.garment) useGarment(state.garment.blob, { fromHistory: true }); }, 600);
}
els.type.onchange = resendPrompt;
els.desc.addEventListener('keydown', (e) => { if (e.key === 'Enter') resendPrompt(); });

// ---------------- Ajustes y ventana ----------------
function openSettings() {
  els.apiKey.value = '';
  els.autoStop.value = String(state.prefs.autoStop ?? 120);
  els.mirror.checked = state.prefs.mirror !== false;
  els.keyState.textContent = state.hasApiKey ? '✓ Hay una clave guardada. Escribe otra para reemplazarla.' : 'Todavía no hay clave guardada.';
  els.settings.showModal();
}
els.settings.addEventListener('close', async () => {
  if (els.settings.returnValue !== 'save') return;
  const key = els.apiKey.value.trim();
  if (key) state.hasApiKey = (await window.tryon.setApiKey(key)).hasApiKey;
  state.prefs = await window.tryon.setPrefs({ autoStop: Number(els.autoStop.value), mirror: els.mirror.checked });
  applyMirror();
});
$('link-platform').onclick = (e) => { e.preventDefault(); window.tryon.openExternal('https://platform.decart.ai'); };
$('btn-settings').onclick = openSettings;
$('btn-close').onclick = () => { stop(); stopCamera(); window.tryon.close(); };
$('btn-min').onclick = () => window.tryon.minimize();
const pinBtn = $('btn-pin');
if (window.tryon.isWeb) {
  // En Chrome: el 📌 abre la app en una ventana flotante siempre visible (Picture-in-Picture).
  pinBtn.classList.remove('on');
  pinBtn.title = 'Abrir en ventana flotante';
  pinBtn.onclick = () => togglePip();
} else {
  pinBtn.onclick = () => { const on = !pinBtn.classList.contains('on'); pinBtn.classList.toggle('on', on); window.tryon.pin(on); };
}

let pipWin = null;
let movedNodes = [];
function replayVideos() { for (const v of [els.local, els.remote]) if (v.srcObject) v.play().catch(() => {}); }
async function togglePip() {
  if (pipWin) { pipWin.close(); return; }
  if (!('documentPictureInPicture' in window)) {
    showError('Tu Chrome no permite ventanas flotantes. Actualiza Chrome (versión 116 o superior).');
    return;
  }
  pipWin = await documentPictureInPicture.requestWindow({ width: 480, height: 800 });
  pipWin.document.body.classList.toggle('cam-big', document.body.classList.contains('cam-big'));
  for (const link of document.querySelectorAll('link[rel=stylesheet]')) {
    const l = pipWin.document.createElement('link');
    l.rel = 'stylesheet'; l.href = link.href;
    pipWin.document.head.append(l);
  }
  pipWin.document.title = 'Probador Virtual';
  movedNodes = [...document.body.children].filter((n) => n.tagName !== 'SCRIPT' && n.id !== 'pip-note');
  pipWin.document.body.append(...movedNodes);
  bindDocEvents(pipWin.document);
  replayVideos();
  $('pip-note')?.classList.remove('hidden');
  pinBtn.classList.add('on');
  pipWin.addEventListener('pagehide', () => {
    document.body.prepend(...movedNodes);
    movedNodes = [];
    pipWin = null;
    replayVideos();
    $('pip-note')?.classList.add('hidden');
    pinBtn.classList.remove('on');
  }, { once: true });
}
window.__togglePip = togglePip;
window.__closePip = () => pipWin?.close();
els.start.onclick = start;
els.stop.onclick = () => stop();

// Modo cámara grande: oculta los controles y deja un botón flotante Probar/Detener.
els.floatBtn = $('btn-float');
els.floatBtn.onclick = () => (state.rt ? stop() : start());
const bigBtn = $('btn-big');
function setBig(on, save = true) {
  for (const b of [document.body, pipWin?.document.body].filter(Boolean)) b.classList.toggle('cam-big', on);
  bigBtn.classList.toggle('on', on);
  bigBtn.textContent = on ? '⤡' : '⤢';
  bigBtn.title = on ? 'Mostrar controles' : 'Cámara grande (oculta los controles)';
  if (save) window.tryon.setPrefs({ bigCamera: on }).catch?.(() => {});
}
bigBtn.onclick = () => setBig(!bigBtn.classList.contains('on'));

function applyMirror() {
  const on = state.prefs.mirror !== false;
  els.local.classList.toggle('mirror', on);
  els.remote.classList.toggle('mirror', on);
}

window.addEventListener('beforeunload', () => { stop(); stopCamera(); });

(async function init() {
  const s = await window.tryon.getSettings();
  state.hasApiKey = s.hasApiKey;
  state.prefs = { ...state.prefs, ...s.prefs };
  applyMirror();
  if (state.prefs.bigCamera) setBig(true, false);
  if (!s.hasApiKey) openSettings();
})();
