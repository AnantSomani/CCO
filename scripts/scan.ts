// Manual trigger for the daily scan in local dev. POSTs the
// `confetti/scan.manual` event to the local Inngest dev server (port 8288),
// which then invokes the registered dailyScan function via the Next.js
// /api/inngest webhook.
//
// Prerequisites: `pnpm dev` running (Next.js) AND `npx inngest-cli dev`
// running (Inngest dev server discovers the function via the Next.js handler).

const DEV_URL = process.env.INNGEST_DEV_URL ?? 'http://localhost:8288/e/dev';

const main = async (): Promise<void> => {
  const res = await fetch(DEV_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'confetti/scan.manual', data: {} }),
  });
  if (!res.ok) {
    console.error(`scan trigger failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`queued confetti/scan.manual → ${await res.text()}`);
};

main().catch((err) => {
  console.error('scan trigger error:', err);
  process.exit(1);
});
