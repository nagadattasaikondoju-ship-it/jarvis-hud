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
  const fresh = FRESH.test(t) || /\b(prices?|rates?|cost)\b[^.?!]{0,30}\b(today|now|currently|this week)\b/i.test(t);
  if (!explicit && !fresh) return { search: false, explicit: false, topic: '' };
  const words = t.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !FILLER.has(w.replace(/'s$/, '')));
  const topic = meaningful.length ? t : '';
  return { search: true, explicit, topic };
}

// ---------------------------------------------------------------------------
// AUTO mode: pick the right tool from the message itself.
// Plain rules, so there is no extra model call and no added delay.

const CREATE = String.raw`(make|create|generate|build|prepare|produce|design|draft|write|compose|turn|convert|export|save|put|send|need|want|give\s+me|get\s+me)`;
// Talking about giving a talk is not asking for a file: "I have to give a presentation tomorrow, any tips?"
const DELIVERING = /\b(give|giving|gave|do|doing|deliver|delivering|present|presenting|attend|attending|watch|watching)\s+(a|an|my|the|our)?\s*(\w+\s+)?(presentation|talk|speech|slides?)\b|\b(tips|advice|nervous|how (do|can|should) i (prepare|present|give))\b/i;
const near = (verbs, nouns, gap = 60) => new RegExp(String.raw`\b${verbs}\b[^.?!\n]{0,${gap}}\b${nouns}\b`, 'i');

const LANG_ALIASES = {
  english: 'English', hindi: 'Hindi', telugu: 'Telugu', tamil: 'Tamil', kannada: 'Kannada', malayalam: 'Malayalam',
  marathi: 'Marathi', bengali: 'Bengali', bangla: 'Bengali', gujarati: 'Gujarati', punjabi: 'Punjabi', urdu: 'Urdu',
  spanish: 'Spanish', french: 'French', german: 'German', italian: 'Italian', portuguese: 'Portuguese', russian: 'Russian',
  arabic: 'Arabic', chinese: 'Chinese (Simplified)', mandarin: 'Chinese (Simplified)', japanese: 'Japanese', korean: 'Korean',
};
const LANG_RE = new RegExp(String.raw`\b(?:to|into|in)\s+(${Object.keys(LANG_ALIASES).join('|')})\b`, 'i');

const FILE_KINDS = [
  { id: 'pptx', re: String.raw`(ppt|pptx|power\s?point|presentation|slides?|slide\s?deck|deck)` },
  { id: 'xlsx', re: String.raw`(excel|xlsx|spreadsheet|work\s?book)` },
  { id: 'docx', re: String.raw`(word\s+(document|doc|file)|docx|word\s+format|ms\s+word|in\s+word)` },
  { id: 'pdf', re: String.raw`(pdf)` },
];

const WRITE_KINDS = [
  ['Email', String.raw`(e-?mail|mail)`], ['Letter', String.raw`(letter|cover\s+letter|application)`], ['Essay', 'essay'],
  ['Article', String.raw`(article|blog(\s+post)?)`], ['Story', String.raw`(story|tale|poem|poetry|lyrics|song)`],
  ['Report', 'report'], ['Social media post', String.raw`((linkedin|instagram|twitter|x|facebook|social media)\s+post|tweet|caption|post)`],
  ['Speech', String.raw`(speech|toast|address)`], ['Summary', String.raw`(summary|synopsis|abstract)`],
];
const TONE_WORDS = [
  ['Formal', /\bformal(ly)?\b/i], ['Friendly', /\b(friendly|warm|casual)\b/i], ['Persuasive', /\b(persuasive|convincing|sales)\b/i],
  ['Concise', /\b(concise|crisp|to the point)\b/i], ['Academic', /\b(academic|scholarly)\b/i], ['Playful', /\b(funny|playful|humou?rous|witty)\b/i],
  ['Empathetic', /\b(empathetic|kind|apolog(y|etic|ise|ize))\b/i], ['Inspirational', /\b(inspir(ing|ational)|motivat(ing|ional))\b/i],
  ['Professional', /\b(professional|polite|business)\b/i],
];

/**
 * The words to translate, without the instruction around them:
 *   "translate good morning, how are you? to Hindi"  -> "good morning, how are you?"
 *   "translate to Telugu: see you tomorrow"           -> "see you tomorrow"
 *   "how do you say thank you in Japanese"            -> "thank you"
 * Returns '' when the text cannot be separated (the whole message is then sent).
 */
export function translateText(t) {
  const L = Object.keys(LANG_ALIASES).join('|');
  const pats = [
    new RegExp(String.raw`^\s*(?:please\s+)?translate\s+(?:this|the following|it)?\s*(?:(?:to|into|in)\s+(?:${L})\b)?\s*[:\-–—]\s*([\s\S]+)$`, 'i'),
    new RegExp(String.raw`^\s*(?:please\s+|can you\s+|could you\s+)?translate\s+["“']?([\s\S]+?)["”']?\s+(?:to|into|in)\s+(?:${L})\s*[.!?]*\s*$`, 'i'),
    new RegExp(String.raw`^\s*how (?:do|would) (?:you|i) say\s+["“']?([\s\S]+?)["”']?\s+in\s+(?:${L})\s*\??\s*$`, 'i'),
    new RegExp(String.raw`^\s*what (?:does|is)\s+["“']?([\s\S]+?)["”']?\s+(?:mean\s+)?in\s+(?:${L})\s*\??\s*$`, 'i'),
  ];
  for (const re of pats) {
    const m = re.exec(t);
    if (m && m[1] && m[1].trim().length > 0) return m[1].trim();
  }
  return '';
}

/**
 * detectMode(text, { files }) -> { mode, opts, why, text? }
 *   mode: chat | write | translate | file | dashboard | artifact | research
 *   opts: overrides for writeType / tone / length / language / format
 *   files: attachments, e.g. [{ kind: 'sheet' }, { kind: 'pdf' }]
 */
export function detectMode(text, { files = [] } = {}) {
  const t = String(text || '').trim();
  const has = (k) => files.some((f) => f.kind === k);
  const hasData = has('sheet') || /(\d[\d,.]*\s*[,;:|\n]\s*){3,}/.test(t) || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*[:=-]?\s*\d/i.test(t);

  // 1. Translation: "translate this to Telugu", "say good morning in Hindi"
  const lang = LANG_RE.exec(t);
  if (/\btranslat(e|ion|ed)\b/i.test(t) || (lang && /\b(how (do|would) (you|i) say|say|write|convert|what is|what's|mean|meaning)\b/i.test(t) && t.length < 400)) {
    return { mode: 'translate', opts: lang ? { language: LANG_ALIASES[lang[1].toLowerCase()] } : {}, why: 'translation', text: translateText(t) };
  }

  // 2. Office / PDF files: "make a ppt on…", "create an excel sheet of…", "give it to me as a pdf"
  for (const k of FILE_KINDS) {
    const asFormat = new RegExp(String.raw`\b(as|in(to)?|to)\s+(an?\s+)?${k.re}(\s+(file|format|document|version))?\b`, 'i');
    const madeOf = near(CREATE, k.re, 50);
    const leading = new RegExp(String.raw`^\s*(an?\s+)?(\d+[-\s]?(slide|page)s?\s+)?${k.re}\b`, 'i');
    // "summarise this pdf" / "what does the attached excel say" is analysis, not creation
    const aboutAttachment = new RegExp(String.raw`\b(this|the|that|attached|my|uploaded)\s+${k.re}\b`, 'i').test(t) && !asFormat.test(t);
    if (!aboutAttachment && !(k.id === 'pptx' && DELIVERING.test(t) && !asFormat.test(t)) && (asFormat.test(t) || madeOf.test(t) || leading.test(t))) {
      return { mode: 'file', opts: { format: k.id }, why: k.id };
    }
  }

  // 3. Dashboards and charts from data
  if (/\bdashboards?\b|\bkpis?\b/i.test(t)
    || (/\b(chart|graph|plot|visuali[sz]e|visuali[sz]ation)\b/i.test(t) && (hasData || near(CREATE, '(chart|graph|plot)', 40).test(t) || /^\s*(visuali[sz]e|plot|chart)\b/i.test(t)))) {
    return { mode: 'dashboard', opts: {}, why: 'dashboard' };
  }

  // 4. Artifacts: diagrams, calculators, mini apps, games
  if (near(String.raw`(make|create|generate|build|design|draw|code|develop|show|give|need|want|write)`,
    String.raw`(diagram|flow\s?chart|mind\s?map|org(anisation|anization)?\s?chart|timeline|calculator|converter|mini\s?app|web\s?app|app|website|web\s?page|landing\s?page|html|game|quiz|timer|stopwatch|to-?do\s?list|tracker|simulation|animation|widget|interactive)`, 50).test(t)) {
    return { mode: 'artifact', opts: {}, why: 'artifact' };
  }

  // 5. Writing: "write an email to…", "draft a leave letter", "a poem about rain"
  for (const [type, re] of WRITE_KINDS) {
    if (near(String.raw`(write|draft|compose|prepare|create|make|give|need|help\s+me\s+(write|with))`, re, 40).test(t) || new RegExp(String.raw`^\s*(an?\s+)?(\w+\s+){0,3}${re}\s+(to|for|about|on|asking|requesting)\b`, 'i').test(t)) {
      const tone = TONE_WORDS.find(([, r]) => r.test(t))?.[0];
      const length = /\b(short|brief|quick|small|few lines|one paragraph)\b/i.test(t) ? 'Short' : /\b(long|detailed|in[-\s]depth|comprehensive|elaborate)\b/i.test(t) ? 'Long' : undefined;
      return { mode: 'write', opts: { writeType: type, ...(tone ? { tone } : {}), ...(length ? { length } : {}) }, why: type.toLowerCase() };
    }
  }

  // 6. Web research
  const si = searchIntent(t);
  if (si.search && !files.length) return { mode: 'research', opts: {}, why: si.topic ? 'web' : 'web-no-topic' };

  return { mode: 'chat', opts: {}, why: '' };
}
