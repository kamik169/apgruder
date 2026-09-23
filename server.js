// Apgruder server: без зависимостей, нужен Node 16+. Запуск: node server.js
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=process.env.PORT||3000,FILE=process.env.DATA_FILE||path.join(__dirname,'data.json');
const ADMIN=(process.env.ADMIN_NICK||'litrerelly').toLowerCase();
let db={users:{},tokens:{},feed:[],rtp:95},dirty=false;
try{db=Object.assign(db,JSON.parse(fs.readFileSync(FILE,'utf8')))}catch(e){}
const save=()=>{dirty=true};
const flush=()=>{if(!dirty)return;dirty=false;fs.writeFileSync(FILE+'.tmp',JSON.stringify(db));fs.renameSync(FILE+'.tmp',FILE)};
setInterval(flush,1000);['SIGTERM','SIGINT'].forEach(s=>process.on(s,()=>{flush();process.exit()}));
const hash=(p,s)=>crypto.scryptSync(p,s,32).toString('hex');
const mk=pw=>{const s=crypto.randomBytes(8).toString('hex');return{salt:s,hash:hash(pw,s)}};
let ap=process.env.ADMIN_PASS;
if(!db.users[ADMIN]){if(!ap){ap=crypto.randomBytes(8).toString('base64url');console.log('ПАРОЛЬ АДМИНА ('+ADMIN+'):',ap)}db.users[ADMIN]={...mk(ap),bal:1000000,admin:true}}
else if(ap)Object.assign(db.users[ADMIN],mk(ap));
Object.keys(db.users).forEach(k=>db.users[k].admin=(k===ADMIN));save();

const err=(m,s=400)=>{throw{m,s}};
const pub=e=>({name:e,bal:db.users[e].bal,admin:!!db.users[e].admin});
const need=u=>u||err('Нужно войти',401);
const adm=u=>{const n=need(u);if(!db.users[n].admin)err('Нет доступа',403);return n};
const att={};
const limit=ip=>{const n=Date.now();att[ip]=(att[ip]||[]).filter(t=>n-t<60000);if(att[ip].length>=10)err('Слишком много попыток, подождите минуту',429);att[ip].push(n)};
const session=e=>{const t=crypto.randomBytes(24).toString('hex');db.tokens[t]=e;save();return{token:t,user:pub(e)}};

const R={};
R['GET /api/config']=()=>({rtp:db.rtp});
R['GET /api/feed']=()=>({feed:db.feed});
R['GET /api/me']=(b,u)=>({user:pub(need(u)),rtp:db.rtp});
R['POST /api/register']=(b,u,ip)=>{limit(ip);const e=String(b.email||'').trim().toLowerCase();
  if(!/^\S+@\S+\.\S+$/.test(e)||e.length>80)err('Введите корректную почту');
  if(String(b.password||'').length<6)err('Пароль — минимум 6 символов');
  if(db.users[e])err('Эта почта уже зарегистрирована');
  db.users[e]={...mk(String(b.password)),bal:10000,admin:false};return session(e)};
R['POST /api/login']=(b,u,ip)=>{limit(ip);const e=String(b.id||'').trim().toLowerCase(),x=db.users[e];
  if(!x||!crypto.timingSafeEqual(Buffer.from(hash(String(b.password||''),x.salt),'hex'),Buffer.from(x.hash,'hex')))err('Неверная почта/ник или пароль');
  return session(e)};
R['POST /api/spin']=(b,u)=>{const n=need(u),x=db.users[n],bet=Math.floor(+b.bet),ch=+b.chance;
  if(!(bet>=10)||bet>x.bal)err('Недостаточно средств (минимум ставки 10)');
  if(!(ch>=1&&ch<=90))err('Шанс должен быть от 1 до 90%');
  const m=db.rtp/ch,win=crypto.randomInt(0,1e6)/1e4<ch,z=ch*3.6,r=()=>.05+.9*crypto.randomInt(0,1000)/1000;
  const angle=win?z*r():z+(360-z)*r(),pay=win?Math.round(bet*m):0;x.bal+=pay-bet;
  db.feed.unshift({e:n.slice(0,2)+'***',w:win,a:win?pay-bet:bet,m,c:ch});db.feed.length=Math.min(db.feed.length,20);save();
  return{win,angle,pay,m,bal:x.bal}};
R['GET /api/admin/users']=(b,u,ip,q)=>{adm(u);const s=(q.get('q')||'').toLowerCase();return{users:Object.keys(db.users).filter(k=>k.includes(s)).map(pub)}};
R['POST /api/admin/balance']=(b,u)=>{adm(u);const x=db.users[String(b.id)];if(!x)err('Игрок не найден');
  const a=Math.max(0,Math.floor(+b.amount)||0);x.bal=b.mode=='add'?x.bal+a:b.mode=='sub'?Math.max(0,x.bal-a):a;save();return{ok:1}};
R['POST /api/admin/password']=(b,u)=>{adm(u);const id=String(b.id),x=db.users[id];
  if(!x||String(b.password||'').length<6)err('Пароль — минимум 6 символов');
  Object.assign(x,mk(String(b.password)));Object.keys(db.tokens).forEach(t=>{if(db.tokens[t]===id)delete db.tokens[t]});save();return{ok:1}};
R['POST /api/admin/rtp']=(b,u)=>{adm(u);db.rtp=Math.min(100,Math.max(50,+b.rtp||95));save();return{rtp:db.rtp}};

const send=(res,c,o)=>{res.writeHead(c,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(o))};
http.createServer((req,res)=>{const url=new URL(req.url,'http://x');
  if(url.pathname.startsWith('/api/')){let d='';req.on('data',c=>{d+=c;if(d.length>1e5)req.destroy()});
    req.on('end',()=>{try{const h=R[req.method+' '+url.pathname];if(!h)err('Не найдено',404);
      const t=(req.headers.authorization||'').slice(7),u=db.tokens[t]&&db.users[db.tokens[t]]?db.tokens[t]:null;
      const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
      send(res,200,h(d?JSON.parse(d):{},u,ip,url.searchParams))}catch(e){send(res,e.s||400,{error:e.m||'Ошибка запроса'})}});return}
  fs.readFile(path.join(__dirname,'index.html'),(e,f)=>{res.writeHead(e?404:200,{'Content-Type':'text/html; charset=utf-8'});res.end(f||'index.html не найден')});
}).listen(PORT,()=>console.log('Apgruder запущен на порту',PORT));
