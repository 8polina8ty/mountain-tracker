export const MENTION_REGEX = /(?:^|[^a-zA-Z0-9_.-])@([a-zA-Z0-9_][a-zA-Z0-9_.-]{1,18}[a-zA-Z0-9_])(?=$|[^a-zA-Z0-9_])/g;
export function extractMentions(body: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(MENTION_REGEX);
  while ((m = re.exec(body)) !== null) {
    // m[1] is username, m[0] includes leading delimiter which we discard
    out.push(m[1]);
    // Avoid infinite loop on zero-length (not needed but safe)
    if (m[0].length === 0) re.lastIndex++;
  }
  return [...new Set(out)];
}
export function renderMentions(body: string): unknown { return body; }
