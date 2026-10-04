'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('HTTP explicit acceptance renders full video, serves Range, persists and never alters baseline/comments',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'preview-apply-http-'));
 const put=(name,value)=>{const f=path.join(root,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,typeof value==='string'?value:JSON.stringify(value));return f;};
 const base=path.join(root,'base.mp4');
 const fixture=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=180x320:r=30:d=2','-f','lavfi','-i','sine=frequency=800:sample_rate=48000:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-y',base]);assert.equal(fixture.status,0,fixture.stderr.toString());
 const original=fs.readFileSync(base),marker={id:'m1',previewTime:1,comment:'show box',resolved:false};
 put('preview_comments.json',{markers:[marker]});put('preview_timeline.json',{sourceDuration:2,clips:[]});
 put('preview_review_config.json',{title:'test',previewVideo:base});put('codex_callback_config.json',{enabled:true,token:'test-only',reviewDir:root,codexBin:'/usr/bin/false'});put('incremental_review_state.json',{paused:true,batches:[]});
 const ass=put('overlay.ass','[Script Info]\nPlayResX:180\nPlayResY:320\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,{\\an7\\pos(10,20)\\p1\\c&H0000FF&}m 0 0 l 80 0 80 50 0 50\n');
 put('codex_runs/run-1/status.json',{state:'completed'});put('codex_runs/run-1/comments.json',{markers:[marker]});put('codex_runs/run-1/timeline.json',{sourceDuration:2,clips:[]});
 put('codex_runs/run-1/result.json',{inputPreview:base,basePreviewSha256:require('node:crypto').createHash('sha256').update(original).digest('hex'),items:[{markerId:'m1',status:'implemented',action:'box',outputFile:base,apply:{mode:'ass_overlay',audio:'unchanged',assFile:ass,fontsDir:root}}]});
 let child;
 async function start(){
  child=spawn(process.execPath,['-e',`const s=require(${JSON.stringify(path.join(__dirname,'preview_review_server.js'))}).createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`,'test','0',base],{cwd:root,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(stderr||'server timeout')),5000);child.stdout.once('data',b=>{clearTimeout(timer);resolve('http://127.0.0.1:'+String(b).trim());});});
 }
 t.after(async()=>{if(child?.exitCode===null){child.kill();await once(child,'exit');}fs.rmSync(root,{recursive:true,force:true});});
 let url=await start();
 const get=route=>fetch(url+route);
 const post=(route,body,token='test-only')=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json','X-Codex-Callback-Token':token},body:JSON.stringify(body)});
 let state=await(await get('/api/edit-application')).json();assert.equal(state.acceptedMarkerIds.length,0);
 const candidate=state.candidates[0];assert.ok(candidate.canAccept);
 assert.equal((await post('/api/edit-accept',candidate,'wrong')).status,403);
 assert.equal((await post('/api/edit-accept',{...candidate,revisionId:'stale'})).status,409);
 assert.equal((await post('/api/edit-accept',candidate)).status,202);
 for(let i=0;i<200;i++){state=await(await get('/api/edit-application')).json();if(state.state==='ready'||state.state==='failed')break;await delay(50);}
 assert.equal(state.state,'ready',JSON.stringify(state));assert.ok(state.activeVersion.identityTimeline);
 assert.deepEqual(Buffer.from(await(await get('/video')).arrayBuffer()),original);
 const media=await fetch(url+state.activeVersion.videoUrl,{headers:{Range:'bytes=0-99'}});assert.equal(media.status,206);assert.equal((await media.arrayBuffer()).byteLength,100);
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'preview_comments.json'))).markers[0].resolved,false);
 const id=state.activeVersion.id;child.kill();await once(child,'exit');url=await start();
 state=await(await get('/api/edit-application')).json();assert.equal(state.activeVersion.id,id);
 assert.equal((await post('/api/edit-accept',candidate)).status,202);await delay(80);
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'preview_apply_state.json'))).versions.length,1);
});
