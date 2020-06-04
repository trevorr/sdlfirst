import { Command, flags } from '@oclif/command';
import { buildASTSchema, parse } from 'graphql';
import { importSchema } from 'graphql-import';
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
  };

  static args = [{ name: 'file', required: true }];

  async run(): Promise<void> {
    const {
      args,
      flags: { output },
    } = this.parse(Augment);
    const inputSource = importSchema(args.file);
    const inputAst = parse(inputSource);
    const inputSchema = buildASTSchema(inputAst);
    const config: Partial<PathConfig> = {};
    if (output) {
      config.sdlOutputDir = dirname(output);
      config.sdlOutputFile = basename(output);
    }
    const sdlFirst = new SDLFirst(inputSchema);
    sdlFirst.addMutations();
    sdlFirst.writeSchema(config);
    this.log(`Augmented schema written to ${output}`);
  }
}
