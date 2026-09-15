// js/render.js — AGENTS: three.js renderer/scene/camera/lights/sky setup + procedural canvas-texture helpers.
// Ownership: renderer, scene, camera, sunLight, muzzleLight, maxAniso, initThree, make*Texture, grain/blotch passes.

import * as THREE from 'three';
import { $ } from './utils.js';

export let renderer, scene, camera, sunLight, muzzleLight, vmFill = null;
export let maxAniso = 4;

// Seeded value-noise helper for procedural textures (cheap, tileable-ish)
function _texRand(seedObj) {
  seedObj.s = (seedObj.s * 16807) % 2147483647;
  return (seedObj.s - 1) / 2147483646;
}

export function makeCanvasTexture(draw, size = 256, repeat = 1, srgb = true) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

// Build a color map + matching bump map from one paint pass.
// draw(g, size, bumpCtx) paints color on g and height on bumpCtx (white=high).
export function makePBRTexture(paint, size = 512, repeat = 1) {
  const cc = document.createElement('canvas'); cc.width = cc.height = size;
  const bc = document.createElement('canvas'); bc.width = bc.height = size;
  const g = cc.getContext('2d'), b = bc.getContext('2d');
  b.fillStyle = '#808080'; b.fillRect(0, 0, size, size);
  paint(g, b, size);
  const map = new THREE.CanvasTexture(cc);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(repeat, repeat);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAniso;
  const bumpMap = new THREE.CanvasTexture(bc);
  bumpMap.wrapS = bumpMap.wrapT = THREE.RepeatWrapping;
  bumpMap.repeat.set(repeat, repeat);
  return { map, bumpMap };
}

export function grainPass(g, s, n, alpha, light, dark, minR = 1, maxR = 3) {
  for (let i = 0; i < n; i++) {
    const v = Math.random();
    g.fillStyle = v < 0.5 ? light : dark;
    g.globalAlpha = Math.random() * alpha;
    const r = minR + Math.random() * (maxR - minR);
    g.fillRect(Math.random() * s, Math.random() * s, r, r);
  }
  g.globalAlpha = 1;
}

export function blotchPass(g, s, n, colors, minR, maxR, alpha) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[(Math.random() * colors.length) | 0];
    g.globalAlpha = alpha * (0.5 + Math.random() * 0.5);
    const r = minR + Math.random() * (maxR - minR);
    g.beginPath();
    g.ellipse(Math.random() * s, Math.random() * s, r, r * (0.5 + Math.random() * 0.8), Math.random() * Math.PI, 0, 7);
    g.fill();
  }
  g.globalAlpha = 1;
}

export function bumpBlotch(b, s, n, minR, maxR, up = true) {
  for (let i = 0; i < n; i++) {
    const v = up ? 150 + (Math.random() * 70 | 0) : 40 + (Math.random() * 50 | 0);
    b.fillStyle = `rgb(${v},${v},${v})`;
    b.globalAlpha = 0.25 + Math.random() * 0.3;
    const r = minR + Math.random() * (maxR - minR);
    b.beginPath(); b.arc(Math.random() * s, Math.random() * s, r, 0, 7); b.fill();
  }
  b.globalAlpha = 1;
}

export function initThree() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // filmic look: richer sun, softer highlights, less washed-out sand
  try {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
  } catch (e) {}
  try { maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy()); } catch (e) { maxAniso = 4; }
  $('game-container').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87a5c8);
  // warm dusty haze — hides far edge, adds depth
  scene.fog = new THREE.Fog(0xc4b295, 34, 165);

  camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 600);

  // late-afternoon desert sun: warm key + cool sky bounce + faint fill
  const hemi = new THREE.HemisphereLight(0xbdd5ff, 0x9a7d55, 0.75);
  scene.add(hemi);
  const amb = new THREE.AmbientLight(0xffe8c4, 0.18);
  scene.add(amb);
  sunLight = new THREE.DirectionalLight(0xffe3b8, 2.4);
  sunLight.position.set(34, 42, 20);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -48; sunLight.shadow.camera.right = 48;
  sunLight.shadow.camera.top = 48; sunLight.shadow.camera.bottom = -48;
  sunLight.shadow.camera.far = 160;
  sunLight.shadow.bias = -0.0006;
  sunLight.shadow.normalBias = 0.02;
  scene.add(sunLight);
  // cool bounce from opposite side so shadow faces aren't pitch black
  const fill = new THREE.DirectionalLight(0x9db8e8, 0.35);
  fill.position.set(-28, 22, -26);
  scene.add(fill);

  muzzleLight = new THREE.PointLight(0xffc36b, 0, 14, 2);
  scene.add(muzzleLight);

  // small warm fill attached to camera so viewmodel + nearby walls read well
  vmFill = new THREE.PointLight(0xfff0d8, 0.55, 6, 1.6);
  vmFill.position.set(0.1, 0.1, 0.2);
  camera.add(vmFill);
  scene.add(camera);

  // gradient sky dome with sun disc + procedural clouds + horizon dust
  const skyGeo = new THREE.SphereGeometry(420, 24, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x2f5da8) },
      mid: { value: new THREE.Color(0x8fb0d8) },
      bottom: { value: new THREE.Color(0xe3c69a) },
      sunDir: { value: new THREE.Vector3(34, 42, 20).normalize() },
      sunCol: { value: new THREE.Color(0xfff3d0) },
      uTime: { value: 0 },
    },
    vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `
      uniform vec3 top; uniform vec3 mid; uniform vec3 bottom;
      uniform vec3 sunDir; uniform vec3 sunCol;
      uniform float uTime;
      varying vec3 vP;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        vec2 u = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1.,0.)), u.x),
                   mix(hash(i+vec2(0.,1.)), hash(i+vec2(1.,1.)), u.x), u.y);
      }
      float fbm(vec2 p){ float v=0.0; float a=0.5; for(int i=0;i<4;i++){ v+=a*vnoise(p); p*=2.1; a*=0.5; } return v; }
      void main(){
        vec3 d = normalize(vP);
        float h = d.y*0.5+0.5;
        vec3 col = mix(bottom, mid, smoothstep(0.48, 0.62, h));
        col = mix(col, top, smoothstep(0.62, 0.95, h));
        // horizon dust band
        col = mix(vec3(0.92,0.78,0.58), col, smoothstep(0.46, 0.56, h));
        // sun disc + glow
        float s = max(dot(d, normalize(sunDir)), 0.0);
        col += sunCol * (pow(s, 900.0) * 1.6 + pow(s, 18.0) * 0.22);
        // high clouds (slow drift with time)
        if (d.y > 0.04) {
          vec2 uv = d.xz / max(d.y, 0.12);
          float cl = fbm(uv * 1.4 + vec2(3.7 + uTime * 0.008, 1.3 + uTime * 0.003));
          float mask = smoothstep(0.52, 0.78, cl) * smoothstep(0.03, 0.25, d.y) * 0.5;
          col = mix(col, vec3(1.0, 0.98, 0.94), mask);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(skyGeo, skyMat));
  try { scene.userData.skyMat = skyMat; } catch (e) {}

  // distant dune silhouette ring — sells "desert outpost" beyond walls
  try {
    const duneMat = new THREE.MeshBasicMaterial({ color: 0xb89a6e, fog: true });
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.3;
      const w = 120 + Math.random() * 90, h = 14 + Math.random() * 22;
      const dune = new THREE.Mesh(new THREE.ConeGeometry(w * 0.5, h, 5), duneMat);
      dune.position.set(Math.cos(a) * 260, h * 0.28, Math.sin(a) * 260);
      dune.rotation.y = Math.random() * Math.PI;
      scene.add(dune);
    }
  } catch (e) {}

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

