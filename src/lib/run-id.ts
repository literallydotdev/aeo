import { randomBytes } from 'node:crypto';

// ============================================================================
// Run identity (hardening spec §4.2): every run carries a ULID minted by the
// caller — the CLI mints one here; an API reuses its submission id so a
// redelivered message is the same run. Crockford base32, 48-bit millisecond
// timestamp + 80 random bits, lexically sortable by creation time.
// ============================================================================

const crockfordAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const timeCharCount = 10;
const randomCharCount = 16;

export const mintRunId = (nowMs: number = Date.now()): string => {
  let remainingTime = nowMs;
  let timePart = '';

  for (let i = 0; i < timeCharCount; i += 1) {
    timePart = `${crockfordAlphabet.charAt(remainingTime % 32)}${timePart}`;
    remainingTime = Math.floor(remainingTime / 32);
  }

  const bytes = randomBytes(randomCharCount);
  let randomPart = '';

  for (const byte of bytes) {
    randomPart += crockfordAlphabet.charAt(byte % 32);
  }

  const runId = `${timePart}${randomPart}`;

  return runId;
};

const runIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const isRunId = (value: string): boolean => {
  return runIdPattern.test(value);
};
