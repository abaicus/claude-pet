'use strict';
// Dropping the pet is the one bit of window plumbing with real arithmetic in
// it, and the failure modes are all silent: a pet that sinks through the
// floor, one that bounces forever, one flung off the screen by a flick.
const test = require('node:test');
const assert = require('node:assert');
const physics = require('../src/chrome/physics');

const BOUNDS = { floor: 800, left: 0, right: 1000 };
const DT = 1 / 60;

// Run a fall to rest and report what happened on the way.
function drop(f, bounds = BOUNDS, maxSteps = 2000) {
  let cur = Object.assign({ vx: 0, vy: 0 }, f);
  const impacts = [];
  for (let i = 0; i < maxSteps; i++) {
    const next = physics.step(cur, bounds, DT);
    if (next.impact > 0) impacts.push(next.impact);
    cur = next;
    if (next.done) return { rest: cur, impacts, steps: i + 1 };
  }
  return { rest: cur, impacts, steps: maxSteps, ranOut: true };
}

test('a dropped pet lands on the floor and stays there', () => {
  const r = drop({ x: 400, y: 100 });
  assert.ok(!r.ranOut, 'never came to rest');
  assert.equal(r.rest.y, BOUNDS.floor, 'came to rest somewhere other than the floor');
  assert.equal(r.rest.vy, 0);
});

test('it bounces, and each bounce is smaller than the last', () => {
  const r = drop({ x: 400, y: 100 });
  assert.ok(r.impacts.length >= 2, `only ${r.impacts.length} bounce(s) — that is a thud, not a bounce`);
  for (let i = 1; i < r.impacts.length; i++) {
    assert.ok(r.impacts[i] < r.impacts[i - 1], 'a bounce came back higher than it fell');
  }
});

test('a higher drop hits harder', () => {
  const soft = drop({ x: 0, y: BOUNDS.floor - 40 }).impacts[0];
  const hard = drop({ x: 0, y: BOUNDS.floor - 600 }).impacts[0];
  assert.ok(hard > soft * 2, `40px fall hit at ${soft}, 600px at ${hard}`);
});

test('it cannot be thrown off the screen', () => {
  for (const vx of [-9000, 9000]) {
    const r = drop({ x: 500, y: 200, vx });
    assert.ok(r.rest.x >= BOUNDS.left && r.rest.x <= BOUNDS.right, `came to rest at x=${r.rest.x}`);
  }
});

test('it never sinks below the floor, even at absurd speed', () => {
  let cur = { x: 400, y: 700, vx: 0, vy: 50000 };
  for (let i = 0; i < 50; i++) {
    cur = physics.step(cur, BOUNDS, DT);
    assert.ok(cur.y <= BOUNDS.floor, `sank to ${cur.y}`);
    if (cur.done) break;
  }
});

// ---------------------------------------------------------------- the throw
test('a flick carries; a slow carry does not', () => {
  const now = 10_000;
  const flick = physics.throwVelocity(
    [{ t: now - 40, dx: 20, dy: 0 }, { t: now - 20, dx: 22, dy: 0 }, { t: now - 5, dx: 24, dy: 0 }], now);
  assert.ok(flick.vx > 400, `a flick should carry, got ${flick.vx}`);

  const carry = physics.throwVelocity(
    [{ t: now - 110, dx: 1, dy: 0 }, { t: now - 60, dx: 1, dy: 0 }, { t: now - 10, dx: 1, dy: 0 }], now);
  assert.ok(Math.abs(carry.vx) < 80, `a slow carry should not throw, got ${carry.vx}`);
});

test('only the tail of the drag counts', () => {
  // Dragged hard left across the screen, then held still before letting go:
  // the release is a place-down, not a throw.
  const now = 10_000;
  const samples = [];
  for (let i = 0; i < 20; i++) samples.push({ t: now - 2000 + i * 50, dx: -30, dy: 0 });
  samples.push({ t: now - 10, dx: 0, dy: 0 });
  const v = physics.throwVelocity(samples, now);
  assert.ok(Math.abs(v.vx) < 200, `stale drag leaked into the throw: ${v.vx}`);
});

test('a couple of samples a few milliseconds apart cannot fling it', () => {
  // Without a floor on the timespan this divides by ~4ms and launches the pet
  // into the next county.
  const now = 10_000;
  const v = physics.throwVelocity([{ t: now - 4, dx: 12, dy: 0 }, { t: now - 2, dx: 12, dy: 0 }], now);
  assert.ok(Math.abs(v.vx) < 1200, `flung at ${v.vx} px/s`);
});

// ---------------------------------------------------------------- throw vs place
// The rule that keeps both promises: "drag it anywhere and it sticks" for a
// placement, and physics for a throw. Height must not enter into it — parking
// the pet at the top of the screen is the case this protects.
test('carrying it somewhere and letting go leaves it there, at any height', () => {
  for (const y of [0, 100, 400, BOUNDS.floor]) {
    assert.equal(physics.shouldFall({ x: 0, y, vx: 0, vy: 0 }), false, `fell from y=${y}`);
  }
  // a hand still drifting a little is still a placement
  assert.equal(physics.shouldFall({ x: 0, y: 60, vx: 40, vy: 25 }), false);
});

test('a throw gets gravity, in any direction', () => {
  assert.equal(physics.shouldFall({ x: 0, y: 400, vx: 900, vy: 0 }), true, 'thrown sideways');
  assert.equal(physics.shouldFall({ x: 0, y: 400, vx: 0, vy: 900 }), true, 'thrown down');
  assert.equal(physics.shouldFall({ x: 0, y: 400, vx: 0, vy: -900 }), true, 'thrown up');
  // …and the diagonal counts as a whole, not one axis at a time
  const d = physics.THROW_SPEED * 0.8;
  assert.equal(physics.shouldFall({ x: 0, y: 400, vx: d, vy: d }), true);
});

test('a real drag ends in a placement, a real flick in a throw', () => {
  // The two gestures end-to-end, through the same sampler main.js feeds.
  const now = 10_000;
  const carry = [];
  for (let i = 0; i < 12; i++) carry.push({ t: now - 600 + i * 50, dx: -3, dy: -2 });
  assert.equal(physics.shouldFall(physics.throwVelocity(carry, now)), false, 'a slow carry fell');

  // …and the case that actually bit: carrying the pet up to the top of the
  // screen at ORDINARY dragging speed and letting go without slowing down.
  // ~500 px/s, which is a repositioning, not a throw. [lesson: real bug]
  const brisk = [];
  for (let i = 0; i < 12; i++) brisk.push({ t: now - 550 + i * 50, dx: 0, dy: -25 });
  assert.equal(physics.shouldFall(physics.throwVelocity(brisk, now)), false,
    'a normal drag to the top of the screen fell back down');

  const flick = [{ t: now - 45, dx: 18, dy: 6 }, { t: now - 25, dx: 21, dy: 8 }, { t: now - 8, dx: 24, dy: 9 }];
  assert.equal(physics.shouldFall(physics.throwVelocity(flick, now)), true, 'a flick just sat there');
});

test('pausing before you let go is always a placement, however fast you were', () => {
  // The other half of the gesture: the hand stops to aim, then releases. With
  // nothing in the sampling window there is no velocity to inherit.
  const now = 10_000;
  const fastThenStill = [{ t: now - 400, dx: 60, dy: 0 }, { t: now - 380, dx: 60, dy: 0 }];
  assert.equal(physics.shouldFall(physics.throwVelocity(fastThenStill, now)), false);
});

test('thrown up, it comes back down rather than leaving the screen', () => {
  const bounds = Object.assign({ ceiling: 0 }, BOUNDS);
  const r = drop({ x: 400, y: 300, vx: 0, vy: -2500 }, bounds);
  assert.ok(!r.ranOut, 'never came to rest');
  assert.equal(r.rest.y, bounds.floor);
  let cur = { x: 400, y: 300, vx: 0, vy: -9000 }, top = 300;
  for (let i = 0; i < 400 && !cur.done; i++) { cur = physics.step(cur, bounds, DT); top = Math.min(top, cur.y); }
  assert.ok(top >= bounds.ceiling, `sailed to ${top}, above the ceiling at ${bounds.ceiling}`);
});
