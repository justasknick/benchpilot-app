// Import: drop an Excel (.xlsx) or CSV file, columns are matched for you, preview of the first 20 rows per sheet, then
// "Import N vendors, M consultants" and a summary (spec section 5.3). Owners and managers only (spec section 3).
// Reading and column matching reuse the extension's lib/import.js and lib/xlsx-reader.js (bp-lib.js loadImportLib()). The file is read
// in this browser; only the matched rows are sent, through the store (the `team` function's import action in live mode).

import { h, clear } from '../dom.js';
import { pageHeader, card, table, field, select, note, button, toast, plural, lockNote } from '../ui.js';
import { CONSULTANT_CAP_NOTE } from '../plan-gate.js';
import { loadImportLib } from '../bp-lib.js';
import { readSheets, planSheet, buildBook, previewRows, rowCount, MAX_IMPORT_ROWS } from '../import-book.js';

const KINDS = { vendors: 'Vendor contacts', consultants: 'Consultants (bench)', skip: 'Skip this sheet' };

export async function render(ctx) {
  if (!ctx.can('import')) {
    return h('div', { class: 'stack' }, pageHeader('Import'),
      lockNote(ctx, { badge: 'Owners and managers', text: 'Only owners and managers can import a spreadsheet. Ask your owner or manager.' }));
  }

  const work = h('div', { class: 'stack', 'aria-live': 'polite' });
  let plans = [];
  let lib = null;

  const fileIn = h('input', { type: 'file', id: 'import-file', accept: '.xlsx,.csv,text/csv', class: 'sr-only' });
  const drop = h('label', { for: 'import-file', class: 'dropzone' },
    h('span', { class: 'strong' }, 'Drop an .xlsx or .csv file here'),
    h('span', { class: 'muted' }, 'or click to pick one. Up to 10 MB and ' + MAX_IMPORT_ROWS.toLocaleString('en-US') + ' rows.'));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) open(f); });
  fileIn.addEventListener('change', () => { if (fileIn.files[0]) open(fileIn.files[0]); fileIn.value = ''; });

  async function open(file) {
    clear(work);
    work.append(note('info', 'Reading ' + file.name + '...'));
    lib = lib || await loadImportLib();
    if (!lib) { clear(work); work.append(note('danger', 'The file reader could not load. Check your connection and try again.')); return; }
    let sheets;
    try { sheets = await readSheets(file, lib); } catch (err) { clear(work); work.append(note('danger', err.message || 'That file could not be read.')); return; }
    plans = sheets.map((s) => planSheet(s, lib));
    draw(file.name);
  }

  function draw(fileName) {
    clear(work);
    const book = buildBook(plans, lib);
    const total = book.vendors.length + book.consultants.length;
    const tooMany = total > MAX_IMPORT_ROWS;
    const msg = h('div', { 'aria-live': 'polite' });
    const go = h('button', { type: 'button', class: 'btn btn-primary', disabled: !total || tooMany },
      'Import ' + plural(book.vendors.length, 'vendor') + ', ' + plural(book.consultants.length, 'consultant'));
    go.addEventListener('click', async () => {
      go.disabled = true; clear(msg); msg.append(note('info', 'Importing...'));
      try {
        const r = await ctx.store.importBook(book);
        clear(work); work.append(summary(r));
        toast('Import finished.');
      } catch (err) {
        clear(msg);
        msg.append(note('danger', err.message, err.partial ? ' Part of the file was imported. Running the import again is safe: rows are merged, not doubled.' : ''));
        go.disabled = false;
      }
    });

    work.append(card('Ready to import', h('div', null,
      h('p', null, h('span', { class: 'strong' }, fileName), ': ' + plural(plans.length, 'sheet') + '. Duplicates are merged: vendor contacts by email, consultants by name.'),
      book.skipped ? h('p', { class: 'muted' }, plural(book.skipped, 'row') + ' will be skipped: no email (vendors) or no name (consultants).') : null,
      tooMany ? note('warn', 'This file has more than ' + MAX_IMPORT_ROWS.toLocaleString('en-US') + ' rows. Split it and import each part.') : null,
      !total ? note('warn', 'No rows to import. Pick what each sheet holds below, or check that the sheet has a header row (for example Name, Email, Company).') : null,
      msg, h('div', { class: 'row-end' }, button('Choose another file', { variant: 'ghost', onclick: () => fileIn.click() }), go))));

    plans.forEach((p, i) => {
      const kindSel = select(KINDS, p.kind, { onchange: (e) => { plans[i] = { ...p, kind: e.target.value }; draw(fileName); } });
      const pv = p.kind === 'skip' ? null : previewRows(p, 20);
      const n = rowCount(p);
      let body;
      if (p.kind === 'skip') body = h('p', { class: 'muted' }, 'This sheet is not imported.');
      else if (!pv.columns.length) body = note('warn', 'No known column headers were found in this sheet, so nothing is imported from it.');
      else {
        body = h('div', null,
          h('p', { class: 'muted' }, 'Matched columns: ' + pv.columns.join(', ') + '. ' + (n > 20 ? 'First 20 of ' + plural(n, 'row') + '.' : plural(n, 'row') + '.')),
          table(pv.columns.map((label, ci) => ({ label, cell: (r) => r[ci] || '' })), pv.rows, { caption: 'Preview of ' + p.name }));
      }
      work.append(card('Sheet: ' + p.name, h('div', null, h('div', { class: 'filters' }, field('This sheet holds', kindSel)), body)));
    });
  }

  function summary(r) {
    const lines = [
      plural(r.contactsCreated, 'vendor contact') + ' added' + (r.companiesCreated ? ', in ' + plural(r.companiesCreated, 'new company', 'new companies') : '') + '.',
      r.contactsUpdated ? plural(r.contactsUpdated, 'existing contact') + ' got missing details filled in.' : '',
      plural(r.consultantsCreated, 'consultant') + ' added to the bench.',
      r.consultantsUpdated ? plural(r.consultantsUpdated, 'existing consultant') + ' got missing details filled in.' : '',
      (r.vendorsSkipped + r.consultantsSkipped - (r.consultantsOverCap || 0)) ? plural(r.vendorsSkipped + r.consultantsSkipped - (r.consultantsOverCap || 0), 'row') + ' skipped (no valid email or name).' : '',
      r.consultantsOverCap ? plural(r.consultantsOverCap, 'consultant') + ' not added: the bench is full. ' + CONSULTANT_CAP_NOTE : ''   // 0038
    ].filter(Boolean);
    return card('Import summary', h('div', null,
      h('ul', { class: 'plain-list' }, lines.map((l) => h('li', null, l))),
      h('p', { class: 'muted' }, 'Existing records were never overwritten: only empty fields were filled. Set vendor tiers in the vendor book.'),
      h('div', { class: 'row-end' },
        button('Import another file', { variant: 'ghost', onclick: () => { clear(work); fileIn.click(); } }),
        button('Open the vendor book', { variant: 'secondary', onclick: () => ctx.go('#vendors') }),
        button('Open the bench', { variant: 'primary', onclick: () => ctx.go('#bench') }))));
  }

  return h('div', { class: 'stack' },
    pageHeader('Import', 'Bring in your vendor contacts and consultants from Excel or CSV'),
    card(null, h('div', null, fileIn, drop,
      h('p', { class: 'hint' }, 'The file is read in your browser. Columns such as Name, Email, Company, Phone (vendors) or Name, Visa, Rate, Skills (consultants) are matched for you. Nothing is saved until you press Import.'))),
    work);
}
