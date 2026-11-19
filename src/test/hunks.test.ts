import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diffHunks,applyHunks} from '../hunks.js';
import {ProposalStore} from '../proposals.js';
import {mkdtemp,writeFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('independent hunks preserve untouched text, CRLF, and trailing newline',()=>{
  const before='one\r\ntwo\r\nthree\r\nfour',after='ONE\r\ntwo\r\nTHREE\r\nfour';
  const hunks=diffHunks(before,after);
  assert.equal(hunks.length,2);
  assert.equal(applyHunks(before,hunks,[0]),'ONE\r\ntwo\r\nthree\r\nfour');
  assert.equal(applyHunks(before,hunks,[1]),'one\r\ntwo\r\nTHREE\r\nfour');
  assert.equal(applyHunks(before,hunks,[0,1]),after);
  assert.equal(applyHunks(before,hunks,[]),before);
  assert.throws(()=>applyHunks(before,hunks,[9]),/Unknown/);
});
test('insertion, deletion, empty and bounded large edits reconstruct exactly',()=>{
  for(const [a,b] of [['','new\n'],['old',''],['a\nb\n','a\nnew\nb\n'],['a\nb\n','b\n'],['last\n','last'],['x\n'.repeat(1100),'y\n'.repeat(1100)]]) {
    const hunks=diffHunks(a,b);assert.equal(applyHunks(a,hunks,hunks.map(h=>h.id)),b);
  }
});
test('bounded discovery/search exclude secrets, generated trees and symlink escapes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ff-discover-'));
  try {
    await mkdir(join(root,'src'));await mkdir(join(root,'node_modules'));
    await writeFile(join(root,'src','a.ts'),'hello\nneedle\n');
    await writeFile(join(root,'src','b.ts'),'needle two');
    await writeFile(join(root,'.env'),'needle SECRET');
    await writeFile(join(root,'node_modules','dep.ts'),'needle');
    await symlink('/tmp',join(root,'outside'));
    const store=new ProposalStore(root);
    assert.deepEqual((await store.discover()).files,['src/a.ts','src/b.ts']);
    assert.equal((await store.discover('b.ts')).files.length,1);
    assert.equal((await store.search('needle')).matches.length,2);
    assert.equal((await store.search('needle',1)).truncated,true);
    const proposal=await store.propose('src/a.ts','HELLO\nneedle\n');
    assert.equal(store.preview(proposal.id,[]),'hello\nneedle\n');
    assert.equal(await store.read('src/a.ts'),'hello\nneedle\n');
    store.endRun();await assert.rejects(store.propose('src/a.ts','new'),/No active/);
    store.beginRun();const pending=store.propose('src/a.ts','new');store.endRun();
    await assert.rejects(pending,/discarded/);
  }finally {await rm(root,{recursive:true,force:true});}
});
test('multi-file staging stays on disk unchanged and hunk rejection is isolated',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ff-multi-'));
  try {
    const store=new ProposalStore(root);
    for(const file of ['route.ts','validate.ts','types.ts']) {
      await writeFile(join(root,file),'old\nkeep\nold2\n');
      const p=await store.propose(file,'new\nkeep\nnew2\n');
      assert.equal(p.hunks.length,2);
      assert.equal(store.preview(p.id,[1]),'old\nkeep\nnew2\n');
      assert.equal(await store.read(file),'old\nkeep\nold2\n');
    }
    assert.equal(store.list().length,3);
    store.reject(store.list()[0].id);
    assert.equal(store.list().length,2);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('Git discovery respects ignored untracked paths', async()=>{
  const root=await mkdtemp(join(tmpdir(),'ff-ignore-'));
  try {
    await promisify(execFile)('git',['init','--quiet',root]);
    await writeFile(join(root,'.gitignore'),'private.txt\n');
    await writeFile(join(root,'private.txt'),'do not retrieve');
    await writeFile(join(root,'public.txt'),'hello');
    assert.deepEqual((await new ProposalStore(root).discover()).files,['public.txt']);
  }finally {await rm(root,{recursive:true,force:true});}
});

test('small edits far apart in a large file remain separately reviewable',()=>{
  const middle=Array.from({length: 2000},(_,i)=>`unchanged ${i}\n`).join('');
  const before='old first\n'+middle+'old last\n';
  const after='new first\n'+middle+'new last\n';
  const hunks=diffHunks(before,after);
  assert.equal(hunks.length,2);
  assert.equal(applyHunks(before,hunks,[1]),'old first\n'+middle+'new last\n');
  assert.equal(applyHunks(before,hunks,[0,1]),after);
});
