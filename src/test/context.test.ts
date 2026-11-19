import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ProposalStore} from "../proposals.js";
import {retrieveContext,parseReferences,contextSummary} from "../context.js";
test("reference syntax supports quoted paths and symbols",()=>{
 assert.deepEqual(parseReferences('edit @file:"some file.py" and @symbol:get_debug_flag'),{files:['some file.py'],symbols:['get_debug_flag']});
});
test("retrieval ranks explicit and automatic evidence, enforces budget, excludes secrets",async()=>{
 const root=await mkdtemp(join(tmpdir(),'ff-context-'));
 try {
  await mkdir(join(root,'tests'));
  await writeFile(join(root,'cli.py'),'def config():\n    "print configuration JSON"\n'+('other line\n'.repeat(200)));
  await writeFile(join(root,'tests/test_cli.py'),'def test_config():\n    assert config()\n');
  await writeFile(join(root,'unrelated.txt'),'rainbows\n');
  await writeFile(join(root,'.env'),'API_KEY=secret\n');
  const store=new ProposalStore(root);
  const result=await retrieveContext(store,'Add config JSON test @symbol:config @file:cli.py',{budgetBytes:512});
  assert.ok(result.bytes<=512);assert.equal(result.bytes,Buffer.byteLength(result.text));
  assert.equal(result.items[0].path,'cli.py');assert.match(contextSummary(result),/512 UTF-8 bytes/);
  assert.ok(!result.text.includes('API_KEY'));
  const auto=await retrieveContext(store,'config JSON test');
  assert.ok(auto.items.some(i=>i.path==='tests/test_cli.py'));assert.ok(auto.items.every(i=>i.reason));
  const missing=await retrieveContext(store,'@file:.env @symbol:absent');
  assert.equal(missing.warnings.length,2);
  const controller=new AbortController();controller.abort();
  await assert.rejects(retrieveContext(store,'config',{signal:controller.signal}));
 } finally {await rm(root,{recursive:true,force:true});}
});

test("the initial budget includes matching code, tests and docs across distracting paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "ff-context-family-"));
  try {
    const lines = "layout preview example with configuration values\n".repeat(120);
    const paths = ["src/layout.py", "tests/test_layout.py", "docs/layout.rst",
      "tests/preview/test_settings.py", "tests/preview/test_example.py",
      "tests/preview/test_configuration.py", "tests/preview/test_values.py"];
    for (const path of paths) {
      await mkdir(join(root, path, ".."), {recursive:true});
      await writeFile(join(root, path), lines);
    }
    const result = await retrieveContext(new ProposalStore(root),
      "Add a LAYOUT option to preview configuration values. Document it and add a test.", {budgetBytes:4800});
    for (const path of paths.slice(0,3)) assert.ok(result.items.some(item => item.path === path), path);
    assert.ok(result.bytes <= result.budgetBytes);
    const roomy = await retrieveContext(new ProposalStore(root),
      "Add a LAYOUT option to preview configuration values. Document it and add a test.", {budgetBytes:30000});
    for (const path of paths.slice(0,3)) assert.equal(roomy.items.find(item => item.path === path)?.text, lines);
    assert.equal(roomy.bytes, Buffer.byteLength(roomy.text));
    assert.ok(roomy.bytes <= roomy.budgetBytes);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('filename ranking retrieves a relevant file beyond the discovery output cap', async()=>{
  const root=await mkdtemp(join(tmpdir(),'ff-ranking-cap-'));
  try {
    for(let i=0;i<510;i++) await writeFile(join(root,`a${i}.txt`),'irrelevant content');
    await writeFile(join(root,'z_widget.py'),'def widget():\n    return 42\n');
    const result=await retrieveContext(new ProposalStore(root),'Change widget');
    assert.equal(result.scannedFiles,500);
    assert.equal(result.items[0].path,'z_widget.py');
    assert.equal(result.truncated,true);
  } finally { await rm(root,{recursive:true,force:true}); }
});
