# Changelog

All notable changes to AL Table Visualizer will be documented here.

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
