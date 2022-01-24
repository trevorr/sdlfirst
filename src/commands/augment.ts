import { GraphQLFileLoader } from '@graphql-tools/graphql-file-loader';
import { loadSchema } from '@graphql-tools/load';
import { Command, flags } from '@oclif/command';
import { basename, dirname, join } from 'path';
import SDLFirst from '..';
import { defaultConfig, PathConfig } from '../config/PathConfig';

const defaultOutput = join(defaultConfig.baseDir, defaultConfig.sdlOutputDir, defaultConfig.sdlOutputFile);

export default class Augment extends Command {
  static description = 'output augmented SDL schema';

  static examples = [
    `$ sdlfirst augment schema/schema.graphql
Augmented schema written to ${defaultOutput}
`,
  ];

  static flags = {
    help: flags.help({ char: 'h' }),
    output: flags.string({
      char: 'o',
      description: 'output filename',
      default: defaultOutput,
    }),
    audience: flags.string({
      char: 'a',
      description: 'target audience',
    }),
  };

  static args = [{ name: 'file', required: true }];

  async run(): Promise<void> {
    try {
      const {
        args,
        flags: { output, audience },
      } = this.parse(Augment);
      const directivesPath = join(dirname(dirname(__dirname)), 'sdl', 'directives.graphql');
      const inputSchema = await loadSchema([args.file, directivesPath], { loaders: [new GraphQLFileLoader()] });
      const config: Partial<PathConfig> = {};
      if (output) {
        config.sdlOutputDir = dirname(output);
        config.sdlOutputFile = basename(output);
      }
      const sdlFirst = new SDLFirst(inputSchema);
      if (audience) {
        sdlFirst.filterAudience(audience);
      }
      sdlFirst.addMutations();
      if (!audience || audience === 'internal') {
        sdlFirst.addInternalIds();
      }
      sdlFirst.writeSchema(config);
      this.log(`Augmented schema written to ${output}`);
    } catch (e) {
      console.error(e);
    }
  }
}
