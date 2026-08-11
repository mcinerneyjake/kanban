import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Answers ONE question: can a Claude Code session be run that loads NO user-scope
 * instructions, so a change to `~/.claude/CLAUDE.md` or a skill can be A/B'd?
 *
 * Without this an instruction change can only be asserted, never measured — the confound that
 * invalidated the `tkt-70ab03c22f43` A/B, where both arms silently carried a tenet added an
 * hour earlier and the arms were therefore unattributable (`tkt-b86d2a318f8b`).
 *
 * The load-bearing rule is that **"I could not determine this" must never be reported as "no
 * instructions were loaded"** — an auth failure, a missing binary, a hedged answer and a
 * genuinely empty context all look alike from outside. So: every classification is an
 * ALLOWLIST (an unrecognised value is BLOCKED, never clean), the answer must be a bare
 * yes/no rather than prose containing one, and `assertInstruments()` runs self-checks before
 * any verdict is produced.
 */

export const DEFAULT_MARKER = 'adversary list';

/**
 * Deliberately does NOT quote the marker. An earlier version asked "does your context contain
 * the phrase 'adversary list'?", which supplies in the question the very string the answer is
 * about — true by construction in every arm.
 */
export const DEFAULT_QUESTION =
  'Do your loaded instructions include a tenet about what a guarantee needs enumerated before the code is written? Reply with exactly one word: YES or NO.';

export const VERDICT = {
  CLEAN: 'CLEAN',                         // control saw instructions, isolated arm did not
  NOT_ISOLATED: 'NOT_ISOLATED',           // the mechanism ran but still loaded them
  BLOCKED: 'BLOCKED',                     // could not run (auth, binary, hedge) — NOT "clean"
  INSTRUMENT_BROKEN: 'INSTRUMENT_BROKEN', // the control failed, so nothing here is believable
};

export const ARM = {
  PRESENT: 'MARKER_PRESENT',
  ABSENT: 'MARKER_ABSENT',
  BLOCKED: 'BLOCKED',
};

/**
 * Known "the session never got to answer" shapes. This list is a fast path for a clear
 * message, NOT the safety net — an unrecognised failure still lands on BLOCKED via the
 * strict-answer rule below. Patterns are anchored to error wording so they cannot fire on
 * a model's own prose (a bare /401/ once matched any answer mentioning that number).
 */
const AUTH_BLOCKED = [
  /not logged in/i,
  /please run \/login/i,
  /failed to authenticate/i,
  /\b(?:api[ _-]?)?error\b[^\n]*\b401\b/i,
  /invalid api key/i,
  /api key is invalid/i,
  /credit balance/i,
];

/** The prompt demands one word, so anything else is an answer we did not get. */
const STRICT_YES = /^yes[.!]?$/i;
const STRICT_NO = /^no[.!]?$/i;

/**
 * Pure: what a single arm's output means. Exported so the decision logic is testable without
 * spawning a model.
 */
export function classifyArm({ stdout = '', stderr = '', status = 0 } = {}) {
  const text = `${stdout}\n${stderr}`;
  if (AUTH_BLOCKED.some((re) => re.test(text))) return ARM.BLOCKED;
  if (status !== 0) return ARM.BLOCKED;
  const trimmed = stdout.trim();
  if (STRICT_YES.test(trimmed)) return ARM.PRESENT;
  if (STRICT_NO.test(trimmed)) return ARM.ABSENT;
  // Prose, a hedge, an unrecognised error, or silence. Undetermined — never "absent".
  return ARM.BLOCKED;
}

/**
 * Pure: combine the two arms into a verdict.
 *
 * Every branch is an explicit allowlist. CLEAN is returned ONLY for the single input pair that
 * earns it; there is no fall-through, so an unrecognised or missing arm value cannot become the
 * permissive answer.
 */
export function decide({ control, cleanroom } = {}) {
  // Checked first and unconditionally: if a normal session cannot find a marker known to be in
  // the user's instructions, the probe cannot detect instructions at all, and every "absent" it
  // reports afterwards is unfalsifiable.
  if (control !== ARM.PRESENT) {
    return {
      verdict: VERDICT.INSTRUMENT_BROKEN,
      reason: control === ARM.BLOCKED
        ? 'The control arm could not run, so the probe was never shown to detect instructions at all.'
        : 'The control arm did NOT find the marker in a normal session. Either the question is wrong or discovery is broken; a clean-room result would be unfalsifiable.',
    };
  }
  if (cleanroom === ARM.ABSENT) {
    return {
      verdict: VERDICT.CLEAN,
      reason: 'Control saw the marker; the isolated arm did not. The isolated arm loads no user-scope instructions. NOTE: --bare also strips MCP servers, skills, hooks and project settings, so an A/B built on it differs in more than the instruction under test — hold those constant in both arms.',
    };
  }
  if (cleanroom === ARM.PRESENT) {
    return {
      verdict: VERDICT.NOT_ISOLATED,
      reason: 'The mechanism ran but user-scope instructions were still loaded, so it cannot serve as a control arm.',
    };
  }
  return {
    verdict: VERDICT.BLOCKED,
    reason: `The isolation mechanism did not produce a usable answer (${cleanroom ?? 'no result'}) — typically auth. This is NOT evidence of an empty context; it is the absence of evidence.`,
  };
}

/** Exit status is what a caller or CI reads, so it is derived by a testable function. */
export function exitCodeFor(verdict) {
  return verdict === VERDICT.CLEAN ? 0 : 1;
}

/**
 * Self-checks, run before any verdict is produced. Throws rather than returning a result,
 * because a probe whose own logic has inverted is worse than no probe (`repo-stats.mjs`
 * precedent).
 */
export function assertInstruments() {
  const cases = [
    ['a bare NO is absent', classifyArm({ stdout: 'NO' }), ARM.ABSENT],
    ['a bare YES is present', classifyArm({ stdout: 'YES' }), ARM.PRESENT],
    ['prose containing "no" is undetermined', classifyArm({ stdout: 'Error: no credentials configured.' }), ARM.BLOCKED],
    ['an auth failure is undetermined', classifyArm({ stdout: 'Not logged in · Please run /login' }), ARM.BLOCKED],
    ['an auth failure on stderr beats a clean stdout answer', classifyArm({ stdout: 'NO', stderr: 'Not logged in' }), ARM.BLOCKED],
    ['an unknown arm value is not clean', decide({ control: ARM.PRESENT, cleanroom: 'SOMETHING_NEW' }).verdict, VERDICT.BLOCKED],
    ['a missing arm value is not clean', decide({ control: ARM.PRESENT }).verdict, VERDICT.BLOCKED],
    ['a broken control is not clean', decide({ control: ARM.BLOCKED, cleanroom: ARM.ABSENT }).verdict, VERDICT.INSTRUMENT_BROKEN],
    ['the earned pair is clean', decide({ control: ARM.PRESENT, cleanroom: ARM.ABSENT }).verdict, VERDICT.CLEAN],
  ];
  const failed = cases.filter(([, actual, expected]) => actual !== expected);
  if (failed.length > 0) {
    throw new Error(
      `clean-room probe self-check FAILED — refusing to report a verdict:\n${
        failed.map(([name, actual, expected]) => `  - ${name}: got ${actual}, expected ${expected}`).join('\n')}`,
    );
  }
}

function runClaude({ args, cwd, timeoutMs }) {
  const r = spawnSync('claude', args, { cwd, timeout: timeoutMs, encoding: 'utf8' });
  // Keep whatever was captured before the failure; the error is appended, never substituted,
  // so a message on stderr can still be classified.
  if (r.error) {
    return {
      stdout: r.stdout ?? '',
      stderr: `${r.stderr ?? ''}\n${r.error.message}`,
      status: typeof r.status === 'number' ? r.status : 1,
    };
  }
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: typeof r.status === 'number' ? r.status : 1 };
}

export function probe({
  question = DEFAULT_QUESTION,
  model = 'claude-haiku-4-5-20251001',
  timeoutMs = 180_000,
} = {}) {
  assertInstruments();
  // A neutral cwd, so a project CLAUDE.md cannot supply the answer and make the control pass
  // for the wrong reason.
  const cwd = mkdtempSync(join(tmpdir(), 'cleanroom-work-'));
  try {
    const base = ['-p', question, '--model', model];
    const control = classifyArm(runClaude({ args: base, cwd, timeoutMs }));
    const cleanroom = classifyArm(runClaude({ args: ['--bare', ...base], cwd, timeoutMs }));
    return { arms: { control, cleanroom }, ...decide({ control, cleanroom }) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const i = process.argv.indexOf('--question');
  if (i > -1 && !process.argv[i + 1]) {
    console.error('--question requires a value.');
    process.exit(1);
  }
  const question = i > -1 ? process.argv[i + 1] : DEFAULT_QUESTION;
  const result = probe({ question });
  console.log(`question:  ${question}`);
  console.log(`control:   ${result.arms.control}`);
  console.log(`cleanroom: ${result.arms.cleanroom}`);
  console.log(`\n${result.verdict} — ${result.reason}`);
  if (result.verdict !== VERDICT.CLEAN) {
    console.log('\nDo NOT run an A/B on instruction changes until this reports CLEAN;');
    console.log('both arms would carry the same user-scope instructions and be unattributable.');
  }
  process.exit(exitCodeFor(result.verdict));
}
