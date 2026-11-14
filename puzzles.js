/*
 * 2Escape // PUZZLE FRAMEWORK
 * ============================================================================
 * Everything that defines a puzzle lives here:
 *   - seeded parameter generation (run layout, positions, make/model, solutions)
 *   - the interaction UI the operative sees in the puzzle modal
 *   - the handbook entries the hacker uses to talk the operative through it
 *   - the terminal overrides that let the hacker act on a puzzle
 *
 * The host page (index.html) keeps game state, networking, audio, timers and
 * every other screen. It talks to this file through window.PuzzleEngine:
 *
 *   PuzzleEngine.TOTAL_ROOMS                  rooms per run
 *   PuzzleEngine.ROOM_VIEW                    operative canvas design space
 *   PuzzleEngine.PUZZLE_SPRITE_RADIUS         sprite radius in that space
 *   PuzzleEngine.generateRun(seed)            -> [{ id, puzzles: [...] }]  (pure)
 *   PuzzleEngine.open(puzzle, ui, host)       -> { refresh(), dispose() }
 *   PuzzleEngine.openPreview(puzzle, ui, host)-> { refresh(), dispose() }
 *   PuzzleEngine.renderManual(container, rooms, host)
 *   PuzzleEngine.parseTerminalCommand(cmdText, ctx)
 *
 * `host` is supplied by index.html and may contain:
 *   t(key, params)        translation lookup
 *   wireColorName(idx)    localized wire colour (0..3)
 *   beep(...)             short UI sound
 *   error() / success()   failure / success sting
 *   solve(puzzle)         mark solved, sync peers, update HUD
 *   penalty(seconds)      apply a time penalty
 *   isOpen(puzzle)        true while the operative still has this puzzle open
 *   laserSync(puzzle, index, angle)  push an optical-relay mirror to the peer
 *
 * Terminal context: { activeRoom, activePuzzleId, rooms }.
 * parseTerminalCommand() returns null when the command is not a puzzle
 * command, otherwise a descriptor the host narrates and broadcasts:
 *   { kind: 'pump', puzzle, pumpKey, flow, roomId }
 *   { kind: 'pump-no-puzzle', cmd }         nothing open on the operative side
 *   { kind: 'pump-invalid', id }
 *   { kind: 'phase', puzzle, phase, roomId, matched }
 *   { kind: 'phase-no-room', room }
 *   { kind: 'phase-no-puzzle', room }
 *   { kind: 'fan', puzzle, delta, force, roomId }     levitating ball: fan+ / fan++ / fan- / fan--
 *   { kind: 'fan-no-puzzle', cmd }                    no levitation field open on the operative side
 *
 * ADDING A PUZZLE TYPE
 *   1. add an entry to PUZZLE_TYPES (labelKey, render, manualEntry)
 *   2. append its draws to drawPuzzleParameters() (see the note there)
 *   3. add the key to PUZZLE_TYPE_KEYS (this reshuffles every existing seed once)
 *   4. extend the handbook/terminal code only if it needs a new mechanic
 *
 * SEED STABILITY
 *   Every puzzle consumes the same draw schedule whatever its type, so a seed
 *   keeps producing the same run. New draws must be appended at the end of the
 *   schedule; inserting them in the middle would reroll every later puzzle.
 */
(function (global) {
    'use strict';

    const TOTAL_ROOMS = 20;

    // ---------------------------------------------------------------- layout
    // Authored in the operative canvas' design space (max 672 x 420)
    const ROOM_VIEW = Object.freeze({ width: 672, height: 420 });
    const PUZZLE_SPRITE_RADIUS = 14;
    const PUZZLE_MIN_SEPARATION = PUZZLE_SPRITE_RADIUS * 2; // one sprite diameter
    const DOOR_KEYPAD_POSITION = Object.freeze({ x: 600, y: 210 }); // right-hand exit, vertically centred
    const ROOM_PUZZLE_SLOTS = Object.freeze([
        Object.freeze({ x: 120, y: 100 }),
        Object.freeze({ x: 340, y: 100 }),
        Object.freeze({ x: 120, y: 320 }),
        Object.freeze({ x: 340, y: 320 }),
        Object.freeze({ x: 230, y: 210 }),
        Object.freeze({ x: 450, y: 210 })
    ]);

    // ------------------------------------------------------- seeded randomness
    class SeededPRNG {
        constructor(seedStr) {
            let hash = 0;
            for (let i = 0; i < seedStr.length; i++) {
                hash = ((hash << 5) - hash) + seedStr.charCodeAt(i);
                hash |= 0;
            }
            this.seed = Math.abs(hash) || 123456789;
        }
        next() {
            this.seed = (this.seed * 9301 + 49297) % 233280;
            return this.seed / 233280;
        }
        range(min, max) { return min + Math.floor(this.next() * (max - min + 1)); }
    }

    // ----------------------------------------------------- placement helpers
    function puzzlePlacementClearance(candidate, placedPositions) {
        if (placedPositions.length === 0) return Infinity;
        return Math.min(...placedPositions.map(placed =>
            Math.hypot(candidate.x - placed.x, candidate.y - placed.y)));
    }

    // Every puzzle keeps at least one sprite diameter from the others. Among the
    // candidates that satisfy that, `prefer` decides the ranking (higher wins) and
    // the roomiest one breaks ties, so nothing ends up merely touching.
    // If no candidate can keep the distance, the highest ranked one is used.
    function selectPuzzlePlacement(candidates, placedPositions, prefer) {
        const scored = candidates.map(candidate => ({
            candidate: candidate,
            clearance: puzzlePlacementClearance(candidate, placedPositions),
            priority: prefer ? prefer(candidate) : 0
        }));
        const free = scored.filter(entry => entry.clearance >= PUZZLE_MIN_SEPARATION);
        const pool = free.length > 0 ? free : scored;
        return pool.reduce((best, entry) => {
            if (entry.priority > best.priority) return entry;
            if (entry.priority === best.priority && entry.clearance > best.clearance) return entry;
            return best;
        }).candidate;
    }

    function distanceToDoor(pos) {
        return Math.hypot(pos.x - DOOR_KEYPAD_POSITION.x, pos.y - DOOR_KEYPAD_POSITION.y);
    }

    function getPuzzleCountForRoom(roomNum) {
        if (roomNum > TOTAL_ROOMS) throw new Error(`Maximum allowed room number is ${TOTAL_ROOMS}.`);
        if (roomNum < 5) return 3;
        if (roomNum < 10) return 4;
        if (roomNum < 15) return 5;
        return 6;
    }

    // ------------------------------------------------------------ device names
    const deviceBrands = [...new Set([
        'Aegis', 'CipherGrid', 'VoltTech', 'Nano', 'Micro', 'OmniKey', 'Cobalt', 'Vex',
        'Nexus', 'Krypton', 'ZeroSec', 'Titan', 'Spectra', 'Helix', 'Vortex', 'Synapse',
        'Axiom', 'Meridian', 'Obsidian', 'Bastion', 'Sentinel', 'NullPoint', 'Ghostline',
        'Hexlock', 'Echelon', 'Voltcore', 'ArcFlash', 'Dynamo', 'Argus', 'Atlas', 'Orion',
        'Rift', 'Quanta', 'Vector', 'Cobalt'
    ])];
    const deviceSeries = [...new Set([
        'Alpha', 'Pro', 'MK-IV', 'v3', '3000', 'X-Series', 'Quantum', 'Q5', 'EX', 'Ultra',
        'Core', 'Prime', 'Nova', 'Omega', 'Delta', '4K', 'Hyper', '4000', 'MK-V', 'R2', 'XC-9',
        '015', '07/16', 'v2', 'Tiny', 'Z7', '45.02.31', 'MK-III', 'RC-1', 'V2.1', 'MK-II', 'X-200',
        'MK-I', 'S3', 'T-1000', 'V5', 'R3', 'Zeta', 'MK-VI'
    ])];

    const DEVICE_TYPE_LABELS = {
        keypad: 'Numpad',
        frequency: 'Beep Synth',
        wires: 'Breaker Box',
        power_grid: 'Matrix Grid',
        pressure_cycle: 'Hydro Station',
        levitation: 'Levitation Column',
        laser: 'Optical Relay',
        laser_hurdles: 'Laser Hurdles',
        network_overload: 'Overload Relay'
    };

    // Bus capacities (fixed in v1) and target classes for network overload (#33).
    // Caps stay fixed; only the target class is seed-drawn via a dedicated PRNG.
    const NETWORK_BUS_CAPS = Object.freeze([42, 34, 28, 18]); // blue, amber, green, red
    const NETWORK_BUS_NAME_KEYS = Object.freeze([
        'overload.busBlue', 'overload.busAmber', 'overload.busGreen', 'overload.busRed'
    ]);
    const NETWORK_TARGETS = Object.freeze(['ai', 'server', 'appliance']);

    const NETWORK_BAND_MIN = 100;
    const NETWORK_BAND_MAX = 120;
    const NETWORK_HARD_TRIP = 125;
    const NETWORK_DWELL = 5;
    const NETWORK_DECAY = 4;
    const NETWORK_GRACE = 1.2;
    const NETWORK_MAX_GAUGE = 130;

    // Word keys for the laser hurdle access sequence. Every run shuffles this pool
    // with its own PRNG, so two hurdles in one run never share a sequence.
    const HURDLE_WORD_KEYS = [
        'nebula', 'quartz', 'vortex', 'cinder', 'lumen', 'onyx', 'pulsar', 'ember',
        'glacier', 'zephyr', 'cobalt', 'raven', 'atlas', 'helix', 'drift', 'prism',
        'tundra', 'solace', 'vector', 'mirage', 'cipher', 'orbit', 'flint', 'harbor',
        'krypton', 'ion', 'matrix', 'nomad', 'opal', 'phantom', 'rift', 'spark'
    ];

    function createHurdleKeyPicker(seedStr) {
        const pool = HURDLE_WORD_KEYS.slice();
        const prng = new SeededPRNG(`${seedStr}-HURDLE-KEYS`);
        for (let i = pool.length - 1; i > 0; i--) {
            const j = prng.range(0, i);
            const tmp = pool[i];
            pool[i] = pool[j];
            pool[j] = tmp;
        }

        let cursor = 0;
        return () => pool[cursor++ % pool.length];
    }

    // Deterministic, run-wide shuffled pool of brand/series combinations.
    // Each puzzle draws the next combination, so a make/model can never repeat within a run.
    function createDeviceNamePicker(seedStr) {
        const pairCount = deviceBrands.length * deviceSeries.length;
        const pool = [];
        for (let i = 0; i < pairCount; i++) pool.push(i);

        const prng = new SeededPRNG(`${seedStr}-DEVICE-NAMES`);
        for (let i = pool.length - 1; i > 0; i--) {
            const j = prng.range(0, i);
            const tmp = pool[i];
            pool[i] = pool[j];
            pool[j] = tmp;
        }

        let cursor = 0;
        return () => {
            const pairIdx = pool[cursor % pairCount];
            const round = Math.floor(cursor / pairCount);
            cursor++;
            // Only reached if a run has more puzzles than brand/series combinations
            return { pairIdx: pairIdx, suffix: round > 0 ? ` ${round + 1}` : '' };
        };
    }

    function generateDeviceName(prng, type, takeName) {
        // Keep the two legacy draws so puzzle parameters stay identical for a given seed
        prng.range(0, deviceBrands.length - 1);
        prng.range(0, deviceSeries.length - 1);

        const typeLabel = DEVICE_TYPE_LABELS[type] || 'Terminal';
        const pick = takeName();
        const brand = deviceBrands[Math.floor(pick.pairIdx / deviceSeries.length)];
        const series = deviceSeries[pick.pairIdx % deviceSeries.length];
        return `${brand} ${typeLabel} ${series}${pick.suffix}`;
    }

    // ------------------------------------------------------- parameterization
    // One draw schedule for all types. Rules of thumb:
    //   - the order below is part of every existing seed: append, never insert
    //   - unused values cost nothing and keep the stream aligned
    function drawPuzzleParameters(prng, nextPumpId) {
        const correctWireIdx = prng.range(0, 3);

        const gridRequiredCount = prng.range(3, 9);
        const indicesPool = [0, 1, 2, 3, 4, 5, 6, 7, 8];
        const powerGridTargets = [];
        for (let i = 0; i < gridRequiredCount; i++) {
            const pickIdx = prng.range(0, indicesPool.length - 1);
            powerGridTargets.push(indicesPool.splice(pickIdx, 1)[0]);
        }
        powerGridTargets.sort((a, b) => a - b);

        const targetTank = prng.range(1, 2);
        const targetLevel = prng.range(25, 95);
        const tank1 = prng.range(15, 85);
        const tank2 = 100 - tank1;

        const p1Id = nextPumpId();
        const p2Id = nextPumpId();
        const p1Flow = prng.range(15, 100);
        const p2Flow = prng.range(15, 100);

        const pin = String(prng.range(1000, 9999));
        const targetFreq = prng.range(200, 700);
        const targetPhase = prng.range(30, 150);

        // Levitating ball: the target height and the fan setting the run starts at.
        // The start force is derived (not drawn) so the difficulty stays a function of
        // the target alone and no extra draws sneak into the schedule.
        const levitationTarget = prng.range(20, 90);
        const levitationStartForce = levitationTarget < 50
            ? Math.min(90, levitationTarget + 25)
            : Math.max(10, levitationTarget - 25);

        return {
            pin: pin,
            targetFreq: targetFreq,
            targetPhase: targetPhase,
            currentPhaseInput: null,
            correctWireIdx: correctWireIdx,
            powerGridTargets: powerGridTargets,
            levitationTarget: levitationTarget,
            fanForce: levitationStartForce,
            pressureData: {
                targetTank: targetTank,
                targetLevel: targetLevel,
                tank1: tank1,
                tank2: tank2,
                p1: { id: p1Id, flow: p1Flow },
                p2: { id: p2Id, flow: p2Flow },
                initialVal: targetTank === 1 ? tank1 : tank2
            }
        };
    }

    // Type selection is part of every seed. Laser hurdles and the optical relay join
    // the regular type pool like any other puzzle, which intentionally reshuffles
    // layouts from older builds. New keys are appended so existing keys keep their
    // position in the pool.
    const LEGACY_TYPE_KEYS = ['keypad', 'frequency', 'wires', 'power_grid', 'pressure_cycle', 'levitation'];
    const TYPE_POOL = LEGACY_TYPE_KEYS.concat('laser_hurdles', 'laser', 'network_overload');
    const PUZZLE_TYPE_KEYS = LEGACY_TYPE_KEYS.concat('laser', 'laser_hurdles', 'network_overload');

    // Hurdle-only data comes from its own PRNG, so phrase draws never shift the
    // room's type, placement, parameter or device-name schedules.
    function createHurdleData(seedStr, roomNum, slot, takeHurdleKey) {
        const prng = new SeededPRNG(`${seedStr}-HURDLES-${roomNum}-${slot}`);
        const phrases = [];
        for (let i = 0; i < 4; i++) {
            phrases.push(prng.range(0, 255).toString(16).toUpperCase().padStart(2, '0'));
        }

        return {
            wordKey: takeHurdleKey(),
            phrases: phrases,
            started: false,
            passed: 0,
            accepted: 0,
            nextPhrasePass: 3,
            hits: 0
        };
    }

    // Optical-relay room data comes from its own PRNG, so mirror, wall and beam
    // draws never shift the room's type, placement, parameter or device-name
    // schedules.
    function createLaserData(seedStr, roomNum, slot) {
        const prng = new SeededPRNG(`${seedStr}-LASER-ROOM-${roomNum}-${slot}`);
        return createLaserRoom(prng.range(0, 2147483647));
    }

    // Network overload target class: drawn from a dedicated PRNG so it never shifts the
    // shared per-puzzle parameter schedule (cf. createHurdleData / createLaserData).
    function createNetworkData(seedStr, roomNum, slot) {
        const prng = new SeededPRNG(`${seedStr}-OVERLOAD-${roomNum}-${slot}`);
        return {
            targetKey: NETWORK_TARGETS[prng.range(0, NETWORK_TARGETS.length - 1)],
            injection: 0
        };
    }

    function syncFrequencyTotals(pList) {
        const freqTotal = pList.filter(p => p.type === 'frequency').length;
        pList.forEach(p => {
            if (p.type === 'frequency') p.totalFreqPuzzlesInRoom = freqTotal;
        });
    }

    function generateRoom(seedStr, roomNum, takeDeviceName, nextPumpId, takeHurdleKey) {
        const roomPrng = new SeededPRNG(`${seedStr}-ROOM-${roomNum}`);
        const puzzleCount = getPuzzleCountForRoom(roomNum);
        // Issue #22: no type repeats while unused types remain, so a room is filled
        // from a shuffled pool instead of independent draws. The pool is only refilled
        // when the puzzle count exceeds the number of types, which repeats nothing
        // before every type has been used once. Draw count stays equal to puzzleCount,
        // as in the legacy schedule.
        const typePool = TYPE_POOL.slice();
        const selectedTypes = [];
        for (let p = 0; p < puzzleCount; p++) {
            if (p >= typePool.length) typePool.push(...TYPE_POOL);
            const pickIdx = roomPrng.range(p, typePool.length - 1);
            selectedTypes.push(typePool[pickIdx]);
            typePool[pickIdx] = typePool[p];
        }

        const pList = [];
        const placedPositions = [];
        let keypadCount = 0;
        let otherPuzzleIndex = 0;
        let freqPuzzleCount = 0;

        selectedTypes.forEach((typeKey, pIdx) => {
            let posX, posY;
            if (typeKey === 'keypad') {
                const isDoorKeypad = keypadCount === 0;
                // Every keypad stays close to the exit: the first guards it, any
                // further keypad takes the free slot nearest the door.
                const candidates = isDoorKeypad
                    ? [DOOR_KEYPAD_POSITION, ...ROOM_PUZZLE_SLOTS]
                    : ROOM_PUZZLE_SLOTS;
                const free = selectPuzzlePlacement(
                    candidates,
                    placedPositions,
                    isDoorKeypad
                        ? candidate => (candidate === DOOR_KEYPAD_POSITION ? 1 : 0)
                        : candidate => -distanceToDoor(candidate)
                );
                posX = free.x;
                posY = free.y;
                keypadCount++;
            } else {
                // Keep the legacy jitter draws so unrelated puzzle parameters stay seed-stable
                const jitterX = roomPrng.range(-15, 15);
                const jitterY = roomPrng.range(-15, 15);
                const startSlot = otherPuzzleIndex % ROOM_PUZZLE_SLOTS.length;
                otherPuzzleIndex++;

                const candidates = [];
                for (let i = 0; i < ROOM_PUZZLE_SLOTS.length; i++) {
                    const slot = ROOM_PUZZLE_SLOTS[(startSlot + i) % ROOM_PUZZLE_SLOTS.length];
                    candidates.push({ x: slot.x + jitterX, y: slot.y + jitterY });
                }
                const free = selectPuzzlePlacement(candidates, placedPositions);
                posX = free.x;
                posY = free.y;
            }
            placedPositions.push({ x: posX, y: posY });

            let freqInRoomIndex = null;
            if (typeKey === 'frequency') {
                freqPuzzleCount++;
                freqInRoomIndex = freqPuzzleCount;
            }

            const makeModel = generateDeviceName(roomPrng, typeKey, takeDeviceName);
            const params = drawPuzzleParameters(roomPrng, nextPumpId);

            const puzzle = {
                id: `r${roomNum}_p${pIdx + 1}_${typeKey}`,
                room: roomNum,
                freqInRoomIndex: freqInRoomIndex,
                makeModel: makeModel,
                type: typeKey,
                x: posX,
                y: posY,
                solved: false,
                pin: params.pin,
                targetFreq: params.targetFreq,
                targetPhase: params.targetPhase,
                currentPhaseInput: params.currentPhaseInput,
                correctWireIdx: params.correctWireIdx,
                powerGridTargets: params.powerGridTargets,
                levitationTarget: params.levitationTarget,
                fanForce: params.fanForce,
                pressureData: params.pressureData
            };

            if (typeKey === 'laser_hurdles') {
                puzzle.hurdleData = createHurdleData(seedStr, roomNum, pIdx + 1, takeHurdleKey);
            }
            if (typeKey === 'laser') {
                puzzle.laserData = createLaserData(seedStr, roomNum, pIdx + 1);
            }
            if (typeKey === 'network_overload') {
                puzzle.networkData = createNetworkData(seedStr, roomNum, pIdx + 1);
            }

            pList.push(puzzle);
        });

        syncFrequencyTotals(pList);

        return { id: roomNum, puzzles: pList };
    }

    function generateRun(seedStr) {
        const seed = String(seedStr == null ? '' : seedStr);
        const takeDeviceName = createDeviceNamePicker(seed);
        const takeHurdleKey = createHurdleKeyPicker(seed);
        let pumpCounter = 1;
        const nextPumpId = () => `p${pumpCounter++}`;

        const run = [];
        for (let r = 1; r <= TOTAL_ROOMS; r++) {
            run.push(generateRoom(seed, r, takeDeviceName, nextPumpId, takeHurdleKey));
        }

        return run;
    }

    // ------------------------------------------------------------ puzzle rules
    // Pressure cycle tolerance: one-sided window, depending on the direction the
    // target tank is approached from.
    function isPressureWithinTolerance(initialValue, currentValue, target) {
        const thresholdDelta = 10; // 10% range

        if (initialValue > target) {
            // Started above target: accepted range is [target - 10%, target]
            return currentValue >= target - thresholdDelta && currentValue <= target;
        }
        if (initialValue < target) {
            // Started below target: accepted range is [target, target + 10%]
            return currentValue >= target && currentValue <= target + thresholdDelta;
        }
        // Edge case: initial value equals target
        return currentValue === target;
    }

    function isPowerGridSolved(targets, grid) {
        return targets.every(idx => grid[idx] === 1) &&
            grid.every((val, idx) => val === 0 || targets.includes(idx));
    }

    // --------------------------------------------------------- optical relay (#17)
    // The laser room is authored in its own 720 x 400 design space. Six mirrors
    // form a serpentine: laser -> M1 -> M2 -> M3 -> M4 -> M5 -> M6 -> target.
    // The operative only sees laser/beam/target; mirrors and walls are hidden
    // there but drawn in the hacker's room preview from the same data.
    const LASER_VIEW = Object.freeze({ width: 720, height: 400 });
    const LASER_MIRROR_RADIUS = 13;
    const LASER_TARGET_RADIUS = 17;

    function laserNormalize(x, y) {
        const len = Math.hypot(x, y) || 1;
        return { x: x / len, y: y / len };
    }

    // Mirrors are pane lines across a circle, so their normal is the pane line
    // turned by 90 degrees. The angle is the pane-line angle (0..360).
    function laserReflect(dir, angleDeg) {
        const a = angleDeg * Math.PI / 180;
        const nx = -Math.sin(a);
        const ny = Math.cos(a);
        const dot = dir.x * nx + dir.y * ny;
        return { x: dir.x - 2 * dot * nx, y: dir.y - 2 * dot * ny };
    }

    function laserCircleHitsRect(cx, cy, radius, rect, pad) {
        const nx = Math.max(rect.x - pad, Math.min(cx, rect.x + rect.w + pad));
        const ny = Math.max(rect.y - pad, Math.min(cy, rect.y + rect.h + pad));
        return Math.hypot(cx - nx, cy - ny) < radius;
    }

    // Liang-Barsky segment/rect clip, used to keep walls off the intended beam.
    function laserSegmentHitsRect(seg, rect, pad) {
        const minX = rect.x - pad;
        const maxX = rect.x + rect.w + pad;
        const minY = rect.y - pad;
        const maxY = rect.y + rect.h + pad;
        const dx = seg.b.x - seg.a.x;
        const dy = seg.b.y - seg.a.y;
        let t0 = 0;
        let t1 = 1;

        const clip = (p, q) => {
            if (p === 0) return q >= 0;
            const r = q / p;
            if (p < 0) {
                if (r > t1) return false;
                if (r > t0) t0 = r;
            } else {
                if (r < t0) return false;
                if (r < t1) t1 = r;
            }
            return true;
        };

        return clip(-dx, seg.a.x - minX) &&
            clip(dx, maxX - seg.a.x) &&
            clip(-dy, seg.a.y - minY) &&
            clip(dy, maxY - seg.a.y);
    }

    function castLaserRay(data, origin, dir, ignoredMirror) {
        const STEP = 1.2;
        const MAX = 2600;
        let x = origin.x;
        let y = origin.y;
        let dist = 0;

        while (dist < MAX) {
            x += dir.x * STEP;
            y += dir.y * STEP;
            dist += STEP;

            if (x < 3 || x > LASER_VIEW.width - 3 || y < 3 || y > LASER_VIEW.height - 3) {
                return { type: 'bounds', x: x, y: y };
            }
            for (let i = 0; i < data.walls.length; i++) {
                const wall = data.walls[i];
                if (x >= wall.x && x <= wall.x + wall.w && y >= wall.y && y <= wall.y + wall.h) {
                    return { type: 'wall', x: x, y: y };
                }
            }
            if (Math.hypot(x - data.target.x, y - data.target.y) <= data.target.r) {
                return { type: 'target', x: x, y: y };
            }
            for (let i = 0; i < data.mirrors.length; i++) {
                const mirror = data.mirrors[i];
                if (mirror === ignoredMirror) continue;
                if (Math.hypot(x - mirror.x, y - mirror.y) <= LASER_MIRROR_RADIUS) {
                    // The pane line runs across the diameter, so the beam pivots at the
                    // mirror centre. Reflecting at the disc edge would offset the outgoing
                    // ray by one radius and it would never line up with the next mirror.
                    return { type: 'mirror', mirror: mirror, x: mirror.x, y: mirror.y };
                }
            }
        }

        return { type: 'max', x: x, y: y };
    }

    function traceLaserBeam(data) {
        let pos = { x: data.laser.x, y: data.laser.y };
        let dir = { x: data.laser.dx, y: data.laser.dy };
        let ignored = null;
        const segments = [];
        let bounces = 0;
        let hitTarget = false;

        for (let bounce = 0; bounce < 12; bounce++) {
            const hit = castLaserRay(data, pos, dir, ignored);
            segments.push({ a: pos, b: { x: hit.x, y: hit.y } });

            if (hit.type === 'target') {
                hitTarget = true;
                break;
            }
            if (hit.type !== 'mirror') break;

            dir = laserReflect(dir, hit.mirror.angle);
            pos = { x: hit.x, y: hit.y };
            ignored = hit.mirror;
            bounces++;
        }

        return { segments: segments, bounces: bounces, hitTarget: hitTarget };
    }

    function laserStartAngle(prng, solution) {
        for (let attempt = 0; attempt < 16; attempt++) {
            const angle = prng.range(0, 71) * 5;
            const line = angle % 180;
            const delta = Math.abs(line - solution);
            if (Math.min(delta, 180 - delta) > 12) return angle;
        }
        return (solution + 35) % 360;
    }

    function laserWallFits(rect, data, walls, segments) {
        const W = LASER_VIEW.width;
        const H = LASER_VIEW.height;
        if (rect.x < 26 || rect.y < 26 || rect.x + rect.w > W - 26 || rect.y + rect.h > H - 26) return false;

        if (laserCircleHitsRect(data.laser.x, data.laser.y, 30, rect, 0)) return false;
        if (laserCircleHitsRect(data.target.x, data.target.y, LASER_TARGET_RADIUS + 10, rect, 0)) return false;
        for (let i = 0; i < data.mirrors.length; i++) {
            const mirror = data.mirrors[i];
            if (laserCircleHitsRect(mirror.x, mirror.y, LASER_MIRROR_RADIUS + 12, rect, 0)) return false;
        }

        for (let i = 0; i < segments.length; i++) {
            if (laserSegmentHitsRect(segments[i], rect, 6)) return false;
        }

        for (let i = 0; i < walls.length; i++) {
            const other = walls[i];
            if (rect.x < other.x + other.w + 10 && rect.x + rect.w + 10 > other.x &&
                rect.y < other.y + other.h + 10 && rect.y + rect.h + 10 > other.y) return false;
        }

        return true;
    }

    function buildLaserWalls(prng, data, segments) {
        const walls = [];
        const fits = (rect) => laserWallFits(rect, data, walls, segments);
        const W = LASER_VIEW.width;
        const H = LASER_VIEW.height;

        // Issue #17: at least one wall must break the direct line M1 -> target.
        // The rectangle is centred on that line and shrunk after every failed try.
        for (let attempt = 0; attempt < 90; attempt++) {
            const t = 0.22 + prng.range(0, 56) / 100;
            const cx = data.mirrors[0].x + (data.target.x - data.mirrors[0].x) * t;
            const cy = data.mirrors[0].y + (data.target.y - data.mirrors[0].y) * t;
            const shrink = Math.max(0.4, 1 - attempt / 120);
            const w = Math.max(26, Math.round(prng.range(48, 96) * shrink));
            const h = Math.max(18, Math.round(prng.range(26, 64) * shrink));
            const rect = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w: w, h: h };
            if (fits(rect)) {
                walls.push(rect);
                break;
            }
        }

        // A couple of decorative blocks so the room reads as a room, never on the path.
        const extras = prng.range(0, 2);
        for (let n = 0; n < extras; n++) {
            for (let attempt = 0; attempt < 20; attempt++) {
                const w = prng.range(34, 96);
                const h = prng.range(20, 56);
                const rect = {
                    x: prng.range(40, W - w - 40),
                    y: prng.range(40, H - h - 40),
                    w: w,
                    h: h
                };
                if (fits(rect)) {
                    walls.push(rect);
                    break;
                }
            }
        }

        return walls;
    }

    function createLaserRoom(seed) {
        const prng = new SeededPRNG('LASER-' + seed);
        const W = LASER_VIEW.width;
        const H = LASER_VIEW.height;

        // Four horizontal lanes, shuffled: the beam turns up/down unpredictably.
        const lanes = [70, 155, 245, 335].map(center => center + prng.range(-10, 10));
        for (let i = lanes.length - 1; i > 0; i--) {
            const j = prng.range(0, i);
            const tmp = lanes[i];
            lanes[i] = lanes[j];
            lanes[j] = tmp;
        }
        const y0 = lanes[0];
        const y1 = lanes[1];
        const y2 = lanes[2];
        const y3 = lanes[3];

        const x1 = prng.range(120, 175);
        const x2 = prng.range(285, 340);
        const x3 = prng.range(450, 505);
        const xTarget = prng.range(620, 668);

        // Muzzle, mirrors M1..M6, then the target - all connected in series.
        let points = [
            { x: 54, y: y0 },
            { x: x1, y: y0 },
            { x: x1, y: y1 },
            { x: x2, y: y1 },
            { x: x2, y: y2 },
            { x: x3, y: y2 },
            { x: x3, y: y3 },
            { x: xTarget, y: y3 }
        ];

        const flipX = prng.range(0, 1) === 1;
        const flipY = prng.range(0, 1) === 1;
        if (flipX) points = points.map(p => ({ x: W - p.x, y: p.y }));
        if (flipY) points = points.map(p => ({ x: p.x, y: H - p.y }));

        const laserDir = laserNormalize(points[1].x - points[0].x, points[1].y - points[0].y);

        const solutionAngles = [];
        for (let i = 1; i <= 6; i++) {
            const inDir = laserNormalize(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
            const outDir = laserNormalize(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
            const half = (Math.atan2(outDir.y, outDir.x) + Math.atan2(inDir.y, inDir.x)) / 2;
            let deg = Math.round(half * 180 / Math.PI) % 180;
            if (deg < 0) deg += 180;
            solutionAngles.push(deg);
        }

        const data = {
            laser: { x: points[0].x, y: points[0].y, dx: laserDir.x, dy: laserDir.y },
            target: { x: points[7].x, y: points[7].y, r: LASER_TARGET_RADIUS },
            mirrors: points.slice(1, 7).map((p, idx) => ({
                x: p.x,
                y: p.y,
                angle: laserStartAngle(prng, solutionAngles[idx])
            })),
            walls: [],
            solution: solutionAngles
        };

        const solutionSegments = [];
        for (let i = 0; i < points.length - 1; i++) {
            solutionSegments.push({ a: points[i], b: points[i + 1] });
        }
        data.walls = buildLaserWalls(prng, data, solutionSegments);

        // Safety net: never hand out an already solved beam.
        for (let guard = 0; guard < 12 && traceLaserBeam(data).hitTarget; guard++) {
            data.mirrors[0].angle = (data.mirrors[0].angle + 17) % 360;
        }

        return data;
    }

    // --------------------------------------------------- optical relay drawing
    function drawLaserWall(ctx, wall) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(wall.x, wall.y, wall.w, wall.h);
        ctx.clip();

        ctx.fillStyle = '#1b222c';
        ctx.fillRect(wall.x, wall.y, wall.w, wall.h);

        ctx.strokeStyle = 'rgba(0, 240, 255, .09)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let d = -wall.h; d < wall.w + wall.h; d += 9) {
            ctx.moveTo(wall.x + d, wall.y + wall.h);
            ctx.lineTo(wall.x + d + wall.h, wall.y);
        }
        ctx.stroke();
        ctx.restore();

        ctx.strokeStyle = '#39424f';
        ctx.lineWidth = 1;
        ctx.strokeRect(wall.x + .5, wall.y + .5, wall.w - 1, wall.h - 1);
    }

    function drawLaserSource(ctx, data, host) {
        const x = data.laser.x;
        const y = data.laser.y;
        const dir = data.laser.dx >= 0 ? 1 : -1;
        const housingX = dir > 0 ? x - 32 : x + 4;

        ctx.fillStyle = '#171d25';
        ctx.strokeStyle = 'rgba(255, 77, 77, .55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(housingX, y - 14, 28, 28);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#2a1a1c';
        ctx.beginPath();
        ctx.rect(dir > 0 ? x - 4 : x - 1, y - 6, 5, 12);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 77, 77, .55)';
        ctx.stroke();

        const glow = ctx.createRadialGradient(x, y, 0, x, y, 16);
        glow.addColorStop(0, 'rgba(255, 220, 220, .95)');
        glow.addColorStop(0.35, 'rgba(255, 80, 80, .65)');
        glow.addColorStop(1, 'rgba(255, 42, 42, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, 16, 0, Math.PI * 2);
        ctx.fill();

        ctx.font = '13px "Share Tech Mono", monospace';
        ctx.fillStyle = 'rgba(255, 120, 120, .8)';
        ctx.textAlign = dir > 0 ? 'left' : 'right';
        ctx.fillText(host.t('laser.sourceLabel'), dir > 0 ? housingX : housingX + 28, y - 22);
        ctx.textAlign = 'left';
    }

    function drawLaserTarget(ctx, data, solved, host) {
        const target = data.target;
        const color = solved ? '#00ff66' : '#ff2a2a';
        const rgb = solved ? '0,255,102' : '255,42,42';

        const glow = ctx.createRadialGradient(target.x, target.y, 0, target.x, target.y, 34);
        glow.addColorStop(0, `rgba(${rgb}, ${solved ? 0.35 : 0.16})`);
        glow.addColorStop(1, `rgba(${rgb}, 0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(target.x, target.y, 34, 0, Math.PI * 2);
        ctx.fill();

        ctx.lineWidth = 1.5;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(target.x, target.y, target.r, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = `rgba(${rgb}, .55)`;
        ctx.beginPath();
        ctx.arc(target.x, target.y, 8, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = `rgba(${rgb}, .35)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(target.x - 24, target.y);
        ctx.lineTo(target.x - target.r - 3, target.y);
        ctx.moveTo(target.x + target.r + 3, target.y);
        ctx.lineTo(target.x + 24, target.y);
        ctx.moveTo(target.x, target.y - 24);
        ctx.lineTo(target.x, target.y - target.r - 3);
        ctx.moveTo(target.x, target.y + target.r + 3);
        ctx.lineTo(target.x, target.y + 24);
        ctx.stroke();

        ctx.font = '12px "Share Tech Mono", monospace';
        ctx.fillStyle = `rgba(${rgb}, .8)`;
        ctx.textAlign = 'center';
        ctx.fillText(host.t('laser.targetLabel'), target.x, target.y + 40);
        ctx.textAlign = 'left';
    }

    function drawLaserBeam(ctx, beam, solved) {
        const segments = beam.segments;
        if (!segments.length) return;

        const rgb = solved ? '0,255,102' : '255,42,42';
        const color = solved ? '#00ff66' : '#ff2a2a';

        const path = () => {
            ctx.beginPath();
            segments.forEach((seg, i) => {
                if (i === 0) ctx.moveTo(seg.a.x, seg.a.y);
                ctx.lineTo(seg.b.x, seg.b.y);
            });
        };

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        path();
        ctx.strokeStyle = `rgba(${rgb}, .10)`;
        ctx.lineWidth = 14;
        ctx.stroke();

        path();
        ctx.strokeStyle = `rgba(${rgb}, .30)`;
        ctx.lineWidth = 6;
        ctx.stroke();

        path();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.2;
        ctx.stroke();

        const last = segments[segments.length - 1];
        if (!solved) {
            const spark = ctx.createRadialGradient(last.b.x, last.b.y, 0, last.b.x, last.b.y, 12);
            spark.addColorStop(0, 'rgba(255, 220, 180, .9)');
            spark.addColorStop(0.35, `rgba(${rgb}, .55)`);
            spark.addColorStop(1, `rgba(${rgb}, 0)`);
            ctx.fillStyle = spark;
            ctx.beginPath();
            ctx.arc(last.b.x, last.b.y, 12, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function drawLaserMirror(ctx, mirror, index) {
        const a = mirror.angle * Math.PI / 180;

        ctx.beginPath();
        ctx.arc(mirror.x, mirror.y, LASER_MIRROR_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 240, 255, .07)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 240, 255, .55)';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.save();
        ctx.shadowColor = 'rgba(0, 240, 255, .85)';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(mirror.x - Math.cos(a) * LASER_MIRROR_RADIUS, mirror.y - Math.sin(a) * LASER_MIRROR_RADIUS);
        ctx.lineTo(mirror.x + Math.cos(a) * LASER_MIRROR_RADIUS, mirror.y + Math.sin(a) * LASER_MIRROR_RADIUS);
        ctx.strokeStyle = '#d9feff';
        ctx.lineWidth = 2.4;
        ctx.stroke();
        ctx.restore();

        ctx.textAlign = 'right';
        ctx.font = '700 13px "Orbitron", sans-serif';
        ctx.fillStyle = '#00f0ff';
        ctx.fillText('M' + (index + 1), mirror.x - 18, mirror.y - 19);

        ctx.font = '12px "Share Tech Mono", monospace';
        ctx.fillStyle = '#6b7788';
        ctx.fillText(mirror.angle + '°', mirror.x - 18, mirror.y - 5);
        ctx.textAlign = 'left';
    }

    function drawLaserRoom(canvas, data, host, showHidden, beam) {
        const ctx = canvas.getContext('2d');
        const W = LASER_VIEW.width;
        const H = LASER_VIEW.height;
        const trace = beam || traceLaserBeam(data);
        const solved = trace.hitTarget;

        ctx.clearRect(0, 0, W, H);

        const bg = ctx.createRadialGradient(360, 200, 40, 360, 200, 470);
        bg.addColorStop(0, '#0a1219');
        bg.addColorStop(1, '#05080c');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0, 240, 255, .06)';
        ctx.beginPath();
        for (let x = 20; x < W; x += 20) {
            ctx.moveTo(x + .5, 0);
            ctx.lineTo(x + .5, H);
        }
        for (let y = 20; y < H; y += 20) {
            ctx.moveTo(0, y + .5);
            ctx.lineTo(W, y + .5);
        }
        ctx.stroke();

        if (showHidden) {
            data.walls.forEach(wall => drawLaserWall(ctx, wall));
        }

        drawLaserSource(ctx, data, host);
        drawLaserBeam(ctx, trace, solved);
        drawLaserTarget(ctx, data, solved, host);

        if (showHidden) {
            data.mirrors.forEach((mirror, index) => drawLaserMirror(ctx, mirror, index));
        }

        if (solved) {
            ctx.strokeStyle = 'rgba(0, 255, 102, .25)';
            ctx.lineWidth = 2;
            ctx.strokeRect(1, 1, W - 2, H - 2);
        }
    }

    // ------------------------------------------------------------- puzzle types
    const PUZZLE_TYPES = {
        keypad: {
            labelKey: 'ptype.keypad',
            manualEntry: (puzzle, host) =>
                `${host.t('manual.pin')} <span class="text-[#00f0ff] font-bold font-mono text-sm">${puzzle.pin}</span>`,
            render: (body, status, puzzle, host) => {
                let entered = '';
                body.innerHTML = `
                    <div class="text-center mb-4">
                        <div id="keypad-display" class="w-48 bg-[#0d0f12] border border-[#00f0ff] p-2 rounded text-xl font-mono text-[#00ff66] tracking-widest mb-3 glow-green">____</div>
                        <div class="grid grid-cols-3 gap-2 w-48 mx-auto" id="keypad-grid"></div>
                    </div>
                `;
                const gridElem = document.getElementById('keypad-grid');
                [1, 2, 3, 4, 5, 6, 7, 8, 9, 'C', 0, 'OK'].forEach(n => {
                    const btn = document.createElement('button');
                    btn.className = "p-2 bg-[#0d0f12] border border-gray-700 hover:border-[#00f0ff] text-[#00f0ff] font-orbitron font-bold rounded cursor-pointer";
                    btn.innerText = n;
                    btn.onclick = () => {
                        host.beep(500, 'sine', 0.05, 0.05);
                        if (n === 'C') entered = '';
                        else if (n === 'OK') {
                            if (entered === puzzle.pin) {
                                status.innerText = host.t('keypad.accepted');
                                host.solve(puzzle);
                            } else {
                                status.innerText = host.t('keypad.wrong');
                                host.error();
                                host.penalty(10);
                                entered = '';
                            }
                        } else { if (entered.length < 4) entered += n; }
                        document.getElementById('keypad-display').innerText = entered.padEnd(4, '_');
                    };
                    gridElem.appendChild(btn);
                });
            }
        },

        frequency: {
            labelKey: 'ptype.frequency',
            manualEntry: (puzzle, host) =>
                `${host.t('manual.targetFreq')} <span class="text-[#00f0ff] font-bold font-mono">${puzzle.targetFreq} Hz</span>`,
            render: (body, status, puzzle, host) => {
                let freq = 200;
                const formulaStr = `cos(phi)=[phaseValue]`;

                body.innerHTML = `
                    <div class="w-full flex flex-col items-center">
                        <canvas id="freq-canvas" width="280" height="100" class="bg-[#0d0f12] border border-[#00f0ff44] rounded mb-3"></canvas>
                        <div class="w-full space-y-3 text-xs">
                            <div>
                                <div class="flex justify-between items-center mb-1">
                                    <label class="text-gray-400">${host.t('freq.label')} <span id="lbl-freq" class="text-[#00ff66] font-mono font-bold">${freq}</span> Hz</label>
                                </div>
                                <div class="flex items-center gap-2">
                                    <button id="btn-freq-minus" class="px-3 py-1 bg-[#12161f] border border-[#00f0ff] text-[#00f0ff] font-bold rounded hover:bg-[#00f0ff] hover:text-[#0d0f12] cursor-pointer text-sm">-</button>
                                    <input type="range" min="100" max="800" value="${freq}" id="slider-freq" class="flex-1 accent-[#00f0ff] cursor-pointer">
                                    <button id="btn-freq-plus" class="px-3 py-1 bg-[#12161f] border border-[#00f0ff] text-[#00f0ff] font-bold rounded hover:bg-[#00f0ff] hover:text-[#0d0f12] cursor-pointer text-sm">+</button>
                                </div>
                            </div>
                            <div class="p-2.5 bg-[#0d0f12] border border-[#00f0ff33] rounded text-center font-mono">
                                <div class="text-[#00f0ff] font-bold text-xs">
                                    cos(φ) = <span id="disp-phase-angle" class="text-yellow-400">${puzzle.targetPhase}°</span>
                                </div>
                                <div class="text-[10px] text-gray-400 mt-1">${host.t('freq.requires')} <code class="bg-[#12161f] px-1.5 py-0.5 rounded text-[#00ff66] font-mono border border-gray-700">${formulaStr}</code></div>
                            </div>
                        </div>
                    </div>
                `;

                const canvas = document.getElementById('freq-canvas');
                const ctx = canvas.getContext('2d');
                const fSlider = document.getElementById('slider-freq');
                const btnMinus = document.getElementById('btn-freq-minus');
                const btnPlus = document.getElementById('btn-freq-plus');

                function drawWave() {
                    ctx.fillStyle = '#0d0f12';
                    ctx.fillRect(0, 0, 280, 100);
                    ctx.strokeStyle = '#00f0ff';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    const activePhase = puzzle.currentPhaseInput !== null ? puzzle.currentPhaseInput : 30;
                    for (let x = 0; x < 280; x++) {
                        const y = 50 + Math.sin((x + activePhase) * (freq / 1000)) * 30;
                        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                    }
                    ctx.stroke();
                }

                let toneTimer = null;

                function playTone() {
                    host.beep(freq, 'sine', 0.2, 0.07);
                }

                function stopTone() {
                    if (toneTimer) clearInterval(toneTimer);
                    toneTimer = null;
                }

                function checkFreq() {
                    const freqMatched = Math.abs(freq - puzzle.targetFreq) < 20;
                    const phaseMatched = puzzle.currentPhaseInput !== null && Math.abs(puzzle.currentPhaseInput - puzzle.targetPhase) < 5;

                    if (freqMatched && phaseMatched) {
                        status.innerText = host.t('freq.solved');
                        stopTone();
                        host.solve(puzzle);
                    } else if (freqMatched && !phaseMatched) {
                        status.innerText = host.t('freq.matched');
                    } else {
                        status.innerText = host.t('freq.awaiting');
                    }
                }

                function updateFreqValue(newVal) {
                    freq = Math.min(800, Math.max(100, newVal));
                    fSlider.value = freq;
                    document.getElementById('lbl-freq').innerText = freq;
                    drawWave();
                    checkFreq();
                }

                fSlider.oninput = (e) => { updateFreqValue(parseInt(e.target.value)); };
                btnMinus.onclick = () => { updateFreqValue(freq - 5); };
                btnPlus.onclick = () => { updateFreqValue(freq + 5); };

                drawWave();
                // The selected frequency is played back to the operative every 1.5s,
                // so tuning the slider changes what the next beep sounds like.
                playTone();
                toneTimer = setInterval(playTone, 1500);

                // The peer syncing the phase (or the terminal) calls refresh()
                return {
                    refresh: () => {
                        drawWave();
                        checkFreq();
                    },
                    dispose: stopTone
                };
            }
        },

        wires: {
            labelKey: 'ptype.wires',
            manualEntry: (puzzle, host) => {
                const rule = host.t('wire.rule', { n: puzzle.correctWireIdx + 1, color: host.wireColorName(puzzle.correctWireIdx) });
                return `${host.t('manual.instruction')} <span class="text-[#00f0ff] font-bold font-mono">${rule}</span>`;
            },
            render: (body, status, puzzle, host) => {
                const wires = [
                    { hex: '#ff2a2a' },
                    { hex: '#00f0ff' },
                    { hex: '#ffcc00' },
                    { hex: '#00ff66' }
                ];
                body.innerHTML = `<div class="w-full space-y-2" id="wires-container"></div>`;
                const wc = document.getElementById('wires-container');
                wires.forEach((w, idx) => {
                    const btn = document.createElement('button');
                    btn.className = "w-full p-2.5 bg-[#0d0f12] border border-gray-700 hover:border-[#00f0ff] rounded flex items-center justify-between cursor-pointer";
                    btn.innerHTML = `<span class="font-orbitron font-bold text-xs" style="color: ${w.hex}">${host.t('wire.label', { n: idx + 1, color: host.wireColorName(idx).toUpperCase() })}</span><span class="text-xs text-gray-500">${host.t('wire.cut')}</span>`;
                    btn.onclick = () => {
                        if (idx === puzzle.correctWireIdx) {
                            host.beep(300, 'sawtooth', 0.15, 0.2);
                            status.innerText = host.t('wire.solved');
                            host.solve(puzzle);
                        } else {
                            host.error();
                            status.innerText = host.t('wire.wrong');
                            host.penalty(10);
                        }
                    };
                    wc.appendChild(btn);
                });
            }
        },

        power_grid: {
            labelKey: 'ptype.power_grid',
            manualEntry: (puzzle, host) => {
                if (puzzle.powerGridTargets.length === 9) {
                    return `${host.t('manual.state')} <span class="text-[#00ff66] font-bold">${host.t('manual.syncAll')}</span>`;
                }
                const nodesList = puzzle.powerGridTargets.map(n => n + 1).join(', ').replace(/, ([^,]*)$/, `${host.t('common.and')}$1`);
                return `${host.t('manual.state')} <span class="text-[#00ff66] font-bold">${host.t('manual.syncNodes', { nodes: nodesList })}</span>`;
            },
            render: (body, status, puzzle, host) => {
                const grid = [0, 0, 0, 0, 0, 0, 0, 0, 0];
                body.innerHTML = `<div class="w-full flex flex-col items-center"><div class="grid grid-cols-3 gap-2 w-56 h-56" id="power-grid-container"></div></div>`;
                const gContainer = document.getElementById('power-grid-container');

                grid.forEach((val, idx) => {
                    const btn = document.createElement('button');
                    btn.className = `border ${val ? 'bg-[#00ff6633] border-[#00ff66] text-[#00ff66]' : 'bg-[#0d0f12] border-gray-700 text-gray-600'} font-orbitron font-bold rounded flex items-center justify-center cursor-pointer text-xs`;
                    btn.innerText = `N-${idx + 1}`;
                    btn.onclick = () => {
                        host.beep(650, 'sine', 0.05, 0.05);
                        grid[idx] = grid[idx] ? 0 : 1;
                        btn.className = `border ${grid[idx] ? 'bg-[#00ff6633] border-[#00ff66] text-[#00ff66]' : 'bg-[#0d0f12] border-gray-700 text-gray-600'} font-orbitron font-bold rounded flex items-center justify-center cursor-pointer text-xs`;

                        if (isPowerGridSolved(puzzle.powerGridTargets, grid)) {
                            status.innerText = host.t('grid.solved');
                            host.solve(puzzle);
                        }
                    };
                    gContainer.appendChild(btn);
                });
            }
        },

        pressure_cycle: {
            labelKey: 'ptype.pressure_cycle',
            render: (body, status, puzzle, host) => {
                const pd = puzzle.pressureData;

                body.innerHTML = `
                    <div class="w-full flex flex-col items-center space-y-4 font-mono text-xs">
                        <div class="w-full grid grid-cols-2 gap-4 bg-[#0d0f12] border border-[#00f0ff44] rounded p-4">
                            <!-- Tank 1 Progress Bar -->
                            <div class="flex flex-col items-center">
                                <div class="text-[#00f0ff] font-orbitron font-bold mb-1">${host.t('pressure.tank', { n: 1 })}</div>
                                <div class="relative w-16 h-36 bg-gray-900 border border-gray-700 rounded overflow-hidden flex flex-col justify-end">
                                    <div id="tank1-fill" class="w-full bg-[#00ff66] transition-all duration-300" style="height: ${pd.tank1}%"></div>
                                    ${pd.targetTank === 1 ? `<div class="absolute w-full border-t-2 border-red-500 z-10" style="bottom: ${pd.targetLevel}%"></div>` : ''}
                                </div>
                                <div class="mt-2 text-gray-300"><span id="tank1-val">${Math.round(pd.tank1)}</span>% ${pd.targetTank === 1 ? `<span class="text-red-400 font-bold">${host.t('pressure.target', { level: pd.targetLevel })}</span>` : ''}</div>
                            </div>

                            <!-- Tank 2 Progress Bar -->
                            <div class="flex flex-col items-center">
                                <div class="text-[#00f0ff] font-orbitron font-bold mb-1">${host.t('pressure.tank', { n: 2 })}</div>
                                <div class="relative w-16 h-36 bg-gray-900 border border-gray-700 rounded overflow-hidden flex flex-col justify-end">
                                    <div id="tank2-fill" class="w-full bg-[#00ff66] transition-all duration-300" style="height: ${pd.tank2}%"></div>
                                    ${pd.targetTank === 2 ? `<div class="absolute w-full border-t-2 border-red-500 z-10" style="bottom: ${pd.targetLevel}%"></div>` : ''}
                                </div>
                                <div class="mt-2 text-gray-300"><span id="tank2-val">${Math.round(pd.tank2)}</span>% ${pd.targetTank === 2 ? `<span class="text-red-400 font-bold">${host.t('pressure.target', { level: pd.targetLevel })}</span>` : ''}</div>
                            </div>
                        </div>

                        <!-- Pumps Panel with Direct Flow Symbols & Rates -->
                        <div class="w-full grid grid-cols-2 gap-2 text-center">
                            <div class="bg-[#12161f] border border-gray-700 p-2 rounded">
                                <div class="text-[#00f0ff] font-bold">P1 ▶</div>
                                <div class="text-gray-400 text-[10px]">${host.t('pressure.rate')} <span id="p1-rate" class="text-[#00ff66]">${pd.p1.flow}</span>%</div>
                            </div>
                            <div class="bg-[#12161f] border border-gray-700 p-2 rounded">
                                <div class="text-[#00f0ff] font-bold">◀ P2</div>
                                <div class="text-gray-400 text-[10px]">${host.t('pressure.rate')} <span id="p2-rate" class="text-[#00ff66]">${pd.p2.flow}</span>%</div>
                            </div>
                        </div>

                        <div class="text-gray-400 text-center">
                            ${host.t('pressure.commands')} <code class="text-[#00ff66] bg-[#0d0f12] px-1 py-0.5 border border-gray-700 rounded">p1 [0-100]</code> | <code class="text-[#00ff66] bg-[#0d0f12] px-1 py-0.5 border border-gray-700 rounded">p2 [0-100]</code>
                        </div>
                    </div>
                `;

                const simInterval = setInterval(() => {
                    if (puzzle.solved || !host.isOpen(puzzle)) {
                        clearInterval(simInterval);
                        return;
                    }

                    const flow1 = (pd.p1.flow / 100) * 10;
                    const flow2 = (pd.p2.flow / 100) * 10;
                    const net = flow1 - flow2;

                    if (net > 0) {
                        const tr = Math.min(net, pd.tank1);
                        pd.tank1 -= tr;
                        pd.tank2 += tr;
                    } else if (net < 0) {
                        const tr = Math.min(Math.abs(net), pd.tank2);
                        pd.tank1 += tr;
                        pd.tank2 -= tr;
                    }

                    const currentTargetVal = pd.targetTank === 1 ? pd.tank1 : pd.tank2;

                    if (isPressureWithinTolerance(pd.initialVal, currentTargetVal, pd.targetLevel)) {
                        status.innerText = host.t('pressure.solved');
                        host.solve(puzzle);
                        clearInterval(simInterval);
                    }

                    // Update UI elements live
                    const t1Fill = document.getElementById('tank1-fill');
                    const t2Fill = document.getElementById('tank2-fill');
                    const t1Val = document.getElementById('tank1-val');
                    const t2Val = document.getElementById('tank2-val');
                    const p1Rate = document.getElementById('p1-rate');
                    const p2Rate = document.getElementById('p2-rate');

                    if (t1Fill) t1Fill.style.height = `${pd.tank1}%`;
                    if (t2Fill) t2Fill.style.height = `${pd.tank2}%`;
                    if (t1Val) t1Val.innerText = Math.round(pd.tank1);
                    if (t2Val) t2Val.innerText = Math.round(pd.tank2);
                    if (p1Rate) p1Rate.innerText = pd.p1.flow;
                    if (p2Rate) p2Rate.innerText = pd.p2.flow;
                }, 3000);

                return {
                    dispose: () => clearInterval(simInterval)
                };
            }
        },

        levitation: {
            labelKey: 'ptype.levitation',
            render: (body, status, puzzle, host) => {
                // ---- geometry: one 0..100 % height scale from the fan up to the ceiling.
                const SHAFT_W = 208;
                const SHAFT_H = 300;
                const FAN_ZONE = 56;
                const TOP_MARGIN = 24;

                // ---- simulation
                const TOLERANCE = 3;      // #14: solved within ±3 of the target
                const SETTLE_SPEED = 5;   // %/s - the ball must hover, not fly through the band
                const DWELL = 0.5;        // seconds at rest inside the band before it counts
                const OMEGA = 2.6;        // cushion stiffness (rad/s)
                const ZETA = 0.3;         // damping ratio

                const targetValue = puzzle.levitationTarget;
                const yFor = (value) => FAN_ZONE + (value / 100) * (SHAFT_H - FAN_ZONE - TOP_MARGIN);

                body.innerHTML = `
                    <div class="w-full flex flex-col items-center gap-3">
                        <div id="lev-shaft" class="relative overflow-hidden rounded-lg"
                            style="width:${SHAFT_W}px;height:${SHAFT_H}px;border:1px solid rgba(0,240,255,.28);
                                   background-color:#070a0f;
                                   background-image:linear-gradient(rgba(0,240,255,.055) 1px, transparent 1px),linear-gradient(90deg, rgba(0,240,255,.055) 1px, transparent 1px),radial-gradient(circle at 50% 100%, rgba(0,240,255,.10), transparent 62%);
                                   background-size:22px 22px,22px 22px,100% 100%;">
                            <div id="lev-air" class="absolute left-0 right-0 top-0 overflow-hidden" style="bottom:${FAN_ZONE}px"></div>

                            <div id="lev-target" class="absolute left-0 right-0 z-10" style="bottom:0">
                                <div id="lev-target-line" class="border-t-2 border-dashed border-[#ff2a2a]"
                                    style="box-shadow:0 0 8px rgba(255,42,42,.45)"></div>
                                <span id="lev-target-flag"
                                    class="absolute right-1 -top-2 px-1 border border-[#ff2a2a] rounded-sm bg-[#0d0f12] font-orbitron text-[8px] tracking-widest text-[#ff6b6b]">${host.t('lev.target')}</span>
                            </div>

                            <div id="lev-ball" class="absolute left-1/2 z-20"
                                style="width:26px;height:26px;margin-left:-13px;margin-bottom:-13px;bottom:0">
                                <div id="lev-ball-core" class="w-full h-full rounded-full"
                                    style="background:radial-gradient(circle at 34% 30%, #d9feff 0%, #57f2ff 28%, #00c2d4 62%, #00707d 100%);
                                           box-shadow:0 0 10px rgba(0,240,255,.85), 0 0 24px rgba(0,240,255,.45), inset -3px -3px 7px rgba(0,0,0,.45)"></div>
                            </div>

                            <div class="absolute left-0 right-0 bottom-0 z-30 flex items-end justify-center"
                                style="height:${FAN_ZONE}px;background:linear-gradient(to top, rgba(0,240,255,.07), transparent)">
                                <div id="lev-fan" class="absolute rounded-full"
                                    style="width:62px;height:62px;bottom:16px;border:1px solid rgba(0,240,255,.55);
                                           background:repeating-conic-gradient(from 0deg, rgba(0,240,255,.42) 0deg 16deg, rgba(0,240,255,.04) 16deg 45deg),radial-gradient(circle, rgba(0,240,255,.10), transparent 68%);
                                           box-shadow:0 0 18px rgba(0,240,255,.30), inset 0 0 16px rgba(0,240,255,.22);"></div>
                                <div class="absolute rounded-full"
                                    style="width:14px;height:14px;bottom:41px;background:radial-gradient(circle, #c8fbff, #0097a8 70%, #00434c);box-shadow:0 0 12px rgba(0,240,255,.8)"></div>
                                <div class="relative w-full h-[14px] flex items-center justify-center border-t border-[#00f0ff44] bg-[#0d1116] font-orbitron text-[7px] tracking-[0.28em] text-[#00f0ff8c]">${host.t('lev.fan')}</div>
                            </div>
                        </div>

                        <div class="w-full px-3 py-2 bg-[#0d0f12] border border-gray-700 rounded text-center text-[11px] leading-relaxed">
                            <div><span class="text-gray-500">${host.t('lev.hintLabel')}</span>
                                <code class="text-[#00ff66] font-mono">fan+</code>
                                <code class="text-[#00ff66] font-mono">fan++</code>
                                <code class="text-[#00ff66] font-mono">fan-</code>
                                <code class="text-[#00ff66] font-mono">fan--</code>
                            </div>
                            <div class="text-[10px] text-gray-500 mt-0.5">${host.t('lev.hintNote')}</div>
                        </div>
                    </div>
                `;

                const ballEl = document.getElementById('lev-ball');
                const targetEl = document.getElementById('lev-target');
                const fanEl = document.getElementById('lev-fan');
                const airEl = document.getElementById('lev-air');

                targetEl.style.bottom = yFor(targetValue) + 'px';

                // Air streaks rise from the fan. Kept in JS (no keyframes) so the whole
                // animation lives in this file and can follow the fan force.
                const streaks = [];
                const airHeight = SHAFT_H - FAN_ZONE;
                for (let i = 0; i < 9; i++) {
                    const el = document.createElement('div');
                    el.className = 'absolute rounded-sm';
                    el.style.left = (8 + Math.random() * 84) + '%';
                    el.style.width = '2px';
                    el.style.height = (24 + Math.random() * 34) + 'px';
                    el.style.bottom = '-46px';
                    el.style.background = 'linear-gradient(to top, rgba(0,240,255,0), rgba(0,240,255,.85))';
                    airEl.appendChild(el);
                    streaks.push({
                        el: el,
                        y: Math.random() * (airHeight + 46),
                        k: 0.8 + Math.random() * 0.5
                    });
                }

                let h = puzzle.fanForce;   // current ball height, 0..100
                let v = 0;                 // vertical speed, %/s
                let dwell = 0;             // seconds spent inside the target band
                let solvedNow = false;
                let fanAngle = 0;
                let lastFrame = 0;
                let raf = 0;
                let lastForce = -1;

                function place(dt, now) {
                    const visH = h + Math.sin(now / 420) * 0.4;   // cosmetic wobble only
                    ballEl.style.bottom = yFor(visH) + 'px';
                }

                function animateFan(dt, force) {
                    if (force !== lastForce) {
                        lastForce = force;
                        const opacity = (0.15 + (force / 100) * 0.55).toFixed(2);
                        streaks.forEach(s => { s.el.style.opacity = opacity; });
                    }
                    fanAngle = (fanAngle + dt * (40 + force * 5)) % 360;
                    fanEl.style.transform = `rotate(${fanAngle}deg)`;

                    const speed = 25 + force * 1.1;   // px/s
                    streaks.forEach(s => {
                        s.y += speed * s.k * dt;
                        if (s.y > airHeight + 46) s.y = 0;
                        s.el.style.transform = `translateY(${-s.y}px)`;
                    });
                }

                function markSolved() {
                    solvedNow = true;
                    status.innerText = host.t('lev.solved');
                    document.getElementById('lev-target-line').style.borderTopColor = '#00ff66';
                    document.getElementById('lev-target-line').style.boxShadow = '0 0 10px rgba(0,255,102,.55)';
                    document.getElementById('lev-target-flag').style.borderColor = 'rgba(0,255,102,.7)';
                    document.getElementById('lev-target-flag').style.color = '#00ff66';
                    document.getElementById('lev-ball-core').style.background =
                        'radial-gradient(circle at 34% 30%, #e4ffea 0%, #7dffb0 28%, #00e05c 62%, #00752f 100%)';
                    document.getElementById('lev-ball-core').style.boxShadow =
                        '0 0 12px rgba(0,255,102,.95), 0 0 30px rgba(0,255,102,.55), inset -3px -3px 7px rgba(0,0,0,.45)';
                    host.solve(puzzle);
                }

                // Damped cushion: lift falls off linearly with height around the height
                // the fan is rated for, so the ball settles at exactly fanForce with a
                // little overshoot on the way.
                function frame(now) {
                    const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0.016;
                    lastFrame = now;

                    if (!host.isOpen(puzzle)) {
                        cancelAnimationFrame(raf);
                        return;
                    }

                    if (!puzzle.solved && !solvedNow) {
                        const a = OMEGA * OMEGA * (puzzle.fanForce - h) - 2 * ZETA * OMEGA * v;
                        v += a * dt;
                        h += v * dt;

                        if (h < 0) { h = 0; if (v < 0) v = 0; }
                        if (h > 100) { h = 100; if (v > 0) v = 0; }

                        if (Math.abs(h - targetValue) <= TOLERANCE && Math.abs(v) <= SETTLE_SPEED) {
                            dwell += dt;
                            if (dwell >= DWELL) markSolved();
                        } else {
                            dwell = 0;
                        }
                    }

                    place(dt, now);
                    animateFan(dt, puzzle.fanForce);
                    raf = requestAnimationFrame(frame);
                }

                status.innerText = host.t('lev.ready');
                place(0, 0);
                raf = requestAnimationFrame(frame);

                return {
                    dispose: () => cancelAnimationFrame(raf)
                };
            }
        },

        laser: {
            labelKey: 'ptype.laser',
            hasRoomPreview: true,
            manualEntry: (puzzle, host) =>
                `${host.t('laser.manualEntry')}` +
                `<div class="text-[10px] text-gray-500 mt-1">${host.t('laser.manualNote')}</div>`,
            render: (body, status, puzzle, host) => {
                const data = puzzle.laserData;

                body.innerHTML = `
                    <div class="w-full flex flex-col items-center gap-3">
                        <canvas id="laser-room-canvas" width="720" height="400"
                            class="w-full h-auto bg-[#0a0c10] border border-[#00f0ff44] rounded"></canvas>
                        <div class="w-full flex items-center justify-between">
                            <span class="font-orbitron text-[10px] tracking-widest text-gray-500">${host.t('laser.knobHeading')}</span>
                        </div>
                        <div id="laser-knobs" class="laser-knobs"></div>
                        <div class="w-full bg-[#0d0f12] border border-gray-700 rounded px-3 py-2">
                            <div class="flex items-center justify-between text-[10px] text-gray-400 mb-1">
                                <span class="tracking-widest">${host.t('laser.angleLabel')}
                                    <b id="laser-selected-mirror" class="text-[#00f0ff] font-orbitron">M1</b></span>
                                <span id="laser-selected-angle" class="font-mono text-[#00f0ff]">${data.mirrors[0].angle}°</span>
                            </div>
                            <input id="laser-angle" type="range" min="0" max="360" step="1"
                                value="${data.mirrors[0].angle}"
                                class="w-full accent-[#00f0ff] cursor-pointer">
                            <div class="text-[9px] text-gray-500 mt-1">${host.t('laser.hint')}</div>
                        </div>
                    </div>
                `;

                const canvas = document.getElementById('laser-room-canvas');
                const knobsContainer = document.getElementById('laser-knobs');
                const slider = document.getElementById('laser-angle');
                const knobElements = [];
                let selected = 0;
                let solvedNow = false;

                data.mirrors.forEach((mirror, index) => {
                    const knob = document.createElement('button');
                    knob.type = 'button';
                    knob.className = 'laser-knob';
                    knob.innerHTML =
                        `<span class="laser-knob-dial">` +
                        `<span class="laser-knob-pane"></span>` +
                        `<span class="laser-knob-hub"></span>` +
                        `</span>` +
                        `<span class="laser-knob-label">M${index + 1}</span>` +
                        `<span class="laser-knob-deg">${mirror.angle}°</span>`;
                    knob.addEventListener('click', () => {
                        host.beep(600, 'sine', 0.05, 0.05);
                        selected = index;
                        syncKnobs();
                    });
                    knobsContainer.appendChild(knob);
                    knobElements.push(knob);
                });

                function syncKnobs() {
                    knobElements.forEach((knob, index) => {
                        const mirror = data.mirrors[index];
                        knob.classList.toggle('selected', index === selected);
                        knob.querySelector('.laser-knob-pane').style.transform = 'rotate(' + mirror.angle + 'deg)';
                        knob.querySelector('.laser-knob-deg').innerText = mirror.angle + '°';
                    });
                    document.getElementById('laser-selected-mirror').innerText = 'M' + (selected + 1);
                    document.getElementById('laser-selected-angle').innerText = data.mirrors[selected].angle + '°';
                    slider.value = data.mirrors[selected].angle;
                }

                function updateBeam() {
                    const beam = traceLaserBeam(data);
                    drawLaserRoom(canvas, data, host, false, beam);

                    if (beam.hitTarget) {
                        status.innerText = host.t('laser.statusSolved');
                        if (!solvedNow && !puzzle.solved) {
                            solvedNow = true;
                            host.solve(puzzle);
                        }
                    } else if (beam.bounces > 0) {
                        status.innerText = host.t('laser.statusRouted');
                    } else {
                        status.innerText = host.t('laser.statusBlocked');
                    }
                }

                slider.addEventListener('input', (event) => {
                    const angle = Math.min(360, Math.max(0, parseInt(event.target.value, 10) || 0));
                    data.mirrors[selected].angle = angle;
                    syncKnobs();
                    updateBeam();
                    host.laserSync(puzzle, selected, angle);
                });

                syncKnobs();
                updateBeam();

                // Peer updates (and later re-opens) re-render without rebuilding the DOM.
                return {
                    refresh: () => {
                        syncKnobs();
                        updateBeam();
                    }
                };
            },
            renderPreview: (body, status, puzzle, host) => {
                const data = puzzle.laserData;
                const swatch = {
                    laser: 'background:#ff2a2a;border-radius:50%;box-shadow:0 0 6px rgba(255,42,42,.8);',
                    mirror: 'border-radius:50%;border:1px solid #00f0ff;background:linear-gradient(135deg, transparent 44%, #d9feff 44%, #d9feff 56%, transparent 56%);',
                    wall: 'background:#39424f;border:1px solid #485264;border-radius:2px;',
                    target: 'border-radius:50%;border:1px solid #ff2a2a;'
                };
                const legendItem = (kind, label) =>
                    `<span style="display:inline-flex;align-items:center;gap:5px;">` +
                    `<i style="display:inline-block;width:10px;height:10px;${swatch[kind]}"></i>${label}</span>`;

                body.innerHTML = `
                    <canvas id="preview-laser-canvas" width="720" height="400"
                        class="w-full h-auto bg-[#0a0c10] border border-[#00f0ff44] rounded"></canvas>
                    <div class="flex flex-wrap text-[10px] text-gray-400 w-full" style="gap:6px 14px;">
                        ${legendItem('laser', host.t('laser.legendLaser'))}
                        ${legendItem('mirror', host.t('laser.legendMirror'))}
                        ${legendItem('wall', host.t('laser.legendWall'))}
                        ${legendItem('target', host.t('laser.legendTarget'))}
                    </div>
                `;

                const canvas = document.getElementById('preview-laser-canvas');

                function refresh() {
                    const beam = traceLaserBeam(data);
                    drawLaserRoom(canvas, data, host, true, beam);
                    if (beam.hitTarget) status.innerText = host.t('laser.statusSolved');
                    else if (beam.bounces > 0) status.innerText = host.t('laser.statusRouted');
                    else status.innerText = host.t('laser.statusBlocked');
                }

                refresh();

                return {
                    refresh: refresh,
                    puzzleId: puzzle.id
                };
            }
        },
        laser_hurdles: {
            labelKey: 'ptype.laser_hurdles',
            manualEntry: (puzzle, host) =>
                `${host.t('hurdle.manualSequence')} ` +
                `<span class="text-[#00ff66] font-mono font-bold">laser(${puzzle.hurdleData.wordKey})</span>` +
                `<div class="text-[10px] text-gray-500 mt-1">${host.t('hurdle.manualNote')}</div>`,
            render: (body, status, puzzle, host) => {
                const data = puzzle.hurdleData;

                // The operative field starts as soon as the modal opens. The hacker
                // sequence still gates the terminal, not the run itself.
                data.started = true;

                // The play field mirrors the approved mockup: 640 x 300 design space,
                // 34 px player, dots capped at 20 % of that height.
                const W = 640;
                const H = 300;
                const GROUND_OFFSET = 34;
                const GROUND_Y = H - GROUND_OFFSET;
                const PLAYER = { x: 64, w: 22, h: 34 };
                const DOT_DIAMETER = PLAYER.h * 0.2;
                const DOT_RADIUS = DOT_DIAMETER / 2;
                const LASER_Y_MIN = GROUND_Y - PLAYER.h + DOT_RADIUS;
                const LASER_Y_MAX = GROUND_Y - DOT_DIAMETER - DOT_RADIUS;
                const BASE_PACE = 1.5;
                const PACE_STEP = 0.03;
                const MIN_PACE = 0.9;
                const HIT_PENALTY = 3;
                const JUMP_VELOCITY = 500;
                const GRAVITY = 2450;

                body.innerHTML = `
                    <div class="w-full flex flex-col items-center gap-3">
                        <div class="relative w-full rounded overflow-hidden border border-[#00f0ff44] bg-[#05070a]">
                            <canvas id="hurdle-canvas" class="block w-full h-auto"></canvas>
                            <div id="hurdle-hex" class="hidden absolute top-2 right-2 min-w-[104px] px-2.5 py-1.5 rounded border text-right"
                                style="background:rgba(5,8,12,.82);border-color:rgba(0,240,255,.45);backdrop-filter:blur(4px)">
                                <span class="block font-orbitron text-[7px] tracking-[.18em] text-gray-500">${host.t('hurdle.hexLabel')}</span>
                                <span id="hurdle-hex-code" class="block mt-0.5 text-xl font-mono tracking-widest text-gray-500">--</span>
                            </div>
                        </div>
                        <div class="w-full flex items-center justify-between gap-3 flex-wrap text-[10px] tracking-widest text-gray-500 uppercase">
                            <span>${host.t('hurdle.passed')} <b id="hurdle-passed" class="text-gray-200 font-normal">0</b></span>
                            <span>${host.t('hurdle.pace')} <b id="hurdle-pace" class="text-gray-200 font-normal">1.50s</b></span>
                            <span>${host.t('hurdle.hits')} <b id="hurdle-hits" class="text-red-400 font-normal">0</b></span>
                        </div>
                        <button id="hurdle-jump" type="button"
                            class="w-full px-4 py-10 min-h-[104px] bg-[#00f0ff11] border-2 border-[#00f0ff] rounded text-[#00f0ff] font-orbitron font-bold text-base tracking-[.22em] cursor-pointer select-none transition-all hover:bg-[#00f0ff22] disabled:opacity-40 disabled:cursor-default">
                            ${host.t('hurdle.jump')}
                        </button>
                    </div>
                `;

                const canvas = document.getElementById('hurdle-canvas');
                const hexBox = document.getElementById('hurdle-hex');
                const hexCode = document.getElementById('hurdle-hex-code');
                const hudPassed = document.getElementById('hurdle-passed');
                const hudPace = document.getElementById('hurdle-pace');
                const hudHits = document.getElementById('hurdle-hits');
                const jumpButton = document.getElementById('hurdle-jump');

                const dpr = Math.min(2, window.devicePixelRatio || 1);
                canvas.width = Math.round(W * dpr);
                canvas.height = Math.round(H * dpr);
                const ctx = canvas.getContext('2d');
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

                const player = { jumpY: 0, jumpT: 0, onGround: true };
                const lasers = [];
                let spawnTimer = 0.9;
                let flash = 0;
                let lastFrame = 0;
                let lastRevealedIndex = -1;
                let disposed = false;
                let raf = 0;

                function pace() {
                    return Math.max(MIN_PACE, BASE_PACE - data.passed * PACE_STEP);
                }

                function pendingPhrase() {
                    if (!data.started || puzzle.solved) return null;
                    if (data.accepted >= data.phrases.length) return null;
                    if (data.passed < data.nextPhrasePass) return null;
                    return data.phrases[data.accepted];
                }

                function renderStatus() {
                    let text;
                    if (puzzle.solved || data.accepted >= data.phrases.length) {
                        text = host.t('hurdle.statusSolved');
                    } else if (!data.started) {
                        text = host.t('hurdle.statusIdle');
                    } else if (pendingPhrase()) {
                        // The phrase itself lives in the top-right screen box only.
                        text = host.t('hurdle.statusReady');
                    } else {
                        text = host.t('hurdle.statusPlaying', {
                            n: Math.max(0, data.nextPhrasePass - data.passed)
                        });
                    }
                    if (status.innerText !== text) status.innerText = text;
                }

                function renderHex() {
                    const solved = puzzle.solved || data.accepted >= data.phrases.length;
                    hexBox.classList.toggle('hidden', !data.started && !solved);
                    if (!data.started && !solved) return;

                    if (solved) {
                        hexCode.innerText = 'OK';
                        hexCode.style.color = '#00ff66';
                        hexCode.style.textShadow = '0 0 12px rgba(0,255,102,.55)';
                        hexBox.style.borderColor = 'rgba(0,255,102,.65)';
                    } else {
                        const code = pendingPhrase();
                        hexCode.innerText = code || '--';
                        hexCode.style.color = code ? '#ffcc00' : '#6b7788';
                        hexCode.style.textShadow = code ? '0 0 12px rgba(255,204,0,.55)' : 'none';
                        hexBox.style.borderColor = code ? '#ffcc00' : 'rgba(0,240,255,.45)';
                    }
                }

                function renderHud() {
                    hudPassed.innerText = String(data.passed);
                    hudPace.innerText = pace().toFixed(2) + 's';
                    hudHits.innerText = String(data.hits);
                    jumpButton.disabled = puzzle.solved || !data.started || data.accepted >= data.phrases.length;
                }

                function refresh() {
                    renderHud();
                    renderHex();
                    renderStatus();
                }

                function triggerJump() {
                    if (disposed || puzzle.solved || !data.started) return;
                    if (!player.onGround) return;
                    player.onGround = false;
                    player.jumpT = 0;
                    host.beep(620, 'sine', 0.06, 0.04);
                }

                function laserHitsPlayer(laser) {
                    const playerTop = GROUND_Y - player.jumpY - PLAYER.h;
                    const nearestX = Math.max(PLAYER.x, Math.min(laser.x, PLAYER.x + PLAYER.w));
                    const nearestY = Math.max(playerTop, Math.min(laser.y, playerTop + PLAYER.h));
                    const dx = laser.x - nearestX;
                    const dy = laser.y - nearestY;
                    return dx * dx + dy * dy <= DOT_RADIUS * DOT_RADIUS;
                }

                function update(dt) {
                    flash = Math.max(0, flash - dt);
                    if (!data.started || puzzle.solved || data.accepted >= data.phrases.length) return;

                    if (!player.onGround) {
                        // Closed-form arc: apex is exactly 1.5x the player height,
                        // independent of frame rate.
                        player.jumpT += dt;
                        player.jumpY = JUMP_VELOCITY * player.jumpT - 0.5 * GRAVITY * player.jumpT * player.jumpT;
                        if (player.jumpY <= 0) {
                            player.jumpY = 0;
                            player.jumpT = 0;
                            player.onGround = true;
                        }
                    }

                    spawnTimer -= dt;
                    if (spawnTimer <= 0) {
                        lasers.push({
                            x: W + DOT_DIAMETER,
                            y: LASER_Y_MIN + Math.random() * (LASER_Y_MAX - LASER_Y_MIN),
                            passed: false,
                            hit: false
                        });
                        spawnTimer = Math.max(0.42, pace() * 0.9);
                    }

                    const speed = W / pace();

                    for (const laser of lasers) {
                        laser.x -= speed * dt;

                        if (!laser.hit && laserHitsPlayer(laser)) {
                            laser.hit = true;
                            flash = 0.42;
                            data.hits += 1;
                            host.penalty(HIT_PENALTY);
                            host.error();
                        }

                        if (!laser.passed && laser.x + DOT_RADIUS < PLAYER.x) {
                            laser.passed = true;
                            data.passed += 1;
                        }
                    }

                    for (let i = lasers.length - 1; i >= 0; i--) {
                        if (lasers[i].x < -DOT_DIAMETER * 2) lasers.splice(i, 1);
                    }

                    // Announce each newly revealed phrase once.
                    if (data.accepted < data.phrases.length &&
                        data.passed >= data.nextPhrasePass &&
                        lastRevealedIndex !== data.accepted) {
                        lastRevealedIndex = data.accepted;
                        host.beep(880, 'sine', 0.1, 0.05);
                    }
                }

                function roundRect(x, y, w, h, r) {
                    ctx.beginPath();
                    ctx.moveTo(x + r, y);
                    ctx.arcTo(x + w, y, x + w, y + h, r);
                    ctx.arcTo(x + w, y + h, x, y + h, r);
                    ctx.arcTo(x, y + h, x, y, r);
                    ctx.arcTo(x, y, x + w, y, r);
                    ctx.closePath();
                }

                function draw() {
                    ctx.clearRect(0, 0, W, H);

                    const bg = ctx.createRadialGradient(W * 0.52, H * 0.42, 20, W * 0.5, H * 0.5, W * 0.8);
                    bg.addColorStop(0, '#0b141c');
                    bg.addColorStop(0.6, '#070b10');
                    bg.addColorStop(1, '#040608');
                    ctx.fillStyle = bg;
                    ctx.fillRect(0, 0, W, H);

                    ctx.strokeStyle = 'rgba(0, 240, 255, .055)';
                    ctx.lineWidth = 1;
                    for (let x = 12; x < W; x += 24) {
                        ctx.beginPath();
                        ctx.moveTo(x, 0);
                        ctx.lineTo(x, H);
                        ctx.stroke();
                    }
                    for (let y = 12; y < H; y += 24) {
                        ctx.beginPath();
                        ctx.moveTo(0, y);
                        ctx.lineTo(W, y);
                        ctx.stroke();
                    }

                    ctx.font = '10px "Share Tech Mono", monospace';
                    ctx.fillStyle = 'rgba(0, 240, 255, .42)';
                    ctx.fillText('FOCUS // LASER HURDLES', 12, 18);

                    const groundGlow = ctx.createLinearGradient(0, GROUND_Y - 20, 0, GROUND_Y + 10);
                    groundGlow.addColorStop(0, 'rgba(0, 255, 102, 0)');
                    groundGlow.addColorStop(0.7, 'rgba(0, 255, 102, .10)');
                    groundGlow.addColorStop(1, 'rgba(0, 255, 102, .22)');
                    ctx.fillStyle = groundGlow;
                    ctx.fillRect(0, GROUND_Y - 20, W, 30);

                    ctx.save();
                    ctx.shadowColor = '#00ff66';
                    ctx.shadowBlur = 10;
                    ctx.strokeStyle = '#00ff66';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(0, GROUND_Y);
                    ctx.lineTo(W, GROUND_Y);
                    ctx.stroke();
                    ctx.restore();

                    for (const laser of lasers) {
                        ctx.save();
                        ctx.shadowColor = '#ff2a2a';
                        ctx.shadowBlur = laser.hit ? 4 : 12;
                        ctx.fillStyle = laser.hit ? 'rgba(255, 42, 42, .30)' : '#ff2a2a';
                        ctx.beginPath();
                        ctx.arc(laser.x, laser.y, DOT_RADIUS, 0, Math.PI * 2);
                        ctx.fill();
                        if (!laser.hit) {
                            ctx.shadowBlur = 0;
                            ctx.fillStyle = 'rgba(255, 255, 255, .75)';
                            ctx.beginPath();
                            ctx.arc(
                                laser.x - DOT_RADIUS * 0.28,
                                laser.y - DOT_RADIUS * 0.28,
                                DOT_RADIUS * 0.34,
                                0,
                                Math.PI * 2
                            );
                            ctx.fill();
                        }
                        ctx.restore();
                    }

                    const py = GROUND_Y - player.jumpY - PLAYER.h;
                    ctx.save();
                    ctx.shadowColor = '#00f0ff';
                    ctx.shadowBlur = 16;
                    ctx.fillStyle = '#00f0ff';
                    roundRect(PLAYER.x, py, PLAYER.w, PLAYER.h, 6);
                    ctx.fill();
                    ctx.shadowBlur = 0;
                    ctx.fillStyle = 'rgba(5, 8, 12, .28)';
                    ctx.fillRect(PLAYER.x + 5, py + 9, PLAYER.w - 10, 2);
                    ctx.fillRect(PLAYER.x + 5, py + 15, PLAYER.w - 10, 2);
                    ctx.fillRect(PLAYER.x + 5, py + 21, PLAYER.w - 10, 2);
                    ctx.restore();

                    if (flash > 0) {
                        ctx.fillStyle = 'rgba(255, 42, 42, ' + (flash * 0.35) + ')';
                        ctx.fillRect(0, 0, W, H);
                    }

                    if (puzzle.solved || data.accepted >= data.phrases.length) {
                        ctx.fillStyle = 'rgba(0, 255, 102, .07)';
                        ctx.fillRect(0, 0, W, H);
                        ctx.font = '700 18px "Orbitron", sans-serif';
                        ctx.fillStyle = '#00ff66';
                        ctx.textAlign = 'center';
                        ctx.shadowColor = '#00ff66';
                        ctx.shadowBlur = 16;
                        ctx.fillText(host.t('hurdle.canvasSolved'), W / 2, H / 2 + 2);
                        ctx.shadowBlur = 0;
                        ctx.textAlign = 'left';
                    }
                }

                function frame(now) {
                    if (disposed) return;
                    if (!host.isOpen(puzzle)) return;

                    const dt = lastFrame ? Math.min(0.05, Math.max(0, (now - lastFrame) / 1000)) : 0;
                    lastFrame = now;

                    update(dt);
                    draw();
                    renderHud();
                    renderHex();
                    renderStatus();

                    raf = requestAnimationFrame(frame);
                }

                function onKeyDown(event) {
                    if (event.code !== 'Space' && event.key !== ' ') return;
                    const tag = event.target && event.target.tagName;
                    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
                    event.preventDefault();
                    triggerJump();
                }

                jumpButton.addEventListener('click', triggerJump);
                document.addEventListener('keydown', onKeyDown);

                refresh();
                raf = requestAnimationFrame(frame);

                return {
                    refresh: refresh,
                    dispose: () => {
                        disposed = true;
                        if (raf) cancelAnimationFrame(raf);
                        document.removeEventListener('keydown', onKeyDown);
                    }
                };
            }
        },

        network_overload: {
            labelKey: 'ptype.network_overload',
            manualEntry: (puzzle, host) => {
                const net = puzzle.networkData;
                const targetName = host.t(`overload.target.${net.targetKey}`);
                const rows = NETWORK_BUS_NAME_KEYS.map((nameKey, index) =>
                    `<div class="flex justify-between text-xs mt-0.5"><span class="text-gray-400">${host.t(nameKey)}</span><b class="text-[#00ff66]">${NETWORK_BUS_CAPS[index]}%</b></div>`
                ).join('');
                return `
                    <div class="text-gray-300 mt-1">${host.t('overload.manualIntro')} <span class="text-[#00f0ff] font-bold">${targetName}</span></div>
                    ${rows}
                    <div class="mt-2 text-gray-300">${host.t('overload.manualBand')}</div>
                    <div class="mt-2 text-gray-300">${host.t('overload.manualDecay')}</div>
                    <div class="mt-2 text-[10px] text-gray-500">${host.t('overload.manualNote')}</div>
                `;
            },
            render: (body, status, puzzle, host) => {
                const net = puzzle.networkData;
                const targetName = host.t(`overload.target.${net.targetKey}`);
                const titleEl = document.getElementById('puzzle-modal-title');
                if (titleEl) titleEl.innerText = targetName;

                const BUS = [
                    { color: '#00f0ff', nameKey: 'overload.busBlue' },
                    { color: '#ffcc00', nameKey: 'overload.busAmber' },
                    { color: '#00ff66', nameKey: 'overload.busGreen' },
                    { color: '#ff5c5c', nameKey: 'overload.busRed' }
                ];

                body.innerHTML = `
                    <div class="w-full flex flex-col items-center gap-3">
                        <div class="w-full" style="display:flex;align-items:center;gap:12px;padding:10px 11px;background:#0d0f12;border:1px solid #232b36;border-radius:6px;">
                            <div class="target-core" style="--core:#00f0ff;width:52px;height:52px;flex:0 0 52px;border-radius:50%;border:1px solid color-mix(in srgb, #00f0ff 65%, transparent);background:radial-gradient(circle at 38% 32%, rgba(255,255,255,.20), transparent 32%),radial-gradient(circle, color-mix(in srgb, #00f0ff 18%, transparent), transparent 68%);box-shadow:0 0 18px color-mix(in srgb, #00f0ff 28%, transparent), inset 0 0 14px color-mix(in srgb, #00f0ff 16%, transparent);"></div>
                            <div style="min-width:0;flex:1;display:flex;flex-direction:column;gap:1px;">
                                <div style="font-family:'Orbitron',sans-serif;font-size:8px;letter-spacing:.16em;color:#6b7788;text-transform:uppercase;">${host.t('overload.targetLabel')}</div>
                                <div style="font-family:'Orbitron',sans-serif;font-size:11px;font-weight:700;color:#00f0ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" id="net-target-name">${targetName}</div>
                                <div style="font-size:9px;letter-spacing:.05em;color:#7d8899;" id="net-target-state">${host.t('overload.statusIdle')}</div>
                            </div>
                            <div style="flex:0 0 128px;display:flex;flex-direction:column;gap:5px;">
                                <div style="display:flex;align-items:baseline;justify-content:space-between;gap:6px;">
                                    <div style="font-family:'Orbitron',sans-serif;font-size:8px;letter-spacing:.16em;color:#6b7788;text-transform:uppercase;">${host.t('overload.corruptLabel')}</div>
                                    <b style="color:#ffcc00;font-size:10px;font-weight:400;white-space:nowrap;" id="net-corrupt-value">0.0s / 5.0s</b>
                                </div>
                                <div style="height:5px;background:#070a0f;border:1px solid #232b36;border-radius:3px;overflow:hidden;">
                                    <div style="width:0;height:100%;background:linear-gradient(90deg,#ffcc00,#ff2a2a);box-shadow:0 0 8px rgba(255,42,42,.45);transition:width .1s linear;" id="net-corrupt-fill"></div>
                                </div>
                            </div>
                        </div>

                        <div style="width:100%;padding:9px 11px 7px;background:#0d0f12;border:1px solid #232b36;border-radius:6px;" id="net-master">
                            <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px;" id="net-master-head">
                                <div style="font-family:'Orbitron',sans-serif;font-size:8px;letter-spacing:.16em;color:#6b7788;text-transform:uppercase;">${host.t('overload.netLoad')}</div>
                                <b style="font-family:'Orbitron',sans-serif;font-size:16px;font-weight:700;color:#00f0ff;line-height:1;" id="net-load-value">0%</b>
                            </div>
                            <div style="position:relative;height:12px;background:#070a0f;border:1px solid #2a3340;border-radius:4px;overflow:hidden;">
                                <div style="position:absolute;top:0;bottom:0;left:76.92%;width:15.38%;background:rgba(0,255,102,.13);border-left:1px solid rgba(0,255,102,.55);border-right:1px solid rgba(0,255,102,.55);z-index:1;"></div>
                                <div style="position:absolute;top:0;bottom:0;left:0;width:0;background:linear-gradient(90deg,rgba(0,240,255,.55),#00f0ff);box-shadow:0 0 10px rgba(0,240,255,.4);z-index:2;transition:width .08s linear,background .2s;" id="net-master-fill"></div>
                                <div style="position:absolute;top:-1px;bottom:-1px;left:96.15%;width:2px;background:#ff2a2a;box-shadow:0 0 7px #ff2a2a;z-index:3;"></div>
                            </div>
                            <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:8px;color:#4f5a6a;letter-spacing:.04em;">
                                <span>0</span><span>100</span><span>120</span><span>125</span>
                            </div>
                        </div>

                        <div class="w-full" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;" id="net-node-grid">
                            ${BUS.map((b, index) => `
                                <div style="--node:${b.color};min-width:0;padding:8px 9px 7px;background:#0d0f12;border:1px solid #232b36;border-left:3px solid ${b.color};border-radius:6px;display:flex;flex-direction:column;gap:5px;" id="net-node-card-${index}">
                                    <div style="display:flex;align-items:center;gap:6px;min-width:0;">
                                        <span style="width:7px;height:7px;flex:0 0 7px;border-radius:50%;background:${b.color};box-shadow:0 0 8px ${b.color};"></span>
                                        <span style="font-family:'Orbitron',sans-serif;font-size:9px;font-weight:700;letter-spacing:.06em;color:#cfd8e3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" data-net-node-name="${index}">${host.t(b.nameKey)}</span>
                                        <span style="margin-left:auto;font-size:11px;color:#d7dde5;white-space:nowrap;" data-net-node-load="${index}"><b>0.0</b><small style="font-size:8px;color:#5c6879;">%</small></span>
                                    </div>
                                    <div style="height:6px;background:#070a0f;border:1px solid #232b36;border-radius:3px;overflow:hidden;">
                                        <div style="width:0;height:100%;background:${b.color};box-shadow:0 0 8px ${b.color};transition:width .08s linear,background .15s;" data-net-node-fill="${index}"></div>
                                    </div>
                                    <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:11px;font-size:8px;letter-spacing:.04em;color:#4f5a6a;">
                                        <span style="white-space:nowrap;" data-net-node-share="${index}">${host.t('overload.shareLabel')} 0%</span>
                                        <span style="color:#ff6b6b;white-space:nowrap;" data-net-node-warn="${index}"></span>
                                    </div>
                                    <input type="range" min="0" max="100" value="30" style="-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:2px;background:linear-gradient(90deg,rgba(0,240,255,.16),rgba(0,240,255,.5));outline:none;cursor:pointer;margin:3px 0 1px;">
                                </div>
                            `).join('')}
                        </div>

                        <div style="width:100%;display:flex;flex-direction:column;gap:5px;">
                            <button id="net-hold-btn" style="width:100%;padding:11px 14px;background:rgba(255,42,42,.08);border:1px solid rgba(255,42,42,.7);color:#ff8a8a;font-family:'Orbitron',sans-serif;font-size:12px;font-weight:700;letter-spacing:.14em;cursor:pointer;user-select:none;touch-action:none;transition:all .12s;">${host.t('overload.hold')}</button>
                            <div style="text-align:center;font-size:9px;color:#5c6879;line-height:1.4;" id="net-hold-hint">${host.t('overload.holdHint')}</div>
                        </div>
                    </div>
                `;

                const nodeCards = BUS.map((_, index) => document.getElementById(`net-node-card-${index}`));
                const nodeLoads = BUS.map((_, index) => document.querySelector(`[data-net-node-load="${index}"]`));
                const nodeFills = BUS.map((_, index) => document.querySelector(`[data-net-node-fill="${index}"]`));
                const nodeShares = BUS.map((_, index) => document.querySelector(`[data-net-node-share="${index}"]`));
                const nodeWarns = BUS.map((_, index) => document.querySelector(`[data-net-node-warn="${index}"]`));
                const sliders = BUS.map((_, index) => document.querySelector(`input[data-net-index="${index}"]`));

                const masterFill = document.getElementById('net-master-fill');
                const masterEl = document.getElementById('net-master');
                const masterHead = document.getElementById('net-master-head');
                const loadValue = document.getElementById('net-load-value');
                const corruptValue = document.getElementById('net-corrupt-value');
                const corruptFill = document.getElementById('net-corrupt-fill');
                const targetCore = document.querySelector('.target-core');
                const targetState = document.getElementById('net-target-state');
                const holdBtn = document.getElementById('net-hold-btn');

                let hold = false;
                let progress = 0;
                let tripFlash = 0;
                let tripNode = null;
                const overTime = [0, 0, 0, 0];
                let weights = [30, 30, 20, 20];
                let lastFrame = 0;
                let raf = 0;
                let disposed = false;
                let solvedNow = false;

                function computeDerived() {
                    const sum = weights.reduce((a, b) => a + b, 0);
                    const shares = sum > 0 ? weights.map(w => w / sum * 100) : [0, 0, 0, 0];
                    const loads = shares.map(s => net.injection * s / 100);
                    return { sum, shares, loads };
                }

                function trip(nodeIndex, isGlobal) {
                    if (puzzle.solved) return;
                    net.injection = 0;
                    progress = 0;
                    hold = false;
                    tripFlash = 2.5;
                    tripNode = isGlobal ? null : nodeIndex;
                    overTime.fill(0);
                    host.penalty(10);
                    host.overloadSync(puzzle, 0, isGlobal
                        ? { kind: 'global' }
                        : { kind: 'node', node: host.t(BUS[nodeIndex].nameKey) });
                    render();
                }

                function render() {
                    const injection = net.injection;
                    const d = computeDerived();
                    const inBand = injection >= NETWORK_BAND_MIN && injection <= NETWORK_BAND_MAX;

                    if (masterFill) {
                        masterFill.style.width = Math.min(injection, NETWORK_MAX_GAUGE) / NETWORK_MAX_GAUGE * 100 + '%';
                        if (injection > NETWORK_BAND_MAX) masterFill.style.background = 'linear-gradient(90deg, rgba(255,204,0,.65), #ff2a2a)';
                        else if (inBand) masterFill.style.background = 'linear-gradient(90deg, rgba(0,255,102,.55), #00ff66)';
                        else masterFill.style.background = 'linear-gradient(90deg, rgba(0,240,255,.55), #00f0ff)';
                    }
                    if (loadValue) loadValue.innerText = Math.round(injection) + '%';
                    if (masterHead) {
                        if (injection > NETWORK_BAND_MAX) { masterHead.style.color = '#ff2a2a'; masterHead.style.textShadow = '0 0 10px rgba(255,42,42,.5)'; }
                        else if (inBand) { masterHead.style.color = '#00ff66'; masterHead.style.textShadow = '0 0 10px rgba(0,255,102,.45)'; }
                        else { masterHead.style.color = '#00f0ff'; masterHead.style.textShadow = '0 0 10px rgba(0,240,255,.55)'; }
                    }
                    if (masterEl) {
                        if (injection > NETWORK_BAND_MAX) masterEl.style.boxShadow = '0 0 12px rgba(255,42,42,.3)';
                        else if (inBand) masterEl.style.boxShadow = '0 0 12px rgba(0,255,102,.3)';
                        else masterEl.style.boxShadow = '';
                    }

                    BUS.forEach((b, index) => {
                        const load = d.loads[index];
                        const over = load > NETWORK_BUS_CAPS[index] + 0.01;
                        const card = nodeCards[index];
                        if (card) {
                            card.style.borderColor = over ? '#ff2a2a' : b.color;
                            card.style.borderLeftColor = over ? '#ff2a2a' : b.color;
                            card.style.background = over ? 'rgba(255,42,42,.07)' : '#0d0f12';
                        }
                        const fill = nodeFills[index];
                        if (fill) {
                            fill.style.width = Math.min(load, 50) / 50 * 100 + '%';
                            fill.style.background = over ? '#ff2a2a' : b.color;
                            fill.style.boxShadow = over ? '0 0 9px #ff2a2a' : `0 0 8px ${b.color}`;
                        }
                        const loadEl = nodeLoads[index];
                        if (loadEl) loadEl.querySelector('b').innerText = load.toFixed(1);
                        const shareEl = nodeShares[index];
                        if (shareEl) shareEl.innerText = host.t('overload.shareLabel') + ' ' + d.shares[index].toFixed(0) + '%';
                        const warnEl = nodeWarns[index];
                        if (warnEl) warnEl.innerText = over ? host.t('overload.warnTrip', { s: Math.max(0, NETWORK_GRACE - overTime[index]).toFixed(1) }) : '';
                        const slider = sliders[index];
                        if (slider) slider.style.accentColor = b.color;
                    });

                    const corrupting = !puzzle.solved && progress > 0.05;
                    if (corruptValue) corruptValue.innerText = progress.toFixed(1) + 's / 5.0s';
                    if (corruptFill) corruptFill.style.width = progress / NETWORK_DWELL * 100 + '%';
                    if (targetCore) {
                        targetCore.style.setProperty('--core', puzzle.solved ? '#ff2a2a' : corrupting ? '#ffcc00' : '#00f0ff');
                        if (puzzle.solved) {
                            targetCore.style.borderColor = 'rgba(255,42,42,.65)';
                            targetCore.style.boxShadow = '0 0 18px rgba(255,42,42,.4), inset 0 0 14px rgba(255,42,42,.2)';
                        } else if (corrupting) {
                            targetCore.style.borderColor = 'rgba(255,204,0,.65)';
                            targetCore.style.boxShadow = '0 0 18px rgba(255,204,0,.4), inset 0 0 14px rgba(255,204,0,.2)';
                        } else {
                            targetCore.style.borderColor = 'rgba(0,240,255,.65)';
                            targetCore.style.boxShadow = '0 0 18px rgba(0,240,255,.4), inset 0 0 14px rgba(0,240,255,.2)';
                        }
                    }
                    if (targetState) {
                        if (puzzle.solved) targetState.innerText = host.t('overload.targetStateCorrupt');
                        else if (corrupting) targetState.innerText = host.t('overload.targetStateOver');
                        else targetState.innerText = host.t('overload.targetState');
                    }
                    if (holdBtn) {
                        holdBtn.disabled = puzzle.solved;
                        if (hold && !puzzle.solved) {
                            holdBtn.style.background = 'rgba(255,42,42,.28)';
                            holdBtn.style.color = '#fff';
                            holdBtn.style.boxShadow = '0 0 24px rgba(255,42,42,.38), inset 0 0 18px rgba(255,42,42,.18)';
                            holdBtn.style.transform = 'translateY(1px)';
                        } else {
                            holdBtn.style.background = 'rgba(255,42,42,.08)';
                            holdBtn.style.color = '#ff8a8a';
                            holdBtn.style.boxShadow = '';
                            holdBtn.style.transform = '';
                        }
                    }
                    renderStatus();
                }

                function renderStatus() {
                    let text;
                    if (puzzle.solved) {
                        text = host.t('overload.statusSolved');
                    } else if (tripFlash > 0) {
                        text = tripNode === null
                            ? host.t('overload.statusTripGlobal')
                            : host.t('overload.statusTrip', { node: host.t(BUS[tripNode].nameKey) });
                    } else {
                        const d = computeDerived();
                        const overIndex = d.loads.findIndex((load, index) => load > NETWORK_BUS_CAPS[index] + 0.01);
                        if (overIndex >= 0) text = host.t('overload.statusUnbalanced', { node: host.t(BUS[overIndex].nameKey) });
                        else if (net.injection < NETWORK_BAND_MIN) {
                            text = net.injection < 0.5 ? host.t('overload.statusIdle') : host.t('overload.statusLow');
                        } else if (net.injection > NETWORK_BAND_MAX) text = host.t('overload.statusHigh');
                        else if (hold) text = host.t('overload.statusHolding');
                        else if (progress > 0.05) text = host.t('overload.statusDecay');
                        else text = host.t('overload.statusBalancing');
                    }
                    if (status.innerText !== text) status.innerText = text;
                }

                function frame(now) {
                    if (disposed) return;
                    if (!host.isOpen(puzzle)) { cancelAnimationFrame(raf); return; }
                    const dt = lastFrame ? Math.min(0.05, Math.max(0, (now - lastFrame) / 1000)) : 0;
                    lastFrame = now;

                    if (tripFlash > 0) tripFlash = Math.max(0, tripFlash - dt);
                    if (net.injection > 0) net.injection = Math.max(0, net.injection - NETWORK_DECAY * dt);

                    const d = computeDerived();

                    if (net.injection > NETWORK_HARD_TRIP) {
                        trip(null, true);
                    } else {
                        let overIndex = -1;
                        d.loads.forEach((load, index) => {
                            if (load > NETWORK_BUS_CAPS[index] + 0.01) {
                                overTime[index] += dt;
                                if (overTime[index] > NETWORK_GRACE) overIndex = index;
                            } else {
                                overTime[index] = Math.max(0, overTime[index] - dt * 2);
                            }
                        });
                        if (overIndex >= 0) trip(overIndex, false);
                    }

                    const inBand = net.injection >= NETWORK_BAND_MIN && net.injection <= NETWORK_BAND_MAX;
                    const balanced = d.loads.every((load, index) => load <= NETWORK_BUS_CAPS[index] + 0.01);
                    if (!solvedNow && hold && inBand && balanced && d.sum > 0) {
                        progress = Math.min(NETWORK_DWELL, progress + dt);
                        if (progress >= NETWORK_DWELL) {
                            solvedNow = true;
                            host.solve(puzzle);
                        }
                    } else {
                        progress = Math.max(0, progress - dt * 1.5);
                    }

                    render();
                    raf = requestAnimationFrame(frame);
                }

                function startHold() {
                    if (puzzle.solved) return;
                    hold = true;
                    render();
                }
                function releaseHold() {
                    if (!hold) return;
                    hold = false;
                    render();
                }

                function onHoldPointerDown(event) {
                    event.preventDefault();
                    startHold();
                    try { holdBtn.setPointerCapture(event.pointerId); } catch (err) { /* ignore */ }
                }
                function onHoldRelease() { releaseHold(); }
                function onHoldKeyDown(event) {
                    if (event.code !== 'Space' && event.code !== 'Enter') return;
                    if (puzzle.solved) return;
                    event.preventDefault();
                    hold = true;
                    render();
                }
                function onHoldKeyUp(event) {
                    if (event.code !== 'Space' && event.code !== 'Enter') return;
                    event.preventDefault();
                    releaseHold();
                }
                function onBlur() { releaseHold(); }
                function onVisibilityChange() { if (document.hidden) releaseHold(); }
                function onSliderInput(event) {
                    if (puzzle.solved) return;
                    const index = Number(event.target.dataset.index);
                    weights[index] = Math.min(100, Math.max(0, parseInt(event.target.value, 10) || 0));
                    render();
                }

                holdBtn.addEventListener('pointerdown', onHoldPointerDown);
                ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => {
                    holdBtn.addEventListener(type, onHoldRelease);
                });
                holdBtn.addEventListener('keydown', onHoldKeyDown);
                holdBtn.addEventListener('keyup', onHoldKeyUp);
                window.addEventListener('blur', onBlur);
                document.addEventListener('visibilitychange', onVisibilityChange);

                sliders.forEach((slider, index) => {
                    slider.dataset.index = index;
                    slider.addEventListener('input', onSliderInput);
                    slider.value = weights[index];
                });

                computeDerived();
                render();
                raf = requestAnimationFrame(frame);

                return {
                    refresh: render,
                    dispose: () => {
                        disposed = true;
                        if (raf) cancelAnimationFrame(raf);
                        holdBtn.removeEventListener('pointerdown', onHoldPointerDown);
                        ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => {
                            holdBtn.removeEventListener(type, onHoldRelease);
                        });
                        holdBtn.removeEventListener('keydown', onHoldKeyDown);
                        holdBtn.removeEventListener('keyup', onHoldKeyUp);
                        window.removeEventListener('blur', onBlur);
                        document.removeEventListener('visibilitychange', onVisibilityChange);
                        sliders.forEach(slider => slider.removeEventListener('input', onSliderInput));
                    }
                };
            }
        }
    };

    // ------------------------------------------------------------ public API
    // Opens the interaction UI for one puzzle. The returned controller lets the
    // host refresh a live puzzle (peer sync) and tear it down when the modal closes.
    function open(puzzle, ui, host) {
        const definition = PUZZLE_TYPES[puzzle.type];
        if (!definition) throw new Error(`Unknown puzzle type: ${puzzle.type}`);

        ui.tag.innerText = `[${host.t(definition.labelKey)}]`;
        ui.title.innerText = puzzle.makeModel;
        ui.body.innerHTML = '';

        const controller = definition.render(ui.body, ui.status, puzzle, host) || {};

        return {
            refresh: typeof controller.refresh === 'function' ? controller.refresh : () => { },
            dispose: typeof controller.dispose === 'function' ? controller.dispose : () => { }
        };
    }

    // Hacker-side room preview: the same room data, but with mirrors and walls drawn.
    // Types without a renderPreview stay read-only in the handbook.
    function openPreview(puzzle, ui, host) {
        const definition = PUZZLE_TYPES[puzzle.type];
        if (!definition || typeof definition.renderPreview !== 'function') {
            throw new Error(`No room preview for puzzle type: ${puzzle.type}`);
        }

        ui.tag.innerText = `[${host.t('preview.tag')}]`;
        ui.title.innerText = `${puzzle.makeModel} // ${host.t('manual.room', { n: puzzle.room })}`;
        ui.body.innerHTML = '';

        const controller = definition.renderPreview(ui.body, ui.status, puzzle, host) || {};

        return {
            puzzleId: puzzle.id,
            refresh: typeof controller.refresh === 'function' ? controller.refresh : () => { },
            dispose: typeof controller.dispose === 'function' ? controller.dispose : () => { }
        };
    }

    // Hacker handbook: every puzzle of the run, grouped by type and sorted by make/model.
    function renderManual(container, rooms, host) {
        container.innerHTML = '';

        const allPuzzles = [];
        rooms.forEach(room => allPuzzles.push(...room.puzzles));

        PUZZLE_TYPE_KEYS.forEach(typeKey => {
            const definition = PUZZLE_TYPES[typeKey];
            const group = allPuzzles.filter(p => p.type === typeKey);
            group.sort((a, b) => a.makeModel.localeCompare(b.makeModel));

            if (group.length === 0) return;

            // A category that would only repeat make/model and room number carries no
            // handbook value, so it is left out entirely.
            const hasInfo = typeof definition.manualEntry === 'function' || !!definition.hasRoomPreview;
            if (!hasInfo) return;

            const groupSection = document.createElement('div');
            groupSection.className = "bg-[#12161f] border border-[#00f0ff33] rounded p-4 space-y-3";

            const title = document.createElement('h4');
            title.className = "font-orbitron text-xs text-[#00ff66] font-bold border-b border-gray-800 pb-2 flex items-center justify-between";
            title.innerHTML = `<span>${host.t('manual.category', { name: host.t(definition.labelKey) })}</span>`;
            groupSection.appendChild(title);

            const grid = document.createElement('div');
            grid.className = "grid grid-cols-1 md:grid-cols-2 gap-3";

            group.forEach(puzzle => {
                const item = document.createElement('div');
                item.className = "bg-[#0d0f12] border border-gray-800 rounded p-3 text-xs flex flex-col justify-between self-start";

                const previewButton = definition.hasRoomPreview
                    ? `<button type="button" data-room-preview="${puzzle.id}"
                            class="mt-2 w-full px-3 py-1.5 border border-[#00f0ff55] text-[#00f0ff] font-orbitron text-[10px] tracking-widest rounded hover:bg-[#00f0ff11] cursor-pointer">${host.t('manual.roomPreview')}</button>`
                    : '';

                // Not every type exposes handbook info (issue #24): the entry is optional.
                const entry = typeof definition.manualEntry === 'function'
                    ? definition.manualEntry(puzzle, host)
                    : '';

                item.innerHTML = `
                    <div>
                        <div class="flex items-center mb-1">
                            <span class="font-orbitron font-bold text-[#00f0ff]">${puzzle.makeModel}</span>
                        </div>
                        ${entry ? `<div class="text-gray-300 mt-1">${entry}</div>` : ''}
                        ${previewButton}
                    </div>
                `;
                grid.appendChild(item);
            });

            groupSection.appendChild(grid);
            container.appendChild(groupSection);
        });
    }

    // ------------------------------------------------------- terminal commands
    // Resolves the puzzle a hacker command targets and validates it, without
    // touching the network or the terminal output. index.html narrates/broadcasts.
    function parseTerminalCommand(cmdText, ctx) {
        const text = String(cmdText || '').trim();
        if (!text) return null;
        const rooms = ctx.rooms || [];

        // Pump control: p1 [flow] / p2 [flow] always apply to the puzzle the operative has open
        const pumpMatch = text.match(/^(p\d+)\s+(\d+)$/i);
        if (pumpMatch) {
            const rawPumpId = pumpMatch[1].toLowerCase();
            const flow = Math.min(100, Math.max(0, parseInt(pumpMatch[2], 10)));

            let pressurePuzzle = null;
            rooms.some(room => {
                const found = room.puzzles.find(p => p.id === ctx.activePuzzleId);
                if (found && found.type === 'pressure_cycle') {
                    pressurePuzzle = found;
                    return true;
                }
                return false;
            });

            if (!pressurePuzzle) {
                return { kind: 'pump-no-puzzle', cmd: `${rawPumpId.toUpperCase()} ${flow}` };
            }

            let pumpKey = null;
            if (rawPumpId === 'p1' || pressurePuzzle.pressureData.p1.id === rawPumpId) pumpKey = 'p1';
            else if (rawPumpId === 'p2' || pressurePuzzle.pressureData.p2.id === rawPumpId) pumpKey = 'p2';

            if (!pumpKey) return { kind: 'pump-invalid', id: rawPumpId };

            return {
                kind: 'pump',
                puzzle: pressurePuzzle,
                pumpKey: pumpKey,
                flow: flow,
                roomId: pressurePuzzle.room
            };
        }

        // Simplified frequency phase input: cos(phi)=[val] or cos(phi[room])=[val]
        const cosMatch = text.match(/^cos\(phi(?:\[?(\d+)\]?)?\)\s*=\s*(\d+)$/i) || text.match(/^cos\(phi\)\s*=\s*(\d+)$/i);
        if (cosMatch) {
            let roomNumber = ctx.activeRoom;
            let phase;

            if (cosMatch.length === 3 && cosMatch[1]) {
                roomNumber = parseInt(cosMatch[1], 10);
                phase = parseInt(cosMatch[2], 10);
            } else {
                phase = parseInt(cosMatch[1] || cosMatch[2], 10);
            }

            const room = rooms.find(r => r.id === roomNumber);
            if (!room) return { kind: 'phase-no-room', room: roomNumber };

            const freqPuzzles = room.puzzles.filter(p => p.type === 'frequency');
            const puzzle = freqPuzzles.find(p => !p.solved) || freqPuzzles[0];
            if (!puzzle) return { kind: 'phase-no-puzzle', room: roomNumber };

            return {
                kind: 'phase',
                puzzle: puzzle,
                phase: phase,
                roomId: roomNumber,
                matched: phase === puzzle.targetPhase
            };
        }

        // Levitating ball: fan+ / fan++ / fan- / fan-- always apply to the puzzle the
        // operative has open, exactly like the pump commands do for the pressure cycle.
        const fanMatch = text.match(/^fan(\+\+|--|\+|-)$/i);
        if (fanMatch) {
            const token = fanMatch[1];
            const delta = token === '++' ? 5 : token === '--' ? -5 : token === '+' ? 1 : -1;

            let levitationPuzzle = null;
            rooms.some(room => {
                const found = room.puzzles.find(p => p.id === ctx.activePuzzleId);
                if (found && found.type === 'levitation') {
                    levitationPuzzle = found;
                    return true;
                }
                return false;
            });

            if (!levitationPuzzle) {
                return { kind: 'fan-no-puzzle', cmd: text.toLowerCase() };
            }

            const force = Math.min(100, Math.max(0, levitationPuzzle.fanForce + delta));
            return {
                kind: 'fan',
                puzzle: levitationPuzzle,
                delta: force - levitationPuzzle.fanForce,
                force: force,
                roomId: levitationPuzzle.room
            };
        }

        // Laser hurdles (issue #28): laser(<word key>) unlocks the field, then the
        // hacker relays the four hex phrases the operative reads off the modal.
        const hurdleSeqMatch = text.match(/^laser\(\s*([a-z0-9_-]+)\s*\)$/i);
        if (hurdleSeqMatch) {
            let hurdlePuzzle = null;
            rooms.some(room => {
                const found = room.puzzles.find(p => p.id === ctx.activePuzzleId);
                if (found && found.type === 'laser_hurdles') {
                    hurdlePuzzle = found;
                    return true;
                }
                return false;
            });

            if (!hurdlePuzzle) return { kind: 'hurdle-no-puzzle', cmd: text };
            if (hurdlePuzzle.solved) return { kind: 'hurdle-solved', puzzle: hurdlePuzzle };
            if (hurdleSeqMatch[1].toLowerCase() !== hurdlePuzzle.hurdleData.wordKey) {
                return { kind: 'hurdle-sequence-invalid', puzzle: hurdlePuzzle };
            }
            return { kind: 'hurdle-sequence', puzzle: hurdlePuzzle, roomId: hurdlePuzzle.room };
        }

        const hurdleHexMatch = text.match(/^([0-9a-f]{2})$/i);
        if (hurdleHexMatch) {
            let hurdlePuzzle = null;
            rooms.some(room => {
                const found = room.puzzles.find(p => p.id === ctx.activePuzzleId);
                if (found && found.type === 'laser_hurdles') {
                    hurdlePuzzle = found;
                    return true;
                }
                return false;
            });

            // A bare hex pair outside a laser hurdle stays an unknown command.
            if (!hurdlePuzzle) return null;

            const d = hurdlePuzzle.hurdleData;
            if (hurdlePuzzle.solved || d.accepted >= d.phrases.length) {
                return { kind: 'hurdle-solved', puzzle: hurdlePuzzle };
            }
            if (!d.started) return { kind: 'hurdle-no-sequence', puzzle: hurdlePuzzle };

            const hex = hurdleHexMatch[1].toUpperCase();
            const matched = hex === d.phrases[d.accepted];
            return {
                kind: 'hurdle-phrase',
                puzzle: hurdlePuzzle,
                hex: hex,
                matched: matched,
                acceptedCount: d.accepted + 1,
                total: d.phrases.length,
                complete: matched && d.accepted + 1 >= d.phrases.length,
                roomId: hurdlePuzzle.room
            };
        }

        // Network overload (issue #33): load <n> / dump / status target the overload
        // puzzle the operative currently has open, like p1/p2 and fan+/fan-.
        const overloadLoadMatch = text.match(/^load\s+(\d{1,3})$/i);
        if (overloadLoadMatch) {
            let overloadPuzzle = null;
            rooms.some(room => {
                const found = room.puzzles.find(p => p.id === ctx.activePuzzleId);
                if (found && found.type === 'network_overload') {
                    overloadPuzzle = found;
                    return true;
                }
                return false;
            });
            if (!overloadPuzzle) return { kind: 'overload-no-puzzle', cmd: text };
            const value = Math.min(150, Math.max(0, parseInt(overloadLoadMatch[1], 10)));
            return { kind: 'overload-load', puzzle: overloadPuzzle, value: value, roomId: overloadPuzzle.room };
        }

        if (/^dump$/i.test(text)) {
            let overloadPuzzle = null;
            rooms.some(room => {
                const found = room.puzzles.find(p => p.id === ctx.activePuzzleId);
                if (found && found.type === 'network_overload') {
                    overloadPuzzle = found;
                    return true;
                }
                return false;
            });
            if (!overloadPuzzle) return { kind: 'overload-no-puzzle', cmd: text };
            return { kind: 'overload-dump', puzzle: overloadPuzzle, roomId: overloadPuzzle.room };
        }

        if (/^status$/i.test(text)) {
            let overloadPuzzle = null;
            rooms.some(room => {
                const found = room.puzzles.find(p => p.id === ctx.activePuzzleId);
                if (found && found.type === 'network_overload') {
                    overloadPuzzle = found;
                    return true;
                }
                return false;
            });
            if (overloadPuzzle) return { kind: 'overload-status', puzzle: overloadPuzzle, roomId: overloadPuzzle.room };
            // `status` falls through to the generic statusreport when no overload puzzle is open
        }

        return null;
    }

    global.PuzzleEngine = {
        TOTAL_ROOMS: TOTAL_ROOMS,
        ROOM_VIEW: ROOM_VIEW,
        PUZZLE_SPRITE_RADIUS: PUZZLE_SPRITE_RADIUS,
        TYPES: PUZZLE_TYPE_KEYS.slice(),
        generateRun: generateRun,
        open: open,
        openPreview: openPreview,
        renderManual: renderManual,
        parseTerminalCommand: parseTerminalCommand
    };
})(window);
