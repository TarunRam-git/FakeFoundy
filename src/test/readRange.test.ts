import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProposalStore} from '../proposals.js';
test('bounded ranges reconstruct large source and retain middle functions without ellipsis',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ff-range-'));
  try {
    const source=Array.from({length:1000},(_,i)=>`line ${i+1}: function example_${i}() {}\r\n`).join('');
    await writeFile(join(root,'large.ts'),source);
    const s=new ProposalStore(root);
    const middle=await s.readRange('large.ts',500,3);
    assert.equal(middle.text,source.split(/(?<=\n)/).slice(499,502).join(''));
    let next:{start_line:number;start_column:number}|null={start_line:1,start_column:0},text='';
    while(next) {const page=await s.readRange('large.ts',next.start_line,40,next.start_column);assert.ok(page.text.length<=8000);text+=page.text;next=page.next;}
    assert.equal(text,source);
    await assert.rejects(s.readRange('large.ts',0),/Invalid/);
    await assert.rejects(s.readRange('large.ts',2000),/outside/);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('long unicode lines continue exactly and EOF/empty files are explicit',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ff-range-'));
  try {
    const s=new ProposalStore(root),source='x'+'🐈'.repeat(10000)+'\nlast';
    await writeFile(join(root,'long.txt'),source);
    let next:{start_line:number;start_column:number}|null={start_line:1,start_column:0},text='';
    while(next) {const p=await s.readRange('long.txt',next.start_line,40,next.start_column);assert.ok(!p.text.includes('�'));text+=p.text;next=p.next;}
    assert.equal(text,source);
    assert.equal((await s.readRange('long.txt',3)).has_more,false);
    await writeFile(join(root,'empty.txt'),'');assert.equal((await s.readRange('empty.txt')).text,'');
  } finally {await rm(root,{recursive:true,force:true});}
});
