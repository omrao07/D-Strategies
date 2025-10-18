// app/routes.ts
// Simple router with hash/history support for demo screens

type Route = {
  path: string
  mount: () => void
}

export const Router = (() => {
  const routes: Route[] = []

  function add(path: string, mount: () => void) {
    routes.push({ path, mount })
  }

  function go(path: string) {
    try {
      history.pushState({}, '', path)
      run()
    } catch {
      // fallback: hash mode
      location.hash = path
    }
  }

  function run() {
    let p = location.pathname
    if (!p || p === '') p = '/'
    // fallback to hash if history not supported
    if (p === '/' && location.hash) p = location.hash.slice(1)

    const r = routes.find(x => x.path === p) || routes[0]
    if (r) r.mount()
  }

  // wire popstate/hashchange
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', run)
    window.addEventListener('hashchange', run)
  }

  return { add, go, run }
})()

// Example: add routes in main.ts
// Router.add('/', () => mountHome())
// Router.add('/matrix', () => mountStrategyMatrix())
// Router.add('/pnl', () => mountPnLDashboard())