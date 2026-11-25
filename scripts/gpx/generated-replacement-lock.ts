/** Human-approved scope, frozen after validating the existing reviewed artifacts. */
export const LOCKED_REPLACEMENT_HASH = 'ca62cb72d5c1aa9f964e375ed288015cba02edb385291674f698a3eb9d53e732';

export interface ReplacementExecuteArgs {
  manifestPath: string;
  manifestSha256: string;
}

export function requirePreparationMode(args: string[]) {
  if (args.length === 0 || args.length === 1 && args[0] === '--dry-run') return;
  if (args[0] === '--execute') {
    if (args.length !== 5 || args[1] !== '--manifest' || args[3] !== '--manifest-sha256')
      throw new Error('EXECUTE_REQUIRES_EXACT_LOCKED_MANIFEST_SHA256');
    const hash = args[4];
    if (hash !== LOCKED_REPLACEMENT_HASH)
      throw new Error('EXECUTE_REQUIRES_EXACT_LOCKED_MANIFEST_SHA256');
    return;
  }
  throw new Error('UNKNOWN_REPLACEMENT_ARGUMENTS');
}

export function parseExecuteArgs(args: string[]): ReplacementExecuteArgs {
  requirePreparationMode(args);
  if (args.length === 0 || args[0] !== '--execute')
    throw new Error('EXECUTE_REQUIRES_EXACT_LOCKED_MANIFEST_SHA256');
  return { manifestPath: args[2], manifestSha256: args[4] };
}
