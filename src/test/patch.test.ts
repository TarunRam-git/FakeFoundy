import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProposalStore} from '../proposals.js';
async function fixture(run:(store:ProposalStore,root:string)=>Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),'ff-patch-'));
  try { await writeFile(join(root,'a.py'),'HEADER\ndef selected():\n    return 1\n\nFOOTER\n'); await writeFile(join(root,'b.py'),'other'); await run(new ProposalStore(root),root); }
  finally {await rm(root,{recursive:true,force:true});}
}
test('scoped patch preserves whole file outside selection and disables full-file tool',async()=>fixture(async s=>{
  const selected='def selected():\n    return 1';
  s.setInlineScope({path:'a.py',oldText:selected});
  await assert.rejects(s.propose('a.py','def selected():\n    return 2'),/full-file replacement is disabled/);
  await assert.rejects(s.proposePatch('b.py',selected,'bad'),/selected file/);
  await assert.rejects(s.proposePatch('a.py','return 1','return 2'),/selected old_text/);
  const p=await s.proposePatch('a.py',selected,'def selected():\n    return 2');
  assert.equal(p.after,'HEADER\ndef selected():\n    return 2\n\nFOOTER\n');
  assert.equal(await s.read('a.py'),p.before);
  await assert.rejects(s.proposePatch('a.py',selected,'x'),/Conflicting/);
}));
test('patch rejects empty, ambiguous, stale and cancelled requests',async()=>fixture(async(s,root)=>{
  await assert.rejects(s.proposePatch('a.py','','x'),/non-empty/);
  await assert.rejects(s.proposePatch('a.py','missing','x'),/does not match/);
  await writeFile(join(root,'a.py'),'same same');
  await assert.rejects(s.proposePatch('a.py','same','x'),/not unique/);
  const pending=s.proposePatch('a.py','same same','new');s.endRun();
  await assert.rejects(pending,/discarded/);
  assert.equal(s.list().length,0);
}));
test('patch cannot erase surrounding 636 lines when supplied only replacement function',async()=>fixture(async(s,root)=>{
  const prefix='keep prefix\n'.repeat(318),suffix='keep suffix\n'.repeat(318);
  await writeFile(join(root,'a.py'),prefix+'old function\n'+suffix);
  s.setInlineScope({path:'a.py',oldText:'old function'});
  const p=await s.proposePatch('a.py','old function','new function');
  assert.equal(p.after,prefix+'new function\n'+suffix);
  assert.equal(p.hunks.length,1);
  assert.equal(p.hunks[0].deleteCount,1);
}));
test('concurrent patches cannot create conflicting pending proposals',async()=>fixture(async s=>{
  const results=await Promise.allSettled([
    s.proposePatch('a.py','return 1','return 2'),s.proposePatch('a.py','return 1','return 3'),
  ]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(s.list().length,1);
}));
test('selection tool captures exact whitespace without requiring model to repeat it',async()=>fixture(async(s,root)=>{
  const selection='    def sample():\r\n        return 1\r\n';
  const before='prefix\r\n'+selection+'suffix\r\n';
  await writeFile(join(root,'a.py'),before);
  await assert.rejects(s.proposeSelection('new'),/active inline selection/);
  const scope={path:'a.py',oldText:selection};s.setInlineScope(scope);
  scope.path='b.py';scope.oldText='other'; // caller cannot mutate captured identity
  const p=await s.proposeSelection('    def sample():\r\n        return 2\r\n');
  assert.equal(p.after,'prefix\r\n    def sample():\r\n        return 2\r\nsuffix\r\n');
  assert.equal(await s.read('a.py'),before);
  s.reject(p.id);s.endRun();
  await assert.rejects(s.proposeSelection('no'),/No active/);
  s.beginRun();await writeFile(join(root,'a.py'),'changed');
  await assert.rejects(s.proposeSelection('no'),/does not match/);
}));
test('disjoint same-file patches compose from original offsets, retain one proposal and independent hunks',async()=>fixture(async s=>{
  const before=await s.read('a.py');
  const first=await s.proposePatch('a.py','HEADER','LONGER HEADER');
  const second=await s.proposePatch('a.py','FOOTER','END');
  assert.equal(second.id,first.id);
  assert.equal(s.list().length,1);
  assert.equal(second.before,before);
  assert.equal(second.after,before.replace('HEADER','LONGER HEADER').replace('FOOTER','END'));
  assert.equal(second.hunks.length,2);
  assert.equal(s.preview(second.id,[0]),before.replace('HEADER','LONGER HEADER'));
  assert.equal(await s.read('a.py'),before);
  await assert.rejects(s.proposePatch('a.py','HEAD','x'),/overlaps/);
  assert.equal(s.get(second.id).after,second.after);
}));
test('concurrent disjoint patches compose and stale/full-file proposals fail closed',async()=>fixture(async(s,root)=>{
  await Promise.all([s.proposePatch('a.py','HEADER','A'),s.proposePatch('a.py','FOOTER','B')]);
  assert.equal(s.list().length,1);assert.match(s.list()[0].after,/^A\n/);assert.match(s.list()[0].after,/B\n$/);
  await writeFile(join(root,'a.py'),'changed');
  await assert.rejects(s.proposePatch('a.py','changed','new'),/changed since/);
  s.reject(s.list()[0].id);
  await s.propose('a.py','full');
  await assert.rejects(s.proposePatch('a.py','changed','new'),/full-file/);
}));
test('composition cannot modify proposals retained from earlier runs',async()=>fixture(async s=>{
  s.beginRun();const p=await s.proposePatch('a.py','HEADER','A');s.endRun();s.beginRun();
  await assert.rejects(s.proposePatch('a.py','FOOTER','B'),/earlier run/);
  assert.equal(s.get(p.id).after,p.after);
}));
test('patch limits prevent oversized replacement workarounds',async()=>fixture(async s=>{
  await assert.rejects(s.proposePatch('a.py','HEADER','x'.repeat(24001)),/range too large/);
  await assert.rejects(s.proposePatch('a.py','line\n'.repeat(201),'x'),/range too large/);
  assert.equal(s.list().length,0);
}));
test('double-escaped newline mismatch gives actionable guidance without silently changing input',async()=>fixture(async s=>{
  await assert.rejects(s.proposePatch('a.py','def selected():\\n    return 1','new'),/literal backslash-n.*actual newline/);
  assert.equal(s.list().length,0);
  const p=await s.proposePatch('a.py','def selected():\n    return 1','def selected():\n    return 2');
  assert.match(p.after,/return 2/);
}));
test('literal backslash-n remains literal when it is real file content',async()=>fixture(async(s,root)=>{
  await writeFile(join(root,'a.py'),'value="literal\\ntext"\n');
  const p=await s.proposePatch('a.py','literal\\ntext','replaced');
  assert.equal(p.after,'value="replaced"\n');
}));

test('captured inline offset disambiguates duplicate text and rejects stale source',async()=>fixture(async(s,root)=>{
  const before='same\nkeep\nsame\n';
  await writeFile(join(root,'a.py'),before);
  const scope={path:'a.py',oldText:'same',selection:{start:10,document:before}};
  s.setInlineScope(scope);
  scope.selection.start=0;
  const p=await s.proposeSelection('edited');
  assert.equal(p.after,'same\nkeep\nedited\n');
  assert.equal(await s.read('a.py'),before);
  s.reject(p.id);
  await writeFile(join(root,'a.py'),before.replace('keep','user'));
  await assert.rejects(s.proposeSelection('rejected'),/changed since the inline selection/);
  assert.equal(s.list().length,0);
}));

test('a rejected multiline anchor identifies a unique matching original line', async()=>fixture(async s=>{
  const before=await s.read('a.py');
  await assert.rejects(s.proposePatch('a.py','def selected():\n    return 999','replacement'),/Original line 2 matches exactly: "def selected\(\):"/);
  assert.equal(s.list().length,0);
  assert.equal(await s.read('a.py'),before);
}));

test('explicit revision replaces only the same original range and leaves other staged edits intact', async()=>fixture(async s=>{
  const before=await s.read('a.py');
  const first=await s.proposePatch('a.py','return 1','return 2');
  await s.proposePatch('a.py','HEADER','NEW HEADER');
  await assert.rejects(s.proposePatch('a.py','HEADER\n','other',true),/exact original range.*"return 1"/);
  await assert.rejects(s.proposePatch('a.py','return 99','return 3',true),/old_text does not match.*"return 1"/);
  const revised=await s.proposePatch('a.py','return 1','return 3',true);
  assert.equal(revised.id,first.id);
  await assert.rejects(s.proposePatch('a.py','return 3','return 4'),/matches the current staged replacement.*replace_existing: true/);
  const partial = await s.proposePatch('a.py','return 3','return 4',true);
  assert.equal(partial.id,first.id);
  assert.equal(partial.after,before.replace('HEADER','NEW HEADER').replace('return 1','return 4'));
  assert.equal(revised.after,before.replace('HEADER','NEW HEADER').replace('return 1','return 3'));
  assert.equal(await s.read('a.py'),before);
}));
