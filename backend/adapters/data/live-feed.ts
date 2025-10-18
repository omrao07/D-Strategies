// adapters/data/live-feed.pure.ts
// Pure demo: no imports, minimal implementation

type Tick = { symbol: string; price: number };

class SimpleLiveFeed<T extends { symbol: string }> {
  url: string;
  ws?: WebSocket;
  subs: Map<string, ((msg: T) => void)[]> = new Map();

  constructor(url: string) {
    this.url = url;
  }

  async connect() {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log("[live] connected");
        resolve();
      };

      this.ws.onerror = (err) => {
        console.error("[live] error", err);
        reject(err);
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: T = JSON.parse(event.data.toString());
          const handlers = this.subs.get(msg.symbol);
          if (handlers) handlers.forEach((fn) => fn(msg));
        } catch (e) {
          console.error("[live] bad message", event.data);
        }
      };
    });
  }

  subscribe(symbol: string, fn: (msg: T) => void) {
    if (!this.subs.has(symbol)) this.subs.set(symbol, []);
    this.subs.get(symbol)!.push(fn);

    return () => {
      this.subs.set(
        symbol,
        this.subs.get(symbol)!.filter((f) => f !== fn)
      );
    };
  }

  send(msg: any) {
    this.ws?.send(JSON.stringify(msg));
  }

  disconnect() {
    this.ws?.close();
    console.log("[live] disconnected");
  }
}

// ===== Example usage =====

const feed = new SimpleLiveFeed<Tick>("wss://echo.websocket.events");

// 1) Subscribe to AAPL ticks
const offAAPL = feed.subscribe("AAPL", (msg) => {
  console.log("AAPL tick:", msg);
});

// 2) Connect and send a demo tick
(async () => {
  await feed.connect();

  // send fake AAPL tick to echo server
  setTimeout(() => {
    feed.send({ symbol: "AAPL", price: 123.45 });
  }, 1000);
})();