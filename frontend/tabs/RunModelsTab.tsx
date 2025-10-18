// frontend/tabs/RunModelsTab.tsx
// Production-ready tab to run quant strategies with queueing, concurrency limits,
// live status, keyboard/a11y support. No external deps.

import React, { useCallback, useMemo, useRef, useState } from "react";

export type Strategy = {
  id: string;
  name: string;
  description?: string;
};

export type RunResult = {
  ok: boolean;
  msg: string;
  artifact?: string; // optional file path or URL to report
};

type Props = {
  strategies: Strategy[];
  runStrategy: (id: string) => Promise<RunResult>;
  /** Max concurrently running strategies when using "Run All". Default 2. */
  maxConcurrent?: number;
};

type Status =
  | { state: "idle" }
  | { state: "running"; startedAt: number }
  | { state: "success"; msg: string; artifact?: string; finishedAt: number }
  | { state: "error"; msg: string; finishedAt: number };

export default function RunModelsTab({
  strategies,
  runStrategy,
  maxConcurrent = 2
}: Props) {
  const [filter, setFilter] = useState("");
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [queueRunning, setQueueRunning] = useState(false);
  const [concurrency, setConcurrency] = useState(maxConcurrent);
  const abortAllRef = useRef<{ aborted: boolean }>({ aborted: false });

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return strategies;
    return strategies.filter(
      s =>
        s.id.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        (s.description || "").toLowerCase().includes(q)
    );
  }, [strategies, filter]);

  const successCount = useMemo(
    () =>
      Object.values(statuses).filter(s => s.state === "success").length,
    [statuses]
  );
  const errorCount = useMemo(
    () => Object.values(statuses).filter(s => s.state === "error").length,
    [statuses]
  );
  const runningCount = useMemo(
    () => Object.values(statuses).filter(s => s.state === "running").length,
    [statuses]
  );

  const updateStatus = useCallback((id: string, next: Status) => {
    setStatuses(prev => ({ ...prev, [id]: next }));
  }, []);

  async function handleRun(id: string) {
    abortAllRef.current.aborted = false;
    updateStatus(id, { state: "running", startedAt: Date.now() });
    try {
      const res = await runStrategy(id);
      if (abortAllRef.current.aborted) return; // if aborted after finish, don't overwrite
      updateStatus(id, {
        state: res.ok ? "success" : "error",
        msg: res.msg,
        artifact: res.artifact,
        finishedAt: Date.now()
      });
    } catch (e: any) {
      if (abortAllRef.current.aborted) return;
      updateStatus(id, {
        state: "error",
        msg: e?.message || "Run failed",
        finishedAt: Date.now()
      });
    }
  }

  function resetStatuses(ids?: string[]) {
    if (!ids) {
      setStatuses({});
      return;
    }
    setStatuses(prev => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
  }

  async function handleRunAll(ids: string[]) {
    if (!ids.length) return;
    abortAllRef.current.aborted = false;
    setQueueRunning(true);
    // simple worker pool
    const queue = ids.slice();
    const workers: Promise<void>[] = [];
    const now = Date.now();

    // pre-mark queued as idle if not set
    setStatuses(prev => {
      const next = { ...prev };
      for (const id of ids) {
        if (!next[id] || next[id].state !== "running") {
          next[id] = { state: "idle" };
        }
      }
      return next;
    });

    const worker = async () => {
      while (queue.length && !abortAllRef.current.aborted) {
        const id = queue.shift()!;
        updateStatus(id, { state: "running", startedAt: now });
        try {
          const res = await runStrategy(id);
          if (abortAllRef.current.aborted) break;
          updateStatus(id, {
            state: res.ok ? "success" : "error",
            msg: res.msg,
            artifact: res.artifact,
            finishedAt: Date.now()
          });
        } catch (e: any) {
          if (abortAllRef.current.aborted) break;
          updateStatus(id, {
            state: "error",
            msg: e?.message || "Run failed",
            finishedAt: Date.now()
          });
        }
      }
    };

    const k = Math.max(1, Math.min(concurrency, ids.length));
    for (let i = 0; i < k; i++) workers.push(worker());
    await Promise.all(workers);
    setQueueRunning(false);
  }

  function abortAll() {
    abortAllRef.current.aborted = true;
    setQueueRunning(false);
  }

  function progressBar() {
    const total =
      visible.length === 0 ? strategies.length : visible.length;
    const done = successCount + errorCount;
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return (
      <div aria-label="Run progress" className="w-full max-w-xl">
        <div className="h-2 bg-gray-200 rounded">
          <div
            className="h-2 bg-blue-600 rounded"
            style={{ width: `${pct}%` }}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            role="progressbar"
          />
        </div>
        <div className="text-xs mt-1 text-gray-600">
          {done}/{total} completed · {runningCount} running · {errorCount} failed
        </div>
      </div>
    );
  }

  return (
    <section aria-labelledby="models-heading" role="region">
      <header className="mb-3 flex items-center gap-3 flex-wrap">
        <h2 id="models-heading" className="text-lg font-semibold">
          Run Quant Models
        </h2>

        {progressBar()}

        <div className="ml-auto flex items-center gap-2">
          <label className="text-sm">
            Concurrency{" "}
            <input
              type="number"
              min={1}
              max={8}
              value={concurrency}
              onChange={e => setConcurrency(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
              className="w-16 border rounded px-2 py-1"
              aria-label="Max concurrent runs"
            />
          </label>

          <button
            className="px-3 py-1 border rounded"
            onClick={() => handleRunAll(visible.map(s => s.id))}
            disabled={queueRunning || visible.length === 0}
            aria-busy={queueRunning}
            aria-label="Run all visible strategies"
          >
            {queueRunning ? "Running All…" : "Run All"}
          </button>

          <button
            className="px-3 py-1 border rounded"
            onClick={abortAll}
            disabled={!queueRunning}
            aria-label="Abort all running jobs"
          >
            Abort
          </button>

          <button
            className="px-3 py-1 border rounded"
            onClick={() => resetStatuses()}
            aria-label="Clear statuses"
          >
            Clear
          </button>

          <label className="text-sm">
            <span className="sr-only">Filter strategies</span>
            <input
              aria-label="Filter strategies"
              placeholder="Filter…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              className="border px-2 py-1 rounded"
            />
          </label>
        </div>
      </header>

      <ul role="list" className="grid gap-3">
        {visible.map(s => {
          const st = statuses[s.id] || { state: "idle" };
          return (
            <li key={s.id} role="listitem">
              <article
                className="border rounded p-3 bg-white"
                aria-labelledby={`s-${s.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 id={`s-${s.id}`} className="font-medium">
                      {s.name}
                    </h3>
                    {s.description ? (
                      <p className="text-sm text-gray-600">{s.description}</p>
                    ) : null}
                    <p className="text-xs text-gray-500 mt-1">ID: {s.id}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="px-3 py-1 border rounded"
                      onClick={() => handleRun(s.id)}
                      disabled={st.state === "running" || queueRunning}
                      aria-busy={st.state === "running"}
                      aria-label={`Run ${s.name}`}
                    >
                      {st.state === "running" ? "Running…" : "Run"}
                    </button>
                  </div>
                </div>

                <div className="mt-2 text-sm">
                  {st.state === "idle" && <span className="text-gray-500">Idle</span>}
                  {st.state === "running" && (
                    <span className="text-blue-700">Running since {new Date(st.startedAt).toLocaleTimeString()}</span>
                  )}
                  {st.state === "success" && (
                    <span className="text-green-700">
                      ✅ {st.msg}
                      {st.artifact ? (
                        <>
                          {" "}|{" "}
                          <a
                            href={st.artifact}
                            target="_blank"
                            rel="noreferrer"
                            className="underline"
                          >
                            Artifact
                          </a>
                        </>
                      ) : null}
                    </span>
                  )}
                  {st.state === "error" && (
                    <span className="text-red-700">❌ {st.msg}</span>
                  )}
                </div>
              </article>
            </li>
          );
        })}
        {visible.length === 0 && (
          <li className="italic text-gray-500">No strategies match the filter.</li>
        )}
      </ul>
    </section>
  );
}