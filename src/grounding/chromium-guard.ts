import type { LookupAddress } from 'node:dns';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { BrowserContext, Page, Request } from 'playwright';
import {
  resolvePublicAddress,
  validateResearchUrl,
  type LookupAll,
} from './guarded-request';

// ============================================================================
// Chromium behind the guard (specs/aeo-checks-and-reach-spec.md §3.2). A
// route handler alone does not hold: it sees only the first URL of a
// redirect, never resolves subresource host names, and WebSockets and
// service workers pass beside it. So the browser's every connection goes
// through a forward proxy on 127.0.0.1 that applies guardedRequest's rule
// per connection: port 443, a public host, every DNS answer public, the
// socket pinned to the checked address. The proxy tunnels TLS; it never
// sees page content.
// ============================================================================

const connectTimeoutInMs = 15_000;

export type ConnectionCounts = { allowed: number; refused: number };

export type GuardingProxyOptions = {
  /** Test seam: the DNS answers for a host. */
  lookupHost?: LookupAll;
  /** Test seam: where an allowed connection is dialled. */
  dial?: (address: LookupAddress) => Socket;
};

export type GuardingProxy = {
  server: string;
  counts: () => ConnectionCounts;
  close: () => Promise<void>;
};

const dialPublicAddress = (address: LookupAddress): Socket => {
  return connect({ host: address.address, port: 443, family: address.family });
};

/** The CONNECT authority as a guarded https URL, or undefined if refused. */
const toConnectTarget = (authority: string): URL | undefined => {
  const separator = authority.lastIndexOf(':');

  if (separator < 0 || authority.slice(separator + 1) !== '443') {
    return undefined;
  }

  try {
    return validateResearchUrl(`https://${authority.slice(0, separator)}/`);
  } catch {
    return undefined;
  }
};

/** startGuardingProxy listens on a free loopback port until closed. */
export const startGuardingProxy = async (
  options: GuardingProxyOptions = {},
): Promise<GuardingProxy> => {
  const { lookupHost, dial = dialPublicAddress } = options;
  const counts: ConnectionCounts = { allowed: 0, refused: 0 };
  const sockets = new Set<Duplex>();

  const refuse = (client: Duplex) => {
    counts.refused += 1;
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  };

  // Only CONNECT tunnels are served: a plain http request is refused.
  const server = createServer((_request, response) => {
    counts.refused += 1;
    response.writeHead(403).end();
  });

  const tunnel = async (authority: string, client: Duplex, head: Buffer) => {
    const target = toConnectTarget(authority);

    if (!target) {
      refuse(client);

      return;
    }

    let address: LookupAddress;

    try {
      address = await resolvePublicAddress(
        target.hostname,
        AbortSignal.timeout(connectTimeoutInMs),
        lookupHost,
      );
    } catch {
      refuse(client);

      return;
    }

    counts.allowed += 1;

    const upstream = dial(address);

    sockets.add(upstream);
    upstream.setTimeout(connectTimeoutInMs, () => {
      upstream.destroy();
    });
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once('error', () => {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    upstream.once('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.once('close', () => {
      upstream.destroy();
    });
  };

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
  });
  server.on('connect', (request, client: Duplex, head: Buffer) => {
    client.on('error', () => {
      client.destroy();
    });
    void tunnel(request.url ?? '', client, head);
  });
  // A ws:// upgrade asked of the proxy itself, not tunnelled.
  server.on('upgrade', (_request, client: Duplex) => {
    refuse(client);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('The guarding proxy did not bind a TCP port.');
  }

  return {
    server: `http://127.0.0.1:${address.port}`,
    counts: () => ({ ...counts }),
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};

const chromiumArgs = [
  // Playwright proxies loopback too unless an environment variable turns
  // that off; this flag comes last and keeps it on regardless.
  '--proxy-bypass-list=<-loopback>',
  // QUIC and WebRTC over UDP would leave beside an HTTP proxy.
  '--disable-quic',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];

/** What a guarded page may request at all, before the proxy decides. */
const isAllowedRequest = (request: Request): boolean => {
  const url = new URL(request.url());

  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    request.resourceType() !== 'media'
  );
};

/**
 * withBoundedPage runs `use` on a new page of the context, then closes it.
 * A page that freezes its main thread never answers evaluate() or content(),
 * and no Playwright timeout covers those calls; closing the page makes them
 * fail. So past the deadline the page is closed and the render refused,
 * instead of holding the run, and the host's turn in the pacer, forever.
 */
export const withBoundedPage = async <T>(
  context: Pick<BrowserContext, 'newPage'>,
  deadlineInMs: number,
  use: (page: Page) => Promise<T>,
): Promise<T> => {
  const page = await context.newPage();
  const deadline = AbortSignal.timeout(deadlineInMs);
  // The pending call fails with the closed page; that failure is reported.
  const closePage = () => {
    void page.close().catch(() => undefined);
  };

  deadline.addEventListener('abort', closePage, { once: true });

  try {
    return await use(page);
  } catch (error) {
    if (deadline.aborted) {
      throw new Error(
        `The page did not finish rendering within ${deadlineInMs / 1000} s.`,
        { cause: error },
      );
    }

    throw error;
  } finally {
    deadline.removeEventListener('abort', closePage);
    await page.close();
  }
};

/**
 * withGuardedChromium runs `use` in a fresh browser context whose every
 * connection passes the guarding proxy, then closes both. Downloads are
 * refused, service workers blocked and media never loaded.
 */
export const withGuardedChromium = async <T>(
  use: (context: BrowserContext) => Promise<T>,
  options: { userAgent?: string; proxy?: GuardingProxyOptions } = {},
): Promise<{ result: T; connections: ConnectionCounts }> => {
  const proxy = await startGuardingProxy(options.proxy);

  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
      proxy: { server: proxy.server },
      args: chromiumArgs,
    });

    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: 'block',
        ...(options.userAgent !== undefined && {
          userAgent: options.userAgent,
        }),
      });

      await context.route('**/*', (route) => {
        return isAllowedRequest(route.request())
          ? route.continue()
          : route.abort();
      });

      const result = await use(context);

      return { result, connections: proxy.counts() };
    } finally {
      await browser.close();
    }
  } finally {
    await proxy.close();
  }
};
