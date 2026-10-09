import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { FrameProtocolOwner, resolveFormSource, resolveLocalAsset, startPreviewCore } from '../src/form/preview-core.js';
function dir(){const d=mkdtempSync(join(tmpdir(),'preview-'));writeFileSync(join(d,`${d.split('/').pop()}.html`),'<html><head></head><body><script>window.harmlessExecuted=true</script><img onerror="window.bad=1">ok</body></html>');writeFileSync(join(d,'a.css'),'x{}');return d;}
test('canonical folder selection rejects preferred and sole escaping HTML symlinks',()=>{const d=dir(),s=resolveFormSource(d);assert.match(resolveLocalAsset(s,'a.css'),/a.css$/);for(const p of ['../x','%2e%2e/x','/etc/passwd','x\0y'])assert.throws(()=>resolveLocalAsset(s,p));symlinkSync('/etc/passwd',join(d,'escape'));assert.throws(()=>resolveLocalAsset(s,'escape'));const a=mkdtempSync(join(tmpdir(),'p-'));symlinkSync('/etc/passwd',join(a,`${a.split('/').pop()}.html`));assert.throws(()=>resolveFormSource(a));const b=mkdtempSync(join(tmpdir(),'p-'));symlinkSync('/etc/passwd',join(b,'only.html'));assert.throws(()=>resolveFormSource(b));const external=join(mkdtempSync(join(tmpdir(),'external-')),'outside.html');writeFileSync(external,'<html>externo</html>');const c=mkdtempSync(join(tmpdir(),'p-'));symlinkSync(external,join(c,'outside.html'));assert.throws(()=>resolveFormSource(join(c,'outside.html')));});
test('control and frame isolate token and expose executable authored script policy',async()=>{const c=await startPreviewCore(dir());try{const control=await(await fetch(c.url)).text();assert.match(control,/sandbox="allow-scripts allow-forms allow-modals"/);assert.match(control,/MessageChannel/);const frame=await(await fetch(`http://127.0.0.1:${c.port}/frame?n=${control.match(/n=([a-f0-9]+)/)![1]}`)).text();assert.doesNotMatch(frame,new RegExp(c.token));assert.match(frame,/window.harmlessExecuted=true/);assert.match(frame,/connect-src 'none'/);assert.match(frame,/form-action 'none'/);assert.match(frame,/script-src 'self' 'unsafe-inline'/);assert.equal((await fetch(`http://127.0.0.1:${c.port}/control/no`)).status,404);}finally{await c.close()}});
test('generated control runtime has one port and rejects repeated hello',async()=>{const c=await startPreviewCore(dir());try{const html=await(await fetch(c.url)).text(),script=html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '',listeners=new Map<string,Function>(),received:any[]=[];const frame:any={contentWindow:{postMessage:(m:any,_:string,ports:any[])=>received.push({m,ports})},addEventListener:(n:string,f:Function)=>listeners.set(n,f)};const context:any={document:{querySelector:()=>frame},addEventListener:(n:string,f:Function)=>listeners.set(n,f),console,MessageChannel};vm.runInNewContext(script,context);const hello={v:1,type:'hello',nonce:html.match(/n=([a-f0-9]+)/)![1]};listeners.get('message')!({source:{},data:hello});assert.equal(received.length,0);listeners.get('message')!({source:frame.contentWindow,data:hello});listeners.get('message')!({source:frame.contentWindow,data:hello});assert.equal(received.length,1);listeners.get('load')!();}finally{await c.close()}});
test('protocol owner requires expected source, nonce, exact messages and no replay',()=>{const source={},o=new FrameProtocolOwner(source,'n');assert.equal(o.acceptHello({}, {v:1,type:'hello',nonce:'n'}).ok,false);assert.equal(o.acceptHello(source,{v:1,type:'hello',nonce:'n'}).ok,true);assert.equal((o.acceptPort({v:1,type:'ready',id:'x'}) as {type:string}).type,'ready');assert.match((o.acceptPort({v:1,type:'ready',id:'x'}) as {diagnostic:string}).diagnostic,/inválida/);assert.match((o.acceptPort({v:1,type:'ready',id:'y',extra:1}) as {diagnostic:string}).diagnostic,/inválida/);o.reset();assert.match((o.acceptPort({v:1,type:'ready',id:'x'}) as {diagnostic:string}).diagnostic,/inválida/);});
test('frame traz o shim com o contexto configurado, sem o token e com connect-src none',async()=>{const c=await startPreviewCore(dir(),{contexto:{modo:'MOD',atividade:7,usuario:'ana',processo:42,empresa:1}});try{const control=await(await fetch(c.url)).text();const nonce=control.match(/n=([a-f0-9]+)/)![1];const resp=await fetch(`http://127.0.0.1:${c.port}/frame?n=${nonce}`);const frame=await resp.text();assert.match(resp.headers.get('content-security-policy')??'',/connect-src 'none'/);assert.doesNotMatch(frame,new RegExp(c.token));assert.ok(frame.includes('window.__fluigPreviewContexto'));assert.ok(frame.includes('"modo":"MOD"'));assert.ok(frame.includes('"atividade":7'));assert.ok(frame.includes('"usuario":"ana"'));assert.ok(frame.includes('"processo":42'));assert.ok(frame.includes('"empresa":1'));assert.ok(frame.includes('contexto do preview é SIMULADO'));assert.ok(frame.includes('window.form'));}finally{await c.close()}});

// --- Harness: drive the ACTUAL emitted control script and frame bootstrap ---

type Listener = (e:any)=>void;
class Bus {
  #map = new Map<string,Set<Listener>>();
  addEventListener(n:string,f:Listener){let s=this.#map.get(n);if(!s){s=new Set;this.#map.set(n,s)}s.add(f)}
  removeEventListener(n:string,f:Listener){this.#map.get(n)?.delete(f)}
  dispatch(n:string,e:any){for(const f of [...(this.#map.get(n)??[])])f(e)}
  count(n:string){return this.#map.get(n)?.size ?? 0}
}
const tick = () => new Promise<void>((r)=>setTimeout(r,0));
const extract = (html:string, marker:string) => { for (const parte of html.split('<script>').slice(1)) { const corpo = parte.split('</script>')[0]!; if (corpo.includes(marker)) return corpo; } throw new Error(`script não encontrado: ${marker}`); };

async function harness() {
  const c = await startPreviewCore(dir());
  const controlHtml = await (await fetch(c.url)).text();
  const nonce = controlHtml.match(/n=([a-f0-9]+)/)![1]!;
  const frameHtml = await (await fetch(`http://127.0.0.1:${c.port}/frame?n=${nonce}`)).text();
  const controlScript = controlHtml.match(/<script>([\s\S]*)<\/script>/)![1]!;
  const frameScript = extract(frameHtml, "type:'hello'");

  const controlBus = new Bus(), frameBus = new Bus();
  const warnings:any[] = [];
  const transferred:{data:any,ports:any[]}[] = [];

  const frameWindow:any = {
    postMessage:(data:any,_origin:string,ports:any[]=[])=>{ transferred.push({data,ports}); frameBus.dispatch('message',{source:parentObj,data,ports}); }
  };
  const parentObj:any = { postMessage:(data:any)=>{ setTimeout(()=>controlBus.dispatch('message',{source:frameWindow,data}),0); } };
  const iframe:any = {
    contentWindow: frameWindow,
    addEventListener: (n:string,f:Listener)=>controlBus.addEventListener(n,f)
  };

  const consoleMock = { warn: (...a:any[])=>warnings.push(a), log:()=>{}, error:()=>{} };
  const controlContext:any = { document:{querySelector:()=>iframe}, addEventListener:(n:string,f:Listener)=>controlBus.addEventListener(n,f), console:consoleMock, MessageChannel:globalThis.MessageChannel };
  const frameContext:any = { parent:parentObj, addEventListener:(n:string,f:Listener)=>frameBus.addEventListener(n,f), removeEventListener:(n:string,f:Listener)=>frameBus.removeEventListener(n,f) };

  vm.runInNewContext(controlScript, controlContext);
  const load = () => controlBus.dispatch('load', {});
  const cleanup = async () => { load(); for(const t of transferred) for(const p of t.ports) try{ p.close(); }catch{} await c.close(); };
  return {
    c, nonce, controlBus, frameBus, warnings, transferred, frameWindow, iframe, cleanup,
    runFrame(){ vm.runInNewContext(frameScript, frameContext); },
    hello(){ controlBus.dispatch('message', { source:frameWindow, data:{v:1,type:'hello',nonce} }); },
    load,
    port(){ return transferred.at(-1)?.ports[0]; }
  };
}

test('emitted control accepts hello only from iframe.contentWindow and transfers exactly one port',async()=>{const h=await harness();try{h.controlBus.dispatch('message',{source:{},data:{v:1,type:'hello',nonce:h.nonce}});assert.equal(h.transferred.length,0,'wrong source must transfer no port');h.hello();assert.equal(h.transferred.length,1,'valid hello must create one channel');assert.equal(h.transferred[0]!.ports.length,1,'exactly one port transferred');const d0=h.transferred[0]!.data;assert.equal(d0.v,1);assert.equal(d0.type,'port');}finally{await h.cleanup()}});
test('emitted control accepts a valid port message and rejects unknown fields, non-exact schema and unsupported type',async()=>{const h=await harness();try{h.hello();const p=h.port();p.postMessage({v:1,type:'ready',id:'ok'});await tick();assert.equal(h.warnings.length,0,'valid ready must not warn');p.postMessage({v:1,type:'ready',id:'b',extra:1});await tick();assert.equal(h.warnings.length,1,'unknown field must warn');p.postMessage({v:1,type:'ready'});await tick();assert.equal(h.warnings.length,2,'missing id must warn');p.postMessage({v:1,type:'ready',id:1});await tick();assert.equal(h.warnings.length,3,'non-string id must warn');p.postMessage({v:1,type:'ready',id:'c',detail:1});await tick();assert.equal(h.warnings.length,4,'non-string detail must warn');p.postMessage({v:1,type:'unsupported',id:'d',extra:2});await tick();assert.equal(h.warnings.length,5,'unsupported type with unknown field must warn');p.postMessage({v:1,type:'ready',id:'e',detail:'x'.repeat(513)});await tick();assert.equal(h.warnings.length,6,'oversized detail must warn');}finally{await h.cleanup()}});
test('emitted control rejects duplicate IDs within a session',async()=>{const h=await harness();try{h.hello();const p=h.port();p.postMessage({v:1,type:'ready',id:'a'});await tick();assert.equal(h.warnings.length,0);p.postMessage({v:1,type:'ready',id:'a'});await tick();assert.equal(h.warnings.length,1,'replay of a seen id must warn');}finally{await h.cleanup()}});
test('emitted control reload closes the old port and resets replay on a fresh handshake',async()=>{const h=await harness();try{h.hello();const old=h.port();old.postMessage({v:1,type:'ready',id:'a'});await tick();assert.equal(h.warnings.length,0);h.load();old.postMessage({v:1,type:'ready',id:'a'});await tick();assert.equal(h.warnings.length,0,'old port after reload must be detached silently');h.hello();assert.equal(h.transferred.length,2,'fresh handshake opens a new channel');const fresh=h.port();assert.notEqual(fresh,old);fresh.postMessage({v:1,type:'ready',id:'a'});await tick();assert.equal(h.warnings.length,0,'replay set must reset after reload');fresh.postMessage({v:1,type:'ready',id:'a'});await tick();assert.equal(h.warnings.length,1,'duplicate after reset must warn');}finally{await h.cleanup()}});
test('emitted frame bootstrap handshakes, receives the port and posts ready-<nonce> that control accepts once',async()=>{const h=await harness();try{h.runFrame();assert.equal(h.frameBus.count('message'),1,'bootstrap listener registered');await tick();await tick();assert.equal(h.transferred.length,1,'control answered the bootstrap hello with a port');const d1=h.transferred[0]!.data;assert.equal(d1.v,1);assert.equal(d1.type,'port');assert.equal(h.frameBus.count('message'),0,'bootstrap one-shot listener removed after receiving the port');await tick();assert.equal(h.warnings.length,0,'ready-<nonce> accepted');const p=h.port();p.postMessage({v:1,type:'ready',id:`ready-${h.nonce}`});await tick();assert.equal(h.warnings.length,1,'replaying ready-<nonce> proves control had accepted it');}finally{await h.cleanup()}});
test('emitted frame bootstrap ignores a non-exact port event and keeps its listener',async()=>{const h=await harness();try{h.runFrame();assert.equal(h.frameBus.count('message'),1,'bootstrap listener registered');assert.equal(h.transferred.length,0,'control reply is async like the browser');h.frameBus.dispatch('message',{source:{},data:{v:1,type:'port'},ports:[]});h.frameBus.dispatch('message',{source:h.frameWindow,data:{v:1,type:'port'},ports:[]});assert.equal(h.frameBus.count('message'),1,'listener kept when event is not exact');await tick();await tick();}finally{await h.cleanup()}});
