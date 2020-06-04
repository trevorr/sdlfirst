import { flags } from '@oclif/command';
import { OutputFlags } from '@oclif/parser';
import * as Diff from 'diff';
import fs from 'fs';
import path from 'path';
import CodegenCommand, { defaultBaseline } from '../CodegenCommand';
import { defaultConfig } from '../config/PathConfig';

const defaultOutput = '.';
const encoding = 'utf8';
const newExtension = '.new';
const patchExtension = '.patch';
const maxContext = 3;
const minContext = 1;

export default class Patch extends CodegenCommand {
  static description = 'patch generated source relative to baseline';

  static examples = [
    `$ sdlfirst patch
42 baseline source files written to ${defaultBaseline}
`,
  ];

  static flags = {
    ...CodegenCommand.flags,
    output: flags.string({
      char: 'o',
      description: 'output directory',
      default: defaultOutput,
    }),
  };

  static args = CodegenCommand.args;

  async run(): Promise<void> {
    const { baseline, output } = this.parsedFlags as OutputFlags<typeof Patch.flags>;

    this.outputConfig.sdlTypesFile = prependExtension(defaultConfig.sdlTypesFile, newExtension);
    this.outputConfig.sqlExtension = newExtension + defaultConfig.sqlExtension;
    this.outputConfig.typescriptExtension = newExtension + defaultConfig.typescriptExtension;

    const files = await this.codegen();

    let newCount = 0;
    let unchangedCount = 0;
    let patchedCount = 0;
    let failedCount = 0;
    let baselessCount = 0;
    for (const newFile of files) {
      const newStr = fs.readFileSync(newFile, { encoding });
      const oldFile = removeExtension(newFile, newExtension);
      const targetFile = path.resolve(output, path.relative(baseline, oldFile));
      if (!fs.existsSync(targetFile)) {
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        fs.writeFileSync(targetFile, newStr, { encoding });
        ++newCount;
      } else if (fs.existsSync(oldFile)) {
        const oldStr = fs.readFileSync(oldFile, { encoding });
        if (oldStr === newStr) {
          ++unchangedCount;
        } else {
          const oldTargetStr = fs.readFileSync(targetFile, { encoding });
          let context = maxContext;
          const patchStr = Diff.createPatch(targetFile, oldStr, newStr, undefined, undefined, { context });
          let fuzzPatch = patchStr;
          let fuzzFactor = 0;
          let newTargetStr;
          for (;;) {
            // jsdiff's "fuzzFactor" is fairly useless so reduce the context amount instead (like GNU patch)
            newTargetStr = Diff.applyPatch(oldTargetStr, fuzzPatch);
            if (newTargetStr || context <= minContext) break;
            --context;
            ++fuzzFactor;
            fuzzPatch = Diff.createPatch(targetFile, oldStr, newStr, undefined, undefined, { context });
          }
          if (newTargetStr) {
            fs.writeFileSync(targetFile, newTargetStr, { encoding });
            ++patchedCount;
            if (fuzzFactor > 0) {
              this.log(`Patched ${targetFile} with fuzz factor ${fuzzFactor}`);
            }
          } else {
            const patchFile = targetFile + patchExtension;
            fs.writeFileSync(patchFile, patchStr, { encoding });
            ++failedCount;
            this.warn(`Failed to patch ${targetFile}; patch saved as ${patchFile}`);
          }
        }
      } else {
        ++baselessCount;
        this.warn(`No baseline for ${targetFile}; compare manually against ${newFile}`);
      }
      fs.renameSync(newFile, oldFile);
    }
    this.log(
      `Patch completed: ${patchedCount} patched, ${newCount} new, ${unchangedCount} unchanged, ${
        failedCount + baselessCount
      } failed`
    );
  }
}

function prependExtension(name: string, extPrefix: string): string {
  const ext = path.extname(name);
  return name.substring(0, name.length - ext.length) + extPrefix + ext;
}

function removeExtension(name: string, extPrefix: string): string {
  const ext = path.extname(name);
  const base = name.substring(0, name.length - ext.length);
  if (ext === extPrefix) {
    return base;
  }
  const ext2 = path.extname(base);
  if (ext2 !== extPrefix) {
    throw new Error(`Extension prefix "${extPrefix}" expected in "${name}"`);
  }
  return base.substring(0, base.length - ext2.length) + ext;
}
