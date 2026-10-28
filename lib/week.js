// ISO-8601 week helpers.
//
// A "week" is the unit of tracking in this app: every screenshot uploaded
// between Monday and Sunday belongs to the same LME Phase 1 result.
// Keys look like "2026-W44" so they sort correctly as plain text.

const pad2 = (n) => String(n).padStart(2, '0');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO week key for a date built from UTC components. */
export function keyFromDate(date) {
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = t.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum); // move to Thursday of this ISO week
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad2(week)}`;
}

/** ISO week key of "today" in the server's local time zone. */
export function currentWeekKey(now = new Date()) {
  return keyFromDate(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

export function parseWeekKey(key) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  return { year: Number(m[1]), week };
}

/** Monday 00:00 UTC of a given ISO year/week. */
export function mondayOf(year, week) {
  // 4 January is always inside ISO week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayNum = jan4.getUTCDay() || 7;
  const week1Monday = new Date(Date.UTC(year, 0, 4 - (dayNum - 1)));
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return monday;
}

/** { start, end } as UTC dates (Monday .. Sunday) for a week key. */
export function weekRange(key) {
  const parsed = parseWeekKey(key);
  if (!parsed) return null;
  const start = mondayOf(parsed.year, parsed.week);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { start, end };
}

/** Move by whole weeks, e.g. shiftWeek('2026-W44', -1) -> '2026-W43'. */
export function shiftWeek(key, delta) {
  const range = weekRange(key);
  if (!range) return null;
  const target = new Date(range.start);
  target.setUTCDate(target.getUTCDate() + delta * 7);
  return keyFromDate(target);
}

export function formatDay(date) {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** "Week 44 (2026) · 26 Oct – 1 Nov" */
export function weekLabel(key) {
  const parsed = parseWeekKey(key);
  if (!parsed) return String(key || '');
  const range = weekRange(key);
  const { start, end } = range;
  const span = start.getUTCMonth() === end.getUTCMonth()
    ? `${start.getUTCDate()}–${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]}`
    : `${formatDay(start)} – ${formatDay(end)}`;
  return `Week ${parsed.week} (${parsed.year}) · ${span}`;
}

export function isWeekKey(key) {
  return parseWeekKey(key) !== null;
}
