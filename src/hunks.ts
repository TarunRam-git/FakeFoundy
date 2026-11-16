export interface Hunk {
  id: number;
  start: number;
  deleteCount: number;
  before: string;
  after: string;
}
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
/** Bounded line LCS. Large edits safely fall back to a single reviewable hunk. */
export function diffHunks(before: string, after: string): Hunk[] {
  if (before === after) return [];
  const a = lines(before), b = lines(after);
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length-prefix && suffix < b.length-prefix && a[a.length-1-suffix] === b[b.length-1-suffix]) suffix++;
  const x = a.slice(prefix, a.length-suffix), y = b.slice(prefix, b.length-suffix);
  if ((x.length+1)*(y.length+1) > 1_000_000) return [{id:0,start:prefix,deleteCount:x.length,before:x.join(''),after:y.join('')}];
  const width = y.length+1;
  const table = new Uint32Array((x.length+1)*width);
  for (let i=x.length-1;i>=0;i--) for(let j=y.length-1;j>=0;j--)
    table[i*width+j] = x[i] === y[j] ? 1+table[(i+1)*width+j+1] : Math.max(table[(i+1)*width+j],table[i*width+j+1]);
  const result: Hunk[] = [];
  let i=0,j=0,current: Hunk|undefined;
  const finish=()=>{if(current) result.push(current);current=undefined;};
  while(i<x.length || j<y.length) {
    if(i<x.length && j<y.length && x[i]===y[j]) {finish();i++;j++;continue;}
    current ??= {id:result.length,start:prefix+i,deleteCount:0,before:'',after:''};
    if(j<y.length && (i===x.length || table[i*width+j+1]>=table[(i+1)*width+j])) current.after+=y[j++];
    else {current.before+=x[i++];current.deleteCount++;}
  }
  finish();return result;
}
export function applyHunks(before: string, hunks: Hunk[], accepted: readonly number[]): string {
  const selected = new Set(accepted);
  if (accepted.some(id=>!hunks.some(h=>h.id===id))) throw new Error('Unknown hunk');
  const result=lines(before);
  for(const h of [...hunks].reverse()) if(selected.has(h.id)) result.splice(h.start,h.deleteCount,...lines(h.after));
  return result.join('');
}
