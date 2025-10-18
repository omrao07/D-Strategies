// core/metrics.ts
// Lightweight metrics registry: counters, gauges, timers, histograms, EMAs, rolling windows,
// FPS/memory canary, and snapshot/export. Pure TS, no imports.

// ========================= Time helpers =========================
const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()

// ========================= Types =========================
type Num = number
type Str = string

export type Counter = { name:Str; help?:Str; value:Num }
export type Gauge   = { name:Str; help?:Str; value:Num }
export type Timer   = { name:Str; help?:Str; _starts:Record<Str,Num>; values:Num[] }
export type Histo   = { name:Str; help?:Str; values:Num[]; buckets?:Num[]; counts?:Record<Str,Num> }
export type EMA     = { name:Str; help?:Str; alpha:Num; value:Num|null }
export type Roll    = { name:Str; help?:Str; size:number; buf:Num[]; idx:number; filled:boolean }

export type MetricsSnapshot = {
  ts: number
  counters: Record<Str,Num>
  gauges:   Record<Str,Num>
  timers:   Record<Str,{count:number,p50:Num,p90:Num,p99:Num,avg:Num,min:Num,max:Num}>
  histos:   Record<Str,{count:number,p50:Num,p90:Num,p99:Num,avg:Num,min:Num,max:Num, buckets?:Record<Str,Num>}>
  emas:     Record<Str,Num|null>
  rolls:    Record<Str,{count:number,avg:Num,min:Num,max:Num}>
  canary?:  { fps?:Num; memMB?:Num }
}

// ========================= Registry =========================
const counters: Record<Str,Counter> = {}
const gauges:   Record<Str,Gauge>   = {}
const timers:   Record<Str,Timer>   = {}
const histos:   Record<Str,Histo>   = {}
const emas:     Record<Str,EMA>     = {}
const rolls:    Record<Str,Roll>    = {}

// ========================= Utilities =========================
function ensureCounter(name:Str, help?:Str){ return counters[name] ||= { name, help, value:0 } }
function ensureGauge(name:Str, help?:Str){ return gauges[name]   ||= { name, help, value:0 } }
function ensureTimer(name:Str, help?:Str){ return timers[name]   ||= { name, help, _starts:{}, values:[] } }
function ensureHisto(name:Str, help?:Str, buckets?:Num[]){
  const h = histos[name] ||= { name, help, values:[], buckets: buckets?.slice().sort((a,b)=>a-b), counts:{} }
  if(buckets && (!h.buckets || h.buckets.join(',')!==buckets.slice().sort((a,b)=>a-b).join(','))){
    h.buckets = buckets.slice().sort((a,b)=>a-b); h.counts = {}
  }
  return h
}
function ensureEMA(name:Str, alpha=0.2, help?:Str){ return emas[name] ||= { name, help, alpha, value:null } }
function ensureRoll(name:Str, size=256, help?:Str){ return rolls[name] ||= { name, help, size, buf:new Array(size).fill(0), idx:0, filled:false } }

function percentile(arr:Num[], p:Num){
  if(arr.length===0) return 0
  const a = arr.slice().sort((x,y)=>x-y)
  const idx = Math.min(a.length-1, Math.max(0, Math.floor((p/100)* (a.length-1))))
  return a[idx]
}
function summaryStats(arr:Num[]){
  if(arr.length===0) return { count:0, avg:0, min:0, max:0, p50:0, p90:0, p99:0 }
  let sum=0, min=arr[0], max=arr[0]
  for(const v of arr){ sum+=v; if(v<min)min=v; if(v>max)max=v }
  const avg = sum/arr.length
  return { count:arr.length, avg, min, max, p50:percentile(arr,50), p90:percentile(arr,90), p99:percentile(arr,99) }
}

// ========================= API: Counters =========================
export const Counter = {
  inc(name:Str, by:Num=1, help?:Str){ ensureCounter(name, help).value += by; return counters[name].value },
  get(name:Str){ return counters[name]?.value ?? 0 },
  set(name:Str, v:Num, help?:Str){ ensureCounter(name, help).value = v }
}

// ========================= API: Gauges =========================
export const Gauge = {
  set(name:Str, v:Num, help?:Str){ ensureGauge(name, help).value = v; return v },
  add(name:Str, by:Num=1, help?:Str){ const g=ensureGauge(name, help); g.value += by; return g.value },
  get(name:Str){ return gauges[name]?.value ?? 0 }
}

// ========================= API: Timers =========================
// Usage:
// const t = Timer.start('load_data'); ... Timer.end('load_data', t)
// or Timer.time('calc', () => { ... })
export const Timer = {
  start(name:Str, help?:Str){ const t=ensureTimer(name, help); const k=Math.random().toString(36).slice(2,9); t._starts[k]=nowMs(); return k },
  end(name:Str, token:Str){ const t=timers[name]; if(!t) return 0; const s=t._starts[token]; if(s==null) return 0; const d=nowMs()-s; delete t._starts[token]; t.values.push(d); if(t.values.length>5000) t.values.splice(0, t.values.length-5000); return d },
  time<T>(name:Str, fn:()=>T, help?:Str){ const tok=this.start(name,help); try{ return fn() } finally{ this.end(name,tok) } },
  timeAsync: async <T>(name:Str, fn:()=>Promise<T>, help?:Str) => { const tok=Timer.start(name,help); try{ return await fn() } finally{ Timer.end(name,tok) } }
}

// ========================= API: Histograms =========================
// histo.observe('latency_ms', 42, [5,10,25,50,100,200,500])
export const Histo = {
  observe(name:Str, v:Num, buckets?:Num[], help?:Str){
    const h = ensureHisto(name, help, buckets)
    h.values.push(v); if(h.values.length>10000) h.values.splice(0, h.values.length-10000)
    if(h.buckets){ 
      const last = h.buckets[h.buckets.length-1]
      for(const b of h.buckets){ const key = String(b); if(v<=b){ (h.counts as any)[key] = ((h.counts as any)[key]??0)+1; return } }
      // overflow (> last bucket)
      const key = `+Inf(${last})`; (h.counts as any)[key] = ((h.counts as any)[key]??0)+1
    }
  }
}

// ========================= API: EMA =========================
export const Ema = {
  set(name:Str, alpha=0.2, help?:Str){ ensureEMA(name, alpha, help) },
  observe(name:Str, v:Num, alpha?:Num){
    const e = ensureEMA(name, alpha ?? emas[name]?.alpha ?? 0.2)
    e.value = (e.value==null) ? v : (e.alpha*v + (1-e.alpha)*e.value)
    return e.value
  },
  get(name:Str){ return emas[name]?.value ?? null }
}

// ========================= API: Rolling Window =========================
export const Rolling = {
  set(name:Str, size=256, help?:Str){ ensureRoll(name,size,help) },
  push(name:Str, v:Num, size?:number){
    const r = ensureRoll(name, size ?? rolls[name]?.size ?? 256)
    r.buf[r.idx] = v; r.idx = (r.idx+1) % r.size; if(!r.filled && r.idx===0) r.filled = true
    return v
  },
  stats(name:Str){
    const r = rolls[name]; if(!r) return { count:0, avg:0, min:0, max:0 }
    const n = r.filled ? r.size : r.idx
    if(n===0) return { count:0, avg:0, min:0, max:0 }
    let sum=0, min=r.buf[0], max=r.buf[0]
    for(let i=0;i<n;i++){ const v=r.buf[i]; sum+=v; if(v<min)min=v; if(v>max)max=v }
    return { count:n, avg:sum/n, min, max }
  }
}

// ========================= FPS / Memory Canary =========================
let fpsLast = nowMs(), frames = 0
let fpsEmaName = '__fps_ema__'
export function enableFPSCanary(){ 
  if(typeof window==='undefined' || typeof requestAnimationFrame==='undefined') return
  const tick = () => {
    frames++
    const t = nowMs()
    if(t - fpsLast >= 1000){
      const fps = frames * 1000 / (t - fpsLast)
      Ema.observe(fpsEmaName, fps, 0.2)
      frames=0; fpsLast=t
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
export function getFPS(){ return Ema.get(fpsEmaName) as number|null }
export function getMemoryMB(){
  const p:any = (typeof performance!=='undefined' ? (performance as any) : null)
  if(p && p.memory && p.memory.usedJSHeapSize){ return Math.round(p.memory.usedJSHeapSize/1_000_000) }
  return undefined
}

// ========================= Snapshots / Export =========================
export function snapshot(): MetricsSnapshot {
  const ts = Date.now()

  const countersOut: Record<Str,Num> = {}
  for(const k in counters) countersOut[k] = counters[k].value

  const gaugesOut: Record<Str,Num> = {}
  for(const k in gauges)   gaugesOut[k] = gauges[k].value

  const timersOut: MetricsSnapshot['timers'] = {}
  for(const k in timers) timersOut[k] = summaryStats(timers[k].values)

  const histosOut: MetricsSnapshot['histos'] = {}
  for(const k in histos){
    const h = histos[k]
    histosOut[k] = { ...summaryStats(h.values), buckets: h.counts as Record<Str,Num> }
  }

  const emasOut: Record<Str,Num|null> = {}
  for(const k in emas) emasOut[k] = emas[k].value

  const rollsOut: MetricsSnapshot['rolls'] = {}
  for(const k in rolls) rollsOut[k] = Rolling.stats(k)

  const canary = { fps: getFPS() ?? undefined, memMB: getMemoryMB() }

  return { ts, counters: countersOut, gauges: gaugesOut, timers: timersOut, histos: histosOut, emas: emasOut, rolls: rollsOut, canary }
}

export function reset(kind?: 'all'|'counters'|'gauges'|'timers'|'histos'|'emas'|'rolls'){
  const k = kind ?? 'all'
  if(k==='all' || k==='counters') for(const x in counters) counters[x].value = 0
  if(k==='all' || k==='gauges')   for(const x in gauges)   gauges[x].value = 0
  if(k==='all' || k==='timers')   for(const x in timers)   timers[x].values.length = 0
  if(k==='all' || k==='histos')   for(const x in histos){ histos[x].values.length=0; histos[x].counts = {} }
  if(k==='all' || k==='emas')     for(const x in emas)     emas[x].value = null
  if(k==='all' || k==='rolls')    for(const x in rolls){ rolls[x].buf.fill(0); rolls[x].idx=0; rolls[x].filled=false }
}

// ========================= Pretty Print (optional) =========================
export function toLines(snap: MetricsSnapshot = snapshot()){
  const lines: string[] = []
  const f = (n:Num)=> (Math.abs(n) < 1e-3 ? n.toExponential(3) : n.toFixed(3))
  lines.push(`ts=${new Date(snap.ts).toISOString()}`)
  if(snap.canary?.fps) lines.push(`fps=${f(snap.canary.fps)}`)
  if(snap.canary?.memMB!==undefined) lines.push(`memMB=${snap.canary.memMB}`)
  for(const k in snap.counters) lines.push(`counter.${k}=${f(snap.counters[k])}`)
  for(const k in snap.gauges)   lines.push(`gauge.${k}=${f(snap.gauges[k])}`)
  for(const k in snap.timers){ const t=snap.timers[k]; lines.push(`timer.${k}{n=${t.count}} avg=${f(t.avg)} p90=${f(t.p90)} p99=${f(t.p99)}`) }
  for(const k in snap.histos){ const h=snap.histos[k]; lines.push(`histo.${k}{n=${h.count}} avg=${f(h.avg)} p90=${f(h.p90)} p99=${f(h.p99)}`) }
  for(const k in snap.emas)     lines.push(`ema.${k}=${snap.emas[k]===null?'null':f(snap.emas[k] as number)}`)
  for(const k in snap.rolls){ const r=snap.rolls[k]; lines.push(`roll.${k}{n=${r.count}} avg=${f(r.avg)} min=${f(r.min)} max=${f(r.max)}`) }
  return lines
}

// ========================= Example usage (remove if not needed) =========================
// Counter.inc('ticks')
// const t = Timer.start('rebalance'); ... Timer.end('rebalance', t)
// Histo.observe('latency_ms', 42, [5,10,25,50,100,200,500])
// Ema.observe('fps', 58.2)
// Rolling.push('equity', nav)
// const snap = snapshot(); console.log(toLines(snap).join('\n'))