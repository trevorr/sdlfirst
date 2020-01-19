# SDL-first GraphQL Service Tools

Tools for building GraphQL services starting from a schema specified in SDL.

<!-- toc -->
* [SDL-first GraphQL Service Tools](#sdl-first-graphql-service-tools)
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->
# Usage
<!-- usage -->
```sh-session
$ npm install -g sdlfirst
$ sdlfirst COMMAND
running command...
$ sdlfirst (-v|--version|version)
sdlfirst/0.0.1 darwin-x64 node-v12.7.0
$ sdlfirst --help [COMMAND]
USAGE
  $ sdlfirst COMMAND
...
```
<!-- usagestop -->
# Commands
<!-- commands -->
* [`sdlfirst augment FILE`](#sdlfirst-augment-file)
* [`sdlfirst baseline FILE`](#sdlfirst-baseline-file)
* [`sdlfirst help [COMMAND]`](#sdlfirst-help-command)
* [`sdlfirst patch FILE`](#sdlfirst-patch-file)
* [`sdlfirst types FILE`](#sdlfirst-types-file)

## `sdlfirst augment FILE`

output augmented SDL schema

```
USAGE
  $ sdlfirst augment FILE

OPTIONS
  -h, --help           show CLI help
  -o, --output=output  [default: genschema/schema.graphql] output filename

EXAMPLE
  $ sdlfirst augment schema/schema.graphql
  Augmented schema written to genschema/schema.graphql
```

_See code: [dist/commands/augment.js](https://github.com/trevorr/sdlfirst/blob/v0.0.1/dist/commands/augment.js)_

## `sdlfirst baseline FILE`

output baseline generated source from SDL schema

```
USAGE
  $ sdlfirst baseline FILE

OPTIONS
  -b, --baseline=baseline          [default: .sdlfirst] baseline directory
  -h, --help                       show CLI help
  --context-module=context-module  [default: gqlsql] resolver context module
  --context-type=context-type      [default: SqlResolverContext] resolver context type

EXAMPLE
  $ sdlfirst baseline
  42 baseline source files written to .sdlfirst
```

_See code: [dist/commands/baseline.js](https://github.com/trevorr/sdlfirst/blob/v0.0.1/dist/commands/baseline.js)_

## `sdlfirst help [COMMAND]`

display help for sdlfirst

```
USAGE
  $ sdlfirst help [COMMAND]

ARGUMENTS
  COMMAND  command to show help for

OPTIONS
  --all  see all commands in CLI
```

_See code: [@oclif/plugin-help](https://github.com/oclif/plugin-help/blob/v2.2.3/src/commands/help.ts)_

## `sdlfirst patch FILE`

patch generated source relative to baseline

```
USAGE
  $ sdlfirst patch FILE

OPTIONS
  -b, --baseline=baseline          [default: .sdlfirst] baseline directory
  -h, --help                       show CLI help
  -o, --output=output              [default: .] output directory
  --context-module=context-module  [default: gqlsql] resolver context module
  --context-type=context-type      [default: SqlResolverContext] resolver context type

EXAMPLE
  $ sdlfirst patch
  42 baseline source files written to .sdlfirst
```

_See code: [dist/commands/patch.js](https://github.com/trevorr/sdlfirst/blob/v0.0.1/dist/commands/patch.js)_

## `sdlfirst types FILE`

output type definitions from SDL schema

```
USAGE
  $ sdlfirst types FILE

OPTIONS
  -h, --help           show CLI help
  -o, --output=output  [default: types/index.ts] output filename

EXAMPLE
  $ sdlfirst types schema/schema.graphql
  Type definitions written to types/index.ts
```

_See code: [dist/commands/types.js](https://github.com/trevorr/sdlfirst/blob/v0.0.1/dist/commands/types.js)_
<!-- commandsstop -->

## License

`sdlfirst` is available under the [ISC license](LICENSE).
