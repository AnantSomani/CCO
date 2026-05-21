import { ok } from '@/lib/result';
import type { GetSlackClient, SlackClient } from '@/slack/client';

// Recording fake for the Slack client. Each Slack method records its inputs
// into a shared arrays bag so tests can assert what was sent. All methods
// return synthetic success results — failure-path testing should construct a
// bespoke stub for the case under test.

export type RecordedPostMessage = {
  channel: string;
  text: string;
  blocks?: unknown[];
  thread_ts?: string;
};

export type RecordedChatUpdate = {
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[];
};

export type RecordedViewsOpen = { trigger_id: string; view: unknown };

export type RecordingSlackClient = {
  posts?: RecordedPostMessage[];
  chatUpdates?: RecordedChatUpdate[];
  viewsOpens?: RecordedViewsOpen[];
  // Optional override for conversations.info (used by /confetti channel test).
  conversationsInfoResult?: {
    ok: true;
    value: { id: string; name: string; is_member: boolean };
  };
};

// Drop-in `getSlackClient` replacement. Same arity, same return shape.
export const recordingSlackClientFactory = (recorder: RecordingSlackClient): GetSlackClient => {
  recorder.posts ??= [];
  recorder.chatUpdates ??= [];
  recorder.viewsOpens ??= [];

  const client: SlackClient = {
    postMessage: async (input) => {
      recorder.posts?.push({ ...input });
      // Use the channel id verbatim for DM-style posts (channel === user id)
      // and assign a stable synthetic ts so tests can assert on it.
      return ok({
        channel: input.channel.startsWith('U') ? `D_${input.channel}` : input.channel,
        ts: `${Date.now()}.${recorder.posts?.length ?? 0}`,
      });
    },
    chatUpdate: async (input) => {
      recorder.chatUpdates?.push({ ...input });
      return ok({ ts: input.ts });
    },
    viewsOpen: async (input) => {
      recorder.viewsOpens?.push({ ...input });
      return ok({ viewId: `V_${recorder.viewsOpens?.length ?? 0}` });
    },
    conversationsInfo: async (channel) => {
      if (recorder.conversationsInfoResult) return recorder.conversationsInfoResult;
      return ok({ id: channel, name: 'stub', is_member: true });
    },
    usersInfo: async (slackUserId) => {
      return ok({
        id: slackUserId,
        name: null,
        realName: null,
        title: null,
        pronouns: null,
        timezone: null,
      });
    },
  };

  return async () => ok(client);
};

// ─── recording event emitter ────────────────────────────────────────────────
export type SentEvent = { name: string; ts?: number; data: Record<string, unknown> };

export const recordingEmitter = (sink: SentEvent[]) => ({
  send: async (event: SentEvent): Promise<unknown> => {
    sink.push(event);
    return undefined;
  },
});
