import { api, el, clear, toast } from './ui.js';
import { formatNumber } from './text.js';

const table = document.getElementById('weekTable');
const currentLine = document.getElementById('currentLine');

function render(data) {
  clear(table);
  currentLine.textContent = data.current.has_data
    ? `This week is ${data.current.label}.`
    : `This week is ${data.current.label} — no scores registered yet.`;

  if (!data.weeks.length) {
    table.append(el('div', { class: 'empty' }, [
      'No weeks recorded yet. ',
      el('a', { href: '/register.html', text: 'Register LME Phase 1 scores' }),
      ' from your screenshots.',
    ]));
    return;
  }

  const body = el('tbody');
  for (const week of data.weeks) {
    body.append(el('tr', {}, [
      el('td', {}, [el('a', { href: `/week.html?week=${week.week}`, text: week.label })]),
      el('td', { class: 'num', text: formatNumber(week.player_count) }),
      el('td', { class: 'num', text: formatNumber(week.total_score) }),
      el('td', { class: 'num', text: formatNumber(week.top_score) }),
      el('td', { class: 'num muted', text: new Date(week.updated_at).toLocaleString() }),
      el('td', { class: 'num' }, [
        week.is_current ? el('span', { class: 'tag', text: 'current' }) : '',
      ]),
    ]));
  }

  table.append(el('table', {}, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Week' }),
      el('th', { class: 'num', text: 'Members' }),
      el('th', { class: 'num', text: 'Total score' }),
      el('th', { class: 'num', text: 'Best' }),
      el('th', { class: 'num', text: 'Last change' }),
      el('th', { class: 'num', text: '' }),
    ])]),
    body,
  ]));
}

async function load() {
  try {
    render(await api('/api/weeks'));
  } catch (err) {
    clear(table).append(el('div', { class: 'empty', text: err.message }));
  }
}

document.getElementById('saveGlory').addEventListener('click', async () => {
  const count = Number(document.getElementById('gloryCount').value);
  try {
    const saved = await api('/api/glory-count', { method: 'PUT', body: { count } });
    toast(`Glory slots set to ${saved.glory_count}.`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
});

load().then(() => {
  api('/api/settings').then((s) => { document.getElementById('gloryCount').value = s.glory_count; });
});
