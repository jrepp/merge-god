/**
 * Pure URL extraction for cached forge link maps.
 *
 * REST and GraphQL payloads often keep browser/API URLs under `links` or
 * `_links` maps. Keep that shape handling centralized so domain models can
 * preserve their own evidence-ref precedence without duplicating link parsing.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function linkValueCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(linkValueCandidates);
  if (typeof value === "string") return [value];
  const link = asRecord(value);
  return [
    link["href"],
    link["url"],
    link["html_url"],
    link["htmlUrl"],
    link["web_url"],
    link["webUrl"],
    link["permalink"],
    link["uri"],
  ];
}

function linkMapCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(linkValueCandidates);
  const links = asRecord(value);
  return [
    ...linkValueCandidates(links["html"]),
    ...linkValueCandidates(links["web"]),
    ...linkValueCandidates(links["self"]),
    ...linkValueCandidates(links["pull_request"]),
    ...linkValueCandidates(links["pullRequest"]),
    ...linkValueCandidates(links["pull_requests"]),
    ...linkValueCandidates(links["pullRequests"]),
    ...linkValueCandidates(links["merge_request"]),
    ...linkValueCandidates(links["mergeRequest"]),
    ...linkValueCandidates(links["merge_requests"]),
    ...linkValueCandidates(links["mergeRequests"]),
    ...linkValueCandidates(links["browser"]),
    ...linkValueCandidates(links["api"]),
    links["html_url"],
    links["htmlUrl"],
    links["web_url"],
    links["webUrl"],
    links["permalink"],
    links["uri"],
    links["url"],
  ];
}

export function recordLinkUrlCandidates(value: unknown): unknown[] {
  const record = asRecord(value);
  return [
    ...linkMapCandidates(record["links"]),
    ...linkMapCandidates(record["_links"]),
  ].filter((candidate) => candidate !== undefined && candidate !== null);
}
