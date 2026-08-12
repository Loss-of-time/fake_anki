// obsidian 模块的最小 mock：让 main.ts 能在 node 环境里被测试
// 通过 esbuild alias 注入（见 scripts/run-tests.mjs）

export class Plugin {
  app: { vault: { adapter: unknown } };
  constructor(app: { vault: { adapter: unknown } }) {
    this.app = app;
  }
  async loadData(): Promise<unknown> {
    return {};
  }
  async saveData(): Promise<void> {}
  addSettingTab(): void {}
  addCommand(): void {}
}

export class Notice {
  static messages: string[] = [];
  static reset(): void {
    Notice.messages = [];
  }
  constructor(message: string) {
    Notice.messages.push(message);
  }
}

export class PluginSettingTab {
  constructor(_app: unknown, _plugin: unknown) {}
}

export class Setting {
  constructor(_containerEl: unknown) {}
}

export class App {}
