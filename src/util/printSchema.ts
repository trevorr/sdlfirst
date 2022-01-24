import {
  GraphQLSchema,
  isSpecifiedDirective,
  isSpecifiedScalarType,
  Kind,
  OperationTypeDefinitionNode,
  OperationTypeNode,
  print,
  printType,
  SchemaDefinitionNode,
} from 'graphql';

function getSchemaAstNode(schema: GraphQLSchema): SchemaDefinitionNode {
  if (schema.astNode) {
    return schema.astNode;
  }
  const operationTypes: OperationTypeDefinitionNode[] = [];
  const queryType = schema.getQueryType();
  if (queryType) {
    operationTypes.push({
      kind: Kind.OPERATION_TYPE_DEFINITION,
      operation: OperationTypeNode.QUERY,
      type: { kind: Kind.NAMED_TYPE, name: { kind: Kind.NAME, value: queryType.name } },
    });
  }
  const mutationType = schema.getMutationType();
  if (mutationType) {
    operationTypes.push({
      kind: Kind.OPERATION_TYPE_DEFINITION,
      operation: OperationTypeNode.MUTATION,
      type: { kind: Kind.NAMED_TYPE, name: { kind: Kind.NAME, value: mutationType.name } },
    });
  }
  const subscriptionType = schema.getSubscriptionType();
  if (subscriptionType) {
    operationTypes.push({
      kind: Kind.OPERATION_TYPE_DEFINITION,
      operation: OperationTypeNode.SUBSCRIPTION,
      type: { kind: Kind.NAMED_TYPE, name: { kind: Kind.NAME, value: subscriptionType.name } },
    });
  }
  return {
    kind: Kind.SCHEMA_DEFINITION,
    operationTypes,
  };
}

export function printSchemaUsingAst(schema: GraphQLSchema): string {
  const directives = schema
    .getDirectives()
    .filter((dir) => !isSpecifiedDirective(dir))
    .map((dir) => (dir.astNode ? print(dir.astNode) : `# directive @${dir.name}`));

  const types = Object.entries(schema.getTypeMap())
    .filter(([name]) => !name.match(/^__/))
    .map(([, type]) => type)
    .filter((type) => !isSpecifiedScalarType(type))
    .sort((type1, type2) => type1.name.localeCompare(type2.name))
    .map((type) => (type.astNode ? print(type.astNode) : printType(type)));

  return [print(getSchemaAstNode(schema))].concat(directives, types).join('\n\n') + '\n';
}
