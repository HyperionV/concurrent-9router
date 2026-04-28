"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Modal } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { getModelsByProviderId } from "@/shared/constants/models";
import {
  AI_PROVIDERS,
  MEDIA_PROVIDER_KINDS,
  getProviderAlias,
} from "@/shared/constants/providers";

function Row({ label, children }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-xs text-text-muted">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function ModelCard({
  model,
  selected,
  fullModel,
  isCustom,
  onSelect,
  onDelete,
}) {
  return (
    <div
      className={`group flex min-w-[190px] flex-1 items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
        selected
          ? "border-primary/50 bg-primary/10 text-text-main"
          : "border-border hover:border-primary/40 hover:bg-sidebar/60"
      }`}
    >
      <span className="material-symbols-outlined mt-0.5 text-base text-primary">
        {selected ? "radio_button_checked" : "image"}
      </span>
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block truncate text-sm font-medium">
          {model.name || model.id}
        </span>
        <code className="mt-1 block truncate rounded bg-sidebar px-1.5 py-0.5 font-mono text-[11px] text-text-muted">
          {fullModel}
        </code>
        {isCustom && (
          <span className="mt-1 inline-flex rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
            Custom
          </span>
        )}
      </button>
      {isCustom && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          className="rounded p-0.5 text-text-muted opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100"
          title="Remove custom model"
        >
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      )}
    </div>
  );
}

function AddImageModelModal({ isOpen, onClose, onSave }) {
  const [modelId, setModelId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) setModelId("");
  }, [isOpen]);

  async function handleSave() {
    const trimmed = modelId.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await onSave(trimmed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Codex Image Model">
      <div className="flex flex-col gap-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium">Model ID</label>
          <input
            type="text"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleSave();
            }}
            placeholder="e.g. gpt-5.5-image"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
            autoFocus
          />
          <p className="mt-1 text-xs text-text-muted">
            Sent as{" "}
            <code className="rounded bg-sidebar px-1 font-mono">
              cx/{modelId.trim() || "model-id"}
            </code>
          </p>
        </div>
        <div className="flex gap-2 pt-1">
          <Button onClick={onClose} variant="ghost" fullWidth size="sm">
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            fullWidth
            size="sm"
            disabled={!modelId.trim() || saving}
          >
            {saving ? "Adding..." : "Add Model"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const IMAGE_CONFIG = {
  inputLabel: "Prompt",
  inputPlaceholder: "A cute cat wearing a hat",
  defaultInput: "A cute cat wearing a hat",
  defaultResponse: `{
  "data": [
    { "url": "...", "b64_json": "..." }
  ]
}`,
  extraFields: [
    {
      key: "size",
      label: "Size",
      default: "auto",
      options: [
        "auto",
        "1024x1024",
        "1024x1536",
        "1536x1024",
        "1024x1792",
        "1792x1024",
      ],
    },
    {
      key: "quality",
      label: "Quality",
      default: "auto",
      options: ["auto", "low", "medium", "high", "standard", "hd"],
    },
    {
      key: "background",
      label: "Background",
      default: "auto",
      options: ["auto", "transparent", "opaque"],
    },
    {
      key: "image_detail",
      label: "Image Detail",
      default: "high",
      options: ["auto", "low", "high", "original"],
    },
    {
      key: "output_format",
      label: "Codec",
      default: "png",
      options: ["png", "jpeg", "webp"],
    },
  ],
};

const IMAGE_ENDPOINTS = {
  generations: {
    label: "Generate",
    method: "POST",
    path: "/v1/images/generations",
    bodyFormat: "json",
    description:
      "JSON prompt request with optional reference image URL/base64.",
  },
  edits: {
    label: "Edit",
    method: "POST",
    path: "/v1/images/edits",
    bodyFormat: "multipart",
    description: "Multipart upload request for one or more reference images.",
  },
};

function maskB64(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(maskB64);
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [
      key,
      key === "b64_json" && typeof value === "string" && value.length > 100
        ? `<${value.length} chars base64>`
        : maskB64(value),
    ]),
  );
}

export default function CodexImageProviderPage() {
  const provider = AI_PROVIDERS.codex;
  const kindConfig = MEDIA_PROVIDER_KINDS.find((kind) => kind.id === "image");
  const providerAlias = getProviderAlias("codex");
  const imageModels = getModelsByProviderId("codex").filter(
    (model) => model.type === "image",
  );
  const builtInModelIds = useMemo(
    () => new Set(imageModels.map((model) => model.id)),
    [imageModels],
  );
  const [modelAliases, setModelAliases] = useState({});
  const customImageModels = useMemo(
    () =>
      Object.entries(modelAliases)
        .filter(([alias, fullModel]) => {
          const prefix = `${providerAlias}/`;
          if (!fullModel.startsWith(prefix)) return false;
          const modelId = fullModel.slice(prefix.length);
          return alias === modelId && !builtInModelIds.has(modelId);
        })
        .map(([alias, fullModel]) => ({
          id: fullModel.slice(`${providerAlias}/`.length),
          alias,
          fullModel,
          type: "image",
          capabilities: ["text2img", "edit"],
          params: [
            "size",
            "quality",
            "background",
            "image_detail",
            "output_format",
          ],
          isCustom: true,
        })),
    [builtInModelIds, modelAliases, providerAlias],
  );
  const availableImageModels = useMemo(
    () => [...imageModels, ...customImageModels],
    [customImageModels, imageModels],
  );
  const [selectedModel, setSelectedModel] = useState(imageModels[0]?.id ?? "");
  const selectedModelObj = availableImageModels.find(
    (model) => model.id === selectedModel,
  );
  const [endpointMode, setEndpointMode] = useState("generations");
  const [input, setInput] = useState(IMAGE_CONFIG.defaultInput);
  const [refImage, setRefImage] = useState("");
  const [uploadedImages, setUploadedImages] = useState([]);
  const [extraValues, setExtraValues] = useState(() =>
    IMAGE_CONFIG.extraFields.reduce((acc, field) => {
      acc[field.key] = field.default;
      return acc;
    }, {}),
  );
  const [apiKey, setApiKey] = useState("");
  const [useTunnel, setUseTunnel] = useState(false);
  const [localEndpoint, setLocalEndpoint] = useState("");
  const [tunnelEndpoint, setTunnelEndpoint] = useState("");
  const [connections, setConnections] = useState([]);
  const [pinnedConnectionId, setPinnedConnectionId] = useState("");
  const [imageOutputFormat, setImageOutputFormat] = useState("json");
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState(null);
  const [partialImage, setPartialImage] = useState(null);
  const [binaryImageUrl, setBinaryImageUrl] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [showAddModel, setShowAddModel] = useState(false);
  const { copied: copiedCurl, copy: copyCurl } = useCopyToClipboard();
  const { copied: copiedRes, copy: copyRes } = useCopyToClipboard();

  const fetchAliases = useCallback(async () => {
    try {
      const response = await fetch("/api/models/alias", { cache: "no-store" });
      const data = await response.json();
      if (response.ok) setModelAliases(data.aliases || {});
    } catch (error) {
      console.log("Error fetching model aliases:", error);
    }
  }, []);

  useEffect(() => {
    setLocalEndpoint(window.location.origin);
    fetch("/api/keys")
      .then((response) => response.json())
      .then((data) => {
        setApiKey(
          (data.keys || []).find((key) => key.isActive !== false)?.key || "",
        );
      })
      .catch(() => {});
    fetch("/api/tunnel/status")
      .then((response) => response.json())
      .then((data) => {
        if (data.publicUrl) setTunnelEndpoint(data.publicUrl);
      })
      .catch(() => {});
    fetch("/api/providers/client")
      .then((response) => response.json())
      .then((data) => {
        const codexConnections = (data.connections || []).filter(
          (connection) =>
            connection.provider === "codex" && connection.isActive !== false,
        );
        setConnections(codexConnections);
      })
      .catch(() => {});
    fetchAliases();
  }, [fetchAliases]);

  useEffect(() => {
    if (!selectedModel && availableImageModels.length > 0) {
      setSelectedModel(availableImageModels[0].id);
      return;
    }
    if (
      selectedModel &&
      !availableImageModels.some((model) => model.id === selectedModel)
    ) {
      setSelectedModel(availableImageModels[0]?.id ?? "");
    }
  }, [availableImageModels, selectedModel]);

  async function handleAddCustomModel(modelId) {
    const fullModel = `${providerAlias}/${modelId}`;
    const response = await fetch("/api/models/alias", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: fullModel, alias: modelId }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setError(data.error || "Failed to add model");
      return;
    }
    await fetchAliases();
    setSelectedModel(modelId);
    setShowAddModel(false);
  }

  async function handleDeleteCustomModel(alias) {
    const response = await fetch(
      `/api/models/alias?alias=${encodeURIComponent(alias)}`,
      { method: "DELETE" },
    );
    if (response.ok) {
      await fetchAliases();
    }
  }

  const requestBody = useMemo(() => {
    const extraBody = Object.entries(extraValues).reduce(
      (acc, [key, value]) => {
        if (value === "" || value === null || value === undefined) return acc;
        acc[key] = value;
        return acc;
      },
      {},
    );
    const body = {
      model: selectedModel ? `${providerAlias}/${selectedModel}` : "",
      prompt: input,
      ...extraBody,
    };
    if (selectedModelObj?.capabilities?.includes("edit") && refImage.trim()) {
      body.image = refImage.trim();
    }
    return body;
  }, [
    extraValues,
    input,
    providerAlias,
    refImage,
    selectedModel,
    selectedModelObj,
  ]);

  const selectedEndpoint = IMAGE_ENDPOINTS[endpointMode];
  const endpoint = useTunnel ? tunnelEndpoint : localEndpoint;
  const wantBinary = imageOutputFormat === "binary";
  const useStreaming = !wantBinary && endpointMode === "generations";
  const apiPathWithQuery = `${selectedEndpoint.path}${wantBinary ? "?response_format=binary" : ""}`;
  const canRun =
    !running &&
    Boolean(input.trim()) &&
    Boolean(requestBody.model) &&
    (endpointMode !== "edits" || uploadedImages.length > 0);
  const curlSnippet = useMemo(() => {
    if (selectedEndpoint.bodyFormat === "multipart") {
      const fileFlags = uploadedImages.length
        ? uploadedImages
            .map((file) => `  -F "image[]=@${file.name}"`)
            .join(" \\\n")
        : `  -F "image[]=@reference.png"`;
      const fields = Object.entries(requestBody)
        .filter(([key, value]) => {
          if (key === "image" || key === "images") return false;
          return value !== "" && value !== null && value !== undefined;
        })
        .map(([key, value]) => `  -F "${key}=${String(value)}"`)
        .join(" \\\n");
      return `curl -X ${selectedEndpoint.method} ${endpoint}${apiPathWithQuery} \\
  -H "Authorization: Bearer ${apiKey || "YOUR_KEY"}"${pinnedConnectionId ? ` \\\n  -H "x-connection-id: ${pinnedConnectionId}"` : ""} \\
${fields} \\
${fileFlags}${wantBinary ? " \\\n  --output image.png" : ""}`;
    }

    const headersPreview = `-H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${apiKey || "YOUR_KEY"}"${pinnedConnectionId ? ` \\\n  -H "x-connection-id: ${pinnedConnectionId}"` : ""}${useStreaming ? ` \\\n  -H "Accept: text/event-stream"` : ""}`;
    return `curl -X ${selectedEndpoint.method} ${endpoint}${apiPathWithQuery} \\
  ${headersPreview.replace(/\\\n  /g, "\\\n  ")} \\
  -d '${JSON.stringify(requestBody)}'${wantBinary ? " \\\n  --output image.png" : ""}`;
  }, [
    apiKey,
    apiPathWithQuery,
    endpoint,
    pinnedConnectionId,
    requestBody,
    selectedEndpoint.bodyFormat,
    selectedEndpoint.method,
    uploadedImages,
    useStreaming,
    wantBinary,
  ]);

  const uploadedImageSummary = useMemo(
    () =>
      uploadedImages.map((file) => ({
        name: file.name,
        type: file.type || "application/octet-stream",
        sizeKb: Math.max(1, Math.round(file.size / 1024)),
      })),
    [uploadedImages],
  );

  function handleUploadChange(event) {
    setUploadedImages(Array.from(event.target.files || []));
  }

  function buildEditFormData() {
    const formData = new FormData();
    Object.entries(requestBody).forEach(([key, value]) => {
      if (key === "image" || key === "images") return;
      if (value === "" || value === null || value === undefined) return;
      formData.append(key, String(value));
    });
    uploadedImages.forEach((file) => formData.append("image[]", file));
    return formData;
  }

  function buildRequestInit() {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (pinnedConnectionId) headers["x-connection-id"] = pinnedConnectionId;

    if (selectedEndpoint.bodyFormat === "multipart") {
      return {
        method: selectedEndpoint.method,
        headers,
        body: buildEditFormData(),
      };
    }

    headers["Content-Type"] = "application/json";
    if (useStreaming) headers.Accept = "text/event-stream";
    return {
      method: selectedEndpoint.method,
      headers,
      body: JSON.stringify(requestBody),
    };
  }

  useEffect(() => {
    if (endpointMode === "edits") setImageOutputFormat("json");
  }, [endpointMode]);

  const requestPreview = useMemo(() => {
    if (selectedEndpoint.bodyFormat !== "multipart") return requestBody;
    return {
      ...Object.fromEntries(
        Object.entries(requestBody).filter(([key, value]) => {
          if (key === "image" || key === "images") return false;
          return value !== "" && value !== null && value !== undefined;
        }),
      ),
      image: uploadedImageSummary,
    };
  }, [requestBody, selectedEndpoint.bodyFormat, uploadedImageSummary]);

  const requestPreviewJson = JSON.stringify(requestPreview, null, 2);

  const runDisabledReason =
    endpointMode === "edits" && uploadedImages.length === 0
      ? "Upload at least one image for edits"
      : "";

  const runButtonTitle = runDisabledReason || undefined;
  const endpointModeOptions = Object.entries(IMAGE_ENDPOINTS);
  const uploadInputId = "codex-image-upload";
  const outputFormatOptions =
    endpointMode === "generations"
      ? [
          ["json", "JSON (Base64)"],
          ["binary", "Binary File"],
        ]
      : [["json", "JSON (Base64)"]];

  async function handleRun() {
    if (!canRun) return;
    setRunning(true);
    setError("");
    setResult(null);
    setProgress(null);
    setPartialImage(null);
    if (binaryImageUrl) {
      try {
        URL.revokeObjectURL(binaryImageUrl);
      } catch {}
      setBinaryImageUrl("");
    }

    const start = Date.now();
    try {
      const response = await fetch(`/api${apiPathWithQuery}`, {
        ...buildRequestInit(),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(
          data?.error?.message || data?.error || `HTTP ${response.status}`,
        );
        return;
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType.startsWith("image/")) {
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        setBinaryImageUrl(objectUrl);
        setResult({
          data: { binary: true, mime: contentType, size: blob.size },
          latencyMs: Date.now() - start,
        });
        return;
      }

      if (contentType.includes("text/event-stream") && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalData = null;
        let streamError = null;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let event = null;
            let dataStr = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:"))
                dataStr += line.slice(5).trim();
            }
            if (!event) continue;
            try {
              const payload = dataStr ? JSON.parse(dataStr) : {};
              if (event === "progress") setProgress(payload);
              else if (event === "partial_image") setPartialImage(payload);
              else if (event === "done") finalData = payload;
              else if (event === "error")
                streamError = payload?.message || "Stream error";
            } catch {}
          }
        }
        if (streamError) {
          setError(streamError);
          return;
        }
        if (finalData)
          setResult({ data: finalData, latencyMs: Date.now() - start });
        return;
      }

      const data = await response.json();
      setResult({ data, latencyMs: Date.now() - start });
    } catch (error) {
      setError(error.message || "Network error");
    } finally {
      setRunning(false);
    }
  }

  const resultJson = result
    ? JSON.stringify(maskB64(result.data), null, 2)
    : "";
  const outputFormat = extraValues.output_format || "png";

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link
          href="/dashboard/media-providers/image"
          className="mb-4 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-primary"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          Text to Image
        </Link>
        <div className="flex items-center gap-4">
          <div
            className="flex size-12 shrink-0 items-center justify-center rounded-lg"
            style={{ backgroundColor: `${provider.color}15` }}
          >
            <ProviderIcon
              src="/providers/codex.png"
              alt={provider.name}
              size={48}
              className="max-h-[48px] max-w-[48px] rounded-lg object-contain"
              fallbackText="CX"
              fallbackColor={provider.color}
            />
          </div>
          <div className="flex-1">
            <h1 className="text-3xl font-semibold tracking-tight">
              {provider.name}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="default" size="sm">
                LLM
              </Badge>
              <Badge variant="primary" size="sm">
                IMAGE
              </Badge>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-700 dark:text-amber-400">
        <span className="material-symbols-outlined mt-0.5 text-[20px]">
          warning
        </span>
        <p className="text-sm">{provider.kindNotice?.image}</p>
      </div>

      <Card>
        <h2 className="mb-4 text-lg font-semibold">Example</h2>
        <div className="flex flex-col gap-2.5">
          <Row label="Model">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                {availableImageModels.map((model) => (
                  <ModelCard
                    key={model.id}
                    model={model}
                    fullModel={`${providerAlias}/${model.id}`}
                    selected={selectedModel === model.id}
                    isCustom={model.isCustom}
                    onSelect={() => setSelectedModel(model.id)}
                    onDelete={() => handleDeleteCustomModel(model.alias)}
                  />
                ))}
                <button
                  type="button"
                  onClick={() => setShowAddModel(true)}
                  className="flex min-h-[64px] min-w-[150px] items-center justify-center gap-1.5 rounded-lg border border-dashed border-black/15 px-3 py-2 text-xs text-text-muted transition-colors hover:border-primary/40 hover:text-primary dark:border-white/15"
                >
                  <span className="material-symbols-outlined text-sm">add</span>
                  Add Model
                </button>
              </div>
            </div>
          </Row>

          <Row label="Endpoint">
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-2 sm:flex-row">
                <select
                  aria-label="Image endpoint"
                  value={endpointMode}
                  onChange={(event) => setEndpointMode(event.target.value)}
                  className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none sm:w-44"
                >
                  {endpointModeOptions.map(([key, config]) => (
                    <option key={key} value={key}>
                      {config.label} ({config.path})
                    </option>
                  ))}
                </select>
                <span className="flex-1 truncate rounded-lg bg-sidebar px-3 py-1.5 font-mono text-sm text-text-main">
                  {endpoint}
                  {selectedEndpoint.path}
                </span>
                {tunnelEndpoint && (
                  <button
                    onClick={() => setUseTunnel((value) => !value)}
                    title={useTunnel ? "Using tunnel" : "Using local"}
                    className={`flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1.5 text-xs transition-colors ${useTunnel ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-text-muted hover:text-primary"}`}
                  >
                    <span className="material-symbols-outlined text-[14px]">
                      wifi_tethering
                    </span>
                    Tunnel
                  </button>
                )}
              </div>
              <p className="text-xs text-text-muted">
                {selectedEndpoint.description}
              </p>
            </div>
          </Row>

          <Row label="API Key">
            <span className="block truncate rounded-lg bg-sidebar px-3 py-1.5 font-mono text-sm text-text-main">
              {apiKey ? (
                `${apiKey.slice(0, 8)}${"*".repeat(Math.min(20, apiKey.length - 8))}`
              ) : (
                <span className="text-text-muted italic">
                  No key configured
                </span>
              )}
            </span>
          </Row>

          {connections.length > 0 && (
            <Row label="Connection">
              <select
                value={pinnedConnectionId}
                onChange={(event) => setPinnedConnectionId(event.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
              >
                <option value="">Auto (by priority)</option>
                {connections.map((connection) => {
                  const plan = connection.providerSpecificData?.chatgptPlanType;
                  const label =
                    connection.email ||
                    connection.name ||
                    connection.id.slice(0, 8);
                  return (
                    <option key={connection.id} value={connection.id}>
                      {label}
                      {plan ? ` [${plan}]` : ""}
                    </option>
                  );
                })}
              </select>
            </Row>
          )}

          <Row label={IMAGE_CONFIG.inputLabel}>
            <div className="relative">
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={IMAGE_CONFIG.inputPlaceholder}
                className="w-full rounded-lg border border-border bg-background px-3 py-1.5 pr-7 text-sm focus:border-primary focus:outline-none"
              />
              {input && (
                <button
                  type="button"
                  onClick={() => setInput("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted transition-colors hover:text-primary"
                >
                  <span className="material-symbols-outlined text-[14px]">
                    close
                  </span>
                </button>
              )}
            </div>
          </Row>

          {endpointMode === "generations" ? (
            <Row label="Ref Image (URL)">
              <div className="flex flex-col gap-2">
                <div className="relative">
                  <input
                    value={refImage}
                    onChange={(event) => setRefImage(event.target.value)}
                    placeholder="https://example.com/source.png"
                    className="w-full rounded-lg border border-border bg-background px-3 py-1.5 pr-7 text-sm focus:border-primary focus:outline-none"
                  />
                  {refImage && (
                    <button
                      type="button"
                      onClick={() => setRefImage("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted transition-colors hover:text-primary"
                    >
                      <span className="material-symbols-outlined text-[14px]">
                        close
                      </span>
                    </button>
                  )}
                </div>
                {refImage.trim() && (
                  <img
                    src={refImage.trim()}
                    alt="Reference"
                    className="max-h-40 rounded-lg border border-border bg-sidebar object-contain"
                  />
                )}
              </div>
            </Row>
          ) : (
            <Row label="Uploads">
              <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border bg-sidebar/70 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id={uploadInputId}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    onChange={handleUploadChange}
                    className="hidden"
                  />
                  <label
                    htmlFor={uploadInputId}
                    className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-text-main transition-colors hover:border-primary/40 hover:text-primary"
                  >
                    <span className="material-symbols-outlined text-[14px]">
                      upload_file
                    </span>
                    {uploadedImages.length ? "Replace Files" : "Choose Files"}
                  </label>
                  <button
                    type="button"
                    onClick={() => setUploadedImages([])}
                    disabled={uploadedImages.length === 0}
                    className="text-xs text-text-muted transition-colors hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Clear uploads
                  </button>
                  <span className="text-xs text-text-muted">
                    {uploadedImages.length
                      ? `${uploadedImages.length} file${uploadedImages.length === 1 ? "" : "s"} ready`
                      : "PNG, JPEG, or WebP reference files"}
                  </span>
                </div>
                {uploadedImageSummary.length > 0 && (
                  <div className="flex flex-col gap-1">
                    {uploadedImageSummary.map((file) => (
                      <div
                        key={`${file.name}-${file.sizeKb}`}
                        className="flex items-center justify-between gap-3 rounded-md bg-background px-2 py-1.5 text-xs"
                      >
                        <span className="truncate text-text-main">
                          {file.name}
                        </span>
                        <span className="shrink-0 text-text-muted">
                          {file.type} · {file.sizeKb} KB
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-xs text-text-muted">
                  Files are sent as <code>image[]</code> form parts to the edit
                  endpoint. Mask uploads are intentionally unsupported.
                </p>
              </div>
            </Row>
          )}

          {IMAGE_CONFIG.extraFields
            .filter(
              (field) =>
                Array.isArray(selectedModelObj?.params) &&
                selectedModelObj.params.includes(field.key),
            )
            .map((field) => (
              <Row key={field.key} label={field.label}>
                <select
                  value={extraValues[field.key] ?? ""}
                  onChange={(event) =>
                    setExtraValues((state) => ({
                      ...state,
                      [field.key]: event.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
                >
                  {field.options.map((option) => (
                    <option key={option} value={option}>
                      {option === "" ? "(default)" : option}
                    </option>
                  ))}
                </select>
              </Row>
            ))}

          <Row label="Output Format">
            <select
              value={imageOutputFormat}
              onChange={(event) => setImageOutputFormat(event.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
            >
              {outputFormatOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Row>

          <div className="mt-1">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                Request{" "}
                <span className="font-normal normal-case text-text-muted">
                  {selectedEndpoint.bodyFormat}
                </span>
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => copyCurl(curlSnippet)}
                  className="flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-primary"
                >
                  <span className="material-symbols-outlined text-[14px]">
                    {copiedCurl ? "check" : "content_copy"}
                  </span>
                  {copiedCurl ? "Copied" : "Copy"}
                </button>
                <button
                  onClick={handleRun}
                  disabled={!canRun}
                  title={runButtonTitle}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span
                    className="material-symbols-outlined text-[14px]"
                    style={
                      running
                        ? { animation: "spin 1s linear infinite" }
                        : undefined
                    }
                  >
                    {running ? "progress_activity" : "play_arrow"}
                  </span>
                  {running
                    ? "Running..."
                    : endpointMode === "edits"
                      ? "Run Edit"
                      : "Run"}
                </button>
              </div>
            </div>
            <p className="mb-1.5 text-xs text-text-muted">
              {selectedEndpoint.bodyFormat === "multipart"
                ? "Uploaded files are sent as form-data; contents are summarized below."
                : "JSON request body sent to the generation endpoint."}
            </p>
            <pre className="overflow-x-auto whitespace-pre rounded-lg bg-sidebar px-3 py-2.5 font-mono text-xs text-text-main">
              {curlSnippet}
            </pre>
            <pre className="mt-2 overflow-x-auto whitespace-pre rounded-lg bg-sidebar/70 px-3 py-2.5 font-mono text-xs text-text-muted">
              {requestPreviewJson}
            </pre>
          </div>

          {(running || progress) && useStreaming && (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-sidebar px-3 py-2">
              <span
                className="material-symbols-outlined text-[16px] text-primary"
                style={
                  running ? { animation: "spin 1s linear infinite" } : undefined
                }
              >
                {running ? "progress_activity" : "check_circle"}
              </span>
              <span className="text-xs text-text-muted">
                {progress?.stage || "starting"}
                {!running && progress?.bytesReceived
                  ? ` · ${(progress.bytesReceived / 1024).toFixed(1)} KB`
                  : ""}
              </span>
            </div>
          )}

          {partialImage?.b64_json && !result && (
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                Partial preview
              </span>
              <img
                src={`data:image/png;base64,${partialImage.b64_json}`}
                alt="Partial"
                className="mt-1.5 max-w-full rounded-lg border border-border opacity-80"
              />
            </div>
          )}

          {error && <p className="break-words text-xs text-red-500">{error}</p>}

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                Response{" "}
                {result && (
                  <span className="font-normal normal-case">
                    &#9889; {result.latencyMs}ms
                  </span>
                )}
              </span>
              {result && (
                <button
                  onClick={() => copyRes(resultJson)}
                  className="flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-primary"
                >
                  <span className="material-symbols-outlined text-[14px]">
                    {copiedRes ? "check" : "content_copy"}
                  </span>
                  {copiedRes ? "Copied" : "Copy"}
                </button>
              )}
            </div>
            <pre className="overflow-x-auto whitespace-pre rounded-lg bg-sidebar px-3 py-2.5 font-mono text-xs text-text-main opacity-70">
              {result ? resultJson : IMAGE_CONFIG.defaultResponse}
            </pre>
            {(binaryImageUrl || result?.data?.data?.[0]) && (
              <div className="mt-2">
                <div className="mb-1.5 flex items-center justify-end">
                  <a
                    href={
                      binaryImageUrl ||
                      (result?.data?.data?.[0]?.b64_json
                        ? `data:image/${outputFormat};base64,${result.data.data[0].b64_json}`
                        : result?.data?.data?.[0]?.url || "")
                    }
                    download={`image.${outputFormat}`}
                    className="flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-primary"
                  >
                    <span className="material-symbols-outlined text-[14px]">
                      download
                    </span>
                    Download
                  </a>
                </div>
                <img
                  src={
                    binaryImageUrl ||
                    (result?.data?.data?.[0]?.b64_json
                      ? `data:image/${outputFormat};base64,${result.data.data[0].b64_json}`
                      : result?.data?.data?.[0]?.url)
                  }
                  alt="Generated"
                  className="max-w-full rounded-lg border border-border"
                />
              </div>
            )}
          </div>
        </div>
      </Card>
      <AddImageModelModal
        isOpen={showAddModel}
        onClose={() => setShowAddModel(false)}
        onSave={handleAddCustomModel}
      />
    </div>
  );
}
