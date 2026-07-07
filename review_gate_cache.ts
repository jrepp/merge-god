export const REVIEW_GATE_CACHE_MARKER = "<!-- merge-god-review-gate-cache:v1 -->";

const REVIEW_GATE_STATUS_HEADING_PATTERN = /^\s{0,3}#{1,6}\s+merge-god review gate status\s*$/im;

export function isReviewGateCacheBody(body: string): boolean {
  if (body.includes(REVIEW_GATE_CACHE_MARKER)) return true;
  return REVIEW_GATE_STATUS_HEADING_PATTERN.test(body);
}
