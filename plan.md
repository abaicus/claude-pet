# gogu — Build Plan (from zero)

A desktop tamagotchi that floats above all windows and feeds on Claude Code
activity. It is a critter, not an app: no dock icon, no window chrome. It
observes coding sessions and reacts — it never interferes with them. Beneath
the toy layer it carries two genuinely useful features: it taps you on the
shoulder when Claude is blocked waiting on you, and it surfaces live
context-usage telemetry per session.

This plan is greenfield but encodes hard-won lessons from a previous build.
Anything marked **[lesson]** was paid for — do not relitigate it without a
reason.

---

## Two hard rules (non-negotiable, apply to every milestone)

1. **The pet observes; it never blocks.** Nothing the pet does may slow,
   block, or fail a Claude Code session. Hook-side capture is fire-and-forget
   (exit 0 always, no network, no waiting on the app). Events queue while the
   app is closed and replay on next launch.
2. **The pet never lies.** It only reports what it can measure. Estimates are
   labeled with `~`. Data it cannot read (Claude plan/usage quotas) is absent,
   never faked or guessed. **[lesson]**

---

## Architecture

Three strictly separated layers. The test of the boundary: deleting the
renderer entirely must leave the brain fully functional. **[lesson: previous
build tangled these; every art rework was expensive because of it]**

### 1. Capture (outside the app)
- Claude Code hooks: SessionStart, SessionEnd/Stop, UserPromptSubmit,
  PreToolUse, PostToolUse, Notification, SubagentStop, PreCompact.
- Each hook appends one JSON line to `~/.gogu/events.jsonl`.
  File transport only — no server, no ports, no sockets. **[lesson]**
- Payloads stay tiny (a few hundred bytes): event type, session id, project
  path, timestamp, tool name, command text / output tail. File contents never
  ride along.
- The app self-installs hooks on launch: idempotent, preserves all existing
  user settings, refuses to touch a config it can't parse, and can cleanly
  uninstall exactly its own entries and nothing else.

### 2. Brain (main process)
- Tails `events.jsonl` (chokidar or fs.watch with a byte-offset cursor;
  cursor persists so closed-app events replay on launch).
- Owns all state: stats, xp/level, streaks, milestones, session registry.
- Reads Claude Code session transcripts incrementally (app-side only, never
  in hooks) for session awareness — see below.
- Persists state as versioned JSON (`schemaVersion` field, migration
  function per bump). Human-readable on purpose; players may cheat.
- Emits a single `state` object to the renderer. The renderer never computes
  game logic.

### 3. Body (renderer)
- Frameless, transparent, always-on-top window. Contract with brain is dumb:
  `render(state)` where state includes form, palette, accessory, mood band,
  active animation, bubble text, stats-line fields. If that is the whole
  interface, future art reworks are cheap. **[lesson]**
- Settings is a separate small window that acts purely as a remote control:
  it displays the brain's actual state and sends commands. The brain enforces
  all rules (e.g. accessory level locks), not the UI. **[lesson]**

Tech: Electron, zero runtime dependencies beyond it if practical. All assets
(art, sounds, tray icon) generated in code — no bundled sprite/audio files.

---

## Milestones

Each milestone ships independently and has acceptance criteria. Work in
order; do not start a milestone until the previous one's criteria pass.

### M0 — Skeleton & transport
- Electron app with frameless transparent always-on-top window showing a
  placeholder shape; draggable; position persists; tray icon with Quit.
- Hook installer/uninstaller working against a real `~/.claude/settings.json`
  (idempotent, config-preserving, parse-failure-safe).
- Hook script appends events; app tails the log; events fired while the app
  is closed appear on next launch.
- **Accept:** run a real Claude Code session; every event type lands in the
  app's log view; killing the app mid-session loses nothing; uninstall leaves
  the settings file byte-identical except for the pet's own entries.

### M1 — Brain: stats, leveling, reactions
- Stats: food (uncapped — an overfed pet is the point), energy 0–100
  (drains per tool call, recovers when idle), mood 0–100, xp, lifetime
  commits, green-test streak, lifetime output tokens.
- 11 levels (0–10), xp ladder: 0, 50, 120, 250, 450, 700, 1000, 1500, 2200,
  3000, 4200. Five forms on top: egg (lv0) → hatchling (lv1) → junior (lv3)
  → senior (lv6) → elder (lv9).
- Event → reaction mapping (full table in Appendix A), including semantic
  bash parsing: commit, test runners (~6 formats, green/red with counts),
  PR create/merge, deploy, push, merge/rebase, installs, branch, stash,
  `rm -rf`, builds. First match wins. **[lesson: reacting to what a command
  MEANS is where the personality lives]**
- Combo/milestone system: rolling 2-min edit combos (8th, 20th), every 10th
  lifetime commit, 5 straight green runs, every million output tokens.
- Passive: food decays ~1.2/min; loneliness after 30 idle min; sleep
  requires low energy AND ≥1 min of event silence — never doze mid-work.
  **[lesson]**
- **Accept:** unit tests drive synthetic event streams through the brain and
  assert stats/level/streak outcomes; a replayed real-day log produces sane
  numbers.

### M2 — Session awareness & the stats line
The utility pillar. App-side transcript reading only.

- Session registry: which sessions are live, project name, per-session
  context fullness % (input + cache tokens against an assumed 200k window,
  labeled `~`). Exclude subagent/sidechain usage — it makes the readout
  bounce. **[lesson]**
- One-shot warnings at ~75% and ~90% ("/compact soon!"), re-armed only when
  that session drops back below 60%.
- Rolling 5-hour output-token burn figure; periodic report every 10 min once
  any session passes 40%.
- **Stats line (redesigned — real telemetry, not game fiction):**
  - Active: `name lv.N │ 2 sessions │ ctx ~72% │ 41k/5h`
    (`ctx` = worst live session; append streak chip `✓×5` only when nonzero)
  - Per-session strip above it when >1 session live: busiest first, top 3 +
    "+N".
  - Idle (no live sessions): collapse to `name lv.N` or hide entirely.
  - Food/energy/mood are NOT in the line — they are expressed through the
    pet's body language and quips only. Real numbers in text; fiction in
    behavior. **[design decision, deliberate]**
- **Accept:** two parallel real sessions show correct per-session strip and
  worst-ctx figure; warnings fire once each and re-arm correctly; line
  collapses when idle.

### M3 — Notification relay (the headline trick)
- Claude Notification events (waiting on permission / input) relay the
  actual message as an important bubble + attention animation + chime.
- Important notices bypass the quip/bubble mute toggle. This feature must
  survive every future refactor. **[lesson: this is why people keep it
  installed]**
- **Accept:** trigger a permission prompt in a background session; the pet
  visibly and audibly flags it even with quips muted and sounds at default.

### M4 — Art & animation
Direction: decided BEFORE any rendering code. Produce static mockups of all
five forms + 3–4 accessories, view them at real size on a real desktop
wallpaper (light and dark), get explicit approval, then build. **[lesson:
three previous art directions were built first and rejected on sight]**

Constraints that survive any medium:
- Each form is a genuinely different silhouette — bigger/taller/marking
  changes — never a recolor. **[lesson]**
- The face is sacred: nothing covers it. No goggles, no forced headwear.
  **[lesson]**
- Accessories sit off the face; wings sweep away from the body (hugging
  reads as earmuffs). **[lesson]**
- Eyes follow the cursor horizontally only — vertical tracking broke the
  face. **[lesson]** Idle glances when the cursor is far. Blink/sleep/sad
  states override tracking.
- Glow = rim light hugging the sprite + small ground shadow. No big radial
  cloud behind the body — it smears gray on dark wallpapers. **[lesson]**
- Eggs (lv0) don't walk, wear nothing, ignore palettes.
- Animations: idle breathe, blink, eat/nibble, party (small: level-up;
  big: evolve/deploy), sulk, sleep + Zzz, wake/stretch, attention jump
  (notification), walk cycle with facing.
- Wandering: after ~3 idle min the pet may stroll and always returns home;
  any grab, menu, settings-open, or click-through toggle aborts the stroll.
- **Accept:** the mockup approval gate, then: all forms/accessories render
  at all sizes on light + dark wallpapers; every animation reachable via a
  debug menu.

### M5 — Interactivity, sound, settings
- Petting: short still left-click → hearts + mood; xp rate-limited (not
  farmable). ~45% of pets share a REAL session fact instead of a quip
  (tune upward if it feels good). **[design decision: bridges toy and
  utility]**
- Treats: double-click = cookie (food/mood/xp), 5-min cooldown, else a
  "not hungry" quip.
- Dragging anywhere; position persists separately from pet state.
- Sound: synthesized chiptune square-wave motifs (Web Audio, no files), all
  short, throttled on high-frequency events, **off by default**, per-event
  variety, volume slider.
- Quips: small phrase pool per event, random pick; quiet tools (reads,
  fetches, subagents, MCP, todo writes) whisper at deliberately low
  probabilities — spam kills the charm. **[lesson]** Unprompted gossip
  ~every 2.5 min at 35% odds, only while events are recent: session facts,
  burn, commits, streak, xp-to-next.
- Settings window:
  - Name (12 chars, shown in stats line).
  - Palette: 12 four-color ramps; one color per form so evolution reads as
    growth in any palette.
  - Accessory: exactly one equipped; 12 wearables unlocked by level —
    bow + sprout (lv1), flower + scarf (lv2), beret (lv3), headphones (lv4),
    crown (lv5), wings (lv6), halo (lv7), wizard hat (lv8), balloon (lv9),
    sparkles (lv10). Locks enforced by the brain. Tiny fanfare on equip.
  - Toggles: speech bubbles, stats line, glow. Size slider (scales about the
    feet; persists).
  - Danger zone: reset to lv0 — wipes progression (xp, food, energy, mood,
    commits, streaks, tokens, accessory) behind arm → "sure?" → "REALLY
    sure?" with 4s auto-disarm. Customization, sound settings, and — critically
    — the event-log read cursor survive the reset, otherwise replaying the
    old log refeeds the newborn instantly. **[lesson: real bug]**
- **Accept:** settings changes apply instantly and round-trip through the
  brain; reset preserves cursor + customization; a locked accessory cannot
  be equipped even via a forged IPC message.

### M6 — Chrome & lifecycle polish
- Tray icon (template image, auto light/dark) and right-click menu share one
  lean menu: Settings…, click-through toggle, reinstall/uninstall hooks,
  quit. Nothing else — everything else lives in settings.
- Click-through mode (`setIgnoreMouseEvents` with forwarding) makes the pet
  unclickable. Escape hatch = global shortcut + tray item, both of which
  must ALWAYS work — an unclickable window cannot offer its own way back.
  **[lesson]**
- Speech bubble sits above the head and grows upward, never covering the
  pet.
- Visible on every workspace/space. Quit + relaunch loses nothing: state,
  position, scale, queued events.
- **Accept:** enable click-through, verify the shortcut and tray both
  recover it; full quit/relaunch round-trip with a session running.

### Deferred (explicitly out of scope for now)
- Packaging / launch-at-login (do first when the time comes).
- Team mode (share stats to a wall page).

---

## Non-goals
- No local server; no network calls anywhere in the capture path.
- No bundled asset files — art, sounds, tray icon all generated in code.
- No faking unreadable data (usage quotas especially).
- No character roster beyond the one blob without a fresh art direction.

---

## Appendix A — Event → reaction table

| Event | Effect | Expression |
|---|---|---|
| UserPromptSubmit | food +6 | nibble; occasional quip ("mm, fresh prompt"); chonk quips past food 150; starving quips under 10 |
| Edit/Write tool | food +4, xp | eat; feeds edit-combo streak (8th / 20th in rolling 2-min gaps = combo party) |
| Bash: `git commit` | food +10, mood +15, xp +25 | party; every 10th lifetime commit = milestone fanfare |
| Bash: tests green | xp +20, streak++ | party, "27 tests green ✓"; 5 straight = milestone |
| Bash: tests red | mood −10, streak reset | sulk, "3 tests red..." |
| Bash: PR create/merge | xp | party |
| Bash: deploy | xp | big party 🚀 |
| Bash: push / merge / rebase / install / new branch / stash / build | small xp | per-command quip + sound |
| Bash: `rm -rf` | — | flinch, "😱 careful" |
| Quiet tools (Read, WebFetch, subagents, TodoWrite, MCP) | — | rare whispers, low probability |
| Tool failure | mood −8 | sulk, sweat drop |
| Notification | — | **important bubble with actual message + chime + attention jump; bypasses mute** |
| SessionStart | — | wake + greet |
| SessionEnd/Stop | energy +20 | occasional goodbye wave |
| PreCompact | — | "compacting memories..." |
| 30 min idle | mood drift | loneliness |
| Low energy + 1 min quiet | — | sleep, Zzz |

Bash matching is first-match-wins down a priority list; parse test output
across ~6 common runner formats for pass/fail counts.

## Appendix B — Suggested repo layout

```
gogu/
  src/
    capture/    hook script (standalone, zero deps), installer/uninstaller
    brain/      state, reducer (event → state), sessions/, persistence,
                bash-parser, combos, gossip
    body/       pet window renderer, animations, bubble, stats line, sounds
    settings/   settings window (remote control only)
    shared/     event + state types, IPC channel names
  test/         brain reducer tests driven by synthetic event streams,
                recorded real-day logs as fixtures
```

The brain must be testable headlessly (no Electron import in `brain/`).
