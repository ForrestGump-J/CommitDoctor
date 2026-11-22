/* Analytics: the shown repository over 30, 60 or 90 days.
   Activity vs. baseline, work mix, pace vs. deadline, code churn and contributors.
   Charts are inline SVG with one shared hover tooltip; every chart also has a table view. */
(function () {
  'use strict';
  const { $, esc, plural, get, pill } = CD;
  const RANGES = [30, 60, 90];
  const SURFACE = '#161A23'; // .card.solid background, used for gaps and marker rings
  const GRID = 'rgba(255,255,255,.07)';
  const INK = '#7B869B';
  // Stack order chosen so every adjacent pair stays distinguishable (checked for colour-blind vision).
  const MIX = ['chore', 'fix', 'feature', 'test', 'refactor', 'merge', 'docs'];
  const STATUS = {
    'on-pace': ['On pace', '#34D399'], 'at-risk': ['At risk', '#F59E0B'], behind: ['Behind', '#F87171'],
    'insufficient-data': ['Not enough history', '#4B5363'], 'deadline-passed': ['Deadline passed', '#4B5363'],
  };
  const W = 720; // every chart's viewBox width; it scales to the card
  const PAD = { l: 36, r: 8, t: 12, b: 24 };

  /* ---------- small SVG helpers ---------- */
  const f1 = (n) => Number(n).toFixed(1);
  /** A bar whose data end has 4px rounded corners and whose base sits on the axis (up or down). */
  function bar(x, y0, y1, w, color, r = 4) {
    if (Math.abs(y1 - y0) < 0.5) return '';
    const up = y1 < y0;
    const rr = Math.min(r, Math.abs(y1 - y0), w / 2);
    const d = up
      ? `M${f1(x)} ${f1(y0)}V${f1(y1 + rr)}Q${f1(x)} ${f1(y1)} ${f1(x + rr)} ${f1(y1)}H${f1(x + w - rr)}Q${f1(x + w)} ${f1(y1)} ${f1(x + w)} ${f1(y1 + rr)}V${f1(y0)}Z`
      : `M${f1(x)} ${f1(y0)}V${f1(y1 - rr)}Q${f1(x)} ${f1(y1)} ${f1(x + rr)} ${f1(y1)}H${f1(x + w - rr)}Q${f1(x + w)} ${f1(y1)} ${f1(x + w)} ${f1(y1 - rr)}V${f1(y0)}Z`;
    return `<path d="${d}" fill="${color}"/>`;
  }
  /** "Nice" upper bound and 3-4 gridline ticks for a max value. */
  function ticks(max, asPct = false) {
    if (asPct) return { top: Math.max(1, Math.ceil(max * 4) / 4), step: 0.25 };
    const m = Math.max(1, max);
    const raw = m / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = Math.max(1, [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw)); // counts: whole-number ticks
    return { top: Math.ceil(m / step) * step, step };
  }
  function grid(h, top, step, fmt = (v) => v, y0 = h - PAD.b, bottom = 0) {
    let out = '';
    for (let v = bottom; v <= top + 1e-9; v += step) {
      const y = y0 - ((v - bottom) / (top - bottom)) * (y0 - PAD.t);
      out += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${f1(y)}" y2="${f1(y)}" stroke="${GRID}" stroke-width="1"/>
        <text x="${PAD.l - 6}" y="${f1(y + 3.5)}" text-anchor="end" font-size="10" fill="${INK}">${fmt(Math.round(v * 100) / 100)}</text>`;
    }
    return out;
  }
  /** Evenly spaced x labels (about six). */
  function xLabels(items, xAt, h, label) {
    const every = Math.max(1, Math.ceil(items.length / 6));
    return items.map((it, i) => (i % every === 0 || i === items.length - 1) && !(i !== items.length - 1 && items.length - 1 - i < every / 2)
      ? `<text x="${f1(xAt(i))}" y="${h - 6}" text-anchor="middle" font-size="10" fill="${INK}">${esc(label(it))}</text>` : '').join('');
  }
  /** Full-height invisible hit targets, one per column, carrying the tooltip text. */
  const hits = (n, slot, h, tip) => Array.from({ length: n }, (_, i) => `<rect class="hit" x="${f1(PAD.l + i * slot)}" y="0" width="${f1(slot)}" height="${h - PAD.b}" fill="transparent" data-tip="${esc(tip(i))}"/>`).join('');
  const svg = (h, label, body) => `<svg class="chart an-chart" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}">${body}</svg>`;
  const legend = (items) => `<div class="legend an-legend">${items.map(([label, c, shape]) => `<span><i style="--c:${c}"${shape === 'line' ? ' class="ln"' : shape === 'dot' ? ' class="dt"' : ''}></i>${esc(label)}</span>`).join('')}</div>`;
  const table = (head, rows) => `<details class="disclosure an-table"><summary>Show as table</summary><div class="table-wrap"><table class="log-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
  const weekLabel = (w) => `${CD.dayMed(w.start)}${w.partial ? '*' : ''}`;
  const weekRange = (w) => `${CD.dayMed(w.start)}${w.end !== w.start ? ` – ${CD.dayMed(w.end)}` : ''}${w.partial ? ' (part of a week)' : ''}`;

  /* ---------- 1. activity over time ---------- */
  function activity(a) {
    const h = 220;
    const d = a.daily;
    const max = Math.max(...d.map((x) => Math.max(x.commits, x.baseline || 0)));
    const { top, step } = ticks(max);
    const y0 = h - PAD.b;
    const y = (v) => y0 - (v / top) * (y0 - PAD.t - 10);
    const slot = (W - PAD.l - PAD.r) / d.length;
    const bw = Math.max(2, slot - 2);
    const cx = (i) => PAD.l + i * slot + slot / 2;
    const bars = d.map((x, i) => bar(PAD.l + i * slot + (slot - bw) / 2, y0, y(x.commits), bw, '#6366F1', Math.min(4, bw / 2))).join('');
    // Baseline as a 2px line, broken where there is no history yet.
    let path = '';
    d.forEach((x, i) => { if (x.baseline == null) return; path += `${path && d[i - 1] && d[i - 1].baseline != null ? 'L' : 'M'}${f1(cx(i))} ${f1(y(x.baseline))}`; });
    const marks = d.map((x, i) => {
      if (!x.flags.length) return '';
      const color = CD.flagMeta(x.flags[0]).at(2);
      return `<circle cx="${f1(cx(i))}" cy="${PAD.t - 2 + 6}" r="4.5" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>`;
    }).join('');
    const flagged = d.filter((x) => x.flags.length).length;
    const tip = (i) => {
      const x = d[i];
      return `${CD.dayLong(x.date)}\n${plural(x.commits, 'commit')}${x.baseline != null ? ` · baseline ${x.baseline}` : ''}${x.flags.length ? `\n${x.flags.map((t) => CD.flagMeta(t)[0]).join(', ')}` : ''}`;
    };
    const body = grid(h, top, step, (v) => v, y0) + bars + (path ? `<path d="${path}" fill="none" stroke="#E8EAF0" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity=".8"/>` : '') + marks
      + xLabels(d, cx, h, (x) => CD.dayMed(x.date)) + hits(d.length, slot, h, tip);
    return `<section class="card solid"><div class="card-head"><div><h2>Activity over time</h2><p class="sub">Commits per day, against the ${a.rules.comparison_days}-day baseline each day's summary is compared with</p></div></div>
      ${legend([['Commits', '#6366F1'], [`${a.rules.comparison_days}-day baseline`, '#E8EAF0', 'line'], [`Flagged day (${flagged})`, '#F59E0B', 'dot']])}
      ${svg(h, `Commits per day from ${CD.dayMed(a.start)} to ${CD.dayMed(a.end)}, ${plural(a.totals.commits, 'commit')} in total, with the rolling baseline and ${plural(flagged, 'flagged day')}`, body)}
      <p class="note">A flag is raised when a saved day is well above or below its baseline, or someone goes quiet. Hover a day for details; click it to open that day.</p>
      ${table(['Day', 'Commits', 'Baseline', 'Flags'], d.slice().reverse().map((x) => [esc(CD.dayMed(x.date)), x.commits, x.baseline ?? '—', esc(x.flags.map((t) => CD.flagMeta(t)[0]).join(', ') || '—')]))}</section>`;
  }

  /* ---------- 2. work mix per week ---------- */
  function workMix(a) {
    const h = 220;
    const wk = a.weeks;
    const { top, step } = ticks(Math.max(...wk.map((w) => w.commits)));
    const y0 = h - PAD.b;
    const y = (v) => y0 - (v / top) * (y0 - PAD.t);
    const slot = (W - PAD.l - PAD.r) / wk.length;
    const bw = Math.min(56, slot * 0.6);
    const cx = (i) => PAD.l + i * slot + slot / 2;
    const totals = {};
    const stacks = wk.map((w, i) => {
      let acc = 0;
      const present = MIX.filter((k) => w.intents[k]);
      return present.map((k, j) => {
        const n = w.intents[k];
        totals[k] = (totals[k] || 0) + n;
        const lo = y(acc);
        acc += n;
        const hi = y(acc) + (j < present.length - 1 ? 1 : 0); // 2px surface gap between segments
        const x = cx(i) - bw / 2;
        if (j === present.length - 1) return bar(x, lo - (j ? 1 : 0), hi, bw, CD.INTENT[k]);
        return `<rect x="${f1(x)}" y="${f1(hi)}" width="${f1(bw)}" height="${f1(Math.max(0, lo - hi - (j ? 1 : 0)))}" fill="${CD.INTENT[k]}"/>`;
      }).join('');
    }).join('');
    const tip = (i) => {
      const w = wk[i];
      const parts = MIX.filter((k) => w.intents[k]).map((k) => `${CD.INTENT_WORD[k]} ${w.intents[k]}`);
      return `${weekRange(w)}\n${plural(w.commits, 'commit')}${parts.length ? `\n${parts.join(' · ')}` : ''}`;
    };
    const used = MIX.filter((k) => totals[k]);
    const body = grid(h, top, step, (v) => v, y0) + stacks + xLabels(wk, cx, h, weekLabel) + hits(wk.length, slot, h, tip);
    return `<section class="card solid"><div class="card-head"><div><h2>Work mix</h2><p class="sub">What kind of work each week was, from the commit-message classifier</p></div></div>
      ${used.length ? legend(used.map((k) => [`${CD.INTENT_WORD[k]} · ${totals[k]}`, CD.INTENT[k]])) : ''}
      ${svg(h, `Commits per week by kind of work: ${used.map((k) => `${CD.INTENT_WORD[k]} ${totals[k]}`).join(', ') || 'none'}`, body)}
      <p class="note">Labels are the classifier's best guess from each message, including low-confidence ones. Weeks run Monday to Sunday; * marks a part week.</p>
      ${table(['Week', 'Commits', ...MIX.map((k) => CD.INTENT_WORD[k])], wk.slice().reverse().map((w) => [esc(weekRange(w)), w.commits, ...MIX.map((k) => w.intents[k] || 0)]))}</section>`;
  }

  /* ---------- 4. pace vs. deadline ---------- */
  function pace(a) {
    if (!a.pace) {
      return `<section class="card solid"><div class="card-head"><h2>Pace vs. deadline</h2></div>
        <p class="hint">Set a deadline for ${esc(a.repo || 'this repository')} to see how its pace changed day by day.</p><p style="margin-top:12px"><a class="btn" href="settings.html">Set a deadline</a></p></section>`;
    }
    const p = a.pace;
    const r = a.rules;
    const slot = (W - PAD.l - PAD.r) / p.length;
    const cx = (i) => PAD.l + i * slot + slot / 2;
    const known = p.filter((x) => x.pace_ratio != null);
    const line = (h, key, top, color) => {
      const y0 = h - PAD.b;
      const y = (v) => y0 - (Math.min(v, top) / top) * (y0 - PAD.t);
      let d = '';
      p.forEach((x, i) => { if (x[key] == null) return; d += `${d && p[i - 1] && p[i - 1][key] != null ? 'L' : 'M'}${f1(cx(i))} ${f1(y(x[key]))}`; });
      const dots = p.map((x, i) => (x[key] != null && (i === 0 || p[i - 1][key] == null) && (i === p.length - 1 || p[i + 1][key] == null)
        ? `<circle cx="${f1(cx(i))}" cy="${f1(y(x[key]))}" r="4" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>` : '')).join('');
      return { y, path: d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}` : '' };
    };
    const thresh = (y, label, color) => `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${f1(y)}" y2="${f1(y)}" stroke="${color}" stroke-width="1" stroke-dasharray="4 4" opacity=".8"/>
      <text x="${W - PAD.r - 4}" y="${f1(y - 4)}" text-anchor="end" font-size="10" fill="#9AA3B5">${esc(label)}</text>`;
    const pct = (v) => `${Math.round(v * 100)}%`;

    // Pace ratio: recent commit rate as a share of the earlier rate.
    const h1 = 200;
    const top1 = ticks(Math.max(1.25, ...known.map((x) => x.pace_ratio)), true).top;
    const L1 = line(h1, 'pace_ratio', top1, '#60A5FA');
    const strip = p.map((x, i) => `<rect x="${f1(PAD.l + i * slot + 0.5)}" y="${h1 - PAD.b + 6}" width="${f1(Math.max(1, slot - 1))}" height="6" rx="1" fill="${(STATUS[x.status] || STATUS['insufficient-data'])[1]}"/>`).join('');
    const tip1 = (i) => {
      const x = p[i];
      return `${CD.dayLong(x.date)}\n${(STATUS[x.status] || [x.status])[0]}${x.pace_ratio != null ? `\nPace ${pct(x.pace_ratio)} of the earlier rate` : ''}${x.churn_ratio != null ? `\nRework ${pct(x.churn_ratio)}` : ''}`;
    };
    const body1 = grid(h1 - 14, top1, 0.25, pct, h1 - PAD.b) + thresh(L1.y(r.on_pace), `On pace ≥ ${pct(r.on_pace)}`, '#34D399') + thresh(L1.y(r.at_risk), `Behind < ${pct(r.at_risk)}`, '#F87171')
      + L1.path + strip + hits(p.length, slot, h1, tip1);
    const h1full = h1 + 16;
    const xl1 = xLabels(p, cx, h1full, (x) => CD.dayMed(x.date));

    // Rework share: deletions out of all changes over the churn window.
    const h2 = 150;
    const hasRework = p.some((x) => x.churn_ratio != null);
    const L2 = line(h2, 'churn_ratio', 1, '#A855F7');
    const body2 = grid(h2, 1, 0.25, pct, h2 - PAD.b) + thresh(L2.y(r.rework), `Heavy rework > ${pct(r.rework)}`, '#F59E0B') + L2.path
      + xLabels(p, cx, h2, (x) => CD.dayMed(x.date)) + hits(p.length, slot, h2, tip1);

    const counts = {};
    for (const x of p) counts[x.status] = (counts[x.status] || 0) + 1;
    const now = p.at(-1);
    const basis = (p.find((x) => x.churn_basis) || {}).churn_basis;
    return `<section class="card solid"><div class="card-head"><div><h2>Pace vs. deadline</h2><p class="sub">What the deadline prediction would have said on each day · due ${esc(CD.dayMed(a.deadline_date))}</p></div>
        ${pill(`Today: ${(STATUS[now.status] || [now.status])[0]}`, (STATUS[now.status] || [0, '#9AA3B5'])[1])}</div>
      ${legend([['Pace (last 7 days vs. earlier)', '#60A5FA', 'line'], ...Object.keys(STATUS).filter((k) => counts[k]).map((k) => [`${STATUS[k][0]} · ${plural(counts[k], 'day')}`, STATUS[k][1]])])}
      ${svg(h1full, `Pace ratio per day with the on-pace and behind thresholds; ${Object.keys(counts).map((k) => `${(STATUS[k] || [k])[0]} ${counts[k]} days`).join(', ')}`, body1 + xl1)}
      <h3 class="stat-label" style="margin:16px 0 4px">Rework share</h3>
      ${legend([[`Removed out of all changes, last ${a.rules.churn_window_days} days${basis === 'files' ? ' (files)' : basis === 'lines' ? ' (lines)' : ''}`, '#A855F7', 'line']])}
      ${hasRework ? svg(h2, 'Share of changes that were removals, per day, with the heavy-rework threshold', body2) : '<p class="note" style="padding:8px 0">No file or line changes recorded in this period, so rework can\'t be measured.</p>'}
      <p class="note">Pace below ${pct(r.on_pace)} is "at risk" and below ${pct(r.at_risk)} "behind". Heavy rework turns "on pace" into "at risk". Rule-based, not a forecast.</p>
      ${table(['Day', 'Status', 'Pace', 'Rework'], p.slice().reverse().map((x) => [esc(CD.dayMed(x.date)), esc((STATUS[x.status] || [x.status])[0]), x.pace_ratio == null ? '—' : pct(x.pace_ratio), x.churn_ratio == null ? '—' : pct(x.churn_ratio)]))}</section>`;
  }

  /* ---------- 5. code churn per week ---------- */
  function churn(a) {
    const wk = a.weeks;
    const lines = a.churn_basis === 'lines';
    const slot = (W - PAD.l - PAD.r) / wk.length;
    const bw = Math.min(56, slot * 0.6);
    const cx = (i) => PAD.l + i * slot + slot / 2;
    let body;
    let h;
    let tip;
    let legendItems;
    let rows;
    let label;
    if (!lines && !wk.some((w) => w.files_added + w.files_modified + w.files_removed)) {
      return `<section class="card solid"><div class="card-head"><div><h2>Code churn</h2><p class="sub">Files changed per week</p></div></div>
        <p class="note" style="padding:8px 0">No file or line changes were recorded for these commits. GitHub sends file lists with webhook pushes and token checks; commits added another way may not have them.</p></section>`;
    }
    if (lines) {
      // Diverging: added above the axis, removed below, on one scale.
      h = 240;
      const max = Math.max(1, ...wk.map((w) => Math.max(w.lines_added, w.lines_deleted)));
      const { top, step } = ticks(max);
      const mid = PAD.t + (h - PAD.b - PAD.t) / 2;
      const s = (v) => (v / top) * ((h - PAD.b - PAD.t) / 2);
      let g = '';
      for (let v = -top; v <= top + 1e-9; v += step) {
        const yy = mid - s(v);
        g += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${f1(yy)}" y2="${f1(yy)}" stroke="${v === 0 ? 'rgba(255,255,255,.25)' : GRID}"/><text x="${PAD.l - 6}" y="${f1(yy + 3.5)}" text-anchor="end" font-size="10" fill="${INK}">${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}</text>`;
      }
      body = g + wk.map((w, i) => bar(cx(i) - bw / 2, mid - 1, mid - 1 - s(w.lines_added), bw, '#60A5FA') + bar(cx(i) - bw / 2, mid + 1, mid + 1 + s(w.lines_deleted), bw, '#A855F7')).join('');
      tip = (i) => { const w = wk[i]; return `${weekRange(w)}\n+${w.lines_added} added · −${w.lines_deleted} removed\nfrom ${plural(w.line_commits, 'commit')} with line counts`; };
      legendItems = [['Lines added', '#60A5FA'], ['Lines removed', '#A855F7']];
      rows = wk.slice().reverse().map((w) => [esc(weekRange(w)), `+${w.lines_added}`, `−${w.lines_deleted}`, w.line_commits]);
      label = 'Lines added and removed per week';
    } else {
      h = 220;
      const { top, step } = ticks(Math.max(...wk.map((w) => w.files_added + w.files_modified + w.files_removed)));
      const y0 = h - PAD.b;
      const y = (v) => y0 - (v / top) * (y0 - PAD.t);
      const parts = [['files_added', '#60A5FA'], ['files_modified', '#9AA3B5'], ['files_removed', '#A855F7']];
      body = grid(h, top, step, (v) => v, y0) + wk.map((w, i) => {
        let acc = 0;
        const present = parts.filter(([k]) => w[k]);
        return present.map(([k, c], j) => {
          const lo = y(acc);
          acc += w[k];
          const hi = y(acc) + (j < present.length - 1 ? 1 : 0);
          if (j === present.length - 1) return bar(cx(i) - bw / 2, lo - (j ? 1 : 0), hi, bw, c);
          return `<rect x="${f1(cx(i) - bw / 2)}" y="${f1(hi)}" width="${f1(bw)}" height="${f1(Math.max(0, lo - hi - (j ? 1 : 0)))}" fill="${c}"/>`;
        }).join('');
      }).join('');
      tip = (i) => { const w = wk[i]; return `${weekRange(w)}\n${w.files_added} added · ${w.files_modified} modified · ${w.files_removed} removed`; };
      legendItems = [['Files added', '#60A5FA'], ['Files modified', '#9AA3B5'], ['Files removed', '#A855F7']];
      rows = wk.slice().reverse().map((w) => [esc(weekRange(w)), w.files_added, w.files_modified, w.files_removed]);
      label = 'Files added, modified and removed per week';
    }
    body += xLabels(wk, cx, h, weekLabel) + hits(wk.length, slot, h, tip);
    return `<section class="card solid"><div class="card-head"><div><h2>Code churn</h2><p class="sub">${lines ? 'Lines added and removed per week' : 'Files changed per week'}</p></div></div>
      ${legend(legendItems)}${svg(h, label, body)}
      <p class="note">${lines ? 'Only commits with known line counts are included (repositories checked with a token).' : 'Line counts are only recorded for repositories checked with a token, so this shows files changed instead.'} Context only, not a measure of output.</p>
      ${table(lines ? ['Week', 'Added', 'Removed', 'Commits counted'] : ['Week', 'Added', 'Modified', 'Removed'], rows)}</section>`;
  }

  /* ---------- 6. contributor activity (small multiples, one shared scale, name order) ---------- */
  function people(a) {
    const wk = a.weeks;
    const quiet = a.rules.comparison_days;
    if (!a.contributors.length) return '<section class="card solid"><h2>Contributor activity</h2><p class="empty">No contributors yet.</p></section>';
    const max = Math.max(1, ...a.contributors.flatMap((c) => c.weekly));
    const w = 220; const h = 64;
    const slot = w / wk.length;
    const bw = Math.min(18, slot * 0.6);
    const cards = a.contributors.map((c) => {
      const bars = c.weekly.map((n, i) => bar(i * slot + (slot - bw) / 2, h - 1, h - 1 - (n / max) * (h - 8), bw, '#22D3EE', Math.min(3, bw / 2))).join('');
      const hit = c.weekly.map((n, i) => `<rect class="hit" x="${f1(i * slot)}" y="0" width="${f1(slot)}" height="${h}" fill="transparent" data-tip="${esc(`${c.name} · ${weekRange(wk[i])}\n${plural(n, 'commit')}`)}"/>`).join('');
      const badge = c.idle_days >= quiet ? pill(`Inactive ${plural(c.idle_days, 'day')}`, '#F59E0B') : c.idle_days === 0 ? pill('Committed today', '#34D399') : pill(`Last commit ${CD.dayMed(c.last_date)}`, '#9AA3B5');
      return `<article class="an-person"><div class="person-head">${CD.avatar(c.name, 28)}<div class="who"><b>${esc(c.name)}</b><small>${plural(c.commits, 'commit')} in ${a.days} days</small></div></div>
        <svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(`${c.name}: commits per week, ${c.weekly.join(', ')}`)}"><line x1="0" x2="${w}" y1="${h - 0.5}" y2="${h - 0.5}" stroke="${GRID}"/>${bars}${hit}</svg>
        <div>${badge}</div></article>`;
    }).join('');
    return `<section class="card solid"><div class="card-head"><div><h2>Contributor activity</h2><p class="sub">Commits per week for each person, on the same scale (up to ${max} a week), in name order</p></div></div>
      <div class="an-people">${cards}</div>
      <p class="note" style="margin-top:12px">Shows when each person was active, to help coordination. Not a ranking or a performance measure. "Inactive" means no commits for ${plural(quiet, 'day')} or more.</p>
      ${table(['Contributor', ...wk.map(weekLabel), 'Last commit'], a.contributors.map((c) => [esc(c.name), ...c.weekly, esc(CD.dayMed(c.last_date))]))}</section>`;
  }

  /* ---------- tooltip ---------- */
  function wireTooltip(main) {
    const tip = document.createElement('div');
    tip.className = 'an-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.append(tip);
    let current = null;
    const place = (e) => {
      const pad = 12;
      const r = tip.getBoundingClientRect();
      let x = e.clientX + pad;
      let y = e.clientY + pad;
      if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
      if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
      tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
    };
    main.addEventListener('pointermove', (e) => {
      const h = e.target.closest('.hit');
      if (!h) { if (current) { current.classList.remove('on'); current = null; } tip.hidden = true; return; }
      if (h !== current) {
        if (current) current.classList.remove('on');
        current = h;
        h.classList.add('on');
        const [head, ...rest] = h.dataset.tip.split('\n');
        tip.innerHTML = `<b>${esc(head)}</b>${rest.map((l) => `<span>${esc(l)}</span>`).join('')}`;
        tip.hidden = false;
      }
      place(e);
    });
    main.addEventListener('pointerleave', () => { tip.hidden = true; if (current) current.classList.remove('on'); current = null; });
  }

  /* ---------- page ---------- */
  CD.start('analytics', async (main) => {
    const o = CD.ctx.overview;
    if (!o.repo && !o.totals.commits) {
      main.innerHTML = `${CD.pageHead('Analytics', 'Nothing connected yet')}<section class="card"><p class="hint">Connect a repository to see its trends here.</p><p style="margin-top:12px"><button class="btn btn-primary" data-open="connect">Connect repository</button></p></section>`;
      return;
    }
    let days = Number(CD.store.get('comdoc.analyticsDays'));
    if (!RANGES.includes(days)) days = 30;
    const draw = async () => {
      const a = await get(`/analytics?days=${days}`);
      const seg = RANGES.map((n) => `<button type="button" data-days="${n}" aria-pressed="${n === days}">${n} days</button>`).join('');
      main.innerHTML = `${CD.pageHead('Analytics', `${o.repo || 'All repositories'} · ${CD.dayMed(a.start)} – ${CD.dayMed(a.end)} · ${plural(a.totals.commits, 'commit')} from ${plural(a.totals.contributors, 'contributor')}`, `<div class="seg" role="group" aria-label="Range">${seg}</div>`)}
        <div class="section-gap">${activity(a)}${workMix(a)}${pace(a)}${churn(a)}${people(a)}</div>
        <p class="footnote">Built from commit metadata only. Commit Doctor never scores or ranks people.</p>`;
      main.dataset.daily = JSON.stringify(a.daily.map((x) => x.date));
    };
    await draw();
    wireTooltip(main);
    main.addEventListener('click', (e) => {
      const b = e.target.closest('[data-days]');
      if (b && Number(b.dataset.days) !== days) {
        days = Number(b.dataset.days);
        CD.store.set('comdoc.analyticsDays', String(days));
        draw().catch((err) => CD.toast(err.message));
        return;
      }
      // Clicking a day in the activity chart opens it on the dashboard.
      const h = e.target.closest('.hit');
      const chart = h && h.closest('section');
      if (h && chart === main.querySelector('.section-gap > section')) {
        const i = [...chart.querySelectorAll('.hit')].indexOf(h);
        const dates = JSON.parse(main.dataset.daily || '[]');
        if (dates[i]) window.location.href = `index.html?date=${dates[i]}`;
      }
    });
  }, { title: 'Analytics' });
})();
