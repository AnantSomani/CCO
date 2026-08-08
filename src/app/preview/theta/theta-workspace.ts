import { db } from '@/db/client';
import { getWorkspaceBySlackTeamId, upsertWorkspace } from '@/db/queries/workspaces';

// Resolves (creating on first call) the standalone "Theta Software" workspace
// that the preview dashboard reads and writes. No Slack install backs it — it
// exists purely so roster rows have a workspace to attach to. Sandbox only;
// the real tenant will be provisioned properly (with a slug + auth) later.
const THETA_SLACK_TEAM_ID = 'theta-sandbox';

export const getThetaWorkspaceId = async (): Promise<string> => {
  const existing = await getWorkspaceBySlackTeamId(db, THETA_SLACK_TEAM_ID);
  if (existing) return existing.id;
  const ws = await upsertWorkspace(db, {
    slackTeamId: THETA_SLACK_TEAM_ID,
    slackTeamName: 'Theta Software',
    installedBySlackUser: 'preview-provisioned',
    botAccessToken: 'sandbox-no-slack-token',
  });
  return ws.id;
};
