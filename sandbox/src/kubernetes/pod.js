import * as k8s from "@kubernetes/client-node";
import { k8sApi } from "./config.js";
import { NAMESPACE } from "../utils/constant.js";

const isNotFound = (err) => err?.code === 404 || err?.statusCode === 404;

export const createPod = async (sandboxId, s3Bucket, agentToken) => {
    const podManifest = {
        metadata: {
            name: `sandbox-pod-${sandboxId}`,
            namespace: NAMESPACE,
            labels: {
                app: `sandbox-pod-${sandboxId}`,
                "managed-by": "sandbox-orchestrator",
                "sandbox-id": sandboxId,
            },
            annotations: {
                "sandbox/last-active": String(Date.now()),
            },
        },
        spec: {
            automountServiceAccountToken: false,
            initContainers: [
                {
                    name: `sync-init-${sandboxId}`,
                    image: "sandbox-sync:latest",
                    imagePullPolicy: "IfNotPresent",
                    command: ["node", "seed.js"],
                    volumeMounts: [{ name: "code-volume", mountPath: "/workspace" }],
                    env: [
                        { name: "SANDBOX_ID", value: sandboxId },
                        { name: "S3_BUCKET", value: s3Bucket },
                        { name: "AWS_DEFAULT_REGION", value: "ap-southeast-2" },
                        {
                            name: "AWS_ACCESS_KEY_ID",
                            valueFrom: { secretKeyRef: { name: "aws-credentials", key: "AWS_ACCESS_KEY_ID" } }
                        },
                        {
                            name: "AWS_SECRET_ACCESS_KEY",
                            valueFrom: { secretKeyRef: { name: "aws-credentials", key: "AWS_SECRET_ACCESS_KEY" } }
                        },
                    ],
                    resources: {
                        limits: { cpu: "200m", memory: "512Mi" },
                        requests: { cpu: "100m", memory: "128Mi" },
                    },
                }
            ],
            containers: [
                {
                    name: `sandbox-container-${sandboxId}`,
                    image: "template:latest",
                    imagePullPolicy: "IfNotPresent",
                    workingDir: "/workspace",
                    command: ["npm", "run", "dev"],
                    ports: [{ containerPort: 5173 }],
                    volumeMounts: [{ name: "code-volume", mountPath: "/workspace" }],
                    readinessProbe: {
                        httpGet: { path: "/", port: 5173 },
                        initialDelaySeconds: 2,
                        periodSeconds: 2,
                    },
                    resources: {
                        limits: { cpu: "500m", memory: "512Mi" },
                        requests: { cpu: "250m", memory: "256Mi" },
                    },
                },
                {
                    name: `sandbox-agent-${sandboxId}`,
                    image: "sandbox-agent:latest",
                    imagePullPolicy: "IfNotPresent",
                    command: ["node", "server.js"],
                    ports: [{ containerPort: 3000 }],
                    volumeMounts: [{ name: "code-volume", mountPath: "/workspace" }],
                    env: agentToken ? [{ name: "AGENT_TOKEN", value: agentToken }] : [],
                    readinessProbe: {
                        httpGet: { path: "/ping", port: 3000 },
                        initialDelaySeconds: 2,
                        periodSeconds: 2,
                    },
                    resources: {
                        limits: { cpu: "500m", memory: "512Mi" },
                        requests: { cpu: "250m", memory: "256Mi" },
                    },
                },
                {
                    name: `sync-sidecar-${sandboxId}`,
                    image: "sandbox-sync:latest",
                    imagePullPolicy: "IfNotPresent",
                    command: ["node", "watch.js"],
                    volumeMounts: [{ name: "code-volume", mountPath: "/workspace" }],
                    env: [
                        { name: "SANDBOX_ID", value: sandboxId },
                        { name: "S3_BUCKET", value: s3Bucket },
                        { name: "AWS_DEFAULT_REGION", value: "ap-southeast-2" },
                        {
                            name: "AWS_ACCESS_KEY_ID",
                            valueFrom: { secretKeyRef: { name: "aws-credentials", key: "AWS_ACCESS_KEY_ID" } }
                        },
                        {
                            name: "AWS_SECRET_ACCESS_KEY",
                            valueFrom: { secretKeyRef: { name: "aws-credentials", key: "AWS_SECRET_ACCESS_KEY" } }
                        },
                    ],
                    resources: {
                        limits: { cpu: "100m", memory: "128Mi" },
                        requests: { cpu: "50m", memory: "64Mi" },
                    },
                },
            ],
            volumes: [
                {
                    name: "code-volume",
                    emptyDir: {}
                }
            ]
        }
    };

    try {
        const response = await k8sApi.createNamespacedPod({
            namespace: NAMESPACE,
            body: podManifest,
        });
        console.log("Pod created:", response.metadata.name);
        return response;
    } catch (err) {
        console.error("Error creating pod:", err);
        throw err;
    }
};

export const getPodStatus = async (sandboxId) => {
    try {
        const pod = await k8sApi.readNamespacedPod({
            name: `sandbox-pod-${sandboxId}`,
            namespace: NAMESPACE,
        });
        const initStatuses = pod.status?.initContainerStatuses || [];
        const containerStatuses = pod.status?.containerStatuses || [];
        const initReady = initStatuses.every((c) => c.ready);
        const ready =
            pod.status?.phase === "Running" &&
            containerStatuses.length === 3 &&
            containerStatuses.every((c) => c.ready);

        return {
            phase: pod.status?.phase || "Pending",
            initReady,
            ready,
            containers: containerStatuses.map((c) => ({
                name: c.name,
                ready: c.ready,
                state: Object.keys(c.state || {})[0] || "unknown",
            })),
        };
    } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
    }
};

export const touchPodHeartbeat = async (sandboxId) => {
    try {
        await k8sApi.patchNamespacedPod(
            {
                name: `sandbox-pod-${sandboxId}`,
                namespace: NAMESPACE,
                body: {
                    metadata: {
                        annotations: {
                            "sandbox/last-active": String(Date.now()),
                        },
                    },
                },
            },
            k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.StrategicMergePatch)
        );
        return true;
    } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
    }
};

export const listManagedPods = async () => {
    const res = await k8sApi.listNamespacedPod({
        namespace: NAMESPACE,
        labelSelector: "managed-by=sandbox-orchestrator",
    });
    return res.items || [];
};

export const deletePod = async (sandboxId) => {
    try {
        await k8sApi.deleteNamespacedPod({
            name: `sandbox-pod-${sandboxId}`,
            namespace: NAMESPACE,
        });
    } catch (err) {
        if (!isNotFound(err)) throw err;
    }
};