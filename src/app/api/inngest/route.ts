import { serve } from 'inngest/next';
import { inngest } from '@/jobs/client';
import { dailyScan } from '@/jobs/daily-scan';

// Placeholder function so the Inngest dev UI has something to display.
// Trigger from the dev UI or by emitting `confetti/placeholder.hello`.
const placeholderHello = inngest.createFunction(
  {
    id: 'placeholder-hello',
    triggers: [{ event: 'confetti/placeholder.hello' }],
  },
  async ({ event }) => {
    const data = event.data as { name?: string } | undefined;
    return { greeting: `hello, ${data?.name ?? 'world'}` };
  },
);

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [placeholderHello, dailyScan],
});
