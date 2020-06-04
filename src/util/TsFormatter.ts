import prettier from 'prettier';

export interface TsFormatterConfig {
  usePrettier: boolean;
  prettierOptions?: prettier.Options;
}

export const defaultConfig: TsFormatterConfig = {
  usePrettier: true,
};

export class TsFormatter {
  private readonly config: TsFormatterConfig;
  private prettierOptions?: prettier.Options;
  private prettierOptionsResolved: boolean;

  constructor(config?: Partial<TsFormatterConfig>) {
    this.config = Object.assign({}, defaultConfig, config);
    this.prettierOptions = this.config.prettierOptions;
    this.prettierOptionsResolved = this.prettierOptions != null;
  }

  public async format(source: string, path: string): Promise<string> {
    if (this.config.usePrettier) {
      if (!this.prettierOptionsResolved) {
        this.prettierOptionsResolved = true;
        const options = await prettier.resolveConfig(path);
        if (options != null) {
          this.prettierOptions = options;
        }
      }
      source = prettier.format(source, { ...this.prettierOptions, filepath: path });
    }
    return source;
  }
}
