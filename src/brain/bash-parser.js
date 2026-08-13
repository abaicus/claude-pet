'use strict';
// Semantic bash parsing: reacting to what a command MEANS is where the
// personality lives. First match wins down a priority list (plan order):
// commit, tests, PR create/merge, deploy, push, merge/rebase, install,
// branch, stash, rm -rf, build.

// ---------------------------------------------------------------- tests
// Parse pass/fail counts across ~6 common runner formats. Output is the
// TAIL of stdout+stderr (summaries live at the end).
function parseTestOutput(out) {
  if (typeof out !== 'string' || !out) return null;

  // jest: "Tests:       2 failed, 1 skipped, 40 passed, 43 total"
  let m = out.match(/Tests:\s+(?:(\d+)\s+failed,\s*)?(?:\d+\s+skipped,\s*)?(?:\d+\s+todo,\s*)?(\d+)\s+passed/);
  if (m) return { passed: +m[2], failed: m[1] ? +m[1] : 0 };
  m = out.match(/Tests:\s+(\d+)\s+failed/);
  if (m) return { passed: 0, failed: +m[1] };

  // vitest: "Tests  2 failed | 40 passed (42)" or "Tests  40 passed (40)"
  m = out.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/);
  if (m) return { passed: +m[2], failed: m[1] ? +m[1] : 0 };
  m = out.match(/Tests\s+(\d+)\s+failed/);
  if (m) return { passed: 0, failed: +m[1] };

  // pytest: "==== 2 failed, 40 passed in 1.2s ====" / "==== 40 passed in 0.5s ===="
  m = out.match(/=+\s+(?:(\d+)\s+failed,\s*)?(\d+)\s+passed[^=]*=+/);
  if (m) return { passed: +m[2], failed: m[1] ? +m[1] : 0 };
  m = out.match(/=+\s+(\d+)\s+failed[^=]*=+/);
  if (m) return { passed: 0, failed: +m[1] };

  // mocha: "  40 passing (2s)" / "  2 failing"
  m = out.match(/(\d+)\s+passing/);
  if (m) {
    const f = out.match(/(\d+)\s+failing/);
    return { passed: +m[1], failed: f ? +f[1] : 0 };
  }

  // cargo: "test result: ok. 40 passed; 0 failed;" / "test result: FAILED. 38 passed; 2 failed;"
  m = out.match(/test result:\s+(?:ok|FAILED)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/);
  if (m) return { passed: +m[1], failed: +m[2] };

  // node:test / TAP: "# pass 40" + "# fail 2"
  m = out.match(/#\s*pass\s+(\d+)/);
  if (m) {
    const f = out.match(/#\s*fail\s+(\d+)/);
    return { passed: +m[1], failed: f ? +f[1] : 0 };
  }

  // go test: no counts — "ok  \tpkg\t0.5s" / "FAIL\tpkg" / "--- FAIL: TestX"
  if (/^--- FAIL|^FAIL\b|\nFAIL\b|\n--- FAIL/.test(out)) {
    const fails = (out.match(/--- FAIL/g) || []).length;
    const passes = (out.match(/--- PASS/g) || []).length;
    return { passed: passes, failed: Math.max(fails, 1) };
  }
  if (/(^|\n)ok\s+\S+\s+[\d.]+s/.test(out)) {
    const passes = (out.match(/--- PASS/g) || []).length;
    return { passed: passes || null, failed: 0 }; // green, count unknown
  }

  return null;
}

const TEST_CMD = /\b(jest|vitest|mocha|pytest|py\.test|tox|go test|cargo (?:test|nextest)|npm (?:test|run test\S*)|yarn (?:test|run test\S*)|pnpm (?:test|run test\S*)|bun test|node\s+--test|phpunit|rspec|rails test|mix test|dotnet test|gradle(?:w)?\s+test|mvn\s+(?:test|verify))\b/;

// ---------------------------------------------------------------- classify
/**
 * @param {string} cmd    the bash command text
 * @param {string} out    tail of stdout+stderr (may be '')
 * @param {boolean} ok    false if the tool reported failure
 * @returns {null | {kind, ...extras}}
 */
function classifyBash(cmd, out = '', ok = true) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;

  // 1. commit
  if (/\bgit\b[^|;&]*\bcommit\b/.test(cmd) && !/--dry-run/.test(cmd)) {
    // A failed commit (hook rejection, nothing staged) is not a party.
    if (ok === false || /nothing to commit|no changes added/i.test(out)) {
      return { kind: 'commit-failed' };
    }
    return { kind: 'commit' };
  }

  // 2. tests
  if (TEST_CMD.test(cmd)) {
    const counts = parseTestOutput(out);
    if (counts) {
      const green = counts.failed === 0 && ok !== false;
      return { kind: green ? 'tests-green' : 'tests-red', counts };
    }
    // Runner ran but no recognizable summary: trust the exit status.
    return { kind: ok === false ? 'tests-red' : 'tests-unknown', counts: null };
  }
  // Output looks like a test summary even if the command didn't (make test…)
  if (/\btest\b/.test(cmd)) {
    const counts = parseTestOutput(out);
    if (counts) {
      const green = counts.failed === 0 && ok !== false;
      return { kind: green ? 'tests-green' : 'tests-red', counts };
    }
  }

  // 3. PR create / merge
  let m = cmd.match(/\bgh\s+pr\s+(create|merge)\b/);
  if (m) return { kind: m[1] === 'create' ? 'pr-create' : 'pr-merge' };

  // 4. deploy
  if (/\b(vercel(\s+--prod|\s+deploy)?|netlify\s+deploy|fly\s+deploy|flyctl\s+deploy|wrangler\s+(deploy|publish)|firebase\s+deploy|eb\s+deploy|cdk\s+deploy|kubectl\s+apply|helm\s+(install|upgrade)|cap\s+\S+\s+deploy|serverless\s+deploy|sls\s+deploy|terraform\s+apply)\b/.test(cmd)
      || /\b(npm|yarn|pnpm|make)\s+(run\s+)?deploy\b/.test(cmd)
      || /\bgit\s+push\s+(heroku|dokku)\b/.test(cmd)) {
    return { kind: 'deploy' };
  }

  // 5. push
  if (/\bgit\s+push\b/.test(cmd)) return { kind: 'push' };

  // 6. merge / rebase
  if (/\bgit\s+(merge|rebase)\b/.test(cmd)) return { kind: 'merge' };

  // 7. installs
  if (/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b/.test(cmd)
      || /\bpip3?\s+install\b/.test(cmd)
      || /\b(cargo\s+add|gem\s+install|brew\s+install|composer\s+(install|require)|go\s+get|uv\s+(pip\s+install|add)|poetry\s+add)\b/.test(cmd)) {
    return { kind: 'install' };
  }

  // 8. new branch
  if (/\bgit\s+(checkout\s+-b|switch\s+(-c|--create))\b/.test(cmd)
      || /\bgit\s+branch\s+(?!-)[^\s-]/.test(cmd)) {
    return { kind: 'branch' };
  }

  // 9. stash
  if (/\bgit\s+stash\b/.test(cmd)) return { kind: 'stash' };

  // 10. rm -rf
  if (/\brm\s+(-\w*[rR]\w*[fF]|-\w*[fF]\w*[rR])\b/.test(cmd) || /\brm\s+-\w*[rR]\w*\s+-\w*[fF]\w*\b/.test(cmd)) {
    return { kind: 'rm-rf' };
  }

  // 11. build
  if (/\b(npm|yarn|pnpm|bun)\s+(run\s+)?build\b/.test(cmd)
      || /\b(cargo\s+build|go\s+build|tsc\b|webpack|vite\s+build|next\s+build|esbuild|rollup|make(\s+\w+)?$|gradle(w)?\s+(build|assemble)|mvn\s+(package|install)|xcodebuild|swift\s+build)\b/.test(cmd.trim())) {
    return { kind: 'build' };
  }

  return null;
}

module.exports = { classifyBash, parseTestOutput };
