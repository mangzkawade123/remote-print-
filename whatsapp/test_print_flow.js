// Offline tests for print_flow.js (no WhatsApp, no printing):  node test_print_flow.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const flow = require('./print_flow');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

// Minimal valid PDF with the given page sizes [w, h] (points)
function makePdf(sizes) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null];
  const kids = [];
  for (const [w, h] of sizes) {
    kids.push(`${objs.length + 1} 0 R`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] >>`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${sizes.length} >>`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const newSession = pages => ({ filename: 'test.pdf', pages, options: {}, step: 'copies' });
function answerAll(s, answers) {
  const results = [];
  for (const a of answers) {
    const r = flow.applyAnswer(s, a);
    results.push(r);
    if (r.ok && r.next) s.step = r.next;
  }
  return results;
}

console.log('\nPage count on real PDFs from the jobs folder');
const expected = {
  '20-minute Artificial Intelligence speaking script.pdf': 5, // from WhatsApp: "5 pages"
  'AI_Assingment_2.pdf': 2,                                  // "2 pages"
  'Akshara Santosh Dhapase_ST.pdf': 1,                       // "1 page"
};
const jobs = path.join(__dirname, 'jobs');
for (const f of fs.readdirSync(jobs)) {
  const name = f.replace(/^\d+_/, '');
  const info = flow.pdfInfo(fs.readFileSync(path.join(jobs, f)));
  if (expected[name] !== undefined) {
    test(`${name}: ${expected[name]} page(s)`, () => assert.strictEqual(info.pages, expected[name], `got ${info.pages}`));
  } else {
    console.log(`  info ${name}: ${info.pages} page(s), orientations ${JSON.stringify(info.orientations)}`);
  }
}

console.log('\nPage count and orientation on generated PDFs');
test('portrait PDF (3 x A4 portrait)', () => {
  const i = flow.pdfInfo(makePdf([[595, 842], [595, 842], [595, 842]]));
  assert.deepStrictEqual(i, { pages: 3, orientations: { portrait: 3, landscape: 0 } });
});
test('landscape PDF (2 x A4 landscape)', () => {
  const i = flow.pdfInfo(makePdf([[842, 595], [842, 595]]));
  assert.deepStrictEqual(i, { pages: 2, orientations: { portrait: 0, landscape: 2 } });
});
test('mixed PDF (portrait + landscape)', () => {
  const i = flow.pdfInfo(makePdf([[595, 842], [842, 595], [595, 842]]));
  assert.deepStrictEqual(i, { pages: 3, orientations: { portrait: 2, landscape: 1 } });
});

console.log('\nPage selection');
test('1-5', () => assert.deepStrictEqual(flow.parsePages('1-5', 12), { ok: true, text: '1-5', count: 5 }));
test('1,3,5,8', () => assert.strictEqual(flow.parsePages('1,3,5,8', 12).text, '1,3,5,8'));
test('1-3,7,10-12', () => assert.strictEqual(flow.parsePages('1-3,7,10-12', 12).text, '1-3,7,10-12'));
test('1,3,5-7 (Test 7)', () => assert.deepStrictEqual(flow.parsePages('1,3,5-7', 10), { ok: true, text: '1,3,5-7', count: 5 }));
test('spaces and order are cleaned up', () => assert.strictEqual(flow.parsePages(' 7, 1-3 ,2', 10).text, '1-3,7'));
test('page beyond PDF rejected', () => assert.match(flow.parsePages('1-13', 12).error, /only 12 pages/));
test('page 0 rejected', () => assert.strictEqual(flow.parsePages('0-2', 12).ok, false));
test('backwards range rejected', () => assert.match(flow.parsePages('5-2', 12).error, /backwards/));
test('text rejected', () => assert.strictEqual(flow.parsePages('abc', 12).ok, false));

console.log('\nConversation');
const full = { copies: 1, color: 'color', sides: 'single', pages: 'all', size: 'A4', tray: 'Tray1', orientation: 'auto' };
test('start: presets 1-4 print at once with the right settings', () => {
  const expect = {
    1: [full, 'color,simplex,paper=A4,bin=Tray1'],
    2: [{ ...full, color: 'mono' }, 'monochrome,simplex,paper=A4,bin=Tray1'],
    3: [{ ...full, color: 'mono', sides: 'duplex' }, 'monochrome,duplexlong,paper=A4,bin=Tray1'],
    4: [{ ...full, tray: 'MP Tray' }, 'color,simplex,paper=A4,bin=MP Tray'],
  };
  for (const [ans, [opts, settings]] of Object.entries(expect)) {
    const s = { ...newSession(3), step: 'start' };
    assert.strictEqual(flow.applyAnswer(s, ans).action, 'print', ans);
    assert.deepStrictEqual(s.options, opts, ans);
    assert.strictEqual(flow.sumatraSettings(s.options), settings, ans);
  }
  const lh = { ...newSession(3), step: 'start' };
  flow.applyAnswer(lh, '4');
  assert.strictEqual(lh.letterhead, true);
  const q = flow.question('start', newSession(3));
  for (const part of ['Direct Print', 'Black & White', 'Both Side', 'Letterhead', 'Custom', '2 bw both 1-3']) assert.ok(q.includes(part), part);
});
test('start: words work too (bw, both, letterhead, print, custom)', () => {
  for (const [w, name] of [['bw', 'Black & White'], ['both', 'Both Side (B&W)'], ['letterhead', 'Letterhead'], ['print', 'Direct Print']]) {
    const s = { ...newSession(3), step: 'start' };
    assert.strictEqual(flow.applyAnswer(s, w).action, 'print', w);
    assert.strictEqual(s.presetName, name);
  }
  assert.strictEqual(flow.applyAnswer({ ...newSession(3), step: 'start' }, 'custom').next, 'copies');
});
test('start: 5 = Custom -> copies question', () => {
  const s = { ...newSession(3), step: 'start' };
  assert.strictEqual(flow.applyAnswer(s, '5').next, 'copies');
});
test('start: invalid answer and cancel', () => {
  for (const bad of ['9', 'hello']) assert.strictEqual(flow.applyAnswer({ ...newSession(3), step: 'start' }, bad).ok, false, bad);
  assert.strictEqual(flow.applyAnswer({ ...newSession(3), step: 'start' }, 'cancel').action, 'cancel');
});

console.log('\nQuick code (one line)');
test('"2 bw both 1-3" -> summary with those options -> PRINT', () => {
  const s = { ...newSession(5), step: 'start' };
  const r = flow.applyAnswer(s, '2 bw both 1-3');
  assert.strictEqual(r.next, 'confirm');
  assert.deepStrictEqual(s.options, { ...full, copies: 2, color: 'mono', sides: 'duplex', pages: '1-3' });
  assert.strictEqual(flow.applyAnswer({ ...s, step: 'confirm' }, '1').action, 'print');
});
test('quick code variants', () => {
  const q = t => flow.parseQuick(t, 10);
  assert.deepStrictEqual(q('3x').options, { ...full, copies: 3 });
  assert.deepStrictEqual(q('1-3').options, { ...full, pages: '1-3' });
  assert.deepStrictEqual(q('5 copies 1, 3, 5-7 landscape').options, { ...full, copies: 5, pages: '1,3,5-7', orientation: 'landscape' });
  assert.deepStrictEqual(q('2 4').options, { ...full, copies: 2, pages: '4' }); // 2nd number = page
  const lh = q('lh 2');
  assert.deepStrictEqual(lh.options, { ...full, copies: 2, tray: 'MP Tray' });
  assert.strictEqual(lh.letterhead, true);
});
test('quick code errors are explained', () => {
  assert.match(flow.parseQuick('2 bw both 1-30', 10).error, /only 10 pages/);
  assert.match(flow.parseQuick('2 blue', 10).error, /understand "blue"/);
  assert.match(flow.parseQuick('99', 10).error, /1 to 50/);
});

console.log('\nCustom (4 questions)');
test('custom: copies, color, sides, pages -> summary (tray / orientation default)', () => {
  const s = newSession(12);
  // 2 copies, B&W, both side, page range -> 1-10
  const r = answerAll(s, ['2', '1', '2', '3', '1-10']);
  assert.ok(r.every(x => x.ok), JSON.stringify(r));
  assert.strictEqual(s.step, 'confirm');
  assert.deepStrictEqual(s.options, { ...full, copies: 2, color: 'mono', sides: 'duplex', pages: '1-10' });
  const text = flow.summary(s);
  for (const part of ['PRINT CONFIRMATION', 'File: test.pdf', 'Total Pages: 12', 'Copies: 2', 'Black & White', 'Both Side', 'Pages: 1-10', 'Paper Size: A4', 'Tray1', 'Auto'])
    assert.ok(text.includes(part), `summary missing "${part}"`);
  assert.strictEqual(flow.applyAnswer(s, '1').action, 'print');
});
test('custom copies number (Test 8)', () => {
  const s = newSession(1);
  answerAll(s, ['7']);
  assert.strictEqual(s.options.copies, 7);
});
test('invalid copies handled', () => {
  const s = newSession(1);
  for (const bad of ['0', '-2', '2.5', 'many', '500']) assert.strictEqual(flow.applyAnswer(s, bad).ok, false, bad);
  assert.strictEqual(s.step, 'copies');
});
test('pages typed directly at the pages question -> summary', () => {
  const s = newSession(10);
  answerAll(s, ['1', '1', '1', '1,3,5-7']);
  assert.strictEqual(s.options.pages, '1,3,5-7');
  assert.strictEqual(s.step, 'confirm');
});
test('paper size fixed to A4: never asked, always A4', () => {
  const s = newSession(1);
  answerAll(s, ['1', '1', '1', '1']);
  assert.strictEqual(s.options.size, 'A4');
  assert.ok(!flow.question('changeWhich', s).includes('Page size'));
});
test('tray and orientation can still be changed from the summary', () => {
  const s = newSession(4);
  answerAll(s, ['1', '1', '1', '1']);            // -> summary
  const menu = flow.question('changeWhich', s);
  assert.ok(menu.includes('Paper tray') && menu.includes('Orientation'));
  answerAll(s, ['3', '5', '2']);                 // change -> 5 = tray -> 2 = MP Tray
  assert.strictEqual(s.options.tray, 'MP Tray');
  assert.strictEqual(s.step, 'confirm');
  answerAll(s, ['3', '6', '2']);                 // change -> 6 = orientation -> 2 = landscape
  assert.strictEqual(s.options.orientation, 'landscape');
  assert.strictEqual(s.step, 'confirm');
});
test('CHANGE OPTIONS -> change copies -> back to summary', () => {
  const s = newSession(4);
  answerAll(s, ['1', '1', '1', '1']);
  answerAll(s, ['3', '1', '4']);
  assert.strictEqual(s.options.copies, 4);
  assert.strictEqual(s.step, 'confirm');
});
test('CANCEL at confirmation (Test 9)', () => {
  const s = newSession(4);
  answerAll(s, ['1', '1', '1', '1']);
  assert.strictEqual(flow.applyAnswer(s, '2').action, 'cancel');
});
test('"cancel" works during questions too', () => {
  const s = newSession(4);
  assert.strictEqual(flow.applyAnswer(s, 'cancel').action, 'cancel');
});
test('words accepted in custom (bw, duplex, all, print)', () => {
  const s = newSession(2);
  const r = answerAll(s, ['1', 'bw', 'duplex', 'all', 'print']);
  assert.strictEqual(s.options.color, 'mono');
  assert.strictEqual(s.options.sides, 'duplex');
  assert.strictEqual(r[4].action, 'print');
});

console.log('\nPage count alert');
test('pages to print: copies x pages, both sides = half the sheets', () => {
  const s = { ...newSession(10), options: { ...full, copies: 3, sides: 'duplex', pages: '1-5' } };
  assert.deepStrictEqual(flow.printCount(s), { perCopy: 5, totalPages: 15, sheets: 9 });
  assert.deepStrictEqual(flow.printCount({ ...newSession(7), options: { ...full } }), { perCopy: 7, totalPages: 7, sheets: 7 });
  assert.strictEqual(flow.printCount({ ...newSession(0), options: { ...full } }), null);
  assert.ok(flow.summary(s).includes('Pages to print: *15* on 9 sheets'));
  assert.ok(flow.summary({ ...newSession(2), options: { ...full } }).includes('Pages to print: *2*'));
});

console.log('\nPolls (tap-to-choose)');
for (const step of ['start', 'copies', 'color', 'sides', 'pages', 'orientation', 'confirm', 'changeWhich']) {
  test(`${step}: every poll option is a valid answer`, () => {
    const p = flow.pollFor(step, newSession(5));
    assert.ok(p && p.options.length >= 2 && p.options.length <= 12, 'poll needs 2-12 options');
    assert.ok(p.name.length <= 255, 'poll question too long');
    assert.strictEqual(new Set(p.options.map(o => o.label)).size, p.options.length, 'option labels must be unique');
    for (const o of p.options) {
      if (o.answer === 'custom') continue; // "type a number" - handled by the bot
      const s = { ...newSession(5), step, options: { copies: 1, color: 'color', sides: 'single', pages: 'all', size: 'A4', orientation: 'auto' } };
      const r = flow.applyAnswer(s, o.answer);
      assert.ok(r.ok, `"${o.label}" -> "${o.answer}" rejected: ${r.error}`);
    }
  });
}
test('page numbers stay typed (no poll)', () => assert.strictEqual(flow.pollFor('pagesInput', newSession(5)), null));
test('long file names are shortened in the poll', () => {
  const p = flow.pollFor('start', { ...newSession(5), filename: 'x'.repeat(300) + '.pdf' });
  assert.ok(p.name.length < 120);
});
test('summary without the typed choices (poll follows it)', () =>
  assert.ok(!flow.summary({ ...newSession(2), options: flow.DIRECT_OPTIONS }, false).includes('1️⃣ ✅ PRINT')));

console.log('\nPaper tray');
test('tray question: 1 Tray1, 2 MP Tray, 3 Auto Select', () => {
  for (const [ans, tray] of [['1', 'Tray1'], ['2', 'MP Tray'], ['3', 'Auto Select'], ['manual', 'MP Tray'], ['auto', 'Auto Select']]) {
    const s = { ...newSession(2), step: 'tray' };
    const r = flow.applyAnswer(s, ans);
    assert.ok(r.ok && r.next === 'confirm', ans); // orientation is not asked: default, then summary
    assert.strictEqual(s.options.tray, tray);
  }
  assert.strictEqual(flow.applyAnswer({ ...newSession(2), step: 'tray' }, '7').ok, false);
});
test('tray in summary and print settings', () => {
  const o = { copies: 1, color: 'color', sides: 'single', pages: 'all', size: 'A4', orientation: 'auto' };
  assert.strictEqual(flow.sumatraSettings({ ...o, tray: 'MP Tray' }), 'color,simplex,paper=A4,bin=MP Tray');
  assert.strictEqual(flow.sumatraSettings({ ...o, tray: 'Auto Select' }), 'color,simplex,paper=A4');
  assert.ok(flow.summary({ ...newSession(1), options: { ...o, tray: 'MP Tray' } }).includes('Tray: ✋ MP Tray'));
  assert.ok(flow.question('changeWhich', newSession(1)).includes('Paper tray'));
});

console.log('\nSumatraPDF print settings');
test('defaults: 1 copy, color, single, all, printer default, auto', () =>
  assert.strictEqual(flow.sumatraSettings({ copies: 1, color: 'color', sides: 'single', pages: 'all', size: 'Printer default', orientation: 'auto' }), 'color,simplex'));
test('2 copies, B&W, duplex, pages, A4, portrait', () =>
  assert.strictEqual(flow.sumatraSettings({ copies: 2, color: 'mono', sides: 'duplex', pages: '1-3,7', size: 'A4', orientation: 'portrait' }), '1-3,7,2x,monochrome,duplexlong,paper=A4,portrait'));
test('landscape + duplex flips on short edge (Test 5/6)', () =>
  assert.strictEqual(flow.sumatraSettings({ copies: 1, color: 'color', sides: 'duplex', pages: 'all', size: 'A4', orientation: 'landscape' }), 'color,duplexshort,paper=A4,landscape'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
