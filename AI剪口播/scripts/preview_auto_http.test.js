'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {createCallbackConfig,markerFingerprint}=require('./codex_callback');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<150;i++){const value=check();if(value)return value;await delay(40);}throw Error('condition timed out');}
const makeMarkers=n=>Array.from({length:n},(_,i)=>({id:'m'+(i+1),previewTime:i+1,comment:'test '+(i+1)}));
async function serverFixture(t,orphan=false){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'koubo-http-auto-'));const video=path.join(root,'preview.mp4');fs.writeFileSync(video,'unchanged video fixture');
 const cli=path.join(root,'test-codex');
 fs.writeFileSync(cli,`#!/usr/bin/env node
const fs=require('fs'),path=require('path');let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{
 const comments=prompt.match(/本批不可变批注 JSON[^\\n]*：([^\\n]+)/)[1].trim();const result=prompt.match(/本次结构化结果：([^\\n]+)/)[1].trim();
 const markers=JSON.parse(fs.readFileSync(comments)).markers;fs.appendFileSync(path.join(process.cwd(),'dispatch.jsonl'),JSON.stringify(markers.map(m=>m.id))+'\\n');
 setTimeout(()=>{const page=path.join(path.dirname(result),'review.html');fs.writeFileSync(page,'<h1>dispatch fixture result</h1>');fs.writeFileSync(result,JSON.stringify({resultPage:page,items:markers.map(m=>({markerId:m.id,resultPage:page}))}));},200);
});\n`);fs.chmodSync(cli,0o755);
 const config=createCallbackConfig({codexBin:cli,reviewDir:root,workspaceDir:root,projectDir:root});fs.writeFileSync(path.join(root,'codex_callback_config.json'),JSON.stringify(config));fs.writeFileSync(path.join(root,'preview_review_config.json'),JSON.stringify({previewVideo:video}));
 fs.writeFileSync(path.join(root,'preview_comments.json'),JSON.stringify({markers:orphan?makeMarkers(4):[]}));
 let prior;
 if(orphan){prior=spawn('/bin/sleep',['0.7']);fs.writeFileSync(path.join(root,'codex_callback_status.json'),JSON.stringify({state:'running',pid:prior.pid,batchId:'prior'}));fs.writeFileSync(path.join(root,'incremental_review_state.json'),JSON.stringify({activeBatchId:'prior',batches:[{batchId:'prior',state:'running',markers:makeMarkers(2).map(m=>({...m,contentHash:markerFingerprint(m)}))}]}));}
 const code=`const s=require(${JSON.stringify(path.join(__dirname,'preview_review_server.js'))}).createServer();s.listen(0,'127.0.0.1',()=>console.log('PORT='+s.address().port));`;
 const child=spawn(process.execPath,['-e',code,'test-server','0',video],{cwd:root,stdio:['ignore','pipe','pipe']});let log='';child.stderr.on('data',b=>log+=b);
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('listen timeout '+log)),5000);child.stdout.on('data',b=>{const m=String(b).match(/PORT=(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]));}});child.on('error',reject);});
 t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}if(prior&&prior.exitCode===null){prior.kill();await once(prior,'exit');}fs.rmSync(root,{recursive:true,force:true});});
 const read=name=>{try{return JSON.parse(fs.readFileSync(path.join(root,name)));}catch{return null;}};
 const dispatches=()=>{try{return fs.readFileSync(path.join(root,'dispatch.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}};
 const post=async(route,body)=>{const response=await fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{'Content-Type':'application/json','X-Codex-Callback-Token':config.token},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
 return{root,port,post,read,dispatches};
}

test('real HTTP saves trigger 2 immediately; end flushes 1, without manual submit or status polling',async t=>{
 const f=await serverFixture(t);
 let out=await f.post('/api/comments',{markers:makeMarkers(1)});assert.equal(out.incremental.batches.length,0);assert.deepEqual(f.dispatches(),[]);
 out=await f.post('/api/comments',{markers:makeMarkers(2)});assert.equal(out.incremental.batches[0].state,'running');
 await until(()=>f.dispatches().length===1);
 await f.post('/api/comments',{markers:makeMarkers(3)});
 await f.post('/api/review-finished',{previewTime:10});
 await until(()=>f.dispatches().length===2&&f.read('incremental_review_state.json').batches.every(b=>b.state==='completed'));
 assert.deepEqual(f.dispatches(),[['m1','m2'],['m3']]);
 const status=await(await fetch(`http://127.0.0.1:${f.port}/api/codex-status`)).json();assert.equal(status.incremental.batches.length,2);
 assert.ok(status.incremental.batches.every(b=>b.outputUrls.length),JSON.stringify({root:f.root,status:status.incremental}));
 const result=await fetch(`http://127.0.0.1:${f.port}${status.incremental.batches[0].outputUrls[0]}`);assert.equal(result.status,200);assert.match(await result.text(),/dispatch fixture result/);
 assert.equal(fs.readFileSync(path.join(f.root,'preview.mp4'),'utf8'),'unchanged video fixture');
 assert.deepEqual(f.read('preview_comments.json').markers.map(m=>m.id),['m1','m2','m3']);
});

test('server watchdog recovers inherited live worker after its exit with no browser request',async t=>{
 const f=await serverFixture(t,true);
 await until(()=>f.dispatches().length===1&&f.read('incremental_review_state.json').batches.some(b=>b.state==='completed'));
 const state=f.read('incremental_review_state.json');assert.deepEqual(f.dispatches(),[['m3','m4']]);assert.equal(state.batches[0].state,'failed');assert.equal(state.activeBatchId,null);
});
