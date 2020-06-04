import { Command, flags } from '@oclif/command';
import { buildASTSchema, parse } from 'graphql';
import { importSchema } from 'graphql-import';
import { basename, dirname, join } from 'path';
import SDLFirst from '..';
import { defaultConfig, PathConfig } from '../config/PathConfig';

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
    const {
      args,
      flags: { output },
    } = this.parse(Types);
    const inputSource = importSchema(args.file);
    const inputAst = parse(inputSource);
    const inputSchema = buildASTSchema(inputAst);
    const config: Partial<PathConfig> = {};
    if (output) {
      config.sdlTypesDir = dirname(output);
      config.sdlTypesFile = basename(output);
    }
    const sdlFirst = new SDLFirst(inputSchema);
    sdlFirst.writeTypes(config, inputAst);
    this.log(`Type definitions written to ${output}`);
  }
}
