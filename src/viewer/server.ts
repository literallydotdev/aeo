import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { z } from 'zod';
import { RunOrigin, toolVersion } from '../bundle/contracts';
import { parseBundleJson } from '../bundle/json';
import { verifyBundle } from '../bundle/verify';
import { viewerPage } from './page';

// ============================================================================
// `literally-aeo view` (specs/aeo-open-source-cli-spec.md §4.3). Any local
// web page can reach loopback, so the server binds to 127.0.0.1 only,
// answers only with a random per-launch token, refuses a Host header other
// than its own address (DNS rebinding), serves only the bundle's own files,
// and sends a Content Security Policy that forbids remote content. It
// cannot start an audit, read a credential or write anything.
// ============================================================================

export type ViewerBundle = {
  files: ReadonlyMap<string, Buffer>;
  description: string;
  /** A run directory's unfinalized state, labelled as such on the page. */
  workingState: boolean;
};

export type ViewerServer = {
  url: string;
  close: () => Promise<void>;
};

const originLabels: Record<string, string> = {
  [RunOrigin.LOCAL]: 'Run locally by the report owner',
  [RunOrigin.HOSTED]: 'Run by Literally.dev',
  [RunOrigin.LEGACY_IMPORT]: 'Imported from a run without an execution trace',
};

const manifestOriginSchema = z.looseObject({
  run: z.looseObject({ origin: z.string() }),
});

const sameToken = (expected: string, received: string | null): boolean => {
  if (received === null) {
    return false;
  }

  const left = Buffer.from(expected);
  const right = Buffer.from(received);

  return left.length === right.length && timingSafeEqual(left, right);
};

type Reply = {
  status: number;
  body: string | Buffer;
  contentType: string;
  csp?: string;
};

const send = (
  response: ServerResponse,
  { status, body, contentType, csp }: Reply,
) => {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    ...(csp !== undefined && { 'content-security-policy': csp }),
  });
  response.end(body);
};

const plain = (status: number, body: string): Reply => {
  return { status, body, contentType: 'text/plain; charset=utf-8' };
};

/** The page's metadata and the verifier's result, served beside the files. */
const derivedDocuments = (bundle: ViewerBundle) => {
  const verification = verifyBundle(bundle.files, bundle.description);
  const manifest = bundle.files.get('manifest.json');
  let origin: string | undefined;

  if (manifest) {
    try {
      const parsed = manifestOriginSchema.safeParse(
        parseBundleJson(manifest.toString('utf8')),
      );

      origin = parsed.success ? parsed.data.run.origin : undefined;
    } catch {
      // A malformed manifest is the verifier's finding, shown on the page.
    }
  }

  return new Map<string, unknown>([
    [
      '__viewer',
      {
        source: bundle.description,
        workingState: bundle.workingState,
        toolVersion,
        originLabel:
          origin === undefined
            ? 'Run locally by the report owner'
            : (originLabels[origin] ?? 'Origin unknown'),
      },
    ],
    ['__verification', bundle.workingState ? null : verification],
  ]);
};

/** startViewer serves a bundle on loopback until closed. */
export const startViewer = async (
  bundle: ViewerBundle,
  { port = 0 }: { port?: number } = {},
): Promise<ViewerServer> => {
  const token = randomBytes(32).toString('hex');
  const derived = derivedDocuments(bundle);
  let host = '';

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    // Only the address the browser was given; a rebinding name is refused.
    if (request.headers.host !== host || request.method !== 'GET') {
      send(response, plain(403, 'Forbidden'));

      return;
    }

    const url = new URL(request.url ?? '/', `http://${host}`);

    if (!sameToken(token, url.searchParams.get('t'))) {
      send(response, plain(403, 'Forbidden'));

      return;
    }

    if (url.pathname === '/') {
      const nonce = randomBytes(16).toString('base64');

      send(response, {
        status: 200,
        body: viewerPage(nonce),
        contentType: 'text/html; charset=utf-8',
        csp: `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });

      return;
    }

    const file = decodeURIComponent(url.pathname.replace(/^\/data\//, ''));
    const derivedDocument = derived.get(file);

    if (url.pathname.startsWith('/data/') && derivedDocument !== undefined) {
      send(response, {
        status: 200,
        body: JSON.stringify(derivedDocument),
        contentType: 'application/json',
      });

      return;
    }

    // Served as data, never as a page: only JSON documents of the bundle.
    const bytes = bundle.files.get(file);

    if (
      !url.pathname.startsWith('/data/') ||
      bytes === undefined ||
      !file.endsWith('.json')
    ) {
      send(response, plain(404, 'Not found'));

      return;
    }

    send(response, {
      status: 200,
      body: bytes,
      contentType: 'application/json',
    });
  };

  const server = createServer(handle);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('The viewer could not read its loopback address.');
  }

  host = `127.0.0.1:${address.port}`;

  const viewer: ViewerServer = {
    url: `http://${host}/?t=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };

  return viewer;
};
