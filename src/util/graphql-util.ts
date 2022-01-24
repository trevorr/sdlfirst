import {
  getNullableType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNamedType,
  GraphQLNonNull,
  GraphQLNullableType,
  GraphQLObjectType,
  GraphQLType,
  isListType,
  isNonNullType,
  isObjectType,
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

export function getElementType<T extends GraphQLNullableType>(
  listType:
    | GraphQLList<T>
    | GraphQLList<GraphQLNonNull<T>>
    | GraphQLNonNull<GraphQLList<T>>
    | GraphQLNonNull<GraphQLList<GraphQLNonNull<T>>>
): T;
export function getElementType(listType: GraphQLType): GraphQLNullableType;
export function getElementType(listType: GraphQLType): GraphQLNullableType {
  const type = getNullableType(listType);
  if (!isListType(type)) {
    throw new Error(`Expected GraphQLList but got ${type.constructor.name}`);
  }
  return getNullableType(type.ofType);
}

export enum WrapperType {
  NON_NULL,
  LIST,
}

export interface WrappedType {
  type: GraphQLNamedType;
  wrappers: WrapperType[]; // inner-most first
}

export function unwrapType(type: GraphQLType): WrappedType {
  const wrappers = [];
  for (;;) {
    if (isNonNullType(type)) {
      type = type.ofType;
      wrappers.unshift(WrapperType.NON_NULL);
    } else if (isListType(type)) {
      type = type.ofType;
      wrappers.unshift(WrapperType.LIST);
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
