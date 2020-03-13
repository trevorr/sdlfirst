import { defaultConfig as defaultDirectiveConfig, DirectiveConfig } from './DirectiveConfig';
import { defaultConfig as defaultPathConfig, PathConfig } from './PathConfig';
import { SqlTableOptions } from '../model/SqlTable';

export interface SqlConfig extends DirectiveConfig, PathConfig {
  booleanSqlType: string;

  // column configuration for @autoinc ID fields
  autoIncrementType: string;

  // column configuration for @rid ID fields
  randomIdName: string;
  randomIdSqlType: string;
  randomIdCharset?: string;
  randomIdCollate?: string;

  // column configuration for @wkid ID fields
  wkidName: string;
  wkidCharset?: string;
  wkidCollate?: string;

  // column type for ID fields without @rid, @wkid, or @autoinc
  idSqlType?: string; // default is requiring @sqlType
  idCharset?: string;
  idCollate?: string;

  // column configuration for hidden auto-increment ID of types with @rid or @wkid
  internalIdName: string;
  internalIdSuffix: string;
  internalIdSqlType?: string; // default is autoIncrementType

  tableIdSuffix: string;
  tableIdSqlType: string;
  tableIdCharset?: string;
  tableIdCollate?: string;

  sequenceName: string;
  sequenceSqlType: string;

  tableOptions: SqlTableOptions;
}

export const defaultConfig: SqlConfig = {
  ...defaultDirectiveConfig,
  ...defaultPathConfig,

  booleanSqlType: 'tinyint(1)',

  autoIncrementType: 'int(10) unsigned',

  randomIdName: 'rid',
  randomIdSqlType: 'varchar(21)',
  randomIdCharset: 'utf8mb4',
  randomIdCollate: 'utf8mb4_bin',

  wkidName: 'wkid',
  wkidCharset: 'utf8mb4',
  wkidCollate: 'utf8mb4_bin',

  idSqlType: undefined,
  idCharset: undefined,
  idCollate: undefined,

  internalIdName: 'id',
  internalIdSuffix: '_id',
  internalIdSqlType: undefined,

  tableIdSuffix: '_kind',
  tableIdSqlType: 'varchar(2)',
  tableIdCharset: 'utf8mb4',
  tableIdCollate: 'utf8mb4_bin',

  sequenceName: 'sequence',
  sequenceSqlType: 'smallint(5) unsigned',

  tableOptions: {
    engine: 'InnoDB',
    defaultCharset: 'utf8mb4',
    defaultCollate: 'utf8mb4_0900_ai_ci'
  }
};
