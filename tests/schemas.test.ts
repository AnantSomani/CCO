import { describe, expect, it } from 'vitest';
import { oauthAccessSchema, oauthCallbackSchema, slashCommandSchema } from '@/slack/schemas';

describe('slashCommandSchema', () => {
  const valid = {
    team_id: 'T123',
    user_id: 'U123',
    command: '/confetti',
    text: 'hello',
    response_url: 'https://hooks.slack.com/commands/T123/123/abc',
    trigger_id: 'trig123',
  };

  it('parses a valid slash command payload', () => {
    const result = slashCommandSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('defaults missing text to empty string', () => {
    const { text: _omit, ...rest } = valid;
    const result = slashCommandSchema.parse(rest);
    expect(result.text).toBe('');
  });

  it('rejects missing team_id', () => {
    const { team_id: _omit, ...rest } = valid;
    expect(slashCommandSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects non-url response_url', () => {
    expect(slashCommandSchema.safeParse({ ...valid, response_url: 'not-a-url' }).success).toBe(
      false,
    );
  });
});

describe('oauthCallbackSchema', () => {
  it('accepts code + state (success path)', () => {
    expect(oauthCallbackSchema.safeParse({ code: 'c', state: 's' }).success).toBe(true);
  });

  it('accepts error + state (user-denied path)', () => {
    expect(oauthCallbackSchema.safeParse({ error: 'access_denied', state: 's' }).success).toBe(
      true,
    );
  });

  it('rejects state with neither code nor error', () => {
    expect(oauthCallbackSchema.safeParse({ state: 's' }).success).toBe(false);
  });

  it('rejects missing state', () => {
    expect(oauthCallbackSchema.safeParse({ code: 'c' }).success).toBe(false);
  });
});

describe('oauthAccessSchema', () => {
  const success = {
    ok: true,
    access_token: 'xoxb-1234',
    token_type: 'bot',
    scope: 'chat:write,commands',
    bot_user_id: 'B1',
    app_id: 'A1',
    team: { id: 'T1', name: 'Acme' },
    authed_user: { id: 'U1' },
  };

  it('parses an ok:true response', () => {
    const result = oauthAccessSchema.safeParse(success);
    expect(result.success).toBe(true);
  });

  it('parses an ok:false response', () => {
    const result = oauthAccessSchema.safeParse({ ok: false, error: 'invalid_code' });
    expect(result.success).toBe(true);
  });

  it('rejects token_type other than bot', () => {
    expect(oauthAccessSchema.safeParse({ ...success, token_type: 'user' }).success).toBe(false);
  });

  it('rejects missing team.name', () => {
    expect(oauthAccessSchema.safeParse({ ...success, team: { id: 'T1' } }).success).toBe(false);
  });
});
