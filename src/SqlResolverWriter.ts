import {
  getNamedType,
  getNullableType,
  GraphQLInterfaceType,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLSchema,
  isEnumType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType
} from 'graphql';
import path from 'path';
import ts from 'typescript';
import { Analyzer, FieldType } from './Analyzer';
import { defaultConfig as defaultPathConfig, PathConfig } from './config/PathConfig';
import { SqlSchemaMappings, TypeTable } from './SqlSchemaBuilder';
import { compare } from './util/compare';
import { mkdir } from './util/fs-util';
import { defaultConfig as defaultFormatterConfig, TsFormatter, TsFormatterConfig } from './util/TsFormatter';
import { TsModule } from './util/TsModule';

const GraphQLJSModule = 'graphql';
const InfoType = 'GraphQLResolveInfo';
const PartialType = 'Partial';
const PromiseType = 'Promise';
const ScalarsType = 'Scalars';

export interface SqlResolverConfig extends PathConfig, TsFormatterConfig {
  includeRootTypes: boolean;
  splitRootMembers: boolean;
  includeUserTypes: boolean;
  includeInterfaces: boolean;
  schemaTypesNamespace?: string;
  schemaTypesModule?: string;
  parentArgName: string;
  rootTypeParentArg: boolean;
  argsArgName: string;
  argsTypeSuffix: string;
  contextType: string;
  contextTypeModule: string;
  contextArgName: string;
  contextResolverFactory: string;
  infoArgName: string;
  unusedArgPrefix: string;
}

export const defaultConfig: SqlResolverConfig = {
  ...defaultPathConfig,
  ...defaultFormatterConfig,
  usePrettier: true,
  includeRootTypes: true,
  splitRootMembers: true,
  includeUserTypes: false,
  includeInterfaces: false,
  schemaTypesNamespace: 'schema',
  schemaTypesModule: '../types',
  parentArgName: 'parent',
  rootTypeParentArg: false,
  argsArgName: 'args',
  argsTypeSuffix: 'Args',
  contextType: 'SqlResolverContext',
  contextTypeModule: 'gqlsql',
  contextArgName: 'context',
  contextResolverFactory: 'resolverFactory',
  infoArgName: 'info',
  unusedArgPrefix: '_'
};

interface ResolverInfo {
  id: string;
  path: string;
}

export class SqlResolverWriter {
  private readonly config: SqlResolverConfig;
  private readonly resolvedTypes = new Set<GraphQLNamedType>();
  private readonly resolvers: ResolverInfo[] = [];
  private readonly methodResolvers: ResolverInfo[] = [];
  private readonly schemaNamespaceId: ts.Identifier | null;
  private readonly contextType: ts.TypeNode;
  private readonly formatter: TsFormatter;

  constructor(
    private readonly schema: GraphQLSchema,
    private readonly analyzer: Analyzer,
    private readonly sqlMappings: SqlSchemaMappings,
    config?: Partial<SqlResolverConfig>
  ) {
    this.config = Object.assign({}, defaultConfig, config);

    const { schemaTypesNamespace } = this.config;
    this.schemaNamespaceId = schemaTypesNamespace ? ts.createIdentifier(schemaTypesNamespace) : null;

    const { contextType } = this.config;
    if (contextType != null) {
      this.contextType = ts.createTypeReferenceNode(contextType, undefined);
    } else {
      this.contextType = ts.createTypeLiteralNode(undefined);
    }

    this.formatter = new TsFormatter(config);
  }

  public async writeResolvers(): Promise<string[]> {
    const { baseDir, resolversDir } = this.config;
    await mkdir(path.join(baseDir, resolversDir), { recursive: true });
    const queryType = this.schema.getQueryType();
    if (queryType != null) {
      await this.writeResolver(queryType, true);
    }
    const mutationType = this.schema.getMutationType();
    if (mutationType != null) {
      await this.writeResolver(mutationType, true);
    }
    const files = this.resolvers.map(r => r.path).concat(this.methodResolvers.map(r => r.path));
    if (this.resolvers.length > 0) {
      const outputFile = this.getSourcePath('index');
      await this.createIndexModule(this.resolvers, false).write(outputFile, this.formatter);
      files.push(outputFile);
    }
    return files;
  }

  private async writeResolver(type: GraphQLNamedType, rootType = false): Promise<void> {
    if (!this.resolvedTypes.has(type)) {
      this.resolvedTypes.add(type);
      if (isObjectType(type)) {
        if (this.analyzer.isConnectionType(type)) {
          this.writeResolver(getNamedType(this.analyzer.getNodeTypeForConnection(type)));
        } else if (!this.isPayloadType(type)) {
          if (rootType ? this.config.includeRootTypes : this.config.includeUserTypes) {
            await this.writeObjectResolver(type, rootType);
          }
          for (const intf of type.getInterfaces()) {
            this.writeResolver(intf);
          }
        }
      } else if (isInterfaceType(type)) {
        if (this.config.includeInterfaces) {
          const outputFile = this.getSourcePath(type.name);
          await this.generateInterfaceResolver(type).write(outputFile, this.formatter);
          this.resolvers.push({ id: type.name, path: outputFile });
        }
        for (const impl of this.analyzer.getImplementingTypes(type)) {
          this.writeResolver(impl);
        }
      }
    }
  }

  private async writeObjectResolver(type: GraphQLObjectType, rootType: boolean): Promise<void> {
    const fields = Object.values(type.getFields());
    if (rootType && this.config.splitRootMembers) {
      const methodResolvers = [];
      for (const field of fields) {
        const id = type.name + capitalize(field.name);
        const outputFile = this.getSourcePath(id);
        await this.writeResolverForFields(outputFile, type, rootType, [field]);
        methodResolvers.push({ id, path: outputFile });
      }
      const outputFile = this.getSourcePath(type.name);
      await this.createIndexModule(methodResolvers, true).write(outputFile, this.formatter);
      this.resolvers.push({ id: type.name, path: outputFile });
      this.methodResolvers.push(...methodResolvers);
    } else {
      const outputFile = this.getSourcePath(type.name);
      await this.writeResolverForFields(outputFile, type, rootType, fields);
      this.resolvers.push({ id: type.name, path: outputFile });
    }
  }

  private async writeResolverForFields(
    sourcePath: string,
    type: GraphQLObjectType,
    rootType: boolean,
    fields: FieldType[]
  ): Promise<void> {
    const module = new TsModule();
    const infoTypeId = module.addNamedImport(GraphQLJSModule, InfoType);

    const { schemaTypesModule, schemaTypesNamespace } = this.config;
    if (schemaTypesModule && schemaTypesNamespace) {
      module.addNamespaceImport(schemaTypesModule, schemaTypesNamespace);
    }

    const { contextType, contextTypeModule } = this.config;
    if (contextType && contextTypeModule) {
      module.addNamedImport(contextTypeModule, contextType);
    }

    const visitorsId = module.addImport(
      path.relative(this.config.resolversDir, `${this.config.fieldVisitorsDir}`),
      'visitors'
    );

    const properties: ts.MethodDeclaration[] = [];
    for (const field of fields) {
      let parentId, parentType;
      if (!rootType || this.config.rootTypeParentArg) {
        parentId = this.config.parentArgName;
        parentType = ts.createTypeReferenceNode(PartialType, [this.createSchemaTypeRef(type.name)]);
      } else {
        parentId = this.config.unusedArgPrefix + this.config.parentArgName;
        parentType = ts.createTypeLiteralNode(undefined);
      }
      let argsId, argsType;
      if (field.args.length > 0) {
        argsId = ts.createIdentifier(this.config.argsArgName);
        argsType = this.createSchemaTypeRef(type.name + capitalize(field.name) + this.config.argsTypeSuffix);
      } else {
        argsId = ts.createIdentifier(this.config.unusedArgPrefix + this.config.argsArgName);
        argsType = ts.createTypeLiteralNode(undefined);
      }
      const contextId = ts.createIdentifier(this.config.contextArgName);
      const infoId = ts.createIdentifier(this.config.infoArgName);
      const params = [
        this.createSimpleParameter(parentId, parentType),
        this.createSimpleParameter(argsId, argsType),
        this.createSimpleParameter(contextId, this.contextType),
        this.createSimpleParameter(infoId, ts.createTypeReferenceNode(infoTypeId, undefined))
      ];
      const returnType = ts.createTypeReferenceNode(PromiseType, [await this.getFieldReturnType(field.type)]);
      let statements: ts.Statement[] = [];
      const fieldType = getNamedType(field.type);
      if (this.analyzer.isConnectionType(fieldType)) {
        const nodeType = this.analyzer.getNodeTypeForConnection(fieldType as GraphQLObjectType);
        if (isObjectType(nodeType) || isInterfaceType(nodeType)) {
          const tableMapping = this.sqlMappings.getIdentityTableForType(nodeType);
          if (tableMapping) {
            statements = this.buildConnectionResolver(module, tableMapping, {
              argsId,
              contextId,
              infoId,
              visitorsId,
              returnType
            });
          } else {
            console.log(`TODO: No table mapping for node type ${nodeType.name}`);
          }
        } else {
          console.log(`TODO: Unhandled node type ${fieldType.name}`);
        }
      } else if (isObjectType(fieldType) || isInterfaceType(fieldType)) {
        const tableMapping = this.sqlMappings.getIdentityTableForType(fieldType);
        if (tableMapping) {
          statements = this.buildLookupResolver(module, field, tableMapping, { argsId, contextId, infoId, visitorsId });
        } else {
          console.log(`TODO: No table mapping for ${fieldType.name}`);
        }
      } else {
        console.log(`TODO: Unhandled type ${fieldType.name}`);
      }
      if (statements.length === 0) {
        statements.push(
          ts.createThrow(
            ts.createNew(ts.createIdentifier('Error'), undefined, [
              ts.createStringLiteral(`TODO: implement resolver for ${type.name}.${field.name}`)
            ])
          )
        );
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
          returnType,
          ts.createBlock(statements, true)
        )
      );
    }
    module.addStatement(ts.createExportDefault(ts.createObjectLiteral(properties, true)));

    await module.write(sourcePath, this.formatter);
  }

  private buildConnectionResolver(
    module: TsModule,
    tableMapping: TypeTable,
    {
      argsId,
      contextId,
      infoId,
      visitorsId,
      returnType
    }: {
      argsId: ts.Identifier;
      contextId: ts.Identifier;
      infoId: ts.Identifier;
      visitorsId: ts.Identifier;
      returnType: ts.TypeNode;
    }
  ): ts.Statement[] {
    const { table, type } = tableMapping;
    const resolverId = ts.createIdentifier('nodeResolver');
    const configBody = [];

    // configure resolver for interface types
    if (isInterfaceType(type)) {
      const configId = module.addNamedImport(
        path.relative(this.config.resolversDir, `${this.config.fieldVisitorsDir}/${type.name}`),
        `configure${type.name}Resolver`
      );
      configBody.push(ts.createExpressionStatement(ts.createCall(configId, undefined, [resolverId!])));
    }

    // order by primary key by default, though it will usual need to be changed
    for (const part of table.primaryKey.parts) {
      configBody.push(
        ts.createExpressionStatement(
          ts.createCall(ts.createPropertyAccess(resolverId, 'addOrderBy'), undefined, [
            ts.createStringLiteral(part.column.name),
            ts.createStringLiteral(table.name)
          ])
        )
      );
    }

    return [
      ts.createReturn(
        ts.createAsExpression(
          ts.createCall(
            ts.createPropertyAccess(
              ts.createCall(
                ts.createPropertyAccess(
                  ts.createCall(
                    ts.createPropertyAccess(
                      ts.createPropertyAccess(contextId, this.config.contextResolverFactory),
                      'createConnection'
                    ),
                    undefined,
                    [ts.createStringLiteral(table.name), argsId]
                  ),
                  'walk'
                ),
                undefined,
                [infoId, visitorsId, this.createArrowFunction([this.createSimpleParameter(resolverId)], configBody)]
              ),
              'execute'
            ),
            undefined,
            []
          ),
          returnType
        )
      )
    ];
  }

  private buildLookupResolver(
    module: TsModule,
    field: FieldType,
    tableMapping: TypeTable,
    {
      argsId,
      contextId,
      infoId,
      visitorsId
    }: { argsId: ts.Identifier; contextId: ts.Identifier; infoId: ts.Identifier; visitorsId: ts.Identifier }
  ): ts.Statement[] {
    const { table, type } = tableMapping;
    const resolverId = ts.createIdentifier('resolver');
    const configBody = [];

    // configure resolver for interface types
    if (isInterfaceType(type)) {
      const configId = module.addNamedImport(
        path.relative(this.config.resolversDir, `${this.config.fieldVisitorsDir}/${type.name}`),
        `configure${type.name}Resolver`
      );
      configBody.push(ts.createExpressionStatement(ts.createCall(configId, undefined, [resolverId!])));
    }

    // add a placeholder for building query based on arguments
    let configExpr = ts.createCall(ts.createPropertyAccess(resolverId, 'getBaseQuery'), undefined, []);
    if ('id' in field.args) {
      configExpr = ts.createCall(ts.createPropertyAccess(configExpr, 'where'), undefined, [
        ts.createStringLiteral('xid'),
        ts.createPropertyAccess(argsId, 'id')
      ]);
    }
    configBody.push(ts.createExpressionStatement(configExpr));

    return [
      ts.createReturn(
        ts.createCall(
          ts.createPropertyAccess(
            ts.createCall(
              ts.createPropertyAccess(
                ts.createCall(
                  ts.createPropertyAccess(
                    ts.createPropertyAccess(contextId, this.config.contextResolverFactory),
                    'createQuery'
                  ),
                  undefined,
                  [ts.createStringLiteral(table.name)]
                ),
                'walk'
              ),
              undefined,
              [infoId, visitorsId, this.createArrowFunction([this.createSimpleParameter(resolverId)], configBody)]
            ),
            'executeLookup'
          ),
          undefined,
          []
        )
      )
    ];
  }

  private async getFieldReturnType(type: GraphQLOutputType): Promise<ts.TypeNode> {
    let returnType: ts.TypeNode;
    const nullableType = getNullableType(type);
    if (isScalarType(nullableType)) {
      returnType = ts.createIndexedAccessTypeNode(
        this.createSchemaTypeRef(ScalarsType),
        ts.createLiteralTypeNode(ts.createStringLiteral(nullableType.name))
      );
    } else if (isEnumType(nullableType)) {
      returnType = this.createSchemaTypeRef(nullableType.name);
    } else if (isObjectType(nullableType)) {
      await this.writeResolver(nullableType);
      returnType = ts.createTypeReferenceNode(PartialType, [this.createSchemaTypeRef(nullableType.name)]);
    } else if (isInterfaceType(nullableType)) {
      await this.writeResolver(nullableType);
      returnType = ts.createTypeReferenceNode(PartialType, [this.createSchemaTypeRef(nullableType.name)]);
    } else if (isUnionType(nullableType)) {
      returnType = this.createSchemaTypeRef(nullableType.name);
    } else if (isListType(nullableType)) {
      returnType = ts.createArrayTypeNode(await this.getFieldReturnType(nullableType.ofType));
    } else {
      throw new Error(`Unrecognized field type: ${type.toString()}`);
    }
    if (!isNonNullType(type)) {
      returnType = ts.createUnionTypeNode([returnType, ts.createKeywordTypeNode(ts.SyntaxKind.NullKeyword)]);
    }
    return returnType;
  }

  private isPayloadType(type: GraphQLObjectType): boolean {
    return type.name.endsWith('Payload') && 'clientMutationId' in type.getFields();
  }

  private generateInterfaceResolver(type: GraphQLInterfaceType): TsModule {
    const module = new TsModule();

    const { schemaTypesModule, schemaTypesNamespace } = this.config;
    if (schemaTypesModule && schemaTypesNamespace) {
      module.addNamespaceImport(schemaTypesModule, schemaTypesNamespace);
    }

    const properties = [
      ts.createMethod(
        undefined,
        undefined,
        undefined,
        '__resolveType',
        undefined,
        undefined,
        [this.createSimpleParameter('obj', this.createSchemaTypeRef(type.name))],
        ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ts.createBlock([ts.createReturn(ts.createStringLiteral('TODO'))], true)
      )
    ];
    module.addStatement(ts.createExportDefault(ts.createObjectLiteral(properties, true)));

    return module;
  }

  private createSchemaTypeRef(name: string | ts.Identifier): ts.TypeReferenceNode {
    let qname: string | ts.EntityName = name;
    const { schemaNamespaceId } = this;
    if (schemaNamespaceId) {
      qname = ts.createQualifiedName(schemaNamespaceId, qname);
    }
    return ts.createTypeReferenceNode(qname, undefined);
  }

  private createSimpleParameter(name: string | ts.BindingName, type?: ts.TypeNode): ts.ParameterDeclaration {
    return ts.createParameter(undefined, undefined, undefined, name, undefined, type);
  }

  private createArrowFunction(parameters: ts.ParameterDeclaration[], statements: ts.Statement[]): ts.ArrowFunction {
    return ts.createArrowFunction(undefined, undefined, parameters, undefined, undefined, ts.createBlock(statements));
  }

  private createIndexModule(resolvers: ResolverInfo[], spread: boolean): TsModule {
    const module = new TsModule();
    const properties = [];
    resolvers.sort((a, b) => compare(a.id, b.id));
    for (const resolver of resolvers) {
      const { id } = resolver;
      const idIdentifier = module.addImport(`./${id}`, id);
      properties.push(
        spread ? ts.createSpreadAssignment(idIdentifier) : ts.createShorthandPropertyAssignment(idIdentifier)
      );
    }
    module.addStatement(ts.createExportDefault(ts.createObjectLiteral(properties, true)));
    return module;
  }

  private getSourcePath(filename: string): string {
    const { baseDir, resolversDir, typescriptExtension } = this.config;
    return path.join(baseDir, resolversDir, `${filename}${typescriptExtension}`);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.substring(1);
}
