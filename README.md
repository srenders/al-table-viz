# AL Table Visualizer

A Visual Studio Code extension that parses Business Central AL source files and compiled `.app` symbol packages to render an interactive **ER-style diagram** of table relationships.

## Screenshots

![Diagram overview](https://raw.githubusercontent.com/srenders/al-table-viz/main/images/diagram-overview.png)
*Interactive ER diagram showing all table relationships in the workspace*

![Base app table support](https://raw.githubusercontent.com/srenders/al-table-viz/main/images/table-from-base-app.png)
*Browse and visualize relationships including standard Business Central base app tables*

## Features

- **ER diagram** — entity boxes with field names and data types, crow's foot notation on relation edges
- **Depth/focus mode** — double-click any table to expand its neighbourhood; use the depth slider to control how many hops to show
- **Filter by name** — type in the search box to immediately narrow the diagram to matching tables
- **Open source** — click a table node to jump to its `.al` declaration
- **Base-app coverage** — reads compiled `.app` symbol packages so relations to standard BC tables resolve correctly
- **Live refresh** — diagram updates automatically when `.al` files change

## Commands

| Command | Description |
|---|---|
| `AL Table Viz: Show All Table Relations` | Opens the diagram with all tables in the workspace |
| `AL Table Viz: Show Relations for Current Table` | Opens the diagram focused on the table in the active editor (also available via right-click on `.al` files) |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `alTableViz.defaultDepth` | `2` | Number of relation hops to show in focus mode |
| `alTableViz.showExternalTables` | `true` | Include tables from `.app` symbol packages |

## Requirements

- VS Code 1.85+
- An AL workspace with `.al` source files (AL Language extension recommended)

## Development

```bash
npm install
npm run compile    # single build
npm run watch      # rebuild on change
```

Press **F5** in VS Code to launch the Extension Development Host.
