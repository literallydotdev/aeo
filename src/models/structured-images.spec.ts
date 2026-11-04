import type * as ai from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { z } from 'zod';
import { createMemoryModelAccounting } from './accounting';
import { testModelProfileFixture } from './profile-fixture';
import { generateStructured, structuredCallReservation } from './structured';
import type { StructuredImage } from './structured-images';

const provider = vi.hoisted(() => ({
  generateText: vi.fn(),
  gateway: vi.fn((id: string) => `gateway:${id}`),
}));

vi.mock('ai', async () => {
  const { streamedResult } = await import('./stream-result-fixture');

  return {
    ...(await vi.importActual<typeof ai>('ai')),
    // The transport streams; these tests describe one settled answer.
    streamText: (options: unknown) =>
      streamedResult(provider.generateText(options)),
  };
});

vi.mock('@ai-sdk/gateway', () => ({
  gateway: provider.gateway,
  createGateway: () => provider.gateway,
}));

beforeEach(() => {
  vi.clearAllMocks();
  provider.generateText.mockResolvedValue({
    output: { valid: true },
    usage: {
      inputTokens: 500,
      outputTokens: 10,
      inputTokenDetails: {},
      outputTokenDetails: {},
    },
    response: { id: 'visual-request', modelId: 'claude-opus-4-6' },
    finishReason: 'stop',
    providerMetadata: { gateway: { cost: '0.01' } },
  });
});

type StreamRequest = {
  model?: unknown;
  prompt?: unknown;
  tools?: unknown;
  maxRetries?: unknown;
  messages?: { content: unknown[] }[];
};

const getStreamRequest = (index: number) => {
  return provider.generateText.mock.calls[index]?.[0] as StreamRequest;
};

const requireValue = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error('Expected a value in the test fixture.');
  }

  return value;
};

const createFixture = async () => {
  const bytes = await sharp({
    create: { width: 256, height: 256, channels: 4, background: '#000' },
  })
    .png()
    .toBuffer();
  const secondBytes = await sharp({
    create: { width: 256, height: 256, channels: 4, background: '#fff' },
  })
    .png()
    .toBuffer();
  const accounting = createMemoryModelAccounting({
    maxUsd: 5,
    maxTokens: 100_000,
    deadlineAt: '2099-01-01T00:00:00.000Z',
  });

  const firstImage = { id: 'image_one', bytes };
  const secondImage = { id: 'image_two', bytes: secondBytes };

  return {
    roleName: 'logoDiscovery',
    role: requireValue(testModelProfileFixture().roles.logoDiscovery),
    schema: z.object({ valid: z.boolean() }).strict(),
    prompt: 'Choose a clear company mark from these candidates.',
    images: [firstImage, secondImage],
    firstImage,
    secondImage,
    accounting,
  };
};

describe('structured - generateStructured() with images', () => {
  it('should send the actual PNG bytes with exact candidate labels and retain provider usage', async () => {
    const { firstImage, secondImage, ...input } = await createFixture();

    await generateStructured(input);

    const request = getStreamRequest(0);
    const [call] = Object.values(input.accounting.state.calls);

    expect(request.model).toBe(`gateway:${input.role.model}`);
    expect(request.prompt).toBeUndefined();
    expect(request.tools).toBeUndefined();
    expect(request.maxRetries).toBe(0);
    expect(request.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image image_one:' },
          {
            type: 'image',
            image: firstImage.bytes,
            mediaType: 'image/png',
          },
          { type: 'text', text: 'Image image_two:' },
          {
            type: 'image',
            image: secondImage.bytes,
            mediaType: 'image/png',
          },
          { type: 'text', text: input.prompt },
        ],
      },
    ]);
    expect(call?.inputTokens).toBeGreaterThan(
      structuredCallReservation({ ...input, images: undefined }).inputTokens +
        4096,
    );
    expect(call?.usage).toMatchObject({
      costUsd: 0.01,
      inputTokens: 500,
      requestId: 'visual-request',
    });
  });

  it('should reject image input above the role token limit before spending or dispatching', async () => {
    const input = await createFixture();
    const textOnly = structuredCallReservation({ ...input, images: undefined });

    const result = generateStructured({
      ...input,
      role: { ...input.role, maxInputTokens: textOnly.inputTokens + 4096 },
    });

    await expect(result).rejects.toThrow('model_input_limit');
    expect(provider.generateText).not.toHaveBeenCalled();
    expect(Object.keys(input.accounting.state.calls)).toHaveLength(0);
  });

  it('should include visual input in the dollar and shared token reservation', async () => {
    const input = await createFixture();
    const without = structuredCallReservation({ ...input, images: undefined });
    const withImages = structuredCallReservation(input);
    const limitCases = [
      { maxUsd: without.reservedUsd, maxTokens: 100_000 },
      {
        maxUsd: 5,
        maxTokens: without.inputTokens + input.role.maxOutputTokens,
      },
    ];

    expect(withImages.reservedUsd).toBeGreaterThan(without.reservedUsd);

    for (const limits of limitCases) {
      const accounting = createMemoryModelAccounting({
        ...limits,
        deadlineAt: '2099-01-01T00:00:00.000Z',
      });

      const result = generateStructured({ ...input, accounting });

      await expect(result).rejects.toThrow(
        'Insufficient remaining model budget',
      );
      expect(Object.keys(accounting.state.calls)).toHaveLength(0);
    }

    expect(provider.generateText).not.toHaveBeenCalled();
  });

  it('should refuse invalid, oversized, duplicate or remote image inputs before any call', async () => {
    const input = await createFixture();
    const { firstImage } = input;
    const tooWide = Buffer.from(firstImage.bytes);

    tooWide.writeUInt32BE(1025, 16);

    const badInputs: StructuredImage[][] = [
      [{ id: 'image_one', bytes: Buffer.from('<svg>untrusted</svg>') }],
      [{ id: 'image_one', bytes: tooWide }],
      [
        {
          id: 'image_one',
          bytes: Buffer.concat([firstImage.bytes, Buffer.alloc(524_288)]),
        },
      ],
      [
        {
          id: 'image_one',
          bytes: 'https://example.com/logo.png' as unknown as Uint8Array,
        },
      ],
      [{ ...firstImage, id: 'image\nInjected label' }],
      [firstImage, firstImage],
      Array.from({ length: 7 }, (_, index) => ({
        ...firstImage,
        id: `image_${index}`,
      })),
    ];

    for (const images of badInputs) {
      await expect(generateStructured({ ...input, images })).rejects.toThrow(
        'model_image_invalid',
      );
    }

    expect(provider.generateText).not.toHaveBeenCalled();
    expect(Object.keys(input.accounting.state.calls)).toHaveLength(0);
  });

  it('should require a model with a known vision reservation and leave text requests unchanged', async () => {
    const input = await createFixture();
    const role = {
      ...testModelProfileFixture().roles.copy,
      model: 'provider/text-only-model',
    };

    await expect(generateStructured({ ...input, role })).rejects.toThrow(
      'model_image_unsupported',
    );

    await generateStructured({ ...input, role, images: undefined });

    const request = getStreamRequest(0);

    expect(request.prompt).toBe(input.prompt);
    expect(request.messages).toBeUndefined();
    expect(provider.generateText).toHaveBeenCalledOnce();
  });

  it('should reserve vision input the same way for every model with a known reservation', async () => {
    const input = await createFixture();
    const other = {
      ...requireValue(testModelProfileFixture().roles.logoDiscovery),
      model: 'anthropic/claude-sonnet-5.5',
    };

    expect(
      structuredCallReservation({ ...input, role: other }).inputTokens,
    ).toBe(structuredCallReservation(input).inputTokens);

    await generateStructured({ ...input, role: other });

    const request = getStreamRequest(0);

    expect(request.model).toBe('gateway:anthropic/claude-sonnet-5.5');
    expect(request.messages?.[0]?.content).toHaveLength(5);
  });
});
