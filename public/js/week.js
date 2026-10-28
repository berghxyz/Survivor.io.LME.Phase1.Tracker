import { api, el, clear, toast, roleTag, playerName, sortableHeaders, sortRows, gainCell, pctCell } from './ui.js';
import { formatNumber } from './text.js';
import { currentWeekKey, shiftWeek, weekLabel, isWeekKey } from '/js/week.js';

const params = new URLSearchParams(location.search);
let week = isWeekKey(params.get('week')) ? params.get('week') : currentWeekKey();

let rows = [];
let meta = null;
const sort = { key: 'rank', dir: 1 };

const title = document.getElementById('title');
const subtitle = document.getElementById('subtitle');
const host = document.getElementById('tableHost');
const totals = document.getElementById('totals');
const filterBox = document.getElementById('filter');
const picker = document.getElementById('weekPicker');

function stat(label, value) {
  return el('div', { class: 'stat' }, [el('b', { text: value }), el('span', { text: label })]);
}

function renderTotals() {
  clear(totals);
  if (!meta) return;
  const t = meta.totals;
  totals.append(
    stat('Members', formatNumber(t.players)),
    stat('Total score', formatNumber(t.total_score)),
    stat('Average', formatNumber(t.avg_score)),
    stat('New this week', formatNumber(t.new_players)),
    stat('Total gain', `+${formatNumber(t.total_gain)}`),
  );
}

function visibleRows() {
  const needle = filterBox.value.trim().toLowerCase();
  const filtered = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : rows;
  if (sort.key === 'rank' && sort.dir === 1) return filtered;
  const sorted = sortRows(filtered, sort.key, sort.dir);
  if ((sort.key === 'rank' || sort.key === 'score') && sort.dir === -1) return sorted;
  return sorted;
}

function render() {
  clear(host);
  const list = visibleRows();
  const showGloryLine = (sort.key === 'rank' || (sort.key === 'score' && sort.dir === -1)) && meta?.glory_count > 0;

  const body = el('tbody');
  list.forEach((row, index) => {
    const tr = el('tr', {}, [
      el('td', { class: 'num muted', text: String(row.rank) }),
      el('td', {}, [playerName(row.name, row.role)]),
      el('td', {}, [roleTag(row.role)]),
      el('td', { class: 'num', text: formatNumber(row.score) }),
      el('td', { class: 'num muted', text: row.prev_score === null ? '—' : formatNumber(row.prev_score) }),
      gainCell(row.gain),
      pctCell(row.gain_pct),
    ]);
    if (showGloryLine && index === meta.glory_count) tr.classList.add('glory-line');
    body.append(tr);
  });

  const header = (label, key, extra = '') => {
    const th = el('th', { class: `sortable num ${extra}`.trim(), dataset: { sort: key }, text: label });
    if (sort.key === key) th.append(el('span', { class: 'arrow', text: sort.dir === -1 ? '▼' : '▲' }));
    th.addEventListener('click', () => {
      sort.dir = sort.key === key ? -sort.dir : (key === 'name' ? 1 : -1);
      sort.key = key;
      render();
    });
    return th;
  };

  const table = el('table', {}, [
    el('thead', {}, [el('tr', {}, [
      el('th', { class: 'num', text: '#' }),
      header('Member', 'name', 'plain'),
      el('th', { text: 'Role' }),
      header('Score', 'score'),
      header('Last week', 'prev'),
      header('Gain', 'gain'),
      header('Gain %', 'gain_pct'),
    ])]),
    body,
  ]);

  if (!list.length) {
    host.append(el('div', { class: 'empty', text: rows.length ? 'No member matches that filter.' : 'No scores for this week yet.' }));
    return;
  }
  host.append(table);
}

function renderProof(uploads) {
  const card = document.getElementById('proofCard');
  const box = clear(document.getElementById('proof'));
  card.hidden = !uploads?.length;
  for (const upload of uploads ?? []) {
    box.append(el('figure', { style: 'margin:0' }, [
      el('img', { class: 'thumb', src: upload.url, alt: upload.filename, style: 'max-width:180px' }),
      el('figcaption', { class: 'muted', style: 'font-size:.75rem', text: `${upload.filename} · ${upload.rows} rows` }),
    ]));
  }
}

async function load() {
  picker.innerHTML = '';
  let data;
  try {
    data = await api('/api/weeks');
  } catch (err) {
    return toast(err.message, 'error');
  }

  const keys = new Set(data.weeks.map((w) => w.week));
  keys.add(week);
  const sortedKeys = [...keys].sort().reverse();
  for (const key of sortedKeys) {
    picker.append(el('option', { value: key, text: weekLabel(key), selected: key === week }));
  }
  picker.value = week;

  try {
    meta = await api(`/api/weeks/${week}`);
    rows = meta.players;
    title.textContent = meta.label;
    subtitle.textContent = meta.prev_week
      ? `Gain compared with ${meta.prev_label}`
      : 'First recorded week — gain is 0 for everyone.';
    document.getElementById('csv').href = `/api/weeks/${week}/export.csv`;
    document.getElementById('deleteWeek').disabled = false;
    renderTotals();
    render();
    renderProof(meta.uploads);
  } catch (err) {
    rows = [];
    meta = null;
    title.textContent = weekLabel(week);
    subtitle.textContent = 'Nothing recorded for this week yet.';
    clear(totals);
    clear(host).append(el('div', { class: 'empty' }, [
      'No scores for this week. ',
      el('a', { href: `/register.html?week=${week}`, text: 'Register them now' }),
      '.',
    ]));
    document.getElementById('deleteWeek').disabled = true;
    renderProof([]);
  }
}

picker.addEventListener('change', () => {
  week = picker.value;
  history.replaceState(null, '', `?week=${week}`);
  load();
});

document.getElementById('prevWeek').addEventListener('click', () => goTo(shiftWeek(week, -1)));
document.getElementById('nextWeek').addEventListener('click', () => goTo(shiftWeek(week, 1)));

function goTo(target) {
  week = target;
  history.replaceState(null, '', `?week=${week}`);
  load();
}

filterBox.addEventListener('input', render);

document.getElementById('rollGlory').addEventListener('click', async () => {
  const count = meta?.glory_count ?? 5;
  if (!confirm(`Set the Glory slot to the top ${count} scores of ${meta?.label}?\nLeaders and Vice Leaders are left untouched.`)) return;
  try {
    const result = await api(`/api/weeks/${week}/glory`, { method: 'POST', body: { count } });
    toast(
      `${result.promoted.length} promoted to Glory, ${result.demoted.length} moved back to Member.`,
      'ok',
      6000,
    );
    meta = result.stats;
    rows = meta.players;
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('deleteWeek').addEventListener('click', async () => {
  if (!confirm(`Delete every score registered for ${weekLabel(week)}?`)) return;
  try {
    await api(`/api/weeks/${week}`, { method: 'DELETE' });
    toast(`Removed ${week}.`, 'ok');
    load();
  } catch (err) {
    toast(err.message, 'error');
  }
});

load();
