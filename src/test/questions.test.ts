import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runTurn} from '../client.js';
function fixture(options:{toolType?:string; malformed?:boolean; wrongThread?:boolean; duplicate?:boolean; pageTwo?:boolean; choices?:boolean}={}) {
  const posts:any[]=[], calls:string[]=[];
  const source={type:'model.message',id:'source',threadId:options.wrongThread?'wrong':'thread',toolCalls:[{
    id:'question-call',toolInfo:{type:options.toolType??'truefoundry-system',name:'ask_user_question',serverName:'patchlight-editor'},
    function:{name:'ask_user_question',arguments:options.malformed?'{invalid':JSON.stringify({question:'Which output format?',...(options.choices?{options:['JSON','plain text']}:{})})},
  }]};
  const page={data:[source],hasNextPage:()=>false};
  const event={type:'tool.response_required',threadId:'thread',toolCalls:[{id:'question-call',sourceEventId:'source'}]};
  const client={sessions:{
    create:async()=>{calls.push('create');return {data:{id:'session'}};},
    createTurnStream:async function*(){
      yield {type:'turn.created',turnId:'turn'};
      yield {type:'model.message.delta',id:'source',threadId:'thread'};
      yield event;if(options.duplicate)yield event;
      yield {type:'turn.done',state:{status:'done',requiredActions:[]}};
    },
    listTurnEvents:async()=>options.pageTwo?{data:[],hasNextPage:()=>true,getNextPage:async()=>page}:page,
    createTurnEvents:async(session:string,turn:string,body:any)=>posts.push({session,turn,...body}),
    cancel:async()=>calls.push('cancel'),
  }} as unknown as Parameters<typeof runTurn>[0];
  return {client,posts,calls};
}
test('built-in question from persisted event is surfaced and answered once on same turn',async()=>{
  const f=fixture({duplicate:true,pageTwo:true});let questions=0;
  await runTurn(f.client,'model','prompt',()=>{}, {onQuestion:async q=>{questions++;assert.equal(q,'Which output format?');return 'JSON';}});
  assert.equal(questions,1);
  assert.deepEqual(f.posts,[{session:'session',turn:'turn',events:[{type:'user.tool_response',threadId:'thread',toolCallId:'question-call',content:'JSON'}]}]);
});
test('missing question UI fails visibly, cancels remote and does not fallback',async()=>{
  const f=fixture();
  await assert.rejects(runTurn(f.client,'model','prompt',()=>{}, {fallbackModel:'fallback'}),/needs a user answer: Which output format/);
  assert.deepEqual(f.calls,['create','cancel']);assert.equal(f.posts.length,0);
});
test('unknown tool, wrong thread or malformed arguments never reach question UI',async()=>{
  for(const option of [{toolType:'mcp'},{wrongThread:true},{malformed:true}]) {
    const f=fixture(option);let questions=0;
    await assert.rejects(runTurn(f.client,'model','prompt',()=>{}, {onQuestion:async()=>{questions++;return 'yes';}}),/unsupported or malformed/);
    assert.equal(questions,0);assert.equal(f.posts.length,0);assert.deepEqual(f.calls,['create','cancel']);
  }
});
test('question cancellation and dismissal do not send responses or fallback',async()=>{
  for(const stalled of [false,true]) {
    const f=fixture(),controller=new AbortController();
    await assert.rejects(runTurn(f.client,'model','prompt',()=>{}, {signal:controller.signal,fallbackModel:'fallback',
      onQuestion:async()=>{if(!stalled)return undefined;setTimeout(()=>controller.abort(),5);return new Promise<string>(()=>{});},
    }),/cancelled/);
    assert.equal(f.posts.length,0);assert.deepEqual(f.calls,['create','cancel']);
  }
});
test('blank and oversized answers are never sent',async()=>{
  for(const answer of [' ', 'x'.repeat(16001)]) {
    const f=fixture();await assert.rejects(runTurn(f.client,'model','prompt',()=>{}, {onQuestion:async()=>answer}),/1–16000/);
    assert.equal(f.posts.length,0);assert.deepEqual(f.calls,['create','cancel']);
  }
});

test('question choices are displayed instead of silently discarded',async()=>{
  const f=fixture({choices:true});
  await runTurn(f.client,'model','prompt',()=>{}, {onQuestion:async question=>{
    assert.equal(question,'Which output format?\n\nOptions:\n- JSON\n- plain text');return 'JSON';
  }});
  assert.equal(f.posts[0].events[0].content,'JSON');
});
