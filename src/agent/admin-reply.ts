const CLAIMS_QUEUED_APPROVAL =
  /\b(queue|queued|queuing|submit|submitted|submitting|preparing the doordash cart|for slack approval|approval now)\b/i;

const BLAMES_DOORDASH_OR_SUPPORT =
  /doordash.*(reject|error|validation|snag|system)|place the order directly|contact confetti support|workaround/i;

export const honestAdminReply = (
  reply: string,
  proposedCount: number,
  lastProposalError: string | null,
): string => {
  if (proposedCount > 0) {
    return 'I prepared an approval card. Nothing has been ordered or charged.';
  }
  const needsRewrite = CLAIMS_QUEUED_APPROVAL.test(reply) || BLAMES_DOORDASH_OR_SUPPORT.test(reply);
  if (!needsRewrite) return reply;
  if (lastProposalError) {
    return `I could not prepare an approval card yet. ${describeProposalError(lastProposalError)}`;
  }
  return 'I could not prepare an approval card yet. Reply with any missing detail, or say "go ahead" and I will use the workspace budget as the maximum.';
};

export const describeProposalError = (error: string): string => {
  if (error.includes('maximum estimate')) {
    return 'Say a maximum such as "max $40", or say "go ahead" to use the workspace budget.';
  }
  if (error.includes('required options')) {
    return `${error} I will attach those choices under the size you already picked.`;
  }
  if (error.includes('delivery address')) {
    return 'I still need to match the delivery address from this conversation.';
  }
  return error;
};
