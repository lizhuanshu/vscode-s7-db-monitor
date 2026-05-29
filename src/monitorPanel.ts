import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseDbBlocks } from './dbParser';
import { MonitorStatus, ParsedDbBlock, PlcConnectionOptions, VariablePulseRequest, VariableValueUpdate, VariableWriteRequest } from './model';
import { S7Service } from './s7Service';

type WebviewMessage =
  | { type: 'connect'; options: PlcConnectionOptions }
  | { type: 'disconnect' }
  | { type: 'readBlock'; dbId: string }
  | { type: 'setContinuousRead'; dbId: string; enabled: boolean }
  | { type: 'setDbNumber'; dbId: string; number?: number }
  | { type: 'writeVariable'; request: VariableWriteRequest }
  | { type: 'pulseVariable'; request: VariablePulseRequest }
  | { type: 'saveConnectionOptions'; options: PlcConnectionOptions }
  | { type: 'ready' };

interface FileProfile {
  connectionOptions?: PlcConnectionOptions;
  dbNumbers: Record<string, number>;
}

export class MonitorPanel {
  public static current?: MonitorPanel;

  private readonly panel: vscode.WebviewPanel;
  private readonly service = new S7Service();
  private readonly blocks = new Map<string, ParsedDbBlock>();
  private status: MonitorStatus = { state: 'disconnected', message: 'Disconnected' };
  private activeSourcePath?: string;
  private connectionOptions?: PlcConnectionOptions;

  public static createOrShow(context: vscode.ExtensionContext): MonitorPanel {
    if (MonitorPanel.current) {
      MonitorPanel.current.panel.reveal(vscode.ViewColumn.One);
      return MonitorPanel.current;
    }

    MonitorPanel.current = new MonitorPanel(context);
    return MonitorPanel.current;
  }

  public static createForCustomEditor(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): MonitorPanel {
    return new MonitorPanel(context, panel);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    panel?: vscode.WebviewPanel
  ) {
    this.panel = panel ?? vscode.window.createWebviewPanel(
      's7DbMonitor',
      'S7 DB Monitor',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );

    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => {
      this.service.disconnect();
      MonitorPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handleMessage(message));

    this.service.on('status', (status) => {
      this.status = status;
      this.post({ type: 'status', status });
    });
    this.service.on('values', (update) => this.postValues(update));
  }

  public async addDbFile(uri: vscode.Uri): Promise<void> {
    const content = await fs.readFile(uri.fsPath, 'utf8');
    const profile = this.getFileProfile(uri.fsPath);
    const parsedBlocks = parseDbBlocks(content, uri.fsPath);
    const diagnostics: string[] = [];
    for (const parsed of parsedBlocks) {
      const savedNumber = profile.dbNumbers[parsed.name];
      if (savedNumber !== undefined) {
        parsed.number = savedNumber;
      }
      this.blocks.set(parsed.id, parsed);
      diagnostics.push(...parsed.diagnostics.map((item) => `${parsed.name}: ${item}`));
    }
    this.activeSourcePath = uri.fsPath;
    this.connectionOptions = profile.connectionOptions ?? this.connectionOptions ?? this.getDefaultOptions();
    this.service.setBlocks([...this.blocks.values()]);
    this.postState();

    if (diagnostics.length > 0) {
      const preview = diagnostics.slice(0, 3).join(' | ');
      const suffix = diagnostics.length > 3 ? ` | +${diagnostics.length - 3} more` : '';
      void vscode.window.showWarningMessage(`DB parse warning: ${preview}${suffix}`);
    }
  }

  public dispose(): void {
    this.service.disconnect();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.postState();
        break;
      case 'connect':
        await this.connect(message.options);
        break;
      case 'disconnect':
        this.service.disconnect();
        this.postState();
        break;
      case 'readBlock':
        await this.service.readBlockOnce(message.dbId);
        break;
      case 'setContinuousRead':
        this.service.setContinuousRead(message.dbId, message.enabled);
        this.postState();
        break;
      case 'setDbNumber':
        this.setDbNumber(message.dbId, message.number);
        break;
      case 'writeVariable':
        await this.service.writeVariable(message.request);
        break;
      case 'pulseVariable':
        await this.service.pulseBoolVariable(message.request);
        break;
      case 'saveConnectionOptions':
        this.saveConnectionOptions(message.options);
        break;
    }
  }

  private setDbNumber(dbId: string, number?: number): void {
    const block = this.blocks.get(dbId);
    if (!block) {
      return;
    }

    block.number = number;
    this.service.setBlocks([...this.blocks.values()]);
    this.saveDbNumber(block.sourcePath, block.name, number);
    this.postState();
  }

  private async connect(options: PlcConnectionOptions): Promise<void> {
    try {
      this.saveConnectionOptions(options);
      await this.service.connect(options, [...this.blocks.values()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = { state: 'error', message, updatedAt: new Date().toISOString() };
      this.post({ type: 'status', status: this.status });
    }
  }

  private postState(): void {
    this.post({
      type: 'state',
      blocks: [...this.blocks.values()],
      status: this.status,
      options: this.getConnectionOptions(),
      continuousBlockId: this.service.getContinuousBlockId()
    });
  }

  private postValues(update: VariableValueUpdate): void {
    this.post({ type: 'values', update });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private getDefaultOptions(): PlcConnectionOptions {
    const config = vscode.workspace.getConfiguration('s7DbMonitor');
    return {
      host: config.get('defaultHost', '192.168.0.1'),
      rack: config.get('defaultRack', 0),
      slot: config.get('defaultSlot', 1),
      pollIntervalMs: config.get('pollIntervalMs', 1000)
    };
  }

  private getConnectionOptions(): PlcConnectionOptions {
    return this.connectionOptions ?? this.getDefaultOptions();
  }

  private saveConnectionOptions(options: PlcConnectionOptions): void {
    this.connectionOptions = options;
    if (!this.activeSourcePath) {
      return;
    }

    const profile = this.getFileProfile(this.activeSourcePath);
    profile.connectionOptions = options;
    void this.context.workspaceState.update(profileKey(this.activeSourcePath), profile);
  }

  private saveDbNumber(sourcePath: string, blockName: string, number?: number): void {
    const profile = this.getFileProfile(sourcePath);
    if (number === undefined) {
      delete profile.dbNumbers[blockName];
    } else {
      profile.dbNumbers[blockName] = number;
    }
    void this.context.workspaceState.update(profileKey(sourcePath), profile);
  }

  private getFileProfile(sourcePath: string): FileProfile {
    return this.context.workspaceState.get<FileProfile>(profileKey(sourcePath), { dbNumbers: {} });
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'monitor.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'monitor.css'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>S7 DB Monitor</title>
</head>
<body>
  <header class="titlebar">
    <div class="brand">S7 DB Monitor</div>
    <a class="company-link" href="https://www.againdo.com/" title="Open AgainDo website" target="_blank" rel="noopener noreferrer">www.againdo.com</a>
    <label>IP <input id="host" type="text" autocomplete="off"></label>
    <label>Rack <input id="rack" type="number" min="0"></label>
    <label>Slot <input id="slot" type="number" min="0"></label>
    <label>Cycle(ms) <input id="pollIntervalMs" type="number" min="100" step="100"></label>
    <button id="connect">Connect</button>
    <button id="disconnect">Disconnect</button>
  </header>
  <main class="workspace">
    <aside id="sidebar" class="sidebar">
      <div class="sidebar-header">
        <span>DB Blocks</span>
      </div>
      <nav id="tabs" class="db-list"></nav>
    </aside>
    <div id="sidebarResizer" class="sidebar-resizer" title="Resize DB list"></div>
    <section class="db-content">
      <section id="dbInfo" class="db-info"></section>
      <section class="table-wrap">
        <table id="variablesTable">
          <colgroup>
            <col class="column-name">
            <col class="column-type">
            <col class="column-address">
            <col class="column-value">
            <col class="column-comment">
          </colgroup>
          <thead>
            <tr>
              <th data-column-id="name">Name<span class="column-resizer" title="Resize column"></span></th>
              <th data-column-id="type">Type<span class="column-resizer" title="Resize column"></span></th>
              <th data-column-id="address">Address<span class="column-resizer" title="Resize column"></span></th>
              <th data-column-id="value">Value<span class="column-resizer" title="Resize column"></span></th>
              <th data-column-id="comment">Comment<span class="column-resizer" title="Resize column"></span></th>
            </tr>
          </thead>
          <tbody id="variables"></tbody>
        </table>
        <div id="empty" class="empty">Open a .db file to start monitoring.</div>
      </section>
      <section id="variableOps" class="variable-ops"></section>
    </section>
  </main>
  <footer class="statusbar">
    <span id="statusState">Disconnected</span>
    <span id="statusMessage">Waiting</span>
    <span id="statusStats">DB: 0</span>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export async function openDbFileInMonitor(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const panel = MonitorPanel.createOrShow(context);
  if (uri) {
    await panel.addDbFile(uri);
    return;
  }

  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.fsPath && path.extname(active.fsPath).toLowerCase() === '.db') {
    await panel.addDbFile(active);
    return;
  }

  await vscode.commands.executeCommand('s7DbMonitor.openMonitor');
}

export class DbMonitorEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 's7DbMonitor.dbEditor';

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };

    webviewPanel.title = `S7 Monitor: ${path.basename(document.uri.fsPath)}`;
    const panel = MonitorPanel.createForCustomEditor(this.context, webviewPanel);
    await panel.addDbFile(document.uri);
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function profileKey(sourcePath: string): string {
  return `s7DbMonitor.fileProfile:${sourcePath}`;
}
