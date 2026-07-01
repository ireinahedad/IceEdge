import { useLayoutEffect, useRef } from "react";

interface IceBackgroundProps {
  height?: number;
  className?: string;
}

const CW = 430;

/**
 * IceBackground — scraped-ice canvas texture (brand/login screens only).
 *
 * Structure: outer <div> owns the height (CSS fallback gradient always visible),
 * <canvas> fills it absolutely and draws the full texture on top.
 */
export function IceBackground({ height = 300, className = "" }: IceBackgroundProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = CW, H = height;

    // Seeded LCG
    let seed = 20240101;
    const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };

    // 1. Blue-ice gradient
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0.00, "#9EBCCC");
    bg.addColorStop(0.35, "#6F93A8");
    bg.addColorStop(0.70, "#4A6E82");
    bg.addColorStop(1.00, "#2E4C5C");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    // 2. Radial soft zones
    const rl = ctx.createRadialGradient(W*.18,H*.12,0, W*.18,H*.12,W*.5);
    rl.addColorStop(0,"rgba(215,233,248,0.22)"); rl.addColorStop(1,"rgba(215,233,248,0)");
    ctx.fillStyle=rl; ctx.fillRect(0,0,W,H);

    const rd = ctx.createRadialGradient(W*.78,H*.72,0, W*.78,H*.72,W*.45);
    rd.addColorStop(0,"rgba(18,42,58,0.28)"); rd.addColorStop(1,"rgba(18,42,58,0)");
    ctx.fillStyle=rd; ctx.fillRect(0,0,W,H);

    const rc = ctx.createRadialGradient(W*.5,H*.4,0, W*.5,H*.4,W*.35);
    rc.addColorStop(0,"rgba(182,212,230,0.10)"); rc.addColorStop(1,"rgba(182,212,230,0)");
    ctx.fillStyle=rc; ctx.fillRect(0,0,W,H);

    // 3. Old scratch marks
    ctx.lineCap="round";
    for (let i=0;i<140;i++){
      const x1=rng()*W,y1=rng()*H,a=rng()*Math.PI,l=15+rng()*70;
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x1+Math.cos(a)*l,y1+Math.sin(a)*l);
      ctx.strokeStyle=`rgba(255,255,255,${0.03+rng()*.04})`; ctx.lineWidth=0.4+rng()*.4; ctx.stroke();
    }

    // 4. Snow grain (3 layers)
    for (let i=0;i<3600;i++){
      ctx.beginPath(); ctx.arc(rng()*W,rng()*H,.25+rng()*.45,0,Math.PI*2);
      ctx.fillStyle=`rgba(255,255,255,${.07+rng()*.11})`; ctx.fill();
    }
    for (let i=0;i<1400;i++){
      ctx.beginPath(); ctx.arc(rng()*W,rng()*H,.5+rng()*.75,0,Math.PI*2);
      ctx.fillStyle=`rgba(255,255,255,${.17+rng()*.20})`; ctx.fill();
    }
    for (let i=0;i<450;i++){
      ctx.beginPath(); ctx.arc(rng()*W,rng()*H,.8+rng()*.9,0,Math.PI*2);
      ctx.fillStyle=`rgba(255,255,255,${.30+rng()*.35})`; ctx.fill();
    }

    // 5. Skate marks (~30, shorter)
    for (let i=0;i<30;i++){
      const sx=rng()*W, sy=rng()*H;
      const a=(rng()-.5)*Math.PI*.55+(rng()>.5?0:Math.PI);
      const len=50+rng()*100;
      const ex=sx+Math.cos(a)*len, ey=sy+Math.sin(a)*len;
      const cv=(rng()-.5)*55;
      const cpx=(sx+ex)/2+Math.sin(a)*cv, cpy=(sy+ey)/2-Math.cos(a)*cv;
      const pnx=Math.sin(a)*.9, pny=-Math.cos(a)*.9;

      const sG=ctx.createLinearGradient(sx,sy,ex,ey);
      sG.addColorStop(0,"rgba(14,38,58,0)"); sG.addColorStop(.12,"rgba(14,38,58,0.30)");
      sG.addColorStop(.88,"rgba(14,38,58,0.30)"); sG.addColorStop(1,"rgba(14,38,58,0)");

      const wG=ctx.createLinearGradient(sx,sy,ex,ey);
      wG.addColorStop(0,"rgba(255,255,255,0)"); wG.addColorStop(.10,"rgba(255,255,255,0.93)");
      wG.addColorStop(.90,"rgba(255,255,255,0.93)"); wG.addColorStop(1,"rgba(255,255,255,0)");

      ctx.beginPath(); ctx.moveTo(sx,sy); ctx.quadraticCurveTo(cpx,cpy,ex,ey);
      ctx.strokeStyle=sG; ctx.lineWidth=1.2; ctx.stroke();

      ctx.beginPath(); ctx.moveTo(sx-pnx,sy-pny); ctx.quadraticCurveTo(cpx-pnx,cpy-pny,ex-pnx,ey-pny);
      ctx.strokeStyle=wG; ctx.lineWidth=0.35; ctx.stroke();

      ctx.beginPath(); ctx.moveTo(sx+pnx,sy+pny); ctx.quadraticCurveTo(cpx+pnx,cpy+pny,ex+pnx,ey+pny);
      ctx.strokeStyle=wG; ctx.lineWidth=0.35; ctx.stroke();

      const spx=rng()>.45?ex:sx, spy=rng()>.45?ey:sy;
      for (let k=0;k<20+Math.floor(rng()*16);k++){
        const sa=rng()*Math.PI*2, sd=rng()*11;
        ctx.beginPath(); ctx.arc(spx+Math.cos(sa)*sd,spy+Math.sin(sa)*sd,.35+rng()*.75,0,Math.PI*2);
        ctx.fillStyle=`rgba(255,255,255,${.35+rng()*.48})`; ctx.fill();
      }
    }
  }, [height]);

  return (
    /*
      Outer div owns the height — its CSS gradient is always visible as a fallback.
      Canvas is absolute inside it and draws the full texture on top.
    */
    <div
      className={className}
      style={{
        position: "relative",
        height,
        flexShrink: 0,
        background: "linear-gradient(180deg,#9EBCCC 0%,#6F93A8 35%,#4A6E82 70%,#2E4C5C 100%)",
      }}
    >
      <canvas
        ref={ref}
        width={CW}
        height={height}
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
      />
    </div>
  );
}
