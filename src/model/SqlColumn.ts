import { SqlTable } from './SqlTable';

export interface SqlColumn {
  name: string;
  type: string;
  charset?: string;
  collate?: string;
  srid?: number;
  notNull?: boolean;
  default?: string;
  onUpdate?: string;
  autoIncrement?: boolean;
  primaryKey?: boolean;
  uniqueKey?: boolean;
  comment?: string;
  // internal use:
  discriminator?: boolean;
}

export function formatColumn(column: SqlColumn, table?: SqlTable): string {
  const typeLC = column.type.toLowerCase();
  let sql = `\`${column.name}\` ${column.type}`;

  if (
    column.charset &&
    (!table ||
      !table.options ||
      column.charset !== table.options.defaultCharset ||
      column.collate !== table.options.defaultCollate)
  ) {
    sql += ` CHARACTER SET ${column.charset}`;
    if (column.collate) sql += ` COLLATE ${column.collate}`;
  } else if (column.collate && (!table || !table.options || column.collate !== table.options.defaultCollate)) {
    sql += ` COLLATE ${column.collate}`;
  }

  if (column.notNull) {
    sql += ' NOT NULL';
  } else if (typeLC.startsWith('timestamp')) {
    sql += ' NULL';
  }

  if (column.srid != null) {
    sql += ` /*!80003 SRID ${column.srid} */`;
  }

  if (column.autoIncrement) {
    sql += ' AUTO_INCREMENT';
  }

  if (column.default) {
    sql += ` DEFAULT ${column.default}`;
  } else if (!column.notNull && !(typeLC.endsWith('blob') || typeLC.endsWith('text'))) {
    sql += ' DEFAULT NULL';
  }

  if (column.onUpdate) {
    sql += ` ON UPDATE ${column.onUpdate}`;
  }

  if (column.comment) {
    sql += ` COMMENT '${column.comment.replace(/'/g, "''")}'`;
  }

  if (column.primaryKey) {
    sql += ' PRIMARY KEY';
  }

  if (column.uniqueKey) {
    sql += ' UNIQUE KEY';
  }

  return sql;
}
