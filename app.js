'use strict';
(() => {
const $ = id => document.getElementById(id);
const MAX_SRC = 2400;   // lato lungo della foto salvata
const MAX_OUT = 2200;   // lato lungo della pagina finale

/* ================= Archivio (IndexedDB) ================= */
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((ok, ko) => {
    const r = indexedDB.open('scanner', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('docs', { keyPath: 'id' });
    r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((ok, ko) => {
    const t = db.transaction('docs', mode), s = t.objectStore('docs'); const r = fn(s);
    t.oncomplete = () => ok(r && r.result); t.onerror = () => ko(t.error); }); };
  return {
    all: () => tx('readonly', s => s.getAll()),
    put: d => tx('readwrite', s => s.put(d)),
    del: id => tx('readwrite', s => s.delete(id)),
  };
})();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ================= Interfaccia generale ================= */
let docs = [], cur = null, deferredInstall = null;
function show(id) { document.querySelectorAll('.screen').forEach(s => s.hidden = s.id !== id); window.scrollTo(0, 0); }
function busy(msg) { $('busy').hidden = !msg; if (msg) $('busyMsg').textContent = msg; }
let toastT; function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); }
const urls = new Map();
const urlOf = blob => { if (!urls.has(blob)) urls.set(blob, URL.createObjectURL(blob)); return urls.get(blob); };
const fmtDate = t => new Date(t).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

async function renderHome() {
  docs = (await idb.all()).sort((a, b) => b.updated - a.updated);
  $('emptyHome').hidden = docs.length > 0;
  $('docList').innerHTML = '';
  for (const d of docs) {
    const b = document.createElement('button'); b.className = 'item';
    const img = document.createElement('img'); img.alt = ''; if (d.pages[0]) img.src = urlOf(d.pages[0].out);
    const txt = document.createElement('div'); const n = document.createElement('b'); n.textContent = d.name;
    const m = document.createElement('span'); m.textContent = `${d.pages.length} ${d.pages.length === 1 ? 'pagina' : 'pagine'} · ${fmtDate(d.updated)}`;
    txt.append(n, m); b.append(img, txt); b.onclick = () => openDoc(d); $('docList').append(b);
  }
  show('home');
}
function renderDoc() {
  $('docName').value = cur.name;
  $('pages').innerHTML = '';
  cur.pages.forEach((p, i) => {
    const b = document.createElement('button'); b.className = 'page'; b.setAttribute('aria-label', 'Pagina ' + (i + 1));
    const img = document.createElement('img'); img.src = urlOf(p.out); img.alt = '';
    const n = document.createElement('i'); n.textContent = i + 1;
    b.append(img, n); b.onclick = () => editPage(i, false); $('pages').append(b);
  });
}
function openDoc(d) { cur = d; renderDoc(); show('doc'); }
async function saveDoc() { cur.updated = Date.now(); await idb.put(cur); }

/* ================= Foto in ingresso ================= */
async function loadImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const sc = Math.min(1, MAX_SRC / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.9));
  return { blob, canvas: c };
}
let queue = [];
async function addFiles(files, newDoc) {
  files = [...files].filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
  if (!files.length) { toast('Scegli delle immagini (JPG, PNG).'); return; }
  if (newDoc || !cur) {
    cur = { id: uid(), name: 'Scansione ' + new Date().toLocaleDateString('it-IT') + ' ' + new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }), pages: [], updated: Date.now() };
  }
  queue = files; nextInQueue();
}
async function nextInQueue() {
  const f = queue.shift();
  if (!f) { renderDoc(); show('doc'); return; }
  busy('Preparo la foto...');
  try {
    const { blob, canvas } = await loadImage(f);
    const corners = detectCorners(canvas);
    const page = { id: uid(), src: blob, corners, filter: 'migliorata', rot: 0, out: null, isNew: true };
    cur.pages.push(page);
    busy(); editPage(cur.pages.length - 1, true, canvas);
  } catch (e) { busy(); toast('Non riesco ad aprire questa foto (prova JPG o PNG).'); nextInQueue(); }
}
document.querySelectorAll('input[type=file]').forEach(inp => inp.addEventListener('change', e => {
  const l = [...e.target.files]; e.target.value = ''; addFiles(l, !!inp.dataset.new);
}));
// Mac / computer: trascina le foto o incollale
document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
document.addEventListener('drop', e => {
  e.preventDefault(); document.body.classList.remove('dragging');
  if (!$('editor').hidden) return;
  addFiles(e.dataTransfer.files, $('doc').hidden);
});
document.addEventListener('paste', e => {
  if (!$('editor').hidden || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  const f = [...(e.clipboardData?.files || [])]; if (f.length) addFiles(f, $('doc').hidden);
});

/* ================= Rilevamento automatico dei bordi ================= */
function detectCorners(src) {
  const W = src.width, H = src.height, s = 200 / Math.max(W, H);
  const w = Math.max(2, Math.round(W * s)), h = Math.max(2, Math.round(H * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h), hist = new Array(256).fill(0);
  for (let i = 0; i < w * h; i++) { const v = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) | 0; g[i] = v; hist[v]++; }
  // soglia di Otsu: separa il foglio chiaro dallo sfondo
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = w * h - wB; if (!wF) break; sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; th = t; } }
  // componente chiara più grande
  const lab = new Int32Array(w * h).fill(-1); let bestN = 0, bestL = -1, L = 0; const st = [];
  for (let i = 0; i < w * h; i++) {
    if (g[i] <= th || lab[i] !== -1) continue;
    let n = 0; st.push(i); lab[i] = L;
    while (st.length) { const p = st.pop(); n++; const x = p % w, y = (p / w) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1])
        if (q >= 0 && lab[q] === -1 && g[q] > th) { lab[q] = L; st.push(q); } }
    if (n > bestN) { bestN = n; bestL = L; } L++;
  }
  const inset = () => [[W * .06, H * .06], [W * .94, H * .06], [W * .94, H * .94], [W * .06, H * .94]];
  if (bestN < w * h * 0.12 || bestN > w * h * 0.97) return inset();
  let tl, tr, br, bl, a = Infinity, b = -Infinity, cc = -Infinity, dd = Infinity;
  for (let i = 0; i < w * h; i++) { if (lab[i] !== bestL) continue; const x = i % w, y = (i / w) | 0;
    if (x + y < a) { a = x + y; tl = [x, y]; } if (x + y > b) { b = x + y; br = [x, y]; }
    if (x - y > cc) { cc = x - y; tr = [x, y]; } if (x - y < dd) { dd = x - y; bl = [x, y]; } }
  return [tl, tr, br, bl].map(([x, y]) => [Math.min(W, Math.max(0, (x + .5) / s)), Math.min(H, Math.max(0, (y + .5) / s))]);
}

/* ================= Raddrizzamento prospettico ================= */
function solve(A, b) { // eliminazione di Gauss
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let m = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r;
    [A[i], A[m]] = [A[m], A[i]]; [b[i], b[m]] = [b[m], b[i]];
    for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  const x = new Array(n); for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
  return x;
}
function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) { const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v); }
  return solve(A, b);
}
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
function warp(srcCanvas, q) {
  let ow = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), oh = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const sc = Math.min(1, MAX_OUT / Math.max(ow, oh)); ow = Math.max(1, Math.round(ow * sc)); oh = Math.max(1, Math.round(oh * sc));
  const h = homography([[0, 0], [ow, 0], [ow, oh], [0, oh]], q);
  const sw = srcCanvas.width, sh = srcCanvas.height, sd = srcCanvas.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = new ImageData(ow, oh), od = out.data;
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const den = h[6] * x + h[7] * y + 1, fx = (h[0] * x + h[1] * y + h[2]) / den, fy = (h[3] * x + h[4] * y + h[5]) / den;
    const x0 = Math.max(0, Math.min(sw - 2, fx | 0)), y0 = Math.max(0, Math.min(sh - 2, fy | 0)), ax = Math.min(1, Math.max(0, fx - x0)), ay = Math.min(1, Math.max(0, fy - y0));
    const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4, o = (y * ow + x) * 4;
    for (let k = 0; k < 3; k++) od[o + k] = (sd[i00 + k] * (1 - ax) + sd[i10 + k] * ax) * (1 - ay) + (sd[i01 + k] * (1 - ax) + sd[i11 + k] * ax) * ay;
    od[o + 3] = 255;
  }
  const c = document.createElement('canvas'); c.width = ow; c.height = oh; c.getContext('2d').putImageData(out, 0, 0); return c;
}

/* ================= Filtri ================= */
const FILTERS = [['migliorata', 'Migliorata'], ['bn', 'Bianco e nero'], ['grigio', 'Grigi'], ['originale', 'Originale']];
function applyFilter(c, f) {
  if (f === 'originale') return c;
  const w = c.width, h = c.height, ctx = c.getContext('2d'), img = ctx.getImageData(0, 0, w, h), d = img.data;
  if (f === 'migliorata' || f === 'grigio') {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < d.length; i += 4) hist[(d[i] * .3 + d[i + 1] * .59 + d[i + 2] * .11) | 0]++;
    const n = w * h; let lo = 0, hi = 255, acc = 0;
    for (; lo < 255 && (acc += hist[lo]) < n * .01; lo++); acc = 0;
    for (; hi > 0 && (acc += hist[hi]) < n * .04; hi--);
    const r = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      if (f === 'grigio') { const v = (d[i] * .3 + d[i + 1] * .59 + d[i + 2] * .11 - lo) * 255 / r; d[i] = d[i + 1] = d[i + 2] = v; }
      else for (let k = 0; k < 3; k++) d[i + k] = (d[i + k] - lo) * 255 / r;
    }
  } else if (f === 'bn') { // soglia adattiva con immagine integrale
    const g = new Float32Array(w * h), I = new Float64Array((w + 1) * (h + 1));
    for (let i = 0; i < w * h; i++) g[i] = d[i * 4] * .3 + d[i * 4 + 1] * .59 + d[i * 4 + 2] * .11;
    for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) { s += g[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + s; } }
    const R = Math.max(8, Math.round(Math.max(w, h) / 40));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - R), y1 = Math.max(0, y - R), x2 = Math.min(w, x + R + 1), y2 = Math.min(h, y + R + 1);
      const m = (I[y2 * (w + 1) + x2] - I[y1 * (w + 1) + x2] - I[y2 * (w + 1) + x1] + I[y1 * (w + 1) + x1]) / ((x2 - x1) * (y2 - y1));
      const v = g[y * w + x] < m * 0.88 ? 0 : 255, o = (y * w + x) * 4; d[o] = d[o + 1] = d[o + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0); return c;
}
function rotate(c, rot) {
  if (!rot) return c;
  const o = document.createElement('canvas'), q = rot % 2 === 1;
  o.width = q ? c.height : c.width; o.height = q ? c.width : c.height;
  const ctx = o.getContext('2d'); ctx.translate(o.width / 2, o.height / 2); ctx.rotate(rot * Math.PI / 2); ctx.drawImage(c, -c.width / 2, -c.height / 2); return o;
}

/* ================= Editor ================= */
let ed = null; // {i, page, src (canvas), mode, corners, view:{s,ox,oy}, drag}
const cv = $('edCanvas');
async function editPage(i, isNew, srcCanvas) {
  const page = cur.pages[i];
  if (!srcCanvas) { busy('Apro la pagina...'); srcCanvas = (await loadImage(page.src)).canvas; busy(); }
  ed = { i, page, src: srcCanvas, corners: page.corners.map(p => p.slice()), filter: page.filter, rot: page.rot, isNew, processed: null };
  $('edCancel').onclick = cancelEdit;
  show('editor'); setMode(isNew ? 'crop' : 'filter');
}
function setMode(m) {
  ed.mode = m;
  $('cropTools').hidden = m !== 'crop'; $('filterTools').hidden = m !== 'filter';
  $('edTitle').textContent = m === 'crop' ? 'Sposta gli angoli sul foglio' : 'Scegli come appare';
  if (m === 'filter') process(); else draw();
}
function process() {
  busy('Raddrizzo il foglio...');
  setTimeout(() => {
    const flat = warp(ed.src, ed.corners); ed.flat = flat;
    refilter(); busy();
  }, 30);
}
function refilter() {
  const c = document.createElement('canvas'); c.width = ed.flat.width; c.height = ed.flat.height; c.getContext('2d').drawImage(ed.flat, 0, 0);
  ed.processed = rotate(applyFilter(c, ed.filter), ed.rot);
  $('filters').innerHTML = '';
  FILTERS.forEach(([k, l]) => { const b = document.createElement('button'); b.textContent = l; b.setAttribute('aria-pressed', ed.filter === k);
    b.onclick = () => { ed.filter = k; busy('Applico il filtro...'); setTimeout(() => { refilter(); busy(); }, 30); }; $('filters').append(b); });
  draw();
}
function fit(iw, ih) {
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  const pad = 28 * dpr, s = Math.min((cv.width - 2 * pad) / iw, (cv.height - 2 * pad) / ih);
  return { s, ox: (cv.width - iw * s) / 2, oy: (cv.height - ih * s) / 2, dpr };
}
function draw() {
  if (!ed || $('editor').hidden) return;
  const ctx = cv.getContext('2d');
  if (ed.mode === 'filter' && ed.processed) {
    const v = fit(ed.processed.width, ed.processed.height); ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(ed.processed, v.ox, v.oy, ed.processed.width * v.s, ed.processed.height * v.s); return;
  }
  const v = ed.view = fit(ed.src.width, ed.src.height);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(ed.src, v.ox, v.oy, ed.src.width * v.s, ed.src.height * v.s);
  const P = ed.corners.map(([x, y]) => [v.ox + x * v.s, v.oy + y * v.s]);
  ctx.beginPath(); P.forEach((p, k) => k ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.closePath();
  ctx.fillStyle = 'rgba(29,43,216,.18)'; ctx.fill(); ctx.lineWidth = 3 * v.dpr; ctx.strokeStyle = '#4f5dff'; ctx.stroke();
  P.forEach(p => { ctx.beginPath(); ctx.arc(p[0], p[1], 14 * v.dpr, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 4 * v.dpr; ctx.strokeStyle = '#1d2bd8'; ctx.stroke(); });
  if (ed.drag != null) { // lente d'ingrandimento sull'angolo
    const [x, y] = ed.corners[ed.drag], R = 60 * v.dpr, cx = P[ed.drag][0] < cv.width / 2 ? cv.width - R - 12 * v.dpr : R + 12 * v.dpr, cy = R + 12 * v.dpr;
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip();
    const z = 2.5 * v.s; ctx.drawImage(ed.src, cx - x * z, cy - y * z, ed.src.width * z, ed.src.height * z);
    ctx.restore(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.lineWidth = 3 * v.dpr; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - 10 * v.dpr, cy); ctx.lineTo(cx + 10 * v.dpr, cy); ctx.moveTo(cx, cy - 10 * v.dpr); ctx.lineTo(cx, cy + 10 * v.dpr); ctx.strokeStyle = '#4f5dff'; ctx.stroke();
  }
}
const toImg = e => { const r = cv.getBoundingClientRect(), v = ed.view; return [((e.clientX - r.left) * v.dpr - v.ox) / v.s, ((e.clientY - r.top) * v.dpr - v.oy) / v.s]; };
cv.addEventListener('pointerdown', e => {
  if (!ed || ed.mode !== 'crop') return;
  const p = toImg(e), lim = 40 * ed.view.dpr / ed.view.s;
  let k = -1, best = Infinity; ed.corners.forEach((c, i) => { const d = dist(c, p); if (d < best) { best = d; k = i; } });
  if (best > lim * 1.5) return;
  ed.drag = k; ed.off = [ed.corners[k][0] - p[0], ed.corners[k][1] - p[1]]; cv.setPointerCapture(e.pointerId); draw();
});
cv.addEventListener('pointermove', e => {
  if (!ed || ed.drag == null) return;
  const p = toImg(e); ed.corners[ed.drag] = [Math.min(ed.src.width, Math.max(0, p[0] + ed.off[0])), Math.min(ed.src.height, Math.max(0, p[1] + ed.off[1]))]; draw();
});
const endDrag = () => { if (ed && ed.drag != null) { ed.drag = null; draw(); } };
cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);
new ResizeObserver(draw).observe(cv);

$('edAll').onclick = () => { const W = ed.src.width, H = ed.src.height; ed.corners = [[0, 0], [W, 0], [W, H], [0, H]]; draw(); };
$('edAuto').onclick = () => { ed.corners = detectCorners(ed.src); draw(); };
$('edNext').onclick = () => setMode('filter');
$('edBackCrop').onclick = () => setMode('crop');
$('edRotate').onclick = () => { ed.rot = (ed.rot + 1) % 4; refilter(); };
$('edDelete').onclick = async () => {
  cur.pages.splice(ed.i, 1); ed = null;
  if (!cur.pages.length) { await idb.del(cur.id); queue = []; renderHome(); toast('Documento eliminato.'); return; }
  await saveDoc(); renderDoc(); nextOrDoc();
};
$('edDone').onclick = async () => {
  busy('Salvo...');
  const p = ed.page; p.corners = ed.corners; p.filter = ed.filter; p.rot = ed.rot; delete p.isNew;
  p.out = await new Promise(ok => ed.processed.toBlob(ok, 'image/jpeg', ed.filter === 'bn' ? 0.8 : 0.86));
  ed = null; await saveDoc(); busy(); nextOrDoc();
};
function cancelEdit() {
  if (ed.isNew) { cur.pages.splice(ed.i, 1); }
  ed = null;
  if (!cur.pages.length) { queue = []; renderHome(); return; }
  nextOrDoc();
}
function nextOrDoc() { if (queue.length) nextInQueue(); else { renderDoc(); show('doc'); } }

/* ================= Schermata documento ================= */
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => b.dataset.go === 'home' ? renderHome() : (renderDoc(), show(b.dataset.go)));
$('docName').onchange = async () => { cur.name = $('docName').value.trim() || cur.name; await saveDoc(); };
$('delDoc').onclick = async () => {
  if ($('delDoc').dataset.sure !== '1') { $('delDoc').dataset.sure = '1'; $('delDoc').textContent = 'Sicuro?'; setTimeout(() => { $('delDoc').dataset.sure = ''; $('delDoc').textContent = 'Elimina'; }, 3000); return; }
  $('delDoc').dataset.sure = ''; $('delDoc').textContent = 'Elimina';
  await idb.del(cur.id); cur = null; renderHome(); toast('Documento eliminato.');
};
const safeName = () => (cur.name || 'documento').replace(/[\\/:*?"<>|]/g, '').trim() || 'documento';
async function deliver(blob, filename, type) {
  const file = new File([blob], filename, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); toast('Salvato: ' + filename);
}
const blobToDataURL = b => new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(b); });
$('pdfBtn').onclick = async () => {
  if (!cur.pages.length) return;
  busy('Creo il PDF...');
  try {
    const { jsPDF } = window.jspdf; let pdf;
    for (const [i, p] of cur.pages.entries()) {
      const bmp = await createImageBitmap(p.out), land = bmp.width > bmp.height;
      const fmt = 'a4', orient = land ? 'l' : 'p';
      if (!i) pdf = new jsPDF({ orientation: orient, unit: 'pt', format: fmt, compress: true }); else pdf.addPage(fmt, orient);
      const W = pdf.internal.pageSize.getWidth(), H = pdf.internal.pageSize.getHeight(), s = Math.min(W / bmp.width, H / bmp.height);
      const w = bmp.width * s, h = bmp.height * s;
      pdf.addImage(await blobToDataURL(p.out), 'JPEG', (W - w) / 2, (H - h) / 2, w, h, undefined, 'FAST');
    }
    const blob = pdf.output('blob'); busy(); await deliver(blob, safeName() + '.pdf', 'application/pdf');
  } catch (e) { busy(); toast('Non sono riuscito a creare il PDF.'); }
};

/* ================= Testo (OCR, funziona senza internet) ================= */
let worker = null;
function loadScript(src) { return new Promise((ok, ko) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = ko; document.head.append(s); }); }
$('ocrBtn').onclick = async () => {
  if (!cur.pages.length) return;
  show('text'); $('ocrText').value = ''; const st = $('ocrStatus');
  try {
    if (!worker) {
      st.textContent = 'Preparo la lettura del testo (la prima volta ci vuole un po\')...';
      if (!window.Tesseract) await loadScript('vendor/tesseract.min.js');
      worker = await Tesseract.createWorker('ita', 1, { workerPath: 'vendor/worker.min.js', corePath: 'vendor/core', langPath: 'vendor/lang', gzip: true });
    }
    let all = [];
    for (const [i, p] of cur.pages.entries()) {
      st.textContent = `Leggo la pagina ${i + 1} di ${cur.pages.length}...`;
      const { data } = await worker.recognize(p.out);
      all.push(data.text.trim()); $('ocrText').value = all.join('\n\n');
    }
    st.textContent = 'Fatto. Puoi correggere il testo qui sotto.';
  } catch (e) { st.textContent = 'Non sono riuscito a leggere il testo. Riprova.'; }
};
$('copyTxt').onclick = async () => { try { await navigator.clipboard.writeText($('ocrText').value); toast('Testo copiato.'); } catch (e) { $('ocrText').select(); toast('Seleziona e copia il testo.'); } };
$('shareTxt').onclick = async () => {
  const t = $('ocrText').value;
  if (navigator.share) { try { await navigator.share({ title: cur.name, text: t }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  deliver(new Blob([t], { type: 'text/plain;charset=utf-8' }), safeName() + '.txt', 'text/plain');
};
$('wordBtn').onclick = () => deliver(makeDocx(cur.name, $('ocrText').value), safeName() + '.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

/* ================= File Word (.docx) ================= */
const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = d => { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = crcT[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zip(files, type) {
  const enc = new TextEncoder(), parts = [], cd = []; let off = 0;
  const put = (dv, list) => list.forEach(([o, v, s]) => s === 4 ? dv.setUint32(o, v, true) : dv.setUint16(o, v, true));
  for (const [name, str] of files) {
    const n = enc.encode(name), d = enc.encode(str), crc = crc32(d);
    const h = new DataView(new ArrayBuffer(30)); put(h, [[0, 0x04034b50, 4], [4, 20, 2], [6, 0, 2], [8, 0, 2], [10, 0, 2], [12, 0x21, 2], [14, crc, 4], [18, d.length, 4], [22, d.length, 4], [26, n.length, 2], [28, 0, 2]]);
    const c = new DataView(new ArrayBuffer(46)); put(c, [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0, 2], [10, 0, 2], [12, 0, 2], [14, 0x21, 2], [16, crc, 4], [20, d.length, 4], [24, d.length, 4], [28, n.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, off, 4]]);
    parts.push(h, n, d); cd.push(c, n); off += 30 + n.length + d.length;
  }
  const size = cd.reduce((a, p) => a + p.byteLength, 0), e = new DataView(new ArrayBuffer(22));
  put(e, [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, size, 4], [16, off, 4], [20, 0, 2]]);
  return new Blob([...parts, ...cd, e], { type });
}
function makeDocx(title, text) {
  const x = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const para = (t, sz, b) => `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>${b ? '<w:b/>' : ''}<w:sz w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${x(t)}</w:t></w:r></w:p>`;
  const body = para(title, 36, true) + text.split(/\n/).map(l => para(l, 22)).join('');
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`]
  ], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

/* ================= Installazione e offline ================= */
const isDesktop = !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
if (isDesktop) { // su Mac/PC la fotocamera non serve: si scelgono o trascinano i file
  document.querySelectorAll('.fab:not(.secondary)').forEach(l => l.firstChild.textContent = 'Scegli foto');
  document.querySelectorAll('.fab.secondary').forEach(l => l.hidden = true);
  document.querySelectorAll('.act').forEach(l => { if (l.firstChild.textContent === '＋ Foto') l.hidden = true; });
  $('emptyHome').querySelector('p').innerHTML = '<b>Nessun documento</b><br>Trascina qui le foto o le scansioni, oppure premi <b>Scegli foto</b>.';
  document.body.classList.add('desktop');
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; $('installBtn').hidden = false; });
$('installBtn').onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('installBtn').hidden = true; };
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

renderHome().catch(() => { show('home'); toast('Archivio non disponibile in questo browser.'); });
window.__scanner = { detectCorners, warp, applyFilter, makeDocx };
})();
