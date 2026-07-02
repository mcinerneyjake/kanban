#!/usr/bin/env node
// Run with: npm run review
// Invokes /code-review via the claude CLI and renders a live spinner so the
// terminal shows what's happening instead of hanging silently.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// ── spinner ──────────────────────────────────────────────────────────────────

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let frameIdx = 0;
let spinLabel = 'Starting review…';
let spinTimer = null;

function spinStart(label) {
  spinLabel = label;
  if (spinTimer) return;
  spinTimer = setInterval(() => {
    process.stderr.write(`\r${FRAMES[frameIdx++ % FRAMES.length]}  ${spinLabel}  `);
  }, 80);
}

function spinUpdate(label) {
  spinLabel = label;
}

function spinStop() {
  if (!spinTimer) return;
  clearInterval(spinTimer);
  spinTimer = null;
  process.stderr.write('\r\x1b[2K');
}

// ── stream handling ───────────────────────────────────────────────────────────

function handleEvent(ev) {
  switch (ev.type) {
    case 'system':
      spinStart('Gathering diff…');
      break;

    case 'assistant': {
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          spinStop();
          process.stdout.write(block.text);
        } else if (block.type === 'tool_use') {
          const { name, input = {} } = block;
          if (name === 'Bash') {
            const cmd = String(input.command ?? '').replace(/\s+/g, ' ').slice(0, 60);
            spinUpdate(`Bash: ${cmd}`);
          } else if (name === 'Agent') {
            const desc = String(input.description ?? input.prompt ?? '').slice(0, 55);
            spinUpdate(`Agent: ${desc}`);
          } else if (name === 'Read') {
            spinUpdate(`Reading ${input.file_path ?? ''}`);
          } else if (name === 'Workflow') {
            spinUpdate(`Workflow: ${String(input.description ?? '').slice(0, 50)}`);
          } else {
            spinUpdate(`${name}…`);
          }
        }
      }
      break;
    }

    case 'result': {
      spinStop();
      if (ev.result) process.stdout.write(ev.result + '\n');
      // Current stream-json names this total_cost_usd; keep cost_usd as a fallback
      // for older CLI builds.
      const costVal = ev.total_cost_usd ?? ev.cost_usd;
      const cost = costVal != null ? ` · $${Number(costVal).toFixed(4)}` : '';
      const secs = ev.duration_ms != null ? ` · ${(ev.duration_ms / 1000).toFixed(1)}s` : '';
      process.stderr.write(`\n✓ Review complete${secs}${cost}\n`);
      break;
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

// Verify the binary actually resolves. The old `PATH.includes('claude')` shortcut
// was a substring test, not an existence check — it both false-negatived (a claude
// on PATH via a dir not literally named "claude") and false-positived (any PATH
// entry containing "claude", e.g. /home/claude/bin, skipping the real check). Just
// resolve it, unless CLAUDE_CLI explicitly overrides.
if (!process.env.CLAUDE_CLI) {
  try {
    const { execSync } = await import('node:child_process');
    execSync('command -v claude', { stdio: 'ignore' });
  } catch {
    console.error('claude CLI not found — install Claude Code to use npm run review');
    process.exit(1);
  }
}

const proc = spawn('claude', [
  '-p', '/code-review',
  '--permission-mode', 'auto',
  '--no-session-persistence',
  '--output-format', 'stream-json',
  '--verbose',
], { stdio: ['ignore', 'pipe', 'inherit'] });

const rl = createInterface({ input: proc.stdout });

rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  try { handleEvent(JSON.parse(line)); } catch { /* non-JSON lines ignored */ }
});

// spawn() failures (e.g. claude vanished between the existence check and here)
// surface as an 'error' event, not a non-zero close — without this the process
// would crash with an unhandled ENOENT instead of a friendly message.
proc.on('error', (err) => {
  spinStop();
  console.error(err.code === 'ENOENT'
    ? 'claude CLI not found — install Claude Code to use npm run review'
    : `Failed to launch claude: ${err.message}`);
  process.exit(1);
});

proc.on('close', (code) => {
  spinStop();
  process.exit(code ?? 0);
});

process.on('SIGINT', () => {
  proc.kill('SIGINT');
  spinStop();
  process.stderr.write('\nReview cancelled.\n');
  process.exit(0);
});
