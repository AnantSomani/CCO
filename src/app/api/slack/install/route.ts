import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { signState } from '@/slack/state';

// Force dynamic — we mint a fresh random state on every call.
export const dynamic = 'force-dynamic';

// Bot scopes must match slack-manifest.yaml exactly. Update both together.
const BOT_SCOPES = [
  'chat:write',
  'channels:read',
  'groups:read',
  'commands',
  'users:read',
  'users:read.email',
  'im:history',
  'im:write',
].join(',');

export const GET = async (): Promise<NextResponse> => {
  const state = signState();
  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    scope: BOT_SCOPES,
    state,
    redirect_uri: `${env.APP_BASE_URL}/api/slack/oauth_callback`,
  });
  return NextResponse.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
};
