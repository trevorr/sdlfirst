import { formatColumn, SqlColumn } from './SqlColumn';
import { formatKey, SqlKey } from './SqlKey';

export interface SqlTableOptions {
  engine?: string;
  defaultCharset?: string;
  defaultCollate?: string;
}

export interface SqlTable {
  name: string;
  columns: SqlColumn[];
  primaryKey: SqlKey;
  keys: SqlKey[];
  options?: SqlTableOptions;
  // internal use:
  discriminatorValue?: string;
}

export function formatTable(table: SqlTable): string {
  const { columns, primaryKey, keys, options } = table;
  let sql = `CREATE TABLE \`${table.name}\` (`;
  let delimiter = '\n';
  for (const column of columns) {
    sql += `${delimiter}  ${formatColumn(column, table)}`;
    delimiter = ',\n';
  }
  if (primaryKey.parts.length > 0) {
    sql += `${delimiter}  ${formatKey(primaryKey)}`;
  }
  for (const key of keys) {
    sql += `${delimiter}  ${formatKey(key)}`;
  }
  sql += '\n)';
  if (options) {
    const { engine, defaultCharset, defaultCollate } = options;
    if (engine) {
      sql += ` ENGINE=${engine}`;
    }
    if (defaultCharset || defaultCollate) {
      sql += ' DEFAULT';
      if (defaultCharset) {
        sql += ` CHARSET=${defaultCharset}`;
      }
      if (defaultCollate) {
        sql += ` COLLATE=${defaultCollate}`;
      }
    }
  }
  sql += ';\n';
  return sql;
}
