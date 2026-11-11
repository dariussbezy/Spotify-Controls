const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const compile=p=>ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
function fixture(){
 const hooks=new Map(),calls=[];let renewals=0,fetchOverride=null;let reply={item:{id:'t',name:'Track',duration_ms:100000,artists:[]},progress_ms:1000,is_playing:true,device:{id:'device'}};
 const playback={};vm.runInNewContext(compile('plugins/SPC/js/playback.ts'),{exports:playback,Date,Math,Number,Error});
 const store={getActiveSocketAndDevice:()=>({socket:{accountId:'a',accessToken:'private-test-token'},device:{id:'device'}})};
 const modules={
  '@valenced/modules/finders':{getModules:(_filter,callback)=>{callback({getAccessToken:async()=>{renewals++;},SpotifyAPI:{},getDevices(){}});return()=>{};}},
  '@valenced/modules/finders/filters':{withProps:()=>null},
  '@valenced/discord/flux':{getStore:(name,fn)=>{if(name==='SpotifyStore')fn(store);if(name==='ConnectedAccountsStore')fn({getAccounts:()=>[{id:'a',type:'spotify'}]});return()=>{};},onFluxEventDispatched:(name,fn)=>{hooks.set(name,fn);return()=>hooks.delete(name);}},
  'react-native':{AppState:{currentState:'active',addEventListener:()=>({remove(){}})}},'./playback':playback,
 };
 const exports={};
 vm.runInNewContext(compile('plugins/SPC/js/spotify.ts'),{exports,require:name=>modules[name],Date,Promise,Error,Set,Object,Array,AbortController,setTimeout,clearTimeout,fetch:async(url,options)=>{
  calls.push({url,...options});if(fetchOverride)return fetchOverride(url,options);return options.method==='GET'?{ok:true,status:200,json:async()=>reply}:{ok:true,status:202};
 }});
 const stop=exports.startSpotify();return {api:exports,stop,calls,hooks,getRenewals:()=>renewals,setFetch:fn=>fetchOverride=fn,setReply:value=>reply=value};
}
test('202 skip is sent once and credentials never enter the public state',async()=>{
 const f=fixture();await f.api.refresh();await f.api.command('next');
 assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 assert.ok(f.calls.every(c=>c.url.startsWith('https://api.spotify.com/v1/me/player')));
 assert.equal(JSON.stringify(f.api.getState()).includes('private-test-token'),false);
 f.stop();assert.equal(f.hooks.size,0);assert.equal(f.api.getState().playback,null);
});
test('explicit reconnect renews the Spotify session even when an old token exists',async()=>{
 const f=fixture();await f.api.refresh();await new Promise(setImmediate);const before=f.getRenewals();await f.api.reconnect();assert.equal(f.getRenewals(),before+1);f.stop();
});
test('a response already in flight cannot restore playback after logout',async()=>{
 const f=fixture();await f.api.refresh();await new Promise(setImmediate);let release;
 f.setFetch(()=>new Promise(resolve=>{release=resolve;}));const refresh=f.api.refresh();
 f.hooks.get('LOGOUT')({type:'LOGOUT'});
 release({ok:true,status:200,json:async()=>({item:{id:'old'},device:{id:'d'}})});await refresh;
 assert.equal(f.api.getState().playback,null);assert.equal(f.api.getState().connected,false);f.stop();
});
test('pause ignores a pre-command playback response and fetches fresh state',async()=>{
 const f=fixture();await f.api.refresh();await new Promise(setImmediate);let release,reads=0;
 f.setFetch((_url,options)=>{
  if(options.method==='GET'&&++reads===1)return new Promise(resolve=>{release=resolve;});
  return Promise.resolve(options.method==='GET'?{ok:true,status:200,json:async()=>({item:{id:'t',duration_ms:100000},is_playing:false,progress_ms:2000,device:{id:'device'}})}:{ok:true,status:204});
 });
 const old=f.api.refresh();const command=f.api.command('pause');
 release({ok:true,status:200,json:async()=>({item:{id:'t',duration_ms:100000},is_playing:true,device:{id:'device'}})});
 await old;await command;assert.equal(f.api.getState().playback.playing,false);assert.ok(reads>=2);f.stop();
});
test('stopping prevents future requests and removes all playback callbacks',async()=>{
 const f=fixture();await f.api.refresh();f.stop();const count=f.calls.length;
 await f.api.refresh();await f.api.command('play');
 assert.equal(f.calls.length,count);assert.equal(f.hooks.size,0);
});
test('an idle Spotify response keeps the last paused track available to resume',async()=>{
 const f=fixture();await f.api.refresh();await new Promise(setImmediate);f.setReply(null);await f.api.refresh();
 assert.equal(f.api.getState().playback.id,'t');assert.equal(f.api.getState().playback.playing,false);f.stop();
});
test('a poll started during a command cannot overwrite its completed result',async()=>{
 const f=fixture();await f.api.refresh();await new Promise(setImmediate);let finishPut,finishGet,reads=0;
 f.setFetch((_url,options)=>{
  if(options.method==='PUT')return new Promise(resolve=>{finishPut=resolve;});
  if(++reads===1)return new Promise(resolve=>{finishGet=resolve;});
  return Promise.resolve({ok:true,status:200,json:async()=>({item:{id:'t',duration_ms:100000},is_playing:false,device:{id:'device'}})});
 });
 const command=f.api.command('pause');const old=f.api.refresh();
 finishPut({ok:true,status:204});await new Promise(setImmediate);
 finishGet({ok:true,status:200,json:async()=>({item:{id:'t',duration_ms:100000},is_playing:true,device:{id:'device'}})});
 await command;await old;assert.equal(f.api.getState().playback.playing,false);f.stop();
});
test('successful playback commands do not try to parse a non-JSON response body',async()=>{
 const f=fixture();await f.api.refresh();await new Promise(setImmediate);
 f.setFetch((_url,options)=>Promise.resolve(options.method==='GET'?{ok:true,status:204}:{ok:true,status:200,json:async()=>{throw new Error('JSON Parse error');}}));
 await f.api.command('next');assert.equal(f.api.getState().status.includes('JSON Parse error'),false);f.stop();
});
