import * as vscode from "vscode";
import { ProposalStore } from "./proposals.js";
/** Capture selection before opening input; never changes focus until user invokes command. */
export function registerInline(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand("fakefoundy.inline",async()=>{
    const editor=vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage("Select the code to edit first."); return;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage("Trust this workspace before running FakeFoundy."); return;
    }
    const folder=vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder || folder.uri.toString() !== vscode.workspace.workspaceFolders?.[0]?.uri.toString()) {
      void vscode.window.showErrorMessage("Inline editing supports files in the first workspace folder only."); return;
    }
    const file=vscode.workspace.asRelativePath(editor.document.uri,false);
    const {document, selection} = editor;
    const captured = {start: document.offsetAt(selection.start), document: document.getText()};
    const selected = document.getText(selection);
    const line = selection.start.line + 1;
    let saved: string;
    try {
      saved = await new ProposalStore(folder.uri.fsPath).read(file);
    } catch {
      void vscode.window.showErrorMessage("This file is protected, outside the workspace, or unsupported for inline editing."); return;
    }
    if (saved !== captured.document) {
      void vscode.window.showErrorMessage("Save the file before requesting an inline edit."); return;
    }
    if (Buffer.byteLength(selected)>16000 || selected.split("\n").length>200) {
      void vscode.window.showErrorMessage("Select a smaller region (up to 16 KB and 200 lines) for inline editing."); return;
    }
    const instruction=await vscode.window.showInputBox({prompt:"How should FakeFoundy edit the selected code?"});
    if (!instruction?.trim()) return;
    await vscode.commands.executeCommand("fakefoundy.start", instruction, {path:file, oldText:selected, selection:captured}, line);
  }));
}
