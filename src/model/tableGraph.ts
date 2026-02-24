import { ALField, ALRelation, ALTable } from './types';

export interface SubGraph {
  tables: ALTable[];
  relations: ALRelation[];
}

export class TableGraph {
  private tableMap: Map<string, ALTable>;
  private relations: ALRelation[];

  constructor(tables: ALTable[], relations: ALRelation[]) {
    this.tableMap = new Map(tables.map(t => [t.name.toLowerCase(), t]));
    this.relations = relations;
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
   */
  getSubgraph(rootTableName: string, depth: number, direction: 'out' | 'in' | 'both' = 'both'): SubGraph {
    const visitedNames = new Set<string>();
    const queue: Array<{ name: string; remaining: number }> = [
      { name: rootTableName.toLowerCase(), remaining: depth }
    ];

    while (queue.length > 0) {
      const { name, remaining } = queue.shift()!;
      if (visitedNames.has(name)) { continue; }
      visitedNames.add(name);
      if (remaining <= 0) { continue; }
      for (const rel of this.relations) {
        const src = rel.sourceTable.toLowerCase();
        const tgt = rel.targetTable.toLowerCase();
        // Outgoing edge: src→tgt, follow if not 'in'
        if (src === name && direction !== 'in' && !visitedNames.has(tgt)) {
          queue.push({ name: tgt, remaining: remaining - 1 });
        }
        // Incoming edge: src→tgt, follow reversed if not 'out'
        if (tgt === name && direction !== 'out' && !visitedNames.has(src)) {
          queue.push({ name: src, remaining: remaining - 1 });
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
      // BFS from each source table
      const queue: Array<{ name: string; remaining: number }> = [
        { name: src.name.toLowerCase(), remaining: depth }
      ];
      while (queue.length > 0) {
        const { name, remaining } = queue.shift()!;
        if (visitedNames.has(name)) { continue; }
        visitedNames.add(name);
        if (remaining <= 0) { continue; }
        for (const rel of this.relations) {
          const s = rel.sourceTable.toLowerCase();
          const t = rel.targetTable.toLowerCase();
          if (s === name && !visitedNames.has(t)) { queue.push({ name: t, remaining: remaining - 1 }); }
          if (t === name && !visitedNames.has(s)) { queue.push({ name: s, remaining: remaining - 1 }); }
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
    // Seed with all tables matching the namespace prefix
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
          for (const rel of this.relations) {
            const s = rel.sourceTable.toLowerCase();
            const tgt = rel.targetTable.toLowerCase();
            if (s === name && !visitedNames.has(tgt)) { queue.push({ name: tgt, remaining: remaining - 1 }); }
            if (tgt === name && !visitedNames.has(s)) { queue.push({ name: s, remaining: remaining - 1 }); }
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
    this.relations.push(...extraRelations);
  }
}
