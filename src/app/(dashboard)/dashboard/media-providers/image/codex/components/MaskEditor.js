"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "@/shared/components";

export default function MaskEditor({ imageFile, onSave, onCancel }) {
  const [imageUrl, setImageUrl] = useState("");
  const [shapes, setShapes] = useState([]);
  const [mode, setMode] = useState("rect"); // 'rect' | 'freeform'
  const [isDrawing, setIsDrawing] = useState(false);
  const [points, setPoints] = useState([]);
  const [commentInput, setCommentInput] = useState("");
  const [showCommentModal, setShowCommentModal] = useState(false);
  const [tempShape, setTempShape] = useState(null);

  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const imgRef = useRef(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [imageLoaded, setImageLoaded] = useState(false);

  useEffect(() => {
    if (!imageFile) return;
    const url = URL.createObjectURL(imageFile);
    setImageUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [imageFile]);

  // Adjust canvas size to fit image container and maintain aspect ratio
  const handleImageLoad = () => {
    const img = imgRef.current;
    if (!img) return;

    const containerWidth = containerRef.current ? containerRef.current.clientWidth : 600;
    const maxDisplayHeight = 450;
    const scale = Math.min(containerWidth / img.naturalWidth, maxDisplayHeight / img.naturalHeight, 1);
    const displayWidth = img.naturalWidth * scale;
    const displayHeight = img.naturalHeight * scale;

    setDimensions({ width: displayWidth, height: displayHeight });
    setImageLoaded(true);
  };

  // Re-calculate dimensions on resize
  useEffect(() => {
    if (!imageLoaded) return;
    const handleResize = () => {
      handleImageLoad();
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [imageLoaded]);

  // Redraw canvas content when shapes, points, drawing state, or dimensions change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageLoaded) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, dimensions.width, dimensions.height);

    // Create a striped pattern (white background with grey slate stripes)
    const patternCanvas = document.createElement("canvas");
    patternCanvas.width = 12;
    patternCanvas.height = 12;
    const pctx = patternCanvas.getContext("2d");
    pctx.fillStyle = "#ffffff";
    pctx.fillRect(0, 0, 12, 12);
    pctx.strokeStyle = "#cbd5e1"; // slate-300
    pctx.lineWidth = 1.5;
    pctx.beginPath();
    pctx.moveTo(0, 12);
    pctx.lineTo(12, 0);
    pctx.stroke();
    const pattern = ctx.createPattern(patternCanvas, "repeat");

    // Sketched border helpers
    const drawSketchedRectBorder = (x1, y1, x2, y2) => {
      ctx.setLineDash([]);
      ctx.lineWidth = 1.2;
      
      const drawOffsetLine = (ox1, oy1, ox2, oy2) => {
        ctx.beginPath();
        const steps = 8;
        ctx.moveTo(ox1, oy1);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          // Seeded deterministic sin offset prevents flickering on typing/render
          const offset = Math.sin(t * Math.PI) * (i % 2 === 0 ? 0.8 : -0.8);
          const x = ox1 + (ox2 - ox1) * t + offset;
          const y = oy1 + (oy2 - oy1) * t + offset;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      };

      // Draw main dark pass
      ctx.strokeStyle = "rgba(15, 23, 42, 0.75)"; // Slate-900
      drawOffsetLine(x1, y1, x2, y1);
      drawOffsetLine(x2, y1, x2, y2);
      drawOffsetLine(x2, y2, x1, y2);
      drawOffsetLine(x1, y2, x1, y1);

      // Draw secondary offset blue pass for a modern "architect sketch" look
      ctx.strokeStyle = "rgba(59, 130, 246, 0.4)";
      drawOffsetLine(x1 - 1, y1 + 0.5, x2 + 1, y1 + 0.5);
      drawOffsetLine(x2 + 0.5, y1 - 1, x2 + 0.5, y2 + 1);
      drawOffsetLine(x2 + 1, y2 - 0.5, x1 - 1, y2 - 0.5);
      drawOffsetLine(x1 - 0.5, y2 + 1, x1 - 0.5, y1 - 1);
    };

    const drawSketchedPolygonBorder = (pts) => {
      ctx.setLineDash([]);
      ctx.lineWidth = 1.2;

      const drawSketchedPath = (color, offset) => {
        ctx.strokeStyle = color;
        ctx.beginPath();
        pts.forEach((p, idx) => {
          const val = (idx % 2 === 0 ? 1 : -1) * 0.8;
          const px = p.x + val + offset;
          const py = p.y - val + offset;
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.stroke();
      };

      drawSketchedPath("rgba(15, 23, 42, 0.75)", 0);
      drawSketchedPath("rgba(59, 130, 246, 0.4)", 0.5);
    };

    // Draw existing shapes
    shapes.forEach((shape) => {
      ctx.beginPath();
      let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
      let minX = dimensions.width, maxX = 0, minY = dimensions.height, maxY = 0;
      
      if (shape.type === "rect") {
        x1 = shape.start.x * dimensions.width;
        y1 = shape.start.y * dimensions.height;
        x2 = shape.end.x * dimensions.width;
        y2 = shape.end.y * dimensions.height;
        ctx.rect(x1, y1, x2 - x1, y2 - y1);
      } else if (shape.type === "freeform") {
        shape.points.forEach((p, idx) => {
          const px = p.x * dimensions.width;
          const py = p.y * dimensions.height;
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
          
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        });
        ctx.closePath();
      }

      // Draw white striped pattern (completely covering old content)
      ctx.fillStyle = pattern;
      ctx.fill();

      // Draw sketched selection borders
      if (shape.type === "rect") {
        drawSketchedRectBorder(x1, y1, x2, y2);
      } else if (shape.type === "freeform") {
        const pts = shape.points.map(p => ({ x: p.x * dimensions.width, y: p.y * dimensions.height }));
        drawSketchedPolygonBorder(pts);
      }

      // Render Comment inside the selection space (word-wrapped to fit, not bold)
      if (shape.comment) {
        ctx.font = "11px Inter, system-ui, sans-serif";
        ctx.fillStyle = "#1e293b"; // Slate-800 text
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const cx = shape.type === "rect" ? (x1 + x2) / 2 : minX + (maxX - minX) / 2;
        const cy = shape.type === "rect" ? (y1 + y2) / 2 : minY + (maxY - minY) / 2;
        const w = shape.type === "rect" ? Math.abs(x2 - x1) : (maxX - minX);
        const h = shape.type === "rect" ? Math.abs(y2 - y1) : (maxY - minY);

        const maxWidth = w - 12;
        const maxHeight = h - 12;

        if (maxWidth > 12 && maxHeight > 12) {
          const words = shape.comment.split(" ");
          const lines = [];
          let currentLine = words[0] || "";
          for (let i = 1; i < words.length; i++) {
            const word = words[i];
            const width = ctx.measureText(currentLine + " " + word).width;
            if (width < maxWidth) {
              currentLine += " " + word;
            } else {
              lines.push(currentLine);
              currentLine = word;
            }
          }
          lines.push(currentLine);

          const lineHeight = 14;
          const totalHeight = lines.length * lineHeight;

          // Cap lines if they exceed vertical height limit
          let renderLines = lines;
          if (totalHeight > maxHeight) {
            const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight));
            renderLines = lines.slice(0, maxLines);
            if (renderLines.length < lines.length) {
              renderLines[renderLines.length - 1] += "...";
            }
          }

          const startY = cy - ((renderLines.length - 1) * lineHeight) / 2;

          // Draw small semi-transparent backing so stripes don't interfere with readability
          ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
          const maxTextW = Math.min(maxWidth + 8, Math.max(...renderLines.map(l => ctx.measureText(l).width)) + 8);
          const bgH = renderLines.length * lineHeight + 4;
          ctx.fillRect(cx - maxTextW / 2, cy - bgH / 2, maxTextW, bgH);

          // Draw text lines
          ctx.fillStyle = "#1e293b";
          renderLines.forEach((line, idx) => {
            ctx.fillText(line, cx, startY + idx * lineHeight);
          });
        }
      }
    });

    // Draw active drawing shape (with dash line marching ants)
    if (isDrawing && points.length > 0) {
      ctx.beginPath();
      if (mode === "rect" && points.length === 2) {
        const [start, end] = points;
        ctx.rect(start.x, start.y, end.x - start.x, end.y - start.y);
      } else if (mode === "freeform") {
        points.forEach((p, idx) => {
          if (idx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
      }

      ctx.fillStyle = "rgba(59, 130, 246, 0.1)";
      ctx.fill();
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
    }
  }, [shapes, points, isDrawing, dimensions, mode, imageLoaded]);

  const getMousePos = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();

    const clientX = e.clientX ?? (e.touches && e.touches[0]?.clientX);
    const clientY = e.clientY ?? (e.touches && e.touches[0]?.clientY);

    return {
      x: Math.max(0, Math.min(clientX - rect.left, dimensions.width)),
      y: Math.max(0, Math.min(clientY - rect.top, dimensions.height)),
    };
  };

  const handleStart = (e) => {
    if (showCommentModal) return;
    e.preventDefault();
    const pos = getMousePos(e);
    setIsDrawing(true);
    if (mode === "rect") {
      setPoints([pos, pos]);
    } else {
      setPoints([pos]);
    }
  };

  const handleMove = (e) => {
    if (!isDrawing || showCommentModal) return;
    const pos = getMousePos(e);
    if (mode === "rect") {
      setPoints(([start]) => [start, pos]);
    } else {
      setPoints((prev) => [...prev, pos]);
    }
  };

  const handleEnd = () => {
    if (!isDrawing || showCommentModal) return;
    setIsDrawing(false);

    if (mode === "rect" && points.length === 2) {
      const [start, end] = points;
      const dx = Math.abs(end.x - start.x);
      const dy = Math.abs(end.y - start.y);
      if (dx < 6 || dy < 6) return;

      const relStart = { x: start.x / dimensions.width, y: start.y / dimensions.height };
      const relEnd = { x: end.x / dimensions.width, y: end.y / dimensions.height };

      setTempShape({
        type: "rect",
        start: relStart,
        end: relEnd,
      });
      setCommentInput("");
      setShowCommentModal(true);
    } else if (mode === "freeform" && points.length > 2) {
      const relPoints = points.map((p) => ({
        x: p.x / dimensions.width,
        y: p.y / dimensions.height,
      }));

      setTempShape({
        type: "freeform",
        points: relPoints,
      });
      setCommentInput("");
      setShowCommentModal(true);
    }
    setPoints([]);
  };

  const handleConfirmComment = () => {
    if (!tempShape) return;
    setShapes((prev) => [
      ...prev,
      { ...tempShape, comment: commentInput.trim() || "Edited region" },
    ]);
    setTempShape(null);
    setShowCommentModal(false);
  };

  const handleCancelComment = () => {
    // Discard shape if user cancels comment modal
    setTempShape(null);
    setShowCommentModal(false);
  };

  const handleExport = () => {
    if (shapes.length === 0) return;

    const img = imgRef.current;
    if (!img) return;

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = img.naturalWidth;
    exportCanvas.height = img.naturalHeight;
    const ctx = exportCanvas.getContext("2d");

    // 1. Fill background with fully opaque white (alpha = 255)
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

    // 2. Set globalCompositeOperation to destination-out to erase selection shapes (making them fully transparent)
    ctx.globalCompositeOperation = "destination-out";

    shapes.forEach((shape) => {
      ctx.beginPath();
      if (shape.type === "rect") {
        const x1 = shape.start.x * exportCanvas.width;
        const y1 = shape.start.y * exportCanvas.height;
        const x2 = shape.end.x * exportCanvas.width;
        const y2 = shape.end.y * exportCanvas.height;
        ctx.rect(x1, y1, x2 - x1, y2 - y1);
      } else if (shape.type === "freeform") {
        shape.points.forEach((p, idx) => {
          const px = p.x * exportCanvas.width;
          const py = p.y * exportCanvas.height;
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
      }
      ctx.fill();
    });

    // 3. Output as blob and save
    exportCanvas.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], "mask.png", { type: "image/png" });
        onSave(file);
      }
    }, "image/png");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative flex w-full max-w-3xl flex-col rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h3 className="text-lg font-semibold text-text-main">Edit Image Mask</h3>
            <p className="text-xs text-text-muted mt-0.5">
              Draw regions to replace or modify. Preserved areas remain untouched.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="rounded-full p-1 text-text-muted hover:bg-sidebar hover:text-text-main transition-colors"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* Workspace Canvas */}
        <div className="flex flex-col items-center justify-center bg-sidebar/40 p-6 min-h-[300px]">
          <div
            ref={containerRef}
            className="relative select-none overflow-hidden rounded-lg border border-border bg-sidebar shadow-md"
            style={{
              width: dimensions.width ? `${dimensions.width}px` : "auto",
              height: dimensions.height ? `${dimensions.height}px` : "auto",
            }}
          >
            {imageUrl && (
              <img
                ref={imgRef}
                src={imageUrl}
                alt="Mask Source"
                onLoad={handleImageLoad}
                className="pointer-events-none max-w-full"
                style={{
                  width: dimensions.width ? `${dimensions.width}px` : "auto",
                  height: dimensions.height ? `${dimensions.height}px` : "auto",
                }}
              />
            )}
            
            {imageLoaded && (
              <canvas
                ref={canvasRef}
                width={dimensions.width}
                height={dimensions.height}
                onMouseDown={handleStart}
                onMouseMove={handleMove}
                onMouseUp={handleEnd}
                onTouchStart={handleStart}
                onTouchMove={handleMove}
                onTouchEnd={handleEnd}
                className="absolute inset-0 cursor-crosshair touch-none"
              />
            )}

            {!imageLoaded && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-text-muted">
                Loading image...
              </div>
            )}
          </div>
        </div>

        {/* Toolbar & Controls */}
        <div className="flex flex-col gap-4 border-t border-border px-6 py-4 bg-background">
          <div className="flex flex-wrap items-center justify-between gap-3">
            
            {/* Draw Mode Selectors */}
            <div className="flex items-center gap-1.5 rounded-lg bg-sidebar p-1 border border-border">
              <button
                type="button"
                onClick={() => setMode("rect")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === "rect"
                    ? "bg-white dark:bg-white/10 text-text-main shadow-sm"
                    : "text-text-muted hover:text-text-main"
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">
                  rectangle
                </span>
                Rectangle
              </button>
              <button
                type="button"
                onClick={() => setMode("freeform")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === "freeform"
                    ? "bg-white dark:bg-white/10 text-text-main shadow-sm"
                    : "text-text-muted hover:text-text-main"
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">
                  draw
                </span>
                Freeform
              </button>
            </div>

            {/* Editing actions */}
            <div className="flex items-center gap-2">
              <Button
                onClick={() => setShapes([])}
                variant="ghost"
                size="sm"
                disabled={shapes.length === 0}
              >
                Clear All
              </Button>
              <Button onClick={onCancel} variant="ghost" size="sm">
                Cancel
              </Button>
              <Button
                onClick={handleExport}
                size="sm"
                disabled={shapes.length === 0}
              >
                Save Mask
              </Button>
            </div>

          </div>
        </div>

        {/* Inline comment Modal overlay (inside Canvas parent container, focused and beautiful) */}
        {showCommentModal && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[1px] p-4">
            <div className="w-full max-w-sm rounded-lg border border-border bg-background p-4 shadow-xl">
              <h4 className="text-sm font-semibold text-text-main mb-1">Add Mask Comment</h4>
              <p className="text-xs text-text-muted mb-3">
                Describe what the model should replace/generate in this specific selected area.
              </p>
              <input
                type="text"
                value={commentInput}
                onChange={(e) => setCommentInput(e.target.value)}
                placeholder="e.g. inflatable flamingo, text logo, etc."
                className="mb-4 w-full rounded-md border border-border bg-sidebar px-3 py-2 text-xs text-text-main focus:border-primary focus:outline-none"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleConfirmComment();
                  if (e.key === "Escape") handleCancelComment();
                }}
              />
              <div className="flex justify-end gap-2">
                <Button onClick={handleCancelComment} variant="ghost" size="xs">
                  Discard
                </Button>
                <Button onClick={handleConfirmComment} size="xs">
                  Confirm
                </Button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
