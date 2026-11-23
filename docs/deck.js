/* deck.js — the turntable as a physical object, built from layered SVG.
 *
 * Every part is its own layer (base → material → highlight → shadow), lit by one light from the
 * top-left at 45°. Moving parts (platter dots, record, tonearm, cue lever) are separate layers
 * that the app only rotates / fades, so all motion is transform + opacity.
 *
 * Units: the record's radius is 100 units ("U"); the origin is the spindle; y points down.
 * Each function returns { origin, box, svg }: `origin` is where the layer's own (0,0) sits on the
 * deck (its rotation centre), `box` is the layer's viewBox around that origin.
 */
'use strict';
const Deck = (() => {
  const TAU = Math.PI * 2;
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  const N = v => Math.round(v * 100) / 100;
  const LIGHT = rad(225);   // direction the light comes from (screen angle; top-left)
  const FONT = '-apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif';

  // --- Geometry ----------------------------------------------------------------
  const G = {
    bounds: { x0: -130, x1: 185, y0: -136, y1: 150 },   // the plinth
    pivot: [124, -70],          // 0.71·D from the spindle, upper right
    armLen: 152,                // effective length 0.76·D → 5 % overhang past the spindle
    headLen: 35, headOffset: 22,
    rest: 88,                   // arm angle when parked in the rest
    groove: [94, 45],           // lead-in → run-out radius
    cue: [157, -36], skate: [96, -98], lamp: [-109, 92],
    speedSwitch: [-94, 100, 22, 7],   // centre x, y, width, height of the 33 / 45 slide switch
    pitch: { x: 168, y0: 26, y1: 114 },
    keys: { start: [-121, 119, 42, 15], s33: [-69, 120, 17, 12], s45: [-46, 120, 17, 12] },
    leds: { s33: [-60.5, 112.5], s45: [-37.5, 112.5] },
  };
  { // headshell offset: the cartridge points 22° off the pivot→stylus line, tangent to the groove
    const o = rad(G.headOffset);
    G.joint = [G.armLen - G.headLen * Math.cos(o), -G.headLen * Math.sin(o)];
    G.tubeA = Math.atan2(G.joint[1], G.joint[0]);
    G.tubeLen = Math.hypot(...G.joint);
  }
  G.armPoint = (angle, x, y) => {   // a point of the arm (arm frame) → deck coordinates
    const a = rad(angle), c = Math.cos(a), s = Math.sin(a);
    return [G.pivot[0] + x * c - y * s, G.pivot[1] + x * s + y * c];
  };
  G.armAngle = r => {   // arm angle that puts the stylus at radius r
    const [px, py] = G.pivot, d = Math.hypot(px, py), L = G.armLen;
    const cos = Math.max(-1, Math.min(1, (L * L + d * d - r * r) / (2 * L * d)));
    return deg(Math.atan2(-py, -px)) - deg(Math.acos(cos));
  };
  G.restPost = (() => { const t = 0.6 * G.tubeLen; return G.armPoint(G.rest, t * Math.cos(G.tubeA), t * Math.sin(G.tubeA)); })();
  G.rimPx = R => Math.max(7, Math.min(11, R * 0.08));   // visible platter rim around the record

  // --- Small SVG helpers ---------------------------------------------------------
  const gray = (v, a = 1) => { v = Math.round(Math.max(0, Math.min(255, v))); return a >= 1 ? `rgb(${v},${v},${v})` : `rgba(${v},${v},${v},${N(a)})`; };
  // Ids are prefixed per layer, so several of these SVGs can live in one page.
  const svg = (box, s, body, defs, pfx) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.map(N).join(' ')}" width="${N(box[2] * s)}" height="${N(box[3] * s)}"><defs>${defs || ''}</defs>${body}</svg>`
      .replace(/id="([^"]+)"/g, `id="${pfx}-$1"`).replace(/url\(#([^)]+)\)/g, `url(#${pfx}-$1)`);
  const pt = (cx, cy, r, a) => `${N(cx + r * Math.cos(a))} ${N(cy + r * Math.sin(a))}`;
  const blur = (id, sd) => `<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${N(sd)}"/></filter>`;
  const lin = (id, stops, x2 = 1, y2 = 1, x1 = 0, y1 = 0) =>
    `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('')}</linearGradient>`;
  const radial = (id, stops, cx = .5, cy = .5, r = .5) =>
    `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}">${stops.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('')}</radialGradient>`;
  function seeded(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // Brushed / turned metal: a conic sheen — two bright wedges on the axis of the light (the near one
  // brighter) plus fine random streaks. Drawn as thin wedges so it also works as a plain image.
  function brushed(base, hi, lo = hi * 0.5, seed = 1, grain = 6) {
    const r = seeded(seed), noise = Array.from({ length: 360 }, () => (r() - 0.5) * 2 * grain);
    return a => {
      const c = Math.cos(a - LIGHT), lobe = c > 0 ? hi * c ** 10 : lo * (-c) ** 10;
      const side = 0.18 * hi * Math.max(0, Math.cos(2 * (a - LIGHT) + Math.PI)) ** 6;   // faint cross sheen
      return base + lobe + side + noise[Math.floor(((a % TAU) + TAU) % TAU / TAU * 360) % 360];
    };
  }
  function fan(cx, cy, r0, r1, n, shade) {
    let out = '';
    for (let i = 0; i < n; i++) {
      const a0 = i / n * TAU, a1 = (i + 1.04) / n * TAU, am = (i + 0.5) / n * TAU;
      const d = r0 > 0
        ? `M${pt(cx, cy, r1, a0)}A${N(r1)} ${N(r1)} 0 0 1 ${pt(cx, cy, r1, a1)}L${pt(cx, cy, r0, a1)}A${N(r0)} ${N(r0)} 0 0 0 ${pt(cx, cy, r0, a0)}Z`
        : `M${N(cx)} ${N(cy)}L${pt(cx, cy, r1, a0)}A${N(r1)} ${N(r1)} 0 0 1 ${pt(cx, cy, r1, a1)}Z`;
      out += `<path d="${d}" fill="${gray(shade(am))}"/>`;
    }
    return out;
  }
  function knurl(cx, cy, r0, r1, n, w) {   // ridges round an edge; the lit ones face the light
    let lit = '', dim = '', dark = '';
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU, d = `M${pt(cx, cy, r0, a)}L${pt(cx, cy, r1, a)}`;
      if (i % 2) dark += d; else if (Math.cos(a - LIGHT) > 0) lit += d; else dim += d;
    }
    return `<path d="${dark}" stroke="#000" stroke-opacity=".45" stroke-width="${N(w)}"/>` +
      `<path d="${lit}" stroke="#fff" stroke-opacity=".24" stroke-width="${N(w)}"/>` +
      `<path d="${dim}" stroke="#fff" stroke-opacity=".08" stroke-width="${N(w)}"/>`;
  }
  const ring = (cx, cy, r, w, stroke) => `<circle cx="${N(cx)}" cy="${N(cy)}" r="${N(r)}" fill="none" stroke="${stroke}" stroke-width="${N(w)}"/>`;
  // A rim lit from the top-left: bright edge facing the light, dark edge away from it.
  const bevelRing = (cx, cy, r, w, id, inset = false) => ring(cx, cy, r, w, `url(#${id}${inset ? 'In' : ''})`);
  const bevelDefs = id =>
    lin(id, [[0, '#fff', .42], [.45, '#fff', .05], [.55, '#000', .1], [1, '#000', .6]]) +
    lin(id + 'In', [[0, '#000', .7], [.45, '#000', .15], [.55, '#fff', .02], [1, '#fff', .22]]);
  const text = (x, y, str, size, { anchor = 'middle', spacing = .14, alpha = .3, weight = 600, rotate = 0 } = {}) =>
    `<text x="${N(x)}" y="${N(y)}" font-family="${FONT}" font-size="${N(size)}" font-weight="${weight}" letter-spacing="${N(size * spacing)}" text-anchor="${anchor}" dominant-baseline="middle" fill="#fff" fill-opacity="${alpha}"${rotate ? ` transform="rotate(${rotate} ${N(x)} ${N(y)})"` : ''}>${str}</text>`;
  const shadow = (shape, dx, dy, filter, op) => `<g transform="translate(${N(dx)} ${N(dy)})" filter="url(#${filter})" opacity="${op}">${shape}</g>`;

  // =============================================================================
  //  Static base: plinth, platter, bearing stack, anti-skate, rest, cue housing, lamp, pitch track
  // =============================================================================
  function base(s, R, bare = false) {
    const P = v => v / s;                    // pixels → units
    const b = G.bounds, pad = P(46), Rp = 100 + P(G.rimPx(R));
    const box = [b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + 2 * pad, b.y1 - b.y0 + 2 * pad];
    const W = b.x1 - b.x0, H = b.y1 - b.y0, rr = 8;
    const plinthShape = fill => `<rect x="${b.x0}" y="${b.y0}" width="${W}" height="${H}" rx="${rr}" fill="${fill}"/>`;
    const noiseF = (id, a, c) => `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
      `<feTurbulence type="fractalNoise" baseFrequency="${N(0.75 * s)}" numOctaves="2" seed="4" stitchTiles="stitch"/>` +
      `<feColorMatrix type="matrix" values="0 0 0 0 ${c} 0 0 0 0 ${c} 0 0 0 0 ${c} ${a}"/></filter>`;
    let defs = blur('fS', P(1.2)) + blur('fM', P(2.4)) + blur('fL', P(4.5)) + blur('fX', P(16)) +
      noiseF('nW', '2.4 0 0 0 -1.35', 1) + noiseF('nB', '-2.4 0 0 0 0.95', 0) + bevelDefs('bv') +
      lin('top', [[0, gray(38)], [.5, gray(24)], [1, gray(15)]]) +
      radial('spec', [[0, '#fff', .075], [1, '#fff', 0]], .12, .06, .75) +
      `<clipPath id="cPl"><rect x="${b.x0}" y="${b.y0}" width="${W}" height="${H}" rx="${rr}"/></clipPath>` +
      radial('dome', [[0, gray(250)], [.35, gray(175)], [.8, gray(70)], [1, gray(40)]], .36, .34, .7) +
      radial('lens', [[0, 'rgb(255,246,232)'], [.45, 'rgb(240,214,182)'], [.85, 'rgb(150,124,100)'], [1, 'rgb(70,60,52)']], .42, .4, .6) +
      radial('post', [[0, gray(150)], [.6, gray(80)], [1, gray(36)]], .38, .36, .7) +
      lin('cueBody', [[0, gray(70)], [.5, gray(38)], [1, gray(20)]]);
    let o = '';

    // Plinth: soft drop shadow, tight contact shadow, matte top with fine grain, lit bevel.
    if (!bare) {
    o += shadow(plinthShape('#000'), P(10), P(14), 'fX', .55) + shadow(plinthShape('#000'), P(2), P(3), 'fM', .7);
    o += plinthShape('url(#top)');
    o += `<g clip-path="url(#cPl)"><rect x="${b.x0}" y="${b.y0}" width="${W}" height="${H}" filter="url(#nW)" opacity=".09"/>` +
      `<rect x="${b.x0}" y="${b.y0}" width="${W}" height="${H}" filter="url(#nB)" opacity=".22"/></g>`;
    o += plinthShape('url(#spec)');
    o += `<rect x="${N(b.x0 + P(.7))}" y="${N(b.y0 + P(.7))}" width="${N(W - P(1.4))}" height="${N(H - P(1.4))}" rx="${N(rr - P(.7))}" fill="none" stroke="url(#bv)" stroke-width="${N(P(1.4))}"/>`;
    o += text(b.x0 + 12, b.y0 + 11, 'VINYL', 4.2, { anchor: 'start', spacing: .5, alpha: .34, weight: 700 }) +
      text(b.x0 + 12, b.y0 + 17, 'DIRECT DRIVE TURNTABLE', 2.6, { anchor: 'start', spacing: .32, alpha: .2 });
    }

    // Platter well, platter (turned aluminium rim) and the record's contact shadow on it.
    if (bare) {   // no plinth / platter: the record floats on the surface with its own shadow
      o += shadow(`<circle r="100" fill="#000"/>`, P(9), P(13), 'fX', .55) + shadow(`<circle r="100" fill="#000"/>`, P(2), P(3), 'fM', .7);
    } else {
    o += `<circle r="${N(Rp + P(3))}" fill="${gray(7)}"/>` + bevelRing(0, 0, Rp + P(3) - P(.6), P(1.2), 'bv', true);
    o += shadow(`<circle r="${N(Rp)}" fill="#000"/>`, P(2), P(2.6), 'fS', .85);
    o += fan(0, 0, 92, Rp, 180, brushed(132, 105, 60, 11, 7));
    o += ring(0, 0, Rp - P(.4), P(.8), 'rgba(0,0,0,.55)') + bevelRing(0, 0, Rp - P(1.2), P(.9), 'bv');
    o += ring(0, 0, Rp - P(G.rimPx(R) * .5 + 1.6), P(.6), 'rgba(0,0,0,.25)');   // step between the strobe rows
    o += shadow(`<circle r="100.6" fill="#000"/>`, P(1.4), P(1.9), 'fS', .8) + `<circle r="${N(100 + P(.8))}" fill="#000" opacity=".35"/>`;
    }

    // Parts set into the surface (bare preview): a darker well, a soft inner shadow along the
    // edge nearest the light, and a lit lip on the far side — like a cut-out in a real deck.
    const recess = (id, shape) => {
      o += `<clipPath id="${id}">${shape('fill="#000"')}</clipPath>` + shape('fill="#000" opacity=".3"');
      o += `<g clip-path="url(#${id})"><g transform="translate(${N(P(2.6))} ${N(P(3.2))})" filter="url(#fM)">${shape(`fill="none" stroke="#000" stroke-opacity=".9" stroke-width="${N(P(8))}"`)}</g></g>`;
      o += shape(`fill="none" stroke="url(#bvIn)" stroke-width="${N(P(1.6))}"`);
    };
    const hole = (cx, cy, r) => a => `<circle cx="${N(cx)}" cy="${N(cy)}" r="${N(r)}" ${a}/>`;
    if (bare) {
      recess('rP', hole(...G.pivot, 31));
      recess('rS', hole(...G.skate, 7.8));
      recess('rR', hole(...G.restPost, 7.4));
      recess('rC', a => `<rect x="-6.8" y="-10.8" width="13.6" height="23.6" rx="3.6" transform="translate(${G.cue[0]} ${G.cue[1]}) rotate(-35)" ${a}/>`);
      // 33 / 45 slide switch: a slot cut into the surface, with tiny printed labels
      const [wx, wy, ww, wh] = G.speedSwitch;
      recess('rW', a => `<rect x="${wx - ww / 2}" y="${wy - wh / 2}" width="${ww}" height="${wh}" rx="${wh / 2}" ${a}/>`);
      o += text(wx - ww / 4, wy - wh / 2 - 4.2, '33', 3, { alpha: .45 }) + text(wx + ww / 4, wy - wh / 2 - 4.2, '45', 3, { alpha: .45 });
      o += text(wx, wy + wh / 2 + 4.4, 'RPM', 2.4, { alpha: .32, spacing: .4 });
    }

    // Strobe lamp: knurled housing, warm lens.
    const [lx, ly] = G.lamp;
    if (!bare) {
    o += shadow(`<circle cx="${lx}" cy="${ly}" r="9.6" fill="#000"/>`, P(2.5), P(3.2), 'fM', .7);
    o += fan(lx, ly, 0, 9.6, 72, brushed(78, 80, 35, 5, 5)) + knurl(lx, ly, 8.4, 9.6, 72, P(.55));
    o += bevelRing(lx, ly, 9.4, P(.6), 'bv');
    o += `<circle cx="${lx}" cy="${ly}" r="5.8" fill="url(#lens)"/>` + bevelRing(lx, ly, 6.1, P(.8), 'bv', true);
    o += `<ellipse cx="${lx - 1.8}" cy="${ly - 2}" rx="1.6" ry="1" fill="#fff" opacity=".8" transform="rotate(-45 ${lx - 1.8} ${ly - 2})"/>`;
    }

    // Tonearm base: knurled collar → height-adjust ring with ticks → recess the gimbal sits in.
    const [px, py] = G.pivot;
    o += shadow(`<circle cx="${px}" cy="${py}" r="27" fill="#000"/>`, P(3.5), P(4.5), 'fL', .65);
    o += fan(px, py, 0, 27, 120, brushed(58, 70, 28, 21, 5)) + knurl(px, py, 25.9, 27, 240, P(.35)) + bevelRing(px, py, 26.8, P(.6), 'bv');
    o += shadow(`<circle cx="${px}" cy="${py}" r="20.5" fill="#000"/>`, P(1.6), P(2.1), 'fS', .7);
    o += fan(px, py, 0, 20.5, 120, brushed(112, 95, 45, 22, 6)) + bevelRing(px, py, 20.2, P(.7), 'bv');
    let ticks = '';
    for (let i = 0; i < 60; i++) {
      const a = i / 60 * TAU, long = i % 5 === 0;
      ticks += `M${pt(px, py, long ? 16.2 : 17.4, a)}L${pt(px, py, 19.2, a)}`;
    }
    o += `<path d="${ticks}" stroke="#000" stroke-opacity=".45" stroke-width="${N(P(.45))}"/>`;
    o += `<path d="${ticks}" stroke="#fff" stroke-opacity=".12" stroke-width="${N(P(.45))}" transform="translate(${N(P(.45))} ${N(P(.45))})"/>`;
    [0, 2, 4, 6].forEach((n, k) => {
      const a = rad(-90 + k * 30);
      o += text(px + 13.6 * Math.cos(a), py + 13.6 * Math.sin(a), String(n), 2.4, { alpha: .32, rotate: -90 + k * 30 + 90 });
    });
    o += `<circle cx="${px}" cy="${py}" r="12.4" fill="${gray(12)}"/>` + bevelRing(px, py, 12.1, P(.9), 'bv', true);

    // Anti-skate dial: knurled knob, indicator notch, scale 0–3.
    const [sx, sy] = G.skate, sa = v => rad(150 + v * 80);
    o += shadow(`<circle cx="${sx}" cy="${sy}" r="6.4" fill="#000"/>`, P(2.2), P(2.8), 'fM', .7);
    o += fan(sx, sy, 0, 6.4, 64, brushed(70, 75, 30, 31, 5)) + knurl(sx, sy, 5.4, 6.4, 56, P(.45));
    o += fan(sx, sy, 0, 4.4, 64, brushed(135, 95, 45, 32, 6)) + bevelRing(sx, sy, 4.3, P(.6), 'bv');
    o += `<path d="M${pt(sx, sy, .8, sa(1.5))}L${pt(sx, sy, 4, sa(1.5))}" stroke="${gray(20)}" stroke-width="${N(P(.9))}" stroke-linecap="round"/>`;
    for (let v = 0; v <= 3; v += .5) {
      const a = sa(v);
      if (v % 1) o += `<circle cx="${N(sx + 8.4 * Math.cos(a))}" cy="${N(sy + 8.4 * Math.sin(a))}" r=".35" fill="#fff" fill-opacity=".25"/>`;
      else o += text(sx + 9.4 * Math.cos(a), sy + 9.4 * Math.sin(a), String(v), 2.6, { alpha: .3 });
    }
    o += text(sx, sy + 14.5, 'ANTI-SKATE', 2, { alpha: .2, spacing: .3 });

    // Arm rest post (the clip sits above the arm, in its own layer).
    const [rx, ry] = G.restPost;
    o += shadow(`<circle cx="${N(rx)}" cy="${N(ry)}" r="5.4" fill="#000"/>`, P(2.4), P(3), 'fM', .7);
    o += fan(rx, ry, 0, 5.4, 48, brushed(60, 60, 25, 41, 4)) + bevelRing(rx, ry, 5.2, P(.6), 'bv');
    o += `<circle cx="${N(rx)}" cy="${N(ry)}" r="3.6" fill="url(#post)"/>`;
    o += `<g transform="translate(${N(rx)} ${N(ry)}) rotate(${N(G.rest + deg(G.tubeA))})"><rect x="-3" y="-2.6" width="6" height="5.2" rx="1" fill="${gray(18)}"/></g>`;

    // Cue lever housing.
    const [cx, cy] = G.cue, cueRect = `<rect x="-5" y="-9" width="10" height="20" rx="2.4" transform="translate(${cx} ${cy}) rotate(-35)"/>`;
    o += shadow(cueRect.replace('<rect', '<rect fill="#000"'), P(2.4), P(3), 'fM', .7);
    o += cueRect.replace('<rect', '<rect fill="url(#cueBody)"');
    o += cueRect.replace('<rect', `<rect fill="none" stroke="url(#bv)" stroke-width="${N(P(.7))}"`);
    o += text(cx + 8.5, cy + 13, '▲', 2.2, { alpha: .25 }) + text(cx + 12, cy + 10, '▼', 2.2, { alpha: .25 });

    if (bare) return { origin: [0, 0], box, svg: svg(box, s, o, defs, 'base') };

    // Pitch fader track with a ±8 % scale and a centre detent mark.
    const { x: fx, y0: fy0, y1: fy1 } = G.pitch, fm = (fy0 + fy1) / 2;
    o += `<rect x="${fx - 2}" y="${fy0 - 6}" width="4" height="${fy1 - fy0 + 12}" rx="2" fill="${gray(4)}"/>`;
    o += `<rect x="${N(fx - 2 + P(.4))}" y="${N(fy0 - 6 + P(.4))}" width="${N(4 - P(.8))}" height="${N(fy1 - fy0 + 12 - P(.8))}" rx="1.8" fill="none" stroke="url(#bvIn)" stroke-width="${N(P(.8))}"/>`;
    let scale = '';
    for (let v = -8; v <= 8; v += 2) {
      const y = fm + v / 8 * (fy1 - fy0) / 2, long = v % 4 === 0;
      scale += `M${fx - 9} ${N(y)}L${fx - (long ? 14 : 12)} ${N(y)}`;
      if (long) o += text(fx - 16, y, v > 0 ? '+' + v : v < 0 ? '−' + -v : '0', 2.6, { anchor: 'end', alpha: .3 });
    }
    o += `<path d="${scale}" stroke="#fff" stroke-opacity=".28" stroke-width="${N(P(.5))}"/>`;
    o += `<path d="M${fx + 6} ${fm}l2.6 -1.6v3.2z" fill="#fff" fill-opacity=".35"/>`;
    o += text(fx, fy0 - 12, 'PITCH', 2.6, { alpha: .28, spacing: .4 }) + text(fx, fy1 + 11, '%', 2.4, { alpha: .22 });

    // Key wells + LED holes for the HTML push buttons, and their printed labels.
    for (const [kx, ky, kw, kh] of Object.values(G.keys)) {
      o += `<rect x="${N(kx - P(1.5))}" y="${N(ky - P(1.5))}" width="${N(kw + P(3))}" height="${N(kh + P(3))}" rx="1.6" fill="${gray(6)}"/>`;
      o += `<rect x="${N(kx - P(1.5))}" y="${N(ky - P(1.5))}" width="${N(kw + P(3))}" height="${N(kh + P(3))}" rx="1.6" fill="none" stroke="url(#bvIn)" stroke-width="${N(P(.8))}"/>`;
    }
    for (const [ex, ey] of Object.values(G.leds)) o += `<circle cx="${ex}" cy="${ey}" r="2.4" fill="${gray(5)}"/>` + bevelRing(ex, ey, 2.4, P(.6), 'bv', true);
    const st = G.keys.start, k33 = G.keys.s33, k45 = G.keys.s45;
    o += text(st[0] + st[2] / 2, st[1] + st[3] + 7.5, 'START · STOP', 2.6, { alpha: .28, spacing: .3 });
    o += text((k33[0] + k45[0] + k45[2]) / 2, k33[1] + k33[3] + 7, 'RPM', 2.6, { alpha: .28, spacing: .4 });
    o += text(lx, ly + 14, 'STROBE', 2, { alpha: .2, spacing: .3 });

    return { origin: [0, 0], box, svg: svg(box, s, o, defs, 'base') };
  }

  // Strobe dots on the platter rim: two rows, one calibrated for 33⅓ and one for 45.
  function dots(s, R, which) {
    const P = v => v / s, rim = G.rimPx(R), Rp = 100 + P(rim);
    const r = which === 33 ? Rp - P(rim * .26) : Rp - P(rim * .66), n = which === 33 ? 120 : 90, dr = P(Math.min(1.05, rim * .11));
    let d = '';
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU, x = r * Math.cos(a), y = r * Math.sin(a);
      d += `M${N(x - dr)} ${N(y)}a${N(dr)} ${N(dr)} 0 1 0 ${N(2 * dr)} 0a${N(dr)} ${N(dr)} 0 1 0 ${N(-2 * dr)} 0`;
    }
    const box = [-Rp, -Rp, 2 * Rp, 2 * Rp];
    const body = `<path d="${d}" fill="#000" fill-opacity=".6" transform="translate(${N(P(.45))} ${N(P(.55))})"/><path d="${d}" fill="${gray(232)}"/>`;
    return { origin: [0, 0], box, svg: svg(box, s, body, '', 'd' + which) };
  }

  // Light from the strobe lamp falling on the plinth and the rim.
  function lampGlow(s) {
    const [lx, ly] = G.lamp, r = 52, box = [lx - r, ly - r, 2 * r, 2 * r];
    const b = G.bounds;
    const defs = radial('g', [[0, 'rgb(255,238,215)', .34], [.25, 'rgb(255,232,205)', .14], [1, 'rgb(255,230,200)', 0]]) +
      `<clipPath id="c"><rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" rx="8"/></clipPath>`;
    return { origin: [0, 0], box, svg: svg(box, s, `<circle cx="${lx}" cy="${ly}" r="${r}" fill="url(#g)" clip-path="url(#c)"/>`, defs, 'glow') };
  }

  function spindle(s) {
    const P = v => v / s, box = [-6, -6, 12, 12];
    const defs = blur('f', P(.9)) + radial('d', [[0, gray(255)], [.3, gray(205)], [.75, gray(95)], [1, gray(45)]], .36, .34, .7);
    return { origin: [0, 0], box, svg: svg(box, s, shadow('<circle r="2.5" fill="#000"/>', P(1), P(1.3), 'f', .7) + '<circle r="2.5" fill="url(#d)"/>', defs, 'spin') };
  }

  // =============================================================================
  //  Tonearm (rotates round the bearing). Arm frame: +x from the pivot towards the stylus.
  //  The lit side of every cylinder is local +y — it faces the top-left light across the arm's swing.
  // =============================================================================
  const ARM_BOX = [-66, -30, 230, 60];
  function armBody(id, s) {
    const P = v => v / s, { joint: [jx, jy], tubeLen } = G, tubeDeg = deg(G.tubeA);
    const cyl = (k, stops) => lin(id + k, stops, 0, 1, 0, 0);
    // dark edge → faint bounce → dark → mid → bright → sharp specular → dark edge (lit side last)
    const chrome = [[0, gray(42)], [.07, gray(96)], [.16, gray(40)], [.48, gray(128)], [.74, gray(196)], [.8, gray(255)], [.86, gray(182)], [.95, gray(88)], [1, gray(50)]];
    const darkMetal = [[0, gray(16)], [.08, gray(46)], [.18, gray(18)], [.55, gray(58)], [.78, gray(104)], [.83, gray(170)], [.88, gray(92)], [1, gray(24)]];
    const satin = [[0, gray(40)], [.1, gray(70)], [.25, gray(48)], [.6, gray(118)], [.82, gray(170)], [.88, gray(210)], [.93, gray(150)], [1, gray(60)]];
    const defs = cyl('c', chrome) + cyl('d', darkMetal) + cyl('s', satin) +
      cyl('k', [[0, gray(10)], [.2, gray(28)], [.6, gray(30)], [.85, gray(52)], [1, gray(14)]]) +
      cyl('y', [[0, gray(30)], [.5, gray(80)], [.85, gray(150)], [1, gray(60)]]) +
      radial(id + 'scr', [[0, gray(240)], [.5, gray(150)], [1, gray(50)]], .38, .36, .7);
    const u = k => `url(#${id}${k})`;
    let o = '';

    // Gimbal yoke round the bearing (the round cap sits on top, in its own layer).
    o += `<rect x="-13" y="-15.5" width="4.5" height="31" rx="1.2" fill="${u('y')}"/>`;
    o += `<rect x="-11" y="-15.5" width="20" height="4.6" rx="1.2" fill="${u('y')}"/><rect x="-11" y="10.9" width="20" height="4.6" rx="1.2" fill="${u('y')}"/>`;
    for (const y of [-13.2, 13.2]) o += `<circle cx="1" cy="${y}" r="1.7" fill="url(#${id}scr)"/><path d="M-.2 ${y}h2.4" stroke="#000" stroke-opacity=".5" stroke-width="${N(P(.5))}"/>`;

    o += `<g transform="rotate(${N(tubeDeg)})">`;
    // Rear stub and main tube: straight, brushed chrome.
    o += `<rect x="-62" y="-2.4" width="52" height="4.8" fill="${u('c')}"/>`;
    o += `<rect x="-12" y="-3.1" width="${N(tubeLen + 13)}" height="6.2" rx="3.1" fill="${u('c')}"/>`;
    o += `<path d="M-10 2.15H${N(tubeLen)}" stroke="#fff" stroke-opacity=".5" stroke-width="${N(P(.5))}"/>`;
    // Counterweight: knurled body, tracking-force scale ring (0–3 g), radially brushed end cap.
    o += `<rect x="-56" y="-9.6" width="21" height="19.2" rx="1.4" fill="${u('d')}"/>`;
    let kn = '', kl = '';
    for (let k = -84; k <= 84; k += 7) { const y = N(9.6 * Math.sin(rad(k))); (k / 7) % 2 ? (kn += `M-55 ${y}H-45`) : (kl += `M-55 ${y}H-45`); }
    o += `<path d="${kn}" stroke="#000" stroke-opacity=".7" stroke-width="${N(P(.6))}"/><path d="${kl}" stroke="#fff" stroke-opacity=".22" stroke-width="${N(P(.5))}"/>`;
    o += `<rect x="-35.5" y="-8.8" width="8.5" height="17.6" rx="1" fill="${u('s')}"/>`;
    let sc = '';
    for (let k = -70; k <= 70; k += 10) { const y = N(8.8 * Math.sin(rad(k))); sc += `M${k % 30 ? -29.6 : -31} ${y}H-27.4`; }
    o += `<path d="${sc}" stroke="#000" stroke-opacity=".6" stroke-width="${N(P(.4))}"/>`;
    ['0', '1', '2', '3'].forEach((n, i) => { const y = 8.8 * Math.sin(rad(-60 + i * 40)); o += `<text x="-33.2" y="${N(y)}" font-family="${FONT}" font-size="2.3" font-weight="600" fill="#000" fill-opacity=".55" text-anchor="middle" dominant-baseline="middle" transform="rotate(90 -33.2 ${N(y)})">${n}</text>`; });
    o += `<path d="M-27 -8.8V8.8" stroke="#fff" stroke-opacity=".3" stroke-width="${N(P(.6))}"/>`;
    o += `<g transform="translate(-56.4 0) scale(.26 1)">${fan(0, 0, 0, 9.6, 64, brushed(95, 120, 55, 51, 9))}</g>`;
    o += `<ellipse cx="-56.4" cy="0" rx="2.5" ry="9.6" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="${N(P(.5))}"/>`;
    o += `</g>`;

    // Headshell, offset 22° so the cartridge sits tangent to the groove.
    o += `<g transform="translate(${N(jx)} ${N(jy)}) rotate(${G.headOffset})">`;
    // finger lift on the outer side
    const lift = 'M20.5 -7.6C22.4 -10.6 24.6 -12.6 27.6 -13.8';
    o += `<path d="${lift}" fill="none" stroke="${gray(18)}" stroke-width="3" stroke-linecap="round"/>`;
    o += `<path d="${lift}" fill="none" stroke="${gray(140)}" stroke-width="1.2" stroke-linecap="round" transform="translate(-.4 .45)"/>`;
    o += `<ellipse cx="28.2" cy="-14" rx="2.4" ry="1.7" transform="rotate(-22 28.2 -14)" fill="${gray(30)}"/>`;
    o += `<ellipse cx="27.9" cy="-13.6" rx="1.5" ry=".8" transform="rotate(-22 27.9 -13.6)" fill="${gray(120)}"/>`;
    // cartridge body (beveled, muted accent) under the shell, cantilever + stylus in front
    o += `<rect x="12" y="-6.4" width="21.2" height="12.8" rx="1.2" fill="${u('k')}"/>`;
    o += `<rect x="12.3" y="-6.1" width="20.6" height="12.2" rx="1" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="${N(P(.5))}"/>`;
    o += `<rect x="30.4" y="-6.4" width="1.1" height="12.8" fill="rgb(118,64,60)"/>`;
    o += `<path d="M31.5 0H35" stroke="${gray(175)}" stroke-width=".55" stroke-linecap="round"/><circle cx="35" cy="0" r=".5" fill="${gray(235)}"/>`;
    // tapered shell
    const shell = 'M-1 -4.9L28.6 -8.1Q30.4 -8.2 30.4 -6.6V6.6Q30.4 8.2 28.6 8.1L-1 4.9Z';
    o += `<path d="${shell}" fill="${u('s')}"/>`;
    o += `<path d="${shell}" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="${N(P(.6))}"/>`;
    o += `<path d="M0 4.4L28.4 7.4" stroke="#fff" stroke-opacity=".45" stroke-width="${N(P(.6))}"/>`;
    // mounting slots and screws
    for (const y of [-4.3, 4.3]) {
      o += `<rect x="11" y="${y - 1.15}" width="15" height="2.3" rx="1.15" fill="#000" fill-opacity=".62"/>`;
      o += `<circle cx="18.5" cy="${y}" r="1.45" fill="url(#${id}scr)"/><path d="M17.5 ${y - .7}l2 1.4" stroke="#000" stroke-opacity=".55" stroke-width="${N(P(.45))}"/>`;
    }
    // collar joining the tube
    o += `<rect x="-7" y="-3.9" width="7.6" height="7.8" rx="1" fill="${u('c')}"/>`;
    o += `<path d="M-3.2 -3.9V3.9" stroke="#000" stroke-opacity=".35" stroke-width="${N(P(.5))}"/>`;
    o += `</g>`;
    return { defs, body: o };
  }

  function arm(s) {
    const { defs, body } = armBody('a', s);
    return { origin: G.pivot, box: ARM_BOX, svg: svg(ARM_BOX, s, body, defs, 'arm') };
  }
  // The arm's shadow: the same shape turned black and blurred (a separate layer, offset by the app).
  function armShadow(s, blurPx, id) {
    const P = v => v / s, sd = P(blurPx), pad = sd * 3;
    const box = [ARM_BOX[0] - pad, ARM_BOX[1] - pad, ARM_BOX[2] + 2 * pad, ARM_BOX[3] + 2 * pad];
    const { defs, body } = armBody(id, s);
    const f = `<filter id="${id}f" x="-20%" y="-60%" width="140%" height="220%"><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"/><feGaussianBlur stdDeviation="${N(sd)}"/></filter>`;
    return { origin: G.pivot, box, svg: svg(box, s, `<g filter="url(#${id}f)">${body}</g>`, defs + f, id) };
  }

  // Bearing cap on top of the gimbal (round, so it doesn't need to turn with the arm).
  function pivotTop(s) {
    const P = v => v / s, box = [-16, -16, 32, 32];
    const defs = blur('f', P(2)) + bevelDefs('bv') + radial('d', [[0, gray(245)], [.3, gray(190)], [.75, gray(85)], [1, gray(40)]], .36, .34, .72);
    let o = shadow('<circle r="10" fill="#000"/>', P(2.4), P(3), 'f', .6);
    o += fan(0, 0, 0, 10, 96, brushed(110, 110, 50, 61, 7)) + bevelRing(0, 0, 9.7, P(.7), 'bv');
    o += ring(0, 0, 7.2, P(.6), 'rgba(0,0,0,.45)');
    o += `<circle r="6.6" fill="url(#d)"/>`;
    o += `<circle r="1.5" fill="${gray(30)}"/><path d="M-1.2 0H1.2" stroke="${gray(140)}" stroke-width="${N(P(.5))}"/>`;
    return { origin: G.pivot, box, svg: svg(box, s, o, defs, 'pt') };
  }

  // Arm-rest clip: two prongs either side of the parked tube.
  function restClip(s) {
    const P = v => v / s, box = [-10, -10, 20, 20];
    const defs = blur('f', P(1)) + lin('m', [[0, gray(150)], [.5, gray(70)], [1, gray(25)]]);
    const prongs = fill => `<g transform="rotate(${N(G.rest + deg(G.tubeA))})"><rect x="-2.6" y="-5.9" width="5.2" height="2.3" rx=".8" fill="${fill}"/><rect x="-2.6" y="3.6" width="5.2" height="2.3" rx=".8" fill="${fill}"/></g>`;
    return { origin: G.restPost, box, svg: svg(box, s, shadow(prongs('#000'), P(1.4), P(1.8), 'f', .7) + prongs('url(#m)'), defs, 'clip') };
  }

  // Cue lever: short lever with a rounded pad. It turns ~28° and casts a longer shadow when raised.
  function cueLever(s) {
    const P = v => v / s, box = [-8, -8, 30, 16];
    const defs = blur('f', P(1.4)) + lin('m', [[0, gray(200)], [.5, gray(120)], [1, gray(50)]], 0, 1, 0, 0) +
      radial('p', [[0, gray(90)], [.7, gray(36)], [1, gray(18)]], .38, .36, .65);
    const shape = (f1, f2) => `<rect x="0" y="-1.5" width="15" height="3" rx="1.5" fill="${f1}"/><circle cx="16.5" cy="0" r="3.4" fill="${f2}"/><circle r="2.6" fill="${f1}"/>`;
    return { origin: G.cue, box, svg: svg(box, s, shadow(shape('#000', '#000'), P(1.8), P(2.3), 'f', .6) + shape('url(#m)', 'url(#p)'), defs, 'cue') };
  }

  return { G, base, dots, lampGlow, spindle, arm, armShadow, pivotTop, restClip, cueLever };
})();
