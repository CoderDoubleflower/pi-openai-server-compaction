/** Offline protocol/lifecycle regressions. Never calls a live backend. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { OPERATIONS, namespaceSchema, routerSchema, validateArguments, routeMessage, rewritePayload, rewriteInput,
  encodeEncryptedOutput, projectToolResult, THREAD_HINT_ENDPOINT } from "../src/context-management/protocol.ts";
import { coversModel, nativeBaseUrl, resolveProvider, callBackend, validateResponse, withDeadline } from "../src/context-management/backend.ts";
import { nextWindow, latestWindow, marker, windowMessage, projectMessages, metadataFor, remaining,
  hasCheckpoint, hasFreshUsage, budgetReminder, WINDOW_TYPE } from "../src/context-management/window.ts";
import { createContextManagementExtensionApi } from "../src/context-management/runtime.ts";

const jwt = (account = "test-account") => `x.${Buffer.from(JSON.stringify({"https://api.openai.com/auth": {chatgpt_account_id: account}})).toString("base64url")}.x`;
const native = {provider: "openai-codex", api: "openai-codex-responses", id: "test-model", baseUrl: "https://codex.example/backend-api/codex", contextWindow: 100_000};
const remoteConfig = {enabled: true, contextManagement: "remote", contextReminderThresholdPercent: 10, contextManagementGatewayModels: []};
const boundary = (window) => ({ type: "custom_message", id: window.id, ...windowMessage(window) });
const messageBoundary = (window) => ({ role: "custom", ...windowMessage(window) });
const entry = (message) => ({type:"message", id: "entry-" + Math.random(), message});
const assistant = (id = "tool-1") => ({role:"assistant", stopReason:"toolUse", usage:{totalTokens: 20_000}, content:[{type:"toolCall",id,namespace:"notes",name:"notes",arguments:{action:"write_file",path:"state",text:"opaque"}}]});
const noteResult = (w) => ({role:"toolResult",toolName:"notes",toolCallId:"tool-1",isError:false,content:[{type:"text",text:"notes operation completed"}],details:{codexHistoryNotes:{encrypted_output:"cipher"},remoteContextOrigin:{sessionId:w.sessionId,scope:w.scope,windowId:w.currentWindowId,checkpoint:true}}});

function harness(config = remoteConfig) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-remote-context-"));
  mkdirSync(join(cwd, ".pi"));
  const configure = (value) => writeFileSync(join(cwd,".pi/openai-server-compaction.json"), JSON.stringify(value));
  configure(config);
  const branch = [], queued = [], hooks = new Map(), definitions = [], notices = [], clears = [];
  let activeTools = ["read","bash"], sessionId = "session-a", usage = {tokens:20_000,contextWindow:100_000};
  const ctx = {cwd, model:{...native}, hasUI:true, ui:{notify:(...args)=>notices.push(args)}, aborted:false,
    abort(){this.aborted=true;}, sessionManager:{getSessionId:()=>sessionId,getBranch:()=>branch},
    modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true,apiKey:jwt(),headers:{}})}, getContextUsage:()=>usage};
  const pi = {registerTool(tool){definitions.push(tool);activeTools.push(tool.name);},getAllTools:()=>definitions,
    getActiveTools:()=>activeTools,setActiveTools:(names)=>{activeTools=names;},
    on(name,fn){if(!hooks.has(name))hooks.set(name,[]);hooks.get(name).push(fn);},
    sendMessage(message,options){if(options?.deliverAs==="steer")queued.push(message);else branch.push({type:"custom_message",id:message.details.remoteContext.id,...message});}};
  const proxy = createContextManagementExtensionApi(pi, id=>clears.push(id));
  const legacy = {compact:0,request:0,message:0};
  proxy.on("session_before_compact",()=>{legacy.compact++;return {legacy:true};});
  proxy.on("before_provider_request",event=>{legacy.request++;return {...event.payload,legacy:true};});
  proxy.on("message_end",()=>{legacy.message++;});
  async function emit(name,event={}) {let result; for (const hook of hooks.get(name)??[]) {const next=await hook(event,ctx);if(next!==undefined)result=next;} return result;}
  const tool = (name,params={})=>definitions.find(t=>t.name===name).execute("tool-1",params,new AbortController().signal,()=>{},ctx);
  const flush = ()=>{for(const message of queued.splice(0))branch.push({type:"custom_message",id:message.details.remoteContext.id,...message});};
  const messages = ()=>branch.flatMap(e=>e.type==="message"?[e.message]:e.type==="custom_message"?[{role:"custom",...e}]:[]);
  return {ctx,pi,proxy,branch,queued,definitions,legacy,notices,clears,configure,emit,tool,flush,messages,
    getActive:()=>activeTools,setSession:(id)=>{sessionId=id;},setUsage:(value)=>{usage=value;},cleanup:()=>rmSync(cwd,{recursive:true,force:true})};
}
async function mockFetch(value, fn) {
  const original=globalThis.fetch; const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(typeof value==="function"?value(url,options):value),{status:200});};
  try{return await fn(calls);}finally{globalThis.fetch=original;}
}

test("config defaults, project values, strict mode, zero reminder and env overrides",()=>{
  const h=harness({});
  try {
    assert.equal(loadConfig(h.ctx.cwd).contextManagement,"off");
    assert.equal(loadConfig(h.ctx.cwd).model,"current");
    h.configure({...remoteConfig,contextReminderThresholdPercent:0,contextManagementGatewayModels:["custom/a","custom/a"]});
    assert.equal(loadConfig(h.ctx.cwd).contextReminderThresholdPercent,0);
    assert.deepEqual(loadConfig(h.ctx.cwd).contextManagementGatewayModels,["custom/a"]);
    const key="PI_OPENAI_SERVER_COMPACTION_CONTEXT_MANAGEMENT",old=process.env[key];
    try {process.env[key]="off"; assert.equal(loadConfig(h.ctx.cwd).contextManagement,"off");}
    finally {if(old===undefined)delete process.env[key];else process.env[key]=old;}
    h.configure({contextManagement:"maybe"});assert.equal(loadConfig(h.ctx.cwd).contextManagement,"off");
  } finally {h.cleanup();}
});

test("reserved namespace schemas, encryption annotations and router validation",()=>{
  for(const ns of ["history","notes"]){
    const schema=namespaceSchema(ns);assert.equal(schema.type,"namespace");
    assert.deepEqual(schema.tools.map(t=>t.name),Object.keys(OPERATIONS[ns]));
    for(const tool of schema.tools){assert.equal(tool.strict,false);assert.equal(tool.parameters.additionalProperties,undefined);}
    assert.equal(routerSchema(ns).additionalProperties,false);
  }
  assert.equal(namespaceSchema("notes").tools.find(t=>t.name==="write_file").parameters.properties.text.encrypted,true);
  assert.equal(routerSchema("notes").properties.text.encrypted,undefined);
  assert.throws(()=>validateArguments("history","__proto__",{}));
  assert.throws(()=>validateArguments("history","read_item",{item_id:"id"}));
  assert.throws(()=>validateArguments("notes","write_file",{path:"p",text:"t",context:{session_id:"other"}}));
  assert.equal(validateArguments("notes","write_file",{action:"write_file",path:"p",text:"t"}),"alpha/notes/v2/write_file");
});

test("native namespace routing round-trips without argument action override",()=>{
  const original={role:"assistant",content:[{type:"toolCall",id:"id",namespace:"notes",name:"write_file",arguments:{action:"read_file",path:"p",text:"opaque"}}]};
  const routed=routeMessage(original);assert.equal(routed.content[0].name,"notes");assert.equal(routed.content[0].arguments.action,"write_file");
  assert.equal(original.content[0].name,"write_file");
  const restored=rewriteInput([{type:"function_call",namespace:"notes",name:"notes",arguments:JSON.stringify(routed.content[0].arguments)}]);
  assert.equal(restored[0].name,"write_file");assert.deepEqual(JSON.parse(restored[0].arguments),{path:"p",text:"opaque"});
});

test("payload merges metadata, preserves prompt cache and rewrites encrypted outputs",()=>{
  const w=nextWindow([],"s","scope");
  const payload={model:"m",input:[{type:"function_call_output",call_id:"id",output:encodeEncryptedOutput("cipher")}],tools:[{type:"function",name:"notes"}],
    prompt_cache_key:"cache",store:false,previous_response_id:"old",context_management:[{}],client_metadata:{other:"x","x-codex-turn-metadata":JSON.stringify({turn_id:"turn"})}};
  const result=rewritePayload(payload,metadataFor(w));
  assert.equal(result.input[0].output[0].type,"encrypted_content");assert.equal(result.input[0].output[0].encrypted_content,"cipher");
  assert.equal(result.prompt_cache_key,"cache");assert.equal(result.store,false);assert.equal(result.previous_response_id,undefined);assert.equal(result.context_management,undefined);
  assert.equal(result.tools[0].type,"namespace");
  const metadata=JSON.parse(result.client_metadata["x-codex-turn-metadata"]);assert.equal(metadata.turn_id,"turn");assert.equal(metadata.history_ingest_requested,true);assert.equal(metadata.window_id,"s:0");
  assert.throws(()=>rewritePayload({...payload,client_metadata:"bad"},metadataFor(w)));
  assert.throws(()=>rewriteInput([{type:"function_call_output",output:"\0pi-openai-server-compaction:encrypted-output:bad"}]));
  assert.equal(payload.previous_response_id,"old");
});

test("initial activation preserves prior history, rollover drops only outgoing old window and orphan outputs",()=>{
  const w=nextWindow([],"s","scope"),first=messageBoundary(w),old={role:"user",content:"keep initially"};
  assert.deepEqual(projectMessages([old,first],w),[old,first]);
  const next=nextWindow([boundary(w)],"s","scope",w);
  const projected=projectMessages([old,first,messageBoundary(next),{role:"toolResult",toolCallId:"orphan"},{role:"user",content:"new"}],next);
  assert.equal(projected.length,2);assert.equal(projected[1].content,"new");
  assert.deepEqual(projectMessages([old,first]),[old]);
  assert.equal(latestWindow([boundary(w),boundary(next)],"s","scope").currentWindowId,next.currentWindowId);
  assert.equal(latestWindow([boundary(w)],"other","scope"),undefined);
  assert.equal(latestWindow([boundary(w)],"s","other"),undefined);
  assert.throws(()=>marker({customType:WINDOW_TYPE,details:{remoteContext:{sessionId:"s"}}},"s"));
});

test("checkpoint and encrypted projection are bound to session, account scope and current window",()=>{
  const w=nextWindow([],"s","scope"),result=noteResult(w),entries=[boundary(w),entry(result)];
  assert.equal(hasCheckpoint(entries,w),true);
  assert.equal(hasCheckpoint([boundary(w),entry({...result,isError:true})],w),false);
  assert.equal(hasCheckpoint(entries,{...w,currentWindowId:"different"}),false);
  assert.match(projectMessages([result],w)[0].content[0].text,/encrypted-output/);
  assert.equal(projectMessages([result],{...w,scope:"different"})[0].content[0].text,"notes operation completed");
  assert.equal(projectToolResult(result,false),result);
});

test("budget keeps 16384 reserve, suppresses stale usage and once-per-window reminders",()=>{
  const w=nextWindow([],"s","scope"),entries=[boundary(w),entry(assistant())];
  assert.equal(remaining(100_000,20_000).remainingTokens,63_616);
  assert.equal(remaining(100_000,null).remainingTokens,undefined);
  assert.equal(hasFreshUsage(entries,w),true);
  const notice=budgetReminder(entries,w,10,remaining(100_000,80_000));assert.equal(notice.kind,"reminder");
  assert.equal(budgetReminder([...entries,boundary(notice)],w,10,remaining(100_000,80_000)),undefined);
  const next=nextWindow(entries,"s","scope",w);assert.equal(hasFreshUsage([...entries,boundary(next)],next),false);
  assert.equal(budgetReminder(entries,w,0,remaining(100_000,99_000)),undefined);
});

test("native provider resolution uses effective auth URL/account; gateway is explicit and strips sensitive headers",async()=>{
  const h=harness();
  try{
    h.ctx.modelRegistry.getApiKeyAndHeaders=async()=>({ok:true,apiKey:jwt(),baseUrl:"https://other.example/backend-api/codex/responses",headers:{"x-custom":"preserve"}});
    const nativeProvider=await resolveProvider(h.ctx,remoteConfig);
    assert.equal(nativeProvider.baseUrl,"https://other.example/backend-api/codex");assert.equal(nativeProvider.headers.get("chatgpt-account-id"),"test-account");
    assert.equal(nativeBaseUrl("https://a.example/api"),"https://a.example/api/codex");assert.throws(()=>nativeBaseUrl("https://a.example/v1"));
    h.ctx.model={...native,provider:"gateway",api:"openai-responses",baseUrl:"https://gw.example/v1"};
    const cfg={...remoteConfig,contextManagementGatewayModels:["gateway/test-model"]};
    assert.equal(coversModel(h.ctx.model,remoteConfig),false);assert.equal(coversModel(h.ctx.model,cfg),true);
    h.ctx.modelRegistry.getApiKeyAndHeaders=async()=>({ok:true,apiKey:"test-data-key",headers:{Cookie:"private","CHATGPT-ACCOUNT-ID":"private","X-API-Key":"private","x-extra":"yes"}});
    const gw=await resolveProvider(h.ctx,cfg);
    for(const name of ["cookie","chatgpt-account-id","x-api-key"])assert.equal(gw.headers.get(name),null);
    assert.equal(gw.headers.get("authorization"),"Bearer test-data-key");assert.equal(gw.headers.get("x-extra"),"yes");
    await assert.rejects(resolveProvider(h.ctx,{...cfg,contextManagementGatewayBaseUrl:"https://third-party.example"}),/same origin/);
    h.ctx.modelRegistry.getApiKeyAndHeaders=async()=>({ok:true,apiKey:jwt(),headers:{}});
    await assert.rejects(resolveProvider(h.ctx,cfg),/OAuth/);
  }finally{h.cleanup();}
});

test("backend request uses alpha encrypted contract and enforces remote failures, aborts and session race",async()=>{
  const h=harness();
  try{
    const calls=[];
    const fetcher=async(url,options)=>{calls.push({url,options});return new Response('{"encrypted_output":"cipher"}');};
    await callBackend(h.ctx,remoteConfig,"alpha/notes/v2/write_file",{path:"p",text:"opaque"},undefined,fetcher);
    const c=calls[0];assert.match(c.url,/alpha\/notes\/v2\/write_file$/);assert.equal(c.options.redirect,"error");
    assert.equal(c.options.headers.get("x-openai-encrypted-tool-arguments"),"true");
    assert.deepEqual(JSON.parse(c.options.body).context,{session_id:"session-a",current_agent_name:"/root"});
    assert.throws(()=>validateResponse({success:false},"alpha/notes/v2/write_file"),/not successful/);
    assert.throws(()=>validateResponse({windows:{}},"alpha/history/v2/list_windows"));
    assert.throws(()=>validateResponse({encrypted_output:""},"alpha/history/v2/read_item"));
    const abort=new AbortController();abort.abort();await assert.rejects(callBackend(h.ctx,remoteConfig,THREAD_HINT_ENDPOINT,{},abort.signal,fetcher),/aborted/);
    assert.equal(calls.length,1);
    h.ctx.modelRegistry.getApiKeyAndHeaders=async()=>{h.setSession("changed");return {ok:true,apiKey:jwt(),headers:{}};};
    await assert.rejects(callBackend(h.ctx,remoteConfig,THREAD_HINT_ENDPOINT,{},undefined,fetcher),/session\/model changed/);
    assert.equal(calls.length,1);
    // AbortSignal.timeout uses an unref timer. Keep the loop alive for this test only.
    const keep=setTimeout(()=>{},1000);
    try{await assert.rejects(withDeadline(()=>new Promise(()=>{}),undefined,10),/timed out/);}finally{clearTimeout(keep);}
  }finally{h.cleanup();}
});

test("default-off leaves old hooks working and hides only owned context tools",async()=>{
  const h=harness({contextManagement:"off"});
  try{await h.emit("session_start");assert.deepEqual(h.getActive(),["read","bash"]);assert.equal(h.branch.length,0);
    assert.deepEqual(await h.emit("session_before_compact"),{legacy:true});
    assert.equal((await h.emit("before_provider_request",{payload:{model:"m",input:[]}})).legacy,true);
    assert.deepEqual(h.legacy,{compact:1,request:1,message:0});
  }finally{h.cleanup();}
});

test("covered models never run legacy compression or replay, even when authentication fails",async()=>{
  const h=harness();
  try{
    await h.emit("session_start");assert.equal(h.branch.length,1);assert.equal(h.getActive().length,6);
    assert.deepEqual(await h.emit("session_before_compact"),{cancel:true});
    const result=await h.emit("before_provider_request",{payload:{model:"m",input:[],previous_response_id:"legacy",tools:[{type:"function",name:"history"}]}});
    assert.equal(result.previous_response_id,undefined);assert.equal(result.tools[0].type,"namespace");
    h.ctx.modelRegistry.getApiKeyAndHeaders=async()=>({ok:false,error:"secret token must not be printed"});
    assert.deepEqual(await h.emit("session_before_compact"),{cancel:true});
    await assert.rejects(h.emit("before_provider_request",{payload:{model:"m",input:[]}}),/authentication/);
    assert.equal(h.ctx.aborted,true);assert.deepEqual(h.legacy,{compact:0,request:0,message:0});assert.ok(h.clears.length>0);
    assert.equal(JSON.stringify(h.notices).includes("secret token"),false);
  }finally{h.cleanup();}
});

test("end-to-end notes checkpoint, pending rollover, fresh metadata, local history retention and disabling",async()=>{
  const h=harness();
  try{await mockFetch((url)=>url.endsWith("thread_hint")?{text:"Read notes/state"}:{encrypted_output:"cipher"},async(calls)=>{
    h.branch.push(entry({role:"user",content:"prior request"}));await h.emit("session_start");
    await assert.rejects(h.tool("new_context"),/checkpoint/);
    h.branch.push(entry(assistant()));const result=await h.tool("notes",{action:"write_file",path:"state",text:"encrypted-args"});
    h.branch.push(entry({role:"toolResult",toolName:"notes",toolCallId:"tool-1",isError:false,...result}));
    assert.equal(JSON.parse(calls[0].options.body).action,undefined);
    const old=(await h.emit("before_provider_request",{payload:{model:"m",input:[]}})).client_metadata["x-codex-window-id"];
    assert.equal((await h.tool("new_context")).details.started,true);
    assert.equal((await h.tool("new_context")).details.started,false);assert.equal(h.queued.length,1);
    const beforeFlush=await h.emit("before_provider_request",{payload:{model:"m",input:[]}});
    assert.equal(beforeFlush.client_metadata["x-codex-window-id"],old);
    h.flush();const projected=await h.emit("context",{messages:h.messages()});assert.equal(projected.messages.length,1);
    const next=await h.emit("before_provider_request",{payload:{model:"m",input:[]}});assert.notEqual(next.client_metadata["x-codex-window-id"],old);
    assert.equal((await h.tool("get_context_remaining")).details.remainingTokens,undefined);
    await assert.rejects(h.tool("new_context"),/checkpoint/);
    assert.equal(h.branch.some(e=>e.message?.content==="prior request"),true);
    h.configure({enabled:true,contextManagement:"off"});const restored=await h.emit("context",{messages:h.messages()});
    assert.equal(restored.messages[0].content,"prior request");assert.equal(restored.messages.some(m=>m.customType===WINDOW_TYPE),false);
    assert.deepEqual(h.getActive(),["read","bash"]);
  });}finally{h.cleanup();}
});

test("HTTP-200 failed notes writes never grant rollover; invalid/missing boundaries abort safely",async()=>{
  const h=harness();
  try{await h.emit("session_start");await mockFetch({success:false},async()=>{
    await assert.rejects(h.tool("notes",{action:"write_file",path:"p",text:"opaque"}),/not successful/);
    await assert.rejects(h.tool("new_context"),/checkpoint/);
  });
    const w=h.branch[0].details.remoteContext;h.branch.push(boundary(nextWindow(h.branch,w.sessionId,w.scope,w)));
    await assert.rejects(h.emit("context",{messages:[]}),/boundary is missing/);assert.equal(h.ctx.aborted,true);
  }finally{h.cleanup();}
});

test("session/fork isolation, branch restore and tool-name conflict fail closed",async()=>{
  const h=harness();
  try{await h.emit("session_start");const first=h.branch[0].details.remoteContext;
    await h.emit("session_start");assert.equal(h.branch.length,1); // reload restores, does not duplicate
    await h.emit("session_before_fork");h.setSession("forked");await h.emit("session_start");
    const second=h.branch.at(-1).details.remoteContext;assert.notEqual(second.firstWindowId,first.firstWindowId);assert.equal(second.sessionId,"forked");
    const tool=h.definitions.find(t=>t.name==="notes");tool.parameters={type:"object"};
    // Mutating the original definition also changes the expected identity; replace inventory item instead.
    h.definitions[h.definitions.indexOf(tool)]={...tool,parameters:{type:"object"},description:"foreign notes"};
    await assert.rejects(h.emit("before_provider_request",{payload:{model:"m",input:[]}}),/conflict/);
  }finally{h.cleanup();}
});
