'use strict';
/* ===== scene.js — misty-hills header, drawn once as an <img> ===== */
const THEMES = {
  earth:  { sky: ['#EBC9A0', '#F7E9D4'], ridges: ['#E2B88E', '#CF946A', '#B0704C', '#7E4A33'], sun: '#C8452C', ac: '#B0532A', ac2: '#C99230' },
  forest: { sky: ['#C9DFCB', '#EFF4E7'], ridges: ['#AECBA8', '#84AC82', '#5C8C61', '#3B6948'], sun: '#FFFDF4', ac: '#3B7A4D', ac2: '#C6613A' },
  sea:    { sky: ['#B8DCE8', '#EDF6F4'], ridges: ['#A3CEDC', '#74B2C8', '#4690B0', '#256A8C'], sun: '#FFFFFF', ac: '#1D7898', ac2: '#E0784E' },
  wind:   { sky: ['#CFDBF0', '#F4F2F8'], ridges: ['#C3CEE6', '#A6B4D7', '#8894C2', '#6772A6'], sun: '#FFFFFF', ac: '#4569B3', ac2: '#D9A32E' }
};
const THEME_NAMES = { earth: 'Đất', forest: 'Rừng', sea: 'Biển', wind: 'Gió' };
const PHASES = {
  dawn:  { sky: ['#EDB9AC', '#FAE3CF'], tint: '#F2B3A0', k: 0.22 },
  dusk:  { sky: ['#D98A7E', '#F4C9A6'], tint: '#6A3E62', k: 0.42 },
  night: { sky: ['#16203D', '#34406A'], tint: '#111933', k: 0.66 }
};
function phaseOf(h) { return h >= 5 && h < 8 ? 'dawn' : h >= 8 && h < 16 ? 'day' : h >= 16 && h < 19 ? 'dusk' : 'night'; }
function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function mix(a, b, k) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const x = p(a), y = p(b);
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, '0')).join('');
}
function ridge(yBase, amp, seed, freq, W = 800, H = 440) {
  const r = rng(seed), p = [r() * 6, r() * 6];
  let d = `M0 ${H} L`;
  for (let x = 0; x <= W; x += 5) {
    const y = yBase - amp * (0.7 * Math.sin(x * freq + p[0]) + 0.3 * Math.sin(x * freq * 2.1 + p[1]));
    d += `${x} ${y.toFixed(1)} L`;
  }
  return d + `${W} ${H}Z`;
}
function sceneURL(theme, phase) {
  const T = THEMES[theme] || THEMES.forest, P = PHASES[phase];
  const W = 800, H = 440, sky = P ? P.sky : T.sky;
  const rid = T.ridges.map(c => P ? mix(c, P.tint, P.k) : c);
  const R = [[246, 26, .0085], [286, 22, .011], [326, 18, .014], [366, 14, .018]];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">` +
    `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient>` +
    `<linearGradient id="m" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="${phase === 'night' ? .12 : .35}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#s)"/>`;
  if (phase === 'night') {
    const r = rng(11);
    for (let i = 0; i < 38; i++) s += `<circle cx="${(r() * W).toFixed(0)}" cy="${(r() * 190).toFixed(0)}" r="${(r() * 1.3 + .4).toFixed(1)}" fill="#fff" opacity="${(r() * .5 + .35).toFixed(2)}"/>`;
    s += `<circle cx="600" cy="120" r="30" fill="#F4F0DC"/><circle cx="614" cy="110" r="27" fill="${sky[0]}"/>`;
  } else {
    const sun = phase === 'dawn' || phase === 'dusk' ? '#FFF3E0' : T.sun;
    s += `<circle cx="600" cy="${phase === 'day' ? 120 : 165}" r="34" fill="${sun}"/>`;
    const bird = phase === 'day' ? '#4B5560' : '#6A4A50';
    s += `<path d="M350 170q6-5 12 0q6-5 12 0M392 152q5-4 10 0q5-4 10 0M330 190q4-3 8 0q4-3 8 0" stroke="${bird}" fill="none" stroke-width="2" stroke-linecap="round" opacity=".7"/>`;
  }
  R.forEach((r, i) => {
    s += `<path d="${ridge(r[0], r[1], i * 7 + 3, r[2])}" fill="${rid[i]}"/>`;
    if (i < 3) s += `<rect y="${r[0] - 34}" width="${W}" height="46" fill="url(#m)"/>`;
  });
  return 'data:image/svg+xml,' + encodeURIComponent(s + '</svg>');
}
