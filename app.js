const logEl = document.getElementById("log");
function log(msg) {
  console.log(msg);
  logEl.innerHTML += msg + "<br>";
}

log("App gestartet.");

const container = document.getElementById("canvas-container");

// Szene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x222222);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 5000);
camera.position.set(0, 200, 350);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Licht
scene.add(new THREE.DirectionalLight(0xffffff, 1).position.set(100,200,100));
scene.add(new THREE.AmbientLight(0x404040));

// Terrain-Parameter
const terrainSize = 200;
const terrainResolution = 64;

let terrainMesh = null;
let trackLine = null;

// ---------- DEM Loader (Terrain-RGB) ----------

async function loadTerrainRGBTile(url) {
  log("Lade DEM-Tile: " + url);

  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  const data = ctx.getImageData(0, 0, img.width, img.height).data;

  const heights = new Float32Array(img.width * img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const idx = (y * img.width + x) * 4;
      const R = data[idx];
      const G = data[idx + 1];
      const B = data[idx + 2];

      const h = (R * 256 * 256 + G * 256 + B) * 0.1 - 10000;
      heights[y * img.width + x] = h;
    }
  }

  return {
    width: img.width,
    height: img.height,
    heights
  };
}

function terrainRGBUrl(z, x, y) {
  return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
}

function lon2tile(lon, zoom) {
  return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
}

function lat2tile(lat, zoom) {
  return Math.floor(
    (1 - Math.log(Math.tan(lat * Math.PI/180) + 1 / Math.cos(lat * Math.PI/180)) / Math.PI) / 2 * Math.pow(2, zoom)
    * Math.pow(2, zoom)
  );
}

async function loadDEMForGPX(points, zoom = 13) {
  log("Berechne DEM-Bounding-Box…");

  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;

  points.forEach(p => {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  });

  const xMin = lon2tile(minLon, zoom);
  const xMax = lon2tile(maxLon, zoom);
  const yMin = lat2tile(maxLat, zoom);
  const yMax = lat2tile(minLat, zoom);

  log(`Tiles: x=[${xMin},${xMax}], y=[${yMin},${yMax}], zoom=${zoom}`);

  const tiles = [];

  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) {
      const url = terrainRGBUrl(zoom, x, y);
      try {
        const tile = await loadTerrainRGBTile(url);
        tiles.push({ x, y, tile });
      } catch (e) {
        log("Fehler beim Laden eines Tiles: " + e);
      }
    }
  }

  log("DEM-Tiles geladen: " + tiles.length);
  return { tiles, zoom, xMin, xMax, yMin, yMax };
}

function sampleDEM(lat, lon, dem) {
  const zoom = dem.zoom;

  const xtile = lon2tile(lon, zoom);
  const ytile = lat2tile(lat, zoom);

  const tile = dem.tiles.find(t => t.x === xtile && t.y === ytile);
  if (!tile) return 0;

  const imgW = tile.tile.width;
  const imgH = tile.tile.height;

  const xFloat = (lon + 180) / 360 * Math.pow(2, zoom);
  const yFloat = (1 - Math.log(Math.tan(lat * Math.PI/180) + 1 / Math.cos(lat * Math.PI/180)) / Math.PI) / 2 * Math.pow(2, zoom);

  const xNorm = xFloat - xtile;
  const yNorm = yFloat - ytile;

  const px = Math.min(imgW - 1, Math.max(0, Math.floor(xNorm * imgW)));
  const py = Math.min(imgH - 1, Math.max(0, Math.floor(yNorm * imgH)));

  const idx = py * imgW + px;
  return tile.tile.heights[idx];
}

// ---------- GPX Parser & Projektion ----------

function parseGPX(xmlText) {
  log("Starte XML-Parsing…");

  let xml;
  try {
    xml = new DOMParser().parseFromString(xmlText, "application/xml");
  } catch (e) {
    log("❌ XML-Parser Fehler: " + e);
    return [];
  }

  const pts = [
    ...xml.getElementsByTagName("trkpt"),
    ...xml.getElementsByTagName("rtept"),
    ...xml.getElementsByTagName("wpt")
  ];

  log(`Gefunden: ${pts.length} Punkte`);
  return pts.map(pt => ({
    lat: parseFloat(pt.getAttribute("lat")),
    lon: parseFloat(pt.getAttribute("lon")),
    ele: parseFloat(pt.getElementsByTagName("ele")[0]?.textContent || 0)
  }));
}

function computeBounds(points) {
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;

  points.forEach(p => {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  });

  return { minLat, maxLat, minLon, maxLon };
}

// ---------- Terrain aus DEM erzeugen ----------

async function createTerrainFromDEM(points) {
  log("Starte DEM-Laden…");

  const dem = await loadDEMForGPX(points);
  const bounds = computeBounds(points);

  log("Erzeuge Terrain-Mesh aus DEM…");

  if (terrainMesh) {
    scene.remove(terrainMesh);
    terrainMesh.geometry.dispose();
    terrainMesh.material.dispose();
    terrainMesh = null;
  }

  const geo = new THREE.PlaneGeometry(
    terrainSize,
    terrainSize,
    terrainResolution,
    terrainResolution
  );
  geo.rotateX(-Math.PI/2);

  const pos = geo.attributes.position;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);

    const nx = (x / terrainSize + 0.5);
    const nz = (z / terrainSize + 0.5);

    const lat = bounds.minLat + nz * (bounds.maxLat - bounds.minLat);
    const lon = bounds.minLon + nx * (bounds.maxLon - bounds.minLon);

    const h = sampleDEM(lat, lon, dem);

    pos.setY(i, h / 10); // Skalierung
  }

  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0x556655,
    flatShading: false
  });

  terrainMesh = new THREE.Mesh(geo, mat);
  scene.add(terrainMesh);

  log("Terrain aus DEM fertig.");
  return { dem, bounds };
}

// ---------- Track zeichnen ----------

function drawTrack(points3D) {
  log("Zeichne Track…");

  if (trackLine) {
    scene.remove(trackLine);
    trackLine.geometry.dispose();
    trackLine.material.dispose();
    trackLine = null;
  }

  const geo = new THREE.BufferGeometry().setFromPoints(points3D);
  const mat = new THREE.LineBasicMaterial({ color: 0xffcc00 });
  trackLine = new THREE.Line(geo, mat);
  scene.add(trackLine);

  log("Track gezeichnet.");
}

function projectTrackToTerrain(points, bounds, dem) {
  log("Projektion des Tracks auf DEM-Terrain…");

  const { minLat, maxLat, minLon, maxLon } = bounds;
  const latR = maxLat - minLat || 1e-6;
  const lonR = maxLon - minLon || 1e-6;

  return points.map(p => {
    const nx = (p.lon - minLon) / lonR - 0.5;
    const nz = (p.lat - minLat) / latR - 0.5;

    const x = nx * terrainSize;
    const z = nz * terrainSize;

    const h = sampleDEM(p.lat, p.lon, dem);
    const y = h / 10 + 2;

    return new THREE.Vector3(x, y, z);
  });
}

// ---------- Datei laden ----------

document.getElementById('gpxFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) {
    log("❌ Keine Datei ausgewählt.");
    return;
  }

  log("Datei ausgewählt: " + file.name);

  const reader = new FileReader();
  reader.onload = async ev => {
    log("FileReader erfolgreich.");

    const text = ev.target.result;
    log("Dateigröße: " + text.length + " Zeichen");

    const points = parseGPX(text);

    if (!points.length) {
      log("❌ Keine Punkte gefunden.");
      return;
    }

    log("Punkte geladen: " + points.length);

    const { dem, bounds } = await createTerrainFromDEM(points);
    const projected = projectTrackToTerrain(points, bounds, dem);
    drawTrack(projected);
  };

  reader.onerror = () => log("❌ FileReader Fehler.");
  reader.readAsText(file);
});

// ---------- Render ----------

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});