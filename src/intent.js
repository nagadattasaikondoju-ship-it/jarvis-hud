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
export function detectMode(text, { files = [], hasFolders = false } = {}) {
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

  // 3b. Questions about the user's own files (when folders are indexed)
  if (hasFolders && !files.length && filesIntent(t)) return { mode: 'files', opts: {}, why: 'files' };

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

// ---------------------------------------------------------------------------
// PC actions: a fixed list the Companion knows how to do safely.

const SITES = {
  youtube: 'https://www.youtube.com', gmail: 'https://mail.google.com', google: 'https://www.google.com', github: 'https://github.com',
  'google drive': 'https://drive.google.com', drive: 'https://drive.google.com', 'google maps': 'https://maps.google.com', maps: 'https://maps.google.com',
  'google calendar': 'https://calendar.google.com', calendar: 'https://calendar.google.com', 'google docs': 'https://docs.google.com',
  'google sheets': 'https://sheets.google.com', 'google meet': 'https://meet.google.com', instagram: 'https://www.instagram.com',
  facebook: 'https://www.facebook.com', linkedin: 'https://www.linkedin.com', twitter: 'https://x.com', netflix: 'https://www.netflix.com',
  amazon: 'https://www.amazon.in', flipkart: 'https://www.flipkart.com', wikipedia: 'https://www.wikipedia.org', reddit: 'https://www.reddit.com',
  'stack overflow': 'https://stackoverflow.com', stackoverflow: 'https://stackoverflow.com', chatgpt: 'https://chatgpt.com',
  'whatsapp web': 'https://web.whatsapp.com', hotstar: 'https://www.hotstar.com', 'prime video': 'https://www.primevideo.com',
  irctc: 'https://www.irctc.co.in', swiggy: 'https://www.swiggy.com', zomato: 'https://www.zomato.com', 'claude': 'https://claude.ai',
};
const APP_ALIASES = {
  'vs code': ['vs code', 'vscode', 'visual studio code', 'code editor'], notepad: ['notepad'], calculator: ['calculator', 'calc'],
  paint: ['paint', 'ms paint'], 'file explorer': ['file explorer', 'explorer', 'file manager', 'files app', 'this pc', 'my computer'],
  settings: ['settings', 'windows settings', 'pc settings'], 'task manager': ['task manager'], camera: ['camera', 'webcam'],
  photos: ['photos', 'photos app'], clock: ['clock', 'alarms', 'alarm clock', 'timer app', 'stopwatch app'], 'snipping tool': ['snipping tool', 'screenshot tool'],
  'microsoft store': ['microsoft store', 'store', 'app store'], spotify: ['spotify'], whatsapp: ['whatsapp', 'whatsapp app'],
  edge: ['edge', 'microsoft edge'], chrome: ['chrome', 'google chrome', 'browser'], word: ['word', 'ms word', 'microsoft word'],
  excel: ['excel', 'ms excel', 'microsoft excel'], powerpoint: ['powerpoint', 'power point', 'ms powerpoint'], outlook: ['outlook'],
  terminal: ['terminal', 'windows terminal'], 'command prompt': ['command prompt', 'cmd'], powershell: ['powershell'],
  'control panel': ['control panel'], teams: ['teams', 'microsoft teams'],
};
const APP_OF = Object.fromEntries(Object.entries(APP_ALIASES).flatMap(([app, names]) => names.map((n) => [n, app])));
const FOLDER_OF = { downloads: 'downloads', download: 'downloads', documents: 'documents', document: 'documents', 'my documents': 'documents', desktop: 'desktop', pictures: 'pictures', photos: 'pictures', music: 'music', videos: 'videos', 'home folder': 'home' };

const PRETTY = { 'vs code': 'VS Code', youtube: 'YouTube', github: 'GitHub', gmail: 'Gmail', linkedin: 'LinkedIn', chatgpt: 'ChatGPT', irctc: 'IRCTC',
  whatsapp: 'WhatsApp', 'whatsapp web': 'WhatsApp Web', 'stack overflow': 'Stack Overflow', stackoverflow: 'Stack Overflow', powerpoint: 'PowerPoint' };
const pretty = (n) => PRETTY[n] || n.replace(/\b\w/g, (c) => c.toUpperCase());
const clean = (s) => s.toLowerCase().replace(/[.!?,]+$/g, '').replace(/^(the|my)\s+/, '').replace(/\s+(app|application|website|site|page|for me|please|now|in (the )?browser)$/g, '').trim();

/** Parse "at 6 pm", "at 18:30", "in 20 minutes", "tomorrow at 9" → epoch ms, or null. */
export function parseWhen(text, now = new Date()) {
  const t = text.toLowerCase();
  const rel = /\bin\s+(an?|half an|\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/.exec(t);
  if (rel) {
    const n = rel[1] === 'half an' ? 0.5 : /^an?$/.test(rel[1]) ? 1 : parseFloat(rel[1]);
    const unit = rel[2][0] === 's' ? 1000 : rel[2][0] === 'm' ? 60000 : rel[2][0] === 'h' ? 3600000 : 86400000;
    return { at: now.getTime() + n * unit, match: rel[0] };
  }
  const abs = /\b(?:at|by|around)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?|\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/.exec(t);
  const tomorrow = /\btomorrow\b/.test(t);
  if (abs) {
    let h = parseInt(abs[1] ?? abs[4], 10);
    const m = parseInt(abs[2] ?? abs[5] ?? '0', 10);
    const ap = (abs[3] ?? abs[6] ?? '').replace(/\./g, '');
    if (h > 23 || m > 59) return null;
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (!ap && /\b(tonight|evening|night)\b/.test(t) && h < 12) h += 12;
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setHours(h, m);
    if (tomorrow) d.setDate(d.getDate() + 1);
    else if (d <= now) {
      if (!ap && h < 12 && new Date(d.getTime() + 12 * 3600000) > now) d.setHours(h + 12); // "at 6" in the afternoon → 6 pm
      else d.setDate(d.getDate() + 1);
    }
    return { at: d.getTime(), match: abs[0] };
  }
  if (tomorrow && /\bmorning\b/.test(t)) { const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return { at: d.getTime(), match: 'tomorrow morning' }; }
  return null;
}

/**
 * detectAction(text) -> null | { action, args, say }
 *   action: open_url | open_app | open_folder | media | lock | remind | disk
 *   say: a short confirmation for the chat (and voice)
 */
export function detectAction(text, now = new Date()) {
  const t = String(text || '').trim().replace(/^(hey\s+)?jarvis[,\s]+/i, '');
  if (!t || t.length > 300) return null;
  const low = t.toLowerCase();

  // YouTube searches: "play lofi music on youtube", "search youtube for cricket highlights"
  const yt = /\b(?:play|watch|search|find|show(?: me)?)\s+(.+?)\s+on\s+youtube\b/i.exec(t) || /\byoutube\s+(?:search\s+)?(?:for\s+)?(.+)$/i.exec(t) || /\bsearch\s+youtube\s+for\s+(.+)$/i.exec(t);
  if (yt && yt[1] && !/^(and|the|app|website)$/i.test(yt[1].trim())) {
    const q = yt[1].replace(/[.!?]+$/, '').trim();
    return { action: 'open_url', args: { url: `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` }, say: `Searching YouTube for “${q}”.` };
  }

  // Open apps, folders and websites
  const open = /^(?:please\s+|can you\s+|could you\s+)?(open|launch|start|run|go to|goto|take me to|bring up)\s+(.+)$/i.exec(t);
  if (open) {
    const target = clean(open[2]);
    const folder = FOLDER_OF[target.replace(/\s+folder$/, '')];
    if (folder && (/\bfolder\b/.test(target) || ['downloads', 'documents', 'desktop'].includes(folder))) {
      return { action: 'open_folder', args: { name: folder }, say: `Opening your ${folder} folder.` };
    }
    if (APP_OF[target]) return { action: 'open_app', args: { app: APP_OF[target] }, say: `Opening ${pretty(APP_OF[target])}.` };
    if (SITES[target]) return { action: 'open_url', args: { url: SITES[target] }, say: `Opening ${pretty(target)}.` };
    const dom = /^((?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|in|org|net|io|dev|ai|co|edu|gov|app|me|info|tv)(?:\/\S*)?)$/i.exec(target);
    if (dom) return { action: 'open_url', args: { url: dom[1].startsWith('http') ? dom[1] : `https://${dom[1]}` }, say: `Opening ${dom[1].replace(/^https?:\/\//, '')}.` };
    return null;
  }

  // Media keys (short commands only)
  if (low.length <= 40) {
    if (/^(pause|resume|play|stop)( the)?( music| song| video| media| playback)?$/.test(low.replace(/[.!]$/, ''))) return { action: 'media', args: { key: 'play_pause' }, say: 'Done.' };
    if (/^(next|skip)( the)?( song| track| video)?$|^play (the )?next( song| track)?$/.test(low.replace(/[.!]$/, ''))) return { action: 'media', args: { key: 'next' }, say: 'Next track.' };
    if (/^(previous|go back|last)( the)?( song| track| video)$|^previous$/.test(low.replace(/[.!]$/, ''))) return { action: 'media', args: { key: 'previous' }, say: 'Previous track.' };
    if (/^(mute|unmute)( the)?( sound| volume| audio| pc| computer| laptop)?$/.test(low.replace(/[.!]$/, ''))) return { action: 'media', args: { key: 'mute' }, say: 'Toggled mute.' };
    if (/\b(volume up|turn (it|the volume|the sound) up|increase (the )?volume|louder)\b/.test(low)) return { action: 'media', args: { key: 'volume_up', times: 5 }, say: 'Volume up.' };
    if (/\b(volume down|turn (it|the volume|the sound) down|decrease (the )?volume|lower the volume|quieter)\b/.test(low)) return { action: 'media', args: { key: 'volume_down', times: 5 }, say: 'Volume down.' };
    if (/^lock (my |the )?(pc|computer|laptop|screen|system|windows)[.!]?$/.test(low)) return { action: 'lock', args: {}, say: 'Locking your PC.' };
  }

  // Reminders: "remind me at 6 pm to call mom", "remind me to drink water in 30 minutes"
  if (/\bremind me\b|\bset (a |an )?(reminder|alarm)\b/i.test(t)) {
    const when = parseWhen(t, now);
    let what = t.replace(/^.*?\b(remind me|set (a |an )?(reminder|alarm))\b\s*/i, '');
    if (when) what = what.replace(when.match, ' ');
    what = what.replace(/\btomorrow\b|\btonight\b/gi, ' ').replace(/^\s*(to|that|about|for)\s+/i, '').replace(/\s+(to|at|in|on)\s*$/i, '').replace(/\s+/g, ' ').trim().replace(/[.!]$/, '');
    const say = when ? `I'll remind you ${new Date(when.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}: ${what || 'reminder'}.` : 'When should I remind you? Say a time, like “at 6 pm” or “in 20 minutes”.';
    return { action: 'remind', args: { at: when ? Math.round(when.at / 1000) : null, text: what ? what[0].toUpperCase() + what.slice(1) : 'Reminder' }, say, needTime: !when };
  }

  // Disk space
  if (/\b(what'?s|what is|whats)\s+(taking|using|eating|filling)\s+(up\s+)?(all\s+)?(my\s+|the\s+)?(disk|space|storage|drive|c drive)|\b(disk|storage)\s+(space|usage|full)|\bfree (disk )?space\b|\bhow much (disk |storage |free )?space\b|\b(clean ?up|free up) (my )?(pc|disk|laptop|space|storage)\b/i.test(t)) {
    return { action: 'disk', args: {}, say: 'Checking your disk…' };
  }
  return null;
}

/** Questions about the user's own indexed files. */
export function filesIntent(text) {
  const t = String(text || '');
  return /\b(my|our)\s+(own\s+)?([\w-]+\s+){0,2}(files?|documents?|docs|notes|folders?|pdfs?|papers|assignments?|records?|resume|cv|notebooks?|slides|presentations?|spreadsheets?|reports?)\b/i.test(t)
    || /\b(that|the)\s+(\w+\s+){0,3}(pdf|document|doc|file|notes|ppt|presentation|spreadsheet|report)\b[^.?!]{0,40}\b(said|says|say|mention(ed|s)?|about|talk(ed|s)? about)\b/i.test(t)
    || /\b(according to|search|check|look in|look through|from)\s+(my|the)\s+(files|folders|documents|notes|pdfs)\b/i.test(t)
    || /\bin my (documents|downloads|desktop|folders?)\b/i.test(t);
}
