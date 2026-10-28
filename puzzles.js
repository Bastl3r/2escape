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
 *
 * ADDING A PUZZLE TYPE
 *   1. add an entry to PUZZLE_TYPES (labelKey, render, manualEntry)
 *   2. append its draws to drawPuzzleParameters() (see the note there)
 *   3. extend the handbook/terminal code only if it needs a new mechanic
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
        pressure_cycle: 'Hydro Station'
    };

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

        return {
            pin: pin,
            targetFreq: targetFreq,
            targetPhase: targetPhase,
            currentPhaseInput: null,
            correctWireIdx: correctWireIdx,
            powerGridTargets: powerGridTargets,
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

    const PUZZLE_TYPE_KEYS = ['keypad', 'frequency', 'wires', 'power_grid', 'pressure_cycle'];

    function generateRoom(seedStr, roomNum, takeDeviceName, nextPumpId) {
        const roomPrng = new SeededPRNG(`${seedStr}-ROOM-${roomNum}`);
        const puzzleCount = getPuzzleCountForRoom(roomNum);
        const selectedTypes = [];

        for (let p = 0; p < puzzleCount; p++) {
            selectedTypes.push(PUZZLE_TYPE_KEYS[roomPrng.range(0, PUZZLE_TYPE_KEYS.length - 1)]);
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
                // The first keypad guards the exit; any further keypad sits as far from the door as possible
                const candidates = isDoorKeypad
                    ? [DOOR_KEYPAD_POSITION, ...ROOM_PUZZLE_SLOTS]
                    : ROOM_PUZZLE_SLOTS;
                const free = selectPuzzlePlacement(
                    candidates,
                    placedPositions,
                    isDoorKeypad
                        ? candidate => (candidate === DOOR_KEYPAD_POSITION ? 1 : 0)
                        : distanceToDoor
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

            pList.push({
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
                pressureData: params.pressureData
            });
        });

        pList.forEach(p => {
            if (p.type === 'frequency') {
                p.totalFreqPuzzlesInRoom = freqPuzzleCount;
            }
        });

        return { id: roomNum, puzzles: pList };
    }

    function generateRun(seedStr) {
        const seed = String(seedStr == null ? '' : seedStr);
        const takeDeviceName = createDeviceNamePicker(seed);
        let pumpCounter = 1;
        const nextPumpId = () => `p${pumpCounter++}`;

        const run = [];
        for (let r = 1; r <= TOTAL_ROOMS; r++) {
            run.push(generateRoom(seed, r, takeDeviceName, nextPumpId));
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
                `${host.t('manual.targetFreq')} <span class="text-[#00f0ff] font-bold font-mono">${puzzle.targetFreq} Hz</span> | ${host.t('manual.terminalOverride')} <code class="text-[#00ff66] font-mono">cos(phi)=${puzzle.targetPhase}</code>`,
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

                function checkFreq() {
                    const freqMatched = Math.abs(freq - puzzle.targetFreq) < 20;
                    const phaseMatched = puzzle.currentPhaseInput !== null && Math.abs(puzzle.currentPhaseInput - puzzle.targetPhase) < 5;

                    if (freqMatched && phaseMatched) {
                        status.innerText = host.t('freq.solved');
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
                btnMinus.onclick = () => { host.beep(400, 'sine', 0.05, 0.05); updateFreqValue(freq - 5); };
                btnPlus.onclick = () => { host.beep(400, 'sine', 0.05, 0.05); updateFreqValue(freq + 5); };

                drawWave();

                // The peer syncing the phase (or the terminal) calls refresh()
                return {
                    refresh: () => {
                        drawWave();
                        checkFreq();
                    }
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
            manualEntry: (puzzle, host) =>
                `${host.t('manual.target')} <span class="text-red-400 font-bold">${host.t('manual.tankTarget', { tank: puzzle.pressureData.targetTank, level: puzzle.pressureData.targetLevel })}</span> | ${host.t('manual.terminalCommands')} <code class="text-[#00f0ff] font-mono">p1 [0-100]</code>, <code class="text-[#00f0ff] font-mono">p2 [0-100]</code>`,
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

            const groupSection = document.createElement('div');
            groupSection.className = "bg-[#12161f] border border-[#00f0ff33] rounded p-4 space-y-3";

            const title = document.createElement('h4');
            title.className = "font-orbitron text-xs text-[#00ff66] font-bold border-b border-gray-800 pb-2 flex items-center justify-between";
            title.innerHTML = `<span>${host.t('manual.category', { name: host.t(definition.labelKey) })}</span><span class="text-gray-500 font-normal">${host.t('manual.count', { n: group.length })}</span>`;
            groupSection.appendChild(title);

            const grid = document.createElement('div');
            grid.className = "grid grid-cols-1 md:grid-cols-2 gap-3";

            group.forEach(puzzle => {
                const item = document.createElement('div');
                item.className = "bg-[#0d0f12] border border-gray-800 rounded p-3 text-xs flex flex-col justify-between";
                item.innerHTML = `
                    <div>
                        <div class="flex justify-between items-center mb-1">
                            <span class="font-orbitron font-bold text-[#00f0ff]">${puzzle.makeModel}</span>
                            <span class="text-[10px] text-gray-500 font-mono">${host.t('manual.room', { n: puzzle.room })}</span>
                        </div>
                        <div class="text-gray-300 mt-1">${definition.manualEntry(puzzle, host)}</div>
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

        return null;
    }

    global.PuzzleEngine = {
        TOTAL_ROOMS: TOTAL_ROOMS,
        ROOM_VIEW: ROOM_VIEW,
        PUZZLE_SPRITE_RADIUS: PUZZLE_SPRITE_RADIUS,
        TYPES: PUZZLE_TYPE_KEYS.slice(),
        generateRun: generateRun,
        open: open,
        renderManual: renderManual,
        parseTerminalCommand: parseTerminalCommand
    };
})(window);
