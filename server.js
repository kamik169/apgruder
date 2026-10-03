// Apgruder server: без npm-зависимостей, нужен Node 16+. Запуск: node server.js
const http=require('http'),https=require('https'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=process.env.PORT||3000,FILE=process.env.DATA_FILE||path.join(__dirname,'data.json');
const ADMIN=(process.env.ADMIN_NICK||'litrerelly').toLowerCase();
const GOOGLE_CLIENT_ID=process.env.GOOGLE_CLIENT_ID||'',STEAM_API_KEY=process.env.STEAM_API_KEY||'';
const AD_SECONDS=+process.env.AD_SECONDS||15,AD_COOLDOWN=(+process.env.AD_COOLDOWN||60)*1000,AD_REWARD=+process.env.AD_REWARD||5000;
const MAXITEM=500000,HELPER_CAP=+process.env.HELPER_CAP||5000;
const ROLES=['user','creator','helper','admin','senior'];
const rank=r=>Math.max(0,ROLES.indexOf(r));

let db={users:{},tokens:{},feed:[],rtp:95,catalog:[],promos:{},tickets:{},steamCodes:{}},dirty=false;
try{db=Object.assign(db,JSON.parse(fs.readFileSync(FILE,'utf8')))}catch(e){}
const save=()=>{dirty=true};
const flush=()=>{if(!dirty)return;dirty=false;fs.writeFileSync(FILE+'.tmp',JSON.stringify(db));fs.renameSync(FILE+'.tmp',FILE)};
setInterval(flush,1000);['SIGTERM','SIGINT'].forEach(s=>process.on(s,()=>{flush();process.exit()}));

const hash=(p,s)=>crypto.scryptSync(p,s,32).toString('hex');
const mk=pw=>{const s=crypto.randomBytes(8).toString('hex');return{salt:s,hash:hash(pw,s)}};
let ap=process.env.ADMIN_PASS;
if(!db.users[ADMIN]){if(!ap){ap=crypto.randomBytes(8).toString('base64url');console.log('ПАРОЛЬ АДМИНА ('+ADMIN+'):',ap)}db.users[ADMIN]={...mk(ap),bal:1000000,role:'senior',inv:[]}}
else if(ap)Object.assign(db.users[ADMIN],mk(ap));
db.users[ADMIN].role='senior';save();

// ---- каталог: сиды по ценовым диапазонам, если пуст ----
function seedCatalog(){
  const ADJ=['Огненный','Ледяной','Неоновый','Тёмный','Королевский','Туманный','Электро','Кровавый','Звёздный','Древний','Ядовитый','Штормовой','Призрачный','Алый','Изумрудный'];
  const NOUNS=[['Брелок','charm'],['Наклейка','sticker'],['Ящик','case'],['Пистолет','gun'],['Автомат','rifle'],['Перчатки','glove'],['Клинок','knife'],['Нож','knife']];
  const tiers=[[1,50],[50,300],[300,1500],[1500,6000],[6000,20000],[20000,60000],[60000,150000],[150000,300000],[300000,500000]];
  const out=[],used=new Set();
  tiers.forEach(([lo,hi])=>{let n=0;while(n<10){const a=ADJ[crypto.randomInt(0,ADJ.length)],no=NOUNS[crypto.randomInt(0,NOUNS.length)];
    const name=no[0]+' «'+a+'»';const key=name+lo;if(used.has(key))continue;used.add(key);
    out.push({id:crypto.randomBytes(6).toString('hex'),name,price:crypto.randomInt(lo,hi+1),ic:no[1],img:''});n++}});
  return out;
}
if(!db.catalog||!db.catalog.length){db.catalog=seedCatalog();save()}

const err=(m,s=400)=>{throw{m,s}};
const pub=e=>({name:e,bal:db.users[e].bal,role:db.users[e].role||'user',avatar:db.users[e].avatar||null,disp:db.users[e].disp||null});
const need=u=>u||err('Нужно войти',401);
const staff=u=>{const n=need(u);if(rank(db.users[n].role)<rank('helper'))err('Нет доступа',403);return n};
const econ=u=>{const n=need(u);if(rank(db.users[n].role)<rank('admin'))err('Нет доступа',403);return n};
const senior=u=>{const n=need(u);if(db.users[n].role!=='senior')err('Только для старшего админа',403);return n};
const att={};
const limit=ip=>{const n=Date.now();att[ip]=(att[ip]||[]).filter(t=>n-t<60000);if(att[ip].length>=10)err('Слишком много попыток, подождите минуту',429);att[ip].push(n)};
const session=e=>{const t=crypto.randomBytes(24).toString('hex');db.tokens[t]=e;save();return{token:t,user:pub(e)}};

function googleVerify(idToken){return new Promise((resolve,reject)=>{
  https.get('https://oauth2.googleapis.com/tokeninfo?id_token='+encodeURIComponent(idToken),r=>{let d='';r.on('data',c=>d+=c);
    r.on('end',()=>{try{const j=JSON.parse(d);if(r.statusCode!==200||j.error)return reject(new Error('Не удалось проверить Google-аккаунт'));resolve(j)}catch(e){reject(new Error('Ошибка проверки Google'))}})
  }).on('error',()=>reject(new Error('Нет связи с Google')))})}
function steamCheck(params){return new Promise((resolve,reject)=>{
  const body=new URLSearchParams(params).toString();
  const req=https.request('https://steamcommunity.com/openid/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}},r=>{
    let d='';r.on('data',c=>d+=c);r.on('end',()=>resolve(/is_valid\s*:\s*true/.test(d)))});
  req.on('error',()=>reject(new Error('Нет связи со Steam')));req.write(body);req.end()})}
function steamProfile(id64){return new Promise(resolve=>{if(!STEAM_API_KEY)return resolve(null);
  https.get(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${id64}`,r=>{let d='';r.on('data',c=>d+=c);
    r.on('end',()=>{try{const p=JSON.parse(d).response.players[0];resolve(p?{name:p.personaname,avatar:p.avatarfull}:null)}catch(e){resolve(null)}})}).on('error',()=>resolve(null))})}

const R={};
R['GET /api/config']=()=>({rtp:db.rtp,adReward:AD_REWARD,adSeconds:AD_SECONDS,tt:process.env.TT_URL||'',googleClientId:GOOGLE_CLIENT_ID,steam:!!true});
R['GET /api/feed']=()=>({feed:db.feed});
R['GET /api/me']=(b,u)=>({user:pub(need(u))});
R['GET /api/catalog']=()=>({catalog:db.catalog});

R['POST /api/register']=(b,u,ip)=>{limit(ip);const e=String(b.email||'').trim().toLowerCase();
  if(!/^\S+@\S+\.\S+$/.test(e)||e.length>80)err('Введите корректную почту');
  if(String(b.password||'').length<6)err('Пароль — минимум 6 символов');
  if(db.users[e])err('Эта почта уже зарегистрирована');
  db.users[e]={...mk(String(b.password)),bal:10000,role:'user',inv:[]};return session(e)};
R['POST /api/login']=(b,u,ip)=>{limit(ip);const e=String(b.id||'').trim().toLowerCase(),x=db.users[e];
  if(!x||!crypto.timingSafeEqual(Buffer.from(hash(String(b.password||''),x.salt),'hex'),Buffer.from(x.hash,'hex')))err('Неверная почта/ник или пароль');
  return session(e)};
R['POST /api/google']=async(b)=>{if(!GOOGLE_CLIENT_ID)err('Вход через Google не настроен');
  const j=await googleVerify(String(b.credential||''));
  if(j.aud!==GOOGLE_CLIENT_ID)err('Токен выдан для другого сайта');
  if(j.email_verified!=='true'&&j.email_verified!==true)err('Почта Google не подтверждена');
  const e=String(j.email||'').toLowerCase();if(!e)err('Google не вернул почту');
  if(!db.users[e])db.users[e]={...mk(crypto.randomBytes(16).toString('hex')),bal:10000,role:'user',inv:[],avatar:j.picture||null,disp:j.name||null};
  else{if(j.picture)db.users[e].avatar=j.picture;if(j.name)db.users[e].disp=j.name}
  save();return session(e)};
R['POST /api/steam/consume']=(b)=>{const code=String(b.code||''),e=db.steamCodes[code];if(!e)err('Ссылка входа устарела, попробуйте снова');
  delete db.steamCodes[code];save();return session(e)};

R['POST /api/buy']=(b,u)=>{const x=db.users[need(u)];x.inv=x.inv||[];
  const price=Math.max(1,Math.min(MAXITEM,Math.floor(+b.price)||0)),name=String(b.name||'Предмет').slice(0,60).trim()||'Предмет';
  if(price>x.bal)err('Недостаточно средств');if(x.inv.length>=80)err('Инвентарь переполнен');
  x.bal-=price;const item={id:crypto.randomBytes(6).toString('hex'),name,price,ic:String(b.ic||'charm').slice(0,20),img:String(b.img||'').slice(0,200)};
  x.inv.push(item);save();return{bal:x.bal,item,inv:x.inv}};
R['GET /api/inventory']=(b,u)=>{const x=db.users[need(u)];x.inv=x.inv||[];return{inv:x.inv,bal:x.bal}};
R['POST /api/sell']=(b,u)=>{const x=db.users[need(u)];x.inv=x.inv||[];const i=x.inv.findIndex(it=>it.id===b.id);
  if(i<0)err('Предмет не найден');const it=x.inv.splice(i,1)[0];x.bal+=it.price;save();return{bal:x.bal,inv:x.inv}};
R['POST /api/upgrade']=(b,u)=>{const x=db.users[need(u)];x.inv=x.inv||[];const ids=Array.isArray(b.ids)?b.ids.map(String):[];
  const items=ids.map(id=>x.inv.find(it=>it.id===id)).filter(Boolean);
  const cash=Math.max(0,Math.min(x.bal,Math.floor(+b.cash)||0));
  if(!items.length&&!cash)err('Выберите хотя бы один предмет или добавьте баланс');
  const total=items.reduce((s,it)=>s+it.price,0)+cash,target=Math.max(1,Math.min(MAXITEM,Math.floor(+b.target)||0)),tname=String(b.name||'Новый предмет').slice(0,60).trim()||'Новый предмет';
  if(target<=total)err('Целевой предмет должен быть дороже суммы ставки');
  const ch=db.rtp*total/target;if(ch<1||ch>90)err('Шанс вне диапазона 1–90%. Выберите другую цель или ставку');
  const win=crypto.randomInt(0,1e6)/1e4<ch,z=ch*3.6,r=()=>.05+.9*crypto.randomInt(0,1000)/1000,angle=win?z*r():z+(360-z)*r();
  x.inv=x.inv.filter(it=>!ids.includes(it.id));x.bal-=cash;let newItem=null;
  if(win){newItem={id:crypto.randomBytes(6).toString('hex'),name:tname,price:target,ic:String(b.ic||'charm').slice(0,20),img:String(b.img||'').slice(0,200)};x.inv.push(newItem)}
  db.feed.unshift({e:need(u).slice(0,2)+'***',w:win,a:win?target-total:total,m:target/total,c:ch});db.feed.length=Math.min(db.feed.length,20);save();
  return{win,angle,ch,total,target,newItem,bal:x.bal,inv:x.inv}};

R['POST /api/ad/start']=(b,u)=>{const x=db.users[need(u)],now=Date.now();
  if(x.adAt&&now-x.adAt<AD_COOLDOWN)err('Следующая реклама через '+Math.ceil((AD_COOLDOWN-(now-x.adAt))/1000)+' с');
  x.adStart=now;save();return{seconds:AD_SECONDS}};
R['POST /api/ad/claim']=(b,u)=>{const x=db.users[need(u)],now=Date.now();
  if(!x.adStart||now-x.adStart<AD_SECONDS*1000-500)err('Реклама ещё не досмотрена');
  x.adStart=0;x.adAt=now;x.bal+=AD_REWARD;save();return{bal:x.bal,reward:AD_REWARD}};

R['POST /api/promo/redeem']=(b,u)=>{const n=need(u),code=String(b.code||'').trim().toUpperCase(),p=db.promos[code];
  if(!p)err('Промокод не найден');if((p.usedBy||[]).includes(n))err('Вы уже использовали этот промокод');
  if(p.uses!=null&&p.usedBy.length>=p.uses)err('Промокод исчерпан');
  db.users[n].bal+=p.amount;p.usedBy=p.usedBy||[];p.usedBy.push(n);save();return{bal:db.users[n].bal,amount:p.amount}};

R['GET /api/admin/users']=(b,u,ip,q)=>{staff(u);const s=(q.get('q')||'').toLowerCase();return{users:Object.keys(db.users).filter(k=>k.includes(s)).map(pub)}};
R['POST /api/admin/balance']=(b,u)=>{const me=staff(u);const x=db.users[String(b.id)];if(!x)err('Игрок не найден');
  const a=Math.max(0,Math.floor(+b.amount)||0);
  if(db.users[me].role==='helper'){if(b.mode!=='add'||a>HELPER_CAP)err('Хелперу можно только начислять, максимум '+HELPER_CAP)}
  x.bal=b.mode=='add'?x.bal+a:b.mode=='sub'?Math.max(0,x.bal-a):a;save();return{ok:1}};
R['POST /api/admin/password']=(b,u)=>{econ(u);const id=String(b.id),x=db.users[id];
  if(!x||String(b.password||'').length<6)err('Пароль — минимум 6 символов');
  Object.assign(x,mk(String(b.password)));Object.keys(db.tokens).forEach(t=>{if(db.tokens[t]===id)delete db.tokens[t]});save();return{ok:1}};
R['POST /api/admin/rtp']=(b,u)=>{econ(u);db.rtp=Math.min(100,Math.max(50,+b.rtp||95));save();return{rtp:db.rtp}};
R['POST /api/admin/role']=(b,u)=>{const me=senior_or_admin(u);const id=String(b.id),role=String(b.role);
  if(!ROLES.includes(role))err('Неизвестная роль');if(!db.users[id])err('Игрок не найден');
  if(id===ADMIN)err('Нельзя менять роль главного администратора');
  const myRole=db.users[me].role;
  if(myRole==='admin'&&(role==='admin'||role==='senior'))err('Только старший админ может назначать админов');
  db.users[id].role=role;save();return{ok:1}};
function senior_or_admin(u){const n=need(u);if(rank(db.users[n].role)<rank('admin'))err('Нет доступа',403);return n}

R['POST /api/admin/catalog/add']=(b,u)=>{econ(u);const name=String(b.name||'').slice(0,60).trim();const price=Math.max(1,Math.min(MAXITEM,Math.floor(+b.price)||0));
  if(!name)err('Введите название');db.catalog.push({id:crypto.randomBytes(6).toString('hex'),name,price,ic:String(b.ic||'charm').slice(0,20),img:String(b.img||'').slice(0,200)});save();return{catalog:db.catalog}};
R['POST /api/admin/catalog/edit']=(b,u)=>{econ(u);const it=db.catalog.find(c=>c.id===String(b.id));if(!it)err('Предмет не найден');
  if(b.name!=null)it.name=String(b.name).slice(0,60).trim()||it.name;
  if(b.price!=null)it.price=Math.max(1,Math.min(MAXITEM,Math.floor(+b.price)||it.price));
  if(b.ic!=null)it.ic=String(b.ic).slice(0,20);if(b.img!=null)it.img=String(b.img).slice(0,200);
  save();return{catalog:db.catalog}};
R['POST /api/admin/catalog/remove']=(b,u)=>{econ(u);db.catalog=db.catalog.filter(c=>c.id!==String(b.id));save();return{catalog:db.catalog}};

R['POST /api/admin/promo']=(b,u)=>{econ(u);const code=String(b.code||'').trim().toUpperCase();if(!/^[A-ZА-Я0-9_-]{3,24}$/.test(code))err('Код: 3–24 символа, буквы/цифры');
  const amount=Math.max(1,Math.min(MAXITEM,Math.floor(+b.amount)||0)),uses=b.uses?Math.max(1,Math.floor(+b.uses)):null;
  db.promos[code]={amount,uses,usedBy:[],createdBy:need(u)};save();return{promos:db.promos}};
R['GET /api/admin/promo']=(b,u)=>{econ(u);return{promos:db.promos}};
R['POST /api/admin/promo/delete']=(b,u)=>{econ(u);delete db.promos[String(b.code||'').toUpperCase()];save();return{promos:db.promos}};

function thread(email){if(!db.tickets[email])db.tickets[email]={status:'closed',messages:[],updatedAt:0};return db.tickets[email]}
R['POST /api/support/send']=(b,u)=>{const n=need(u);const text=String(b.text||'').slice(0,500).trim();if(!text)err('Пустое сообщение');
  const t=thread(n);t.messages.push({from:'user',by:n,text,ts:Date.now()});t.status='open';t.updatedAt=Date.now();t.messages=t.messages.slice(-60);save();return{thread:t}};
R['GET /api/support/mine']=(b,u)=>{const n=need(u);return{thread:thread(n)}};
R['GET /api/support/list']=(b,u,ip,q)=>{staff(u);const all=q.get('all')==='1';
  return{list:Object.keys(db.tickets).filter(e=>all||db.tickets[e].status==='open').map(e=>({user:e,status:db.tickets[e].status,updatedAt:db.tickets[e].updatedAt,last:(db.tickets[e].messages.slice(-1)[0]||{}).text||''})).sort((a,b2)=>b2.updatedAt-a.updatedAt)}};
R['GET /api/support/thread']=(b,u,ip,q)=>{staff(u);const e=String(q.get('user')||'').toLowerCase();if(!db.users[e])err('Игрок не найден');return{thread:thread(e)}};
R['POST /api/support/reply']=(b,u)=>{const me=staff(u);const e=String(b.user||'').toLowerCase();if(!db.users[e])err('Игрок не найден');
  const text=String(b.text||'').slice(0,500).trim();let credit=0;
  if(b.credit){credit=Math.max(0,Math.floor(+b.credit)||0);if(db.users[me].role==='helper'&&credit>HELPER_CAP)err('Хелперу можно начислять максимум '+HELPER_CAP);
    if(credit>0){db.users[e].bal+=credit}}
  if(!text&&!credit)err('Введите сообщение или сумму начисления');
  const t=thread(e);t.messages.push({from:'staff',by:me,text:text||('Начислено '+credit),ts:Date.now(),credit:credit||undefined});
  t.status='open';t.updatedAt=Date.now();t.messages=t.messages.slice(-60);save();return{thread:t,bal:db.users[e].bal}};
R['POST /api/support/close']=(b,u)=>{staff(u);const e=String(b.user||'').toLowerCase();if(!db.tickets[e])err('Обращение не найдено');db.tickets[e].status='closed';save();return{ok:1}};

const send=(res,c,o)=>{res.writeHead(c,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(o))};
const CT={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml'};
http.createServer((req,res)=>{const url=new URL(req.url,'http://x');const origin=(req.headers['x-forwarded-proto']||'https')+'://'+req.headers.host;

  if(url.pathname==='/auth/steam'){
    const p=new URLSearchParams({'openid.ns':'http://specs.openid.net/auth/2.0','openid.mode':'checkid_setup',
      'openid.return_to':origin+'/auth/steam/return','openid.realm':origin,
      'openid.identity':'http://specs.openid.net/auth/2.0/identifier_select','openid.claimed_id':'http://specs.openid.net/auth/2.0/identifier_select'});
    res.writeHead(302,{Location:'https://steamcommunity.com/openid/login?'+p.toString()});return res.end()}

  if(url.pathname==='/auth/steam/return'){(async()=>{try{
    const params={};for(const[k,v]of url.searchParams)if(k.startsWith('openid.'))params[k]=v;params['openid.mode']='check_authentication';
    const ok=await steamCheck(params);if(!ok)throw 0;
    const m=/\/id\/(\d+)$/.exec(url.searchParams.get('openid.claimed_id')||'');if(!m)throw 0;
    const e='steam:'+m[1];
    if(!db.users[e])db.users[e]={...mk(crypto.randomBytes(16).toString('hex')),bal:10000,role:'user',inv:[]};
    const prof=await steamProfile(m[1]);if(prof){db.users[e].disp=prof.name;db.users[e].avatar=prof.avatar}
    save();const code=crypto.randomBytes(16).toString('hex');db.steamCodes[code]=e;save();
    setTimeout(()=>{delete db.steamCodes[code];save()},120000);
    res.writeHead(302,{Location:origin+'/?steam='+code});res.end()
  }catch(e){res.writeHead(302,{Location:origin+'/?steamerr=1'});res.end()}})();return}

  if(url.pathname.startsWith('/img/')){const rel=decodeURIComponent(url.pathname.slice(5));
    if(rel.includes('..')){res.writeHead(400);return res.end()}
    const file=path.join(__dirname,'img',rel);
    fs.readFile(file,(e,buf)=>{if(e){res.writeHead(404);return res.end('not found')}
      res.writeHead(200,{'Content-Type':CT[path.extname(file).toLowerCase()]||'application/octet-stream','Cache-Control':'public, max-age=86400'});res.end(buf)});return}

  if(url.pathname==='/ad.mp4'){const f=path.join(__dirname,'ad.mp4');fs.stat(f,(e,s)=>{if(e){res.writeHead(404);return res.end()}
    let a=0,b=s.size-1,code=200;const h={'Content-Type':'video/mp4','Accept-Ranges':'bytes'},m=/bytes=(\d*)-(\d*)/.exec(req.headers.range||'');
    if(m){if(m[1]){a=+m[1];if(m[2])b=Math.min(+m[2],s.size-1)}else if(m[2]){a=Math.max(0,s.size-+m[2])}code=206;if(a>b){res.writeHead(416);return res.end()}h['Content-Range']=`bytes ${a}-${b}/${s.size}`}
    h['Content-Length']=b-a+1;res.writeHead(code,h);fs.createReadStream(f,{start:a,end:b}).pipe(res)});return}

  if(url.pathname.startsWith('/api/')){let d='';req.on('data',c=>{d+=c;if(d.length>2e5)req.destroy()});
    req.on('end',async()=>{try{const h=R[req.method+' '+url.pathname];if(!h)err('Не найдено',404);
      const t=(req.headers.authorization||'').slice(7),u=db.tokens[t]&&db.users[db.tokens[t]]?db.tokens[t]:null;
      const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
      const out=await h(d?JSON.parse(d):{},u,ip,url.searchParams);send(res,200,out)}catch(e){send(res,(e&&e.s)||400,{error:(e&&e.m)||'Ошибка запроса'})}});return}

  fs.readFile(path.join(__dirname,'index.html'),(e,f)=>{res.writeHead(e?404:200,{'Content-Type':'text/html; charset=utf-8'});res.end(f||'index.html не найден')});
}).listen(PORT,()=>console.log('Apgruder запущен на порту',PORT));
