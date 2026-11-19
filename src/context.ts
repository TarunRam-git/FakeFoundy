import { ProposalStore } from "./proposals.js";

export interface ContextItem { path: string; reason: string; startLine: number; text: string }
export interface ContextResult {
  text: string; items: ContextItem[]; warnings: string[];
  bytes: number; budgetBytes: number; scannedFiles: number; truncated: boolean;
}
const stop = new Set("the a an to and or of in is it be by as for from with that this must should add new built loaded any containing values every also well case insensitive appear covered documented alongside other".split(" "));
export function parseReferences(prompt: string) {
  const files: string[] = [], symbols: string[] = [];
  for (const m of prompt.matchAll(/@(file|symbol):(?:"([^"]+)"|([^\s,;]+))/g))
    (m[1] === "file" ? files : symbols).push(m[2] ?? m[3]);
  return {files: [...new Set(files)], symbols: [...new Set(symbols)]};
}
/** Deterministic lexical retrieval, not an embedding index. Budget includes rendered headers. */
export async function retrieveContext(store: ProposalStore, prompt: string, options: {budgetBytes?:number; signal?:AbortSignal} = {}): Promise<ContextResult> {
  const budgetBytes = Math.max(256, Math.min(131072, options.budgetBytes ?? 16000));
  const {files, symbols} = parseReferences(prompt);
  const terms = [...new Set((prompt.toLowerCase().match(/[a-z_][a-z_0-9]{2,}/g) ?? []).filter(t=>!stop.has(t) && t!=="file" && t!=="symbol"))].slice(0,40);
  const acronyms = new Set((prompt.match(/\b[A-Z]{2,}\b/g) ?? []).map(word => word.toLowerCase()));
  // Rank filenames before the content scan cap so large test or vendor trees cannot consume it first.
  const nameMatches = (path: string) => {
    const basename = path.split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase();
    const words = basename.split(/[^a-z0-9]+/);
    return terms.filter(term => (term === basename || words.includes(term)) && term !== "test" && term !== "tests");
  };
  const nameScore = (matches: string[]) => matches.reduce((sum, term) => sum + (acronyms.has(term) ? 20 : 12), 0);
  options.signal?.throwIfAborted();
  const discovered = await store.discover("",500,{signal:options.signal, prioritize:path => nameScore(nameMatches(path))});
  const candidates = [...new Set([...files, ...discovered.files])];
  const ranked: {path:string; lines:string[]; line:number; score:number; reason:string}[] = [];
  const warnings: string[] = [];
  const foundSymbols = new Set<string>();
  let scannedFiles = 0, scanBytes = 0, truncated = discovered.truncated;
  for (const path of candidates) {
    options.signal?.throwIfAborted();
    let source: string;
    try { source = await store.read(path); } catch {
      if (files.includes(path)) warnings.push(`Cannot read @file:${path} (missing, protected or unsupported).`);
      continue;
    }
    scanBytes += Buffer.byteLength(source);
    if (scanBytes > 5 * 1024 * 1024) { truncated = true; break; }
    scannedFiles++;
    const lines = source.split("\n");
    const explicit = files.includes(path);
    const hits = symbols.filter(symbol => new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\b`).test(source));
    for (const symbol of hits) foundSymbols.add(symbol);
    // Direct filename matches carry more information than a shared package name
    // or a substring such as "cli" inside "client".
    const pathTerms = nameMatches(path);
    let bestLine = 0, bestScore = 0;
    for (let i=0;i<lines.length;i++) {
      const normalized = lines[i].toLowerCase();
      const score = terms.filter(t=>normalized.includes(t)).length;
      if (score>bestScore) { bestScore = score; bestLine=i; }
    }
    if (hits.length) bestLine = lines.findIndex(l=>l.includes(hits[0]));
    const score = (explicit?10000:0) + hits.length*1000 + nameScore(pathTerms) + bestScore;
    if (!score) continue;
    const reason = explicit ? "explicit @file reference" : hits.length ? `@symbol match: ${hits.join(", ")}` : `lexical relevance: ${[...pathTerms,...terms.filter(t=>lines[bestLine].toLowerCase().includes(t))].filter((x,i,a)=>a.indexOf(x)===i).slice(0,8).join(", ")}`;
    ranked.push({path,lines,line:bestLine,score,reason});
  }
  for (const symbol of symbols) if (!foundSymbols.has(symbol)) warnings.push(`No @symbol:${symbol} match in bounded workspace scan.`);
  ranked.sort((a,b)=>b.score-a.score || a.path.localeCompare(b.path));
  let text="", bytes=0;
  const items:ContextItem[]=[];
  // Send the strongest matches verbatim when all of them fit while leaving
  // room for other results. Smaller budgets still distribute excerpts across files.
  const top = ranked.slice(0, 3);
  const complete = new Map(top.map(candidate => {
    const source = candidate.lines.join("\n");
    const block = `\n--- ${candidate.path} (complete file; ${candidate.reason}) ---\n${source}\n`;
    return [candidate, block] as const;
  }));
  const topBytes = [...complete.values()].reduce((sum, block) => sum + Buffer.byteLength(block), 0);
  if (topBytes > budgetBytes * 0.85) complete.clear();
  for (const candidate of ranked.slice(0,12)) {
    options.signal?.throwIfAborted();
    const full = complete.get(candidate);
    if (full !== undefined) {
      text += full;
      bytes += Buffer.byteLength(full);
      items.push({path:candidate.path, reason:candidate.reason, startLine:1, text:candidate.lines.join("\n")});
      continue;
    }
    // Reserve space for multiple relevant files, rather than filling budget with first whole file.
    const allowance = Math.min(4000, Math.max(512, Math.floor(budgetBytes / 8)), budgetBytes-bytes);
    const start = Math.max(0,candidate.line-12);
    const header = `\n--- ${candidate.path} (line ${start+1}; ${candidate.reason}) ---\n`;
    let excerpt="";
    for (let i=start;i<Math.min(candidate.lines.length,start+90);i++) {
      const line=`${i+1}: ${candidate.lines[i]}\n`;
      if (Buffer.byteLength(header+excerpt+line)>allowance) break;
      excerpt+=line;
    }
    if (!excerpt) { truncated=true; continue; }
    const block=header+excerpt;
    text+=block; bytes+=Buffer.byteLength(block);
    items.push({path:candidate.path,reason:candidate.reason,startLine:start+1,text:excerpt});
  }
  if (items.length<ranked.length) truncated=true;
  return {text,items,warnings,bytes,budgetBytes,scannedFiles,truncated};
}
export function contextSummary(result: ContextResult): string {
  return [`Context: ${result.bytes}/${result.budgetBytes} UTF-8 bytes; ${result.items.length} selections from ${result.scannedFiles} scanned files${result.truncated?" (bounded/truncated)":""}.`,
    ...result.items.map(i=>`${i.path}:${i.startLine} — ${i.reason}`),...result.warnings].join("\n");
}
