import { Router } from "express";
import crypto from "crypto";
import { v7 as uuid } from "uuid";
import {
    createPod,
    deletePod,
    getPodStatus,
    listManagedPods,
    touchPodHeartbeat,
} from "../kubernetes/pod.js";
import {
    createService,
    createSandboxIngress,
    deleteService,
    deleteIngress,
} from "../kubernetes/service.js";

const router = Router();
const SANDBOX_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const cleanupSandbox = async (sandboxId) => {
    await Promise.all([
        deletePod(sandboxId),
        deleteService(sandboxId),
        deleteIngress(sandboxId),
    ]);
};

router.get("/health", (req, res) => {
    res.json({ message: "Sandbox API is healthy" });
});

router.get("/:sandboxId/status", async (req, res) => {
    const { sandboxId } = req.params;
    if (!SANDBOX_ID_RE.test(sandboxId)) {
        return res.status(400).json({ error: "Invalid sandboxId format" });
    }
    try {
        const status = await getPodStatus(sandboxId);
        if (!status) {
            return res.status(404).json({ error: `Sandbox ${sandboxId} not found` });
        }
        res.json({ sandboxId, ...status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/:sandboxId/heartbeat", async (req, res) => {
    const { sandboxId } = req.params;
    if (!SANDBOX_ID_RE.test(sandboxId)) {
        return res.status(400).json({ error: "Invalid sandboxId format" });
    }
    try {
        const updated = await touchPodHeartbeat(sandboxId);
        if (!updated) {
            return res.status(404).json({ error: `Sandbox ${sandboxId} not found` });
        }
        res.json({ ok: true, sandboxId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete("/:sandboxId", async (req, res) => {
    const { sandboxId } = req.params;
    if (!SANDBOX_ID_RE.test(sandboxId)) {
        return res.status(400).json({ error: "Invalid sandboxId format" });
    }
    try {
        await cleanupSandbox(sandboxId);
        res.json({ message: `Sandbox ${sandboxId} deleted` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/start", async (req, res) => {
    const requestedId = req.body?.sandboxId?.trim();
    if (requestedId && !SANDBOX_ID_RE.test(requestedId)) {
        return res.status(400).json({ error: "Invalid sandboxId format (lowercase alphanumeric and hyphens only)" });
    }

    const sandboxId = requestedId || uuid();
    const s3Bucket = process.env.S3_BUCKET;

    if (!s3Bucket) {
        return res.status(500).json({ error: "S3_BUCKET env var is not set" });
    }

    const agentToken = crypto.randomBytes(24).toString("hex");

    try {
        const existing = await getPodStatus(sandboxId);
        if (existing) {
            return res.status(409).json({ error: `Sandbox ${sandboxId} is already active` });
        }

        const podResult = await createPod(sandboxId, s3Bucket, agentToken);
        const serviceResult = await createService(sandboxId);
        const urls = await createSandboxIngress(sandboxId);

        res.json({
            sandboxId,
            resumed: Boolean(requestedId),
            pod: podResult?.metadata?.name,
            service: serviceResult?.response?.metadata?.name,
            urls,
            agentToken,
        });
    } catch (err) {
        console.error("Error starting sandbox, rolling back:", err);
        await cleanupSandbox(sandboxId).catch((cleanupErr) =>
            console.error("Rollback cleanup error:", cleanupErr)
        );
        res.status(500).json({ error: err.message });
    }
});

export const startIdleReaper = () => {
    const ttlMs = Number(process.env.SANDBOX_IDLE_TTL_MS || 30 * 60 * 1000);
    const intervalMs = 60 * 1000;

    const timer = setInterval(async () => {
        try {
            const pods = await listManagedPods();
            const now = Date.now();
            for (const pod of pods) {
                const sandboxId = pod.metadata?.labels?.["sandbox-id"];
                if (!sandboxId) continue;

                const lastActiveStr = pod.metadata?.annotations?.["sandbox/last-active"];
                const createdAt = pod.metadata?.creationTimestamp
                    ? new Date(pod.metadata.creationTimestamp).getTime()
                    : now;
                const lastActive = lastActiveStr ? Number(lastActiveStr) : createdAt;

                if (Number.isFinite(lastActive) && now - lastActive > ttlMs) {
                    console.log(`Reaping idle sandbox ${sandboxId} (idle ${Math.round((now - lastActive) / 1000)}s)`);
                    await cleanupSandbox(sandboxId);
                }
            }
        } catch (err) {
            console.error("Idle reaper error:", err.message);
        }
    }, intervalMs);

    timer.unref();
    return timer;
};

export default router;
