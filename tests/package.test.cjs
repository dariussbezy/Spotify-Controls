const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),{unzipSync}=require('fflate');
test('beta catalog and ZIP match the current manifest and compiled JavaScript',()=>{
 const manifest=JSON.parse(fs.readFileSync('plugins/SPC/manifest.json'));
 const p=JSON.parse(fs.readFileSync('index.json')).plugins[manifest.id];
 assert.equal(p.channels.beta,'1.0.0-beta');
 const archive=fs.readFileSync('pool/'+manifest.id+'@'+manifest.version+'.zip');
 const entry=p.versions[manifest.version];assert.equal(entry.size,archive.length);assert.equal(entry.sha256,crypto.createHash('sha256').update(archive).digest('hex'));
 const files=unzipSync(archive);assert.deepEqual(Object.keys(files).sort(),['index.js','manifest.json']);
 assert.deepEqual(JSON.parse(Buffer.from(files['manifest.json'])),manifest);
 assert.deepEqual(Buffer.from(files['index.js']),fs.readFileSync('plugins/SPC/build/js/index.js'));
});
