import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportRun } from '../bundle/export';
import { readBundleSource } from '../bundle/read';
import { createSyntheticRun } from '../bundle/__fixtures__/synthetic-run';
import { startViewer, type ViewerServer } from './server';

let root: string;
let viewer: ViewerServer;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aeo-viewer-'));

  const run = await createSyntheticRun(path.join(root, 'run'));
  const { archive } = await exportRun(run.dir);
  const source = await readBundleSource(archive);

  viewer = await startViewer({ ...source, workingState: false });
});

afterEach(async () => {
  await viewer.close();
  await rm(root, { recursive: true, force: true });
});

/** A raw request, so the test controls headers fetch() will not let it set. */
const get = (
  url: string,
  { host, method = 'GET' }: { host?: string; method?: string } = {},
) => {
  const target = new URL(url);

  return new Promise<{
    status: number;
    body: string;
    headers: Record<string, unknown>;
  }>((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: { host: host ?? target.host },
      },
      (response) => {
        let body = '';

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body,
            headers: response.headers,
          });
        });
      },
    );

    outgoing.on('error', reject);
    outgoing.end();
  });
};

const withPath = (pathname: string) => {
  const url = new URL(viewer.url);

  url.pathname = pathname;

  return url.toString();
};

describe('viewer - startViewer()', () => {
  it('should serve the page on loopback with a restrictive content security policy', async () => {
    const response = await get(viewer.url);

    expect(new URL(viewer.url).hostname).toBe('127.0.0.1');
    expect(response.status).toBe(200);
    expect(String(response.headers['content-security-policy'])).toContain(
      "default-src 'none'",
    );
    expect(response.body).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  });

  it('should refuse a request without the launch token', async () => {
    const url = new URL(viewer.url);

    url.searchParams.set('t', 'wrong');
    const response = await get(url.toString());

    expect(response.status).toBe(403);
  });

  it('should refuse a foreign Host header, as a DNS rebinding page would send', async () => {
    const response = await get(viewer.url, { host: 'attacker.example:80' });

    expect(response.status).toBe(403);
  });

  it('should refuse anything but GET', async () => {
    const response = await get(viewer.url, { method: 'POST' });

    expect(response.status).toBe(403);
  });

  it('should serve bundle documents and the verification, and nothing else', async () => {
    const snapshot = await get(withPath('/data/report/snapshot.json'));
    const verification = await get(withPath('/data/__verification'));
    const outside = await get(withPath('/data/../../../etc/passwd'));
    const unknown = await get(withPath('/data/report/nope.json'));

    expect(snapshot.status).toBe(200);
    expect(JSON.parse(verification.body)).toMatchObject({ exitCode: 3 });
    expect(outside.status).toBe(404);
    expect(unknown.status).toBe(404);
  });
});
