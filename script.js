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
// =======================================================================================
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const $ = id => document.getElementById(id);
const COLORS = { LOS: '#1f77b4', WALL: '#d62728', HUMAN: '#2ca02c', OTHER: '#7f7f7f' };
let records = [];

// FSPL(dB) = 32.44 + 20log10(d_km) + 20log10(f_MHz)
const fspl = (dM, fMHz) => 32.44 + 20 * Math.log10(dM / 1000) + 20 * Math.log10(fMHz);
const eirp = () => (parseFloat($('pt').value) || 0) + (parseFloat($('gains').value) || 0);
const plOf = r => eirp() - r.rssi;
const condOf = r => r.condition || 'OTHER';
const colorOf = c => COLORS[c] || COLORS.OTHER;

// Mean of valFn(r) per distance -> sorted [{x,y}]
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

function makeChart(id, yTitle) {
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
const ch1 = makeChart('ch1', 'RSSI (dBm)');
const ch2 = makeChart('ch2', 'Apparent path loss (dB)');
const ch3 = makeChart('ch3', 'Path loss (dB)');

function renderCards() {
  $('cCount').textContent = records.length;
  const l = records[records.length - 1];
  if (!l) return;
  $('cRssi').textContent = `${Number(l.rssi).toFixed(1)} dBm`;
  $('cDist').textContent = `${Number(l.distance).toFixed(1)} m`;
  $('cFreq').textContent = `${l.frequency} MHz (Ch ${l.channel})`;
}

function renderTable() {
  const tb = $('tbody'); tb.innerHTML = '';
  records.slice(-200).reverse().forEach(r => {
    const tr = document.createElement('tr');
    const t = r.timestamp ? new Date(r.timestamp).toLocaleString() : '--';
    [r.seq ?? r.id, t, Number(r.distance).toFixed(1), Number(r.rssi).toFixed(1), r.channel, condOf(r)]
      .forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
    tb.appendChild(tr);
  });
}

function condDatasets(valFn) {
  const conds = [...new Set(records.map(condOf))];
  const ds = conds.map(c => ({
    label: `${c} (mean)`, data: meanSeries(records.filter(r => condOf(r) === c), valFn),
    showLine: true, tension: 0, pointRadius: 5, borderColor: colorOf(c), backgroundColor: colorOf(c)
  }));
  ds.push({ label: 'All trials', data: records.filter(r => typeof r.rssi === 'number').map(r => ({ x: Number(r.distance), y: valFn(r) })),
            showLine: false, pointRadius: 2, backgroundColor: 'rgba(120,120,120,.45)' });
  return ds;
}

function renderCharts() {
  ch1.data.datasets = condDatasets(r => r.rssi); ch1.update('none');
  ch2.data.datasets = condDatasets(plOf);        ch2.update('none');

  const los = records.filter(r => condOf(r) === 'LOS');
  const base = los.length ? los : records;
  const f = records.length ? Number(records[records.length - 1].frequency) || 2437 : 2437;
  const dists = base.map(r => Number(r.distance)).filter(d => d > 0);
  const maxD = dists.length ? Math.max(...dists) : 10;

  const theory = [];
  for (let i = 0; i <= 40; i++) { const d = 0.5 + i * (maxD - 0.5) / 40; theory.push({ x: d, y: fspl(d, f) }); }

  const ds = [
    { label: `Experimental (${los.length ? 'LOS' : 'all'}, mean)`, data: meanSeries(base, plOf),
      showLine: true, pointRadius: 5, borderColor: '#1f77b4', backgroundColor: '#1f77b4' },
    { label: `Theoretical FSPL @ ${f} MHz`, data: theory, showLine: true, pointRadius: 0, borderColor: '#d62728', borderDash: [6, 4] }
  ];

  // Least-squares fit PL = a + n*10log10(d) (log-distance model)
  const pts = base.filter(r => Number(r.distance) > 0 && typeof r.rssi === 'number')
                  .map(r => ({ x: 10 * Math.log10(Number(r.distance)), y: plOf(r) }));
  const distinct = new Set(pts.map(p => p.x.toFixed(4))).size;
  if (distinct >= 2) {
    const N = pts.length, sx = pts.reduce((s, p) => s + p.x, 0), sy = pts.reduce((s, p) => s + p.y, 0);
    const sxy = pts.reduce((s, p) => s + p.x * p.y, 0), sxx = pts.reduce((s, p) => s + p.x * p.x, 0);
    const n = (N * sxy - sx * sy) / (N * sxx - sx * sx), a = (sy - n * sx) / N;
    ds.push({ label: 'Fitted log-distance model', data: theory.map(p => ({ x: p.x, y: a + n * 10 * Math.log10(p.x) })),
              showLine: true, pointRadius: 0, borderColor: '#2ca02c' });
    $('fit').textContent = `Fitted path-loss exponent n = ${n.toFixed(2)} (free space = 2.00); intercept at 1 m = ${a.toFixed(1)} dB (apparent). Theory FSPL at 1 m = ${fspl(1, f).toFixed(1)} dB.`;
  } else {
    $('fit').textContent = 'Need at least two different distances to fit a path-loss exponent.';
  }
  ch3.data.datasets = ds; ch3.update('none');
}

function refresh() { renderCards(); renderTable(); renderCharts(); }

db.ref('.info/connected').on('value', s => {
  $('conn').textContent = s.val() ? 'Firebase: connected' : 'Firebase: offline';
});
db.ref('measurements').on('value', snap => {
  const arr = [];
  snap.forEach(ch => { const v = ch.val(); v.id = ch.key; arr.push(v); });
  arr.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || (a.seq || 0) - (b.seq || 0));
  records = arr; refresh();               // fires automatically on every new record
}, err => { $('conn').textContent = 'Error: ' + err.message; });

$('pt').addEventListener('input', refresh);
$('gains').addEventListener('input', refresh);

// ---------- CSV export (button in hero) ----------
function buildCsv(list) {
  const cols = ['seq','timestamp_iso','distance_m','rssi_dbm','rssi_min','rssi_max','samples','frequency_mhz','channel','condition','trial','id'];
  const rows = list.map(r => [
    r.seq ?? '', r.timestamp ? new Date(r.timestamp).toISOString() : '', r.distance, r.rssi,
    r.rssi_min ?? '', r.rssi_max ?? '', r.samples ?? '', r.frequency ?? '', r.channel ?? '',
    r.condition ?? '', r.trial ?? '', r.id ?? ''
  ].join(','));
  return [cols.join(','), ...rows].join('\n');
}
$('btnCsv').addEventListener('click', () => {
  if (!records.length) { alert('No measurements yet.'); return; }
  const blob = new Blob([buildCsv(records)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'propagation_measurements.csv';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
});
