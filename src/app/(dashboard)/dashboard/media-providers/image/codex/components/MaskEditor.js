"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/shared/components";


// Helper to draw annotated shapes on a 2D canvas context
function drawShapesOnCanvas(ctx, width, height, shapes, scaleFactor) {
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

  // Sketched border helper (scaled by scaleFactor)
  const drawSketchedRectBorder = (x1, y1, x2, y2) => {
    ctx.setLineDash([]);
    ctx.lineWidth = 1.2 * Math.max(0.8, scaleFactor * 0.7);
    
    const drawOffsetLine = (ox1, oy1, ox2, oy2) => {
      ctx.beginPath();
      const steps = 8;
      ctx.moveTo(ox1, oy1);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const offset = Math.sin(t * Math.PI) * (i % 2 === 0 ? 0.8 : -0.8) * Math.max(0.6, scaleFactor * 0.8);
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

  // Draw existing shapes
  shapes.forEach((shape) => {
    ctx.beginPath();
    const x1 = shape.start.x * width;
    const y1 = shape.start.y * height;
    const x2 = shape.end.x * width;
    const y2 = shape.end.y * height;
    ctx.rect(x1, y1, x2 - x1, y2 - y1);

    // Draw white striped pattern (completely covering old content)
    ctx.fillStyle = pattern;
    ctx.fill();

    // Draw sketched selection borders
    drawSketchedRectBorder(x1, y1, x2, y2);

    // Render Comment inside the selection space (word-wrapped to fit, not bold)
    if (shape.comment) {
      const fontSize = Math.max(8, Math.round(11 * scaleFactor));
      ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = "#1e293b"; // Slate-800 text
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);

      const padding = 12 * scaleFactor;
      const maxWidth = w - padding;
      const maxHeight = h - padding;

      if (maxWidth > 12 && maxHeight > 12) {
        const words = shape.comment.split(" ");
        const lines = [];
        let currentLine = words[0] || "";
        for (let i = 1; i < words.length; i++) {
          const word = words[i];
          const textWidth = ctx.measureText(currentLine + " " + word).width;
          if (textWidth < maxWidth) {
            currentLine += " " + word;
          } else {
            lines.push(currentLine);
            currentLine = word;
          }
        }
        lines.push(currentLine);

        const lineHeight = 14 * scaleFactor;
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

        // Draw small semi-transparent backing so stripes don't interfere with legibility
        ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
        const maxTextW = Math.min(maxWidth + 8 * scaleFactor, Math.max(...renderLines.map(l => ctx.measureText(l).width)) + 8 * scaleFactor);
        const bgH = renderLines.length * lineHeight + 4 * scaleFactor;
        ctx.fillRect(cx - maxTextW / 2, cy - bgH / 2, maxTextW, bgH);

        // Draw text lines
        ctx.fillStyle = "#1e293b";
        renderLines.forEach((line, idx) => {
          ctx.fillText(line, cx, startY + idx * lineHeight);
        });
      }
    }
  });
}

export default function MaskEditor({ imageFile, initialShapes = [], onSave, onCancel }) {
  const [imageUrl, setImageUrl] = useState("");
  const [shapes, setShapes] = useState(initialShapes || []);
  const [isDrawing, setIsDrawing] = useState(false);
  const [points, setPoints] = useState([]);
  const [commentInput, setCommentInput] = useState("");
  const [showCommentModal, setShowCommentModal] = useState(false);
  const [tempShape, setTempShape] = useState(null);
  const [zoom, setZoom] = useState(1); // Zoom scale factor (0.5 to 4)

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

    const containerWidth = containerRef.current ? containerRef.current.clientWidth : 800;
    const maxDisplayHeight = 550;
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

  // Redraw canvas content when shapes, points, drawing state, zoom, or dimensions change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageLoaded) return;
    const ctx = canvas.getContext("2d");
    
    const scaleWidth = dimensions.width * zoom;
    const scaleHeight = dimensions.height * zoom;

    ctx.clearRect(0, 0, scaleWidth, scaleHeight);

    // Draw the annotated shapes using the helper (scaled by zoom)
    drawShapesOnCanvas(ctx, scaleWidth, scaleHeight, shapes, zoom);

    // Draw active drawing shape (with dash line marching ants)
    if (isDrawing && points.length === 2) {
      ctx.beginPath();
      const [start, end] = points;
      ctx.rect(start.x, start.y, end.x - start.x, end.y - start.y);

      ctx.fillStyle = "rgba(59, 130, 246, 0.1)";
      ctx.fill();
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
    }
  }, [shapes, points, isDrawing, dimensions, imageLoaded, zoom]);

  const getMousePos = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();

    const clientX = e.clientX ?? (e.touches && e.touches[0]?.clientX);
    const clientY = e.clientY ?? (e.touches && e.touches[0]?.clientY);

    const scaleWidth = dimensions.width * zoom;
    const scaleHeight = dimensions.height * zoom;

    return {
      x: Math.max(0, Math.min(clientX - rect.left, scaleWidth)),
      y: Math.max(0, Math.min(clientY - rect.top, scaleHeight)),
    };
  };

  const handleStart = (e) => {
    if (showCommentModal) return;
    e.preventDefault();
    const pos = getMousePos(e);
    setIsDrawing(true);
    setPoints([pos, pos]);
  };

  const handleMove = (e) => {
    if (!isDrawing || showCommentModal) return;
    const pos = getMousePos(e);
    setPoints(([start]) => [start, pos]);
  };

  const handleEnd = () => {
    if (!isDrawing || showCommentModal) return;
    setIsDrawing(false);

    const scaleWidth = dimensions.width * zoom;
    const scaleHeight = dimensions.height * zoom;

    if (points.length === 2) {
      const [start, end] = points;
      const dx = Math.abs(end.x - start.x);
      const dy = Math.abs(end.y - start.y);
      if (dx < 6 || dy < 6) return;

      const relStart = { x: start.x / scaleWidth, y: start.y / scaleHeight };
      const relEnd = { x: end.x / scaleWidth, y: end.y / scaleHeight };

      setTempShape({
        type: "rect",
        start: relStart,
        end: relEnd,
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
    setTempShape(null);
    setShowCommentModal(false);
  };

  const handleExport = () => {
    if (shapes.length === 0) return;

    const img = imgRef.current;
    if (!img) return;

    // 1. Draw original image onto mask canvas and erase selection shapes (leaving transparent cutouts)
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = img.naturalWidth;
    exportCanvas.height = img.naturalHeight;
    const ctx = exportCanvas.getContext("2d");

    ctx.drawImage(img, 0, 0, exportCanvas.width, exportCanvas.height);
    ctx.globalCompositeOperation = "destination-out";

    shapes.forEach((shape) => {
      ctx.beginPath();
      const x1 = shape.start.x * exportCanvas.width;
      const y1 = shape.start.y * exportCanvas.height;
      const x2 = shape.end.x * exportCanvas.width;
      const y2 = shape.end.y * exportCanvas.height;
      ctx.rect(x1, y1, x2 - x1, y2 - y1);
      ctx.fill();
    });

    // 2. Draw original image onto annotated canvas, then draw annotations on top
    const annotatedCanvas = document.createElement("canvas");
    annotatedCanvas.width = img.naturalWidth;
    annotatedCanvas.height = img.naturalHeight;
    const actx = annotatedCanvas.getContext("2d");

    actx.drawImage(img, 0, 0, annotatedCanvas.width, annotatedCanvas.height);

    // Scale annotations relative to image natural dimensions to match visual density on screen
    const styleScale = img.naturalWidth / dimensions.width;
    drawShapesOnCanvas(actx, annotatedCanvas.width, annotatedCanvas.height, shapes, styleScale);

    // 3. Output both to blobs and callback
    exportCanvas.toBlob((maskBlob) => {
      if (maskBlob) {
        const maskFile = new File([maskBlob], "mask.png", { type: "image/png" });
        annotatedCanvas.toBlob((annotatedBlob) => {
          if (annotatedBlob) {
            const annotatedFile = new File([annotatedBlob], "annotated_image.png", { type: "image/png" });
            onSave(maskFile, shapes, annotatedFile);
          } else {
            onSave(maskFile, shapes, null);
          }
        }, "image/png");
      }
    }, "image/png");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative flex w-[90vw] h-[90vh] flex-col rounded-xl border border-border bg-background shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-3">
          <div>
            <h3 className="text-base font-semibold text-text-main">Edit Image Mask</h3>
            <p className="text-xs text-text-muted mt-0.5">
              Draw rectangular regions to replace or modify. Preserved areas remain untouched.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="rounded-full p-1 text-text-muted hover:bg-sidebar hover:text-text-main transition-colors"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>

        {/* Workspace Canvas (Scrollable viewport) */}
        <div className="flex-1 overflow-auto bg-sidebar/40 p-6 flex items-center justify-center min-h-[300px]">
          <div
            ref={containerRef}
            className="relative select-none overflow-visible rounded-lg border border-border bg-sidebar shadow-md"
            style={{
              width: dimensions.width ? `${dimensions.width * zoom}px` : "auto",
              height: dimensions.height ? `${dimensions.height * zoom}px` : "auto",
              transition: "width 0.15s ease-out, height 0.15s ease-out",
            }}
          >
            {imageUrl && (
              <img
                ref={imgRef}
                src={imageUrl}
                alt="Mask Source"
                onLoad={handleImageLoad}
                className="pointer-events-none max-w-none"
                style={{
                  width: dimensions.width ? `${dimensions.width * zoom}px` : "auto",
                  height: dimensions.height ? `${dimensions.height * zoom}px` : "auto",
                  transition: "width 0.15s ease-out, height 0.15s ease-out",
                }}
              />
            )}
            
            {imageLoaded && (
              <canvas
                ref={canvasRef}
                width={dimensions.width * zoom}
                height={dimensions.height * zoom}
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
            
            {/* Mode status */}
            <div className="flex items-center gap-1.5 rounded-lg bg-sidebar px-3 py-1.5 border border-border text-xs text-text-muted">
              <span className="material-symbols-outlined text-[14px]">
                rectangle
              </span>
              <span>Rectangle Mode Only</span>
            </div>

            {/* Zoom Controls */}
            <div className="flex items-center gap-1.5 rounded-lg bg-sidebar p-1 border border-border">
              <button
                type="button"
                onClick={() => setZoom(z => Math.max(0.5, z - 0.25))}
                className="flex items-center justify-center rounded-md p-1 text-text-muted hover:text-text-main transition-colors"
                title="Zoom Out"
              >
                <span className="material-symbols-outlined text-[16px]">zoom_out</span>
              </button>
              <span className="text-[11px] font-mono font-medium text-text-muted px-1">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setZoom(z => Math.min(4, z + 0.25))}
                className="flex items-center justify-center rounded-md p-1 text-text-muted hover:text-text-main transition-colors"
                title="Zoom In"
              >
                <span className="material-symbols-outlined text-[16px]">zoom_in</span>
              </button>
              <button
                type="button"
                onClick={() => setZoom(1)}
                className="flex items-center justify-center rounded-md p-1 text-text-muted hover:text-text-main transition-colors border-l border-border pl-2 ml-1"
                title="Reset Zoom"
              >
                <span className="material-symbols-outlined text-[16px]">restart_alt</span>
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
