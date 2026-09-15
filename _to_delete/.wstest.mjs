import { WebSocket } from 'ws';
const U='ws://127.0.0.1:18931/ws';
const tryc=(o)=>new Promise(r=>{const w=new WebSocket(U,{headers:o?{Origin:o}:{}});w.on('open',()=>r(['open',w]));w.on('unexpected-response',(q,res)=>r(['rej '+res.statusCode]));w.on('error',e=>r(['err '+e.message]));});
console.log('no origin', (await tryc())[0]);
console.log('evil origin', (await tryc('https://evil.com'))[0]);
const socks=[];for(let i=0;i<5;i++){const [s,w]=await tryc('http://127.0.0.1:18931');console.log('same origin',i,s);if(w)socks.push(w);}
const w=socks[0]; let got=0; socks[1].on('message',()=>got++);
w.send(JSON.stringify({type:'hello',name:'Bob‮<img>'})); socks[1].send(JSON.stringify({type:'hello',name:'x'}));
await new Promise(r=>setTimeout(r,300)); got=0;
for(let i=0;i<2000;i++) w.send(JSON.stringify({type:'chat',text:'x'}));
for(let i=0;i<2000;i++) w.send(JSON.stringify({type:'shot',x:1,y:1,z:1}));
await new Promise(r=>setTimeout(r,800));
console.log('relayed to peer during flood:',got,'flooder state',w.readyState);
process.exit(0);
