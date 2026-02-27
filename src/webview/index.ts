/// <reference lib="dom" />
/**
 * Webview entry point — runs inside VS Code's sandboxed browser context.
 * Uses Cytoscape.js to render a clean ER-style diagram of AL table relationships.
 */

import cytoscape, { Core, ElementDefinition, StylesheetStyle } from 'cytoscape';
// @ts-ignore — no bundled types for cytoscape-dagre
import dagre from 'cytoscape-dagre';
// @ts-ignore — no bundled types for cytoscape-svg
import cytoscapeSvg from 'cytoscape-svg';

import type {
  ExtensionMessage,
  GraphPayload,
  WebviewMessage,
  ALTable,
  DiagramColors
} from '../model/types';
import { THEMES, DEFAULT_THEME } from '../model/themes';

cytoscape.use(dagre);
cytoscape.use(cytoscapeSvg);

// ---------------------------------------------------------------------------
// VS Code webview API
// ---------------------------------------------------------------------------
declare function acquireVsCodeApi(): { postMessage(msg: WebviewMessage): void };
const vscode = acquireVsCodeApi();

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const loadingEl       = document.getElementById('loading')!;
const cyEl            = document.getElementById('cy')!;
const searchInput     = document.getElementById('searchInput') as HTMLInputElement;
const depthSlider     = document.getElementById('depthSlider') as HTMLInputElement;
const depthVal        = document.getElementById('depthVal')!;
const btnReset        = document.getElementById('btnReset')!;
const btnFit          = document.getElementById('btnFit')!;
const btnZoomIn       = document.getElementById('btnZoomIn')!;
const btnZoomOut      = document.getElementById('btnZoomOut')!;
const statusEl        = document.getElementById('status')!;
const nsFilter        = document.getElementById('nsFilter') as HTMLSelectElement;
const focusCrumbEl    = document.getElementById('focusCrumb')!;
const crumbNameEl     = document.getElementById('crumbName')!;
const btnClearFocus   = document.getElementById('btnClearFocus')!;
const btnDirection    = document.getElementById('btnDirection')!;
const sidebarEl       = document.getElementById('sidebar')!;
const sidebarSearchEl = document.getElementById('sidebarSearch') as HTMLInputElement;
const tableListEl     = document.getElementById('tableList')!;
const ctxMenuEl       = document.getElementById('ctxMenu')!;
const ctxFocusEl      = document.getElementById('ctxFocus')!;
const ctxOpenEl       = document.getElementById('ctxOpen')!;
const errorBannerEl   = document.getElementById('errorBanner')!;
const errorMsgEl      = document.getElementById('errorMsg')!;
const btnDismissError   = document.getElementById('btnDismissError')!;
const btnExportPng      = document.getElementById('btnExportPng')!;
const btnExportSvg      = document.getElementById('btnExportSvg')!;
const btnExportMermaid  = document.getElementById('btnExportMermaid')!;
const btnFindRelated    = document.getElementById('btnFindRelated')!;
const themePicker       = document.getElementById('themePicker') as HTMLSelectElement;;
// ---------------------------------------------------------------------------
// Sidebar + context menu state
// ---------------------------------------------------------------------------
let sidebarAllItems: string[] = [];
let currentFocusName: string | null = null;
let ctxNodeName            = '';
let ctxNodeFilePath        = '';
let ctxNodeDeclarationLine = 1;
let lastPayload: GraphPayload | null = null;

// ---------------------------------------------------------------------------
// Active colour palette — updated from each GraphPayload
// ---------------------------------------------------------------------------
let activeColors: DiagramColors = { ...THEMES[DEFAULT_THEME] };

// ---------------------------------------------------------------------------
// Cytoscape instance
// ---------------------------------------------------------------------------
let cy: Core | null = null;

function initCy(): Core {
  if (cy) { cy.destroy(); }
  cy = cytoscape({
    container: cyEl,
    style: buildStylesheet(),
    layout: { name: 'preset' },
    wheelSensitivity: 0.3
  });

  // Right-click on a node → context menu.
  // Use native contextmenu event (+ stopPropagation) instead of Cytoscape's
  // cxttap, which was unreliable in VS Code's webview sandbox.
  cyEl.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!cy) { return; }
    const rect = cyEl.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // Hit-test: find the first node whose rendered bounding box contains the click
    const hit = cy.nodes().filter(n => {
      const bb = n.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
      return px >= bb.x1 && px <= bb.x2 && py >= bb.y1 && py <= bb.y2;
    }).first();
    if (!hit || hit.length === 0) { return; }
    ctxNodeName            = (hit.data('tableName')      as string)         ?? '';
    ctxNodeFilePath        = (hit.data('filePath')       as string)         ?? '';
    ctxNodeDeclarationLine = (hit.data('declarationLine') as number | undefined) ?? 1;
    showCtxMenu(e.clientX, e.clientY, !!ctxNodeName);
  });

  // Double-click → focus subgraph on that table
  cy.on('dblclick', 'node', evt => {
    const tableName = evt.target.data('tableName') as string;
    if (tableName) { postMsg({ type: 'focusTable', tableName }); }
  });

  // Right-click → context menu (handled via native contextmenu on cyEl above)
  // Keeping cxttap as no-op to prevent default browser menu on some platforms
  cy.on('cxttap', 'node', _evt => { /* handled by native contextmenu listener */ });

  // Tap on node → highlight it, sync relation list if open
  cy.on('tap', 'node', evt => {
    cy!.elements().removeClass('highlighted').addClass('dimmed');
    evt.target.removeClass('dimmed').addClass('highlighted');
    evt.target.connectedEdges().removeClass('dimmed').addClass('highlighted');
    evt.target.neighborhood('node').removeClass('dimmed').addClass('highlighted');
    const tableName = evt.target.data('tableName') as string;
    if (tableName) { postMsg({ type: 'syncRelated', tableName }); }
  });

  // Tap on canvas background → dismiss context menu and clear highlight
  cy.on('tap', evt => {
    hideCtxMenu();
    if (evt.target === cy) {
      cy!.elements().removeClass('dimmed highlighted');
    }
  });

  return cy;
}

// ---------------------------------------------------------------------------
// SVG node background — bold header band + separator + field rows
// ---------------------------------------------------------------------------
const NODE_WIDTH  = 240;
const HEADER_H    = 26;   // px — table name band
const LINE_H      = 16;   // px per field row
const FIELD_PAD_T = 8;    // gap between separator and first field
const FIELD_PAD_B = 8;    // gap after last field
const PAD_X       = 10;   // horizontal text inset

/** Visible row count: PK rows + 1 summary row (if there are non-PK fields), min 1 */
function visibleRowCount(t: ALTable): number {
  const pkCount = t.pkFields?.length ?? 0;
  if (pkCount === 0) { return Math.max(t.fields.length, 1); } // legacy: show all
  const otherCount = t.fields.length - pkCount;
  return pkCount + (otherCount > 0 ? 1 : 0);
}

function nodeHeight(t: ALTable): number {
  return HEADER_H + FIELD_PAD_T + Math.max(visibleRowCount(t), 1) * LINE_H + FIELD_PAD_B;
}

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildNodeSvg(t: ALTable, isExternal: boolean): string {
  const W        = NODE_WIDTH;
  const H        = nodeHeight(t);
  const nameFg   = isExternal ? activeColors.extNodeNameFg   : activeColors.nodeNameFg;
  const pkFg     = isExternal ? activeColors.extNodePkFg     : activeColors.nodePkFg;
  const fieldFg  = isExternal ? activeColors.extNodeFieldFg  : activeColors.nodeFieldFg;
  const moresFg  = activeColors.moresFg;
  const headerBg = isExternal ? activeColors.extNodeHeaderBg : activeColors.nodeHeaderBg;
  const bodyBg   = isExternal ? activeColors.extNodeBodyBg   : activeColors.nodeBodyBg;
  const sepColor = isExternal ? activeColors.extNodeSepColor : activeColors.nodeSepColor;

  const pkSet = new Set((t.pkFields ?? []).map(n => n.toLowerCase()));
  const hasPk = pkSet.size > 0;

  let rows: string;
  if (!hasPk) {
    // No PK info: show all fields (or empty note)
    if (t.fields.length === 0) {
      rows = `<text x="${PAD_X}" y="${HEADER_H + FIELD_PAD_T + LINE_H - 3}" font-size="10" fill="${xmlEsc(moresFg)}" font-style="italic" font-family="Consolas,'Courier New',monospace">(no fields)</text>`;
    } else {
      rows = t.fields.map((f, i) => {
        const y = HEADER_H + FIELD_PAD_T + i * LINE_H + LINE_H - 3;
        const eFg    = f.isFromExtension ? (isExternal ? activeColors.extNodeExtFieldFg : activeColors.nodeExtFieldFg) : fieldFg;
        const prefix = f.isFromExtension ? '\u2295 ' : ''; // ⊕ prefix for extension fields
        return `<text x="${PAD_X}" y="${y}" font-size="10" fill="${xmlEsc(eFg)}" font-family="Consolas,'Courier New',monospace">${xmlEsc(prefix + f.name)} : ${xmlEsc(f.dataType)}</text>`;
      }).join('');
    }
  } else {
    // Show PK fields with key icon; then summary row for non-PK fields
    const pkFields = t.fields.filter(f => pkSet.has(f.name.toLowerCase()));
    // Any PK names not found in fields (external tables may have sparse field lists)
    const missingPk = (t.pkFields ?? []).filter(n => !t.fields.some(f => f.name.toLowerCase() === n.toLowerCase()));
    const allPkRows = [
      ...pkFields.map(f => ({ name: f.name, dataType: f.dataType })),
      ...missingPk.map(n => ({ name: n, dataType: '' }))
    ];
    const otherCount = t.fields.length - pkFields.length;
    const rowParts: string[] = [];
    allPkRows.forEach((f, i) => {
      const y = HEADER_H + FIELD_PAD_T + i * LINE_H + LINE_H - 3;
      const label = f.dataType ? `${f.name} : ${f.dataType}` : f.name;
      rowParts.push(
        `<text x="${PAD_X}" y="${y}" font-size="10" fill="${xmlEsc(pkFg)}" font-weight="bold" font-family="Consolas,'Courier New',monospace">⚷ ${xmlEsc(label)}</text>`
      );
    });
    if (otherCount > 0) {
      const otherFields = t.fields.filter(f => !pkSet.has(f.name.toLowerCase()));
      const extCount = otherFields.filter(f => f.isFromExtension).length;
      const extNote  = extCount > 0 ? `, ${extCount} from ext` : '';
      const y = HEADER_H + FIELD_PAD_T + allPkRows.length * LINE_H + LINE_H - 3;
      rowParts.push(
        `<text x="${PAD_X}" y="${y}" font-size="10" fill="${xmlEsc(moresFg)}" font-style="italic" font-family="Consolas,'Courier New',monospace">··· ${otherCount} more field${otherCount !== 1 ? 's' : ''}${xmlEsc(extNote)}</text>`
      );
    }
    rows = rowParts.join('');
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`,
    `<rect width="${W}" height="${H}" rx="3" fill="${bodyBg}"/>`,
    `<rect width="${W}" height="${HEADER_H}" rx="3" fill="${headerBg}"/>`,
    `<rect y="${HEADER_H - 3}" width="${W}" height="3" fill="${headerBg}"/>`,
    `<line x1="0" y1="${HEADER_H}" x2="${W}" y2="${HEADER_H}" stroke="${sepColor}" stroke-width="1.5"/>`,
    `<text x="${PAD_X}" y="${HEADER_H - 8}" font-size="11" font-weight="bold" fill="${nameFg}" font-family="Consolas,'Courier New',monospace">${xmlEsc(t.name)}</text>`,
    rows,
    `</svg>`
  ].join('');

  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// ---------------------------------------------------------------------------
// Graph rendering
// ---------------------------------------------------------------------------
function renderGraph(payload: GraphPayload): void {
  lastPayload = payload;
  const { tables, relations, focusTable } = payload;
  loadingEl.classList.add('hidden');
  const instance = initCy();
  const elements: ElementDefinition[] = [];

  // One node per table
  for (const t of tables) {
    elements.push({
      data: {
        id:              tableNodeId(t.name),
        label:           '',
        svgBg:           buildNodeSvg(t, t.isExternal),
        nodeH:           nodeHeight(t),
        tableName:       t.name,
        filePath:        t.filePath,
        declarationLine: t.declarationLine,
        isExternal:      t.isExternal
      },
      classes: t.isExternal ? 'tbl-ext' : 'tbl-src'
    });
  }

  // Edges — deduplicated
  const seen = new Set<string>();
  for (const r of relations) {
    const key = `${r.sourceTable}||${r.targetTable}||${r.sourceField}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    const edgeLabel = r.targetField
      ? `${r.sourceField}\n→ ${r.targetField}`
      : r.sourceField;
    elements.push({
      data: {
        id:     `e||${key}`,
        source: tableNodeId(r.sourceTable),
        target: tableNodeId(r.targetTable),
        label:  edgeLabel
      },
      classes: r.isConditional ? 'rel-cond' : 'rel'
    });
  }

  instance.add(elements);

  // Choose layout based on hint from the extension
  const layoutHint = payload.layout ?? (relations.length > 0 ? 'dagre' : 'grid');
  if (layoutHint === 'concentric' && focusTable) {
    // Star layout: focus table in centre, all direct neighbours around it
    const focusId = tableNodeId(focusTable);
    instance.layout({
      name: 'concentric',
      concentric: (n: any) => n.id() === focusId ? 2 : 1,
      levelWidth: () => 1,
      minNodeSpacing: 30,
      spacingFactor: 1.2,
      padding: 40
    } as any).run();
  } else if (layoutHint === 'dagre' || (relations.length > 0)) {
    instance.layout({
      name:     'dagre',
      rankDir:  'LR',
      nodeSep:  40,
      rankSep:  120,
      padding:  40
    } as any).run();
  } else {
    // Grid layout: calculate columns so nodes fill the canvas roughly squarely
    const cols = Math.max(2, Math.ceil(Math.sqrt(tables.length * (NODE_WIDTH + 40) / 300)));
    instance.layout({
      name:     'grid',
      cols,
      avoidOverlap: true,
      spacingFactor: 1.3,
      padding:  40
    } as any).run();
  }

  if (focusTable) {
    const n = instance.$(`#${cssEsc(tableNodeId(focusTable))}`);
    if (n.length) { instance.animate({ fit: { eles: n, padding: 100 } }); }
  } else {
    instance.fit(undefined, 30);
  }

  statusEl.textContent = `${tables.length} table(s) · ${relations.length} relation(s)` +
    (payload.capped ? ` — showing ${tables.length} of ${payload.totalTables} (reduce depth to see all)` : '');
}

// ---------------------------------------------------------------------------
// Namespace dropdown population
// ---------------------------------------------------------------------------
function populateNamespaces(namespaces: string[]): void {
  const current = nsFilter.value;
  // Rebuild options
  while (nsFilter.options.length > 1) { nsFilter.remove(1); }  // keep first "All" option
  for (const ns of namespaces) {
    const opt = document.createElement('option');
    opt.value = ns;
    opt.textContent = ns;
    nsFilter.appendChild(opt);
  }
  // Restore selection if still present
  if (current && namespaces.includes(current)) {
    nsFilter.value = current;
  } else {
    nsFilter.value = '';
  }
}

// ---------------------------------------------------------------------------
// Sidebar rendering
// ---------------------------------------------------------------------------
function renderSidebar(items: string[], active: string | null, filter = ''): void {
  sidebarAllItems = items;
  currentFocusName = active;

  if (items.length === 0) {
    sidebarEl.classList.add('hidden');
    return;
  }
  sidebarEl.classList.remove('hidden');

  const q = filter.toLowerCase();
  const visible = q ? items.filter(n => n.toLowerCase().includes(q)) : items;

  (document.getElementById('sidebarHeader') as HTMLElement).textContent =
    `Tables (${visible.length}${visible.length < items.length ? ' / ' + items.length : ''})`;

  tableListEl.innerHTML = '';
  for (const name of visible) {
    const li = document.createElement('li');
    li.textContent = name;
    li.title = name;
    if (name === active) { li.classList.add('active'); }
    li.addEventListener('click', () => {
      postMsg({ type: 'focusTable', tableName: name });
    });
    li.addEventListener('contextmenu', e => {
      e.preventDefault();
      ctxNodeName = name;
      ctxNodeFilePath = '';
      showCtxMenu(e.clientX, e.clientY, false);
    });
    tableListEl.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
function showCtxMenu(x: number, y: number, hasFile: boolean): void {
  ctxOpenEl.style.display = hasFile ? '' : 'none';
  // Find the separator before ctxOpen and hide it if no file
  const sep = ctxOpenEl.previousElementSibling as HTMLElement | null;
  if (sep) { sep.style.display = hasFile ? '' : 'none'; }

  ctxMenuEl.style.display = 'block';
  ctxMenuEl.style.left = x + 'px';
  ctxMenuEl.style.top  = y + 'px';
  // Keep inside viewport
  requestAnimationFrame(() => {
    const rect = ctxMenuEl.getBoundingClientRect();
    if (rect.right  > window.innerWidth)  { ctxMenuEl.style.left = (x - rect.width)  + 'px'; }
    if (rect.bottom > window.innerHeight) { ctxMenuEl.style.top  = (y - rect.height) + 'px'; }
  });
}

function hideCtxMenu(): void {
  ctxMenuEl.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------
function buildStylesheet(): StylesheetStyle[] {
  return [
    {
      // Base node — SVG background fills the node; no text label
      selector: 'node',
      style: {
        'shape':                   'rectangle',
        'width':                    NODE_WIDTH,
        'height':                  'data(nodeH)',
        'label':                   '',
        'background-color':        activeColors.nodeBodyBg,
        'background-image':        'data(svgBg)',
        'background-fit':          'cover',
        'background-clip':         'node',
        'background-opacity':       1,
        'border-width':             1,
        'border-color':            activeColors.nodeSepColor,
        'padding':                 '0px'
      } as any
    },
    {
      selector: 'node.tbl-src',
      style: {
        'border-color': activeColors.nodeBorderColor,
        'border-width':  2
      } as any
    },
    {
      selector: 'node.tbl-ext',
      style: {
        'border-color': activeColors.extNodeBorderColor,
        'border-width':  1
      } as any
    },
    {
      selector: 'node:selected',
      style: {
        'border-color': activeColors.selectedColor,
        'border-width':  2
      } as any
    },
    {
      // Crow's foot: vee (fork) on the source (many) end, tee (bar) on the target (one) end
      selector: 'edge.rel',
      style: {
        'width':                    1.5,
        'curve-style':             'unbundled-bezier',
        'line-color':              activeColors.edgeColor,
        'source-arrow-shape':      'vee',
        'source-arrow-color':      activeColors.edgeColor,
        'target-arrow-shape':      'tee',
        'target-arrow-color':      activeColors.edgeColor,
        'arrow-scale':              1.4,
        'label':                   'data(label)',
        'font-size':               '9px',
        'font-family':             'Consolas, "Courier New", monospace',
        'font-style':              'italic',
        'color':                   activeColors.edgeLabelColor,
        'text-wrap':               'wrap',
        'text-background-color':   activeColors.edgeLabelBg,
        'text-background-opacity':  0.85,
        'text-background-padding': '2px',
        'text-rotation':           'none',
        'text-margin-y':           '-8px'
      } as any
    },
    {
      selector: 'edge.rel-cond',
      style: {
        'line-style':          'dashed',
        'line-color':          activeColors.edgeCondColor,
        'source-arrow-color':  activeColors.edgeCondColor,
        'target-arrow-color':  activeColors.edgeCondColor,
        'color':               activeColors.edgeCondColor
      } as any
    },
    {
      // Dimmed: fade non-selected elements when a node is tapped
      selector: '.dimmed',
      style: { 'opacity': 0.15 } as any
    },
    {
      selector: 'node.highlighted',
      style: { 'border-color': activeColors.highlightColor, 'border-width': 3, 'opacity': 1 } as any
    },
    {
      selector: 'edge.highlighted',
      style: { 'width': 3, 'line-color': activeColors.highlightColor,
                'source-arrow-color': activeColors.highlightColor, 'target-arrow-color': activeColors.highlightColor,
                'opacity': 1 } as any
    }
  ];
}

/**
 * Re-apply the active colour palette to an already-rendered Cytoscape graph.
 * Updates the stylesheet and re-bakes all node SVG backgrounds.
 * Called when the user switches themes in the panel without a full graph reload.
 */
function applyColors(): void {
  if (!cy || !lastPayload) { return; }
  cy.style(buildStylesheet());
  cy.nodes().forEach(n => {
    const tableName  = n.data('tableName')  as string;
    const isExternal = n.data('isExternal') as boolean;
    const table = lastPayload!.tables.find(t => t.name === tableName);
    if (table) { n.data('svgBg', buildNodeSvg(table, isExternal)); }
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function cssEsc(s: string): string {
  return s.replace(/([\[\]():,. !#$%^&*+={}'"\\/<>?@;~`|])/g, '\\$1');
}

function tableNodeId(name: string): string {
  return `t:${name}`;
}

function postMsg(msg: WebviewMessage): void {
  vscode.postMessage(msg);
}

// ---------------------------------------------------------------------------
// Toolbar interactions
// ---------------------------------------------------------------------------
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
searchInput.addEventListener('input', () => {
  if (searchDebounce) { clearTimeout(searchDebounce); }
  searchDebounce = setTimeout(() => {
    postMsg({ type: 'filterTables', query: searchInput.value });
  }, 300);
});

let depthDebounce: ReturnType<typeof setTimeout> | null = null;
depthSlider.addEventListener('input', () => {
  const depth = parseInt(depthSlider.value, 10);
  depthVal.textContent = String(depth);
  if (depthDebounce) { clearTimeout(depthDebounce); }
  depthDebounce = setTimeout(() => {
    postMsg({ type: 'setDepth', depth });
  }, 250);
});

btnReset.addEventListener('click', () => {
  searchInput.value = '';
  sidebarSearchEl.value = '';
  nsFilter.value = '';
  postMsg({ type: 'filterByNamespace', namespace: '' });
});

btnClearFocus.addEventListener('click', () => {
  // Return to namespace list (or source view if no namespace active)
  postMsg({ type: 'filterByNamespace', namespace: nsFilter.value });
});

nsFilter.addEventListener('change', () => {
  searchInput.value = '';
  sidebarSearchEl.value = '';
  postMsg({ type: 'filterByNamespace', namespace: nsFilter.value });
});

// Sidebar search — filters the list client-side, no round-trip needed
sidebarSearchEl.addEventListener('input', () => {
  renderSidebar(sidebarAllItems, currentFocusName, sidebarSearchEl.value);
});

// Context menu actions
ctxFocusEl.addEventListener('click', () => {
  hideCtxMenu();
  if (ctxNodeName) { postMsg({ type: 'focusTable', tableName: ctxNodeName }); }
});
ctxOpenEl.addEventListener('click', () => {
  hideCtxMenu();
  if (ctxNodeFilePath) { postMsg({ type: 'openFile', filePath: ctxNodeFilePath, line: ctxNodeDeclarationLine, tableName: ctxNodeName }); }
  else if (ctxNodeName)  { postMsg({ type: 'openFile', filePath: '', line: 0, tableName: ctxNodeName }); }
});
document.addEventListener('click', () => { hideCtxMenu(); });

// Direction toggle: Out → In → Both → Out
const dirCycle: Array<'out' | 'in' | 'both'> = ['out', 'in', 'both'];
const dirLabels: Record<string, string> = { out: '\u2192 Out', in: '\u2190 In', both: '\u21c4 Both' };
let currentDir: 'out' | 'in' | 'both' = 'out';
btnDirection.addEventListener('click', () => {
  currentDir = dirCycle[(dirCycle.indexOf(currentDir) + 1) % dirCycle.length];
  btnDirection.textContent = dirLabels[currentDir];
  postMsg({ type: 'setDirection', direction: currentDir });
});

btnFit.addEventListener('click', () => { cy?.fit(undefined, 40); });
btnZoomIn.addEventListener('click',  () => { if (cy) { cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cyEl.clientWidth / 2, y: cyEl.clientHeight / 2 } }); } });
btnZoomOut.addEventListener('click', () => { if (cy) { cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: cyEl.clientWidth / 2, y: cyEl.clientHeight / 2 } }); } });

btnExportPng.addEventListener('click', () => {
  if (!cy) { return; }
  const dataUri = cy.png({ output: 'base64uri', bg: activeColors.exportBg, scale: 2 }) as string;
  const a = document.createElement('a');
  a.href = dataUri;
  a.download = 'al-diagram.png';
  a.click();
});

btnDismissError.addEventListener('click', () => {
  errorBannerEl.classList.add('hidden');
});

// Open relation list for the focused table, or trigger a QuickPick to pick one
btnFindRelated.addEventListener('click', () => {
  if (currentFocusName) {
    postMsg({ type: 'findRelated', tableName: currentFocusName });
  } else {
    postMsg({ type: 'pickTable' });
  }
});

btnExportSvg.addEventListener('click', () => {
  if (!cy) { return; }
  // cytoscape-svg augments cy with a .svg() method
  const svgContent: string = (cy as any).svg({ scale: 1, full: true, bg: activeColors.exportBg });
  const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'al-diagram.svg';
  a.click();
  URL.revokeObjectURL(url);
});

btnExportMermaid.addEventListener('click', () => {
  if (!lastPayload) { return; }
  const mmd = generateMermaid(lastPayload);
  const blob = new Blob([mmd], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'al-diagram.mmd';
  a.click();
  URL.revokeObjectURL(url);
});

// Theme picker — instant visual feedback + persist the choice via extension
themePicker.addEventListener('change', () => {
  const theme = themePicker.value;
  if (THEMES[theme]) { activeColors = { ...THEMES[theme] }; }
  applyColors();
  postMsg({ type: 'setTheme', theme });
});

// ---------------------------------------------------------------------------
// Mermaid erDiagram generator
// ---------------------------------------------------------------------------
function mmdSanitizeName(raw: string): string {
  // Wrap names that contain non-identifier chars in double-quotes (Mermaid supports this)
  return /[^A-Za-z0-9_]/.test(raw) ? `"${raw.replace(/"/g, '')}"` : raw;
}
function mmdSanitizeType(raw: string): string {
  // Mermaid type tokens: no brackets/spaces — replace with underscores
  return raw.replace(/[\[\]()'"\s,]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'field';
}
function mmdSanitizeAttr(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'field';
}

function generateMermaid(payload: GraphPayload): string {
  const lines: string[] = ['erDiagram', ''];

  // Entity blocks — one per table in the current view
  for (const t of payload.tables) {
    const eName = mmdSanitizeName(t.name);
    lines.push(`  ${eName} {`);
    if (t.fields.length === 0) {
      lines.push(`    string _empty`);
    } else {
      for (const f of t.fields) {
        const fType  = mmdSanitizeType(f.dataType);
        const fAttr  = mmdSanitizeAttr(f.name);
        const isPk   = t.pkFields?.some(pk => pk.toLowerCase() === f.name.toLowerCase()) ?? false;
        const pkMark = isPk ? ' PK' : '';
        const comment = f.isFromExtension ? ' "ext"' : '';
        lines.push(`    ${fType} ${fAttr}${pkMark}${comment}`);
      }
    }
    lines.push(`  }`);
  }

  lines.push('');

  // Relationship lines — deduplicated, same logic as diagram edges
  // Mermaid notation: A }o--|| B : "label"
  //   }o = zero-or-more on source (many)  ||  = exactly one on target (one)
  // Dashed (..) for conditional
  const seen = new Set<string>();
  for (const r of payload.relations) {
    const key = `${r.sourceTable}||${r.targetTable}||${r.sourceField}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    const src   = mmdSanitizeName(r.sourceTable);
    const tgt   = mmdSanitizeName(r.targetTable);
    const label = r.targetField
      ? `"${r.sourceField} to ${r.targetField}"`
      : `"${r.sourceField}"`;
    const line  = r.isConditional ? '}o..||' : '}o--||';
    lines.push(`  ${src} ${line} ${tgt} : ${label}`);
  }

  return lines.join('\n') + '\n';
}

// Keyboard shortcuts: F = fit, +/= = zoom in, - = zoom out
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.target as HTMLElement).tagName === 'INPUT' ||
      (e.target as HTMLElement).tagName === 'SELECT') { return; }
  if (e.key === 'f' || e.key === 'F') { cy?.fit(undefined, 40); }
  if (e.key === '+' || e.key === '=') { if (cy) { cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cyEl.clientWidth / 2, y: cyEl.clientHeight / 2 } }); } }
  if (e.key === '-') { if (cy) { cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: cyEl.clientWidth / 2, y: cyEl.clientHeight / 2 } }); } }
  if (e.key === 'Escape') { hideCtxMenu(); }
});

// ---------------------------------------------------------------------------
// Message handler from extension host
// ---------------------------------------------------------------------------
window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'setGraph':
      // Update the active colour palette BEFORE rendering so buildStylesheet() uses
      // the new colours when initCy() is called inside renderGraph().
      activeColors = { ...msg.payload.colors };
      themePicker.value = msg.payload.colorTheme ?? DEFAULT_THEME;
      depthSlider.value = String(msg.payload.depth);
      depthVal.textContent = String(msg.payload.depth);
      populateNamespaces(msg.payload.namespaces ?? []);
      renderSidebar(msg.payload.sidebarItems ?? [], msg.payload.focusTable, sidebarSearchEl.value);
      // Sync direction button + local state from extension
      if (msg.payload.direction) {
        currentDir = msg.payload.direction;
        const labels: Record<string, string> = { out: '\u2192 Out', in: '\u2190 In', both: '\u21c4 Both' };
        btnDirection.textContent = labels[currentDir] ?? '\u2192 Out';
      }
      if (msg.payload.focusTable) {
        crumbNameEl.textContent = msg.payload.focusTable;
        focusCrumbEl.classList.remove('hidden');
      } else {
        focusCrumbEl.classList.add('hidden');
      }
      renderGraph(msg.payload);
      break;
    case 'setLoading':
      loadingEl.classList.toggle('hidden', !msg.loading);
      break;
    case 'setError':
      errorMsgEl.textContent = `Error: ${msg.message}`;
      errorBannerEl.classList.remove('hidden');
      loadingEl.classList.add('hidden');
      break;
  }
});

// Tell the extension we're ready
postMsg({ type: 'ready' });
