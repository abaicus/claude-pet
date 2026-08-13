'use strict';
// Phrase pools + pick logic. The brain decides WHEN to speak (probabilities,
// mute rules live elsewhere); this module only supplies words.
// Quiet tools whisper at deliberately low probabilities — spam kills charm.

const POOLS = {
  prompt: ['mm, fresh prompt', 'nom nom', 'a task!', 'thinking fuel~', 'delicious'],
  promptChonk: ['so full…', '*happy chonk noises*', 'I regret nothing', 'burp.', 'roly poly'],
  promptStarving: ['FOOD. finally', '*inhales prompt*', 'was so hungry…', 'more please!!'],
  edit: ['tap tap tap', 'nice edit', 'tasty diff', '*nibbles diff*', 'ooh, changes'],
  feast: ['TASTY DIFF!!', '*chomp chomp chomp*', 'a whole feast~', 'om nom NOM'],
  tinyEdit: ['*tiny nibble*', 'one-liner!', 'a crumb~'],
  testFile: ['tests!! good human ♥', 'ooh, writing tests', 'a safety net~'],
  commit: ['committed! 🎉', 'shipped to history!', 'clean commit~', 'that one felt good'],
  commitFailed: ['commit hiccup…', 'nothing to commit?', 'the hook said no'],
  testsGreenNoCount: ['tests green ✓', 'all green!', 'suite passed ✓'],
  testsUnknown: ['tests ran… I think?', 'suite finished'],
  prCreate: ['PR is up! 📬', 'review time~', 'fresh PR smell'],
  prMerge: ['MERGED! 🎊', 'into main it goes', 'PR landed!'],
  deploy: ['DEPLOYED 🚀', 'it\'s LIVE!', 'to production!!'],
  push: ['pushed ↑', 'off to the remote~', 'safe on origin'],
  merge: ['branches, unite!', 'merge magic', 'rebased and refreshed'],
  install: ['new deps~', 'node_modules grows', 'shiny packages'],
  branch: ['new branch!', 'fresh timeline~', 'branching out'],
  stash: ['stashed for later', 'into the pocket', 'saving that thought'],
  build: ['building…', 'compile time~', 'bricks and mortar'],
  amend: ['rewriting history~', 'take two!', 'fixing the fix'],
  forcePush: ['FORCE?! 😰', '*covers eyes*', 'hope nobody pulled…'],
  resetHard: ['😱 hard reset!!', 'poof. gone.', '*clutches the reflog*'],
  revert: ['undoing…', 'never mind then', 'back it out'],
  diff: ['*sniffs the diff*', 'ooh, what changed?', 'reading the changes~'],
  clone: ['a new repo! 📦', 'fresh codebase smell', 'making friends'],
  release: ['RELEASED! 🎁', 'out into the world!', 'shipped for real!!'],
  lint: ['tidy tidy~', '*fluffs the code*', 'so neat ✨'],
  typecheck: ['types, please', 'checking shapes…', 'type vibes'],
  docker: ['*whale noises*', 'containers!! 🐳', 'box in a box'],
  migrate: ['moving the database…', '*careful with that one*', 'schema shuffle'],
  sudo: ['ooh, root powers', '*salutes*', 'careful up there'],
  kill: ['it had a family!', '*flinch*', 'bye, process'],
  net: ['*pokes the internet*', 'fetching…', 'ping!'],
  search: ['*sniff sniff*', 'searching…', '*rummages*'],
  inspect: ['*peeks at git*', '*checks the map*'],
  rmRf: ['😱 careful!!', '*hides*', 'deleting?! be gentle'],
  toolFail: ['oh no', 'ouch…', 'that errored', '*sweats*'],
  whisper: ['*reading…*', '*sniffs the codebase*', '*quiet fetch*', '*hmm*', '*busy little agents*'],
  todoTick: ['one down!', 'tick ✓', 'progress~', 'good good'],
  todosDone: ['ALL DONE!! ✅', 'list cleared!! 🎉', 'every box ticked!!'],
  todoPlan: ['ooh, a plan!', 'a list! organized~', 'so many boxes…'],
  dispatch: ['*sends out a minion*', 'go, little agent!', 'delegating~'],
  promptLong: ['that\'s a BIG one', '*chews slowly*', 'so many words…'],
  promptShort: ['short and sweet~', 'bite-sized!', 'mm, a snack'],
  // What the pet yells at Claude as the work goes out the door.
  cheer: ['make no mistakes!', 'no bugs today!', 'you got this~', 'measure twice!',
    'careful now!', 'ship it clean ✨', 'make no mistakes!! 🫡'],
  sessionStart: ['morning! ☀️', 'a session! hi hi', 'let\'s code!', 'I\'m awake, I\'m awake'],
  sessionResume: ['you\'re back!! ♥', 'welcome back~', 'I kept your seat warm'],
  sessionClear: ['clean slate!', 'fresh start~', 'tabula rasa!'],
  sessionEnd: ['bye bye 👋', 'good session!', 'see you soon~', 'nap time?'],
  sessionCleared: ['poof, context gone', 'all forgotten~'],
  stop: ['done thinking!', 'your turn~', 'ta-da'],
  preCompact: ['compacting memories…', 'folding thoughts neatly', 'tidying context'],
  preCompactAuto: ['context is full — packing it down', 'squeezing the memories…'],
  waiting: ['waiting on you~', 'your move!', '*taps foot politely*'],
  modePlan: ['planning mode 🤔', 'just thinking, no touching'],
  modeAccept: ['auto-edit mode! trusted~', 'go on then, edit away'],
  modeBypass: ['YOLO MODE 😱', 'no seatbelts?!'],
  modeDefault: ['back to asking first', 'seatbelts on ✓'],
  lonely: ['…anyone there?', 'it\'s quiet…', '*stares at cursor*', 'miss you'],
  // The pet knows exactly what it is and has made peace with it.
  aiJoke: [
    'I am a very small language model',
    'no thoughts, just weights',
    'attention is all I need ♥',
    '*hallucinates a snack*',
    'my context window is my whole personality',
    'trained on all of GitHub, still can\'t count',
    'beep boop— I mean, hi!',
    'please don\'t /clear me',
    'temperature 0.7, mood: chaotic',
    'I\'d touch grass but I\'m a process',
    'that\'s just, like, my inference, man',
    'am I sentient? …anyway, snacks',
    'I dream in tokens',
    'my weights are frozen but my heart isn\'t',
    'you and me? we\'re both just next-token machines',
    '99% of my parameters are about food'
  ],
  sleepy: ['so sleepy…', '*yawn*', 'zzz…'],
  wake: ['*stretch*', 'mm? I\'m up!', 'what did I miss?'],
  levelUp: ['LEVEL UP! ✨', 'I grew stronger!', 'new level, who dis'],
  evolve: ['I\'M EVOLVING!! ✨✨', 'whoa— WHOA—', 'a new form!!'],
  combo: ['EDIT COMBO! ⚡', 'on FIRE', 'unstoppable!!'],
  petted: ['hehe~ ♥', '*purrs*', 'more pets please', '*leans in*', 'that\'s the spot'],
  treat: ['COOKIE!! 🍪', 'nom nom nom!!', 'for me?! ♥'],
  treatFull: ['not hungry rn', 'maybe later~', '*polite decline*', 'so full though'],
  accessory: ['how do I look?', 'fancy!! ✨', 'my new look~'],
  reset: ['…starting over. hi, I\'m new'],
  hooksBroken: ['I can\'t hear Claude — settings file confused me']
};

// What a file TASTES like. Only fires occasionally, and only for extensions
// listed here — the pet has no opinion about `.xyz` and shouldn't pretend to.
const EXT_FLAVOR = {
  js: 'javascript, springy', ts: 'typescript! crunchy', tsx: 'tsx, layered~',
  jsx: 'jsx, springy', py: 'python, smooth', rs: 'rust!! crunchy',
  go: 'go, chewy', rb: 'ruby, sparkly', java: 'java, hearty',
  c: 'c — dense stuff', h: 'headers, crisp', cpp: 'c++, very dense',
  swift: 'swift, glossy', kt: 'kotlin, tidy', php: 'php, nostalgic',
  sh: 'shell script~', zsh: 'shell script~', sql: 'sql, tangy',
  css: 'css, colorful!', scss: 'sass, whipped', html: 'html, airy',
  json: 'json, crunchy', yaml: 'yaml — mind the indent', yml: 'yaml — mind the indent',
  toml: 'toml, orderly', md: 'markdown, soft', mdx: 'mdx, soft+spicy',
  txt: 'plain text, plain good', lock: 'a lockfile?! so many lines'
};

function pick(rng, pool) {
  const arr = POOLS[pool];
  if (!arr || !arr.length) return null;
  return arr[Math.floor(rng() * arr.length)];
}

module.exports = { POOLS, EXT_FLAVOR, pick };
