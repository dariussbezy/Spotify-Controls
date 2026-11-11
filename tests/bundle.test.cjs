const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('the compiled wave component does not contain a corrupted Animated.View reference',()=>{
 const code=fs.readFileSync('plugins/SPC/build/js/index.js','utf8');
 assert.equal(code.includes('.Animated.valenced'),false);
});
