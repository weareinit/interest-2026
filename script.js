const canvas = document.getElementById("x-scene");
const ctx = canvas.getContext("2d", { alpha: true });
const DEFAULT_OUTLINE_METRICS = {
  minX: 0,
  minY: 0,
  width: 103,
  height: 123,
  centerX: 101.5,
  centerY: 111.5
};
let xOutlineMetrics = Object.freeze({ ...DEFAULT_OUTLINE_METRICS });
let xOutlinePath = null;
let xOutlineOuterPath = null;
let xPrimaryMetrics = Object.freeze({ ...DEFAULT_OUTLINE_METRICS });
let xPrimaryOuterPath = null;
let xPrimaryParts = [];

const portalConfig = {
  layerCount: 7,
  motionDelayMs: 90,
  shapeWidthScale: 1.0,
  shapeHeightScale: 1.0,
  topLeftPad: -10,
  offsetStepXFactor: 0.09,
  offsetStepYFactor: 0,
  innerScaleStart: 0.63,
  innerScaleDecay: 0.6825,
  innerAlphaStart: 0.8,
  innerAlphaDecay: 0.625,
  innerMotionXStart: 0.34,
  innerMotionXStep: 0.18,
  innerMotionYStart: 0.22,
  innerMotionYStep: 0.12,
  innerAngleFactor: 0.00035,
  minStroke: 2.1,
  strokeDecay: 0.78,
  glitchDurationMs: 180,
  glitchMaxOffsetPx: 18,
  glitchMaxAngle: 0.11,
  glitchLayerVariance: 0.18,
  glitchChromaticSplitPx: 10,
  glitchChromaticAlpha: 0.65,
  glitchChromaticColorA: "#ff365b",
  glitchChromaticColorB: "#2ee6ff",
  colorBurstPalette: ["#ff315f", "#ff8b2a", "#ffe75b", "#4eff88", "#2ee6ff", "#6e7bff", "#c66bff"],
  colorBurstSegmentMs: 85,
  color: "#6FA8DD"
};

// const CLICK_BEHAVIORS = {
//   COLOR_FLIP: "color-flip",
//   GLITCH: "glitch"
// };

const scene = {
  width: 0,
  height: 0,
  pointer: { x: 0, y: 0 },
  pointerTarget: { x: 0, y: 0 },
  isPointerHeld: false,
  tick: 0,
  useIdle: false,
  reduceMotion: false,
  // glitchUntilMs: 0,
  colorFlipStartMs: 0,
  colorBurstActive: false,
  currentStrokeColor: "#6FA8DD",
  // clickBehavior: CLICK_BEHAVIORS.COLOR_FLIP,
  motionHistory: [],
  shapes: []
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothStep(current, target, easing) {
  return current + (target - current) * easing;
}

function setXOutlineMetrics({ minX, minY, width, height }) {
  xOutlineMetrics = Object.freeze({
    minX,
    minY,
    width,
    height,
    centerX: minX + width * 0.5,
    centerY: minY + height * 0.5
  });
}

function computePathBounds(pathData) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", pathData);
  svg.appendChild(path);

  svg.style.position = "absolute";
  svg.style.visibility = "hidden";
  svg.style.pointerEvents = "none";
  svg.style.width = "0";
  svg.style.height = "0";
  svg.style.overflow = "visible";

  document.body.appendChild(svg);
  const box = path.getBBox();
  svg.remove();

  return box;
}

function getMetricsFromSvg(svgRoot, fallbackMetrics, bboxPathData) {
  const viewBoxAttr = svgRoot.getAttribute("viewBox");

  let minX = 0;
  let minY = 0;
  let width = fallbackMetrics.width;
  let height = fallbackMetrics.height;

  if (viewBoxAttr) {
    const vb = viewBoxAttr.trim().split(/\s+/).map(Number);
    if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
      minX = vb[0];
      minY = vb[1];
      width = vb[2];
      height = vb[3];
    }
  }

  try {
    const bbox = computePathBounds(bboxPathData);
    if (bbox.width > 0 && bbox.height > 0) {
      minX = bbox.x;
      minY = bbox.y;
      width = bbox.width;
      height = bbox.height;
    }
  } catch (error) {
    console.warn("Falling back to viewBox sizing", error);
  }

  return Object.freeze({
    minX,
    minY,
    width,
    height,
    centerX: minX + width * 0.5,
    centerY: minY + height * 0.5
  });
}

function getDelayedMotion(delayMs, fallbackX, fallbackY) {
  const history = scene.motionHistory;
  if (history.length === 0 || delayMs <= 0) {
    return { x: fallbackX, y: fallbackY };
  }

  const targetTime = performance.now() - delayMs;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].t <= targetTime) {
      return { x: history[i].x, y: history[i].y };
    }
  }

  return { x: history[0].x, y: history[0].y };
}

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  const normalized = value.length === 3
    ? value.split("").map((c) => c + c).join("")
    : value;

  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return { r: 111, g: 168, b: 221 };
  }

  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16)
  };
}

function interpolateHexColor(fromHex, toHex, t) {
  const from = hexToRgb(fromHex);
  const to = hexToRgb(toHex);
  const mix = clamp(t, 0, 1);
  const r = Math.round(from.r + (to.r - from.r) * mix);
  const g = Math.round(from.g + (to.g - from.g) * mix);
  const b = Math.round(from.b + (to.b - from.b) * mix);
  return `rgb(${r}, ${g}, ${b})`;
}

function getColorBurstColor(now) {
  const sequence = [portalConfig.color, ...portalConfig.colorBurstPalette, portalConfig.color];
  if (sequence.length < 2) {
    return portalConfig.color;
  }

  const segmentMs = Math.max(1, portalConfig.colorBurstSegmentMs);
  const segmentCount = sequence.length - 1;
  const totalDuration = segmentCount * segmentMs;
  const elapsed = now - scene.colorFlipStartMs;

  if (!scene.colorBurstActive || elapsed <= 0) {
    return portalConfig.color;
  }

  if (scene.isPointerHeld) {
    const loopElapsed = elapsed % totalDuration;
    const segmentPosition = loopElapsed / segmentMs;
    const segmentIndex = Math.floor(segmentPosition);
    const segmentT = segmentPosition - segmentIndex;

    return interpolateHexColor(sequence[segmentIndex], sequence[segmentIndex + 1], segmentT);
  }

  if (elapsed >= totalDuration) {
    scene.colorBurstActive = false;
    return portalConfig.color;
  }

  const segmentPosition = elapsed / segmentMs;
  const segmentIndex = Math.floor(segmentPosition);
  const segmentT = segmentPosition - segmentIndex;

  return interpolateHexColor(sequence[segmentIndex], sequence[segmentIndex + 1], segmentT);
}

async function loadXOutlinePath() {
  const [echoResponse, primaryResponse] = await Promise.all([
    fetch("assets/Vector.svg"),
    fetch("assets/Vector-w-text.svg")
  ]);

  if (!echoResponse.ok) {
    throw new Error(`Failed to load Vector.svg: ${echoResponse.status}`);
  }
  if (!primaryResponse.ok) {
    throw new Error(`Failed to load Vector-w-text.svg: ${primaryResponse.status}`);
  }

  const [echoText, primaryText] = await Promise.all([echoResponse.text(), primaryResponse.text()]);

  const echoDoc = new DOMParser().parseFromString(echoText, "image/svg+xml");
  const primaryDoc = new DOMParser().parseFromString(primaryText, "image/svg+xml");

  const echoPathNode = echoDoc.querySelector("path[d]");
  if (!echoPathNode) {
    throw new Error("No path found in Vector.svg");
  }

  const primaryPathNodes = Array.from(primaryDoc.querySelectorAll("path[d]"));
  if (primaryPathNodes.length === 0) {
    throw new Error("No paths found in Vector-w-text.svg");
  }

  const echoD = echoPathNode.getAttribute("d") || "";
  const echoFirstClose = echoD.search(/[zZ]/);
  const echoOuterD = echoFirstClose === -1 ? echoD : echoD.slice(0, echoFirstClose + 1);

  const primaryOuterD = primaryPathNodes[0].getAttribute("d") || "";
  const primaryFirstClose = primaryOuterD.search(/[zZ]/);
  const primaryOuterClosed =
    primaryFirstClose === -1 ? primaryOuterD : primaryOuterD.slice(0, primaryFirstClose + 1);

  const echoMetrics = getMetricsFromSvg(echoDoc.documentElement, DEFAULT_OUTLINE_METRICS, echoD);
  const primaryMetrics = getMetricsFromSvg(
    primaryDoc.documentElement,
    DEFAULT_OUTLINE_METRICS,
    primaryOuterD
  );

  setXOutlineMetrics({
    minX: echoMetrics.minX,
    minY: echoMetrics.minY,
    width: echoMetrics.width,
    height: echoMetrics.height
  });

  xPrimaryMetrics = primaryMetrics;
  xPrimaryOuterPath = new Path2D(primaryOuterClosed);
  xPrimaryParts = primaryPathNodes.map((node) => {
    const d = node.getAttribute("d") || "";
    const fill = node.getAttribute("fill") || "none";
    const stroke = node.getAttribute("stroke") || "none";
    const strokeWidth = Number(node.getAttribute("stroke-width") || "1");
    return {
      path: new Path2D(d),
      fill,
      stroke,
      strokeWidth: Number.isFinite(strokeWidth) ? strokeWidth : 1
    };
  });

  xOutlinePath = new Path2D(echoD);
  xOutlineOuterPath = new Path2D(echoOuterD);
}

function createShape(centerX, centerY, width, height, options) {
  return {
    centerX,
    centerY,
    width,
    height,
    stroke: options.stroke,
    depth: options.depth,
    angle: options.angle,
    phase: options.phase,
    drift: options.drift
  };
}

function buildScene() {
  const w = scene.width;
  const h = scene.height;
  const isWide = w / h > 1.1;
  
  // Single scale factor for both dimensions to lock aspect ratio
  const baseScale = isWide ? Math.min(w, h) * 0.9 : Math.min(w, h) * 0.8;
  const baseWidth = baseScale;
  const baseHeight = baseScale;
  const shapeW = baseWidth * portalConfig.shapeWidthScale;
  const shapeH = baseHeight * portalConfig.shapeHeightScale;
  const pad = portalConfig.topLeftPad;
  scene.shapes = [
    createShape(
      shapeW * 0.5 + pad,
      shapeH * 0.5 + pad,
      shapeW,
      shapeH,
      {
        stroke: isWide ? 8.5 : 6.5,
        depth: 1,
        angle: 0,
        phase: 1.2,
        drift: 0.4
      }
    )
  ];
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();

  scene.width = rect.width;
  scene.height = rect.height;

  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  scene.pointer.x = 0;
  scene.pointer.y = 0;
  scene.pointerTarget.x = 0;
  scene.pointerTarget.y = 0;

  buildScene();
}

function createTransformedPath(path, metrics, cx, cy, width, height, angle) {
  const matrix = new DOMMatrix();
  matrix.translateSelf(cx, cy);
  matrix.rotateSelf((angle * 180) / Math.PI);
  matrix.scaleSelf(width / metrics.width, height / metrics.height);
  matrix.translateSelf(-metrics.centerX, -metrics.centerY);

  const transformed = new Path2D();
  transformed.addPath(path, matrix);
  return transformed;
}

function createTransformedXPath(cx, cy, width, height, angle) {
  return createTransformedPath(xOutlinePath, xOutlineMetrics, cx, cy, width, height, angle);
}

function createTransformedOuterXPath(cx, cy, width, height, angle) {
  return createTransformedPath(xOutlineOuterPath, xOutlineMetrics, cx, cy, width, height, angle);
}

function createTransformedPrimaryPath(path, cx, cy, width, height, angle) {
  return createTransformedPath(path, xPrimaryMetrics, cx, cy, width, height, angle);
}

function createTransformedPrimaryOuterPath(cx, cy, width, height, angle) {
  return createTransformedPath(xPrimaryOuterPath, xPrimaryMetrics, cx, cy, width, height, angle);
}

function drawPrimaryLayer(layer) {
  if (!xPrimaryParts.length) {
    return;
  }

  const sx = layer.width / xPrimaryMetrics.width;
  const sy = layer.height / xPrimaryMetrics.height;
  const scaleStroke = (sx + sy) * 0.5;

  ctx.globalAlpha = layer.alpha;

  for (const part of xPrimaryParts) {
    const transformed = createTransformedPrimaryPath(part.path, layer.cx, layer.cy, layer.width, layer.height, layer.angle);

    if (part.fill !== "none") {
      ctx.fillStyle = part.fill;
      ctx.fill(transformed, "evenodd");
    }

    if (part.stroke !== "none") {
      ctx.strokeStyle = part.stroke;
      ctx.lineWidth = Math.max(1, part.strokeWidth * scaleStroke);
      ctx.stroke(transformed);
    }
  }
}

function drawShape(shape, motionX, motionY, idleDrift, glitchAmount) {
  if (!xOutlinePath || !xOutlineOuterPath || !xPrimaryOuterPath) {
    return;
  }

  const baseOffset = shape.depth;
  const driftX = Math.sin(scene.tick * 0.001 + shape.phase) * shape.drift * idleDrift;
  const driftY = Math.cos(scene.tick * 0.0012 + shape.phase) * shape.drift * idleDrift;

  const offsetStepX = shape.width * portalConfig.offsetStepXFactor;
  const offsetStepY = shape.height * portalConfig.offsetStepYFactor;
  const layerCount = Math.max(1, Math.floor(portalConfig.layerCount));
  const layers = [];

  for (let i = 0; i < layerCount; i += 1) {
    const delayedMotion = getDelayedMotion(i * portalConfig.motionDelayMs, motionX, motionY);
    const baseCx = shape.centerX + delayedMotion.x * baseOffset + driftX;
    const baseCy = shape.centerY + delayedMotion.y * baseOffset + driftY;
    const baseAngle = shape.angle + delayedMotion.x * 0.00045 * shape.depth;

    let scale = 1;
    let alpha = 1;
    let motionMulX = 0;
    let motionMulY = 0;
    let layerAngle = baseAngle;

    if (i > 0) {
      const depth = i - 1;
      scale = portalConfig.innerScaleStart * Math.pow(portalConfig.innerScaleDecay, depth);
      alpha = portalConfig.innerAlphaStart * Math.pow(portalConfig.innerAlphaDecay, depth);
      motionMulX = portalConfig.innerMotionXStart + portalConfig.innerMotionXStep * depth;
      motionMulY = portalConfig.innerMotionYStart + portalConfig.innerMotionYStep * depth;
      layerAngle = baseAngle - delayedMotion.x * portalConfig.innerAngleFactor;
    }

    const layerCx = baseCx + offsetStepX * i - delayedMotion.x * motionMulX;
    const layerCy = baseCy + offsetStepY * i - delayedMotion.y * motionMulY;
    const layerWidth = shape.width * scale;
    const layerHeight = shape.height * scale;
    // const layerGlitchScale = glitchAmount * (1 + i * portalConfig.glitchLayerVariance);
    // const jitterX = randomRange(-portalConfig.glitchMaxOffsetPx, portalConfig.glitchMaxOffsetPx) * layerGlitchScale;
    // const jitterY = randomRange(-portalConfig.glitchMaxOffsetPx, portalConfig.glitchMaxOffsetPx) * layerGlitchScale;
    // const jitterAngle = randomRange(-portalConfig.glitchMaxAngle, portalConfig.glitchMaxAngle) * layerGlitchScale;
    // const jitteredCx = layerCx + jitterX;
    // const jitteredCy = layerCy + jitterY;
    // const jitteredAngle = layerAngle + jitterAngle;
    const jitteredCx = layerCx;
    const jitteredCy = layerCy;
    const jitteredAngle = layerAngle;
    const layerStroke =
      i === 0
        ? shape.stroke
        : Math.max(portalConfig.minStroke, shape.stroke * Math.pow(portalConfig.strokeDecay, i));

    layers.push({
      cx: jitteredCx,
      cy: jitteredCy,
      width: layerWidth,
      height: layerHeight,
      stroke: layerStroke,
      angle: jitteredAngle,
      alpha,
      color: scene.currentStrokeColor,
      path: createTransformedXPath(jitteredCx, jitteredCy, layerWidth, layerHeight, jitteredAngle),
      outerPath:
        i === 0
          ? createTransformedPrimaryOuterPath(jitteredCx, jitteredCy, layerWidth, layerHeight, jitteredAngle)
          : createTransformedOuterXPath(jitteredCx, jitteredCy, layerWidth, layerHeight, jitteredAngle)
    });
  }

  drawPrimaryLayer(layers[0]);

  let clipDepth = 0;

  for (let i = 1; i < layers.length; i += 1) {
    ctx.save();
    clipDepth += 1;
    ctx.clip(layers[i - 1].outerPath, "nonzero");

    ctx.strokeStyle = layers[i].color;
    ctx.lineWidth = layers[i].stroke;
    ctx.globalAlpha = layers[i].alpha;
    ctx.stroke(layers[i].path);

    // if (glitchAmount > 0) {
    //   const chromaScale = glitchAmount * (1 + i * portalConfig.glitchLayerVariance);
    //   const chromaSplit = portalConfig.glitchChromaticSplitPx * chromaScale;
    //   const chromaPathA = createTransformedXPath(
    //     layers[i].cx - chromaSplit,
    //     layers[i].cy,
    //     layers[i].width,
    //     layers[i].height,
    //     layers[i].angle
    //   );
    //   const chromaPathB = createTransformedXPath(
    //     layers[i].cx + chromaSplit,
    //     layers[i].cy,
    //     layers[i].width,
    //     layers[i].height,
    //     layers[i].angle
    //   );

    //   ctx.globalAlpha = layers[i].alpha * portalConfig.glitchChromaticAlpha;
    //   ctx.strokeStyle = portalConfig.glitchChromaticColorA;
    //   ctx.stroke(chromaPathA);
    //   ctx.strokeStyle = portalConfig.glitchChromaticColorB;
    //   ctx.stroke(chromaPathB);
    // }
  }

  while (clipDepth > 0) {
    ctx.restore();
    clipDepth -= 1;
  }

  ctx.globalAlpha = 1;

//   for (let i = 1; i <= shape.nestCount; i += 1) {
//     const f = 1 - shape.step * i;
//     if (f <= 0.22) {
//       break;
//     }

//     const nestedYShift = 0;
//     drawXShape(
//       cx,
//       cy + nestedYShift,
//       shape.width * f,
//       shape.height * f,
//       Math.max(1.4, shape.stroke * (0.93 - i * 0.08)),
//       angle + i * 0.003
//     );
//   }
}

function render() {
  scene.tick += 1;

  scene.pointer.x = smoothStep(scene.pointer.x, scene.pointerTarget.x, 0.07);
  scene.pointer.y = smoothStep(scene.pointer.y, scene.pointerTarget.y, 0.07);

  ctx.clearRect(0, 0, scene.width, scene.height);

  const maxOffset = Math.min(scene.width, scene.height) * 0.3;
  const idleScale = scene.useIdle ? 1 : 0.2;
  const pointerScale = scene.reduceMotion ? 0.35 : 1;
  const motionX = scene.pointer.x * maxOffset * pointerScale;
  const motionY = scene.pointer.y * maxOffset * 0.6 * pointerScale;

  const now = performance.now();
  // let glitchAmount = 0;
  // if (scene.clickBehavior === CLICK_BEHAVIORS.GLITCH) {
  //   const glitchProgress = clamp((scene.glitchUntilMs - now) / portalConfig.glitchDurationMs, 0, 1);
  //   glitchAmount = scene.reduceMotion ? glitchProgress * 0.45 : glitchProgress;
  //   scene.currentStrokeColor = portalConfig.color;
  // } else {
  //   scene.currentStrokeColor = getColorBurstColor(now);
  // }
  const glitchAmount = 0;
  scene.currentStrokeColor = getColorBurstColor(now);

  scene.motionHistory.push({ t: now, x: motionX, y: motionY });
  const maxHistoryMs = portalConfig.motionDelayMs * Math.max(1, portalConfig.layerCount) + 250;
  while (scene.motionHistory.length > 2 && now - scene.motionHistory[0].t > maxHistoryMs) {
    scene.motionHistory.shift();
  }

  for (const shape of scene.shapes) {
    drawShape(shape, motionX, motionY, idleScale, glitchAmount);
  }

  requestAnimationFrame(render);
}

function onPointerMove(event) {
  if (scene.useIdle) {
    return;
  }

  const normX = (event.clientX / scene.width) * 2 - 1;
  const normY = (event.clientY / scene.height) * 2 - 1;

  scene.pointerTarget.x = clamp(normX, -1, 1);
  scene.pointerTarget.y = clamp(normY, -1, 1);
}

function onPointerDown() {
  // if (scene.clickBehavior === CLICK_BEHAVIORS.GLITCH) {
  //   scene.glitchUntilMs = performance.now() + portalConfig.glitchDurationMs;
  //   return;
  // }

  scene.isPointerHeld = true;
  scene.colorBurstActive = true;
  scene.colorFlipStartMs = performance.now();
}

function onPointerUp() {
  scene.isPointerHeld = false;
}

// function onKeyDown(event) {
//   if (event.key.toLowerCase() !== "p") {
//     return;
//   }

//   scene.clickBehavior =
//     scene.clickBehavior === CLICK_BEHAVIORS.COLOR_FLIP
//       ? CLICK_BEHAVIORS.GLITCH
//       : CLICK_BEHAVIORS.COLOR_FLIP;

//   console.info(`Click behavior: ${scene.clickBehavior}`);
// }

function setupNotifyButtons() {
  const buttons = document.querySelectorAll(".notify-btn");

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      button.classList.remove("is-clicked");
      void button.offsetWidth;
      button.classList.add("is-clicked");
    });

    button.addEventListener("animationend", () => {
      button.classList.remove("is-clicked");
    });
  });
}

function setupRetroPreviewButtons() {
  const buttons = document.querySelectorAll(".concept-retro .btn");

  buttons.forEach((button) => {
    button.addEventListener("mousedown", () => {
      button.classList.add("btn-active");
    });

    button.addEventListener("mouseup", () => {
      button.classList.remove("btn-active");
    });

    button.addEventListener("mouseleave", () => {
      button.classList.remove("btn-center", "btn-right", "btn-left", "btn-active");
    });

    button.addEventListener("mousemove", (event) => {
      const leftOffset = button.getBoundingClientRect().left;
      const buttonWidth = button.offsetWidth;
      const pointerX = event.pageX;

      let nextClass = "btn-center";
      if (pointerX < leftOffset + 0.3 * buttonWidth) {
        nextClass = "btn-left";
      } else if (pointerX > leftOffset + 0.65 * buttonWidth) {
        nextClass = "btn-right";
      }

      button.classList.remove("btn-center", "btn-right", "btn-left");
      button.classList.add(nextClass);
    });
  });
}

function setInteractionMode() {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarsePointer = window.matchMedia("(hover: none), (pointer: coarse)").matches;

  scene.reduceMotion = prefersReducedMotion;
  scene.useIdle = coarsePointer;

  if (scene.useIdle) {
    scene.pointerTarget.x = 0;
    scene.pointerTarget.y = 0;
  }
}

window.addEventListener("resize", resize);
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerdown", onPointerDown);
window.addEventListener("pointerup", onPointerUp);
window.addEventListener("pointercancel", onPointerUp);
// window.addEventListener("keydown", onKeyDown);
window.matchMedia("(hover: none), (pointer: coarse)").addEventListener("change", setInteractionMode);
window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", setInteractionMode);

setInteractionMode();
resize();
setupNotifyButtons();
// setupRetroPreviewButtons();
loadXOutlinePath().catch((error) => {
  console.error(error);
});
requestAnimationFrame(render);
