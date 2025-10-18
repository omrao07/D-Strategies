// app/main.ts
// Fixed, self-contained bootstrap (no imports). Safe in browser; runs without errors.

/** ===================== FLAGS ===================== **/
const FLAGS = {
  USE_MOCK_DATA: true,
  USE_LIVE_ADAPTERS: false,
  ENABLE_SCHEDULER: true,
  ENABLE_PERSISTENCE: true,
  DEBUG_LOGS: true,
  DEMO_MODE: true
} as const
type FlagKey = keyof typeof FLAGS
function setFlag(k: FlagKey, v: boolean){ (FLAGS as any)[k] = v }

/** ===================== RUN / LOGS ===================== **/
const RUN_ID = (()=>`R_${new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14)}_${Math.random().toString(36).slice(2,8)}`)()
const log   = (...a:any[]) => { if (FLAGS.DEBUG_LOGS) console.log('[APP]', RUN_ID, ...a) }
const warn  = (...a:any[]) => console.warn('[APP]', RUN_ID, ...a)
const error = (...a:any[]) => console.error('[APP]', RUN_ID, ...a)

/** ===================== EVENT BUS ===================== **/
type Handler = (p?:any)=>void
const bus: Record<string, Handler[]> = {}
function on(ev:string, h:Handler){ (bus[ev] ??= []).push(h); return ()=>{ bus[ev]= (bus[ev]||[]).filter(x=>x!==h) } }
function emit(ev:string, p?:any){ (bus[ev]||[]).forEach(h=>{ try{ h(p) }catch(e){ error('bus',ev,e) } }) }

/** ===================== TYPES ===================== **/
type Ledger = { cash:number; positions:{symbol:string,qty:number,avgPx:number}[]; ts:number }
type Tick   = { t:number, symbol:string, px:number }
type Feed   = { kind:'mock'|'live', connect:()=>void, disconnect:()=>void, onTick:(h:(k:Tick)=>void)=>void }

/** ===================== PERSISTENCE ===================== **/
type StorageAPI = { save:(l:Ledger)=>void; load:()=>Ledger|null }
function hasLocalStorage(){ try{ return typeof localStorage!=='undefined' }catch{ return false } }

// NOTE: name is NOT "Storage" to avoid clash with DOM Storage interface
const LedgerStorage: StorageAPI = (()=> {
  const KEY = 'ledger_v1'
  let mem: string | null = null
  function save(ledger:Ledger){
    if(!FLAGS.ENABLE_PERSISTENCE) return
    const s = JSON.stringify(ledger)
    try{
      if(hasLocalStorage()) localStorage.setItem(KEY, s)
      else mem = s
    }catch(e){ warn('persist save failed', e) }
  }
  function load():Ledger|null{
    if(!FLAGS.ENABLE_PERSISTENCE) return null
    try{
      const s = hasLocalStorage() ? localStorage.getItem(KEY) : mem
      return s ? JSON.parse(s) as Ledger : null
    }catch{ return null }
  }
  return { save, load }
})()

/** ===================== SCHEDULER ===================== **/
type Job = ()=>Promise<void>|void
type MarketClock = { isOpen:(d:Date)=>boolean; nextOpen:(after:Date)=>Date }
const USEquitiesClock:MarketClock = {
  isOpen(d){ const day=d.getUTCDay(); if(day===0||day===6) return false
    const m=d.getUTCHours()*60+d.getUTCMinutes(), open=14*60+30, close=21*60
    return m>=open && m<=close
  },
  nextOpen(after){ const n=new Date(after); for(let i=0;i<7;i++){ if(i) n.setUTCDate(n.getUTCDate()+1); n.setUTCHours(14,30,0,0); if(this.isOpen(n)) return n } return n }
}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
function Scheduler(clock:MarketClock, intervalMs:number, jitterMs=250){
  let running=false
  async function start(job:Job){
    if(!FLAGS.ENABLE_SCHEDULER) return
    if(running) return; running=true
    while(running){
      const now=new Date()
      if(!clock.isOpen(now)){ const dt=clock.nextOpen(now).getTime()-now.getTime(); await sleep(Math.max(1000,dt)); continue }
      const jitter=(Math.random()*2-1)*jitterMs, due=Math.max(0, intervalMs+jitter)
      const t0=Date.now(); try{ await job() }catch(e){ error('job error', e) }
      await sleep(Math.max(0, due-(Date.now()-t0)))
    }
  }
  return { start, stop(){ running=false } }
}

/** ===================== FEEDS ===================== **/
function MockFeed(seed=1):Feed{
  let timer:any=null, handler:(k:Tick)=>void=()=>{}
  const syms=['AAPL','MSFT','RELIANCE','NIFTY']
  return {
    kind:'mock',
    connect(){ let i=0; timer=setInterval(()=>{ const s=syms[i%syms.length]; const px=100+Math.sin((i+seed)/7)*5+Math.random(); handler({t:Date.now(),symbol:s,px}); i++ }, 500) },
    disconnect(){ clearInterval(timer) },
    onTick(h){ handler=h }
  }
}
function LiveFeedTemplate():Feed{
  let handler:(k:Tick)=>void=()=>{}
  return { kind:'live', connect(){ warn('LiveFeed not implemented') }, disconnect(){}, onTick(h){ handler=h } }
}

/** ===================== ENGINE ===================== **/
const Engine = (()=>{
  let ledger:Ledger = { cash:100000, positions:[], ts:Date.now() }
  let feed:Feed|null = null

  function setFeed(f:Feed){ feed=f; f.onTick(onTick) }
  function onTick(k:Tick){ emit('tick',k); ledger.ts=k.t; emit('ledger',ledger) }

  function start(){ feed?.connect() }
  function stop(){ feed?.disconnect() }
  function getLedger(){ return ledger }

  function load(){ const l=LedgerStorage.load(); if(l) ledger=l }
  function save(){ LedgerStorage.save(ledger) }

  return { setFeed, start, stop, getLedger, load, save }
})()

/** ===================== ROUTER (tiny) ===================== **/
type Route = { path:string, mount:()=>void }
const Router = (()=>{
  const routes:Route[]=[]
  function add(path:string, mount:()=>void){ routes.push({path,mount}) }
  function go(path:string){ try{ history.pushState({},'',path) }catch{}; run() }
  function run(){ let p=location.pathname||'/'; if(p==='/' && location.hash) p=location.hash.slice(1); (routes.find(r=>r.path===p)||routes[0])?.mount() }
  if(typeof window!=='undefined'){ window.addEventListener('popstate', run); window.addEventListener('hashchange', run) }
  return { add, go, run }
})()

/** ===================== BANNER ===================== **/
function mountBanner(){
  if(typeof document==='undefined') return
  let el=document.getElementById('__app_banner__')
  if(!el){ el=document.createElement('div'); el.id='__app_banner__'; document.body.appendChild(el) }
  const tags=[FLAGS.DEMO_MODE?'Demo':'Live', FLAGS.USE_MOCK_DATA?'MockData':'', FLAGS.USE_LIVE_ADAPTERS?'Adapters':''].filter(Boolean).join(' · ')
  el.setAttribute('style','position:fixed;left:12px;bottom:12px;padding:6px 10px;border-radius:10px;background:#111827;color:#fff;font:12px system-ui;box-shadow:0 6px 18px rgba(0,0,0,.25);z-index:9999;opacity:.9')
  el.textContent=`RUN ${RUN_ID} — ${tags}`
}

/** ===================== BOOT ===================== **/
async function boot(){
  log('boot', FLAGS, RUN_ID)

  const feed = FLAGS.USE_LIVE_ADAPTERS ? LiveFeedTemplate() : MockFeed(1)
  Engine.setFeed(feed)
  Engine.load()
  Engine.start()

  if(FLAGS.ENABLE_SCHEDULER){
    const sched = Scheduler(USEquitiesClock, 60_000, 250)
    sched.start(()=> Engine.save())
  }

  Router.add('/', ()=> mountBanner())
  Router.run()

  ;(window as any).APP = { RUN_ID, FLAGS, setFlag, on, emit, Engine, Router, log, warn, error }
  log('ready')
}

if(typeof document!=='undefined'){
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
} else { boot() }