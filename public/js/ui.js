// Small DOM and API helpers shared by all pages.

export const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

export const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

export async function api(path, { method = 'GET', body, raw, headers } = {}) {
  const response = await fetch(path, {
    method,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    headers: body === undefined && !raw ? headers : { 'Content-Type': 'application/json', ...headers },
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({ error: `Server sent a non-JSON reply (${response.status}).` }));
  if (!response.ok) throw Object.assign(new Error(payload.error || `Request failed (${response.status})`), { payload });
  return payload;
}

export function toast(message, kind = 'info', ms = 4000) {
  const host = document.getElementById('toast') || document.body;
  const box = el('div', { class: `toast ${kind}`, text: message });
  host.append(box);
  setTimeout(() => box.remove(), ms);
  if (kind === 'error') box.addEventListener('click', () => box.remove());
}

export const ROLE_LABELS = {
  leader: 'Leader',
  vice: 'Vice Leader',
  glory: 'Glory Member',
  member: 'Member',
};

export const roleTag = (role) =>
  el('span', { class: `tag role-${role}`, text: ROLE_LABELS[role] || role });

/** Highlight a player name with a colour hint for the clan hierarchy. */
export function playerName(name, role) {
  const node = el('span', { text: name });
  if (role === 'leader' || role === 'vice') node.style.color = '#ffd85e';
  else if (role === 'glory') node.style.color = '#ffb08a';
  return node;
}

/** Clickable column headers that sort an array of rows client side. */
export function sortableHeaders(table, getRows, renderRows) {
  const state = { key: null, dir: -1 };
  for (const head of table.querySelectorAll('th.sortable')) {
    head.addEventListener('click', () => {
      const key = head.dataset.sort;
      state.dir = state.key === key ? -state.dir : -1;
      state.key = key;
      for (const other of table.querySelectorAll('th.sortable')) {
        clear(other.querySelector('.arrow') || el('span'));
        other.querySelector('.arrow')?.remove();
      }
      head.append(el('span', { class: 'arrow', text: state.dir === -1 ? '▼' : '▲' }));
      renderRows(sortRows(getRows(), key, state.dir));
    });
  }
  return state;
}

export function sortRows(rows, key, dir) {
  const value = (row) => {
    switch (key) {
      case 'score': return row.score;
      case 'gain': return row.gain;
      case 'gain_pct': return row.gain_pct === null ? -Infinity : row.gain_pct;
      case 'prev': return row.prev_score ?? -1;
      case 'rank': return row.rank;
      default: return String(row[key] ?? '').toLowerCase();
    }
  };
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * (dir === -1 ? -1 : 1) * -1 || a.name.localeCompare(b.name);
    return String(x).localeCompare(String(y)) * (dir === -1 ? -1 : 1);
  });
}

/** Marks gain cells green/red and shows "new" when there is no baseline. */
export function gainCell(gain) {
  if (gain > 0) return el('td', { class: 'num pos', text: `+${gain.toLocaleString('en-US')}` });
  if (gain < 0) return el('td', { class: 'num neg', text: gain.toLocaleString('en-US') });
  return el('td', { class: 'num muted', text: '0' });
}

export function pctCell(gainPct) {
  if (gainPct === null || gainPct === undefined) return el('td', { class: 'num', text: '—', title: 'No score last week' });
  const text = `${gainPct > 0 ? '+' : ''}${gainPct.toFixed(1)}%`;
  const cls = gainPct > 0 ? 'num pos' : gainPct < 0 ? 'num neg' : 'num muted';
  return el('td', { class: cls, text });
}
