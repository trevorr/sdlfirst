import assert from 'assert';
import {
  DirectiveNode,
  getNamedType,
  getNullableType,
  GraphQLInputField,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLSchema,
  IntValueNode,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  StringValueNode
} from 'graphql';
import { pascalCase } from 'pascal-case';
import path from 'path';
import ts from 'typescript';
import { Analyzer, FieldType, isTableType, TableType, TableTypeInfo } from './Analyzer';
import { defaultConfig as defaultPathConfig, defaultConfig as defaultSqlConfig, SqlConfig } from './config/SqlConfig';
import { CLIENT_MUTATION_ID } from './MutationBuilder';
import { isColumns, SqlSchemaMappings, TypeTable } from './SqlSchemaBuilder';
import {
  findFirstDirective,
  getDirectiveArgument,
  getRequiredDirectiveArgument,
  hasDirective,
  hasDirectives
} from './util/ast-util';
import { lcFirst, ucFirst } from './util/case';
import { compare } from './util/compare';
import { mkdir } from './util/fs-util';
import { defaultConfig as defaultFormatterConfig, TsFormatter, TsFormatterConfig } from './util/TsFormatter';
import { TsBlock, TsModule } from './util/TsModule';

const GraphQLJSModule = 'graphql';
const InfoType = 'GraphQLResolveInfo';
const PartialType = 'Partial';
const PromiseType = 'Promise';
const ScalarsType = 'Scalars';

export interface SqlResolverConfig extends SqlConfig, TsFormatterConfig {
  includeRootTypes: boolean;
  splitRootMembers: boolean;
  includeUserTypes: boolean;
  includeInterfaces: boolean;
  gqlsqlNamespace: string;
  gqlsqlModule: string;
  tsfvBinding: string;
  tsfvModule: string;
  id62Binding: string;
  id62Module: string;
  schemaTypesNamespace: string;
  schemaTypesModule: string;
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
  ...defaultSqlConfig,
  ...defaultFormatterConfig,
  usePrettier: true,
  includeRootTypes: true,
  splitRootMembers: true,
  includeUserTypes: false,
  includeInterfaces: false,
  gqlsqlNamespace: 'gqlsql',
  gqlsqlModule: 'gqlsql',
  tsfvBinding: 'tsfv',
  tsfvModule: 'tsfv',
  id62Binding: 'id62',
  id62Module: 'id62',
  schemaTypesNamespace: 'schema',
  schemaTypesModule: path.relative(defaultPathConfig.resolversDir, defaultPathConfig.sdlTypesDir),
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

enum RootType {
  Query = 1,
  Mutation = 2
}

interface ResolverNodes {
  argsId: ts.Identifier;
  contextId: ts.Identifier;
  infoId: ts.Identifier;
  returnType: ts.TypeNode;
}

interface ResolverTransactionNodes extends ResolverNodes {
  trxId: ts.Identifier;
}

export class SqlResolverWriter {
  private readonly config: SqlResolverConfig;
  private readonly resolvedTypes = new Set<GraphQLNamedType>();
  private readonly resolvers: ResolverInfo[] = [];
  private readonly methodResolvers: ResolverInfo[] = [];
  private readonly schemaNamespaceId: ts.Identifier;
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
    this.schemaNamespaceId = ts.createIdentifier(schemaTypesNamespace);

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
      await this.writeResolver(queryType, RootType.Query);
    }
    const mutationType = this.schema.getMutationType();
    if (mutationType != null) {
      await this.writeResolver(mutationType, RootType.Mutation);
    }
    const files = this.resolvers.map(r => r.path).concat(this.methodResolvers.map(r => r.path));
    if (this.resolvers.length > 0) {
      const outputFile = this.getSourcePath('index');
      await this.createIndexModule(this.resolvers, false).write(outputFile, this.formatter);
      files.push(outputFile);
    }
    return files;
  }

  private async writeResolver(type: GraphQLNamedType, rootType?: RootType): Promise<void> {
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

  private async writeObjectResolver(type: GraphQLObjectType, rootType?: RootType): Promise<void> {
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
    rootType: RootType | undefined,
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
      const resolverNodes = {
        argsId,
        contextId,
        infoId,
        returnType
      };

      const block = module.newBlock();
      const fieldType = getNamedType(field.type);
      let inputType;
      let targetTypeInfo;
      if (
        rootType === RootType.Mutation &&
        isObjectType(fieldType) &&
        (inputType = this.getMutationInputType(field)) &&
        (targetTypeInfo = this.getMutationTargetTypeInfo(field))
      ) {
        const targetType = targetTypeInfo.type;
        switch (field.name.substring(0, 6)) {
          case 'create':
            this.destructureInput(block, argsId, inputType);
            this.validateInput(block, inputType, targetType);
            const { idId, identityTableMapping } = this.performInsert(block, resolverNodes, inputType, targetTypeInfo);

            const { configBlock, resolverId, lookupExpr } = this.buildLookupResolver(
              block,
              identityTableMapping,
              resolverNodes
            );
            configBlock.addStatement(
              ts.createExpressionStatement(
                ts.createCall(
                  ts.createPropertyAccess(
                    ts.createCall(ts.createPropertyAccess(resolverId, 'getBaseQuery'), undefined, []),
                    'where'
                  ),
                  undefined,
                  [
                    ts.createCall(ts.createPropertyAccess(resolverId, 'qualifyColumn'), undefined, [
                      ts.createStringLiteral(this.config.internalIdName)
                    ]),
                    idId
                  ]
                )
              )
            );
            const resultName = lcFirst(targetType.name);
            const resultId = block.declareConst(
              resultName,
              undefined,
              ts.createAsExpression(ts.createAwait(lookupExpr), this.createSchemaTypeRef(targetType.name))
            );

            block.addStatement(
              ts.createReturn(
                ts.createObjectLiteral([
                  block.createIdPropertyAssignment(CLIENT_MUTATION_ID, block.findIdentifier(CLIENT_MUTATION_ID)),
                  block.createIdPropertyAssignment(resultName, resultId)
                ])
              )
            );
            break;
          case 'update':
            this.destructureInput(block, argsId, inputType);
            this.ensureModification(block, inputType, targetType);
            this.validateInput(block, inputType, targetType);
            // TODO: perform update(s), obtain internal ID
            // TODO: query result
            block.addStatement(
              ts.createThrow(
                ts.createNew(ts.createIdentifier('Error'), undefined, [
                  ts.createStringLiteral(`TODO: implement resolver for ${type.name}.${field.name}`)
                ])
              )
            );
            break;
          case 'delete':
            this.destructureInput(block, argsId, inputType);
            // TODO: delete object(s), if exist
            // TODO: return mutation ID and deleted flag
            block.addStatement(
              ts.createThrow(
                ts.createNew(ts.createIdentifier('Error'), undefined, [
                  ts.createStringLiteral(`TODO: implement resolver for ${type.name}.${field.name}`)
                ])
              )
            );
            break;
        }
      } else if (this.analyzer.isConnectionType(fieldType)) {
        const nodeType = this.analyzer.getNodeTypeForConnection(fieldType as GraphQLObjectType);
        if (isTableType(nodeType)) {
          const tableMapping = this.sqlMappings.getIdentityTableForType(nodeType);
          if (tableMapping) {
            this.buildConnectionResolver(block, tableMapping, resolverNodes);
          } else {
            console.log(`TODO: No table mapping for node type ${nodeType.name}`);
          }
        } else {
          console.log(`TODO: Unhandled node type ${fieldType.name}`);
        }
      } else if (isTableType(fieldType)) {
        const tableMapping = this.sqlMappings.getIdentityTableForType(fieldType);
        if (tableMapping) {
          const { configBlock, resolverId, lookupExpr } = this.buildLookupResolver(block, tableMapping, resolverNodes);

          // add a placeholder for building query based on arguments
          let configExpr = ts.createCall(ts.createPropertyAccess(resolverId, 'getBaseQuery'), undefined, []);
          if ('id' in field.args) {
            configExpr = ts.createCall(ts.createPropertyAccess(configExpr, 'where'), undefined, [
              ts.createStringLiteral(this.config.randomIdName),
              ts.createPropertyAccess(argsId, 'id')
            ]);
          }
          configBlock.addStatement(ts.createExpressionStatement(configExpr));

          block.addStatement(ts.createReturn(lookupExpr));
        } else {
          console.log(`TODO: No table mapping for ${fieldType.name}`);
        }
      } else {
        console.log(`TODO: Unhandled type ${fieldType.name}`);
      }
      if (block.isEmpty()) {
        block.addStatement(
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
          [ts.createModifier(ts.SyntaxKind.AsyncKeyword)],
          undefined,
          field.name,
          undefined,
          undefined,
          params,
          returnType,
          block.toBlock()
        )
      );
    }
    module.addStatement(ts.createExportDefault(ts.createObjectLiteral(properties, true)));

    await module.write(sourcePath, this.formatter);
  }

  private getMutationInputType(field: FieldType): GraphQLInputObjectType | null {
    if (field.args.length === 1) {
      const [arg] = field.args;
      const argType = getNullableType(arg.type);
      if (arg.name === 'input' && isNonNullType(arg.type) && isInputObjectType(argType)) {
        return argType;
      }
    }
    return null;
  }

  private getMutationTargetTypeInfo(field: FieldType): TableTypeInfo | undefined {
    const typeName = field.name.substring(6); // createFoo -> Foo
    const type = this.schema.getType(typeName);
    if (isTableType(type)) {
      return this.analyzer.getTypeInfo(type);
    }
  }

  private destructureInput(block: TsBlock, argsId: ts.Identifier, inputType: GraphQLInputObjectType): void {
    block.declareConst(
      ts.createObjectBindingPattern(
        Object.values(inputType.getFields()).map(field => {
          let idSuffix;
          if (hasDirectives(field, [this.config.stringIdDirective, this.config.stringIdRefDirective])) {
            idSuffix = this.config.stringIdName;
          } else if (hasDirective(field, this.config.randomIdRefDirective)) {
            idSuffix = this.config.randomIdName;
          }
          if (idSuffix) {
            let binding;
            if (field.name === 'id') {
              binding = idSuffix;
            } else if (field.name.endsWith('Id')) {
              binding = field.name.substring(0, field.name.length - 2) + ucFirst(idSuffix);
            }
            if (binding) {
              return ts.createBindingElement(undefined, field.name, block.createIdentifier(binding, field));
            }
          }
          return block.createBindingElement(field.name, field);
        })
      ),
      undefined,
      ts.createPropertyAccess(argsId, 'input')
    );
  }

  private findTargetField(field: GraphQLInputField, targetType: TableType): FieldType | undefined {
    const targetFields = targetType.getFields();
    let targetField = targetFields[field.name];
    if (!targetField && field.name.endsWith('Id')) {
      targetField = targetFields[field.name.substring(0, field.name.length - 2)];
    }
    return targetField;
  }

  private ensureModification(block: TsBlock, inputType: GraphQLInputObjectType, targetType: TableType): void {
    const gqlsqlId = block.module.addNamespaceImport(this.config.gqlsqlModule, this.config.gqlsqlNamespace);
    block.addStatement(
      ts.createIf(
        ts.createLogicalNot(
          ts.createCall(ts.createPropertyAccess(gqlsqlId, 'hasDefinedElement'), undefined, [
            ts.createArrayLiteral(this.listInputs(block, inputType, targetType))
          ])
        ),
        ts.createBlock([
          ts.createThrow(
            ts.createNew(ts.createIdentifier('Error'), undefined, [
              ts.createStringLiteral('Update must specify at least one field to modify')
            ])
          )
        ])
      )
    );
  }

  private listInputs(
    block: TsBlock,
    inputType: GraphQLInputObjectType,
    targetType: TableType,
    getFieldRef: (field: GraphQLInputField) => ts.Expression = field => block.createIdentifier(field.name, field),
    output: ts.Expression[] = []
  ): ts.Expression[] {
    for (const field of Object.values(inputType.getFields())) {
      const targetField = this.findTargetField(field, targetType);
      if (field.name === CLIENT_MUTATION_ID || (targetField && this.getExternalId(targetField))) continue;
      const fieldType = getNullableType(field.type);
      const fieldRef = getFieldRef(field);
      if (isInputObjectType(fieldType) && targetField) {
        const targetType = getNullableType(targetField.type);
        if (isTableType(targetType)) {
          this.listInputs(
            block,
            fieldType,
            targetType,
            field =>
              ts.createPropertyAccessChain(
                fieldRef,
                ts.createToken(ts.SyntaxKind.QuestionDotToken),
                block.createIdentifier(field.name, field)
              ),
            output
          );
        }
      } else {
        output.push(fieldRef);
      }
    }
    return output;
  }

  private getExternalId(field: GraphQLInputField | FieldType): DirectiveNode | undefined {
    return (
      findFirstDirective(field, this.config.randomIdDirective) ||
      findFirstDirective(field, this.config.stringIdDirective)
    );
  }

  private validateInput(
    block: TsBlock,
    inputType: GraphQLInputObjectType,
    targetType: TableType,
    getFieldRef: (field: GraphQLInputField) => ts.Expression = field => block.createIdentifier(field.name, field)
  ): void {
    const tsfvId = ts.createIdentifier(this.config.tsfvBinding);
    for (const field of Object.values(inputType.getFields())) {
      const fieldType = getNullableType(field.type);
      const optional = !isNonNullType(field.type);
      let expr: ts.Expression = tsfvId;
      if (isScalarType(fieldType)) {
        const targetField = this.findTargetField(field, targetType) || field;
        switch (fieldType.name) {
          case 'ID':
            const sidDir =
              findFirstDirective(field, this.config.stringIdDirective) ||
              findFirstDirective(field, this.config.stringIdRefDirective);
            expr = getRangeValidator(expr, sidDir, 'string', {
              betweenMethod: 'length',
              equalMethod: 'length',
              minMethod: 'minLength',
              maxMethod: 'maxLength',
              maxArgName: 'maxLength',
              defaultMin: '1'
            });
            const ridDir = findFirstDirective(field, this.config.randomIdRefDirective);
            if (ridDir) {
              // rids should be /([A-Z]{1,4}_)?[0-9A-Za-z]{21}/
              // but strict validation isn't necessary due to database lookup
              expr = getRangeValidator(expr, ridDir, 'string', {
                betweenMethod: 'length',
                defaultMin: '21',
                defaultMax: '26'
              });
            }
            break;
          case 'String':
            const lengthDir = findFirstDirective(targetField, this.config.lengthDirective);
            expr = getRangeValidator(expr, lengthDir, 'string', {
              betweenMethod: 'length',
              equalMethod: 'length',
              minMethod: 'minLength',
              maxMethod: 'maxLength',
              defaultMin: '1'
            });
            const regexDir = findFirstDirective(targetField, this.config.regexDirective);
            if (regexDir) {
              const valueArg = getRequiredDirectiveArgument(regexDir, 'value', 'StringValue');
              expr = ts.createCall(ts.createPropertyAccess(expr, 'pattern'), undefined, [
                ts.createRegularExpressionLiteral('/' + (valueArg.value as StringValueNode).value + '/')
              ]);
            }
            break;
          case 'Float':
            const floatRangeDir = findFirstDirective(targetField, this.config.floatRangeDirective);
            expr = getRangeValidator(expr, floatRangeDir, 'number');
            break;
          case 'Int':
            const intRangeDir = findFirstDirective(targetField, this.config.intRangeDirective);
            expr = getRangeValidator(expr, intRangeDir, 'integer');
            break;
        }
        if (expr !== tsfvId) {
          if (optional) {
            expr = ts.createCall(ts.createPropertyAccess(expr, 'optional'), undefined, undefined);
          }
          block.addStatement(
            ts.createExpressionStatement(
              ts.createCall(ts.createPropertyAccess(expr, 'check'), undefined, [
                getFieldRef(field),
                ts.createStringLiteral(field.name)
              ])
            )
          );
        }
      } else if (isInputObjectType(fieldType)) {
        const targetField = this.findTargetField(field, targetType);
        if (targetField) {
          const targetType = getNullableType(targetField.type);
          if (isTableType(targetType)) {
            const fieldRef = getFieldRef(field);
            const targetBlock = optional ? block.newBlock() : block;
            this.validateInput(targetBlock, fieldType, targetType, field =>
              ts.createPropertyAccess(fieldRef, block.createIdentifier(field.name, field))
            );
            if (optional) {
              block.addStatement(ts.createIf(fieldRef, targetBlock.toBlock()));
            }
          }
        }
      }
    }
    if (!block.isEmpty()) {
      block.module.addImport(this.config.tsfvModule, this.config.tsfvBinding);
    }
  }

  private performInsert(
    block: TsBlock,
    resolverNodes: ResolverNodes,
    inputType: GraphQLInputObjectType,
    targetTypeInfo: TableTypeInfo
  ): { idId: ts.Identifier; identityTableMapping: TypeTable } {
    const { identityTypeInfo = targetTypeInfo } = targetTypeInfo;
    const identityTableMapping = this.sqlMappings.getIdentityTableForType(identityTypeInfo.type);
    if (!identityTableMapping) {
      throw new Error(`No table mapping for type "${targetTypeInfo.type.name}"`);
    }

    let ridId;
    if (targetTypeInfo.externalIdDirective?.name.value === this.config.randomIdDirective) {
      ridId = block.declareConst(
        this.config.randomIdName,
        undefined,
        ts.createCall(block.module.addImport(this.config.id62Module, this.config.id62Binding), undefined, undefined)
      );
    }

    const trxId = block.module.createIdentifier('trx');
    const trxBlock = block.newBlock();
    const trxNodes = { ...resolverNodes, trxId };

    const insertProps: ts.ObjectLiteralElementLike[] = [];
    if (ridId) {
      insertProps.push(block.createIdPropertyAssignment(this.config.randomIdName, ridId));
    }
    const { typeDiscriminatorField } = identityTypeInfo;
    if (typeDiscriminatorField) {
      const fieldMapping = identityTableMapping.fieldMappings.get(typeDiscriminatorField);
      if (fieldMapping && isColumns(fieldMapping)) {
        const enumsId = this.getEnumsImport(block.module);
        const enumName = getNamedType(typeDiscriminatorField.type).name;
        const enumValue = ts.createPropertyAccess(
          ts.createPropertyAccess(this.schemaNamespaceId, enumName),
          targetTypeInfo.type.name
        );
        const enumToSqlName = `${pascalCase(enumName)}ToSql`;
        const sqlValue = ts.createCall(
          ts.createPropertyAccess(ts.createPropertyAccess(enumsId, enumToSqlName), 'get'),
          undefined,
          [enumValue]
        );
        insertProps.push(ts.createPropertyAssignment(fieldMapping.columns[0].name, sqlValue));
      }
    }
    insertProps.push(...this.getInsertProps(trxBlock, trxNodes, inputType, identityTableMapping));
    const queryExpr = this.getInsertExpression(trxId, identityTableMapping.table.name, insertProps);
    const idId = trxBlock.declareConst(
      this.config.internalIdName,
      undefined,
      ts.createElementAccess(this.getExecuteExpression(resolverNodes.contextId, queryExpr), 0)
    );

    const targetTableMapping = this.sqlMappings.getIdentityTableForType(targetTypeInfo.type);
    if (targetTableMapping && targetTypeInfo !== identityTypeInfo) {
      const insertProps: ts.ObjectLiteralElementLike[] = [];
      const keyParts = targetTableMapping.table.primaryKey.parts;
      assert(keyParts.length === 1);
      insertProps.push(ts.createPropertyAssignment(keyParts[0].column.name, idId));
      insertProps.push(...this.getInsertProps(trxBlock, trxNodes, inputType, targetTableMapping));
      const queryExpr = this.getInsertExpression(trxId, targetTableMapping.table.name, insertProps);
      trxBlock.addStatement(
        ts.createExpressionStatement(this.getExecuteExpression(resolverNodes.contextId, queryExpr))
      );
    }

    // TODO: insert nested objects into joined tables

    trxBlock.addStatement(ts.createReturn(idId));

    const trxExpr = ts.createAwait(
      ts.createCall(
        ts.createPropertyAccess(ts.createPropertyAccess(resolverNodes.contextId, 'knex'), 'transaction'),
        undefined,
        [
          ts.createArrowFunction(
            [ts.createModifier(ts.SyntaxKind.AsyncKeyword)],
            undefined,
            [ts.createParameter(undefined, undefined, undefined, trxId)],
            undefined,
            undefined,
            trxBlock.toBlock()
          )
        ]
      )
    );

    return { idId: block.declareConst(this.config.internalIdName, undefined, trxExpr), identityTableMapping };
  }

  private getInsertExpression(trx: ts.Expression, table: string, props: ts.ObjectLiteralElementLike[]): ts.Expression {
    return ts.createCall(
      ts.createPropertyAccess(ts.createCall(trx, undefined, [ts.createStringLiteral(table)]), 'insert'),
      undefined,
      [ts.createObjectLiteral(props, true)]
    );
  }

  private getExecuteExpression(context: ts.Expression, queryExpr: ts.Expression): ts.Expression {
    return ts.createAwait(
      ts.createCall(ts.createPropertyAccess(ts.createPropertyAccess(context, 'sqlExecutor'), 'execute'), undefined, [
        queryExpr
      ])
    );
  }

  private getInsertProps(
    block: TsBlock,
    trxNodes: ResolverTransactionNodes,
    inputType: GraphQLInputObjectType,
    tableMapping: TypeTable
  ): ts.ObjectLiteralElementLike[] {
    const result = [];
    for (const field of Object.values(inputType.getFields())) {
      const targetField = this.findTargetField(field, tableMapping.type);
      if (targetField) {
        const fieldMapping = tableMapping.fieldMappings.get(targetField);
        if (fieldMapping && isColumns(fieldMapping)) {
          if (fieldMapping.columns.length === 1) {
            const inputId = block.findIdentifierFor(field);
            if (inputId) {
              const { name } = fieldMapping.columns[0];
              const fieldType = getNullableType(field.type);
              if (isEnumType(fieldType)) {
                let expr: ts.Expression = inputId;
                let nullable = false;
                if (!isNonNullType(field.type)) {
                  const defaultDir = findFirstDirective(targetField, this.config.defaultDirective);
                  if (defaultDir) {
                    const def = getRequiredDirectiveArgument(defaultDir, 'value', 'StringValue');
                    const enumValue = pascalCase((def.value as StringValueNode).value);
                    const enumValueExpr = ts.createPropertyAccess(
                      ts.createPropertyAccess(this.schemaNamespaceId, field.type.name),
                      enumValue
                    );
                    expr = ts.createNullishCoalesce(inputId, enumValueExpr);
                  } else {
                    nullable = true;
                  }
                }
                const enumsId = this.getEnumsImport(block.module);
                const enumName = `${pascalCase(fieldType.name)}ToSql`;
                expr = ts.createCall(
                  ts.createPropertyAccess(ts.createPropertyAccess(enumsId, enumName), 'get'),
                  undefined,
                  [expr]
                );
                if (nullable) {
                  expr = ts.createLogicalAnd(inputId, expr);
                }
                result.push(ts.createPropertyAssignment(name, expr));
              } else {
                const refDir =
                  findFirstDirective(field, this.config.randomIdRefDirective) ||
                  findFirstDirective(field, this.config.stringIdRefDirective);
                if (refDir) {
                  result.push(
                    ts.createPropertyAssignment(name, this.resolveXidRef(inputId, field, refDir, block, trxNodes))
                  );
                } else {
                  result.push(block.createIdPropertyAssignment(name, inputId));
                }
              }
            }
          } else {
            // TODO: handle kind/ID union references
          }
        }
      }
    }
    return result;
  }

  private resolveXidRef(
    inputId: ts.Identifier,
    field: GraphQLInputField,
    dir: DirectiveNode,
    block: TsBlock,
    trxNodes: ResolverTransactionNodes
  ): ts.Expression {
    const type = (getRequiredDirectiveArgument(dir, 'type', 'StringValue').value as StringValueNode).value;
    // await context.getIdForXid(someXid, dbmeta.Type, trx);
    let expr: ts.Expression = ts.createAwait(
      ts.createCall(ts.createPropertyAccess(trxNodes.contextId, 'getIdForXid'), undefined, [
        inputId,
        ts.createPropertyAccess(this.getMetaImport(block.module), type),
        trxNodes.trxId
      ])
    );
    if (!isNonNullType(field.type)) {
      // someXid && await ...
      expr = ts.createLogicalAnd(inputId, expr);
    }
    // const someId = someXid && await ...
    return block.declareConst(field.name, undefined, expr);
  }

  private getMetaImport(module: TsModule): ts.Identifier {
    return module.addImport(path.relative(this.config.resolversDir, this.config.databaseMetadataDir), 'dbmeta');
  }

  private getEnumsImport(module: TsModule): ts.Identifier {
    return module.addNamespaceImport(path.relative(this.config.resolversDir, this.config.enumMappingsDir), 'enums');
  }

  private buildConnectionResolver(
    block: TsBlock,
    tableMapping: TypeTable,
    { argsId, contextId, infoId, returnType }: ResolverNodes
  ): void {
    const { table, type } = tableMapping;
    const configBlock = block.newBlock();
    const resolverId = configBlock.createIdentifier('nodeResolver');

    // configure resolver for interface types
    if (isInterfaceType(type)) {
      const configId = block.module.addNamedImport(
        path.relative(this.config.resolversDir, `${this.config.fieldVisitorsDir}/${type.name}`),
        `configure${type.name}Resolver`
      );
      configBlock.addStatement(ts.createExpressionStatement(ts.createCall(configId, undefined, [resolverId!])));
    }

    // order by primary key by default, though it will usual need to be changed
    for (const part of table.primaryKey.parts) {
      configBlock.addStatement(
        ts.createExpressionStatement(
          ts.createCall(ts.createPropertyAccess(resolverId, 'addOrderBy'), undefined, [
            ts.createStringLiteral(part.column.name),
            ts.createStringLiteral(table.name)
          ])
        )
      );
    }

    block.addStatement(
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
                [infoId, this.createArrowFunction([this.createSimpleParameter(resolverId)], configBlock.toBlock())]
              ),
              'execute'
            ),
            undefined,
            []
          ),
          returnType
        )
      )
    );
  }

  private buildLookupResolver(
    block: TsBlock,
    tableMapping: TypeTable,
    { contextId, infoId }: ResolverNodes
  ): { configBlock: TsBlock; resolverId: ts.Identifier; lookupExpr: ts.Expression } {
    const { table, type } = tableMapping;
    const configBlock = block.newBlock();
    const resolverId = configBlock.createIdentifier('resolver');

    // configure resolver for interface types
    if (isInterfaceType(type)) {
      const configId = block.module.addNamedImport(
        path.relative(this.config.resolversDir, `${this.config.fieldVisitorsDir}/${type.name}`),
        `configure${type.name}Resolver`
      );
      configBlock.addStatement(ts.createExpressionStatement(ts.createCall(configId, undefined, [resolverId!])));
    }

    const lookupExpr = ts.createCall(
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
          [infoId, this.createArrowFunction([this.createSimpleParameter(resolverId)], configBlock.toBlock())]
        ),
        'executeLookup'
      ),
      undefined,
      []
    );

    return { configBlock, resolverId, lookupExpr };
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
    qname = ts.createQualifiedName(this.schemaNamespaceId, qname);
    return ts.createTypeReferenceNode(qname, undefined);
  }

  private createSimpleParameter(name: string | ts.BindingName, type?: ts.TypeNode): ts.ParameterDeclaration {
    return ts.createParameter(undefined, undefined, undefined, name, undefined, type);
  }

  private createArrowFunction(parameters: ts.ParameterDeclaration[], body: ts.ConciseBody): ts.ArrowFunction {
    return ts.createArrowFunction(undefined, undefined, parameters, undefined, undefined, body);
  }

  private createIndexModule(resolvers: ResolverInfo[], spread: boolean): TsModule {
    const module = new TsModule();
    const properties = [];
    resolvers.sort((a, b) => compare(a.id, b.id));
    for (const resolver of resolvers) {
      const { id } = resolver;
      const idIdentifier = module.addImport(`./${id}`, id);
      properties.push(
        spread ? ts.createSpreadAssignment(idIdentifier) : module.createIdPropertyAssignment(id, idIdentifier)
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

interface RangeValidatorOptions {
  betweenMethod: string;
  equalMethod?: string;
  minMethod: string;
  maxMethod: string;
  minArgName: string;
  maxArgName: string;
  defaultMin?: string;
  defaultMax?: string;
}

const defaultRangeValidatorOptions: RangeValidatorOptions = {
  betweenMethod: 'between',
  minMethod: 'greaterThanOrEqual',
  maxMethod: 'lessThanOrEqual',
  minArgName: 'min',
  maxArgName: 'max'
};

function getRangeValidator(
  expr: ts.Expression,
  directive: DirectiveNode | undefined,
  typeMethod: string,
  options?: Partial<RangeValidatorOptions>
): ts.Expression {
  const opts = Object.assign({}, defaultRangeValidatorOptions, options);
  if (directive) {
    let min = opts.defaultMin;
    let max = opts.defaultMax;
    const minArg = getDirectiveArgument(directive, opts.minArgName);
    if (minArg) {
      min = (minArg.value as IntValueNode).value;
    }
    const maxArg = getDirectiveArgument(directive, opts.maxArgName);
    if (maxArg) {
      max = (maxArg.value as IntValueNode).value;
    }
    let method, params;
    if (min != null) {
      if (max != null) {
        if (min === max && opts.equalMethod) {
          method = opts.equalMethod;
          params = [min];
        } else {
          method = opts.betweenMethod;
          params = [min, max];
        }
      } else {
        method = opts.minMethod;
        params = [min];
      }
    } else if (max != null) {
      method = opts.maxMethod;
      params = [max];
    }
    if (method && params) {
      expr = ts.createCall(
        ts.createPropertyAccess(ts.createCall(ts.createPropertyAccess(expr, typeMethod), undefined, undefined), method),
        undefined,
        params.map(v => ts.createNumericLiteral(v))
      );
    }
  }
  return expr;
}
