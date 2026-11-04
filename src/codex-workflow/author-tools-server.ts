import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { getEnvironment } from '../lib/env';
import { searchAdapterFromEnv } from './author-search';
import { createAuthorTools, renderWithChromium } from './author-tools';

// ============================================================================
// The research tool server on the wire (specs/aeo-codex-author-spec.md §4):
// a stdio MCP server Codex starts for the author stage, registered in the
// isolated home's config. Codex speaks JSON-RPC over stdin and stdout and
// never surfaces the server's stderr, so anything worth knowing is written
// to the work directory. The tools themselves live in author-tools.ts.
// ============================================================================

const defaultProtocolVersion = '2025-06-18';

// A request's fields as the server reads them; malformed params are read as
// absent rather than dropping the request.
const requestSchema = z.looseObject({
  jsonrpc: z.string().optional(),
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

type Request = z.infer<typeof requestSchema>;

type RequestId = Request['id'];

const readSettings = (env: NodeJS.ProcessEnv) => {
  const AEO_AUTHOR_WORKDIR = env.AEO_AUTHOR_WORKDIR;
  const AEO_AUTHOR_LABEL = env.AEO_AUTHOR_LABEL ?? 'author-0';

  if (!AEO_AUTHOR_WORKDIR) {
    throw new Error(
      'Please set AEO_AUTHOR_WORKDIR for the research tool server.',
    );
  }

  const settings = {
    dir: path.resolve(AEO_AUTHOR_WORKDIR),
    label: AEO_AUTHOR_LABEL,
    secrets: [
      env.AI_GATEWAY_API_KEY,
      env.DATAFORSEO_LOGIN,
      env.DATAFORSEO_PASSWORD,
    ].filter((value): value is string => Boolean(value)),
  };

  return settings;
};

const describeError = (error: unknown) => {
  return error instanceof Error ? error.message : String(error);
};

const send = (message: unknown) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const reply = (id: RequestId, result: unknown) => {
  send({ jsonrpc: '2.0', id, result });
};

const fail = (id: RequestId, error: { code: number; message: string }) => {
  send({ jsonrpc: '2.0', id, error });
};

type ToolServer = {
  tools: ReturnType<typeof createAuthorTools>;
  log: (line: string) => Promise<void>;
};

const handleRequest = async (
  { tools, log }: ToolServer,
  { id, method, params }: Request,
) => {
  if (method === 'initialize') {
    reply(id, {
      protocolVersion:
        typeof params?.protocolVersion === 'string'
          ? params.protocolVersion
          : defaultProtocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'research', version: '1' },
    });

    return;
  }

  if (method === 'ping') {
    reply(id, {});

    return;
  }

  if (method === 'tools/list') {
    reply(id, { tools: tools.definitions });

    return;
  }

  if (method === 'tools/call') {
    const name = typeof params?.name === 'string' ? params.name : '';

    await log(`call ${name}`);

    const result = await tools.call(name, params?.arguments ?? {});

    reply(id, result);

    return;
  }

  // Notifications carry no id and expect no answer.
  if (id !== undefined) {
    fail(id, { code: -32601, message: `Unknown method ${String(method)}` });
  }
};

const startToolServer = async () => {
  const settings = readSettings(getEnvironment());
  const logFile = path.join(
    settings.dir,
    'JOURNAL',
    `${settings.label}.tools.log`,
  );

  await mkdir(path.dirname(logFile), { recursive: true });

  const log = (line: string) => {
    return appendFile(logFile, `${new Date().toISOString()} ${line}\n`).catch(
      () => undefined,
    );
  };

  const search = searchAdapterFromEnv(getEnvironment());

  const tools = createAuthorTools({
    ...settings,
    search,
    renderHtml: renderWithChromium,
  });

  const server: ToolServer = { tools, log };

  await log(
    `started: ${tools.definitions.length} tools, search provider ${search?.provider ?? 'none'}`,
  );

  // Requests are handled in order: a tool call must finish before the next
  // is read, so the caps and the per-host spacing see one call at a time.
  let queue: Promise<void> = Promise.resolve();
  const lines = createInterface({ input: process.stdin });

  lines.on('line', (line) => {
    if (!line.trim()) {
      return;
    }

    let json: unknown;

    try {
      json = JSON.parse(line);
    } catch {
      // A line that is not JSON is not a request; there is no id to answer.
      return;
    }

    const parsed = requestSchema.safeParse(json);

    if (!parsed.success) {
      return;
    }

    const request = parsed.data;

    queue = queue.then(async () => {
      try {
        await handleRequest(server, request);
      } catch (error) {
        await log(
          `error on ${String(request.method)}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );

        if (request.id !== undefined) {
          fail(request.id, {
            code: -32000,
            message:
              error instanceof Error ? error.message : 'Tool server error',
          });
        }
      }
    });
  });
  lines.on('close', () => {
    void queue
      .then(() => log('stdin closed; exiting'))
      .then(() => process.exit(0));
  });
};

void startToolServer().catch((error: unknown) => {
  process.stderr.write(`${describeError(error)}\n`);
  process.exit(1);
});
