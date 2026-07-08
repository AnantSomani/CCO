import styles from './page.module.css';

const pillars = [
  {
    eyebrow: 'Moments',
    title: 'Mark the moments that matter.',
    body:
      'Birthdays, anniversaries, promotions, new babies, weddings, and sensitive moments handled with context, taste, and budget controls.',
    points: ['Finds the moment', 'Suggests the right gesture', 'Acts with approval when needed'],
  },
  {
    eyebrow: 'Activities',
    title: 'Plan office energy before it fades.',
    body:
      'From trivia nights to themed lunches to surprise ice cream carts, Confetti turns vague ideas into a date, budget, and invite.',
    points: ['Spots low-energy weeks', 'Ranks the best options', 'Handles rollout in Slack'],
  },
  {
    eyebrow: 'Travel',
    title: 'Make every office visit count.',
    body:
      'When someone travels between offices, Confetti lines up the right coffee, dinner, or intro so distributed teams feel like one company.',
    points: ['Matches the right people', 'Suggests the right setting', 'Makes travel feel intentional'],
  },
];

const activityOptions = [
  'Nerf War',
  'Mafia Night',
  'Ice Cream Cart',
  'Trivia Night',
  'Themed Lunch',
  'Scavenger Hunt',
];

const modes = [
  {
    number: '01',
    title: 'Proactive',
    body:
      'Confetti watches for moments worth marking and brings a recommendation to Slack with context, cost, and a next step.',
  },
  {
    number: '02',
    title: 'On-demand',
    body:
      'Ask it like a chief of staff: plan Friday, send a cake, start a card, or make a trip count.',
  },
  {
    number: '03',
    title: 'Autonomous',
    body:
      'Set budgets and guardrails. Confetti handles the easy wins and checks in when judgment or extra spend is needed.',
  },
];

const strengths = [
  {
    title: 'Context, not templates',
    body:
      'Confetti reads calendars, channels, profiles, office patterns, and collaboration history so recommendations fit the team.',
  },
  {
    title: 'Judgment, not automation',
    body:
      'The right move is different for a promotion, a birthday, a travel visit, or a tough week. Confetti adapts instead of repeating scripts.',
  },
  {
    title: 'Execution, not reminders',
    body:
      'Budgets, ordering, reservations, invites, reminders, and follow-ups happen in one loop instead of across five tools and two people.',
  },
];

const integrations = [
  'Slack',
  'Google Calendar',
  'DoorDash',
  'Resy',
  'OpenTable',
  'Amazon Business',
  'Rippling',
  'Gusto',
  'Workday',
  'Zoom',
  'Notion',
  'Linear',
];

const faqs = [
  {
    question: 'Will Confetti spend money without me knowing?',
    answer:
      'You set the threshold. Anything over budget or sensitive asks first in Slack.',
  },
  {
    question: 'Does this replace People Ops?',
    answer:
      'No. It removes the remembering, coordination, and follow-through so people teams can focus on the human work.',
  },
  {
    question: 'How does it know what to do?',
    answer:
      'It combines HRIS, Slack, calendar, travel, and office signals to understand the moment and suggest the right move.',
  },
];

function SlackMessage({
  speaker,
  time,
  children,
}: {
  speaker: string;
  time: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.message}>
      <div className={styles.avatar}>{speaker.slice(0, 1)}</div>
      <div className={styles.messageContent}>
        <div className={styles.messageMeta}>
          <strong>{speaker}</strong>
          <span>{time}</span>
        </div>
        <div className={styles.messageBody}>{children}</div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.nav}>
          <div className={styles.brand}>
            <span className={styles.brandMark} />
            <span>Confetti</span>
          </div>
          <a className={styles.navLink} href="#how-it-works">
            How it works
          </a>
        </div>

        <div className={styles.heroGrid}>
          <div className={styles.heroCopy}>
            <div className={styles.kicker}>AI office culture platform for Slack</div>
            <h1>The teammate who remembers what culture needs.</h1>
            <p className={styles.heroText}>
              Confetti runs milestones, office activities, and travel rituals from Slack. It
              spots the signal, suggests the right move, and follows through.
            </p>
            <div className={styles.heroActions}>
              <a className={styles.primaryButton} href="/api/slack/install">
                Add to Slack
              </a>
              <a className={styles.secondaryButton} href="#features">
                See features
              </a>
            </div>
            <p className={styles.heroFootnote}>
              Built for growing teams that want culture to feel thoughtful, not manual.
            </p>
          </div>

          <div className={styles.heroPanel}>
            <div className={styles.panelGlow} />
            <div className={styles.demoCard}>
              <div className={styles.demoHeader}>
                <span className={styles.demoDot} />
                <span>Live in Slack</span>
              </div>
              <SlackMessage speaker="Confetti" time="10:14 AM">
                Maya turns 30 on Thursday. I can line up a cake, start the card in `#product`, and
                keep it under budget.
              </SlackMessage>
              <div className={styles.optionStack}>
                <div className={styles.optionCard}>
                  <strong>Cake at standup</strong>
                  <span>Chocolate, candles, card thread, about $87</span>
                </div>
                <div className={styles.optionCard}>
                  <strong>Team lunch</strong>
                  <span>Friday delivery for collaborators, about $160</span>
                </div>
              </div>
              <SlackMessage speaker="Sarah" time="10:16 AM">
                Cake. Keep it simple.
              </SlackMessage>
              <SlackMessage speaker="Confetti" time="10:16 AM">
                Done. Delivery booked, channel post queued, card thread ready.
              </SlackMessage>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.pillarsSection} id="features">
        <div className={styles.sectionHeading}>
          <span className={styles.sectionLabel}>Features</span>
          <h2>Three ways Confetti makes culture happen.</h2>
        </div>
        <div className={styles.pillarsGrid}>
          {pillars.map((pillar) => (
            <article className={styles.pillarCard} key={pillar.title}>
              <span className={styles.cardEyebrow}>{pillar.eyebrow}</span>
              <h3>{pillar.title}</h3>
              <p>{pillar.body}</p>
              <ul className={styles.compactList}>
                {pillar.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.storySection} id="demo">
        <div className={styles.storyIntro}>
          <span className={styles.sectionLabel}>How it works</span>
          <h2>One loop from signal to action.</h2>
          <p>
            Confetti finds the moment, recommends the move, and carries the work through Slack.
          </p>
        </div>

        <div className={styles.storyGrid}>
          <article className={styles.storyCard}>
            <span className={styles.storyNumber}>01</span>
            <h3>Spot the moment</h3>
            <p>
              Birthdays, anniversaries, promotions, office slumps, and travel windows show up
              before someone has to remember them manually.
            </p>
          </article>

          <article className={styles.storyCard}>
            <span className={styles.storyNumber}>02</span>
            <h3>Recommend the move</h3>
            <p>
              Confetti proposes the right gesture, activity, or meetup with context, timing, and
              cost.
            </p>
            <div className={styles.activityGrid}>
              {activityOptions.map((activity) => (
                <span className={styles.activityPill} key={activity}>
                  {activity}
                </span>
              ))}
            </div>
          </article>

          <article className={styles.storyCard}>
            <span className={styles.storyNumber}>03</span>
            <h3>Carry it through</h3>
            <p>
              Approvals, ordering, invites, cards, reservations, and follow-up all happen in the
              same loop.
            </p>
            <div className={styles.tripCard}>
              <div>
                <strong>Upcoming trip</strong>
                <span>NYC to SFO · Tue to Thu · Atlas review</span>
              </div>
              <p>
                Three suggested meetups: a cross-functional coffee, a design dinner, and a team
                drop-in that fit the trip.
              </p>
            </div>
          </article>
        </div>
      </section>

      <section className={styles.howSection} id="how-it-works">
        <div className={styles.sectionHeading}>
          <span className={styles.sectionLabel}>How it works</span>
          <h2>Three modes. One agent.</h2>
        </div>
        <div className={styles.modeGrid}>
          {modes.map((mode) => (
            <article className={styles.modeCard} key={mode.number}>
              <span className={styles.modeNumber}>{mode.number}</span>
              <h3>{mode.title}</h3>
              <p>{mode.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.agentSection}>
        <div className={styles.agentIntro}>
          <span className={styles.sectionLabel}>Why Confetti</span>
          <h2>More than a workflow. Less work for your team.</h2>
          <p>
            Culture work breaks when nobody owns the remembering. Confetti adds context, judgment,
            and follow-through.
          </p>
        </div>
        <div className={styles.strengthGrid}>
          {strengths.map((strength) => (
            <article className={styles.strengthCard} key={strength.title}>
              <h3>{strength.title}</h3>
              <p>{strength.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.integrationsSection}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionLabel}>Integrations</span>
          <h2>Built for the tools culture already runs on.</h2>
        </div>
        <div className={styles.integrationGrid}>
          {integrations.map((integration) => (
            <div className={styles.integrationCard} key={integration}>
              {integration}
            </div>
          ))}
        </div>
      </section>

      <section className={styles.faqSection}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionLabel}>Common questions</span>
          <h2>The questions that come up first.</h2>
        </div>
        <div className={styles.faqGrid}>
          {faqs.map((faq) => (
            <article className={styles.faqCard} key={faq.question}>
              <h3>{faq.question}</h3>
              <p>{faq.answer}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.ctaSection}>
        <div className={styles.ctaCard}>
          <span className={styles.sectionLabel}>Bring Confetti in</span>
          <h2>Give your team a better default for culture.</h2>
          <p>
            Start in Slack. Let Confetti handle the remembering, planning, and follow-through.
          </p>
          <div className={styles.heroActions}>
            <a className={styles.primaryButton} href="/api/slack/install">
              Add to Slack
            </a>
            <a className={styles.secondaryButton} href="mailto:hello@confetti.app">
              Talk to us
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
