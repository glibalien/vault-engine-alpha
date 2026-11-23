import { type App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type VaultEnginePlugin from './main.js';
import { connectEngine } from './engine/transport.js';
import { makeEngineClient } from './engine/client.js';
import { SEARCH_MODES, type SearchMode } from './search/search.js';

export class VaultSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: VaultEnginePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Engine URL')
      .setDesc('The Vault Engine MCP endpoint (ends in /mcp).')
      .addText((t) =>
        t
          .setPlaceholder('http://localhost:3334/mcp')
          .setValue(this.plugin.settings.engineUrl)
          .onChange(async (v) => {
            this.plugin.settings.engineUrl = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Bearer token')
      .setDesc('A service token (issue-service-token.ts --name obsidian-plugin).')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('paste token')
          .setValue(this.plugin.settings.token)
          .onChange(async (v) => {
            this.plugin.settings.token = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Curator URL')
      .setDesc('The Vault Curator MCP endpoint (ends in /mcp). Leave the token blank to disable curator tools.')
      .addText((t) =>
        t
          .setPlaceholder('http://localhost:3335/mcp')
          .setValue(this.plugin.settings.curatorUrl)
          .onChange(async (v) => {
            this.plugin.settings.curatorUrl = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Curator token (optional)')
      .setDesc('A curator service token (issue-service-token.ts --name vault-obsidian --scope curate:read,curate:trigger). Blank = curator tools off.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('paste curator token')
          .setValue(this.plugin.settings.curatorToken)
          .onChange(async (v) => {
            this.plugin.settings.curatorToken = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Fireworks API key')
      .setDesc('Used for chat (same key the vault-chat server uses). Keys are read when a chat leaf opens — close and reopen the chat pane after changing them.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('paste Fireworks API key')
          .setValue(this.plugin.settings.fireworksApiKey)
          .onChange(async (v) => {
            this.plugin.settings.fireworksApiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Anthropic API key')
      .setDesc('Optional — enables Claude models in the chat model picker. Keys are read when a chat leaf opens — close and reopen the chat pane after changing them.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('paste Anthropic API key')
          .setValue(this.plugin.settings.anthropicApiKey)
          .onChange(async (v) => {
            this.plugin.settings.anthropicApiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('OpenRouter API key')
      .setDesc('Optional — enables OpenRouter-routed models in the chat model picker (discover them via the "Discover models" command). Keys are read when a chat leaf opens — close and reopen the chat pane after changing them.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('paste OpenRouter API key')
          .setValue(this.plugin.settings.openrouterApiKey)
          .onChange(async (v) => {
            this.plugin.settings.openrouterApiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('OpenAI API key')
      .setDesc('Optional — enables OpenAI models in the chat model picker. Keys are read when a chat leaf opens — close and reopen the chat pane after changing them.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('paste OpenAI API key')
          .setValue(this.plugin.settings.openaiApiKey)
          .onChange(async (v) => {
            this.plugin.settings.openaiApiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Default search mode')
      .setDesc('Ranking lane used by the vault search modal.')
      .addDropdown((d) => {
        for (const { value, label } of SEARCH_MODES) d.addOption(value, label);
        d.setValue(this.plugin.settings.searchMode).onChange(async (v) => {
          this.plugin.settings.searchMode = v as SearchMode;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Calls vault-stats and reports the node count.')
      .addButton((b) =>
        b
          .setButtonText('Test connection')
          .setCta()
          .onClick(async () => {
            b.setDisabled(true);
            let conn;
            try {
              conn = await connectEngine(this.plugin.settings.engineUrl, this.plugin.settings.token);
              const env = await makeEngineClient(conn.call).vaultStats();
              new Notice(env.ok ? `✓ connected — ${env.data?.node_count ?? '?'} nodes` : `✗ ${env.error?.message ?? 'failed'}`);
            } catch (e) {
              new Notice(`✗ ${e instanceof Error ? e.message : String(e)}`);
            } finally {
              await conn?.close().catch(() => {});
              b.setDisabled(false);
            }
          }),
      );
  }
}
