# Changelog

All notable changes to AL Table Visualizer will be documented here.

## [0.1.3] — 2026-02-25

### Added
- **Related Tables list panel** — click the `🔗 Related` toolbar button or run _Find Related Tables_ to open a sortable panel showing all tables reachable from the focused table
- **By Table / By Relation toggle** — deduplicate the list by unique related table (showing min-hop and relation count) or expand to individual field-level relation rows
- **Single-click node sync** — clicking a node in the diagram updates the relation list panel if it is open
- **List → diagram navigation** — clicking a table name in the list refocuses the diagram on that table
- **External table source** — clicking a table from an `.app` package extracts and opens its `.Table.al` source directly from the ZIP

### Fixed
- Right-click context menu now works correctly in the VS Code webview sandbox (replaced `cxttap` + `originalEvent` access with a native `contextmenu` listener and Cytoscape hit-testing)
- Context menu "Open file" now also available for external (app package) tables
- Focusing a table from the relation list preserves the current diagram direction instead of resetting to `Out`

## [0.1.2] — 2026-02-24

### Fixed
- Marketplace screenshots now load correctly (absolute GitHub raw URLs)

## [0.1.0] — 2026-02-24

### Added
- ER-style diagram of AL table relationships using Cytoscape.js
- Parses `.al` source files for table, field, and `TableRelation` definitions
- Reads compiled `.app` symbol packages (e.g. BC Base App) to resolve external table relations
- Focus mode: double-click a table to show its neighbourhood up to a configurable depth
- Depth slider (1–5) to control how many relation hops are shown
- Direction toggle: outgoing (`→`), incoming (`←`), or both (`↔`) relations
- Namespace filter dropdown to browse BC standard tables by namespace (e.g. `Microsoft.Sales`)
- Sidebar table list for quick navigation within a namespace
- Name filter to search tables by name
- Crow's foot edge notation (many-to-one semantics)
- Context menu on nodes: focus relations or open the `.al` source file
- Right-click on `.al` files in Explorer to focus that table directly
- Export diagram as PNG, SVG, or Mermaid `erDiagram`
- Keyboard shortcuts: `F` to fit, `+`/`-` to zoom, `Escape` to dismiss menus
- Live refresh when `.al` or `.app` files change in the workspace
- Configurable settings: `alTableViz.defaultDepth`, `alTableViz.showExternalTables`
