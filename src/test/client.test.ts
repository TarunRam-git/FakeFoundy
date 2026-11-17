import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, createClient } from "../client.js";
function fakeClient(events: unknown[]) {
  return {
    sessions: {
      cancel: async () => ({}),
      create: async () => ({ data: { id: "session-test" } }),
      createTurnStream: async function* () {
        yield* events;
      },
    },
  } as unknown as Parameters<typeof runTurn>[0];
}
test("turn accepts only terminal success and forwards streamed events", async () => {
  const seen: unknown[] = [];
  assert.equal(
    await runTurn(
      fakeClient([{ type: "turn.done", state: { status: "done" } }]),
      "test/model",
      "prompt",
      (e) => seen.push(e),
    ),
    "session-test",
  );
  assert.equal(seen.length, 1);
  await assert.rejects(
    runTurn(fakeClient([]), "test/model", "prompt", () => {}),
    /before terminal/,
  );
  await assert.rejects(
    runTurn(
      fakeClient([
        {
          type: "turn.done",
          state: { status: "error", message: "provider unavailable" },
        },
      ]),
      "test/model",
      "prompt",
      () => {},
    ),
    /provider unavailable/,
  );
  await assert.rejects(
    runTurn(
      fakeClient([{ type: "turn.done", state: { status: "cancelled" } }]),
      "test/model",
      "prompt",
      () => {},
    ),
    /cancelled/,
  );
});
test("client disallows non-local runtime URLs", async () => {
  await assert.rejects(createClient("https://example.com"), /local HTTP/);
});

test("falls back only once, rolls back before retry, and uses configured model", async () => {
  const calls: string[] = [];
  let attempt = 0;
  const client = { sessions: {
    create: async (request: any) => {
      calls.push(request.agent.spec.model.name);
      return { data: { id: `session-${++attempt}` } };
    },
    createTurnStream: async function* () {
      yield { type: "turn.done", state: attempt === 1
        ? { status: "error", message: "quota exceeded" } : { status: "done" } };
    },
  } } as unknown as Parameters<typeof runTurn>[0];
  assert.equal(await runTurn(client, "primary", "prompt", () => {}, {
    fallbackModel: "secondary", onAttemptFailed: () => { calls.push("rollback"); },
  }), "session-2");
  assert.deepEqual(calls, ["primary", "rollback", "secondary"]);
});

test("abort cancels the remote session and never starts fallback", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const client = { sessions: {
    create: async () => { calls.push("create"); return { data: { id: "s" } }; },
    createTurnStream: async function* () {
      controller.abort();
      yield { type: "turn.started" };
    },
    cancel: async (id: string) => { calls.push(`cancel:${id}`); },
  } } as unknown as Parameters<typeof runTurn>[0];
  await assert.rejects(runTurn(client, "primary", "prompt", () => {}, {
    signal: controller.signal, fallbackModel: "secondary",
    onAttemptFailed: () => { calls.push("rollback"); },
  }), /cancelled/);
  assert.deepEqual(calls, ["create", "cancel:s", "rollback"]);
});

test("does not fallback when remote cancellation cannot be confirmed", async () => {
  let attempts = 0;
  const client = { sessions: {
    create: async () => { attempts++; return { data: { id: "s" } }; },
    createTurnStream: async function* () { throw new Error("connection lost"); },
    cancel: async () => { throw new Error("runtime unreachable"); },
  } } as unknown as Parameters<typeof runTurn>[0];
  await assert.rejects(runTurn(client, "primary", "prompt", () => {}, {
    fallbackModel: "secondary",
  }), /Could not confirm TrueForge stopped/);
  assert.equal(attempts, 1);
});

test("already aborted runs create no sessions", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runTurn({} as Parameters<typeof runTurn>[0], "primary", "prompt", () => {}, {
    signal: controller.signal,
  }), /cancelled/);
});

test("duplicate fallback is not retried and unknown terminal states fail", async () => {
  let rolledBack = 0;
  await assert.rejects(runTurn(fakeClient([{ type: "turn.done", state: { status: "unknown" } }]),
    "same", "prompt", () => {}, { fallbackModel: "same", onAttemptFailed: () => { rolledBack++; } }),
    /Unknown TrueForge/);
  assert.equal(rolledBack, 1);
});

function approvalClient(record: any[], onWait?: () => void) {
  return {sessions:{
    create: async (request:any) => { record.push(request.agent.spec.mcpServers[0].requireApprovalForTools); return {data:{id:"s"}}; },
    createTurnStream: async function* () {
      yield {type:"turn.created",turnId:"t"};
      yield {type:"model.message",threadId:"main",id:"m",toolCalls:[{id:"call",toolInfo:{type:"mcp",serverName:"fakefoundy-editor",name:"review_staged_edits"}}]};
      onWait?.();
      yield {type:"tool.approval_required",threadId:"main",toolCalls:[{id:"call",sourceEventId:"m"}]};
      yield {type:"turn.done",state:{status:"done",requiredActions:[]}};
    },
    createTurnEvents: async (session:string,turn:string,request:any) => {record.push({session,turn,...request});},
    cancel: async () => {record.push("cancel");},
  }} as unknown as Parameters<typeof runTurn>[0];
}
test("native approval posts scoped allow on same turn, without another model turn", async () => {
  const calls:any[]=[];
  await runTurn(approvalClient(calls),"model","prompt",()=>{}, {onApproval:async()=>true});
  assert.deepEqual(calls, [["review_staged_edits"],{session:"s",turn:"t",events:[{
    type:"user.tool_approval",threadId:"main",toolCallId:"call",approval:{status:"allow"},
  }]}]);
});
test("native approval denies on rejection or missing reviewer", async () => {
  for (const onApproval of [undefined, async()=>false]) {
    const calls:any[]=[];
    await runTurn(approvalClient(calls),"model","prompt",()=>{}, {onApproval});
    assert.equal(calls[1].events[0].approval.status,"deny");
  }
});
test("cancel or deadline abort during stalled approval stops remote and never sends allow", async () => {
  for (const delay of [0, 10]) {
    const calls:any[]=[]; const controller=new AbortController();
    await assert.rejects(runTurn(approvalClient(calls),"model","prompt",()=>{}, {
      signal:controller.signal,
      onApproval:()=>{setTimeout(()=>controller.abort(),delay); return new Promise<boolean>(()=>{});},
    }), /cancelled/);
    assert.deepEqual(calls,[["review_staged_edits"],"cancel"]);
  }
});
test("pending native actions cannot be reported as terminal success", async () => {
  await assert.rejects(runTurn(fakeClient([{type:"turn.done",state:{status:"done",requiredActions:[{type:"mcp.auth_required"}]}}]),
    "model","prompt",()=>{}), /unresolved required actions/);
});

test("unresolved approval requires remote cleanup before fallback; failed cleanup blocks it", async () => {
  for (const cleanupFails of [false, true]) {
    const calls:string[]=[]; let attempt=0;
    const client={sessions:{
      create:async()=>{calls.push("create"); return {data:{id:`s${++attempt}`}};},
      createTurnStream:async function*(){yield {type:"turn.done",state:{status:"done",requiredActions:attempt===1?[{type:"tool.approval_required"}]:[]}};},
      cancel:async()=>{calls.push("cancel"); if(cleanupFails) throw new Error("unreachable");},
    }} as unknown as Parameters<typeof runTurn>[0];
    const result=runTurn(client,"primary","prompt",()=>{}, {fallbackModel:"fallback"});
    if(cleanupFails) {
      await assert.rejects(result,/Could not confirm TrueForge stopped/);
      assert.deepEqual(calls,["create","cancel"]);
    } else {
      assert.equal(await result,"s2");
      assert.deepEqual(calls,["create","cancel","create"]);
    }
  }
});

test("unknown native approval is denied and duplicate requests are not posted twice", async () => {
  const posted:any[]=[]; let reviewed=0;
  const event={type:"tool.approval_required",threadId:"main",toolCalls:[{id:"unknown",sourceEventId:"unseen"}]};
  const client={sessions:{
    create:async()=>({data:{id:"s"}}),
    createTurnStream:async function*(){
      yield {type:"turn.created",turnId:"t"}; yield event; yield event;
      yield {type:"turn.done",state:{status:"done",requiredActions:[]}};
    },
    createTurnEvents:async (_s:string,_t:string,request:any)=>{posted.push(request);},
    listTurnEvents:async()=>({data:[],hasNextPage:()=>false}),
  }} as unknown as Parameters<typeof runTurn>[0];
  await runTurn(client,"model","prompt",()=>{}, {onApproval:async()=>{reviewed++; return true;}});
  assert.equal(reviewed,0); assert.equal(posted.length,1);
  assert.equal(posted[0].events[0].approval.status,"deny");
});

test("delta-only SSE resolves exact persisted approval source, never trusts unrelated tool metadata", async () => {
  const wrapper = {type:"truefoundry-system", name:"call_tool"};
  const args = {mcp_server:"fakefoundy-editor", tool_name:"review_staged_edits", input:{}};
  const cases = [
    {valid:true, toolInfo:{type:"mcp",serverName:"fakefoundy-editor",name:"review_staged_edits"}},
    {valid:false, toolInfo:{type:"mcp",serverName:"other-server",name:"review_staged_edits"}},
    {valid:true, toolInfo:wrapper, args},
    {valid:false, toolInfo:wrapper, args:{...args, tool_name:"run_terminal"}},
    {valid:false, toolInfo:wrapper, args:{...args, mcp_server:"other-server"}},
  ];
  for (const entry of cases) {
    const valid = entry.valid;
    let reviews=0; const posted:any[]=[];
    const client={sessions:{
      create:async()=>({data:{id:"s"}}),
      createTurnStream:async function*(){
        yield {type:"turn.created",turnId:"t"};
        yield {type:"model.message.delta",id:"m",threadId:"main",content:""};
        yield {type:"tool.approval_required",threadId:"main",toolCalls:[{id:"c",sourceEventId:"m"}]};
        yield {type:"turn.done",state:{status:"done",requiredActions:[]}};
      },
      listTurnEvents:async()=>({data:[{type:"model.message",id:"m",threadId:"main",toolCalls:[{
        id:"c",toolInfo:entry.toolInfo, function:{arguments:JSON.stringify(entry.args)},
      }]}],hasNextPage:()=>false}),
      createTurnEvents:async(_s:string,_t:string,r:any)=>{posted.push(r);},
    }} as unknown as Parameters<typeof runTurn>[0];
    await runTurn(client,"model","prompt",()=>{}, {onApproval:async()=>{reviews++;return true;}});
    assert.equal(reviews,valid?1:0);
    assert.equal(posted[0].events[0].approval.status,valid?"allow":"deny");
  }
});

test("approval identity lookup follows returned SDK pagination pages", async () => {
  let reviews=0, pages=0; const posted:any[]=[];
  const client={sessions:{
    create:async()=>({data:{id:"s"}}),
    createTurnStream:async function*(){
      yield {type:"turn.created",turnId:"t"};
      yield {type:"tool.approval_required",threadId:"main",toolCalls:[{id:"c",sourceEventId:"m"}]};
      yield {type:"turn.done",state:{status:"done",requiredActions:[]}};
    },
    listTurnEvents:async()=>({data:[],hasNextPage:()=>true,getNextPage:async()=>{
      pages++; return {data:[{type:"model.message",id:"m",threadId:"main",toolCalls:[{
        id:"c",toolInfo:{type:"mcp",serverName:"fakefoundy-editor",name:"review_staged_edits"},
      }]}],hasNextPage:()=>false};
    }}),
    createTurnEvents:async(_s:string,_t:string,r:any)=>{posted.push(r);},
  }} as unknown as Parameters<typeof runTurn>[0];
  await runTurn(client,"model","prompt",()=>{}, {onApproval:async()=>{reviews++;return true;}});
  assert.equal(pages,1); assert.equal(reviews,1); assert.equal(posted[0].events[0].approval.status,"allow");
});
