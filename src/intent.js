// Spots chat messages that need the web, so Jarvis can search automatically
// instead of answering from (possibly outdated) training data.

const EXPLICIT = new RegExp([
  String.raw`^\s*(search|google|browse|look\s*up|lookup)\b`, // "search iPhone 18 price"
  String.raw`\b(search|google|browse)\s+(the\s+)?(web|internet|net|online|for|about|it|this|that|up)\b`, // "search the web for …"
  String.raw`\b(can|could|would|will|please|pls|plz)\s+(you\s+|u\s+)?(search|google|browse|look\s*up|look\s+(it|this|that)\s+up|find\s+out|check)\b`,
  String.raw`\blook\s+(it|this|that)\s+up\b`,
  String.raw`\b(find|check)\b[^.?!]{0,40}\b(online|on the (web|internet|net))\b`,
].join('|'), 'i');
const FRESH = /\b(latest|breaking news|newest|today'?s (news|headlines|weather|price|match|score)|news|headlines|weather|forecast|stock price|share price|price of|exchange rate|live score|who won|winner of|results? of the|release date|launch date|trending)\b/i;

// Words that carry no topic on their own ("can you search the web and give me some information").
const FILLER = new Set(('can could would will you u please pls plz kindly hey jarvis search searching google look lookup up browse find check '
  + 'the a an web internet online net on in at for about me my us some any something anything information info details detail '
  + 'give tell show get bring and or to it this that what whats is are i want need like do does let lets quickly quick just more '
  + 'result results stuff thing things topic').split(' '));

/** { search: boolean, explicit: boolean, topic: string } — topic is '' when the user did not say what to look up. */
export function searchIntent(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 600) return { search: false, explicit: false, topic: '' };
  const explicit = EXPLICIT.test(t);
  const fresh = FRESH.test(t);
  if (!explicit && !fresh) return { search: false, explicit: false, topic: '' };
  const words = t.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !FILLER.has(w.replace(/'s$/, '')));
  const topic = meaningful.length ? t : '';
  return { search: true, explicit, topic };
}
