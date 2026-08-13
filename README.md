# claude-pet 🐾

A standalone tamagotchi that floats above all your windows and feeds on your
Claude Code activity. **Run the app once and it wires itself up** — no manual
settings editing.

## Run

```bash
cd app
npm install
npm start
```

That's it. On launch the app:

1. Writes the hook emitter to `~/.claude-pet/pet-hook.js` (rewritten every
   launch, so upgrades propagate).
2. Safely merges hook entries into `~/.claude/settings.json`:
   - existing hooks and settings are preserved
   - a backup is saved to `settings.json.pet-backup` before any write
   - install is idempotent — running twice adds nothing
   - if your settings.json isn't valid JSON, it **refuses to touch it** and
     tells you instead
3. Shows the pet, top-right, above everything.

Start (or restart) a Claude Code session and the pet starts eating.

## Architecture

```
Claude Code session(s)
   │  hooks: node ~/.claude-pet/pet-hook.js   (fire-and-forget, exit 0)
   ▼
~/.claude-pet/events.jsonl    ◄── parallel sessions all feed the same pet
   │  tailed every 500ms, byte offset persisted
   ▼
Electron app — transparent, frameless, always-on-top, draggable
```

The hook script is Node, so there are zero extra dependencies — anyone
running Claude Code has Node already.

## Controls

- **Click** the pet to pet it — hearts, a mood boost, and quite often a piece
  of gossip about your sessions (see below).
- **Double-click** feeds it a cookie (5-minute cooldown; real work is dinner,
  cookies are cookies).
- **Drag** the pet anywhere — it remembers where you put it, and comes back
  there next launch (clamped to a monitor that's actually attached). Its eyes
  follow your cursor, and if you leave it alone for a few minutes it
  sometimes goes for a little walk and comes back.
- **Menu bar icon** and **right-click** on the pet open the same lean menu:
  **Settings…**, click-through toggle, reinstall hooks, *uninstall hooks &
  quit* (surgically removes only claude-pet's entries from settings.json), or
  quit keeping hooks.
- **Settings…** opens a little retro panel with everything else: name your
  pet, pick its species — blob, cat, gerbil, dog, ghost, or penguin, all
  hatching from the same egg and evolving through the same stages — pick one of six color
  palettes, dress it (accessories unlock as it levels), size slider (70–200%,
  resizes live from the pet's feet) with a reset-size-&-position button,
  toggles for the speech bubble / stats line / glow, and sounds (every action
  has a tiny chiptune motif, off by default) with a volume slider.
- **⌘⌥P** toggles click-through globally — you need it, because once
  click-through is on, the right-click that would turn it off passes straight
  through the pet.

## Tests

```bash
npm test
```

Runs against a throwaway `$HOME`, so it can never touch your real
`~/.claude/settings.json`.

## Behavior

| Trigger | Reaction |
|---|---|
| Edit/Write succeeds | eats (hunger down, +xp) |
| `git commit` in Bash | party animation, big xp |
| `git push` | party, "pushed to the cloud ☁" |
| npm/pnpm/yarn install | munches on the dependencies |
| Test run, all green | party, +20 xp, "27 tests green ✓" |
| Test run, red | sulks, "3 tests red..." |
| Other tool failure | sulks, mood drops |
| **Claude waits for your input** | relays it: "☝ Claude needs your permission to use Bash" |
| Context compaction | "compacting memories..." |
| A subagent finishes | "a minion returns ✓" |
| Session starts | wakes up and greets you |
| Idle 30+ min | lonely, but energy recovers |
| Low energy | sleeps |
| XP thresholds | egg → hatchling → junior → senior → wizard (hat) — every character has its own sprite per stage |
| Context ~75% / ~90% full | warns you: "⚠ context ~91% in myproject — /compact soon!" |

Web searches, agent spawns, and file reads get occasional asides too, at
deliberately low odds — the pet comments on your work, it doesn't narrate it.

## It knows what you're working on

The hook hands over the session's transcript path, and the app (never the
hook) reads the tail of it to learn things it can honestly report: how many
sessions are running and in which projects, how full the context window is
(a strip under the pet lists every live session by name with its own 🧠%,
subagent noise filtered out),
which model is on the case, and roughly how many tokens you've burned in the
last 5 hours. Every 10 minutes it repeats the headline numbers once context
passes 40% — plan limits (/usage) aren't on disk, so it reports only what
the transcript proves. Pet it and it'll tell you — "3 sessions: api, web, infra",
"context ~62% in claude-pet", "~1.2M tokens out in 5h". The context-fullness
warnings fire once per threshold and re-arm after a /compact.

Test runs are recognized across jest, vitest, pytest, go, cargo, rspec,
phpunit, gradle/maven, dotnet, swift, mix and friends — both the command and
the pass/fail tally are parsed, so the pet knows *how* green it was.

State persists in `~/.claude-pet/state.json`. The event log is truncated on
launch (and past 512 KB) once every queued event has been applied.

## Packaging for distribution

For the "download and double-click" experience, add electron-builder:

```bash
npm i -D electron-builder
npx electron-builder --mac --win --linux
```

Everything self-installs on first run, so the packaged app is genuinely
standalone. Add `app.setLoginItemSettings({ openAtLogin: true })` if you want
it to start with the OS.

## Extending

- **Sprites**: every character × stage is a 16×16 ASCII grid in the
  `CHARACTERS` table in `index.html` — adding a species is ~3 grids plus face
  coordinates, and the test suite checks the geometry for you.
- **Team mode**: POST stats on SessionEnd to a shared endpoint; render the
  whole team's pets on one wall.
- **Log rotation**: `events.jsonl` grows forever; truncation is handled
  (offset auto-resets), so a cron/cleanup on launch is enough.
- **Tauri port**: same architecture at ~10MB if Electron size offends.

## Notes

- Hooks always exit 0 and are installed with `"async": true` — Claude Code
  never waits on them. The pet observes, it never blocks a tool call.
- The install bakes an **absolute** node path into the hook command. Under
  nvm/fnm/volta, or when Claude Code is launched from Spotlight/Dock, bare
  `node` often isn't on the hook's PATH and the hook fails silently. If node
  later moves, right-click → *Reinstall Claude hooks* re-resolves it.
- The hook trims tool payloads before writing, so the log stays small and
  file contents never land on disk twice.
- Linux/Wayland transparency can be temperamental; macOS and Windows are fine.
