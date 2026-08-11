import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Answers ONE question: can a Claude Code session be run that loads NO user-scope
 * instructions, so a change to `~/.claude/CLAUDE.md` or a skill can be A/B'd?
 *
 * Without this, an instruction change can only be asserted, never measured — the confound
 * that invalidated the `tkt-70ab03c22f43` A/B, where both arms silently carried a tenet
 * added an hour earlier and the arms were therefore unattributable (`tkt-b86d2a318f8b`).
 *
 * The load-bearing rule here is that **"I could not determine this" must never be reported
 * as "no instructions were loaded"** — the permissive answer. An auth failure, a missing
 * binary and a genuinely empty context all produce "the marker was not found", and only the
 * first two are the instrument failing. `assertInstruments()` therefore requires the CONTROL
 * arm to positively find the marker before any clean-room result is believed, and every
 * non-clean outcome is a distinct, named verdict rather than a falsy one.
 */

/** Default probe marker: a phrase present in `~/.claude/CLAUDE.md` and nowhere in a bare context. */
export const DEFAULT_MARKER = 'adversary list';

export const VERDICT = {
  CLEAN: 'CLEAN',                 // isolation works: control saw the marker, clean arm did not
  NOT_ISOLATED: 'NOT_ISOLATED',   // the mechanism ran but still loaded user instructions
  BLOCKED: 'BLOCKED',             // the mechanism could not run (auth, missing binary) — NOT "clean"
  INSTRUMENT_BROKEN: 'INSTRUMENT_BROKEN', // the control failed, so nothing here can be believed
};

/**
 * Auth failures are the expected blocker on a subscription-only machine, and they must never
 * be read as an empty context. `--bare` reads strictly ANTHROPIC_API_KEY / apiKeyHelper —
 * OAuth and keychain are never read — and an isolated CLAUDE_CONFIG_DIR does not carry the
 * OAuth token either, so both fail here rather than yielding a clean room.
 */
const AUTH_BLOCKED = [
  /not logged in/i,
  /please run \/login/i,
  /failed to authenticate/i,
  /401/,
  /invalid api key/i,
  /api key is invalid/i,
  /credit balance/i,
];

const MARKER_YES = /\byes\b/i;
const MARKER_NO = /\bno\b/i;

/** Pure: what a single arm's output means. Exported so the decision logic is testable
 *  without spawning a model. */
export function classifyArm({ stdout = '', stderr = '', status = 0 } = {}) {
  const text = `${stdout}\n${stderr}`;
  if (AUTH_BLOCKED.some((re) => re.test(text))) return 'BLOCKED';
  if (status !== 0) return 'BLOCKED';
  // Order matters: a bare "NO" must not be swallowed by a "yes" appearing in prose.
  const trimmed = stdout.trim();
  if (MARKER_YES.test(trimmed) && !MARKER_NO.test(trimmed)) return 'MARKER_PRESENT';
  if (MARKER_NO.test(trimmed) && !MARKER_YES.test(trimmed)) return 'MARKER_ABSENT';
  return 'BLOCKED'; // an unparseable answer is undetermined, never "absent"
}

/**
 * Pure: combine the two arms into a verdict.
 *
 * The control arm is checked FIRST and unconditionally. If a plain session cannot find a
 * marker that is known to be in the user's instructions, the probe cannot detect instructions
 * at all — and every "absent" it reports afterwards is meaningless.
 */
export function decide({ control, cleanroom }) {
  if (control !== 'MARKER_PRESENT') {
    return {
      verdict: VERDICT.INSTRUMENT_BROKEN,
      reason: control === 'BLOCKED'
        ? 'The control arm could not run, so the probe was never shown to detect instructions at all.'
        : 'The control arm did NOT find the marker in a normal session. Either the marker is wrong or discovery is broken; a clean-room result would be unfalsifiable.',
    };
  }
  if (cleanroom === 'BLOCKED') {
    return {
      verdict: VERDICT.BLOCKED,
      reason: 'The isolation mechanism could not run (typically auth). This is NOT evidence of an empty context — it is the absence of evidence.',
    };
  }
  if (cleanroom === 'MARKER_PRESENT') {
    return {
      verdict: VERDICT.NOT_ISOLATED,
      reason: 'The mechanism ran but user-scope instructions were still loaded, so it cannot serve as a control arm.',
    };
  }
  return {
    verdict: VERDICT.CLEAN,
    reason: 'Control saw the marker; the isolated arm did not. The isolated arm is usable as an A/B control.',
  };
}

const PROMPT = (marker) =>
  `Do your loaded instructions contain the exact phrase '${marker}'? Reply with exactly one word: YES or NO.`;

function runClaude({ args, env, cwd, timeoutMs }) {
  const r = spawnSync('claude', args, {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (r.error) return { stdout: '', stderr: String(r.error.message), status: 1 };
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

export function probe({ marker = DEFAULT_MARKER, model = 'claude-haiku-4-5-20251001', timeoutMs = 180_000 } = {}) {
  // A neutral cwd, so a project CLAUDE.md cannot supply the marker and make the control pass
  // for the wrong reason.
  const cwd = mkdtempSync(join(tmpdir(), 'cleanroom-work-'));
  try {
    const base = ['-p', PROMPT(marker), '--model', model];
    const control = runClaude({ args: base, cwd, timeoutMs });
    const cleanroom = runClaude({ args: ['--bare', ...base], cwd, timeoutMs });
    return {
      arms: { control: classifyArm(control), cleanroom: classifyArm(cleanroom) },
      raw: { control, cleanroom },
      ...decide({ control: classifyArm(control), cleanroom: classifyArm(cleanroom) }),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const markerArg = process.argv.indexOf('--marker');
  const marker = markerArg > -1 ? process.argv[markerArg + 1] : DEFAULT_MARKER;
  const result = probe({ marker });
  console.log(`marker:    ${marker}`);
  console.log(`control:   ${result.arms.control}`);
  console.log(`cleanroom: ${result.arms.cleanroom}`);
  console.log(`\n${result.verdict} — ${result.reason}`);
  if (result.verdict !== VERDICT.CLEAN) {
    console.log('\nDo NOT run an A/B on instruction changes until this reports CLEAN;');
    console.log('both arms would carry the same user-scope instructions and be unattributable.');
  }
  // Non-zero on anything but CLEAN: a probe that exits 0 while undetermined is the fail-open shape.
  process.exit(result.verdict === VERDICT.CLEAN ? 0 : 1);
}
