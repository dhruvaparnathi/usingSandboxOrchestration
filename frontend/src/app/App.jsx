import { useCallback, useEffect, useState } from "react";
import "./App.css";
import TerminalComponent from "../components/TerminalComponent.jsx";

const HISTORY_KEY = "sandbox_history_ids";

const loadHistory = () => {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
};

const saveHistory = (sandboxId) => {
  const next = [sandboxId, ...loadHistory().filter((id) => id !== sandboxId)].slice(0, 5);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
};

function App() {
  const [sandbox, setSandbox] = useState(null);
  const [resumeId, setResumeId] = useState("");
  const [history, setHistory] = useState(loadHistory);
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | booting | ready | disconnected
  const [podPhase, setPodPhase] = useState("");
  const [previewReady, setPreviewReady] = useState(false);
  const [error, setError] = useState("");
  const [iframeKey, setIframeKey] = useState(0);

  const handleStatusChange = useCallback((nextStatus) => {
    setStatus(nextStatus);
  }, []);

  // Poll Kubernetes readiness while booting
  useEffect(() => {
    if (!sandbox || previewReady) return;
    let active = true;

    const poll = async () => {
      try {
        const res = await fetch(`/api/sandbox/${sandbox.sandboxId}/status`);
        if (!res.ok) return;
        const data = await res.json();
        if (!active) return;

        setPodPhase(data.initReady ? data.phase : "Init (seeding + npm install)");
        if (data.ready) {
          setPreviewReady(true);
          setIframeKey((k) => k + 1);
        }
      } catch {
        // Ignore transient network errors while booting
      }
    };

    poll();
    const id = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [sandbox, previewReady]);

  // Send idle-TTL heartbeat every 60s while sandbox is active
  useEffect(() => {
    if (!sandbox) return;
    const id = setInterval(() => {
      fetch(`/api/sandbox/${sandbox.sandboxId}/heartbeat`, { method: "POST" }).catch(() => {});
    }, 60 * 1000);
    return () => clearInterval(id);
  }, [sandbox]);

  const startSandbox = async (targetId) => {
    setLoading(true);
    setError("");
    setPreviewReady(false);
    setPodPhase("Scheduling pod");
    try {
      const body = targetId ? JSON.stringify({ sandboxId: targetId }) : undefined;
      const res = await fetch("/api/sandbox/start", {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to start sandbox");
      }
      setSandbox(data);
      setStatus("booting");
      setHistory(saveHistory(data.sandboxId));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const stopSandbox = async () => {
    if (!sandbox) return;
    setStopping(true);
    setError("");
    try {
      const res = await fetch(`/api/sandbox/${sandbox.sandboxId}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to delete sandbox");
      }
      setSandbox(null);
      setStatus("idle");
      setPreviewReady(false);
      setPodPhase("");
    } catch (err) {
      setError(err.message);
    } finally {
      setStopping(false);
    }
  };

  const statusBadge = {
    idle: "bg-zinc-800 text-zinc-300",
    booting: "bg-amber-500/20 text-amber-300 border border-amber-500/40",
    ready: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40",
    disconnected: "bg-red-500/20 text-red-300 border border-red-500/40",
  }[status];

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* Top Bar */}
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5 bg-zinc-900">
        <div className="flex items-center gap-3">
          <span className="font-semibold tracking-tight text-white">
            Sandbox Orchestrator
          </span>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadge}`}>
            {status === "booting" ? `Booting (${podPhase || "starting"})...` : status}
          </span>
          {sandbox && (
            <span className="hidden md:inline font-mono text-xs text-zinc-400">
              {sandbox.sandboxId}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!sandbox ? (
            <button
              onClick={() => startSandbox()}
              disabled={loading}
              className="rounded-md bg-emerald-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 cursor-pointer"
            >
              {loading ? "Starting..." : "Start Sandbox"}
            </button>
          ) : (
            <>
              <button
                onClick={() => setIframeKey((k) => k + 1)}
                className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 cursor-pointer"
              >
                Reload Preview
              </button>
              <a
                href={sandbox.urls.previewUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
              >
                Open Preview ↗
              </a>
              <button
                onClick={stopSandbox}
                disabled={stopping}
                className="rounded-md bg-red-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50 cursor-pointer"
              >
                {stopping ? "Stopping..." : "Stop Sandbox"}
              </button>
            </>
          )}
        </div>
      </header>

      {error && (
        <div className="border-b border-red-800 bg-red-950/60 px-4 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {/* Workspace */}
      {!sandbox ? (
        <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6 text-center">
          <div className="max-w-md space-y-4">
            <h1 className="text-2xl font-bold text-white">
              Cloud React Sandbox
            </h1>
            <p className="text-sm text-zinc-400">
              Launch an isolated Kubernetes pod with a live Vite preview,
              interactive PTY terminal, and automatic S3 workspace sync.
            </p>
            <button
              onClick={() => startSandbox()}
              disabled={loading}
              className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 cursor-pointer"
            >
              {loading ? "Creating Pod..." : "Start New Sandbox"}
            </button>

            {/* Resume by Sandbox ID */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (resumeId.trim()) startSandbox(resumeId.trim());
              }}
              className="pt-4 border-t border-zinc-800 flex gap-2"
            >
              <input
                type="text"
                value={resumeId}
                onChange={(e) => setResumeId(e.target.value)}
                placeholder="Paste Sandbox ID to resume from S3..."
                className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-mono text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={loading || !resumeId.trim()}
                className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 cursor-pointer"
              >
                Resume
              </button>
            </form>

            {history.length > 0 && (
              <div className="text-left space-y-1.5 pt-2">
                <div className="text-xs text-zinc-500">Recent Sandboxes (S3):</div>
                <div className="flex flex-col gap-1">
                  {history.map((id) => (
                    <button
                      key={id}
                      onClick={() => startSandbox(id)}
                      disabled={loading}
                      className="rounded border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-left font-mono text-xs text-zinc-300 hover:border-zinc-600 hover:bg-zinc-900 cursor-pointer"
                    >
                      {id}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </main>
      ) : (
        <main className="grid flex-1 grid-cols-1 lg:grid-cols-2 overflow-hidden">
          {/* Left: Terminal */}
          <section className="flex flex-col border-r border-zinc-800 overflow-hidden">
            <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-400">
              <span>Terminal ({sandbox.urls.agentUrl})</span>
              <span className="font-mono">/workspace</span>
            </div>
            <div className="flex-1 overflow-hidden">
              <TerminalComponent
                agentUrl={sandbox.urls.agentUrl}
                agentToken={sandbox.agentToken}
                onStatusChange={handleStatusChange}
              />
            </div>
          </section>

          {/* Right: Live Vite Preview */}
          <section className="flex flex-col overflow-hidden bg-white">
            <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400">
              <span>Preview ({sandbox.urls.previewUrl})</span>
              {!previewReady && (
                <span className="text-amber-300">{podPhase || "Waiting for Vite..."}</span>
              )}
            </div>
            {previewReady ? (
              <iframe
                key={iframeKey}
                src={sandbox.urls.previewUrl}
                title="Sandbox Preview"
                className="h-full w-full flex-1 border-0 bg-white"
              />
            ) : (
              <div className="flex flex-1 items-center justify-center bg-zinc-950 text-sm text-zinc-400">
                Initializing sandbox pod &amp; installing dependencies...
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}

export default App;
