import { isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { ProposalStore } from "./proposals.js";

export interface TerminalRequest {
  command: string;
  args: readonly string[];
}
export type TerminalApproval = (request: TerminalRequest) => Promise<boolean>;
export interface TerminalResult {
  status: "completed" | "denied" | "unsupported";
  stdout: string;
  stderr: string;
  truncated: boolean;
}
export const TERMINAL_OUTPUT_BYTES = 16 * 1024;

function bounded(text: string): {stdout: string; truncated: boolean} {
  if (Buffer.byteLength(text) <= TERMINAL_OUTPUT_BYTES)
    return {stdout:text, truncated:false};
  let end = Math.min(text.length, TERMINAL_OUTPUT_BYTES);
  while (Buffer.byteLength(text.slice(0,end)) > TERMINAL_OUTPUT_BYTES) end--;
  // Do not split a UTF-16 surrogate pair.
  if (end && /[\uD800-\uDBFF]/.test(text[end-1])) end--;
  return {stdout:text.slice(0,end),truncated:true};
}

/** Deliberately NOT a shell. Approval never enables arbitrary commands or code. */
export async function runReadOnlyTerminal(
  store: ProposalStore,
  input: TerminalRequest,
  approve?: TerminalApproval,
): Promise<TerminalResult> {
  // Copy before awaiting UI approval so callers cannot change the approved request.
  const request = Object.freeze({command:input.command,args:Object.freeze([...input.args])});
  const noArgs = request.args.length === 0;
  const catPath = request.args[0];
  const supported =
    ((request.command === "pwd" || request.command === "ls") && noArgs) ||
    (request.command === "cat" && request.args.length === 1 &&
      catPath.length > 0 && catPath.length <= 1024 &&
      !catPath.startsWith("-") && !isAbsolute(catPath) &&
      !catPath.split(/[\\/]/).includes("..") && !/[\x00-\x1f\x7f]/.test(catPath));
  if (!supported) return {
    status:"unsupported",stdout:"",truncated:false,
    stderr:"Only pwd, ls (bounded recursive workspace file list), and cat with one relative file path are supported. Shells, scripts, flags, pipes, redirects, network, builds, and writes are not supported. Approval cannot enable them.",
  };
  if (!approve || !(await approve(request))) return {
    status:"denied",stdout:"",stderr:"Explicit editor approval was not granted; nothing was read or executed.",truncated:false,
  };
  let output: string;
  let truncated = false;
  if (request.command === "pwd") output = `${await realpath(store.root)}\n`;
  else if (request.command === "ls") {
    const listing = await store.discover("",100);
    output = listing.files.join("\n") + (listing.files.length ? "\n" : "");
    truncated = listing.truncated;
  } else output = await store.read(catPath);
  const clipped = bounded(output);
  return {status:"completed",stdout:clipped.stdout,stderr:"",truncated:truncated||clipped.truncated};
}
