// Reads files in the browser and turns them into text (or images) the local model can use.
// Nothing is uploaded anywhere: extraction happens on this computer.
import { uid } from './store.js';

export const ACCEPT = '.pdf,.docx,.xlsx,.xlsm,.csv,.tsv,.txt,.md,.json,.html,.htm,.xml,.js,.ts,.py,.java,.c,.cpp,.cs,.go,.rs,.sql,.yaml,.yml,.log,image/*';

const TEXT_EXT = /\.(txt|md|json|html?|xml|js|ts|jsx|tsx|py|java|c|cpp|cs|go|rs|sql|ya?ml|log|ini|toml|sh|ps1|css)$/i;

function ext(name) {
  const m = /\.([^.]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

async function readPdf(file) {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = '';
    let lastY = null;
    const out = [];
    for (const it of tc.items) {
      const y = it.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) { out.push(line); line = ''; }
      line += it.str + (it.hasEOL ? '\n' : '');
      lastY = y;
    }
    out.push(line);
    pages.push(`--- Page ${i} ---\n${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}`);
  }
  const text = pages.join('\n\n');
  return { text, note: text.replace(/--- Page \d+ ---/g, '').trim().length < 20 ? 'This PDF looks like scanned images; no selectable text was found.' : '' };
}

async function readDocx(file) {
  const mammoth = await import('mammoth/mammoth.browser.js');
  const m = mammoth.default || mammoth;
  const r = await m.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return { text: r.value.replace(/\n{3,}/g, '\n\n').trim() };
}

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(v);
}

const csvEscape = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

async function readXlsx(file) {
  const mod = await import('exceljs/dist/exceljs.min.js');
  const ExcelJS = mod.default || mod;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const parts = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      for (let c = 1; c <= ws.actualColumnCount; c++) vals.push(csvEscape(cellText(row.getCell(c).value)));
      rows.push(vals.join(','));
    });
    parts.push(`--- Sheet: ${ws.name} (${rows.length} rows) ---\n${rows.join('\n')}`);
  });
  return { text: parts.join('\n\n') };
}

async function readImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const image = c.toDataURL('image/jpeg', 0.86).split(',')[1];
  const t = document.createElement('canvas');
  const ts = Math.min(1, 160 / Math.max(w, h));
  t.width = Math.round(w * ts); t.height = Math.round(h * ts);
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
  return { image, thumb: t.toDataURL('image/jpeg', 0.8), text: '' };
}

/** Turn a File into an attachment: { id, name, kind, size, text, image, thumb, note } */
export async function readFile(file) {
  const e = ext(file.name);
  const base = { id: uid(), name: file.name, size: file.size };
  if (file.type.startsWith('image/')) return { ...base, kind: 'image', ...(await readImage(file)) };
  if (e === 'pdf') return { ...base, kind: 'pdf', ...(await readPdf(file)) };
  if (e === 'docx') return { ...base, kind: 'docx', ...(await readDocx(file)) };
  if (e === 'xlsx' || e === 'xlsm') return { ...base, kind: 'sheet', ...(await readXlsx(file)) };
  if (e === 'csv' || e === 'tsv') return { ...base, kind: 'sheet', text: (await file.text()).trim() };
  if (TEXT_EXT.test(file.name) || file.type.startsWith('text/')) return { ...base, kind: 'text', text: (await file.text()).trim() };
  if (e === 'doc' || e === 'xls' || e === 'ppt' || e === 'pptx') {
    throw new Error(`${file.name}: this format isn't supported yet. Save it as .docx, .xlsx or PDF and try again.`);
  }
  throw new Error(`${file.name}: unsupported file type.`);
}

/** Text block for the model, trimmed to a character budget. */
export function attachmentBlock(att, budget) {
  if (att.kind === 'image') return `[Attached image: ${att.name}]`;
  let t = att.text || '';
  let cut = '';
  if (t.length > budget) {
    t = t.slice(0, budget);
    cut = `\n[...truncated: only the first ${budget.toLocaleString()} of ${att.text.length.toLocaleString()} characters were included]`;
  }
  return `[Attached file: ${att.name}]\n\`\`\`\n${t}\n\`\`\`${cut}`;
}

export const fmtSize = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
