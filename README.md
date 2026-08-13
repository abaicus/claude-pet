# claude-pet

A desktop tamagotchi that floats above all windows and feeds on Claude Code
activity. No dock icon, no window chrome — a critter, not an app. It observes
coding sessions and reacts; it never interferes with them.

Beyond the toy: it taps you on the shoulder when Claude is blocked waiting on
you (notification relay with chime, bypasses mute), and it surfaces live
context-usage telemetry per session in a stats line
(`Pixel lv.6 │ 2 sessions │ ctx ~72% │ 41k/5h │ ✓×5 │ ☑ 3/7`).

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

Every sprite is pixel art drawn on an integer grid at runtime — no image
files. The silhouette's per-row half-width table places the face, ears and
every accessory, so nothing floats off the body; the palette hues the whole
creature. The pet levels 0–10 through five forms (egg → hatchling → junior →
senior → elder) on xp from commits, green tests, PRs, deploys and edits.
Context warnings fire once at ~75% and ~90% per session and re-arm below 60%.

## What it notices

The hook payloads carry far more than "a tool ran", so the pet reads them:

- **The size of an edit.** A 70-line change is a *feast* (chomp animation,
  crumbs, extra food); a one-liner is a nibble. Editing a test file is its own
  small moment, and a known file extension gets a flavour ("rust!! crunchy").
- **What a bash command means** — commits, tests, PRs, deploys, releases,
  migrations, containers, linters, searches and the scary ones. First match
  wins, so the order *is* the semantics: `git commit --amend` is an amend,
  `git push --force` is a scare and not a push, `docker build` is docker and
  not a build. Commits and `git diff --stat` report the numbers *git printed*;
  a bare `git diff` reports none, because the output tail would undercount.
- **Claude's todo list.** A ticked box gets a nod, a finished list gets a spin
  and a jingle, and progress shows in the stats line while it's still live.
- **Subagents**, announced going out (`*Explore, go!*`) and coming back.
- **Which host** a WebFetch read, **which MCP server** a call went to.
- **Permission-mode changes** — plan mode, auto-edit, and `bypassPermissions`,
  which gets an important bubble and a shiver. The value is never announced,
  only the change.
- **Session shape**: resume vs clear vs startup, manual vs auto compaction,
  and a permission prompt vs Claude idly waiting on you (different chimes).

It never lies: estimates are labeled `~` (an edit's own line counts are not a
git diff, so they carry one; git's numbers don't), and data it can't read is
absent, never faked. It records the **length** of your prompt and not one
character of its text.

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
              bash-parser (command semantics) · sessions (transcript
              telemetry) · quips · persistence
  body/       dumb renderer: render(state) — canvas art, animations,
              bubble, stats line, sounds (all generated in code)
  settings/   remote control only; the brain enforces every rule
  shared/     constants, tuning, IPC channel names
```

State lives in `~/.claude-pet/` as human-readable versioned JSON
(`state.json` progression · `prefs.json` customization · `cursor.json`
read offsets). Players may cheat; that's a feature.
