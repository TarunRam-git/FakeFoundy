import * as vscode from 'vscode';
import { ProposalStore } from './proposals.js';
import { startBridge } from './bridge.js';
import { createClient, runTurn } from './client.js';
export function activate(context:vscode.ExtensionContext) {
  const output=vscode.window.createOutputChannel('FakeFoundy');
  let store:ProposalStore|undefined; let bridge:Awaited<ReturnType<typeof startBridge>>|undefined; let busy=false;
  const previews=new Map<string,string>();
  context.subscriptions.push(output,vscode.workspace.registerTextDocumentContentProvider('fakefoundy-preview',{provideTextDocumentContent:uri=>previews.get(uri.toString())??''}));
  context.subscriptions.push({dispose:()=>{void bridge?.close();}});
  context.subscriptions.push(vscode.commands.registerCommand('fakefoundy.start',async()=>{
    if (!vscode.workspace.isTrusted) {void vscode.window.showErrorMessage('Trust this workspace before running FakeFoundy.');return;}
    if(busy) {void vscode.window.showInformationMessage('A run is already active.');return;}
    const root=vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if(!root) {void vscode.window.showErrorMessage('Open a workspace folder first.');return;}
    const prompt=await vscode.window.showInputBox({prompt:'Ask the TrueForge agent to read a file and propose an edit'});
    if(!prompt) return;
    busy=true;
    try {
      const config=vscode.workspace.getConfiguration('fakefoundy');
      if(!store) store=new ProposalStore(root);
      if(!bridge) bridge=await startBridge(store,config.get<number>('mcpPort',31337));
      const client=await createClient(config.get<string>('baseUrl','http://127.0.0.1:8790'));
      await client.settings.mcpServers.createOrUpdate({manifest:{name:'fakefoundy-editor',description:'FakeFoundy local editor read and staged-edit tools',type:'remote',url:bridge.url,auth:{type:'header',headers:{Authorization:`Bearer ${bridge.token}`}}}});
      output.show();output.appendLine('Starting TrueForge session…');
      const id=await runTurn(client,config.get<string>('model','openai/gpt-4.1-mini'),prompt,event=>output.appendLine(JSON.stringify(event)));
      output.appendLine(`Session: ${id}. Use FakeFoundy: Review Proposed Edit to inspect staged edits.`);
    } catch(e) {void vscode.window.showErrorMessage(`FakeFoundy: ${e instanceof Error?e.message:'Run failed'}`);}
    finally {busy=false;}
  }));
  context.subscriptions.push(vscode.commands.registerCommand('fakefoundy.review',async()=>{
    if(!store) return;
    const picked=await vscode.window.showQuickPick(store.list().map(p=>({label:p.path,id:p.id})),{placeHolder:'Choose a staged edit'});
    if(!picked) return;
    const p=store.get(picked.id);
    const before=vscode.Uri.parse(`fakefoundy-preview:/${p.id}/before`),after=vscode.Uri.parse(`fakefoundy-preview:/${p.id}/after`);
    previews.set(before.toString(),p.before);previews.set(after.toString(),p.after);
    await vscode.commands.executeCommand('vscode.diff',before,after,`FakeFoundy proposed edit: ${p.path}`);
    const answer=await vscode.window.showInformationMessage('Review the diff. Apply this full-file proposal?', 'Apply','Reject');
    if(answer==='Reject') store.reject(p.id);
    if(answer==='Apply') {
      const doc=await vscode.workspace.openTextDocument(p.path);
      if(doc.getText()!==p.before || await store.read(p.path)!==p.before) {void vscode.window.showErrorMessage('File changed since proposal; regenerate the edit.');return;}
      const edit=new vscode.WorkspaceEdit();
      edit.replace(doc.uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),p.after);
      if(await vscode.workspace.applyEdit(edit)) {store.reject(p.id); void vscode.window.showInformationMessage('Applied to editor buffer. Undo is available; save when ready.');}
    }
  }));
}
