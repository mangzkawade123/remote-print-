// WhatsApp Auto Print - any PDF sent to this WhatsApp number is printed automatically.
// First run:  start_whatsapp_print.bat  -> scan the QR code with WhatsApp > Linked devices.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const flow = require('./print_flow');

// ---- Settings ----
const PRINTER = 'Brother DCP-T830DW Printer (Copy 1)';
// Phone numbers allowed to print, with country code and no + or spaces, e.g. '919876543210'.
// Leave empty [] to print PDFs from anyone. Applies to personal chats only.
const ALLOWED_NUMBERS = [];
// Print files sent in personal chats too? false = only the print groups below are used.
const PRINT_PERSONAL_CHATS = false;
// Also print photos (JPG/PNG) - fitted to the page
const PRINT_IMAGES = false;
// Ask in the group for copies / color / sides / pages / size / orientation, and wait for PRINT, before printing
const ASK_BEFORE_PRINT = true;
// A print request with no answer for this long is cancelled (reply "reprint" to start it again)
const ANSWER_TIMEOUT_MINUTES = 30;
// A one-tap print (presets 1-4) bigger than this many pages is not started straight away: the bot shows
// the summary with a page alert and waits for PRINT, so a wrong tap can't waste a lot of paper
const LARGE_PRINT_PAGES = 30;

// Where people collect their prints, and the sign-off of the "ready" message
const PRINTER_LOCATION = 'Innovation Zone 1\nTable No 1';
const SIGN_OFF = 'Regards,\nOperation Dept';

// "✅ Your print is ready" message, with the sender's name and how much was printed
function readyMessage(s, note = '') {
  const name = String(s.who || '').replace(/\s*\(.*$/, '').trim();
  const c = flow.printCount(s);
  const o = s.options;
  return `✅ *Your print is ready${name ? `, ${name}` : ''}!*${note}\n📄 ${s.filename}\n` +
    `🧾 ${c ? `${c.totalPages} page${c.totalPages === 1 ? '' : 's'}${c.sheets !== c.totalPages ? ` on ${c.sheets} sheets` : ''}` : 'pages: ?'}` +
    ` · ${o.copies} cop${o.copies === 1 ? 'y' : 'ies'} · ${flow.LABELS.color[o.color]} · ${flow.LABELS.sides[o.sides]}` +
    `${o.tray && o.tray !== 'Tray1' ? ` · ${o.tray}` : ''}\n\n📍 Please collect it from the printer:\n${PRINTER_LOCATION}\n\n${SIGN_OFF}`;
}
// Ask the questions as tap-to-choose polls (typed answers like 1 / 2 / 3 keep working too)
const USE_POLLS = false;
// Print Word files too: they are converted to PDF with the Microsoft Word installed on this PC
const PRINT_WORD = true;
const WORD_EXT = /\.(docx?|rtf)$/i;// WhatsApp groups where every member's PDFs are printed (group name, not case-sensitive).
// Other groups are ignored.
// One group per team keeps each team's files among its own members. Add more names here, then restart.
const PRINT_GROUPS = ['Printing', 'HR Dept', 'Training Dept', 'DM Print'];
const MAX_MB = 25;
// When the program connects, PDFs sent to the print groups in this many minutes before are printed if missed
const CATCH_UP_MINUTES = 60;
// How often to check the print groups for PDFs that were missed (backup to instant printing)
const CHECK_SECONDS = 10;
// Reply sent to the chat after each successful print (as a reply to the PDF). Set to '' to turn off.
const REPLY_TEXT = 'Printed ✅';
// ------------------

const SUMATRA = path.join(__dirname, '..', 'SumatraPDF.exe');
const JOBS_DIR = path.join(__dirname, 'jobs');
const LOG_FILE = path.join(__dirname, 'whatsapp_print.log');
const BROWSER = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => fs.existsSync(p));
fs.mkdirSync(JOBS_DIR, { recursive: true });

function log(text) {
  const line = `[${new Date().toLocaleString()}] ${text}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

const IMAGE_EXT = /\.(jpe?g|png|bmp|gif|tiff?)$/i;
// printSettings: SumatraPDF -print-settings value from the chosen options (see print_flow.js)
function printPdf(file, printSettings) {
  // Photos are scaled to fit the page; PDFs print as they are
  const settings = printSettings ? ['-print-settings', printSettings]
    : IMAGE_EXT.test(file) ? ['-print-settings', 'fit'] : [];
  return new Promise((resolve, reject) => {
    execFile(SUMATRA, ['-print-to', PRINTER, ...settings, '-silent', file], { timeout: 600000 },
      err => (err ? reject(err) : resolve()));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Word file -> PDF using convert_to_pdf.ps1 (Microsoft Word). Resolves with the PDF path.
function convertToPdf(input) {
  const output = input.replace(/\.[^.\\]+$/, '') + '.pdf';
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'convert_to_pdf.ps1'), input, output], { timeout: 120000, windowsHide: true },
    (err, stdout) => {
      if (!err && fs.existsSync(output)) return resolve(output);
      // A conversion that hung leaves a hidden Word behind: close hidden Word windows started by it
      // (never a Word window someone is working in - those have a title)
      execFile('powershell.exe', ['-NoProfile', '-Command',
        `Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { -not $_.MainWindowTitle -and ` +
        `$_.StartTime -ge ([datetime]'${new Date(started - 2000).toISOString()}') } | Stop-Process -Force`],
      () => reject(new Error(String(stdout || (err && err.message) || 'conversion failed').replace(/^ERROR:\s*/, '').trim())));
    });
  });
}

// Fallback download: waits for WhatsApp Web to fetch the file itself, then reads it from the page.
// Returns { data, mimetype, filename } or { error } with the real error details.
function downloadInPage(msgId) {
  return client.pupPage.evaluate(async id => {
    const describe = e => [e && e.name, e && e.message, String(e), e && e.stack && e.stack.split('\n').slice(0, 3).join(' | ')]
      .filter(Boolean).join(' / ');
    const errors = [];
    let Coll, msg;
    try { Coll = window.require('WAWebCollections'); } catch (e) { return { error: 'require: ' + describe(e) }; }
    // Several ways to find the message; ID lookups can fail for senders with the newer @lid ids
    const lookups = [
      ['Msg.get', () => Coll.Msg.get(id)],
      ['scan Msg', () => Coll.Msg.getModelsArray().find(m => m.id && m.id._serialized === id)],
      ['chat msgs', () => {
        const chatId = id.split('_')[1];
        const chat = Coll.Chat.get(chatId) || Coll.Chat.getModelsArray().find(c => c.id && c.id._serialized === chatId);
        return chat && chat.msgs.getModelsArray().find(m => m.id && m.id._serialized === id);
      }],
      ['getMessagesById', async () => (await Coll.Msg.getMessagesById([id]))?.messages?.[0]],
    ];
    for (const [name, fn] of lookups) {
      try { msg = await fn(); if (msg) break; errors.push(name + ': not found'); }
      catch (e) { errors.push(name + ': ' + describe(e)); }
    }
    if (!msg) return { error: 'message not found in WhatsApp Web; ' + errors.join(' || ') };
    if (!msg.mediaData) return { error: 'message has no media data' };

    if (msg.mediaData.mediaStage !== 'RESOLVED') {
      try { await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 }); }
      catch (e) { errors.push('resolve: ' + describe(e)); }
    }
    for (let i = 0; i < 30 && msg.mediaData.mediaStage !== 'RESOLVED'; i++) await new Promise(r => setTimeout(r, 1000));
    const stage = msg.mediaData.mediaStage;

    const toB64 = async buf => {
      const bytes = new Uint8Array(buf); let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    };
    try {
      const blobSrc = msg.mediaData.mediaBlob;
      const blob = blobSrc && (blobSrc.forceToBlob ? blobSrc.forceToBlob() : blobSrc);
      if (blob && blob.arrayBuffer) {
        return { data: await toB64(await blob.arrayBuffer()), mimetype: msg.mimetype, filename: msg.filename };
      }
      errors.push('blob: no mediaBlob (stage ' + stage + ')');
    } catch (e) { errors.push('blob: ' + describe(e)); }

    try {
      const buf = await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
        directPath: msg.directPath, encFilehash: msg.encFilehash, filehash: msg.filehash,
        mediaKey: msg.mediaKey, mediaKeyTimestamp: msg.mediaKeyTimestamp, type: msg.type,
        signal: new AbortController().signal,
      });
      return { data: await toB64(buf), mimetype: msg.mimetype, filename: msg.filename };
    } catch (e) { errors.push('decrypt: ' + describe(e)); }

    return { error: `stage ${stage}; ` + errors.join(' || ') };
  }, msgId);
}

// Direct download: fetch the encrypted file from WhatsApp's media server and decrypt it here,
// using the download path and key that come with the message (does not depend on WhatsApp Web internals).
async function downloadDirect(msg) {
  const d = msg._data || {};
  if (!d.directPath || !d.mediaKey) {
    const keys = Object.keys(d).filter(k => /media|path|hash|key|url/i.test(k)).join(', ');
    throw new Error(`no download path/key in message (fields: ${keys || 'none'})`);
  }
  const url = d.directPath.startsWith('http') ? d.directPath : `https://mmg.whatsapp.net${d.directPath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`media server returned ${res.status}`);
  const enc = Buffer.from(await res.arrayBuffer());

  const keys = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(d.mediaKey, 'base64'), Buffer.alloc(32),
    d.type === 'image' ? 'WhatsApp Image Keys' : 'WhatsApp Document Keys', 112));
  const iv = keys.subarray(0, 16), cipherKey = keys.subarray(16, 48), macKey = keys.subarray(48, 80);
  const body = enc.subarray(0, enc.length - 10), mac = enc.subarray(enc.length - 10);
  const expected = crypto.createHmac('sha256', macKey).update(iv).update(body).digest().subarray(0, 10);
  if (!expected.equals(mac)) throw new Error('file check failed (wrong key or damaged download)');
  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
  const data = Buffer.concat([decipher.update(body), decipher.final()]);
  return { data: data.toString('base64'), mimetype: d.mimetype, filename: d.filename };
}

async function downloadPdf(msg) {
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await downloadDirect(msg);
    } catch (e) {
      lastError = `direct: ${e.message}`;
    }
    try {
      const media = await msg.downloadMedia();
      if (media && media.data) return media;
      lastError += ' | library: returned nothing';
    } catch (e) {
      lastError += ` | library: ${e.message}`;
    }
    let res;
    try { res = await downloadInPage(msg.id._serialized); }
    catch (e) { res = { error: `page error: ${e.message}` }; }
    if (res && res.data) return res;
    lastError += ` | fallback: ${res && res.error}`;
    log(`Download attempt ${attempt} failed: ${lastError}`);
    await sleep(5000);
  }
  throw new Error(lastError);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, 'session') }),
  puppeteer: { headless: true, executablePath: BROWSER },
});

// The QR code is also saved as an image with a page that refreshes itself (qr.html), so it can be
// scanned even when the program runs hidden. The page is opened on screen once.
const QR_PNG = path.join(__dirname, 'qr.png');
const QR_HTML = path.join(__dirname, 'qr.html');
let qrPageOpened = false;
// WhatsApp Web stops making new QR codes after about 2 minutes; restart (start_hidden.vbs starts the
// program again) so a fresh code keeps appearing until someone scans it
let qrTimeout = null;
function writeQrPage(body) {
  fs.writeFileSync(QR_HTML, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="4">
<title>WhatsApp Print - link</title><style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px;
background:#fff;color:#111}img{width:320px;height:320px;image-rendering:pixelated;border:12px solid #fff}</style></head>
<body>${body}</body></html>`);
}
client.on('qr', async qr => {
  log('Scan this QR code in WhatsApp > Settings > Linked devices > Link a device:');
  qrcode.generate(qr, { small: true });
  if (!qrTimeout) {
    qrTimeout = setTimeout(() => {
      writeQrPage('<h2>Getting a new QR code…</h2><p>This page updates by itself in about 40 seconds.</p>');
      log('QR codes expired without a scan - restarting for a fresh code');
      client.destroy().catch(() => {}).finally(() => process.exit(1));
    }, 110000);
  }
  try {
    const canvas = await client.pupPage.$('canvas');
    if (canvas) await canvas.screenshot({ path: QR_PNG });
    writeQrPage(`<h2>Scan with WhatsApp</h2><p>Phone: WhatsApp → Settings → Linked devices → Link a device</p>
<img src="qr.png?${Date.now()}" alt="QR code"><p>The code changes every 20 seconds; this page updates by itself.</p>`);
    // Open the page on screen once (not again on every restart for a fresh code within 30 minutes)
    const marker = path.join(__dirname, 'qr_opened.txt');
    let openedAt = 0;
    try { openedAt = Number(fs.readFileSync(marker, 'utf8')) || 0; } catch (e) { /* never opened */ }
    if (!qrPageOpened && Date.now() - openedAt > 30 * 60000) {
      qrPageOpened = true;
      fs.writeFileSync(marker, String(Date.now()));
      execFile('cmd.exe', ['/c', 'start', '', QR_HTML], { windowsHide: true });
    }
  } catch (e) {
    log(`Note: could not save the QR image (${e.message})`);
  }
});
client.on('authenticated', () => {
  clearTimeout(qrTimeout);
  if (!fs.existsSync(QR_HTML)) return;
  writeQrPage('<h2>✅ Linked - WhatsApp printing is connected.</h2><p>You can close this page.</p>');
  try { fs.unlinkSync(QR_PNG); } catch (e) { /* ignore */ }
});
// If WhatsApp gets stuck loading after login, exit so start_hidden.vbs restarts the program
let readyWatchdog, setupRetry, isReady = false, watching = false;
client.on('authenticated', () => {
  if (watching) return; // the setup retry below emits 'authenticated' again
  watching = true;
  log('Logged in, loading chats...');
  // The library's setup step after login sometimes fails silently; rerun it once and log the real error
  setupRetry = setTimeout(async () => {
    if (isReady) return;
    log('Not ready after 45 s - retrying setup...');
    try {
      const err = await client.pupPage.evaluate(async () => {
        // Remove the half-finished setup so the library redoes all of it, including the message listeners
        delete window.WWebJS;
        try { await window.onAppStateHasSyncedEvent(); return null; } catch (e) { return String((e && e.message) || e); }
      });
      if (err) log(`Setup error: ${err}`);
    } catch (e) { log(`Setup retry failed: ${e.message}`); }
  }, 45000);
  readyWatchdog = setTimeout(async () => {
    log('Stuck loading for 2 minutes - restarting.');
    try { await client.destroy(); } catch (e) { /* ignore */ }
    process.exit(1);
  }, 120000);
});
client.on('loading_screen', (percent, text) => log(`Loading ${percent}% ${text || ''}`));
client.on('change_state', state => log(`State: ${state}`));
// WhatsApp Web sometimes shows a "What's new" pop-up after login that blocks loading; click its Continue button
let popupTimer;
client.on('authenticated', () => {
  clearInterval(popupTimer);
  popupTimer = setInterval(async () => {
    try {
      const clicked = await client.pupPage.evaluate(() => {
        const btn = [...document.querySelectorAll('[role="dialog"] button, div[data-animate-modal-popup] button, button')]
          .find(b => /^(continue|ok|got it)$/i.test((b.innerText || '').trim()));
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (clicked) log('Closed a WhatsApp pop-up');
    } catch (e) { /* page still loading */ }
  }, 5000);
});
client.on('ready', () => { isReady = true; clearTimeout(readyWatchdog); clearTimeout(setupRetry); clearInterval(popupTimer); });
client.on('ready', async () => {
  log(`Connected to WhatsApp. Waiting for PDFs (printer: ${PRINTER}).`);
  await catchUp();
  if (ASK_BEFORE_PRINT) await inFlow(resumeRequests);
  // Safety net: live message notifications from WhatsApp Web are not always reliable,
  // so check for unprinted PDFs every minute as well
  clearInterval(pollTimer);
  lastGoodCheck = Date.now();
  pollTimer = setInterval(async () => {
    if (Date.now() - lastGoodCheck > 5 * 60000) {
      log('PDF checks have not completed for 5 minutes - restarting.');
      try { await client.destroy(); } catch (e) { /* ignore */ }
      process.exit(1);
    }
    catchUp(true).catch(e => log(`Check failed: ${e.message}`));
  }, CHECK_SECONDS * 1000);
});
let pollTimer, lastGoodCheck = Date.now();
client.on('auth_failure', m => log(`Login failed: ${m}. Delete the "session" folder and scan again.`));
client.on('disconnected', reason => {
  log(`Disconnected (${reason}). Reconnecting in 30 s...`);
  setTimeout(() => client.initialize(), 30000);
});

// Record of printed message ids, so a PDF is never printed twice (live + catch-up, or after a restart)
const PRINTED_FILE = path.join(__dirname, 'printed.json');
let printedIds = new Set();
try { printedIds = new Set(JSON.parse(fs.readFileSync(PRINTED_FILE, 'utf8'))); } catch (e) { /* first run */ }
// Same file from the same chat printed recently: the check skips it (people often resend when a print is slow)
const RECENT_FILE = path.join(__dirname, 'recent_prints.json');
let recentPrints = {};
try { recentPrints = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8')); } catch (e) { /* first run */ }
const fileKey = (chatId, filename) => `${chatId}|${filename}`;
function printedRecently(chatId, chatName, filename) {
  const t = recentPrints[fileKey(chatId, filename)] || (chatName && recentPrints[fileKey(chatName, filename)]);
  return t && Date.now() - t < CATCH_UP_MINUTES * 60000;
}
function markPrinted(id, chatId, filename, chatName) {
  printedIds.add(id);
  fs.writeFileSync(PRINTED_FILE, JSON.stringify([...printedIds].slice(-2000)));
  if (chatId && filename) {
    recentPrints[fileKey(chatId, filename)] = Date.now();
    if (chatName) recentPrints[fileKey(chatName, filename)] = Date.now();
    for (const k of Object.keys(recentPrints)) if (Date.now() - recentPrints[k] > 24 * 3600000) delete recentPrints[k];
    fs.writeFileSync(RECENT_FILE, JSON.stringify(recentPrints));
  }
}

// ---- Print requests: ask for options in the group, print only after PRINT ----
// One request is asked at a time per program; others wait in order. Saved in sessions.json so a
// restart never loses a request and never prints one that was not confirmed.
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
let store = { sessions: [], answerKeys: [] };
try { store = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch (e) { /* first run */ }
const answerKeys = new Set(store.answerKeys || []);
function saveStore() {
  // Keep finished requests for a while (for "reprint"), drop old ones
  const active = s => ['waiting', 'asking', 'printing'].includes(s.status);
  store.sessions = store.sessions.filter((s, i, all) => active(s) || i >= all.length - 50);
  store.answerKeys = [...answerKeys].slice(-1000);
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(store, null, 1));
}

// All request changes run one after another, so live answers and the backup check can't clash
let flowTail = Promise.resolve();
function inFlow(fn) {
  flowTail = flowTail.then(fn).catch(e => log(`ERROR in print request: ${e.message}\n${e.stack}`));
  return flowTail;
}

// Printer capabilities as reported by the Windows driver (read once)
let printerCaps = null;
function psRun(command) {
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-Command', command],
    { timeout: 30000 }, (err, out) => (err ? reject(err) : resolve(String(out).trim()))));
}
const psName = PRINTER.replace(/'/g, "''");
async function getPrinterCaps() {
  if (printerCaps) return printerCaps;
  try {
    const out = await psRun(`$p = Get-CimInstance Win32_Printer | Where-Object Name -eq '${psName}'; ` +
      `@{ caps = @($p.Capabilities); papers = @($p.PrinterPaperNames) } | ConvertTo-Json -Compress`);
    const j = JSON.parse(out);
    // Win32_Printer capability codes: 2 = Color, 3 = Duplex
    printerCaps = { color: j.caps.includes(2), duplex: j.caps.includes(3), paperNames: j.papers };
    log(`Printer reports: color ${printerCaps.color ? 'yes' : 'no'}, two-sided ${printerCaps.duplex ? 'yes' : 'no'}, ${j.papers.length} paper sizes`);
  } catch (e) {
    log(`Note: could not read printer capabilities (${e.message})`);
    printerCaps = {};
  }
  return printerCaps;
}

// Is the printer there and ready? Returns '' when OK, otherwise a short problem description.
async function printerProblem() {
  try {
    const out = await psRun(`$p = Get-Printer -Name '${psName}' -ErrorAction Stop; ` +
      `$w = (Get-CimInstance Win32_Printer | Where-Object Name -eq '${psName}').WorkOffline; "$($p.PrinterStatus)|$w"`);
    const [status, offline] = out.split('|');
    if (offline === 'True') return 'the printer is set to "Use printer offline" in Windows';
    if (!/^(Normal|Printing|Idle|Processing|Warmup)$/i.test(status)) return `the printer reports "${status}"`;
    return '';
  } catch (e) {
    return `the printer "${PRINTER}" was not found in Windows`;
  }
}

// After sending a file to the printer, follow the job in the Windows print queue so the group is told
// what really happened (a printer that is off or has a paper error keeps the job with an Error state).
async function jobState(file) {
  const doc = file.replace(/'/g, "''");
  try {
    const out = await psRun(`$j = @(Get-PrintJob -PrinterName '${psName}' -ErrorAction SilentlyContinue | ` +
      `Where-Object DocumentName -eq '${doc}'); $p = (Get-Printer -Name '${psName}' -ErrorAction SilentlyContinue).PrinterStatus; ` +
      `@{ job = $(if ($j.Count) { [string]$j[0].JobStatus } else { '' }); printer = [string]$p } | ConvertTo-Json -Compress`);
    return JSON.parse(out);
  } catch (e) {
    return { job: '', printer: '', unknown: e.message };
  }
}
const isJobError = st => /error|offline|paper|jam|blocked|intervention|deleting/i.test(`${st.job} ${st.job ? st.printer : ''}`);

// Returns 'done' (left the queue without error), 'error' or 'pending' (still printing after the wait)
async function watchJob(file, seconds) {
  let last = null;
  for (let waited = 0; waited <= seconds; waited += 3) {
    const st = await jobState(file);
    last = st;
    if (!st.job && !st.unknown) return { outcome: 'done', st };
    if (st.job && isJobError(st)) return { outcome: 'error', st };
    await sleep(3000);
  }
  return { outcome: 'pending', st: last };
}

function problemText(st) {
  const p = String(st.printer || '');
  if (/offline/i.test(p)) return 'the printer is off or disconnected';
  if (/paper/i.test(`${p} ${st.job}`)) return 'the printer has a paper problem (tray / paper size / no paper)';
  return `the printer reports "${p || st.job}" - it may be switched off, out of paper, or showing an error`;
}

// Keeps following a job that is stuck or still printing, and posts the outcome when it changes
async function followJob(s, firstOutcome) {
  let reportedError = firstOutcome === 'error';
  const until = Date.now() + 30 * 60000;
  while (Date.now() < until) {
    await sleep(15000);
    const st = await jobState(s.file);
    if (!st.job && !st.unknown) {
      log(`Print completed later: "${s.filename}"`);
      return sendBot(s.chatId, readyMessage(s, reportedError ? ' (after the printer problem was fixed)' : ''));
    }
    if (isJobError(st) && !reportedError) {
      reportedError = true;
      log(`Printer problem while printing "${s.filename}": ${st.printer} / ${st.job}`);
      await sendBot(s.chatId, `⚠️ Not printed yet: ${s.filename}\nProblem: ${problemText(st)}.\nThe file is waiting in the print queue and will print when the printer is fixed. I'll post here when it's done.`);
    }
  }
  log(`Still not printed after 30 minutes: "${s.filename}"`);
  return sendBot(s.chatId, `⚠️ Still not printed after 30 minutes: ${s.filename}\nPlease check the printer (switched on? paper? error on its screen?). The file is still waiting in the print queue.`);
}

async function sendBot(chatId, text) {
  const withTimeout = p => Promise.race([p, sleep(30000).then(() => { throw new Error('timed out'); })]);
  try { await withTimeout(client.sendMessage(chatId, `${flow.HEADER}\n${text}`)); }
  catch (e) { log(`Note: could not send message to the group (${e.message})`); }
}

const activeIn = chatId => store.sessions.find(s => s.chatId === chatId && ['asking', 'printing'].includes(s.status));

async function ask(s, note = '') {
  s.askedAt = Math.floor(Date.now() / 1000) - 1;
  s.lastActivity = Date.now();
  s.pollId = null;
  const poll = USE_POLLS ? flow.pollFor(s.step, s) : null;
  if (poll) {
    // The summary is a normal message; the PRINT / CANCEL / CHANGE choice is the poll after it
    if (s.step === 'confirm') await sendBot(s.chatId, (note ? `${note}\n` : '') + flow.summary(s, false));
    else if (note) await sendBot(s.chatId, note);
    try {
      const msg = await Promise.race([
        client.sendMessage(s.chatId, new Poll(poll.name, poll.options.map(o => o.label), { allowMultipleAnswers: false })),
        sleep(30000).then(() => { throw new Error('timed out'); })]);
      s.pollId = msg && msg.id && msg.id._serialized;
      s.pollT = msg && msg.timestamp;
      s.pollName = poll.name;
      s.pollOptions = poll.options;
      saveStore();
      return;
    } catch (e) {
      log(`Note: could not send poll (${e.message}) - asking as text instead`);
    }
  }
  saveStore();
  await sendBot(s.chatId, (note && !poll ? `${note}\n` : '') + flow.question(s.step, s));
}

async function startNext() {
  const chats = [...new Set(store.sessions.filter(s => s.status === 'waiting').map(s => s.chatId))];
  for (const chatId of chats) {
    if (activeIn(chatId)) continue;
    const s = store.sessions.find(x => x.chatId === chatId && x.status === 'waiting');
    s.status = 'asking';
    s.step = 'start';
    s.options = {};
    s.changing = false;
    const waiting = store.sessions.filter(x => x.chatId === chatId && x.status === 'waiting').length;
    await ask(s, waiting ? `(${waiting} more file${waiting === 1 ? '' : 's'} waiting after this one)` : '');
  }
}

// New PDF -> new request (asked when it's this file's turn)
async function createRequest(info) {
  // The same PDF can arrive live and through the backup check at the same moment, with differently
  // written message ids; group + file name + send time is identical on both paths.
  if (store.sessions.some(x => x.detectKey === info.detectKey)) {
    log(`Duplicate detection of "${info.filename}" ignored (already has a print request)`);
    try { fs.unlinkSync(info.file); } catch (e) { /* ignore */ }
    return;
  }
  const buf = fs.readFileSync(info.file);
  let pdf = { pages: 0, orientations: null };
  try { pdf = flow.pdfInfo(buf); } catch (e) { log(`Note: could not read page count of "${info.filename}" (${e.message})`); }
  const s = {
    id: Date.now(), ...info, pages: pdf.pages, orientations: pdf.orientations,
    caps: await getPrinterCaps(), status: 'waiting', step: null, options: {}, created: new Date().toLocaleString(),
  };
  store.sessions.push(s);
  log(`PDF detected: "${s.filename}" (${s.pages || '?'} pages) from ${s.who} - waiting for print options`);
  saveStore();
  await startNext();
}

function logOptions(s) {
  const o = s.options;
  log(`Options for "${s.filename}": copies ${o.copies}, ${o.color === 'mono' ? 'black & white' : 'color'}, ` +
    `${o.sides === 'duplex' ? 'both sides' : 'single side'}, pages ${o.pages === 'all' ? 'all' : o.pages}, ` +
    `paper ${o.size}, tray ${o.tray || 'Auto Select'}, orientation ${o.orientation}`);
}

async function finish(s, status) {
  s.status = status;
  s.lastActivity = Date.now();
  saveStore();
  await startNext();
}

async function doPrint(s) {
  const problem = await printerProblem();
  if (problem) {
    log(`Print not started for "${s.filename}": ${problem}`);
    s.step = 'confirm';
    saveStore();
    return ask(s, `⚠️ Can't print right now: ${problem}.\nCheck the printer, then choose PRINT to try again. The request is kept.`);
  }
  const settings = flow.sumatraSettings(s.options);
  s.status = 'printing';
  saveStore();
  log(`Print started: "${s.filename}" (SumatraPDF settings: ${settings})`);
  try {
    await printPdf(s.file, settings);
    if (s.msgId) markPrinted(s.msgId, s.chatId, s.filename, s.groupName);
    const details = `🖨️ ${s.options.copies} cop${s.options.copies === 1 ? 'y' : 'ies'} · ` +
      `${flow.LABELS.color[s.options.color]} · ${flow.LABELS.sides[s.options.sides]} · pages ${s.options.pages === 'all' ? 'all' : s.options.pages} · ${s.options.size} · ${s.options.tray || 'Auto Select'}`;
    // Watch the Windows print queue for up to a minute to see what the printer did with it
    const { outcome, st } = await watchJob(s.file, 60);
    if (outcome === 'done') {
      log(`Print completed: "${s.filename}" from ${s.who}`);
      await sendBot(s.chatId, readyMessage(s));
    } else if (outcome === 'error') {
      log(`Printer problem: "${s.filename}" - ${st.printer} / ${st.job}`);
      await sendBot(s.chatId, `⚠️ Not printed yet: ${s.filename}\nProblem: ${problemText(st)}.\n` +
        `The file is waiting in the print queue and will print when the printer is fixed. I'll post here when it's done.`);
    } else {
      log(`Still printing after 1 minute: "${s.filename}"`);
      await sendBot(s.chatId, `🖨️ Printing: ${s.filename}\n${details}\n${flow.countLine(s)}\nI'll post here when it's ready.`);
    }
    await finish(s, 'printed');
    // Keep following a job that hasn't finished (not awaited, so other requests continue meanwhile)
    if (outcome !== 'done') followJob(s, outcome).catch(e => log(`Note: stopped following "${s.filename}" (${e.message})`));
  } catch (e) {
    log(`Print failed: "${s.filename}": ${e.message}`);
    s.status = 'asking';
    s.step = 'confirm';
    saveStore();
    await ask(s, `⚠️ Print failed: ${e.message}\nChoose PRINT to try again. The request is kept.`);
  }
}

// A text message in a group. key makes sure the same message is handled once, whether it arrives
// live or through the backup check.
async function handleAnswer({ chatId, t, authorUser, fromMe, body }) {
  body = String(body || '').trim();
  if (!body || (fromMe && body.startsWith(flow.HEADER))) return; // the bot's own messages
  const key = `${chatId}|${t}|${fromMe ? 'me' : authorUser}|${body}`;
  if (answerKeys.has(key)) return;
  answerKeys.add(key);

  const s = activeIn(chatId);
  const mayAnswer = x => fromMe || (authorUser && authorUser === x.senderUser);

  // "reprint": start the last finished/cancelled request in this chat again (file is kept)
  if (/^re-?print$/i.test(body)) {
    const last = [...store.sessions].reverse().find(x => x.chatId === chatId &&
      ['cancelled', 'expired', 'printed', 'failed'].includes(x.status) && fs.existsSync(x.file));
    if (!last || !mayAnswer(last) || t * 1000 < (last.lastActivity || 0) - 5000) return saveStore();
    log(`Reprint requested for "${last.filename}"`);
    store.sessions.push({ ...last, id: Date.now(), msgId: null, status: 'waiting', step: null, options: {}, created: new Date().toLocaleString() });
    saveStore();
    return startNext();
  }

  if (!s || s.status !== 'asking' || t < s.askedAt || !mayAnswer(s)) return saveStore();
  return processAnswer(s, chatId, body);
}

// A tap on one of the bot's polls. Only taps on the current question's poll count.
async function handleVote({ chatId, pollId, pollT, voterUser, fromMe, optionName, ts }) {
  const s = activeIn(chatId);
  if (!s || s.status !== 'asking' || !s.pollOptions) return;
  if (!(pollId && pollId === s.pollId) && !(pollT && pollT === s.pollT)) return; // an older poll
  const key = `vote|${s.pollId || s.pollT}|${fromMe ? 'me' : voterUser}|${optionName}|${ts}`;
  if (answerKeys.has(key)) return;
  answerKeys.add(key);
  if (!(fromMe || (voterUser && voterUser === s.senderUser))) {
    log(`Poll tap ignored from ${voterUser || 'unknown'} for "${s.filename}" (only the sender ${s.senderUser} or you can answer)`);
    return saveStore();
  }
  const option = s.pollOptions.find(o => o.label === optionName);
  if (!option) return saveStore();
  log(`Poll answer for "${s.filename}" (${s.step}): ${optionName}`);
  if (option.answer === 'custom') {
    s.lastActivity = Date.now();
    s.pollOptions = null; // further taps on this poll are ignored; the number is typed
    saveStore();
    return sendBot(chatId, '✏️ Type the number of copies, e.g. 5');
  }
  s.pollOptions = null; // one answer per poll
  return processAnswer(s, chatId, option.answer);
}

// Applies an answer (typed or tapped) to the request and moves the conversation on
async function processAnswer(s, chatId, body) {
  const r = flow.applyAnswer(s, body);
  s.lastActivity = Date.now();
  if (!r.ok) {
    saveStore();
    return sendBot(chatId, `⚠️ ${r.error}`);
  }
  if (r.action === 'cancel') {
    log(`Print cancelled: "${s.filename}"`);
    await sendBot(chatId, `❌ Print cancelled: ${s.filename}\n(Reply *reprint* to choose options for it again.)`);
    return finish(s, 'cancelled');
  }
  if (r.action === 'print') {
    if (s.step === 'start') log(`${s.presetName || (s.letterhead ? 'Letterhead' : 'Direct Print')} chosen for "${s.filename}"`);
    logOptions(s);
    // Page alert: a big one-tap print waits for confirmation instead of printing straight away
    const count = flow.printCount(s);
    if (s.step === 'start' && count && count.totalPages > LARGE_PRINT_PAGES) {
      log(`Large print (${count.totalPages} pages) - asking for confirmation: "${s.filename}"`);
      s.step = 'confirm';
      return ask(s, `⚠️ *Big print: ${count.totalPages} pages${count.sheets !== count.totalPages ? ` (${count.sheets} sheets)` : ''}.* Please confirm.`);
    }
    saveStore();
    if (s.letterhead) {
      await sendBot(chatId, `📜 Letterhead print: put the letterhead paper in the ${s.options.tray} (manual feed slot), ` +
        `${count && count.sheets > 1 ? `${count.sheets} sheets, ` : ''}letterhead facing the way your printer needs. Printing now...`);
    }
    return doPrint(s);
  }
  s.step = r.next;
  if (r.next === 'confirm') { s.changing = false; logOptions(s); }
  return ask(s);
}

// Every check: cancel requests nobody answered in time
async function expireRequests() {
  for (const s of store.sessions.filter(x => x.status === 'asking')) {
    if (Date.now() - (s.lastActivity || 0) < ANSWER_TIMEOUT_MINUTES * 60000) continue;
    log(`Print request expired (no answer for ${ANSWER_TIMEOUT_MINUTES} min): "${s.filename}"`);
    await sendBot(s.chatId, `⏰ No answer for ${ANSWER_TIMEOUT_MINUTES} minutes - print request cancelled: ${s.filename}\n(Reply *reprint* to start it again.)`);
    await finish(s, 'expired');
  }
}

// After a restart: continue open requests (never print one that was not confirmed)
async function resumeRequests() {
  for (const s of store.sessions.filter(x => x.status === 'printing')) {
    // Stopped in the middle of printing: ask again instead of risking a double print
    s.status = 'asking';
    s.step = 'confirm';
    log(`Print of "${s.filename}" was interrupted by a restart - asking for confirmation again`);
  }
  for (const s of store.sessions.filter(x => x.status === 'asking')) {
    s.lastActivity = Date.now();
    await ask(s, '(continuing after a restart)');
  }
  await startNext();
}

// On connect, print PDFs sent to the print groups in the last CATCH_UP_MINUTES that were missed
// (sent while the PC was off, or failed earlier).
// WhatsApp Web can silently stop receiving messages while still looking connected. If its connection
// isn't CONNECTED for 90 seconds, restart the program (start_hidden.vbs starts it again).
let lastSocket = '', notConnectedSince = 0;
function checkConnection(socket) {
  if (!socket) return;
  const text = `${socket.state}/${socket.stream}`;
  if (text !== lastSocket) { log(`WhatsApp connection: ${text}`); lastSocket = text; }
  if (socket.state === 'CONNECTED') { notConnectedSince = 0; return; }
  if (!notConnectedSince) notConnectedSince = Date.now();
  if (Date.now() - notConnectedSince > 90000) {
    log('WhatsApp has not been connected for 90 seconds - restarting the connection.');
    client.destroy().catch(() => {}).finally(() => process.exit(1));
  }
}

const failCounts = new Map();
let catchUpRunning = 0; // start time of the running check, 0 when idle
async function catchUp(quiet = false) {
  if (catchUpRunning) {
    if (Date.now() - catchUpRunning < 3 * 60000) return;
    log('Previous PDF check was stuck for 3 minutes - starting a new one');
  }
  const started = Date.now();
  catchUpRunning = started;
  try { await catchUpOnce(quiet); } finally { if (catchUpRunning === started) catchUpRunning = 0; }
}

async function catchUpOnce(quiet) {
  let since = Date.now() / 1000 - CATCH_UP_MINUTES * 60;
  // One-time reprint: reprint.json = {"chat": "<chat id>", "minutes": 180} prints that chat's missed PDFs
  // from further back, then the file is deleted.
  const REPRINT_FILE = path.join(__dirname, 'reprint.json');
  let reprint = null;
  try { reprint = JSON.parse(fs.readFileSync(REPRINT_FILE, 'utf8')); fs.unlinkSync(REPRINT_FILE); } catch (e) { /* none */ }
  const reprintSince = reprint ? Date.now() / 1000 - reprint.minutes * 60 : since;
  if (reprint) log(`One-time reprint for ${reprint.chat}, last ${reprint.minutes} minutes`);
  const wanted = PRINT_GROUPS.map(g => g.toLowerCase());
  let groups;
  try {
    // Read the groups' recent messages straight from the WhatsApp page (the library's chat functions break often)
    const openPolls = store.sessions.filter(s => s.status === 'asking' && s.pollOptions && (s.pollId || s.pollT))
      .map(s => ({ chatId: s.chatId, pollId: s.pollId, pollT: s.pollT }));
    groups = await client.pupPage.evaluate(async (names, ids, since, reprintChat, reprintSince, printImages, personalChats, openPolls, printWord) => {
      const str = v => (v == null ? undefined : String(v));
      const Coll = window.require('WAWebCollections');
      // Connection state of WhatsApp Web (used to detect a connection that has silently stopped)
      let socket = null;
      try { const S = window.require('WAWebSocketModel').Socket; socket = { state: str(S.state), stream: str(S.stream) }; } catch (e) { /* unknown */ }
      // WhatsApp Web only keeps messages in memory for chats it has loaded. Ask it to load the
      // print groups' latest messages (like scrolling up in the chat) when none are recent enough.
      for (const c of Coll.Chat.getModelsArray()) {
        if (!(c.id && c.id.server === 'g.us' &&
          (names.includes(String(c.formattedTitle || c.name || '').toLowerCase()) || ids.includes(c.id._serialized)))) continue;
        for (let i = 0; i < 3; i++) {
          const loaded = c.msgs.getModelsArray();
          const oldest = loaded.length ? Math.min(...loaded.map(m => m.t || 0)) : Infinity;
          if (loaded.length && oldest <= since) break; // already covers the whole catch-up window
          try {
            const more = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat: c });
            if (!more || !more.length) break;
          } catch (e) { break; }
        }
      }
      // A chat's loaded messages don't always include new ones, so also use all messages in memory
      // PDFs are not always typed 'document' (e.g. ones with a page preview), so also check file type and name
      // Printable: PDFs (not always typed 'document'), and photos if enabled
      // A 'document' with another file name (e.g. .docx) is not a PDF
      const isPdf = m => m.mimetype === 'application/pdf' || /\.pdf$/i.test(String(m.filename || '')) ||
        (m.type === 'document' && !m.filename && !m.mimetype) ||
        (printWord && /\.(docx?|rtf)$/i.test(String(m.filename || ''))) ||
        (printImages && m.type === 'image' && /^image\/(jpeg|png)/.test(String(m.mimetype || '')));
      const allDocs = Coll.Msg.getModelsArray().filter(isPdf);
      // Newer message ids may not have _serialized; toString() gives the same text
      const idOf = m => (m.id && (m.id._serialized || (m.id.toString && m.id.toString()))) || '';
      const remoteOf = m => (m.id && m.id.remote && (m.id.remote._serialized || String(m.id.remote))) || '';
      const msgsOf = c => {
        const byId = new Map();
        for (const m of c.msgs.getModelsArray()) byId.set(idOf(m), m);
        for (const m of allDocs) if (remoteOf(m) === c.id._serialized) byId.set(idOf(m), m);
        byId.delete('');
        return [...byId.values()];
      };
      const chats = Coll.Chat.getModelsArray()
        .filter(c => c.id && (c.id.server === 'g.us'
          ? names.includes(String(c.formattedTitle || c.name || '').toLowerCase()) || ids.includes(c.id._serialized)
          : personalChats && c.id.server !== 'broadcast' && c.id.user !== 'status'))
        .map(c => ({
          name: String(c.formattedTitle || c.name || ''),
          id: c.id._serialized,
          isGroup: c.id.server === 'g.us',
          loaded: c.msgs.getModelsArray().length,
          // Labels of the latest messages (type / file type only, no content) for troubleshooting
          lastTypes: c.id.server === 'g.us'
            ? c.msgs.getModelsArray().slice(-5).map(m => `${m.type}/${m.mimetype || '-'}/${idOf(m) ? 'id' : 'NO-ID'}`)
            : undefined,
          // Recent text messages in print groups: answers to the print questions (backup to live events)
          texts: c.id.server !== 'g.us' ? [] : c.msgs.getModelsArray()
            .filter(m => m.type === 'chat' && m.t >= Date.now() / 1000 - 45 * 60)
            .map(m => ({ t: m.t, body: str(m.body), fromMe: !!m.id.fromMe,
              author: m.author ? (m.author._serialized || String(m.author)) : '' })),
          msgs: msgsOf(c)
            .filter(m => isPdf(m) && (!m.id.fromMe || c.id.server === 'g.us') &&
              m.t >= ((c.id._serialized === reprintChat || (m.from && m.from._serialized === reprintChat))
                ? reprintSince : since))
            .map(m => ({
              id: idOf(m), author: m.author ? (m.author._serialized || String(m.author)) : '', t: m.t, fromMe: !!m.id.fromMe,
              data: { directPath: str(m.directPath), mediaKey: str(m.mediaKey), filename: str(m.filename),
                mimetype: str(m.mimetype), notifyName: str(m.notifyName), type: str(m.type) },
            })),
        }));
      // Taps on the bot's open polls (backup to the live vote events)
      const pollVotes = [];
      for (const p of openPolls) {
        try {
          const chat = Coll.Chat.get(p.chatId);
          const pool = [...(chat ? chat.msgs.getModelsArray() : []), ...Coll.Msg.getModelsArray().filter(m => remoteOf(m) === p.chatId)];
          const pm = pool.find(m => m.type === 'poll_creation' && (idOf(m) === p.pollId || (p.pollT && m.t === p.pollT)));
          if (!pm) continue;
          const rows = await window.require('WAWebPollsVotesSchema').getTable().equals(['parentMsgKey'], pm.id.toString());
          const names = new Map((pm.pollOptions || []).map(o => [o.localId, o.name]));
          pollVotes.push({ ...p, votes: rows.map(v => {
            const who = v.sender || v.author || v.from || v.senderJid;
            const ids = Array.from(new Uint8Array(v.selectedOptionLocalIds || []));
            return { sender: who ? str(who._serialized || who) : '', optionName: ids.length ? names.get(ids[0]) : null,
              ts: v.senderTimestampMs || v.t || 0, keys: who ? undefined : Object.keys(v).join(',') };
          }) });
        } catch (e) { pollVotes.push({ ...p, error: String(e && e.message || e) }); }
      }
      // This account's own ids (phone and @lid), to recognise your own taps
      let me = [];
      try { const U = window.require('WAWebUserPrefsMeUser'); me = [U.getMaybeMePnUser(), U.getMaybeMeLidUser()].filter(Boolean).map(w => w.user); } catch (e) { /* unknown */ }
      return { socket, chats, pollVotes, me };
    }, wanted, PRINT_GROUPS, since, reprint && reprint.chat, reprintSince, PRINT_IMAGES, PRINT_PERSONAL_CHATS, openPolls, PRINT_WORD);
    checkConnection(groups.socket);
    for (const u of groups.me || []) meUsers.add(String(u));
    for (const p of groups.pollVotes || []) {
      if (p.error) { log(`Note: could not read poll taps (${p.error})`); continue; }
      for (const v of p.votes) {
        if (!v.optionName) { if (v.keys) log(`Note: poll tap without sender (fields: ${v.keys})`); continue; }
        const voterUser = String(v.sender || '').split('@')[0].split(':')[0];
        inFlow(() => handleVote({ chatId: p.chatId, pollId: p.pollId, pollT: p.pollT, voterUser,
          fromMe: meUsers.has(voterUser), optionName: v.optionName, ts: v.ts }));
      }
    }
    groups = groups.chats;
  } catch (e) {
    return log(`Catch-up skipped: could not read groups (${e.message})`);
  }
  lastGoodCheck = Date.now();
  // Status file for checking the program is alive (time of last check and what it saw)
  try {
    fs.writeFileSync(path.join(__dirname, 'status.json'), JSON.stringify({
      lastCheck: new Date().toLocaleString(),
      chats: groups.filter(g => g.isGroup || g.msgs.length).map(g => ({
        name: g.name, messagesLoaded: g.loaded, lastTypes: g.lastTypes, recentPdfs: g.msgs.length, unprinted: g.msgs.filter(m => !printedIds.has(m.id)).length })),
    }, null, 1));
  } catch (e) { /* not important */ }
  if (!quiet && !groups.some(g => g.isGroup)) log(`Catch-up: no group named ${PRINT_GROUPS.join(', ')} found`);
  // Answers that the live events missed, oldest first
  for (const g of groups.filter(x => x.isGroup)) {
    for (const m of g.texts.sort((a, b) => a.t - b.t)) {
      inFlow(() => handleAnswer({ chatId: g.id, t: m.t, fromMe: m.fromMe, body: m.body,
        authorUser: m.fromMe ? 'me' : String(m.author || '').split('@')[0] }));
    }
  }
  inFlow(expireRequests);
  for (const g of groups) {
    // Skip PDFs already printed, and give up on one after it has failed 3 times
    // (PDFs already waiting in the print queue are left to the queue.) Oldest first, so prints come out in order.
    const missed = g.msgs.filter(m => !printedIds.has(m.id) && !queuedIds.has(m.id) && (failCounts.get(m.id) || 0) < 3)
      .sort((a, b) => a.t - b.t);
    if (!missed.length && (quiet || !g.isGroup)) continue;
    log(`Catch-up: ${missed.length} unprinted PDF(s) in ${g.isGroup ? 'group' : 'chat'} "${g.name}" from the last ${CATCH_UP_MINUTES} minutes`);
    // If the same file was sent several times (e.g. resent because it did not print), print it once
    const seen = new Set();
    for (const m of missed) {
      if (m.data.filename && (seen.has(m.data.filename) || printedRecently(g.id, g.name, m.data.filename))) {
        markPrinted(m.id);
        log(`Catch-up: skipped duplicate "${m.data.filename}"`);
        continue;
      }
      seen.add(m.data.filename);
      // Minimal message object with just what handleMessage and downloadDirect use
      enqueue({
        id: { _serialized: m.id }, from: g.id, to: g.id, author: m.author, fromMe: m.fromMe, hasMedia: true,
        type: m.data.type || 'document', timestamp: m.t, _data: m.data,
        getContact: () => Promise.reject(new Error('not available in catch-up')),
        downloadMedia: () => Promise.reject(new Error('not available in catch-up')),
      }, g.isGroup ? g.name : undefined);
    }
  }
}

// Print queue: PDFs are handled one at a time in the order they arrive, so when several are
// sent one by one they all print, in the same order, without mixing up pages.
let queueTail = Promise.resolve();
const queuedIds = new Set();
function enqueue(msg, knownGroupName) {
  const id = msg.id._serialized;
  if (queuedIds.has(id) || printedIds.has(id)) return queueTail;
  queuedIds.add(id);
  if (queuedIds.size > 1) log(`Queued (${queuedIds.size} waiting): ${(msg._data && msg._data.filename) || 'document'}`);
  // A job that takes over 5 minutes (stuck download/print) is given up so it can't block the queue
  queueTail = queueTail
    .then(() => Promise.race([handleMessage(msg, knownGroupName),
      sleep(5 * 60000).then(() => { throw new Error(`gave up on "${(msg._data && msg._data.filename) || id}" after 5 minutes`); })]))
    .catch(e => log(`ERROR in print queue: ${e.message}`))
    .finally(() => queuedIds.delete(id));
  return queueTail;
}

// Text messages in groups may be answers to the print questions
function onText(msg) {
  const chatId = msg.fromMe ? msg.to : msg.from;
  if (!chatId || !chatId.endsWith('@g.us')) return;
  inFlow(() => handleAnswer({
    chatId, t: msg.timestamp, fromMe: !!msg.fromMe, body: msg.body,
    authorUser: msg.fromMe ? 'me' : String(msg.author || '').split('@')[0],
  }));
}
// Live poll taps
const meUsers = new Set(); // this account's own user ids, filled by the backup check
client.on('vote_update', vote => {
  try {
    const parent = vote.parentMessage || {};
    const pid = parent.id || {};
    const remote = pid.remote && (pid.remote._serialized || pid.remote);
    const chatId = String(remote || (parent.fromMe ? parent.to : parent.from) || '');
    const voter = vote.voter && (typeof vote.voter === 'string' ? vote.voter : (vote.voter._serialized || vote.voter.user));
    const voterUser = String(voter || '').split('@')[0].split(':')[0];
    const optionName = vote.selectedOptions && vote.selectedOptions[0] && vote.selectedOptions[0].name;
    if (!chatId.endsWith('@g.us') || !optionName) return;
    inFlow(() => handleVote({ chatId, pollId: pid._serialized, pollT: parent.timestamp, voterUser,
      fromMe: meUsers.has(voterUser), optionName, ts: vote.interractedAtTs }));
  } catch (e) {
    log(`Note: could not read a poll tap (${e.message})`);
  }
});
client.on('message', msg => (msg.type === 'chat' ? onText(msg) : enqueue(msg)));
// Your own messages don't trigger 'message'; this catches PDFs (and answers) you send in the print groups
client.on('message_create', msg => { if (msg.fromMe) (msg.type === 'chat' ? onText(msg) : enqueue(msg)); });

const inProgress = new Set();
async function handleMessage(msg, knownGroupName) {
  let step = 'start';
  const id = msg.id._serialized;
  if (printedIds.has(id) || inProgress.has(id)) return;
  inProgress.add(id);
  try {
    const d = msg._data || {};
    const looksLikePdf = msg.type === 'document' || d.mimetype === 'application/pdf' || /\.pdf$/i.test(String(d.filename || ''));
    const isPhoto = PRINT_IMAGES && msg.type === 'image' && /^image\/(jpeg|png)/.test(String(d.mimetype || ''));
    if (!looksLikePdf && !isPhoto) return;
    if (!d.type) d.type = msg.type; // downloadDirect needs it to pick the right key
    // For your own messages the chat is in msg.to; they print only in the print groups
    const chatId = msg.fromMe ? msg.to : msg.from;
    if (msg.fromMe && !chatId.endsWith('@g.us')) return;
    if (msg.from !== chatId) {
      const copy = Object.assign(Object.create(Object.getPrototypeOf(msg)), msg, { from: chatId });
      Object.defineProperty(copy, 'client', { value: msg.client });
      msg = copy;
    }
    const isGroup = chatId.endsWith('@g.us');
    if (!isGroup && !PRINT_PERSONAL_CHATS) return;
    let groupName = knownGroupName || '';
    if (isGroup && !groupName) {
      step = 'group lookup';
      try {
        groupName = (await msg.getChat()).name || '';
      } catch (e) {
        try {
          groupName = await client.pupPage.evaluate(id => {
            const chat = window.require('WAWebCollections').Chat.get(id);
            return (chat && (chat.formattedTitle || chat.name)) || '';
          }, msg.from);
        } catch (e2) {
          log(`Note: could not read group name (${e.message})`);
        }
      }
    }
    if (isGroup) {
      const wanted = PRINT_GROUPS.map(g => g.toLowerCase());
      if (!wanted.includes(groupName.toLowerCase()) && !PRINT_GROUPS.includes(msg.from)) return;
    }
    log(`Document received from ${isGroup ? `group "${groupName}", member ${msg.fromMe ? 'you' : msg.author}` : msg.from}` +
      ` (${(msg._data && msg._data.filename) || 'no name'})`);

    // Contact lookup sometimes breaks after WhatsApp Web updates, so fall back to the raw chat id
    step = 'contact lookup';
    let sender = (isGroup ? msg.author || '' : msg.from).split('@')[0];
    let who = `${(msg._data && msg._data.notifyName) || ''} (${sender})`.trim();
    try {
      const contact = await msg.getContact();
      if (contact.number) sender = contact.number;
      who = `${contact.pushname || contact.name || (msg._data && msg._data.notifyName) || ''} (${sender})`.trim();
    } catch (e) {
      log(`Note: could not look up contact (${e.message}), using ${sender}`);
    }
    if (isGroup) who += ` in "${groupName}"`;
    else if (ALLOWED_NUMBERS.length && !ALLOWED_NUMBERS.includes(sender)) {
      return log(`Ignored document from ${who}: not in ALLOWED_NUMBERS`);
    }

    step = 'download';
    const media = await downloadPdf(msg);
    const mime = String((media && media.mimetype) || '');
    const name = (media && media.filename) ||
      (mime.startsWith('image/') ? `photo_${msg.timestamp || Date.now()}.${mime.includes('png') ? 'png' : 'jpg'}` : 'document.pdf');
    const okImage = isPhoto || (mime.startsWith('image/') && PRINT_IMAGES) || (PRINT_IMAGES && IMAGE_EXT.test(name));
    const isWord = PRINT_WORD && WORD_EXT.test(name);
    // Files that won't be printed are remembered as handled, so the backup check doesn't fetch them again
    if (!media || (mime !== 'application/pdf' && !name.toLowerCase().endsWith('.pdf') && !okImage && !isWord)) {
      markPrinted(id, msg.from, (msg._data && msg._data.filename) || name, groupName);
      return log(`Ignored "${name}" from ${who}: not a PDF${PRINT_WORD ? ', Word file' : ''} or photo`);
    }
    const data = Buffer.from(media.data, 'base64');
    if (data.length > MAX_MB * 1024 * 1024) {
      markPrinted(id, msg.from, (msg._data && msg._data.filename) || name, groupName);
      return log(`Ignored "${name}" from ${who}: larger than ${MAX_MB} MB`);
    }

    let file = path.join(JOBS_DIR, `${Date.now()}_${name.replace(/[\\/:*?"<>|]/g, '_')}`);
    fs.writeFileSync(file, data);
    if (isWord) {
      // Word file: convert to PDF first; then it goes through the normal PDF flow
      step = 'convert Word file';
      try {
        const pdf = await convertToPdf(file);
        log(`Converted "${name}" to PDF`);
        try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
        file = pdf;
      } catch (e) {
        markPrinted(id, msg.from, (msg._data && msg._data.filename) || name, groupName);
        log(`Could not convert "${name}" to PDF: ${e.message}`);
        if (isGroup) await sendBot(msg.from, `⚠️ Couldn't open the Word file "${name}" for printing.\nPlease save it as PDF (File → Save As → PDF) and send the PDF.`);
        return;
      }
    }
    if (ASK_BEFORE_PRINT && isGroup) {
      // Don't print yet: record the PDF as handled (so it is never picked up twice) and ask for options
      step = 'create print request';
      markPrinted(id, msg.from, (msg._data && msg._data.filename) || name, groupName);
      await inFlow(() => createRequest({
        msgId: id, chatId: msg.from, groupName, file, filename: name, who,        detectKey: `${msg.from}|${(msg._data && msg._data.filename) || name}|${msg.timestamp}`,
        senderUser: msg.fromMe ? 'me' : String(msg.author || '').split('@')[0], fromMe: !!msg.fromMe,
      }));
      return;
    }
    step = 'print';
    await printPdf(file);
    markPrinted(id, msg.from, (msg._data && msg._data.filename) || name, groupName);
    log(`PRINTED "${name}" from ${who}`);
    if (REPLY_TEXT) {
      step = 'reply';
      const withTimeout = p => Promise.race([p, sleep(30000).then(() => { throw new Error('timed out'); })]);
      try {
        await withTimeout(client.sendMessage(msg.from, REPLY_TEXT, { quotedMessageId: id }));
      } catch (e) {
        try { await withTimeout(client.sendMessage(msg.from, REPLY_TEXT)); }
        catch (e2) { log(`Note: printed, but could not send reply (${e2.message})`); }
      }
    }
  } catch (e) {
    failCounts.set(id, (failCounts.get(id) || 0) + 1);
    log(`ERROR during ${step}: ${e.message}\n${e.stack}`);
  } finally {
    inProgress.delete(id);
  }
}

log('Starting WhatsApp Auto Print...');
client.initialize();
