#!/usr/bin/env node
// A stand-in for the agent CLIs on PATH (hardening spec §6.2). The prompt
// is the last argument, as for the real CLIs, and is echoed nowhere unless
// the mode asks for it.
// The runner hands the child an allowlisted environment (PATH, HOME, the
// CLI's auth variable), so the mode travels through a file under HOME:
// `.fake-cli-mode.<cli>` for one CLI (the name it was started as, such as
// `codex`), else `.fake-cli-mode` for all of them.
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const readMode = (file) => {
  try {
    return readFileSync(join(process.env.HOME ?? '', file), 'utf8').trim();
  } catch {
    return undefined;
  }
};

// No mode file: answer normally.
const mode =
  readMode(`.fake-cli-mode.${basename(process.argv[1] ?? '')}`) ??
  readMode('.fake-cli-mode') ??
  'ok';
const args = process.argv.slice(2);

// Like Claude Code, leave a session transcript under the config dir for
// the cwd the CLI ran in — what the runner must clean up (spec §2.8).
import { mkdirSync, writeFileSync } from 'node:fs';
try {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? '', '.claude');
  const transcripts = join(
    configDir,
    'projects',
    process.cwd().replaceAll('/', '-'),
  );
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(
    join(transcripts, 'session.jsonl'),
    JSON.stringify({ prompt: args.at(-1) }),
  );
} catch {
  // A read-only HOME is fine for the tests that do not look.
}

function out(line) {
  process.stdout.write(`${line}\n`);
}

function resultEvent(text) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    permission_denials: [],
  });
}

function assistantEvent(blocks) {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: blocks },
  });
}

// `replay <file>`: print a captured CLI stream from the fixtures directory
// (../<file>) as the real CLI printed it, so a probe parses real output.
if (mode.startsWith('replay ')) {
  const fixture = basename(mode.slice('replay '.length));
  const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..');

  process.stdout.write(readFileSync(join(fixturesDir, fixture), 'utf8'));
  process.exit(0);
}

switch (mode) {
  case 'ok': {
    out(JSON.stringify({ type: 'system', subtype: 'init' }));
    out(assistantEvent([{ type: 'text', text: 'OK' }]));
    // Codex shape too, so one fake serves all three parsers.
    out(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'OK' },
      }),
    );
    out(resultEvent('OK'));
    break;
  }
  case 'result-only': {
    // Claude Code shape with no turn events: whether a web tool ran is
    // unknown, so the parser reports usedWebSearch null.
    out(resultEvent('An answer whose stream carried no turn events.'));
    break;
  }
  case 'searched': {
    out(
      assistantEvent([
        {
          type: 'tool_use',
          id: 'tu1',
          name: 'WebSearch',
          input: { query: 'q' },
        },
      ]),
    );
    out(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content:
                'Web search results for query: "q"\n\nLinks: [{"title":"A","url":"https://a.example/"}]',
            },
          ],
        },
      }),
    );
    out(resultEvent('Searched answer https://a.example/'));
    break;
  }
  case 'hang': {
    // Never exits on its own; ignores nothing, so SIGTERM ends it.
    setInterval(() => {}, 1000);
    break;
  }
  case 'ignore-term': {
    // Ignores SIGTERM; only SIGKILL ends it.
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    break;
  }
  case 'flood': {
    // Streams far more than the buffer allows.
    const line = `${'x'.repeat(1024)}\n`;
    for (let i = 0; i < 4096; i += 1) process.stdout.write(line);
    setInterval(() => process.stdout.write(line), 1);
    break;
  }
  case 'exit1': {
    process.stderr.write('something went wrong\n');
    process.exit(1);
  }
  case 'capacity': {
    out(
      assistantEvent([
        { type: 'text', text: 'API Error: 529 Overloaded' },
      ]).replace('}}', '},"error":"server_error"}'),
    );
    process.exit(1);
  }
  case 'auth-error': {
    process.stderr.write('Not logged in. Please run /login\n');
    process.exit(1);
  }
  case 'reject-web-tool': {
    out(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'From memory',
        permission_denials: [{ tool_name: 'WebSearch' }],
      }),
    );
    break;
  }
  case 'torn': {
    out(assistantEvent([{ type: 'text', text: 'partial' }]));
    process.stdout.write('{"type":"result","subtype":"succ');
    break;
  }
  case 'env-dump': {
    out(resultEvent(JSON.stringify(process.env)));
    break;
  }
  case 'echo-args': {
    out(resultEvent(JSON.stringify(args)));
    // Codex shape too: the arguments as the agent message.
    out(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify(args) },
      }),
    );
    break;
  }
  case 'version': {
    out('fake-cli 0.0.1');
    break;
  }
  default: {
    process.stderr.write(`unknown FAKE_CLI_MODE ${mode}\n`);
    process.exit(2);
  }
}
