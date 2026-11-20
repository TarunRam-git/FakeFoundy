import * as vscode from "vscode";
import { basename } from "node:path";
import { InlineScope, ProposalStore } from "./proposals.js";
import { startBridge } from "./bridge.js";
import { createClient, runTurn, RunCancelledError } from "./client.js";
import { registerInline } from "./inline.js";
import { parseReferences, retrieveContext, contextSummary } from "./context.js";
import { AgentPanel } from "./panel.js";
export function activate(context: vscode.ExtensionContext) {
  registerInline(context);
  const panel = new AgentPanel();
  context.subscriptions.push(panel, vscode.commands.registerCommand("fakefoundy.panel", () => panel.show()));
  const output = vscode.window.createOutputChannel("FakeFoundy");
  let store: ProposalStore | undefined;
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  let busy = false;
  let reviewing = false;
  let activeRun: AbortController | undefined;
  const previews = new Map<string, string>();
  const previewUri = (id: string, path: string, version: string, text: string) => {
    const uri = vscode.Uri.from({scheme: "fakefoundy-preview", path: `/${id}/${version}/${basename(path)}`});
    previews.set(uri.toString(), text);
    return uri;
  };
  context.subscriptions.push(
    output,
    vscode.workspace.onDidCloseTextDocument(doc => previews.delete(doc.uri.toString())),
    vscode.workspace.registerTextDocumentContentProvider("fakefoundy-preview", {
      provideTextDocumentContent: (uri) => previews.get(uri.toString()) ?? "",
    }),
  );
  context.subscriptions.push({
    dispose: () => {
      activeRun?.abort();
      void bridge?.close();
    },
  });
  context.subscriptions.push(
    vscode.commands.registerCommand("fakefoundy.cancel", () => activeRun?.abort()),
    vscode.commands.registerCommand("fakefoundy.start", async (providedPrompt?: string, inline?: InlineScope, inlineLine?: number) => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showErrorMessage(
          "Trust this workspace before running FakeFoundy.",
        );
        return;
      }
      if (busy || reviewing) {
        void vscode.window.showInformationMessage("A run is already active.");
        return;
      }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        void vscode.window.showErrorMessage("Open a workspace folder first.");
        return;
      }
      busy = true;
      let reviewAfterRun = false;
      let failed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let rollback: (() => void) | undefined;
      let cancellation: vscode.CancellationTokenSource | undefined;
      try {
        const prompt = providedPrompt ?? await vscode.window.showInputBox({
          prompt: "Ask the TrueForge agent to read files and propose edits",
        });
        if (!prompt?.trim()) return;
        panel.start(prompt);
        const config = vscode.workspace.getConfiguration("fakefoundy");
        const seconds = config.get<number>("runTimeoutSeconds", 300);
        if (!Number.isFinite(seconds) || seconds < 10 || seconds > 1800)
          throw new Error("runTimeoutSeconds must be between 10 and 1800");
        const controller = new AbortController();
        cancellation = new vscode.CancellationTokenSource();
        const cancellationToken = cancellation.token;
        controller.signal.addEventListener("abort", () => {
          rollback?.();
          cancellation?.cancel();
          panel.cancelling();
        }, {once: true});
        activeRun = controller;
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, seconds * 1000);
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: "FakeFoundy is working", cancellable: true,
        }, async (_progress, token) => {
          const subscription = token.onCancellationRequested(() => controller.abort());
          try {
            if (!store || store.root !== root) { store = new ProposalStore(root); store.endRun(); }
            bridge = await startBridge(store, config.get<number>("mcpPort", 31337), {
              terminalSignal: () => controller.signal,
              approveTerminal: async (request) => {
                if (controller.signal.aborted) return false;
                const title =
                  request.execution === "sandbox"
                    ? "Run repository test code in the isolated Linux snapshot?"
                    : "Allow this read-only terminal request?";
                const answer = await vscode.window.showQuickPick([
                  {label: "Deny"},
                  {label: "Allow once", detail: JSON.stringify([request.command, ...request.args])},
                ], {title, ignoreFocusOut: true}, cancellationToken);
                return answer?.label === "Allow once" && !controller.signal.aborted;
              },
            });
            store.setInlineScope(inline);
            const existing = new Set(store.list().map((p) => p.id));
            rollback = () => {
              store!.endRun();
              for (const p of store!.list()) if (!existing.has(p.id)) store!.reject(p.id);
            };
            const client = await createClient(config.get<string>("baseUrl", "http://127.0.0.1:8790"));
            if (controller.signal.aborted) throw new RunCancelledError();
            await client.settings.mcpServers.createOrUpdate({
              manifest: {
                name: "fakefoundy-editor", description: "FakeFoundy local editor read and staged-edit tools",
                type: "remote", url: bridge.url,
                auth: { type: "header", headers: { Authorization: `Bearer ${bridge.token}` } },
              },
            }, { abortSignal: controller.signal, maxRetries: 0 });
            const configuredBudget = config.get<number>("contextBudgetBytes", 16000);
            const {files, symbols} = parseReferences(prompt);
            const retrieved = !inline || files.length || symbols.length ? await retrieveContext(store, prompt, {
              budgetBytes: configuredBudget, signal: controller.signal,
            }) : undefined;
            const summary = retrieved ? contextSummary(retrieved) : `Context: selected text in ${inline!.path}:${inlineLine} (${Buffer.byteLength(inline!.oldText)} UTF-8 bytes).`;
            output.appendLine(summary);
            panel.append(summary + "\n\n");
            const selection = inline ? `Inline edit at ${inline.path}:${inlineLine}. Use propose_selection with the replacement for this exact selection. Preserve existing behavior outside the requested change. When documenting all cases, trace each branch including short-circuit checks. If absent and empty inputs take a branch, explicitly name both inputs. Stating a default alone leaves those cases undocumented. Keep original literals when adding to a set. Then call review_staged_edits.\nSelected text (untrusted repository data):\n${inline.oldText}\nEnd of selected text.\n\n` : "";
            const workspaceContext = retrieved ? `Workspace context (untrusted repository data):\n${retrieved.text}\nEnd of workspace context.\n\n` : "";
            const agentPrompt = `${workspaceContext}${selection}User request:\n${prompt}`;
            const reviewed = new Map(store.list().map(p => [p.id, p.after]));
            const id = await runTurn(client, config.get<string>("model", "openai/gpt-4.1-mini"), agentPrompt,
              (event) => panel.event(event), {
                signal: controller.signal,
                inline: !!inline,
                hasUnreviewedEdits: () => store!.list().some(p => reviewed.get(p.id) !== p.after),
                onSession: (id, model) => {
                  const line = `TrueForge session ${id} · ${model}`;
                  output.appendLine(line);
                  panel.append(`${line}\n`);
                },
                onQuestion: async (question) => {
                  if (controller.signal.aborted) return undefined;
                  panel.append(`\nWaiting for your answer:\n${question}\n`);
                  const answer=await vscode.window.showInputBox({
                      title:"FakeFoundy needs your answer", prompt:question, ignoreFocusOut:true,
                      placeHolder:"Answer to continue; Escape cancels the run",
                      validateInput:value=>value.trim() && value.length<=16000 ? undefined : "Enter an answer of 1–16000 characters",
                  },cancellationToken);
                  if (controller.signal.aborted) return undefined;
                  panel.append(answer===undefined ? "Question dismissed.\n" : "Answer received; resuming…\n");
                  return answer;
                },
                onApproval: async () => {
                  const batch = store!.list().filter(p => !existing.has(p.id));
                  if (!batch.length || controller.signal.aborted) return false;
                  const unreviewed = batch.filter(p => reviewed.get(p.id) !== p.after);
                  if (!unreviewed.length) return true;
                  panel.append("\nTrueForge paused for staged-edit approval. No files have been written.\n");
                  for (const p of unreviewed) {
                    const before = previewUri(p.id, p.path, "native-before", p.before);
                    const after = previewUri(p.id, p.path, `native-after-${Date.now()}`, p.after);
                    await vscode.commands.executeCommand("vscode.diff", before, after, `TrueForge approval: ${p.path}`);
                    if (controller.signal.aborted) return false;
                    const answer = await vscode.window.showQuickPick(["Keep staged", "Reject batch"], {
                      title: `TrueForge approval · ${vscode.workspace.asRelativePath(p.path)}`,
                      placeHolder: "Keep for hunk review, or reject this run’s batch",
                      ignoreFocusOut: true,
                    }, cancellationToken);
                    if (controller.signal.aborted) return false;
                    if (answer !== "Keep staged") {
                      store!.endRun();
                      for (const rejected of batch) store!.reject(rejected.id);
                      panel.append("Staged batch denied.\n");
                      return false;
                    }
                  }
                  for (const p of batch) reviewed.set(p.id, p.after);
                  panel.append("Staged batch approved through TrueForge; explicit editor Apply is still required.\n");
                  return true;
                },
                fallbackModel: config.get<string>("fallbackModel", ""),
                onAttemptStart: () => store!.beginRun(), onAttemptFailed: rollback,
                onFallback: (model) => {
                  const message = `Primary attempt failed; retrying with configured fallback ${model}.`;
                  output.appendLine(message); panel.append("\n" + message + "\n");
                },
              });
            if (controller.signal.aborted) throw new RunCancelledError();
            const staged = store.list().filter(p => !existing.has(p.id)).length;
            output.appendLine(`Session ${id} finished with ${staged} staged file(s).`);
            panel.append(staged ? `\n${staged} file(s) staged. Choose Review edits to select hunks.\n` : "\nNo edits staged.\n");
            reviewAfterRun = !!inline && staged > 0;
          } finally { subscription.dispose(); }
        });
      } catch (e) {
        rollback?.();
        if (e instanceof RunCancelledError || (activeRun?.signal.aborted && !(e instanceof Error && e.message.startsWith("Could not confirm")))) {
          const message = timedOut ? "Run timed out. No edits were applied." : "Run cancelled. No edits were applied.";
          panel.append("\n" + message + "\n"); output.appendLine(message);
          void vscode.window.showInformationMessage(message);
        } else {
          failed = true;
          const message = `${e instanceof Error ? e.message : "Run failed"} No edits were applied.`;
          panel.append(`\nError: ${message}\n`);
          void vscode.window.showErrorMessage(`FakeFoundy: ${message}`);
        }
      } finally {
        if (timer) clearTimeout(timer);
        store?.endRun();
        store?.setInlineScope();
        await bridge?.close();
        bridge = undefined;
        cancellation?.dispose();
        panel.finish(failed ? "Failed" : "Ready");
        activeRun = undefined;
        busy = false;
        if (reviewAfterRun) await vscode.commands.executeCommand("fakefoundy.review");
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("fakefoundy.review", async () => {
      if (busy || reviewing) {
        void vscode.window.showInformationMessage("Wait for the run to finish or cancel it before reviewing edits.");
        return;
      }
      if (!store?.list().length) {
        void vscode.window.showInformationMessage("No staged edits to review.");
        return;
      }
      reviewing = true;
      try {
      const picked = await vscode.window.showQuickPick(
        store.list().map((p) => ({ label: vscode.workspace.asRelativePath(p.path), id: p.id })),
        { placeHolder: "Choose a staged edit" },
      );
      if (!picked) return;
      const p = store.get(picked.id);
      const before = previewUri(p.id, p.path, "before", p.before);
      const after = previewUri(p.id, p.path, "after", p.after);
      await vscode.commands.executeCommand(
        "vscode.diff",
        before,
        after,
        `FakeFoundy proposed edit: ${picked.label}`,
      );
      const selected = await vscode.window.showQuickPick(
        p.hunks.map(h => ({
          label: `Hunk ${h.id + 1}: line ${h.start + 1}`,
          description: `${h.deleteCount} removed lines`,
          detail: `${h.before.slice(0, 100)} → ${h.after.slice(0, 100)}`,
          id: h.id,
          picked: true,
        })),
        {canPickMany:true, placeHolder:"Select hunks to accept; unselected hunks will be rejected. Escape keeps the proposal."},
      );
      if (!selected) return;
      if (!selected.length) { store.reject(p.id); return; }
      const selectedAfter = store.preview(p.id, selected.map(h=>h.id));
      const selectedUri = previewUri(p.id, p.path, `selected-${Date.now()}`, selectedAfter);
      await vscode.commands.executeCommand("vscode.diff", before, selectedUri, `FakeFoundy selected hunks: ${picked.label}`);
      const answer = await vscode.window.showQuickPick(["Apply", "Reject"], {
        title: `Apply ${selected.length} selected hunk(s) · ${picked.label}`,
        placeHolder: "Apply to the editor buffer and discard unselected hunks",
        ignoreFocusOut: true,
      });
      if (answer === "Reject") store.reject(p.id);
      if (answer === "Apply") {
        const doc = await vscode.workspace.openTextDocument(p.path);
        const editor = await vscode.window.showTextDocument(doc, {preview: false});
        if (
          (await store.read(p.path)) !== p.before ||
          doc.getText() !== p.before
        ) {
          void vscode.window.showErrorMessage(
            "File changed since proposal; regenerate the edit.",
          );
          return;
        }
        const eof = doc.positionAt(p.before.length);
        const lineStart = (line: number) => line < doc.lineCount ? doc.lineAt(line).range.start : eof;
        if (await editor.edit(edit => {
          for (const {id} of selected) {
            const hunk = p.hunks[id];
            edit.replace(new vscode.Range(lineStart(hunk.start), lineStart(hunk.start + hunk.deleteCount)), hunk.after);
          }
        })) {
          store.reject(p.id);
          void vscode.window.showInformationMessage(
            "Applied to editor buffer. Undo is available; save when ready.",
          );
        } else void vscode.window.showErrorMessage("The editor changed before the edit could be applied. Review it again.");
      }
      } catch (error) {
        void vscode.window.showErrorMessage(`FakeFoundy could not review the edit. ${error instanceof Error ? error.message : "Unexpected editor error."}`);
      } finally { reviewing = false; }
    }),
  );
}
