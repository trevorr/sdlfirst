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
  """Creates a new A object"""
  createA(
    """Input object containing the field values for the new object"""
    input: CreateAInput!
  ): CreateAPayload!

  """Deletes an existing A object"""
  deleteA(
    """Input object containing the ID of the object to delete"""
    input: DeleteAInput!
  ): DeleteAPayload!

  """Updates an existing A object"""
  updateA(
    """
    Input object containing the ID of the object to update and the new field values
    """
    input: UpdateAInput!
  ): UpdateAPayload!
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
  """The arbitrary client identifier provided in the mutation input object"""
  clientMutationId: String

  """The newly created A object"""
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
  """The arbitrary client identifier provided in the mutation input object"""
  clientMutationId: String

  """
  Indicates whether an object with the given identifier was found and deleted
  """
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
  """The arbitrary client identifier provided in the mutation input object"""
  clientMutationId: String

  """The updated A object"""
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
      createdAt: Int! @createdAt
    }
    
    type EventCategoryConnection {
      edges: [EventCategoryEdge!]!
      nodes: [EventCategory!]!
      totalCount: Int!
    }`);
    expect(printMutationTypes(schema)).to.equal(
      `"""Automatically generated mutations"""
type Mutation {
  """Creates a new Event object"""
  createEvent(
    """Input object containing the field values for the new object"""
    input: CreateEventInput!
  ): CreateEventPayload!

  """Creates a new EventCategory object"""
  createEventCategory(
    """Input object containing the field values for the new object"""
    input: CreateEventCategoryInput!
  ): CreateEventCategoryPayload!

  """Deletes an existing Event object"""
  deleteEvent(
    """Input object containing the ID of the object to delete"""
    input: DeleteEventInput!
  ): DeleteEventPayload!

  """Deletes an existing EventCategory object"""
  deleteEventCategory(
    """Input object containing the ID of the object to delete"""
    input: DeleteEventCategoryInput!
  ): DeleteEventCategoryPayload!

  """Updates an existing Event object"""
  updateEvent(
    """
    Input object containing the ID of the object to update and the new field values
    """
    input: UpdateEventInput!
  ): UpdateEventPayload!

  """Updates an existing EventCategory object"""
  updateEventCategory(
    """
    Input object containing the ID of the object to update and the new field values
    """
    input: UpdateEventCategoryInput!
  ): UpdateEventCategoryPayload!
}
"""Automatically generated input type for Mutation.createEvent"""
input CreateEventInput {
  clientMutationId: String
  categories: [CreateEventCategoryEdgeInput!]
  categoryIds: [ID!] @wkidRef(maxLength: 60, type: "EventCategory")
}
"""Automatically generated input type for EventCategoryEdge"""
input CreateEventCategoryEdgeInput {
  id: ID! @wkidRef(maxLength: 60, type: "EventCategory")
  inferred: Boolean
}
"""Automatically generated output type for Mutation.createEvent"""
type CreateEventPayload {
  """The arbitrary client identifier provided in the mutation input object"""
  clientMutationId: String

  """The newly created Event object"""
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
  createdAt: Int! @createdAt
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
  """The arbitrary client identifier provided in the mutation input object"""
  clientMutationId: String

  """The newly created EventCategory object"""
  eventCategory: EventCategory!
}
"""Automatically generated input type for Mutation.deleteEvent"""
input DeleteEventInput {
  clientMutationId: String
  id: ID! @ridRef(type: "Event")
}
"""Automatically generated output type for Mutation.deleteEvent"""
type DeleteEventPayload {
  """The arbitrary client identifier provided in the mutation input object"""
  clientMutationId: String

  """
  Indicates whether an object with the given identifier was found and deleted
  """
  deleted: Boolean!
}
"""Automatically generated input type for Mutation.deleteEventCategory"""
input DeleteEventCategoryInput {
  clientMutationId: String
  id: ID! @wkidRef(maxLength: 60, type: "EventCategory")
}
"""Automatically generated output type for Mutation.deleteEventCategory"""
type DeleteEventCategoryPayload {
  """The arbitrary client identifier provided in the mutation input object"""
  clientMutationId: String

  """
  Indicates whether an object with the given identifier was found and deleted
  """
  deleted: Boolean!
}
"""Automatically generated input type for Mutation.updateEvent"""
input UpdateEventInput {
  clientMutationId: String
  id: ID! @ridRef(type: "Event")
  categories: [CreateEventCategoryEdgeInput!]
  categoryIds: [ID!] @wkidRef(maxLength: 60, type: "EventCategory")
}
"""Automatically generated output type for Mutation.updateEvent"""
type UpdateEventPayload {
  """The arbitrary client identifier provided in the mutation input object"""
  clientMutationId: String

  """The updated Event object"""
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
  """The arbitrary client identifier provided in the mutation input object"""
  clientMutationId: String

  """The updated EventCategory object"""
  eventCategory: EventCategory!
}`
    );
  });
});
