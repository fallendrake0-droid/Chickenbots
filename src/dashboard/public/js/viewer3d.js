/**
 * Bounded WebGL world viewer.
 *
 * Terrain arrives as a real heightfield (one surfaced block per x/z column)
 * plus entities from /api/world. A single merged mesh is rebuilt only when a
 * new snapshot arrives, so frame cost stays constant while bots move. There is
 * no unbounded chunk cache: each snapshot replaces the previous buffers, and
 * the server clamps the radius before scanning.
 */

const SKY = [0.52, 0.72, 0.9];

function mat4Identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = (far + near) / (near - far); out[11] = -1;
  out[12] = 0; out[13] = 0; out[14] = (2 * far * near) / (near - far); out[15] = 0;
  return out;
}

function lookAt(out, eye, target, up) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

function multiply(out, a, b) {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j];
    }
  }
  return out;
}

function project(m, point) {
  const x = point[0], y = point[1], z = point[2];
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (cw <= 0.0001) return null;
  return [cx / cw, cy / cw, cz / cw];
}

function rgb(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

function shade(color, factor) {
  return [Math.min(1, color[0] * factor), Math.min(1, color[1] * factor), Math.min(1, color[2] * factor)];
}

const VERT = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec3 aColor;
uniform mat4 uViewProj;
varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vWorld;
void main() {
  vNormal = aNormal;
  vColor = aColor;
  vWorld = aPosition;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vWorld;
uniform vec3 uCamera;
uniform vec3 uSky;
uniform float uFogNear;
uniform float uFogFar;
void main() {
  vec3 n = normalize(vNormal);
  vec3 lightDir = normalize(vec3(0.45, 1.0, 0.3));
  float diffuse = max(dot(n, lightDir), 0.0);
  float light = 0.52 + 0.48 * diffuse;
  vec3 color = vColor * light;
  float dist = distance(vWorld, uCamera);
  float fog = clamp((dist - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 0.72);
  gl_FragColor = vec4(mix(color, uSky, fog), 1.0);
}`;

function cubeFaces(cx, cy, cz, sx, sy, sz, color) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy, y1 = cy + sy;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  const c = rgb(color);
  const top = shade(c, 1.08);
  const bottom = shade(c, 0.55);
  const sideX = shade(c, 0.82);
  const sideZ = shade(c, 0.68);
  const out = [];
  const quad = (a, b, d, e, n, col) => {
    for (const p of [a, b, d, a, d, e]) out.push(p[0], p[1], p[2], n[0], n[1], n[2], col[0], col[1], col[2]);
  };
  quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0], top);
  quad([x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [0, -1, 0], bottom);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], sideX);
  quad([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0], shade(c, 0.74));
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1], sideZ);
  quad([x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1], [0, 0, 1], shade(c, 0.76));
  return out;
}

export function createWorldViewer({ canvas, overlay, onSelect = null, onStats = null } = {}) {
  if (!canvas) throw new Error('viewer requires a canvas');
  let gl = null;
  let mode = 'webgl';
  let program = null;
  let terrainBuffer = null;
  let entityBuffer = null;
  let terrainVertices = 0;
  let entityVertices = 0;
  let data = null;
  let selected = null;
  let follow = true;
  let disposed = false;
  let raf = 0;
  let lastFrame = 0;
  let fps = 0;
  let frameMs = 0;
  let lastProjection = mat4Identity();
  let lastViewport = { width: 1, height: 1 };
  let contextLost = false;
  const camera = { yaw: -0.7, pitch: 0.62, distance: 58, target: [0, 70, 0] };
  const pointer = { dragging: false, x: 0, y: 0, panning: false, moved: 0 };
  const buffers = {};
  let resizeObserver = null;
  let glListenersBound = false;

  let bgCtx = null;
  const bg = () => {
    // A canvas that already owns a WebGL context cannot return a 2D context.
    // In that case the fallback is drawn on the transparent overlay instead.
    // Cache the result so a failed probe is not repeated every frame.
    if (!bgCtx) bgCtx = canvas.getContext('2d') || (overlay ? overlay.getContext('2d') : null);
    return bgCtx;
  };

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`shader compile failed: ${log}`);
    }
    return shader;
  }

  function initGL() {
    // The shaders are GLSL ES 1.00, so request WebGL 1 first. WebGL 2 accepts
    // them on most browsers but not all; the fallback path is worse than simply
    // using the universally supported context.
    const opts = { antialias: true, alpha: false, powerPreference: 'high-performance' };
    gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) {
      mode = 'fallback';
      return;
    }
    mode = 'webgl';
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
    buffers.aPosition = gl.getAttribLocation(program, 'aPosition');
    buffers.aNormal = gl.getAttribLocation(program, 'aNormal');
    buffers.aColor = gl.getAttribLocation(program, 'aColor');
    buffers.uViewProj = gl.getUniformLocation(program, 'uViewProj');
    buffers.uCamera = gl.getUniformLocation(program, 'uCamera');
    buffers.uSky = gl.getUniformLocation(program, 'uSky');
    buffers.uFogNear = gl.getUniformLocation(program, 'uFogNear');
    buffers.uFogFar = gl.getUniformLocation(program, 'uFogFar');
    terrainBuffer = gl.createBuffer();
    entityBuffer = gl.createBuffer();
    gl.enable(gl.DEPTH_TEST);
    // Terrain is a single-sided heightfield mesh; keep both faces visible so a
    // winding mistake or a camera below the surface cannot blank the view.
    gl.disable(gl.CULL_FACE);
    if (!glListenersBound) {
      canvas.addEventListener('webglcontextlost', onContextLost);
      canvas.addEventListener('webglcontextrestored', onContextRestored);
      glListenersBound = true;
    }
  }

  function onContextLost(event) {
    event.preventDefault();
    contextLost = true;
    gl = null;
  }

  function onContextRestored() {
    contextLost = false;
    try {
      initGL();
      buildTerrain();
      if (data) buildEntities();
    } catch (_) {
      mode = 'fallback';
    }
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    if (overlay) {
      if (overlay.width !== width || overlay.height !== height) {
        overlay.width = width;
        overlay.height = height;
      }
    }
    lastViewport = { width: rect.width || 1, height: rect.height || 1, dpr };
    if (gl) gl.viewport(0, 0, width, height);
  }

  function buildTerrain() {
    terrainVertices = 0;
    if (!gl || !terrainBuffer) return;
    const columns = data && Array.isArray(data.columns) ? data.columns : [];
    if (!columns.length) {
      gl.bindBuffer(gl.ARRAY_BUFFER, terrainBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.DYNAMIC_DRAW);
      return;
    }
    const palette = new Map((data.palette || []).map((entry) => [entry.index, rgb(entry.color)]));
    const heights = new Map();
    for (const column of columns) heights.set(`${column[0]},${column[1]}`, column);
    const baseY = Number(data.baseY) || 60;
    const verts = [];
    const pushQuad = (a, b, c, d, normal, color) => {
      for (const p of [a, b, c, a, c, d]) {
        verts.push(p[0], p[1], p[2], normal[0], normal[1], normal[2], color[0], color[1], color[2]);
      }
    };
    for (const column of columns) {
      const [x, z, y, colorHex, paletteIndex] = column;
      const color = palette.get(paletteIndex) || rgb(colorHex);
      const top = y + 1;
      const x0 = x - 0.5, x1 = x + 0.5, z0 = z - 0.5, z1 = z + 0.5;
      pushQuad([x0, top, z0], [x0, top, z1], [x1, top, z1], [x1, top, z0], [0, 1, 0], color);
      const neighbours = [
        [1, 0, [1, 0, 0], shade(color, 0.86)],
        [-1, 0, [-1, 0, 0], shade(color, 0.74)],
        [0, 1, [0, 0, 1], shade(color, 0.8)],
        [0, -1, [0, 0, -1], shade(color, 0.68)]
      ];
      for (const [dx, dz, normal, sideColor] of neighbours) {
        const other = heights.get(`${x + dx},${z + dz}`);
        const otherTop = other ? other[2] + 1 : baseY;
        if (otherTop >= top) continue;
        const bottom = Math.max(baseY, otherTop);
        if (dx === 1) pushQuad([x1, bottom, z0], [x1, top, z0], [x1, top, z1], [x1, bottom, z1], normal, sideColor);
        else if (dx === -1) pushQuad([x0, bottom, z1], [x0, top, z1], [x0, top, z0], [x0, bottom, z0], normal, sideColor);
        else if (dz === 1) pushQuad([x1, bottom, z1], [x1, top, z1], [x0, top, z1], [x0, bottom, z1], normal, sideColor);
        else pushQuad([x0, bottom, z0], [x0, top, z0], [x1, top, z0], [x1, bottom, z0], normal, sideColor);
      }
    }
    terrainVertices = verts.length / 9;
    gl.bindBuffer(gl.ARRAY_BUFFER, terrainBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  }

  function buildEntities() {
    entityVertices = 0;
    if (!gl || !entityBuffer || !data) return;
    const verts = [];
    for (const bot of data.bots || []) {
      const p = bot.position;
      verts.push(...cubeFaces(p[0], p[1], p[2], 0.65, 1.8, 0.65, bot.color));
      if (bot.selected) verts.push(...cubeFaces(p[0], p[1] + 1.86, p[2], 0.22, 0.18, 0.22, 0xffe066));
    }
    for (const entity of data.entities || []) {
      const p = entity.position;
      const color = entity.username ? 0x9ecbff : entity.hostile ? 0xd9534f : 0x9e9e9e;
      verts.push(...cubeFaces(p[0], p[1], p[2], 0.55, entity.username ? 1.75 : 0.9, 0.55, color));
    }
    entityVertices = verts.length / 9;
    gl.bindBuffer(gl.ARRAY_BUFFER, entityBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
  }

  function bindBuffer(buffer, stride) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(buffers.aPosition);
    gl.vertexAttribPointer(buffers.aPosition, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(buffers.aNormal);
    gl.vertexAttribPointer(buffers.aNormal, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(buffers.aColor);
    gl.vertexAttribPointer(buffers.aColor, 3, gl.FLOAT, false, stride, 24);
  }

  function cameraEye() {
    const cp = Math.cos(camera.pitch);
    return [
      camera.target[0] + Math.cos(camera.yaw) * cp * camera.distance,
      camera.target[1] + Math.sin(camera.pitch) * camera.distance,
      camera.target[2] + Math.sin(camera.yaw) * cp * camera.distance
    ];
  }

  function renderGL(cameraEyePos) {
    const aspect = lastViewport.width / Math.max(1, lastViewport.height);
    const projection = perspective(mat4Identity(), 55 * Math.PI / 180, aspect, 0.1, 600);
    const view = lookAt(mat4Identity(), cameraEyePos, camera.target, [0, 1, 0]);
    const viewProj = multiply(mat4Identity(), projection, view);
    lastProjection = viewProj;
    gl.clearColor(SKY[0] * 0.8, SKY[1] * 0.86, SKY[2] * 0.95, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.uniformMatrix4fv(buffers.uViewProj, false, viewProj);
    gl.uniform3fv(buffers.uCamera, new Float32Array(cameraEyePos));
    gl.uniform3fv(buffers.uSky, new Float32Array([SKY[0], SKY[1], SKY[2]]));
    gl.uniform1f(buffers.uFogNear, camera.distance * 0.9);
    gl.uniform1f(buffers.uFogFar, camera.distance * 2.8 + 60);
    gl.enable(gl.DEPTH_TEST);
    if (terrainVertices) {
      bindBuffer(terrainBuffer, 36);
      gl.drawArrays(gl.TRIANGLES, 0, terrainVertices);
    }
    if (entityVertices) {
      bindBuffer(entityBuffer, 36);
      gl.drawArrays(gl.TRIANGLES, 0, entityVertices);
    }
    return viewProj;
  }

  function drawFallback() {
    const ctx = bg();
    if (!ctx) return;
    const width = lastViewport.width;
    const height = lastViewport.height;
    const dpr = lastViewport.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#5d8fb5');
    sky.addColorStop(1, '#c8dbe4');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);
    if (!data || !data.columns.length) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillText('Waiting for world data…', 18, 28);
      return;
    }
    const radius = data.radius || 20;
    const scale = Math.min(width, height) / (radius * 2 + 2);
    const ox = width / 2;
    const oy = height / 2;
    const heights = data.columns.map((column) => column[2]);
    const min = Math.min(...heights);
    const max = Math.max(...heights) || min + 1;
    const palette = new Map((data.palette || []).map((entry) => [entry.index, entry.color]));
    for (const column of data.columns) {
      const [x, z, y, colorHex, index] = column;
      const t = (y - min) / Math.max(1, max - min);
      const color = palette.get(index) || colorHex;
      ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      ctx.globalAlpha = 0.7 + t * 0.3;
      ctx.fillRect(ox + x * scale - scale / 2, oy + z * scale - scale / 2, scale + 0.5, scale + 0.5);
    }
    ctx.globalAlpha = 1;
    for (const bot of data.bots || []) {
      const [x, , z] = bot.position;
      ctx.fillStyle = `#${bot.color.toString(16).padStart(6, '0')}`;
      ctx.beginPath();
      ctx.arc(ox + x * scale, oy + z * scale, Math.max(3, scale * 0.35), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(bot.name, ox + x * scale + 6, oy + z * scale - 5);
    }
    ctx.fillStyle = 'rgba(15,23,42,0.75)';
    ctx.fillRect(10, height - 30, 220, 20);
    ctx.fillStyle = '#fff';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('WebGL unavailable — 2D fallback', 18, height - 16);
  }

  function drawOverlay(viewProj) {
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    const width = lastViewport.width;
    const height = lastViewport.height;
    const dpr = lastViewport.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!data) return;
    const projectedBots = [];
    for (const bot of data.bots || []) {
      const p = project(viewProj, [bot.position[0], bot.position[1] + 2.1, bot.position[2]]);
      if (!p) continue;
      const sx = (p[0] * 0.5 + 0.5) * width;
      const sy = (1 - (p[1] * 0.5 + 0.5)) * height;
      if (sx < -100 || sx > width + 100 || sy < -100 || sy > height + 100) continue;
      projectedBots.push({ bot, sx, sy });
    }
    for (const item of projectedBots) {
      const { bot, sx, sy } = item;
      ctx.font = '600 11px system-ui, -apple-system, sans-serif';
      const label = `${bot.name}${bot.task ? ` · ${bot.task.type}` : ''}`;
      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = bot.selected ? 'rgba(255,224,102,0.92)' : 'rgba(15,23,42,0.78)';
      ctx.fillRect(sx - w / 2, sy - 24, w, 17);
      ctx.fillStyle = bot.selected ? '#1f2937' : '#f8fafc';
      ctx.fillText(label, sx - w / 2 + 6, sy - 11);
      const health = Math.max(0, Math.min(20, Number(bot.health) || 0));
      ctx.fillStyle = 'rgba(15,23,42,0.6)';
      ctx.fillRect(sx - 16, sy - 5, 32, 3);
      ctx.fillStyle = health > 12 ? '#4ade80' : health > 6 ? '#fbbf24' : '#ef4444';
      ctx.fillRect(sx - 16, sy - 5, 32 * (health / 20), 3);
    }
    // Only label nearby hostiles; distant names would cover the terrain.
    let labelled = 0;
    for (const entity of data.entities || []) {
      if (!entity.hostile || labelled >= 18) continue;
      const p = project(viewProj, [entity.position[0], entity.position[1] + 1.1, entity.position[2]]);
      if (!p) continue;
      const sx = (p[0] * 0.5 + 0.5) * width;
      const sy = (1 - (p[1] * 0.5 + 0.5)) * height;
      if (sx < 0 || sx > width || sy < 0 || sy > height) continue;
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(127,29,29,0.85)';
      const text = entity.name;
      const w = ctx.measureText(text).width + 8;
      ctx.fillRect(sx - w / 2, sy - 14, w, 14);
      ctx.fillStyle = '#fee2e2';
      ctx.fillText(text, sx - w / 2 + 4, sy - 4);
      labelled++;
    }
    lastProjection = viewProj;
    return projectedBots;
  }

  function frame(now) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    if (now - lastFrame < 1000 / 30) return;
    lastFrame = now;
    const started = performance.now();
    resize();
    if (!data) {
      drawFallback();
      if (onStats) onStats({ fps, frames: terrainVertices / 6, mode, columns: 0, entities: 0, frameMs, drawCalls: 0, triangles: 0 });
      return;
    }
    let viewProj = mat4Identity();
    if (mode === 'webgl' && gl && !contextLost) {
      try {
        viewProj = renderGL(cameraEye());
        drawOverlay(viewProj);
      } catch (_) {
        mode = 'fallback';
      }
    }
    if (mode !== 'webgl' || contextLost) {
      // drawFallback() renders the terrain, bots, labels and its own status
      // banner on whichever 2D context is available. Do not clear that context
      // afterwards: when WebGL owns the canvas the same overlay is the surface
      // that holds the fallback, and a second clear would erase it.
      drawFallback();
    }
    frameMs = (frameMs * 0.8) + ((performance.now() - started) * 0.2);
    fps = fps ? (fps * 0.85 + (1000 / Math.max(1, now - (frame.last || now - 16))) * 0.15) : 60;
    frame.last = now;
    if (onStats) {
      onStats({
        fps: Math.round(fps),
        mode,
        columns: (data.columns || []).length,
        chunks: (data.chunks || []).length,
        entities: (data.entities || []).length,
        bots: (data.bots || []).length,
        frameMs: Number(frameMs.toFixed(1)),
        vertices: terrainVertices + entityVertices,
        triangles: Math.round((terrainVertices + entityVertices) / 3),
        drawCalls: (terrainVertices ? 1 : 0) + (entityVertices ? 1 : 0)
      });
    }
  }

  function selectAt(clientX, clientY) {
    if (!data) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = null;
    for (const bot of data.bots || []) {
      const p = project(lastProjection, [bot.position[0], bot.position[1] + 1, bot.position[2]]);
      if (!p) continue;
      const sx = (p[0] * 0.5 + 0.5) * rect.width;
      const sy = (1 - (p[1] * 0.5 + 0.5)) * rect.height;
      const dist = Math.hypot(sx - x, sy - y);
      if (dist < 28 && (!best || dist < best.dist)) best = { kind: 'bot', name: bot.name, dist };
    }
    if (!best) {
      for (const entity of data.entities || []) {
        const p = project(lastProjection, [entity.position[0], entity.position[1] + 0.5, entity.position[2]]);
        if (!p) continue;
        const sx = (p[0] * 0.5 + 0.5) * rect.width;
        const sy = (1 - (p[1] * 0.5 + 0.5)) * rect.height;
        const dist = Math.hypot(sx - x, sy - y);
        if (dist < 24 && (!best || dist < best.dist)) best = { kind: 'entity', name: entity.name, id: entity.id, dist };
      }
    }
    if (best && onSelect) onSelect(best);
    return best;
  }

  function onPointerDown(event) {
    pointer.dragging = true;
    pointer.panning = event.shiftKey || event.button === 1 || event.button === 2;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.moved = 0;
    canvas.setPointerCapture && canvas.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (!pointer.dragging) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.moved += Math.abs(dx) + Math.abs(dy);
    if (pointer.panning) {
      const scale = camera.distance * 0.0016;
      camera.target[0] -= Math.cos(camera.yaw) * dx * scale;
      camera.target[2] -= Math.sin(camera.yaw) * dx * scale;
      camera.target[0] += Math.sin(camera.yaw) * dy * scale;
      camera.target[2] -= Math.cos(camera.yaw) * dy * scale;
    } else {
      camera.yaw -= dx * 0.007;
      camera.pitch = Math.max(0.08, Math.min(1.45, camera.pitch + dy * 0.006));
    }
  }

  function onPointerUp(event) {
    pointer.dragging = false;
    if (pointer.moved < 4) selectAt(event.clientX, event.clientY);
    pointer.panning = false;
  }

  function onWheel(event) {
    event.preventDefault();
    camera.distance = Math.max(8, Math.min(220, camera.distance * (1 + Math.sign(event.deltaY) * 0.1)));
  }

  function bindControls() {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', () => { pointer.dragging = false; });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(canvas);
    } else {
      window.addEventListener('resize', resize);
      resizeObserver = { disconnect: () => window.removeEventListener('resize', resize) };
    }
  }

  let centreKey = null;
  function setData(next) {
    const previousRadius = data ? data.radius : null;
    data = next && next.ok ? next : null;
    if (data) {
      const nextKey = `${data.bot}:${data.center.x},${data.center.z}:${data.radius}`;
      const centreChanged = nextKey !== centreKey;
      centreKey = nextKey;
      if (centreChanged) {
        const current = selected ? (data.bots || []).find((bot) => bot.name === selected) : null;
        if (current && follow) camera.target = [current.position[0], current.position[1] + 1.5, current.position[2]];
        else camera.target = [0, (Number(data.center && data.center.y) || 64), 0];
      } else if (selected && follow) {
        const current = (data.bots || []).find((bot) => bot.name === selected);
        if (current) camera.target = [current.position[0], current.position[1] + 1.5, current.position[2]];
      }
      if (previousRadius !== data.radius) {
        camera.distance = Math.max(20, Math.min(180, (Number(data.radius) || 20) * 2.4));
      }
      buildTerrain();
      buildEntities();
    }
    return data;
  }

  function setSelected(name) {
    selected = name || null;
    if (data) {
      for (const bot of data.bots || []) bot.selected = bot.name === selected;
      if (follow) {
        const current = (data.bots || []).find((bot) => bot.name === selected);
        if (current) camera.target = [current.position[0], current.position[1] + 1.5, current.position[2]];
      }
      buildEntities();
    }
    return selected;
  }

  function setFollow(value) { follow = Boolean(value); return follow; }

  function resetCamera() {
    camera.yaw = -0.7;
    camera.pitch = 0.62;
    camera.distance = Math.max(24, (Number(data && data.radius) || 20) * 2.4);
    if (data) camera.target = [0, (Number(data.center && data.center.y) || 64), 0];
    return camera;
  }

  function dispose() {
    disposed = true;
    cancelAnimationFrame(raf);
    if (resizeObserver) resizeObserver.disconnect();
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    if (glListenersBound) {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
    }
    if (gl) {
      if (terrainBuffer) gl.deleteBuffer(terrainBuffer);
      if (entityBuffer) gl.deleteBuffer(entityBuffer);
      if (program) gl.deleteProgram(program);
    }
  }

  try {
    initGL();
  } catch (err) {
    mode = 'fallback';
  }
  if (mode !== 'webgl') mode = 'fallback';
  bindControls();
  resize();
  raf = requestAnimationFrame(frame);
  return { setData, setSelected, setFollow, resetCamera, resize, dispose, get mode() { return mode; }, get data() { return data; }, get camera() { return camera; } };
}
