"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge, Card } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS } from "@/shared/constants/providers";

function getEffectiveStatus(connection) {
  const isCooldown = Object.entries(connection).some(
    ([key, value]) =>
      key.startsWith("modelLock_") &&
      value &&
      new Date(value).getTime() > Date.now(),
  );
  return connection.testStatus === "unavailable" && !isCooldown
    ? "active"
    : connection.testStatus;
}

function CodexImageCard({ connections }) {
  const provider = AI_PROVIDERS.codex;
  const codexConnections = connections.filter(
    (connection) => connection.provider === "codex",
  );
  const connected = codexConnections.filter((connection) => {
    const status = getEffectiveStatus(connection);
    return status === "active" || status === "success";
  }).length;
  const error = codexConnections.filter((connection) => {
    const status = getEffectiveStatus(connection);
    return (
      status === "error" || status === "expired" || status === "unavailable"
    );
  }).length;
  const total = codexConnections.length;
  const allDisabled =
    total > 0 &&
    codexConnections.every((connection) => connection.isActive === false);

  return (
    <Link href="/dashboard/media-providers/image/codex" className="group">
      <Card
        padding="xs"
        className={`h-full cursor-pointer transition-colors hover:bg-black/[0.01] dark:hover:bg-white/[0.01] ${allDisabled ? "opacity-50" : ""}`}
      >
        <div className="flex items-center gap-3">
          <div
            className="flex size-8 shrink-0 items-center justify-center rounded-lg"
            style={{ backgroundColor: `${provider.color}15` }}
          >
            <ProviderIcon
              src="/providers/codex.png"
              alt={provider.name}
              size={30}
              className="max-h-[30px] max-w-[30px] rounded-lg object-contain"
              fallbackText="CX"
              fallbackColor={provider.color}
            />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{provider.name}</h3>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              {allDisabled ? (
                <Badge variant="default" size="sm">
                  Disabled
                </Badge>
              ) : total === 0 ? (
                <span className="text-xs text-text-muted">No connections</span>
              ) : (
                <>
                  {connected > 0 && (
                    <Badge variant="success" size="sm" dot>
                      {connected} Connected
                    </Badge>
                  )}
                  {error > 0 && (
                    <Badge variant="error" size="sm" dot>
                      {error} Error
                    </Badge>
                  )}
                  {connected === 0 && error === 0 && (
                    <Badge variant="default" size="sm">
                      {total} Added
                    </Badge>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </Card>
    </Link>
  );
}

export default function ImageMediaProvidersPage() {
  const [connections, setConnections] = useState([]);

  useEffect(() => {
    fetch("/api/providers", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => setConnections(data.connections || []))
      .catch(() => {});
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Text to Image</h1>
        <p className="mt-2 max-w-2xl text-sm text-text-muted">
          Codex-only image generation for testing Plus/Pro image entitlement and
          `/v1/images/generations` behavior.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <CodexImageCard connections={connections} />
      </div>
    </div>
  );
}
