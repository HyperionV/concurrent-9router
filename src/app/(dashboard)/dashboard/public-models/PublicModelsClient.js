"use client";

import { useState, useEffect, useMemo } from "react";
import { Card, Button, Input, Modal, Badge, CardSkeleton, Toggle } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { resolveModelCapabilities } from "@/shared/utils/modelCapabilities";

const STANDARD_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

export default function PublicModelsClient() {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [filterCap, setFilterCap] = useState("all");
  const [selectedEfforts, setSelectedEfforts] = useState({});
  const [activeSnippetModel, setActiveSnippetModel] = useState(null);

  // Modal State
  const [showModal, setShowModal] = useState(false);
  const [editingModel, setEditingModel] = useState(null);
  const [saving, setSaving] = useState(false);

  // Available suggestions for target model dropdown
  const [availableSuggestions, setAvailableSuggestions] = useState([]);

  const { copied, copy } = useCopyToClipboard(2000);

  useEffect(() => {
    fetchModels();
    fetchSuggestions();
  }, []);

  const fetchModels = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/public-models");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const json = await res.json();
      const list = json.models || [];
      setModels(list);

      // Initialize selected efforts
      const initial = {};
      for (const m of list) {
        if (m.defaultEffort) {
          initial[m.id] = m.defaultEffort;
        } else if (Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length > 0) {
          initial[m.id] = m.reasoningEfforts[0];
        }
      }
      setSelectedEfforts(initial);
    } catch (err) {
      setError(err.message || "Failed to load public models");
    } finally {
      setLoading(false);
    }
  };

  const fetchSuggestions = async () => {
    try {
      const res = await fetch("/api/v1/models");
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.data)) {
          setAvailableSuggestions(json.data.map((d) => d.id).filter(Boolean));
        }
      }
    } catch (e) {
      // Non-critical
    }
  };

  const handleSaveModel = async (formData) => {
    setSaving(true);
    try {
      const isEdit = !!editingModel;
      const url = isEdit ? `/api/public-models/${editingModel.id}` : "/api/public-models";
      const method = isEdit ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || "Failed to save public model");
      }

      await fetchModels();
      setShowModal(false);
      setEditingModel(null);
    } catch (err) {
      alert(err.message || "Error saving public model");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteModel = async (id, name) => {
    if (!confirm(`Are you sure you want to delete "${name}" from public models?`)) return;
    try {
      const res = await fetch(`/api/public-models/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete model");
      setModels((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      alert(err.message || "Error deleting model");
    }
  };

  const handleToggleActive = async (model) => {
    const nextState = !model.isActive;
    try {
      const res = await fetch(`/api/public-models/${model.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: nextState }),
      });
      if (res.ok) {
        setModels((prev) =>
          prev.map((m) => (m.id === model.id ? { ...m, isActive: nextState } : m))
        );
      }
    } catch (err) {
      console.error("Failed to toggle model active status:", err);
    }
  };

  const handleEffortChange = (modelId, effort) => {
    setSelectedEfforts((prev) => ({
      ...prev,
      [modelId]: effort,
    }));
  };

  const filteredModels = useMemo(() => {
    return models.filter((m) => {
      if (search.trim()) {
        const q = search.toLowerCase();
        const matchesName = m.name?.toLowerCase().includes(q);
        const matchesTarget = m.targetModel?.toLowerCase().includes(q);
        const matchesProv = m.providerDisplay?.toLowerCase().includes(q) || m.provider?.toLowerCase().includes(q);
        if (!matchesName && !matchesTarget && !matchesProv) return false;
      }

      if (filterCap === "active" && !m.isActive) return false;
      if (filterCap === "inactive" && m.isActive) return false;
      if (filterCap === "reasoning" && !(m.capabilities?.reasoning || (m.reasoningEfforts?.length > 0))) return false;
      if (filterCap === "vision" && !m.capabilities?.vision) return false;
      if (filterCap === "image" && !m.capabilities?.image_generation) return false;

      return true;
    });
  }, [models, search, filterCap]);

  const stats = useMemo(() => {
    const total = models.length;
    const activeCount = models.filter((m) => m.isActive).length;
    const reasoningCount = models.filter((m) => m.capabilities?.reasoning || (m.reasoningEfforts?.length > 0)).length;
    return { total, activeCount, reasoningCount };
  }, [models]);

  const getEffectiveModelSlug = (model) => {
    const target = model.targetModel || model.id;
    const effort = selectedEfforts[model.id];
    if (effort && effort !== "auto" && effort !== "none") {
      if (!target.endsWith(`-${effort}`)) {
        return `${target}-${effort}`;
      }
    }
    return target;
  };

  const formatTokens = (tokens) => {
    if (!tokens) return "-";
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(0)}M`;
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
    return tokens.toString();
  };

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-bg-main text-text-main">
      <div className="p-6 md:p-8 max-w-7xl w-full mx-auto flex flex-col gap-6">
        {/* Hero & Action Bar */}
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
                  Create and manage publicly discoverable models, supported effort tiers, and titles exposed at <code className="text-xs bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded font-mono">/public/models</code>.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <Button
              variant="primary"
              size="sm"
              icon="add"
              onClick={() => {
                setEditingModel(null);
                setShowModal(true);
              }}
              className="shadow-sm shadow-orange-500/20"
            >
              Add Public Model
            </Button>
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
              {copied === "endpoint-url" ? "URL Copied!" : "Copy Endpoint URL"}
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
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3.5">
          <div className="p-4 rounded-xl border border-black/5 dark:border-white/5 bg-surface/50 backdrop-blur-sm flex flex-col">
            <span className="text-xs font-medium text-text-muted">Total Published</span>
            <span className="text-2xl font-bold text-text-main mt-1">{stats.activeCount} <span className="text-xs font-normal text-text-muted">/ {stats.total} entries</span></span>
          </div>
          <div className="p-4 rounded-xl border border-black/5 dark:border-white/5 bg-surface/50 backdrop-blur-sm flex flex-col">
            <span className="text-xs font-medium text-text-muted">Reasoning Enabled</span>
            <span className="text-2xl font-bold text-[#f97815] mt-1">{stats.reasoningCount}</span>
          </div>
          <div className="p-4 rounded-xl border border-black/5 dark:border-white/5 bg-surface/50 backdrop-blur-sm flex flex-col">
            <span className="text-xs font-medium text-text-muted">Public Endpoint</span>
            <span className="text-sm font-mono text-emerald-500 mt-2 truncate">GET /public/models</span>
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
              placeholder="Search created public models..."
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

          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
            {[
              { id: "all", label: "All Entries" },
              { id: "active", label: "Published (Active)" },
              { id: "inactive", label: "Drafts (Inactive)" },
              { id: "reasoning", label: "Reasoning Tiers", icon: "psychology" },
              { id: "vision", label: "Vision", icon: "visibility" },
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

        {/* Catalog Grid */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
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
        ) : models.length === 0 ? (
          <div className="p-12 rounded-2xl border border-dashed border-black/10 dark:border-white/10 bg-surface/30 text-center flex flex-col items-center gap-4">
            <div className="size-16 rounded-2xl bg-[#f97815]/10 text-[#f97815] flex items-center justify-center">
              <span className="material-symbols-outlined text-[36px]">tune</span>
            </div>
            <div className="max-w-md">
              <h3 className="text-base font-semibold text-text-main mb-1">No Public Models Created Yet</h3>
              <p className="text-xs text-text-muted">
                Create user-defined entries to expose specific models, titles, and reasoning effort levels on the public <code className="font-mono">/public/models</code> discovery endpoint.
              </p>
            </div>
            <Button
              variant="primary"
              size="sm"
              icon="add"
              onClick={() => {
                setEditingModel(null);
                setShowModal(true);
              }}
            >
              Create First Public Model
            </Button>
          </div>
        ) : filteredModels.length === 0 ? (
          <div className="p-12 rounded-2xl border border-dashed border-black/10 dark:border-white/10 text-center flex flex-col items-center gap-2">
            <span className="material-symbols-outlined text-text-muted text-[36px]">search_off</span>
            <p className="text-sm font-medium text-text-main">No models matching filter criteria</p>
            <p className="text-xs text-text-muted">Try resetting search or filters.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredModels.map((model) => {
              const currentEffort = selectedEfforts[model.id] || model.defaultEffort || model.reasoningEfforts?.[0] || "high";
              const effectiveSlug = getEffectiveModelSlug(model);
              const hasReasoning = Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0;

              return (
                <div
                  key={model.id}
                  className={`rounded-2xl border transition-all duration-200 p-5 flex flex-col justify-between gap-4 shadow-xs ${
                    model.isActive
                      ? "border-black/5 dark:border-white/5 bg-surface/70 hover:bg-surface hover:border-black/10 dark:hover:border-white/10"
                      : "border-dashed border-black/10 dark:border-white/10 bg-surface/30 opacity-75"
                  }`}
                >
                  {/* Card Header */}
                  <div className="flex flex-col gap-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h2 className="font-semibold text-text-main text-base leading-snug truncate">
                            {model.name}
                          </h2>
                          {!model.isActive && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                              Inactive
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[11px] font-mono text-text-muted bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded">
                            {model.providerDisplay || model.provider || "Custom"}
                          </span>
                          <span className="text-[11px] font-mono text-text-muted truncate max-w-[140px]" title={model.targetModel}>
                            {model.targetModel}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingModel(model);
                            setShowModal(true);
                          }}
                          className="p-1 rounded-lg text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                          title="Edit Public Model"
                        >
                          <span className="material-symbols-outlined text-[18px]">edit</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteModel(model.id, model.name)}
                          className="p-1 rounded-lg text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
                          title="Delete Public Model"
                        >
                          <span className="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                      </div>
                    </div>

                    {model.description && (
                      <p className="text-xs text-text-muted line-clamp-2 mt-0.5">{model.description}</p>
                    )}

                    {/* Capability Badges */}
                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                      {hasReasoning && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                          <span className="material-symbols-outlined text-[12px]">psychology</span>
                          {model.reasoningEfforts.length} Effort Levels
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
                      {model.contextWindow && (
                        <span className="text-[10px] font-medium text-text-muted bg-black/5 dark:bg-white/5 px-2 py-0.5 rounded-full ml-auto">
                          {formatTokens(model.contextWindow)} ctx
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
                        {model.reasoningEfforts.map((lvl) => {
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
                      <span className="text-[11px] text-text-muted">Published ID:</span>
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

                      <button
                        type="button"
                        onClick={() => handleToggleActive(model)}
                        className={`p-1.5 rounded-lg border transition-colors ${
                          model.isActive
                            ? "border-emerald-500/30 text-emerald-500 bg-emerald-500/5 hover:bg-emerald-500/10"
                            : "border-black/10 dark:border-white/10 text-text-muted hover:text-text-main"
                        }`}
                        title={model.isActive ? "Published (Click to Deactivate)" : "Draft (Click to Publish)"}
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {model.isActive ? "visibility" : "visibility_off"}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create / Edit Public Model Modal */}
      {showModal && (
        <PublicModelFormModal
          isOpen={showModal}
          initialData={editingModel}
          onClose={() => {
            setShowModal(false);
            setEditingModel(null);
          }}
          onSave={handleSaveModel}
          saving={saving}
          availableSuggestions={availableSuggestions}
        />
      )}

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
    ...(activeSnippetModel.currentEffort
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
    ...(activeSnippetModel.currentEffort
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
                      ...(activeSnippetModel.currentEffort
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

function PublicModelFormModal({ isOpen, initialData, onClose, onSave, saving, availableSuggestions }) {
  const isEdit = !!initialData;
  const [name, setName] = useState(initialData?.name || "");
  const [targetModel, setTargetModel] = useState(initialData?.targetModel || "");
  const [providerDisplay, setProviderDisplay] = useState(initialData?.providerDisplay || "");
  const [description, setDescription] = useState(initialData?.description || "");
  const [contextWindow, setContextWindow] = useState(initialData?.contextWindow || 128000);
  const [maxOutputTokens, setMaxOutputTokens] = useState(initialData?.maxOutputTokens || 8192);
  const [reasoningEfforts, setReasoningEfforts] = useState(initialData?.reasoningEfforts || ["low", "medium", "high", "xhigh", "max"]);
  const [defaultEffort, setDefaultEffort] = useState(initialData?.defaultEffort || "high");
  const [capabilities, setCapabilities] = useState(initialData?.capabilities || {
    reasoning: true,
    vision: true,
    tool_calling: true,
    streaming: true,
    image_generation: false,
  });
  const [isActive, setIsActive] = useState(initialData ? initialData.isActive : true);

  const handleTargetModelSelect = (selectedId) => {
    setTargetModel(selectedId);
    if (!name) {
      // Auto-populate friendly name
      const parts = selectedId.split("/");
      const baseName = parts[parts.length - 1].replace(/-/g, " ");
      setName(baseName.charAt(0).toUpperCase() + baseName.slice(1));
    }
    if (!providerDisplay && selectedId.includes("/")) {
      const prov = selectedId.split("/")[0];
      setProviderDisplay(prov.toUpperCase());
    }

    // Auto-detect capabilities if available
    const caps = resolveModelCapabilities("", selectedId);
    if (caps.reasoning_efforts.length > 0) {
      setReasoningEfforts(caps.reasoning_efforts);
      setDefaultEffort(caps.default_reasoning_effort || "high");
      setCapabilities((prev) => ({ ...prev, reasoning: true }));
    }
    if (caps.context_window) setContextWindow(caps.context_window);
    if (caps.max_output_tokens) setMaxOutputTokens(caps.max_output_tokens);
  };

  const toggleEffortLevel = (lvl) => {
    setReasoningEfforts((prev) => {
      const next = prev.includes(lvl) ? prev.filter((x) => x !== lvl) : [...prev, lvl];
      if (!next.includes(defaultEffort) && next.length > 0) {
        setDefaultEffort(next[0]);
      }
      return next;
    });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) return alert("Please enter a model name / title");
    if (!targetModel.trim()) return alert("Please specify the target model ID");

    onSave({
      name: name.trim(),
      targetModel: targetModel.trim(),
      providerDisplay: providerDisplay.trim(),
      provider: providerDisplay.trim().toLowerCase() || targetModel.split("/")[0] || "custom",
      description: description.trim(),
      contextWindow: Number(contextWindow) || 128000,
      maxOutputTokens: Number(maxOutputTokens) || 8192,
      reasoningEfforts,
      defaultEffort: reasoningEfforts.length > 0 ? defaultEffort : null,
      capabilities: {
        ...capabilities,
        reasoning: reasoningEfforts.length > 0,
      },
      isActive,
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? `Edit: ${initialData.name}` : "Create Public Model Entry"}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="text-xs font-semibold text-text-main mb-1 block">
            Public Display Title <span className="text-red-500">*</span>
          </label>
          <Input
            placeholder="e.g. Grok 4.7 Reasoning Flagship"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>

        <div>
          <label className="text-xs font-semibold text-text-main mb-1 block">
            Target Model ID / Slug <span className="text-red-500">*</span>
          </label>
          <div className="flex flex-col gap-1.5">
            <Input
              placeholder="e.g. gcli/grok-4.7 or cc/claude-sonnet-5-5 or combo-name"
              value={targetModel}
              onChange={(e) => setTargetModel(e.target.value)}
              required
            />
            {availableSuggestions.length > 0 && (
              <div className="flex items-center gap-1.5 overflow-x-auto text-[11px] text-text-muted scrollbar-none py-0.5">
                <span className="shrink-0 font-medium">Quick Pick:</span>
                {availableSuggestions.slice(0, 5).map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => handleTargetModelSelect(id)}
                    className="px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5 hover:bg-[#f97815]/10 hover:text-[#f97815] transition-colors truncate max-w-[120px]"
                  >
                    {id}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-text-main mb-1 block">
              Provider Badge / Tag
            </label>
            <Input
              placeholder="e.g. Grok CLI, Claude, Codex"
              value={providerDisplay}
              onChange={(e) => setProviderDisplay(e.target.value)}
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-text-main mb-1 block">
              Context Window (tokens)
            </label>
            <Input
              type="number"
              placeholder="131072"
              value={contextWindow}
              onChange={(e) => setContextWindow(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="text-xs font-semibold text-text-main mb-1 block">
            Description (Optional)
          </label>
          <Input
            placeholder="e.g. Flagship coding and reasoning model with extended context."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* Reasoning Efforts Selector */}
        <div className="p-3 rounded-xl border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-text-main flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[16px] text-[#f97815]">neurology</span>
              Supported Reasoning Effort Tiers
            </span>
            <span className="text-[11px] text-text-muted">
              {reasoningEfforts.length > 0 ? `${reasoningEfforts.length} selected` : "Disabled"}
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {STANDARD_EFFORTS.map((lvl) => {
              const active = reasoningEfforts.includes(lvl);
              return (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => toggleEffortLevel(lvl)}
                  className={`px-3 py-1 text-xs font-medium rounded-lg capitalize transition-all ${
                    active
                      ? "bg-[#f97815] text-white shadow-xs"
                      : "bg-surface border border-black/10 dark:border-white/10 text-text-muted hover:text-text-main"
                  }`}
                >
                  {lvl}
                </button>
              );
            })}
          </div>

          {reasoningEfforts.length > 0 && (
            <div className="flex items-center gap-2 mt-1">
              <label className="text-xs text-text-muted shrink-0 font-medium">Default Effort:</label>
              <select
                value={defaultEffort}
                onChange={(e) => setDefaultEffort(e.target.value)}
                className="px-2.5 py-1 text-xs rounded-lg border border-black/10 dark:border-white/10 bg-surface text-text-main"
              >
                {reasoningEfforts.map((lvl) => (
                  <option key={lvl} value={lvl}>
                    {lvl}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Capabilities Checkboxes */}
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={capabilities.vision}
              onChange={(e) => setCapabilities((c) => ({ ...c, vision: e.target.checked }))}
              className="accent-[#f97815]"
            />
            Vision Support
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={capabilities.tool_calling}
              onChange={(e) => setCapabilities((c) => ({ ...c, tool_calling: e.target.checked }))}
              className="accent-[#f97815]"
            />
            Tool Calling
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="accent-[#f97815]"
            />
            Publish Immediately (Active)
          </label>
        </div>

        <div className="flex justify-end gap-2.5 pt-2 border-t border-black/5 dark:border-white/5">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={saving}>
            {isEdit ? "Update Public Model" : "Create Public Model"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
