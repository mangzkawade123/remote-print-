// Print options conversation: questions, answer parsing, PDF page info, SumatraPDF settings, summary.
// Pure functions only (no WhatsApp / printer access), so it can be tested on its own: node test_print_flow.js
const zlib = require('zlib');

const HEADER = '🖨️ *Print Bot*';

// Paper size is fixed: every print uses this size and the size question is not asked.
// Set to null to ask for the paper size again.
const FIXED_SIZE = 'A4';

// All options (the order of "CHANGE OPTIONS"). Custom only ASKS the first ones; the rest use defaults
// and can still be changed from the summary.
const STEPS = ['copies', 'color', 'sides', 'pages', 'size', 'tray', 'orientation'].filter(x => !(FIXED_SIZE && x === 'size'));
const ASKED_STEPS = ['copies', 'color', 'sides', 'pages', ...(FIXED_SIZE ? [] : ['size'])];
const FLOW = ['copies', 'color', 'sides', 'pages', 'size', 'tray', 'orientation', 'confirm'];

// Paper sources as named by the Brother printer driver (passed to SumatraPDF as bin=<name>)
const TRAYS = { 1: 'Tray1', 2: 'MP Tray', 3: 'Auto Select' };
const TRAY_LABELS = { 'Tray1': '🗂️ Tray1 (main tray)', 'MP Tray': '✋ MP Tray (manual feed)', 'Auto Select': '🔄 Auto Select' };

const SIZES = { 1: 'A4', 2: 'A3', 3: 'A5', 4: 'Letter', 5: 'Legal', 6: 'Printer default' };
// Paper sizes the printer can't physically take (Brother DCP-T830DW is an A4-size printer)
const UNSUPPORTED_SIZES = { A3: 'A3 paper does not fit this printer (largest is A4 / Legal).' };

// Settings used by "Direct Print" (first question): print straight away, no more questions
const DIRECT_OPTIONS = { copies: 1, color: 'color', sides: 'single', pages: 'all', size: FIXED_SIZE || 'A4', tray: 'Tray1', orientation: 'auto' };
// "Letterhead" (first question): prints at once on pre-printed letterhead paper loaded in this tray
const LETTERHEAD_TRAY = 'MP Tray';
const LETTERHEAD_OPTIONS = { ...DIRECT_OPTIONS, sides: 'single', tray: LETTERHEAD_TRAY };
// First-question shortcuts: 1-4 print at once, 5 asks the Custom questions
const PRESETS = {
  1: { name: 'Direct Print', options: DIRECT_OPTIONS, words: ['direct', 'direct print', 'print', 'yes', 'color', 'colour'] },
  2: { name: 'Black & White', options: { ...DIRECT_OPTIONS, color: 'mono' }, words: ['bw', 'b&w', 'b/w', 'black', 'black & white', 'mono'] },
  3: { name: 'Both Side (B&W)', options: { ...DIRECT_OPTIONS, color: 'mono', sides: 'duplex' }, words: ['both', 'both side', 'duplex', 'double'] },
  4: { name: 'Letterhead', options: LETTERHEAD_OPTIONS, letterhead: true, words: ['letterhead', 'letter head', 'lh'] },
};
const CUSTOM_WORDS = ['5', 'custom', 'options', 'choose', 'choose options'];

// One-line quick code, e.g. "2 bw both 1-3" = 2 copies, black & white, both sides, pages 1-3.
// Anything not written uses the Direct Print defaults. Returns { ok, options } or { ok: false, error }.
function parseQuick(text, totalPages) {
  const o = { ...DIRECT_OPTIONS };
  let copiesSet = false;
  let letterhead = false;
  const words = String(text).toLowerCase().replace(/[–—]/g, '-').replace(/\s*,\s*/g, ',').replace(/\s*-\s*/g, '-')
    .split(/\s+/).filter(Boolean);
  for (const w of words) {
    let m;
    if ((m = w.match(/^(\d+)(x|copy|copies)$/)) || (!copiesSet && /^\d+$/.test(w) && (m = [w, w]))) {
      const n = Number(m[1]);
      if (n < 1 || n > 50) return { ok: false, error: 'Copies must be from 1 to 50.' };
      o.copies = n; copiesSet = true;
    } else if (/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(w)) {
      const r = parsePages(w, totalPages);
      if (!r.ok) return r;
      o.pages = r.text;
    } else if (['bw', 'b&w', 'b/w', 'black', 'mono', 'grey', 'gray'].includes(w)) o.color = 'mono';
    else if (['color', 'colour'].includes(w)) o.color = 'color';
    else if (['both', 'duplex', 'double'].includes(w)) o.sides = 'duplex';
    else if (['single', 'one'].includes(w)) o.sides = 'single';
    else if (['lh', 'letterhead'].includes(w)) { o.tray = LETTERHEAD_TRAY; o.sides = 'single'; letterhead = true; }
    else if (['mp', 'manual'].includes(w)) o.tray = 'MP Tray';
    else if (['tray1', 'tray'].includes(w)) o.tray = 'Tray1';
    else if (['landscape', 'portrait'].includes(w)) o.orientation = w;
    else if (['copies', 'copy', 'page', 'pages', 'side', 'sides', 'print'].includes(w)) continue;
    else return { ok: false, error: `I didn't understand "${w}". Example: *2 bw both 1-3* (2 copies, black & white, both sides, pages 1-3).` };
  }
  return { ok: true, options: o, letterhead };
}

const LABELS = {
  color: { mono: '🖤 Black & White', color: '🎨 Color' },
  sides: { single: '📄 Single Side', duplex: '🔄 Both Side' },
  orientation: { portrait: '📄 Portrait', landscape: '🖼️ Landscape', auto: '🔄 Auto (as per PDF)' },
};

function question(step, s) {
  const file = `📄 ${s.filename} (${s.pages ? `${s.pages} page${s.pages === 1 ? '' : 's'}` : 'pages unknown'})`;
  switch (step) {
    case 'start':
      return `${file}\n\nHow do you want to print?\n1️⃣ ⚡ Direct Print (Color)\n2️⃣ 🖤 Black & White\n3️⃣ 🔄 Both Side (B&W)\n` +
        `4️⃣ 📜 Letterhead (${LETTERHEAD_TRAY})\n5️⃣ ⚙️ Custom\n✏️ Or in one line, e.g. *2 bw both 1-3*\n❌ *cancel* to skip`;
    case 'tray':
      return '🗂️ Select paper tray:\n' + Object.entries(TRAYS).map(([k, v]) => `${k}️⃣ ${TRAY_LABELS[v]}`).join('\n');
    case 'copies':
      return `${s.changing ? '' : `${file}\n\n`}🖨️ How many copies do you want to print?\n1️⃣ 1\n2️⃣ 2\n3️⃣ 3\n✏️ Or type any number (e.g. 5)`;
    case 'color':
      return '🎨 Select print color:\n1️⃣ 🖤 Black & White\n2️⃣ 🎨 Color';
    case 'sides':
      return '🔄 Select printing side:\n1️⃣ 📄 Single Side\n2️⃣ 🔄 Both Side / Duplex';
    case 'pages':
      return '📑 Which pages do you want to print?\n1️⃣ 📄 All Pages\n2️⃣ 🔢 Specific Pages\n3️⃣ 📃 Page Range\n✏️ Or type the pages now, e.g. 1-5 or 1,3,5 or 1-3,7,10-12';
    case 'pagesInput':
      return `✏️ Type the pages${s.pages ? ` (1 to ${s.pages})` : ''}, e.g. 1-5 or 1,3,5,8 or 1-3,7,10-12`;
    case 'size':
      return '📐 Select page size:\n' + Object.entries(SIZES).map(([k, v]) => `${k}️⃣ ${v}`).join('\n');
    case 'orientation':
      return '↕️ Select page orientation:\n1️⃣ 📄 Portrait\n2️⃣ 🖼️ Landscape\n3️⃣ 🔄 Auto / As per PDF';
    case 'changeWhich': {
      const names = { copies: 'Copies', color: 'Color / Black & White', sides: 'Single Side / Duplex', pages: 'Pages', size: 'Page size', tray: 'Paper tray', orientation: 'Orientation' };
      return '🔄 What do you want to change?\n' + STEPS.map((x, i) => `${i + 1}️⃣ ${names[x]}`).join('\n');
    }
    case 'confirm':
      return summary(s);
    default:
      return '';
  }
}

// Tap-to-choose version of a question (a WhatsApp poll). Each option maps to the same answer text that
// typing would give, so polls and typed answers go through applyAnswer the same way.
// Returns { name, options: [{ label, answer }] }, or null for questions that need typing (page numbers).
function pollFor(step, s) {
  const short = String(s.filename || '').length > 60 ? `${String(s.filename).slice(0, 57)}...` : s.filename;
  const pages = s.pages ? `${s.pages} page${s.pages === 1 ? '' : 's'}` : 'pages unknown';
  const opt = (...pairs) => pairs.map(([label, answer]) => ({ label, answer }));
  switch (step) {
    case 'start':
      return { name: `🖨️ ${short} (${pages})\nHow do you want to print?`,
        options: opt(['⚡ Direct Print (Color)', '1'], ['🖤 Black & White', '2'], ['🔄 Both Side (B&W)', '3'],
          ['📜 Letterhead (MP Tray)', '4'], ['⚙️ Custom', '5'], ['❌ Cancel', 'cancel']) };
    case 'copies':
      return { name: '🖨️ How many copies?', options: opt(['1', '1'], ['2', '2'], ['3', '3'], ['✏️ Other number (type it)', 'custom']) };
    case 'color':
      return { name: '🎨 Select print color', options: opt([LABELS.color.mono, '1'], [LABELS.color.color, '2']) };
    case 'sides':
      return { name: '🔄 Select printing side', options: opt([LABELS.sides.single, '1'], ['🔄 Both Side / Duplex', '2']) };
    case 'pages':
      return { name: '📑 Which pages?', options: opt(['📄 All Pages', '1'], ['🔢 Specific pages (type them)', '2'], ['📃 Page range (type it)', '3']) };
    case 'tray':
      return { name: '🗂️ Select paper tray', options: Object.entries(TRAYS).map(([k, v]) => ({ label: TRAY_LABELS[v], answer: k })) };
    case 'orientation':
      return { name: '↕️ Select page orientation', options: opt([LABELS.orientation.portrait, '1'], [LABELS.orientation.landscape, '2'], ['🔄 Auto / As per PDF', '3']) };
    case 'confirm':
      return { name: 'Do you want to continue?', options: opt(['✅ PRINT', '1'], ['❌ CANCEL', '2'], ['🔄 CHANGE OPTIONS', '3']) };
    case 'changeWhich': {
      const names = { copies: 'Copies', color: 'Color / Black & White', sides: 'Single Side / Duplex', pages: 'Pages', size: 'Page size', tray: 'Paper tray', orientation: 'Orientation' };
      return { name: '🔄 What do you want to change?', options: STEPS.map((x, i) => ({ label: names[x], answer: String(i + 1) })) };
    }
    default:
      return null;
  }
}

// "1-3,7,10-12" -> { ok, text, count } validated against total pages
function parsePages(input, total) {
  const text = String(input).replace(/\s+/g, '').replace(/[–—]/g, '-');
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(text)) {
    return { ok: false, error: 'Please type pages like 1-5 or 1,3,5 or 1-3,7,10-12.' };
  }
  const set = new Set();
  for (const part of text.split(',')) {
    const [a, b] = part.split('-').map(Number);
    const end = b === undefined ? a : b;
    if (a < 1 || end < 1) return { ok: false, error: 'Page numbers start at 1.' };
    if (end < a) return { ok: false, error: `"${part}" goes backwards - write it as ${end}-${a}.` };
    if (total && end > total) return { ok: false, error: `This PDF has only ${total} page${total === 1 ? '' : 's'} - page ${end} doesn't exist.` };
    if (end - a > 5000) return { ok: false, error: 'That range is too large.' };
    for (let p = a; p <= end; p++) set.add(p);
  }
  // Normalise to sorted ranges, e.g. 1,2,3,7 -> 1-3,7
  const pages = [...set].sort((x, y) => x - y);
  const ranges = [];
  for (const p of pages) {
    const last = ranges[ranges.length - 1];
    if (last && p === last[1] + 1) last[1] = p; else ranges.push([p, p]);
  }
  return { ok: true, text: ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(','), count: pages.length };
}

const pick = (t, map) => {
  const n = String(t).trim().toLowerCase().replace(/[^\w ,\-&/]/g, '').trim();
  for (const [key, words] of Object.entries(map)) if (words.includes(n)) return key;
  return null;
};

// Applies an answer to the session. Returns { ok, next?, error?, action? }
//   next: step to ask next ('confirm' shows the summary); action: 'print' | 'cancel'
function applyAnswer(s, text) {
  const t = String(text || '').trim();
  const lower = t.toLowerCase();
  if (['cancel', 'stop', '❌'].includes(lower) && s.step !== 'confirm') return { ok: true, action: 'cancel' };
  // Questions Custom doesn't ask (fixed paper size, tray, orientation) get their default and are skipped
  const defaults = { size: FIXED_SIZE || 'A4', tray: DIRECT_OPTIONS.tray, orientation: DIRECT_OPTIONS.orientation };
  const after = nextStep => {
    if (s.changing) return 'confirm';
    while (nextStep !== 'confirm' && !ASKED_STEPS.includes(nextStep)) {
      if (s.options[nextStep] === undefined) s.options[nextStep] = defaults[nextStep];
      nextStep = FLOW[FLOW.indexOf(nextStep) + 1];
    }
    return nextStep;
  };

  switch (s.step) {
    case 'start': {
      const key = Object.keys(PRESETS).find(k => k === lower || PRESETS[k].words.includes(lower));
      if (key) {
        const p = PRESETS[key];
        s.options = { ...p.options };
        s.presetName = p.name;
        s.letterhead = !!p.letterhead;
        return { ok: true, action: 'print' };
      }
      if (CUSTOM_WORDS.includes(lower)) return { ok: true, next: 'copies' };
      // One-line quick code -> summary
      if (/\s/.test(t) || /^\d+(x|copy|copies)$/i.test(t) || /[-,]/.test(t)) {
        const q = parseQuick(t, s.pages);
        if (!q.ok) return q;
        s.options = q.options;
        s.letterhead = q.letterhead;
        return { ok: true, next: 'confirm' };
      }
      return { ok: false, error: 'Please reply 1-5, or type it in one line like *2 bw both 1-3*.' };
    }
    case 'copies': {
      const n = Number(lower.replace(/copies?|x/g, '').trim());
      if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'Please reply with a number of copies, e.g. 1, 2 or 5.' };
      if (n > 50) return { ok: false, error: 'Maximum is 50 copies per request.' };
      s.options.copies = n;
      return { ok: true, next: after('color') };
    }
    case 'color': {
      const v = pick(t, { mono: ['1', 'bw', 'b&w', 'b/w', 'black', 'black & white', 'black and white', 'mono', 'grey', 'gray'], color: ['2', 'color', 'colour'] });
      if (!v) return { ok: false, error: 'Please reply 1 for Black & White or 2 for Color.' };
      s.options.color = v;
      return { ok: true, next: after('sides') };
    }
    case 'sides': {
      const v = pick(t, { single: ['1', 'single', 'single side', 'one', 'one side'], duplex: ['2', 'both', 'both side', 'both sides', 'duplex', 'double'] });
      if (!v) return { ok: false, error: 'Please reply 1 for Single Side or 2 for Both Side.' };
      s.options.sides = v;
      return { ok: true, next: after('pages') };
    }
    case 'pages': {
      if (['1', 'all', 'all pages'].includes(lower)) { s.options.pages = 'all'; return { ok: true, next: after('size') }; }
      if (['2', '3', 'specific', 'range', 'page range', 'specific pages'].includes(lower)) return { ok: true, next: 'pagesInput' };
      // Pages typed directly
      const r = parsePages(t, s.pages);
      if (!r.ok) return { ok: false, error: /^[\d\s,\-–—]+$/.test(t) ? r.error : 'Please reply 1 (All), 2 (Specific), 3 (Range), or type pages like 1-5.' };
      s.options.pages = r.text;
      return { ok: true, next: after('size') };
    }
    case 'pagesInput': {
      const r = parsePages(t, s.pages);
      if (!r.ok) return { ok: false, error: r.error };
      s.options.pages = r.text;
      return { ok: true, next: after('size') };
    }
    case 'size': {
      let v = SIZES[lower];
      if (!v) v = Object.values(SIZES).find(x => x.toLowerCase() === lower || (lower === 'default' && x === 'Printer default'));
      if (!v) return { ok: false, error: 'Please reply with a number from 1 to 6.' };
      if (UNSUPPORTED_SIZES[v]) return { ok: false, error: `⚠️ ${UNSUPPORTED_SIZES[v]} Please choose another size.` };
      s.options.size = v;
      return { ok: true, next: after('tray') };
    }
    case 'tray': {
      let v = TRAYS[lower];
      if (!v) v = Object.values(TRAYS).find(x => x.toLowerCase() === lower ||
        (lower === 'manual' && x === 'MP Tray') || (lower === 'auto' && x === 'Auto Select') || (lower === 'tray 1' && x === 'Tray1'));
      if (!v) return { ok: false, error: 'Please reply 1 (Tray1), 2 (MP Tray / manual feed) or 3 (Auto Select).' };
      s.options.tray = v;
      return { ok: true, next: after('orientation') };
    }
    case 'orientation': {
      const v = pick(t, { portrait: ['1', 'portrait'], landscape: ['2', 'landscape'], auto: ['3', 'auto', 'as per pdf'] });
      if (!v) return { ok: false, error: 'Please reply 1 (Portrait), 2 (Landscape) or 3 (Auto).' };
      s.options.orientation = v;
      return { ok: true, next: 'confirm' };
    }
    case 'confirm': {
      const v = pick(t, { print: ['1', 'print', 'yes', 'ok', 'y'], cancel: ['2', 'cancel', 'no', 'n'], change: ['3', 'change', 'change options', 'edit'] });
      if (v === 'print') return { ok: true, action: 'print' };
      if (v === 'cancel') return { ok: true, action: 'cancel' };
      if (v === 'change') return { ok: true, next: 'changeWhich' };
      return { ok: false, error: 'Please reply 1 to PRINT, 2 to CANCEL or 3 to CHANGE OPTIONS.' };
    }
    case 'changeWhich': {
      const n = Number(lower);
      if (!Number.isInteger(n) || n < 1 || n > STEPS.length) return { ok: false, error: `Please reply with a number from 1 to ${STEPS.length}.` };
      s.changing = true;
      return { ok: true, next: STEPS[n - 1] };
    }
    default:
      return { ok: false, error: 'This request is no longer waiting for an answer.' };
  }
}

// How much will be printed: pages per copy, total pages and sheets of paper (both sides = half the sheets).
// Returns null when the PDF's page count is unknown.
function printCount(s) {
  const o = s.options || {};
  let perCopy = s.pages || 0;
  if (o.pages && o.pages !== 'all') {
    const r = parsePages(o.pages, s.pages);
    perCopy = r.ok ? r.count : 0;
  }
  if (!perCopy) return null;
  const copies = o.copies || 1;
  const sheetsPerCopy = o.sides === 'duplex' ? Math.ceil(perCopy / 2) : perCopy;
  return { perCopy, totalPages: perCopy * copies, sheets: sheetsPerCopy * copies };
}

function countLine(s) {
  const c = printCount(s);
  if (!c) return '🧾 Pages to print: unknown';
  const sheets = c.sheets === c.totalPages ? '' : ` on ${c.sheets} sheet${c.sheets === 1 ? '' : 's'}`;
  return `🧾 Pages to print: *${c.totalPages}*${sheets}`;
}

function pagesLabel(s) {
  if (s.options.pages === 'all' || !s.options.pages) return `All${s.pages ? ` (1-${s.pages})` : ''}`;
  return s.options.pages;
}

function summary(s, withChoices = true) {
  const o = s.options;
  const line = '━━━━━━━━━━━━━━━━━━━━';
  const orient = o.orientation === 'auto' && s.orientations
    ? `${LABELS.orientation.auto} - ${describeOrientations(s.orientations)}` : LABELS.orientation[o.orientation];
  const lines = [
    line, '🖨️ PRINT CONFIRMATION', line,
    `📄 File: ${s.filename}`,
    `📑 Total Pages: ${s.pages || 'unknown'}`,
    `🖨️ Copies: ${o.copies}`,
    `🎨 Color: ${LABELS.color[o.color]}`,
    `🔄 Sides: ${LABELS.sides[o.sides]}`,
    `📑 Pages: ${pagesLabel(s)}`,
    `📐 Paper Size: ${o.size}`,
    `🗂️ Tray: ${TRAY_LABELS[o.tray || 'Auto Select']}`,
    `↕️ Orientation: ${orient}`,
    countLine(s),
    line,
  ];
  for (const w of warnings(s)) lines.push(`⚠️ ${w}`);
  if (withChoices) lines.push('Do you want to continue?', '1️⃣ ✅ PRINT', '2️⃣ ❌ CANCEL', '3️⃣ 🔄 CHANGE OPTIONS');
  return lines.join('\n');
}

function describeOrientations(o) {
  const parts = [];
  if (o.portrait) parts.push(`${o.portrait} portrait`);
  if (o.landscape) parts.push(`${o.landscape} landscape`);
  return parts.length ? `${parts.join(', ')} page${o.portrait + o.landscape === 1 ? '' : 's'} detected` : 'not detected';
}

// Things the printer can't do with these options (filled in from the printer's reported capabilities)
function warnings(s) {
  const w = [];
  const caps = s.caps || {};
  if (s.options.sides === 'duplex' && caps.duplex === false) w.push('This printer does not report two-sided printing - it will fail or print single-sided.');
  if (s.options.color === 'color' && caps.color === false) w.push('This printer does not report color printing.');
  if (caps.paperNames && s.options.size && s.options.size !== 'Printer default' &&
    !caps.paperNames.some(p => p.toLowerCase().startsWith(s.options.size.toLowerCase()))) {
    w.push(`The printer does not list ${s.options.size} paper.`);
  }
  if (s.pages === 0) w.push('Could not read the page count of this PDF; page numbers were not checked.');
  return w;
}

// Options -> SumatraPDF -print-settings value
function sumatraSettings(o) {
  const parts = [];
  if (o.pages && o.pages !== 'all') parts.push(o.pages);
  if (o.copies > 1) parts.push(`${o.copies}x`);
  parts.push(o.color === 'mono' ? 'monochrome' : 'color');
  // Both Side: flip on the long edge for portrait, short edge for landscape (normal book-style)
  if (o.sides === 'duplex') parts.push(o.orientation === 'landscape' ? 'duplexshort' : 'duplexlong');
  else parts.push('simplex');
  if (o.size && o.size !== 'Printer default') parts.push(`paper=${o.size}`);
  // Paper tray by the driver's own name; Auto Select = let the printer choose (no bin given)
  if (o.tray && o.tray !== 'Auto Select') parts.push(`bin=${o.tray}`);
  if (o.orientation === 'portrait' || o.orientation === 'landscape') parts.push(o.orientation);
  // 'auto': no orientation given - SumatraPDF rotates each page to suit its own shape
  return parts.join(',');
}

// ---- PDF page count and page orientations (no external library) ----
// Reads the page tree, including compressed object streams.
function pdfInfo(buf) {
  const texts = [buf.toString('latin1')];
  // Inflate compressed streams (object streams hold the page dictionaries in many modern PDFs)
  const raw = texts[0];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const dictStart = raw.lastIndexOf('<<', m.index);
    const dict = raw.slice(dictStart, m.index);
    if (/FlateDecode/.test(dict) && !/\/Subtype\s*\/Image|\/Length1|\/FontFile/.test(dict) && end - start < 5e6) {
      try {
        const out = zlib.inflateSync(buf.subarray(start, end), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1');
        if (/\/Type\s*\/Page/.test(out)) texts.push(out);
      } catch (e) { /* not a deflate stream we need */ }
    }
    re.lastIndex = end;
  }

  const dictAround = (s, idx) => s.slice(Math.max(0, s.lastIndexOf('<<', idx)), (s.indexOf('>>', idx) + 1 || s.length));
  let treeCount = 0;
  let leaves = 0;
  const orientations = { portrait: 0, landscape: 0 };
  let inheritedBox = null;
  for (const s of texts) {
    for (const mm of s.matchAll(/\/Type\s*\/Pages\b/g)) {
      const d = dictAround(s, mm.index);
      const c = d.match(/\/Count\s+(\d+)/);
      if (c) treeCount = Math.max(treeCount, Number(c[1]));
      const box = d.match(/\/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)/);
      if (box && !inheritedBox) inheritedBox = box;
    }
  }
  for (const s of texts) {
    for (const mm of s.matchAll(/\/Type\s*\/Page(?![s\w])/g)) {
      leaves++;
      const d = dictAround(s, mm.index);
      const box = d.match(/\/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)/) || inheritedBox;
      if (!box) continue;
      let w = Math.abs(box[3] - box[1]);
      let h = Math.abs(box[4] - box[2]);
      const rot = d.match(/\/Rotate\s+(-?\d+)/);
      if (rot && Math.abs(Number(rot[1])) % 180 === 90) [w, h] = [h, w];
      if (w > h) orientations.landscape++; else orientations.portrait++;
    }
  }
  const pages = treeCount || leaves;
  const detected = orientations.portrait + orientations.landscape;
  return { pages, orientations: detected && detected <= pages ? orientations : null };
}

module.exports = { HEADER, STEPS, DIRECT_OPTIONS, LETTERHEAD_OPTIONS, PRESETS, parseQuick, printCount, countLine, question, pollFor, applyAnswer, parsePages, summary, sumatraSettings, pdfInfo, LABELS };
