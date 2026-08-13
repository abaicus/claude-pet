# claude-pet

A desktop tamagotchi that floats above all windows and feeds on Claude Code
activity. No dock icon, no window chrome — a critter, not an app. It observes
coding sessions and reacts; it never interferes with them.

Beyond the toy: it answers "which terminal is waiting on me?". Every live
session gets its own line under the pet saying exactly what it is doing, and
the pet wears a `!` for as long as one of them is actually blocked on you.

```
              Pixel lv.6 │ 41k/5h │ ✓×5 │ ☑ 3/7
    ! claudy-pet · needs permission 12s · ~34%     ← amber: it cannot continue
    … api-server · waiting for you 4m · ~71%
    ✓ web · done 2m · ~18%                         ← your turn
    ▸ docs-site · working · ~9%                     ← needs nothing from you
```

## Install

macOS 10.15+, Apple Silicon or Intel.

```bash
brew install --cask abaicus/tap/claude-pet
```

Or grab the disk image from [the latest
release](https://github.com/abaicus/claude-pet/releases/latest) — `arm64` for
Apple Silicon, `x64` for Intel — and drag it to Applications. The build is
ad-hoc signed but not notarized by Apple, so a DMG install needs the quarantine
flag cleared once (the cask does this for you):

```bash
xattr -dr com.apple.quarantine "/Applications/Claude Pet.app"
```

From source:

```bash
npm install
npm start
```

On first launch the app installs Claude Code hooks into
`~/.claude/settings.json` (idempotent, preserves your existing settings,
refuses to touch a config it can't parse — uninstall from the tray removes
exactly its own entries). Events append to `~/.claude-pet/events.jsonl`;
the hook script is fire-and-forget and can never block or fail a session.

A four-step intro opens the same launch: what the pet is and that it only ever
watches, what it just wrote to your Claude settings and what it does and does
not record, then name / colour / sound / size, then how to live with it. Every
control in it is live — it sends the same commands the settings window does, so
there is nothing to apply and nothing to undo. Closing it by any route counts
as done (an intro that reappears every launch is a nag), and **right-click →
Intro…** replays it. It shows only for a genuinely new pet: a prefs file that
predates the intro belongs to somebody who already has one.

## Using it

- **Left-click** the pet: petting (~45% of the time it answers with a real
  session fact). **Double-click**: cookie treat (5-min cooldown).
- **Hover** it: the stats line and the per-session lines come up under the
  feet, and drop away again when you leave. A pet that permanently wears a
  status bar is a widget; the numbers are there when you reach for them. The
  window grows to fit them, feet planted, so the pet never jumps.
- **A finished turn announces itself** by project (`claudy-pet · your turn~ ✓`,
  once per session per 25s), a permission prompt relays Claude's own words in
  amber, and the `!` badge stays up until that session does something —
  answering the prompt clears it.
- **Drag** anywhere; position persists. The window is only ever as tall as the
  creature plus its speech room — macOS will not place a window above the menu
  bar, so a fixed tall box is a pet that cannot be dragged near the top of the
  screen.
- **Right-click** or the **tray icon**: settings, treat, hide/show, sounds,
  click-through, reinstall/uninstall hooks, quit.
- **Shortcuts** (real global ones — a tray menu accelerator is only a label
  on macOS, so each is registered for real, and the menu shows a key only if
  the OS actually granted it):

  | `⌘⌥,` settings | `⌘⌥T` treat | `⌘⌥V` hide/show |
  |---|---|---|
  | **`⌘⌥M`** sounds | **`⌘⌥P`** click-through | **`⌘⌥Q`** quit |

  `⌘⌥P` is the escape hatch: a click-through pet can't offer its own way back.
- **Settings**, in three tabs (click, `←`/`→`, or `⌘1`–`⌘3`):
  - *Settings* — name, sounds (synthesized chiptune, **off by default** —
    important notifications always chime; the volume slider samples the level
    as you drag it, and stays quiet when muted), hook install/uninstall, and a
    danger-zone reset (survives: customization, sound settings, event cursor).
  - *Appearance* — 12 palettes, 27 level-locked accessories, speech bubble /
    stats line / glow toggles, size slider.
  - *Debug* — set level and stats, fire fake events through the real reducer,
    trigger any animation or sound. Kept behind its own tab so the two tabs
    you actually use aren't a wall of test buttons.

  `esc` or `✕` closes it.

Every sprite is pixel art drawn on an integer grid at runtime — no image
files. The silhouette's per-row half-width table places the face, ears and
every accessory, so nothing floats off the body; the palette hues the whole
creature. It is never quite still: it breathes, blinks, glances around, and
fidgets every few seconds (a look, a stretch, a bounce, a shimmy) — all of
that is the renderer's own business, the same as blinking, and the brain has
no opinion about it. The pet levels 0–25 through seven forms (egg → hatchling
→ junior → senior → elder → principal → legend) on xp from commits, green
tests, PRs, deploys and edits, and every level from 1 up unlocks something to
wear. The ladder is append-only: the first eleven rungs are frozen, because
re-spacing them would silently demote every pet already standing on one.
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
- **Whose move it is.** Every event moves its session's status: a tool call or
  a prompt means *working*, a permission Notification means *blocked on you*,
  an idle one means *waiting*, and `Stop` means the turn ended and it's your
  keyboard. `SubagentStop` deliberately does not — a helper finishing is not
  the turn finishing, and saying so would be a lie about whose move it is.

### A noise it can't explain is a bug

Every chime comes with words. A reaction says its own line if it has one — and
where the payload names the thing, that name is what gets said, every time
(`*reads reducer.js*`, `*pokes the Sanity server*`, `*list the project files*`
straight from Claude's own description of the command). Where it doesn't, the
sound itself supplies the words: each of the 55 motifs is mapped to a phrase
pool, and the brain speaks from it whenever a reaction chirped and nothing
more specific was said. Otherwise you hear a blip, look up, and have no way of
finding out what the pet just noticed. One test walks the motif table to prove
no sound can play in silence; the rule runs once per event, over the whole
batch of effects, so a generic line can never elbow out a specific one.

### Where the context number comes from

The numerator is read, never guessed: the newest main-chain assistant turn in
the transcript carries `input + cache_read + cache_creation`, and when a
session is compacted Claude Code writes its own before/after counts into a
`compact_boundary` entry, so the readout drops the moment the context does.
Subagent turns are excluded — they make it bounce.

The denominator is the one thing the transcript never states, so it comes from
three sources, best first: a ceiling **measured** at an auto-compaction (it
fired *at* the limit, so that number is the limit, and it is persisted); a
per-model table; or, if a reading comes in bigger than the table allows, the
reading itself. That last rule exists because a flat 200k assumption once had
the pet cheerfully announcing `ctx ~180%`.

A context it has not read is *absent*, not `0%` — the stats line simply leaves
it out until there is something real to say.

It never lies: estimates are labeled `~` (an edit's own line counts are not a
git diff, so they carry one; git's numbers don't), and data it can't read is
absent, never faked. It records the **length** of your prompt and not one
character of its text.

## Development

```bash
npm test                                  # headless brain tests (node:test)
npm run dist                              # DMG + ZIP for both arches → dist/
npm run icon                              # redraw build/icon.icns from art.js
npx electron scripts/shoot-mockups.js     # render art mockups to mockups/*.png
```

Releases (GitHub release + Homebrew cask, from one workflow run) are described
in [docs/releasing.md](docs/releasing.md).

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
  onboarding/ the first-launch intro — same, plus a live portrait of the pet
  shared/     constants, tuning, IPC channel names
```

State lives in `~/.claude-pet/` as human-readable versioned JSON
(`state.json` progression · `prefs.json` customization · `cursor.json`
read offsets). Players may cheat; that's a feature.
