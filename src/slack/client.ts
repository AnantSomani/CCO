import { db } from '@/db/client';
import { getWorkspaceBotAccessToken } from '@/db/queries/workspaces';
import { log } from '@/lib/log';
import { err, ok, type Result } from '@/lib/result';

// Thin Slack Web API wrapper. The decrypted token lives in this closure only —
// callers never touch the plaintext. Add new methods here as they're needed by
// downstream sessions; do not call Slack outside this module.
//
// Methods exposed today: postMessage (used starting in Session 3 / Week 3 for
// approval DMs and celebration posts). usersInfo / openView land when their
// callers do.

const SLACK_API = 'https://slack.com/api';

type PostMessageInput = {
  channel: string;
  text: string;
  blocks?: unknown[];
  thread_ts?: string;
};

type PostMessageResult = { ts: string; channel: string };

export type SlackClient = {
  postMessage: (input: PostMessageInput) => Promise<Result<PostMessageResult, string>>;
};

export const getSlackClient = async (workspaceId: string): Promise<Result<SlackClient, string>> => {
  const token = await getWorkspaceBotAccessToken(db, workspaceId);
  if (!token) return err(`no token for workspace ${workspaceId}`);

  // NEVER log `token`. Log `workspaceId` only.
  const callJson = async <T>(method: string, body: object): Promise<Result<T, string>> => {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const raw = (await res.json()) as { ok: boolean; error?: string };
    if (!raw.ok) {
      log.warn('slack api error', { method, error: raw.error, workspaceId });
      return err(raw.error ?? 'unknown_slack_error');
    }
    return ok(raw as T);
  };

  return ok({
    postMessage: async (input) => {
      const result = await callJson<{ ok: true; ts: string; channel: string }>(
        'chat.postMessage',
        input,
      );
      if (!result.ok) return result;
      return ok({ ts: result.value.ts, channel: result.value.channel });
    },
  });
};
