import {
  DirectiveDefinitionNode,
  DocumentNode,
  EnumTypeDefinitionNode,
  InputObjectTypeDefinitionNode,
  InterfaceTypeDefinitionNode,
  Kind,
  ObjectTypeDefinitionNode,
  ScalarTypeDefinitionNode,
  TypeDefinitionNode,
  UnionTypeDefinitionNode,
  visit,
} from 'graphql';

export type NamedDefinitionNode = TypeDefinitionNode | DirectiveDefinitionNode;

export type NamedDefinitionMap = Map<string, NamedDefinitionNode>;

export function buildNamedDefinitionMap(schemaAst: DocumentNode): NamedDefinitionMap {
  const result = new Map<string, NamedDefinitionNode>();
  visit(schemaAst, {
    DirectiveDefinition(node) {
      result.set(node.name.value, node);
    },
    EnumTypeDefinition(node) {
      result.set(node.name.value, node);
    },
    InputObjectTypeDefinition(node) {
      result.set(node.name.value, node);
    },
    InterfaceTypeDefinition(node) {
      result.set(node.name.value, node);
    },
    ObjectTypeDefinition(node) {
      result.set(node.name.value, node);
    },
    ScalarTypeDefinition(node) {
      result.set(node.name.value, node);
    },
    UnionTypeDefinition(node) {
      result.set(node.name.value, node);
    },
  });
  return result;
}

type NamedDefinitionKindMap = {
  [Kind.DIRECTIVE_DEFINITION]: DirectiveDefinitionNode;
  [Kind.ENUM_TYPE_DEFINITION]: EnumTypeDefinitionNode;
  [Kind.INPUT_OBJECT_TYPE_DEFINITION]: InputObjectTypeDefinitionNode;
  [Kind.INTERFACE_TYPE_DEFINITION]: InterfaceTypeDefinitionNode;
  [Kind.OBJECT_TYPE_DEFINITION]: ObjectTypeDefinitionNode;
  [Kind.SCALAR_TYPE_DEFINITION]: ScalarTypeDefinitionNode;
  [Kind.UNION_TYPE_DEFINITION]: UnionTypeDefinitionNode;
};

const namedDefinitionKindNames = {
  [Kind.DIRECTIVE_DEFINITION]: 'directive',
  [Kind.ENUM_TYPE_DEFINITION]: 'enum type',
  [Kind.INPUT_OBJECT_TYPE_DEFINITION]: 'input object type',
  [Kind.INTERFACE_TYPE_DEFINITION]: 'interface type',
  [Kind.OBJECT_TYPE_DEFINITION]: 'object type',
  [Kind.SCALAR_TYPE_DEFINITION]: 'scalar type',
  [Kind.UNION_TYPE_DEFINITION]: 'union type',
};

export function getNamedDefinition(schemaMap: NamedDefinitionMap, name: string): NamedDefinitionNode;
export function getNamedDefinition<K extends keyof NamedDefinitionKindMap>(
  schemaMap: NamedDefinitionMap,
  name: string,
  kind: K | readonly K[]
): NamedDefinitionKindMap[K];
export function getNamedDefinition<K extends keyof NamedDefinitionKindMap>(
  schemaMap: NamedDefinitionMap,
  name: string,
  kindOrKinds?: K | readonly K[]
): NamedDefinitionNode | NamedDefinitionKindMap[K] {
  const def = schemaMap.get(name);
  if (!def) {
    throw new Error(`Definition for ${name} not found in schema`);
  }
  if (kindOrKinds != null) {
    let kindNames;
    if (isReadonlyArray(kindOrKinds)) {
      for (const kind of kindOrKinds) {
        if (isNamedDefinitionKind(def, kind)) {
          return def;
        }
      }
      kindNames = kindOrKinds.map((kind) => namedDefinitionKindNames[kind]).join(' or ');
    } else if (isNamedDefinitionKind(def, kindOrKinds)) {
      return def;
    } else {
      kindNames = namedDefinitionKindNames[kindOrKinds];
    }
    throw new Error(`Expected ${name} to be ${kindNames} but got ${namedDefinitionKindNames[def.kind]}`);
  }
  return def;
}

export function isNamedDefinitionKind<K extends keyof NamedDefinitionKindMap>(
  def: NamedDefinitionNode,
  kind: K
): def is NamedDefinitionKindMap[K] {
  return def.kind === kind;
}

// https://github.com/microsoft/TypeScript/issues/17002
export function isReadonlyArray(v: unknown): v is readonly unknown[] {
  return Array.isArray(v);
}
