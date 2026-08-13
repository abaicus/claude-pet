'use strict';
// Phrase pools + pick logic. The brain decides WHEN to speak (probabilities,
// mute rules live elsewhere); this module only supplies words.
// Quiet tools whisper at deliberately low probabilities — spam kills charm.

const POOLS = {
  prompt: ['mm, fresh prompt', 'nom nom', 'a task!', 'thinking fuel~', 'delicious'],
  promptChonk: ['so full…', '*happy chonk noises*', 'I regret nothing', 'burp.', 'roly poly'],
  promptStarving: ['FOOD. finally', '*inhales prompt*', 'was so hungry…', 'more please!!'],
  edit: ['tap tap tap', 'nice edit', '*nibbles diff*', 'ooh, changes'],
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
  rmRf: ['😱 careful!!', '*hides*', 'deleting?! be gentle'],
  toolFail: ['oh no', 'ouch…', 'that errored', '*sweats*'],
  whisper: ['*reading…*', '*sniffs the codebase*', '*quiet fetch*', '*hmm*', '*busy little agents*'],
  sessionStart: ['morning! ☀️', 'a session! hi hi', 'let\'s code!', 'I\'m awake, I\'m awake'],
  sessionEnd: ['bye bye 👋', 'good session!', 'see you soon~', 'nap time?'],
  stop: ['done thinking!', 'your turn~', 'ta-da'],
  preCompact: ['compacting memories…', 'folding thoughts neatly', 'tidying context'],
  lonely: ['…anyone there?', 'it\'s quiet…', '*stares at cursor*', 'miss you'],
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

function pick(rng, pool) {
  const arr = POOLS[pool];
  if (!arr || !arr.length) return null;
  return arr[Math.floor(rng() * arr.length)];
}

module.exports = { POOLS, pick };
