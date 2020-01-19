import {
  getNullableType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLType,
  isListType,
  isNonNullType,
  isObjectType
} from 'graphql';

export type InterfaceImplementorMap = Map<GraphQLInterfaceType, Set<GraphQLObjectType>>;

export function getInterfaceImplementors(
  types: Iterable<GraphQLType>,
  map: InterfaceImplementorMap = new Map()
): InterfaceImplementorMap {
  for (const type of types) {
    if (isObjectType(type)) {
      for (const intf of type.getInterfaces()) {
        let implementers = map.get(intf);
        if (implementers == null) {
          map.set(intf, (implementers = new Set()));
        }
        implementers.add(type);
      }
    }
  }
  return map;
}

export function getElementType<T extends GraphQLType>(listType: T): T {
  const type = getNullableType(listType);
  if (!isListType(type)) {
    throw new Error(`Expected GraphQLList but got ${type.constructor.name}`);
  }
  return getNullableType(type.ofType);
}

enum WrapperType {
  NON_NULL,
  LIST
}

interface WrappedType {
  type: GraphQLNamedType;
  wrappers: WrapperType[];
}

export function unwrapType(type: GraphQLType): WrappedType {
  const wrappers = [];
  for (;;) {
    if (isNonNullType(type)) {
      type = type.ofType;
      wrappers.push(WrapperType.NON_NULL);
    } else if (isListType(type)) {
      type = type.ofType;
      wrappers.push(WrapperType.LIST);
    } else {
      break;
    }
  }
  return { type, wrappers };
}

export function wrapType(type: GraphQLType, wrappers: WrapperType[]): GraphQLType {
  for (const wrapper of wrappers) {
    switch (wrapper) {
      case WrapperType.NON_NULL:
        type = new GraphQLNonNull(type);
        break;
      case WrapperType.LIST:
        type = new GraphQLList(type);
        break;
    }
  }
  return type;
}