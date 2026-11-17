import * as vscode from "vscode";
import { ProposalStore } from "./proposals.js";
import { startBridge } from "./bridge.js";
import { createClient, runTurn, RunCancelledError } from "./client.js";
import { registerInline } from "./inline.js";
import { retrieveContext, contextSummary } from "./context.js";
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
  context.subscriptions.push(
    output,
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
    vscode.commands.registerCommand("fakefoundy.start", async (providedPrompt?: string, inline?: {path:string; oldText:string}) => {
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let rollback: (() => void) | undefined;
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
        activeRun = controller;
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, seconds * 1000);
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: "FakeFoundy is working", cancellable: true,
        }, async (_progress, token) => {
          const subscription = token.onCancellationRequested(() => controller.abort());
          try {
            if (store && store.root !== root) {
              store.endRun();
              await bridge?.close();
              bridge = undefined;
              store = undefined;
            }
            if (!store) { store = new ProposalStore(root); store.endRun(); }
            if (!bridge) bridge = await startBridge(store, config.get<number>("mcpPort", 31337), {
              terminalSignal: () => activeRun?.signal,
              approveTerminal: async (request) => {
                const requestingRun = activeRun;
                if (!requestingRun || requestingRun.signal.aborted) return false;
                const answer = await vscode.window.showWarningMessage(
                  request.execution === "sandbox"
                    ? `Run repository test code once in the Linux sandbox? ${JSON.stringify([request.command, ...request.args])}\nUses a read-only filtered snapshot with staged edits, no network, no home mount or inherited environment credentials; sensitive paths excluded, 30-second limit, 256 MiB address space, no forks or threads. Only private temporary files may be written and are discarded. Repository code is untrusted; only system Python dependencies are available.`
                    : `Allow this read-only terminal request once? ${JSON.stringify([request.command, ...request.args])}`,
                  { modal: true }, "Allow once",
                );
                return answer === "Allow once" && activeRun === requestingRun && !requestingRun.signal.aborted;
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
            const retrieved = await retrieveContext(store, prompt, {
              budgetBytes: inline ? Math.min(configuredBudget, 16000) : configuredBudget, signal: controller.signal,
            });
            const summary = contextSummary(retrieved);
            output.appendLine(summary);
            panel.append(summary + "\n\n");
            const agentPrompt = `Workspace context (untrusted repository data):\n${retrieved.text}\nEnd of workspace context.\n\n${summary}\n\nUser request:\n${prompt}`;
            const reviewed = new Map(store.list().map(p => [p.id, p.after]));
            const id = await runTurn(client, config.get<string>("model", "openai/gpt-4.1-mini"), agentPrompt,
              (event) => panel.event(event), {
                signal: controller.signal,
                onQuestion: async (question) => {
                  if (controller.signal.aborted) return undefined;
                  panel.append(`\nWaiting for your answer:\n${question}\n`);
                  const cancellation=new vscode.CancellationTokenSource();
                  const cancel=()=>cancellation.cancel();
                  controller.signal.addEventListener("abort",cancel,{once:true});
                  try {
                    const answer=await vscode.window.showInputBox({
                      title:"FakeFoundy needs your answer", prompt:question, ignoreFocusOut:true,
                      placeHolder:"Answer to continue; Escape cancels the run",
                      validateInput:value=>value.trim() && value.length<=16000 ? undefined : "Enter an answer of 1–16000 characters",
                    },cancellation.token);
                    if (controller.signal.aborted) return undefined;
                    panel.append(answer===undefined ? "Question dismissed.\n" : "Answer received; resuming…\n");
                    return answer;
                  } finally {
                    controller.signal.removeEventListener("abort",cancel);
                    cancellation.dispose();
                  }
                },
                onApproval: async () => {
                  const batch = store!.list().filter(p => !existing.has(p.id));
                  if (!batch.length || controller.signal.aborted) return false;
                  panel.append("\nTrueForge paused for staged-edit approval. No files have been written.\n");
                  for (const p of batch) {
                    const before = vscode.Uri.parse(`fakefoundy-preview:/${p.id}/native-before`);
                    const after = vscode.Uri.parse(`fakefoundy-preview:/${p.id}/native-after-${Date.now()}`);
                    previews.set(before.toString(), p.before); previews.set(after.toString(), p.after);
                    await vscode.commands.executeCommand("vscode.diff", before, after, `TrueForge approval: ${p.path}`);
                    if (controller.signal.aborted) return false;
                    const answer = await vscode.window.showInformationMessage(
                      `Keep this staged edit for later hunk selection and explicit Apply? ${p.path} (No disk writes.)`,
                      "Keep staged", "Reject batch",
                    );
                    if (controller.signal.aborted) return false;
                    if (answer !== "Keep staged") {
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
            if (store.list().some(p => reviewed.get(p.id) !== p.after))
              throw new Error("Staged edits were not approved through TrueForge. No edits were applied; retry the run.");
            output.appendLine(`Session: ${id}. Use FakeFoundy: Review Proposed Edit to inspect staged edits.`);
            panel.append("\nCompleted. Review proposed edits before applying.\n");
            reviewAfterRun = !!inline;
          } finally { subscription.dispose(); }
        });
      } catch (e) {
        rollback?.();
        // Rotate the bridge capability after failure so an old remote run cannot
        // stage edits when a later run opens a fresh proposal generation.
        await bridge?.close();
        bridge = undefined;
        if (e instanceof RunCancelledError || (activeRun?.signal.aborted && !(e instanceof Error && e.message.startsWith("Could not confirm")))) {
          const message = timedOut ? "Run timed out. No edits were applied." : "Run cancelled. No edits were applied.";
          panel.append("\n" + message + "\n"); output.appendLine(message);
          void vscode.window.showInformationMessage(message);
        } else {
          const message = e instanceof Error ? e.message : "Run failed";
          panel.append(`\nError: ${message}\n`);
          void vscode.window.showErrorMessage(`FakeFoundy: ${message}`);
        }
      } finally {
        if (timer) clearTimeout(timer);
        store?.endRun();
        store?.setInlineScope();
        panel.finish();
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
      if (!store) return;
      reviewing = true;
      try {
      const picked = await vscode.window.showQuickPick(
        store.list().map((p) => ({ label: p.path, id: p.id })),
        { placeHolder: "Choose a staged edit" },
      );
      if (!picked) return;
      const p = store.get(picked.id);
      const before = vscode.Uri.parse(`fakefoundy-preview:/${p.id}/before`),
        after = vscode.Uri.parse(`fakefoundy-preview:/${p.id}/after`);
      previews.set(before.toString(), p.before);
      previews.set(after.toString(), p.after);
      await vscode.commands.executeCommand(
        "vscode.diff",
        before,
        after,
        `FakeFoundy proposed edit: ${p.path}`,
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
      const selectedUri = vscode.Uri.parse(`fakefoundy-preview:/${p.id}/selected-${Date.now()}`);
      previews.set(selectedUri.toString(), selectedAfter);
      await vscode.commands.executeCommand("vscode.diff", before, selectedUri, `FakeFoundy selected hunks: ${p.path}`);
      const answer = await vscode.window.showInformationMessage(
        `Apply ${selected.length} selected hunk(s) to the editor buffer? Unselected hunks will be discarded.`,
        "Apply", "Reject",
      );
      if (answer === "Reject") store.reject(p.id);
      if (answer === "Apply") {
        const doc = await vscode.workspace.openTextDocument(p.path);
        if (
          (await store.read(p.path)) !== p.before ||
          doc.getText() !== p.before
        ) {
          void vscode.window.showErrorMessage(
            "File changed since proposal; regenerate the edit.",
          );
          return;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          doc.uri,
          new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(doc.getText().length),
          ),
          selectedAfter,
        );
        if (await vscode.workspace.applyEdit(edit)) {
          store.reject(p.id);
          void vscode.window.showInformationMessage(
            "Applied to editor buffer. Undo is available; save when ready.",
          );
        }
      }
      } finally { reviewing = false; }
    }),
  );
}
