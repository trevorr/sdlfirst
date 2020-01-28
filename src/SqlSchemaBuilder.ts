import assert from 'assert';
import {
  ArgumentNode,
  BooleanValueNode,
  getNamedType,
  getNullableType,
  GraphQLCompositeType,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLOutputType,
  IntValueNode,
  isCompositeType,
  isEnumType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  ListValueNode,
  ObjectValueNode,
  StringValueNode
} from 'graphql';
import { snakeCase } from 'snake-case';
import { Analyzer, EnumValueType, FieldType, TableType, TypeInfo } from './Analyzer';
import { defaultConfig, SqlConfig } from './config/SqlConfig';
import { SqlColumn } from './model/SqlColumn';
import { SqlKeyType } from './model/SqlKey';
import { SqlTable } from './model/SqlTable';
import {
  findFirstDirective,
  formatLocationOf,
  getDirectiveArgument,
  getRequiredDirectiveArgument,
  hasDirective
} from './util/ast-util';

export interface FieldColumns {
  field: FieldType;
  columns: SqlColumn[];
}

export interface FieldJoin {
  field: FieldType;
  toTable: TypeTable;
  fromFields?: FieldType[]; // one:many with backref join
  toFields?: FieldType[]; // one:many
  pkPrefix?: boolean; // many:many: if referring table key is first half of join table key (else last half)
  nodeTable?: TypeTable; // many:many
}

export type FieldMapping = FieldColumns | FieldJoin;

export function isColumns(mapping: FieldMapping): mapping is FieldColumns {
  return 'columns' in mapping;
}

export function isJoin(mapping: FieldMapping): mapping is FieldJoin {
  return 'toTable' in mapping;
}

export interface TypeTable {
  type: TableType;
  table: SqlTable;
  fieldMappings: Map<FieldType, FieldMapping>;
}

export interface SqlSchemaMappings {
  tables: readonly TypeTable[];
  getIdentityTableForType(type: TableType): TableMapping | undefined;
}

enum FieldsMapped {
  NONE,
  SOME_KEYS,
  ALL_KEYS,
  SOME_DATA,
  ALL_DATA
}

interface TableMapping extends TypeTable {
  fieldsMapped: FieldsMapped;
  fieldNames?: Set<string>;
}

export class SqlSchemaBuilder {
  private readonly config: SqlConfig;
  private readonly tableMappingByName = new Map<string, TableMapping>();
  private readonly identityTableMappingByType = new Map<TableType, TableMapping>();

  constructor(private readonly analyzer: Analyzer, config?: Partial<SqlConfig>) {
    this.config = Object.assign({}, defaultConfig, config);
  }

  public generateTables(): SqlSchemaMappings {
    for (const typeInfo of this.analyzer.getTypeInfos()) {
      // only directly emit tables with identity fields; non-identity tables are emitted as
      // encountered via fields, since they take their identity from the referencing table
      if (typeInfo.hasTable && typeInfo.hasIdentity) {
        this.generateTable(typeInfo as TypeInfo<TableType>);
      }
    }
    return {
      tables: Array.from(this.tableMappingByName.values()),
      getIdentityTableForType: type => this.identityTableMappingByType.get(type)
    };
  }

  private generateTable(typeInfo: TypeInfo<TableType>): TableMapping | null {
    const { type, identityTypeInfo } = typeInfo;

    // return table if already generated for type
    let mapping = this.identityTableMappingByType.get(type);
    if (mapping == null) {
      // get the name of the table based on the type name or @sqlTable.name
      const name = getTableName(type, this.config);
      const existing = this.tableMappingByName.get(name);
      if (existing) {
        throw new Error(`Table name "${name}" for type "${type.name}" already used by type "${existing.type.name}"`);
      }

      const fields = type.getFields();
      const fieldNames = new Set(Object.keys(fields));

      // exclude fields already in interface table
      if (identityTypeInfo) {
        for (const intfFieldName of Object.keys(identityTypeInfo.type.getFields())) {
          fieldNames.delete(intfFieldName);
        }

        // skip table entirely represented by interface table
        if (fieldNames.size === 0) {
          return null;
        }
      }

      mapping = this.emitTable(name, type, fieldNames);
      this.identityTableMappingByType.set(type, mapping);
    } else if (mapping.fieldsMapped >= FieldsMapped.SOME_DATA) {
      return mapping;
    }

    const { table, fieldNames } = mapping;

    if (mapping.fieldsMapped === FieldsMapped.NONE) {
      mapping.fieldsMapped = FieldsMapped.SOME_KEYS;

      // if the table doesn't have an explicit internal ID, add an implicit one
      if (!typeInfo.internalIdFields) {
        // if the table implements an interface table, use its internal ID
        if (identityTypeInfo) {
          const interfaceTable = this.generateTable(identityTypeInfo)!.table;
          this.addParentKeyColumns(table, interfaceTable);
        } else {
          // add an auto-increment column as the internal ID
          const idColumn = {
            name: this.config.internalIdName,
            type: this.config.internalIdSqlType,
            notNull: true,
            autoIncrement: this.config.internalIdAutoIncrement
          };
          table.columns.push(idColumn);
          table.primaryKey.parts.push({ column: idColumn, descending: false });
        }
      } else {
        // emit primary key fields separately first to support circular references
        for (const field of typeInfo.internalIdFields) {
          const columns = this.emitColumnsForField(mapping, typeInfo, field);
          table.primaryKey.parts.push(...columns.map(column => ({ column, descending: false })));
          fieldNames!.delete(field.name);
        }
      }

      mapping.fieldsMapped = FieldsMapped.ALL_KEYS;
    }

    // emit remaining non-key columns
    this.emitColumnsForFields(mapping, typeInfo, fieldNames);

    // add any keys from @sqlTable directive
    const tableDir = findFirstDirective(type, this.config.sqlTableDirective);
    const keysArg = tableDir ? getDirectiveArgument(tableDir, 'keys') : null;
    if (keysArg != null) {
      this.emitKeys(table, keysArg);
    }

    return mapping;
  }

  private emitTable(name: string, type: TableType, fieldNames?: Set<string>): TableMapping {
    const table: SqlTable = {
      name,
      columns: [],
      primaryKey: {
        type: SqlKeyType.PRIMARY,
        parts: []
      },
      keys: [],
      options: { ...this.config.tableOptions }
    };
    const mapping = {
      type,
      table,
      fieldMappings: new Map(),
      fieldsMapped: FieldsMapped.NONE,
      fieldNames
    };
    this.tableMappingByName.set(name, mapping);
    return mapping;
  }

  private emitColumnsForFields(
    mapping: TableMapping,
    typeInfo: TypeInfo<TableType>,
    fieldNames?: Iterable<string>
  ): void {
    if (mapping.fieldsMapped === FieldsMapped.ALL_KEYS) {
      const fields = typeInfo.type.getFields();
      if (!fieldNames) {
        fieldNames = Object.keys(fields);
      }
      mapping.fieldsMapped = FieldsMapped.SOME_DATA;
      for (const fieldName of fieldNames) {
        this.emitColumnsForField(mapping, typeInfo, fields[fieldName]);
      }
      mapping.fieldsMapped = FieldsMapped.ALL_DATA;
    }
  }

  private emitColumnsForField(mapping: TableMapping, typeInfo: TypeInfo<TableType>, field: FieldType): SqlColumn[] {
    if (hasDirective(field, this.config.derivedDirective)) {
      return [];
    }

    let fieldType = field.type;
    let notNull = false;
    if (isNonNullType(fieldType)) {
      notNull = true;
      fieldType = fieldType.ofType;
    }

    let { name, explicitName } = getColumnNameInfo(field, this.config);

    const { table } = mapping;
    let sqlType;
    let charset;
    let collate;
    let srid;
    let uniqueKey = hasDirective(field, this.config.uniqueDirective);
    let typeDir = findFirstDirective(field, this.config.sqlTypeDirective);
    if (typeDir == null && 'astNode' in fieldType) {
      typeDir = findFirstDirective(fieldType, this.config.sqlTypeDirective);
    }
    if (typeDir != null) {
      // column has explicit SQL type
      const typeArg = getRequiredDirectiveArgument(typeDir, 'type', 'StringValue');
      sqlType = (typeArg.value as StringValueNode).value;
      const charsetArg = getDirectiveArgument(typeDir, 'charset');
      if (charsetArg != null) {
        charset = (charsetArg.value as StringValueNode).value;
      }
      const collateArg = getDirectiveArgument(typeDir, 'collate');
      if (collateArg != null) {
        collate = (collateArg.value as StringValueNode).value;
      }
      const sridArg = getDirectiveArgument(typeDir, 'srid');
      if (sridArg != null) {
        srid = parseInt((sridArg.value as IntValueNode).value, 10);
      }
    } else if (isScalarType(fieldType)) {
      // determine SQL type from scalar type
      switch (fieldType.name) {
        case 'ID':
          const xidDir = findFirstDirective(field, this.config.externalIdDirective);
          const sidDir = findFirstDirective(field, this.config.stringIdDirective);
          if (xidDir != null) {
            name = this.config.externalIdName;
            sqlType = this.config.externalIdSqlType;
            charset = this.config.externalIdCharset;
            collate = this.config.externalIdCollate;
            uniqueKey = true;
          } else if (sidDir != null) {
            const maxArg = getRequiredDirectiveArgument(sidDir, 'maxLength', 'IntValue');
            name = this.config.stringIdName;
            sqlType = `varchar(${(maxArg.value as IntValueNode).value})`;
            charset = this.config.stringIdCharset;
            collate = this.config.stringIdCollate;
            uniqueKey = true;
          } else if (this.config.idSqlType != null) {
            sqlType = this.config.idSqlType;
            charset = this.config.idCharset;
            collate = this.config.idCollate;
            uniqueKey = true;
          } else {
            throw new Error(`@sqlType, @sid, or @xid directive required for ID type${formatLocationOf(field.astNode)}`);
          }
          break;
        case 'String':
          const lengthDir = findFirstDirective(field, this.config.lengthDirective);
          if (lengthDir != null) {
            const maxArg = getRequiredDirectiveArgument(lengthDir, 'max', 'IntValue');
            sqlType = `varchar(${(maxArg.value as IntValueNode).value})`;
          } else {
            sqlType = 'text';
          }
          charset = this.config.tableOptions.defaultCharset;
          collate = this.config.tableOptions.defaultCollate;
          break;
        case 'Float':
          sqlType = 'double';
          break;
        case 'Int':
          sqlType = 'int(11)';
          break;
        case 'Boolean':
          sqlType = this.config.booleanSqlType;
          break;
        default:
          throw new Error(
            `@sqlType directive required for custom scalar type "${fieldType.name}"${formatLocationOf(field.astNode)}`
          );
      }
    } else if (isEnumType(fieldType)) {
      // for enums without @sqlType, determine maximum value length and whether all are ints
      const fieldTypeInfo = this.analyzer.getTypeInfo(fieldType);
      if (fieldTypeInfo.valueType === EnumValueType.STRING) {
        sqlType = `varchar(${fieldTypeInfo.maxLength})`;
        charset = this.config.tableOptions.defaultCharset;
        collate = this.config.tableOptions.defaultCollate;
      } else if (fieldTypeInfo.minIntValue >= 0 && fieldTypeInfo.maxIntValue <= 255) {
        sqlType = 'tinyint(3) unsigned';
      } else {
        sqlType = 'int(11)';
      }
    } else if (isObjectType(fieldType)) {
      if (this.analyzer.isConnectionType(fieldType)) {
        // one:many or many:many relation following the Relay connection pattern
        const edgeType = this.analyzer.getEdgeTypeForConnection(fieldType);
        const edgeTypeInfo = this.analyzer.getTypeInfo(edgeType);
        const edgeFields = edgeType.getFields();
        const { node } = edgeFields;
        const nodeType = getNullableType(node.type);
        if (!isCompositeType(nodeType)) {
          throw new Error(`Unsupported connection node type "${fieldType.name}"${formatLocationOf(field.astNode)}`);
        }
        const nodeTableMapping = this.getNodeTable(nodeType);
        const nmtmDir = findFirstDirective(field, this.config.newManyToManyDirective);
        const umtmDir = findFirstDirective(field, this.config.useManyToManyDirective);
        const nodeBackrefField = this.analyzer.findNodeBackrefField(nodeType, typeInfo.type, field);
        const nodeBackrefJoin = this.analyzer.getNodeBackrefJoin(nodeType, typeInfo.type, field);
        const otherEdgeFieldNames = Object.keys(edgeFields).filter(k => k !== 'cursor' && k !== 'node');
        if (umtmDir != null) {
          // use existing many:many join table created for another field (i.e. the inverse relation)
          const fieldArg = getRequiredDirectiveArgument(umtmDir, 'tableName', 'StringValue');
          const tableName = (fieldArg.value as StringValueNode).value;
          let joinTableMapping = this.tableMappingByName.get(tableName);
          if (!joinTableMapping) {
            joinTableMapping = this.emitTable(tableName, edgeType);
          }
          mapping.fieldMappings.set(field, {
            field,
            toTable: joinTableMapping,
            pkPrefix: false,
            nodeTable: nodeTableMapping
          });
        } else if (nmtmDir != null || (!nodeBackrefField && !nodeBackrefJoin) || otherEdgeFieldNames.length > 0) {
          // create a many:many join table if required by directive, lack of back-reference, or edge fields
          const joinTableMapping = this.getJoinTable(table, typeInfo, field, edgeType);
          if (joinTableMapping.fieldsMapped === FieldsMapped.SOME_KEYS) {
            const { node } = edgeFields;
            ({ name, explicitName } = getColumnNameInfo(node, this.config, snakeCase(getNamedType(nodeType).name)));
            notNull = isNonNullType(node.type);
            const refCols = this.addTypeReferenceColumns(
              joinTableMapping.table,
              nodeType,
              name,
              explicitName,
              notNull,
              uniqueKey
            );
            joinTableMapping.table.primaryKey.parts.push(...refCols.map(column => ({ column, descending: false })));
            joinTableMapping.fieldsMapped = FieldsMapped.ALL_KEYS;
            this.emitColumnsForFields(joinTableMapping, edgeTypeInfo, otherEdgeFieldNames);
            this.emitJoinTableKeys(joinTableMapping.table, field);
          }
          mapping.fieldMappings.set(field, {
            field,
            toTable: joinTableMapping,
            pkPrefix: true,
            nodeTable: nodeTableMapping
          });
        } else {
          // one:many join using back-reference field (node field of this type)
          // or join (node fields corresponding to fields of this type)
          const fieldMapping: FieldJoin = { field, toTable: nodeTableMapping };
          if (nodeBackrefField) {
            fieldMapping.toFields = [nodeBackrefField];
          } else {
            fieldMapping.fromFields = nodeBackrefJoin!.map(pair => pair[1] || pair[0]);
            fieldMapping.toFields = nodeBackrefJoin!.map(pair => pair[0]);
          }
          mapping.fieldMappings.set(field, fieldMapping);
        }
        return [];
      } else {
        const fieldTypeInfo = this.analyzer.getTypeInfo(fieldType);
        if (fieldTypeInfo.hasIdentity) {
          // for identity tables, reference by internal ID
          const columns = this.addTypeReferenceColumns(table, fieldType, name, explicitName, notNull, uniqueKey);
          mapping.fieldMappings.set(field, { field, columns });
          return columns;
        } else if (fieldTypeInfo.hasData) {
          // create 1:1 join table for nested type with data but no identity
          const joinTableMapping = this.getJoinTable(table, typeInfo, field, fieldType);
          if (joinTableMapping.fieldsMapped === FieldsMapped.SOME_KEYS) {
            joinTableMapping.fieldsMapped = FieldsMapped.ALL_KEYS;
            this.emitColumnsForFields(joinTableMapping, fieldTypeInfo);
            this.emitJoinTableKeys(joinTableMapping.table, field);
          }
          mapping.fieldMappings.set(field, { field, toTable: joinTableMapping });
        } else {
          // for nested type with no data, associate any connection fields with containing type
          this.emitColumnsForFields(mapping, fieldTypeInfo);
          mapping.fieldMappings.set(field, { field, toTable: mapping });
        }
        return [];
      }
    } else if (isInterfaceType(fieldType) || isUnionType(fieldType)) {
      const columns = this.addTypeReferenceColumns(table, fieldType, name, explicitName, notNull, uniqueKey);
      mapping.fieldMappings.set(field, { field, columns });
      return columns;
    } else if (isListType(fieldType)) {
      // TODO: sequenced join table for lists
      throw new Error(`List types are not currently supported: ${fieldType.toString()}`);
    } else {
      throw new Error(`Unrecognized field type: ${(fieldType as GraphQLOutputType).toString()}`);
    }

    const column: SqlColumn = {
      name,
      type: sqlType,
      charset,
      collate,
      srid,
      notNull
    };
    if (hasDirective(field, this.config.createdAtDirective)) {
      column.default = 'CURRENT_TIMESTAMP';
    }
    if (hasDirective(field, this.config.updatedAtDirective)) {
      column.onUpdate = 'CURRENT_TIMESTAMP';
    }
    table.columns.push(column);
    if (uniqueKey) {
      table.keys.push({
        name,
        type: SqlKeyType.UNIQUE,
        parts: [{ column, descending: false }]
      });
    }
    const columns = [column];
    mapping.fieldMappings.set(field, { field, columns });
    return columns;
  }

  private emitKeys(table: SqlTable, keysArg: ArgumentNode): void {
    for (const keyValue of (keysArg.value as ListValueNode).values) {
      const { fields } = keyValue as ObjectValueNode;
      const nameField = fields.find(f => f.name.value === 'name');
      const keyName = nameField ? (nameField.value as StringValueNode).value : undefined;
      const uniqueField = fields.find(f => f.name.value === 'unique');
      const unique = uniqueField != null && (uniqueField.value as BooleanValueNode).value;
      const columnsField = fields.find(f => f.name.value === 'columns');
      if (!columnsField || columnsField.value.kind !== 'ListValue') {
        throw new Error(`Expected ListValue for @${this.config.sqlTableDirective}.columns`);
      }
      const columnNames = (columnsField.value as ListValueNode).values.map(v => (v as StringValueNode).value);
      const name = keyName || columnNames.join('_');
      if (!table.keys.find(key => key.name === name)) {
        table.keys.push({
          name,
          type: unique ? SqlKeyType.UNIQUE : SqlKeyType.INDEX,
          parts: columnNames.map(columnName => {
            const column = table.columns.find(column => column.name === columnName);
            if (column == null) {
              throw new Error(
                `Column "${columnName}" not found in table "${name}" for ${
                  keyName ? `key "${keyName}"` : 'unnamed key'
                }`
              );
            }
            return {
              column,
              descending: false
            };
          })
        });
      }
    }
  }

  private getNodeTable(nodeType: GraphQLCompositeType): TableMapping {
    let typeInfo = this.analyzer.getTypeInfo(nodeType);
    if (typeInfo.identityTypeInfo) {
      typeInfo = typeInfo.identityTypeInfo;
    }
    if (!typeInfo.hasTable) {
      // TODO: support discriminated unions as connection nodes
      const typeKind = isInterfaceType(nodeType) ? 'implementing types' : 'union members';
      throw new Error(`All ${typeKind} of "${nodeType.name}" must have common table interface`);
    }
    return this.generateTable(typeInfo as TypeInfo<TableType>)!;
  }

  private getJoinTable(
    parentTable: SqlTable,
    parentTypeInfo: TypeInfo<TableType>,
    field: FieldType,
    joinType: GraphQLObjectType
  ): TableMapping {
    // analyze references to the target type to determine which can share a table
    // 1. references from types sharing a common identity interface can share a table
    // 2. references from multiple interface or concrete types require a table name prefix
    // 3. references from multiple fields within a type also require a table name prefix
    // 4. cases #2 and #3 can each result in a separate table name prefix
    const parentType = parentTypeInfo.type;
    const joinTypeInfo = this.analyzer.getTypeInfo(joinType);
    const fieldCountByRefType = new Map<TableType, number>();
    let commonIdentityInterface = null;
    let nonIdentityInterface = false;
    let multipleIdentityInterfaces = false;
    let foundRef = false;
    let foundIdentityInterface = null;
    for (const ref of joinTypeInfo.referringFields) {
      const { type } = ref;
      const typeRefCount = (fieldCountByRefType.get(type) || 0) + 1;
      fieldCountByRefType.set(type, typeRefCount);

      const refTypeInfo = this.analyzer.getTypeInfo(type);
      const identityInterface = refTypeInfo.identityTypeInfo;
      if (identityInterface) {
        if (commonIdentityInterface == null) {
          commonIdentityInterface = identityInterface;
        } else if (commonIdentityInterface !== identityInterface) {
          multipleIdentityInterfaces = true;
        }
      } else {
        nonIdentityInterface = true;
      }

      if (type === parentType && field === ref.field) {
        foundRef = true;
        foundIdentityInterface = identityInterface;
      }
    }
    assert(foundRef, `Reference not found: ${parentTable.name}.${field.name} -> ${joinType.name}`);

    let tableName = null;
    const nmtmDir = findFirstDirective(field, this.config.newManyToManyDirective);
    if (nmtmDir != null) {
      const fieldArg = getDirectiveArgument(nmtmDir, 'tableName');
      if (fieldArg != null) {
        tableName = (fieldArg.value as StringValueNode).value;
      }
    }

    const idPrefix = snakeCase(foundIdentityInterface ? foundIdentityInterface.type.name : parentType.name);
    if (tableName == null) {
      const needIdentityPrefix = multipleIdentityInterfaces || (nonIdentityInterface && fieldCountByRefType.size > 1);
      const needFieldPrefix = (fieldCountByRefType.get(parentType) || 0) > 1;
      const tablePrefix =
        (needIdentityPrefix ? idPrefix + '_' : '') + (needFieldPrefix ? snakeCase(field.name) + '_' : '');
      tableName = tablePrefix + snakeCase(joinType.name);
    }

    let childTableMapping = this.tableMappingByName.get(tableName);
    if (!childTableMapping) {
      childTableMapping = this.emitTable(tableName, joinType);
    }

    // @useManyToMany emits a table without setting its primary key
    if (childTableMapping.fieldsMapped === FieldsMapped.NONE) {
      this.addParentKeyColumns(childTableMapping.table, parentTable, idPrefix);
      childTableMapping.fieldsMapped = FieldsMapped.SOME_KEYS;
    }

    return childTableMapping;
  }

  private emitJoinTableKeys(table: SqlTable, field: FieldType): void {
    const nmtmDir = findFirstDirective(field, this.config.newManyToManyDirective);
    if (nmtmDir != null) {
      const keysArg = getDirectiveArgument(nmtmDir, 'tableKeys');
      if (keysArg != null) {
        this.emitKeys(table, keysArg);
      }
    }
  }

  private addParentKeyColumns(childTable: SqlTable, parentTable: SqlTable, idPrefix?: string): void {
    for (const part of parentTable.primaryKey.parts) {
      let { name, type } = part.column;
      if (name === 'id') {
        name = (idPrefix || parentTable.name) + '_id';
      }
      const childColumn = { name, type, notNull: true };
      childTable.columns.push(childColumn);
      childTable.primaryKey.parts.push({
        column: childColumn,
        descending: false
      });
    }
  }

  private addTypeReferenceColumns(
    sourceTable: SqlTable,
    targetType: GraphQLCompositeType,
    refName: string,
    explicitName: boolean,
    notNull: boolean,
    uniqueKey: boolean
  ): SqlColumn[] {
    let typeInfo = this.analyzer.getTypeInfo(targetType);
    if (typeInfo.identityTypeInfo) {
      typeInfo = typeInfo.identityTypeInfo;
    }
    if (typeInfo.hasTable) {
      const targetTableMapping = this.generateTable(typeInfo as TypeInfo<TableType>)!;
      return this.addTableReferenceColumns(
        sourceTable,
        targetTableMapping.table,
        refName,
        explicitName,
        notNull,
        uniqueKey
      );
    } else if (typeInfo.tableIds) {
      return this.addDiscriminatedReferenceColumns(
        sourceTable,
        typeInfo.tableIds,
        refName,
        explicitName,
        notNull,
        uniqueKey
      );
    } else {
      throw new Error(
        `Member types of union "${targetType.name}" must have common table interface or @${this.config.sqlTableDirective} IDs`
      );
    }
  }

  private addDiscriminatedReferenceColumns(
    sourceTable: SqlTable,
    targetTables: Map<string, TableType>,
    refName: string,
    explicitName: boolean,
    notNull: boolean,
    uniqueKey: boolean
  ): SqlColumn[] {
    const addedColumns: SqlColumn[] = [];

    const discColumn = {
      name: refName + this.config.tableIdSuffix,
      type: this.config.tableIdSqlType,
      notNull,
      discriminator: true
    };
    sourceTable.columns.push(discColumn);
    addedColumns.push(discColumn);

    const refTableMapping = this.generateDiscriminatedTables(targetTables);
    addedColumns.push(
      ...this.addTableReferenceColumns(sourceTable, refTableMapping.table, refName, explicitName, notNull, uniqueKey)
    );

    return addedColumns;
  }

  private generateDiscriminatedTables(targetTables: Map<string, TableType>): TableMapping {
    let refTableMapping = null;
    for (const type of targetTables.values()) {
      const typeInfo = this.analyzer.getTypeInfo(type);
      assert(typeInfo.hasTable);
      const newTableMapping = this.generateTable(typeInfo);
      assert(newTableMapping != null);
      const newTable = newTableMapping!.table;
      if (refTableMapping == null) {
        assert(newTable.primaryKey.parts.length > 0);
        refTableMapping = newTableMapping;
      } else {
        const refTable = refTableMapping.table;
        if (newTable.primaryKey.parts.length !== refTable.primaryKey.parts.length) {
          throw new Error(`Primary key mismatch in union reference between "${newTable.name}" and "${refTable.name}"`);
        }
        for (let i = 0; i < newTable.primaryKey.parts.length; ++i) {
          const newTableColumn = newTable.primaryKey.parts[i].column;
          const refTableColumn = refTable.primaryKey.parts[i].column;
          if (newTableColumn.type !== refTableColumn.type) {
            throw new Error(
              'Primary key column type mismatch in union reference between ' +
                `"${newTable.name}.${newTableColumn.name}" (${newTableColumn.type}) and ` +
                `"${refTable.name}.${refTableColumn.name}" (${refTableColumn.type})`
            );
          }
        }
      }
    }
    assert(refTableMapping);
    return refTableMapping!;
  }

  private addTableReferenceColumns(
    sourceTable: SqlTable,
    targetTable: SqlTable,
    refName: string,
    explicitName: boolean,
    notNull: boolean,
    uniqueKey: boolean
  ): SqlColumn[] {
    const { primaryKey } = targetTable;
    const addedColumns = [];
    if (primaryKey.parts.length === 1) {
      const name = explicitName ? refName : refName + this.config.internalIdSuffix;
      const { type, collate } = primaryKey.parts[0].column;
      const refColumn = { name, type, collate, notNull };
      sourceTable.columns.push(refColumn);
      addedColumns.push(refColumn);
    } else {
      const addPrefix = explicitName || !targetTable.name.startsWith(refName);
      for (const part of primaryKey.parts) {
        let { name, type, collate } = part.column;
        if (addPrefix) {
          name = refName + '_' + name;
        }
        const refColumn = { name, type, collate, notNull };
        sourceTable.columns.push(refColumn);
        addedColumns.push(refColumn);
      }
    }
    if (uniqueKey) {
      sourceTable.keys.push({
        name: addedColumns[0].name,
        type: SqlKeyType.UNIQUE,
        parts: addedColumns.map(column => ({ column, descending: false }))
      });
    }
    return addedColumns;
  }
}

function getTableName(type: GraphQLNamedType, config: SqlConfig): string {
  const tableDir = findFirstDirective(type, config.sqlTableDirective);
  if (tableDir != null) {
    const nameArg = getDirectiveArgument(tableDir, 'name');
    if (nameArg != null) {
      return (nameArg.value as StringValueNode).value;
    }
  }
  return snakeCase(type.name);
}

function getColumnNameInfo(
  field: FieldType,
  config: SqlConfig,
  defaultName?: string
): { name: string; explicitName: boolean } {
  let name = defaultName;
  let explicitName = false;

  const columnDir = findFirstDirective(field, config.sqlColumnDirective);
  if (columnDir != null) {
    const nameArg = getDirectiveArgument(columnDir, 'name');
    if (nameArg != null) {
      name = (nameArg.value as StringValueNode).value;
      explicitName = true;
    }
  }

  if (!name) {
    const xidDir = findFirstDirective(field, config.externalIdDirective);
    const sidDir = findFirstDirective(field, config.stringIdDirective);
    if (xidDir != null) {
      name = config.externalIdName;
    } else if (sidDir != null) {
      name = config.stringIdName;
    } else {
      name = snakeCase(field.name);
    }
  }

  return { name, explicitName };
}
