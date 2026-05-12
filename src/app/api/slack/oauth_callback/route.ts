import { type NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { upsertUser } from '@/db/queries/users';
import { upsertWorkspace } from '@/db/queries/workspaces';
import { env } from '@/lib/env';
import { log } from '@/lib/log';
import { COOKIE_MAX_AGE_SECONDS, signUploadCookie, UPLOAD_COOKIE_NAME } from '@/lib/upload-cookie';
import { oauthAccessSchema, oauthCallbackSchema } from '@/slack/schemas';
import { verifyState } from '@/slack/state';

export const dynamic = 'force-dynamic';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const htmlResponse = (status: number, body: string): NextResponse =>
  new NextResponse(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

const errorPage = (status: number, message: string): NextResponse =>
  htmlResponse(
    status,
    `<html><body style="font-family:sans-serif;padding:2rem"><h1>Install failed</h1><p>${escapeHtml(message)}</p></body></html>`,
  );

export const GET = async (req: NextRequest): Promise<NextResponse> => {
  const url = new URL(req.url);
  const queryParseResult = oauthCallbackSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!queryParseResult.success) {
    return errorPage(400, 'Invalid OAuth callback parameters.');
  }
  const { code, state, error: userError } = queryParseResult.data;

  if (userError) {
    log.info('oauth user denied', { error: userError });
    return errorPage(400, `Slack reported an error: ${userError}`);
  }
  if (!code) {
    return errorPage(400, 'Missing authorization code.');
  }

  const stateResult = verifyState(state);
  if (!stateResult.ok) {
    log.warn('oauth state verification failed', { reason: stateResult.error });
    return errorPage(400, 'OAuth state verification failed. Please start the install again.');
  }

  const tokenExchange = new URLSearchParams({
    code,
    client_id: env.SLACK_CLIENT_ID,
    client_secret: env.SLACK_CLIENT_SECRET,
    redirect_uri: `${env.APP_BASE_URL}/api/slack/oauth_callback`,
  });

  const slackResp = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenExchange.toString(),
  });
  const slackBody: unknown = await slackResp.json();

  const accessResult = oauthAccessSchema.safeParse(slackBody);
  if (!accessResult.success) {
    log.error('oauth.v2.access response failed schema validation', {
      issues: accessResult.error.issues,
    });
    return errorPage(502, 'Slack returned an unexpected response shape.');
  }
  if (!accessResult.data.ok) {
    log.warn('oauth.v2.access returned ok:false', { error: accessResult.data.error });
    return errorPage(400, `Slack OAuth error: ${accessResult.data.error}`);
  }

  const oauth = accessResult.data;
  const workspace = await upsertWorkspace(db, {
    slackTeamId: oauth.team.id,
    slackTeamName: oauth.team.name,
    installedBySlackUser: oauth.authed_user.id,
    botAccessToken: oauth.access_token,
  });
  await upsertUser(db, {
    workspaceId: workspace.id,
    slackUserId: oauth.authed_user.id,
    isAdmin: true,
  });

  log.info('workspace installed', {
    workspaceId: workspace.id,
    slackTeamId: oauth.team.id,
    installedBy: oauth.authed_user.id,
  });

  const response = htmlResponse(
    200,
    `<html><body style="font-family:sans-serif;padding:3rem;max-width:640px;margin:0 auto;line-height:1.5">
      <h1>🎉 Installed</h1>
      <p>Confetti is now in <strong>${escapeHtml(oauth.team.name)}</strong>.</p>
      <p><a href="/upload" style="display:inline-block;padding:0.6rem 1rem;background:#4a154b;color:#fff;text-decoration:none;border-radius:4px">Upload your team CSV →</a></p>
      <p style="color:#666;font-size:0.9rem">Or try <code>/confetti hello</code> in any channel.</p>
    </body></html>`,
  );
  response.cookies.set(UPLOAD_COOKIE_NAME, signUploadCookie(workspace.id, oauth.team.id), {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: '/',
  });
  return response;
};
