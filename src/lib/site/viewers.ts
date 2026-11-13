/**
 * Is this request a program fetching the link and not a person reading it?
 * Mail security gateways, chat apps and crawlers open every link in a message,
 * often seconds after delivery; counting those would tell the owner a clinic
 * "viewed" a report nobody has seen. Obvious cases only: a scanner that
 * imitates a browser exactly cannot be told apart here.
 */
const BOT_UA =
  /bot\b|bots\b|crawl|spider|slurp|preview|scanner|monitor|validator|fetch|headless|phantomjs|lighthouse|pagespeed|python-requests|python-urllib|aiohttp|httpx|curl\/|wget\/|libwww|go-http-client|okhttp|java\/|apache-httpclient|node-fetch|undici|axios|postmanruntime|insomnia|facebookexternalhit|slack-imgproxy|skypeuripreview|embedly|quora link|outbrain|vkshare|w3c_|proofpoint|mimecast|barracuda|safelinks|symantec|trend ?micro|forcepoint|fireeye|ironport|urldefense|google-safety|googleimageproxy|feedfetcher|mediapartners|apis-google|claude-|anthropic|chatgpt|oai-|perplexity/i;
// Names of apps people really browse in (Slack, Teams, WhatsApp, LinkedIn, DuckDuckGo, ...)
// are deliberately not listed: their link expanders identify as "...bot" or send no browser token.

export function isAutomatedFetch(userAgent: string, headers?: { get(name: string): string | null }): boolean {
  const ua = userAgent.trim();
  if (ua.length < 20) return true; // no user agent, or a bare library name
  if (BOT_UA.test(ua)) return true;
  if (!/mozilla\/|opera\//i.test(ua)) return true; // every real browser sends one of these
  if (headers) {
    // browsers mark speculative loads; they are not a reading
    const purpose = `${headers.get("purpose") ?? ""} ${headers.get("sec-purpose") ?? ""} ${headers.get("x-purpose") ?? ""} ${headers.get("x-moz") ?? ""}`;
    if (/prefetch|prerender|preview/i.test(purpose)) return true;
  }
  return false;
}
