import * as THREE from 'three';

export class BoundingBoxCollision {
  constructor() {
    this.objects = new Map();
    this.boundingBoxes = new Map();
  }

  addObject(id, object3D) {
    this.objects.set(id, object3D);
    this.updateBoundingBox(id);
    return this;
  }

  removeObject(id) {
    this.objects.delete(id);
    this.boundingBoxes.delete(id);
    return this;
  }

  updateBoundingBox(id) {
    const obj = this.objects.get(id);
    if (!obj) return null;

    const box = new THREE.Box3().setFromObject(obj);
    this.boundingBoxes.set(id, box);
    return box;
  }

  updateAll() {
    for (const id of this.objects.keys()) {
      this.updateBoundingBox(id);
    }
  }

  getBoundingBox(id) {
    return this.boundingBoxes.get(id) || null;
  }

  intersects(id1, id2) {
    const box1 = this.boundingBoxes.get(id1);
    const box2 = this.boundingBoxes.get(id2);

    if (!box1 || !box2) return false;

    return box1.intersectsBox(box2);
  }

  intersectsPoint(id, point) {
    const box = this.boundingBoxes.get(id);
    if (!box) return false;

    return box.containsPoint(point);
  }

  intersectsSphere(id, sphere) {
    const box = this.boundingBoxes.get(id);
    if (!box) return false;

    return box.intersectsSphere(sphere);
  }

  findIntersections(targetId) {
    const results = [];
    const targetBox = this.boundingBoxes.get(targetId);

    if (!targetBox) return results;

    for (const [id, box] of this.boundingBoxes) {
      if (id !== targetId && box.intersectsBox(targetBox)) {
        results.push(id);
      }
    }

    return results;
  }

  findAllIntersections() {
    const pairs = [];
    const ids = Array.from(this.boundingBoxes.keys());

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const box1 = this.boundingBoxes.get(ids[i]);
        const box2 = this.boundingBoxes.get(ids[j]);

        if (box1 && box2 && box1.intersectsBox(box2)) {
          pairs.push([ids[i], ids[j]]);
        }
      }
    }

    return pairs;
  }

  computeOverlapVolume(id1, id2) {
    const box1 = this.boundingBoxes.get(id1);
    const box2 = this.boundingBoxes.get(id2);

    if (!box1 || !box2) return 0;

    const intersection = new THREE.Box3();
    intersection.copy(box1).intersect(box2);

    if (intersection.isEmpty()) return 0;

    const size = new THREE.Vector3();
    intersection.getSize(size);

    return size.x * size.y * size.z;
  }

  getCenter(id) {
    const box = this.boundingBoxes.get(id);
    if (!box) return null;

    const center = new THREE.Vector3();
    box.getCenter(center);
    return center;
  }

  getSize(id) {
    const box = this.boundingBoxes.get(id);
    if (!box) return null;

    const size = new THREE.Vector3();
    box.getSize(size);
    return size;
  }

  distanceBetween(id1, id2) {
    const center1 = this.getCenter(id1);
    const center2 = this.getCenter(id2);

    if (!center1 || !center2) return Infinity;

    return center1.distanceTo(center2);
  }

  getClosestObject(targetId, candidates = null) {
    const targetCenter = this.getCenter(targetId);
    if (!targetCenter) return null;

    let closestId = null;
    let closestDist = Infinity;

    const searchIds = candidates || Array.from(this.objects.keys());

    for (const id of searchIds) {
      if (id === targetId) continue;

      const center = this.getCenter(id);
      if (!center) continue;

      const dist = targetCenter.distanceTo(center);
      if (dist < closestDist) {
        closestDist = dist;
        closestId = id;
      }
    }

    return { id: closestId, distance: closestDist };
  }

  sweepTest(id, direction, distance, step = 0.1) {
    const obj = this.objects.get(id);
    const originalBox = this.boundingBoxes.get(id);

    if (!obj || !originalBox) return [];

    const hits = [];
    const steps = Math.ceil(distance / step);

    const sweepBox = originalBox.clone();
    const stepVec = direction.clone().normalize().multiplyScalar(step);

    for (let i = 0; i < steps; i++) {
      sweepBox.translate(stepVec);

      for (const [otherId, otherBox] of this.boundingBoxes) {
        if (otherId === id) continue;
        if (hits.find(h => h.id === otherId)) continue;

        if (sweepBox.intersectsBox(otherBox)) {
          hits.push({
            id: otherId,
            distance: (i + 1) * step,
            box: otherBox.clone()
          });
        }
      }
    }

    return hits;
  }

  getCollisionNormal(id1, id2) {
    const center1 = this.getCenter(id1);
    const center2 = this.getCenter(id2);

    if (!center1 || !center2) return null;

    const normal = new THREE.Vector3();
    normal.subVectors(center2, center1).normalize();

    return normal;
  }

  resolveCollision(id1, id2, restitution = 0.5) {
    const center1 = this.getCenter(id1);
    const center2 = this.getCenter(id2);
    const size1 = this.getSize(id1);
    const size2 = this.getSize(id2);

    if (!center1 || !center2 || !size1 || !size2) return null;

    const overlap = new THREE.Vector3();
    const halfSize1 = size1.clone().multiplyScalar(0.5);
    const halfSize2 = size2.clone().multiplyScalar(0.5);

    const dx = center2.x - center1.x;
    const dy = center2.y - center1.y;
    const dz = center2.z - center1.z;

    const overlapX = halfSize1.x + halfSize2.x - Math.abs(dx);
    const overlapY = halfSize1.y + halfSize2.y - Math.abs(dy);
    const overlapZ = halfSize1.z + halfSize2.z - Math.abs(dz);

    if (overlapX <= 0 || overlapY <= 0 || overlapZ <= 0) {
      return null;
    }

    let minOverlap = overlapX;
    let normal = new THREE.Vector3(dx > 0 ? 1 : -1, 0, 0);

    if (overlapY < minOverlap) {
      minOverlap = overlapY;
      normal.set(0, dy > 0 ? 1 : -1, 0);
    }

    if (overlapZ < minOverlap) {
      minOverlap = overlapZ;
      normal.set(0, 0, dz > 0 ? 1 : -1);
    }

    const pushOut = normal.clone().multiplyScalar(minOverlap * (1 + restitution) / 2);

    return {
      normal,
      overlap: minOverlap,
      pushOut
    };
  }

  clear() {
    this.objects.clear();
    this.boundingBoxes.clear();
  }

  getObjectCount() {
    return this.objects.size;
  }

  getObjectIds() {
    return Array.from(this.objects.keys());
  }
}

export class CollisionLayer {
  constructor() {
    this.layers = new Map();
  }

  addLayer(layerName) {
    if (!this.layers.has(layerName)) {
      this.layers.set(layerName, new BoundingBoxCollision());
    }
    return this.layers.get(layerName);
  }

  getLayer(layerName) {
    return this.layers.get(layerName) || null;
  }

  addToLayer(layerName, id, object) {
    let layer = this.layers.get(layerName);
    if (!layer) {
      layer = this.addLayer(layerName);
    }
    layer.addObject(id, object);
    return this;
  }

  removeFromLayer(layerName, id) {
    const layer = this.layers.get(layerName);
    if (layer) {
      layer.removeObject(id);
    }
    return this;
  }

  checkCollisionBetweenLayers(layer1Name, layer2Name) {
    const layer1 = this.layers.get(layer1Name);
    const layer2 = this.layers.get(layer2Name);

    if (!layer1 || !layer2) return [];

    const collisions = [];
    const ids1 = layer1.getObjectIds();
    const ids2 = layer2.getObjectIds();

    for (const id1 of ids1) {
      const box1 = layer1.getBoundingBox(id1);
      if (!box1) continue;

      for (const id2 of ids2) {
        const box2 = layer2.getBoundingBox(id2);
        if (!box2) continue;

        if (box1.intersectsBox(box2)) {
          collisions.push({ id1, id2, layer1: layer1Name, layer2: layer2Name });
        }
      }
    }

    return collisions;
  }

  updateAll() {
    for (const layer of this.layers.values()) {
      layer.updateAll();
    }
  }

  clearLayer(layerName) {
    const layer = this.layers.get(layerName);
    if (layer) {
      layer.clear();
    }
    return this;
  }

  clearAll() {
    for (const layer of this.layers.values()) {
      layer.clear();
    }
    return this;
  }
}
