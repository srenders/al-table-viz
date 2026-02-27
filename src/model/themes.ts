/**
 * Built-in colour palettes for the AL Table diagram.
 *
 * Imported by both the extension host (to resolve settings → DiagramColors)
 * and the webview (for optimistic / instant theme switching).
 *
 * This file must NOT import 'vscode' — it runs in both contexts.
 */

import type { DiagramColors } from './types';

// ---------------------------------------------------------------------------
// Preset palettes
// ---------------------------------------------------------------------------

const dark: DiagramColors = {
  nodeHeaderBg:     '#1a2236',
  nodeBodyBg:       '#1c2333',
  nodeBorderColor:  '#4a9eff',
  nodeNameFg:       '#79c0ff',
  nodePkFg:         '#e0e8ff',
  nodeFieldFg:      '#c9d1d9',
  nodeExtFieldFg:   '#c9a04a',
  nodeSepColor:     '#3a6ea8',
  moresFg:          '#555e6e',
  extNodeHeaderBg:    '#151c27',
  extNodeBodyBg:      '#121820',
  extNodeBorderColor: '#3a3a5a',
  extNodeNameFg:      '#8b9dc3',
  extNodePkFg:        '#b0c4de',
  extNodeFieldFg:     '#7a8394',
  extNodeExtFieldFg:  '#9a7a3a',
  extNodeSepColor:    '#2a3550',
  edgeColor:      '#4a9eff',
  edgeLabelColor: '#7aaddd',
  edgeLabelBg:    '#0d1117',
  edgeCondColor:  '#d4a017',
  selectedColor:  '#ffcc00',
  highlightColor: '#ffcc00',
  exportBg:       '#1e1e2e',
};

const light: DiagramColors = {
  nodeHeaderBg:     '#dde4f0',
  nodeBodyBg:       '#f0f4fa',
  nodeBorderColor:  '#0969da',
  nodeNameFg:       '#0550ae',
  nodePkFg:         '#24292f',
  nodeFieldFg:      '#57606a',
  nodeExtFieldFg:   '#a07040',
  nodeSepColor:     '#0550ae',
  moresFg:          '#8c959f',
  extNodeHeaderBg:    '#e8ecf4',
  extNodeBodyBg:      '#f6f8fc',
  extNodeBorderColor: '#b0bfd0',
  extNodeNameFg:      '#5a7099',
  extNodePkFg:        '#6e7781',
  extNodeFieldFg:     '#8c959f',
  extNodeExtFieldFg:  '#87714d',
  extNodeSepColor:    '#8090b0',
  edgeColor:      '#0969da',
  edgeLabelColor: '#0550ae',
  edgeLabelBg:    '#ffffff',
  edgeCondColor:  '#b76e00',
  selectedColor:  '#cf222e',
  highlightColor: '#cf222e',
  exportBg:       '#ffffff',
};

const highContrast: DiagramColors = {
  nodeHeaderBg:     '#000000',
  nodeBodyBg:       '#1a1a1a',
  nodeBorderColor:  '#ffffff',
  nodeNameFg:       '#ffffff',
  nodePkFg:         '#ffffa0',
  nodeFieldFg:      '#e0e0e0',
  nodeExtFieldFg:   '#ffcc44',
  nodeSepColor:     '#ffffff',
  moresFg:          '#888888',
  extNodeHeaderBg:    '#0d0d0d',
  extNodeBodyBg:      '#111111',
  extNodeBorderColor: '#666666',
  extNodeNameFg:      '#aaaaff',
  extNodePkFg:        '#bbbbbb',
  extNodeFieldFg:     '#888888',
  extNodeExtFieldFg:  '#ccaa00',
  extNodeSepColor:    '#aaaaaa',
  edgeColor:      '#00ff00',
  edgeLabelColor: '#00ff00',
  edgeLabelBg:    '#000000',
  edgeCondColor:  '#ffaa00',
  selectedColor:  '#ff4444',
  highlightColor: '#ff4444',
  exportBg:       '#000000',
};

const solarized: DiagramColors = {
  nodeHeaderBg:     '#073642',
  nodeBodyBg:       '#002b36',
  nodeBorderColor:  '#268bd2',
  nodeNameFg:       '#268bd2',
  nodePkFg:         '#eee8d5',
  nodeFieldFg:      '#839496',
  nodeExtFieldFg:   '#b58900',
  nodeSepColor:     '#586e75',
  moresFg:          '#586e75',
  extNodeHeaderBg:    '#002b36',
  extNodeBodyBg:      '#001e26',
  extNodeBorderColor: '#073642',
  extNodeNameFg:      '#657b83',
  extNodePkFg:        '#93a1a1',
  extNodeFieldFg:     '#586e75',
  extNodeExtFieldFg:  '#7a6000',
  extNodeSepColor:    '#073642',
  edgeColor:      '#2aa198',
  edgeLabelColor: '#6dada8',
  edgeLabelBg:    '#001e26',
  edgeCondColor:  '#cb4b16',
  selectedColor:  '#d33682',
  highlightColor: '#d33682',
  exportBg:       '#002b36',
};

/** All built-in colour palettes, keyed by theme name. */
export const THEMES: Record<string, DiagramColors> = { dark, light, highContrast, solarized };

/** The theme name used when no setting is configured. */
export const DEFAULT_THEME = 'dark';

/** Ordered list for UI display (theme picker). */
export const THEME_NAMES: Array<{ id: string; label: string }> = [
  { id: 'dark',          label: 'Dark (default)' },
  { id: 'light',         label: 'Light' },
  { id: 'highContrast',  label: 'High Contrast' },
  { id: 'solarized',     label: 'Solarized Dark' },
];
