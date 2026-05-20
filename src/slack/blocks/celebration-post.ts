// The day-of celebration message posted to the workspace's celebration channel.
// Hardcoded message templates in session 4 — voice tuning lands in session 5
// when the agent generates these.
//
// `slackUserId` lets us @-mention the person if they have a Slack account;
// otherwise we fall back to their first name.

type CelebrationPostInput = {
  person: { name: string; slackUserId: string | null };
  kind: 'birthday' | 'anniversary';
  years?: number | null;
  customGestureText?: string | null;
  suggestionSummary?: string | null;
};

export type BuiltMessage = { blocks: unknown[]; text: string };

const firstName = (name: string): string => (name.split(/\s+/)[0] ?? name).trim() || name;

const mention = (person: { name: string; slackUserId: string | null }): string =>
  person.slackUserId ? `<@${person.slackUserId}>` : firstName(person.name);

const headline = (
  person: { name: string; slackUserId: string | null },
  kind: 'birthday' | 'anniversary',
  years?: number | null,
): string => {
  const who = mention(person);
  if (kind === 'birthday') {
    return `🎉 Happy birthday, ${who}! Sending you a great day from the whole team.`;
  }
  const n = years ?? 0;
  return `🎉 ${n} years at the team today, ${who}! What a run.`;
};

export const buildCelebrationPost = ({
  person,
  kind,
  years,
  customGestureText,
  suggestionSummary,
}: CelebrationPostInput): BuiltMessage => {
  const top = headline(person, kind, years);
  const gesture = customGestureText ?? suggestionSummary ?? null;

  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: top },
    },
  ];

  if (gesture) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `From the team: _${gesture}_` }],
    });
  }

  return { blocks, text: top };
};

export const CARD_THREAD_PROMPT = (person: { name: string }): string =>
  `👇 sign the card for ${firstName(person.name)}!`;
