import { ALField, ALRelation, ALTable, RelatedEntry } from './types';

export interface SubGraph {
  tables: ALTable[];
  relations: ALRelation[];
  /**
   * BFS distance from the root for each visited table (lowercase name → hop count).
   * Only populated by getSubgraph(); other methods leave this undefined.
   */
  distances?: Map<string, number>;
}

export class TableGraph {
  private tableMap: Map<string, ALTable>;
  private relations: ALRelation[];
  /** Adjacency index: source-table (lowercase) → outgoing relations */
  private _bySource: Map<string, ALRelation[]> = new Map();
  /** Adjacency index: target-table (lowercase) → incoming relations */
  private _byTarget: Map<string, ALRelation[]> = new Map();

  constructor(tables: ALTable[], relations: ALRelation[]) {
    this.tableMap = new Map(tables.map(t => [t.name.toLowerCase(), t]));
    this.relations = relations;
    this._buildIndex();
  }

  /** Rebuild source/target adjacency indexes from the flat relations list. */
  private _buildIndex(): void {
    this._bySource = new Map();
    this._byTarget = new Map();
    for (const rel of this.relations) {
      const src = rel.sourceTable.toLowerCase();
      const tgt = rel.targetTable.toLowerCase();
      if (!this._bySource.has(src)) { this._bySource.set(src, []); }
      this._bySource.get(src)!.push(rel);
      if (!this._byTarget.has(tgt)) { this._byTarget.set(tgt, []); }
      this._byTarget.get(tgt)!.push(rel);
    }
  }

  getTables(): ALTable[] {
    return Array.from(this.tableMap.values());
  }

  getRelations(): ALRelation[] {
    return this.relations;
  }

  getTable(name: string): ALTable | undefined {
    return this.tableMap.get(name.toLowerCase());
  }

  /**
   * Returns a subgraph centred on rootTableName up to `depth` hops away.
   * direction: 'out' = only follow FKs that leave rootTable (sourceTable)
   *            'in'  = only follow FKs that arrive at rootTable (targetTable)
   *            'both' = bidirectional (default)
   *
   * The returned SubGraph includes a `distances` map (lowercase name → hop count)
   * so callers can sort/trim by proximity to the focus table.
   */
  getSubgraph(rootTableName: string, depth: number, direction: 'out' | 'in' | 'both' = 'both'): SubGraph {
    // distances: lowercase name → BFS hop count from root
    const distances = new Map<string, number>();
    const queue: Array<{ name: string; remaining: number; dist: number }> = [
      { name: rootTableName.toLowerCase(), remaining: depth, dist: 0 }
    ];

    while (queue.length > 0) {
      const { name, remaining, dist } = queue.shift()!;
      if (distances.has(name)) { continue; }
      distances.set(name, dist);
      if (remaining <= 0) { continue; }

      // For the root node, respect the requested direction.
      // For intermediate nodes (dist > 0), always expand in both directions so that
      // e.g. depth=2 'in' from SalesHeader reaches Item via SalesHeader←SalesLine→Item.
      const expandDir: 'out' | 'in' | 'both' = dist === 0 ? direction : 'both';

      // Outgoing edges (source → target), follow if expandDir is 'out' or 'both'
      if (expandDir !== 'in') {
        for (const rel of this._bySource.get(name) ?? []) {
          const tgt = rel.targetTable.toLowerCase();
          if (!distances.has(tgt)) { queue.push({ name: tgt, remaining: remaining - 1, dist: dist + 1 }); }
        }
      }
      // Incoming edges (target ← source), follow reversed if expandDir is 'in' or 'both'
      if (expandDir !== 'out') {
        for (const rel of this._byTarget.get(name) ?? []) {
          const src = rel.sourceTable.toLowerCase();
          if (!distances.has(src)) { queue.push({ name: src, remaining: remaining - 1, dist: dist + 1 }); }
        }
      }
    }

    const tables = Array.from(distances.keys())
      .map(n => this.tableMap.get(n))
      .filter((t): t is ALTable => t !== undefined);

    const relations = this.relations.filter(
      r =>
        distances.has(r.sourceTable.toLowerCase()) &&
        distances.has(r.targetTable.toLowerCase())
    );

    return { tables, relations, distances };
  }

  /**
   * Returns tables whose names contain the query string (case-insensitive).
   * Relations are filtered to those between matching tables only.
   */
  filterByName(query: string): SubGraph {
    if (!query.trim()) {
      return { tables: this.getTables(), relations: this.relations };
    }
    const q = query.toLowerCase();
    const matchedNames = new Set<string>();
    for (const t of this.tableMap.values()) {
      if (t.name.toLowerCase().includes(q)) {
        matchedNames.add(t.name.toLowerCase());
      }
    }
    const tables = Array.from(matchedNames)
      .map(n => this.tableMap.get(n))
      .filter((t): t is ALTable => t !== undefined);
    const relations = this.relations.filter(
      r =>
        matchedNames.has(r.sourceTable.toLowerCase()) &&
        matchedNames.has(r.targetTable.toLowerCase())
    );
    return { tables, relations };
  }

  /**
   * Returns the union of depth-bounded subgraphs rooted at every source
   * (non-external) table.  This is the default view — the analyst's own
   * tables plus the external tables they directly reference.
   */
  getSourceSubgraph(depth: number): SubGraph {
    const sourceTables = Array.from(this.tableMap.values()).filter(t => !t.isExternal);
    const visitedNames = new Set<string>();

    for (const src of sourceTables) {
      const queue: Array<{ name: string; remaining: number }> = [
        { name: src.name.toLowerCase(), remaining: depth }
      ];
      while (queue.length > 0) {
        const { name, remaining } = queue.shift()!;
        if (visitedNames.has(name)) { continue; }
        visitedNames.add(name);
        if (remaining <= 0) { continue; }
        for (const rel of this._bySource.get(name) ?? []) {
          const tgt = rel.targetTable.toLowerCase();
          if (!visitedNames.has(tgt)) { queue.push({ name: tgt, remaining: remaining - 1 }); }
        }
        for (const rel of this._byTarget.get(name) ?? []) {
          const s = rel.sourceTable.toLowerCase();
          if (!visitedNames.has(s)) { queue.push({ name: s, remaining: remaining - 1 }); }
        }
      }
    }

    const tables = Array.from(visitedNames)
      .map(n => this.tableMap.get(n))
      .filter((t): t is ALTable => t !== undefined);

    const relations = this.relations.filter(
      r =>
        visitedNames.has(r.sourceTable.toLowerCase()) &&
        visitedNames.has(r.targetTable.toLowerCase())
    );

    return { tables, relations };
  }

  /**
   * Returns all distinct namespace prefixes (first 2 dot-segments) present
   * in external tables, sorted alphabetically.
   * e.g. ["Microsoft.Finance", "Microsoft.Inventory", "Microsoft.Sales"]
   */
  getNamespaces(): string[] {
    const seen = new Set<string>();
    for (const t of this.tableMap.values()) {
      if (t.isExternal && t.namespace) {
        const parts = t.namespace.split('.');
        const prefix = parts.slice(0, 2).join('.');
        if (prefix) { seen.add(prefix); }
      }
    }
    return Array.from(seen).sort();
  }

  /**
   * Returns a subgraph containing all tables whose namespace starts with
   * `nsPrefix`, plus neighbours reachable within `depth` relation hops.
   */
  getSubgraphForNamespace(nsPrefix: string, depth: number): SubGraph {
    const visitedNames = new Set<string>();
    for (const t of this.tableMap.values()) {
      if (t.namespace && t.namespace.startsWith(nsPrefix)) {
        const queue: Array<{ name: string; remaining: number }> = [
          { name: t.name.toLowerCase(), remaining: depth }
        ];
        while (queue.length > 0) {
          const { name, remaining } = queue.shift()!;
          if (visitedNames.has(name)) { continue; }
          visitedNames.add(name);
          if (remaining <= 0) { continue; }
          for (const rel of this._bySource.get(name) ?? []) {
            const tgt = rel.targetTable.toLowerCase();
            if (!visitedNames.has(tgt)) { queue.push({ name: tgt, remaining: remaining - 1 }); }
          }
          for (const rel of this._byTarget.get(name) ?? []) {
            const s = rel.sourceTable.toLowerCase();
            if (!visitedNames.has(s)) { queue.push({ name: s, remaining: remaining - 1 }); }
          }
        }
      }
    }

    const tables = Array.from(visitedNames)
      .map(n => this.tableMap.get(n))
      .filter((t): t is ALTable => t !== undefined);

    const relations = this.relations.filter(
      r =>
        visitedNames.has(r.sourceTable.toLowerCase()) &&
        visitedNames.has(r.targetTable.toLowerCase())
    );

    return { tables, relations };
  }

  /**
   * Returns all table names whose namespace starts with nsPrefix, sorted.
   * Used to populate the sidebar list without BFS expansion.
   */
  getTableNamesForNamespace(nsPrefix: string): string[] {
    const names: string[] = [];
    for (const t of this.tableMap.values()) {
      if (t.namespace && t.namespace.startsWith(nsPrefix)) {
        names.push(t.name);
      }
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Returns a flat, sorted list of all relations reachable from `rootTableName`
   * within `depth` BFS hops. Each entry includes the hop distance (1 = direct,
   * 2+ = transitive) and whether either end of the relation is an external table.
   * Used to populate the RelationListPanel.
   */
  getRelatedEntries(rootTableName: string, depth: number, direction: 'out' | 'in' | 'both' = 'both'): RelatedEntry[] {
    // BFS — track minimum hop distance per table name
    const hopMap = new Map<string, number>();
    const queue: Array<{ name: string; hop: number }> = [
      { name: rootTableName.toLowerCase(), hop: 0 }
    ];

    while (queue.length > 0) {
      const { name, hop } = queue.shift()!;
      if (hopMap.has(name)) { continue; }
      hopMap.set(name, hop);
      if (hop >= depth) { continue; }
      if (direction !== 'in') {
        for (const rel of this._bySource.get(name) ?? []) {
          const tgt = rel.targetTable.toLowerCase();
          if (!hopMap.has(tgt)) { queue.push({ name: tgt, hop: hop + 1 }); }
        }
      }
      if (direction !== 'out') {
        for (const rel of this._byTarget.get(name) ?? []) {
          const src = rel.sourceTable.toLowerCase();
          if (!hopMap.has(src)) { queue.push({ name: src, hop: hop + 1 }); }
        }
      }
    }

    const entries: RelatedEntry[] = [];

    for (const rel of this.relations) {
      const srcLower = rel.sourceTable.toLowerCase();
      const tgtLower = rel.targetTable.toLowerCase();
      if (!hopMap.has(srcLower) || !hopMap.has(tgtLower)) { continue; }
      // Hop distance = the max of the two ends (the "farther" end from root)
      const hopDistance = Math.max(hopMap.get(srcLower)!, hopMap.get(tgtLower)!);
      if (hopDistance === 0) { continue; } // skip relations where both ends are the root itself
      const srcTable = this.tableMap.get(srcLower);
      const tgtTable = this.tableMap.get(tgtLower);
      entries.push({
        sourceTable: rel.sourceTable,
        sourceField: rel.sourceField,
        targetTable: rel.targetTable,
        targetField: rel.targetField,
        isExternal: !!(srcTable?.isExternal || tgtTable?.isExternal),
        hopDistance
      });
    }

    // Sort by hop distance, then source table, then source field
    entries.sort((a, b) => {
      if (a.hopDistance !== b.hopDistance) { return a.hopDistance - b.hopDistance; }
      const st = a.sourceTable.localeCompare(b.sourceTable);
      if (st !== 0) { return st; }
      return a.sourceField.localeCompare(b.sourceField);
    });

    return entries;
  }

  /**
   * Merges fields and relations from a table extension into the base table.
   * Each field is spread (`{ ...f, isFromExtension: true }`) rather than mutated
   * in place, so the parser's original objects remain unchanged — important for
   * test isolation and predictable re-scan behaviour.
   * If `baseName` is not found in the graph (e.g. the base app table was excluded),
   * the call is silently ignored — extension fields are simply not shown.
   */
  mergeExtension(baseName: string, extraFields: ALField[], extraRelations: ALRelation[]): void {
    const base = this.tableMap.get(baseName.toLowerCase());
    if (base) {
      base.fields.push(...extraFields.map(f => ({ ...f, isFromExtension: true })));
    }
    if (extraRelations.length > 0) {
      this.relations.push(...extraRelations);
      // Rebuild adjacency index to include the new relations
      this._buildIndex();
    }
  }
}
