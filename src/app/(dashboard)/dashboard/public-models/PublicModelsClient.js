"use client";

import { useState, useEffect, useMemo } from "react";
import { Card, Button, Input, Modal, Badge, CardSkeleton } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

export default function PublicModelsClient() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [filterCap, setFilterCap] = useState("all"); // all, reasoning, vision, tools, image, combo
  const [selectedProvider, setSelectedProvider] = useState("all");
  const [selectedEfforts, setSelectedEfforts] = useState({});
  const [activeSnippetModel, setActiveSnippetModel] = useState(null);

  const { copied, copy } = useCopyToClipboard(2000);

  useEffect(() => {
    fetchModels();
  }, []);

  const fetchModels = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/public/models");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const json = await res.json();
      setData(json);

      // Initialize default selected efforts
      const initialEfforts = {};
      if (Array.isArray(json?.data)) {
        for (const m of json.data) {
          if (m.default_reasoning_effort) {
            initialEfforts[m.id] = m.default_reasoning_effort;
          }
        }
      }
      setSelectedEfforts(initialEfforts);
    } catch (err) {
      setError(err.message || "Failed to load public model catalog");
    } finally {
      setLoading(false);
    }
  };

  const handleEffortChange = (modelId, effort) => {
    setSelectedEfforts((prev) => ({
      ...prev,
      [modelId]: effort,
    }));
  };

  const models = data?.data || [];

  const providers = useMemo(() => {
    const set = new Set();
    for (const m of models) {
      if (m.provider) set.add(m.provider);
    }
    return Array.from(set).sort();
  }, [models]);

  const filteredModels = useMemo(() => {
    return models.filter((m) => {
      // Search
      if (search.trim()) {
        const q = search.toLowerCase();
        const matchesId = m.id?.toLowerCase().includes(q);
        const matchesName = m.name?.toLowerCase().includes(q);
        const matchesProv = m.provider_display?.toLowerCase().includes(q) || m.provider?.toLowerCase().includes(q);
        if (!matchesId && !matchesName && !matchesProv) return false;
      }

      // Provider
      if (selectedProvider !== "all" && m.provider !== selectedProvider) {
        return false;
      }

      // Capabilities
      if (filterCap === "reasoning" && !m.capabilities?.reasoning) return false;
      if (filterCap === "vision" && !m.capabilities?.vision) return false;
      if (filterCap === "tools" && !m.capabilities?.tool_calling) return false;
      if (filterCap === "image" && !m.capabilities?.image_generation) return false;
      if (filterCap === "combo" && m.provider !== "combo") return false;

      return true;
    });
  }, [models, search, selectedProvider, filterCap]);

  const stats = useMemo(() => {
    const total = models.length;
    const reasoningCount = models.filter((m) => m.capabilities?.reasoning).length;
    const visionCount = models.filter((m) => m.capabilities?.vision).length;
    const activeProvCount = providers.length;
    return { total, reasoningCount, visionCount, activeProvCount };
  }, [models, providers]);

  const getEffectiveModelSlug = (model) => {
    const effort = selectedEfforts[model.id];
    if (effort && effort !== "auto" && effort !== "none") {
      // If the model ID doesn't already contain the effort suffix
      if (!model.id.endsWith(`-${effort}`)) {
        return `${model.id}-${effort}`;
      }
    }
    return model.id;
  };

  const formatTokens = (tokens) => {
    if (!tokens) return "-";
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(0)}M`;
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
    return tokens.toString();
  };

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-bg-main text-text-main">
      {/* Top Banner / Hero */}
      <div className="p-6 md:p-8 max-w-7xl w-full mx-auto flex flex-col gap-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-black/5 dark:border-white/5 pb-6">
          <div>
            <div className="flex items-center gap-3">
              <div className="size-10 rounded-xl bg-linear-to-br from-[#f97815] to-[#c2590a] flex items-center justify-center text-white shadow-md shadow-orange-500/20">
                <span className="material-symbols-outlined text-[24px]">tune</span>
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-text-main flex items-center gap-2">
                  Public Model Interface
                  <Badge variant="success" className="text-xs">Live API</Badge>
                </h1>
                <p className="text-sm text-text-muted">
                  Discover public model routes, reasoning effort levels, and integration parameters for downstream clients.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const url = typeof window !== "undefined" ? `${window.location.origin}/public/models` : "/public/models";
                copy(url, "endpoint-url");
              }}
              className="flex items-center gap-2 text-xs"
            >
              <span className="material-symbols-outlined text-[16px]">
                {copied === "endpoint-url" ? "check" : "content_copy"}
              </span>
              {copied === "endpoint-url" ? "URL Copied!" : "Copy Public API URL"}
            </Button>
            <a
              href="/public/models"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 transition-colors text-text-main"
            >
              <span className="material-symbols-outlined text-[16px]">open_in_new</span>
              Raw JSON
            </a>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
          <div className="p-4 rounded-xl border border-black/5 dark:border-white/5 bg-surface/50 backdrop-blur-sm flex flex-col">
            <span className="text-xs font-medium text-text-muted">Available Models</span>
            <span className="text-2xl font-bold text-text-main mt-1">{stats.total}</span>
          </div>
          <div className="p-4 rounded-xl border border-black/5 dark:border-white/5 bg-surface/50 backdrop-blur-sm flex flex-col">
            <span className="text-xs font-medium text-text-muted">Thinking & Reasoning</span>
            <span className="text-2xl font-bold text-[#f97815] mt-1">{stats.reasoningCount}</span>
          </div>
          <div className="p-4 rounded-xl border border-black/5 dark:border-white/5 bg-surface/50 backdrop-blur-sm flex flex-col">
            <span className="text-xs font-medium text-text-muted">Multimodal (Vision)</span>
            <span className="text-2xl font-bold text-blue-500 mt-1">{stats.visionCount}</span>
          </div>
          <div className="p-4 rounded-xl border border-black/5 dark:border-white/5 bg-surface/50 backdrop-blur-sm flex flex-col">
            <span className="text-xs font-medium text-text-muted">Active Providers</span>
            <span className="text-2xl font-bold text-emerald-500 mt-1">{stats.activeProvCount}</span>
          </div>
        </div>

        {/* Search & Filter Bar */}
        <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
          <div className="relative flex-1 max-w-md">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[18px]">
              search
            </span>
            <input
              type="text"
              placeholder="Search by model name, slug, or provider..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-sm rounded-xl border border-black/10 dark:border-white/10 bg-surface/80 text-text-main placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-[#f97815]/30 focus:border-[#f97815]"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main"
              >
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            )}
          </div>

          {/* Capabilities Filter Chips */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
            {[
              { id: "all", label: "All Models" },
              { id: "reasoning", label: "Thinking / Reasoning", icon: "psychology" },
              { id: "vision", label: "Vision", icon: "visibility" },
              { id: "tools", label: "Tools", icon: "build" },
              { id: "image", label: "Image Gen", icon: "brush" },
              { id: "combo", label: "Combos", icon: "layers" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setFilterCap(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center gap-1 whitespace-nowrap ${
                  filterCap === tab.id
                    ? "bg-[#f97815] text-white shadow-sm shadow-orange-500/20"
                    : "bg-surface/60 text-text-muted hover:text-text-main hover:bg-surface border border-black/5 dark:border-white/5"
                }`}
              >
                {tab.icon && <span className="material-symbols-outlined text-[14px]">{tab.icon}</span>}
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Provider Filter Tabs */}
        {providers.length > 1 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
            <span className="text-xs font-medium text-text-muted mr-1">Provider:</span>
            <button
              onClick={() => setSelectedProvider("all")}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                selectedProvider === "all"
                  ? "bg-black/10 dark:bg-white/15 text-text-main font-semibold"
                  : "text-text-muted hover:text-text-main"
              }`}
            >
              All ({models.length})
            </button>
            {providers.map((p) => {
              const count = models.filter((m) => m.provider === p).length;
              return (
                <button
                  key={p}
                  onClick={() => setSelectedProvider(p)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    selectedProvider === p
                      ? "bg-black/10 dark:bg-white/15 text-text-main font-semibold"
                      : "text-text-muted hover:text-text-main"
                  }`}
                >
                  {p} ({count})
                </button>
              );
            })}
          </div>
        )}

        {/* Catalog Grid */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : error ? (
          <div className="p-8 rounded-2xl border border-red-500/20 bg-red-500/5 text-center flex flex-col items-center gap-3">
            <span className="material-symbols-outlined text-red-500 text-[32px]">error</span>
            <p className="text-sm font-medium text-red-600 dark:text-red-400">{error}</p>
            <Button size="sm" variant="outline" onClick={fetchModels}>
              Retry
            </Button>
          </div>
        ) : filteredModels.length === 0 ? (
          <div className="p-12 rounded-2xl border border-dashed border-black/10 dark:border-white/10 text-center flex flex-col items-center gap-2">
            <span className="material-symbols-outlined text-text-muted text-[36px]">search_off</span>
            <p className="text-sm font-medium text-text-main">No models matching criteria</p>
            <p className="text-xs text-text-muted">Try adjusting your search or active filter pills.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredModels.map((model) => {
              const currentEffort = selectedEfforts[model.id] || model.default_reasoning_effort || "high";
              const effectiveSlug = getEffectiveModelSlug(model);
              const hasReasoning = model.capabilities?.reasoning && model.reasoning_efforts?.length > 0;

              return (
                <div
                  key={model.id}
                  className="rounded-2xl border border-black/5 dark:border-white/5 bg-surface/70 hover:bg-surface hover:border-black/10 dark:hover:border-white/10 transition-all duration-200 p-5 flex flex-col justify-between gap-4 shadow-xs"
                >
                  {/* Card Header */}
                  <div className="flex flex-col gap-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h2 className="font-semibold text-text-main text-base leading-snug">
                          {model.name}
                        </h2>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[11px] font-mono text-text-muted bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded">
                            {model.provider_display || model.provider}
                          </span>
                          {model.type === "combo" && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
                              Combo ({model.models_count} models)
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        {model.context_window && (
                          <span
                            title={`Context window: ${model.context_window.toLocaleString()} tokens`}
                            className="text-[11px] font-medium text-text-muted bg-black/5 dark:bg-white/5 px-2 py-0.5 rounded-full"
                          >
                            {formatTokens(model.context_window)} ctx
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Capability Badges */}
                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                      {model.capabilities?.reasoning && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                          <span className="material-symbols-outlined text-[12px]">psychology</span>
                          Reasoning
                        </span>
                      )}
                      {model.capabilities?.vision && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                          <span className="material-symbols-outlined text-[12px]">visibility</span>
                          Vision
                        </span>
                      )}
                      {model.capabilities?.tool_calling && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                          <span className="material-symbols-outlined text-[12px]">build</span>
                          Tools
                        </span>
                      )}
                      {model.capabilities?.image_generation && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-md bg-pink-500/10 text-pink-600 dark:text-pink-400 border border-pink-500/20">
                          <span className="material-symbols-outlined text-[12px]">brush</span>
                          Text2Img
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Reasoning Effort Configurator (if supported) */}
                  {hasReasoning && (
                    <div className="p-2.5 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-black/5 dark:border-white/5 flex flex-col gap-1.5">
                      <div className="flex items-center justify-between text-[11px] text-text-muted">
                        <span className="font-medium flex items-center gap-1">
                          <span className="material-symbols-outlined text-[13px] text-[#f97815]">neurology</span>
                          Effort Level:
                        </span>
                        <span className="font-mono text-[#f97815] font-semibold">{currentEffort}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {model.reasoning_efforts.map((lvl) => {
                          const isSelected = currentEffort === lvl;
                          return (
                            <button
                              key={lvl}
                              type="button"
                              onClick={() => handleEffortChange(model.id, lvl)}
                              className={`flex-1 py-1 text-[11px] font-medium rounded-md capitalize transition-all ${
                                isSelected
                                  ? "bg-[#f97815] text-white shadow-xs"
                                  : "bg-black/5 dark:bg-white/5 text-text-muted hover:text-text-main hover:bg-black/10 dark:hover:bg-white/10"
                              }`}
                            >
                              {lvl}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Model Slug Display & Action Footer */}
                  <div className="flex flex-col gap-2 pt-2 border-t border-black/5 dark:border-white/5">
                    <div className="flex items-center justify-between gap-1 text-xs">
                      <span className="text-[11px] text-text-muted">Model ID:</span>
                      <code className="font-mono text-[11px] text-text-main font-semibold truncate max-w-[200px]" title={effectiveSlug}>
                        {effectiveSlug}
                      </code>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => copy(effectiveSlug, `slug-${model.id}`)}
                        className="flex-1 py-1.5 px-2.5 rounded-lg border border-black/10 dark:border-white/10 bg-surface hover:bg-black/5 dark:hover:bg-white/5 text-text-main text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
                      >
                        <span className="material-symbols-outlined text-[15px]">
                          {copied === `slug-${model.id}` ? "check" : "content_copy"}
                        </span>
                        {copied === `slug-${model.id}` ? "Copied Slug" : "Copy Slug"}
                      </button>

                      <button
                        type="button"
                        onClick={() => setActiveSnippetModel({ ...model, currentEffort, effectiveSlug })}
                        className="py-1.5 px-2.5 rounded-lg border border-black/10 dark:border-white/10 bg-surface hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-text-main text-xs font-medium flex items-center justify-center gap-1 transition-colors"
                        title="Integration Snippets"
                      >
                        <span className="material-symbols-outlined text-[15px]">code</span>
                        Snippet
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Snippet Modal */}
      {activeSnippetModel && (
        <Modal
          isOpen={true}
          onClose={() => setActiveSnippetModel(null)}
          title={`Integration: ${activeSnippetModel.name}`}
        >
          <div className="flex flex-col gap-4">
            <div>
              <label className="text-xs font-medium text-text-muted mb-1 block">
                OpenAI Client Payload
              </label>
              <pre className="p-3 rounded-xl bg-black/5 dark:bg-white/5 font-mono text-xs text-text-main overflow-x-auto">
{JSON.stringify(
  {
    model: activeSnippetModel.effectiveSlug,
    ...(activeSnippetModel.capabilities?.reasoning && activeSnippetModel.currentEffort
      ? { reasoning_effort: activeSnippetModel.currentEffort }
      : {}),
    messages: [{ role: "user", content: "Hello!" }],
    stream: true,
  },
  null,
  2
)}
              </pre>
            </div>

            <div>
              <label className="text-xs font-medium text-text-muted mb-1 block">
                cURL Command
              </label>
              <pre className="p-3 rounded-xl bg-black/5 dark:bg-white/5 font-mono text-xs text-text-main overflow-x-auto whitespace-pre-wrap">
{`curl -X POST "${typeof window !== "undefined" ? window.location.origin : "http://localhost:8080"}/v1/chat/completions" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '${JSON.stringify({
    model: activeSnippetModel.effectiveSlug,
    ...(activeSnippetModel.capabilities?.reasoning && activeSnippetModel.currentEffort
      ? { reasoning_effort: activeSnippetModel.currentEffort }
      : {}),
    messages: [{ role: "user", content: "Hello!" }],
  })}'`}
              </pre>
            </div>

            <div className="flex justify-end gap-2 mt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const payload = JSON.stringify(
                    {
                      model: activeSnippetModel.effectiveSlug,
                      ...(activeSnippetModel.capabilities?.reasoning && activeSnippetModel.currentEffort
                        ? { reasoning_effort: activeSnippetModel.currentEffort }
                        : {}),
                      messages: [{ role: "user", content: "Hello!" }],
                    },
                    null,
                    2
                  );
                  copy(payload, "modal-payload");
                }}
              >
                {copied === "modal-payload" ? "Copied JSON!" : "Copy Payload"}
              </Button>
              <Button size="sm" onClick={() => setActiveSnippetModel(null)}>
                Done
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
