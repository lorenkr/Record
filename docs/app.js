/* Vinyl Player for the phone — a turntable that spins whatever you're playing on Spotify.
 *
 * The turntable is a physical object made of layers: the plinth, platter, tonearm and controls are
 * SVG (deck.js), the record and its label are drawn on canvases, and everything that moves only
 * rotates / fades, so motion stays smooth. Spotify is reached with the PKCE login (no client
 * secret), so the whole app is static files that can be added to the iPhone home screen.
 *
 * Open with ?demo to preview without Spotify.
 */
'use strict';
const APP_VERSION = 6;

// --- Behaviour ---------------------------------------------------------------
const POLL_MS = 1500;          // how often Spotify is asked what's playing
const SPEEDS = { 33: 360 / 1.8, 45: 360 / (4 / 3) };   // deg/s: 33⅓ rpm = 1.8 s a turn, 45 rpm = 1.333 s
const SPIN_UP = 0.7, SPIN_DOWN = 1.5;                  // seconds
const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';

// --- Turntable geometry (see deck.js; the record's radius is 100 units) -------
const DG = Deck.G;
// The parts sit straight on the surface, set into it, with no plinth or platter (?plinth shows the full deck).
const BARE = !new URLSearchParams(location.search).has('plinth');
const LABEL_R = 0.34;

const TAU = Math.PI * 2;
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rgba = (r, g, b, a = 255) => `rgba(${r | 0},${g | 0},${b | 0},${(a / 255).toFixed(3)})`;
const gray = (v, a = 255) => rgba(v, v, v, a);
const ease = {
  inOut: k => k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2,
  out: k => 1 - (1 - k) ** 3,
  sine: k => -(Math.cos(Math.PI * k) - 1) / 2,
};

function rng(seed) {   // mulberry32: same "random" record every time
  if (typeof seed === 'string') { let h = 2166136261; for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); seed = h; }
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, uniform: (lo, hi) => lo + (hi - lo) * next(), int: (lo, hi) => lo + Math.floor((hi - lo + 1) * next()) };
}

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}
function circle(p, x, y, r) { p.beginPath(); p.arc(x, y, Math.max(0, r), 0, TAU); }
function fillCircle(p, x, y, r, style) { circle(p, x, y, r); p.fillStyle = style; p.fill(); }
function strokeCircle(p, x, y, r) { circle(p, x, y, r); p.stroke(); }
function roundRect(p, x, y, w, h, r) {
  p.beginPath();
  p.moveTo(x + r, y); p.arcTo(x + w, y, x + w, y + h, r); p.arcTo(x + w, y + h, x, y + h, r);
  p.arcTo(x, y + h, x, y, r); p.arcTo(x, y, x + w, y, r); p.closePath();
}
// Qt's conical gradient runs counter-clockwise from `angle`; the canvas one runs clockwise.
function conic(p, x, y, qtAngle, stops) {
  const g = p.createConicGradient(rad(-qtAngle), x, y);
  [...stops].map(([pos, col]) => [1 - pos, col]).sort((a, b) => a[0] - b[0]).forEach(([pos, col]) => g.addColorStop(pos, col));
  return g;
}
function annulusClip(p, x, y, outer, inner) {
  p.beginPath(); p.arc(x, y, outer, 0, TAU); p.moveTo(x + inner, y); p.arc(x, y, inner, 0, TAU, true); p.clip('evenodd');
}

// =============================================================================
//  Rendering (all at device-pixel resolution)
// =============================================================================
function renderDisc(n) {
  const cv = makeCanvas(n), p = cv.getContext('2d');
  const c = n / 2, R = n / 2, rnd = rng(33);

  let g = p.createRadialGradient(c, c, 0, c, c, R);
  g.addColorStop(0, 'rgb(30,30,32)'); g.addColorStop(1, 'rgb(12,12,13)');
  fillCircle(p, c, c, R, g);
  fillCircle(p, c, c, R * (LABEL_R + 0.10), 'rgb(20,20,22)');   // glossy run-out area

  // Grooves: many fine concentric rings with slightly varying brightness.
  const start = R * (LABEL_R + 0.10), end = R * 0.965;
  const gaps = Array.from({ length: 6 }, () => rnd.uniform(start + R * 0.05, end - R * 0.05)).sort((a, b) => a - b);
  const step = Math.max(1, n / 900);
  p.lineWidth = step * 0.55;
  for (let r = start; r < end; r += step) {
    if (gaps.some(gp => Math.abs(r - gp) < R * 0.009)) continue;
    p.strokeStyle = gray(255, rnd.int(5, 17));
    strokeCircle(p, c, c, r);
  }
  // Track gaps between songs.
  p.lineWidth = R * 0.012; p.strokeStyle = rgba(48, 48, 52, 200);
  gaps.forEach(gp => strokeCircle(p, c, c, gp));
  // Lead-in groove and rounded rim.
  p.lineWidth = R * 0.02; p.strokeStyle = 'rgb(40,40,44)'; strokeCircle(p, c, c, R * 0.978);
  const rimW = Math.max(1, R * 0.006);
  p.lineWidth = rimW; p.strokeStyle = rgba(85, 85, 90, 220); strokeCircle(p, c, c, R - rimW / 2);

  // Uneven sheen pressed into the vinyl — it turns with the record, so you can see it spin.
  p.save();
  annulusClip(p, c, c, R * 0.97, R * (LABEL_R + 0.02));
  p.fillStyle = conic(p, c, c, rnd.uniform(0, 360), [[0, 0], [0.07, 30], [0.16, 4], [0.31, 22], [0.42, 0], [0.58, 14],
    [0.66, 36], [0.75, 6], [0.88, 20], [1, 0]].map(([s, a]) => [s, gray(255, a)]));
  p.fillRect(0, 0, n, n);
  p.restore();

  // A few hairline scratches.
  p.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const rr = rnd.uniform(R * (LABEL_R + 0.12), R * 0.93), st = rnd.uniform(0, 360), span = rnd.uniform(8, 28);
    p.strokeStyle = gray(255, rnd.int(35, 70)); p.lineWidth = Math.max(0.8, step * 0.8);
    p.beginPath(); p.arc(c, c, rr, rad(-st - span), rad(-st)); p.stroke();
  }
  // A little dust — it turns with the record and makes the spin readable.
  for (let i = 0, k = Math.floor(110 + n / 8); i < k; i++) {
    const a = rnd.uniform(0, TAU), rr = rnd.uniform(R * (LABEL_R + 0.02), R * 0.97), s = rnd.uniform(0.5, 1.6) * step;
    fillCircle(p, c + rr * Math.cos(a), c + rr * Math.sin(a), s, gray(255, rnd.int(25, 75)));
  }
  return cv;
}

function renderSheen(n, dpr = 1) {   // light on the grooves + the record's edge — fixed to the light, it does NOT turn
  const cv = makeCanvas(n), p = cv.getContext('2d');
  const c = n / 2, R = n / 2;
  p.save();
  annulusClip(p, c, c, R * 0.992, R * (LABEL_R + 0.01));
  // Anisotropic highlight: two opposite bright wedges on the axis of the top-left light,
  // the one nearer the light brighter. The grooves and label turn underneath it.
  const g = p.createConicGradient(0, c, c);
  for (let i = 0; i <= 120; i++) {
    const a = i / 120 * TAU, near = Math.max(0, Math.cos(a - rad(225))), far = Math.max(0, Math.cos(a - rad(45)));
    const alpha = 0.34 * near ** 40 + 0.20 * far ** 40 + 0.07 * near ** 5 + 0.035 * far ** 5;
    g.addColorStop(i / 120, `rgba(255,255,255,${alpha.toFixed(4)})`);
  }
  p.fillStyle = g; p.fillRect(0, 0, n, n);
  const lin = p.createLinearGradient(0, 0, n, n);
  lin.addColorStop(0, gray(255, 14)); lin.addColorStop(0.5, gray(255, 0)); lin.addColorStop(1, gray(0, 55));
  p.fillStyle = lin; p.fillRect(0, 0, n, n);
  p.restore();
  // The record's edge: a 1–2 px lighter bevel, bright where it faces the light.
  const w = 1.6 * dpr, edge = p.createLinearGradient(0, 0, n, n);
  edge.addColorStop(0, 'rgba(255,255,255,.55)'); edge.addColorStop(0.45, 'rgba(255,255,255,.16)');
  edge.addColorStop(0.7, 'rgba(255,255,255,.05)'); edge.addColorStop(1, 'rgba(0,0,0,.35)');
  p.lineWidth = w; p.strokeStyle = edge; strokeCircle(p, c, c, R - w / 2);
  p.lineWidth = dpr * 0.6; p.strokeStyle = 'rgba(0,0,0,.6)'; strokeCircle(p, c, c, R - w - dpr * 0.3);
  return cv;
}

function renderLabel(art, n) {   // circular paper label: album art, or a classic red label
  const cv = makeCanvas(n), p = cv.getContext('2d');
  const c = n / 2, r = n / 2;
  p.save();
  circle(p, c, c, r); p.clip();
  if (art) {
    p.imageSmoothingQuality = 'high';
    p.drawImage(art, 0, 0, n, n);
  } else {
    const g = p.createRadialGradient(c, c, 0, c, c, r);
    g.addColorStop(0, 'rgb(190,40,45)'); g.addColorStop(1, 'rgb(120,18,24)');
    p.fillStyle = g; p.fillRect(0, 0, n, n);
    p.strokeStyle = rgba(255, 225, 200, 130); p.lineWidth = Math.max(1, n / 160);
    strokeCircle(p, c, c, r * 0.88); strokeCircle(p, c, c, r * 0.30);
    p.fillStyle = rgba(255, 230, 205, 220); p.textAlign = 'center'; p.textBaseline = 'middle';
    p.font = `600 ${Math.max(6, n * 0.11) | 0}px ${FONT}`;
    p.letterSpacing = `${n * 0.011}px`;
    p.fillText('VINYL', c, n * 0.26);
    p.font = `600 ${Math.max(5, n * 0.07) | 0}px ${FONT}`;
    p.fillText('33⅓ RPM', c, n * 0.73);
  }
  // Paper look: slight vignette and a pressed edge.
  const v = p.createRadialGradient(c, c, 0, c, c, r);
  v.addColorStop(0, gray(0, 0)); v.addColorStop(0.75, gray(0, 10)); v.addColorStop(1, gray(0, 90));
  p.fillStyle = v; p.fillRect(0, 0, n, n);
  p.restore();
  const ew = Math.max(1, n / 220);
  p.strokeStyle = gray(0, 120); p.lineWidth = ew; strokeCircle(p, c, c, r - ew / 2);
  return cv;
}

// =============================================================================
//  Album art: label image + the cover's colors for the background
// =============================================================================
function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((h / 6) + 1) % 1, mx ? d / mx : 0, mx];
}
function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}

function medianCut(px, k) {
  let boxes = [px];
  while (boxes.length < k) {
    let best = -1, bi = -1, ch = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const p of b) { lo = Math.min(lo, p[c]); hi = Math.max(hi, p[c]); }
        if (hi - lo > best) { best = hi - lo; bi = i; ch = c; }
      }
    });
    if (bi < 0 || best <= 0) break;
    const b = boxes[bi].sort((a, z) => a[ch] - z[ch]), m = b.length >> 1;
    boxes.splice(bi, 1, b.slice(0, m), b.slice(m));
  }
  return boxes.map(b => {
    const s = [0, 0, 0]; b.forEach(p => { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; });
    return { count: b.length, rgb: s.map(v => v / b.length) };
  });
}

function extractPalette(data, k = 5) {   // the cover's most prominent colors, vivid ones first, made bolder
  const px = [];
  for (let i = 0; i < data.length; i += 4) px.push([data[i], data[i + 1], data[i + 2]]);
  const found = medianCut(px, 10).map(({ count, rgb: [r, g, b] }) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0;
    return [count * (0.35 + sat) * (0.4 + mx / 255), [r, g, b]];
  }).sort((a, b) => b[0] - a[0]);
  const picked = [];
  for (const [, c] of found) {   // skip near-duplicates
    if (picked.every(o => c.reduce((s, v, i) => s + (v - o[i]) ** 2, 0) > 45 ** 2)) picked.push(c);
    if (picked.length === k) break;
  }
  const out = (picked.length ? picked : [[110, 80, 200]]).map(([r, g, b]) => {
    let [h, s, v] = rgbToHsv(r / 255, g / 255, b / 255);
    if (s > 0.08) { s = Math.min(1, s * 1.45 + 0.12); v = Math.min(1, Math.max(v, 0.5) * 1.15); }
    return hsvToRgb(h, s, v).map(c => Math.round(c * 255));
  });
  while (out.length < 3) out.push(out[out.length - 1]);
  return out;
}

let artSerial = 0;
function processArt(src) {
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height, s = Math.min(w, h);
  const label = makeCanvas(640), lp = label.getContext('2d');
  lp.imageSmoothingQuality = 'high';
  lp.drawImage(src, (w - s) / 2, (h - s) / 2, s, s, 0, 0, 640, 640);
  let palette = [[110, 80, 200], [60, 40, 120], [200, 90, 140]], lum = 0.2;
  try {
    const small = makeCanvas(64), sp = small.getContext('2d', { willReadFrequently: true });
    sp.drawImage(label, 0, 0, 64, 64);
    const data = sp.getImageData(0, 0, 64, 64).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    lum = sum / (data.length / 4) / 255;
    palette = extractPalette(data);
  } catch (e) { console.warn('Could not read the cover colors', e); }
  return { id: ++artSerial, label, palette, lum };
}

function loadArt(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(processArt(img));
    img.onerror = reject;
    img.src = url;
  });
}

function demoArt() {
  const c = makeCanvas(640), p = c.getContext('2d'), im = p.createImageData(640, 640);
  for (let y = 0; y < 640; y++) for (let x = 0; x < 640; x++) {
    const i = (y * 640 + x) * 4;
    im.data[i] = 230 - y * 0.15; im.data[i + 1] = 120 + x * 0.12; im.data[i + 2] = 90 + (x + y) * 0.1; im.data[i + 3] = 255;
  }
  p.putImageData(im, 0, 0);
  return processArt(c);
}

let grainTile = null;
function getGrain() {   // a tile of film grain, made once and repeated
  if (!grainTile) {
    grainTile = makeCanvas(256);
    const p = grainTile.getContext('2d'), im = p.createImageData(256, 256), r = rng(7);
    for (let i = 0; i < im.data.length; i += 4) {
      const g = (r.next() + r.next() + r.next() - 1.5) * 2;   // roughly gaussian
      const v = clamp(128 + g * 110, 0, 255);
      im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255;
    }
    p.putImageData(im, 0, 0);
  }
  return grainTile;
}

// =============================================================================
//  A view = one canvas the turntable is drawn into (the screen, or the floating window)
// =============================================================================
class View {
  constructor(canvas, { withText = false } = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.withText = withText;
    this.cache = new Map();
  }
  cached(key, make) {
    if (!this.cache.has(key)) this.cache.set(key, make());
    return this.cache.get(key);
  }
  forgetArt(keep) {   // drop backgrounds/labels for covers no longer shown
    for (const k of this.cache.keys()) {
      const m = /^(bg|label):(\d+):/.exec(k);
      if (m && !keep.includes(+m[2])) this.cache.delete(k);
    }
  }
  forgetSize() { this.cache.clear(); }
}

function background(view, art, L, dpr) {
  const { W, H, deck } = L;
  return view.cached(`bg:${art.id}:${W}x${H}:${deck.x.toFixed(1)},${deck.y.toFixed(1)},${deck.w.toFixed(1)}:${dpr}:${L.portrait}`, () => {
    // A grainy mesh gradient of the cover's colors — the room the turntable stands in.
    const pal = art.palette.map(c => [...c]);
    const cv = makeCanvas(W * dpr, H * dpr), q = cv.getContext('2d');
    q.scale(dpr, dpr);
    q.fillStyle = rgba(...pal[0]); q.fillRect(0, 0, W, H);
    const rnd = rng(String(art.palette));
    const spots = [[0.05, 0.10, 0.80], [0.95, 0.05, 0.75], [0.80, 1.00, 0.85], [0.25, 1.05, 0.70], [0.55, 0.40, 0.55]];
    const cols = [...pal.slice(1), pal[0]];
    spots.forEach(([fx, fy, fr], i) => {
      const col = cols[i]; if (!col) return;
      const x = (fx + rnd.uniform(-0.08, 0.08)) * W, y = (fy + rnd.uniform(-0.15, 0.15)) * H, r = fr * Math.max(W, H) * 0.7;
      const g = q.createRadialGradient(x, y, 0, x, y, r);
      for (const [s, a] of [[0, 255], [0.4, 200], [0.75, 70], [1, 0]]) g.addColorStop(s, rgba(...col, a));
      q.fillStyle = g; q.fillRect(0, 0, W, H);
    });

    // Readability: a dark veil behind the text (stronger on bright covers) + soft vignette.
    const a = (110 + 120 * art.lum) * 0.7;
    if (L.portrait) {
      const y0 = deck.y + deck.h * 0.8;
      const veil = q.createLinearGradient(0, y0, 0, H);
      veil.addColorStop(0, gray(0, 0)); veil.addColorStop(0.3, gray(0, a * 0.6)); veil.addColorStop(1, gray(0, a));
      q.fillStyle = veil; q.fillRect(0, y0, W, H - y0);
    } else {
      const end = Math.max(1, deck.x + deck.w * 0.1);
      const veil = q.createLinearGradient(0, 0, end, 0);
      veil.addColorStop(0, gray(0, a)); veil.addColorStop(0.7, gray(0, a * 0.6)); veil.addColorStop(1, gray(0, 0));
      q.fillStyle = veil; q.fillRect(0, 0, end, H);
    }
    const cx = deck.x + deck.w / 2, cy = deck.y + deck.h / 2;
    const vig = q.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.75);
    vig.addColorStop(0.45, gray(0, 0)); vig.addColorStop(1, gray(0, 130));
    q.fillStyle = vig; q.fillRect(0, 0, W, H);

    // Film grain, one speck per screen pixel.
    q.setTransform(1, 0, 0, 1, 0, 0);
    q.globalAlpha = 0.28; q.globalCompositeOperation = 'overlay';
    q.fillStyle = q.createPattern(getGrain(), 'repeat'); q.fillRect(0, 0, cv.width, cv.height);
    return cv;
  });
}

function drawBackground(view, L, dpr, S) {
  const p = view.ctx, { W, H, deck } = L;
  p.setTransform(dpr, 0, 0, dpr, 0, 0);
  p.globalAlpha = 1; p.globalCompositeOperation = 'source-over';
  p.fillStyle = 'rgb(20,19,20)'; p.fillRect(0, 0, W, H);
  // cross-fades when the cover changes
  for (const [art, alpha] of [[S.prevArt, 1], [S.art, S.artFade]]) {
    if (art && alpha > 0) { p.globalAlpha = alpha; p.drawImage(background(view, art, L, dpr), 0, 0, W, H); }
  }
  p.globalAlpha = 1;
  if (!S.art && !S.prevArt) {
    const cx = deck.x + deck.w / 2, cy = deck.y + deck.h / 2;
    const vig = p.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.75);
    vig.addColorStop(0, 'rgb(52,48,50)'); vig.addColorStop(1, 'rgb(14,13,14)');
    p.fillStyle = vig; p.fillRect(0, 0, W, H);
  }
}

// =============================================================================
//  The deck's layers, bottom to top. Static ones are SVG drawn once; moving ones only get a
//  transform (rotate / translate / scale) and an opacity each frame.
// =============================================================================
const LAYERS = [
  ['base', (s, R) => Deck.base(s, R, BARE)],
  ['d33', (s, R) => Deck.dots(s, R, 33)],
  ['d45', (s, R) => Deck.dots(s, R, 45)],
  ['glow', s => Deck.lampGlow(s)],
  ['record'], ['sheen'],
  ['spindle', s => Deck.spindle(s)],
  ['sh1', s => Deck.armShadow(s, 5, 'sh1')],     // arm shadow resting on the record
  ['sh2', s => Deck.armShadow(s, 10, 'sh2')],    // …and the softer, further one when it's raised
  ['contact'],
  ['arm', s => Deck.arm(s)],
  ['pivot', s => Deck.pivotTop(s)],
  ['clip', s => Deck.restClip(s)],
  ['cue', s => Deck.cueLever(s)],
].filter(([k]) => !(BARE && ['d33', 'd45', 'glow'].includes(k)));

function deckPose() {
  const A = S.arm, onRecord = A.angle > DG.rest + 4;
  // a slightly eccentric record: the arm sways ±0.15° once per turn while it plays
  const wobble = onRecord ? 0.15 * (1 - A.lift) * Math.sin(rad(S.discAngle)) : 0;
  return { disc: S.discAngle, d33: S.dot33, d45: S.dot45, arm: A.angle + wobble, lift: A.lift,
    contact: onRecord ? clamp(1 - A.lift * 6, 0, 1) : 0, cue: A.lift };
}

function poseFor(key, P) {   // { rot (deg), scale, dx, dy (px), alpha } — null for static layers
  switch (key) {
    case 'd33': return { rot: P.d33 };
    case 'd45': return { rot: P.d45 };
    case 'record': return { rot: P.disc };
    case 'sh1': case 'sh2': {
      // floating ~15–20 mm above the record; lifting pushes the shadow further and softer
      const off = 5 + 7 * P.lift;
      return { rot: P.arm, scale: 1 + 0.02 * P.lift, dx: off, dy: off, alpha: key === 'sh1' ? 0.42 * (1 - P.lift) : 0.34 * P.lift };
    }
    case 'contact': return { rot: P.arm, alpha: P.contact };
    case 'arm': return { rot: P.arm, scale: 1 + 0.02 * P.lift };
    case 'cue': return { rot: 40 - 30 * P.cue };
    default: return null;
  }
}

function wrapLines(p, text, width, maxLines) {
  const words = text.split(/\s+/).filter(Boolean), lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (p.measureText(t).width <= width || !cur) cur = t; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && p.measureText(last + '…').width > width) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines.map(l => { while (p.measureText(l).width > width && l.length > 1) l = l.slice(0, -2) + '…'; return l; });
}

function drawCanvasText(p, L, [eyebrow, title, artist, album]) {   // for the floating window
  const { x, w, yc, h } = L.text;
  if (w < 60) return;
  const font = FONT;
  let size = Math.min(h * 0.2, w * 0.16);
  let blocks;
  for (; ;) {
    blocks = [];
    const add = (text, px, weight, alpha, maxLines, spacing = 0) => {
      if (!text) return;
      p.font = `${weight} ${px}px ${font}`; p.letterSpacing = `${spacing}px`;
      blocks.push({ px, weight, alpha, spacing, lines: wrapLines(p, text, w, maxLines) });
    };
    add(eyebrow, Math.max(9, size * 0.30), 600, 175, 1, size * 0.04);
    add(title, size, 700, 255, 2);
    add(artist, Math.max(10, size * 0.52), 500, 235, 1);
    add(album, Math.max(9, size * 0.40), 400, 165, 1);
    const total = blocks.reduce((s, b) => s + b.lines.length * b.px * 1.15 + size * 0.2, 0);
    if (total <= h || size <= 12) { blocks.total = total; break; }
    size *= 0.92;
  }
  let y = yc - blocks.total / 2;
  p.textBaseline = 'top'; p.textAlign = 'left';
  for (const b of blocks) {
    p.font = `${b.weight} ${b.px}px ${font}`; p.letterSpacing = `${b.spacing}px`;
    for (const line of b.lines) {
      p.fillStyle = gray(0, 110); p.fillText(line, x, y + 1.5);
      p.fillStyle = gray(255, b.alpha); p.fillText(line, x, y);
      y += b.px * 1.15;
    }
    y += size * 0.2;
  }
  p.letterSpacing = '0px';
}

// =============================================================================
//  Layout
// =============================================================================
function insets() {
  const cs = getComputedStyle($('#safe'));
  return { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
}

const DB = BARE ? { x0: -114, x1: 162, y0: -138, y1: 116 } : DG.bounds, DECK_W = DB.x1 - DB.x0, DECK_H = DB.y1 - DB.y0;
function deckAt(s, x, y) {   // the plinth's top-left corner at (x, y), s px per unit
  return { R: 100 * s, C: { x: x - DB.x0 * s, y: y - DB.y0 * s }, deck: { x, y, w: DECK_W * s, h: DECK_H * s } };
}

function layoutFor(W, H, ins = { top: 0, right: 0, bottom: 0, left: 0 }, { controls = true } = {}) {
  const top = ins.top, availH = H - ins.top - ins.bottom;
  if (W / H < 1.15) {   // portrait phone: a smaller turntable in the middle, words underneath
    const tbH = controls ? 58 : 8, ctrlH = controls ? 76 : 0;
    const textH = clamp(availH * 0.2, 104, 190);
    const s = Math.max(0.3, Math.min((W - 40 - ins.left - ins.right) / DECK_W, (availH - tbH - textH - ctrlH - 24) / DECK_H, 1.7));
    const dh = DECK_H * s, total = tbH + dh + 16 + textH + ctrlH;
    const y = top + Math.max(0, (availH - total) / 2) + tbH;
    const d = deckAt(s, W / 2 - DECK_W * s / 2, y);
    const textTop = y + dh + 16;
    const text = { x: 20 + ins.left, w: W - 40 - ins.left - ins.right, top: textTop, h: Math.min(textH, H - ins.bottom - ctrlH - textTop - 8) };
    text.yc = text.top + text.h / 2;
    return { W, H, ...d, portrait: true, text,
      controls: { x: W / 2, y: Math.min(H - ins.bottom - ctrlH / 2 - 6, text.top + text.h + ctrlH / 2) },
      toolbar: { left: 14 + ins.left, top: top + 8 } };
  }
  // landscape (and the floating window): words on the left, the turntable on the right
  const s = Math.min((availH - 28) / DECK_H, (W * 0.6 - 24 - ins.right) / DECK_W);
  const regionL = W * 0.4, regionR = W - ins.right;
  const x = Math.min((regionL + regionR) / 2 - DECK_W * s / 2, regionR - 16 - DECK_W * s);
  const d = deckAt(s, x, top + (availH - DECK_H * s) / 2);
  const margin = Math.max(18, ins.left + 12);
  const tbH = controls ? 62 : 0, ctrlH = controls ? 70 : 0;
  const h = controls ? availH - tbH - ctrlH - 8 : availH * 0.8;
  const text = { x: margin, w: x - 22 - margin, top: controls ? top + tbH : top + (availH - h) / 2, h };
  text.yc = text.top + h / 2;
  return { W, H, ...d, portrait: false, text,
    controls: { x: margin + Math.min(text.w, 190) / 2, y: top + availH - ctrlH / 2 - 4, left: margin },
    toolbar: { left: margin - 4, top: top + 10 } };
}

// =============================================================================
//  App state
// =============================================================================
const $ = s => document.querySelector(s);
const S = {
  track: null, state: 'idle', status: 'starting',
  art: null, prevArt: null, artFade: 1, artUrl: null,
  speed: 33, pitch: 0,                       // selected speed and the pitch fader (±8 %)
  omega: 0, spin: null,                      // platter speed (deg/s) and its current ramp
  discAngle: 0, dot33: 0, dot45: 0,
  arm: { angle: DG.rest, lift: 0, mode: 'idle', t: 0 },
};
const demo = new URLSearchParams(location.search).has('demo');

function progressFraction() {
  const t = S.track;
  if (!t || !t.duration_ms) return 0;
  let ms = t.progress_ms;
  if (S.state === 'playing') ms += performance.now() - t.fetched_at;
  return clamp(ms / t.duration_ms, 0, 1);
}

// What a strobe lamp shows: dots that pass one pitch per flash look still, so the row seems to move
// only by how far the platter is off its calibrated speed.
const strobe = (w, nominal) => ((w + nominal / 2) % nominal + nominal) % nominal - nominal / 2;

function tick(dt) {
  // Platter: never jumps — it ramps to the new speed (spin-up 0.7 s, spin-down 1.5 s).
  const target = S.state === 'playing' ? SPEEDS[S.speed] * (1 + S.pitch / 100) : 0;
  if ((S.spin ? S.spin.to : S.omega) !== target) {
    S.spin = { from: S.omega, to: target, t: 0, dur: target > S.omega ? SPIN_UP : SPIN_DOWN };
  }
  if (S.spin) {
    const w = S.spin; w.t += dt;
    const k = Math.min(1, w.t / w.dur);
    S.omega = w.from + (w.to - w.from) * ease.sine(k);
    if (k >= 1) { S.omega = w.to; S.spin = null; }
  }
  S.discAngle = (S.discAngle + S.omega * dt) % 360;
  S.dot33 = (S.dot33 + strobe(S.omega, SPEEDS[33]) * dt) % 360;
  S.dot45 = (S.dot45 + strobe(S.omega, SPEEDS[45]) * dt) % 360;

  // Tonearm: cue up (200 ms) → swing (600 ms) → lower (300 ms), like cueing a real record.
  const onRecord = S.track && (S.state === 'playing' || S.state === 'paused');
  const [gOut, gIn] = DG.groove;
  const target2 = onRecord ? DG.armAngle(gOut - (gOut - gIn) * progressFraction()) : DG.rest;
  const wantUp = onRecord && S.state === 'paused';
  const A = S.arm;
  A.t += dt;
  const next = () => {
    A.t = 0;
    if (Math.abs(target2 - A.angle) > 1.2) {
      if (A.lift < 1) { A.mode = 'lift'; A.l0 = A.lift; } else { A.mode = 'swing'; A.a0 = A.angle; A.a1 = target2; }
      return;
    }
    A.angle = target2;   // close enough: just follow the groove
    if (wantUp && A.lift < 1) { A.mode = 'lift'; A.l0 = A.lift; }
    else if (!wantUp && A.lift > 0) { A.mode = 'lower'; A.l0 = A.lift; }
    else A.mode = 'idle';
  };
  if (A.mode === 'lift') {
    const k = Math.min(1, A.t / 0.2); A.lift = A.l0 + (1 - A.l0) * ease.out(k);
    if (k >= 1) { A.lift = 1; next(); }
  } else if (A.mode === 'swing') {
    const k = Math.min(1, A.t / 0.6); A.angle = A.a0 + (A.a1 - A.a0) * ease.inOut(k);
    if (k >= 1) next();
  } else if (A.mode === 'lower') {
    const k = Math.min(1, A.t / 0.3); A.lift = A.l0 * (1 - ease.out(k));
    if (k >= 1) { A.lift = 0; next(); }
  } else next();

  S.artFade = Math.min(1, S.artFade + dt / 0.8);
}

// --- texts -----------------------------------------------------------------------
function textContent() {
  const t = S.track, k = S.status;
  if (k === 'config') return ['SETUP NEEDED', 'Add your Spotify Client ID', 'Tap ⋯ to set it up', ''];
  if (k === 'auth') return ['WELCOME', 'Connect Spotify', 'Tap anywhere to sign in', ''];
  if (!t) {
    if (k === 'offline') return ['OFFLINE', "Can't reach Spotify", 'Retrying automatically…', ''];
    if (k === 'starting') return ['', 'Connecting…', '', ''];
    return ['READY', 'Nothing playing', 'Start a song on Spotify', ''];
  }
  let eyebrow = { playing: 'NOW PLAYING', paused: 'PAUSED', idle: 'LAST PLAYED' }[S.state];
  if (k === 'offline') eyebrow = 'OFFLINE · RETRYING';
  return [eyebrow, t.name, t.artist, t.album];
}

let textKey = '';
function updateText(force = false) {
  const content = textContent(), L = main.layout;
  const key = JSON.stringify([content, L.W, L.H]);
  if (!force && key === textKey) return;
  textKey = key;
  const info = $('#info'), inner = $('#infoInner');
  const [e, t, a, b] = inner.children;
  const box = L.text;
  info.className = L.portrait ? 'portrait' : 'landscape';
  Object.assign(info.style, { left: box.x + 'px', top: box.top + 'px', width: box.w + 'px', height: box.h + 'px' });
  info.style.display = box.w < 60 ? 'none' : '';
  const small = box.h < 150;
  e.textContent = small ? '' : content[0]; t.textContent = content[1];
  a.textContent = content[2]; b.textContent = box.h < 110 ? '' : content[3];
  if (!L.portrait) info.style.justifyContent = 'center';
  // Shrink until everything fits (title at most 3 lines).
  let s = Math.min(box.h * 0.22, box.w * (L.portrait ? 0.11 : 0.16), 44);
  for (let i = 0; i < 40; i++) {
    t.style.fontSize = s + 'px';
    a.style.fontSize = Math.max(13, Math.min(s * 0.55, 22)) + 'px';
    b.style.fontSize = Math.max(11, Math.min(s * 0.42, 16)) + 'px';
    e.style.fontSize = Math.max(10, Math.min(s * 0.30, 12.5)) + 'px';
    for (const el of [e, t, a]) el.style.marginBottom = (s * 0.22) + 'px';
    const lines = Math.round(t.offsetHeight / (s * 1.1));
    if ((inner.offsetHeight <= box.h + 1 && lines <= 3) || s <= 14) break;
    s *= 0.93;
  }
  $('#controls').classList.toggle('paused', S.state !== 'playing');
}

// =============================================================================
//  Main view: background canvas + the deck's layers + animation loop
// =============================================================================
const main = { view: null, layout: null, dpr: 1, layers: null, bgDirty: true };

// On the iPhone home screen (status bar drawn over the app) portrait reports a height that is
// short by about the status bar, which left a black strip at the bottom. Use the full screen there.
function viewportSize() {
  const W = window.innerWidth;
  let H = Math.max(window.innerHeight, document.documentElement.clientHeight);
  if (isIOS && standalone()) {
    const long = Math.max(screen.width, screen.height), short = Math.min(screen.width, screen.height);
    const full = W < long - 1 ? long : short;   // portrait: the long side is the height
    if (full > H && full - H < 140) H = full;
  }
  // The CSS adds the top safe area to the canvas height (see style.css); use that if it is taller.
  const cv = main.view && main.view.canvas;
  if (cv) {
    const keep = cv.style.height;
    cv.style.height = '';
    const cssH = cv.getBoundingClientRect().height;
    cv.style.height = keep;
    if (cssH > H && cssH - H < 140) H = Math.round(cssH);
  }
  return { W, H };
}

function resize() {
  const { W, H } = viewportSize(), dpr = Math.min(window.devicePixelRatio || 1, 3);
  const cv = main.view.canvas;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  main.dpr = dpr;
  main.layout = layoutFor(W, H, insets(), { controls: true });
  main.view.forgetSize();
  const L = main.layout, c = $('#controls'), tb = $('#toolbar');
  if (L.portrait) Object.assign(c.style, { left: '50%', transform: 'translate(-50%, -50%)', top: L.controls.y + 'px' });
  else Object.assign(c.style, { left: L.controls.left + 'px', transform: 'translateY(-50%)', top: L.controls.y + 'px' });
  Object.assign(tb.style, { left: L.toolbar.left + 'px', top: L.toolbar.top + 'px' });
  buildDeck();
  updateText(true);
  main.bgDirty = true;
  draw();
}

const px = v => v.toFixed(2) + 'px';

function buildDeck() {
  const L = main.layout, s = L.R / 100, R = L.R, dpr = main.dpr, host = $('#deck');
  host.innerHTML = '';
  Object.assign(host.style, { left: px(L.C.x), top: px(L.C.y) });
  main.layers = {};
  for (const [key, make] of LAYERS) {
    const el = document.createElement('div');
    el.className = 'layer L-' + key + (poseFor(key, deckPose()) ? ' moves' : '');
    if (make) {
      const spec = make(s, R);
      Object.assign(el.style, { left: px(spec.origin[0] * s), top: px(spec.origin[1] * s) });
      el.innerHTML = spec.svg;
      Object.assign(el.firstElementChild.style, { left: px(spec.box[0] * s), top: px(spec.box[1] * s) });
    } else if (key === 'record') {
      const n = Math.max(8, Math.round(2 * R * dpr));
      el.appendChild(placeCanvas(main.view.cached(`disc:${n}`, () => renderDisc(n)), R));
      el.appendChild(Object.assign(document.createElement('div'), { className: 'labels' }));
    } else if (key === 'sheen') {
      const n = Math.max(8, Math.round(2 * R * dpr));
      el.appendChild(placeCanvas(main.view.cached(`sheen:${n}`, () => renderSheen(n, dpr)), R));
    } else if (key === 'contact') {
      Object.assign(el.style, { left: px(DG.pivot[0] * s), top: px(DG.pivot[1] * s) });
      const dot = document.createElement('i');
      Object.assign(dot.style, { left: px(DG.armLen * s) });
      el.appendChild(dot);
    }
    host.appendChild(el);
    main.layers[key] = el;
  }
  refreshLabels();

  if (BARE) { main.fader = null; return; }
  // Controls on the plinth: START/STOP, 33 / 45 with their LEDs, and the pitch fader.
  const place = (el, x, y, w, h) => Object.assign(el.style, { left: px(x * s), top: px(y * s), width: px(w * s), height: px(h * s) });
  const k = DG.keys;
  const key = (name, label, aria) => {
    const b = document.createElement('button');
    b.className = 'key'; b.dataset.key = name; b.setAttribute('aria-label', aria);
    b.innerHTML = `<span>${label}</span>`;
    place(b, ...k[name]);
    host.appendChild(b);
    return b;
  };
  host.style.setProperty('--kf', Math.max(5.5, 2.9 * s).toFixed(1) + 'px');
  key('start', 'START', 'Start or stop'); key('s33', '33', '33⅓ rpm'); key('s45', '45', '45 rpm');
  for (const [name, [x, y]] of Object.entries(DG.leds)) {
    const led = document.createElement('i');
    led.className = 'led'; led.dataset.led = name;
    place(led, x - 1.7, y - 1.7, 3.4, 3.4);
    host.appendChild(led);
  }
  const fp = DG.pitch;
  const fader = document.createElement('i'); fader.className = 'fader';
  place(fader, fp.x - 8, (fp.y0 + fp.y1) / 2 - 4.5, 16, 9);
  const hit = document.createElement('div'); hit.className = 'faderHit';
  place(hit, fp.x - 14, fp.y0 - 12, 28, fp.y1 - fp.y0 + 24);
  host.append(fader, hit);
  main.fader = fader;
  syncDeckControls();
}

function placeCanvas(cv, R) {
  Object.assign(cv.style, { left: px(-R), top: px(-R), width: px(2 * R), height: px(2 * R) });
  return cv;
}

function refreshLabels() {   // the paper label on the record (cross-fades when the cover changes)
  const box = main.layers && main.layers.record && main.layers.record.querySelector('.labels');
  if (!box) return;
  const lr = main.layout.R * LABEL_R, ln = Math.max(8, Math.round(2 * lr * main.dpr));
  box.innerHTML = '';
  main.label = null;
  for (const art of [S.prevArt, S.art]) {
    if (!art && S.prevArt) continue;
    const cv = main.view.cached(`label:${art ? art.id : 0}:${ln}`, () => renderLabel(art && art.label, ln));
    box.appendChild(placeCanvas(cv, lr));
    main.label = cv;
  }
}

function syncDeckControls() {
  for (const led of document.querySelectorAll('#deck .led')) led.classList.toggle('on', led.dataset.led === 's' + S.speed);
  if (main.fader) {
    const fp = DG.pitch, s = main.layout.R / 100;
    main.fader.style.transform = `translateY(${px(S.pitch / 8 * (fp.y1 - fp.y0) / 2 * s)})`;
  }
}

function setSpeed(v) { S.speed = v; store.set('speed', String(v)); syncDeckControls(); }
function setPitch(v) {
  v = clamp(Math.round(v * 10) / 10, -8, 8);
  if (Math.abs(v) < 0.5) v = 0;   // centre detent
  S.pitch = v; store.set('pitch', String(v)); syncDeckControls();
}

function applyPose() {   // transforms + opacity only
  const P = deckPose();
  for (const key in main.layers) {
    const T = poseFor(key, P);
    if (!T) continue;
    const el = main.layers[key];
    const tr = `translate(${px(T.dx || 0)},${px(T.dy || 0)}) rotate(${T.rot.toFixed(3)}deg) scale(${(T.scale || 1).toFixed(4)})`;
    if (el._tr !== tr) { el.style.transform = tr; el._tr = tr; }
    const op = (T.alpha ?? 1).toFixed(3);
    if (el._op !== op) { el.style.opacity = op; el._op = op; }
  }
  if (main.label) {
    const op = (S.prevArt ? S.artFade : 1).toFixed(3);
    if (main.label._op !== op) { main.label.style.opacity = op; main.label._op = op; }
  }
}

function draw() {
  if (main.bgDirty || S.artFade < 1) { drawBackground(main.view, main.layout, main.dpr, S); main.bgDirty = S.artFade < 1; }
  applyPose();
  if (pip.active) drawPip();
}

let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  tick(dt);
  draw();
  requestAnimationFrame(frame);
}

// =============================================================================
//  Floating window (Picture in Picture) — keeps the turntable on screen over Spotify
// =============================================================================
const pip = { view: null, video: null, active: false, timer: 0, imgs: null };
const PIP_W = 720, PIP_H = 360;

function pipSupported() {
  const v = document.createElement('video');
  return !!((document.pictureInPictureEnabled && v.requestPictureInPicture) ||
    (v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode('picture-in-picture'))) &&
    !!HTMLCanvasElement.prototype.captureStream;
}

// The same SVG layers, turned into images once so the window can be drawn on a canvas.
async function rasterDeck(L) {
  const s = L.R / 100, out = {};
  await Promise.all(LAYERS.filter(([, make]) => make).map(async ([key, make]) => {
    const spec = make(s, L.R), img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(spec.svg);
    try { await img.decode(); out[key] = { img, spec }; } catch (e) { console.warn('layer', key, e); }
  }));
  return out;
}

function drawPip() {
  const v = pip.view, L = pip.layout, p = v.ctx, R = L.R, s = R / 100;
  drawBackground(v, L, 1, S);
  const P = deckPose();
  p.save();
  p.translate(L.C.x, L.C.y);
  for (const [key] of LAYERS) {
    const T = poseFor(key, P) || {};
    const alpha = T.alpha ?? 1;
    if (alpha <= 0.002) continue;
    p.save();
    p.globalAlpha = alpha;
    const o = pip.imgs && pip.imgs[key];
    const origin = o ? o.spec.origin : key === 'contact' ? DG.pivot : [0, 0];
    p.translate(origin[0] * s + (T.dx || 0), origin[1] * s + (T.dy || 0));
    p.rotate(rad(T.rot || 0));
    if (T.scale) p.scale(T.scale, T.scale);
    if (o) {
      const [bx, by, bw, bh] = o.spec.box;
      p.drawImage(o.img, bx * s, by * s, bw * s, bh * s);
    } else if (key === 'record') {
      const n = Math.round(2 * R), ln = Math.round(2 * R * LABEL_R), lr = R * LABEL_R;
      p.drawImage(v.cached(`disc:${n}`, () => renderDisc(n)), -R, -R, 2 * R, 2 * R);
      for (const [art, a] of [[S.prevArt, 1], [S.art, S.prevArt ? S.artFade : 1]]) {
        if (!art && S.prevArt) continue;
        p.globalAlpha = alpha * a;
        p.drawImage(v.cached(`label:${art ? art.id : 0}:${ln}`, () => renderLabel(art && art.label, ln)), -lr, -lr, 2 * lr, 2 * lr);
      }
    } else if (key === 'sheen') {
      const n = Math.round(2 * R);
      p.drawImage(v.cached(`sheen:${n}`, () => renderSheen(n, 1)), -R, -R, 2 * R, 2 * R);
    } else if (key === 'contact') {
      fillCircle(p, DG.armLen * s, 0, 1.8, 'rgba(0,0,0,.7)');
    }
    p.restore();
  }
  p.restore();
  drawCanvasText(p, L, textContent());
}

function preparePip() {
  if (pip.video) return;
  const cv = makeCanvas(PIP_W, PIP_H);
  pip.view = new View(cv, { withText: true });
  pip.layout = layoutFor(PIP_W, PIP_H, undefined, { controls: false });
  rasterDeck(pip.layout).then(imgs => { pip.imgs = imgs; drawPip(); });
  drawPip();
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.autoplay = true;
  v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.setAttribute('autopictureinpicture', '');
  v.autoPictureInPicture = true;
  Object.assign(v.style, { position: 'fixed', width: '2px', height: '1px', opacity: '0.01', left: '0', bottom: '0', pointerEvents: 'none' });
  v.srcObject = cv.captureStream(30);
  document.body.appendChild(v);
  v.play().catch(() => { });
  const onLeave = () => { pip.active = false; clearInterval(pip.timer); };
  v.addEventListener('leavepictureinpicture', onLeave);
  v.addEventListener('enterpictureinpicture', () => { pip.active = true; startPipTimer(); });
  v.addEventListener('webkitpresentationmodechanged', () => {
    if (v.webkitPresentationMode === 'picture-in-picture') { pip.active = true; startPipTimer(); } else onLeave();
  });
  pip.video = v;
}

// While the app is in the background requestAnimationFrame stops, so a timer keeps the window moving.
function startPipTimer() {
  clearInterval(pip.timer);
  let last = performance.now();
  pip.timer = setInterval(() => {
    if (!document.hidden) return;
    const now = performance.now();
    tick(Math.min(0.2, (now - last) / 1000)); last = now;
    drawPip();
  }, 50);
}

function togglePip() {
  preparePip();
  const v = pip.video;
  v.play().catch(() => { });
  try {
    if (document.pictureInPictureElement) return void document.exitPictureInPicture();
    if (v.webkitPresentationMode === 'picture-in-picture') return void v.webkitSetPresentationMode('inline');
    if (v.requestPictureInPicture && document.pictureInPictureEnabled) {
      v.requestPictureInPicture().then(() => toast('עכשיו אפשר לעבור לספוטיפי — הפטיפון נשאר צף')).catch(err => toast('לא הצלחתי לפתוח חלון צף: ' + err.message));
    } else if (v.webkitSetPresentationMode) {
      v.webkitSetPresentationMode('picture-in-picture');
      toast('עכשיו אפשר לעבור לספוטיפי — הפטיפון נשאר צף');
    }
  } catch (err) { toast('לא הצלחתי לפתוח חלון צף'); }
}

// =============================================================================
//  Spotify (PKCE login — no client secret needed, so it runs as static files)
// =============================================================================
const store = {
  get(k) { try { return localStorage.getItem('vp.' + k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem('vp.' + k) : localStorage.setItem('vp.' + k, v); } catch { } },
};
const clientId = () => store.get('clientId') || (window.VP_CONFIG && window.VP_CONFIG.clientId) || '';
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = n => b64url(crypto.getRandomValues(new Uint8Array(n))).slice(0, n);

async function login() {
  const verifier = randomString(64), state = randomString(16);
  store.set('verifier', verifier); store.set('state', state);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: clientId(), response_type: 'code', redirect_uri: redirectUri(),
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state,
  });
}

function logout() {
  ['access', 'refresh', 'expires', 'verifier', 'state'].forEach(k => store.set(k, null));
  S.track = null; S.state = 'idle'; setStatus('auth');
}

async function tokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
  });
  if (!r.ok) { const e = new Error('Spotify login ' + r.status); e.status = r.status; e.detail = await r.text().catch(() => ''); throw e; }
  const j = await r.json();
  store.set('access', j.access_token);
  store.set('expires', String(Date.now() + (j.expires_in - 60) * 1000));
  if (j.refresh_token) store.set('refresh', j.refresh_token);
}

async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return;
  history.replaceState(null, '', redirectUri());
  if (q.get('error')) { toast('ההתחברות בוטלה (' + q.get('error') + ')'); return; }
  if (q.get('state') !== store.get('state')) { toast('ההתחברות לא הושלמה, נסה שוב'); return; }
  try {
    await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(),
      client_id: clientId(), code_verifier: store.get('verifier') });
    toast('מחובר לספוטיפי ✓');
  } catch (e) { toast('ההתחברות נכשלה: ' + e.message); console.warn(e.detail); }
}

let refreshing = null;
async function accessToken() {
  const at = store.get('access');
  if (at && Date.now() < +store.get('expires')) return at;
  const rt = store.get('refresh');
  if (!rt) return null;
  refreshing = refreshing || tokenRequest({ grant_type: 'refresh_token', refresh_token: rt, client_id: clientId() })
    .finally(() => { refreshing = null; });
  try { await refreshing; } catch (e) {
    if (e.status === 400 || e.status === 401) { logout(); return null; }   // login revoked or expired
    throw e;
  }
  return store.get('access');
}

async function api(method, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await accessToken();
    if (!tok) { const e = new Error('auth'); e.auth = true; throw e; }
    const r = await fetch('https://api.spotify.com/v1' + path, { method, headers: { Authorization: 'Bearer ' + tok } });
    if (r.status !== 401) return r;
    store.set('expires', '0');
  }
  const e = new Error('auth'); e.auth = true; throw e;
}

function parsePlayback(pb) {
  if (!pb || !pb.item) return { state: 'idle' };
  const item = pb.item;
  let artist, album, images;
  if (item.type === 'episode') {
    const show = item.show || {};
    artist = show.name || ''; album = ''; images = item.images || show.images || [];
  } else {
    artist = (item.artists || []).map(a => a.name).join(', ');
    album = (item.album || {}).name || ''; images = (item.album || {}).images || [];
  }
  return { state: 'ok', id: item.id || item.uri || item.name, name: item.name || '', artist, album,
    image_url: images.length ? images[0].url : null, is_playing: !!pb.is_playing,
    progress_ms: pb.progress_ms || 0, duration_ms: item.duration_ms || 0, fetched_at: performance.now() };
}

function setStatus(kind) {
  if (kind === S.status) return;
  S.status = kind;
  updateText();
  if (kind === 'auth' || kind === 'config') showControls(true);
}

function onPlayback(info) {
  if (info.state === 'ok') { S.track = info; S.state = info.is_playing ? 'playing' : 'paused'; }
  else S.state = 'idle';
  updateText();
  if (info.image_url && info.image_url !== S.artUrl) {
    S.artUrl = info.image_url;
    loadArt(info.image_url).then(art => { if (S.artUrl === info.image_url) setArt(art); }).catch(e => console.warn(e));
  }
}

function setArt(art) {
  S.prevArt = S.art; S.art = art; S.artFade = 0;
  const keep = [S.prevArt, S.art].filter(Boolean).map(a => a.id);
  main.view.forgetArt(keep);
  if (pip.view) pip.view.forgetArt(keep);
  refreshLabels();
}

let pollTimer = 0;
async function poll() {
  clearTimeout(pollTimer);
  if (demo) return;
  let delay = POLL_MS;
  try {
    if (!clientId()) { setStatus('config'); delay = 5000; }
    else if (!store.get('refresh') && !store.get('access')) { setStatus('auth'); delay = 3000; }
    else {
      const r = await api('GET', '/me/player?additional_types=track,episode');
      if (r.status === 204) { setStatus('ok'); onPlayback({ state: 'idle' }); }
      else if (r.status === 429) delay = (+r.headers.get('Retry-After') || 5) * 1000;
      else if (r.ok) { const pb = await r.json(); setStatus('ok'); onPlayback(parsePlayback(pb)); }
      else throw new Error('Spotify ' + r.status);
    }
  } catch (e) {
    if (e.auth) setStatus('auth');
    else { console.warn(e); setStatus('offline'); delay = 5000; }
  }
  if (document.hidden && !pip.active) delay = Math.max(delay, 15000);   // nobody's looking
  pollTimer = setTimeout(poll, delay);
}

async function command(cmd) {
  if (!S.track && cmd === 'toggle') return;
  const playing = S.state === 'playing';
  const [method, path] = {
    toggle: playing ? ['PUT', '/me/player/pause'] : ['PUT', '/me/player/play'],
    next: ['POST', '/me/player/next'], previous: ['POST', '/me/player/previous'],
  }[cmd];
  if (cmd === 'toggle' && S.track) {   // feels instant; the next poll confirms it
    S.track.progress_ms += playing ? performance.now() - S.track.fetched_at : 0;
    S.track.fetched_at = performance.now();
    S.state = playing ? 'paused' : 'playing'; updateText();
  }
  if (demo) return;
  try {
    const r = await api(method, path);
    if (r.status === 403) toast('שליטה בנגינה דורשת ספוטיפי פרימיום');
    else if (r.status === 404) toast('אין מכשיר פעיל — פתח את ספוטיפי');
  } catch (e) { if (!e.auth) toast('אין חיבור לספוטיפי'); }
  setTimeout(poll, 400);
}

// =============================================================================
//  UI: sheets, menu, toasts, auto-hiding buttons
// =============================================================================
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const SHARE_ICON = '<svg class="share" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M7 11H5v10h14V11h-2"/></svg>';

function sheet(html, onReady) {
  const s = $('#sheet'), card = s.querySelector('.card');
  if (!html) { s.hidden = true; card.innerHTML = ''; return; }
  card.innerHTML = html; s.hidden = false;
  card.querySelectorAll('[data-close]').forEach(b => b.onclick = () => sheet(null));
  onReady && onReady(card);
}

function showInstall() {
  sheet(`<h2>להתקין על המסך הראשי</h2>
    <ol>
      <li>פתח את הדף הזה ב-<b>Safari</b>.</li>
      <li>לחץ על כפתור השיתוף ${SHARE_ICON} בתחתית.</li>
      <li>בחר <b>"הוסף למסך הבית"</b> ואז <b>"הוסף"</b>.</li>
      <li>פתח את <b>Vinyl</b> מהמסך הראשי והתחבר לספוטיפי שם.</li>
    </ol>
    <p>שים לב: ההתחברות לספוטיפי נשמרת בנפרד בתוך האפליקציה, לכן כדאי להתחבר רק אחרי ההתקנה.</p>
    <div class="row"><button class="btn" data-close>הבנתי</button></div>`);
}

function showSetup() {
  sheet(`<h2>חיבור לספוטיפי — פעם אחת</h2>
    <ol>
      <li>היכנס ל-<a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener" style="color:#1ed760">Spotify Developer Dashboard</a> ופתח את האפליקציה שלך.</li>
      <li>ב-<b>Settings ← Redirect URIs</b> הוסף בדיוק את הכתובת:<br><span class="mono" id="ru"></span></li>
      <li>העתק את ה-<b>Client ID</b> והדבק כאן:</li>
    </ol>
    <input id="cid" placeholder="Client ID" autocomplete="off" autocapitalize="off" spellcheck="false">
    <div class="row"><button class="btn" id="saveCid">שמור והתחבר</button><button class="btn secondary" data-close>סגור</button></div>`,
    card => {
      card.querySelector('#ru').textContent = redirectUri();
      const inp = card.querySelector('#cid');
      inp.value = clientId();
      card.querySelector('#saveCid').onclick = () => {
        const v = inp.value.trim();
        if (!/^[0-9a-f]{32}$/i.test(v)) { toast('Client ID הוא 32 תווים של אותיות ומספרים'); return; }
        store.set('clientId', v); sheet(null); login();
      };
    });
}

function showConnect() {
  sheet(`<h2>התחברות לספוטיפי</h2>
    <p>הפטיפון יציג את מה שמתנגן אצלך בספוטיפי — בטלפון, במחשב או ברמקול.</p>
    <div class="row"><button class="btn" id="go">התחבר עם ספוטיפי</button><button class="btn secondary" data-close>אחר כך</button></div>`,
    card => { card.querySelector('#go').onclick = () => login(); });
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

let hideTimer = 0;
function showControls(stay = false) {
  for (const el of [$('#controls'), $('#toolbar')]) el.classList.remove('dim');
  $('#controls').hidden = !(S.track || demo) || S.status === 'auth' || S.status === 'config';
  clearTimeout(hideTimer);
  if (!stay) hideTimer = setTimeout(() => {
    if (!$('#menu').hidden || S.state !== 'playing') return;
    for (const el of [$('#controls'), $('#toolbar')]) el.classList.add('dim');
  }, 5000);
}

// Keep the screen on while the record is showing (like leaving a turntable on the shelf).
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock && !document.hidden) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { }
}

function bindUI() {
  const menu = $('#menu');
  $('#btnMore').onclick = e => {
    e.stopPropagation();
    if (!menu.hidden) { menu.hidden = true; return; }
    const r = e.currentTarget.getBoundingClientRect();
    menu.hidden = false;
    menu.style.top = (r.bottom + 8) + 'px';
    menu.style.left = r.left + 'px';
    menu.querySelector('[data-act="install"]').hidden = standalone();
    const vs = viewportSize();
    menu.querySelector('.ver').textContent =
      `v${APP_VERSION} · ${vs.W}×${vs.H} (${innerWidth}×${innerHeight}, ${screen.width}×${screen.height})${standalone() ? ' · app' : ''}`;
    showControls(true);
  };
  menu.onclick = e => {
    const act = e.target.closest('button')?.dataset.act;
    menu.hidden = true;
    if (act === 'install') showInstall();
    else if (act === 'setup') showSetup();
    else if (act === 'logout') { logout(); toast('נותקת מספוטיפי'); }
  };
  $('#btnPip').onclick = e => { e.stopPropagation(); togglePip(); };
  $('#btnSpotify').onclick = e => e.stopPropagation();
  $('#controls').onclick = e => {
    e.stopPropagation();
    const b = e.target.closest('button'); if (b) { command(b.dataset.cmd); showControls(); }
  };
  $('#sheet').onclick = e => { if (e.target.id === 'sheet') sheet(null); };

  $('#scene').addEventListener('click', e => {
    keepAwake();
    preparePip();
    if (!menu.hidden) { menu.hidden = true; return; }
    if (S.status === 'config') return showSetup();
    if (S.status === 'auth') return showConnect();
    // Tap the record to pause / play.
    const L = main.layout, d = Math.hypot(e.clientX - L.C.x, e.clientY - L.C.y);
    if (d < L.R && (S.track || demo)) command('toggle');
    showControls();
  });
  // The turntable's own controls.
  const deck = $('#deck');
  deck.addEventListener('click', e => {
    const b = e.target.closest('.key'); if (!b) return;
    e.stopPropagation(); keepAwake();
    if (b.dataset.key === 'start') { if (S.track || demo) command('toggle'); }
    else setSpeed(b.dataset.key === 's45' ? 45 : 33);
  });
  let drag = null;
  deck.addEventListener('pointerdown', e => {
    if (!e.target.classList.contains('faderHit')) return;
    e.preventDefault();
    const fp = DG.pitch, s = main.layout.R / 100;
    drag = { id: e.pointerId, y: e.clientY, p: S.pitch, k: 16 / ((fp.y1 - fp.y0) * s) };
    e.target.setPointerCapture(e.pointerId);
  });
  deck.addEventListener('pointermove', e => { if (drag && e.pointerId === drag.id) setPitch(drag.p + (e.clientY - drag.y) * drag.k); });
  const endDrag = e => { if (drag && e.pointerId === drag.id) drag = null; };
  deck.addEventListener('pointerup', endDrag); deck.addEventListener('pointercancel', endDrag);
  deck.addEventListener('dblclick', e => { if (e.target.classList.contains('faderHit')) setPitch(0); });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { keepAwake(); poll(); lastT = performance.now(); }
  });
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 300));
}

// =============================================================================
async function start() {
  main.view = new View($('#scene'));
  S.speed = store.get('speed') === '45' ? 45 : 33;
  S.pitch = clamp(+store.get('pitch') || 0, -8, 8);
  bindUI();
  resize();
  requestAnimationFrame(t => { lastT = t; frame(t); });
  $('#btnPip').hidden = !pipSupported();
  showControls();

  if (demo) {
    S.status = 'ok';
    onPlayback({ state: 'ok', id: 'demo', name: 'Song Name', artist: 'Artist', album: 'Album', is_playing: true,
      progress_ms: 60000, duration_ms: 210000, fetched_at: performance.now() });
    setArt(demoArt());
    return;
  }
  await handleRedirect();
  poll();
  if (isIOS && !standalone() && !store.get('installHintShown')) { store.set('installHintShown', '1'); showInstall(); }
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { });
}

if (!window.VP_NO_START) start();
