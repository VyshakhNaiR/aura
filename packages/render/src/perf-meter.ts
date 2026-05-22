/**
 * DOM-based HUD: fps / frame-ms / gpu / bpm + a beat dot.
 * Pre-creates Text nodes and a Web Animations Animation for the beat
 * pulse — zero allocations on every-frame tick().
 */
export class PerfMeter {
  readonly element: HTMLDivElement;
  private readonly fpsText: Text;
  private readonly frameMsText: Text;
  private readonly gpuText: Text;
  private readonly bpmText: Text;
  private readonly beatDot: HTMLDivElement;

  private frameCount = 0;
  private windowStart = 0;
  private lastFrameMs = 0;
  private smoothedFrameMs = 16.67;

  constructor() {
    const el = document.createElement("div");
    el.style.cssText = [
      "position:fixed",
      "top:8px",
      "right:10px",
      "z-index:50",
      "font:11px/1.4 ui-monospace,Menlo,Consolas,monospace",
      "color:#a8ffce",
      "background:rgba(0,0,0,0.45)",
      "padding:6px 10px 6px 28px",
      "border:1px solid rgba(168,255,206,0.25)",
      "border-radius:6px",
      "letter-spacing:0.04em",
      "pointer-events:none",
      "user-select:none",
      "backdrop-filter:blur(6px)",
      "-webkit-backdrop-filter:blur(6px)",
      "min-width:170px",
    ].join(";");

    const mk = (label: string, value: string): Text => {
      const row = document.createElement("div");
      const lbl = document.createElement("span");
      lbl.textContent = label;
      lbl.style.opacity = "0.6";
      lbl.style.marginRight = "6px";
      const txt = document.createTextNode(value);
      row.appendChild(lbl);
      row.appendChild(txt);
      el.appendChild(row);
      return txt;
    };

    this.fpsText = mk("fps", "—");
    this.frameMsText = mk("ms ", "—");
    this.gpuText = mk("gpu", "—");
    this.bpmText = mk("bpm", "—");

    this.beatDot = document.createElement("div");
    this.beatDot.style.cssText = [
      "position:absolute",
      "left:10px",
      "bottom:10px",
      "width:8px",
      "height:8px",
      "border-radius:50%",
      "background:#ff6b9d",
      "opacity:0",
      "box-shadow:0 0 8px rgba(255,107,157,0.7)",
    ].join(";");
    el.appendChild(this.beatDot);

    this.element = el;
  }

  mount(parent: HTMLElement = document.body): void {
    parent.appendChild(this.element);
  }

  tick(now: number): void {
    if (this.windowStart === 0) {
      this.windowStart = now;
      this.lastFrameMs = now;
      return;
    }
    const dt = now - this.lastFrameMs;
    this.lastFrameMs = now;
    this.smoothedFrameMs += (dt - this.smoothedFrameMs) * 0.05;
    this.frameCount++;

    if (now - this.windowStart >= 500) {
      const fps = (this.frameCount * 1000) / (now - this.windowStart);
      this.fpsText.nodeValue = fps.toFixed(0);
      this.frameMsText.nodeValue = this.smoothedFrameMs.toFixed(2);
      this.frameCount = 0;
      this.windowStart = now;
    }
  }

  setGpuInfo(info: string): void {
    this.gpuText.nodeValue = info;
  }

  setBpm(bpm: number, confidence: number): void {
    if (bpm > 0) {
      this.bpmText.nodeValue = `${bpm.toFixed(1)}  ${(confidence * 100).toFixed(0)}%`;
    } else {
      this.bpmText.nodeValue = "—";
    }
  }

  flashBeat(): void {
    this.beatDot.animate(
      [
        { opacity: 1, transform: "scale(1.6)" },
        { opacity: 0, transform: "scale(1)" },
      ],
      { duration: 220, easing: "ease-out", fill: "forwards" },
    );
  }
}
