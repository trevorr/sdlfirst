import { Command, flags } from '@oclif/command';
import { buildASTSchema } from 'graphql';
import { basename, dirname, join } from 'path';
import SDLFirst from '..';
import { PathConfig, defaultConfig } from '../config/PathConfig';
import { loadSchema } from '../loadSchema';

const defaultOutput = join(defaultConfig.baseDir, defaultConfig.sdlTypesDir, defaultConfig.sdlTypesFile);

export default class Types extends Command {
  static description = 'output type definitions from SDL schema';

  static examples = [
    `$ sdlfirst types schema/schema.graphql
Type definitions written to ${defaultOutput}
`,
  ];

  static flags = {
    help: flags.help({ char: 'h' }),
    output: flags.string({
      char: 'o',
      description: 'output filename',
      default: defaultOutput,
    }),
  };

  static args = [{ name: 'file', required: true }];

  async run(): Promise<void> {
    try {
      const {
        args,
        flags: { output },
      } = this.parse(Types);
      const directivesPath = join(dirname(dirname(__dirname)), 'sdl', 'directives.graphql');
      const schemaAst = await loadSchema([args.file, directivesPath]);
      const inputSchema = buildASTSchema(schemaAst);
      const config: Partial<PathConfig> = {};
      if (output) {
        config.sdlTypesDir = dirname(output);
        config.sdlTypesFile = basename(output);
      }
      const sdlFirst = new SDLFirst(inputSchema);
      sdlFirst.writeTypes(config);
      this.log(`Type definitions written to ${output}`);
    } catch (e) {
      console.error(e);
    }
  }
}
