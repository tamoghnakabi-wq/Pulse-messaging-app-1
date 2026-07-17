import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, ZoomOut, Check } from 'lucide-react';
import { Button } from './Button';
import { cn } from '../../utils/cn';

export type CropShape = 'circle' | 'rect';

interface Props {
  open: boolean;
  imageSrc: string | null;
  shape?: CropShape;
  /** Output width in px (height derived from aspect). */
  outputSize?: number;
  title?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (file: File) => void | Promise<void>;
}

/**
 * Image cropper.
 * Cover (rect) and avatar (circle) both keep the bitmap covering the frame
 * (object-fit: cover style) so exports never letterbox with black bars.
 */
export function ImageCropModal({
  open,
  imageSrc,
  shape = 'circle',
  outputSize,
  title,
  confirmLabel = 'Save',
  onCancel,
  onConfirm,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const zoomRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const naturalRef = useRef({ w: 0, h: 0 });

  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });

  const isCircle = shape === 'circle';
  // Cover: 3:1 banner. Avatar: 1:1.
  const aspect = isCircle ? 1 : 3;
  const viewW = isCircle ? 280 : 336;
  const viewH = Math.round(viewW / aspect);
  const outW = outputSize ?? (isCircle ? 512 : 1500);
  const outH = isCircle ? outW : Math.round(outW / aspect);
  const dialogTitle =
    title ?? (isCircle ? 'Crop profile photo' : 'Crop cover photo');

  /** Minimum scale so the image fully covers the frame (no empty bars). */
  const coverScale = (nw: number, nh: number) => {
    if (nw <= 0 || nh <= 0) return 1;
    return Math.max(viewW / nw, viewH / nh);
  };

  const clampOffset = (x: number, y: number, z: number, nw: number, nh: number) => {
    const drawW = nw * z;
    const drawH = nh * z;
    const maxX = Math.max(0, (drawW - viewW) / 2);
    const maxY = Math.max(0, (drawH - viewH) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  };

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);
  useEffect(() => {
    naturalRef.current = natural;
  }, [natural]);

  useEffect(() => {
    if (!open || !imageSrc) {
      setReady(false);
      imgRef.current = null;
      return;
    }
    let cancelled = false;
    setReady(false);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    zoomRef.current = 1;
    offsetRef.current = { x: 0, y: 0 };

    const img = new Image();
    // Decode for correct orientation when browser supports it
    img.decoding = 'async';
    img.onload = () => {
      if (cancelled) return;
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      if (!nw || !nh) {
        setReady(false);
        return;
      }
      imgRef.current = img;
      naturalRef.current = { w: nw, h: nh };
      setNatural({ w: nw, h: nh });
      const z = coverScale(nw, nh);
      zoomRef.current = z;
      offsetRef.current = { x: 0, y: 0 };
      setZoom(z);
      setOffset({ x: 0, y: 0 });
      setReady(true);
    };
    img.onerror = () => {
      if (!cancelled) setReady(false);
    };
    img.src = imageSrc;
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, imageSrc, shape, viewW, viewH]);

  /** Draw image to a 2d context for a given output size (preview or export). */
  const paintImage = (
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    destW: number,
    destH: number,
    z: number,
    ox: number,
    oy: number,
    nw: number,
    nh: number
  ) => {
    // Scale pan/zoom from view coordinates → destination coordinates
    const sx = destW / viewW;
    const sy = destH / viewH;
    const drawW = nw * z * sx;
    const drawH = nh * z * sy;
    const dx = ((viewW - nw * z) / 2 + ox) * sx;
    const dy = ((viewH - nh * z) / 2 + oy) * sy;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Draw full bitmap transformed — always covers dest when z >= coverScale
    ctx.drawImage(img, dx, dy, drawW, drawH);
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !ready || !natural.w) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(viewW * dpr));
    canvas.height = Math.max(1, Math.round(viewH * dpr));
    canvas.style.width = `${viewW}px`;
    canvas.style.height = `${viewH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);

    // Neutral fill only behind (should never show once image covers)
    ctx.fillStyle = '#1c1c1e';
    ctx.fillRect(0, 0, viewW, viewH);

    paintImage(ctx, img, viewW, viewH, zoom, offset.x, offset.y, natural.w, natural.h);

    if (isCircle) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.rect(0, 0, viewW, viewH);
      ctx.arc(viewW / 2, viewH / 2, Math.min(viewW, viewH) / 2 - 2, 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(viewW / 2, viewH / 2, Math.min(viewW, viewH) / 2 - 2, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.strokeRect(1.5, 1.5, viewW - 3, viewH - 3);
    }
  }, [ready, zoom, offset, natural, isCircle, viewW, viewH]);

  useEffect(() => {
    draw();
  }, [draw]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      ox: offsetRef.current.x,
      oy: offsetRef.current.y,
    };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    e.preventDefault();
    const nw = naturalRef.current.w;
    const nh = naturalRef.current.h;
    const next = clampOffset(
      d.ox + (e.clientX - d.x),
      d.oy + (e.clientY - d.y),
      zoomRef.current,
      nw,
      nh
    );
    offsetRef.current = next;
    setOffset(next);
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const applyZoom = (next: number) => {
    const nw = naturalRef.current.w;
    const nh = naturalRef.current.h;
    if (!nw) return;
    const zMin = coverScale(nw, nh);
    const zMax = zMin * 4;
    const z = Math.max(zMin, Math.min(zMax, next));
    const o = clampOffset(offsetRef.current.x, offsetRef.current.y, z, nw, nh);
    zoomRef.current = z;
    offsetRef.current = o;
    setZoom(z);
    setOffset(o);
  };

  const exportCrop = async () => {
    const img = imgRef.current;
    const nw = naturalRef.current.w;
    const nh = naturalRef.current.h;
    if (!img || !ready || !nw) return;
    setSaving(true);
    try {
      // Ensure we never export below cover scale (guards against stale zoom)
      const zMin = coverScale(nw, nh);
      const z = Math.max(zoomRef.current, zMin);
      const o = clampOffset(offsetRef.current.x, offsetRef.current.y, z, nw, nh);

      const out = document.createElement('canvas');
      out.width = outW;
      out.height = outH;
      const ctx = out.getContext('2d');
      if (!ctx) throw new Error('No canvas');

      if (isCircle) {
        // Export a full square JPEG — UI clips to circle. Avoids transparent
        // PNG corners compositing as a black square on some backgrounds.
        paintImage(ctx, img, outW, outH, z, o.x, o.y, nw, nh);
        const blob = await new Promise<Blob | null>((resolve) =>
          out.toBlob(resolve, 'image/jpeg', 0.92)
        );
        if (!blob) throw new Error('Export failed');
        await onConfirm(new File([blob], `avatar-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      } else {
        // WYSIWYG: same transform as preview, scaled to outW×outH — no black fill
        paintImage(ctx, img, outW, outH, z, o.x, o.y, nw, nh);
        const blob = await new Promise<Blob | null>((resolve) =>
          out.toBlob(resolve, 'image/jpeg', 0.92)
        );
        if (!blob) throw new Error('Export failed');
        await onConfirm(new File([blob], `cover-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      }
    } finally {
      setSaving(false);
    }
  };

  if (!open || !imageSrc) return null;

  const zMin = natural.w ? coverScale(natural.w, natural.h) : 1;
  const zMax = zMin * 4;
  const zoomPct = natural.w
    ? Math.round(((zoom - zMin) / (zMax - zMin || 1)) * 100)
    : 0;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 md:bg-black/60 md:backdrop-blur-[4px]"
        aria-label="Close crop"
        onClick={onCancel}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={dialogTitle}
        className="relative z-10 w-full max-w-sm overflow-hidden rounded-3xl border border-white/10 bg-[var(--color-surface-elevated)] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="text-[15px] font-semibold tracking-[-0.02em]">{dialogTitle}</h2>
          <button
            type="button"
            className="pressable flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-ink-secondary)] hover:bg-black/5 dark:hover:bg-white/5"
            onClick={onCancel}
            aria-label="Cancel"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-4 px-4 py-5">
          <p className="text-center text-xs text-[var(--color-ink-secondary)]">
            {isCircle
              ? 'Drag to position. Profile photos are always circular.'
              : 'Drag to position. The full banner is filled — no black bars.'}
          </p>

          <div
            className={cn(
              'relative touch-none select-none overflow-hidden shadow-inner',
              isCircle ? 'rounded-full' : 'rounded-xl'
            )}
            style={{ width: viewW, height: viewH, background: '#1c1c1e' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <canvas ref={canvasRef} className="pointer-events-none block h-full w-full" />
            {!ready && (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-white/60">
                Loading…
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              className="pressable flex h-10 w-10 items-center justify-center rounded-full bg-black/5 dark:bg-white/10"
              onClick={() => applyZoom(zoom - (zMax - zMin) * 0.08)}
              aria-label="Zoom out"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={zoomPct}
              onChange={(e) => {
                const t = Number(e.target.value) / 100;
                applyZoom(zMin + t * (zMax - zMin));
              }}
              className="w-32 accent-pulse-500"
              aria-label="Zoom"
            />
            <button
              type="button"
              className="pressable flex h-10 w-10 items-center justify-center rounded-full bg-black/5 dark:bg-white/10"
              onClick={() => applyZoom(zoom + (zMax - zMin) * 0.08)}
              aria-label="Zoom in"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
          </div>

          <div className="flex w-full gap-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="button"
              className="flex-1"
              loading={saving}
              disabled={!ready}
              onClick={() => void exportCrop()}
            >
              <Check className="h-4 w-4" />
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
