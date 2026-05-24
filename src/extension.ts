import * as vscode from 'vscode';
import { DbMonitorEditorProvider, MonitorPanel, openDbFileInMonitor } from './monitorPanel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      DbMonitorEditorProvider.viewType,
      new DbMonitorEditorProvider(context),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    ),
    vscode.commands.registerCommand('s7DbMonitor.openMonitor', () => {
      MonitorPanel.createOrShow(context);
    }),
    vscode.commands.registerCommand('s7DbMonitor.openDbFile', async (uri?: vscode.Uri) => {
      await openDbFileInMonitor(context, uri);
    })
  );
}

export function deactivate(): void {
  MonitorPanel.current?.dispose();
}
