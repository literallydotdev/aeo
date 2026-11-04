#!/usr/bin/env node
// A stand-in for the agent CLIs on PATH (hardening spec §6.2). The mode
// comes from FAKE_CLI_MODE; the prompt is the last argument, as for the
// real CLIs, and is echoed nowhere unless the mode asks for it.
// The runner hands the child an allowlisted environment (PATH, HOME, the
// CLI's auth variable), so the mode travels through a file under HOME.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let mode = 'ok';
try {
  mode = readFileSync(
    join(process.env.HOME ?? '', '.fake-cli-mode'),
    'utf8',
  ).trim();
} catch {
  // No mode file: answer normally.
}
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
