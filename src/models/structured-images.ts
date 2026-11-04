import type { ModelMessage } from 'ai';

export type StructuredImage = {
  id: string;
  /** Host-decoded, normalized PNG bytes; remote URLs are never accepted. */
  bytes: Uint8Array;
};

/** Models that accept image input, with the visual tokens reserved per
 * image before dispatch; settlement uses the provider's reported usage.
 * Opus 4.6's standard vision tier uses at most 1,568 tokens per image
 * (https://platform.claude.com/docs/en/build-with-claude/vision); Kimi K3
 * billed about 700 for a 1024x512 PNG through the gateway on 2026-09-11.
 * 2,048 covers either with framing. */
const imageTokenReserve: Readonly<Record<string, number>> = {
  'anthropic/claude-opus-4.6': 2048,
  'moonshotai/kimi-k3': 2048,
};

export const supportsImageInput = (model: string): boolean => {
  return model in imageTokenReserve;
};

export const structuredImageTokens = (
  images: readonly StructuredImage[] | undefined,
  model: string,
): number => {
  if (!images?.length) {
    return 0;
  }

  const reservePerImage = imageTokenReserve[model];

  if (!reservePerImage) {
    throw new Error('model_image_unsupported');
  }

  if (
    images.length > 6 ||
    new Set(images.map(({ id }) => id)).size !== images.length
  ) {
    throw new Error('model_image_invalid');
  }

  for (const image of images) {
    if (
      !/^[a-zA-Z0-9_-]{1,80}$/.test(image.id) ||
      !(image.bytes instanceof Uint8Array)
    ) {
      throw new Error('model_image_invalid');
    }

    const bytes = Buffer.from(
      image.bytes.buffer,
      image.bytes.byteOffset,
      image.bytes.byteLength,
    );

    if (
      bytes.length < 33 ||
      bytes.length > 524_288 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.subarray(12, 16).toString('ascii') !== 'IHDR' ||
      bytes.readUInt32BE(16) < 1 ||
      bytes.readUInt32BE(16) > 1024 ||
      bytes.readUInt32BE(20) < 1 ||
      bytes.readUInt32BE(20) > 512
    ) {
      throw new Error('model_image_invalid');
    }
  }

  return images.length * reservePerImage;
};

export const structuredImageMessages = (
  prompt: string,
  images: readonly StructuredImage[],
): ModelMessage[] => {
  return [
    {
      role: 'user',
      content: [
        ...images.flatMap(({ id, bytes }) => [
          { type: 'text' as const, text: `Image ${id}:` },
          { type: 'image' as const, image: bytes, mediaType: 'image/png' },
        ]),
        { type: 'text', text: prompt },
      ],
    },
  ];
};
