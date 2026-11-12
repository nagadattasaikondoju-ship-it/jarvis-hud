// Jarvis modes: what each one tells the local model, and (for files/dashboards)
// the exact JSON shape the model must return. Ollama enforces the shape.

export const MODES = [
  { id: 'chat', label: 'CHAT', hint: 'Talk normally' },
  { id: 'write', label: 'WRITE', hint: 'Emails, articles, stories, reports' },
  { id: 'translate', label: 'TRANSLATE', hint: 'Translate text between languages' },
  { id: 'file', label: 'CREATE FILE', hint: 'Word, Excel, PowerPoint or PDF' },
  { id: 'dashboard', label: 'DASHBOARD', hint: 'Charts and KPIs from your data' },
  { id: 'artifact', label: 'ARTIFACT', hint: 'Diagrams and mini web apps' },
  { id: 'research', label: 'RESEARCH', hint: 'Web search with citations (needs Companion)' },
  { id: 'files', label: 'MY FILES', hint: 'Answers from the folders you added (needs Companion)' },
];

export const WRITE_TYPES = ['Email', 'Article', 'Story', 'Report', 'Social media post', 'Letter', 'Summary', 'Essay', 'Speech'];
export const TONES = ['Professional', 'Friendly', 'Persuasive', 'Concise', 'Academic', 'Playful', 'Empathetic', 'Formal', 'Inspirational'];
export const LENGTHS = ['Short', 'Medium', 'Long'];
export const LANGUAGES = [
  'English', 'Hindi', 'Telugu', 'Tamil', 'Kannada', 'Malayalam', 'Marathi', 'Bengali', 'Gujarati', 'Punjabi', 'Urdu',
  'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Russian', 'Arabic', 'Chinese (Simplified)', 'Japanese', 'Korean',
];
export const FILE_FORMATS = [
  { id: 'docx', label: 'Word (.docx)' },
  { id: 'pptx', label: 'PowerPoint (.pptx)' },
  { id: 'xlsx', label: 'Excel (.xlsx)' },
  { id: 'pdf', label: 'PDF (.pdf)' },
];

export const DEFAULT_MODE_OPTS = {
  writeType: 'Email', tone: 'Professional', length: 'Medium', language: 'Telugu', format: 'docx',
};

const str = { type: 'string' };
const strArr = { type: 'array', items: str };

export const SCHEMAS = {
  doc: {
    type: 'object',
    properties: {
      title: str,
      subtitle: str,
      sections: {
        type: 'array',
        items: { type: 'object', properties: { heading: str, paragraphs: strArr, bullets: strArr }, required: ['heading', 'paragraphs'] },
      },
    },
    required: ['title', 'sections'],
  },
  pptx: {
    type: 'object',
    properties: {
      title: str,
      subtitle: str,
      slides: {
        type: 'array',
        items: { type: 'object', properties: { title: str, bullets: strArr, notes: str }, required: ['title', 'bullets'] },
      },
    },
    required: ['title', 'slides'],
  },
  xlsx: {
    type: 'object',
    properties: {
      title: str,
      sheets: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: str, columns: strArr, rows: { type: 'array', items: strArr } },
          required: ['name', 'columns', 'rows'],
        },
      },
    },
    required: ['title', 'sheets'],
  },
  dashboard: {
    type: 'object',
    properties: {
      title: str,
      summary: str,
      kpis: {
        type: 'array',
        items: { type: 'object', properties: { label: str, value: str, note: str }, required: ['label', 'value'] },
      },
      charts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut'] },
            title: str,
            labels: strArr,
            series: {
              type: 'array',
              items: { type: 'object', properties: { name: str, values: { type: 'array', items: { type: 'number' } } }, required: ['name', 'values'] },
            },
          },
          required: ['type', 'title', 'labels', 'series'],
        },
      },
      table: { type: 'object', properties: { columns: strArr, rows: { type: 'array', items: strArr } } },
    },
    required: ['title', 'summary', 'kpis', 'charts'],
  },
};

/** Extra system instructions for a mode. */
export function modeSystem(mode, o) {
  switch (mode) {
    case 'write':
      return `WRITING MODE. You are an expert writer. Write a ${o.writeType.toLowerCase()} in a ${o.tone.toLowerCase()} tone, ${o.length.toLowerCase()} length (${o.length === 'Short' ? 'about 100 words' : o.length === 'Medium' ? 'about 300 words' : 'about 700 words'}). Use Markdown headings and lists only where they help. Output only the finished piece — no preamble, no explanation.${o.writeType === 'Email' ? ' Start with a "Subject:" line.' : ''}`;
    case 'translate':
      return `TRANSLATION MODE. Translate the user's text into ${o.language}. Keep the meaning, tone and formatting. Output the translation first. Then, only if useful, add a line "---" followed by at most 3 short notes about tricky words or cultural nuances. Do not translate code or URLs.`;
    case 'file': {
      const kind = o.format;
      if (kind === 'pptx') return 'You create presentation content. Return JSON for a slide deck: a clear title, an optional subtitle, and 5-10 slides. Each slide has a short title, 3-5 concise bullets (max 15 words each) and optional speaker notes. Base it on the request and any attached material.';
      if (kind === 'xlsx') return 'You create spreadsheet content. Return JSON with one or more sheets. Each sheet has a name (max 30 chars), column headers, and rows (each row has exactly one value per column). Write numbers as plain digits without currency symbols or thousands separators. Use real data from the attached material when given; otherwise create a sensible template or example data.';
      return 'You create document content. Return JSON for a well-structured document: a title, an optional subtitle, and 3-8 sections. Each section has a heading, 1-4 paragraphs, and optional bullet points. Write complete, polished prose. Base it on the request and any attached material.';
    }
    case 'dashboard':
      return 'You build data dashboards. Return JSON: a title, a 1-3 sentence summary of the key insight, 2-6 KPI cards (label + value as short text + optional note), and 1-4 charts. Each chart has a type (bar, line, pie or doughnut), a title, category labels, and one or more series whose values align with the labels. Use ONLY numbers from the attached data or the user\'s message. If no data was given, invent clearly illustrative sample data and say "Sample data" in the summary. Optionally include a small table.';
    case 'artifact':
      return 'ARTIFACT MODE. Build what the user asks for (diagram, chart, calculator, mini web app, interactive explainer) as ONE complete, self-contained HTML file with inline CSS and JavaScript. Use a dark, clean design. Do not use external images. If you need a library, load it only from https://cdn.jsdelivr.net. Reply with exactly one ```html code block, then one short sentence describing it.';
    case 'research':
      return 'RESEARCH MODE. Answer using ONLY the numbered web sources provided. Cite sources inline like [1], [2] right after the facts they support. Start with a 2-3 sentence direct answer, then key points as a list. If sources disagree or are insufficient, say so. Do not invent sources or URLs.';
    case 'files':
      return "MY FILES MODE. Answer using ONLY the numbered excerpts from the user's own files. Cite them inline like [1] and mention the file name when it helps. If the excerpts don't contain the answer, say so plainly and suggest what to search for instead. Never invent content.";
    default:
      return '';
  }
}

export const STRUCTURED = { file: true, dashboard: true };

export function schemaFor(mode, o) {
  if (mode === 'dashboard') return SCHEMAS.dashboard;
  if (mode === 'file') return o.format === 'pptx' ? SCHEMAS.pptx : o.format === 'xlsx' ? SCHEMAS.xlsx : SCHEMAS.doc;
  return null;
}
