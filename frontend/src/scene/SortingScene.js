import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { BoundingBoxCollision } from '../collision/BoundingBoxCollision.js';

export class SortingScene {
  constructor(container) {
    this.container = container;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.clock = null;

    this.conveyorBelt = null;
    this.conveyorRollers = [];
    this.chutes = new Map();
    this.robotArms = [];
    this.scanCameras = [];
    this.packages = new Map();

    this.conveyorLength = 20;
    this.conveyorWidth = 2;
    this.conveyorSpeed = 2;
    this.conveyorOffset = 0;

    this.collisionDetector = new BoundingBoxCollision();

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.interactiveObjects = [];

    this.onChuteClick = null;
    this.hoveredObject = null;

    this.init();
  }

  init() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);
    this.scene.fog = new THREE.Fog(0x1a1a2e, 30, 80);

    this.camera = new THREE.PerspectiveCamera(
      60,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      1000
    );
    this.camera.position.set(15, 12, 15);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.labelRenderer.domElement.style.position = 'absolute';
    this.labelRenderer.domElement.style.top = '0';
    this.labelRenderer.domElement.style.left = '0';
    this.labelRenderer.domElement.style.pointerEvents = 'none';
    this.container.appendChild(this.labelRenderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 50;
    this.controls.maxPolarAngle = Math.PI / 2.1;
    this.controls.target.set(0, 1, 0);

    this.clock = new THREE.Clock();

    this.setupLights();
    this.createGround();
    this.createConveyorBelt();
    this.createScanCamera();
    this.createRobotArms();

    this.setupEventListeners();
    this.animate();
  }

  setupLights() {
    const ambientLight = new THREE.AmbientLight(0x404060, 0.6);
    this.scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight(0xffffff, 0.8);
    mainLight.position.set(10, 20, 10);
    mainLight.castShadow = true;
    mainLight.shadow.mapSize.width = 2048;
    mainLight.shadow.mapSize.height = 2048;
    mainLight.shadow.camera.near = 0.5;
    mainLight.shadow.camera.far = 50;
    mainLight.shadow.camera.left = -15;
    mainLight.shadow.camera.right = 15;
    mainLight.shadow.camera.top = 15;
    mainLight.shadow.camera.bottom = -15;
    this.scene.add(mainLight);

    const fillLight = new THREE.DirectionalLight(0x6080ff, 0.3);
    fillLight.position.set(-10, 10, -10);
    this.scene.add(fillLight);

    const pointLight1 = new THREE.PointLight(0x00ffff, 0.5, 20);
    pointLight1.position.set(-8, 3, 0);
    this.scene.add(pointLight1);

    const pointLight2 = new THREE.PointLight(0xff00ff, 0.5, 20);
    pointLight2.position.set(8, 3, 0);
    this.scene.add(pointLight2);
  }

  createGround() {
    const groundGeometry = new THREE.PlaneGeometry(60, 40);
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x2d2d44,
      roughness: 0.9,
      metalness: 0.1
    });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const gridHelper = new THREE.GridHelper(60, 60, 0x444466, 0x333355);
    gridHelper.position.y = 0.01;
    this.scene.add(gridHelper);

    const lineMarkingMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
    const lineGeo = new THREE.PlaneGeometry(0.1, 40);
    const line1 = new THREE.Mesh(lineGeo, lineMarkingMaterial);
    line1.rotation.x = -Math.PI / 2;
    line1.position.set(-12, 0.02, 0);
    this.scene.add(line1);

    const line2 = new THREE.Mesh(lineGeo, lineMarkingMaterial);
    line2.rotation.x = -Math.PI / 2;
    line2.position.set(12, 0.02, 0);
    this.scene.add(line2);
  }

  createConveyorBelt() {
    const beltGroup = new THREE.Group();

    const frameGeo = new THREE.BoxGeometry(this.conveyorLength, 0.3, this.conveyorWidth + 0.4);
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x444455,
      metalness: 0.7,
      roughness: 0.3
    });
    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.position.y = 0.5;
    frame.castShadow = true;
    frame.receiveShadow = true;
    beltGroup.add(frame);

    const beltGeo = new THREE.PlaneGeometry(this.conveyorLength, this.conveyorWidth);
    const beltMat = new THREE.MeshStandardMaterial({
      color: 0x333344,
      roughness: 0.8,
      metalness: 0.1
    });
    this.conveyorBelt = new THREE.Mesh(beltGeo, beltMat);
    this.conveyorBelt.rotation.x = -Math.PI / 2;
    this.conveyorBelt.position.y = 0.66;
    beltGroup.add(this.conveyorBelt);

    const rollerCount = 10;
    const rollerGeo = new THREE.CylinderGeometry(0.1, 0.1, this.conveyorWidth + 0.6, 16);
    const rollerMat = new THREE.MeshStandardMaterial({
      color: 0x666677,
      metalness: 0.9,
      roughness: 0.2
    });

    for (let i = 0; i < rollerCount; i++) {
      const roller = new THREE.Mesh(rollerGeo, rollerMat);
      roller.rotation.z = Math.PI / 2;
      roller.position.x = -this.conveyorLength / 2 + (i / (rollerCount - 1)) * this.conveyorLength;
      roller.position.y = 0.5;
      roller.castShadow = true;
      beltGroup.add(roller);
      this.conveyorRollers.push(roller);
    }

    const legGeo = new THREE.BoxGeometry(0.2, 1, 0.2);
    const legMat = new THREE.MeshStandardMaterial({
      color: 0x555566,
      metalness: 0.6,
      roughness: 0.4
    });

    const legPositions = [
      [-this.conveyorLength / 2 + 0.5, 0, -this.conveyorWidth / 2 - 0.2],
      [-this.conveyorLength / 2 + 0.5, 0, this.conveyorWidth / 2 + 0.2],
      [this.conveyorLength / 2 - 0.5, 0, -this.conveyorWidth / 2 - 0.2],
      [this.conveyorLength / 2 - 0.5, 0, this.conveyorWidth / 2 + 0.2],
      [0, 0, -this.conveyorWidth / 2 - 0.2],
      [0, 0, this.conveyorWidth / 2 + 0.2],
    ];

    for (const pos of legPositions) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(pos[0], 0.5, pos[2]);
      leg.castShadow = true;
      beltGroup.add(leg);
    }

    this.scene.add(beltGroup);
  }

  createChute(chuteData) {
    const chuteGroup = new THREE.Group();
    chuteGroup.userData = { type: 'chute', ...chuteData };

    const chuteWidth = 1.5;
    const chuteLength = 4;

    const sideGeo = new THREE.BoxGeometry(chuteLength, 0.15, 0.1);
    const sideMat = new THREE.MeshStandardMaterial({
      color: 0x556677,
      metalness: 0.7,
      roughness: 0.3
    });

    const leftSide = new THREE.Mesh(sideGeo, sideMat);
    leftSide.position.set(0, 0.5, -chuteWidth / 2);
    leftSide.rotation.y = Math.PI / 2;
    leftSide.castShadow = true;
    chuteGroup.add(leftSide);

    const rightSide = new THREE.Mesh(sideGeo, sideMat);
    rightSide.position.set(0, 0.5, chuteWidth / 2);
    rightSide.rotation.y = Math.PI / 2;
    rightSide.castShadow = true;
    chuteGroup.add(rightSide);

    const bottomGeo = new THREE.PlaneGeometry(chuteLength, chuteWidth);
    const bottomMat = new THREE.MeshStandardMaterial({
      color: 0x445566,
      metalness: 0.5,
      roughness: 0.5
    });
    const bottom = new THREE.Mesh(bottomGeo, bottomMat);
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.y = 0.4;
    bottom.receiveShadow = true;
    chuteGroup.add(bottom);

    const indicatorGeo = new THREE.SphereGeometry(0.2, 16, 16);
    const indicatorMat = new THREE.MeshStandardMaterial({
      color: 0x00ff00,
      emissive: 0x00ff00,
      emissiveIntensity: 0.5
    });
    const indicator = new THREE.Mesh(indicatorGeo, indicatorMat);
    indicator.position.set(-chuteLength / 2 + 0.3, 0.8, 0);
    chuteGroup.add(indicator);
    chuteGroup.userData.indicator = indicator;

    const labelGeo = new THREE.PlaneGeometry(1.2, 0.3);
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#00ff88';
    ctx.font = 'bold 28px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(chuteData.name, 128, 32);

    const labelTex = new THREE.CanvasTexture(canvas);
    const labelMat = new THREE.MeshBasicMaterial({
      map: labelTex,
      transparent: true,
      side: THREE.DoubleSide
    });
    const label = new THREE.Mesh(labelGeo, labelMat);
    label.position.set(0, 1.8, 0);
    label.rotation.x = -Math.PI / 6;
    chuteGroup.add(label);

    const hitBoxGeo = new THREE.BoxGeometry(chuteLength, 2, chuteWidth);
    const hitBoxMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide
    });
    const hitBox = new THREE.Mesh(hitBoxGeo, hitBoxMat);
    hitBox.position.y = 0.8;
    hitBox.userData = { type: 'chute_hitbox', chuteData };
    chuteGroup.add(hitBox);

    this.interactiveObjects.push(hitBox);
    this.collisionDetector.addObject(`chute_${chuteData.id}`, hitBox);

    const x = chuteData.position[0];
    const z = -chuteLength / 2 - 1;
    chuteGroup.position.set(x, 0, z);
    chuteGroup.rotation.y = Math.PI / 2;

    this.chutes.set(chuteData.id, chuteGroup);
    this.scene.add(chuteGroup);

    return chuteGroup;
  }

  updateChuteStatus(chuteId, status) {
    const chute = this.chutes.get(chuteId);
    if (!chute || !chute.userData.indicator) return;

    const indicator = chute.userData.indicator;
    let color, emissive;

    switch (status) {
      case 'normal':
        color = 0x00ff00;
        emissive = 0x00ff00;
        break;
      case 'fault':
        color = 0xff0000;
        emissive = 0xff0000;
        break;
      case 'maintenance':
        color = 0xffaa00;
        emissive = 0xffaa00;
        break;
      default:
        color = 0x00ff00;
        emissive = 0x00ff00;
    }

    indicator.material.color.setHex(color);
    indicator.material.emissive.setHex(emissive);
    indicator.userData.status = status;
  }

  createScanCamera() {
    const cameraGroup = new THREE.Group();

    const poleGeo = new THREE.CylinderGeometry(0.08, 0.1, 3, 8);
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x667788,
      metalness: 0.8,
      roughness: 0.2
    });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(-6, 1.5, -this.conveyorWidth / 2 - 0.5);
    pole.castShadow = true;
    cameraGroup.add(pole);

    const camBodyGeo = new THREE.BoxGeometry(0.4, 0.3, 0.5);
    const camBodyMat = new THREE.MeshStandardMaterial({
      color: 0x334455,
      metalness: 0.9,
      roughness: 0.1
    });
    const camBody = new THREE.Mesh(camBodyGeo, camBodyMat);
    camBody.position.set(-6, 3, -this.conveyorWidth / 2 - 0.3);
    camBody.rotation.y = Math.PI / 2;
    camBody.castShadow = true;
    cameraGroup.add(camBody);

    const lensGeo = new THREE.CylinderGeometry(0.1, 0.08, 0.2, 16);
    const lensMat = new THREE.MeshStandardMaterial({
      color: 0x00ffff,
      emissive: 0x00ffff,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.9
    });
    const lens = new THREE.Mesh(lensGeo, lensMat);
    lens.rotation.z = Math.PI / 2;
    lens.position.set(-5.8, 3, -this.conveyorWidth / 2 - 0.3);
    cameraGroup.add(lens);

    const scanLineGeo = new THREE.PlaneGeometry(0.02, 2.5);
    const scanLineMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide
    });
    const scanLine = new THREE.Mesh(scanLineGeo, scanLineMat);
    scanLine.position.set(-6, 1.8, 0);
    scanLine.rotation.y = Math.PI / 2;
    cameraGroup.add(scanLine);
    cameraGroup.userData.scanLine = scanLine;

    this.scanCameras.push(cameraGroup);
    this.scene.add(cameraGroup);
  }

  createRobotArms() {
    const armPositions = [
      { x: -3, z: -this.conveyorWidth / 2 - 1.5 },
      { x: 3, z: -this.conveyorWidth / 2 - 1.5 },
    ];

    for (const pos of armPositions) {
      const armGroup = this.createRobotArm();
      armGroup.position.set(pos.x, 0, pos.z);
      this.robotArms.push(armGroup);
      this.scene.add(armGroup);
    }
  }

  createRobotArm() {
    const armGroup = new THREE.Group();

    const baseGeo = new THREE.CylinderGeometry(0.4, 0.5, 0.3, 16);
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0xff6600,
      metalness: 0.7,
      roughness: 0.3
    });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = 0.15;
    base.castShadow = true;
    armGroup.add(base);

    const lowerArmGeo = new THREE.BoxGeometry(0.25, 1.5, 0.25);
    const lowerArmMat = new THREE.MeshStandardMaterial({
      color: 0xff8800,
      metalness: 0.6,
      roughness: 0.4
    });
    const lowerArm = new THREE.Mesh(lowerArmGeo, lowerArmMat);
    lowerArm.position.y = 1.05;
    lowerArm.castShadow = true;
    armGroup.add(lowerArm);

    const upperArmGeo = new THREE.BoxGeometry(0.2, 1.2, 0.2);
    const upperArmMat = new THREE.MeshStandardMaterial({
      color: 0xffaa00,
      metalness: 0.6,
      roughness: 0.4
    });
    const upperArm = new THREE.Mesh(upperArmGeo, upperArmMat);
    upperArm.position.set(0.5, 1.8, 0);
    upperArm.rotation.z = -Math.PI / 4;
    upperArm.castShadow = true;
    armGroup.add(upperArm);

    const endEffectorGeo = new THREE.BoxGeometry(0.3, 0.15, 0.3);
    const endEffectorMat = new THREE.MeshStandardMaterial({
      color: 0x333333,
      metalness: 0.9,
      roughness: 0.2
    });
    const endEffector = new THREE.Mesh(endEffectorGeo, endEffectorMat);
    endEffector.position.set(1.2, 1.3, 0);
    endEffector.castShadow = true;
    armGroup.add(endEffector);

    armGroup.userData = {
      base: base,
      lowerArm: lowerArm,
      upperArm: upperArm,
      endEffector: endEffector,
      phase: Math.random() * Math.PI * 2
    };

    return armGroup;
  }

  createPackage(pkgData) {
    const pkgGroup = new THREE.Group();
    pkgGroup.userData = { type: 'package', ...pkgData };

    const w = pkgData.size[0] || 0.5;
    const h = pkgData.size[1] || 0.4;
    const d = pkgData.size[2] || 0.3;

    const boxGeo = new THREE.BoxGeometry(w, h, d);
    const boxMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(pkgData.color || '#e74c3c'),
      roughness: 0.7,
      metalness: 0.1,
      emissive: new THREE.Color(0x000000),
      emissiveIntensity: 0
    });
    const box = new THREE.Mesh(boxGeo, boxMat);
    box.position.y = h / 2;
    box.castShadow = true;
    box.receiveShadow = true;
    box.name = 'box';
    pkgGroup.add(box);

    const edgeGeo = new THREE.EdgesGeometry(boxGeo);
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.3
    });
    const edges = new THREE.LineSegments(edgeGeo, edgeMat);
    edges.position.y = h / 2;
    edges.name = 'edges';
    pkgGroup.add(edges);

    const warningRingGeo = new THREE.RingGeometry(w * 0.6, w * 0.8, 32);
    const warningRingMat = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide
    });
    const warningRing = new THREE.Mesh(warningRingGeo, warningRingMat);
    warningRing.rotation.x = -Math.PI / 2;
    warningRing.position.y = 0.02;
    warningRing.name = 'warningRing';
    pkgGroup.add(warningRing);

    const labelGeo = new THREE.PlaneGeometry(w * 0.6, h * 0.4);
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 80;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 200, 80);
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 16px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pkgData.barcode || 'SF0000', 100, 30);

    const barLines = 20;
    for (let i = 0; i < barLines; i++) {
      const x = 20 + i * 8;
      const barWidth = (i % 3 === 0) ? 3 : 1;
      ctx.fillRect(x, 50, barWidth, 20);
    }

    const labelTex = new THREE.CanvasTexture(canvas);
    const labelMat = new THREE.MeshBasicMaterial({
      map: labelTex,
      side: THREE.DoubleSide
    });
    const label = new THREE.Mesh(labelGeo, labelMat);
    label.position.set(0, h / 2, d / 2 + 0.01);
    label.name = 'label';
    pkgGroup.add(label);

    const warnBubble = this.createWarningBubble(pkgData);
    warnBubble.position.set(0, h + 1.2, 0);
    warnBubble.name = 'warnBubble';
    pkgGroup.add(warnBubble);

    pkgGroup.position.set(pkgData.position[0], pkgData.position[1], pkgData.position[2]);

    this.applyPackageStateVisual(pkgGroup, pkgData.state);

    this.packages.set(pkgData.id, pkgGroup);
    this.scene.add(pkgGroup);

    return pkgGroup;
  }

  createWarningBubble(pkgData) {
    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = 'package-warning-bubble';
    bubbleDiv.innerHTML = `
      <div class="bubble-arrow"></div>
      <div class="bubble-content">
        <div class="bubble-icon">⚠️</div>
        <div class="bubble-text">
          <div class="bubble-title">体积超限</div>
          <div class="bubble-reason">${pkgData.oversize_reason || '尺寸超标'}</div>
          <div class="bubble-size">${(pkgData.size[0] || 0).toFixed(2)} × ${(pkgData.size[1] || 0).toFixed(2)} × ${(pkgData.size[2] || 0).toFixed(2)} m</div>
        </div>
      </div>
    `;

    const label = new CSS2DObject(bubbleDiv);
    label.visible = false;
    return label;
  }

  updatePackage(pkgData) {
    let pkg = this.packages.get(pkgData.id);
    if (!pkg) {
      pkg = this.createPackage(pkgData);
    }

    const yOffset = 0.66 + (pkgData.size[1] || 0.4) / 2;
    pkg.position.set(pkgData.position[0], yOffset + pkgData.position[1], pkgData.position[2]);

    if (pkgData.rotation) {
      pkg.rotation.set(pkgData.rotation[0], pkgData.rotation[1], pkgData.rotation[2]);
    }

    if (pkg.userData.state !== pkgData.state || pkg.userData.is_oversized !== pkgData.is_oversized) {
      this.applyPackageStateVisual(pkg, pkgData.state, pkgData);
    }

    pkg.userData.state = pkgData.state;
    pkg.userData.target_chute = pkgData.target_chute;
    pkg.userData.retry_count = pkgData.retry_count;
    pkg.userData.is_oversized = pkgData.is_oversized;
  }

  applyPackageStateVisual(pkgGroup, state, pkgData = null) {
    const box = pkgGroup.getObjectByName('box');
    const edges = pkgGroup.getObjectByName('edges');
    const warningRing = pkgGroup.getObjectByName('warningRing');
    const warnBubble = pkgGroup.getObjectByName('warnBubble');

    if (!box) return;

    switch (state) {
      case 'entering':
      case 'scanning':
      case 'moving':
      case 'delivered':
      case 'exiting':
        box.material.transparent = false;
        box.material.opacity = 1;
        box.material.emissive.setHex(0x000000);
        box.material.emissiveIntensity = 0;
        box.material.color.setHex(pkgData?.color ? new THREE.Color(pkgData.color).getHex() : box.material.color.getHex());
        if (edges) edges.material.opacity = 0.3;
        if (warningRing) {
          warningRing.material.opacity = 0;
          warningRing.scale.set(1, 1, 1);
        }
        if (warnBubble) warnBubble.visible = false;
        break;

      case 'diverted':
        box.material.transparent = false;
        box.material.opacity = 1;
        box.material.emissive.setHex(0xffaa00);
        box.material.emissiveIntensity = 0.3;
        if (edges) {
          edges.material.color.setHex(0xffaa00);
          edges.material.opacity = 0.8;
        }
        if (warningRing) {
          warningRing.material.color.setHex(0xffaa00);
          warningRing.material.opacity = 0.5;
        }
        if (warnBubble) warnBubble.visible = false;
        break;

      case 'sorting':
        box.material.transparent = false;
        box.material.opacity = 1;
        box.material.emissive.setHex(0x00ff88);
        box.material.emissiveIntensity = 0.4;
        if (edges) {
          edges.material.color.setHex(0x00ff88);
          edges.material.opacity = 0.6;
        }
        if (warnBubble) warnBubble.visible = false;
        break;

      case 'oversized':
        box.material.transparent = true;
        box.material.opacity = 0.5;
        box.material.color.setHex(0xff3333);
        box.material.emissive.setHex(0xff0000);
        box.material.emissiveIntensity = 0.5;
        if (edges) {
          edges.material.color.setHex(0xff0000);
          edges.material.opacity = 1;
        }
        if (warningRing) {
          warningRing.material.color.setHex(0xff0000);
          warningRing.material.opacity = 0.8;
        }
        if (warnBubble) {
          warnBubble.visible = true;
          if (pkgData?.oversize_reason) {
            const reasonEl = warnBubble.element.querySelector('.bubble-reason');
            const sizeEl = warnBubble.element.querySelector('.bubble-size');
            if (reasonEl) reasonEl.textContent = pkgData.oversize_reason;
            if (sizeEl && pkgData.size) {
              sizeEl.textContent = `${pkgData.size[0].toFixed(2)} × ${pkgData.size[1].toFixed(2)} × ${pkgData.size[2].toFixed(2)} m`;
            }
          }
        }
        break;

      case 'error':
        box.material.transparent = false;
        box.material.opacity = 1;
        box.material.emissive.setHex(0xff0000);
        box.material.emissiveIntensity = 0.6;
        if (edges) {
          edges.material.color.setHex(0xff0000);
          edges.material.opacity = 1;
        }
        if (warningRing) {
          warningRing.material.color.setHex(0xff0000);
          warningRing.material.opacity = 0.8;
        }
        if (warnBubble) warnBubble.visible = false;
        break;

      default:
        break;
    }
  }

  removePackage(pkgId) {
    const pkg = this.packages.get(pkgId);
    if (pkg) {
      this.scene.remove(pkg);
      this.packages.delete(pkgId);
    }
  }

  updateAllPackages(packagesData) {
    const currentIds = new Set(this.packages.keys());
    const newIds = new Set(packagesData.map(p => p.id));

    for (const pkgData of packagesData) {
      this.updatePackage(pkgData);
    }

    for (const id of currentIds) {
      if (!newIds.has(id)) {
        this.removePackage(id);
      }
    }
  }

  setupEventListeners() {
    window.addEventListener('resize', () => this.onWindowResize());

    this.renderer.domElement.addEventListener('click', (e) => this.onMouseClick(e));
    this.renderer.domElement.addEventListener('mousemove', (e) => this.onMouseMove(e));
  }

  onWindowResize() {
    this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.labelRenderer.setSize(this.container.clientWidth, this.container.clientHeight);
  }

  onMouseClick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.interactiveObjects, true);

    if (intersects.length > 0) {
      let obj = intersects[0].object;
      while (obj && !obj.userData?.chuteData) {
        obj = obj.parent;
      }

      if (obj && obj.userData?.chuteData) {
        if (this.onChuteClick) {
          this.onChuteClick(obj.userData.chuteData);
        }
      }
    }
  }

  onMouseMove(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.interactiveObjects, true);

    if (this.hoveredObject) {
      this.hoveredObject.material.opacity = 0;
      this.hoveredObject = null;
      document.body.style.cursor = 'default';
    }

    if (intersects.length > 0) {
      let obj = intersects[0].object;
      while (obj && obj.userData?.type !== 'chute_hitbox') {
        obj = obj.parent;
      }

      if (obj) {
        obj.material.opacity = 0.2;
        this.hoveredObject = obj;
        document.body.style.cursor = 'pointer';
      }
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());

    const delta = this.clock.getDelta();
    const time = this.clock.getElapsedTime();

    this.updateConveyor(delta, time);
    this.updateRobotArms(time);
    this.updateScanCamera(time);
    this.updatePackageEffects(time);

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  updatePackageEffects(time) {
    const pulseScale = 1 + Math.sin(time * 4) * 0.15;
    const floatOffset = Math.sin(time * 2) * 0.1;

    for (const pkg of this.packages.values()) {
      const state = pkg.userData.state;
      const warningRing = pkg.getObjectByName('warningRing');
      const warnBubble = pkg.getObjectByName('warnBubble');

      if ((state === 'error' || state === 'diverted' || state === 'oversized') && warningRing) {
        if (warningRing.material.opacity > 0) {
          warningRing.scale.setScalar(pulseScale);
        }
      }

      if (state === 'oversized' && warnBubble) {
        warnBubble.position.y = (pkg.userData.size?.[1] || 0.4) + 1.2 + floatOffset;
      }
    }
  }

  updateConveyor(delta, time) {
    this.conveyorOffset += this.conveyorSpeed * delta;
    if (this.conveyorOffset > 1) this.conveyorOffset -= 1;

    const rollerSpeed = this.conveyorSpeed * delta * 2;
    for (const roller of this.conveyorRollers) {
      roller.rotation.x -= rollerSpeed;
    }
  }

  updateRobotArms(time) {
    for (const arm of this.robotArms) {
      const { base, lowerArm, upperArm, endEffector, phase } = arm.userData;

      const t = time * 0.8 + phase;
      base.rotation.y = Math.sin(t * 0.7) * 0.3;
      lowerArm.rotation.z = Math.sin(t * 1.2) * 0.2;
      upperArm.rotation.z = -Math.PI / 4 + Math.sin(t * 0.9) * 0.3;
    }
  }

  updateScanCamera(time) {
    for (const cam of this.scanCameras) {
      const scanLine = cam.userData.scanLine;
      if (scanLine) {
        const intensity = 0.3 + Math.sin(time * 8) * 0.3;
        scanLine.material.opacity = intensity;
      }
    }
  }

  setConveyorSpeed(speed) {
    this.conveyorSpeed = speed;
  }

  getChutes() {
    return Array.from(this.chutes.values());
  }

  dispose() {
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}
