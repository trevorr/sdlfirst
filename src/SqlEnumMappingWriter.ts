import { GraphQLEnumType, GraphQLSchema, isEnumType } from 'graphql';
import { pascalCase } from 'pascal-case';
import path from 'path';
import ts from 'typescript';
import { Analyzer, EnumValueType } from './Analyzer';
import { defaultConfig as defaultDirectiveConfig, DirectiveConfig } from './config/DirectiveConfig';
import { defaultConfig as defaultPathConfig, PathConfig } from './config/PathConfig';
import { compare } from './util/compare';
import { mkdir } from './util/fs-util';
import { defaultConfig as defaultFormatterConfig, TsFormatter, TsFormatterConfig } from './util/TsFormatter';
import { TsModule } from './util/TsModule';

export interface SqlEnumMappingConfig extends DirectiveConfig, PathConfig, TsFormatterConfig {
  schemaTypesNamespace?: string;
  schemaTypesModule?: string;
}

export const defaultConfig: SqlEnumMappingConfig = {
  ...defaultDirectiveConfig,
  ...defaultPathConfig,
  ...defaultFormatterConfig,
  schemaTypesNamespace: 'schema',
  schemaTypesModule: '../types',
};

interface MappingInfo {
  id: string;
  exports: string[];
}

export class SqlEnumMappingWriter {
  private readonly config: Readonly<SqlEnumMappingConfig>;
  private readonly mappings: MappingInfo[] = [];
  private readonly schemaNamespaceId: ts.Identifier | null;
  private readonly formatter: TsFormatter;

  constructor(
    private readonly schema: GraphQLSchema,
    private readonly analyzer: Analyzer,
    config?: Partial<SqlEnumMappingConfig>
  ) {
    this.config = Object.freeze(Object.assign({}, defaultConfig, config, analyzer.getConfig()));

    const { schemaTypesNamespace } = this.config;
    this.schemaNamespaceId = schemaTypesNamespace ? ts.factory.createIdentifier(schemaTypesNamespace) : null;

    this.formatter = new TsFormatter(config);
  }

  public getConfig(): Readonly<SqlEnumMappingConfig> {
    return this.config;
  }

  public async writeMappings(): Promise<string[]> {
    const files = [];
    const { baseDir, enumMappingsDir } = this.config;
    await mkdir(path.join(baseDir, enumMappingsDir), { recursive: true });
    for (const type of Object.values(this.schema.getTypeMap())) {
      if (isEnumType(type) && !type.name.startsWith('__') && type.name !== 'SqlValueTransform') {
        const outputFile = await this.createEnumMappingModule(type);
        if (outputFile) {
          files.push(outputFile);
        }
      }
    }
    if (this.mappings.length > 0) {
      const outputFile = this.getSourcePath('index');
      await this.createIndexModule().write(outputFile, this.formatter);
      files.push(outputFile);
    }
    return files;
  }

  private async createEnumMappingModule(type: GraphQLEnumType): Promise<string | null> {
    const typeInfo = this.analyzer.getTypeInfo(type);
    if (!typeInfo.values) return null;

    const id = pascalCase(type.name);
    const outputFile = this.getSourcePath(id);
    const module = new TsModule();
    const exportIds = [];

    const { schemaTypesModule, schemaTypesNamespace } = this.config;
    if (schemaTypesModule && schemaTypesNamespace) {
      module.addNamespaceImport(schemaTypesModule, schemaTypesNamespace);
    }

    let sqlType;
    let valueToNode: (value: string | number) => ts.Expression;
    if (typeInfo.valueType === EnumValueType.INT) {
      sqlType = ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
      valueToNode = (value: string | number) => ts.factory.createNumericLiteral(String(value));
    } else {
      sqlType = ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
      valueToNode = (value: string | number) => ts.factory.createStringLiteral(String(value));
    }
    const valueEntries = Array.from(typeInfo.values.entries());

    const toSqlId = `${id}ToSql`;
    const toSqlMappings = valueEntries.map(([key, value]) =>
      ts.factory.createArrayLiteralExpression([this.createSchemaEnumValueRef(id, key), valueToNode(value)])
    );
    const toSqlInit = ts.factory.createNewExpression(
      ts.factory.createIdentifier('Map'),
      [this.createSchemaTypeRef(id), sqlType],
      [ts.factory.createArrayLiteralExpression(toSqlMappings, true)]
    );
    exportIds.push(toSqlId);
    module.addStatement(this.createExportConst(toSqlId, toSqlInit));

    const fromSqlId = `SqlTo${id}`;
    const fromSqlMappings = valueEntries.map(([key, value]) =>
      ts.factory.createArrayLiteralExpression([valueToNode(value), this.createSchemaEnumValueRef(id, key)])
    );
    const fromSqlInit = ts.factory.createNewExpression(
      ts.factory.createIdentifier('Map'),
      [sqlType, this.createSchemaTypeRef(id)],
      [ts.factory.createArrayLiteralExpression(fromSqlMappings, true)]
    );
    exportIds.push(fromSqlId);
    module.addStatement(this.createExportConst(fromSqlId, fromSqlInit));

    const { discriminatedObjects } = typeInfo;
    if (discriminatedObjects) {
      const toTypenameId = `SqlTo${id}__typename`;
      const toTypenameMappings = Array.from(discriminatedObjects.entries(), ([key, value]) =>
        ts.factory.createArrayLiteralExpression([
          valueToNode(typeInfo.values.get(key)!),
          ts.factory.createStringLiteral(value.type.name),
        ])
      );
      const toTypenameInit = ts.factory.createNewExpression(
        ts.factory.createIdentifier('Map'),
        [sqlType, ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword)],
        [ts.factory.createArrayLiteralExpression(toTypenameMappings, true)]
      );
      exportIds.push(toTypenameId);
      module.addStatement(this.createExportConst(toTypenameId, toTypenameInit));
    }

    await module.write(outputFile, this.formatter);
    this.mappings.push({ id, exports: exportIds.sort() });
    return outputFile;
  }

  private createExportConst(name: string | ts.BindingName, initializer?: ts.Expression): ts.VariableStatement {
    return ts.factory.createVariableStatement(
      [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
      ts.factory.createVariableDeclarationList(
        [ts.factory.createVariableDeclaration(name, undefined, undefined, initializer)],
        ts.NodeFlags.Const
      )
    );
  }

  private createSchemaEnumValueRef(enumName: string, valueName: string): ts.PropertyAccessExpression {
    const { schemaNamespaceId } = this;
    let lhs;
    if (schemaNamespaceId) {
      lhs = ts.factory.createPropertyAccessExpression(schemaNamespaceId, enumName);
    } else {
      lhs = ts.factory.createIdentifier(enumName);
    }
    return ts.factory.createPropertyAccessExpression(lhs, pascalCase(valueName));
  }

  private createSchemaTypeRef(name: string | ts.Identifier): ts.TypeReferenceNode {
    let qname: string | ts.EntityName = name;
    const { schemaNamespaceId } = this;
    if (schemaNamespaceId) {
      qname = ts.factory.createQualifiedName(schemaNamespaceId, qname);
    }
    return ts.factory.createTypeReferenceNode(qname, undefined);
  }

  private createIndexModule(): TsModule {
    const module = new TsModule();
    this.mappings.sort((a, b) => compare(a.id, b.id));
    for (const mapping of this.mappings) {
      const { id, exports } = mapping;
      module.addStatement(
        ts.factory.createExportDeclaration(
          undefined,
          false,
          ts.factory.createNamedExports(
            exports.map((name) => ts.factory.createExportSpecifier(false, undefined, name))
          ),
          ts.factory.createStringLiteral(`./${id}`)
        )
      );
    }
    return module;
  }

  private getSourcePath(filename: string): string {
    const { baseDir, enumMappingsDir, typescriptExtension } = this.config;
    return path.join(baseDir, enumMappingsDir, `${filename}${typescriptExtension}`);
  }
}
