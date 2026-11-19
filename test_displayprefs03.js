const assert=require('assert');
const fs=require('fs');
const script=fs.readFileSync(__dirname+'/app/public/app.js','utf8');
const sourceLabels=[
 'ここでの指定はE2記事一覧の表示だけに適用します。',
 '次回のE2探索時にのみ参考にします。',
 'AIセレクトのローカルAI（E2）'
];
const destLabels=[
 'ここでの指定はAIセレクトの記事一覧の表示だけに適用します。',
 '次回のAIセレクトの探索時にのみ参考にします。',
 'AIセレクトのローカルAI'
];
for(const s of sourceLabels)assert(!script.includes(s),'old UI label still present: '+s);
for(const s of destLabels)assert(script.includes(s),'new UI label missing: '+s);
const displayedE2=script.split('\n').filter(s=>/E2/.test(s)&&/['"`]/.test(s)&&/elt\(|append\(/.test(s)&&!s.trim().startsWith('//'));
assert(!displayedE2.some(s=>/記事一覧の表示だけ|探索時にのみ|ローカルAI（E2）/.test(s)));
console.log('PASS: three settings UI labels no longer expose E2');
