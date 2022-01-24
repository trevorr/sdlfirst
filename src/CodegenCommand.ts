import { GraphQLFileLoader } from '@graphql-tools/graphql-file-loader';
import { loadSchema } from '@graphql-tools/load';
import { Command, flags } from '@oclif/command';
import { Input, OutputArgs, OutputFlags } from '@oclif/parser';
import { GraphQLSchema } from 'graphql';
import { dirname, join } from 'path';
import SDLFirst from '.';
import { PathConfig } from './config/PathConfig';
import { SqlResolverConfig } from './SqlResolverWriter';

export const defaultBaseline = '.sdlfirst';

export default abstract class CodegenCommand extends Command {
  static flags = {
    help: flags.help({ char: 'h' }),
    baseline: flags.string({
      char: 'b',
      description: 'baseline directory',
      default: defaultBaseline,
    }),
    'context-type': flags.string({
      description: 'resolver context type',
      default: 'SqlResolverContext',
    }),
    'context-module': flags.string({
      description: 'resolver context module',
      default: 'gqlsql',
    }),
  };

  static args = [{ name: 'file', required: true }];

  protected parsedArgs?: OutputArgs;
  protected parsedFlags?: OutputFlags<typeof CodegenCommand.flags>;
  protected inputSchema?: GraphQLSchema;
  protected outputConfig: Partial<PathConfig & SqlResolverConfig> = {};

  async init(): Promise<void> {
    const { args, flags } = this.parse(this.constructor as Input<typeof CodegenCommand.flags>);
    this.parsedArgs = args;
    this.parsedFlags = flags;
    const directivesPath = join(dirname(dirname(__dirname)), 'sdl', 'directives.graphql');
    this.inputSchema = await loadSchema([args.file, directivesPath], { loaders: [new GraphQLFileLoader()] });
    this.outputConfig.baseDir = this.parsedFlags.baseline;
    this.outputConfig.contextType = this.parsedFlags['context-type'];
    this.outputConfig.contextTypeModule = this.parsedFlags['context-module'];
  }

  async codegen(): Promise<string[]> {
    const sdlFirst = new SDLFirst(this.inputSchema!);
    const files: string[] = [];
    console.log('Writing types...');
    files.push(...(await sdlFirst.writeTypes(this.outputConfig)));
    console.log('Writing SQL metadata...');
    files.push(...(await sdlFirst.writeSqlMetadata(this.outputConfig)));
    console.log('Writing SQL tables...');
    files.push(...(await sdlFirst.writeSqlTables(this.outputConfig)));
    console.log('Writing enum mappings...');
    files.push(...(await sdlFirst.writeEnumMappings(this.outputConfig)));
    console.log('Writing GraphQL resolvers...');
    files.push(...(await sdlFirst.writeResolvers(this.outputConfig)));
    console.log('Writing field visitors...');
    files.push(...(await sdlFirst.writeFieldVisitors(this.outputConfig)));
    console.log(`Wrote ${files.length} files`);
    return files;
  }
}
