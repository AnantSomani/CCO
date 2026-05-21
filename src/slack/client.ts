import { db } from '@/db/client';
import { getWorkspaceBotAccessToken } from '@/db/queries/workspaces';
import { log } from '@/lib/log';
import { err, ok, type Result } from '@/lib/result';

// Thin Slack Web API wrapper. The decrypted token lives in this closure only —
// callers never touch the plaintext. Add new methods here as they're needed by
// downstream sessions; do not call Slack outside this module.

const SLACK_API = 'https://slack.com/api';

type PostMessageInput = {
  channel: string;
  text: string;
  blocks?: unknown[];
  thread_ts?: string;
};

type PostMessageResult = { ts: string; channel: string };

type ChatUpdateInput = {
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[];
};

type ViewsOpenInput = {
  trigger_id: string;
  view: unknown;
};

type ConversationsInfoResult = {
  id: string;
  name: string;
  is_member: boolean;
};

type UsersInfoResult = {
  id: string;
  name: string | null;
  realName: string | null;
  title: string | null;
  pronouns: string | null;
  timezone: string | null;
};

export type SlackClient = {
  postMessage: (input: PostMessageInput) => Promise<Result<PostMessageResult, string>>;
  chatUpdate: (input: ChatUpdateInput) => Promise<Result<{ ts: string }, string>>;
  viewsOpen: (input: ViewsOpenInput) => Promise<Result<{ viewId: string }, string>>;
  conversationsInfo: (channel: string) => Promise<Result<ConversationsInfoResult, string>>;
  // Returns extended profile fields for the agent's `get_person_profile` tool.
  // Implementation uses GET (users.info rejects JSON body the same way
  // conversations.info does).
  usersInfo: (slackUserId: string) => Promise<Result<UsersInfoResult, string>>;
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
    const raw = (await res.json()) as {
      ok: boolean;
      error?: string;
      response_metadata?: { messages?: string[] };
    };
    if (!raw.ok) {
      log.warn('slack api error', {
        method,
        error: raw.error,
        messages: raw.response_metadata?.messages,
        workspaceId,
      });
      return err(raw.error ?? 'unknown_slack_error');
    }
    return ok(raw as T);
  };

  // Some Slack read methods (notably conversations.info) reject JSON bodies
  // with `invalid_arguments`. GET + query string is the safest form.
  const callGet = async <T>(
    method: string,
    params: Record<string, string>,
  ): Promise<Result<T, string>> => {
    const url = `${SLACK_API}/${method}?${new URLSearchParams(params).toString()}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
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
    chatUpdate: async (input) => {
      const result = await callJson<{ ok: true; ts: string }>('chat.update', input);
      if (!result.ok) return result;
      return ok({ ts: result.value.ts });
    },
    viewsOpen: async (input) => {
      // Slack's views.open requires `view` to be a JSON-encoded *string* even
      // when the request body itself is JSON. Passing the view as a nested
      // object yields `invalid_arguments`. This matches @slack/web-api's
      // behavior — it stringifies before sending.
      const result = await callJson<{ ok: true; view: { id: string } }>('views.open', {
        trigger_id: input.trigger_id,
        view: JSON.stringify(input.view),
      });
      if (!result.ok) return result;
      return ok({ viewId: result.value.view.id });
    },
    conversationsInfo: async (channel) => {
      const result = await callGet<{
        ok: true;
        channel: { id: string; name: string; is_member: boolean };
      }>('conversations.info', { channel });
      if (!result.ok) return result;
      return ok({
        id: result.value.channel.id,
        name: result.value.channel.name,
        is_member: result.value.channel.is_member,
      });
    },
    usersInfo: async (slackUserId) => {
      const result = await callGet<{
        ok: true;
        user: {
          id: string;
          name?: string;
          real_name?: string;
          tz?: string;
          profile?: {
            title?: string;
            pronouns?: string;
            real_name?: string;
            display_name?: string;
          };
        };
      }>('users.info', { user: slackUserId });
      if (!result.ok) return result;
      const u = result.value.user;
      return ok({
        id: u.id,
        name: u.name ?? null,
        realName: u.profile?.real_name ?? u.real_name ?? null,
        title: u.profile?.title ?? null,
        pronouns: u.profile?.pronouns ?? null,
        timezone: u.tz ?? null,
      });
    },
  });
};

// Function-shaped client factory used by jobs and handlers so tests can inject
// a recording stub at the boundary (per CONVENTIONS.md: "Mock the Slack client
// at the getSlackClient boundary").
export type GetSlackClient = (workspaceId: string) => Promise<Result<SlackClient, string>>;
