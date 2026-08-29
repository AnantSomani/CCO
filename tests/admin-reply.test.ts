import { describe, expect, it } from 'vitest';
import { honestAdminReply } from '@/agent/admin-reply';
import { summarizeMenuItemPrice } from '@/integrations/doordash/prices';

describe('honestAdminReply', () => {
  it('replaces a fake submit when no proposal was created', () => {
    expect(
      honestAdminReply(
        'No required customizations needed — confirmed! Submitting the DoorDash cart preview for Slack approval now...',
        0,
        null,
      ),
    ).toContain('I could not prepare an approval card yet');
  });

  it('keeps a normal question when nothing was proposed', () => {
    expect(honestAdminReply('Which crust do you want?', 0, null)).toBe('Which crust do you want?');
  });

  it('replaces a fake DoorDash outage when no proposal was created', () => {
    const reply = honestAdminReply(
      "DoorDash's system keeps returning an error. Place the order directly on DoorDash or contact Confetti support.",
      0,
      'Ask the user to pick required options for Cheese: Crust, Sauce, Toppings. Do not guess.',
    );
    expect(reply).toContain(
      'Ask the user to pick required options for Cheese: Crust, Sauce, Toppings',
    );
    expect(reply).not.toContain('Place the order directly');
  });

  it('confirms a card only after a proposal exists', () => {
    expect(honestAdminReply('Submitting for Slack approval now...', 1, null)).toBe(
      'I prepared an approval card. Nothing has been ordered or charged.',
    );
  });
});

describe('summarizeMenuItemPrice', () => {
  it('treats integer DoorDash prices as cents', () => {
    expect(summarizeMenuItemPrice(2498, null)).toEqual({
      priceCents: 2498,
      priceDisplay: '$24.98',
    });
  });
});
