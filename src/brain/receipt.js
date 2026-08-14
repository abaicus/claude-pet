'use strict';
// The day, printed as a till receipt.
//
// Pure text, produced brain-side, because the window that shows it should be a
// printer and nothing more — the same deal the pet window gets. Fixed width,
// right-aligned figures, and no line that the ledger cannot back up.
//
// The XP column is the honest part. Each item is priced at the rate the brain
// actually pays for it, so the column adds up to what those items really
// earned; everything else the day earned (petting, milestones, curing a sick
// pet) lands in one OTHER line rather than being smeared across the items.
// A receipt that does not balance is a receipt nobody believes.

const { TUNING, XP_LADDER, MAX_LEVEL, formForLevel } = require('../shared/constants');

const W = 30;                       // characters — the width of the paper

// key → what it is called on the roll, and what the brain pays for one.
// `xp: null` means the item earns none: prompts are food, red tests are a
// setback. Printed as "--" rather than "0", which would read as a failure to
// count rather than a thing that is not counted in this column.
const ITEMS = [
  { key: 'prompts', label: 'PROMPT FED', xp: null },
  { key: 'edits', label: 'EDIT', xp: () => TUNING.xpPerEdit },
  { key: 'feasts', label: '  …OF WHICH FEASTS', xp: null, sub: true },
  { key: 'todos', label: 'TODO TICKED', xp: () => TUNING.todoXp },
  { key: 'commits', label: 'COMMIT', xp: () => TUNING.commit.xp },
  { key: 'testsGreen', label: 'TESTS GREEN', xp: () => TUNING.testsGreenXp },
  { key: 'testsRed', label: 'TESTS RED', xp: null },
  { key: 'sick', label: '  …TOOK TO BED', xp: null, sub: true },
  { key: 'prs', label: 'PULL REQUEST', xp: () => TUNING.prXp },
  { key: 'deploys', label: 'DEPLOY', xp: () => TUNING.deployXp },
  { key: 'releases', label: 'RELEASE', xp: () => TUNING.deployXp },
  { key: 'treats', label: 'TREAT', xp: () => TUNING.treat.xp },
  { key: 'pets', label: 'HEAD PAT', xp: null }
];

const pad = (s) => String(s).slice(0, W).padEnd(W);
const centre = (s) => {
  const t = String(s).slice(0, W);
  return ' '.repeat(Math.max(0, Math.floor((W - t.length) / 2))) + t;
};
const rule = (ch = '-') => ch.repeat(W);

// "12  SOMETHING          260"
function row(qty, label, amount) {
  const q = String(qty).padStart(3);
  const a = String(amount).padStart(6);
  const room = W - q.length - a.length - 2;
  return `${q}  ${String(label).slice(0, room).padEnd(room)}${a}`;
}
function totalRow(label, amount) {
  const a = String(amount).padStart(6);
  return String(label).slice(0, W - a.length).padEnd(W - a.length) + a;
}

function tokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function stamp(ms) {
  const d = new Date(ms);
  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${p(d.getDate())} ${MON[d.getMonth()]} ${d.getFullYear()}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`
  };
}

// A barcode is a rhythm, not a random smear — and it has to be the SAME
// rhythm every time the same day is printed, or the receipt looks alive in the
// one way paper never is. Seeded off the day's own numbers.
function barcode(day) {
  let seed = (day.xp * 7 + day.commits * 13 + day.edits * 31 + 17) >>> 0;
  const next = () => (seed = (seed * 1103515245 + 12345) >>> 0);
  let out = '';
  while (out.length < W) out += (next() % 3 === 0 ? '█' : (next() % 2 ? '▌' : '│'));
  return out.slice(0, W);
}

/**
 * @param {object} day    a ledger (see ledger.js)
 * @param {object} opts   {name, level, xp, greenStreak, lifetimeCommits, now}
 * @returns {string[]} the printed lines, top to bottom
 */
function receiptLines(day, opts = {}) {
  const name = String(opts.name || 'GOGU').toUpperCase();
  const level = opts.level || 0;
  const when = stamp(opts.now || Date.now());
  const out = [];

  out.push(centre('G O G U   M A R T'));
  out.push(centre('* * * * * * * * *'));
  out.push('');
  out.push(pad(`${when.date}${' '.repeat(Math.max(1, W - when.date.length - when.time.length))}${when.time}`));
  out.push(pad(`CASHIER: ${name} (LV.${level})`));
  out.push(pad(`FORM: ${String(formForLevel(level)).toUpperCase()}`));
  out.push(rule());
  out.push(row('QTY', 'ITEM', 'XP'));
  out.push(rule());

  let subtotal = 0;
  let printed = 0;
  for (const item of ITEMS) {
    const n = day[item.key] || 0;
    if (!n) continue;
    printed++;
    if (item.sub) { out.push(row(n, item.label, '')); continue; }
    if (!item.xp) { out.push(row(n, item.label, '--')); continue; }
    const amount = item.xp() * n;
    subtotal += amount;
    out.push(row(n, item.label, amount));
  }
  if (!printed) {
    out.push('');
    out.push(centre('( NOTHING YET TODAY )'));
    out.push('');
  }

  const dayXp = day.xp || 0;
  const other = dayXp - subtotal;
  out.push(rule());
  out.push(totalRow('SUBTOTAL', subtotal));
  // Petting, milestones, a cure — everything the items above do not price.
  // Can go negative only if the tuning changed mid-day, which is worth seeing.
  if (other !== 0) out.push(totalRow('BONUSES & PATS', other));
  out.push(totalRow('TOTAL XP', dayXp));
  out.push(rule('='));
  if (day.levels) out.push(totalRow('LEVELS GAINED', day.levels));
  out.push(totalRow('TOKENS SPOKEN', tokens(day.tokens || 0)));
  if (day.bestStreak) out.push(totalRow('LONGEST GREEN RUN', day.bestStreak));
  if (opts.xpNext) out.push(totalRow(`XP TO LV.${level + 1}`, Math.max(0, opts.xpNext - (opts.xp || 0))));
  else if (level >= MAX_LEVEL) out.push(totalRow('RANK', 'MAX'));
  out.push(rule());
  out.push(barcode(day));
  out.push('');
  out.push(centre('THANK YOU FOR FEEDING'));
  out.push(centre(`YOUR ${name}`));
  out.push(centre('* NO REFUNDS *'));
  // Padding to the right edge is what aligned the figures; it is not part of
  // the text, and it should not be part of what you paste into Slack.
  return out.map(l => l.replace(/\s+$/, ''));
}

/** The one line the tray menu has room for. */
function receiptTeaser(day) {
  if (!day) return 'nothing yet today';
  const bits = [];
  if (day.commits) bits.push(`${day.commits} commit${day.commits === 1 ? '' : 's'}`);
  if (day.edits) bits.push(`${day.edits} edit${day.edits === 1 ? '' : 's'}`);
  if (day.testsGreen) bits.push(`${day.testsGreen} green`);
  if (!bits.length && day.prompts) bits.push(`${day.prompts} prompt${day.prompts === 1 ? '' : 's'}`);
  if (!bits.length) return 'nothing yet today';
  return `${bits.slice(0, 2).join(' · ')} · ${day.xp || 0} xp`;
}

module.exports = { receiptLines, receiptTeaser, ITEMS, W, XP_LADDER };
