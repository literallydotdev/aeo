import { z } from 'zod';

/** Coverage gate shared by local runs and full-scope pipeline requests. */
export const coverageThresholdsSchema = z.object({
  blockAtZero: z.boolean().default(true),
  minCapturedRatio: z.number().min(0).max(1).default(0.5),
});
