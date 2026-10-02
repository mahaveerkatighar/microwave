document.documentElement.classList.add('js');

// ====== Firebase web-app config for project microwave-8db82 ======
const firebaseConfig = {
  apiKey: "AIzaSyAp5-AZGWq3scDUBlJFJcGcTJN4RcnC7hg",
  authDomain: "microwave-8db82.firebaseapp.com",
  databaseURL: "https://microwave-8db82-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "microwave-8db82",
  storageBucket: "microwave-8db82.firebasestorage.app",
  messagingSenderId: "777098116883",
  appId: "1:777098116883:web:1b54e635c7e8b976db64e6"
};
// ==================================================================

const $ = id => document.getElementById(id);
const NAMES = { LOS: 'Clear line of sight', WALL: 'Wall in between', HUMAN: 'Person in between', OTHER: 'Other' };
const COLORS = { LOS: '#1f77b4', WALL: '#d62728', HUMAN: '#2ca02c', OTHER: '#7f7f7f' };
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

let records = [];
let filter = 'ALL';
let knownIds = null;
let db = null;

// ---------- theory + helpers ----------
// FSPL(dB) = 32.44 + 20log10(d_km) + 20log10(f_MHz)
const fspl = (dM, fMHz) => 32.44 + 20 * Math.log10(dM / 1000) + 20 * Math.log10(fMHz);
const eirp = () => (parseFloat($('pt').value) || 0) + (parseFloat($('gains').value) || 0);
const plOf = r => eirp() - r.rssi;
const condOf = r => r.condition || 'OTHER';
const nameOf = c => NAMES[c] || c;
const colorOf = c => COLORS[c] || COLORS.OTHER;
const visible = () => filter === 'ALL' ? records : records.filter(r => condOf(r) === filter);

function quality(rssi) {            // rule-of-thumb Wi-Fi bands (not calibrated)
  if (rssi >= -55) return { bars: 4, label: 'Excellent', cls: 'q4' };
  if (rssi >= -65) return { bars: 3, label: 'Good', cls: 'q3' };
  if (rssi >= -75) return { bars: 2, label: 'Fair', cls: 'q2' };
  if (rssi >= -85) return { bars: 1, label: 'Weak', cls: 'q1' };
  return { bars: 1, label: 'Very weak', cls: 'q0' };
}
function drawBars(el, q) {
  el.className = 'bars' + (q ? ' ' + q.cls : '');
  el.innerHTML = [1, 2, 3, 4].map(i => `<i class="${q && i <= q.bars ? 'on' : ''}"></i>`).join('');
}

// mean of valFn(r) per distance -> sorted [{x,y}]
function meanSeries(list, valFn) {
  const g = {};
  list.forEach(r => {
    const d = Number(r.distance);
    if (!isFinite(d) || d <= 0 || typeof r.rssi !== 'number') return;
    (g[d] = g[d] || []).push(valFn(r));
  });
  return Object.keys(g).map(Number).sort((a, b) => a - b)
    .map(d => ({ x: d, y: g[d].reduce((a, b) => a + b, 0) / g[d].length }));
}

// least squares  y = a + s*x ; returns {s,a,r2}
function lsq(pts) {
  const N = pts.length, sx = pts.reduce((s, p) => s + p.x, 0), sy = pts.reduce((s, p) => s + p.y, 0);
  const sxy = pts.reduce((s, p) => s + p.x * p.y, 0), sxx = pts.reduce((s, p) => s + p.x * p.x, 0);
  const den = N * sxx - sx * sx; if (!den) return null;
  const s = (N * sxy - sx * sy) / den, a = (sy - s * sx) / N, yb = sy / N;
  const tot = pts.reduce((t, p) => t + (p.y - yb) ** 2, 0), res = pts.reduce((t, p) => t + (p.y - (a + s * p.x)) ** 2, 0);
  return { s, a, r2: tot ? 1 - res / tot : 0 };
}

// count-up animation for numbers
function countTo(el, to, dec, suffix = '') {
  const from = parseFloat(el.dataset.v); const start = isFinite(from) ? from : to;
  el.dataset.v = to; const tok = (el._tok = (el._tok || 0) + 1);
  if (start === to || reduced()) { el.textContent = to.toFixed(dec) + suffix; return; }
  const t0 = performance.now();
  const step = t => {
    if (el._tok !== tok) return;
    const k = Math.min(1, (t - t0) / 500);
    el.textContent = (start + (to - start) * k).toFixed(dec) + suffix;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- charts ----------
function makeChart(id, yTitle) {
  if (typeof Chart === 'undefined') return null;
  Chart.defaults.color = css('--fg') || '#1d2733';
  Chart.defaults.borderColor = css('--bd') || '#dde3ea';
  return new Chart($(id), {
    type: 'scatter', data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { type: 'linear', title: { display: true, text: 'Distance (m)' } },
                y: { title: { display: true, text: yTitle } } },
      plugins: { legend: { position: 'bottom' } }
    }
  });
}
const ch1 = makeChart('ch1', 'Signal strength, RSSI (dBm)');
const ch2 = makeChart('ch2', 'Apparent path loss (dB)');
const ch3 = makeChart('ch3', 'Path loss (dB)');

function condDatasets(list, valFn) {
  const conds = [...new Set(list.map(condOf))];
  const ds = conds.map(c => ({
    label: `${nameOf(c)} (average)`, data: meanSeries(list.filter(r => condOf(r) === c), valFn),
    showLine: true, tension: 0, pointRadius: 5, borderColor: colorOf(c), backgroundColor: colorOf(c)
  }));
  ds.push({ label: 'Individual readings', data: list.filter(r => typeof r.rssi === 'number').map(r => ({ x: Number(r.distance), y: valFn(r) })),
            showLine: false, pointRadius: 2, backgroundColor: 'rgba(120,120,120,.45)' });
  return ds;
}

function renderCharts() {
  const list = visible();
  if (ch1) { ch1.data.datasets = condDatasets(list, r => r.rssi); ch1.update('none'); }
  if (ch2) { ch2.data.datasets = condDatasets(list, plOf); ch2.update('none'); }

  const los = records.filter(r => condOf(r) === 'LOS');
  const base = filter === 'ALL' ? (los.length ? los : records) : list;
  const baseName = filter === 'ALL' ? (los.length ? 'clear line of sight' : 'all readings') : nameOf(filter).toLowerCase();
  const f = records.length ? Number(records[records.length - 1].frequency) || 2437 : 2437;
  const dists = base.map(r => Number(r.distance)).filter(d => d > 0);
  const maxD = dists.length ? Math.max(...dists, 2) : 10;

  const theory = [];
  for (let i = 0; i <= 40; i++) { const d = 0.5 + i * (maxD - 0.5) / 40; theory.push({ x: d, y: fspl(d, f) }); }
  const ds = [
    { label: `Measured (${baseName}, average)`, data: meanSeries(base, plOf), showLine: true, pointRadius: 5, borderColor: '#1f77b4', backgroundColor: '#1f77b4' },
    { label: `Theory: empty space @ ${f} MHz`, data: theory, showLine: true, pointRadius: 0, borderColor: '#d62728', borderDash: [6, 4] }
  ];

  // log-distance fit: PL = a + n*10log10(d)
  const pts = base.filter(r => Number(r.distance) > 0 && typeof r.rssi === 'number')
                  .map(r => ({ x: 10 * Math.log10(Number(r.distance)), y: plOf(r) }));
  const distinct = new Set(pts.map(p => p.x.toFixed(4))).size;
  let fit = null;
  if (distinct >= 2) {
    fit = lsq(pts);
    if (fit) {
      ds.push({ label: 'Fitted trend', data: theory.map(p => ({ x: p.x, y: fit.a + fit.s * 10 * Math.log10(p.x) })), showLine: true, pointRadius: 0, borderColor: '#2ca02c' });
      $('fit').textContent = `Fitted path-loss exponent n = ${fit.s.toFixed(2)} (free space = 2.00), R² = ${fit.r2.toFixed(2)}; intercept at 1 m = ${fit.a.toFixed(1)} dB (apparent). Theory FSPL at 1 m = ${fspl(1, f).toFixed(1)} dB.`;
    }
  } else {
    $('fit').textContent = 'Need at least two different distances to fit a path-loss exponent.';
  }
  if (ch3) { ch3.data.datasets = ds; ch3.update('none'); }
  renderSummary(base, baseName, fit);
}

// ---------- plain-language findings ----------
function renderSummary(base, baseName, fit) {
  const el = $('summary'); el.innerHTML = '';
  const add = (t, cls) => { const p = document.createElement('p'); p.textContent = t; if (cls) p.className = cls; el.appendChild(p); };
  const m = meanSeries(base, r => r.rssi);
  if (!base.length) { add('No measurements yet. Place the receiver at a marked distance and press SAVE on the board.'); return; }
  if (m.length < 2) { add(`So far there are ${base.length} reading(s), all at ${m[0] ? m[0].x : '?'} m. Take readings at other distances to see how the signal changes.`); return; }
  const a = m[0], b = m[m.length - 1], diff = a.y - b.y, th = 20 * Math.log10(b.x / a.x);
  if (diff > 0.5) {
    add(`At ${a.x} m the average signal was ${a.y.toFixed(0)} dBm. At ${b.x} m it was ${b.y.toFixed(0)} dBm, about ${diff.toFixed(0)} dB weaker.`);
    add(`In empty space, theory predicts about ${th.toFixed(0)} dB of weakening over this distance. We measured ${diff.toFixed(0)} dB.`);
  } else {
    add(`At ${a.x} m the average signal was ${a.y.toFixed(0)} dBm and at ${b.x} m it was ${b.y.toFixed(0)} dBm. No clear weakening yet: reflections in a room can hide the trend, so more readings help.`);
  }
  if (fit) {
    if (base.length < 6 || m.length < 3) add('There are too few readings to say how clear the trend is. Aim for 3 readings at each of 3 or more distances.');
    else add(fit.r2 >= 0.7 ? 'The trend is fairly clear: farther away means a weaker signal.'
          : fit.r2 >= 0.4 ? 'The weakening is visible but noisy.'
          : 'The readings are scattered. Indoors, signals bounce off walls and furniture and swing by several dB, so only the overall trend is reliable.');
  }
  add(`Based on ${base.length} saved readings (${baseName}) at ${m.length} distances.`, 'muted');
}

// ---------- cards / table / chips ----------
function renderCards() {
  const list = visible(), l = list[list.length - 1];
  countTo($('cCount'), list.length, 0);
  if (!l) {
    $('cRssi').textContent = '--'; $('cDist').textContent = '--'; $('cFreq').textContent = '--';
    $('cRssi').dataset.v = ''; drawBars($('cBars'), null);
    $('cQual').className = 'qual'; $('cQual').textContent = 'No data yet'; return;
  }
  const r = Number(l.rssi), q = quality(r);
  countTo($('cRssi'), r, 1, ' dBm');
  drawBars($('cBars'), q); $('cQual').className = 'qual ' + q.cls; $('cQual').textContent = q.label;
  $('cDist').textContent = `${Number(l.distance).toFixed(1)} m`;
  $('cFreq').textContent = `2.4 GHz (Ch ${l.channel})`;
  $('cFreqNote').textContent = `${l.frequency} MHz, same band as home Wi-Fi`;
}

function renderTable() {
  const tb = $('tbody'); tb.innerHTML = '';
  visible().slice(-200).reverse().forEach(r => {
    const tr = document.createElement('tr');
    const t = r.timestamp ? new Date(r.timestamp).toLocaleString() : '--';
    const q = quality(Number(r.rssi));
    const cells = [r.seq ?? r.id, t, Number(r.distance).toFixed(1), null, r.channel, nameOf(condOf(r))];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      if (i === 3) { const dot = document.createElement('span'); dot.className = 'dq ' + q.cls; td.appendChild(dot); td.appendChild(document.createTextNode(`${Number(r.rssi).toFixed(1)} (${q.label})`)); }
      else td.textContent = v;
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
}

function renderChips() {
  const cnt = { ALL: records.length, LOS: 0, WALL: 0, HUMAN: 0 };
  records.forEach(r => { const c = condOf(r); if (cnt[c] !== undefined) cnt[c]++; });
  Object.keys(cnt).forEach(k => { $('n_' + k).textContent = cnt[k]; });
  document.querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b.dataset.c === filter));
}

// ---------- animated scene ----------
const NS = 'http://www.w3.org/2000/svg';
const X0 = 190, X1 = 730;
const xOf = d => X0 + (d - 1) / 9 * (X1 - X0);
let shownD = 1, targetD = 1, tweenId = 0, playing = false, playId = 0, lastRounded = null;

(function buildTicks() {
  const g = $('ticks');
  for (let d = 1; d <= 10; d++) {
    const l = document.createElementNS(NS, 'line'); l.setAttribute('class', 'tick');
    l.setAttribute('x1', xOf(d)); l.setAttribute('x2', xOf(d)); l.setAttribute('y1', 220); l.setAttribute('y2', 232); g.appendChild(l);
    const t = document.createElementNS(NS, 'text'); t.setAttribute('class', 'lbl small'); t.setAttribute('x', xOf(d)); t.setAttribute('y', 250); t.setAttribute('text-anchor', 'middle'); t.textContent = d; g.appendChild(t);
  }
})();

function updateScene(d) {
  const x = xOf(d), mid = (134 + (x - 40)) / 2;
  $('rx').style.transform = `translate(${x}px,0)`;
  $('sigpath').setAttribute('x2', Math.max(140, x - 40));
  $('rxDist').textContent = `${d.toFixed(1)} m`;
  const amp = Math.max(0.1, Math.min(1, 1 - 0.9 * Math.log10(Math.max(d, 1))));   // illustrative fade (about 1/d trend)
  $('rxGlow').setAttribute('opacity', (0.45 * amp).toFixed(2));
  $('sigpath').style.opacity = (0.35 + 0.65 * amp).toFixed(2);
  $('obWall').style.display = filter === 'WALL' ? '' : 'none';
  $('obPerson').style.display = filter === 'HUMAN' ? '' : 'none';
  $('obWall').style.transform = $('obPerson').style.transform = `translate(${mid}px,0)`;
  const r = Math.round(d * 2) / 2;
  if (r !== lastRounded) { lastRounded = r; updateReadouts(r); }
}

function updateReadouts(d) {
  const loss = 20 * Math.log10(d);
  $('roTheory').innerHTML = d <= 1.01 ? 'Reference point: <b>1 m</b>. Everything else is compared with this.'
    : `At ${d.toFixed(1)} m the signal power is about <b>${Math.round(d * d)}&times; weaker</b> than at 1 m (&minus;${loss.toFixed(0)} dB).`;
  const m = meanSeries(visible(), r => r.rssi);
  if (!m.length) { $('roMeas').textContent = 'No measurement yet for this choice.'; drawBars($('bars'), null); return; }
  let best = m[0]; m.forEach(p => { if (Math.abs(p.x - d) < Math.abs(best.x - d)) best = p; });
  const q = quality(best.y);
  $('roMeas').innerHTML = `Nearest tested distance: <b>${best.x} m</b>, average <b>${best.y.toFixed(0)} dBm</b> (${q.label}).` +
    (Math.abs(best.x - d) > 0.75 ? ' <small>Not measured at exactly this distance.</small>' : '');
  drawBars($('bars'), q);
}

function goTo(d, ms = 350) {
  cancelAnimationFrame(tweenId);
  const from = shownD, t0 = performance.now();
  const step = t => {
    const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
    shownD = from + (d - from) * e; updateScene(shownD);
    if (k < 1) tweenId = requestAnimationFrame(step);
  };
  tweenId = requestAnimationFrame(step);
}
function stopPlay() { playing = false; cancelAnimationFrame(playId); $('btnPlay').innerHTML = '&#9654; Play walk-away demo'; }
function startPlay() {
  playing = true; $('btnPlay').innerHTML = '&#10074;&#10074; Pause demo';
  const t0 = performance.now(), period = 9000;
  const loop = t => {
    if (!playing) return;
    const d = 1 + 9 * (0.5 - 0.5 * Math.cos(2 * Math.PI * (t - t0) / period));
    shownD = d; targetD = d; updateScene(d);
    $('dist').value = (Math.round(d * 2) / 2).toFixed(1); $('distVal').textContent = d.toFixed(1) + ' m';
    playId = requestAnimationFrame(loop);
  };
  playId = requestAnimationFrame(loop);
}
$('btnPlay').addEventListener('click', () => playing ? stopPlay() : startPlay());
$('dist').addEventListener('input', e => {
  stopPlay(); targetD = parseFloat(e.target.value); $('distVal').textContent = targetD.toFixed(1) + ' m'; goTo(targetD);
});

// ---------- controls ----------
document.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => { filter = b.dataset.c; refresh(); }));
$('btnMode').addEventListener('click', () => {
  const on = document.body.classList.toggle('tech-on');
  $('btnMode').setAttribute('aria-pressed', on); $('btnMode').textContent = on ? 'Hide technical details' : 'Show technical details';
});
$('btnFull').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen(); else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
});
$('btnPrint').addEventListener('click', () => window.print());
$('pt').addEventListener('input', refresh);
$('gains').addEventListener('input', refresh);

// ---------- CSV export ----------
function buildCsv(list) {
  const cols = ['seq','timestamp_iso','distance_m','rssi_dbm','rssi_min','rssi_max','samples','frequency_mhz','channel','condition','trial','id'];
  const rows = list.map(r => [
    r.seq ?? '', r.timestamp ? new Date(r.timestamp).toISOString() : '', r.distance, r.rssi,
    r.rssi_min ?? '', r.rssi_max ?? '', r.samples ?? '', r.frequency ?? '', r.channel ?? '',
    r.condition ?? '', r.trial ?? '', r.id ?? ''
  ].join(','));
  return [cols.join(','), ...rows].join('\n');
}
function downloadCsv() {
  if (!records.length) { alert('No measurements yet.'); return; }
  const blob = new Blob([buildCsv(records)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'propagation_measurements.csv';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
}
$('btnCsv').addEventListener('click', downloadCsv);
$('btnCsv2').addEventListener('click', downloadCsv);

// ---------- toast + reveal ----------
let toastTimer = 0;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}
(function reveal() {
  const els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) { els.forEach(e => e.classList.add('in')); return; }
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.08 });
  els.forEach(e => io.observe(e));
})();


// ---------- remote control (SAVE / NEXT buttons that drive the receiver) ----------
let unlocked = false, pin = '', pending = null, pendTimer = 0, status = null, serverOffset = 0;
try { pin = sessionStorage.getItem('ctlpin') || ''; } catch (e) {}
const ACTIONS = { SAVE: 'SAVE', NEXT: 'NEXT distance', NEXT_COND: 'NEXT condition' };

function setCtl(msg, kind) { const m = $('ctlMsg'); m.textContent = msg; m.className = 'ctl-msg ' + (kind || ''); }
function updateCtlUi() {
  const on = unlocked && !pending && db;
  ['btnSave', 'btnNext', 'btnCond'].forEach(id => { $(id).disabled = !on; });
  $('lockState').textContent = unlocked ? '\uD83D\uDD13 Unlocked' : '\uD83D\uDD12 Locked';
}
function renderStatus() {
  const st = $('rxState'), s = status;
  if (!s) { st.className = 'pill off'; st.textContent = 'Receiver: no status yet'; ['stDist','stCond','stTrial','stWin','stRssi'].forEach(i => { $(i).textContent = '--'; }); return; }
  const age = Date.now() + serverOffset - (s.ts || 0), online = age < 20000;
  st.className = 'pill ' + (online ? 'on' : 'off');
  st.textContent = online ? 'Receiver: online' : `Receiver: offline (last seen ${Math.round(age / 1000)} s ago)`;
  $('stDist').textContent = `${Number(s.distance).toFixed(1)} m`;
  $('stCond').textContent = nameOf(s.condition);
  $('stTrial').textContent = s.trial;
  $('stWin').textContent = `${s.samples}/${s.window}`;
  $('stRssi').textContent = s.signal ? `${s.rssi} dBm` : 'not seen';
}
function checkAck() {
  if (pending && status && status.ack === pending.id) {
    clearTimeout(pendTimer);
    const ok = !/^(Not saved|Unknown)/.test(status.msg || '');
    setCtl((ok ? '\u2713 ' : '\u26A0 ') + (status.msg || 'Done'), ok ? 'ok' : 'wait');
    pending = null; updateCtlUi();
  }
}
function sendCmd(action) {
  if (!db || !unlocked || pending) return;
  const id = String(Date.now()) + String(Math.floor(Math.random() * 1000));
  pending = { id, action }; updateCtlUi();
  setCtl(`Sending ${ACTIONS[action]}\u2026 waiting for the receiver`, 'wait');
  db.ref('control').set({ id, action, pin }).catch(e => {
    pending = null; clearTimeout(pendTimer);
    if (e && e.code === 'PERMISSION_DENIED') { unlocked = false; setCtl('Wrong PIN. Check it and press Unlock again.', 'bad'); }
    else setCtl('Could not send: ' + (e && e.message), 'bad');
    updateCtlUi();
  });
  clearTimeout(pendTimer);
  pendTimer = setTimeout(() => {
    if (pending && pending.id === id) { pending = null; setCtl('No reply from the receiver. Is it powered and connected to the hotspot? (It checks for commands every few seconds.)', 'bad'); updateCtlUi(); }
  }, 15000);
}
function unlock() {
  const v = $('pin').value.trim(); if (!v) { setCtl('Enter the PIN first.', 'bad'); return; }
  pin = v; unlocked = true; try { sessionStorage.setItem('ctlpin', pin); } catch (e) {}
  setCtl('Unlocked. The database checks the PIN when you press a button.', 'ok'); updateCtlUi();
}
$('btnUnlock').addEventListener('click', unlock);
$('pin').addEventListener('keydown', e => { if (e.key === 'Enter') unlock(); });
$('btnSave').addEventListener('click', () => sendCmd('SAVE'));
$('btnNext').addEventListener('click', () => sendCmd('NEXT'));
$('btnCond').addEventListener('click', () => sendCmd('NEXT_COND'));
setInterval(renderStatus, 3000);                             // keeps "last seen" fresh
updateCtlUi();

// ---------- refresh + live data ----------
function refresh() {
  renderChips(); renderCards(); renderTable(); renderCharts();
  lastRounded = null; updateScene(shownD);
}

if (typeof firebase !== 'undefined') {
  firebase.initializeApp(firebaseConfig);
  db = firebase.database();
  db.ref('.info/serverTimeOffset').on('value', x => { serverOffset = x.val() || 0; });
  db.ref('status').on('value', x => { status = x.val(); renderStatus(); checkAck(); });
  db.ref('.info/connected').on('value', s => { $('conn').textContent = s.val() ? 'Firebase: connected' : 'Firebase: offline'; });
  db.ref('measurements').on('value', snap => {
    const arr = [];
    snap.forEach(ch => { const v = ch.val(); v.id = ch.key; arr.push(v); });
    arr.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || (a.seq || 0) - (b.seq || 0));
    if (knownIds) {                                           // after the first load: announce new records
      const fresh = arr.filter(r => !knownIds.has(r.id));
      if (fresh.length) {
        const l = fresh[fresh.length - 1];
        toast(`New measurement saved: ${Number(l.rssi).toFixed(0)} dBm at ${Number(l.distance).toFixed(1)} m`);
        const s = $('stepCloud'); s.classList.remove('pulse'); void s.offsetWidth; s.classList.add('pulse');
      }
    }
    knownIds = new Set(arr.map(r => r.id));
    records = arr; refresh();                                 // fires automatically on every new record
  }, err => { $('conn').textContent = 'Error: ' + err.message; });
} else {
  $('conn').textContent = 'Firebase library not loaded (check Internet)';
}
refresh();
