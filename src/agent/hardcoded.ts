// TODO: replace with agent in session 5.
//
// Stand-in for the real Anthropic-powered suggestion generator. The only
// reason this file exists is so we can wire and ship the full approval flow
// (DM → buttons → modal → day-of post → spend log) without depending on the
// agent. Session 5 swaps this single export out for `src/agent/index.ts`.

import type { NewSuggestionInput } from '@/db/queries/suggestions';
import { log } from '@/lib/log';

type Person = { name: string };
type Workspace = { id: string; defaultBudgetCents: number };
type Event = { kind: 'birthday' | 'anniversary'; years: number | null };

export type HardcodedInput = {
  event: Event;
  person: Person;
  workspace: Workspace;
};

const firstName = (name: string): string => (name.split(/\s+/)[0] ?? name).trim() || name;

// Templates carry their own (intended) cost. We clamp to the workspace's
// default budget at the end so a hardcoded $120 lunch can't blow through a
// $50 default — the agent in session 5 will respect budget natively.
type Template = { summaryTemplate: string; intendedCostCents: number; rank: number };

const BIRTHDAY_TEMPLATES: Template[] = [
  {
    summaryTemplate: 'Card from the team + $30 DoorDash gift card',
    intendedCostCents: 4500,
    rank: 1,
  },
  {
    summaryTemplate: 'Surprise cake at next standup',
    intendedCostCents: 6500,
    rank: 2,
  },
];

const ANNIVERSARY_TEMPLATES: Template[] = [
  {
    summaryTemplate: 'Team-signed card',
    intendedCostCents: 1500,
    rank: 1,
  },
  {
    summaryTemplate: 'Lunch on the company for {person} + their pod',
    intendedCostCents: 12000,
    rank: 2,
  },
];

const render = (template: string, person: Person): string =>
  template.replace(/\{person\}/g, firstName(person.name));

export const generateHardcodedSuggestions = ({
  event,
  person,
  workspace,
}: HardcodedInput): NewSuggestionInput[] => {
  const templates = event.kind === 'birthday' ? BIRTHDAY_TEMPLATES : ANNIVERSARY_TEMPLATES;
  const budget = workspace.defaultBudgetCents;
  return templates.map((t) => {
    const clampedCost = Math.min(t.intendedCostCents, budget);
    if (clampedCost < t.intendedCostCents) {
      log.warn('hardcoded suggestion cost clamped to workspace budget', {
        workspaceId: workspace.id,
        kind: event.kind,
        rank: t.rank,
        intendedCostCents: t.intendedCostCents,
        budgetCents: budget,
      });
    }
    return {
      gestureSummary: render(t.summaryTemplate, person),
      gestureDetails: { source: 'hardcoded', kind: event.kind, rank: t.rank },
      estimatedCostCents: clampedCost,
      rank: t.rank,
    };
  });
};
