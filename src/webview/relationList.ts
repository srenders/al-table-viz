/// <reference lib="dom" />
/**
 * Webview entry point for the Relation List panel.
 * Runs in VS Code's sandboxed browser context.
 */

import type { RelatedEntry } from '../model/types';

declare function acquireVsCodeApi(): {
  postMessage(msg: { type: string; [k: string]: unknown }): void;
};
const vscode = acquireVsCodeApi();

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const titleEl       = document.getElementById('rl-title')!;
const subtitleEl    = document.getElementById('rl-subtitle')!;
const filterInput   = document.getElementById('filterInput') as HTMLInputElement;
const counterEl     = document.getElementById('counter')!;
const relTable      = document.getElementById('relTable') as HTMLTableElement;
const theadRow      = document.querySelector('#theadRow tr')!;
const tableBody     = document.getElementById('tableBody')!;
const emptyMsg      = document.getElementById('emptyMsg')!;
const btnByRelation = document.getElementById('btnByRelation')!;
const btnByTable    = document.getElementById('btnByTable')!;
const btnExportCsv  = document.getElementById('btnExportCsv')!;
const paginationEl  = document.getElementById('pagination')!;
const dirBadgeEl    = document.getElementById('dirBadge')!;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const PAGE_SIZE = 100;
let allEntries: RelatedEntry[] = [];
let tableFiles: Record<string, { filePath: string; line: number }> = {};
let rootTable   = '';
let direction: 'out' | 'in' | 'both' = 'both';
let viewMode    = 'byTable';
let sortCol     = 'minHop';
let sortAsc     = true;
let filterText  = '';
let currentPage = 1;

const HEADERS_BY_RELATION = [
  { col: 'sourceTable', label: 'Source Table' },
  { col: 'sourceField', label: 'Source Field' },
  { col: 'targetTable', label: 'Target Table' },
  { col: 'targetField', label: 'Target Field' },
  { col: 'hopDistance', label: 'Hop' },
  { col: 'isExternal',  label: 'Ext' }
];
const HEADERS_BY_TABLE = [
  { col: 'tableName',  label: 'Related Table' },
  { col: 'minHop',     label: 'Min Hop' },
  { col: 'relCount',   label: 'Relations' },
  { col: 'isExternal', label: 'Ext' }
];

// ---------------------------------------------------------------------------
// Table row aggregation (By Table mode)
// ---------------------------------------------------------------------------
interface ByTableRow {
  tableName:   string;
  minHop:      number;
  relCount:    number;
  directCount: number;
  isExternal:  boolean;
}

function buildTableRows(): ByTableRow[] {
  const map = new Map<string, ByTableRow>();
  const rootLower = rootTable.toLowerCase();
  for (const e of allEntries) {
    addEntry(map, e.sourceTable, e, rootLower);
    addEntry(map, e.targetTable, e, rootLower);
  }
  return Array.from(map.values());
}

function addEntry(map: Map<string, ByTableRow>, name: string, entry: RelatedEntry, rootLower: string): void {
  if (name.toLowerCase() === rootLower) { return; }
  if (!map.has(name)) {
    map.set(name, { tableName: name, minHop: entry.hopDistance, relCount: 0, directCount: 0, isExternal: entry.isExternal });
  }
  const row = map.get(name)!;
  if (entry.hopDistance < row.minHop) { row.minHop = entry.hopDistance; }
  row.relCount++;
  if (entry.hopDistance === 1) { row.directCount++; }
  if (entry.isExternal) { row.isExternal = true; }
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applySort<T extends Record<string, any>>(rows: T[], col: string, asc: boolean): void {
  rows.sort((a, b) => {
    let va = a[col], vb = b[col];
    if (typeof va === 'boolean') { va = va ? 1 : 0; vb = vb ? 1 : 0; }
    if (typeof va === 'number') { return asc ? va - vb : vb - va; }
    return asc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
  });
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------
function buildHeaders(defs: Array<{ col: string; label: string }>): void {
  theadRow.innerHTML = '';
  defs.forEach(def => {
    const th = document.createElement('th');
    th.setAttribute('data-col', def.col);
    th.textContent = def.label;
    if (def.col === sortCol) { th.classList.add(sortAsc ? 'sort-asc' : 'sort-desc'); }
    th.addEventListener('click', () => {
      if (sortCol === def.col) { sortAsc = !sortAsc; } else { sortCol = def.col; sortAsc = true; }
      currentPage = 1;
      buildHeaders(defs);
      render();
    });
    theadRow.appendChild(th);
  });
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
function renderPagination(totalRows: number): void {
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  if (totalPages <= 1) { paginationEl.innerHTML = ''; return; }
  paginationEl.innerHTML = '';
  const prev = document.createElement('button');
  prev.className = 'pg-btn'; prev.textContent = '\u2039 Prev';
  prev.disabled = currentPage <= 1;
  prev.addEventListener('click', () => { currentPage--; render(); });
  paginationEl.appendChild(prev);
  const info = document.createElement('span');
  info.className = 'pg-info'; info.textContent = ` Page ${currentPage} of ${totalPages} `;
  paginationEl.appendChild(info);
  const next = document.createElement('button');
  next.className = 'pg-btn'; next.textContent = 'Next \u203A';
  next.disabled = currentPage >= totalPages;
  next.addEventListener('click', () => { currentPage++; render(); });
  paginationEl.appendChild(next);
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------
function hopBadge(hop: number): HTMLElement {
  const span = document.createElement('span');
  span.className = hop === 1 ? 'badge-hop-direct' : 'badge-hop-n';
  span.textContent = hop === 1 ? 'direct' : `${hop}\u00d7`;
  return span;
}
function extBadge(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'badge-ext'; span.textContent = 'ext';
  return span;
}

function linkCell(name: string): HTMLTableCellElement {
  const td = document.createElement('td');
  const span = document.createElement('span');
  span.className = 'name-link';
  span.textContent = name;
  const fi = tableFiles[name];
  span.title = fi ? 'Focus diagram \u2022 open source file' : `Focus diagram on ${name}`;
  span.addEventListener('click', () => {
    vscode.postMessage({ type: 'focusTable', tableName: name });
    vscode.postMessage({ type: 'openFile', filePath: fi ? fi.filePath : '', line: fi ? fi.line : 0, tableName: name });
  });
  td.appendChild(span);
  return td;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function showEmpty(msg: string): void {
  relTable.style.display = 'none';
  emptyMsg.style.display = '';
  emptyMsg.textContent = msg;
}

function render(): void {
  if (viewMode === 'byRelation') { renderByRelation(); } else { renderByTable(); }
}

function renderByRelation(): void {
  const q = filterText.toLowerCase();
  let rows = q
    ? allEntries.filter(e =>
        e.sourceTable.toLowerCase().includes(q) || e.sourceField.toLowerCase().includes(q) ||
        e.targetTable.toLowerCase().includes(q)  || e.targetField.toLowerCase().includes(q))
    : allEntries.slice();
  applySort(rows, sortCol, sortAsc);
  const total = rows.length;
  const start = (currentPage - 1) * PAGE_SIZE;
  const page  = rows.slice(start, start + PAGE_SIZE);
  counterEl.textContent = `${total} / ${allEntries.length} relation${allEntries.length !== 1 ? 's' : ''}`;
  renderPagination(total);
  if (page.length === 0) { showEmpty(allEntries.length === 0 ? 'No relations found.' : 'No matches.'); return; }
  relTable.style.display = ''; emptyMsg.style.display = 'none'; tableBody.innerHTML = '';
  for (const e of page) {
    const tr = document.createElement('tr');
    tr.appendChild(linkCell(e.sourceTable));
    const tdSF = document.createElement('td'); tdSF.textContent = e.sourceField; tr.appendChild(tdSF);
    tr.appendChild(linkCell(e.targetTable));
    const tdTF = document.createElement('td'); tdTF.textContent = e.targetField || '\u2014'; tr.appendChild(tdTF);
    const tdH = document.createElement('td'); tdH.appendChild(hopBadge(e.hopDistance)); tr.appendChild(tdH);
    const tdE = document.createElement('td'); if (e.isExternal) { tdE.appendChild(extBadge()); } tr.appendChild(tdE);
    tableBody.appendChild(tr);
  }
}

function renderByTable(): void {
  let rows = buildTableRows();
  const q = filterText.toLowerCase();
  if (q) { rows = rows.filter(r => r.tableName.toLowerCase().includes(q)); }
  applySort(rows, sortCol, sortAsc);
  const total = rows.length;
  const allTableRows = buildTableRows().length;
  const start = (currentPage - 1) * PAGE_SIZE;
  const page  = rows.slice(start, start + PAGE_SIZE);
  counterEl.textContent = `${total} / ${allTableRows} table${allTableRows !== 1 ? 's' : ''}`;
  renderPagination(total);
  if (page.length === 0) { showEmpty(allTableRows === 0 ? 'No related tables found.' : 'No matches.'); return; }
  relTable.style.display = ''; emptyMsg.style.display = 'none'; tableBody.innerHTML = '';
  for (const r of page) {
    const tr = document.createElement('tr');
    tr.appendChild(linkCell(r.tableName));
    const tdH = document.createElement('td'); tdH.appendChild(hopBadge(r.minHop)); tr.appendChild(tdH);
    const tdC = document.createElement('td');
    const cs = document.createElement('span'); cs.className = 'rel-count';
    cs.textContent = r.relCount + (r.directCount > 0 && r.relCount !== r.directCount ? ` (${r.directCount} direct)` : '');
    tdC.appendChild(cs); tr.appendChild(tdC);
    const tdE = document.createElement('td'); if (r.isExternal) { tdE.appendChild(extBadge()); } tr.appendChild(tdE);
    tableBody.appendChild(tr);
  }
}

function setMode(mode: string): void {
  viewMode = mode;
  btnByRelation.classList.toggle('active', mode === 'byRelation');
  btnByTable.classList.toggle('active',    mode === 'byTable');
  filterInput.placeholder = mode === 'byTable' ? 'Filter table name\u2026' : 'Filter table or field name\u2026';
  filterText = ''; filterInput.value = '';
  currentPage = 1;
  if (mode === 'byRelation') { sortCol = 'hopDistance'; sortAsc = true; buildHeaders(HEADERS_BY_RELATION); }
  else                       { sortCol = 'minHop';      sortAsc = true; buildHeaders(HEADERS_BY_TABLE); }
  render();
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------
function exportCsv(): void {
  const headers = viewMode === 'byRelation'
    ? 'Source Table,Source Field,Target Table,Target Field,Hop,External'
    : 'Related Table,Min Hop,Relations,External';
  const rows: string[] = [headers];

  if (viewMode === 'byRelation') {
    for (const e of allEntries) {
      rows.push([e.sourceTable, e.sourceField, e.targetTable, e.targetField || '', e.hopDistance, e.isExternal ? 'yes' : '']
        .map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
  } else {
    for (const r of buildTableRows()) {
      rows.push([r.tableName, r.minHop, r.relCount, r.isExternal ? 'yes' : '']
        .map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
  }

  const csv  = rows.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `relations-${rootTable || 'export'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
btnByRelation.addEventListener('click', () => setMode('byRelation'));
btnByTable.addEventListener('click',    () => setMode('byTable'));
filterInput.addEventListener('input', () => { filterText = filterInput.value; currentPage = 1; render(); });
btnExportCsv.addEventListener('click', exportCsv);

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data;
  if (msg.type !== 'setRelationList') { return; }

  allEntries = msg.entries as RelatedEntry[];
  tableFiles = msg.tableFiles as Record<string, { filePath: string; line: number }>;
  rootTable  = msg.tableName as string;
  direction  = (msg.direction as 'out' | 'in' | 'both') ?? 'both';

  const dirLabels: Record<string, string> = { out: '\u2192 Out', in: '\u2190 In', both: '\u21c4 Both' };
  dirBadgeEl.textContent = dirLabels[direction] ?? '';
  dirBadgeEl.style.display = '';

  const directCount  = allEntries.filter(e => e.hopDistance === 1).length;
  const transitCount = allEntries.length - directCount;
  const tableCount   = buildTableRows().length;

  titleEl.textContent    = `Related Tables: ${rootTable}`;
  subtitleEl.textContent = `Depth: ${msg.depth as number}\u00a0\u00b7\u00a0`
    + `${tableCount} table${tableCount !== 1 ? 's' : ''}\u00a0\u00b7\u00a0`
    + `${directCount} direct, ${transitCount} transitive relation${transitCount !== 1 ? 's' : ''}`;

  currentPage = 1;
  setMode('byTable');
});

// Initial header build
buildHeaders(HEADERS_BY_TABLE);

// If the extension embedded initial data in the HTML, process it now (no postMessage needed).
// This avoids the race condition where postMessage fires before the listener is registered.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const initData = (window as any).__RL_INIT__;
if (initData && initData.type === 'setRelationList') {
  window.dispatchEvent(new MessageEvent('message', { data: initData }));
}
