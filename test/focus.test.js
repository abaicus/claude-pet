'use strict';
// Clicking a session line raises the terminal running it. Finding that window
// is guesswork — terminals title themselves however they like — so the guess
// is scored rather than assumed, and the ordering of those scores is the whole
// feature: raising the WRONG window is far worse than raising none.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { matchScore, pickBest, parseList } = require('../src/chrome/focus');

const HOME = os.homedir();
const CWD = path.join(HOME, 'Development', 'gogu');

test('an exact path is the strongest signal, in either notation', () => {
  assert.equal(matchScore(CWD, CWD), 100);
  assert.equal(matchScore('~/Development/gogu', CWD), 100);
});

test('a path in a title beats a name in a title beats a name buried in a word', () => {
  const inTitle = matchScore('zsh — ~/Development/gogu — 80×24', CWD);
  const word = matchScore('gogu — -zsh — 80×24', CWD);
  const buried = matchScore('my-gogu-fork', CWD);
  assert.ok(inTitle > word && word > buried, `scores out of order: ${inTitle} ${word} ${buried}`);
  assert.ok(buried > 0, 'a buried name is still a hint, just a weak one');
});

test('an unrelated window scores nothing at all', () => {
  assert.equal(matchScore('Slack', CWD), 0);
  assert.equal(matchScore('', CWD), 0);
  assert.equal(matchScore('~/Development/other', CWD), 0);
  assert.equal(matchScore('anything', ''), 0);
});

test('a sibling project is not this project', () => {
  // The bug this exists to prevent: ~/x/api raising the window for ~/x/api-docs.
  const api = path.join(HOME, 'x', 'api');
  assert.ok(matchScore('~/x/api — -zsh', api) > matchScore('~/x/api-docs — -zsh', api),
    'a longer sibling path outranked the real one');
});

test('the best window wins, not the first plausible one', () => {
  const cands = [
    { app: 'Terminal', window: 1, tab: 1, title: 'gogu-old — -zsh' },
    { app: 'iTerm2', window: 2, tab: 3, title: CWD },
    { app: 'Terminal', window: 3, tab: 1, title: 'gogu — vim' }
  ];
  const best = pickBest(cands, CWD);
  assert.equal(best.app, 'iTerm2');
  assert.equal(best.window, 2);
  assert.equal(best.tab, 3);
});

test('no plausible window at all is null, not a wild guess', () => {
  assert.equal(pickBest([{ app: 'Terminal', window: 1, tab: 1, title: 'Slack' }], CWD), null);
  assert.equal(pickBest([], CWD), null);
  assert.equal(pickBest(null, CWD), null);
});

test('ties go to the earliest listed — the most recently used window', () => {
  const cands = [
    { app: 'iTerm2', window: 4, tab: 1, title: 'gogu — -zsh' },
    { app: 'iTerm2', window: 9, tab: 1, title: 'gogu — -zsh' }
  ];
  assert.equal(pickBest(cands, CWD).window, 4);
});

// ---------------------------------------------------------------- the wire
test('the script output parses, including titles with pipes in them', () => {
  const rows = parseList([
    'iTerm2|1|2|/Users/me/code/gogu',
    'Terminal|3|1|gogu | vim | 80x24',
    '',
    'garbage'
  ].join('\n'));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { app: 'iTerm2', window: 1, tab: 2, title: '/Users/me/code/gogu' });
  assert.equal(rows[1].title, 'gogu | vim | 80x24', 'a piped title was truncated');
});

test('an empty or failed script is simply no candidates', () => {
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList(null), []);
});
