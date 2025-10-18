// core/log.ts
// Lightweight logger with levels, colors, runId, timestamps. No imports.

/* ======================= State ======================= */
const RUN_ID = (() => {
  const rand = Math.random().toString(36).slice(2, 6)
  const t = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 12)
  return `R${t}_${rand}`
})()

let LEVEL: 'debug'|'info'|'warn'|'error' = 'debug'

/* ======================= Helpers ======================= */
function ts() {
  const d = new Date()
  return d.toISOString().split('T')[1].replace('Z','')
}

function colorize(level:string, msg:string) {
  if (typeof window !== 'undefined') return msg // browser console handles styling separately
  const codes: Record<string,string> = {
    debug: '\x1b[90m',
    info:  '\x1b[36m',
    warn:  '\x1b[33m',
    error: '\x1b[31m'
  }
  const reset = '\x1b[0m'
  return (codes[level]||'') + msg + reset
}

function shouldLog(l:'debug'|'info'|'warn'|'error'){
  const order = { debug:0, info:1, warn:2, error:3 }
  return order[l] >= order[LEVEL]
}

/* ======================= Core Logger ======================= */
function base(level:'debug'|'info'|'warn'|'error', ...args:any[]){
  if(!shouldLog(level)) return
  const prefix = `[${ts()}][${RUN_ID}][${level.toUpperCase()}]`
  const msg = prefix + ' ' + args.map(a => 
    typeof a === 'string' ? a : JSON.stringify(a)
  ).join(' ')
  if(level==='debug' || level==='info') console.log(colorize(level,msg))
  else if(level==='warn') console.warn(colorize(level,msg))
  else console.error(colorize(level,msg))
}

/* ======================= API ======================= */
export const Log = {
  runId: RUN_ID,
  setLevel(l:'debug'|'info'|'warn'|'error'){ LEVEL = l },
  debug: (...a:any[]) => base('debug', ...a),
  info:  (...a:any[]) => base('info',  ...a),
  warn:  (...a:any[]) => base('warn',  ...a),
  error: (...a:any[]) => base('error', ...a)
}