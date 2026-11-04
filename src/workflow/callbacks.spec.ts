import { describe, expect, it } from 'vitest';
import {
  isPublicAddress,
  signCallback,
  validateCallbackUrl,
  verifyCallback,
} from './callbacks';
import { pipelineCallbackSchema } from './schema';

describe('Callbacks - verifyCallback()', () => {
  it('should authenticate exact body bytes within a five-minute timestamp window', () => {
    const secret = 'test-secret';
    const body = '{"eventId":"1"}';
    const signature = signCallback(body, secret, {
      timestampInSeconds: 1800000000,
    });

    const exact = verifyCallback(body, {
      signature,
      secret,
      nowMs: 1800000000_000,
    });
    const changedBody = verifyCallback(`${body} `, {
      signature,
      secret,
      nowMs: 1800000000_000,
    });
    const tooLate = verifyCallback(body, {
      signature,
      secret,
      nowMs: 1800000301_000,
    });
    const tooEarly = verifyCallback(body, {
      signature,
      secret,
      nowMs: 1799999699_000,
    });
    const malformed = verifyCallback(body, { signature: 't=1,v1=a', secret });

    expect(exact).toBe(true);
    expect(changedBody).toBe(false);
    expect(tooLate).toBe(false);
    expect(tooEarly).toBe(false);
    expect(malformed).toBe(false);
  });
});

describe('Callbacks - validateCallbackUrl()', () => {
  it('should refuse arbitrary hosts, credentials, alternate ports and protocols', () => {
    const hosts = ['www.literally.dev'];

    expect(
      validateCallbackUrl(
        'https://www.literally.dev/api/aeo/pipeline-events',
        hosts,
      ).hostname,
    ).toBe(hosts[0]);

    for (const url of [
      'http://www.literally.dev/x',
      'https://www.literally.dev:8443/x',
      'https://user:pass@www.literally.dev/x',
      'https://foo.vercel.app/x',
      'https://www.literally.dev.evil.test/x',
    ]) {
      expect(() => validateCallbackUrl(url, hosts)).toThrow();
    }
  });
});

describe('Callbacks - isPublicAddress()', () => {
  it('should refuse private, link local and mapped private addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.2',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.1.1',
      '::1',
      '::ffff:127.0.0.1',
      'fe80::1',
      'fc00::1',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }

    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
});

describe('Callbacks - pipelineCallbackSchema', () => {
  it('should ignore a field a newer sender adds instead of refusing the event', () => {
    const body = {
      eventId: 'evt-1',
      event: 'pipeline_failed',
      pipelineId: 'pipe-2',
      retryAncestorIds: ['pipe-1'],
      reportKey: 'company',
      status: 'failed',
      reason: 'harness_crashed',
      reportUrl: null,
      gate: null,
      gateId: null,
      gateTarget: null,
      sentAt: '2026-09-14T00:00:00.000Z',
    };

    const parsed = pipelineCallbackSchema.parse({
      ...body,
      addedInALaterRelease: { anything: true },
    });

    expect(parsed).toEqual(body);
  });
});
