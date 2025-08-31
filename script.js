// ===================== script.js (ES module, photo ↔ 3D with toggle) =====================

// Expose toggleMenu (hamburger)
window.toggleMenu = function () {
  const menu = document.querySelector(".menu-links");
  const icon = document.querySelector(".hamburger-icon");
  if (!menu || !icon) return;
  menu.classList.toggle("open");
  icon.classList.toggle("open");
};

import * as THREE from "https://esm.sh/three@0.156.1";
import { OrbitControls } from "https://esm.sh/three@0.156.1/examples/jsm/controls/OrbitControls.js";
import { PLYLoader } from "https://esm.sh/three@0.156.1/examples/jsm/loaders/PLYLoader.js";

(function initPlyViewer() {
  const container = document.getElementById("ply-viewer");
  if (!container) return;

  // ---------- Controls in the page ----------
  const toggleBtn = document.getElementById("view-toggle-btn"); // above avatar
  const hintEl = document.getElementById("model-hint");         // reserved hint line under avatar

  // Start hidden: button appears only after model shows once
  if (toggleBtn) toggleBtn.style.display = "none";
  // Ensure hint is hidden initially (Image mode)
  if (hintEl) hintEl.classList.remove("visible");

  // ---------- Phase 0: photo ----------
  const PLACEHOLDER_IMG = "./assets/gs.JPG";
  const PHOTO_ZOOM = 0.85; // 1.0 = fit width

  let showingMode = "image";   // "image" | "model"
  let dataReady = false;
  let timerDone = false;

  container.style.backgroundImage = `url("${PLACEHOLDER_IMG}")`;
  container.style.backgroundRepeat = "no-repeat";
  container.style.backgroundPosition = "center";
  container.style.position = "relative";

  function applyPhotoZoom() {
    container.style.backgroundSize = `${Math.round(PHOTO_ZOOM * 100)}% auto`;
  }
  applyPhotoZoom();

  // ---------- Loader overlay ----------
  const overlay = document.createElement("div");
  overlay.className = "ply-overlay";
  overlay.innerHTML = `
    <div class="ply-box">
      <div class="ply-title">
        <span>3D Model Loading</span>
        <span class="dots"><span>.</span><span>.</span><span>.</span></span>
      </div>
      <div class="ply-bar"><div class="ply-bar-fill" style="width:0%"></div></div>
      <div class="ply-pct">0%</div>
    </div>
  `;
  container.appendChild(overlay);
  const barFill = overlay.querySelector(".ply-bar-fill");
  const pctEl   = overlay.querySelector(".ply-pct");

  // ---------- Timings ----------
  const MIN_PICTURE_MS     = 800;
  const LOADER_DURATION_MS = 1500;
  const DOTS_EXTRA_MS      = 700;

  // Auto-load model once on first run
  setTimeout(() => {
    container.classList.add("loading");
    startProgressTimer();
  }, MIN_PICTURE_MS);

  // ---------- Three.js setup ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.domElement.style.opacity = "0";   // hidden until reveal
  renderer.domElement.style.transition = "opacity 280ms ease";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
  keyLight.position.set(1, 1, 1);
  scene.add(keyLight);
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;

  function resize() {
    const size = Math.min(container.clientWidth || 400, container.clientHeight || 400);
    renderer.setSize(size, size, false);
    camera.aspect = 1;
    camera.updateProjectionMatrix();
    if (showingMode === "image") applyPhotoZoom();
  }
  resize();
  window.addEventListener("resize", resize);

  // ---------- Geometry helpers ----------
  const DEG = Math.PI / 180;
  function normAngleRad(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
  function isAngleInRange(a, min, max) {
    const aa = normAngleRad(a), amin = normAngleRad(min), amax = normAngleRad(max);
    if (amin <= amax) return aa >= amin && aa <= amax;
    return aa >= amin || aa <= amax;
  }
  function deg360ToRadSigned(deg) {
    let x = ((deg % 360) + 360) % 360;
    if (x > 180) x -= 360;
    return x * DEG;
  }
  function computeAzBasis(axis, cam) {
    const right = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
    cam.updateMatrixWorld();
    cam.matrixWorld.extractBasis(right, up, fwd);
    let u = right.sub(axis.clone().multiplyScalar(right.dot(axis)));
    if (u.lengthSq() < 1e-8) {
      u = new THREE.Vector3(0, 1, 0).sub(axis.clone().multiplyScalar(axis.y));
      if (u.lengthSq() < 1e-8) u = new THREE.Vector3(1, 0, 0).sub(axis.clone().multiplyScalar(axis.x));
    }
    u.normalize();
    const w = new THREE.Vector3().crossVectors(axis, u).normalize();
    return { u, w };
  }
  function inAnyAzCut(azRad, min1, max1, min2, max2) {
    return isAngleInRange(azRad, min1, max1) || isAngleInRange(azRad, min2, max2);
  }

  function cropMeshToBandConeDepthYAzCuts(
    geom, center, rMin, rMax, axis, cosTheta, dMin, dMax,
    yKeepMin, yKeepMax, edgeMax, aspectMax,
    u, w, azMin1, azMax1, azMin2, azMax2, cutYMin, cutYMax
  ) {
    const g = geom.index ? geom.toNonIndexed() : geom;
    const pos = g.attributes.position.array;
    const hasColor = !!g.attributes.color;
    const col = hasColor ? g.attributes.color.array : null;

    const rMin2 = rMin * rMin, rMax2 = rMax * rMax;
    const keptPos = [], keptCol = [];
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    const na = new THREE.Vector3(), nb = new THREE.Vector3(), nc = new THREE.Vector3();
    const AB = new THREE.Vector3(), BC = new THREE.Vector3(), CA = new THREE.Vector3();

    for (let i = 0; i < pos.length; i += 9) {
      va.set(pos[i] - center.x, pos[i+1] - center.y, pos[i+2] - center.z);
      vb.set(pos[i+3] - center.x, pos[i+4] - center.y, pos[i+5] - center.z);
      vc.set(pos[i+6] - center.x, pos[i+7] - center.y, pos[i+8] - center.z);

      const da = va.lengthSq(), db = vb.lengthSq(), dc = vc.lengthSq();
      if (da < rMin2 || da > rMax2 || db < rMin2 || db > rMax2 || dc < rMin2 || dc > rMax2) continue;

      const ta = va.dot(axis), tb = vb.dot(axis), tc = vc.dot(axis);
      if (ta < dMin || ta > dMax || tb < dMin || tb > dMax || tc < dMin || tc > dMax) continue;

      if (va.y < yKeepMin || va.y > yKeepMax || vb.y < yKeepMin || vb.y > yKeepMax || vc.y < yKeepMin || vc.y > yKeepMax) continue;

      na.copy(va).normalize(); nb.copy(vb).normalize(); nc.copy(vc).normalize();
      if (na.dot(axis) < cosTheta || nb.dot(axis) < cosTheta || nc.dot(axis) < cosTheta) continue;

      const aza = Math.atan2(na.dot(w), na.dot(u));
      const azb = Math.atan2(nb.dot(w), nb.dot(u));
      const azc = Math.atan2(nc.dot(w), nc.dot(u));
      const aInGate = va.y >= cutYMin && va.y <= cutYMax;
      const bInGate = vb.y >= cutYMin && vb.y <= cutYMax;
      const cInGate = vc.y >= cutYMin && vc.y <= cutYMax;
      if ((aInGate && inAnyAzCut(aza, azMin1, azMax1, azMin2, azMax2)) ||
          (bInGate && inAnyAzCut(azb, azMin1, azMax1, azMin2, azMax2)) ||
          (cInGate && inAnyAzCut(azc, azMin1, azMax1, azMin2, azMax2))) continue;

      AB.subVectors(na, nb); BC.subVectors(nb, nc); CA.subVectors(nc, na);
      const eAB = AB.length(), eBC = BC.length(), eCA = CA.length();
      const eMax = Math.max(eAB, eBC, eCA), eMin = Math.min(eAB, eBC, eCA);
      if (eMax > edgeMax) continue;
      if (eMin > 0 && eMax / eMin > aspectMax) continue;

      keptPos.push(
        pos[i], pos[i+1], pos[i+2],
        pos[i+3], pos[i+4], pos[i+5],
        pos[i+6], pos[i+7], pos[i+8]
      );
      if (hasColor) keptCol.push(
        col[i], col[i+1], col[i+2],
        col[i+3], col[i+4], col[i+5],
        col[i+6], col[i+7], col[i+8]
      );
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(new Float32Array(keptPos), 3));
    if (hasColor) out.setAttribute("color", new THREE.BufferAttribute(new Float32Array(keptCol), 3));
    return out;
  }

  function cropPointsToBandConeDepthYAzCuts(
    geom, center, rMin, rMax, axis, cosTheta, dMin, dMax,
    yKeepMin, yKeepMax, u, w, azMin1, azMax1, azMin2, azMax2, cutYMin, cutYMax
  ) {
    const pos = geom.attributes.position.array;
    const hasColor = !!geom.attributes.color;
    const col = hasColor ? geom.attributes.color.array : null;

    const rMin2 = rMin * rMin, rMax2 = rMax * rMax;
    const keptPos = [], keptCol = [];
    const v = new THREE.Vector3(), n = new THREE.Vector3();

    for (let i = 0; i < pos.length; i += 3) {
      v.set(pos[i] - center.x, pos[i+1] - center.y, pos[i+2] - center.z);
      const L2 = v.lengthSq(); if (L2 < rMin2 || L2 > rMax2) continue;

      const t = v.dot(axis); if (t < dMin || t > dMax) continue;

      if (v.y < yKeepMin || v.y > yKeepMax) continue;

      n.copy(v).normalize();
      if (n.dot(axis) < cosTheta) continue;

      const az = Math.atan2(n.dot(w), n.dot(u));
      const bsR = geom?.boundingSphere?.radius || 1;
      if ((v.y >= (bsR * 0.14) && v.y <= bsR) &&
          inAnyAzCut(az, deg360ToRadSigned(209), deg360ToRadSigned(222), deg360ToRadSigned(191), deg360ToRadSigned(240))) continue;

      keptPos.push(pos[i], pos[i+1], pos[i+2]);
      if (hasColor) keptCol.push(col[i], col[i+1], col[i+2]);
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(new Float32Array(keptPos), 3));
    if (hasColor) out.setAttribute("color", new THREE.BufferAttribute(new Float32Array(keptCol), 3));
    return out;
  }

  // ---------- Progress timer ----------
  let timerId = null;
  let timerStart = 0;

  function startProgressTimer() {
    timerStart = Date.now();
    timerId = setInterval(() => {
      const t = Math.min(1, (Date.now() - timerStart) / LOADER_DURATION_MS);
      const pct = Math.round(t * 100);
      barFill.style.width = pct + "%";
      pctEl.textContent = pct + "%";
      if (t >= 1) {
        clearInterval(timerId);
        timerDone = true;
        maybeReveal();
      }
    }, 60);
  }

  function showModel() {
    container.classList.remove("loading");
    container.style.backgroundImage = "none";
    renderer.domElement.style.opacity = "1";
    if (hintEl) hintEl.classList.add("visible");      // show hint ONLY in model mode
    showingMode = "model";

    if (toggleBtn) {
      toggleBtn.style.display = "block";              // reveal toggle after first model reveal
      toggleBtn.textContent = "Click to view image";
      toggleBtn.setAttribute("aria-pressed", "true");
    }
  }

  function showImage() {
    renderer.domElement.style.opacity = "0";
    container.style.backgroundImage = `url("${PLACEHOLDER_IMG}")`;
    applyPhotoZoom();
    if (hintEl) hintEl.classList.remove("visible");   // hide hint in image mode
    showingMode = "image";

    if (toggleBtn) {
      toggleBtn.textContent = "Click to view 3D model of me";
      toggleBtn.setAttribute("aria-pressed", "false");
    }
  }

  function maybeReveal() {
    if (timerDone && dataReady) {
      setTimeout(() => { showModel(); }, DOTS_EXTRA_MS);
      startRenderLoop();
    }
  }

  // ---------- Load PLY ----------
  const loader = new PLYLoader();
  loader.load(
    "./assets/Tarun_full_mesh.ply",
    (geometry) => {
      const hasFaces = !!geometry.index && geometry.index.count > 0;
      geometry.computeBoundingSphere();
      const bs0 = geometry.boundingSphere;
      const baseCenter = bs0.center.clone();

      // Final crop values
      const innerScale     = 0.21;
      const outerScale     = 0.29;
      const depthMinScale  = 0.16;
      const depthMaxScale  = 0.28;
      const edgeFactor     = 0.80;
      const aspectMax      = 7.0;
      const coneDegrees    = 16;
      const yKeepMinPct    = 3;
      const yKeepMaxPct    = 13;
      const azCutMinDeg    = 209;
      const azCutMaxDeg    = 222;
      const az2CutMinDeg   = 191;
      const az2CutMaxDeg   = 240;
      const cutYMinPct     = 14;
      const cutYMaxPct     = 100;

      // derived
      const rMin   = bs0.radius * innerScale;
      const rMax   = bs0.radius * outerScale;
      const dMin   = bs0.radius * depthMinScale;
      const dMax   = bs0.radius * depthMaxScale;
      const yKeepMin = bs0.radius * (yKeepMinPct / 100);
      const yKeepMax = bs0.radius * (yKeepMaxPct / 100);
      const cutYMin  = bs0.radius * (cutYMinPct  / 100);
      const cutYMax  = bs0.radius * (cutYMaxPct  / 100);
      const edgeMax  = bs0.radius * edgeFactor;
      const cosTheta = Math.cos(THREE.MathUtils.degToRad(coneDegrees));

      // axis estimate
      const axis = new THREE.Vector3(0, 0, 1);
      (function estimateAxis() {
        const g = geometry.index ? geometry.toNonIndexed() : geometry;
        const pos = g.attributes.position.array;
        const rMin2 = rMin * rMin, rMax2 = rMax * rMax;
        const sum = new THREE.Vector3(), v = new THREE.Vector3();
        let n = 0;
        for (let i = 0; i < pos.length; i += 3) {
          v.set(pos[i] - baseCenter.x, pos[i+1] - baseCenter.y, pos[i+2] - baseCenter.z);
          const L2 = v.lengthSq(); if (L2 < rMin2 || L2 > rMax2) continue;
          v.normalize(); sum.add(v); n++;
        }
        if (n && sum.lengthSq() > 0) axis.copy(sum.normalize());
      })();
      const { u: azU, w: azW } = computeAzBasis(axis, camera);

      const azMin1 = deg360ToRadSigned(azCutMinDeg);
      const azMax1 = deg360ToRadSigned(azCutMaxDeg);
      const azMin2 = deg360ToRadSigned(az2CutMinDeg);
      const azMax2 = deg360ToRadSigned(az2CutMaxDeg);

      let cleanGeom, object;

      if (hasFaces) {
        cleanGeom = cropMeshToBandConeDepthYAzCuts(
          geometry, baseCenter,
          rMin, rMax, axis, cosTheta, dMin, dMax,
          yKeepMin, yKeepMax, edgeMax, aspectMax,
          azU, azW, azMin1, azMax1, azMin2, azMax2, cutYMin, cutYMax
        );
        cleanGeom.computeVertexNormals();
        object = new THREE.Mesh(
          cleanGeom,
          new THREE.MeshStandardMaterial({
            roughness: 0.9, metalness: 0.0,
            vertexColors: !!cleanGeom.attributes.color,
            color: cleanGeom.attributes.color ? undefined : 0x996655
          })
        );
      } else {
        cleanGeom = cropPointsToBandConeDepthYAzCuts(
          geometry, baseCenter,
          rMin, rMax, axis, cosTheta, dMin, dMax,
          yKeepMin, yKeepMax, azU, azW, azMin1, azMax1, azMin2, azMax2, cutYMin, cutYMax
        );
        object = new THREE.Points(
          cleanGeom,
          new THREE.PointsMaterial({
            size: 0.03, sizeAttenuation: true,
            vertexColors: !!cleanGeom.attributes.color,
            color: cleanGeom.attributes.color ? undefined : 0x996655
          })
        );
      }

      // --- Smart fit ---
      cleanGeom.computeBoundingSphere();
      const bs = cleanGeom.boundingSphere;

      const TARGET_RADIUS = 1.0;
      const scale = bs && bs.radius > 0 ? TARGET_RADIUS / bs.radius : 1.0;
      object.scale.setScalar(scale);
      if (bs) object.position.sub(bs.center.clone().multiplyScalar(scale));
      scene.add(object);

      const SCREEN_FILL = 1.4;
      const fovRad = THREE.MathUtils.degToRad(camera.fov);
      const distance = TARGET_RADIUS / (Math.tan(fovRad / 2) * SCREEN_FILL);

      const SHIFT_CENTER_X = -0.09;
      const SHIFT_CENTER_Y =  0.00;

      camera.position.set(SHIFT_CENTER_X, SHIFT_CENTER_Y, distance);
      const target = new THREE.Vector3(SHIFT_CENTER_X, SHIFT_CENTER_Y, 0);
      controls.target.copy(target);
      controls.minDistance = distance * 0.6;
      controls.maxDistance = distance * 2.2;
      camera.near = Math.max(0.01, distance * 0.05);
      camera.far  = distance * 20;
      camera.updateProjectionMatrix();
      camera.lookAt(target);
      controls.update();
      controls.saveState();

      // ready → maybe reveal
      dataReady = true;
      maybeReveal();
    },
    null,
    (err) => {
      console.error("PLY load error:", err);
      dataReady = true;
      maybeReveal();
    }
  );

  // ---------- Render loop ----------
  function startRenderLoop() {
    function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();
  }

  // ---------- Toggle wiring ----------
  function updateLabel() {
    if (!toggleBtn) return;
    toggleBtn.textContent =
      showingMode === "model" ? "Click to view image" : "Click to view 3D model of me";
    toggleBtn.setAttribute("aria-pressed", showingMode === "model" ? "true" : "false");
  }
  updateLabel();

  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      if (showingMode === "model") {
        showImage();
      } else {
        if (dataReady && timerDone) {
          showModel();
        } else {
          container.classList.add("loading");
          if (!timerId) startProgressTimer();
        }
      }
      updateLabel();
    });
  }

  // ---------- Progress → Reveal ----------
  function maybeReveal() {
    if (timerDone && dataReady) {
      setTimeout(() => { showModel(); }, DOTS_EXTRA_MS);
      startRenderLoop();
    }
  }
})();
