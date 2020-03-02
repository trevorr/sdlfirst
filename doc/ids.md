# Identifiers

This document describes the various types of identifiers (IDs) supported by this project.
Among them, the broadest distinction is internal versus external identifiers.

## Internal identifiers

Internal identifiers are used by the database and the implementation of the GraphQL API.
They are never directly exposed to consumers of the API. Currently, internal IDs are always
auto-increment integers, usually 32 bits wide and unsigned. Smaller integers can be used as
an optimization for small tables, such as enumerations, and larger can be used for tables
expected to have a high rate of inserts. Because they are compact and ordered, auto-increment
integers have the best performance for primary keys and their associated clustered indexes
in a relational database. They make joins as efficient as possible by keeping indexes compact
and preserving temporal locality.

## External identifiers

While auto-increment integers are great as internal IDs, they have several drawbacks when
exposed externally, such as through a public API:

* They leak information that can help hackers or competitors:
  * They reveal roughly how many objects of a given type have been created, such as number of users
  * They reveal the relative age of two objects
  * Valid IDs can be trivially guessed
  * Future IDs can be easily predicted
* They can conflict between environments:
  * Any special IDs that need to be referenced by software, such as enumerations,
    are likely to have different values in development versus production environments
  * If systems need to be merged, distinct objects will have the same IDs
* They are not easily pre-determined in cases that software needs to reference them,
  such as enumerations; changes to seed data scripts must be carefully coordinated
* They don't provide a universally/globally unique identifier, which can be very useful for
  operational concerns like caching and logging

Addressing these issues leads to two types of external IDs: random and well-known.

### Random identifiers

Random identifiers work very well as external IDs for objects that are created dynamically
(and thus rarely end up hard-coded in software), which are most of the objects in a given system.
They reveal no information about the number, age, or other IDs of the associated objects.
When comprised of a sufficient number of bits, they become universally unique and non-conflicting.
The most common example of a random ID is the version 4 UUID (standardized by the Open Software
Foundation). With 122 random bits, the probability of generating two identical values in negligible.

Because the hexadecimal form of a UUID is relatively long and difficult to remember/identify
or select for copy and paste (i.e. a double click generally will not select the whole UUID),
we use a base-62 representation consisting only of numbers and upper- and lower-case Latin letters.
With 122 bits, it is only 21 characters long (as opposed to 36 for a UUID) and much easier
to recognize and copy/paste. While somewhat more computationally expensive to generate than
base-64, base-62 avoids issues with non-alphanumeric characters, which can interfere with
usage in file/URL paths and copy/paste selection.

### Well-known identifiers

The one area where random identifiers are suboptimal is enumerations. Most systems have
enumerations for things like object types, user roles and permissions, categories and tags, etc.
These enumerated values often need to be referenced from software for the system to function,
and therefore are part of the seed data used to initialize the database. Randomizing these
values would needlessly complicate the development, maintenance, and debugging of the system.
For example, the user role ID "super" is much more clear (in source code and in logs) than
an ID like "6JQVieXHwyN780PlgPqh2". Such identifiers are typically called "well-known",
since they are known by and embedded within interoperating systems.

## Type-qualified identifiers

A common requirement of an identifier scheme is the ability to refer uniformly and unambiguously
to any object in the system. This may arise from core functionality like maintaining relations
between heterogeneous objects (e.g. attaching images to various types of objects) or from
operational concerns like caching and logging. While random IDs are usually universally unique
to begin with, one generally needs to know the type/table of the object to look it up.
For this reason, it is useful to have a form of each identifier that includes its type.

### Qualified internal IDs

Within the database, the simplest, most general, and most efficient way to refer to objects of
different types is to include a type discriminator column in additional to the internal ID.
In this system, the type discriminator is assumed to be a short string (e.g. 1-3 alphabetic
characters) that identifies the target table. This string is called the table ID.

### Qualified random IDs

The easiest way to add a type qualifier to a base-62 random ID while preserving the benefits
described above is to prefix it with the table ID separated by an underscore. Because random
IDs are not generally recognizable by value, we always prefer to qualify them externally.
For example, a qualified random ID for a user might be "u_2eCiDho8QesFdykKx7bg9", assuming
"u" is the table ID for the user table.

### Qualified well-known IDs

In most cases, the meaning of well-known IDs should be programmatically clear from context and
easily recognizable by humans even without context. For rare cases when a well-known ID needs to
refer to multiple types of objects, such as generically attaching images to values of various
enumerations, it can be prefixed with a table ID and a colon. For example, the super-user role
might have the qualified well-known ID "rl:super", assuming "rl" is the table ID for the role table.
This implies that well-known IDs cannot otherwise include colons.

## Summary

| Name | Abbreviation | Purpose | Example |
|------|--------------|---------|---------|
| Internal ID | IID | Database primary keys | 1234 |
| External ID | XID | API ID values, either random or well-known | (see below) |
| Random ID | RID | Database unique key for dynamically-created objects | 2eCiDho8QesFdykKx7bg9 |
| Well-known ID | WKID | Database unique key and API ID for enumeration values | super |
| Qualified random ID | QRID | API ID for dynamically-created objects | u_2eCiDho8QesFdykKx7bg9 |
| Qualified well-known ID | QWKID | API ID for enumeration values of mixed type | rl:super |
