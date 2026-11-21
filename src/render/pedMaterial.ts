import * as THREE from 'three';

/** Per-vertex color zone identifiers encoded in attribute `aZone`. */
export const PED_ZONE = {
  /** Fixed vertex color (shoes, eyes, reflective stripes, helmets, metal, tires). */
  FIXED: 0,
  /** Primary outfit / canopy / bike frame / luggage shell (multiplied by `instanceColor`). */
  PRIMARY: 1,
  /** Skin tone (face, neck, exposed forearms/hands/legs, multiplied by `aSkinColor`). */
  SKIN: 2,
  /** Hair & eyebrows (multiplied by `aHairColor`). */
  HAIR: 3,
  /** Secondary garment (pants, skirt, shorts, multiplied by `aBottomColor`). */
  BOTTOM: 4,
} as const;

/** Per-vertex articulated body-part identifiers encoded in attribute `aPart`. */
export const PED_PART = {
  TORSO: 0,
  HEAD: 1,
  ARM_L: 2,
  ARM_R: 3,
  THIGH_L: 4,
  THIGH_R: 5,
  FOREARM_L: 6,
  FOREARM_R: 7,
  SHIN_L: 8,
  SHIN_R: 9,
  STATIC: 10,
  WHEEL_F: 11,
  WHEEL_R: 12,
  CRANK: 13,
} as const;

/** Shared global animation clock uniform for in-world pedestrians & cyclists. */
export const PED_UNIFORMS = {
  uPedTime: { value: 0 },
};

/**
 * Shared GLSL vertex animation routines (Mesh2Motion-inspired walk cycle, idle breathing,
 * right-arm umbrella grip pose, and analytic 2-bone IK cyclist pedaling).
 *
 * Coordinate convention: +X forward, +Y up, +Z right, -Z left.
 * Positive rotation around +Z swings a hanging limb (0, -L, 0) forward (+X).
 * Negative rotation around +Z bends a knee backward (-X) or leans an upright torso forward (+X).
 */
const PED_ANIM_COMMON_GLSL = /* glsl */ `
uniform float uPedTime;
attribute vec4 aPedMeta; // (roughness, metalness, zone, part)
attribute vec4 aPivot4;  // (pivot.x, pivot.y, pivot.z, pivot2.y)
#ifdef USE_INSTANCING
attribute vec3 aSkinColor;
attribute vec3 aHairColor;
attribute vec3 aBottomColor;
attribute vec4 aAnim;
#endif

vec3 pedRotZ(vec3 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(v.x * c - v.y * s, v.x * s + v.y * c, v.z);
}

vec3 pedRotY(vec3 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

void evalPedPose(inout vec3 pos, inout vec3 nrm, vec4 anim) {
  float part = aPedMeta.w;
  if (part > 9.5 && part < 10.5) return; // PART_STATIC

  vec3 aPivot = aPivot4.xyz;
  vec3 aPivot2 = vec3(aPivot4.x, aPivot4.w, aPivot4.z);

  float phase0 = anim.x;
  float amp = anim.y;
  float mode = anim.z;      // 0 = idle/wait, 1 = walk, 2 = cyclist
  float umbLift = anim.w;   // 0..1 right-arm umbrella hold

  // Bicycle wheel spin (parts 11 & 12) and synchronized crankset/pedals (part 13)
  if (part > 10.5) {
    if (part > 12.5) {
      // Crankset + pedals: exact lockstep with cyclist foot crank angle
      float crank = uPedTime * 6.5 * max(amp, 0.0) + phase0;
      vec3 rel = pos - aPivot;
      pos = aPivot + pedRotZ(rel, crank);
      nrm = pedRotZ(nrm, crank);
      return;
    }
    float spin = -(uPedTime * 7.5 + phase0) * amp;
    vec3 rel = pos - aPivot;
    pos = aPivot + pedRotZ(rel, spin);
    nrm = pedRotZ(nrm, spin);
    return;
  }

  // ---- MODE 2: CYCLIST (seated on saddle, leaning forward, hands on grips, 2-bone IK pedaling) ----
  if (mode > 1.5) {
    float crank = uPedTime * 6.5 * max(amp, 0.0) + phase0;
    float lean = -0.47; // negative rotZ pitches upright torso (+Y) forward toward +X
    // Derive exact stature-proportional hip height from vertex pivot metadata
    float hipBaseY = part < 0.5 ? aPivot.y : (part < 1.5 ? aPivot4.w : aPivot.y * 0.6182);
    vec3 hipBase = vec3(0.0, hipBaseY, 0.0);
    vec3 saddleShift = vec3(-0.18, (0.91 - hipBaseY) + 0.008 * sin(crank * 2.0) * min(amp, 1.0), 0.0);

    if (part < 0.5) {
      // Torso: lean forward around pelvis and seat onto saddle
      vec3 rel = pos - hipBase;
      pos = hipBase + pedRotZ(rel, lean) + saddleShift;
      nrm = pedRotZ(nrm, lean);
    } else if (part < 1.5) {
      // Head: follow pitched neck, then counter-pitch upward so cyclist looks straight ahead (+X)
      vec3 neckRel = aPivot - hipBase;
      vec3 neckNew = hipBase + pedRotZ(neckRel, lean) + saddleShift;
      float headCounter = 0.36;
      vec3 rel = pos - aPivot;
      pos = neckNew + pedRotZ(rel, lean + headCounter);
      nrm = pedRotZ(nrm, lean + headCounter);
    } else if (part < 3.5 || (part > 5.5 && part < 7.5)) {
      // Arms (2, 3) & Forearms (6, 7): reach from pitched shoulder directly to handlebar grips
      float side = (part < 2.5 || (part > 5.5 && part < 6.5)) ? -1.0 : 1.0;
      vec3 shRel = aPivot - hipBase;
      vec3 shNew = hipBase + pedRotZ(shRel, lean) + saddleShift;
      bool singleSegArm = aPivot4.w < 0.0; // LOW LOD single-piece arm reaches straight to grip
      float shAngle = singleSegArm ? 0.76 : 0.62;
      float elAngle = 0.28;
      float flareZ = side * (singleSegArm ? 0.055 : 0.042);
      if (part < 3.5) {
        vec3 rel = pos - aPivot;
        float t = clamp((aPivot.y - pos.y) / (singleSegArm ? 0.57 : 0.30), 0.0, 1.0);
        pos = shNew + pedRotZ(rel, shAngle) + vec3(0.0, 0.0, flareZ * t);
        nrm = pedRotZ(nrm, shAngle);
      } else {
        vec3 elRel = aPivot2 - aPivot;
        vec3 elNew = shNew + pedRotZ(elRel, shAngle) + vec3(0.0, 0.0, flareZ);
        vec3 rel = pos - aPivot2;
        pos = elNew + pedRotZ(rel, shAngle + elAngle);
        nrm = pedRotZ(nrm, shAngle + elAngle);
      }
    } else {
      // Legs (4, 5 thighs; 8, 9 shins+feet): analytic 2-bone IK to circular crank orbit
      float isRight = (part > 4.5 && part < 5.5) || (part > 8.5) ? 1.0 : 0.0;
      float cAng = crank + isRight * 3.14159265;
      vec2 hipXY = aPivot.xy + vec2(-0.18, (0.91 - aPivot.y) + 0.008 * sin(crank * 2.0) * min(amp, 1.0));
      // Crank center at (+0.04, 0.32), radius 0.13m (matches buildBike crankset)
      vec2 pedalXY = vec2(0.04 + 0.13 * cos(cAng), 0.32 + 0.13 * sin(cAng));
      float L1 = max(0.20, aPivot.y - aPivot2.y);
      float L2 = max(0.20, aPivot2.y - 0.04);
      vec2 toP = pedalXY - hipXY;
      float d = clamp(length(toP), abs(L1 - L2) + 0.04, L1 + L2 - 0.015);
      float baseA = atan(toP.x, -toP.y);
      float cosA = clamp((L1 * L1 + d * d - L2 * L2) / (2.0 * L1 * d), -1.0, 1.0);
      float hipA = baseA + acos(cosA);
      float cosB = clamp((L1 * L1 + L2 * L2 - d * d) / (2.0 * L1 * L2), -1.0, 1.0);
      float kneeA = -(3.14159265 - acos(cosB));

      if (part < 5.5) {
        // Thigh
        vec3 rel = pos - aPivot;
        pos = vec3(hipXY, aPivot.z) + pedRotZ(rel, hipA);
        nrm = pedRotZ(nrm, hipA);
      } else {
        // Shin + foot
        vec3 kneeRel = aPivot2 - aPivot;
        vec3 kneeNew = vec3(hipXY, aPivot.z) + pedRotZ(kneeRel, hipA);
        vec3 rel = pos - aPivot2;
        pos = kneeNew + pedRotZ(rel, hipA + kneeA);
        nrm = pedRotZ(nrm, hipA + kneeA);
      }
    }
    return;
  }

  // ---- MODE 0 (IDLE / WAITING) & MODE 1 (WALKING) ----
  float walkW = clamp(mode, 0.0, 1.0) * amp;
  float walkPh = uPedTime * 5.6 + phase0;
  float breathPh = uPedTime * 1.9 + phase0;

  // Pelvis bounce at 2x step frequency: drops slightly on double-support so stance toe kisses Y=0
  float dblSup = sin(walkPh) * sin(walkPh);
  float pelvisDy = walkW * (-0.018 * dblSup + 0.009 * (1.0 - dblSup))
                 + (1.0 - walkW) * 0.005 * sin(breathPh);
  float torsoTwist = walkW * 0.065 * sin(walkPh);
  float torsoLean = -walkW * 0.035;

  if (part < 0.5) {
    // Torso / pelvis
    vec3 rel = pos - aPivot;
    float upperW = clamp((pos.y - aPivot.y) / 0.55, 0.0, 1.0);
    rel = pedRotY(rel, torsoTwist * upperW);
    rel = pedRotZ(rel, torsoLean * upperW);
    pos = aPivot + rel + vec3(0.0, pelvisDy, 0.0);
    nrm = pedRotZ(pedRotY(nrm, torsoTwist * upperW), torsoLean * upperW);
  } else if (part < 1.5) {
    // Head / hair / helmet: gentle counter-nod + idle look sway
    float headNod = -0.025 * sin(breathPh) - walkW * 0.02 * cos(walkPh * 2.0);
    float headYaw = (1.0 - walkW) * 0.07 * sin(breathPh * 0.55);
    vec3 rel = pos - aPivot;
    rel = pedRotY(pedRotZ(rel, headNod), headYaw);
    pos = aPivot + rel + vec3(0.0, pelvisDy, 0.0);
    nrm = pedRotY(pedRotZ(nrm, headNod), headYaw);
  } else if (part < 3.5 || (part > 5.5 && part < 7.5)) {
    // Arms (2=L, 3=R) & Forearms (6=L, 7=R)
    float isRight = (part > 2.5 && part < 3.5) || (part > 6.5) ? 1.0 : 0.0;
    // Left arm swings with right leg (walkPh + PI), right arm swings with left leg (walkPh)
    float armPh = walkPh + (1.0 - isRight) * 3.14159265;
    float shA = walkW * 0.36 * sin(armPh) + (1.0 - walkW) * 0.025 * sin(breathPh + isRight * 1.1);
    float elA = walkW * (0.14 + 0.24 * max(0.0, sin(armPh))) + (1.0 - walkW) * 0.09;
    float pullZ = 0.0;

    // Right arm umbrella-holding pose (raises forearm forward/up to grip handle)
    if (isRight > 0.5 && umbLift > 0.01) {
      float uSway = 0.025 * sin(walkPh);
      shA = mix(shA, 0.55 + uSway, umbLift);
      elA = mix(elA, 1.20 - uSway * 0.5, umbLift);
      pullZ = -0.032 * umbLift;
    }

    if (part < 3.5) {
      vec3 rel = pos - aPivot;
      float t = clamp((aPivot.y - pos.y) / 0.30, 0.0, 1.0);
      pos = aPivot + pedRotZ(rel, shA) + vec3(0.0, pelvisDy, pullZ * t);
      nrm = pedRotZ(nrm, shA);
    } else {
      vec3 elRel = aPivot2 - aPivot;
      vec3 elNew = aPivot + pedRotZ(elRel, shA) + vec3(0.0, pelvisDy, pullZ);
      vec3 rel = pos - aPivot2;
      pos = elNew + pedRotZ(rel, shA + elA);
      nrm = pedRotZ(nrm, shA + elA);
    }
  } else {
    // Legs (4=L thigh, 5=R thigh, 8=L shin/foot, 9=R shin/foot)
    float isRight = (part > 4.5 && part < 5.5) || (part > 8.5) ? 1.0 : 0.0;
    float legPh = walkPh + isRight * 3.14159265;
    float hipA = walkW * (0.40 * sin(legPh) + 0.035 * sin(2.0 * legPh));
    // Knee flexes backward (-rotZ) during forward swing so foot clears the ground
    float kSwing = max(0.0, cos(legPh - 0.18));
    float kneeA = -walkW * (0.04 + 0.64 * kSwing * kSwing);

    if (part < 5.5) {
      vec3 rel = pos - aPivot;
      pos = aPivot + pedRotZ(rel, hipA) + vec3(0.0, pelvisDy, 0.0);
      nrm = pedRotZ(nrm, hipA);
    } else {
      vec3 kneeRel = aPivot2 - aPivot;
      vec3 kneeNew = aPivot + pedRotZ(kneeRel, hipA) + vec3(0.0, pelvisDy, 0.0);
      vec3 rel = pos - aPivot2;
      pos = kneeNew + pedRotZ(rel, hipA + kneeA);
      nrm = pedRotZ(nrm, hipA + kneeA);
      // Guarantee foot sole never penetrates below ground Y=0 during stride
      pos.y = max(pos.y, 0.0);
    }
  }
}
`;

export interface PedMaterialOptions {
  flatShading?: boolean;
  side?: THREE.Side;
  timeUniform?: { value: number };
}

/**
 * Multi-zone instanced PBR material for pedestrians, cyclists, bicycles & accessories.
 * Supports 1 draw call per archetype×LOD with independent per-instance skin, hair,
 * primary garment (`instanceColor`), and bottom garment colors plus GPU vertex animation.
 */
export function createPedMaterial(opts: PedMaterialOptions = {}): THREE.MeshStandardMaterial {
  const timeU = opts.timeUniform ?? PED_UNIFORMS.uPedTime;
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.72,
    metalness: 0.06,
    flatShading: opts.flatShading ?? false,
    side: opts.side ?? THREE.FrontSide,
  });
  mat.customProgramCacheKey = () => `cidade-viva-ped-v2-${opts.flatShading ? 'f' : 's'}-${opts.side ?? 0}`;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPedTime = timeU;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vPedMat;
        ${PED_ANIM_COMMON_GLSL}`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 objectNormal = vec3( normal );
        vec3 pedPosTmp = vec3( position );
        #ifdef USE_INSTANCING
          evalPedPose(pedPosTmp, objectNormal, aAnim);
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = pedPosTmp;`,
      )
      .replace(
        '#include <color_vertex>',
        `#if defined( USE_COLOR_ALPHA )
          vColor = vec4( 1.0 );
        #elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )
          vColor = vec3( 1.0 );
        #endif
        #ifdef USE_COLOR
          vColor *= color;
        #endif
        #ifdef USE_INSTANCING
          float pZone = aPedMeta.z;
          vec3 zoneTint = vec3( 1.0 );
          if (pZone > 0.5 && pZone < 1.5) {
            #ifdef USE_INSTANCING_COLOR
              zoneTint = instanceColor.xyz;
            #endif
          } else if (pZone >= 1.5 && pZone < 2.5) {
            zoneTint = aSkinColor;
          } else if (pZone >= 2.5 && pZone < 3.5) {
            zoneTint = aHairColor;
          } else if (pZone >= 3.5) {
            zoneTint = aBottomColor;
          }
          vColor.xyz *= zoneTint;
        #endif
        vPedMat = aPedMeta.xy;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPedMat;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(vPedMat.x, 0.04, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = clamp(vPedMat.y, 0.0, 1.0);');
  };
  return mat;
}

/** Matching depth material so cast shadows follow animated walking, umbrella, and cyclist poses. */
export function createPedDepthMaterial(timeUniform?: { value: number }): THREE.MeshDepthMaterial {
  const timeU = timeUniform ?? PED_UNIFORMS.uPedTime;
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.customProgramCacheKey = () => 'cidade-viva-ped-depth-v1';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPedTime = timeU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${PED_ANIM_COMMON_GLSL}`)
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3( position );
        vec3 pedNrmTmp = vec3( 0.0, 1.0, 0.0 );
        #ifdef USE_INSTANCING
          evalPedPose(transformed, pedNrmTmp, aAnim);
        #endif`,
      );
  };
  return mat;
}

export interface PedInstanceBuffers {
  skin: Float32Array;
  hair: Float32Array;
  bottom: Float32Array;
  anim: Float32Array;
  skinAttr: THREE.InstancedBufferAttribute;
  hairAttr: THREE.InstancedBufferAttribute;
  bottomAttr: THREE.InstancedBufferAttribute;
  animAttr: THREE.InstancedBufferAttribute;
  markUpdated: () => void;
}

/**
 * Attach per-instance color/animation attributes to a pedestrian/accessory InstancedMesh.
 * Note: clones the BufferGeometry container (sharing vertex buffers) so each mesh owns its instance attributes.
 */
export function attachPedInstanceBuffers(mesh: THREE.InstancedMesh, capacity: number): PedInstanceBuffers {
  const geo = mesh.geometry.clone();
  mesh.geometry = geo;
  const skin = new Float32Array(capacity * 3);
  const hair = new Float32Array(capacity * 3);
  const bottom = new Float32Array(capacity * 3);
  const anim = new Float32Array(capacity * 4);
  // Sensible defaults (neutral warm skin, dark hair, denim bottom, idle pose)
  for (let i = 0; i < capacity; i++) {
    skin[i * 3] = 0.78; skin[i * 3 + 1] = 0.56; skin[i * 3 + 2] = 0.43;
    hair[i * 3] = 0.10; hair[i * 3 + 1] = 0.08; hair[i * 3 + 2] = 0.06;
    bottom[i * 3] = 0.16; bottom[i * 3 + 1] = 0.22; bottom[i * 3 + 2] = 0.34;
    anim[i * 4] = 0; anim[i * 4 + 1] = 0; anim[i * 4 + 2] = 0; anim[i * 4 + 3] = 0;
  }
  const skinAttr = new THREE.InstancedBufferAttribute(skin, 3);
  const hairAttr = new THREE.InstancedBufferAttribute(hair, 3);
  const bottomAttr = new THREE.InstancedBufferAttribute(bottom, 3);
  const animAttr = new THREE.InstancedBufferAttribute(anim, 4);
  geo.setAttribute('aSkinColor', skinAttr);
  geo.setAttribute('aHairColor', hairAttr);
  geo.setAttribute('aBottomColor', bottomAttr);
  geo.setAttribute('aAnim', animAttr);

  return {
    skin,
    hair,
    bottom,
    anim,
    skinAttr,
    hairAttr,
    bottomAttr,
    animAttr,
    markUpdated() {
      skinAttr.needsUpdate = true;
      hairAttr.needsUpdate = true;
      bottomAttr.needsUpdate = true;
      animAttr.needsUpdate = true;
    },
  };
}
