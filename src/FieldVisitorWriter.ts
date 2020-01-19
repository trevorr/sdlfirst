import assert from 'assert';
import {
  getNamedType,
  getNullableType,
  isCompositeType,
  isEnumType,
  isInterfaceType,
  isScalarType,
  isUnionType
} from 'graphql';
import { pascalCase } from 'pascal-case';
import path from 'path';
import ts from 'typescript';
import { Analyzer, FieldType, TableType } from './Analyzer';
import { defaultConfig as defaultSqlConfig, SqlConfig } from './config/SqlConfig';
import { SqlColumn } from './model/SqlColumn';
import { SqlTable } from './model/SqlTable';
import { FieldColumns, FieldJoin, isColumns, isJoin, SqlSchemaMappings, TypeTable } from './SqlSchemaBuilder';
import { findFirstDirective } from './util/ast-util';
import { compare } from './util/compare';
import { mkdir } from './util/fs-util';
import { defaultConfig as defaultFormatterConfig, TsFormatter, TsFormatterConfig } from './util/TsFormatter';
import { TsModule } from './util/TsModule';

const EdgesVisitorsType = 'EdgesVisitors';
const FieldVisitorsType = 'FieldVisitors';
const SqlQueryResolverType = 'SqlQueryResolver';
const VisitorsConst = 'Visitors';

export interface FieldVisitorConfig extends SqlConfig, TsFormatterConfig {
  gqlsqlTypesNamespace: string;
  gqlsqlTypesModule: string;
  contextArgName: string;
  infoArgName: string;
  visitorsArgName: string;
}

export const defaultConfig: FieldVisitorConfig = {
  ...defaultSqlConfig,
  ...defaultFormatterConfig,
  gqlsqlTypesNamespace: 'gqlsql',
  gqlsqlTypesModule: 'gqlsql',
  contextArgName: 'context',
  infoArgName: 'info',
  visitorsArgName: 'visitors'
};

interface VisitorInfo {
  id: string;
  path: string;
}

export class FieldVisitorWriter {
  private readonly config: Readonly<FieldVisitorConfig>;
  private readonly visitors: VisitorInfo[] = [];
  private readonly gqlsqlNamespaceId: ts.Identifier;
  private readonly formatter: TsFormatter;

  constructor(
    private readonly analyzer: Analyzer,
    private readonly sqlMappings: SqlSchemaMappings,
    config?: Partial<FieldVisitorConfig>
  ) {
    this.config = Object.freeze(Object.assign({}, defaultConfig, analyzer.getConfig(), config));

    this.gqlsqlNamespaceId = ts.createIdentifier(this.config.gqlsqlTypesNamespace);

    this.formatter = new TsFormatter(config);
  }

  public async writeVisitors(): Promise<string[]> {
    const { baseDir, fieldVisitorsDir } = this.config;
    await mkdir(path.join(baseDir, fieldVisitorsDir), { recursive: true });
    for (const tableMapping of this.sqlMappings.tables) {
      await this.writeVisitor(tableMapping);
    }
    const files = this.visitors.map(r => r.path);
    if (this.visitors.length > 0) {
      const outputFile = this.getSourcePath('index');
      await this.createIndexModule(this.visitors).write(outputFile, this.formatter);
      files.push(outputFile);
    }
    return files;
  }

  private async writeVisitor(tableMapping: TypeTable): Promise<void> {
    const { type } = tableMapping;
    const isEdgeType = this.analyzer.isEdgeType(type);
    let fields = Object.values(type.getFields());
    if (isEdgeType) {
      fields = fields.filter(field => field.name !== 'cursor' && field.name !== 'node');
      if (fields.length === 0) {
        return;
      }
    }

    const module = new TsModule();

    const { gqlsqlTypesModule, gqlsqlTypesNamespace } = this.config;
    if (gqlsqlTypesModule && gqlsqlTypesNamespace) {
      module.addNamespaceImport(gqlsqlTypesModule, gqlsqlTypesNamespace);
    }

    const typeInfo = this.analyzer.getTypeInfo(tableMapping.type);
    const { identityTypeInfo } = typeInfo;
    let identityVisitorsId = null;
    const identityTableFields = new Set<string>();
    if (identityTypeInfo) {
      const { type } = identityTypeInfo;
      for (const field of Object.values(type.getFields())) {
        identityTableFields.add(field.name);
      }

      const { name } = type;
      identityVisitorsId = module.addImport(`./${name}`, name + VisitorsConst);
    }

    const properties: ts.ObjectLiteralElementLike[] = [];

    if (isEdgeType) {
      properties.push(ts.createSpreadAssignment(ts.createPropertyAccess(this.gqlsqlNamespaceId, EdgesVisitorsType)));
    }

    const { table, fieldMappings } = tableMapping;
    for (const field of fields) {
      if (identityTableFields.has(field.name)) continue;

      const params = [
        this.createSimpleParameter(this.config.contextArgName),
        this.createSimpleParameter(this.config.infoArgName)
      ];
      const body: ts.Statement[] = [];

      const fieldMapping = fieldMappings.get(field);
      const fieldType = getNullableType(field.type);
      if (isScalarType(fieldType)) {
        if (!fieldMapping || !isColumns(fieldMapping)) {
          throw new Error(`Column expected for scalar field "${field.name}"`);
        }
        body.push(ts.createReturn(this.addVisitorColumnField(fieldMapping.columns[0].name, table.name)));
      } else if (isEnumType(fieldType)) {
        if (!fieldMapping || !isColumns(fieldMapping)) {
          throw new Error(`Column expected for scalar field "${field.name}"`);
        }
        const id = pascalCase(fieldType.name);
        const fromSqlId = module.addNamedImport(
          path.relative(this.config.fieldVisitorsDir, `${this.config.enumMappingsDir}/${id}`),
          `SqlTo${id}`
        );
        const arrowParam = 'value';
        const func = ts.createArrowFunction(
          undefined,
          undefined,
          [this.createSimpleParameter(arrowParam)],
          undefined,
          undefined,
          ts.createAsExpression(
            ts.createCall(ts.createPropertyAccess(fromSqlId, 'get'), undefined, [ts.createIdentifier(arrowParam)]),
            ts.createTypeReferenceNode('string', undefined)
          )
        );
        body.push(ts.createReturn(this.addVisitorColumnField(fieldMapping.columns[0].name, table.name, func)));
      } else if (this.analyzer.isConnectionType(fieldType)) {
        if (!fieldMapping) {
          throw new Error(`No mapping for connection field "${type.name}.${field.name}"`);
        }
        if (!isJoin(fieldMapping)) {
          throw new Error(`Join mapping expected for connection field "${type.name}.${field.name}"`);
        }
        const infoId = ts.createIdentifier(this.config.infoArgName);
        const visitorsId = ts.createIdentifier(this.config.visitorsArgName);
        params.push(this.createSimpleParameter(visitorsId));
        const joinSpec = this.getJoinSpec(tableMapping, fieldMapping);
        const callParams: ts.Expression[] = [
          ts.createPropertyAccess(infoId, 'fieldName'),
          joinSpec,
          ts.createCall(ts.createPropertyAccess(this.gqlsqlNamespaceId, 'resolveArguments'), undefined, [infoId])
        ];
        const nodeResolverId = ts.createIdentifier('nodeResolver');
        const configStatements = [];

        // addTable for many:many connection to join edge table to node table
        if (fieldMapping.nodeTable) {
          configStatements.push(
            ts.createStatement(
              ts.createCall(ts.createPropertyAccess(nodeResolverId, 'addTable'), undefined, [
                this.getNodeJoinSpec(fieldMapping)
              ])
            )
          );
        }

        // order by primary key by default, though it will usual need to be changed
        const toTable = fieldMapping.toTable.table;
        for (const part of toTable.primaryKey.parts) {
          configStatements.push(
            ts.createStatement(
              ts.createCall(ts.createPropertyAccess(nodeResolverId, 'addOrderBy'), undefined, [
                ts.createStringLiteral(part.column.name),
                ts.createStringLiteral(toTable.name)
              ])
            )
          );
        }

        body.push(
          ts.createStatement(
            ts.createCall(
              ts.createPropertyAccess(
                ts.createCall(
                  ts.createPropertyAccess(ts.createIdentifier(this.config.contextArgName), 'addConnection'),
                  undefined,
                  callParams
                ),
                'walk'
              ),
              undefined,
              [
                infoId,
                visitorsId,
                ts.createArrowFunction(
                  undefined,
                  undefined,
                  [this.createSimpleParameter(nodeResolverId)],
                  undefined,
                  undefined,
                  ts.createBlock(configStatements)
                )
              ]
            )
          )
        );
      } else if (isCompositeType(fieldType)) {
        const fieldTypeInfo = this.analyzer.getTypeInfo(fieldType);
        if (!fieldMapping) {
          throw new Error(`No field mapping for composite field "${type.name}.${field.name}"`);
        }
        let resultExpr: ts.Expression;
        let configType;
        if (isJoin(fieldMapping)) {
          const joinSpec =
            fieldMapping.toTable !== tableMapping ? this.getJoinSpec(tableMapping, fieldMapping) : undefined;
          resultExpr = this.addObjectField(joinSpec);
          configType = fieldType;
        } else {
          let fieldTableType;
          if (isUnionType(fieldType)) {
            if (fieldTypeInfo.identityTypeInfo) {
              fieldTableType = fieldTypeInfo.identityTypeInfo.type;
            } else if (fieldTypeInfo.tableIds) {
              const joinSpecs = this.getUnionJoinSpecs(fieldTypeInfo.tableIds.values(), tableMapping, fieldMapping);
              resultExpr = this.addUnionField(joinSpecs);
            } else {
              throw new Error(
                `Member types of union "${fieldType.name}" must have common table interface or @${this.config.sqlTableDirective} IDs`
              );
            }
          } else {
            fieldTableType = fieldType;
          }
          if (fieldTableType) {
            const joinSpec = this.getColumnsJoinSpec(fieldTableType, tableMapping, fieldMapping);
            if (joinSpec) {
              resultExpr = this.addObjectField(joinSpec);
              configType = fieldTableType;
            } else if (isInterfaceType(fieldType)) {
              const joinSpecs = this.getUnionJoinSpecs(
                this.analyzer.getImplementingTypes(fieldType),
                tableMapping,
                fieldMapping
              );
              resultExpr = this.addUnionField(joinSpecs);
            } else {
              assert(findFirstDirective(fieldType, this.config.sqlTypeDirective));
              resultExpr = this.addObjectField();
            }
          }
        }
        if (isInterfaceType(configType)) {
          const configName = `configure${configType.name}Resolver`;
          const configId = module.addNamedImport(`./${configType.name}`, configName);
          resultExpr = ts.createCall(configId, undefined, [resultExpr!]);
        }
        body.push(ts.createReturn(resultExpr!));
      }

      properties.push(
        ts.createMethod(
          undefined,
          undefined,
          undefined,
          field.name,
          undefined,
          undefined,
          params,
          undefined,
          ts.createBlock(body, true)
        )
      );
    }
    if (!properties.length) return;

    const sqlQueryResolverType = ts.createTypeReferenceNode(
      ts.createQualifiedName(this.gqlsqlNamespaceId, SqlQueryResolverType),
      undefined
    );
    module.addStatement(
      ts.createVariableStatement(
        undefined,
        ts.createVariableDeclarationList(
          [
            ts.createVariableDeclaration(
              VisitorsConst,
              ts.createTypeReferenceNode(ts.createQualifiedName(this.gqlsqlNamespaceId, FieldVisitorsType), [
                sqlQueryResolverType
              ]),
              ts.createObjectLiteral(properties, true)
            )
          ],
          ts.NodeFlags.Const
        )
      )
    );

    let defaultExpr: ts.Expression = ts.createIdentifier(VisitorsConst);
    if (identityVisitorsId) {
      defaultExpr = ts.createCall(ts.createPropertyAccess(ts.createIdentifier('Object'), 'assign'), undefined, [
        ts.createObjectLiteral(),
        identityVisitorsId,
        defaultExpr
      ]);
    }
    module.addStatement(ts.createExportDefault(defaultExpr));

    // create resolver configuration function for interface tables,
    // since they need a __typename column and object tables added
    if (isInterfaceType(type)) {
      const resolverId = ts.createIdentifier('resolver');
      const body: ts.Statement[] = [];

      if (typeInfo.typeDiscriminatorField) {
        const field = typeInfo.typeDiscriminatorField;
        const fieldMapping = fieldMappings.get(field);
        if (fieldMapping && isColumns(fieldMapping)) {
          const id = pascalCase(getNamedType(field.type).name);
          const toTypenameId = module.addNamedImport(
            path.relative(this.config.fieldVisitorsDir, `${this.config.enumMappingsDir}/${id}`),
            `SqlTo${id}__typename`
          );
          const arrowParam = 'value';
          const func = ts.createArrowFunction(
            undefined,
            undefined,
            [this.createSimpleParameter(arrowParam)],
            undefined,
            undefined,
            ts.createNonNullExpression(
              ts.createCall(ts.createPropertyAccess(toTypenameId, 'get'), undefined, [ts.createIdentifier(arrowParam)])
            )
          );
          body.push(
            ts.createExpressionStatement(
              this.addColumnField(
                resolverId,
                ts.createStringLiteral('__typename'),
                fieldMapping.columns[0].name,
                table.name,
                func
              )
            )
          );
        }
      }

      const objTypes = this.analyzer.getImplementingTypes(type);
      for (const objType of objTypes) {
        const objMapping = this.sqlMappings.getIdentityTableForType(objType);
        if (objMapping) {
          const toTable = objMapping.table;
          body.push(
            ts.createExpressionStatement(
              ts.createCall(ts.createPropertyAccess(resolverId, 'addTable'), undefined, [
                ts.createObjectLiteral([
                  ts.createPropertyAssignment('toTable', ts.createStringLiteral(toTable.name)),
                  ts.createPropertyAssignment(
                    'toColumns',
                    ts.createArrayLiteral(
                      toTable.primaryKey.parts.map(part => ts.createStringLiteral(part.column.name))
                    )
                  ),
                  ts.createPropertyAssignment('fromTable', ts.createStringLiteral(table.name)),
                  ts.createPropertyAssignment(
                    'fromColumns',
                    ts.createArrayLiteral(table.primaryKey.parts.map(part => ts.createStringLiteral(part.column.name)))
                  )
                ])
              ])
            )
          );
        }
      }

      body.push(ts.createReturn(resolverId));
      module.addStatement(
        ts.createFunctionDeclaration(
          undefined,
          [ts.createModifier(ts.SyntaxKind.ExportKeyword)],
          undefined,
          `configure${type.name}Resolver`,
          undefined,
          [this.createSimpleParameter(resolverId, sqlQueryResolverType)],
          sqlQueryResolverType,
          ts.createBlock(body, true)
        )
      );
    }

    const sourcePath = this.getSourcePath(type.name);
    await module.write(sourcePath, this.formatter);
    this.visitors.push({ id: type.name, path: sourcePath });
  }

  private getJoinSpec(fromTableMapping: TypeTable, fieldMapping: FieldJoin): ts.Expression {
    const fromTypeInfo = this.analyzer.getTypeInfo(fromTableMapping.type);
    const fromIdMapping =
      !fromTypeInfo.hasIdentity && fromTypeInfo.identityTypeInfo
        ? this.sqlMappings.getIdentityTableForType(fromTypeInfo.identityTypeInfo.type)!
        : fromTableMapping;
    let toColumns, fromColumns;
    if (fieldMapping.toFields) {
      // one:many
      toColumns = this.getFieldColumns(fieldMapping.toFields, fieldMapping.toTable);
      if (fieldMapping.fromFields) {
        // backref join
        fromColumns = this.getFieldColumns(fieldMapping.fromFields, fromTableMapping);
      } else {
        // backref field
        fromColumns = [fromIdMapping.table.primaryKey.parts[0].column];
      }
    } else {
      // many:many
      fromColumns = fromIdMapping.table.primaryKey.parts.map(p => p.column);
      toColumns = sliceFirstLast(
        fieldMapping.toTable.table.primaryKey.parts,
        fieldMapping.pkPrefix!,
        fromColumns.length
      ).map(p => p.column);
    }
    return this.buildJoinSpec(
      fieldMapping.toTable.table,
      fieldMapping.toTable.type,
      toColumns,
      fromTableMapping.table,
      fromTableMapping.type,
      fromColumns
    );
  }

  private getNodeJoinSpec(fieldMapping: FieldJoin): ts.Expression {
    const { table, type } = fieldMapping.nodeTable!;
    const toColumns = table.primaryKey.parts.map(p => p.column);
    const fromColumns = sliceFirstLast(
      fieldMapping.toTable.table.primaryKey.parts,
      !fieldMapping.pkPrefix,
      toColumns.length
    ).map(p => p.column);
    return this.buildJoinSpec(
      table,
      type,
      toColumns,
      fieldMapping.toTable.table,
      fieldMapping.toTable.type,
      fromColumns
    );
  }

  private getColumnsJoinSpec(
    toType: TableType,
    fromMapping: TypeTable,
    fieldMapping: FieldColumns,
    includeTypeName?: boolean
  ): ts.Expression | null {
    const toTableMapping = this.sqlMappings.getIdentityTableForType(toType);
    if (!toTableMapping) {
      return null;
    }
    const { table } = toTableMapping;
    return this.buildJoinSpec(
      table,
      toType,
      table.primaryKey.parts.map(p => p.column),
      fromMapping.table,
      fromMapping.type,
      fieldMapping.columns,
      includeTypeName ? toType.name : undefined
    );
  }

  private getUnionJoinSpecs(
    toTypes: Iterable<TableType>,
    fromMapping: TypeTable,
    fieldMapping: FieldColumns
  ): ts.Expression[] {
    const joinSpecs = [];
    for (const toType of toTypes) {
      const joinSpec = this.getColumnsJoinSpec(toType, fromMapping, fieldMapping, true);
      if (!joinSpec) {
        throw new Error(`Table mapping not found for union member "${toType.name}"`);
      }
      joinSpecs.push(joinSpec);
    }
    return joinSpecs;
  }

  private buildJoinSpec(
    toTable: SqlTable,
    toType: TableType,
    toColumns: SqlColumn[],
    fromTable: SqlTable,
    fromType: TableType,
    fromColumns: SqlColumn[],
    typeName?: string
  ): ts.Expression {
    const params = [];
    if (typeName) {
      params.push(ts.createPropertyAssignment('typeName', ts.createStringLiteral(typeName)));
    }
    params.push(ts.createPropertyAssignment('toTable', ts.createStringLiteral(toTable.name)));
    this.addJoinSpecColumns(params, 'to', toColumns, fromType);
    params.push(ts.createPropertyAssignment('fromTable', ts.createStringLiteral(fromTable.name)));
    this.addJoinSpecColumns(params, 'from', fromColumns, toType);
    return ts.createObjectLiteral(params);
  }

  private addJoinSpecColumns(
    params: ts.PropertyAssignment[],
    fromOrTo: 'from' | 'to',
    columns: SqlColumn[],
    idType: TableType
  ): void {
    const discriminatorIndex = columns.findIndex(column => column.discriminator);
    let discriminatorColumn = null;
    if (discriminatorIndex >= 0) {
      discriminatorColumn = columns[discriminatorIndex];
      columns = columns.filter((_, i) => i !== discriminatorIndex);
    }

    params.push(
      ts.createPropertyAssignment(
        `${fromOrTo}Columns`,
        ts.createArrayLiteral(columns.map(column => ts.createStringLiteral(column.name)))
      )
    );

    if (discriminatorColumn) {
      const tableId = this.analyzer.getTableId(idType);
      if (!tableId) {
        throw new Error(`Table ID expected for ${idType.name}`);
      }
      params.push(
        ts.createPropertyAssignment(
          `${fromOrTo}Restrictions`,
          ts.createArrayLiteral([
            ts.createObjectLiteral([
              ts.createPropertyAssignment('column', ts.createStringLiteral(discriminatorColumn.name)),
              ts.createPropertyAssignment('value', ts.createStringLiteral(tableId))
            ])
          ])
        )
      );
    }
  }

  private getFieldColumns(fields: FieldType[], tableMapping: TypeTable): SqlColumn[] {
    const { fieldMappings, table } = tableMapping;
    return fields.flatMap(field => {
      const fieldMapping = fieldMappings.get(field);
      if (!fieldMapping) {
        throw new Error(`No mapping for join field "${field.name}" of table "${table.name}"`);
      }
      if (!isColumns(fieldMapping)) {
        throw new Error(`Column mapping expected for join field "${field.name}" of table "${table.name}"`);
      }
      return fieldMapping.columns;
    });
  }

  private addVisitorColumnField(columnName: string, tableName: string, func?: ts.Expression): ts.Expression {
    return this.addColumnField(
      ts.createIdentifier(this.config.contextArgName),
      ts.createPropertyAccess(ts.createIdentifier(this.config.infoArgName), 'fieldName'),
      columnName,
      tableName,
      func
    );
  }

  private addColumnField(
    resolver: ts.Expression,
    field: ts.Expression,
    columnName: string,
    tableName: string,
    func?: ts.Expression
  ): ts.Expression {
    const params = [field, ts.createStringLiteral(columnName), ts.createStringLiteral(tableName)];
    if (func) {
      params.push(func);
    }
    return ts.createCall(ts.createPropertyAccess(resolver, 'addColumnField'), undefined, params);
  }

  private addObjectField(joinSpec?: ts.Expression): ts.Expression {
    const callParams: ts.Expression[] = [
      ts.createPropertyAccess(ts.createIdentifier(this.config.infoArgName), 'fieldName')
    ];
    if (joinSpec) {
      callParams.push(joinSpec);
    }
    return ts.createCall(
      ts.createPropertyAccess(ts.createIdentifier(this.config.contextArgName), 'addObjectField'),
      undefined,
      callParams
    );
  }

  private addUnionField(joinSpec: ts.Expression[]): ts.Expression {
    return ts.createCall(
      ts.createPropertyAccess(ts.createIdentifier(this.config.contextArgName), 'addUnionField'),
      undefined,
      [
        ts.createPropertyAccess(ts.createIdentifier(this.config.infoArgName), 'fieldName'),
        ts.createArrayLiteral(joinSpec)
      ]
    );
  }

  private createSimpleParameter(name: string | ts.Identifier, type?: ts.TypeNode): ts.ParameterDeclaration {
    return ts.createParameter(undefined, undefined, undefined, name, undefined, type);
  }

  private createIndexModule(resolvers: VisitorInfo[]): TsModule {
    const module = new TsModule();
    const properties = [];
    resolvers.sort((a, b) => compare(a.id, b.id));
    for (const resolver of resolvers) {
      const { id } = resolver;
      const idIdentifier = module.addImport(`./${id}`, id);
      properties.push(ts.createShorthandPropertyAssignment(idIdentifier));
    }
    module.addStatement(ts.createExportDefault(ts.createObjectLiteral(properties, true)));
    return module;
  }

  private getSourcePath(filename: string): string {
    const { baseDir, fieldVisitorsDir, typescriptExtension } = this.config;
    return path.join(baseDir, fieldVisitorsDir, `${filename}${typescriptExtension}`);
  }
}

function sliceFirstLast<T>(array: T[], first: boolean, count: number): T[] {
  return first ? array.slice(0, count) : array.slice(-count);
}