// Slack action_id / callback_id / command constants. Handlers reference these
// instead of inline string literals so renames are safe and grep-friendly.

export const COMMAND_CONFETTI = '/confetti' as const;

export const SUBCOMMAND_HELLO = 'hello' as const;
