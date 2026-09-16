(() => {
  'use strict';

  // ---------------------------------------------------------------
  // CONFIG — tune everything here. Nothing below this block should
  // contain a hardcoded balance number.
  // ---------------------------------------------------------------

  const CONFIG = {
    player: {
      startHp: 100,
      radius: 15,
      bottomOffset: 78,      // px up from the bottom of the field
    lifestealPerKill: 10,   // HP restored per zombie killed
    },
    lines: {
      damageLineFromTop: 0.45, // quarter of the field — enemies past this drain HP
      barricadeGapAbovePlayer: 36, // px above the player — enemies physically stop here
      dpsPerEnemy: 1,          // HP/sec drained per enemy currently past the damage line
    },
    zombie: {
      baseHp: 20,
      baseSpeed: 58,         // px/sec
      radius: 13,
      spawnIntervalStart: 1.15, // seconds between spawns at run start
      spawnIntervalMin: 0.32,
      spawnRampKills: 400,   // kills over which spawn interval eases to its min
    },
    weapon: {
      damage: 10,
      fireRate: 2,           // shots per second
      projectileSpeed: 430,
      projectileCount: 1,
      pierce: 0,
      projectileRadius: 4,
      spread: 0.12,          // radians between multiple projectiles
    },
    enemyScalingPerMilestone: {
      hpMult: 1.16,
      speedMult: 1.06,
    },
    milestones: [20, 50, 100, 140, 190, 250, 320, 400, 550, 750, 1000, 1300, 1650, 2050],
    // once the fixed list runs out, keep spacing runs from getting
    // impossibly far apart while still growing:
    milestoneGapGrowth: 1.22,
    // passive (turret/teammate) milestones — a separate track from weapon
    // upgrades. If a kill count hits both a weapon and a passive milestone,
    // the weapon screen is shown first, then the passive screen.
    passiveMilestones: [75, 200, 400, 700, 1100, 1600],
    passiveMilestoneGapGrowth: 1.3,
    passive: {
      maxTurrets: 2,
      maxTeammates: 4,
      maxPerSide: 3,
      slotOffsetX: 30,       // px between each ally slot, outward from the player
      turret: {
        damageMult: 0.4,      // relative to CONFIG.weapon at the moment it's summoned
        fireRateMult: 3.5,    // spam-fire during its burst window
        sweepDeg: 25,         // ± from straight up
        burstDuration: 2,     // seconds actively firing
        reloadDuration: 1.2,  // seconds silent between bursts
      },
      teammate: {
        damageMult: 0.8,
        fireRateMult: 1,      // steady pace, matches base weapon fire rate
      },
    },
  };

  const UPGRADE_POOL = [
    { id: 'damage', name: 'Hot Rounds', desc: '+35% weapon damage', apply: w => { w.damage *= 1.35; } },
    { id: 'firerate', name: 'Twitchy Trigger', desc: '+25% fire rate', apply: w => { w.fireRate *= 1.25; } },
    { id: 'projspeed', name: 'Overcharged Barrel', desc: '+30% projectile speed', apply: w => { w.projectileSpeed *= 1.3; } },
    { id: 'multishot', name: 'Split Chamber', desc: '+1 projectile', apply: w => { w.projectileCount += 1; } },
    { id: 'pierce', name: 'Armor Shredder', desc: '+1 target the shot can pass through', apply: w => { w.pierce += 1; } },
  ];

  const PASSIVE_POOL = [
    {
      id: 'turret',
      name: 'Turret',
      desc: 'Sweeping gatling turret — bursts of rapid, low-damage fire',
      canOffer: () => state.passives.filter(u => u.type === 'turret').length < CONFIG.passive.maxTurrets,
    },
    {
      id: 'teammate',
      name: 'Teammate',
      desc: 'Steady ally — auto-targets its nearest enemy at a fixed pace',
      canOffer: () => state.passives.filter(u => u.type === 'teammate').length < CONFIG.passive.maxTeammates,
    },
  ];

  const BEST_KEY = 'outbreak_personal_best_v1';

  // ---------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');

  const hpFill = document.getElementById('hp-fill');
  const hpValue = document.getElementById('hp-value');
  const killCountEl = document.getElementById('kill-count');
  const milestoneValueEl = document.getElementById('milestone-value');

  const startScreen = document.getElementById('start-screen');
  const startBtn = document.getElementById('start-btn');
  const startBestLine = document.getElementById('start-best-line');
  const startBestValue = document.getElementById('start-best-value');

  const upgradeScreen = document.getElementById('upgrade-screen');
  const upgradeKillCount = document.getElementById('upgrade-kill-count');
  const upgradeOptionsEl = document.getElementById('upgrade-options');

  const gameoverScreen = document.getElementById('gameover-screen');
  const finalKillsEl = document.getElementById('final-kills');
  const finalBestEl = document.getElementById('final-best');
  const newBestBadge = document.getElementById('new-best-badge');
  const restartBtn = document.getElementById('restart-btn');

  // ---------------------------------------------------------------
  // Canvas sizing (mobile-first, handles orientation changes)
  // ---------------------------------------------------------------

  const gameRoot = document.getElementById('game-root');
  let W = 0, H = 0; // logical (CSS-pixel) field size

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = gameRoot.getBoundingClientRect();
    // fall back to the viewport if the root hasn't laid out yet / reports 0
    W = Math.max(1, Math.round(rect.width) || window.innerWidth);
    H = Math.max(1, Math.round(rect.height) || window.innerHeight);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', resizeCanvas);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', resizeCanvas);
  }

  // ---------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------

  let state = null;

  function freshState() {
    return {
      running: false,
      hp: CONFIG.player.startHp,
      kills: 0,
      milestoneIndex: 0,       // which weapon milestone we're heading toward
      passiveMilestoneIndex: 0, // which passive milestone we're heading toward
      zombies: [],             // {x,y,hp,maxHp,speed}
      bullets: [],             // {x,y,vx,vy,damage,pierceLeft,hitIds:Set}
      passives: [],            // {type,side,slot,weapon,fireTimer,mode?,modeTimer?,sweepPhase?}
      weapon: { ...CONFIG.weapon },
      spawnTimer: 0,
      fireTimer: 0,
      enemyHpMult: 1,
      enemySpeedMult: 1,
      debugSpawnInterval: null, // cheat override; null = normal kill-based ramp
      lastTime: 0,
    };
  }

  function playerPos() {
    return { x: W / 2, y: H - CONFIG.player.bottomOffset };
  }

  function damageLineY() {
    return H * CONFIG.lines.damageLineFromTop;
  }

  function barricadeLineY() {
    return playerPos().y - CONFIG.lines.barricadeGapAbovePlayer;
  }

  function nextMilestoneKills(index) {
    const list = CONFIG.milestones;
    if (index < list.length) return list[index];
    // extend past the designed list with a growing gap
    let last = list[list.length - 1];
    let gap = last - list[list.length - 2];
    let i = list.length;
    while (i <= index) {
      gap *= CONFIG.milestoneGapGrowth;
      last += gap;
      i++;
    }
    return Math.round(last);
  }

  function nextPassiveMilestoneKills(index) {
    const list = CONFIG.passiveMilestones;
    if (index < list.length) return list[index];
    let last = list[list.length - 1];
    let gap = last - list[list.length - 2];
    let i = list.length;
    while (i <= index) {
      gap *= CONFIG.passiveMilestoneGapGrowth;
      last += gap;
      i++;
    }
    return Math.round(last);
  }

  // ---------------------------------------------------------------
  // Personal best
  // ---------------------------------------------------------------

  function getBest() {
    const v = parseInt(localStorage.getItem(BEST_KEY), 10);
    return Number.isFinite(v) ? v : 0;
  }

  function setBest(v) {
    localStorage.setItem(BEST_KEY, String(v));
  }

  // ---------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------

  function currentSpawnInterval() {
    if (state.debugSpawnInterval != null) return state.debugSpawnInterval;
    const z = CONFIG.zombie;
    const t = Math.min(1, state.kills / z.spawnRampKills);
    return z.spawnIntervalStart + (z.spawnIntervalMin - z.spawnIntervalStart) * t;
  }

  function spawnZombie() {
    const z = CONFIG.zombie;
    state.zombies.push({
      x: Math.random() * (W - z.radius * 2) + z.radius,
      y: -z.radius,
      hp: z.baseHp * state.enemyHpMult,
      maxHp: z.baseHp * state.enemyHpMult,
      speed: z.baseSpeed * state.enemySpeedMult,
      radius: z.radius,
    });
  }

  // ---------------------------------------------------------------
  // Weapon / bullets
  // ---------------------------------------------------------------

  function findNearestZombie(from) {
    let best = null, bestD = Infinity;
    for (const zb of state.zombies) {
      const dx = zb.x - from.x, dy = zb.y - from.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = zb; }
    }
    return best;
  }

  function computeInterceptAngle(from, target, targetVy, projectileSpeed) {
    const dx = target.x - from.x;
    const dy = target.y - from.y;

    // stationary target (already stopped at the barricade) — no lead needed
    if (!targetVy) return Math.atan2(dy, dx);

    const s = projectileSpeed;
    // solve |r + vT t| = s t  for the smallest positive t (vT is vertical-only: (0, targetVy))
    const a = targetVy * targetVy - s * s;
    const b = 2 * dy * targetVy;
    const c = dx * dx + dy * dy;
    let t = null;

    if (Math.abs(a) < 1e-6) {
      if (Math.abs(b) > 1e-6) {
        const tt = -c / b;
        if (tt > 0) t = tt;
      }
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        const candidates = [(-b + sq) / (2 * a), (-b - sq) / (2 * a)].filter(tt => tt > 0);
        if (candidates.length) t = Math.min(...candidates);
      }
    }

    if (t === null) return Math.atan2(dy, dx); // no valid intercept — fall back to direct aim

    const aimY = target.y + targetVy * t;
    return Math.atan2(aimY - from.y, dx);
  }

  function fireAt(from, target, targetVy) {
    const w = state.weapon;
    const baseAngle = computeInterceptAngle(from, target, targetVy, w.projectileSpeed);
    const n = w.projectileCount;
    const mid = (n - 1) / 2;
    for (let i = 0; i < n; i++) {
      const angle = baseAngle + (i - mid) * w.spread;
      state.bullets.push({
        x: from.x,
        y: from.y,
        vx: Math.cos(angle) * w.projectileSpeed,
        vy: Math.sin(angle) * w.projectileSpeed,
        damage: w.damage,
        pierceLeft: w.pierce,
        hit: new Set(),
      });
    }
  }

  // ---------------------------------------------------------------
  // Passives (turrets / teammates)
  // ---------------------------------------------------------------

  function summonPassive(type) {
    const typeCfg = CONFIG.passive[type];
    // own weapon-stat object, seeded fresh from the base config — NOT from
    // the player's currently-upgraded stats, and not shared with the
    // player's weapon object, so later weapon upgrades apply only to
    // units that already exist at pick-time.
    const weapon = { ...CONFIG.weapon };
    weapon.damage *= typeCfg.damageMult;
    weapon.fireRate *= typeCfg.fireRateMult;

    const leftCount = state.passives.filter(u => u.side === -1).length;
    const rightCount = state.passives.filter(u => u.side === 1).length;
    const side = leftCount <= rightCount ? -1 : 1;
    const slot = state.passives.filter(u => u.side === side).length;

    const unit = {
      type,
      side,
      slot,
      weapon,
      fireTimer: 1 / weapon.fireRate,
    };
    if (type === 'turret') {
      unit.mode = 'burst';
      unit.modeTimer = typeCfg.burstDuration;
      unit.sweepPhase = Math.random() * Math.PI * 2;
    }
    state.passives.push(unit);
  }

  function passivePos(unit) {
    const p = playerPos();
    const step = CONFIG.passive.slotOffsetX;
    return { x: p.x + unit.side * step * (unit.slot + 1), y: p.y };
  }

  function fireFixed(from, angle, weapon) {
    const n = weapon.projectileCount;
    const mid = (n - 1) / 2;
    for (let i = 0; i < n; i++) {
      const a = angle + (i - mid) * weapon.spread;
      state.bullets.push({
        x: from.x,
        y: from.y,
        vx: Math.cos(a) * weapon.projectileSpeed,
        vy: Math.sin(a) * weapon.projectileSpeed,
        damage: weapon.damage,
        pierceLeft: weapon.pierce,
        hit: new Set(),
      });
    }
  }

  function updatePassives(dt) {
    const UP = -Math.PI / 2; // straight up
    for (const u of state.passives) {
      const pos = passivePos(u);

      if (u.type === 'teammate') {
        u.fireTimer -= dt;
        if (u.fireTimer <= 0) {
          const target = findNearestZombie(pos);
          if (target) {
            const barricadeY = barricadeLineY();
            const targetVy = target.y >= barricadeY ? 0 : target.speed;
            const angle = computeInterceptAngle(pos, target, targetVy, u.weapon.projectileSpeed);
            fireFixed(pos, angle, u.weapon);
            u.fireTimer = 1 / u.weapon.fireRate;
          }
        }
        continue;
      }

      // turret: burst / reload cycle with a sweeping angle while bursting
      const tCfg = CONFIG.passive.turret;
      u.modeTimer -= dt;
      if (u.mode === 'burst') {
        u.fireTimer -= dt;
        if (u.fireTimer <= 0) {
          const sweepRad = tCfg.sweepDeg * Math.PI / 180;
          const sweep = Math.sin(performance.now() / 1000 * 6 + u.sweepPhase) * sweepRad;
          fireFixed(pos, UP + sweep, u.weapon);
          u.fireTimer = 1 / u.weapon.fireRate;
        }
        if (u.modeTimer <= 0) {
          u.mode = 'reload';
          u.modeTimer = tCfg.reloadDuration;
        }
      } else if (u.modeTimer <= 0) {
        u.mode = 'burst';
        u.modeTimer = tCfg.burstDuration;
      }
    }
  }

  function renderPassives() {
    for (const u of state.passives) {
      const pos = passivePos(u);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, u.type === 'turret' ? 10 : 9, 0, Math.PI * 2);
      ctx.fillStyle = u.type === 'turret' ? '#66d9ff' : '#c9a4ff';
      ctx.shadowColor = u.type === 'turret' ? 'rgba(102,217,255,0.6)' : 'rgba(201,164,255,0.6)';
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // ---------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------

  function killZombie(zb) {
  state.zombies.splice(state.zombies.indexOf(zb), 1);
  state.kills += 1;
  state.hp = Math.min(CONFIG.player.startHp, state.hp + CONFIG.player.lifestealPerKill);
  killCountEl.textContent = state.kills;
  killCountEl.classList.remove('pop');
  // restart the animation
  void killCountEl.offsetWidth;
  killCountEl.classList.add('pop');
  checkMilestones();
}


  // Checks weapon then passive milestones, chaining screens as needed.
  // Safe to call both mid-run (state.running true — does nothing if no
  // milestone is due) and after a screen closes or a cheat jump (running
  // false — resumes the loop once nothing further is due).
  function checkMilestones() {
    const weaponTarget = nextMilestoneKills(state.milestoneIndex);
    if (state.kills >= weaponTarget) {
      state.running = false;
      showUpgradeScreen(weaponTarget);
      return;
    }
    const passiveTarget = nextPassiveMilestoneKills(state.passiveMilestoneIndex);
    if (state.kills >= passiveTarget) {
      const options = pickPassiveOptions();
      if (options.length > 0) {
        state.running = false;
        showPassiveScreen(passiveTarget, options);
        return;
      }
      // both caps full — nothing to offer, skip this milestone and keep checking
      state.passiveMilestoneIndex += 1;
      checkMilestones();
      return;
    }
    if (!state.running) resumeRun();
  }

  function resumeRun() {
    hideAllScreens();
    state.running = true;
    state.lastTime = 0;
    requestAnimationFrame(loop);
  }

  function update(dt) {
    const from = playerPos();
    const dmgLineY = damageLineY();
    const barricadeY = barricadeLineY();

    // spawn
    state.spawnTimer -= dt;
    if (state.spawnTimer <= 0) {
      spawnZombie();
      state.spawnTimer = currentSpawnInterval();
    }

    // fire — lead the shot based on the target's *current* vertical speed
    // (0 once it has already piled up at the barricade)
    state.fireTimer -= dt;
    if (state.fireTimer <= 0 && state.zombies.length > 0) {
      const target = findNearestZombie(from);
      if (target) {
        const targetVy = target.y >= barricadeY ? 0 : target.speed;
        fireAt(from, target, targetVy);
        state.fireTimer = 1 / state.weapon.fireRate;
      }
    }

    updatePassives(dt);

    // move zombies (stop dead at the barricade) + damage-line drain
    let dpsThisFrame = 0;
    for (const zb of state.zombies) {
      if (zb.y < barricadeY) {
        zb.y += zb.speed * dt;
        if (zb.y > barricadeY) zb.y = barricadeY;
      }
      if (zb.y >= dmgLineY) dpsThisFrame += CONFIG.lines.dpsPerEnemy;
    }
    if (dpsThisFrame > 0) {
      state.hp = Math.max(0, state.hp - dpsThisFrame * dt);
    }

    // move bullets + collisions
    for (let bi = state.bullets.length - 1; bi >= 0; bi--) {
      const b = state.bullets[bi];
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      if (b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20) {
        state.bullets.splice(bi, 1);
        continue;
      }

      for (const zb of state.zombies) {
        if (b.hit.has(zb)) continue;
        const dx = zb.x - b.x, dy = zb.y - b.y;
        const rr = (zb.radius + CONFIG.weapon.projectileRadius);
        if (dx * dx + dy * dy <= rr * rr) {
          zb.hp -= b.damage;
          b.hit.add(zb);
          if (zb.hp <= 0) killZombie(zb);
          if (b.pierceLeft > 0) {
            b.pierceLeft -= 1;
          } else {
            state.bullets.splice(bi, 1);
          }
          break;
        }
      }
    }

    // HUD
    hpValue.textContent = Math.ceil(state.hp);
    hpFill.style.width = `${Math.max(0, (state.hp / CONFIG.player.startHp) * 100)}%`;

    if (state.hp <= 0) {
      state.running = false;
      showGameOver();
    }
  }

  // ---------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------

  function render() {
    ctx.clearRect(0, 0, W, H);

    // damage line
    const dmgLineY = damageLineY();
    ctx.strokeStyle = 'rgba(255, 59, 59, 0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(0, dmgLineY);
    ctx.lineTo(W, dmgLineY);
    ctx.stroke();
    ctx.setLineDash([]);

    // barricade line
    const barricadeY = barricadeLineY();
    ctx.strokeStyle = 'rgba(255, 176, 66, 0.75)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, barricadeY);
    ctx.lineTo(W, barricadeY);
    ctx.stroke();

    // zombies
    for (const zb of state.zombies) {
      const t = zb.hp / zb.maxHp;
      ctx.beginPath();
      ctx.arc(zb.x, zb.y, zb.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, ${Math.round(90 + 90 * t)}, 90, 0.95)`;
      ctx.fill();
    }

    // bullets
    ctx.fillStyle = '#eafff0';
    for (const b of state.bullets) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, CONFIG.weapon.projectileRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    renderPassives();

    // player
    const p = playerPos();
    ctx.beginPath();
    ctx.arc(p.x, p.y, CONFIG.player.radius, 0, Math.PI * 2);
    ctx.fillStyle = '#6dff6d';
    ctx.shadowColor = 'rgba(109,255,109,0.6)';
    ctx.shadowBlur = 18;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // ---------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------

  function loop(ts) {
    if (!state.running) return;
    if (!state.lastTime) state.lastTime = ts;
    const dt = Math.min(0.05, (ts - state.lastTime) / 1000); // clamp for tab-switch jumps
    state.lastTime = ts;

    if (W > 1 && H > 1) {
      update(dt);
      render();
    } else {
      // field hasn't laid out yet — re-measure and wait a frame rather
      // than simulating against a zero-sized field
      resizeCanvas();
    }

    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------

  function hideAllScreens() {
    startScreen.hidden = true;
    upgradeScreen.hidden = true;
    gameoverScreen.hidden = true;
  }

  function renderOptionScreen(reachedAt, options, onChoose) {
    hideAllScreens();
    upgradeScreen.hidden = false;
    upgradeKillCount.textContent = reachedAt;

    upgradeOptionsEl.innerHTML = '';
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.className = 'upgrade-option';
      btn.innerHTML = `<span class="opt-name">${opt.name}</span><span class="opt-desc">${opt.desc}</span>`;
      btn.addEventListener('click', () => onChoose(opt));
      upgradeOptionsEl.appendChild(btn);
    }
  }

  function showUpgradeScreen(reachedAt) {
    renderOptionScreen(reachedAt, pickUpgradeOptions(3), chooseUpgrade);
  }

  function pickUpgradeOptions(n) {
    const pool = [...UPGRADE_POOL];
    const picked = [];
    while (picked.length < n && pool.length > 0) {
      const i = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(i, 1)[0]);
    }
    return picked;
  }

  function chooseUpgrade(opt) {
    // applies to the player's weapon AND every passive that already
    // exists — a passive summoned later starts fresh at base values,
    // per the "seeded at base values at summon time" rule.
    opt.apply(state.weapon);
    for (const u of state.passives) opt.apply(u.weapon);

    // scale enemies up, then move to the next weapon milestone target
    state.enemyHpMult *= CONFIG.enemyScalingPerMilestone.hpMult;
    state.enemySpeedMult *= CONFIG.enemyScalingPerMilestone.speedMult;
    state.milestoneIndex += 1;

    milestoneValueEl.textContent = nextMilestoneKills(state.milestoneIndex);

    // a passive milestone might have landed on this same kill count
    checkMilestones();
  }

  function pickPassiveOptions() {
    return PASSIVE_POOL.filter(opt => opt.canOffer());
  }

  function showPassiveScreen(reachedAt, options) {
    renderOptionScreen(reachedAt, options, choosePassive);
  }

  function choosePassive(opt) {
    summonPassive(opt.id);
    state.passiveMilestoneIndex += 1;
    checkMilestones();
  }

  function showGameOver() {
    hideAllScreens();
    const best = getBest();
    const isNewBest = state.kills > best;
    if (isNewBest) setBest(state.kills);

    finalKillsEl.textContent = state.kills;
    finalBestEl.textContent = isNewBest ? state.kills : best;
    newBestBadge.hidden = !isNewBest;

    gameoverScreen.hidden = false;
  }

  function showStartScreen() {
    hideAllScreens();
    const best = getBest();
    if (best > 0) {
      startBestValue.textContent = best;
      startBestLine.hidden = false;
    } else {
      startBestLine.hidden = true;
    }
    startScreen.hidden = false;
  }

  // ---------------------------------------------------------------
  // Run control
  // ---------------------------------------------------------------

  function startRun() {
    resizeCanvas();
    resizeCanvas(); // second pass in case the first ran before layout settled
    state = freshState();
    state.spawnTimer = currentSpawnInterval();
    state.fireTimer = 1 / state.weapon.fireRate;

    killCountEl.textContent = '0';
    milestoneValueEl.textContent = nextMilestoneKills(0);
    hpValue.textContent = CONFIG.player.startHp;
    hpFill.style.width = '100%';

    hideAllScreens();
    state.running = true;
    requestAnimationFrame(loop);
  }

  startBtn.addEventListener('click', startRun);
  restartBtn.addEventListener('click', startRun);

  // ---------------------------------------------------------------
  // Debug panel (?debug=1) — testing cheats, invisible in normal play
  // ---------------------------------------------------------------

  const DEBUG = new URLSearchParams(location.search).get('debug') === '1';

  function setupDebugPanel() {
    if (!DEBUG) return;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:99999;font:11px/1.4 monospace;';

    const toggle = document.createElement('button');
    toggle.textContent = '🛠';
    toggle.style.cssText = 'width:32px;height:32px;border-radius:16px;background:#222;color:#fff;border:1px solid #555;opacity:0.8;';

    const panel = document.createElement('div');
    panel.style.cssText = 'display:none;flex-direction:column;gap:6px;background:#181818;color:#eee;padding:10px;border-radius:8px;border:1px solid #444;width:220px;max-height:70vh;overflow-y:auto;position:absolute;bottom:38px;right:0;';

    toggle.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    });

    function row(labelText, inputAttrs, onApply) {
      const r = document.createElement('div');
      r.style.cssText = 'display:flex;gap:4px;align-items:center;';
      const label = document.createElement('span');
      label.textContent = labelText;
      label.style.cssText = 'flex:1;';
      const input = document.createElement('input');
      Object.assign(input, { type: 'number', step: 'any' }, inputAttrs);
      input.style.cssText = 'width:64px;background:#222;color:#fff;border:1px solid #555;';
      const btn = document.createElement('button');
      btn.textContent = 'Set';
      btn.style.cssText = 'background:#334;color:#fff;border:1px solid #556;';
      btn.addEventListener('click', () => onApply(input.value));
      r.append(label, input, btn);
      panel.appendChild(r);
      return input;
    }

    function heading(text) {
      const h = document.createElement('div');
      h.textContent = text;
      h.style.cssText = 'margin-top:6px;color:#8f8;font-weight:bold;';
      panel.appendChild(h);
    }

    heading('Kills');
    row('kills →', {}, v => {
      if (!state) return;
      const n = Math.max(0, Math.floor(Number(v)));
      if (!Number.isFinite(n)) return;
      state.kills = n;
      killCountEl.textContent = state.kills;
      checkMilestones();
    });

    heading('Zombies');
    row('HP ×', {}, v => { if (state && v !== '') state.enemyHpMult = Number(v); });
    row('Speed ×', {}, v => { if (state && v !== '') state.enemySpeedMult = Number(v); });
    row('Spawn (s, blank=off)', { step: '0.01' }, v => {
      if (!state) return;
      state.debugSpawnInterval = v === '' ? null : Math.max(0.05, Number(v));
    });

    heading('Weapon (player)');
    row('Damage', {}, v => { if (state && v !== '') state.weapon.damage = Number(v); });
    row('Fire rate', {}, v => { if (state && v !== '') state.weapon.fireRate = Number(v); });
    row('Proj speed', {}, v => { if (state && v !== '') state.weapon.projectileSpeed = Number(v); });
    row('Proj count', {}, v => { if (state && v !== '') state.weapon.projectileCount = Math.max(1, Math.floor(Number(v))); });
    row('Pierce', {}, v => { if (state && v !== '') state.weapon.pierce = Math.max(0, Math.floor(Number(v))); });

    heading('Passives');
    const passiveRow = document.createElement('div');
    passiveRow.style.cssText = 'display:flex;gap:4px;';
    const addPassiveBtn = (label, type) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'flex:1;background:#334;color:#fff;border:1px solid #556;';
      b.addEventListener('click', () => {
        if (!state) return;
        const opt = PASSIVE_POOL.find(o => o.id === type);
        if (opt && opt.canOffer()) summonPassive(type);
      });
      passiveRow.appendChild(b);
    };
    addPassiveBtn('+Turret', 'turret');
    addPassiveBtn('+Teammate', 'teammate');
    panel.appendChild(passiveRow);

    wrap.append(toggle, panel);
    document.body.appendChild(wrap);
  }

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------

  resizeCanvas();
  showStartScreen();
  setupDebugPanel();
})();
