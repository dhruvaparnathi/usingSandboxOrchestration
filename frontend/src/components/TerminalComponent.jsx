import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { io } from "socket.io-client";

export default function TerminalComponent({ agentUrl, agentToken, onStatusChange }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!agentUrl || !containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', monospace",
      theme: {
        background: "#09090b",
        foreground: "#e4e4e7",
        cursor: "#22c55e",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        if (term.hasSelection() || e.shiftKey) {
          navigator.clipboard?.writeText(term.getSelection());
          term.clearSelection();
          return false;
        }
        return true;
      }

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "v") {
        return false;
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        navigator.clipboard?.readText().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }

      return true;
    });

    term.writeln("\x1b[33mConnecting to sandbox terminal (waiting for pod init)...\x1b[0m");
    onStatusChange?.("booting");

    const socket = io(agentUrl, {
      transports: ["websocket"],
      auth: agentToken ? { token: agentToken } : undefined,
      reconnection: true,
      reconnectionAttempts: 60,
      reconnectionDelay: 2000,
    });

    const syncResize = () => {
      fitAddon.fit();
      if (socket.connected) {
        socket.emit("pty-resize", { cols: term.cols, rows: term.rows });
      }
    };

    socket.on("connect", () => {
      onStatusChange?.("ready");
      term.writeln("\x1b[32mConnected to sandbox shell.\x1b[0m\r\n");
      syncResize();
      socket.emit("pty-input", "\n");
    });

    socket.on("pty-output", (data) => {
      term.write(data);
    });

    socket.on("disconnect", (reason) => {
      onStatusChange?.("disconnected");
      term.writeln(`\r\n\x1b[31m[Disconnected: ${reason}]\x1b[0m`);
    });

    const inputDisposable = term.onData((data) => {
      if (socket.connected) {
        socket.emit("pty-input", data);
      }
    });

    const resizeObserver = new ResizeObserver(syncResize);
    resizeObserver.observe(containerRef.current);
    window.addEventListener("resize", syncResize);

    return () => {
      window.removeEventListener("resize", syncResize);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      socket.disconnect();
      term.dispose();
    };
  }, [agentUrl, agentToken, onStatusChange]);

  return <div ref={containerRef} className="h-full w-full p-2 bg-zinc-950" />;
}
