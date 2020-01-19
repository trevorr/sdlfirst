import { GraphQLCompositeType, isCompositeType, isInterfaceType, isUnionType } from 'graphql';
import path from 'path';
import ts from 'typescript';
import { Analyzer, TableType, TypeInfo } from './Analyzer';
import { defaultConfig as defaultPathConfig, PathConfig } from './config/PathConfig';
import { SqlSchemaMappings } from './SqlSchemaBuilder';
import { compare } from './util/compare';
import { mkdir } from './util/fs-util';
import { defaultConfig as defaultFormatterConfig, TsFormatter, TsFormatterConfig } from './util/TsFormatter';
import { TsModule } from './util/TsModule';

export interface SqlMetadataConfig extends PathConfig, TsFormatterConfig {
  gqlsqlTypesNamespace: string;
  gqlsqlTypesModule: string;
}

export const defaultConfig: SqlMetadataConfig = {
  ...defaultPathConfig,
  ...defaultFormatterConfig,
  gqlsqlTypesNamespace: 'gqlsql',
  gqlsqlTypesModule: 'gqlsql'
};

interface MetaInfo {
  id: string;
  path: string;
}

export class SqlMetadataWriter {
  private readonly config: SqlMetadataConfig;
  private readonly metas: MetaInfo[] = [];
  private readonly formatter: TsFormatter;

  constructor(
    private readonly analyzer: Analyzer,
    private readonly sqlMappings: SqlSchemaMappings,
    config?: Partial<SqlMetadataConfig>
  ) {
    this.config = Object.assign({}, defaultConfig, config);
    this.formatter = new TsFormatter(config);
  }

  public async writeMetadata(): Promise<string[]> {
    const { baseDir, databaseMetadataDir } = this.config;
    await mkdir(path.join(baseDir, databaseMetadataDir), { recursive: true });
    for (const typeInfo of this.analyzer.getTypeInfos()) {
      if (isCompositeType(typeInfo.type)) {
        await this.writeTypeMetadata(typeInfo as TypeInfo<GraphQLCompositeType>);
      }
    }
    const files = this.metas.map(r => r.path);
    if (this.metas.length > 0) {
      const outputFile = this.getSourcePath('index');
      await this.createIndexModule(this.metas).write(outputFile, this.formatter);
      files.push(outputFile);
    }
    return files;
  }

  private async writeTypeMetadata(typeInfo: TypeInfo<GraphQLCompositeType>): Promise<TsModule | null> {
    const module = new TsModule();
    const propMap: Record<string, ts.Expression> = {};

    const { gqlsqlTypesModule, gqlsqlTypesNamespace } = this.config;
    const gqlsql = module.addNamespaceImport(gqlsqlTypesModule, gqlsqlTypesNamespace);
    let tsType;

    const { type, tableIds } = typeInfo;
    if (tableIds) {
      tsType = ts.createTypeReferenceNode(ts.createQualifiedName(gqlsql, 'UnionMetadata'), undefined);

      const idProps = [];
      for (const [key, value] of Array.from(tableIds.entries()).sort((a, b) => compare(a[0], b[0]))) {
        idProps.push(ts.createPropertyAssignment(key, module.addImport(`./${value.name}`, value.name)));
      }
      propMap['tableIds'] = ts.createObjectLiteral(idProps, true);
    } else {
      const { identityTypeInfo, tableId } = typeInfo;
      const idType = identityTypeInfo ? identityTypeInfo.type : typeInfo.hasTable ? (type as TableType) : null;
      if (idType) {
        const mapping = this.sqlMappings.getIdentityTableForType(idType);
        if (mapping) {
          tsType = ts.createTypeReferenceNode(ts.createQualifiedName(gqlsql, 'TableMetadata'), undefined);

          if (tableId) {
            propMap['tableId'] = ts.createStringLiteral(tableId);
          }

          propMap['tableName'] = ts.createStringLiteral(mapping.table.name);
        } else {
          return null;
        }
      } else {
        return null;
      }
    }

    propMap['typeName'] = ts.createStringLiteral(type.name);

    let objectTypes;
    if (isInterfaceType(type)) {
      objectTypes = Array.from(this.analyzer.getImplementingTypes(type));
    } else if (isUnionType(type)) {
      objectTypes = type.getTypes();
    }
    if (objectTypes && objectTypes.length > 0) {
      propMap['objectTypes'] = ts.createArrayLiteral(
        objectTypes
          .sort((a, b) => compare(a.name, b.name))
          .map(objectType => module.addImport(`./${objectType.name}`, objectType.name)),
        true
      );
    }

    const properties = Object.entries(propMap)
      .sort((a, b) => compare(a[0], b[0]))
      .map(([key, value]) => ts.createPropertyAssignment(key, value));
    const id = ts.createIdentifier(type.name);
    module.addStatement(this.declareConst(id, tsType, ts.createObjectLiteral(properties, true)));
    module.addStatement(ts.createExportDefault(id));

    const outputFile = this.getSourcePath(type.name);
    await module.write(outputFile, this.formatter);
    this.metas.push({ id: type.name, path: outputFile });

    return module;
  }

  private createIndexModule(metas: MetaInfo[]): TsModule {
    const module = new TsModule();

    const properties = [];
    metas.sort((a, b) => compare(a.id, b.id));
    for (const resolver of metas) {
      const { id } = resolver;
      const idIdentifier = module.addImport(`./${id}`, id);
      properties.push(ts.createShorthandPropertyAssignment(idIdentifier));
    }

    module.addStatement(ts.createExportDefault(ts.createObjectLiteral(properties, true)));

    return module;
  }

  private declareConst(
    name: string | ts.BindingName,
    type?: ts.TypeNode,
    initializer?: ts.Expression
  ): ts.VariableStatement {
    return ts.createVariableStatement(
      undefined,
      ts.createVariableDeclarationList([ts.createVariableDeclaration(name, type, initializer)], ts.NodeFlags.Const)
    );
  }

  private getSourcePath(filename: string): string {
    const { baseDir, databaseMetadataDir, typescriptExtension } = this.config;
    return path.join(baseDir, databaseMetadataDir, `${filename}${typescriptExtension}`);
  }
}
