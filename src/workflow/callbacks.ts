import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { ApiError } from '../api/errors';

const signatureToleranceSeconds = 300;
const deliveryTimeoutMs = 5000;

type SignCallbackOptions = {
  timestampInSeconds?: number;
};

export const signCallback = (
  rawBody: string,
  secret: string,
  {
    timestampInSeconds = Math.floor(Date.now() / 1000),
  }: SignCallbackOptions = {},
): string => {
  const digest = createHmac('sha256', secret)
    .update(`${timestampInSeconds}.${rawBody}`)
    .digest('hex');

  return `t=${timestampInSeconds},v1=${digest}`;
};

type VerifyCallbackOptions = {
  signature: string | null;
  secret: string;
  nowMs?: number;
};

export const verifyCallback = (
  rawBody: string,
  { signature, secret, nowMs = Date.now() }: VerifyCallbackOptions,
): boolean => {
  const match = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(signature ?? '');

  if (!match || !secret) {
    return false;
  }

  const [, timestampText, digestHex] = match;

  if (timestampText === undefined || digestHex === undefined) {
    return false;
  }

  const ageInSeconds = Math.abs(nowMs / 1000 - Number(timestampText));

  if (ageInSeconds > signatureToleranceSeconds) {
    return false;
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestampText}.${rawBody}`)
    .digest();

  return timingSafeEqual(expected, Buffer.from(digestHex, 'hex'));
};

export const isPublicAddress = (address: string): boolean => {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);

    if (a === undefined || b === undefined) {
      return false;
    }

    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  // IPv4-mapped and non-global IPv6 are rejected, avoiding alternate forms of
  // private hosts.
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !address.toLowerCase().startsWith('2001:db8:')
  );
};

export const validateCallbackUrl = (
  value: string,
  hosts: readonly string[],
): URL => {
  const url = new URL(value);

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !hosts.includes(url.hostname) ||
    isIP(url.hostname)
  ) {
    throw new ApiError(
      'invalid_request',
      'Callback URL must use an approved HTTPS host and default port',
    );
  }

  return url;
};

export type DeliverCallbackOptions = {
  rawBody: string;
  signature: string;
};

/**
 * deliverCallback connects to the validated DNS answer, keeping TLS SNI on the
 * approved host.
 */
export const deliverCallback = async (
  url: URL,
  { rawBody, signature }: DeliverCallbackOptions,
): Promise<void> => {
  const controller = new AbortController();

  const deadline = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        reject(new Error(`Callback delivery timed out for ${url.hostname}.`));
      },
      { once: true },
    );
  });

  const timeout = setTimeout(() => {
    controller.abort();
  }, deliveryTimeoutMs);

  try {
    // DNS consumes the same deadline as HTTP; a late lookup must never send.
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true }),
      deadline,
    ]);

    const [pinned] = addresses;

    if (!pinned || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new Error(
        `Callback DNS must resolve only to public addresses: ${url.hostname}.`,
      );
    }

    await new Promise<void>((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(rawBody),
            'x-aeo-signature': signature,
          },
          lookup: (_host, options, callback) => {
            if (options.all) {
              callback(null, [pinned]);
            } else {
              callback(null, pinned.address, pinned.family);
            }
          },
          signal: controller.signal,
        },
        (res) => {
          res.resume();

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(
              new Error(
                `Callback delivery returned HTTP ${res.statusCode ?? 'without a status'}.`,
              ),
            );
          }
        },
      );

      req.once('error', reject);
      req.end(rawBody);
    });
  } finally {
    clearTimeout(timeout);
  }
};
