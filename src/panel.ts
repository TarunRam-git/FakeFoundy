import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { StreamFormatter } from "./streamText.js";

/** A bounded, text-only stream view. Model content never becomes HTML or commands. */
export class AgentPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private text = "";
  private active = false;
  private status = "Ready";
  private formatter = new StreamFormatter();
  show() {
    if (this.panel) { this.panel.reveal(undefined, true); return; }
    this.panel = vscode.window.createWebviewPanel("fakefoundy.agent", "FakeFoundy Agent",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
    const nonce = randomBytes(24).toString("hex");
    this.panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">body{font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}textarea{width:95%;min-height:80px;color:inherit;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}button{margin:8px 6px 8px 0;padding:7px 12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--vscode-editor-font-family)}small{display:block;opacity:.8}</style></head><body>
<h2>FakeFoundy</h2><small>TrueForge agent · Changes stay staged until you review and apply them.</small>
<label for="prompt">Task (supports @file:path and @symbol:name)</label><textarea id="prompt" placeholder="Describe the change…"></textarea>
<div><button id="start">Run</button><button id="cancel">Cancel</button><button id="review">Review edits</button></div>
<p id="status" role="status">Ready</p><pre id="stream" aria-live="polite"></pre>
<script nonce="${nonce}">const api=acquireVsCodeApi();
const start=document.getElementById('start'),cancel=document.getElementById('cancel'),review=document.getElementById('review');
start.onclick=()=>api.postMessage({type:'start',prompt:document.getElementById('prompt').value});
cancel.onclick=()=>api.postMessage({type:'cancel'});review.onclick=()=>api.postMessage({type:'review'});
window.addEventListener('message',({data})=>{document.getElementById('stream').textContent=data.text;document.getElementById('status').textContent=data.status;start.disabled=data.active;cancel.disabled=data.status!=='Working…';review.disabled=data.active;});api.postMessage({type:'ready'});
</script></body></html>`;
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== "object") return;
      const m = message as {type?: string; prompt?: unknown};
      if (m.type === "ready") this.update();
      else if (m.type === "start" && !this.active && typeof m.prompt === "string" && m.prompt.trim() && m.prompt.length <= 32000)
        void vscode.commands.executeCommand("fakefoundy.start", m.prompt);
      else if (m.type === "cancel") void vscode.commands.executeCommand("fakefoundy.cancel");
      else if (m.type === "review" && !this.active) void vscode.commands.executeCommand("fakefoundy.review");
    });
  }
  start(prompt: string) { this.formatter = new StreamFormatter(); this.text = `Task: ${prompt}\n\n`; this.active = true; this.status = "Working…"; this.show(); this.update(); }
  cancelling() { this.status = "Cancelling…"; this.update(); }
  append(text: string) { this.text = (this.text + text).slice(-100000); this.update(); }
  event(event: unknown) { const text = this.formatter.format(event); if (text) this.append(text); }
  finish() { this.active = false; this.status = "Ready"; this.update(); }
  private update() { void this.panel?.webview.postMessage({text:this.text,active:this.active,status:this.status}); }
  dispose() { this.panel?.dispose(); }
}
