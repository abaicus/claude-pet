# claude-pet

A desktop tamagotchi that floats above all windows and feeds on Claude Code
activity. No dock icon, no window chrome — a critter, not an app. It observes
coding sessions and reacts; it never interferes with them.

Beyond the toy: it taps you on the shoulder when Claude is blocked waiting on
you (notification relay with chime, bypasses mute), and it surfaces live
context-usage telemetry per session in a stats line
(`Pixel lv.6 │ 2 sessions │ ctx ~72% │ 41k/5h │ ✓×5`).

## Run

```bash
npm install
npm start
```

On first launch the app installs Claude Code hooks into
`~/.claude/settings.json` (idempotent, preserves your existing settings,
refuses to touch a config it can't parse — uninstall from the tray removes
exactly its own entries). Events append to `~/.claude-pet/events.jsonl`;
the hook script is fire-and-forget and can never block or fail a session.

## Using it

- **Left-click** the pet: petting (~45% of the time it answers with a real
  session fact). **Double-click**: cookie treat (5-min cooldown).
- **Drag** anywhere; position persists.
- **Right-click** or the **tray icon**: settings, treat, hide/show, sounds,
  click-through, reinstall/uninstall hooks, quit.
- **Shortcuts** (real global ones — a tray menu accelerator is only a label
  on macOS, so each is registered for real, and the menu shows a key only if
  the OS actually granted it):

  | `⌘⌥,` settings | `⌘⌥T` treat | `⌘⌥V` hide/show |
  |---|---|---|
  | **`⌘⌥M`** sounds | **`⌘⌥P`** click-through | **`⌘⌥Q`** quit |

  `⌘⌥P` is the escape hatch: a click-through pet can't offer its own way back.
- **Settings**: name, 12 palettes, 12 level-locked accessories, speech
  bubble / stats line / glow toggles, size slider, sounds (synthesized
  chiptune, **off by default** — important notifications always chime),
  danger-zone reset (survives: customization, sound settings, event cursor),
  and debug sections (set level/stats, fire fake events through the real
  reducer, trigger any animation or sound). `esc` or `✕` closes it.

The pet levels 0–10 through five forms (egg → hatchling → junior → senior →
elder) on xp from commits, green tests, PRs, deploys and edits. It parses
what bash commands *mean* — commits party, red tests sulk with the failure
count, `rm -rf` gets a flinch. Context warnings fire once at ~75% and ~90%
per session and re-arm below 60%.

It never lies: estimates are labeled `~`, and data it can't read is absent,
never faked.

## Development

```bash
npm test                                  # headless brain tests (node:test)
npx electron scripts/shoot-mockups.js     # render art mockups to mockups/*.png
```

Sandboxing for development — never touches your real config:

```bash
CLAUDE_PET_DIR=/tmp/pet-sandbox \
CLAUDE_PET_SETTINGS=/tmp/pet-sandbox/settings.json \
npm start
```

Debug env: `CLAUDE_PET_NO_HOOKS=1` (skip hook install),
`CLAUDE_PET_SHOT=/path.png` / `CLAUDE_PET_SHOT_SETTINGS=/path.png` +
`CLAUDE_PET_SHOT_DELAY=ms` (window screenshots).

### Architecture

Three strictly separated layers (deleting the renderer leaves the brain
fully functional):

```
src/
  capture/    hook script (standalone, zero deps) + settings installer
  brain/      ALL state & game logic — no Electron imports, headless-testable
              tailer (byte-offset cursor) · reducer (event → state) ·
              bash-parser · sessions (transcript telemetry) · persistence
  body/       dumb renderer: render(state) — canvas art, animations,
              bubble, stats line, sounds (all generated in code)
  settings/   remote control only; the brain enforces every rule
  shared/     constants, tuning, IPC channel names
```

State lives in `~/.claude-pet/` as human-readable versioned JSON
(`state.json` progression · `prefs.json` customization · `cursor.json`
read offsets). Players may cheat; that's a feature.
