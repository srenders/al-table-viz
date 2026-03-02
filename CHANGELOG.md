# Changelog

All notable changes to AL Table Visualizer will be documented here.

## [0.1.6] — 2026-03-02

### Added
- **Project filter dropdown** — new _Project_ dropdown in the diagram toolbar restricts the diagram to tables from a single workspace folder; useful when multiple AL projects share the same workspace. External app-package tables are still loaded and shown as neighbours when following relations.
- **App Package filter dropdown** — new _App Package_ dropdown lets you browse all tables from a specific `.app` symbol package (e.g. _Microsoft / Base Application 25.0.0.0_) and see which source tables reference them.
- **App identity on external tables** — publisher, name, version, and GUID are now read from `app.json` inside each `.app` ZIP and stored on every external table; the App Package dropdown is populated from this structured identity rather than raw file paths.
- **Content-hash app package cache** — the disk cache for parsed `.app` packages is now keyed by SHA-256 of the file content rather than path + mtime + size. Identical packages copied across multiple `.alpackages/` folders share a single cache entry.
- **Duplicate `.app` deduplication** — when multiple workspace folders each contain the same `.app` file (e.g. shared `Microsoft_Base_Application.app` in every `.alpackages/` folder), the scanner detects identical content and parses each unique file only once per scan run.
- **Source-table-only QuickPick** — the _Find Related Tables_ QuickPick now lists source (`.al`) tables only, filtered to the active Project selection when set, keeping the list short and focused.

### Changed
- `Reset` button clears the Project and App Package dropdowns in addition to the Namespace dropdown.
- Changing any one filter dropdown (Project / Namespace / App Package) automatically clears the other two to avoid conflicting filter state.

## [0.1.5] — 2026-02-28

### Added
- **Back / Forward navigation** — ‹/› buttons in the diagram toolbar navigate through the focus history within a session
- **BFS-ranked node cap** — when the diagram exceeds the `alTableViz.maxDiagramNodes` limit, the closest tables survive and a notice shows the full count with a link to raise the limit
- **`alTableViz.maxDiagramNodes` setting** — configures the maximum number of table nodes rendered at once (default 60, range 10–500)
- **`alTableViz.excludedAppPackages` setting** — list of `.app` filename substrings to skip during scanning; useful for excluding large third-party packages
- **`AL Table Viz: Re-scan Workspace` command** — force a full re-parse of all source files and `.app` packages, clearing all caches
- **Disk cache for `.app` packages** — parsed symbol packages are now persisted to VS Code global storage (keyed by path + mtime + size); subsequent workspace opens skip re-parsing unchanged `.app` files
- **Incremental AL rescan** — when `.al` files change, only the modified files are re-parsed; the rest of the graph is preserved
- **Relations List enhancements** — direction badge showing _Out / In / Both_; pagination (100 rows per page); CSV export; hop-distance and external-table badges; sortable and filterable columns
- **Enum field labels** — fields declared as `Enum "Name"` now show the enum type name rather than a numeric ID
- **CASE/WHEN `TableRelation` parsing** — multi-branch `CASE … OF … WHEN` relation values are fully parsed and indexed
- **Namespace hint** — when no tables match the selected namespace filter an inline hint suggests switching to namespace mode

### Fixed
- `RE_TABLE` regex now correctly matches table declarations with an inline `{ }` body on the same line
- Inline `TableRelation` values on the same line as the field declaration are now collected (were silently skipped)
- BFS `depth ≥ 2` with direction `In` now correctly expands intermediate nodes in both directions, making transitive targets reachable

## [0.1.4] — 2026-02-27

### Added
- **Colour themes** — four built-in palettes selectable from a dropdown in the diagram toolbar: _Dark_ (default), _Light_, _High Contrast_, and _Solarized Dark_
- **Live theme switching** — selecting a theme in the toolbar applies it instantly and persists the choice to `alTableViz.colorTheme`; changing the setting externally also re-renders live
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
