'use strict';
// The fall, as arithmetic.
//
// main.js owns the window and the timer; this owns where the pet is a
// sixteenth of a second from now. Same split as the brain: the part with
// rules in it must be testable without an Electron window to drop.

const GRAVITY = 2800;      // px/s² — brisk; a floaty pet reads as a balloon
const BOUNCE = 0.42;       // …of the impact speed kept, per bounce
const WALL = 0.55;         // …and off the sides, and off the ceiling
const AIR = 0.86;          // sideways speed kept per second in flight
const SETTLE_SPEED = 200;  // a bounce slower than this is not worth playing
const THROW_WINDOW_MS = 120;

// The line between putting the pet down and throwing it, in px/s.
//
// Height is deliberately NOT part of this. "Drag it anywhere; the position
// sticks" is the older promise and the more important one — somebody parking
// their pet at the top of the screen beside their editor must be able to, and
// a pet that slides to the floor every time you let go of it has taken that
// away. So gravity only ever applies to something you THREW: carry it and set
// it down and it stays exactly where your hand left it, at any height.
//
// The number is high on purpose. Ordinary dragging runs at 400–700 px/s and
// people often release while still moving at that speed, so anything lower
// turns a repositioning into a drop; a deliberate flick is 1500–3000 px/s and
// clears this easily. The two mistakes are not equal — failing to throw costs
// you a second flick, failing to place loses the spot you were aiming at.
const THROW_SPEED = 800;

/**
 * How fast it was moving when the hand let go, in px/s.
 *
 * Only the tail of the drag counts: where the hand was a second ago says
 * nothing about where it was going at the moment of release, and averaging the
 * whole drag makes a flick indistinguishable from a slow carry.
 *
 * @param {Array<{t:number,dx:number,dy:number}>} samples in chronological order
 * @param {number} now
 */
function throwVelocity(samples, now) {
  const recent = (samples || []).filter(s => now - s.t < THROW_WINDOW_MS);
  if (recent.length < 2) return { vx: 0, vy: 0 };
  // A floor on the span: three samples 4ms apart would otherwise report a
  // velocity in the thousands and fling the pet off the screen.
  const span = Math.max(32, now - recent[0].t);
  const sum = recent.reduce((a, s) => ({ dx: a.dx + s.dx, dy: a.dy + s.dy }), { dx: 0, dy: 0 });
  return { vx: sum.dx * 1000 / span, vy: sum.dy * 1000 / span };
}

/**
 * One step of the fall.
 *
 * @param {{x,y,vx,vy}} f        position (window top-left) and velocity
 * @param {{floor,left,right,ceiling}} bounds  where it may not pass
 * @param {number} dt            seconds
 * @returns {{x,y,vx,vy,impact,done}} `impact` is the landing speed of a bounce
 *          that happened THIS step (0 while airborne), so the caller knows
 *          both that it landed and how hard. `done` means it has come to rest.
 */
function step(f, bounds, dt) {
  let { x, y, vx, vy } = f;
  vy += GRAVITY * dt;
  vx *= Math.pow(AIR, dt);
  x += vx * dt;
  y += vy * dt;

  if (x < bounds.left) { x = bounds.left; vx = -vx * WALL; }
  if (x > bounds.right) { x = bounds.right; vx = -vx * WALL; }
  // Thrown up hard enough and it bonks off the top of the screen rather than
  // sailing out of it. `ceiling` is optional; without one it just flies.
  if (bounds.ceiling !== undefined && y < bounds.ceiling) {
    y = bounds.ceiling;
    vy = Math.abs(vy) * WALL;
  }

  let impact = 0, done = false;
  if (y >= bounds.floor) {
    y = bounds.floor;
    impact = vy;
    vy = -vy * BOUNCE;
    vx *= 0.7;                       // friction with the floor
    if (-vy < SETTLE_SPEED) { vy = 0; done = true; }
  }
  return { x, y, vx, vy, impact, done };
}

/**
 * Whether letting go here is a throw (physics) or a placement (stay put).
 *
 * Speed alone decides — see THROW_SPEED. Note that this reads the RAW release
 * velocity including an upward one: flicking the pet up at the ceiling is
 * every bit as much a throw as dropping it.
 */
function shouldFall(f) {
  return Math.hypot(f.vx || 0, f.vy || 0) >= THROW_SPEED;
}

module.exports = { step, throwVelocity, shouldFall, GRAVITY, BOUNCE, WALL, SETTLE_SPEED, THROW_SPEED };
