# claude-pet — project brief

A standalone desktop tamagotchi (Electron) that floats above all windows and
feeds on Claude Code activity via hooks. This scaffold is working but early —
your job is to take it from prototype to polished hackathon demo.

## Architecture (do not break these invariants)

```
Claude Code session(s)
   │  hooks: node ~/.claude-pet/pet-hook.js   (fire-and-forget)
   ▼
~/.claude-pet/events.jsonl    ◄── parallel sessions all feed the same pet
   │  tailed every 500ms by the app, byte offset persisted in state.json
   ▼
Electron app — transparent, frameless, always-on-top, draggable
```

**Invariants:**
1. Hooks ALWAYS exit 0 and must be fast. The pet observes; it never blocks a
   tool call. Do not add blocking logic, network calls, or exit code 2 to the
   hook script.
2. The app self-installs on launch (`installHooks()` in `main.js`): writes
   `pet-hook.js`, merges entries into `~/.claude/settings.json`. The merge
   must stay: idempotent, backup-before-write, preserve all user hooks and
   settings keys, and REFUSE to write if settings.json is invalid JSON.
   `uninstallHooks()` must remove only our entries (identified by
   "pet-hook.js" in the command string).
3. File-based transport (events.jsonl), not a local server — hooks must never
   fail when the app is closed, and queued events replay on next launch.
   Truncation is handled (offset resets); keep it that way.

## Files

- `app/main.js` — window setup + placement, self-installer, node resolution,
  tray icon, and the one menu template shared by the tray and the right-click
- `app/index.html` — everything renderer: pixel pet on canvas (16×16 grid,
  procedural, 4fps on purpose), event tailing, state machine, speech bubble
- `app/test/verify.js` — sandbox suite, `npm test`. Runs against a throwaway
  `$HOME`, so it can never touch your real settings.json. It lifts the
  test-parsing block straight out of index.html so it exercises shipped source.
- `app/package.json` — electron only, `npm start`
- Hook script source lives as the `HOOK_SOURCE` string in main.js and is
  written to `~/.claude-pet/pet-hook.js` on every launch (so upgrades ship
  with the app)

## What's verified

`npm test` — 52 checks, all green:

- Installer: idempotent double-install, preserves user hooks/groups/matchers
  and unrelated settings keys, backs up, refuses invalid JSON leaving the file
  untouched, and **repairs its own stale entries** when the node path moves
- Uninstall removes only claude-pet entries and never rewrites an event it
  doesn't appear in
- Hook script: compact record out (now incl. `transcript_path`), exits 0 on
  malformed/empty stdin, <1s, appends one line per event, never leaks file
  contents into the log
- Test-run detection across ~25 command forms and 6 runner output formats
- Session awareness: transcript usage-line parsing (context = input + both
  cache buckets), torn-line/junk rejection, session start/end/resume
  tracking, token formatting — lifted from index.html like the test parser
- Customization tables: every palette a 4-ramp of valid hex, accessory locks
  reachable, IPC wiring present in all three sources, bubble bottom-anchored
- Characters: all five present with hatchling/junior/senior stages, every grid
  a well-formed 16×16 of known pixels, and **eyes/mouth land on the body for
  every stage at every ±1 tracking offset** (a per-stage geometry slip is
  exactly how eye tracking died silently once). Horns-regression: no
  `st.name === "senior"` special-case draw may reappear in render()
- Sounds: every action key present, each motif sane [freq, dur] pairs
- New hook events registered (Notification/SubagentStop/PreCompact), the
  Notification `message` carried through the hook, and the untouched-event
  test now uses PreToolUse (the one event we deliberately don't register)

Verified by actually running it on macOS (screenshots via `CLAUDE_PET_SHOT`):

- Electron launch, transparency, rendering, evolution + wizard hat
- Every stage's distinct look (small hatchling, senior ears, wizard hat),
  palettes, accessories incl. level locks in the settings UI, the rim glow,
  the above-head bubble, and the settings window itself — screenshot- and
  GIF-verified
- Click-to-pet fired from a real physical mouse click ("more pets pls")
- Hooks fire live from a real Claude Code session with the absolute node path
- Queued-while-closed events replay on launch, then the log rotates to 0 bytes
- A half-written line is left pending instead of being parsed or skipped

## What's NOT verified (needs a real machine / a human)

- Always-on-top over fullscreen apps, and the click-through toggle — both need
  a human at the keyboard. (Dragging is now verified: a synthetic mouseDown
  starts a real drag, and the window tracks the OS cursor 1:1 with no drift.)
- Whether the level-up sound is audible (the code path runs without error)
- A full idle wander cycle (trigger is random after 3 min idle; the motion
  path is the same setPosition-on-a-timer machinery the verified drag uses)
- The settings→pet direction of the settings IPC under a human hand (the
  pet→settings direction is screenshot-proven: the page rendered the pet's
  real name/palette/locks)
- Windows: `node "path"` quoting in the hook command, hook execution shell.
  `resolveNode()` falls back to bare `node` there — no login-shell probe.

## Pet mechanics (current)

- **Petting**: a left-click that moves <5px and lasts <350ms is a pet, not a
  drag (the drag machinery still runs — a stationary cursor moves nothing).
  Hearts + mood; xp/mood gain rate-limited to one per 2.5s so it can't be
  farmed. 45% of pets make it share a session fact instead of a quip.
- **Treats**: double-click = cookie (hunger −12, mood +6, xp 2) on a 5-min
  cooldown, else a "not hungry" quip. Real work stays the main food source.
- **Eyes follow the cursor**: main polls the OS cursor (renderer can't see
  outside the window), quantizes, and sends only on change; pupils shift ±1
  **horizontally only** — vertical shift dragged the eyes toward the mouth
  and made the face fall apart. The eye format is sacred: 2px tall, 1px on
  blink, ALL stages, and every stage tracks (a per-stage tracking exception
  once silently killed the feature for the very pet the user was looking
  at). Idle glances when nobody's near. Blink/sleep/sad eyes unaffected.
- **Wandering**: after 3+ min idle (awake, lv>0), the renderer may request a
  stroll; main walks the window in 4px/120ms steps and always returns home so
  window.json stays honest. Aborted by grabbing the pet, the menu, settings,
  or click-through. Feet + facing render at 4fps.
- **Session awareness**: the hook adds `transcript_path` (a path, ~100 bytes
  — invariant 1 intact); the APP tails transcripts incrementally (per-file
  offset, starts at last 64KB, dedups by message id since one API response
  spans several lines with the same usage, and **skips `isSidechain` lines**
  — subagent usage in the same transcript made the context readout bounce).
  Knows: active sessions + project names, context fullness (input + both
  cache buckets, /200k assumed — labels say "~"), model, rolling 5h
  output-token burn. Context is ALWAYS visible: 🧠% of the busiest live
  session in the stats line (`busyCtx()`), plus a periodic report every
  10min once ctx ≥40% ("🧠 ~62% ctx in proj · ~1.2M out/5h"), plus one-shot
  warnings at ~75% and ~90% ("/compact soon!"), re-armed below 60%.
  Unprompted gossip every ~2.5min at 35% odds, only while events are recent.
  **/usage plan limits are NOT readable**: that data lives behind an
  authenticated API call inside Claude Code, not on disk. Don't fake it —
  the pet only reports what the transcript proves.
- PostToolUse Edit/Write → eat animation, hunger −8, xp
- Bash containing "git commit" → party, hunger −20, mood +15, xp +25
- Green test run → party, xp +20, mood +15, "27 tests green ✓"
- Red test run → sulk, mood −10, "3 tests red..."
- Other PostToolUseFailure → sulk, mood −8
- SessionStart → wake + greet; Stop → small xp; SessionEnd → energy +20
- More Bash flavor: `git push` → party "pushed to the cloud ☁" (+10 xp),
  npm/pnpm/yarn/bun install → eat + deps quip, `git checkout -b` → branch quip
- Quieter tools whisper occasionally: WebSearch/WebFetch (20%), Task (35%),
  Read/Grep/Glob (6%) — probabilities deliberately low, spam kills the charm
- **Notification** → the pet relays the actual message ("☝ Claude needs your
  permission to use Bash") as an important bubble + notify chime. This is the
  headline trick: the pet taps you on the shoulder when Claude is blocked.
- PreCompact → "compacting memories..."; SubagentStop → +3 xp, minion quip 30%
- Passive: hunger creeps up, energy recovers when idle, lonely after 30 min
- Energy drains −1/tool call and recovers +2.5/20s once you've been idle a
  minute (+0.3 otherwise). **Sleep needs low energy AND a minute of quiet** —
  gating on energy alone made the pet doze through every busy session, which
  is precisely when it should be lively.
- **Characters** (`S.custom.character`): blob, cat, gerbil, dog, ghost, frog,
  penguin. All hatch from the SAME egg and evolve through the same xp ladder;
  each character × stage is its own 16×16 grid + face layout in the
  `CHARACTERS` table (grid letters: `.` empty, `D` outline, `B` body/palette,
  `W` white patch; char-level extras: `mouthColor` = orange beak, `feetColor`
  = orange feet, `bill` = wide flat idle mouth). The wizard stage reuses the
  senior grid — the hat marks it, anchored to each layout's `top`/`cx`. A
  saved character that no longer exists falls back to blob on load.
  **The goose was tried and removed** ("looks bad" — user): a long neck needs
  more pixels than 16 give it. Stick to shapes that read at 16×16 — round
  bodies, ears, bellies, wavy hems. Two hard-won face rules: eyes must not
  hang off a dark crown-bridge row (they merge with it and vanish — give
  them a body-color row above), and eyes inside small silhouette bumps just
  fill the bump with dark (the frog's eyes live on its face, bumps stay
  empty).
- Evolution by xp: egg(0) → hatchling(50) → junior(250) → senior(1000) →
  wizard(3000). Each stage LOOKS different, not recolored — bigger body,
  longer ears, taller neck. Stage markers stay OFF the face and IN the
  silhouette: senior goggles wrecked the eyes, and the blob's dark senior
  ear-nubs read as "horns, wtf" (user). Identity lives in the character now;
  the blob just gets taller. Add stages/characters in `CHARACTERS`, never
  with magic row numbers in render(). The geometry test enforces eyes/mouth
  on-body for every stage at every tracking offset.
- Customization (persisted in `S.custom` in state.json): name (stats line),
  character, palette (6 × 4-color ramps, one color per stage 1-4 so evolution
  still reads as growth; egg ignores it), accessory (bow lv1 / sprout lv2 /
  scarf lv3 — gates enforced in the renderer, not just greyed in the UI),
  bubble/stats/glow visibility, sound volume (0 = mute, 60 ≈ old fixed level)
- Sounds for ALL actions: level-up/commit/green/red plus eat (throttled to
  one blip per 8s — edits arrive in bursts), pet, treat, wake, sleep (fires
  once on the doze-off transition, tracked via lastMode in render), sad,
  notify, warn, gossip, transform. Synthesized square waves, **off by
  default**, toggled from settings, persisted in state.json. Keep new sounds
  SHORT and throttle anything tied to a high-frequency event.
- State + event-log byte offset persist in `~/.claude-pet/state.json`
- Window position and scale persist in `~/.claude-pet/window.json`, kept
  separate on purpose: the renderer writes state.json constantly, so a second
  writer would race it. main owns window.json, the renderer owns state.json.

## Window chrome

- **Dragging is done in JS, not with `-webkit-app-region: drag`.** Do not put
  that property back. Every element in the window is absolutely positioned, so
  the body it attaches to is a zero-height box — the region has no area and the
  pet cannot be picked up at all. (It never could; drag was listed as unverified
  from the start.) `#pet` is also transformed now, which app-region handles
  poorly. The renderer sends `pet-drag-start`/`pet-drag-end`; main follows the
  OS cursor on a 16ms timer. A regression test guards this.
- Drag position is **absolute** (`cursor − grab offset`), never accumulated
  deltas. Accumulating drifts badly: the window slides out from under the
  cursor as it moves, so each move feeds the next. Measured ~1.7× overshoot
  before the fix.
- One `menuTemplate()` feeds both the tray and the right-click menu — add
  items there, not in two places. Labels go stale, so `refreshMenus()`
  rebuilds rather than reusing. The menu is deliberately LEAN (Settings…,
  click-through, hooks, quit): sounds, size, and reset live in the settings
  window. Keep click-through in the menu — it must be reachable when the
  settings window is the thing you can't click.
- The tray icon is drawn into a BGRA bitmap from `TRAY_MASK` at 2x and marked
  a template image, so macOS recolors it for light/dark. No icon file to ship.
- The size slider is in the **settings window** (the old in-window overlay is
  gone — a separate window dodges every "slider scales with the thing it
  scales" problem it had). The page sends `pet-scale`; main resizes and tells
  the pet renderer via `pet-scale-set`. `#pet` is a fixed 220×280 box anchored
  to the window's bottom centre and scaled about that origin, so it fills the
  resized window exactly.
- Resizing preserves centre-x and the bottom edge — the pet grows from its
  feet and doesn't lurch across the screen.
- `win.setResizable(true)` is flipped on around the programmatic resize —
  some platforms ignore `setBounds` on a non-resizable window.
- **Settings window** (`settings.html`): separate frameless always-on-top
  window, opened from the shared menu. The pet renderer stays the ONLY writer
  of state.json — the page is a remote control: pet broadcasts `pet-state`
  (sound, level, custom, palettes, accessory locks — self-describing so the
  page duplicates no data), page sends `custom-set` patches, main relays as
  `pet-custom-set`, pet validates (lock gates, palette existence, name cap),
  applies, saves, and echoes. Its title bar CAN use `-webkit-app-region:
  drag` — unlike the pet window it has normal-flow elements with height.
- The speech bubble is **bottom-anchored just above the head** (bottom:
  212px, clearing the wizard-hat zone) so long messages grow UPWARD, never
  down over the pet. History: top:6px floated it in empty sky; bottom:20px
  sat it on the pet's feet with "too little distance" — this position tracks
  the head. The bottom-anchor (not top) is what the regression test checks.
- The glow is a **rim light on the canvas** (`body.glow #stage` drop-shadow,
  hugging the sprite silhouette) plus a small `#ground` ellipse shadow under
  the feet. A big radial cloud behind the body was tried first — it smears
  gray over dark wallpapers ("sucks ass" — the user). Toggleable in settings
  (`showGlow`).

## Roadmap

Done: 1–4, plus (unnumbered): interactivity (petting/treats/eyes/wander),
customization + settings window, session awareness/context warnings, visual
evolution ladder, glow, bubble reposition, characters (cat/gerbil/dog/ghost/frog/penguin),
sounds for all actions, always-visible context readout (sidechain-free), Notification/PreCompact/SubagentStop reactions.

1. ~~Run it, fix anything platform-specific~~ — see "Platform notes" below
2. ~~Test-run awareness~~ — `isTestCmd`/`parseTests` in index.html
3. ~~events.jsonl rotation~~ — on launch, and again past 512 KB. Only ever
   truncates when the on-disk size equals our consumed offset, so a parallel
   session's events can't be eaten.
4. ~~Sound effects on level-up~~ — Web Audio, no asset files
5. Better sprites: replace procedural `drawGrid` with spritesheets, keep the
   chunky low-fps feel. Note `drawGrid` and every helper now draw through
   `px()`, which applies a `TOP` row offset — keep that if you swap it out.
6. Team mode for the demo: SessionEnd POSTs stats to a shared endpoint, plus
   a simple wall page rendering everyone's pets
7. Package with electron-builder; optional launch-at-login

## Platform notes (learned the hard way)

- **Bare `node` is not good enough in the hook command.** Hooks run via
  `sh -c` with Claude Code's environment; under nvm/fnm/volta, or when Claude
  Code is launched from Spotlight/Dock, `node` isn't on that PATH and the hook
  fails silently — the pet just never eats. `resolveNode()` probes a login
  shell and bakes an absolute path in. Install repairs it if node later moves.
- **`PostToolUseFailure` is real** and now registered (it was missing from
  `HOOK_EVENTS` while the renderer already handled it). Tool events take a
  `matcher`; non-tool events must not have one. Also registered: Notification
  (its `message` rides along in the hook record — the pet's cue to wave),
  SubagentStop, PreCompact. PreToolUse is deliberately NOT registered (it
  would double event volume for nothing) — tests use it as the untouched
  user event.
- Hooks are installed with `"async": true` — Claude Code doesn't wait on them
  at all. This is invariant 1 enforced at the config level; keep it.
- The hook trims payloads before writing. Full `tool_response` bodies made the
  log grow ~14 KB per event; records are now a few hundred bytes.
- Rendering gotchas already paid for: an abspos bubble at `left:50%` needs
  `width:max-content` or it shrinks to the window edge and clips; the canvas
  needs `TOP` headroom or the bob clips the wizard hat off the top. TOP is
  now **6** (canvas 160×220): tall characters crown at grid row 0, the hat
  wants 4 rows above that, and the party bob 2 more. Don't shrink it.

## Dev helpers

- `npm test` — sandbox suite, safe to run anywhere
- `CLAUDE_PET_SHOT=/tmp/pet.png npm start` — renders, screenshots the window,
  exits. `CLAUDE_PET_SHOT_DELAY` (ms) controls when, `CLAUDE_PET_SHOT_SETTINGS=1`
  opens and captures the settings window instead, `CLAUDE_PET_SHOT_FRAMES=64`
  snaps a burst (`shot-000.png`…) every `CLAUDE_PET_SHOT_EVERY` ms (default
  250 = the render tick) — pipe through
  `ffmpeg -framerate 4 -i shot-%03d.png … out.gif` for a reaction reel. Set
  `HOME` to a temp dir to drive a throwaway pet with hand-written
  events.jsonl / state.json / window.json fixtures — a state.json with
  `{"xp":1500,"custom":{...}}` stages any evolution/palette/accessory combo,
  and appending to events.jsonl mid-burst scripts a story (wake → eat →
  commit → tests) into the recording.
- `CLAUDE_PET_SCALE=1.4 npm start` — start at a given scale, and exercise the
  real resize + persist path.
- `CLAUDE_PET_NODE=/path/to/node` — override interpreter resolution.

## Style notes

- Keep it a critter, not an app: no dock icon, no window chrome, tiny
  footprint
- Deliberately retro: 4fps stepping, pixel speech bubble, kaomoji energy
- Zero runtime dependencies beyond Electron; hook script is plain Node
