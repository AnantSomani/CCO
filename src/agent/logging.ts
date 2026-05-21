import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { env } from '@/lib/env';
import { log } from '@/lib/log';

// Append-only JSONL of every agent invocation. The tuning loop (CP3 and
// onward) reads these to judge "why did the agent suggest *that*?" In dev
// they land in `logs/agent-YYYY-MM-DD.jsonl`; in prod we emit one structured
// console line per run so the platform log collector can pick it up.

export type AgentRunLogEntry = {
  ts: string;
  workspace_id: string;
  event_id: string;
  kind: 'birthday' | 'anniversary';
  person_name: string;
  budget_cents: number;
  rounds: number;
  tool_calls: Array<{ name: string; input: Record<string, unknown> }>;
  final_suggestions: Array<{ summary: string; cost_cents: number; rank: number }>;
  used_fallback: boolean;
  error?: string;
};

export const appendAgentRunLog = async (entry: AgentRunLogEntry): Promise<void> => {
  if (env.NODE_ENV === 'test') return;
  const line = `${JSON.stringify(entry)}\n`;
  if (env.NODE_ENV === 'production') {
    // Pipe through console so the platform log collector captures it.
    console.log(line.trim());
    return;
  }
  try {
    // Sync writes serialize concurrent calls. fs.promises.appendFile under
    // O_APPEND is only atomic up to ~PIPE_BUF (~512B on macOS) — our 2-3KB
    // JSON lines exceeded that, and we were silently losing rows when ~10
    // agent runs finished in parallel. Sync per-line is fine in dev.
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.resolve('logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, `agent-${today}.jsonl`), line, 'utf-8');
  } catch (err) {
    // Logging shouldn't break suggestion generation. Warn and move on.
    log.warn('agent log append failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
