# AL Table Visualizer — Copilot Instructions

## Project overview
This is a VS Code extension (TypeScript + webpack) that visualizes Business Central AL table relationships as interactive ER diagrams using Cytoscape.js inside a Webview panel.

## Key architecture
- `src/extension.ts` — activation, command registration
- `src/model/types.ts` — shared data model (JSON-safe, used by both extension host and webview)
- `src/model/tableGraph.ts` — in-memory graph with subgraph/filter helpers
- `src/parser/alFileParser.ts` — regex-based `.al` file parser (tables, fields, TableRelation)
- `src/parser/appPackageReader.ts` — reads `.app` ZIP symbol packages via jszip
- `src/scanner/workspaceScanner.ts` — orchestrates scanning, merging, file watching
- `src/panel/diagramPanel.ts` — singleton WebviewPanel, serializes graph and handles messages
- `src/webview/index.ts` — Cytoscape.js webview app (compiled to `dist/webview.js`)

## Build
- Extension host: `dist/extension.js` (webpack target: node)
- Webview: `dist/webview.js` (webpack target: web, uses `tsconfig.webview.json`)
- Run: `npm run compile` or `npm run watch`

## Coding conventions
- Strict TypeScript throughout
- All cross-boundary data (extension ↔ webview) must be JSON-serializable and typed in `src/model/types.ts`
- Parser must not import `vscode` (keep it pure/testable)
- Webview must not import `vscode` directly — only use `acquireVsCodeApi()`
