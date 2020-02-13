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
  StringValueNode,
  isCompositeType
} from 'graphql';
import { pascalCase } from 'pascal-case';
import path from 'path';
import ts from 'typescript';
import { Analyzer, FieldType, isTableType, TableType, TableTypeInfo, TypeInfo } from './Analyzer';
import { defaultConfig as defaultPathConfig, defaultConfig as defaultSqlConfig, SqlConfig } from './config/SqlConfig';
import { CLIENT_MUTATION_ID, DELETED_FLAG } from './MutationBuilder';
import { isColumns, SqlSchemaMappings, TypeTable, FieldColumns } from './SqlSchemaBuilder';
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
import { SqlColumn } from './model/SqlColumn';

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

type ExprWrapper = (expr: ts.Expression) => ts.Expression;

interface InputFieldMapping {
  inputField: GraphQLInputField;
  targetField: FieldType;
  columnMapping: FieldColumns;
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
        const id = addNamePrefix(type.name, field.name);
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
        argsType = this.createSchemaTypeRef(addNamePrefix(type.name, field.name + this.config.argsTypeSuffix));
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
        switch (field.name.substring(0, 6)) {
          case 'create':
            this.createMutation(block, resolverNodes, inputType, targetTypeInfo);
            break;
          case 'update':
            this.updateMutation(block, resolverNodes, inputType, targetTypeInfo);
            break;
          case 'delete':
            this.deleteMutation(block, resolverNodes, inputType, targetTypeInfo);
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
          const configStmt = ts.createExpressionStatement(
            ts.createCall(ts.createPropertyAccess(resolverId, 'getBaseQuery'), undefined, [])
          );
          ts.addSyntheticLeadingComment(
            configStmt,
            ts.SyntaxKind.SingleLineCommentTrivia,
            'TODO: build query based on arguments',
            true
          );
          configBlock.addStatement(configStmt);

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

  private createMutation(
    block: TsBlock,
    resolverNodes: ResolverNodes,
    inputType: GraphQLInputObjectType,
    targetTypeInfo: TableTypeInfo
  ): void {
    const targetType = targetTypeInfo.type;
    this.destructureInput(block, resolverNodes.argsId, inputType);
    this.validateInput(block, inputType, targetType);
    const { idExprs, identityTableMapping } = this.performInsert(block, resolverNodes, inputType, targetTypeInfo);
    this.returnUpsertQuery(block, resolverNodes, identityTableMapping, targetType, idExprs);
  }

  private updateMutation(
    block: TsBlock,
    resolverNodes: ResolverNodes,
    inputType: GraphQLInputObjectType,
    targetTypeInfo: TableTypeInfo
  ): void {
    const targetType = targetTypeInfo.type;
    this.destructureInput(block, resolverNodes.argsId, inputType);
    this.ensureModification(block, inputType, targetType);
    this.validateInput(block, inputType, targetType);
    const { idExprs, identityTableMapping } = this.performUpdate(block, resolverNodes, inputType, targetTypeInfo);
    this.returnUpsertQuery(block, resolverNodes, identityTableMapping, targetType, idExprs);
  }

  private returnUpsertQuery(
    block: TsBlock,
    resolverNodes: ResolverNodes,
    identityTableMapping: TypeTable,
    targetType: TableType,
    idExprs: ts.Expression[]
  ): void {
    const { configBlock, resolverId, lookupExpr } = this.buildLookupResolver(
      block,
      identityTableMapping,
      resolverNodes
    );
    configBlock.addStatement(
      ts.createExpressionStatement(
        this.getWhereExpression(
          identityTableMapping,
          ts.createCall(ts.createPropertyAccess(resolverId, 'getBaseQuery'), undefined, []),
          idExprs,
          resolverId
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
  }

  private deleteMutation(
    block: TsBlock,
    resolverNodes: ResolverNodes,
    inputType: GraphQLInputObjectType,
    targetTypeInfo: TableTypeInfo
  ): void {
    const { identityTypeInfo = targetTypeInfo } = targetTypeInfo;
    const identityTableMapping = this.sqlMappings.getIdentityTableForType(identityTypeInfo.type);
    if (!identityTableMapping) {
      throw new Error(`No table mapping for type "${targetTypeInfo.type.name}"`);
    }

    // const { clientMutationId, id: rid } = args.input
    this.destructureInput(block, resolverNodes.argsId, inputType);

    const trxId = block.module.createIdentifier('trx');
    const trxBlock = block.newBlock();
    const trxNodes = { ...resolverNodes, trxId };

    // const id = await context.forXid(?, dbmeta.?, trx).configure(...).lookupId()
    const { idExprs, softDeleteColumn, softDeleteWhereWrapper, softDeleteValueExpr } = this.buildIdLookups(
      trxBlock,
      trxNodes,
      inputType,
      targetTypeInfo,
      identityTypeInfo,
      identityTableMapping,
      false
    );

    // if (id == null || ...) return false
    trxBlock.addStatement(
      ts.createIf(
        idExprs.reduce(
          (expr, idExpr) => ts.createBinary(expr, ts.SyntaxKind.BarBarToken, this.eqEqNull(idExpr)),
          this.eqEqNull(idExprs[0])
        ),
        ts.createReturn(ts.createFalse())
      )
    );

    // delete identity row
    let deleteExpr = this.getWhereExpression(identityTableMapping, trxId, idExprs);
    if (softDeleteWhereWrapper) {
      deleteExpr = softDeleteWhereWrapper(deleteExpr);
    }
    if (softDeleteColumn && softDeleteValueExpr) {
      deleteExpr = ts.createCall(ts.createPropertyAccess(deleteExpr, 'update'), undefined, [
        ts.createObjectLiteral([ts.createPropertyAssignment(softDeleteColumn, softDeleteValueExpr)])
      ]);
    } else {
      deleteExpr = ts.createCall(ts.createPropertyAccess(deleteExpr, 'del'), undefined, undefined);
    }
    deleteExpr = this.getExecuteExpression(resolverNodes.contextId, deleteExpr);
    let resultExpr;
    if (softDeleteWhereWrapper) {
      resultExpr = trxBlock.declareConst(
        'deleted',
        undefined,
        ts.createBinary(deleteExpr, ts.SyntaxKind.GreaterThanToken, ts.createNumericLiteral('0'))
      );
    } else {
      trxBlock.addStatement(ts.createExpressionStatement(deleteExpr));
      resultExpr = ts.createTrue();
    }

    // TODO: cascade delete

    // return true
    trxBlock.addStatement(ts.createReturn(resultExpr));

    // const deleted = await context.knex.transaction(async trx => { <trxBlock> })
    const deletedId = block.declareConst(
      DELETED_FLAG,
      undefined,
      ts.createAwait(
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
      )
    );

    // return { clientMutationId, deleted }
    block.addStatement(
      ts.createReturn(
        ts.createObjectLiteral([
          block.createIdPropertyAssignment(CLIENT_MUTATION_ID, block.findIdentifier(CLIENT_MUTATION_ID)),
          block.createIdPropertyAssignment(DELETED_FLAG, deletedId)
        ])
      )
    );
  }

  private eqEqNull(expr: ts.Expression): ts.Expression {
    return ts.createBinary(expr, ts.SyntaxKind.EqualsEqualsToken, ts.createNull());
  }

  private destructureInput(block: TsBlock, argsId: ts.Identifier, inputType: GraphQLInputObjectType): void {
    block.declareConst(
      ts.createObjectBindingPattern(
        Object.values(inputType.getFields()).map(field => {
          let idSuffix;
          // TODO: Qid suffix
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
              binding = addNamePrefix(field.name.substring(0, field.name.length - 2), idSuffix);
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

  private buildIdLookups(
    block: TsBlock,
    resolverNodes: ResolverTransactionNodes,
    inputType: GraphQLInputObjectType,
    targetTypeInfo: TableTypeInfo,
    identityTypeInfo: TableTypeInfo,
    identityTableMapping: TypeTable,
    required: boolean,
    namePrefix?: string
  ): {
    idExprs: ts.Identifier[];
    softDeleteColumn?: string;
    softDeleteWhereWrapper?: ExprWrapper;
    softDeleteValueExpr?: ts.Expression;
  } {
    const result = this.buildNestedIdLookups(
      block,
      resolverNodes,
      inputType,
      targetTypeInfo,
      identityTypeInfo,
      identityTableMapping,
      required,
      namePrefix
    );
    if (identityTypeInfo.softDeleteField && !result.softDeleteColumn) {
      Object.assign(
        result,
        this.getSoftDeleteInfo(identityTypeInfo.softDeleteField, identityTableMapping, resolverNodes)
      );
    }
    return result;
  }

  private buildNestedIdLookups(
    block: TsBlock,
    resolverNodes: ResolverTransactionNodes,
    inputType: GraphQLInputObjectType,
    targetTypeInfo: TypeInfo,
    identityTypeInfo: TableTypeInfo,
    identityTableMapping: TypeTable,
    required: boolean,
    namePrefix?: string
  ): {
    idExprs: ts.Identifier[];
    softDeleteColumn?: string;
    softDeleteValueExpr?: ts.Expression;
  } {
    if (identityTypeInfo.externalIdField) {
      const { idExpr, softDeleteColumn, softDeleteValueExpr } = this.buildXidLookup(
        block,
        resolverNodes,
        inputType,
        targetTypeInfo,
        identityTypeInfo,
        identityTableMapping,
        required,
        namePrefix
      );
      return { idExprs: [idExpr], softDeleteColumn, softDeleteValueExpr };
    }

    const idExprs: ts.Identifier[] = [];
    for (const field of identityTypeInfo.internalIdFields!) {
      const fieldName = addNamePrefix(namePrefix, field.name);
      const fieldType = getNullableType(field.type);
      if (isScalarType(fieldType) || isEnumType(fieldType)) {
        const inputField = inputType.getFields()[fieldName];
        const inputId = block.findIdentifierFor(inputField);
        if (!inputId) {
          throw new Error(`Identifier not found for field "${identityTypeInfo.type.name}.${inputField.name}"`);
        }
        idExprs.push(inputId);
      } else if (isCompositeType(fieldType)) {
        const nestedTargetTypeInfo = this.analyzer.getTypeInfo(fieldType);
        let nestedIdentityTypeInfo: TableTypeInfo;
        if (nestedTargetTypeInfo.identityTypeInfo) {
          nestedIdentityTypeInfo = nestedTargetTypeInfo.identityTypeInfo;
        } else if (isTableType(nestedTargetTypeInfo.type)) {
          nestedIdentityTypeInfo = nestedTargetTypeInfo as TableTypeInfo;
        } else {
          throw new Error(`Unexpected type for ID field ${identityTypeInfo.type.name}.${field.name}`);
        }
        const nestedIdentityTableMapping = this.sqlMappings.getIdentityTableForType(nestedIdentityTypeInfo.type);
        if (!nestedIdentityTableMapping) {
          throw new Error(`No table mapping for type "${nestedIdentityTypeInfo.type.name}"`);
        }

        const { idExprs: nestedIdExprs } = this.buildNestedIdLookups(
          block,
          resolverNodes,
          inputType,
          nestedTargetTypeInfo,
          nestedIdentityTypeInfo,
          nestedIdentityTableMapping,
          required,
          fieldName
        );
        idExprs.push(...nestedIdExprs);
      } else {
        throw new Error(`Unexpected type for ID field ${identityTypeInfo.type.name}.${field.name}`);
      }
    }
    return { idExprs };
  }

  private buildXidLookup(
    block: TsBlock,
    resolverNodes: ResolverTransactionNodes,
    inputType: GraphQLInputObjectType,
    targetTypeInfo: TypeInfo,
    identityTypeInfo: TableTypeInfo,
    identityTableMapping: TypeTable,
    required: boolean,
    namePrefix?: string
  ): {
    idExpr: ts.Identifier;
    softDeleteColumn?: string;
    softDeleteValueExpr?: ts.Expression;
  } {
    // context.forXid(?, dbmeta.?, trx).configure(...)
    const targetType = targetTypeInfo.type;
    const idField = identityTypeInfo.externalIdField;
    if (!idField) {
      throw new Error(`No external ID for delete mutation of ${targetType.name}`);
    }
    const idInputField = inputType.getFields()[addNamePrefix(namePrefix, idField.name)];
    if (!idInputField) {
      throw new Error(`ID field "${idField.name}" not found in type "${inputType.name}"`);
    }
    const inputId = block.findIdentifierFor(idInputField);
    if (!inputId) {
      throw new Error(`Identifier not found for ID field "${inputType.name}.${idInputField.name}"`);
    }
    let builderExpr: ts.Expression = ts.createCall(
      ts.createPropertyAccess(resolverNodes.contextId, 'forXid'),
      undefined,
      [inputId, ts.createPropertyAccess(this.getMetaImport(block.module), targetType.name), resolverNodes.trxId]
    );
    const { typeDiscriminatorField, softDeleteField } = identityTypeInfo;
    let softDeleteColumn, softDeleteValueExpr;
    if (typeDiscriminatorField || softDeleteField) {
      const configBlock = block.newBlock();
      const queryId = configBlock.createIdentifier('query');
      let configExpr: ts.Expression = queryId;
      if (typeDiscriminatorField) {
        // query.where('?', enums.?TypeToSql.get(schema.?Type.?))
        const cv = this.getTypeDiscriminatorColumnAndValue(
          typeDiscriminatorField,
          targetTypeInfo.type,
          identityTableMapping,
          block.module
        );
        configExpr = ts.createCall(ts.createPropertyAccess(configExpr, 'where'), undefined, [
          ts.createStringLiteral(cv[0]),
          cv[1]
        ]);
      }
      if (softDeleteField) {
        let softDeleteWhereWrapper;
        ({ softDeleteColumn, softDeleteWhereWrapper, softDeleteValueExpr } = this.getSoftDeleteInfo(
          softDeleteField,
          identityTableMapping,
          resolverNodes
        ));
        configExpr = softDeleteWhereWrapper(configExpr);
      }
      builderExpr = ts.createCall(ts.createPropertyAccess(builderExpr, 'configure'), undefined, [
        ts.createArrowFunction(
          undefined,
          undefined,
          [ts.createParameter(undefined, undefined, undefined, queryId)],
          undefined,
          undefined,
          configExpr
        )
      ]);
    }

    // await context.forXid(?, dbmeta.?, trx).configure(...).getId()
    const lookupExpr = ts.createAwait(
      ts.createCall(ts.createPropertyAccess(builderExpr, required ? 'getId' : 'lookupId'), undefined, undefined)
    );

    const name = addNamePrefix(namePrefix, this.config.internalIdName);
    const idExpr = block.declareConst(name, undefined, lookupExpr);
    return { idExpr, softDeleteColumn, softDeleteValueExpr };
  }

  private performInsert(
    block: TsBlock,
    resolverNodes: ResolverNodes,
    inputType: GraphQLInputObjectType,
    targetTypeInfo: TableTypeInfo
  ): { idExprs: ts.Identifier[]; identityTableMapping: TypeTable } {
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
      insertProps.push(
        ts.createPropertyAssignment(
          ...this.getTypeDiscriminatorColumnAndValue(
            typeDiscriminatorField,
            targetTypeInfo.type,
            identityTableMapping,
            block.module
          )
        )
      );
    }
    const inputMappings = this.getInputFieldMappings(inputType, identityTableMapping);
    insertProps.push(...this.getUpsertProps(trxBlock, trxNodes, inputMappings));
    const queryExpr = this.getInsertExpression(trxId, identityTableMapping.table.name, insertProps);
    const execExpr = this.getExecuteExpression(resolverNodes.contextId, queryExpr);

    let idExprs: ts.Identifier[];
    const hasAutoincId =
      identityTypeInfo.externalIdField != null ||
      (identityTypeInfo.internalIdFields?.length === 1 &&
        identityTypeInfo.internalIdFields[0] === identityTypeInfo.autoincField);
    if (hasAutoincId) {
      idExprs = [trxBlock.declareConst(this.config.internalIdName, undefined, ts.createElementAccess(execExpr, 0))];
    } else {
      trxBlock.addStatement(ts.createExpressionStatement(execExpr));
      idExprs = inputMappings
        .filter(m => this.isIdField(identityTypeInfo, m.targetField))
        .flatMap(m => {
          const ids = m.columnMapping.columns.map(c => trxBlock.findIdentifierFor(c));
          if (ids.every(id => id != null)) return ids as ts.Identifier[];
          const id = trxBlock.findIdentifierFor(m.inputField);
          if (!id) {
            throw new Error(`Identifier not found for field "${identityTypeInfo.type.name}.${m.inputField.name}"`);
          }
          return id;
        });
    }

    const targetTableMapping = this.sqlMappings.getIdentityTableForType(targetTypeInfo.type);
    if (targetTableMapping && targetTypeInfo !== identityTypeInfo) {
      const insertProps: ts.ObjectLiteralElementLike[] = [];
      const keyParts = targetTableMapping.table.primaryKey.parts;
      if (keyParts.length !== idExprs.length) {
        console.log(identityTypeInfo, keyParts, idExprs);
      }
      assert(keyParts.length === idExprs.length);
      insertProps.push(
        ...keyParts.map((keyPart, index) => ts.createPropertyAssignment(keyPart.column.name, idExprs[index]))
      );
      const inputMappings = this.getInputFieldMappings(inputType, targetTableMapping);
      insertProps.push(...this.getUpsertProps(trxBlock, trxNodes, inputMappings));
      const queryExpr = this.getInsertExpression(trxId, targetTableMapping.table.name, insertProps);
      const execExpr = this.getExecuteExpression(resolverNodes.contextId, queryExpr);
      trxBlock.addStatement(ts.createExpressionStatement(execExpr));
    }

    // TODO: insert nested objects into joined tables

    return { idExprs: this.getOuterBlockIds(block, trxBlock, trxNodes, idExprs), identityTableMapping };
  }

  private getInsertExpression(trx: ts.Expression, table: string, props: ts.ObjectLiteralElementLike[]): ts.Expression {
    return ts.createCall(
      ts.createPropertyAccess(ts.createCall(trx, undefined, [ts.createStringLiteral(table)]), 'insert'),
      undefined,
      [ts.createObjectLiteral(props, true)]
    );
  }

  private performUpdate(
    block: TsBlock,
    resolverNodes: ResolverNodes,
    inputType: GraphQLInputObjectType,
    targetTypeInfo: TableTypeInfo
  ): { idExprs: ts.Identifier[]; identityTableMapping: TypeTable } {
    const { identityTypeInfo = targetTypeInfo } = targetTypeInfo;
    const identityTableMapping = this.sqlMappings.getIdentityTableForType(identityTypeInfo.type);
    if (!identityTableMapping) {
      throw new Error(`No table mapping for type "${targetTypeInfo.type.name}"`);
    }

    const trxId = block.module.createIdentifier('trx');
    const trxBlock = block.newBlock();
    const trxNodes = { ...resolverNodes, trxId };

    // const id = await context.forXid(?, dbmeta.?, trx).configure(...).getId()
    const { idExprs, softDeleteWhereWrapper } = this.buildIdLookups(
      trxBlock,
      trxNodes,
      inputType,
      targetTypeInfo,
      identityTypeInfo,
      identityTableMapping,
      true
    );

    const targetTableMapping =
      targetTypeInfo !== identityTypeInfo ? this.sqlMappings.getIdentityTableForType(targetTypeInfo.type) : undefined;
    let updateBlock = targetTableMapping ? trxBlock.newBlock() : trxBlock;
    const nonIdInputMappings = this.getInputFieldMappings(inputType, identityTableMapping).filter(
      m => !this.isIdField(identityTypeInfo, m.targetField)
    );
    let updateId = updateBlock.declareConst(
      'update',
      undefined,
      ts.createObjectLiteral(this.getUpsertProps(trxBlock, trxNodes, nonIdInputMappings), true)
    );
    let updateExpr = this.getUpdateExpression(identityTableMapping, trxId, idExprs, softDeleteWhereWrapper, updateId);
    let execStmt = ts.createExpressionStatement(this.getExecuteExpression(resolverNodes.contextId, updateExpr));
    // TODO: ensure row exists when using softDeleteWhereWrapper
    if (targetTableMapping) {
      updateBlock.addStatement(
        ts.createIf(this.getHasValueExpression(block.module, updateId), ts.createBlock([execStmt]))
      );
      trxBlock.addStatement(updateBlock.toBlock());

      updateBlock = trxBlock.newBlock();
      const inputMappings = this.getInputFieldMappings(inputType, targetTableMapping);
      updateId = updateBlock.declareConst(
        'update',
        undefined,
        ts.createObjectLiteral(this.getUpsertProps(trxBlock, trxNodes, inputMappings), true)
      );
      updateExpr = this.getUpdateExpression(targetTableMapping, trxId, idExprs, undefined, updateId);
      execStmt = ts.createExpressionStatement(this.getExecuteExpression(resolverNodes.contextId, updateExpr));
      updateBlock.addStatement(
        ts.createIf(this.getHasValueExpression(block.module, updateId), ts.createBlock([execStmt]))
      );
      trxBlock.addStatement(updateBlock.toBlock());
    } else {
      trxBlock.addStatement(execStmt);
    }

    // TODO: update nested objects into joined tables

    return { idExprs: this.getOuterBlockIds(block, trxBlock, trxNodes, idExprs), identityTableMapping };
  }

  private isIdField(typeInfo: TypeInfo, field: FieldType): boolean {
    return (
      typeInfo.externalIdField === field ||
      (typeInfo.internalIdFields != null && typeInfo.internalIdFields.includes(field))
    );
  }

  private getOuterBlockIds(
    outerBlock: TsBlock,
    trxBlock: TsBlock,
    trxNodes: ResolverTransactionNodes,
    innerIdExprs: ts.Identifier[]
  ): ts.Identifier[] {
    const trxExpr = this.getTransactionExpression(trxBlock, trxNodes);

    if (innerIdExprs.length === 1) {
      // const id = ... => { ...; return id; }
      trxBlock.addStatement(ts.createReturn(innerIdExprs[0]));
      return [outerBlock.declareConst(ts.idText(innerIdExprs[0]), undefined, trxExpr)];
    }

    // const [id1, id2] = ... => { ...; return [id1, id2]; }
    trxBlock.addStatement(ts.createReturn(ts.createArrayLiteral(innerIdExprs)));
    const outerIdExprs = innerIdExprs.map(idExpr => outerBlock.createIdentifier(ts.idText(idExpr)));
    outerBlock.declareConst(
      ts.createArrayBindingPattern(outerIdExprs.map(idExpr => ts.createBindingElement(undefined, undefined, idExpr))),
      undefined,
      trxExpr
    );
    return outerIdExprs;
  }

  private getTransactionExpression(block: TsBlock, nodes: ResolverTransactionNodes): ts.Expression {
    // await context.knex.transaction(async trx => { ... })
    return ts.createAwait(
      ts.createCall(
        ts.createPropertyAccess(ts.createPropertyAccess(nodes.contextId, 'knex'), 'transaction'),
        undefined,
        [
          ts.createArrowFunction(
            [ts.createModifier(ts.SyntaxKind.AsyncKeyword)],
            undefined,
            [ts.createParameter(undefined, undefined, undefined, nodes.trxId)],
            undefined,
            undefined,
            block.toBlock()
          )
        ]
      )
    );
  }

  private getUpdateExpression(
    tableMapping: TypeTable,
    trxExpr: ts.Expression,
    idExprs: ts.Expression[],
    softDeleteWhereWrapper: ExprWrapper | undefined,
    props: ts.Expression
  ): ts.Expression {
    let whereExpr = this.getWhereExpression(
      tableMapping,
      ts.createCall(trxExpr, undefined, [ts.createStringLiteral(tableMapping.table.name)]),
      idExprs
    );
    if (softDeleteWhereWrapper) {
      whereExpr = softDeleteWhereWrapper(whereExpr);
    }
    return ts.createCall(ts.createPropertyAccess(whereExpr, 'update'), undefined, [props]);
  }

  private getWhereExpression(
    tableMapping: TypeTable,
    queryExpr: ts.Expression,
    idExprs: ts.Expression[],
    resolverExpr?: ts.Expression
  ): ts.Expression {
    const keyParts = tableMapping.table.primaryKey.parts;
    if (keyParts.length !== idExprs.length) {
      console.log(tableMapping, keyParts, idExprs);
    }
    assert(keyParts.length === idExprs.length);
    keyParts.forEach((keyPart, index) => {
      let columnExpr: ts.Expression = ts.createStringLiteral(keyPart.column.name);
      if (resolverExpr) {
        columnExpr = ts.createCall(ts.createPropertyAccess(resolverExpr, 'qualifyColumn'), undefined, [columnExpr]);
      }
      queryExpr = ts.createCall(ts.createPropertyAccess(queryExpr, 'where'), undefined, [columnExpr, idExprs[index]]);
    });
    return queryExpr;
  }

  private getExecuteExpression(context: ts.Expression, queryExpr: ts.Expression): ts.Expression {
    return ts.createAwait(
      ts.createCall(ts.createPropertyAccess(ts.createPropertyAccess(context, 'sqlExecutor'), 'execute'), undefined, [
        queryExpr
      ])
    );
  }

  private getHasValueExpression(module: TsModule, updateExpr: ts.Expression): ts.Expression {
    const gqlsqlId = module.addNamespaceImport(this.config.gqlsqlModule, this.config.gqlsqlNamespace);
    return ts.createCall(ts.createPropertyAccess(gqlsqlId, 'hasDefinedValue'), undefined, [updateExpr]);
  }

  private getInputFieldMappings(inputType: GraphQLInputObjectType, tableMapping: TypeTable): InputFieldMapping[] {
    const result: InputFieldMapping[] = [];
    for (const inputField of Object.values(inputType.getFields())) {
      const targetField = this.findTargetField(inputField, tableMapping.type);
      if (targetField) {
        const fieldMapping = tableMapping.fieldMappings.get(targetField);
        if (fieldMapping && isColumns(fieldMapping)) {
          result.push({ inputField, targetField, columnMapping: fieldMapping });
        }
      }
    }
    return result;
  }

  private getUpsertProps(
    block: TsBlock,
    trxNodes: ResolverTransactionNodes,
    inputMappings: InputFieldMapping[]
  ): ts.ObjectLiteralElementLike[] {
    const result = [];
    for (const { inputField, targetField, columnMapping } of inputMappings) {
      const inputId = block.findIdentifierFor(inputField);
      if (!inputId) {
        throw new Error(`Identifier not found for input field "${inputField.name}"`);
      }
      if (columnMapping.columns.length === 1) {
        const [column] = columnMapping.columns;
        const { name } = column;
        const fieldType = getNullableType(inputField.type);
        if (isEnumType(fieldType)) {
          let expr: ts.Expression = inputId;
          let nullable = false;
          if (!isNonNullType(inputField.type)) {
            const defaultDir = findFirstDirective(targetField, this.config.defaultDirective);
            if (defaultDir) {
              const def = getRequiredDirectiveArgument(defaultDir, 'value', 'StringValue');
              const enumValue = pascalCase((def.value as StringValueNode).value);
              const enumValueExpr = ts.createPropertyAccess(
                ts.createPropertyAccess(this.schemaNamespaceId, inputField.type.name),
                enumValue
              );
              expr = ts.createNullishCoalesce(inputId, enumValueExpr);
            } else {
              nullable = true;
            }
          }
          const enumsId = this.getEnumsImport(block.module);
          const enumName = `${pascalCase(fieldType.name)}ToSql`;
          expr = ts.createCall(ts.createPropertyAccess(ts.createPropertyAccess(enumsId, enumName), 'get'), undefined, [
            expr
          ]);
          if (nullable) {
            expr = ts.createLogicalAnd(inputId, expr);
          }
          result.push(ts.createPropertyAssignment(name, expr));
        } else {
          const refDir =
            findFirstDirective(inputField, this.config.randomIdRefDirective) ||
            findFirstDirective(inputField, this.config.stringIdRefDirective);
          if (refDir) {
            result.push(
              ts.createPropertyAssignment(
                name,
                this.resolveXidRef(inputId, inputField, refDir, block, trxNodes, column)
              )
            );
          } else {
            result.push(block.createIdPropertyAssignment(name, inputId));
          }
        }
      } else {
        assert(columnMapping.columns.length === 2);
        const refDir = findFirstDirective(inputField, this.config.randomIdRefDirective);
        assert(refDir);
        const [kindColumn, idColumn] = columnMapping.columns;
        const { kindExpr, idExpr } = this.resolveQidRef(
          inputId,
          inputField,
          refDir!,
          block,
          trxNodes,
          kindColumn,
          idColumn
        );
        result.push(ts.createPropertyAssignment(kindColumn.name, kindExpr));
        result.push(ts.createPropertyAssignment(idColumn.name, idExpr));
      }
    }
    return result;
  }

  private resolveQidRef(
    inputId: ts.Identifier,
    inputField: GraphQLInputField,
    dir: DirectiveNode,
    block: TsBlock,
    trxNodes: ResolverTransactionNodes,
    kindUser: SqlColumn,
    idUser: SqlColumn
  ): { kindExpr: ts.Expression; idExpr: ts.Expression } {
    const name = stripIdSuffix(inputField.name);
    const type = (getRequiredDirectiveArgument(dir, 'type', 'StringValue').value as StringValueNode).value;
    const nullable = !isNonNullType(inputField.type);
    const resolveBlock = nullable ? block.newBlock() : block;
    const gqlsqlId = block.module.addNamespaceImport(this.config.gqlsqlModule, this.config.gqlsqlNamespace);

    // const [, fooMeta] = gqlsql.resolveQid(fooRid, dbmeta.Foo);
    const metaId = resolveBlock.createIdentifier(name + 'Meta');
    resolveBlock.declareConst(
      ts.createArrayBindingPattern([
        ts.createOmittedExpression(),
        ts.createBindingElement(undefined, undefined, metaId)
      ]),
      undefined,
      ts.createCall(ts.createPropertyAccess(gqlsqlId, 'resolveQid'), undefined, [
        inputId,
        ts.createPropertyAccess(this.getMetaImport(block.module), type)
      ])
    );

    // await context.getIdForXid(fooRid, fooMeta, trx);
    const idId = block.createIdentifier(name + 'Id', idUser);
    const idExpr = ts.createAwait(
      ts.createCall(ts.createPropertyAccess(trxNodes.contextId, 'getIdForXid'), undefined, [
        inputId,
        metaId,
        trxNodes.trxId
      ])
    );

    // fooMeta.tableId
    const kindId = block.createIdentifier(name + 'Kind', kindUser);
    const kindExpr = ts.createPropertyAccess(metaId, 'tableId');

    if (nullable) {
      // let fooKind, fooId;
      block.addStatement(
        ts.createVariableStatement(
          undefined,
          ts.createVariableDeclarationList(
            [ts.createVariableDeclaration(kindId), ts.createVariableDeclaration(idId)],
            ts.NodeFlags.Let
          )
        )
      );
      // fooId = await context.getIdForXid(fooRid, fooMeta, trx);
      resolveBlock.addStatement(ts.createExpressionStatement(ts.createAssignment(idId, idExpr)));
      // fooKind = fooMeta.tableId;
      resolveBlock.addStatement(ts.createExpressionStatement(ts.createAssignment(kindId, kindExpr)));
      // if (fooRid) { ... }
      block.addStatement(ts.createIf(inputId, resolveBlock.toBlock()));
    } else {
      // const fooId = await context.getIdForXid(fooRid, fooMeta, trx);
      block.declareConst(idId, undefined, idExpr);
      // const fooKind = fooMeta.tableId;
      block.declareConst(kindId, undefined, kindExpr);
    }

    return { kindExpr: kindId, idExpr: idId };
  }

  private resolveXidRef(
    inputId: ts.Identifier,
    inputField: GraphQLInputField,
    dir: DirectiveNode,
    block: TsBlock,
    trxNodes: ResolverTransactionNodes,
    idUser: SqlColumn
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
    if (!isNonNullType(inputField.type)) {
      // someXid && await ...
      expr = ts.createLogicalAnd(inputId, expr);
    }
    // const someId = someXid && await ...
    return block.declareConst(block.createIdentifier(inputField.name, idUser), undefined, expr);
  }

  private getTypeDiscriminatorColumnAndValue(
    typeDiscriminatorField: FieldType,
    targetType: GraphQLNamedType,
    identityTableMapping: TypeTable,
    module: TsModule
  ): [string, ts.Expression] {
    const fieldMapping = identityTableMapping.fieldMappings.get(typeDiscriminatorField);
    if (!fieldMapping || !isColumns(fieldMapping)) {
      throw new Error(
        `No column mapping for type discriminator field "${typeDiscriminatorField.name}"` +
          ` in table "${identityTableMapping.table.name}"`
      );
    }
    const enumsId = this.getEnumsImport(module);
    const enumName = getNamedType(typeDiscriminatorField.type).name;
    const enumValue = ts.createPropertyAccess(
      ts.createPropertyAccess(this.schemaNamespaceId, enumName),
      targetType.name
    );
    const enumToSqlName = `${pascalCase(enumName)}ToSql`;
    // enums.FieldTypeToSql.get(schema.FieldType.TargetType)
    const sqlValue = ts.createCall(
      ts.createPropertyAccess(ts.createPropertyAccess(enumsId, enumToSqlName), 'get'),
      undefined,
      [enumValue]
    );
    return [fieldMapping.columns[0].name, sqlValue];
  }

  private getSoftDeleteInfo(
    softDeleteField: FieldType,
    tableMapping: TypeTable,
    resolverNodes: ResolverNodes
  ): {
    softDeleteColumn: string;
    softDeleteWhereWrapper: ExprWrapper;
    softDeleteValueExpr: ts.Expression;
  } {
    const fieldMapping = tableMapping.fieldMappings.get(softDeleteField);
    if (!fieldMapping || !isColumns(fieldMapping)) {
      throw new Error(
        `No column mapping for soft-delete field "${softDeleteField.name}" in table "${tableMapping.table.name}"`
      );
    }
    const softDeleteColumn = fieldMapping.columns[0].name;

    if (getNamedType(softDeleteField.type).name === 'Boolean') {
      return {
        softDeleteColumn,
        softDeleteWhereWrapper: expr =>
          ts.createCall(ts.createPropertyAccess(expr, 'where'), undefined, [
            ts.createStringLiteral(softDeleteColumn),
            ts.createFalse()
          ]),
        softDeleteValueExpr: ts.createTrue()
      };
    } else {
      return {
        softDeleteColumn,
        softDeleteWhereWrapper: expr =>
          ts.createCall(ts.createPropertyAccess(expr, 'whereNull'), undefined, [
            ts.createStringLiteral(softDeleteColumn)
          ]),
        // context.knex.fn.now()
        softDeleteValueExpr: ts.createCall(
          ts.createPropertyAccess(
            ts.createPropertyAccess(ts.createPropertyAccess(resolverNodes.contextId, 'knex'), 'fn'),
            'now'
          ),
          undefined,
          undefined
        )
      };
    }
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

function addNamePrefix(prefix: string | undefined, name: string): string {
  return prefix ? prefix + ucFirst(name) : name;
}

function stripIdSuffix(name: string): string {
  return name.endsWith('Id') ? name.substring(0, name.length - 2) : name;
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
