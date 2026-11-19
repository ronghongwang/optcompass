'use strict';
const $ = s => document.querySelector(s);
const fmt = (n, d = 0) => (n == null || isNaN(n)) ? '—'
  : Number(n).toLocaleString('zh-TW', { maximumFractionDigits: d, minimumFractionDigits: d });
const sgn = (n, d = 0) => (n > 0 ? '+' : '') + fmt(n, d);
const cls = n => n > 0 ? 'up' : n < 0 ? 'down' : '';
const MULT = 50; // 台指選擇權每點 50 元

const S = { eod: null, live: null, liveErr: false, code: null, tab: 'overview', mode: 'oi', range: 45, rentCode: null };

/* ---------- 計算 ---------- */
function expiryMs(c) { return Date.parse(c.expiry + 'T13:30:00+08:00'); }

function model() {
  const c = S.eod.contracts.find(x => x.code === S.code);
  const lq = {};
  const liveOn = S.live && S.live.contract === S.code;
  if (liveOn) for (const q of S.live.quotes) lq[q[0] + q[1]] = q;
  const px = (l, e) => l ? (l[2] || (l[3] && l[4] ? (l[3] + l[4]) / 2 : 0) || e || l[6]) : e;
  const rows = c.strikes.map(s => {
    const lc = lq[s[0] + 'C'], lp = lq[s[0] + 'P'];
    return { k: s[0], coi: s[1], cdoi: s[2], cvol: lc ? lc[5] : s[3], cpx: px(lc, s[4]),
             poi: s[5], pdoi: s[6], pvol: lp ? lp[5] : s[7], ppx: px(lp, s[8]) };
  });
  const lastFut = S.eod.fut[S.eod.fut.length - 1] || {};
  const lf = S.live && S.live.fut;
  const F = lf ? lf.last : lastFut.c;
  const ref = lf ? lf.ref : (S.eod.fut[S.eod.fut.length - 2] || {}).c;
  const best = key => rows.reduce((a, b) => b[key] > a[key] ? b : a, rows[0]);
  const callWall = best('coi'), putWall = best('poi');
  const payout = k => {
    let cp = 0, pp = 0;
    for (const r of rows) { if (k > r.k) cp += r.coi * (k - r.k); else if (k < r.k) pp += r.poi * (r.k - k); }
    return { cp, pp, all: cp + pp };
  };
  let pain = rows[0].k, painV = Infinity;
  for (const r of rows) { if (!(r.coi || r.poi)) continue; const v = payout(r.k).all; if (v < painV) { painV = v; pain = r.k; } }
  const priced = rows.filter(r => r.cpx > 0 && r.ppx > 0);
  const atm = (priced.length ? priced : rows).reduce((a, b) => Math.abs(b.k - F) < Math.abs(a.k - F) ? b : a);
  const straddle = atm.cpx + atm.ppx;
  const sd = straddle / 0.8;
  const sum = key => rows.reduce((a, r) => a + r[key], 0);
  const days = (expiryMs(c) - Date.now()) / 864e5;
  return { c, rows, F, ref, chg: F - ref, callWall, putWall, pain, painV, payout, atm, straddle, sd,
           pcr: sum('coi') ? sum('poi') / sum('coi') : null, sumC: sum('coi'), sumP: sum('poi'),
           sumCd: sum('cdoi'), sumPd: sum('pdoi'), days, liveOn, futName: lf ? lf.name : '台指期（盤後）' };
}

// n=25「近」：現價 ±0.6σ 全部履約價；n=45「中」：涵蓋籌碼牆與 ±1σ，只留有份量的履約價；其餘「全」
function windowRows(m, n) {
  const all = m.rows.filter(r => r.coi || r.poi || r.cvol || r.pvol);
  if (n > 100) return all;
  const sd = m.sd || m.F * 0.03, f = n <= 25 ? 0.6 : 1;
  let lo = m.F - sd * f, hi = m.F + sd * f;
  if (n > 25) { lo = Math.min(lo, m.putWall.k, m.pain) - 1; hi = Math.max(hi, m.callWall.k, m.pain) + 1; }
  const span = all.filter(r => r.k >= lo && r.k <= hi);
  if (n <= 25 || n === 70) return span;
  const max = Math.max(1, ...span.map(r => Math.max(r.coi, r.poi)));
  const keep = new Set([m.atm.k, m.callWall.k, m.putWall.k, m.pain]);
  return span.filter(r => keep.has(r.k) || Math.max(r.coi, r.poi) >= max * 0.04);
}

const phi = x => { // 標準常態 CDF
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};

/* ---------- 圖表 ---------- */
function lineChart(el, o) {
  const W = el.clientWidth || 600, H = el.clientHeight || 300, m = { l: 54, r: 14, t: 18, b: 26 };
  const xs = o.series.flatMap(s => s.pts.map(p => p[0])), ys = o.series.flatMap(s => s.pts.map(p => p[1]));
  if (!xs.length) { el.innerHTML = '<p class="note">無資料</p>'; return; }
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (o.zero) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  if (x0 === x1) x1 += 1;
  const pad = (y1 - y0) * 0.08; y1 += pad; if (y0 !== 0 || o.zero) y0 -= pad;
  const X = v => m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r), Y = v => H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b);
  const yf = o.yfmt || (v => fmt(v)), xf = o.xfmt || (v => fmt(v));
  let h = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (let i = 0; i <= 4; i++) {
    const v = y0 + (y1 - y0) * i / 4;
    h += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${yf(v)}</text>`;
  }
  const nt = W < 480 ? 3 : 6;
  for (let i = 0; i <= nt; i++) {
    const v = x0 + (x1 - x0) * i / nt;
    h += `<text x="${X(v)}" y="${H - 6}" text-anchor="middle">${xf(v)}</text>`;
  }
  if (o.zero) h += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--muted)" stroke-width="1"/>`;
  for (const s of o.series) {
    const d = s.pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join('');
    if (s.fill) {
      const base = Y(o.zero ? 0 : y0);
      h += `<path d="${d}L${X(s.pts[s.pts.length - 1][0])} ${base}L${X(s.pts[0][0])} ${base}Z" fill="${s.color}" opacity=".13"/>`;
    }
    h += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.w || 2}" ${s.dash ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round"/>`;
  }
  (o.vlines || []).forEach((v, i) => {
    if (v.x < x0 || v.x > x1) return;
    const x = X(v.x), anchor = x > W - 90 ? 'end' : x < 90 ? 'start' : 'middle';
    h += `<line x1="${x}" x2="${x}" y1="${m.t}" y2="${H - m.b}" stroke="${v.color}" stroke-dasharray="4 3"/>` +
         `<text x="${x}" y="${m.t - 5 + (i % 2) * 13}" text-anchor="${anchor}" style="fill:${v.color};font-weight:600">${v.label}</text>`;
  });
  if (o.legend) {
    let lx = m.l + 6;
    for (const s of o.series) { h += `<rect x="${lx}" y="${H - m.b - 16}" width="10" height="3" fill="${s.color}"/><text x="${lx + 14}" y="${H - m.b - 10}">${s.name}</text>`; lx += 26 + s.name.length * 12; }
  }
  el.innerHTML = h + '</svg>';
}

function barLine(el, dates, bars, line) {
  const W = el.clientWidth || 600, H = el.clientHeight || 300, m = { l: 58, r: line ? 52 : 14, t: 14, b: 26 }, n = dates.length;
  if (!n) { el.innerHTML = '<p class="note">無資料</p>'; return; }
  let b0 = Math.min(0, ...bars), b1 = Math.max(0, ...bars); const p = (b1 - b0) * 0.08 || 1; b0 -= b0 < 0 ? p : 0; b1 += b1 > 0 ? p : 0;
  const bw = (W - m.l - m.r) / n, Y = v => H - m.b - (v - b0) / (b1 - b0) * (H - m.t - m.b);
  let h = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (let i = 0; i <= 4; i++) {
    const v = b0 + (b1 - b0) * i / 4;
    h += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  }
  bars.forEach((v, i) => {
    const y = Math.min(Y(v), Y(0)), hh = Math.abs(Y(v) - Y(0));
    h += `<rect x="${m.l + i * bw + bw * 0.15}" y="${y}" width="${bw * 0.7}" height="${Math.max(hh, 1)}" rx="2" fill="${v >= 0 ? 'var(--call)' : 'var(--put)'}"><title>${dates[i]}：${fmt(v)}</title></rect>`;
  });
  h += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--muted)"/>`;
  const step = Math.ceil(n / (W < 480 ? 4 : 8));
  dates.forEach((d, i) => { if (i % step === 0) h += `<text x="${m.l + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${d.slice(5).replace('-', '/')}</text>`; });
  if (line) {
    const vals = line.filter(v => v != null); let l0 = Math.min(...vals), l1 = Math.max(...vals); const lp = (l1 - l0) * 0.1 || 1; l0 -= lp; l1 += lp;
    const LY = v => H - m.b - (v - l0) / (l1 - l0) * (H - m.t - m.b);
    let d = '', started = false;
    line.forEach((v, i) => { if (v == null) return; d += (started ? 'L' : 'M') + (m.l + i * bw + bw / 2).toFixed(1) + ' ' + LY(v).toFixed(1); started = true; });
    h += `<path d="${d}" fill="none" stroke="var(--blue)" stroke-width="2"/>`;
    for (let i = 0; i <= 4; i++) { const v = l0 + (l1 - l0) * i / 4; h += `<text x="${W - m.r + 6}" y="${LY(v) + 4}" style="fill:var(--blue)">${fmt(v)}</text>`; }
  }
  el.innerHTML = h + '</svg>';
}

const kpi = (l, v, s = '', c = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`;

/* ---------- 各頁 ---------- */
function renderOverview(m) {
  const spot = S.live && S.live.spot;
  const pct = m.ref ? m.chg / m.ref * 100 : 0;
  $('#kpis').innerHTML =
    kpi(m.futName, fmt(m.F), `<span class="${cls(m.chg)}">${sgn(m.chg)}（${sgn(pct, 2)}%）</span>${spot ? ' · 現貨 ' + fmt(spot.last) : ''}`, cls(m.chg)) +
    kpi('最大痛點', fmt(m.pain), `距現價 ${sgn(m.pain - m.F)} 點`, 'acc') +
    kpi('Call 牆（壓力）', fmt(m.callWall.k), `${fmt(m.callWall.coi)} 口 · 增減 ${sgn(m.callWall.cdoi)}`, 'up') +
    kpi('Put 牆（支撐）', fmt(m.putWall.k), `${fmt(m.putWall.poi)} 口 · 增減 ${sgn(m.putWall.pdoi)}`, 'down') +
    kpi('P/C 未平倉比', m.pcr == null ? '—' : fmt(m.pcr * 100, 1) + '%', `Put ${fmt(m.sumP)} / Call ${fmt(m.sumC)}`) +
    kpi('預期波動（1σ）', '±' + fmt(m.sd), `${fmt(m.F - m.sd)} ～ ${fmt(m.F + m.sd)}`) +
    kpi('距結算', m.days > 0 ? (m.days >= 1 ? fmt(m.days, 1) + ' 天' : fmt(m.days * 24, 1) + ' 小時') : '已結算', m.c.expiry + ' 13:30');

  const vals = [m.putWall.k, m.callWall.k, m.pain, m.F, m.F - m.sd, m.F + m.sd];
  let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.08 || 100; lo -= pad; hi += pad;
  const P = v => ((v - lo) / (hi - lo) * 100).toFixed(2) + '%';
  const a = Math.min(m.putWall.k, m.callWall.k), b = Math.max(m.putWall.k, m.callWall.k);
  $('#ruler').innerHTML =
    `<div class="track"></div>` +
    `<div class="zone" style="left:${P(a)};width:${((b - a) / (hi - lo) * 100).toFixed(2)}%"></div>` +
    `<div class="band" style="left:${P(m.F - m.sd)};width:${(2 * m.sd / (hi - lo) * 100).toFixed(2)}%"></div>` +
    `<div class="mk t price" style="left:${P(m.F)}">現價<b>${fmt(m.F)}</b></div>` +
    `<div class="mk b down" style="left:${P(m.putWall.k)}"><b>${fmt(m.putWall.k)}</b>Put 牆</div>` +
    `<div class="mk b up" style="left:${P(m.callWall.k)}"><b>${fmt(m.callWall.k)}</b>Call 牆</div>` +
    (Math.abs(m.pain - m.putWall.k) > (hi - lo) * 0.09 && Math.abs(m.pain - m.callWall.k) > (hi - lo) * 0.09
      ? `<div class="mk b acc" style="left:${P(m.pain)}"><b>${fmt(m.pain)}</b>最大痛點</div>` : '');
  $('#rulerLegend').innerHTML = `<span><i style="background:var(--put)"></i>Put 牆 ${fmt(m.putWall.k)}</span><span><i style="background:var(--accent)"></i>最大痛點 ${fmt(m.pain)}</span><span><i style="background:var(--call)"></i>Call 牆 ${fmt(m.callWall.k)}</span><span><i style="background:var(--blue)"></i>預期波動 ±${fmt(m.sd)}</span>`;

  const ins = insights(m);
  $('#insights').innerHTML = ins.list.map(i => `<li class="${i.c}">${i.t}</li>`).join('');
  $('#biasTag').outerHTML = `<small id="biasTag"><span class="tag ${ins.score >= 2 ? 'bull' : ins.score <= -2 ? 'bear' : 'neu'}">${ins.score >= 2 ? '籌碼偏多' : ins.score <= -2 ? '籌碼偏空' : '多空中性'}</span></small>`;

  const now = Date.now();
  $('#contractList').innerHTML = S.eod.contracts.filter(c => expiryMs(c) > now - 864e5).map(c => {
    const co = c.strikes.reduce((a, s) => a + s[1], 0), po = c.total_oi - co, t = c.total_oi || 1;
    return `<button data-code="${c.code}" class="${c.code === S.code ? 'on' : ''}"><span><b>${c.code}</b> <small>${c.label}</small></span><span>${fmt(c.total_oi)} 口</span>` +
      `<span class="bar"><i style="width:${po / t * 100}%;background:var(--put)"></i><i style="width:${co / t * 100}%;background:var(--call)"></i></span></button>`;
  }).join('');
}

function insights(m) {
  const list = []; let score = 0;
  const add = (c, t, s = 0) => { list.push({ c, t }); score += s; };
  if (m.days <= 0) add('', '此合約已結算，以下為結算前最後一筆未平倉結構。');
  const dp = m.F - m.pain;
  if (Math.abs(dp) < m.sd * 0.25) add('', `現價 ${fmt(m.F)} 貼近最大痛點 ${fmt(m.pain)}，買賣權賣方都在舒適區，結算前傾向區間整理。`);
  else if (dp > 0) add('bear', `現價高於最大痛點 ${fmt(m.pain)} 約 ${fmt(dp)} 點，結算前有向下收斂的統計傾向。`, -1);
  else add('bull', `現價低於最大痛點 ${fmt(m.pain)} 約 ${fmt(-dp)} 點，結算前有向上收斂的統計傾向。`, 1);

  if (m.F > m.callWall.k) add('bull', `現價已站上 Call 牆 ${fmt(m.callWall.k)}，壓力區被突破，留意賣方回補帶來的推升。`, 2);
  else if (m.F < m.putWall.k) add('bear', `現價已跌破 Put 牆 ${fmt(m.putWall.k)}，支撐區失守，留意賣方停損帶來的追殺。`, -2);
  else add('', `主力區間 ${fmt(m.putWall.k)} ～ ${fmt(m.callWall.k)}：距下方支撐 ${fmt(m.F - m.putWall.k)} 點、距上方壓力 ${fmt(m.callWall.k - m.F)} 點。`);

  const tc = m.rows.reduce((a, b) => b.cdoi > a.cdoi ? b : a), tp = m.rows.reduce((a, b) => b.pdoi > a.pdoi ? b : a);
  if (tc.cdoi > 0) tc.k >= m.F ? add('bear', `Call 最大增倉在 ${fmt(tc.k)}（+${fmt(tc.cdoi)} 口），上方壓力加重。`, -1)
                               : add('bull', `價內 Call ${fmt(tc.k)} 增倉最多（+${fmt(tc.cdoi)} 口），有買方追價跡象。`, 1);
  if (tp.pdoi > 0) tp.k <= m.F ? add('bull', `Put 最大增倉在 ${fmt(tp.k)}（+${fmt(tp.pdoi)} 口），下方支撐增強。`, 1)
                               : add('bear', `價內 Put ${fmt(tp.k)} 增倉最多（+${fmt(tp.pdoi)} 口），有避險或追空跡象。`, -1);
  if (m.pcr != null) {
    const p = fmt(m.pcr * 100, 1) + '%';
    if (m.pcr > 1.2) add('bull', `P/C 未平倉比 ${p}，Put 部位明顯多於 Call，賣方較敢在下方收租，結構偏多。`, 1);
    else if (m.pcr < 0.8) add('bear', `P/C 未平倉比 ${p}，Call 部位明顯多於 Put，上方壓力較重，結構偏空。`, -1);
    else add('', `P/C 未平倉比 ${p}，多空部位大致均衡。`);
  }
  const f = S.eod.inst_fut, a = f[f.length - 1], b = f[f.length - 2];
  if (a && b && a.foreign != null && b.foreign != null) {
    const d = a.foreign - b.foreign;
    add(d > 0 ? 'bull' : d < 0 ? 'bear' : '', `外資台指期淨${a.foreign >= 0 ? '多' : '空'}單 ${fmt(Math.abs(a.foreign))} 口，單日${d >= 0 ? '偏多調整 +' : '偏空調整 '}${fmt(d)} 口（${a.date.slice(5)}）。`, Math.sign(d));
  }
  add('', `價平 ${fmt(m.atm.k)} 跨式權利金 ${fmt(m.straddle, 1)} 點，市場隱含到結算約 ±${fmt(m.sd)} 點（${fmt(m.F - m.sd)} ～ ${fmt(m.F + m.sd)}）。`);
  return { list, score };
}

function renderChips(m) {
  const rows = windowRows(m, S.range).reverse();
  const key = { oi: ['coi', 'poi'], doi: ['cdoi', 'pdoi'], vol: ['cvol', 'pvol'] }[S.mode];
  const max = Math.max(1, ...rows.map(r => Math.max(Math.abs(r[key[0]]), Math.abs(r[key[1]]))));
  const side = (r, k, dk, c) => {
    const v = r[k], w = (Math.abs(v) / max * 66).toFixed(1) + '%';
    let t = S.mode === 'doi' ? sgn(v) : fmt(v);
    if (S.mode === 'oi' && r[dk]) t += ` <span class="${cls(r[dk])}">${sgn(r[dk])}</span>`;
    return `<div class="side ${c}" style="--w:${w}"><div class="bar ${v < 0 ? 'neg' : ''}"></div>${v ? `<span class="n">${t}</span>` : ''}</div>`;
  };
  let h = '', lined = false;
  for (const r of rows) {
    if (!lined && r.k < m.F) { h += `<div class="pxline">現價 ${fmt(m.F)}</div>`; lined = true; }
    const c = [r.k === m.callWall.k ? 'wallc' : '', r.k === m.putWall.k ? 'wallp' : '', r.k === m.pain ? 'pain' : '', r.k === m.atm.k ? 'atm' : ''].join(' ');
    h += `<div class="bf ${c}">${side(r, key[1], 'pdoi', 'p')}<div class="k">${fmt(r.k)}</div>${side(r, key[0], 'cdoi', 'c')}</div>`;
  }
  $('#butterfly').innerHTML = h;
  $('#chipsAsof').textContent = `OI：${S.eod.asof} 盤後 · 增減較 ${S.eod.prev || '—'}` + (S.mode === 'vol' ? (m.liveOn ? ' · 量為即時' : ' · 量為盤後') : '');
  $('#tAsof').textContent = m.liveOn ? `成交價/量 即時（${S.live.session}）` : '成交價為盤後結算價';
  const td = (v, c = '') => `<td class="${c}">${v}</td>`;
  $('#ttable').innerHTML = `<thead><tr><th>增減</th><th>未平倉</th><th>量</th><th>Call 價</th><th class="k">履約價</th><th>Put 價</th><th>量</th><th>未平倉</th><th>增減</th></tr></thead><tbody>` +
    windowRows(m, S.range).map(r => {
      const ci = r.k < m.F ? 'itm' : '', pi = r.k > m.F ? 'itm' : '';
      return `<tr class="${r.k === m.atm.k ? 'atm' : ''}">${td(sgn(r.cdoi), ci + ' ' + cls(r.cdoi))}${td(fmt(r.coi), ci)}${td(fmt(r.cvol), ci)}${td(fmt(r.cpx, 1), ci)}` +
        `<td class="k">${fmt(r.k)}</td>${td(fmt(r.ppx, 1), pi)}${td(fmt(r.pvol), pi)}${td(fmt(r.poi), pi)}${td(sgn(r.pdoi), pi + ' ' + cls(r.pdoi))}</tr>`;
    }).join('') + '</tbody>';
}

const yi = v => fmt(v * MULT / 1e8, 1) + ' 億'; // 點×口 → 新台幣億元
function renderSettle(m) {
  const rows = windowRows(m, 70), pts = rows.map(r => [r.k, m.payout(r.k)]);
  lineChart($('#painChart'), {
    legend: true, yfmt: v => fmt(v * MULT / 1e8, 0) + '億',
    series: [
      { name: 'Call 買方獲利', color: 'var(--call)', pts: pts.map(p => [p[0], p[1].cp]), w: 1.5 },
      { name: 'Put 買方獲利', color: 'var(--put)', pts: pts.map(p => [p[0], p[1].pp]), w: 1.5 },
      { name: '合計', color: 'var(--accent)', pts: pts.map(p => [p[0], p[1].all]), fill: true, w: 2.5 }],
    vlines: [{ x: m.pain, label: '最大痛點 ' + fmt(m.pain), color: 'var(--accent)' }, { x: m.F, label: '現價 ' + fmt(m.F), color: 'var(--text)' }],
  });
  const now = m.payout(m.F);
  $('#settleKpis').innerHTML = kpi('最大痛點', fmt(m.pain), '賣方賠付最少', 'acc') + kpi('痛點處買方總獲利', yi(m.painV)) +
    kpi('以現價結算買方總獲利', yi(now.all), `比痛點多 ${yi(now.all - m.painV)}`);
  const sl = $('#settleSlider'), ks = rows.map(r => r.k);
  const step = ks.length > 1 ? Math.min(...ks.slice(1).map((k, i) => k - ks[i])) : 50;
  if (sl.dataset.code !== S.code) { sl.min = ks[0]; sl.max = ks[ks.length - 1]; sl.step = step; sl.value = Math.round(m.F / step) * step; sl.dataset.code = S.code; }
  const v = +sl.value, p = m.payout(v);
  $('#settleOut').innerHTML = kpi('假設結算價', fmt(v), `距現價 ${sgn(v - m.F)} 點`) + kpi('Call 賣方賠付', yi(p.cp), '', 'up') +
    kpi('Put 賣方賠付', yi(p.pp), '', 'down') + kpi('賣方合計賠付', yi(p.all), `比痛點多 ${yi(p.all - m.painV)}`, 'acc');
}

function renderRent(m) {
  const puts = m.rows.filter(r => r.ppx > 0 && r.k <= m.F).reverse(), calls = m.rows.filter(r => r.cpx > 0 && r.k >= m.F);
  const sp = $('#rPut'), sc = $('#rCall');
  if (!puts.length || !calls.length) { $('#rentKpis').innerHTML = '<p class="note">此合約目前沒有可用的權利金報價。</p>'; $('#rentChart').innerHTML = ''; return; }
  const near = (list, k) => list.reduce((a, b) => Math.abs(b.k - k) < Math.abs(a.k - k) ? b : a).k;
  const setWalls = () => {
    sp.value = near(puts, m.putWall.k < m.F ? m.putWall.k : m.F - m.sd);
    sc.value = near(calls, m.callWall.k > m.F ? m.callWall.k : m.F + m.sd);
  };
  if (S.rentCode !== S.code) {
    sp.innerHTML = puts.map(r => `<option value="${r.k}">${fmt(r.k)}</option>`).join('');
    sc.innerHTML = calls.map(r => `<option value="${r.k}">${fmt(r.k)}</option>`).join('');
    setWalls(); S.rentCode = S.code;
  }
  $('#rAuto').onclick = () => { setWalls(); render(); };
  const byK = Object.fromEntries(m.rows.map(r => [r.k, r]));
  const Kp = +sp.value, Kc = +sc.value, wing = +$('#rWing').value, lots = Math.max(1, +$('#rLots').value || 1);
  let prem = byK[Kp].ppx + byK[Kc].cpx, Kpw = null, Kcw = null, note = '';
  const opt = (k, cp) => `<option value="${k}">${fmt(k)}（${fmt(byK[k][cp], 1)}）</option>`;
  [...sp.options].forEach(o => o.textContent = `${fmt(+o.value)}（${fmt(byK[+o.value].ppx, 1)} 點）`);
  [...sc.options].forEach(o => o.textContent = `${fmt(+o.value)}（${fmt(byK[+o.value].cpx, 1)} 點）`);
  void opt;
  if (wing) {
    const pw = m.rows.filter(r => r.ppx > 0 && r.k < Kp), cw = m.rows.filter(r => r.cpx > 0 && r.k > Kc);
    if (pw.length && cw.length) {
      Kpw = near(pw, Kp - wing); Kcw = near(cw, Kc + wing);
      prem -= byK[Kpw].ppx + byK[Kcw].cpx;
      note = `保護翼：買進 Put ${fmt(Kpw)}（${fmt(byK[Kpw].ppx, 1)} 點）、買進 Call ${fmt(Kcw)}（${fmt(byK[Kcw].cpx, 1)} 點）。`;
    } else note = '外側沒有可用報價，改以無保護計算。';
  }
  const pnl = s => prem - Math.max(s - Kc, 0) - Math.max(Kp - s, 0) + (Kcw ? Math.max(s - Kcw, 0) : 0) + (Kpw ? Math.max(Kpw - s, 0) : 0);
  const beL = Kp - prem, beH = Kc + prem;
  const prob = m.sd > 0 ? phi((beH - m.F) / m.sd) - phi((beL - m.F) / m.sd) : null;
  const maxLoss = Kpw ? Math.max(Kp - Kpw, Kcw - Kc) - prem : null;
  const money = v => 'NT$ ' + fmt(v * MULT * lots);
  const margin = Math.min(m.F - beL, beH - m.F);
  $('#rentKpis').innerHTML =
    kpi('淨收權利金', fmt(prem, 1) + ' 點', money(prem), prem > 0 ? 'acc' : 'down') +
    kpi('最大風險', maxLoss == null ? '無上限' : fmt(maxLoss, 1) + ' 點', maxLoss == null ? '建議加保護翼' : money(maxLoss) + ` · 報酬/風險 ${fmt(prem / maxLoss * 100, 0)}%`, 'up') +
    kpi('損益兩平區間', `${fmt(beL)} ～ ${fmt(beH)}`, `寬度 ${fmt(beH - beL)} 點`) +
    kpi('安全邊際', fmt(margin) + ' 點', `距現價 ${fmt(margin / m.F * 100, 2)}% · ${m.sd ? fmt(margin / m.sd, 2) + 'σ' : ''}`, margin > 0 ? '' : 'up') +
    kpi('結算落在獲利區機率', prob == null ? '—' : fmt(prob * 100, 0) + '%', '以隱含波動常態估算');
  const span = Math.max(m.sd * 1.5, wing * 1.3, 300), lo = Math.min(Kpw || Kp, m.F) - span, hi = Math.max(Kcw || Kc, m.F) + span;
  const xs = [lo, Kpw, Kp, Kc, Kcw, hi].filter(v => v != null).sort((a, b) => a - b);
  lineChart($('#rentChart'), {
    zero: true, yfmt: v => fmt(v * MULT * lots / 1000, 0) + 'K',
    series: [{ name: '到期損益', color: 'var(--accent)', pts: xs.map(x => [x, pnl(x)]), fill: true, w: 2.5 }],
    vlines: [{ x: m.F, label: '現價 ' + fmt(m.F), color: 'var(--text)' }, { x: beL, label: '損平 ' + fmt(beL), color: 'var(--put)' }, { x: beH, label: '損平 ' + fmt(beH), color: 'var(--call)' }],
  });
  $('#rentNote').textContent = `${note} 權利金採${m.liveOn ? '即時成交價（無成交則用買賣中價）' : '盤後結算價'}，未計手續費、交易稅與保證金；縱軸單位為千元。機率為理論估算，非獲利保證。`;
}

function renderInst() {
  const fmap = Object.fromEntries(S.eod.fut.map(f => [f.date, f.c]));
  const f = S.eod.inst_fut.filter(d => d.foreign != null).slice(-30);
  barLine($('#instFutChart'), f.map(d => d.date), f.map(d => d.foreign), f.map(d => fmap[d.date] ?? null));
  const o = S.eod.inst_opt, a = o[o.length - 1], b = o[o.length - 2] || {};
  const table = who => {
    const x = a && a[who], y = b[who] || {};
    if (!x) return '<p class="note">無資料</p>';
    const row = (name, k, c) => `<tr><td class="${c}">${name}</td><td>${fmt(x[k] / 1000, 0)}</td><td class="${cls(x[k] - y[k])}">${y[k] == null ? '—' : sgn((x[k] - y[k]) / 1000, 0)}</td><td>${fmt(x[k + '_v'])}</td></tr>`;
    const net = v => (v.bc + v.sp - v.sc - v.bp) / 1000, n = net(x), dn = y.bc == null ? null : n - net(y);
    return `<table class="itable"><thead><tr><th>${a.date}</th><th>金額</th><th>日增減</th><th>口數</th></tr></thead><tbody>` +
      row('買進 Call（看漲）', 'bc', 'up') + row('賣出 Put（看不跌）', 'sp', 'up') + row('賣出 Call（看不漲）', 'sc', 'down') + row('買進 Put（看跌）', 'bp', 'down') +
      `<tr><td>偏多淨額</td><td class="${cls(n)}">${sgn(n, 0)}</td><td class="${cls(dn)}">${dn == null ? '—' : sgn(dn, 0)}</td><td></td></tr></tbody></table>`;
  };
  $('#instForeign').innerHTML = table('foreign'); $('#instDealer').innerHTML = table('dealer');
  const pc = S.eod.pc_trend.filter(d => d.ratio != null);
  lineChart($('#pcChart'), {
    yfmt: v => fmt(v, 0) + '%', xfmt: v => { const d = pc[Math.round(v)]; return d && Math.abs(v - Math.round(v)) < 0.01 ? d.date.slice(5).replace('-', '/') : ''; },
    series: [{ name: 'P/C', color: 'var(--blue)', pts: pc.map((d, i) => [i, d.ratio * 100]), fill: true }],
  });
}

/* ---------- 主流程 ---------- */
function render() {
  if (!S.eod) return;
  const m = model();
  ({ overview: renderOverview, chips: renderChips, settle: renderSettle, rent: renderRent, inst: renderInst, about: () => {} })[S.tab](m);
  $('#footAsof').textContent = `未平倉資料日 ${S.eod.asof}`;
}

function setContract(code) {
  S.code = code; $('#contract').value = code; S.live = null; render(); pollLive();
}

async function loadEod(first) {
  try {
    const r = await fetch('/api/eod'), j = await r.json();
    if (j.error) throw new Error(j.error);
    S.eod = j;
    const now = Date.now(), live = j.contracts.filter(c => expiryMs(c) > now);
    $('#contract').innerHTML = j.contracts.filter(c => expiryMs(c) > now - 864e5)
      .map(c => `<option value="${c.code}">${c.code}｜${c.label}</option>`).join('');
    if (!S.code || !j.contracts.some(c => c.code === S.code)) S.code = (live[0] || j.contracts[j.contracts.length - 1]).code;
    $('#contract').value = S.code;
    $('#loading').hidden = true;
    document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== S.tab);
    render();
    if (first) pollLive();
  } catch (e) {
    if (first) { const l = $('#loading'); l.classList.add('err'); l.textContent = '資料載入失敗：' + e.message + '（請稍後重新整理）'; }
  }
}

let liveBusy = false;
async function pollLive() {
  if (!S.code || liveBusy || document.hidden) return;
  liveBusy = true; const code = S.code;
  try {
    const j = await (await fetch('/api/live?contract=' + code)).json();
    if (j.error) throw new Error(j.error);
    if (code === S.code) { S.live = j; S.liveErr = false; }
    $('#liveBox').className = 'live ok';
    $('#liveText').textContent = `${j.session} · ${j.ts.slice(11, 19)}`;
    const el = document.activeElement;
    if (!(el && /SELECT|INPUT/.test(el.tagName) && S.tab === 'rent')) render();
  } catch (e) {
    S.liveErr = true; $('#liveBox').className = 'live err'; $('#liveText').textContent = '即時報價中斷，顯示盤後值';
  } finally { liveBusy = false; }
}

document.addEventListener('DOMContentLoaded', () => {
  let saved = null; try { saved = localStorage.getItem('theme'); } catch (e) {}
  const theme = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
  $('#theme').onclick = () => {
    const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = t; try { localStorage.setItem('theme', t); } catch (e) {}
  };
  $('#tabs').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    S.tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== S.tab);
    render();
  };
  const seg = (id, key, attr, num) => $(id).onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    S[key] = num ? +b.dataset[attr] : b.dataset[attr];
    $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); render();
  };
  seg('#chipMode', 'mode', 'm'); seg('#chipRange', 'range', 'r', true);
  $('#contract').onchange = e => setContract(e.target.value);
  $('#contractList').onclick = e => { const b = e.target.closest('button'); if (b) setContract(b.dataset.code); };
  $('#settleSlider').oninput = render;
  ['#rPut', '#rCall', '#rWing', '#rLots'].forEach(id => $(id).addEventListener('change', render));
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 150); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollLive(); });
  loadEod(true);
  setInterval(pollLive, 15000);
  setInterval(() => loadEod(false), 10 * 60 * 1000);
});
