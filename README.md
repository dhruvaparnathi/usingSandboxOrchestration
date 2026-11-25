# Kubernetes Sandbox Orchestration

An on-demand cloud React/Vite sandbox platform built on **Kubernetes**, **Node.js**, **Socket.IO + `node-pty`**, **React + `xterm.js`**, and **AWS S3**. Each user session spins up an isolated Kubernetes Pod with a live Vite HMR preview, an interactive WebSocket PTY terminal, and real-time S3 workspace persistence.

**Repository:** https://github.com/dhruvaparnathi/usingSandboxOrchestration.git

---

## Architecture

```mermaid
flowchart LR
    U[Browser / Client] -->|"/api/sandbox/*"| ING_O[Ingress: orchestrator-ingress]
    ING_O --> ORCH[Orchestrator API :3000]
    ORCH -->|"K8s API (create / patch / delete)"| POD

    U -->|"http://{id}.preview.localhost"| ING_S[Ingress: sandbox-ingress-{id}]
    U -->|"ws://{id}.agent.localhost (AGENT_TOKEN)"| ING_S
    ING_S -->|":5173"| VITE
    ING_S -->|":3000"| AGENT

    subgraph POD["Pod: sandbox-pod-{id} (automountServiceAccountToken: false)"]
        INIT["Init: sync-init (seed.js)"] -.->|"seeds & npm install"| VOL[(emptyDir: /workspace)]
        VITE["sandbox-container (Vite :5173)"] --> VOL
        AGENT["sandbox-agent (node-pty :3000)"] --> VOL
        SYNC["sync-sidecar (chokidar watch.js)"] --> VOL
    end

    INIT <-->|"restore / seed template"| S3[(AWS S3)]
    SYNC -->|"upload / delete"| S3
```

---

## What I Built

### 1. Kubernetes Orchestrator API (`sandbox/`)
- **Dynamic Pod, Service & Ingress provisioning** via `@kubernetes/client-node` (`POST /api/sandbox/start`, `DELETE /api/sandbox/:sandboxId`).
- **S3 Session Resume:** Accepts an optional `{ sandboxId }` on `POST /start` to restore a previously stopped workspace from S3 into a fresh Pod.
- **Readiness & Heartbeat APIs:** `GET /api/sandbox/:sandboxId/status` reports container readiness; `POST /api/sandbox/:sandboxId/heartbeat` patches the Pod's `sandbox/last-active` annotation.
- **Rollback & Idempotent Cleanup:** Automatically tears down partial resources if provisioning fails and safely ignores `404` during cleanup.
- **Multi-Replica Idle TTL Reaper:** Background interval checks Pod `sandbox/last-active` annotations across replicas and deletes Pods, Services, and Ingresses after `SANDBOX_IDLE_TTL_MS` (default 30 minutes).

### 2. Multi-Container Sandbox Pod (`sandbox-agents/` & `template/`)
- **`sync-init` (`seed.js`):** InitContainer that checks AWS S3 for `${SANDBOX_ID}/`; restores existing files or seeds from `/template`, runs `npm install` in `/workspace`, and exits before main containers boot.
- **`sandbox-container` (`template/`):** React 19 + Vite + Tailwind CSS v4 dev server bound to `0.0.0.0:5173` with `workingDir: /workspace` and HTTP readiness probe.
- **`sandbox-agent` (`comm-agent/`):** Express + Socket.IO + `node-pty-prebuilt-multiarch` on `:3000` spawning an interactive shell in `/workspace`, supporting `pty-resize` and per-sandbox `AGENT_TOKEN` WebSocket authentication.
- **`sync-sidecar` (`watch.js`):** `chokidar` watcher syncing file `add`, `change`, and `unlink` events to AWS S3 (`node_modules`, `.git`, `dist` excluded).

### 3. Security & Isolation (`k8s/rbac.yaml`, `pod.js`, `comm-agent/`)
- **Credential Blast-Radius Split:** AWS credentials (`aws-credentials` Secret) are mounted **only** into `sync-init` and `sync-sidecar` — never into the user-accessible `sandbox-agent` container.
- **Kubernetes API Isolation:** Created a dedicated `sandbox-orchestrator` `ServiceAccount` for the orchestrator Deployment and set `automountServiceAccountToken: false` on every sandbox Pod so user shells cannot access the cluster API.
- **WebSocket Token Guard:** Orchestrator generates an ephemeral `AGENT_TOKEN` per Pod; `comm-agent` validates it during Socket.IO handshake and deletes it from `process.env` at startup.

### 4. Frontend Control Plane (`frontend/`)
- React + Vite + Tailwind CSS UI served behind `orchestrator-ingress` at `http://localhost/`.
- Start new sandboxes or resume recent S3 `sandboxId`s (`localStorage` history).
- Split-pane layout with **`@xterm/xterm`** (fit/resize sync + `Ctrl+C`/`Ctrl+V`/`Ctrl+Shift+V` clipboard support) and live Vite preview `<iframe>` with status polling and 60s heartbeats.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/sandbox/health` | Orchestrator health check |
| `POST` | `/api/sandbox/start` | Create new sandbox (or pass `{ "sandboxId": "..." }` to resume from S3) |
| `GET` | `/api/sandbox/:sandboxId/status` | Pod phase, init status, and container readiness |
| `POST` | `/api/sandbox/:sandboxId/heartbeat` | Refresh `sandbox/last-active` annotation to extend idle TTL |
| `DELETE` | `/api/sandbox/:sandboxId` | Delete Pod, Service, and Ingress |

---

## Project Structure

```text
orchestration/
├── frontend/                  # React + xterm.js orchestrator UI
├── sandbox/                   # Express Kubernetes orchestrator API
│   ├── server.js              # HTTP server + idle TTL reaper
│   └── src/
│       ├── app.js
│       ├── kubernetes/        # K8s client, Pod/Service/Ingress lifecycle
│       ├── routes/            # /api/sandbox routes
│       └── utils/constant.js
├── sandbox-agents/
│   ├── comm-agent/            # WebSocket <-> node-pty terminal bridge (:3000)
│   └── sync-agent/            # seed.js (init) & watch.js (S3 sidecar)
├── template/                  # Default React + Vite + Tailwind starter app
├── k8s/                       # Deployment, Service, Ingress, and RBAC manifests
└── skaffold.yml               # Local build & deploy configuration
```

---

## Local Setup (Docker Desktop Kubernetes + Skaffold)

### Prerequisites
- **Docker Desktop** with **Kubernetes** enabled
- **`kubectl`**, **`skaffold`** (v2+), and **Node.js** (v20+)
- **AWS Account** with an S3 bucket and scoped IAM user (`s3:ListBucket`, `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`)

### 1. Install Nginx Ingress Controller
```powershell
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.10.1/deploy/static/provider/cloud/deploy.yaml
kubectl wait --namespace ingress-nginx --for=condition=ready pod --selector=app.kubernetes.io/component=controller --timeout=120s
```

### 2. Configure S3 Bucket & Kubernetes Secret
1. Set your bucket name in `k8s/sandbox-deployment.yml` (`S3_BUCKET`) and match `AWS_DEFAULT_REGION` in `sandbox/src/kubernetes/pod.js`.
2. Create the AWS secret:
```powershell
kubectl create secret generic aws-credentials `
  --from-literal=AWS_ACCESS_KEY_ID=YOUR_ACCESS_KEY_ID `
  --from-literal=AWS_SECRET_ACCESS_KEY=YOUR_SECRET_ACCESS_KEY `
  -n default
```

### 3. Build & Deploy
```powershell
skaffold run
```
On Docker Desktop, dynamically spawned sandbox Pods pull `:latest` from the node's containerd store rather than Skaffold's manifest-rewritten tags. Whenever you rebuild `template`, `sandbox-agent`, or `sandbox-sync`, import the updated `:latest` images into `desktop-control-plane`:
```powershell
cmd /c "docker save sandbox-sync:latest sandbox-agent:latest template:latest | docker exec -i desktop-control-plane ctr -n k8s.io images import -"
```

### 4. Open the App
Visit **`http://localhost/`**, click **Start New Sandbox**, wait for `sync-init` to seed S3 and install dependencies (~45s), and start coding in the live terminal.

---

## What I Learned

1. **InitContainers solve `emptyDir` startup races cleanly:** Mounting an `emptyDir` wipes pre-existing container files at that path. Running `seed.js` as an `initContainer` guarantees `/workspace` and `node_modules` are ready before Vite and `comm-agent` start.
2. **Working directory alignment across containers matters:** All containers sharing a volume (`sync-init`, Vite `workingDir`, `comm-agent` PTY `cwd`, and `sync-sidecar`) must agree on `/workspace`, otherwise Vite serves stale image files instead of live volume edits.
3. **Never give user-facing Pods default RBAC permissions:** Kubernetes mounts the `default` ServiceAccount token automatically unless `automountServiceAccountToken: false` is set. Moving orchestrator permissions to a dedicated `ServiceAccount` (`sandbox-orchestrator`) and disabling token mounting on sandbox Pods prevents shell users from calling the cluster API.
4. **Separate credentials by container boundary:** Placing AWS keys only in `sync-init` / `sync-sidecar` prevents terminal users in `comm-agent` from reading `env` to steal S3 credentials.
5. **Skaffold only auto-loads images referenced in static manifests:** Images created dynamically at runtime by code (`pod.js`) aren't rewritten by Skaffold's tagger in `rawYaml`, so local containerd caches can serve stale `:latest` images unless explicitly imported.
6. **Stateless multi-replica state belongs in Kubernetes:** With `replicas: 2` on the orchestrator, an in-memory TTL map breaks across pods. Storing `sandbox/last-active` as a Pod annotation lets any orchestrator replica handle heartbeats and idle cleanup reliably.
7. **Terminal UX in the browser needs explicit wiring:** `xterm.js` intercepts `Ctrl+C`/`Ctrl+V` as control characters (`^C` / `^V`) unless handled via `attachCustomKeyEventHandler`, and `FitAddon` dimensions must be forwarded to `node-pty` via `pty-resize` to avoid line-wrapping bugs.
