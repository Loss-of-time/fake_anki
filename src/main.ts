import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import * as http from "http";

interface AnkiToObsidianSettings {
  port: number;
  targetFile: string;
}

const DEFAULT_SETTINGS: AnkiToObsidianSettings = {
  port: 8766,
  targetFile: "anki-cards.md",
};

export default class AnkiToObsidianPlugin extends Plugin {
  settings: AnkiToObsidianSettings;
  server: http.Server | null = null;

  async onload() {
    await this.loadSettings();
    this.startServer();
    this.addSettingTab(new AnkiToObsidianSettingTab(this.app, this));
  }

  onunload() {
    this.server?.close();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  startServer() {
    this.server = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      if (req.method === "OPTIONS") {
        // ponytail: preflight, needed for browser-side callers
        res.writeHead(204);
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        const reply = (result: unknown, error: string | null) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result, error }));
        };
        try {
          const { action, params } = JSON.parse(body);
          if (action === "version") {
            reply(6, null);
          } else if (action === "addNote") {
            const fields = params?.note?.fields ?? {};
            const text = Object.values(fields).join("\n\n") + "\n\n---\n\n";
            await this.appendToFile(text);
            reply(Date.now(), null);
          } else {
            reply(null, "unsupported action");
          }
        } catch (e) {
          reply(null, String((e as Error)?.message ?? e));
        }
      });
    });
    this.server.on("error", (e) => console.error("anki-to-obsidian:", e));
    this.server.listen(this.settings.port, "127.0.0.1");
  }

  restartServer() {
    // ponytail: close waits for idle connections; fine for a local single-user server
    if (this.server) this.server.close(() => this.startServer());
    else this.startServer();
  }

  async appendToFile(text: string) {
    const path = this.settings.targetFile;
    if (!(await this.app.vault.adapter.exists(path))) {
      await this.app.vault.create(path, "");
    }
    await this.app.vault.adapter.append(path, text);
  }
}

class AnkiToObsidianSettingTab extends PluginSettingTab {
  plugin: AnkiToObsidianPlugin;

  constructor(app: App, plugin: AnkiToObsidianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Port")
      .setDesc("Listen on 127.0.0.1:<port>. Changing it restarts the server.")
      .addText((text) =>
        text
          .setPlaceholder("8766")
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            const port = parseInt(value, 10);
            if (isNaN(port)) return;
            this.plugin.settings.port = port;
            await this.plugin.saveSettings();
            this.plugin.restartServer();
          })
      );

    new Setting(containerEl)
      .setName("Target file")
      .setDesc("Vault-relative path that cards are appended to (created if missing).")
      .addText((text) =>
        text
          .setPlaceholder("anki-cards.md")
          .setValue(this.plugin.settings.targetFile)
          .onChange(async (value) => {
            this.plugin.settings.targetFile = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
