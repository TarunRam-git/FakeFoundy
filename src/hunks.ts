import { diffArrays } from "diff";

export interface Hunk {
  id: number;
  start: number;
  deleteCount: number;
  before: string;
  after: string;
}
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
/** Diff by lines while keeping original line endings and missing final newlines. */
export function diffHunks(before: string, after: string): Hunk[] {
  if (before === after) return [];
  const a = lines(before), b = lines(after);
  const changes = diffArrays(a, b, {maxEditLength: 2048});
  // shortcut: extremely large rewrites use one hunk; move diffs off-thread if large rewrites are supported.
  if (!changes) return [{id:0,start:0,deleteCount:a.length,before,after}];
  const result: Hunk[] = [];
  let line = 0;
  let current: Hunk | undefined;
  for (const change of changes) {
    if (change.added || change.removed) {
      if (!current) {
        current = {id:result.length,start:line,deleteCount:0,before:"",after:""};
        result.push(current);
      }
      if (change.added) current.after += change.value.join("");
      else {
        current.deleteCount += change.count;
        current.before += change.value.join("");
      }
    } else current = undefined;
    if (!change.added) line += change.count;
  }
  return result;
}
export function applyHunks(before: string, hunks: Hunk[], accepted: readonly number[]): string {
  const selected = new Set(accepted);
  if (accepted.some(id=>!hunks.some(h=>h.id===id))) throw new Error('Unknown hunk');
  const original = lines(before);
  const result: string[] = [];
  let line = 0;
  for (const hunk of hunks) {
    if (!selected.has(hunk.id)) continue;
    result.push(original.slice(line, hunk.start).join(""), hunk.after);
    line = hunk.start + hunk.deleteCount;
  }
  return result.join("") + original.slice(line).join("");
}
