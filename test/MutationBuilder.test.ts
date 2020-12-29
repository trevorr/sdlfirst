import { expect } from 'chai';
import fs from 'fs';
import {
  buildSchema,
  getNamedType,
  GraphQLNamedType,
  GraphQLSchema,
  isCompositeType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isSpecifiedScalarType,
  print,
  printType,
} from 'graphql';
import path from 'path';
import { Analyzer } from '../src/Analyzer';
import { MutationBuilder } from '../src/MutationBuilder';

const directives = fs.readFileSync(path.join(__dirname, '../sdl/directives.graphql'), { encoding: 'utf8' });

function addMutations(sdl: string): GraphQLSchema {
  const schema = buildSchema(`${directives}\n${sdl}`);
  return new MutationBuilder(schema, new Analyzer(schema)).addMutations();
}

function printMutationTypes(schema: GraphQLSchema): string {
  const mutation = schema.getType('Mutation');
  return printTypes(mutation ? getReferencedUserTypes(mutation) : []);
}

function printTypes(types: Iterable<GraphQLNamedType>): string {
  return Array.from(types, (t) => (t.astNode ? print(t.astNode) : printType(t))).join('\n');
}

function getReferencedUserTypes(type: GraphQLNamedType, into = new Set<GraphQLNamedType>()): Set<GraphQLNamedType> {
  if (!into.has(type)) {
    if (isCompositeType(type)) {
      into.add(type);
      if (isObjectType(type)) {
        type.getInterfaces().forEach((t) => getReferencedUserTypes(t, into));
        Object.values(type.getFields()).forEach((f) => {
          f.args.forEach((a) => getReferencedUserTypes(getNamedType(a.type), into));
          getReferencedUserTypes(getNamedType(f.type), into);
        });
      } else if (isInterfaceType(type)) {
        Object.values(type.getFields()).forEach((f) => {
          f.args.forEach((a) => getReferencedUserTypes(getNamedType(a.type), into));
          getReferencedUserTypes(getNamedType(f.type), into);
        });
      } else {
        type.getTypes().forEach((t) => getReferencedUserTypes(t, into));
      }
    } else if (isInputObjectType(type)) {
      into.add(type);
      Object.values(type.getFields()).forEach((f) => {
        getReferencedUserTypes(getNamedType(f.type), into);
      });
    } else if (isEnumType(type) || !isSpecifiedScalarType(type)) {
      into.add(type);
    }
  }
  return into;
}

describe('MutationBuilder', () => {
  it('basically works', () => {
    const schema = addMutations(`
      type A { id: ID! @rid, b: B }
      type B { x: String }`);
    expect(printMutationTypes(schema)).to.equal(
      `"""Automatically generated mutations"""
type Mutation {
  createA(input: CreateAInput!): CreateAPayload!
  deleteA(input: DeleteAInput!): DeleteAPayload!
  updateA(input: UpdateAInput!): UpdateAPayload!
}
"""Automatically generated input type for Mutation.createA"""
input CreateAInput {
  clientMutationId: String
  b: CreateNestedBInput
}
"""Automatically generated input type for Mutation.createB"""
input CreateNestedBInput {
  x: String
}
"""Automatically generated output type for Mutation.createA"""
type CreateAPayload {
  clientMutationId: String
  a: A!
}
type A {
  id: ID! @rid
  b: B
}
type B {
  x: String
}
"""Automatically generated input type for Mutation.deleteA"""
input DeleteAInput {
  clientMutationId: String
  id: ID! @ridRef(type: "A")
}
"""Automatically generated output type for Mutation.deleteA"""
type DeleteAPayload {
  clientMutationId: String
  deleted: Boolean!
}
"""Automatically generated input type for Mutation.updateA"""
input UpdateAInput {
  clientMutationId: String
  id: ID! @ridRef(type: "A")
  b: UpdateNestedBInput
}
"""Automatically generated input type for Mutation.updateB"""
input UpdateNestedBInput {
  x: String
}
"""Automatically generated output type for Mutation.updateA"""
type UpdateAPayload {
  clientMutationId: String
  a: A!
}`
    );
  });
  it('handles connections', () => {
    const schema = addMutations(`
    type Event {
      id: ID! @rid
      categories(
        first: Int
        after: String
        last: Int
        before: String
      ): EventCategoryConnection! @newManyToMany(tableName: "event_categories", tableKeys: [{ columns: ["event_category_id"] }])
    }

    type EventCategory {
      id: ID! @wkid(maxLength: 60)
      parent: EventCategory @immutable
      name: String! @length(max: 40) @unique
      description: String
    }
        
    type EventCategoryEdge {
      cursor: String!
      node: EventCategory!
      inferred: Boolean! @generatedDefault
    }
    
    type EventCategoryConnection {
      edges: [EventCategoryEdge!]!
      nodes: [EventCategory!]!
      totalCount: Int!
    }`);
    expect(printMutationTypes(schema)).to.equal(
      `"""Automatically generated mutations"""
type Mutation {
  createEvent(input: CreateEventInput!): CreateEventPayload!
  createEventCategory(input: CreateEventCategoryInput!): CreateEventCategoryPayload!
  deleteEvent(input: DeleteEventInput!): DeleteEventPayload!
  deleteEventCategory(input: DeleteEventCategoryInput!): DeleteEventCategoryPayload!
  updateEvent(input: UpdateEventInput!): UpdateEventPayload!
  updateEventCategory(input: UpdateEventCategoryInput!): UpdateEventCategoryPayload!
}
"""Automatically generated input type for Mutation.createEvent"""
input CreateEventInput {
  clientMutationId: String
  categoryIds: [ID!] @wkidRef(maxLength: 60, type: "EventCategory")
}
"""Automatically generated output type for Mutation.createEvent"""
type CreateEventPayload {
  clientMutationId: String
  event: Event!
}
type Event {
  id: ID! @rid
  categories(first: Int, after: String, last: Int, before: String): EventCategoryConnection! @newManyToMany(tableName: "event_categories", tableKeys: [{columns: ["event_category_id"]}])
}
type EventCategoryConnection {
  edges: [EventCategoryEdge!]!
  nodes: [EventCategory!]!
  totalCount: Int!
}
type EventCategoryEdge {
  cursor: String!
  node: EventCategory!
  inferred: Boolean! @generatedDefault
}
type EventCategory {
  id: ID! @wkid(maxLength: 60)
  parent: EventCategory @immutable
  name: String! @length(max: 40) @unique
  description: String
}
"""Automatically generated input type for Mutation.createEventCategory"""
input CreateEventCategoryInput {
  clientMutationId: String
  id: ID! @wkid(maxLength: 60)
  parentId: ID @wkidRef(maxLength: 60, type: "EventCategory")
  name: String!
  description: String
}
"""Automatically generated output type for Mutation.createEventCategory"""
type CreateEventCategoryPayload {
  clientMutationId: String
  eventCategory: EventCategory!
}
"""Automatically generated input type for Mutation.deleteEvent"""
input DeleteEventInput {
  clientMutationId: String
  id: ID! @ridRef(type: "Event")
}
"""Automatically generated output type for Mutation.deleteEvent"""
type DeleteEventPayload {
  clientMutationId: String
  deleted: Boolean!
}
"""Automatically generated input type for Mutation.deleteEventCategory"""
input DeleteEventCategoryInput {
  clientMutationId: String
  id: ID! @wkidRef(maxLength: 60, type: "EventCategory")
}
"""Automatically generated output type for Mutation.deleteEventCategory"""
type DeleteEventCategoryPayload {
  clientMutationId: String
  deleted: Boolean!
}
"""Automatically generated input type for Mutation.updateEvent"""
input UpdateEventInput {
  clientMutationId: String
  id: ID! @ridRef(type: "Event")
  categoryIds: [ID!] @wkidRef(maxLength: 60, type: "EventCategory")
}
"""Automatically generated output type for Mutation.updateEvent"""
type UpdateEventPayload {
  clientMutationId: String
  event: Event!
}
"""Automatically generated input type for Mutation.updateEventCategory"""
input UpdateEventCategoryInput {
  clientMutationId: String
  id: ID! @wkidRef(maxLength: 60, type: "EventCategory")
  name: String
  description: String
}
"""Automatically generated output type for Mutation.updateEventCategory"""
type UpdateEventCategoryPayload {
  clientMutationId: String
  eventCategory: EventCategory!
}`
    );
  });
});
