import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/lib/env';

// Factory-shaped client constructor so jobs and handlers inject a stub at the
// boundary (mirrors `getSlackClient` discipline from CONVENTIONS.md). Tests
// pass `scriptedAnthropic` from `tests/anthropic-stub.ts` and never make
// network calls.

export type GetAnthropicClient = () => Anthropic;

export const getAnthropicClient: GetAnthropicClient = () =>
  new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
