// Parches para que el SDK de Decart funcione dentro de Electron.
//
// El SDK (y LiveKit, la librería WebRTC que usa por dentro) agregan el parámetro
// "x-google-start-bitrate" solo a algunas secciones de video de la negociación WebRTC.
// El Chromium de Electron lo rechaza ("BUNDLE group contains a codec collision") y la
// cámara queda publicada pero enviando 0 kbps, así que el modelo nunca genera video.
// Ese parámetro solo acelera los primeros segundos; quitarlo no cambia el resultado.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'node_modules');
const MARK = '/* probador-virtual-patch */';

function patch(file, re, replacement, label) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return 'missing'; }
  if (src.includes(MARK)) return 'ya';
  if (!re.test(src)) { console.warn(`Aviso: no se encontró el punto a parchear en ${label}.`); return 'no'; }
  fs.writeFileSync(file, src.replace(re, replacement));
  return 'ok';
}

const results = [];
// 1) Decart SDK
results.push(patch(
  path.join(root, '@decartai/sdk/dist/realtime/media-channel.js'),
  /seedStartBitrate\(room\)\s*\{(\s*\/\* probador-virtual: seedStartBitrate desactivado \*\/ return;)?/,
  (m) => `seedStartBitrate(room) { ${MARK} return;`,
  'Decart SDK'));
// 1b) Decart SDK: el diagnóstico de latencia usa un Web Worker (frame-metadata-worker.js) que no
//     viaja dentro del bundle. Sin el worker, cada cuadro de la cámara se pierde y se envían 0 bytes.
results.push(patch(
  path.join(root, '@decartai/sdk/dist/realtime/browser/frame-metadata-diagnostics.js'),
  /function isFrameMetadataRuntimeSupported\(\)\s*\{/,
  (m) => `${m} ${MARK} return false;`,
  'Decart SDK (worker de latencia)'));
// 2) LiveKit (versión ESM, la que usa esbuild)
results.push(patch(
  path.join(root, 'livekit-client/dist/livekit-client.esm.mjs'),
  /this\.trackBitrates\.push\(info\);/,
  `${MARK} void info;`,
  'LiveKit'));
if (results.includes('missing') && results.every((r) => r === 'missing')) {
  console.error('No encontré las dependencias. Corre "npm install" primero.');
  process.exit(1);
}
console.log(`Parches WebRTC: ${results.filter((r) => r === 'ok').length} aplicados, ${results.filter((r) => r === 'ya').length} ya estaban.`);
