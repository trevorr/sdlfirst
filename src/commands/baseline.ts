import CodegenCommand, { defaultBaseline } from '../CodegenCommand';

export default class Baseline extends CodegenCommand {
  static description = 'output baseline generated source from SDL schema';

  static examples = [
    `$ sdlfirst baseline
42 baseline source files written to ${defaultBaseline}
`,
  ];

  static flags = CodegenCommand.flags;

  static args = CodegenCommand.args;

  async run(): Promise<void> {
    const files = await this.codegen();
    this.log(`${files.length} baseline source files written to ${this.parsedFlags!.baseline}`);
  }
}
