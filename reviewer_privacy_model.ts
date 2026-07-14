/** Privacy and accessibility rules for reviewer-facing text and evidence. */

const LOCAL_HOST_PATTERN = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i;

export function redactReviewerText(value: string): string {
  return value
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s]*)?/g, "[local path redacted]")
    .replace(/\/(?:Users|home)\/[^/\s]+(?:\/[^\s]*)?/g, "[local path redacted]")
    .replace(/file:\/\/[^\s)]+/gi, "[local path redacted]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, (match) => match.replace(/\/\/.*@/, "//"))
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email redacted]")
    .replace(/https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::\d+)?[^\s)]*/gi, "[local URL redacted]");
}

export function reviewerAccessibleEvidenceRef(value: string): string | null {
  const trimmed = value.trim();
  if (!/^https:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" || LOCAL_HOST_PATTERN.test(parsed.hostname)) return null;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function reviewerAccessibleEvidenceRefs(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const ref = reviewerAccessibleEvidenceRef(value);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    result.push(ref);
  }
  return result;
}
