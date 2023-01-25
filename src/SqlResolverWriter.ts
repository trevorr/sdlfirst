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
  GraphQLScalarType,
  GraphQLSchema,
  IntValueNode,
  isCompositeType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isNullableType,
  isObjectType,
  isScalarType,
  isUnionType,
  StringValueNode,
} from 'graphql';
import { pascalCase } from 'pascal-case';
import path from 'path';
import ts from 'typescript';
import { Analyzer, FieldType, isTableType, TableType, TableTypeInfo, TypeInfo } from './Analyzer';
import { defaultConfig as defaultPathConfig, defaultConfig as defaultSqlConfig, SqlConfig } from './config/SqlConfig';
import { SqlColumn } from './model/SqlColumn';
import { CLIENT_MUTATION_ID, DELETED_FLAG } from './MutationBuilder';
import { FieldColumns, isColumns, SqlSchemaMappings, TypeTableMapping } from './SqlSchemaBuilder';
import {
  findDirective,
  getDirectiveArgument,
  getRequiredDirectiveArgument,
  hasDirective,
  hasDirectives,
} from './util/ast-util';
import { lcFirst, ucFirst } from './util/case';
import { compare } from './util/compare';
import { mkdir } from './util/fs-util';
import { QueryExpressionBuilder, RootQueryExpressionBuilder } from './util/QueryExpressionBuilder';
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
  qualifiedIdName: string;
  discriminatorSuffix: string;
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
  qualifiedIdName: 'qid',
  discriminatorSuffix: 'Kind',
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
  unusedArgPrefix: '_',
};

interface ResolverInfo {
  id: string;
  path: string;
}

enum RootType {
  Query = 1,
  Mutation = 2,
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
    this.schemaNamespaceId = ts.factory.createIdentifier(schemaTypesNamespace);

    const { contextType } = this.config;
    if (contextType != null) {
      this.contextType = ts.factory.createTypeReferenceNode(contextType, undefined);
    } else {
      this.contextType = ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
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
    const files = this.resolvers.map((r) => r.path).concat(this.methodResolvers.map((r) => r.path));
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
        parentType = ts.factory.createTypeReferenceNode(PartialType, [this.createSchemaTypeRef(type.name)]);
      } else {
        parentId = this.config.unusedArgPrefix + this.config.parentArgName;
        parentType = ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
      }
      let argsId, argsType;
      if (field.args.length > 0) {
        argsId = ts.factory.createIdentifier(this.config.argsArgName);
        argsType = this.createSchemaTypeRef(addNamePrefix(type.name, field.name + this.config.argsTypeSuffix));
      } else {
        argsId = ts.factory.createIdentifier(this.config.unusedArgPrefix + this.config.argsArgName);
        argsType = ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
      }
      const contextId = ts.factory.createIdentifier(this.config.contextArgName);
      const infoId = ts.factory.createIdentifier(this.config.infoArgName);
      const params = [
        this.createSimpleParameter(parentId, parentType),
        this.createSimpleParameter(argsId, argsType),
        this.createSimpleParameter(contextId, this.contextType),
        this.createSimpleParameter(infoId, ts.factory.createTypeReferenceNode(infoTypeId, undefined)),
      ];
      const returnType = ts.factory.createTypeReferenceNode(PromiseType, [await this.getFieldReturnType(field.type)]);
      const resolverNodes = {
        argsId,
        contextId,
        infoId,
        returnType,
      };

      const block = module.newBlock();
      let fieldType = getNullableType(field.type);
      let isList;
      if ((isList = isListType(fieldType))) {
        fieldType = getNullableType(fieldType.ofType);
      }
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
          console.log(`TODO: Unhandled node type ${fieldType.toString()}`);
        }
      } else if (isTableType(fieldType)) {
        const tableMapping = this.sqlMappings.getIdentityTableForType(fieldType);
        if (tableMapping) {
          const { configBlock, resolverId } = this.buildQueryResolver(block, tableMapping);

          // add a placeholder for building query based on arguments
          const configStmt = ts.factory.createExpressionStatement(
            ts.factory.createCallExpression(
              ts.factory.createPropertyAccessExpression(resolverId, 'getBaseQuery'),
              undefined,
              []
            )
          );
          ts.addSyntheticLeadingComment(
            configStmt,
            ts.SyntaxKind.SingleLineCommentTrivia,
            'TODO: build query based on arguments',
            true
          );
          configBlock.addStatement(configStmt);

          const lookupExpr = this.executeQueryResolver(
            tableMapping,
            this.createArrowFunction([this.createSimpleParameter(resolverId)], configBlock.toBlock()),
            isList,
            resolverNodes
          );

          block.addStatement(ts.factory.createReturnStatement(lookupExpr));
        } else {
          console.log(`TODO: No table mapping for ${fieldType.name}`);
        }
      } else {
        console.log(`TODO: Unhandled type ${fieldType.toString()}`);
      }
      if (block.isEmpty()) {
        block.addStatement(
          ts.factory.createThrowStatement(
            ts.factory.createNewExpression(ts.factory.createIdentifier('Error'), undefined, [
              ts.factory.createStringLiteral(`TODO: implement resolver for ${type.name}.${field.name}`),
            ])
          )
        );
      }
      properties.push(
        ts.factory.createMethodDeclaration(
          [ts.factory.createModifier(ts.SyntaxKind.AsyncKeyword)],
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
    module.addStatement(ts.factory.createExportDefault(ts.factory.createObjectLiteralExpression(properties, true)));

    await module.write(sourcePath, this.formatter);
  }

  private getMutationInputType(field: FieldType): GraphQLInputObjectType | null {
    const arg = field.args.find((arg) => arg.name === 'input');
    if (arg && isNonNullType(arg.type)) {
      const argType = getNullableType(arg.type);
      if (isInputObjectType(argType)) {
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
    identityTableMapping: TypeTableMapping,
    targetType: TableType,
    idExprs: ts.Expression[]
  ): void {
    const { configBlock, resolverId } = this.buildQueryResolver(block, identityTableMapping);

    configBlock.addStatement(
      ts.factory.createExpressionStatement(
        this.getWhereExpression(
          identityTableMapping,
          ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(resolverId, 'getBaseQuery'),
            undefined,
            []
          ),
          idExprs,
          resolverId
        )
      )
    );

    const lookupExpr = this.executeQueryResolver(
      identityTableMapping,
      this.createArrowFunction([this.createSimpleParameter(resolverId)], configBlock.toBlock()),
      false,
      resolverNodes
    );

    const resultName = lcFirst(targetType.name);
    const resultId = block.declareConst(
      resultName,
      undefined,
      ts.factory.createAsExpression(
        ts.factory.createAwaitExpression(lookupExpr),
        this.createSchemaTypeRef(targetType.name)
      )
    );

    block.addStatement(
      ts.factory.createReturnStatement(
        ts.factory.createObjectLiteralExpression([
          block.createIdPropertyAssignment(CLIENT_MUTATION_ID, block.findIdentifier(CLIENT_MUTATION_ID)),
          block.createIdPropertyAssignment(resultName, resultId),
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

    // const { clientMutationId, id: qid } = args.input
    this.destructureInput(block, resolverNodes.argsId, inputType);

    const trxId = block.module.createIdentifier('trx');
    const trxBlock = block.newBlock();
    const trxNodes = { ...resolverNodes, trxId };

    // const { a_id, b_id, ... } = await context.queryOptionalRow(...);
    const { idExprs, softDeleteColumn, softDeleteValueExpr } = this.idLookup(
      targetTypeInfo,
      identityTypeInfo,
      identityTableMapping,
      inputType,
      trxBlock,
      trxNodes,
      true
    );

    // if (a_id == null) return false
    trxBlock.addStatement(
      ts.factory.createIfStatement(
        this.eqEqNull(idExprs[0]),
        ts.factory.createReturnStatement(ts.factory.createFalse())
      )
    );

    // delete identity row
    let deleteExpr = this.getWhereExpression(
      identityTableMapping,
      ts.factory.createCallExpression(trxId, undefined, [
        ts.factory.createStringLiteral(identityTableMapping.table.name),
      ]),
      idExprs
    );
    let isSoftDelete;
    if (softDeleteColumn && softDeleteValueExpr) {
      deleteExpr = ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(deleteExpr, 'update'),
        undefined,
        [
          ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment(softDeleteColumn, softDeleteValueExpr),
          ]),
        ]
      );
      isSoftDelete = true;
    } else {
      deleteExpr = ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(deleteExpr, 'del'),
        undefined,
        undefined
      );
      isSoftDelete = false;
    }
    deleteExpr = this.getExecuteExpression(resolverNodes.contextId, deleteExpr);
    const deleteStmt = ts.factory.createExpressionStatement(deleteExpr);
    trxBlock.addStatement(deleteStmt);

    if (!isSoftDelete) {
      // TODO: cascade delete
      const deleteTables = new Set<string>();
      const nullColumns = new Set<string>();
      for (const ref of identityTypeInfo.referringFields) {
        const refTableMapping = this.sqlMappings.getIdentityTableForType(ref.type);
        if (refTableMapping) {
          const tableName = refTableMapping.table.name;
          if (isNullableType(ref.field.type)) {
            const refFieldMapping = refTableMapping.fieldMappings.get(ref.field);
            if (refFieldMapping) {
              if (isColumns(refFieldMapping)) {
                nullColumns.add(`${tableName}.${refFieldMapping.columns.map((c) => c.name).join(',')}`);
              } else {
                deleteTables.add(refFieldMapping.toTable.table.name);
              }
            }
          } else {
            deleteTables.add(tableName);
          }
        }
      }
      if (deleteTables.size > 0 || nullColumns.size > 0) {
        const commentLines = ['TODO: cascade delete'];
        if (deleteTables.size > 0) {
          commentLines.push('Delete from tables:');
          commentLines.push(...Array.from(deleteTables).sort());
        }
        if (nullColumns.size > 0) {
          commentLines.push('Null columns:');
          commentLines.push(...Array.from(nullColumns).sort());
        }
        commentLines.push('');
        ts.addSyntheticLeadingComment(deleteStmt, ts.SyntaxKind.MultiLineCommentTrivia, commentLines.join('\n'), true);
      }
    }

    // return true
    trxBlock.addStatement(ts.factory.createReturnStatement(ts.factory.createTrue()));

    // const deleted = await context.knex.transaction(async trx => { <trxBlock> })
    const deletedId = block.declareConst(
      DELETED_FLAG,
      undefined,
      ts.factory.createAwaitExpression(
        ts.factory.createCallExpression(
          ts.factory.createPropertyAccessExpression(
            ts.factory.createPropertyAccessExpression(resolverNodes.contextId, 'knex'),
            'transaction'
          ),
          undefined,
          [
            ts.factory.createArrowFunction(
              [ts.factory.createModifier(ts.SyntaxKind.AsyncKeyword)],
              undefined,
              [ts.factory.createParameterDeclaration(undefined, undefined, trxId)],
              undefined,
              undefined,
              trxBlock.toBlock()
            ),
          ]
        )
      )
    );

    // return { clientMutationId, deleted }
    block.addStatement(
      ts.factory.createReturnStatement(
        ts.factory.createObjectLiteralExpression([
          block.createIdPropertyAssignment(CLIENT_MUTATION_ID, block.findIdentifier(CLIENT_MUTATION_ID)),
          block.createIdPropertyAssignment(DELETED_FLAG, deletedId),
        ])
      )
    );
  }

  private eqEqNull(expr: ts.Expression): ts.Expression {
    return ts.factory.createBinaryExpression(expr, ts.SyntaxKind.EqualsEqualsToken, ts.factory.createNull());
  }

  private destructureInput(block: TsBlock, argsId: ts.Identifier, inputType: GraphQLInputObjectType): void {
    block.declareConst(
      ts.factory.createObjectBindingPattern(
        Object.values(inputType.getFields()).map((field) => {
          let binding = field.name;
          let idSuffix;
          if (hasDirectives(field, [this.config.wkidDirective, this.config.wkidRefDirective])) {
            idSuffix = this.config.wkidName;
          } else if (hasDirective(field, this.config.randomIdRefDirective)) {
            idSuffix = this.config.qualifiedIdName;
          }
          let match;
          if (idSuffix) {
            if (field.name === 'id') {
              binding = idSuffix;
            } else if ((match = /^(.*)Id(s?)$/.exec(field.name))) {
              binding = addNamePrefix(match[1], idSuffix + match[2]);
            }
          }
          return block.createBindingElement(field.name, binding, field);
        })
      ),
      undefined,
      ts.factory.createPropertyAccessExpression(argsId, 'input')
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
      ts.factory.createIfStatement(
        ts.factory.createLogicalNot(
          ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(gqlsqlId, 'hasDefinedElement'),
            undefined,
            [ts.factory.createArrayLiteralExpression(this.listInputs(block, inputType, targetType))]
          )
        ),
        ts.factory.createBlock([
          ts.factory.createThrowStatement(
            ts.factory.createNewExpression(ts.factory.createIdentifier('Error'), undefined, [
              ts.factory.createStringLiteral('Update must specify at least one field to modify'),
            ])
          ),
        ])
      )
    );
  }

  private listInputs(
    block: TsBlock,
    inputType: GraphQLInputObjectType,
    targetType: TableType,
    getFieldRef: (field: GraphQLInputField) => ts.Expression = (field) => block.createIdentifier(field.name, field),
    output: ts.Expression[] = []
  ): ts.Expression[] {
    for (const field of Object.values(inputType.getFields())) {
      const targetField = this.findTargetField(field, targetType);
      if (field.name === CLIENT_MUTATION_ID || (targetField && this.hasIdDirective(targetField))) continue;
      const fieldType = getNullableType(field.type);
      const fieldRef = getFieldRef(field);
      if (isInputObjectType(fieldType) && targetField) {
        const targetType = getNullableType(targetField.type);
        if (isTableType(targetType)) {
          this.listInputs(
            block,
            fieldType,
            targetType,
            (field) =>
              ts.factory.createPropertyAccessChain(
                fieldRef,
                ts.factory.createToken(ts.SyntaxKind.QuestionDotToken),
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

  private hasIdDirective(field: GraphQLInputField | FieldType): boolean {
    return hasDirectives(field, [this.config.idDirective, this.config.randomIdDirective, this.config.wkidDirective]);
  }

  private validateInput(
    block: TsBlock,
    inputType: GraphQLInputObjectType,
    targetType: TableType,
    getFieldRef: (field: GraphQLInputField) => ts.Expression = (field) => block.createIdentifier(field.name, field)
  ): void {
    const tsfvId = ts.factory.createIdentifier(this.config.tsfvBinding);
    for (const field of Object.values(inputType.getFields())) {
      let fieldType = getNullableType(field.type);
      const optional = !isNonNullType(field.type);
      const targetField = this.findTargetField(field, targetType);
      let expr: ts.Expression = tsfvId;
      if (isScalarType(fieldType)) {
        expr = this.validateScalarField(field, fieldType, targetField, expr);
      } else if (isListType(fieldType)) {
        fieldType = getNullableType(fieldType.ofType);
        if (isScalarType(fieldType)) {
          expr = this.validateScalarField(field, fieldType, targetField, expr);
        }
        if (expr !== tsfvId) {
          expr = ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(tsfvId, 'every'),
            undefined,
            [expr]
          );
        }
      } else if (isInputObjectType(fieldType) && targetField) {
        const targetFieldType = getNullableType(targetField.type);
        if (isTableType(targetFieldType)) {
          const fieldRef = getFieldRef(field);
          const targetBlock = optional ? block.newBlock() : block;
          this.validateInput(targetBlock, fieldType, targetFieldType, (field) =>
            ts.factory.createPropertyAccessExpression(fieldRef, block.createIdentifier(field.name, field))
          );
          if (optional) {
            block.addStatement(ts.factory.createIfStatement(fieldRef, targetBlock.toBlock()));
          }
        }
      }
      if (expr !== tsfvId) {
        if (optional) {
          expr = ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(expr, 'optional'),
            undefined,
            undefined
          );
        }
        block.addStatement(
          ts.factory.createExpressionStatement(
            ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(expr, 'check'), undefined, [
              getFieldRef(field),
              ts.factory.createStringLiteral(field.name),
            ])
          )
        );
      }
    }
    if (!block.isEmpty()) {
      block.module.addImport(this.config.tsfvModule, this.config.tsfvBinding);
    }
  }

  private validateScalarField(
    field: GraphQLInputField,
    fieldType: GraphQLScalarType,
    targetField: FieldType | undefined,
    expr: ts.Expression
  ): ts.Expression {
    switch (fieldType.name) {
      case 'ID':
        const wkidDir =
          findDirective(field, this.config.wkidDirective) || findDirective(field, this.config.wkidRefDirective);
        expr = getRangeValidator(expr, wkidDir, 'string', {
          betweenMethod: 'length',
          equalMethod: 'length',
          minMethod: 'minLength',
          maxMethod: 'maxLength',
          maxArgName: 'maxLength',
          defaultMin: '1',
        });
        const ridDir = findDirective(field, this.config.randomIdRefDirective);
        if (ridDir) {
          // rids should be /([A-Z]{1,4}_)?[0-9A-Za-z]{21}/
          // but strict validation isn't necessary due to database lookup
          expr = getRangeValidator(expr, ridDir, 'string', {
            betweenMethod: 'length',
            defaultMin: '21',
            defaultMax: '26',
          });
        }
        break;
      case 'String':
        const lengthDir = findDirective(targetField || field, this.config.lengthDirective);
        expr = getRangeValidator(expr, lengthDir, 'string', {
          betweenMethod: 'length',
          equalMethod: 'length',
          minMethod: 'minLength',
          maxMethod: 'maxLength',
          defaultMin: '1',
        });
        const regexDir = findDirective(targetField || field, this.config.regexDirective);
        if (regexDir) {
          const valueArg = getRequiredDirectiveArgument(regexDir, 'value', 'StringValue');
          expr = ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(expr, 'pattern'),
            undefined,
            [ts.factory.createRegularExpressionLiteral('/' + (valueArg.value as StringValueNode).value + '/')]
          );
        }
        break;
      case 'Float':
        const floatRangeDir = findDirective(targetField || field, this.config.floatRangeDirective);
        expr = getRangeValidator(expr, floatRangeDir, 'number');
        break;
      case 'Int':
        const intRangeDir = findDirective(targetField || field, this.config.intRangeDirective);
        expr = getRangeValidator(expr, intRangeDir, 'integer');
        break;
    }
    return expr;
  }

  private idLookup(
    targetTypeInfo: TableTypeInfo,
    identityTypeInfo: TableTypeInfo,
    identityTableMapping: TypeTableMapping,
    inputType: GraphQLInputObjectType,
    block: TsBlock,
    trxNodes: ResolverTransactionNodes,
    optional: boolean
  ): {
    idExprs: ts.Identifier[];
    softDeleteColumn?: string;
    softDeleteValueExpr?: ts.Expression;
  } {
    // const [aRid] = gqlsql.resolveQid(aQid, dbmeta.A);
    // const [bRid, bMeta] = gqlsql.resolveQid(bQid, dbmeta.B);
    // ...
    // trx('c')
    //   .join('a', { 'c.a_id': 'a.id' }).where('a.rid', aRid)
    //   .join(`${bMeta.tableName} as b`, {
    //     'c.b_kind': context.knex.raw('?', [bMeta.tableId!]),
    //     'c.b_id': `b.${bMeta.idColumns[0]}`
    //   }).where('b.rid', bRid)
    const qeb = new RootQueryExpressionBuilder(
      ts.factory.createPropertyAccessExpression(trxNodes.contextId, 'knex'),
      trxNodes.trxId,
      identityTableMapping.table.name
    );
    const inputIds = this.addIdLookup(identityTypeInfo, identityTableMapping, inputType, qeb, block);

    // .where('a.type', enums.IntfTypeToSql.get(schema.IntfType.ObjType))
    const { typeDiscriminatorField } = identityTypeInfo;
    if (typeDiscriminatorField) {
      const [column, value] = this.getTypeDiscriminatorColumnAndValue(
        typeDiscriminatorField,
        targetTypeInfo.type,
        identityTableMapping,
        block.module
      );
      qeb.where(column, value);
    }

    // .whereNull('a.delete_date')
    let softDeleteColumn, softDeleteValueExpr;
    const { softDeleteField } = identityTypeInfo;
    if (softDeleteField) {
      const fieldMapping = this.getFieldColumns(identityTableMapping, softDeleteField, 'soft-delete');
      softDeleteColumn = fieldMapping.columns[0].name;
      if (getNamedType(softDeleteField.type).name === 'Boolean') {
        qeb.where(softDeleteColumn, ts.factory.createFalse());
        softDeleteValueExpr = ts.factory.createTrue();
      } else {
        qeb.whereNull(softDeleteColumn);
        // context.knex.fn.now()
        softDeleteValueExpr = ts.factory.createCallExpression(
          ts.factory.createPropertyAccessExpression(
            ts.factory.createPropertyAccessExpression(
              ts.factory.createPropertyAccessExpression(trxNodes.contextId, 'knex'),
              'fn'
            ),
            'now'
          ),
          undefined,
          undefined
        );
      }
    }

    // .select('a.*')
    qeb.select('*');

    // const { a_id, b_id, ... } = await context.queryOptionalRow(...);
    const idExprs: ts.Identifier[] = [];
    const idBinds: ts.BindingElement[] = [];
    const { internalIdFields } = identityTypeInfo;
    if (internalIdFields) {
      for (const idField of internalIdFields) {
        const fieldMapping = this.getFieldColumns(identityTableMapping, idField, 'ID');
        for (const column of fieldMapping.columns) {
          const { name } = column;
          const id = block.createIdentifier(name, column);
          idBinds.push(ts.factory.createBindingElement(undefined, ts.idText(id) !== name ? name : undefined, id));
          idExprs.push(id);
        }
      }
    } else {
      const name = this.config.internalIdName;
      const id = block.createIdentifier(name);
      idBinds.push(ts.factory.createBindingElement(undefined, ts.idText(id) !== name ? name : undefined, id));
      idExprs.push(id);
    }
    const queryArgs = [qeb.getExpression()];
    let queryMethod;
    if (optional) {
      queryMethod = 'queryOptionalRow';
    } else {
      queryMethod = 'queryRow';
      queryArgs.push(
        ts.factory.createTemplateExpression(
          ts.factory.createTemplateHead(`${targetTypeInfo.type.name} with ID "`),
          inputIds.map((inputId, index) =>
            ts.factory.createTemplateSpan(
              inputId,
              index < inputIds.length - 1 ? ts.factory.createTemplateMiddle('", "') : ts.factory.createTemplateTail('"')
            )
          )
        )
      );
    }
    const queryExpr = ts.factory.createAwaitExpression(
      ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(trxNodes.contextId, queryMethod),
        undefined,
        queryArgs
      )
    );
    block.declareConst(ts.factory.createObjectBindingPattern(idBinds), undefined, queryExpr);

    return { idExprs, softDeleteColumn, softDeleteValueExpr };
  }

  private addIdLookup(
    identityTypeInfo: TableTypeInfo,
    identityTableMapping: TypeTableMapping,
    inputType: GraphQLInputObjectType,
    qeb: QueryExpressionBuilder,
    block: TsBlock,
    namePrefix?: string
  ): ts.Identifier[] {
    const { externalIdField, internalIdFields } = identityTypeInfo;
    const idFields = externalIdField ? [externalIdField] : internalIdFields;
    if (!idFields) {
      throw new Error(`ID fields expected for type "${identityTypeInfo.type.name}"`);
    }
    const inputIds: ts.Identifier[] = [];
    for (const idField of idFields) {
      const fieldMapping = this.getFieldColumns(identityTableMapping, idField, 'ID');
      inputIds.push(...this.addIdLookupFor(identityTypeInfo.type, fieldMapping, inputType, qeb, block, namePrefix));
    }
    return inputIds;
  }

  private addIdLookupFor(
    parentType: TableType,
    fieldMapping: FieldColumns,
    inputType: GraphQLInputObjectType,
    qeb: QueryExpressionBuilder,
    block: TsBlock,
    namePrefix?: string
  ): ts.Identifier[] {
    const { field, columns } = fieldMapping;
    const name = namePrefix ? namePrefix + ucFirst(field.name) : field.name;
    const type = getNullableType(field.type);

    if (isScalarType(type) || isEnumType(type)) {
      const idInputField = inputType.getFields()[name];
      if (!idInputField) {
        throw new Error(`ID field "${name}" not found in type "${inputType.name}"`);
      }
      const inputId = block.findIdentifierFor(idInputField);
      if (!inputId) {
        throw new Error(`Identifier not found for ID field "${inputType.name}.${name}"`);
      }
      if (columns.length !== 1) {
        throw new Error(
          `Expected 1 column mapping for ID field "${parentType.name}.${field.name}", got ${columns.length}`
        );
      }
      const column = columns[0].name;
      if (hasDirective(idInputField, this.config.randomIdRefDirective)) {
        // const [aRid] = gqlsql.resolveQid(aQid, dbmeta.A);
        const ridId = block.createIdentifier(name + ucFirst(this.config.randomIdName));
        const gqlsqlId = block.module.addNamespaceImport(this.config.gqlsqlModule, this.config.gqlsqlNamespace);
        block.declareConst(
          ts.factory.createArrayBindingPattern([ts.factory.createBindingElement(undefined, undefined, ridId)]),
          undefined,
          ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(gqlsqlId, 'resolveQid'),
            undefined,
            [inputId, ts.factory.createPropertyAccessExpression(this.getMetaImport(block.module), parentType.name)]
          )
        );
        qeb.where(column, ridId);
      } else {
        qeb.where(column, inputId);
      }
      return [inputId];
    }

    if (isCompositeType(type)) {
      const typeInfo = this.analyzer.getTypeInfo(type);
      if (typeInfo.hasIdentity) {
        const { identityTypeInfo = typeInfo } = typeInfo;
        const identityType = identityTypeInfo.type as TableType;
        const identityTableMapping = this.sqlMappings.getIdentityTableForType(identityType);
        if (identityTableMapping) {
          const { table } = identityTableMapping;
          const keyParts = table.primaryKey.parts;
          if (columns.length !== keyParts.length) {
            throw new Error(
              `Expected ${keyParts.length} column mapping(s) for ID field "${parentType.name}.${field.name}"` +
                `, got ${columns.length}`
            );
          }
          const jb = qeb.join(table.name, name);
          keyParts.forEach((part, index) => {
            jb.onColumn(part.column.name, columns[index].name);
          });
          return this.addIdLookup(
            identityTypeInfo as TableTypeInfo,
            identityTableMapping,
            inputType,
            jb.endJoin(),
            block,
            name
          );
        }

        const { externalIdField } = identityTypeInfo;
        if (externalIdField && typeInfo.tableIds) {
          const idName = name + ucFirst(externalIdField.name);
          const idInputField = inputType.getFields()[idName];
          if (!idInputField) {
            throw new Error(`ID field "${idName}" not found in type "${inputType.name}"`);
          }
          const inputId = block.findIdentifierFor(idInputField);
          if (!inputId) {
            throw new Error(`Identifier not found for ID field "${inputType.name}.${idName}"`);
          }
          if (columns.length !== 2) {
            throw new Error(
              `Expected 2 column mappings for discriminated ID field "${parentType.name}.${field.name}", got ${columns.length}`
            );
          }
          // const [cRid, cMeta] = gqlsql.resolveQid(cQid, dbmeta.C);
          const ridId = block.createIdentifier(name + ucFirst(this.config.randomIdName));
          const metaId = block.createIdentifier(name + ucFirst(this.config.discriminatorSuffix));
          const gqlsqlId = block.module.addNamespaceImport(this.config.gqlsqlModule, this.config.gqlsqlNamespace);
          block.declareConst(
            ts.factory.createArrayBindingPattern([
              ts.factory.createBindingElement(undefined, undefined, ridId),
              ts.factory.createBindingElement(undefined, undefined, metaId),
            ]),
            undefined,
            ts.factory.createCallExpression(
              ts.factory.createPropertyAccessExpression(gqlsqlId, 'resolveQid'),
              undefined,
              [inputId, ts.factory.createPropertyAccessExpression(this.getMetaImport(block.module), type.name)]
            )
          );
          // .join(`${cMeta.tableName} as c`, { 'a.c_kind': context.knex.raw('?', [cMeta.tableId]), 'a.c_id': `c.${cMeta.idColumns[0]}` })
          // .where('c.rid', cRid)
          const [kindColumn, idColumn] = columns;
          const jb = qeb.join(ts.factory.createPropertyAccessExpression(metaId, 'tableName'), name);
          jb.onValue(
            ts.factory.createNonNullExpression(ts.factory.createPropertyAccessExpression(metaId, 'tableId')),
            kindColumn.name
          );
          jb.onColumn(
            ts.factory.createElementAccessExpression(ts.factory.createPropertyAccessExpression(metaId, 'idColumns'), 0),
            idColumn.name
          );
          jb.endJoin().where(this.config.randomIdName, ridId);
          return [inputId];
        }
      }
    }

    throw new Error(`Unsupported type "${type.toString()}" for field "${parentType.name}.${field.name}"`);
  }

  private getFieldColumns(tableMapping: TypeTableMapping, field: FieldType, kind: string): FieldColumns {
    const fieldMapping = tableMapping.fieldMappings.get(field);
    if (!fieldMapping) {
      throw new Error(`No column mapping for ${kind} field "${tableMapping.type.name}.${field.name}"`);
    }
    if (!isColumns(fieldMapping)) {
      throw new Error(`Expected column mapping for ${kind} field "${tableMapping.type.name}.${field.name}"`);
    }
    return fieldMapping;
  }

  private performInsert(
    block: TsBlock,
    resolverNodes: ResolverNodes,
    inputType: GraphQLInputObjectType,
    targetTypeInfo: TableTypeInfo
  ): { idExprs: ts.Identifier[]; identityTableMapping: TypeTableMapping } {
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
        ts.factory.createCallExpression(
          block.module.addImport(this.config.id62Module, this.config.id62Binding),
          undefined,
          undefined
        )
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
      const [column, value] = this.getTypeDiscriminatorColumnAndValue(
        typeDiscriminatorField,
        targetTypeInfo.type,
        identityTableMapping,
        block.module
      );
      insertProps.push(ts.factory.createPropertyAssignment(column, value));
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
      idExprs = [
        trxBlock.declareConst(
          this.config.internalIdName,
          undefined,
          ts.factory.createElementAccessExpression(execExpr, 0)
        ),
      ];
    } else {
      trxBlock.addStatement(ts.factory.createExpressionStatement(execExpr));
      idExprs = inputMappings
        .filter((m) => this.isIdField(identityTypeInfo, m.targetField))
        .flatMap((m) => {
          const ids = m.columnMapping.columns.map((c) => trxBlock.findIdentifierFor(c));
          if (ids.every((id) => id != null)) return ids as ts.Identifier[];
          const id = trxBlock.findIdentifierFor(m.inputField);
          if (!id) {
            throw new Error(`Identifier not found for field "${identityTypeInfo.type.name}.${m.inputField.name}"`);
          }
          return id;
        });
    }

    const targetTableMapping = this.sqlMappings.getIdentityTableForType(targetTypeInfo.type);
    if (targetTableMapping && targetTableMapping.table !== identityTableMapping.table) {
      const insertProps: ts.ObjectLiteralElementLike[] = [];
      const keyParts = targetTableMapping.table.primaryKey.parts;
      if (keyParts.length !== idExprs.length) {
        console.log(identityTypeInfo, keyParts, idExprs);
      }
      assert(keyParts.length === idExprs.length);
      insertProps.push(
        ...keyParts.map((keyPart, index) => ts.factory.createPropertyAssignment(keyPart.column.name, idExprs[index]))
      );
      const inputMappings = this.getInputFieldMappings(inputType, targetTableMapping);
      insertProps.push(...this.getUpsertProps(trxBlock, trxNodes, inputMappings));
      const queryExpr = this.getInsertExpression(trxId, targetTableMapping.table.name, insertProps);
      const execExpr = this.getExecuteExpression(resolverNodes.contextId, queryExpr);
      trxBlock.addStatement(ts.factory.createExpressionStatement(execExpr));
    }

    // TODO: insert nested objects into joined tables

    return { idExprs: this.getOuterBlockIds(block, trxBlock, trxNodes, idExprs), identityTableMapping };
  }

  private getInsertExpression(trx: ts.Expression, table: string, props: ts.ObjectLiteralElementLike[]): ts.Expression {
    return ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(
        ts.factory.createCallExpression(trx, undefined, [ts.factory.createStringLiteral(table)]),
        'insert'
      ),
      undefined,
      [ts.factory.createObjectLiteralExpression(props, true)]
    );
  }

  private performUpdate(
    block: TsBlock,
    resolverNodes: ResolverNodes,
    inputType: GraphQLInputObjectType,
    targetTypeInfo: TableTypeInfo
  ): { idExprs: ts.Identifier[]; identityTableMapping: TypeTableMapping } {
    const { identityTypeInfo = targetTypeInfo } = targetTypeInfo;
    const identityTableMapping = this.sqlMappings.getIdentityTableForType(identityTypeInfo.type);
    if (!identityTableMapping) {
      throw new Error(`No table mapping for type "${targetTypeInfo.type.name}"`);
    }

    const trxId = block.module.createIdentifier('trx');
    const trxBlock = block.newBlock();
    const trxNodes = { ...resolverNodes, trxId };

    // const { a_id, b_id, ... } = await context.queryRow(...);
    const { idExprs } = this.idLookup(
      targetTypeInfo,
      identityTypeInfo,
      identityTableMapping,
      inputType,
      trxBlock,
      trxNodes,
      false
    );

    const targetTableMapping =
      targetTypeInfo !== identityTypeInfo ? this.sqlMappings.getIdentityTableForType(targetTypeInfo.type) : undefined;
    let updateBlock = targetTableMapping ? trxBlock.newBlock() : trxBlock;
    const nonIdInputMappings = this.getInputFieldMappings(inputType, identityTableMapping).filter(
      (m) => !this.isIdField(identityTypeInfo, m.targetField)
    );
    let updateId = updateBlock.declareConst(
      'update',
      undefined,
      ts.factory.createObjectLiteralExpression(this.getUpsertProps(trxBlock, trxNodes, nonIdInputMappings), true)
    );
    let updateExpr = this.getUpdateExpression(identityTableMapping, trxId, idExprs, updateId);
    let execStmt = ts.factory.createExpressionStatement(this.getExecuteExpression(resolverNodes.contextId, updateExpr));
    if (targetTableMapping && targetTableMapping.table !== identityTableMapping.table) {
      updateBlock.addStatement(
        ts.factory.createIfStatement(
          this.getHasValueExpression(block.module, updateId),
          ts.factory.createBlock([execStmt])
        )
      );
      trxBlock.addStatement(updateBlock.toBlock());

      updateBlock = trxBlock.newBlock();
      const inputMappings = this.getInputFieldMappings(inputType, targetTableMapping);
      updateId = updateBlock.declareConst(
        'update',
        undefined,
        ts.factory.createObjectLiteralExpression(this.getUpsertProps(trxBlock, trxNodes, inputMappings), true)
      );
      updateExpr = this.getUpdateExpression(targetTableMapping, trxId, idExprs, updateId);
      execStmt = ts.factory.createExpressionStatement(this.getExecuteExpression(resolverNodes.contextId, updateExpr));
      updateBlock.addStatement(
        ts.factory.createIfStatement(
          this.getHasValueExpression(block.module, updateId),
          ts.factory.createBlock([execStmt])
        )
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
    if (innerIdExprs.length === 1) {
      // const id = ... => { ...; return id; }
      trxBlock.addStatement(ts.factory.createReturnStatement(innerIdExprs[0]));
      return [
        outerBlock.declareConst(
          ts.idText(innerIdExprs[0]),
          undefined,
          this.getTransactionExpression(trxBlock, trxNodes)
        ),
      ];
    }

    // const [id1, id2] = ... => { ...; return [id1, id2]; }
    trxBlock.addStatement(ts.factory.createReturnStatement(ts.factory.createArrayLiteralExpression(innerIdExprs)));
    const outerIdExprs = innerIdExprs.map((idExpr) => outerBlock.createIdentifier(ts.idText(idExpr)));
    outerBlock.declareConst(
      ts.factory.createArrayBindingPattern(
        outerIdExprs.map((idExpr) => ts.factory.createBindingElement(undefined, undefined, idExpr))
      ),
      undefined,
      this.getTransactionExpression(trxBlock, trxNodes)
    );
    return outerIdExprs;
  }

  private getTransactionExpression(block: TsBlock, nodes: ResolverTransactionNodes): ts.Expression {
    // await context.knex.transaction(async trx => { ... })
    return ts.factory.createAwaitExpression(
      ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(
          ts.factory.createPropertyAccessExpression(nodes.contextId, 'knex'),
          'transaction'
        ),
        undefined,
        [
          ts.factory.createArrowFunction(
            [ts.factory.createModifier(ts.SyntaxKind.AsyncKeyword)],
            undefined,
            [ts.factory.createParameterDeclaration(undefined, undefined, nodes.trxId)],
            undefined,
            undefined,
            block.toBlock()
          ),
        ]
      )
    );
  }

  private getUpdateExpression(
    tableMapping: TypeTableMapping,
    trxExpr: ts.Expression,
    idExprs: ts.Expression[],
    props: ts.Expression
  ): ts.Expression {
    const whereExpr = this.getWhereExpression(
      tableMapping,
      ts.factory.createCallExpression(trxExpr, undefined, [ts.factory.createStringLiteral(tableMapping.table.name)]),
      idExprs
    );
    return ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(whereExpr, 'update'), undefined, [
      props,
    ]);
  }

  private getWhereExpression(
    tableMapping: TypeTableMapping,
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
      let columnExpr: ts.Expression = ts.factory.createStringLiteral(keyPart.column.name);
      if (resolverExpr) {
        columnExpr = ts.factory.createCallExpression(
          ts.factory.createPropertyAccessExpression(resolverExpr, 'qualifyColumn'),
          undefined,
          [columnExpr]
        );
      }
      queryExpr = ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(queryExpr, 'where'),
        undefined,
        [columnExpr, idExprs[index]]
      );
    });
    return queryExpr;
  }

  private getExecuteExpression(context: ts.Expression, queryExpr: ts.Expression): ts.Expression {
    return ts.factory.createAwaitExpression(
      ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(
          ts.factory.createPropertyAccessExpression(context, 'sqlExecutor'),
          'execute'
        ),
        undefined,
        [queryExpr]
      )
    );
  }

  private getHasValueExpression(module: TsModule, updateExpr: ts.Expression): ts.Expression {
    const gqlsqlId = module.addNamespaceImport(this.config.gqlsqlModule, this.config.gqlsqlNamespace);
    return ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(gqlsqlId, 'hasDefinedValue'),
      undefined,
      [updateExpr]
    );
  }

  private getInputFieldMappings(
    inputType: GraphQLInputObjectType,
    tableMapping: TypeTableMapping
  ): InputFieldMapping[] {
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
            const defaultDir = findDirective(targetField, this.config.defaultDirective);
            if (defaultDir) {
              const def = getRequiredDirectiveArgument(defaultDir, 'value', 'StringValue');
              const enumValue = pascalCase((def.value as StringValueNode).value);
              const enumValueExpr = ts.factory.createPropertyAccessExpression(
                ts.factory.createPropertyAccessExpression(this.schemaNamespaceId, inputField.type.name),
                enumValue
              );
              expr = ts.factory.createBinaryExpression(inputId, ts.SyntaxKind.QuestionQuestionToken, enumValueExpr);
            } else {
              nullable = true;
            }
          }
          const enumsId = this.getEnumsImport(block.module);
          const enumName = `${pascalCase(fieldType.name)}ToSql`;
          expr = ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(
              ts.factory.createPropertyAccessExpression(enumsId, enumName),
              'get'
            ),
            undefined,
            [expr]
          );
          if (nullable) {
            expr = ts.factory.createLogicalAnd(inputId, expr);
          }
          result.push(ts.factory.createPropertyAssignment(name, expr));
        } else {
          const refDir =
            findDirective(inputField, this.config.randomIdRefDirective) ||
            findDirective(inputField, this.config.wkidRefDirective);
          if (refDir) {
            result.push(
              ts.factory.createPropertyAssignment(
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
        const refDir = findDirective(inputField, this.config.randomIdRefDirective);
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
        result.push(ts.factory.createPropertyAssignment(kindColumn.name, kindExpr));
        result.push(ts.factory.createPropertyAssignment(idColumn.name, idExpr));
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
      ts.factory.createArrayBindingPattern([
        ts.factory.createOmittedExpression(),
        ts.factory.createBindingElement(undefined, undefined, metaId),
      ]),
      undefined,
      ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(gqlsqlId, 'resolveQid'), undefined, [
        inputId,
        ts.factory.createPropertyAccessExpression(this.getMetaImport(block.module), type),
      ])
    );

    // await context.getIdForXid(fooRid, fooMeta, trx);
    const idId = block.createIdentifier(name + 'Id', idUser);
    const idExpr = ts.factory.createAwaitExpression(
      ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(trxNodes.contextId, 'getIdForXid'),
        undefined,
        [inputId, metaId, trxNodes.trxId]
      )
    );

    // fooMeta.tableId
    const kindId = block.createIdentifier(name + 'Kind', kindUser);
    const kindExpr = ts.factory.createPropertyAccessExpression(metaId, 'tableId');

    if (nullable) {
      // let fooKind, fooId;
      block.addStatement(
        ts.factory.createVariableStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            [ts.factory.createVariableDeclaration(kindId), ts.factory.createVariableDeclaration(idId)],
            ts.NodeFlags.Let
          )
        )
      );
      // fooId = await context.getIdForXid(fooRid, fooMeta, trx);
      resolveBlock.addStatement(ts.factory.createExpressionStatement(ts.factory.createAssignment(idId, idExpr)));
      // fooKind = fooMeta.tableId;
      resolveBlock.addStatement(ts.factory.createExpressionStatement(ts.factory.createAssignment(kindId, kindExpr)));
      // if (fooRid) { ... }
      block.addStatement(ts.factory.createIfStatement(inputId, resolveBlock.toBlock()));
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
    let expr: ts.Expression = ts.factory.createAwaitExpression(
      ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(trxNodes.contextId, 'getIdForXid'),
        undefined,
        [inputId, ts.factory.createPropertyAccessExpression(this.getMetaImport(block.module), type), trxNodes.trxId]
      )
    );
    if (!isNonNullType(inputField.type)) {
      // someXid && await ...
      expr = ts.factory.createLogicalAnd(inputId, expr);
    }
    // const someId = someXid && await ...
    return block.declareConst(block.createIdentifier(inputField.name, idUser), undefined, expr);
  }

  private getTypeDiscriminatorColumnAndValue(
    typeDiscriminatorField: FieldType,
    targetType: GraphQLNamedType,
    identityTableMapping: TypeTableMapping,
    module: TsModule
  ): [string, ts.Expression] {
    const fieldMapping = this.getFieldColumns(identityTableMapping, typeDiscriminatorField, 'type discriminator');
    const enumsId = this.getEnumsImport(module);
    const enumName = getNamedType(typeDiscriminatorField.type).name;
    const enumValue = ts.factory.createPropertyAccessExpression(
      ts.factory.createPropertyAccessExpression(this.schemaNamespaceId, enumName),
      targetType.name
    );
    const enumToSqlName = `${pascalCase(enumName)}ToSql`;
    // enums.FieldTypeToSql.get(schema.FieldType.TargetType)
    const sqlValue = ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(
        ts.factory.createPropertyAccessExpression(enumsId, enumToSqlName),
        'get'
      ),
      undefined,
      [enumValue]
    );
    return [fieldMapping.columns[0].name, sqlValue];
  }

  private getMetaImport(module: TsModule): ts.Identifier {
    return module.addImport(path.relative(this.config.resolversDir, this.config.databaseMetadataDir), 'dbmeta');
  }

  private getEnumsImport(module: TsModule): ts.Identifier {
    return module.addNamespaceImport(path.relative(this.config.resolversDir, this.config.enumMappingsDir), 'enums');
  }

  private buildConnectionResolver(
    block: TsBlock,
    tableMapping: TypeTableMapping,
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
      configBlock.addStatement(
        ts.factory.createExpressionStatement(ts.factory.createCallExpression(configId, undefined, [resolverId!]))
      );
    }

    // order by primary key by default, though it will usual need to be changed
    for (const part of table.primaryKey.parts) {
      configBlock.addStatement(
        ts.factory.createExpressionStatement(
          ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(resolverId, 'addOrderBy'),
            undefined,
            [ts.factory.createStringLiteral(part.column.name), ts.factory.createStringLiteral(table.name)]
          )
        )
      );
    }

    block.addStatement(
      ts.factory.createReturnStatement(
        ts.factory.createAsExpression(
          ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(
              ts.factory.createCallExpression(
                ts.factory.createPropertyAccessExpression(
                  ts.factory.createCallExpression(
                    ts.factory.createPropertyAccessExpression(
                      ts.factory.createPropertyAccessExpression(contextId, this.config.contextResolverFactory),
                      'createConnection'
                    ),
                    undefined,
                    [ts.factory.createStringLiteral(table.name), argsId]
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

  private buildQueryResolver(
    block: TsBlock,
    tableMapping: TypeTableMapping
  ): { configBlock: TsBlock; resolverId: ts.Identifier } {
    const { type } = tableMapping;
    const configBlock = block.newBlock();
    const resolverId = configBlock.createIdentifier('resolver');

    // configure resolver for interface types
    if (isInterfaceType(type)) {
      const configId = block.module.addNamedImport(
        path.relative(this.config.resolversDir, `${this.config.fieldVisitorsDir}/${type.name}`),
        `configure${type.name}Resolver`
      );
      configBlock.addStatement(
        ts.factory.createExpressionStatement(ts.factory.createCallExpression(configId, undefined, [resolverId!]))
      );
    }

    return { configBlock, resolverId };
  }

  private executeQueryResolver(
    tableMapping: TypeTableMapping,
    walkConfig: ts.Expression | undefined,
    isList: boolean,
    { contextId, infoId }: ResolverNodes
  ): ts.Expression {
    const walkArgs: ts.Expression[] = [infoId];
    if (walkConfig) {
      walkArgs.push(walkConfig);
    }
    return ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(
        ts.factory.createCallExpression(
          ts.factory.createPropertyAccessExpression(
            ts.factory.createCallExpression(
              ts.factory.createPropertyAccessExpression(
                ts.factory.createPropertyAccessExpression(contextId, this.config.contextResolverFactory),
                'createQuery'
              ),
              undefined,
              [ts.factory.createStringLiteral(tableMapping.table.name)]
            ),
            'walk'
          ),
          undefined,
          walkArgs
        ),
        isList ? 'execute' : 'executeLookup'
      ),
      undefined,
      []
    );
  }

  private async getFieldReturnType(type: GraphQLOutputType): Promise<ts.TypeNode> {
    let returnType: ts.TypeNode;
    const nullableType = getNullableType(type);
    if (isScalarType(nullableType)) {
      returnType = ts.factory.createIndexedAccessTypeNode(
        this.createSchemaTypeRef(ScalarsType),
        ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(nullableType.name))
      );
    } else if (isEnumType(nullableType)) {
      returnType = this.createSchemaTypeRef(nullableType.name);
    } else if (isObjectType(nullableType)) {
      await this.writeResolver(nullableType);
      returnType = ts.factory.createTypeReferenceNode(PartialType, [this.createSchemaTypeRef(nullableType.name)]);
    } else if (isInterfaceType(nullableType)) {
      await this.writeResolver(nullableType);
      returnType = ts.factory.createTypeReferenceNode(PartialType, [this.createSchemaTypeRef(nullableType.name)]);
    } else if (isUnionType(nullableType)) {
      returnType = this.createSchemaTypeRef(nullableType.name);
    } else if (isListType(nullableType)) {
      returnType = ts.factory.createArrayTypeNode(await this.getFieldReturnType(nullableType.ofType));
    } else {
      throw new Error(`Unrecognized field type: ${type.toString()}`);
    }
    if (!isNonNullType(type)) {
      returnType = ts.factory.createUnionTypeNode([
        returnType,
        ts.factory.createLiteralTypeNode(ts.factory.createToken(ts.SyntaxKind.NullKeyword)),
      ]);
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
      ts.factory.createMethodDeclaration(
        undefined,
        undefined,
        undefined,
        '__resolveType',
        undefined,
        undefined,
        [this.createSimpleParameter('obj', this.createSchemaTypeRef(type.name))],
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ts.factory.createBlock([ts.factory.createReturnStatement(ts.factory.createStringLiteral('TODO'))], true)
      ),
    ];
    module.addStatement(ts.factory.createExportDefault(ts.factory.createObjectLiteralExpression(properties, true)));

    return module;
  }

  private createSchemaTypeRef(name: string | ts.Identifier): ts.TypeReferenceNode {
    let qname: string | ts.EntityName = name;
    qname = ts.factory.createQualifiedName(this.schemaNamespaceId, qname);
    return ts.factory.createTypeReferenceNode(qname, undefined);
  }

  private createSimpleParameter(name: string | ts.BindingName, type?: ts.TypeNode): ts.ParameterDeclaration {
    return ts.factory.createParameterDeclaration(undefined, undefined, name, undefined, type);
  }

  private createArrowFunction(parameters: ts.ParameterDeclaration[], body: ts.ConciseBody): ts.ArrowFunction {
    return ts.factory.createArrowFunction(undefined, undefined, parameters, undefined, undefined, body);
  }

  private createIndexModule(resolvers: ResolverInfo[], spread: boolean): TsModule {
    const module = new TsModule();
    const properties = [];
    resolvers.sort((a, b) => compare(a.id, b.id));
    for (const resolver of resolvers) {
      const { id } = resolver;
      const idIdentifier = module.addImport(`./${id}`, id);
      properties.push(
        spread ? ts.factory.createSpreadAssignment(idIdentifier) : module.createIdPropertyAssignment(id, idIdentifier)
      );
    }
    module.addStatement(ts.factory.createExportDefault(ts.factory.createObjectLiteralExpression(properties, true)));
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
  maxArgName: 'max',
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
      expr = ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(
          ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(expr, typeMethod),
            undefined,
            undefined
          ),
          method
        ),
        undefined,
        params.map((v) => ts.factory.createNumericLiteral(v))
      );
    }
  }
  return expr;
}
