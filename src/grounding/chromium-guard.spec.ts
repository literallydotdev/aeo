import type { LookupAddress } from 'node:dns';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import {
  connect,
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserContext } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startGuardingProxy,
  withBoundedPage,
  withGuardedChromium,
  type GuardingProxy,
} from './chromium-guard';

// ============================================================================
// The guarding proxy Chromium is sent through, against a fake resolver: every
// connection it allows is to port 443 of a host whose DNS answers are all
// public, dialled at the checked address. The raw CONNECT tests always run.
// The Chromium tests run where Playwright's Chromium is installed (CI has
// none) and prove the browser cannot reach around the proxy: subresources,
// navigations, WebSockets and loopback all arrive at it and are refused.
// Nothing here leaves the machine: every name resolves to a fake address and
// an allowed connection is dialled to a local server.
// ============================================================================

const publicAnswer: LookupAddress[] = [{ address: '203.0.113.10', family: 4 }];
const privateAnswer: LookupAddress[] = [{ address: '10.0.0.1', family: 4 }];

const mockLookup = vi.fn((host: string): Promise<LookupAddress[]> => {
  if (host === 'mixed.acme.example') {
    return Promise.resolve([...publicAnswer, ...privateAnswer]);
  }

  return Promise.resolve(
    host === 'www.acme.example' ? publicAnswer : privateAnswer,
  );
});

const toPort = (address: AddressInfo | string | null): number => {
  if (address === null || typeof address === 'string') {
    throw new Error('No TCP port.');
  }

  return address.port;
};

/** A local echo server standing in for the public host. */
const startEcho = async () => {
  const server = createTcpServer((socket) => {
    socket.pipe(socket);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return { server, port: toPort(server.address()) };
};

/** The first response line the proxy answers a raw request with. */
const sendRaw = async (proxy: GuardingProxy, raw: string) => {
  const socket = connect(Number(new URL(proxy.server).port), '127.0.0.1');

  await once(socket, 'connect');
  socket.write(raw);

  const [chunk] = (await once(socket, 'data')) as [Buffer];

  return { socket, statusLine: chunk.toString('latin1').split('\r\n')[0] };
};

const connectTo = (proxy: GuardingProxy, authority: string) => {
  return sendRaw(
    proxy,
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
  );
};

const opened: { close: () => unknown }[] = [];

afterEach(async () => {
  for (const resource of opened.splice(0)) {
    await resource.close();
  }
});

describe('chromium-guard - startGuardingProxy()', () => {
  it('should tunnel port 443 of a public host to the checked address', async () => {
    const echo = await startEcho();
    const dialled: string[] = [];
    const proxy = await startGuardingProxy({
      lookupHost: mockLookup,
      dial: (address) => {
        dialled.push(address.address);

        return connect(echo.port, '127.0.0.1');
      },
    });

    opened.push(proxy, echo.server);

    const { socket, statusLine } = await connectTo(
      proxy,
      'www.acme.example:443',
    );

    socket.write('ping');
    const [echoed] = (await once(socket, 'data')) as [Buffer];

    socket.destroy();
    expect(statusLine).toBe('HTTP/1.1 200 Connection Established');
    expect(echoed.toString()).toBe('ping');
    expect(dialled).toEqual(['203.0.113.10']);
    expect(proxy.counts()).toEqual({ allowed: 1, refused: 0 });
  });

  it.each([
    ['another port', 'www.acme.example:80'],
    ['a loopback address', '127.0.0.1:443'],
    ['the metadata address', '169.254.169.254:443'],
    ['an IPv6 loopback', '[::1]:443'],
    ['a name resolving to a private address', 'internal.acme.example:443'],
    [
      'a name with one private answer among public ones',
      'mixed.acme.example:443',
    ],
    ['a local name', 'printer.local:443'],
  ])('should refuse %s, dialling nothing', async (_case, authority) => {
    const dial = vi.fn<() => Socket>();
    const proxy = await startGuardingProxy({ lookupHost: mockLookup, dial });

    opened.push(proxy);

    const { socket, statusLine } = await connectTo(proxy, authority);

    socket.destroy();
    expect(statusLine).toBe('HTTP/1.1 403 Forbidden');
    expect(dial).not.toHaveBeenCalled();
    expect(proxy.counts()).toEqual({ allowed: 0, refused: 1 });
  });

  it('should refuse a plain http request and a WebSocket upgrade asked of it', async () => {
    const proxy = await startGuardingProxy({ lookupHost: mockLookup });

    opened.push(proxy);

    const plain = await sendRaw(
      proxy,
      'GET http://www.acme.example/ HTTP/1.1\r\nHost: www.acme.example\r\n\r\n',
    );
    const upgrade = await sendRaw(
      proxy,
      'GET ws://www.acme.example/ HTTP/1.1\r\nHost: www.acme.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );

    plain.socket.destroy();
    upgrade.socket.destroy();
    expect(plain.statusLine).toBe('HTTP/1.1 403 Forbidden');
    expect(upgrade.statusLine).toBe('HTTP/1.1 403 Forbidden');
    expect(proxy.counts()).toEqual({ allowed: 0, refused: 2 });
  });
});

describe('chromium-guard - withBoundedPage()', () => {
  it('should close a page that never answers past the deadline, and say why', async () => {
    let rejectPending: (error: Error) => void = () => undefined;
    const close = vi.fn(() => {
      rejectPending(new Error('Target page has been closed'));

      return Promise.resolve();
    });
    const frozenPage = {
      close,
      evaluate: () =>
        new Promise<string>((_resolve, reject) => {
          rejectPending = reject;
        }),
    };
    const context = {
      newPage: () => Promise.resolve(frozenPage),
    } as unknown as Pick<BrowserContext, 'newPage'>;

    await expect(
      withBoundedPage(context, 20, (page) => page.evaluate(() => '')),
    ).rejects.toThrow('did not finish rendering within 0.02 s');
    expect(close).toHaveBeenCalled();
  });

  it('should return what the page yields in time, and close it', async () => {
    const close = vi.fn(() => Promise.resolve());
    const context = {
      newPage: () => Promise.resolve({ close }),
    } as unknown as Pick<BrowserContext, 'newPage'>;

    await expect(
      withBoundedPage(context, 1_000, () => Promise.resolve('text')),
    ).resolves.toBe('text');
    expect(close).toHaveBeenCalledTimes(1);
  });
});

const hasChromium = await import('playwright')
  .then(({ chromium }) => chromium.launch())
  .then(async (browser) => {
    await browser.close();

    return true;
  })
  .catch(() => false);

describe.skipIf(!hasChromium)('chromium-guard - withGuardedChromium()', () => {
  it('should send every connection the page makes to the proxy, which refuses each private one', async () => {
    let localHits = 0;
    const local = createHttpServer((_request, response) => {
      localHits += 1;
      response.end('reached');
    });

    local.on('upgrade', (_request, socket: Socket) => {
      localHits += 1;
      socket.destroy();
    });
    local.listen(0, '127.0.0.1');
    await once(local, 'listening');
    opened.push(local);

    const localPort = toPort(local.address());
    const dial = vi.fn<() => Socket>();

    const { result, connections } = await withGuardedChromium(
      async (context) => {
        const page = await context.newPage();

        await page.setContent(`<img src="https://internal.acme.example/a.png">
          <img src="http://127.0.0.1:${localPort}/b.png">`);
        await page.evaluate(async (port) => {
          const attempts = [
            fetch('https://internal.acme.example/x'),
            fetch('https://127.0.0.1/'),
            fetch(`http://127.0.0.1:${port}/`),
            ...[
              'wss://internal.acme.example/',
              'wss://10.0.0.1/',
              `ws://127.0.0.1:${port}/`,
            ].map(
              (url) =>
                new Promise((resolve) => {
                  const socket = new WebSocket(url);

                  socket.onerror = resolve;
                  socket.onopen = resolve;
                }),
            ),
          ];

          await Promise.allSettled(attempts);
        }, localPort);

        const navigation = await page
          .goto('https://internal.acme.example/')
          .then(
            () => 'loaded',
            () => 'refused',
          );

        return navigation;
      },
      { proxy: { lookupHost: mockLookup, dial } },
    );

    expect(result).toBe('refused');
    expect(localHits).toBe(0);
    expect(dial).not.toHaveBeenCalled();
    expect(connections.allowed).toBe(0);
    // The image, the two https fetches, two wss sockets, the ws socket
    // tunnelled to a non-443 port and the navigation, at least.
    expect(connections.refused).toBeGreaterThanOrEqual(6);
  }, 60_000);

  it('should end the render of a page that freezes its main thread', async () => {
    const { result } = await withGuardedChromium(
      (context) => {
        return withBoundedPage(context, 1_000, async (page) => {
          await page.setContent(
            '<p>text</p><script>setTimeout(() => { while (true) {} }, 50)</script>',
          );
          await delay(200);

          return page.evaluate(() => document.body.innerText);
        }).catch((error: unknown) => String(error));
      },
      { proxy: { lookupHost: mockLookup } },
    );

    expect(result).toContain('did not finish rendering within 1 s');
  }, 30_000);
});
