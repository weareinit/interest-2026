const canvas = document.getElementById("x-scene");
const ctx = canvas.getContext("2d", { alpha: true });
const layerMaskCanvas = document.createElement("canvas");
const layerMaskCtx = layerMaskCanvas.getContext("2d", { alpha: true });

const USE_PATH_TRANSFORM = (function() {
  try {
    const p = new Path2D();
    p.addPath(new Path2D(), new DOMMatrix());
    return true;
  } catch (e) {
    return false;
  }
})();
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
  topPad: -50,
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
  colorBurstPalette: ["#ff315f", "#ff8b2a", "#ffe75b", "#4eff88", "#2ee6ff", "#6e7bff", "#c66bff"],
  colorBurstSegmentMs: 200,
  idleAutoMotionAmpX: 0.22,
  idleAutoMotionAmpY: 0.16,
  idleAutoMotionSpeed: 0.00022,
  color: "#6FA8DD"
};

const scene = {
  width: 0,
  height: 0,
  pointer: { x: 0, y: 0 },
  pointerTarget: { x: 0, y: 0 },
  isPointerHeld: false,
  tick: 0,
  useIdle: false,
  reduceMotion: false,
  colorFlipStartMs: 0,
  colorBurstActive: false,
  audioPlaying: false,
  currentStrokeColor: "#6FA8DD",
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

function getColorBurstColor(now, delayMs) {
  const sequence = [portalConfig.color, ...portalConfig.colorBurstPalette, portalConfig.color];
  if (sequence.length < 2) {
    return portalConfig.color;
  }

  const segmentMs = Math.max(1, portalConfig.colorBurstSegmentMs);
  const segmentCount = sequence.length - 1;
  const totalDuration = segmentCount * segmentMs;
  const adjustedElapsed = Math.max(0, now - scene.colorFlipStartMs - delayMs);

  if (!scene.colorBurstActive || adjustedElapsed <= 0) {
    return portalConfig.color;
  }

  if (scene.isPointerHeld || scene.audioPlaying) {
    const loopElapsed = adjustedElapsed % totalDuration;
    const segmentPosition = loopElapsed / segmentMs;
    const segmentIndex = Math.floor(segmentPosition);
    const segmentT = segmentPosition - segmentIndex;

    return interpolateHexColor(sequence[segmentIndex], sequence[segmentIndex + 1], segmentT);
  }

  if (adjustedElapsed >= totalDuration) {
    scene.colorBurstActive = false;
    return portalConfig.color;
  }

  const segmentPosition = adjustedElapsed / segmentMs;
  const segmentIndex = Math.floor(segmentPosition);
  const segmentT = segmentPosition - segmentIndex;

  return interpolateHexColor(sequence[segmentIndex], sequence[segmentIndex + 1], segmentT);
}

async function loadXOutlinePath() {
  const [echoResponse, primaryResponse] = await Promise.all([
    fetch("assets/x.svg"),
    fetch("assets/x-text.svg")
  ]);

  if (!echoResponse.ok) {
    throw new Error(`Failed to load x.svg: ${echoResponse.status}`);
  }
  if (!primaryResponse.ok) {
    throw new Error(`Failed to load x-text.svg: ${primaryResponse.status}`);
  }

  const [echoText, primaryText] = await Promise.all([echoResponse.text(), primaryResponse.text()]);

  const echoDoc = new DOMParser().parseFromString(echoText, "image/svg+xml");
  const primaryDoc = new DOMParser().parseFromString(primaryText, "image/svg+xml");

  const echoPathNode = echoDoc.querySelector("path[d]");
  if (!echoPathNode) {
    throw new Error("No path found in x.svg");
  }

  const primaryPathNodes = Array.from(primaryDoc.querySelectorAll("path[d]"));
  if (primaryPathNodes.length === 0) {
    throw new Error("No paths found in x-text.svg");
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
  const minDim = Math.min(w, h);
  let baseScale = isWide ? minDim * 0.9 : minDim * 0.8;

  // On smaller screens, progressively scale up the X for better visual presence.
  const smallScreenFactor = clamp((900 - w) / 500, 0, 1);
  const mobileBoost = 1 + smallScreenFactor * 0.88;
  baseScale *= mobileBoost;

  const baseWidth = baseScale;
  const baseHeight = baseScale;
  const shapeW = baseWidth * portalConfig.shapeWidthScale;
  const shapeH = baseHeight * portalConfig.shapeHeightScale;
  const leftPad = -30 - smallScreenFactor * 170;
  const topPad = portalConfig.topPad;
  scene.shapes = [
    createShape(
      shapeW * 0.5 + leftPad,
      shapeH * 0.5 + topPad,
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

  layerMaskCanvas.width = canvas.width;
  layerMaskCanvas.height = canvas.height;
  if (layerMaskCtx) {
    layerMaskCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

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

  if (USE_PATH_TRANSFORM) {
    const transformed = new Path2D();
    transformed.addPath(path, matrix);
    return transformed;
  }

  return { path, matrix };
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

function drawWithTransform(pathOrInfo, drawFn, targetCtx = ctx) {
  if (USE_PATH_TRANSFORM) {
    drawFn(pathOrInfo);
  } else {
    targetCtx.save();
    targetCtx.transform(
      pathOrInfo.matrix.a, pathOrInfo.matrix.b,
      pathOrInfo.matrix.c, pathOrInfo.matrix.d,
      pathOrInfo.matrix.e, pathOrInfo.matrix.f
    );
    drawFn(pathOrInfo.path);
    targetCtx.restore();
  }
}

function clipWithTransform(pathOrInfo, fillRule, targetCtx = ctx) {
  if (USE_PATH_TRANSFORM) {
    targetCtx.clip(pathOrInfo, fillRule);
  } else {
    targetCtx.transform(
      pathOrInfo.matrix.a, pathOrInfo.matrix.b,
      pathOrInfo.matrix.c, pathOrInfo.matrix.d,
      pathOrInfo.matrix.e, pathOrInfo.matrix.f
    );
    targetCtx.clip(pathOrInfo.path, fillRule);
  }
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

    drawWithTransform(transformed, function(path) {
      if (part.fill && part.fill.trim().toLowerCase() !== "none") {
        ctx.fillStyle = scene.currentStrokeColor;
        ctx.fill(path, "evenodd");
      }

      if (part.stroke !== "none") {
        ctx.strokeStyle = scene.currentStrokeColor;
        ctx.lineWidth = Math.max(1, part.strokeWidth * scaleStroke);
        ctx.stroke(path);
      }
    });
  }
}

function drawShape(shape, motionX, motionY, idleDrift, now) {
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
    const layerStroke =
      i === 0
        ? shape.stroke
        : Math.max(portalConfig.minStroke, shape.stroke * Math.pow(portalConfig.strokeDecay, i));
    
    const layerWidth = shape.width * scale;
    const layerHeight = shape.height * scale;
    const jitteredCx = layerCx;
    const jitteredCy = layerCy;
    const jitteredAngle = layerAngle;

    layers.push({
      cx: jitteredCx,
      cy: jitteredCy,
      width: layerWidth,
      height: layerHeight,
      stroke: layerStroke,
      angle: jitteredAngle,
      alpha,
      color: getColorBurstColor(now, i * portalConfig.motionDelayMs),
      path: createTransformedXPath(jitteredCx, jitteredCy, layerWidth, layerHeight, jitteredAngle),
      outerPath:
        i === 0
          ? createTransformedPrimaryOuterPath(jitteredCx, jitteredCy, layerWidth, layerHeight, jitteredAngle)
          : createTransformedOuterXPath(jitteredCx, jitteredCy, layerWidth, layerHeight, jitteredAngle)
    });
  }

  drawPrimaryLayer(layers[0]);

  if (layerMaskCtx) {
    const dpr = scene.width > 0 ? canvas.width / scene.width : 1;

    for (let i = 1; i < layers.length; i += 1) {
      layerMaskCtx.setTransform(1, 0, 0, 1, 0, 0);
      layerMaskCtx.clearRect(0, 0, layerMaskCanvas.width, layerMaskCanvas.height);
      layerMaskCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      layerMaskCtx.globalCompositeOperation = "source-over";
      layerMaskCtx.globalAlpha = layers[i].alpha;
      layerMaskCtx.strokeStyle = layers[i].color;
      layerMaskCtx.lineWidth = layers[i].stroke;
      drawWithTransform(layers[i].path, function(path) {
        layerMaskCtx.stroke(path);
      }, layerMaskCtx);

      for (let j = 0; j < i; j += 1) {
        layerMaskCtx.globalCompositeOperation = "destination-in";
        layerMaskCtx.globalAlpha = 1;
        layerMaskCtx.fillStyle = "#fff";
        drawWithTransform(layers[j].outerPath, function(path) {
          layerMaskCtx.fill(path, "nonzero");
        }, layerMaskCtx);

        layerMaskCtx.globalCompositeOperation = "destination-out";
        layerMaskCtx.globalAlpha = 1;
        layerMaskCtx.strokeStyle = "#fff";
        layerMaskCtx.lineWidth = layers[j].stroke + 1;
        drawWithTransform(layers[j].outerPath, function(path) {
          layerMaskCtx.stroke(path);
        }, layerMaskCtx);
      }

      layerMaskCtx.globalCompositeOperation = "source-over";
      ctx.drawImage(layerMaskCanvas, 0, 0, scene.width, scene.height);

    }
  } else {
    let clipDepth = 0;

    for (let i = 1; i < layers.length; i += 1) {
      if (USE_PATH_TRANSFORM) {
        ctx.save();
        clipDepth += 1;
        ctx.clip(layers[i - 1].outerPath, "nonzero");
      } else {
        ctx.save();
        clipDepth += 1;
        clipWithTransform(layers[i - 1].outerPath, "nonzero");
      }

      ctx.strokeStyle = layers[i].color;
      ctx.lineWidth = layers[i].stroke;
      ctx.globalAlpha = layers[i].alpha;

      drawWithTransform(layers[i].path, function(path) {
        ctx.stroke(path);
      });
    }

    while (clipDepth > 0) {
      ctx.restore();
      clipDepth -= 1;
    }
  }

  ctx.globalAlpha = 1;

}

function render() {
  const now = performance.now();

  if (scene.useIdle) {
    const t = now * portalConfig.idleAutoMotionSpeed;
    const baseAmpX = scene.reduceMotion ? portalConfig.idleAutoMotionAmpX * 0.4 : portalConfig.idleAutoMotionAmpX;
    const baseAmpY = scene.reduceMotion ? portalConfig.idleAutoMotionAmpY * 0.4 : portalConfig.idleAutoMotionAmpY;

    // Two-frequency blend to avoid obvious looping on touchscreen idle motion.
    const autoX = Math.sin(t * 1.9) * baseAmpX + Math.sin(t * 0.73 + 1.2) * (baseAmpX * 0.35);
    const autoY = Math.cos(t * 1.5 + 0.4) * baseAmpY + Math.sin(t * 0.67) * (baseAmpY * 0.28);

    scene.pointerTarget.x = clamp(autoX, -1, 1);
    scene.pointerTarget.y = clamp(autoY, -1, 1);
  }

  scene.tick += 1;

  scene.pointer.x = smoothStep(scene.pointer.x, scene.pointerTarget.x, 0.07);
  scene.pointer.y = smoothStep(scene.pointer.y, scene.pointerTarget.y, 0.07);

  ctx.clearRect(0, 0, scene.width, scene.height);

  const maxOffset = Math.min(scene.width, scene.height) * 0.3;
  const idleScale = scene.useIdle ? 1 : 0.2;
  const pointerScale = scene.reduceMotion ? 0.35 : 1;
  const motionX = scene.pointer.x * maxOffset * pointerScale;
  const motionY = scene.pointer.y * maxOffset * 0.6 * pointerScale;

  scene.currentStrokeColor = scene.colorBurstActive ? getColorBurstColor(now, 0) : portalConfig.color;

  scene.motionHistory.push({ t: now, x: motionX, y: motionY });
  const maxHistoryMs = portalConfig.motionDelayMs * Math.max(1, portalConfig.layerCount) + 250;
  while (scene.motionHistory.length > 2 && now - scene.motionHistory[0].t > maxHistoryMs) {
    scene.motionHistory.shift();
  }

  for (const shape of scene.shapes) {
    drawShape(shape, motionX, motionY, idleScale, now);
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
  scene.isPointerHeld = true;
  scene.colorBurstActive = true;
  scene.colorFlipStartMs = performance.now();
}

function onPointerUp() {
  scene.isPointerHeld = false;
}

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

function setupAudioPlayer() {
  const toggleBtn = document.querySelector(".audio-toggle-btn");
  const playBtn = document.querySelector(".audio-play-btn");
  const progressContainer = document.querySelector(".audio-progress-container");
  const progressFill = document.querySelector(".audio-progress-fill");
  const volumeSlider = document.querySelector(".audio-volume-slider");
  const muteBtn = document.querySelector(".audio-mute-btn");
  const volumeWaves = document.querySelectorAll(".volume-wave");
  const miniPlayer = document.querySelector(".audio-mini-player");

  if (!toggleBtn || !playBtn || !progressContainer || !progressFill || !miniPlayer) {
    return;
  }

  let sound = null;
  let hasStarted = false;
  let isPlayerOpen = false;
  let isMuted = false;
  let progressRAF = null;
  let currentVolume = 0.5;

  function initSound() {
    if (sound) return;
    try {
      sound = new Howl({
        src: ["assets/audio/soundtrack.mp3"],
        html5: true,
        loop: true,
        volume: 0.5,
        onload: function() {
          updatePlayPauseIcon();
          startProgressTracking();
        },
        onplay: function() {
          updatePlayPauseIcon();
          startProgressTracking();
          toggleBtn.classList.add("is-playing");
          scene.colorBurstActive = true;
          scene.audioPlaying = true;
          scene.colorFlipStartMs = performance.now();
        },
        onpause: function() {
          updatePlayPauseIcon();
          stopProgressTracking();
          toggleBtn.classList.remove("is-playing");
          scene.colorBurstActive = false;
          scene.audioPlaying = false;
        },
        onloaderror: function(id, error) {
          console.error("Audio load error:", error);
        }
      });
    } catch (e) {
      console.error("Howler.js not available:", e);
    }
  }

  function startPlayback() {
    if (!sound) {
      initSound();
    }
    if (sound && !hasStarted) {
      hasStarted = true;
      sound.play();
      startProgressTracking();
    }
  }

  function updatePlayPauseIcon() {
    if (!sound) return;
    if (sound.playing()) {
      playBtn.classList.add("is-playing");
    } else {
      playBtn.classList.remove("is-playing");
    }
  }

  function updateVolumeIcon(vol) {
    if (vol === 0 || isMuted) {
      volumeWaves.forEach(function(w) { w.style.display = "none"; });
    } else if (vol < 0.5) {
      volumeWaves[0].style.display = "";
      volumeWaves[1].style.display = "none";
    } else {
      volumeWaves.forEach(function(w) { w.style.display = ""; });
    }
  }

  function startProgressTracking() {
    if (progressRAF) return;
    function tick() {
      if (!sound) {
        progressRAF = null;
        return;
      }
      const seek = sound.seek();
      const duration = sound.duration();
      if (duration > 0 && typeof seek === "number") {
        const progress = (seek / duration) * 100;
        progressFill.style.width = progress + "%";
      }
      if (sound.playing()) {
        progressRAF = requestAnimationFrame(tick);
      } else {
        progressRAF = null;
      }
    }
    progressRAF = requestAnimationFrame(tick);
  }

  function stopProgressTracking() {
    if (progressRAF) {
      cancelAnimationFrame(progressRAF);
      progressRAF = null;
    }
  }

  toggleBtn.addEventListener("click", function() {
    if (!hasStarted) {
      startPlayback();
      isPlayerOpen = true;
      miniPlayer.classList.add("is-open");
      toggleBtn.classList.add("is-open");
    } else {
      isPlayerOpen = !isPlayerOpen;
      if (isPlayerOpen) {
        miniPlayer.classList.add("is-open");
        toggleBtn.classList.add("is-open");
      } else {
        miniPlayer.classList.remove("is-open");
        toggleBtn.classList.remove("is-open");
      }
    }
  });

  playBtn.addEventListener("click", function() {
    if (!sound) return;
    if (sound.playing()) {
      sound.pause();
    } else {
      sound.play();
      startProgressTracking();
    }
  });

  progressContainer.addEventListener("click", function(e) {
    if (!sound) return;
    const rect = progressContainer.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const width = rect.width;
    const seekPosition = clickX / width;
    const duration = sound.duration();
    if (duration > 0) {
      sound.seek(seekPosition * duration);
    }
  });

  volumeSlider.addEventListener("input", function() {
    currentVolume = volumeSlider.value / 100;
    if (sound) {
      sound.volume(currentVolume);
    }
    updateVolumeIcon(currentVolume);
    updateVolumeFill();
  });

  volumeSlider.addEventListener("change", function() {
    currentVolume = volumeSlider.value / 100;
    if (sound) {
      sound.volume(currentVolume);
    }
    updateVolumeIcon(currentVolume);
    updateVolumeFill();
  });

  volumeSlider.addEventListener("touchmove", function() {
    currentVolume = volumeSlider.value / 100;
    if (sound) {
      sound.volume(currentVolume);
    }
    updateVolumeIcon(currentVolume);
    updateVolumeFill();
  }, { passive: true });

  function updateVolumeFill() {
    const pct = volumeSlider.value;
    volumeSlider.style.background = `linear-gradient(90deg, #e57777 ${pct}%, rgba(255, 255, 255, 0.08) ${pct}%)`;
  }

  if (muteBtn) {
    muteBtn.addEventListener("click", function() {
      isMuted = !isMuted;
      if (sound) {
        sound.mute(isMuted);
      }
      muteBtn.classList.toggle("is-muted", isMuted);
      updateVolumeIcon(currentVolume);
    });
  }

  updateVolumeIcon(currentVolume);
  updateVolumeFill();
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
window.matchMedia("(hover: none), (pointer: coarse)").addEventListener("change", setInteractionMode);
window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", setInteractionMode);

setInteractionMode();
resize();
setupNotifyButtons();
setupAudioPlayer();
loadXOutlinePath().catch((error) => {
  console.error(error);
});
requestAnimationFrame(render);
