// frontend/components/Toast.tsx
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

export type ToastType = "info" | "success" | "warning" | "error";

export type Toast = {
  id: string;
  type: ToastType;
  message: string;
  duration?: number; // ms
};

type ToastContextValue = {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => void;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const toast: Toast = { id, duration: 4000, ...t };
    setToasts(prev => [...prev, toast]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, push, dismiss }}>
      {children}
      <ToastViewport toasts={toasts} dismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

function ToastViewport({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: string) => void }) {
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-80"
    >
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { id, type, message, duration } = toast;
  const [hover, setHover] = useState(false);

  useEffect(() => {
    if (hover) return;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [hover, duration, onDismiss]);

  const colors: Record<ToastType, { bg: string; border: string }> = {
    info: { bg: "bg-blue-50", border: "border-blue-400" },
    success: { bg: "bg-green-50", border: "border-green-400" },
    warning: { bg: "bg-yellow-50", border: "border-yellow-400" },
    error: { bg: "bg-red-50", border: "border-red-400" }
  };

  return (
    <div
      role="status"
      tabIndex={0}
      className={`border ${colors[type].border} ${colors[type].bg} rounded shadow p-3 flex justify-between items-start animate-slide-in`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="pr-2 text-sm text-gray-900">{message}</div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="text-gray-500 hover:text-gray-700 text-sm"
      >
        ✕
      </button>
    </div>
  );
}

// Animation (basic CSS you can add to globals.css or tailwind config):
// .animate-slide-in { animation: slide-in 0.2s ease-out; }
// @keyframes slide-in {
//   from { opacity: 0; transform: translateX(30px); }
//   to { opacity: 1; transform: translateX(0); }
// }      <p>© 2024 HF Platform</p>