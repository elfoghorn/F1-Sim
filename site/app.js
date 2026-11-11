/* F1 SIM f1sim0001: a Formula 1 league. Race engine, Formula Racing V3.0 adapter, app core, the grid and race weekends, the paddock. */
/* =====================================================================
   F1 SIM race engine.
   Pure and deterministic, in the same pattern as CombatEngine: a seed,
   the starting state and the calls made each lap always give the same
   race, so every Grand Prix can be replayed, paused for strategy calls,
   resumed and audited. No I/O. The race state is plain JSON, so it can be
   saved to the docs table between laps and picked up by anyone.

   API
     qualify({ circuit, entries, weather, seed, rules })      -> { grid, results, log }
     createRace({ circuit, entries, grid, weather, seed, rules }) -> state
     stepLap(state, calls)                                     -> { state, log }
     runTo(state, lap, callsByLap)                             -> { state, log }
     classify(state)                                           -> results with points
     carScore(car, circuit)                                    -> 0..100

   Calls (all optional; with none, the AI strategist runs every car)
     { entry, type: 'box', compound }            pit at the end of this lap
     { entry, type: 'mode', value }              push | standard | manage
     { entry, type: 'plan', stops: [{ lap, compound }] }
     { entry, type: 'manual', value: true }      AI stops making pit calls for this car
     { team,  type: 'order', value }             hold | swap | none
     { entry, type: 'refuseOrder' }              the driver ignores the current team order

   Optional entry fields (all default to neutral)
     driver.overtaking / driver.defense   split attack and defence (else racecraft for both)
     driver.experience / driver.mental    fewer mistakes under pressure
     car.pitSpeed / car.tyreLife          crew speed and how kind the car is to its tyres
     paceAdj / qualiAdj                   seconds per lap, e.g. a driver's good or bad tracks
     ai: { stretch, scPit, undercut }     the AI strategist's personality for this car
     startMode                            driving mode at the start
   ===================================================================== */
(function (root) {
  'use strict';

  var COMPOUNDS = {
    soft:   { label: 'Soft',         short: 'S', offset: 0.00, deg: 0.085, life: 16, wet: false },
    medium: { label: 'Medium',       short: 'M', offset: 0.45, deg: 0.055, life: 26, wet: false },
    hard:   { label: 'Hard',         short: 'H', offset: 0.85, deg: 0.035, life: 38, wet: false },
    inter:  { label: 'Intermediate', short: 'I', offset: 0.00, deg: 0.050, life: 30, wet: true },
    wet:    { label: 'Wet',          short: 'W', offset: 0.00, deg: 0.040, life: 35, wet: true }
  };
  var TRACK = ['dry', 'damp', 'wet'];
  /* Seconds lost per lap for each compound on a dry, damp or wet track. */
  var GRIP = { soft: [0, 4, 11], medium: [0, 4.5, 11.5], hard: [0, 5, 12], inter: [2.8, 0, 3.5], wet: [5.5, 1.8, 0] };
  var MODES = {
    push:     { label: 'Push',     pace: -0.30, deg: 1.45, risk: 1.6, energy: 4 },
    standard: { label: 'Standard', pace: 0,     deg: 1.00, risk: 1.0, energy: 12 },
    manage:   { label: 'Manage',   pace: 0.40,  deg: 0.65, risk: 0.6, energy: 20 }
  };
  var DEFAULTS = {
    points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
    qualifying: { q2: 16, q3: 10 },
    carCoef: 0.11,          // seconds per point of car score
    driverCoef: 0.035,      // seconds per point of driver pace
    setupCoef: 0.006,       // seconds per point of setup quality
    fuelEffect: 3.2,        // seconds slower on a full tank
    minGap: 0.35,           // closest a following car finishes a lap without passing
    overtake: { base: 0.015, pace: 0.2, racecraft: 0.003 },  // pass chance, scaled by the circuit's ease of overtaking
    dirtyAir: 0.25,         // seconds lost when right behind another car
    overtakeMode: { gap: 1.0, cost: 35, bonus: 0.07 },
    pitStop: { mean: 2.5, sd: 0.3, slowChance: 0.04 },
    scPace: 1.35, vscPace: 1.30, scBunch: 0.8,
    formSd: 0.25,           // weekend-to-weekend swing in a car's pace (s): set-up, track temperature, luck
    failureRate: 0.0025,    // per lap, scaled by (1 - reliability)
    crashRate: 0.0008, mistakeRate: 0.006
  };

  /* ------------------------------------------------------------ randomness */
  function rng(seed) {                               // mulberry32, as in CombatEngine
    var a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function hashId(id) { var h = 2166136261; String(id).split('').forEach(function (ch) { h = Math.imul(h ^ ch.charCodeAt(0), 16777619); }); return h >>> 0; }
  /* The same car gets the same weekend form in qualifying and the race. */
  function weekendForm(seed, id, rules) { return round3(gauss(rng(mix(seed, hashId(id) % 100000, 5))) * rules.formSd); }
  function mix(seed, n, salt) { var h = (seed ^ Math.imul(n + 1, 0x9E3779B1) ^ Math.imul(salt + 7, 0x85EBCA6B)) >>> 0; h = Math.imul(h ^ (h >>> 16), 0x7FEB352D); return (h ^ (h >>> 15)) >>> 0; }
  function gauss(r) { var u = 1 - r(), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  var clamp = function (x, lo, hi) { return Math.max(lo, Math.min(hi, x)); };
  var round3 = function (x) { return Math.round(x * 1000) / 1000; };
  function merge(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in (b || {})) o[k] = b[k]; return o; }

  /* ------------------------------------------------------------ pace model */
  function carScore(car, circuit) {
    var w = circuit.weights || { power: 1, aero: 1, grip: 1 }, s = (w.power || 0) + (w.aero || 0) + (w.grip || 0) || 1;
    return ((car.power || 0) * (w.power || 0) + (car.aero || 0) * (w.aero || 0) + (car.grip || 0) * (w.grip || 0)) / s;
  }
  /* Everything about a car and driver that doesn't change lap to lap. */
  function basePace(e, circuit, rules, track) {
    var d = e.driver;
    var t = circuit.baseLap
      - (carScore(e.car, circuit) - 85) * rules.carCoef
      - (d.pace - 85) * rules.driverCoef
      - ((e.setup == null ? 60 : e.setup) - 60) * rules.setupCoef;
    if (track > 0) t -= (d.wet - 85) * 0.04 * track;
    return t + (e.paceAdj || 0) + (e.form || 0);
  }
  function tyreLife(compound, e, circuit) {
    var carLife = (e.car && e.car.tyreLife != null) ? 1 + (e.car.tyreLife - 75) / 150 : 1;
    return COMPOUNDS[compound].life / (circuit.tyreStress || 1) * (0.85 + e.driver.tyreMgmt / 600) * carLife;
  }
  var attack = function (d) { return d.overtaking != null ? d.overtaking : d.racecraft; };
  var defend = function (d) { return d.defense != null ? d.defense : d.racecraft; };
  function composure(d) { return (1 + (70 - (d.experience == null ? 70 : d.experience)) / 150) * (1 + (7 - (d.mental == null ? 7 : d.mental)) * 0.06); }
  function tyreTime(tyre, e, circuit, track) {
    var c = COMPOUNDS[tyre.compound], life = tyreLife(tyre.compound, e, circuit);
    var t = (c.wet ? 0 : c.offset) + GRIP[tyre.compound][track] + tyre.wear * c.deg;
    if (tyre.wear > life) t += Math.pow(tyre.wear - life, 1.6) * 0.08;
    return t;
  }

  /* ------------------------------------------------------------ weather */
  function weatherPlan(weather, laps, seed) {
    weather = weather || { start: 'dry' };
    var plan = [], cur = TRACK.indexOf(weather.start || 'dry'), changes = {};
    if (cur < 0) cur = 0;
    (weather.changes || []).forEach(function (c) { changes[c.lap] = TRACK.indexOf(c.to); });
    if (weather.mode === 'variable') {
      var r = rng(mix(seed, 0, 99)), chance = weather.rainChance == null ? 0.5 : weather.rainChance;
      if (r() < chance) {
        var from = 5 + Math.floor(r() * (laps - 15)), len = 6 + Math.floor(r() * 18), peak = r() < 0.45 ? 2 : 1;
        changes[from] = 1; if (peak === 2) changes[from + 3] = 2;
        changes[Math.min(laps, from + len)] = 1; changes[Math.min(laps, from + len + 4)] = 0;
      }
    }
    for (var lap = 1; lap <= laps; lap++) { if (changes[lap] != null && changes[lap] >= 0) cur = changes[lap]; plan.push(cur); }
    return plan;
  }

  /* ------------------------------------------------------------ qualifying */
  function qualify(opts) {
    var rules = merge(DEFAULTS, opts.rules), circuit = opts.circuit, entries = opts.entries, r = rng(mix(opts.seed, 0, 1));
    var track = TRACK.indexOf((opts.weather && opts.weather.qualifying) || (opts.weather && opts.weather.start) || 'dry');
    if (track < 0) track = 0;
    var comp = track === 2 ? 'wet' : track === 1 ? 'inter' : 'soft', log = [], res = {};
    entries = entries.map(function (e) { return merge(e, { form: weekendForm(opts.seed, e.id, rules) }); });
    entries.forEach(function (e) { res[e.id] = { id: e.id, times: [null, null, null], out: null }; });
    function run(e) {
      var best = Infinity;
      for (var i = 0; i < 2; i++) {
        var t = basePace(e, circuit, rules, track) - rules.fuelEffect - 0.35 + GRIP[comp][track] + (e.qualiAdj || 0)
          + gauss(r) * (0.08 + (100 - e.driver.consistency) * 0.006);
        if (r() < 0.04 * (1 + track) * composure(e.driver)) { log.push({ kind: 'mistake', ids: [e.id], text: e.driver.code + ' runs wide and abandons a lap' }); continue; }
        best = Math.min(best, t);
      }
      return best;
    }
    var field = entries.slice(), sizes = [entries.length, Math.min(entries.length, rules.qualifying.q2), Math.min(entries.length, rules.qualifying.q3)];
    var order = [];
    for (var q = 0; q < 3; q++) {
      field.forEach(function (e) { res[e.id].times[q] = round3(run(e)); });
      field.sort(function (a, b) { return res[a.id].times[q] - res[b.id].times[q]; });
      var cut = q < 2 ? sizes[q + 1] : field.length;
      var out = field.slice(cut);
      out.forEach(function (e) { res[e.id].out = 'Q' + (q + 1); });
      order = out.concat(order);
      field = field.slice(0, cut);
      if (q < 2 && out.length) log.push({ kind: 'session', text: 'Q' + (q + 1) + ' eliminated: ' + out.map(function (e) { return e.driver.code; }).join(', ') });
    }
    order = field.concat(order);
    log.push({ kind: 'pole', ids: [order[0].id], text: order[0].driver.code + ' takes pole' });
    return { grid: order.map(function (e) { return e.id; }), results: order.map(function (e, i) { var x = res[e.id]; x.position = i + 1; return x; }), log: log };
  }

  /* ------------------------------------------------------------ race set-up */
  function startCompound(pos, n, track) {
    if (track === 2) return 'wet';
    if (track === 1) return 'inter';
    return pos <= Math.ceil(n * 0.45) ? (pos % 3 === 0 ? 'medium' : 'soft') : (pos % 2 ? 'medium' : 'hard');
  }
  function createRace(opts) {
    var rules = merge(DEFAULTS, opts.rules), circuit = opts.circuit, laps = circuit.laps;
    if (opts.sprint) {   /* about 100 km, sprint points, no compulsory second compound */
      laps = circuit.sprintLaps || Math.ceil(circuit.laps / 3);
      rules = merge(rules, { points: (opts.rules && opts.rules.sprintPoints) || [8, 7, 6, 5, 4, 3, 2, 1], mandatoryCompounds: false });
    }
    var byId = {}; opts.entries.forEach(function (e) { byId[e.id] = e; });
    var grid = opts.grid || opts.entries.map(function (e) { return e.id; });
    var plan = weatherPlan(opts.weather, laps, opts.seed);
    var cars = grid.map(function (id, i) {
      var e = byId[id], comp = e.startTyre || startCompound(i + 1, grid.length, plan[0]);
      return {
        id: id, team: e.team, driver: e.driver, car: e.car, setup: e.setup == null ? 60 : e.setup,
        grid: i + 1, status: 'running', dnf: null, cum: i * 0.25, lastLap: null, bestLap: null,
        tyre: { compound: comp, wear: 0, age: 0 }, stints: [{ compound: comp, from: 1, to: null }],
        paceAdj: e.paceAdj || 0, form: weekendForm(opts.seed, id, rules), ai: e.ai || {},
        used: [comp], stops: 0, mode: MODES[e.startMode] ? e.startMode : 'standard', energy: 60, plan: (e.plan || []).slice(), manual: !!e.manual,
        pendingBox: null, refuse: false, positions: [], lapTimes: []
      };
    });
    return {
      version: 1, seed: opts.seed >>> 0, circuit: circuit, rules: rules, sprint: !!opts.sprint, lap: 0, laps: laps, track: plan,
      sc: { type: null, laps: 0 }, cars: cars, orders: {}, fastest: null, finished: false, events: []
    };
  }

  /* ------------------------------------------------------------ calls */
  function applyCalls(s, calls, log) {
    (calls || []).forEach(function (c) {
      if (c.team) { s.orders[c.team] = c.value === 'none' ? null : { value: c.value, lap: s.lap + 1 };
        if (c.value !== 'none') log.push({ kind: 'order', team: c.team, text: 'Team order for ' + c.team + ': ' + c.value }); return; }
      var car = s.cars.filter(function (x) { return x.id === c.entry; })[0];
      if (!car || car.status !== 'running') return;
      if (c.type === 'box') car.pendingBox = c.compound || 'auto';
      else if (c.type === 'mode' && MODES[c.value]) car.mode = c.value;
      else if (c.type === 'plan') car.plan = (c.stops || []).slice();
      else if (c.type === 'manual') car.manual = !!c.value;
      else if (c.type === 'refuseOrder') { car.refuse = true; log.push({ kind: 'order', ids: [car.id], text: car.driver.code + ' refuses the team order' }); }
    });
  }

  /* ------------------------------------------------------------ AI strategist */
  function chooseCompound(car, s, track) {
    if (track === 2) return 'wet';
    if (track === 1) return 'inter';
    var left = s.laps - s.lap, opts = ['soft', 'medium', 'hard'];
    var dryUsed = car.used.filter(function (c) { return !COMPOUNDS[c].wet; });
    var needNew = s.rules.mandatoryCompounds !== false && dryUsed.length === 1 ? dryUsed[0] : null;
    for (var i = 0; i < opts.length; i++) {
      var c = opts[i];
      if (tyreLife(c, car, s.circuit) * 1.05 >= left && c !== needNew) return c;
    }
    return needNew === 'hard' ? 'medium' : 'hard';
  }
  function aiWantsBox(car, s, track) {
    var left = s.laps - s.lap, c = COMPOUNDS[car.tyre.compound], life = tyreLife(car.tyre.compound, car, s.circuit);
    var planned = car.plan.filter(function (p) { return p.lap === s.lap; })[0];
    if (planned) return planned.compound || 'auto';
    if (track === 0 && c.wet && car.tyre.age >= 1) return 'auto';
    if (track > 0 && !c.wet) return 'auto';
    if (track === 1 && car.tyre.compound === 'wet' && s.track[s.lap - 2] === 1) return 'auto';
    if (track === 2 && car.tyre.compound === 'inter' && s.track[s.lap - 2] === 2) return 'auto';
    if (car.manual) return car.tyre.wear > life * 1.3 ? 'auto' : null;
    if (left <= 1) return null;
    var ai = car.ai || {}, stretch = ai.stretch || 1;
    if (car.tyre.wear >= life * 0.92 * stretch && left > 3) return 'auto';
    if (s.sc.type && car.tyre.wear > life * (ai.scPit || 0.45) && left > 8) return 'auto';
    if (ai.undercut && !s.sc.type && car.tyre.wear >= life * 0.7 && left > 8) {
      /* Undercut: stop early when stuck within a second and a half of the car ahead. */
      var ahead = order(s).filter(function (c) { return c.cum < car.cum; }).pop();
      if (ahead && car.cum - ahead.cum < 1.5 && ahead.tyre.age >= car.tyre.age - 2) return 'auto';
    }
    var dry = car.used.filter(function (x) { return !COMPOUNDS[x].wet; });
    var wetRace = s.track.some(function (t) { return t > 0; });
    if (s.rules.mandatoryCompounds !== false && !wetRace && dry.length < 2 && left <= 3) return 'auto';
    return null;
  }

  /* ------------------------------------------------------------ one lap */
  function running(s) { return s.cars.filter(function (c) { return c.status === 'running'; }); }
  function order(s) { return running(s).sort(function (a, b) { return a.cum - b.cum; }); }

  function stepLap(state, calls) {
    var s = JSON.parse(JSON.stringify(state)), log = [];
    if (s.finished) return { state: s, log: log };
    applyCalls(s, calls, log);
    s.lap += 1;
    var R = s.rules, circuit = s.circuit, r = rng(mix(s.seed, s.lap, 2)), track = s.track[s.lap - 1];
    if (s.lap > 1 && track !== s.track[s.lap - 2]) log.push({ kind: 'weather', text: 'Track now ' + TRACK[track] });
    var field = order(s), leader0 = field[0] ? field[0].cum : 0;
    var newSc = null;

    /* raw lap times */
    var raw = {};
    field.forEach(function (car, i) {
      var m = MODES[car.mode], t = basePace(car, circuit, R, track) + m.pace + tyreTime(car.tyre, car, circuit, track)
        + R.fuelEffect * (1 - (s.lap - 1) / s.laps);
      t += gauss(r) * (0.12 + (100 - car.driver.consistency) * 0.008);
      if (s.lap === 1) t += 4 + gauss(r) * (0.5 + (100 - car.driver.racecraft) * 0.02);
      var risk = m.risk * (1 + track * 1.5) * (1 + ((car.driver.aggression || 50) - 50) / 100) * composure(car.driver) * (s.lap === 1 ? 4 : 1);
      if (!s.sc.type && r() < R.mistakeRate * risk) { var lost = 0.8 + r() * 2.7; t += lost; log.push({ kind: 'mistake', ids: [car.id], text: car.driver.code + ' makes a mistake, ' + lost.toFixed(1) + 's lost' }); }
      if (!s.sc.type && r() < R.crashRate * risk * (1 + track)) { retire(car, 'Accident', log, s); newSc = r() < 0.65 ? 'sc' : 'vsc'; return; }
      if (r() < R.failureRate * (1 - (car.car.reliability || 85) / 100) * (1 + (car.car.wear || 0) / 100)) {
        var what = ['power unit', 'gearbox', 'hydraulics', 'energy store', 'brakes'][Math.floor(r() * 5)];
        retire(car, 'Failure: ' + what, log, s); if (r() < 0.3) newSc = 'vsc'; return;
      }
      if (i > 0 && !s.sc.type) {
        var gap = car.cum - field[i - 1].cum;
        if (gap < 1.0) t += R.dirtyAir * (1 - gap);
      }
      raw[car.id] = t;
    });
    if (!newSc && !s.sc.type && r() < (circuit.scChance || 0.004)) { newSc = r() < 0.5 ? 'sc' : 'vsc'; log.push({ kind: 'incident', text: 'Debris on track' }); }

    field = field.filter(function (c) { return c.status === 'running'; });
    var start = {}; field.forEach(function (c) { start[c.id] = c.cum; });

    if (s.sc.type) {
      /* Behind the safety car: no passing; under the full SC the field bunches up. */
      var scLap = circuit.baseLap * (s.sc.type === 'sc' ? R.scPace : R.vscPace), prevEnd = null;
      field.forEach(function (car) {
        var end;
        if (s.sc.type === 'sc') {
          /* The leader follows the safety car; everyone else closes up to the train, but no faster than racing pace. */
          end = prevEnd == null ? car.cum + scLap : Math.max(prevEnd + R.scBunch, car.cum + circuit.baseLap * 1.08);
        } else end = car.cum + scLap + (raw[car.id] - circuit.baseLap) * 0.2;
        car.lastLap = round3(end - car.cum); car.cum = round3(end); prevEnd = end;
      });
    } else {
      /* Green flag: resolve each car against the one ahead, front to back. */
      field.forEach(function (car, i) {
        var t = raw[car.id], end = car.cum + t;
        if (i > 0) {
          var ahead = field[i - 1], aheadEnd = ahead.cum, sameTeam = ahead.team === car.team;
          var ord = s.orders[car.team];
          if (end < aheadEnd + R.minGap) {
            var hold = sameTeam && ord && ord.value === 'hold' && !car.refuse;
            var chance = 0;
            if (!hold) {
              var adv = raw[ahead.id] - t, ease = circuit.overtaking == null ? 0.7 : circuit.overtaking;
              chance = ease * (R.overtake.base + Math.max(0, adv - 0.1) * R.overtake.pace) + (attack(car.driver) - defend(ahead.driver)) * R.overtake.racecraft;
              if (car.energy >= R.overtakeMode.cost && (start[car.id] - start[ahead.id]) < R.overtakeMode.gap) { chance += R.overtakeMode.bonus * (0.4 + ease * 0.6); car.energy -= R.overtakeMode.cost; }
              if (track > 0) chance += (car.driver.wet - ahead.driver.wet) * 0.005;
              chance = clamp(chance, 0.005, 0.85);
            }
            if (!hold && r() < chance) {
              end = Math.min(end, aheadEnd - 0.1 - r() * 0.3);
              var pushed = Math.max(ahead.cum, end + R.minGap * 0.5);
              ahead.lastLap = round3(ahead.lastLap + pushed - ahead.cum); ahead.cum = round3(pushed);
              log.push({ kind: 'overtake', ids: [car.id, ahead.id], text: car.driver.code + ' passes ' + ahead.driver.code + ' for P' + i });
              field[i - 1] = car; field[i] = ahead;
            } else {
              end = aheadEnd + R.minGap + r() * 0.3;
            }
          }
        }
        car.lastLap = round3(end - car.cum); car.cum = round3(end);
      });
      /* Team order: swap */
      Object.keys(s.orders).forEach(function (team) {
        var o = s.orders[team]; if (!o || o.value !== 'swap') return;
        var mates = order(s).filter(function (c) { return c.team === team; });
        if (mates.length < 2) return;
        var front = mates[0], back = mates[1];
        if (back.cum - front.cum > 2.5) return;
        if (front.refuse) { log.push({ kind: 'order', ids: [front.id], text: front.driver.code + ' ignores the call to let ' + back.driver.code + ' by' }); s.orders[team] = null; return; }
        var t = front.cum; front.cum = round3(back.cum + 0.6); back.cum = round3(Math.min(back.cum, t + 0.2));
        log.push({ kind: 'order', ids: [front.id, back.id], text: front.driver.code + ' lets ' + back.driver.code + ' through on team orders' });
        s.orders[team] = null;
      });
    }

    /* tyres, energy, pit stops (laps after a pit stop don't count for fastest lap) */
    var box0 = {}; running(s).forEach(function (car) { box0[car.id] = s.events.concat(log).some(function (e) { return e.kind === 'pit' && e.ids[0] === car.id && (e.lap === s.lap - 1 || e.lap == null); }); });
    running(s).forEach(function (car) {
      var m = MODES[car.mode];
      car.tyre.age += 1;
      car.tyre.wear = round3(car.tyre.wear + (s.sc.type ? 0.3 : 1) * m.deg * (circuit.tyreStress || 1) * (1.25 - car.driver.tyreMgmt / 200));
      car.energy = clamp(car.energy + m.energy, 0, 100);
      if (!s.sc.type && !box0[car.id] && car.lastLap && (!car.bestLap || car.lastLap < car.bestLap)) car.bestLap = car.lastLap;
      if (!s.sc.type && !box0[car.id] && car.lastLap && (!s.fastest || car.lastLap < s.fastest.time)) s.fastest = { id: car.id, time: car.lastLap, lap: s.lap };
      var box = car.pendingBox || (s.lap < s.laps ? aiWantsBox(car, s, track) : null);
      if (box && s.lap < s.laps) {
        var comp = box === 'auto' || !COMPOUNDS[box] ? chooseCompound(car, s, s.track[s.lap] != null ? s.track[s.lap] : track) : box;
        var crew = car.car.pitSpeed == null ? 85 : car.car.pitSpeed;
        var stop = Math.max(1.9, R.pitStop.mean - (crew - 85) * 0.03 + gauss(r) * R.pitStop.sd);
        var slow = r() < R.pitStop.slowChance * (1 + (85 - crew) / 30); if (slow) stop += 2 + r() * 6;
        var loss = (circuit.pitLoss || 21) * (s.sc.type === 'sc' ? 0.55 : s.sc.type === 'vsc' ? 0.65 : 1) + stop;
        car.cum = round3(car.cum + loss); car.lastLap = round3(car.lastLap + loss);
        car.stints[car.stints.length - 1].to = s.lap;
        car.stints.push({ compound: comp, from: s.lap + 1, to: null });
        car.tyre = { compound: comp, wear: 0, age: 0 }; car.stops += 1; car.pendingBox = null;
        if (car.used.indexOf(comp) < 0) car.used.push(comp);
        car.plan = car.plan.filter(function (p) { return p.lap > s.lap; });
        log.push({ kind: 'pit', ids: [car.id], text: car.driver.code + ' pits for ' + COMPOUNDS[comp].label + 's (' + stop.toFixed(1) + 's' + (slow ? ', slow stop' : '') + ')' });
      }
    });

    /* safety car bookkeeping */
    if (s.sc.type) {
      s.sc.laps -= 1;
      if (s.sc.laps <= 0) { log.push({ kind: s.sc.type, text: (s.sc.type === 'sc' ? 'Safety car' : 'Virtual safety car') + ' ends, racing resumes' }); s.sc = { type: null, laps: 0 }; }
    } else if (newSc && s.lap < s.laps - 1) {
      s.sc = { type: newSc, laps: newSc === 'sc' ? 3 + Math.floor(r() * 3) : 2 + Math.floor(r() * 2) };
      log.push({ kind: newSc, text: newSc === 'sc' ? 'Safety car deployed' : 'Virtual safety car deployed' });
    }

    order(s).forEach(function (car, i) { car.positions.push(i + 1); car.lapTimes.push(car.lastLap); car.refuse = car.refuse && !!s.orders[car.team]; });
    s.cars.forEach(function (car) { if (car.status !== 'running' && car.positions.length < s.lap) car.positions.push(null); });

    if (s.lap >= s.laps) {
      s.finished = true;
      running(s).forEach(function (c) { c.stints[c.stints.length - 1].to = s.lap; });
      var w = order(s)[0];
      log.push({ kind: 'finish', ids: w ? [w.id] : [], text: w ? w.driver.code + ' wins the ' + (circuit.race || circuit.name) : 'Race over' });
    }
    log.forEach(function (l) { l.lap = s.lap; });
    s.events = s.events.concat(log);
    return { state: s, log: log };
  }

  function retire(car, why, log, s) {
    car.status = 'dnf'; car.dnf = why; car.retiredLap = s.lap;
    car.stints[car.stints.length - 1].to = s.lap;
    log.push({ kind: 'dnf', ids: [car.id], text: car.driver.code + ' out: ' + why });
  }

  function runTo(state, lap, callsByLap) {
    var s = state, log = [];
    while (!s.finished && s.lap < lap) {
      var out = stepLap(s, (callsByLap && callsByLap[s.lap + 1]) || []);
      s = out.state; log = log.concat(out.log);
    }
    return { state: s, log: log };
  }

  function classify(s) {
    var R = s.rules, run = order(s), lead = run[0], leadLap = lead ? lead.cum / Math.max(1, s.lap) : 1;
    var out = run.map(function (c, i) {
      var behind = c.cum - (lead ? lead.cum : 0), down = Math.floor(behind / leadLap);
      return { id: c.id, position: i + 1, status: 'finished', gap: i === 0 ? null : down >= 1 ? '+' + down + ' lap' + (down > 1 ? 's' : '') : '+' + behind.toFixed(3) + 's',
               time: c.cum, stops: c.stops, best: c.bestLap, grid: c.grid, points: R.points[i] || 0 };
    });
    var dnf = s.cars.filter(function (c) { return c.status !== 'running'; }).sort(function (a, b) { return (b.retiredLap || 0) - (a.retiredLap || 0); });
    dnf.forEach(function (c) { out.push({ id: c.id, position: null, status: 'dnf', gap: c.dnf, stops: c.stops, best: c.bestLap, grid: c.grid, points: 0, lap: c.retiredLap }); });
    return out;
  }

  var api = { COMPOUNDS: COMPOUNDS, MODES: MODES, TRACK: TRACK, DEFAULTS: DEFAULTS, rng: rng, carScore: carScore, tyreLife: tyreLife, composure: composure,
              weatherPlan: weatherPlan, qualify: qualify, createRace: createRace, stepLap: stepLap, runTo: runTo, classify: classify };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RaceEngine = api;
})(typeof window !== 'undefined' ? window : this);

;
/* =====================================================================
   Formula Racing V3.0 data -> F1 SIM race engine inputs.
   Keeps the V3.0 attribute scales (so the admin ratings screen still
   makes sense) and translates them into what the lap-by-lap engine uses.
   Pure functions, no I/O.

     toCircuit(track)                 -> engine circuit
     toEntries(drivers, teams, track) -> engine entries
     weatherFor(track, mode)          -> engine weather
   ===================================================================== */
(function (root) {
  'use strict';

  /* V3.0 tracks have no lap times or pit-lane losses, which the engine needs
     for strategy. Approximate race-pace lap (s) and pit loss (s). */
  var LAP_REF = {
    australia: [82.5, 19], china: [98, 22], japan: [94, 22], bahrain: [96, 23], saudi: [92, 20],
    miami: [92, 20], spain: [78, 21], monaco: [75, 19], canada: [76, 18], austria: [69, 20],
    britain: [90, 20], hungary: [81, 20], belgium: [108, 18], netherlands: [74, 21], italy: [84, 24],
    azerbaijan: [106, 20], singapore: [96, 28], usa: [99, 20], mexico: [81, 22], brazil: [74, 21],
    lasvegas: [96, 20], qatar: [85, 25], abudhabi: [88, 22]
  };

  /* Which car qualities each circuit type rewards. */
  var TYPE_WEIGHTS = {
    'low-downforce':  { power: 0.60, aero: 0.20, grip: 0.20 },
    'high-speed':     { power: 0.40, aero: 0.45, grip: 0.15 },
    'high-downforce': { power: 0.20, aero: 0.55, grip: 0.25 },
    'technical':      { power: 0.20, aero: 0.40, grip: 0.40 },
    'street':         { power: 0.25, aero: 0.25, grip: 0.50 },
    'mixed':          { power: 0.35, aero: 0.35, grip: 0.30 }
  };

  /* V3.0 driving styles become small attribute changes. */
  var STYLES = {
    charger:    { aggression: 65, overtaking: 2 },
    aggressive: { aggression: 78 },
    qualifier:  { aggression: 55, qualiAdj: -0.12 },
    technical:  { aggression: 50, setup: 6 },
    smooth:     { aggression: 45, tyreMgmt: 5 },
    defender:   { aggression: 50, defense: 3 },
    strategist: { aggression: 50, tyreMgmt: 3, stretch: 1.04 },
    ironman:    { aggression: 45, consistency: 3 }
  };

  /* V3.0 team strategies, which used to scale a team's pace by up to 4%,
     become the AI strategist's habits instead. They change decisions, not speed. */
  var ARCHETYPES = {
    one_stop:       { label: 'One-stop',      stretch: 1.12, scPit: 0.50 },
    aggressive_two: { label: 'Aggressive two-stop', stretch: 0.80, scPit: 0.40 },
    undercut_king:  { label: 'Undercut',      stretch: 0.95, scPit: 0.45, undercut: true },
    overcut:        { label: 'Overcut',       stretch: 1.08, scPit: 0.60 },
    fuel_save:      { label: 'Lift and coast', stretch: 1.10, scPit: 0.45, startMode: 'manage', reliability: 3 },
    safety_car:     { label: 'Waits for a safety car', stretch: 1.06, scPit: 0.28 },
    tyre_banker:    { label: 'Tyre banker',   stretch: 1.00, scPit: 0.40, tyreLife: 4 },
    reactive:       { label: 'Reactive',      stretch: 1.00, scPit: 0.35 }
  };

  var clamp = function (x, lo, hi) { return Math.max(lo, Math.min(hi, x)); };

  function toCircuit(t) {
    var ref = LAP_REF[t.id] || [90, 21];
    return {
      id: t.id, name: t.circuit, race: t.name, laps: t.laps, baseLap: ref[0], pitLoss: ref[1],
      overtaking: clamp((100 - t.od) / 75, 0.12, 1.15),               // od: overtaking difficulty 0-100
      tyreStress: 0.55 + t.td / 100 * 0.6 + (t.abrasive || 3) * 0.03, // td: tyre degradation 0-100
      weights: TYPE_WEIGHTS[t.type] || TYPE_WEIGHTS.mixed,
      scChance: 0.003 + (t.street ? 0.006 : 0),
      wetRisk: t.wr, hasSprint: !!t.hasSprint, flag: t.flag
    };
  }

  /* Changeable weather uses the track's wet risk (wr, 0-100). */
  function weatherFor(t, mode) {
    if (mode === 'dry') return { start: 'dry' };
    return { mode: 'variable', rainChance: (t.wr || 0) / 100 * 0.6 };
  }

  /* V3.0 ratings are spread wide (car pace 67-96, driver pace 72-97). Compress
     them (spread, driverSpread) so the field covers about two seconds a lap and
     the midfield can still score; tune these rather than the ratings. */
  function toCar(team, spread) {
    var k = spread == null ? 0.45 : spread, base = 85 + (team.carPace - 82) * k;
    var arch = ARCHETYPES[team.strategy] || ARCHETYPES.reactive;
    return {
      power: base + ((team.topSpeed || 12) - 12.5) * 0.8,
      aero:  base + ((team.cornering || 12) - 12.5) * 0.8,
      grip:  base + ((team.cornering || 12) - 12.5) * 0.4,
      reliability: clamp((team.reliability || 75) + (arch.reliability || 0), 40, 99),
      pitSpeed: team.pitSpeed, tyreLife: (team.tyreLife || 75) + (arch.tyreLife || 0)
    };
  }

  function toDriver(d, spread) {
    var st = STYLES[d.style] || {}, k = spread == null ? 0.7 : spread;
    var tyreMgmt = Math.round(d.consistency * 0.6 + d.experience * 0.4) + (st.tyreMgmt || 0);
    return {
      code: d.abbr, name: d.name, num: d.num, flag: d.flag, style: d.style,
      pace: Math.round((85 + (d.pace - 85) * k) * 10) / 10, wet: d.wet, consistency: clamp(d.consistency + (st.consistency || 0), 1, 99),
      overtaking: clamp(d.overtaking + (st.overtaking || 0), 1, 99), defense: clamp(d.defense + (st.defense || 0), 1, 99),
      racecraft: Math.round((d.overtaking + d.defense) / 2), tyreMgmt: clamp(tyreMgmt, 1, 99),
      experience: d.experience, mental: d.mental, aggression: st.aggression || 50, rivals: d.rivals || []
    };
  }

  function toEntries(drivers, teams, track, opts) {
    opts = opts || {};
    var byTeam = {}; teams.forEach(function (t) { byTeam[t.id] = t; });
    return drivers.map(function (d) {
      var team = byTeam[d.teamId], st = STYLES[d.style] || {}, arch = ARCHETYPES[team.strategy] || ARCHETYPES.reactive;
      var affinity = (d.goodTracks || []).indexOf(track.id) >= 0 ? -0.15 : (d.badTracks || []).indexOf(track.id) >= 0 ? 0.15 : 0;
      return {
        id: d.abbr, team: team.id, driver: toDriver(d, opts.driverSpread), car: toCar(team, opts.spread),
        setup: (opts.setup && opts.setup[d.abbr] != null ? opts.setup[d.abbr] : 60) + (st.setup || 0),
        paceAdj: affinity, qualiAdj: st.qualiAdj || 0,
        ai: { stretch: arch.stretch * (st.stretch || 1), scPit: arch.scPit, undercut: !!arch.undercut },
        startMode: arch.startMode
      };
    });
  }

  var api = { LAP_REF: LAP_REF, TYPE_WEIGHTS: TYPE_WEIGHTS, STYLES: STYLES, ARCHETYPES: ARCHETYPES,
              toCircuit: toCircuit, toEntries: toEntries, toCar: toCar, toDriver: toDriver, weatherFor: weatherFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FormulaRacingAdapter = api;
})(typeof window !== 'undefined' ? window : this);

;
/* =====================================================================
   F1 SIM — app core: state, data layer, shell, navigation and events.
   Storage comes from bridge.js as window.claude.use('db'): records by
   collection, live through Supabase Realtime.
   ===================================================================== */
'use strict';

const COLLECTIONS = ['characters', 'f1_teams', 'f1_people', 'f1_seats', 'f1_tracks', 'f1_weekends', 'f1_calls',
  'f1_applications', 'f1_posts', 'f1_settings', 'audit'];

const S = {
  phase: 'boot', store: {}, delivered: new Set(), db: null, uid: null, isGm: false, isOwner: false,
  route: 'home', charId: null, busy: false, navOpen: false,
  ui: { form: {}, drawer: null, confirm: null, toast: null }
};

/* ---------------------------------------------------------------- helpers */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => s == null ? '' : String(s).replace(/[&<>"']/g, c => ESC[c]);
const nowIso = () => new Date().toISOString();
const newId = p => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
const plural = (n, w, pl) => n + ' ' + (n === 1 ? w : (pl || w + 's'));
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const fmtWhen = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const list = col => Object.keys(S.store[col] || {}).map(id => Object.assign({}, S.store[col][id], { id }));
const get = (col, id) => id && S.store[col] && S.store[col][id] ? Object.assign({}, S.store[col][id], { id }) : null;
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } }
function setPath(path, value) {
  const keys = path.split('/'); let o = S;
  for (let i = 0; i < keys.length - 1; i++) { if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {}; o = o[keys[i]]; }
  o[keys[keys.length - 1]] = value;
}
const ACCOUNT = () => (typeof window !== 'undefined' && window.F1SIM_ACCOUNT) || null;

const ICONS = {
  menu: 'M3 6h18M3 12h18M3 18h18', x: 'M6 6l12 12M18 6L6 18', plus: 'M12 5v14M5 12h14',
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z', flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  radio: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H4zM17 15h3v5h-3z', star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  users: 'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  news: 'M4 4h13v16H6a2 2 0 0 1-2-2zM17 8h3v10a2 2 0 0 1-2 2M8 8h5M8 12h5M8 16h3', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  server: 'M4 4h16v7H4zM4 13h16v7H4zM8 7.5h.01M8 16.5h.01', logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'
};
const icon = (n, size) => `<svg class="ico" viewBox="0 0 24 24" width="${size || 18}" height="${size || 18}" aria-hidden="true"><path d="${ICONS[n] || ''}"/></svg>`;

/* ---------------------------------------------------------------- data layer */
const Data = {
  /* Writes apply to the local copy at once and roll back if the database refuses. */
  async put(col, id, data) {
    const bucket = S.store[col] = S.store[col] || {};
    const had = Object.prototype.hasOwnProperty.call(bucket, id), prev = bucket[id];
    bucket[id] = clone(data);
    try { await S.db.collection(col).doc(id).set(data); }
    catch (e) { if (had) bucket[id] = prev; else delete bucket[id]; throw e; }
  },
  async remove(col, id) {
    const bucket = S.store[col] || {}, prev = bucket[id];
    delete bucket[id];
    try { await S.db.collection(col).doc(id).delete(); }
    catch (e) { if (prev !== undefined) bucket[id] = prev; throw e; }
  },
  async audit(action, summary) {
    await Data.put('audit', newId('aud'), { at: nowIso(), userId: S.uid, actor: actorLabel(), action, summary });
  }
};
function actorLabel() { const c = currentChar(); const a = ACCOUNT(); return S.isGm ? 'Race Control' + (a ? ` (${a.username})` : '') : (c ? c.name : (a ? a.username : 'player')); }

function toast(msg, bad) {
  S.ui.toast = { msg, bad: !!bad }; renderOverlay();
  clearTimeout(toast.t); toast.t = setTimeout(() => { S.ui.toast = null; renderOverlay(); }, bad ? 6000 : 3200);
}
/* Run a write sequence with one busy flag and a readable failure message. */
async function run(fn, okMsg) {
  if (S.busy) return false;
  S.busy = true; render();
  let ok = false;
  try { await fn(); ok = true; if (okMsg) toast(okMsg); }
  catch (e) {
    const code = e && e.code;
    if (code === 'not_granted') toast('Your account isn’t allowed to change this. Ask Race Control.', true);
    else if (code === 'quota_exceeded') toast('The database is full. Download a backup and remove old race weekends, or move to a larger Supabase plan.', true);
    else toast('Couldn’t save: ' + ((e && e.message) || 'unknown error') + '. Try again.', true);
  } finally { S.busy = false; render(); }
  return ok;
}
function askConfirm(message, confirmText, action, danger) { S.ui.confirm = { message, confirmText, action, danger: !!danger }; renderOverlay(); }

/* ---------------------------------------------------------------- characters */
const CHAR_ROLES = [['driver', 'Driver'], ['principal', 'Team principal'], ['engineer', 'Race engineer'], ['media', 'Media'], ['paddock', 'Paddock life']];
const charRoleName = k => (CHAR_ROLES.find(r => r[0] === k) || [k, k])[1];
const myChars = () => list('characters').filter(c => c.userId === S.uid && !c.retired).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
const currentChar = () => { const c = get('characters', S.charId); return c && c.userId === S.uid ? c : null; };
function resolveChar() {
  const mine = myChars(), saved = lsGet('f1sim.char');
  S.charId = (mine.find(c => c.id === saved) || mine[0] || {}).id || null;
}

/* ---------------------------------------------------------------- routes, actions, drawers */
const ROUTES = {}, ACTIONS = {}, CHANGES = {}, DRAWERS = {};
function route(name, title, view, opts) { ROUTES[name] = Object.assign({ title, view }, opts || {}); }
function openDrawer(type, extra) { S.ui.drawer = Object.assign({ type }, extra || {}); renderOverlay(); }
function closeDrawer() { S.ui.drawer = null; renderOverlay(); }
function go(r) { if (!ROUTES[r]) r = 'home'; S.route = r; S.navOpen = false; S.ui.drawer = null; if (location.hash.slice(1) !== r) history.replaceState(null, '', '#' + r); render(); window.scrollTo(0, 0); }

const NAV = [
  ['home', 'home', 'Home'], ['grid', 'flag', 'The Grid'], ['weekend', 'radio', 'Race Weekend'], ['standings', 'star', 'Championship'],
  ['paddock', 'news', 'Paddock'], ['characters', 'user', 'Your characters']
];
const NAV_RC = [['control', 'shield', 'Race Control'], ['admin', 'server', 'Accounts and backups']];
function navHtml() {
  const item = ([r, ic, label, count]) => `<button class="nav-item" data-act="nav" data-route="${r}" ${S.route === r ? 'aria-current="page"' : ''}>${icon(ic)}<span>${esc(label)}</span>${count ? `<span class="count">${count}</span>` : ''}</button>`;
  const pending = S.isGm ? list('f1_applications').filter(a => a.status === 'pending').length : 0;
  let h = `<div class="nav-group">${NAV.map(item).join('')}</div>`;
  if (S.isGm) h += `<div class="nav-group rc"><p class="nav-h">Race Control</p>${item(['control', 'shield', 'Race Control', pending])}${S.isOwner ? item(NAV_RC[1]) : ''}</div>`;
  return h;
}
function topbarHtml() {
  const a = ACCOUNT(), mine = myChars(), c = currentChar();
  const who = mine.length > 1 ? `<label class="who"><span class="sr-only">Playing as</span><select id="char-switch" data-change="char-switch">${mine.map(x => `<option value="${esc(x.id)}" ${x.id === S.charId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`
    : c ? `<span class="who">${esc(c.name)}</span>` : '';
  return `<button class="menu-btn" data-act="nav-toggle" aria-label="${S.navOpen ? 'Close' : 'Open'} the menu" aria-expanded="${S.navOpen}">${icon(S.navOpen ? 'x' : 'menu', 22)}</button>
    <button class="brand" data-act="nav" data-route="home"><span class="brand-mark" aria-hidden="true"></span>F1 SIM</button>
    <div class="top-right">${S.isGm ? '<span class="rc-badge">Race Control</span>' : ''}${who}
      ${a ? `<button class="btn ghost small" data-act="sign-out" title="Signed in as ${esc(a.username)}">${icon('logout', 16)}<span class="hide-s">Sign out</span></button>` : ''}</div>`;
}

/* ---------------------------------------------------------------- rendering */
let renderQueued = false;
function scheduleRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); }
function bootHtml(title, body) { return `<div class="boot"><div class="boot-card"><span class="brand-mark big" aria-hidden="true"></span><h1>${title}</h1><p>${body}</p></div></div>`; }
function render() {
  const app = document.getElementById('app');
  if (S.phase !== 'ready') {
    app.innerHTML = S.phase === 'boot' ? bootHtml('Connecting', 'Loading the grid, the calendar and the paddock.')
      : S.phase === 'timeout' ? bootHtml('Still connecting', 'The database is slow to answer. The league opens as soon as the data arrives.')
      : bootHtml('Can’t open the league', 'Sign in again, or check that the database set-up has run.');
    renderOverlay(); return;
  }
  const ae = document.activeElement, fid = ae && ae.id ? ae.id : null;
  let sel = null; try { if (fid && ae.selectionStart != null) sel = [ae.selectionStart, ae.selectionEnd]; } catch (e) { sel = null; }
  if (!app.querySelector('.shell')) app.innerHTML = `<div class="shell"><header class="topbar" id="topbar"></header><nav class="side" id="side" aria-label="Main"></nav><main class="main" id="main" tabindex="-1"></main></div>`;
  app.querySelector('.shell').classList.toggle('nav-open', S.navOpen);
  document.getElementById('topbar').innerHTML = topbarHtml();
  document.getElementById('side').innerHTML = navHtml();
  const r = ROUTES[S.route] || ROUTES.home;
  let body;
  if (r.gm && !S.isGm) body = '<div class="empty">This page is for Race Control.</div>';
  else if (r.owner && !S.isOwner) body = '<div class="empty">This page is for the Administrator.</div>';
  else { try { body = r.view(); } catch (e) { console.error(e); body = `<div class="empty">This page couldn’t be shown: ${esc(e.message)}</div>`; } }
  document.getElementById('main').innerHTML = `<div class="page">${body}</div>`;
  document.title = `${r.title} · F1 SIM`;
  renderOverlay();
  if (fid) { const el = document.getElementById(fid); if (el) { el.focus({ preventScroll: true }); if (sel) { try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not text */ } } } }
}
function renderOverlay() {
  let ov = document.getElementById('overlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'overlay'; document.body.appendChild(ov); }
  const db = ov.querySelector('.drawer .body'), keep = db ? db.scrollTop : 0;
  let h = '';
  if (S.ui.drawer && DRAWERS[S.ui.drawer.type]) h += `<div class="scrim" data-act="close-drawer"></div><section class="drawer" role="dialog" aria-modal="true" aria-label="Details">${DRAWERS[S.ui.drawer.type](S.ui.drawer)}</section>`;
  if (S.ui.confirm) { const c = S.ui.confirm; h += `<div class="scrim"></div><div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="cf-msg"><p id="cf-msg">${esc(c.message)}</p>
    <div class="btn-row"><button class="btn ${c.danger ? 'danger' : 'primary'}" data-act="confirm-ok" id="confirm-ok">${esc(c.confirmText)}</button><button class="btn" data-act="confirm-cancel">Cancel</button></div></div>`; }
  if (S.ui.toast) h += `<div class="toast ${S.ui.toast.bad ? 'bad' : ''}" role="status">${esc(S.ui.toast.msg)}</div>`;
  const focusedInOverlay = ov.contains(document.activeElement) ? document.activeElement.id : null;
  ov.innerHTML = h;
  const db2 = ov.querySelector('.drawer .body'); if (db2) db2.scrollTop = keep;
  if (focusedInOverlay) { const el = document.getElementById(focusedInOverlay); if (el) el.focus({ preventScroll: true }); }
  else if (S.ui.confirm) { const ok = document.getElementById('confirm-ok'); if (ok) ok.focus(); }
}

/* ---------------------------------------------------------------- events
   Typed fields (data-bind) store their value on every keystroke and never redraw:
   a redraw between pressing and releasing a button would swallow the click.
   Selects and checkboxes with data-bind redraw on change, because what they pick
   usually changes what's shown. */
function bindValue(el) {
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.type === 'number' && el.type !== 'checkbox') v = v === '' ? null : Number(v);
  setPath(el.dataset.bind, v);
}
document.addEventListener('click', e => {
  const el = e.target.closest && e.target.closest('[data-act]');
  if (!el || (el.tagName === 'INPUT' && el.type === 'checkbox')) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el.dataset, el, e); }
});
document.addEventListener('input', e => { const el = e.target; if (el.dataset && el.dataset.bind && el.tagName !== 'SELECT' && el.type !== 'checkbox') bindValue(el); });
document.addEventListener('change', e => {
  const el = e.target; if (!el.dataset) return;
  if (el.type === 'checkbox' && el.dataset.act) { ACTIONS[el.dataset.act](el.dataset, el); return; }
  if (el.dataset.bind) { bindValue(el); if (el.tagName === 'SELECT' || el.type === 'checkbox') render(); return; }
  if (el.dataset.change && CHANGES[el.dataset.change]) CHANGES[el.dataset.change](el.value, el.dataset, el);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (S.ui.confirm) { S.ui.confirm = null; renderOverlay(); } else if (S.ui.drawer) closeDrawer(); else if (S.navOpen) { S.navOpen = false; render(); }
});
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (ROUTES[h] && h !== S.route) go(h); });

Object.assign(ACTIONS, {
  nav: d => go(d.route),
  'nav-toggle': () => { S.navOpen = !S.navOpen; render(); },
  'close-drawer': () => closeDrawer(),
  'confirm-ok': () => { const a = S.ui.confirm.action; S.ui.confirm = null; renderOverlay(); a(); },
  'confirm-cancel': () => { S.ui.confirm = null; renderOverlay(); },
  'sign-out': () => { const a = ACCOUNT(); if (a) a.signOut(); }
});
CHANGES['char-switch'] = v => { S.charId = v; lsSet('f1sim.char', v); render(); };

/* ---------------------------------------------------------------- boot */
async function init() {
  render();
  const c = window.claude;
  if (!c || typeof c.use !== 'function') { S.phase = 'nodb'; render(); return; }
  const timer = setTimeout(() => { if (S.phase === 'boot') { S.phase = 'timeout'; render(); } }, 10000);
  let db = null, user = null;
  try { [db, user] = await Promise.all([c.use('db'), c.use('user')]); } catch (e) { db = null; }
  if (!db) { clearTimeout(timer); S.phase = 'nodb'; render(); return; }
  S.db = db;
  try { S.isGm = !!(await user.canEdit()); S.uid = await user.id(); S.isOwner = !!(await user.isOwner()); } catch (e) { /* treat as player */ }
  COLLECTIONS.forEach(col => {
    db.collection(col).onSnapshot(snap => {
      const m = {}; snap.docs.forEach(d => { m[d.id] = d.data(); });
      S.store[col] = m; S.delivered.add(col);
      if (S.phase !== 'ready' && S.delivered.size === COLLECTIONS.length) {
        clearTimeout(timer); S.phase = 'ready'; resolveChar();
        const h = location.hash.slice(1); S.route = ROUTES[h] ? h : 'home';
      }
      if (col === 'characters' && S.phase === 'ready' && !currentChar()) resolveChar();
      scheduleRender();
    }, () => { S.delivered.add(col); scheduleRender(); });
  });
}

/* ---------------------------------------------------------------- Your characters */
const CHAR_BLANK = { name: '', code: '', number: '', nationality: '', role: 'driver', bio: '', discord: '' };
ACTIONS['char-new'] = () => { S.ui.form.ch = Object.assign({}, CHAR_BLANK); openDrawer('char'); };
ACTIONS['char-edit'] = d => { const c = get('characters', d.id); if (!c) return; S.ui.form.ch = Object.assign({}, CHAR_BLANK, clone(S.store.characters[d.id]), { id: d.id }); openDrawer('char'); };
ACTIONS['char-play'] = d => { S.charId = d.id; lsSet('f1sim.char', d.id); toast('Now playing as ' + ((get('characters', d.id) || {}).name || 'this character') + '.'); render(); };
DRAWERS.char = function () {
  const f = S.ui.form.ch || {}, txt = (k, label, extra) => `<label class="field">${label}<input id="ch-${k}" type="text" data-bind="ui/form/ch/${k}" value="${esc(f[k] || '')}" ${extra || ''}></label>`;
  return `<header><div><h2>${f.id ? 'Edit character' : 'New character'}</h2><p>Characters are fiction. Race Control puts characters into seats on the grid; you can also apply for one.</p></div>
      <button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><div class="form-grid">
      ${txt('name', 'Name', 'autocomplete="off" required')}
      <label class="field">What they do<select id="ch-role" data-bind="ui/form/ch/role">${CHAR_ROLES.map(([k, l]) => `<option value="${k}" ${f.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${txt('nationality', 'Nationality', 'placeholder="e.g. Scottish"')}
      ${f.role === 'driver' ? txt('code', 'Three-letter code (drivers)', 'maxlength="3" placeholder="e.g. HAR"') + `<label class="field">Car number (drivers)<input id="ch-number" type="number" min="1" max="99" data-bind="ui/form/ch/number" data-type="number" value="${esc(f.number || '')}"></label>` : ''}
      ${txt('discord', 'Discord username (optional)', 'autocomplete="off"')}
    </div>
    <label class="field">About them<textarea id="ch-bio" rows="6" data-bind="ui/form/ch/bio" placeholder="Background, personality, how they got into the paddock">${esc(f.bio || '')}</textarea></label>
    <div class="btn-row"><button class="btn primary" data-act="char-save">${f.id ? 'Save changes' : 'Create character'}</button>${f.id ? `<button class="btn danger" data-act="char-retire" data-id="${esc(f.id)}">Retire this character</button>` : ''}</div></div>`;
};
ACTIONS['char-save'] = () => {
  const f = clone(S.ui.form.ch || {}), id = f.id || newId('ch'); delete f.id;
  f.name = String(f.name || '').trim();
  if (!f.name) { toast('Give your character a name.', true); return; }
  f.code = String(f.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  const prev = get('characters', id);
  const doc = Object.assign({}, prev ? clone(S.store.characters[id]) : { createdAt: nowIso() }, f, { userId: prev ? prev.userId : S.uid, updatedAt: nowIso() });
  run(async () => {
    await Data.put('characters', id, doc);
    if (!prev) { S.charId = id; lsSet('f1sim.char', id); await Data.audit('character.new', `${doc.name} joined the paddock as ${charRoleName(doc.role).toLowerCase()}`); }
    closeDrawer();
  }, prev ? 'Character saved.' : 'Character created. You’re now playing as ' + f.name + '.');
};
ACTIONS['char-retire'] = d => askConfirm('Retire this character? They leave any seat they hold and stop appearing in your list. Their race results stay in the record books.', 'Retire', () => run(async () => {
  const c = clone(S.store.characters[d.id]); c.retired = true; c.retiredAt = nowIso();
  for (const s of list('f1_seats').filter(x => x.holderCharId === d.id)) await Data.put('f1_seats', s.id, Object.assign(clone(S.store.f1_seats[s.id]), { holderCharId: null, holderName: null, holderSince: null }));
  await Data.put('characters', d.id, c); closeDrawer(); resolveChar();
}, 'Character retired.'), true);

route('characters', 'Your characters', function () {
  const mine = myChars();
  const card = c => { const seat = list('f1_seats').find(s => s.holderCharId === c.id), t = seat ? get('f1_teams', seat.teamId) : null;
    return `<article class="card char-card ${c.id === S.charId ? 'active' : ''}" ${t ? `style="--team:${esc(t.color)}"` : ''}>
      <h2>${esc(c.name)}</h2><p class="meta">${esc(charRoleName(c.role))}${c.nationality ? ', ' + esc(c.nationality) : ''}${c.code ? `, ${esc(c.code)}` : ''}${c.number ? ` #${esc(c.number)}` : ''}</p>
      <p>${seat ? `<b>${esc(seatTitle(seat))}, ${esc(t ? t.name : '')}</b>` : '<span class="muted">No seat yet</span>'}</p>
      ${c.bio ? `<p class="bio">${esc(c.bio.slice(0, 220))}${c.bio.length > 220 ? '…' : ''}</p>` : ''}
      <div class="btn-row">${c.id === S.charId ? '<span class="tag on">Playing now</span>' : `<button class="btn small primary" data-act="char-play" data-id="${esc(c.id)}">Play as ${esc(c.name.split(' ')[0])}</button>`}
        <button class="btn small" data-act="char-edit" data-id="${esc(c.id)}">Edit</button></div></article>`; };
  return `<div class="page-head"><div><h1>Your characters</h1><p>Drivers, team principals, race engineers, journalists and everyone else in the paddock. Play as one at a time; switch whenever you like.</p></div>
      <button class="btn primary" data-act="char-new">${icon('plus', 16)} New character</button></div>
    ${mine.length ? `<div class="cards">${mine.map(card).join('')}</div>` : `<div class="card empty-card"><h2>Make your first character</h2><p>Start with who they are and what they do. A driver or team principal can apply for a seat on The Grid once they exist.</p><button class="btn primary" data-act="char-new">Create a character</button></div>`}`;
});

const F1_DEFAULTS = {"teams":[{"id":"mclaren","name":"McLaren","abbr":"MCL","color":"#FF8000","strategy":"aggressive_two","carPace":96,"reliability":88,"pitSpeed":92,"tyreLife":82,"cornering":18,"topSpeed":14,"order":1,"powerUnit":"Mercedes"},{"id":"ferrari","name":"Ferrari","abbr":"FER","color":"#E8002D","strategy":"overcut","carPace":93,"reliability":84,"pitSpeed":87,"tyreLife":76,"cornering":16,"topSpeed":16,"order":2,"powerUnit":"Ferrari"},{"id":"redbull","name":"Red Bull","abbr":"RBR","color":"#3671C6","strategy":"one_stop","carPace":91,"reliability":83,"pitSpeed":95,"tyreLife":79,"cornering":16,"topSpeed":15,"order":3,"powerUnit":"Red Bull Ford"},{"id":"mercedes","name":"Mercedes","abbr":"MER","color":"#00D2BE","strategy":"undercut_king","carPace":89,"reliability":91,"pitSpeed":88,"tyreLife":83,"cornering":14,"topSpeed":14,"order":4,"powerUnit":"Mercedes"},{"id":"williams","name":"Williams","abbr":"WIL","color":"#37BEDD","strategy":"fuel_save","carPace":82,"reliability":82,"pitSpeed":83,"tyreLife":78,"cornering":11,"topSpeed":13,"order":5,"powerUnit":"Mercedes"},{"id":"racingbulls","name":"Racing Bulls","abbr":"RBX","color":"#6692FF","strategy":"reactive","carPace":81,"reliability":79,"pitSpeed":84,"tyreLife":74,"cornering":12,"topSpeed":13,"order":6,"powerUnit":"Red Bull Ford"},{"id":"astonmartin","name":"Aston Martin","abbr":"AMR","color":"#358C75","strategy":"safety_car","carPace":79,"reliability":80,"pitSpeed":82,"tyreLife":75,"cornering":12,"topSpeed":12,"order":7,"powerUnit":"Honda"},{"id":"alpine","name":"Alpine","abbr":"ALP","color":"#0093CC","strategy":"reactive","carPace":77,"reliability":77,"pitSpeed":79,"tyreLife":72,"cornering":10,"topSpeed":12,"order":8,"powerUnit":"Mercedes"},{"id":"haas","name":"Haas","abbr":"HAS","color":"#B6BABD","strategy":"tyre_banker","carPace":75,"reliability":76,"pitSpeed":80,"tyreLife":71,"cornering":10,"topSpeed":11,"order":9,"powerUnit":"Ferrari"},{"id":"audi","name":"Audi","abbr":"AUD","color":"#B30000","strategy":"one_stop","carPace":71,"reliability":72,"pitSpeed":78,"tyreLife":66,"cornering":9,"topSpeed":10,"order":10,"powerUnit":"Audi"},{"id":"cadillac","name":"Cadillac","abbr":"CAD","color":"#9B9B9B","strategy":"fuel_save","carPace":67,"reliability":70,"pitSpeed":76,"tyreLife":62,"cornering":8,"topSpeed":9,"order":11,"powerUnit":"Ferrari"}],"people":[{"kind":"driver","id":"norris","name":"Lando Norris","abbr":"NOR","num":4,"teamId":"mclaren","flag":"🇬🇧","pace":94,"consistency":90,"wet":88,"overtaking":91,"defense":87,"experience":82,"mental":8,"style":"charger","rivals":["verstappen","leclerc"],"goodTracks":["britain","belgium","usa"],"badTracks":["monaco","singapore","hungary"]},{"kind":"driver","id":"piastri","name":"Oscar Piastri","abbr":"PIA","num":81,"teamId":"mclaren","flag":"🇦🇺","pace":91,"consistency":88,"wet":85,"overtaking":87,"defense":84,"experience":76,"mental":8,"style":"technical","rivals":["norris","russell"],"goodTracks":["australia","japan","miami"],"badTracks":["monaco","canada","azerbaijan"]},{"kind":"driver","id":"russell","name":"George Russell","abbr":"RUS","num":63,"teamId":"mercedes","flag":"🇬🇧","pace":90,"consistency":89,"wet":87,"overtaking":85,"defense":86,"experience":78,"mental":8,"style":"technical","rivals":["antonelli","norris"],"goodTracks":["britain","belgium","brazil"],"badTracks":["monaco","azerbaijan","lasvegas"]},{"kind":"driver","id":"antonelli","name":"Kimi Antonelli","abbr":"ANT","num":12,"teamId":"mercedes","flag":"🇮🇹","pace":86,"consistency":82,"wet":80,"overtaking":83,"defense":79,"experience":60,"mental":6,"style":"qualifier","rivals":["russell","hadjar"],"goodTracks":["italy","china","bahrain"],"badTracks":["monaco","singapore","canada"]},{"kind":"driver","id":"verstappen","name":"Max Verstappen","abbr":"VER","num":1,"teamId":"redbull","flag":"🇳🇱","pace":97,"consistency":95,"wet":96,"overtaking":96,"defense":94,"experience":92,"mental":9,"style":"aggressive","rivals":["norris","leclerc"],"goodTracks":["japan","belgium","brazil"],"badTracks":["singapore","monaco","hungary"]},{"kind":"driver","id":"hadjar","name":"Isack Hadjar","abbr":"HAD","num":6,"teamId":"redbull","flag":"🇫🇷","pace":84,"consistency":80,"wet":78,"overtaking":81,"defense":78,"experience":58,"mental":6,"style":"aggressive","rivals":["lawson","antonelli"],"goodTracks":["bahrain","spain","austria"],"badTracks":["monaco","singapore","lasvegas"]},{"kind":"driver","id":"leclerc","name":"Charles Leclerc","abbr":"LEC","num":16,"teamId":"ferrari","flag":"🇲🇨","pace":92,"consistency":87,"wet":88,"overtaking":89,"defense":86,"experience":82,"mental":7,"style":"qualifier","rivals":["hamilton","verstappen"],"goodTracks":["monaco","azerbaijan","italy"],"badTracks":["hungary","brazil","japan"]},{"kind":"driver","id":"hamilton","name":"Lewis Hamilton","abbr":"HAM","num":44,"teamId":"ferrari","flag":"🇬🇧","pace":88,"consistency":86,"wet":90,"overtaking":88,"defense":88,"experience":99,"mental":9,"style":"smooth","rivals":["leclerc","alonso"],"goodTracks":["britain","hungary","spain"],"badTracks":["azerbaijan","lasvegas","qatar"]},{"kind":"driver","id":"sainz","name":"Carlos Sainz","abbr":"SAI","num":55,"teamId":"williams","flag":"🇪🇸","pace":87,"consistency":88,"wet":85,"overtaking":84,"defense":85,"experience":86,"mental":8,"style":"smooth","rivals":["albon","leclerc"],"goodTracks":["singapore","spain","australia"],"badTracks":["hungary","brazil","abudhabi"]},{"kind":"driver","id":"albon","name":"Alex Albon","abbr":"ALB","num":23,"teamId":"williams","flag":"🇹🇭","pace":82,"consistency":83,"wet":80,"overtaking":80,"defense":82,"experience":74,"mental":7,"style":"defender","rivals":["sainz"],"goodTracks":["miami","usa","australia"],"badTracks":["monaco","singapore","brazil"]},{"kind":"driver","id":"lawson","name":"Liam Lawson","abbr":"LAW","num":30,"teamId":"racingbulls","flag":"🇳🇿","pace":80,"consistency":78,"wet":77,"overtaking":79,"defense":76,"experience":66,"mental":7,"style":"technical","rivals":["hadjar","lindblad"],"goodTracks":["japan","china","bahrain"],"badTracks":["monaco","singapore","austria"]},{"kind":"driver","id":"lindblad","name":"Arvid Lindblad","abbr":"LIN","num":7,"teamId":"racingbulls","flag":"🇬🇧","pace":74,"consistency":72,"wet":70,"overtaking":73,"defense":70,"experience":40,"mental":5,"style":"qualifier","rivals":["lawson"],"goodTracks":["britain","austria","bahrain"],"badTracks":["monaco","singapore","italy"]},{"kind":"driver","id":"alonso","name":"Fernando Alonso","abbr":"ALO","num":14,"teamId":"astonmartin","flag":"🇪🇸","pace":88,"consistency":90,"wet":92,"overtaking":89,"defense":91,"experience":99,"mental":10,"style":"strategist","rivals":["hamilton","verstappen"],"goodTracks":["monaco","hungary","spain"],"badTracks":["azerbaijan","lasvegas","canada"]},{"kind":"driver","id":"stroll","name":"Lance Stroll","abbr":"STR","num":18,"teamId":"astonmartin","flag":"🇨🇦","pace":72,"consistency":70,"wet":73,"overtaking":68,"defense":72,"experience":72,"mental":6,"style":"defender","rivals":["alonso"],"goodTracks":["azerbaijan","bahrain","saudi"],"badTracks":["monaco","hungary","brazil"]},{"kind":"driver","id":"bearman","name":"Oliver Bearman","abbr":"BEA","num":87,"teamId":"haas","flag":"🇬🇧","pace":78,"consistency":76,"wet":74,"overtaking":76,"defense":74,"experience":58,"mental":7,"style":"aggressive","rivals":["ocon"],"goodTracks":["italy","britain","miami"],"badTracks":["monaco","singapore","japan"]},{"kind":"driver","id":"camara","name":"Rafael Camara","abbr":"CAM","num":null,"teamId":"haas","flag":"🇧🇷","pace":75,"consistency":73,"wet":72,"overtaking":74,"defense":71,"experience":35,"mental":6,"style":"charger","rivals":["bearman"],"goodTracks":["brazil"],"badTracks":[]},{"kind":"driver","id":"hulkenberg","name":"Nico Hülkenberg","abbr":"HUL","num":27,"teamId":"audi","flag":"🇩🇪","pace":80,"consistency":82,"wet":78,"overtaking":77,"defense":80,"experience":90,"mental":8,"style":"ironman","rivals":["bortoleto"],"goodTracks":["austria","spain","brazil"],"badTracks":["monaco","singapore","italy"]},{"kind":"driver","id":"bortoleto","name":"Gabriel Bortoleto","abbr":"BOR","num":5,"teamId":"audi","flag":"🇧🇷","pace":76,"consistency":74,"wet":73,"overtaking":75,"defense":72,"experience":52,"mental":6,"style":"charger","rivals":["hulkenberg"],"goodTracks":["brazil","spain","usa"],"badTracks":["monaco","singapore","azerbaijan"]},{"kind":"driver","id":"gasly","name":"Pierre Gasly","abbr":"GAS","num":10,"teamId":"alpine","flag":"🇫🇷","pace":79,"consistency":78,"wet":77,"overtaking":78,"defense":77,"experience":80,"mental":7,"style":"charger","rivals":["colapinto","ocon"],"goodTracks":["italy","bahrain","spain"],"badTracks":["monaco","singapore","hungary"]},{"kind":"driver","id":"colapinto","name":"Franco Colapinto","abbr":"COL","num":43,"teamId":"alpine","flag":"🇦🇷","pace":76,"consistency":74,"wet":74,"overtaking":75,"defense":73,"experience":55,"mental":7,"style":"aggressive","rivals":["gasly"],"goodTracks":["lasvegas","brazil","miami"],"badTracks":["monaco","singapore","japan"]},{"kind":"driver","id":"perez","name":"Sergio Pérez","abbr":"PER","num":11,"teamId":"cadillac","flag":"🇲🇽","pace":78,"consistency":77,"wet":76,"overtaking":76,"defense":78,"experience":88,"mental":6,"style":"strategist","rivals":["bottas"],"goodTracks":["azerbaijan","saudi","singapore"],"badTracks":["monaco","hungary","brazil"]},{"kind":"driver","id":"bottas","name":"Valtteri Bottas","abbr":"BOT","num":77,"teamId":"cadillac","flag":"🇫🇮","pace":74,"consistency":75,"wet":74,"overtaking":72,"defense":74,"experience":86,"mental":7,"style":"ironman","rivals":["perez"],"goodTracks":["austria","japan","spain"],"badTracks":["monaco","azerbaijan","lasvegas"]},{"id":"tp-mclaren","kind":"principal","name":"Andrea Stella","teamId":"mclaren"},{"id":"tp-ferrari","kind":"principal","name":"Fred Vasseur","teamId":"ferrari"},{"id":"tp-redbull","kind":"principal","name":"Laurent Mekies","teamId":"redbull"},{"id":"tp-mercedes","kind":"principal","name":"Toto Wolff","teamId":"mercedes"},{"id":"tp-williams","kind":"principal","name":"James Vowles","teamId":"williams"},{"id":"tp-racingbulls","kind":"principal","name":"Alan Permane","teamId":"racingbulls"},{"id":"tp-astonmartin","kind":"principal","name":"Adrian Newey","teamId":"astonmartin"},{"id":"tp-alpine","kind":"principal","name":"Steve Nielsen","teamId":"alpine"},{"id":"tp-haas","kind":"principal","name":"Ayao Komatsu","teamId":"haas"},{"id":"tp-audi","kind":"principal","name":"Mattia Binotto","teamId":"audi"},{"id":"tp-cadillac","kind":"principal","name":"Marcin Budkowski","teamId":"cadillac"}],"tracks":[{"round":1,"id":"australia","name":"Australian GP","circuit":"Albert Park","flag":"🇦🇺","laps":58,"od":45,"td":60,"wr":30,"type":"mixed","hasSprint":false,"drs":4,"alt":10,"temp":21,"abrasive":4,"street":false},{"round":2,"id":"china","name":"Chinese GP","circuit":"Shanghai Int'l","flag":"🇨🇳","laps":56,"od":40,"td":65,"wr":40,"type":"mixed","hasSprint":true,"drs":2,"alt":5,"temp":16,"abrasive":3,"street":false},{"round":3,"id":"japan","name":"Japanese GP","circuit":"Suzuka","flag":"🇯🇵","laps":53,"od":60,"td":55,"wr":50,"type":"high-speed","hasSprint":false,"drs":2,"alt":40,"temp":15,"abrasive":4,"street":false},{"round":4,"id":"bahrain","name":"Bahrain GP","circuit":"Bahrain Int'l","flag":"🇧🇭","laps":57,"od":40,"td":68,"wr":5,"type":"technical","hasSprint":false,"drs":3,"alt":7,"temp":30,"abrasive":7,"street":false},{"round":5,"id":"saudi","name":"Saudi Arabian GP","circuit":"Jeddah Corniche","flag":"🇸🇦","laps":50,"od":30,"td":58,"wr":5,"type":"street","hasSprint":false,"drs":3,"alt":10,"temp":28,"abrasive":2,"street":true},{"round":6,"id":"miami","name":"Miami GP","circuit":"Miami Int'l","flag":"🇺🇸","laps":57,"od":50,"td":70,"wr":35,"type":"street","hasSprint":true,"drs":3,"alt":2,"temp":28,"abrasive":3,"street":true},{"round":7,"id":"spain","name":"Spanish GP","circuit":"Circuit de Barcelona","flag":"🇪🇸","laps":66,"od":55,"td":72,"wr":25,"type":"high-downforce","hasSprint":false,"drs":2,"alt":110,"temp":24,"abrasive":4,"street":false},{"round":8,"id":"monaco","name":"Monaco GP","circuit":"Circuit de Monaco","flag":"🇲🇨","laps":78,"od":88,"td":40,"wr":30,"type":"street","hasSprint":false,"drs":1,"alt":15,"temp":20,"abrasive":2,"street":true},{"round":9,"id":"canada","name":"Canadian GP","circuit":"Gilles Villeneuve","flag":"🇨🇦","laps":70,"od":25,"td":68,"wr":45,"type":"street","hasSprint":false,"drs":2,"alt":12,"temp":22,"abrasive":2,"street":true},{"round":10,"id":"austria","name":"Austrian GP","circuit":"Red Bull Ring","flag":"🇦🇹","laps":71,"od":35,"td":55,"wr":40,"type":"high-speed","hasSprint":true,"drs":3,"alt":680,"temp":22,"abrasive":3,"street":false},{"round":11,"id":"britain","name":"British GP","circuit":"Silverstone","flag":"🇬🇧","laps":52,"od":40,"td":70,"wr":60,"type":"high-speed","hasSprint":false,"drs":2,"alt":126,"temp":18,"abrasive":4,"street":false},{"round":12,"id":"hungary","name":"Hungarian GP","circuit":"Hungaroring","flag":"🇭🇺","laps":70,"od":65,"td":55,"wr":40,"type":"technical","hasSprint":false,"drs":2,"alt":260,"temp":30,"abrasive":3,"street":false},{"round":13,"id":"belgium","name":"Belgian GP","circuit":"Spa-Francorchamps","flag":"🇧🇪","laps":44,"od":30,"td":60,"wr":70,"type":"high-speed","hasSprint":false,"drs":2,"alt":435,"temp":17,"abrasive":4,"street":false},{"round":14,"id":"netherlands","name":"Dutch GP","circuit":"Zandvoort","flag":"🇳🇱","laps":72,"od":65,"td":65,"wr":45,"type":"technical","hasSprint":false,"drs":2,"alt":5,"temp":18,"abrasive":5,"street":false},{"round":15,"id":"italy","name":"Italian GP","circuit":"Monza","flag":"🇮🇹","laps":53,"od":20,"td":45,"wr":30,"type":"low-downforce","hasSprint":false,"drs":2,"alt":162,"temp":24,"abrasive":3,"street":false},{"round":16,"id":"azerbaijan","name":"Azerbaijan GP","circuit":"Baku City Circuit","flag":"🇦🇿","laps":51,"od":22,"td":55,"wr":15,"type":"street","hasSprint":false,"drs":2,"alt":28,"temp":25,"abrasive":2,"street":true},{"round":17,"id":"singapore","name":"Singapore GP","circuit":"Marina Bay","flag":"🇸🇬","laps":61,"od":72,"td":70,"wr":50,"type":"street","hasSprint":false,"drs":3,"alt":15,"temp":32,"abrasive":3,"street":true},{"round":18,"id":"usa","name":"United States GP","circuit":"Circuit of the Americas","flag":"🇺🇸","laps":56,"od":40,"td":65,"wr":35,"type":"mixed","hasSprint":true,"drs":2,"alt":300,"temp":28,"abrasive":5,"street":false},{"round":19,"id":"mexico","name":"Mexican GP","circuit":"Autodromo HR","flag":"🇲🇽","laps":71,"od":45,"td":50,"wr":25,"type":"technical","hasSprint":false,"drs":3,"alt":2285,"temp":21,"abrasive":3,"street":false},{"round":20,"id":"brazil","name":"Brazilian GP","circuit":"Interlagos","flag":"🇧🇷","laps":71,"od":30,"td":60,"wr":65,"type":"mixed","hasSprint":true,"drs":2,"alt":785,"temp":26,"abrasive":4,"street":false},{"round":21,"id":"lasvegas","name":"Las Vegas GP","circuit":"Las Vegas Strip","flag":"🇺🇸","laps":50,"od":35,"td":55,"wr":10,"type":"street","hasSprint":false,"drs":3,"alt":640,"temp":12,"abrasive":2,"street":true},{"round":22,"id":"qatar","name":"Qatar GP","circuit":"Lusail Circuit","flag":"🇶🇦","laps":57,"od":45,"td":75,"wr":5,"type":"technical","hasSprint":true,"drs":2,"alt":15,"temp":30,"abrasive":8,"street":false},{"round":23,"id":"abudhabi","name":"Abu Dhabi GP","circuit":"Yas Marina","flag":"🇦🇪","laps":58,"od":45,"td":50,"wr":5,"type":"mixed","hasSprint":false,"drs":2,"alt":3,"temp":28,"abrasive":3,"street":false}]};
const F1_ROLE = { principal: 'Team principal', driver: 'Driver', engineer: 'Race engineer' };
/* A player's new driver starts here; Race Control tunes it on the ratings screen. */
const F1_ROOKIE = { pace: 80, consistency: 78, wet: 76, overtaking: 78, defense: 76, experience: 40, mental: 6, style: 'technical', goodTracks: [], badTracks: [], rivals: [] };
const F1_STYLES = [['charger', 'Charger'], ['aggressive', 'Aggressive'], ['qualifier', 'Qualifier'], ['technical', 'Technical'], ['smooth', 'Smooth'], ['defender', 'Defender'], ['strategist', 'Strategist'], ['ironman', 'Ironman']];
const F1_RATINGS = [['pace', 'Pace'], ['consistency', 'Consistency'], ['wet', 'Wet weather'], ['overtaking', 'Overtaking'], ['defense', 'Defence'], ['experience', 'Experience']];
const F1_WEATHER = [['track', 'The track’s usual rain risk'], ['dry', 'Dry'], ['mid', 'Rain mid-race'], ['wet', 'Wet start, drying']];

const F1 = {
  teams: () => list('f1_teams').sort((a, b) => (a.order || 0) - (b.order || 0)),
  team: id => get('f1_teams', id) || { id, name: id, color: '#888888' },
  person: id => get('f1_people', id),
  seats: teamId => list('f1_seats').filter(s => !teamId || s.teamId === teamId).sort((a, b) => (a.order || 0) - (b.order || 0)),
  tracks: () => list('f1_tracks').sort((a, b) => (a.round || 0) - (b.round || 0)),
  track: id => get('f1_tracks', id),
  weekends: () => list('f1_weekends').sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
  live: () => list('f1_weekends').find(w => w.status !== 'finished') || null
};
const f1PcId = charId => 'pc-' + charId;
/* Typed fields store their value without redrawing the page. The app redraws on every
   change event, and a redraw between pressing and releasing a button swallows the click. */
document.addEventListener('input', e => {
  const el = e.target, path = el && el.dataset && el.dataset.f1bind; if (!path) return;
  setPath(path, el.dataset.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value);
});
const f1Colour = teamId => (F1.team(teamId).color || '#888888');

/* Who sits in a seat now: a character overrides the real default. */
function f1Occupant(seat) {
  const real = seat.defaultPersonId ? F1.person(seat.defaultPersonId) : null;
  if (seat.holderCharId) {
    const person = F1.person(f1PcId(seat.holderCharId));
    return { player: true, charId: seat.holderCharId, person, name: (person && person.name) || seat.holderName || 'A character', real };
  }
  return { player: false, person: real, name: real ? real.name : (seat.role === 'engineer' ? 'Team engineer' : 'Vacant'), real };
}
const f1MySeats = () => S.charId ? F1.seats().filter(s => s.holderCharId === S.charId) : [];
function f1Code(name) { const parts = String(name || '').trim().split(/\s+/); return (parts[parts.length - 1] || 'DRV').normalize('NFD').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X'); }

/* ---------------------------------------------------------------- loading today's grid */
async function f1PutAll(rows) {
  for (let i = 0; i < rows.length; i += 10) await Promise.all(rows.slice(i, i + 10).map(([c, id, d]) => Data.put(c, id, d)));
}
ACTIONS['f1-load'] = () => askConfirm('Load today’s grid: 11 teams, their drivers and team principals, and 23 circuits? Teams, ratings and circuits go back to today’s values; seats players hold are kept.', 'Load the grid', async () => {
  await run(async () => {
    const rows = [];
    F1_DEFAULTS.teams.forEach(t => rows.push(['f1_teams', t.id, Object.assign({}, t)]));
    F1_DEFAULTS.people.forEach(p => rows.push(['f1_people', p.id, Object.assign({}, p)]));
    F1_DEFAULTS.tracks.forEach(t => rows.push(['f1_tracks', t.id, Object.assign({}, t)]));
    F1_DEFAULTS.teams.forEach((t, ti) => {
      const drivers = F1_DEFAULTS.people.filter(p => p.kind === 'driver' && p.teamId === t.id);
      const seat = (key, role, car, order, def) => {
        const id = `${t.id}-${key}`, old = (S.store.f1_seats || {})[id] || {};
        rows.push(['f1_seats', id, { teamId: t.id, role, car, order: ti * 10 + order, defaultPersonId: def || null,
          holderCharId: old.holderCharId || null, holderName: old.holderName || null, holderSince: old.holderSince || null, open: !!old.open }]);
      };
      seat('tp', 'principal', null, 0, 'tp-' + t.id);
      seat('d1', 'driver', 1, 1, drivers[0] && drivers[0].id); seat('e1', 'engineer', 1, 2, null);
      seat('d2', 'driver', 2, 3, drivers[1] && drivers[1].id); seat('e2', 'engineer', 2, 4, null);
    });
    await f1PutAll(rows);
    await Data.audit('f1.grid-load', 'Loaded today’s grid');
  }, 'Today’s grid is loaded.');
});

/* ---------------------------------------------------------------- seats */
/* Put a character into a seat (or hand it back with charId = null). One seat per character. */
async function f1Assign(seatId, charId) {
  const seat = get('f1_seats', seatId); if (!seat) throw { message: 'That seat no longer exists' };
  const team = F1.team(seat.teamId), roleName = F1_ROLE[seat.role] || seat.role;
  const empty = { holderCharId: null, holderName: null, holderSince: null };
  if (!charId) {
    await Data.put('f1_seats', seatId, Object.assign(clone(S.store.f1_seats[seatId]), empty));
    await Data.audit('seat.release', `${roleName}, ${team.name}: seat handed back to ${(f1Occupant(Object.assign({}, seat, empty)).name)}`);
    return;
  }
  const c = get('characters', charId); if (!c) throw { message: 'That character no longer exists' };
  for (const other of F1.seats().filter(s => s.holderCharId === charId && s.id !== seatId))
    await Data.put('f1_seats', other.id, Object.assign(clone(S.store.f1_seats[other.id]), empty));
  const pid = f1PcId(charId), cur = F1.person(pid);
  const person = Object.assign({}, F1_ROOKIE, cur ? clone(S.store.f1_people[pid]) : {}, {
    kind: seat.role, charId, teamId: seat.teamId, name: c.name,
    abbr: (cur && cur.abbr) || c.code || f1Code(c.name), flag: (cur && cur.flag) || '', num: (cur && cur.num) || c.number || null });
  await Data.put('f1_people', pid, person);
  await Data.put('f1_seats', seatId, Object.assign(clone(S.store.f1_seats[seatId]), { holderCharId: charId, holderName: c.name, holderSince: nowIso(), open: false }));
  for (const a of list('f1_applications').filter(x => x.seatId === seatId && x.status === 'pending' && x.charId !== charId))
    await Data.put('f1_applications', a.id, Object.assign(clone(S.store.f1_applications[a.id]), { status: 'declined', decidedAt: nowIso(), reply: 'The seat went to someone else.' }));
  await Data.audit('seat.take', `${c.name} takes the ${roleName.toLowerCase()} seat at ${team.name}`);
}
CHANGES['f1-seat'] = (v, ds) => run(() => f1Assign(ds.id, v || null), v ? 'Seat filled. The character now replaces the real default.' : 'Seat handed back to the real default.');
ACTIONS['seat-open'] = d => { const s = get('f1_seats', d.id); if (!s) return;
  run(async () => { await Data.put('f1_seats', s.id, Object.assign(clone(S.store.f1_seats[s.id]), { open: !s.open })); }, s.open ? 'Seat closed to applications.' : 'Seat open for applications.'); };

/* ---------------------------------------------------------------- applying for a seat */
const seatTitle = s => s.role === 'principal' ? 'Team principal' : s.role === 'driver' ? `Driver, car ${s.car}` : `Race engineer, car ${s.car}`;
const ROLE_FOR_SEAT = { principal: ['principal'], driver: ['driver'], engineer: ['engineer'] };
ACTIONS['seat-apply'] = d => {
  const c = currentChar(); if (!c) { toast('Create a character first, on Your characters.', true); return; }
  S.ui.form.app = { seatId: d.id, note: '' }; openDrawer('apply');
};
DRAWERS.apply = function () {
  const f = S.ui.form.app || {}, s = get('f1_seats', f.seatId), c = currentChar(); if (!s || !c) return '';
  const t = F1.team(s.teamId), o = f1Occupant(s);
  return `<header><div><h2>Apply for ${esc(seatTitle(s).toLowerCase())} at ${esc(t.name)}</h2><p>${esc(c.name)} applies. ${o.real ? `If Race Control says yes, ${esc(c.name)} takes the seat in place of ${esc(o.real.name)}.` : ''}</p></div>
    <button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><label class="field">Why ${esc(c.name.split(' ')[0])}, and why this team?<textarea id="app-note" rows="7" data-bind="ui/form/app/note" placeholder="Their pitch to the team: results, ambitions, what they bring"></textarea></label>
    <div class="btn-row"><button class="btn primary" data-act="seat-apply-send">Send application</button></div></div>`;
};
ACTIONS['seat-apply-send'] = () => {
  const f = S.ui.form.app || {}, c = currentChar(), s = get('f1_seats', f.seatId); if (!c || !s) return;
  if (list('f1_applications').some(a => a.charId === c.id && a.seatId === s.id && a.status === 'pending')) { toast(`${c.name} has already applied for this seat.`, true); return; }
  run(async () => {
    await Data.put('f1_applications', newId('app'), { userId: S.uid, charId: c.id, charName: c.name, seatId: s.id, teamId: s.teamId, role: s.role, note: String(f.note || '').trim(), status: 'pending', createdAt: nowIso() });
    closeDrawer();
  }, 'Application sent to Race Control.');
};
ACTIONS['app-withdraw'] = d => run(async () => { await Data.remove('f1_applications', d.id); }, 'Application withdrawn.');
ACTIONS['app-decide'] = d => {
  const a = get('f1_applications', d.id); if (!a) return;
  if (d.ok === '1') askConfirm(`Give ${a.charName} the seat? Whoever holds it now hands it back.`, 'Give them the seat', () => run(async () => {
    await f1Assign(a.seatId, a.charId);
    await Data.put('f1_applications', a.id, Object.assign(clone(S.store.f1_applications[a.id]), { status: 'approved', decidedAt: nowIso() }));
  }, `${a.charName} has the seat.`));
  else run(async () => { await Data.put('f1_applications', a.id, Object.assign(clone(S.store.f1_applications[a.id]), { status: 'declined', decidedAt: nowIso() })); }, 'Application declined.');
};

/* ---------------------------------------------------------------- ratings */
ACTIONS['f1-person'] = d => {
  const p = F1.person(d.id); if (!p) return;
  S.ui.form.f1p = Object.assign({}, F1_ROOKIE, clone(S.store.f1_people[d.id]), { id: d.id });
  openDrawer('f1-person', { id: d.id });
};
DRAWERS['f1-person'] = function (d) {
  const f = S.ui.form.f1p || {}, num = (k, label, min, max) => `<label class="field">${label}<input id="f1p-${k}" type="number" min="${min}" max="${max}" step="1" data-bind="ui/form/f1p/${k}" data-type="number" value="${esc(f[k] == null ? '' : f[k])}"></label>`;
  return `<header><div><h2>${esc(f.name || '')}</h2><p>${f.charId ? 'A player’s character. ' : 'A real driver. '}Ratings run from 1 to 99; mental strength from 1 to 10.</p></div>
      <button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body">
      <div class="f1-ratings">
        <label class="field">Name<input id="f1p-name" type="text" data-bind="ui/form/f1p/name" value="${esc(f.name || '')}"></label>
        <label class="field">Three-letter code<input id="f1p-abbr" type="text" maxlength="3" data-bind="ui/form/f1p/abbr" value="${esc(f.abbr || '')}"></label>
        ${num('num', 'Car number', 1, 99)}
        <label class="field">Driving style<select id="f1p-style" data-bind="ui/form/f1p/style">${F1_STYLES.map(([k, l]) => `<option value="${k}" ${f.style === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${F1_RATINGS.map(([k, l]) => num(k, l, 1, 99)).join('')}
        ${num('mental', 'Mental strength', 1, 10)}
      </div>
      <p class="muted small" style="margin-top:12px">Overtaking and defence decide wheel-to-wheel fights; experience and mental strength cut mistakes under pressure; the style nudges tyre wear, set-up and aggression.</p>
      <div class="btn-row" style="margin-top:12px"><button class="btn primary" data-act="f1-person-save">Save ratings</button></div>
    </div>`;
};
ACTIONS['f1-person-save'] = () => {
  const f = clone(S.ui.form.f1p || {}); if (!f.id) return;
  const id = f.id; delete f.id;
  const bad = F1_RATINGS.map(r => r[0]).find(k => !(f[k] >= 1 && f[k] <= 99));
  if (bad) { toast(`${F1_RATINGS.find(r => r[0] === bad)[1]} must be between 1 and 99.`, true); return; }
  if (!(f.mental >= 1 && f.mental <= 10)) { toast('Mental strength must be between 1 and 10.', true); return; }
  f.abbr = String(f.abbr || f1Code(f.name)).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  run(async () => { await Data.put('f1_people', id, f); await Data.audit('f1.ratings', `Ratings updated for ${f.name}`); closeDrawer(); }, 'Ratings saved.');
};

/* ---------------------------------------------------------------- The Grid */
function f1OccupantHtml(seat) {
  const o = f1Occupant(seat), you = S.charId && seat.holderCharId === S.charId;
  const p = o.person, driver = seat.role === 'driver';
  let sub = '';
  if (o.player && o.real) sub = `<span class="muted small">In place of ${esc(o.real.name)}</span>`;
  else if (driver && p) sub = `<span class="muted small">${p.num ? '#' + esc(p.num) + ' ' : ''}${esc(p.abbr || '')}, pace ${esc(p.pace)}</span>`;
  const chips = (o.player ? '<span class="tag player">Player</span>' : (p ? '<span class="tag">Real</span>' : '')) + (you ? ' <span class="tag you">You</span>' : '');
  return `<div class="f1-occ"><b>${p && p.flag ? esc(p.flag) + ' ' : ''}${esc(o.name)}</b> ${chips}${sub}</div>`;
}
function f1SeatControls(seat) {
  const c = currentChar(), mineOpen = list('f1_applications').find(a => c && a.charId === c.id && a.seatId === seat.id && a.status === 'pending');
  if (!S.isGm) {
    if (!seat.open || seat.holderCharId === S.charId) return '';
    if (mineOpen) return `<div class="ctl"><span class="tag">Applied</span><button class="btn small" data-act="app-withdraw" data-id="${esc(mineOpen.id)}">Withdraw</button></div>`;
    return `<div class="ctl"><span class="tag open">Open seat</span>${c ? `<button class="btn small primary" data-act="seat-apply" data-id="${esc(seat.id)}">Apply as ${esc(c.name.split(' ')[0])}</button>` : ''}</div>`;
  }
  const o = f1Occupant(seat), held = new Map(F1.seats().filter(s => s.holderCharId).map(s => [s.holderCharId, s]));
  const chars = list('characters').filter(x => !x.retired).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const def = o.real ? `${o.real.name} (real)` : 'No player';
  const opts = chars.map(x => { const h = held.get(x.id), note = h && h.id !== seat.id ? `, now ${F1_ROLE[h.role].toLowerCase()} at ${F1.team(h.teamId).name}` : '';
    return `<option value="${esc(x.id)}" ${seat.holderCharId === x.id ? 'selected' : ''}>${esc(x.name + ' (' + charRoleName(x.role).toLowerCase() + note + ')')}</option>`; }).join('');
  const apps = list('f1_applications').filter(a => a.seatId === seat.id && a.status === 'pending').length;
  const ratings = seat.role === 'driver' && o.person ? `<button class="btn small" data-act="f1-person" data-id="${esc(o.person.id)}">Ratings</button>` : '';
  return `<div class="ctl"><label class="sr-only" for="f1s-${esc(seat.id)}">Who sits in the ${esc(F1_ROLE[seat.role].toLowerCase())} seat at ${esc(F1.team(seat.teamId).name)}</label>
    <select id="f1s-${esc(seat.id)}" data-change="f1-seat" data-id="${esc(seat.id)}"><option value="">${esc(def)}</option>${opts}</select>${ratings}
    <button class="btn small ${seat.open ? 'on' : ''}" data-act="seat-open" data-id="${esc(seat.id)}" aria-pressed="${!!seat.open}">${seat.open ? 'Open to applications' : 'Open it'}</button>
    ${apps ? `<button class="btn small" data-act="nav" data-route="control">${plural(apps, 'application')}</button>` : ''}</div>`;
}
function f1TeamCard(t) {
  const arch = FormulaRacingAdapter.ARCHETYPES[t.strategy] || FormulaRacingAdapter.ARCHETYPES.reactive;
  return `<section class="card f1-team" style="--team:${esc(t.color)}" aria-label="${esc(t.name)}">
    <header><h2>${esc(t.name)}</h2><span class="meta">${esc(t.powerUnit || '')} power unit. AI strategist: ${esc(arch.label.toLowerCase())}.</span>
      ${S.isGm ? `<button class="btn small ghost" data-act="car-edit" data-id="${esc(t.id)}">Car</button>` : ''}</header>
    <ul class="f1-seatlist">${F1.seats(t.id).map(s => `<li><span class="role">${esc(seatTitle(s))}</span>${f1OccupantHtml(s)}${f1SeatControls(s)}</li>`).join('')}</ul>
  </section>`;
}
route('grid', 'The Grid', function () {
  const teams = F1.teams();
  const head = `<div class="page-head"><div><h1>The Grid</h1>
    <p>Today’s real grid is the starting point. When a player’s character takes a seat, they race in place of the real driver, or run the team in place of the real team principal, until the seat is handed back.</p></div></div>`;
  if (!teams.length) return head + `<div class="card empty-card"><h2>No grid yet</h2>${S.isGm ? `<p>Load today’s grid to start: 11 teams with their real drivers and team principals, plus 23 circuits. Then put characters into seats, or open seats for players to apply.</p>
    <button class="btn primary" data-act="f1-load">Load today’s grid</button>` : '<p>Race Control hasn’t set up the grid yet.</p>'}</div>`;
  const all = F1.seats(), mine = f1MySeats(), open = all.filter(s => s.open).length;
  const mineHtml = mine.length ? `<div class="card your-seat" style="--team:${esc(F1.team(mine[0].teamId).color)}"><h2>Your seat</h2>${mine.map(s => { const t = F1.team(s.teamId), o = f1Occupant(s);
      return `<p><b>${esc(seatTitle(s))}, ${esc(t.name)}</b>${o.real ? `, in place of ${esc(o.real.name)}` : ''}.</p>`; }).join('')}
      <p class="muted">Your pit wall is on Race Weekend whenever a weekend is open.</p></div>` : '';
  return head + mineHtml + `<div class="metrics"><div class="metric"><b>${teams.length}</b><span>Teams</span></div>
      <div class="metric"><b>${all.filter(s => s.holderCharId).length}</b><span>Seats held by players</span></div>
      <div class="metric"><b>${all.filter(s => s.role === 'driver' && !s.holderCharId).length}</b><span>Real drivers racing</span></div>
      <div class="metric"><b>${open}</b><span>Seats open to applications</span></div></div>
    ${!S.isGm && open ? `<p class="lead">Seats marked <span class="tag open">Open seat</span> take applications. Apply as the character you’re playing.</p>` : ''}
    <div class="f1-teams">${teams.map(f1TeamCard).join('')}</div>
    ${S.isGm ? `<p class="muted" style="margin-top:16px">Pick a character in any seat to put them there; pick the real person to hand it back. Open a seat to let players apply. <button class="btn small" data-act="f1-load">Reload today’s grid</button></p>` : ''}`;
});


/* ---------------------------------------------------------------- race weekends: building the field */
function f1Entrants() {
  const out = [], used = new Set();
  F1.teams().forEach(t => F1.seats(t.id).filter(s => s.role === 'driver').forEach(s => {
    const o = f1Occupant(s), p = o.person; if (!p) return;
    const base = String(p.abbr || f1Code(p.name)).toUpperCase().slice(0, 3);
    let code = base, n = 2; while (used.has(code)) code = base.slice(0, 2) + n++;
    used.add(code);
    out.push({ id: code, seatId: s.id, car: s.car, teamId: t.id, personId: p.id, charId: s.holderCharId || null, name: p.name,
      v3: Object.assign({}, F1_ROOKIE, p, { abbr: code, teamId: t.id }) });
  }));
  return out;
}
function f1Weather(w, track) {
  const L = track.laps, at = f => Math.max(2, Math.round(L * f));
  if (w.weatherMode === 'dry') return { start: 'dry' };
  if (w.weatherMode === 'mid') return { start: 'dry', changes: [{ lap: at(.35), to: 'damp' }, { lap: at(.41), to: 'wet' }, { lap: at(.55), to: 'damp' }, { lap: at(.63), to: 'dry' }] };
  if (w.weatherMode === 'wet') return { start: 'wet', qualifying: 'wet', changes: [{ lap: at(.18), to: 'damp' }, { lap: at(.34), to: 'dry' }] };
  return FormulaRacingAdapter.weatherFor(track, 'variable');
}
function f1NextTrack() {
  const done = new Set(F1.weekends().filter(w => w.status === 'finished' && w.session === 'gp').map(w => w.trackId));
  return F1.tracks().find(t => !done.has(t.id)) || F1.tracks()[0];
}

/* ---------------------------------------------------------------- pit-wall calls and who may make them */
function f1CallAllowed(c, w) {
  const ent = (w.entrants || f1Entrants()).find(e => e.id === c.carId), team = c.teamId || (ent && ent.teamId);
  const seats = F1.seats(team).filter(s => s.holderCharId && s.holderCharId === c.charId);
  if (!seats.length) return false;
  const tp = seats.some(s => s.role === 'principal');
  const own = role => !!ent && seats.some(s => s.role === role && s.car === ent.car);
  switch (c.type) {
    case 'order': return tp;
    case 'setup': return tp || own('engineer');
    case 'box': case 'mode': return tp || own('engineer') || own('driver');
    case 'refuseOrder': return own('driver');
    default: return false;
  }
}
const f1Calls = w => list('f1_calls').filter(c => c.weekendId === w.id).sort((a, b) => String(a.at).localeCompare(String(b.at)));
function f1CallText(c, w) {
  const ent = (w.entrants || []).find(e => e.id === c.carId), who = ent ? ent.id : F1.team(c.teamId).name;
  if (c.type === 'box') return `${who}: box for ${c.value === 'auto' ? 'the best tyre' : RaceEngine.COMPOUNDS[c.value].label.toLowerCase() + 's'}`;
  if (c.type === 'mode') return `${who}: ${RaceEngine.MODES[c.value].label.toLowerCase()} mode`;
  if (c.type === 'order') return `${who}: team order, ${c.value === 'none' ? 'free to race' : c.value === 'hold' ? 'hold positions' : 'swap the cars'}`;
  if (c.type === 'refuseOrder') return `${who}: refuses the team order`;
  if (c.type === 'setup') return `${who}: set-up ${c.value}`;
  return who;
}
function f1SendCall(call) {
  const w = F1.live(); if (!w || !S.charId) return;
  const doc = Object.assign({ weekendId: w.id, userId: S.uid, charId: S.charId, at: nowIso(), lap: (w.state && w.state.lap) || 0 }, call);
  if (!f1CallAllowed(doc, w)) { toast('Your seat doesn’t allow that call.', true); return; }
  /* A newer call of the same kind for the same car replaces the older one. */
  const old = f1Calls(w).filter(c => c.charId === S.charId && c.type === doc.type && c.carId === doc.carId && c.teamId === doc.teamId);
  run(async () => { for (const o of old) await Data.remove('f1_calls', o.id); await Data.put('f1_calls', newId('f1c'), doc); },
    doc.type === 'setup' ? 'Set-up sent to Race Control.' : 'Call sent. It applies from the next lap.');
}
ACTIONS['f1-call'] = d => f1SendCall({ type: d.type, carId: d.car || null, teamId: d.team || null, value: d.value || null });
ACTIONS['f1-call-setup'] = d => { const v = Number((S.ui.form.f1setup || {})[d.car] || 60); f1SendCall({ type: 'setup', carId: d.car, value: Math.max(20, Math.min(95, v)) }); };
ACTIONS['f1-call-withdraw'] = d => run(async () => { await Data.remove('f1_calls', d.id); }, 'Call withdrawn.');

/* ---------------------------------------------------------------- Race Control: running the weekend */
ACTIONS['f1-open'] = () => {
  const f = S.ui.form.f1w || {}, track = F1.track(f.trackId) || f1NextTrack();
  if (!track) { toast('Load the grid first.', true); return; }
  if (F1.live()) { toast('A weekend is already open. Finish or cancel it first.', true); return; }
  const session = f.session === 'sprint' && track.hasSprint ? 'sprint' : 'gp', id = newId('f1w');
  const seed = Math.max(1, parseInt(f.seed, 10) || (1 + Math.floor(Math.random() * 999999)));
  run(async () => {
    await Data.put('f1_weekends', id, { trackId: track.id, round: track.round, session, seed, weatherMode: f.weatherMode || 'track', status: 'practice', createdAt: nowIso() });
    await Data.audit('f1.weekend-open', `${track.name}${session === 'sprint' ? ' sprint' : ''} opened`);
    S.ui.form.f1w = null; S.ui.f1view = null;
  }, 'Weekend open. Teams can send their set-ups.');
};
ACTIONS['f1-cancel'] = () => { const w = F1.live(); if (!w) return;
  askConfirm('Cancel this weekend? The session and any calls are deleted and nothing counts towards the championship.', 'Cancel the weekend', () => run(async () => {
    for (const c of f1Calls(w)) await Data.remove('f1_calls', c.id);
    await Data.remove('f1_weekends', w.id); await Data.audit('f1.weekend-cancel', 'Weekend cancelled');
  }, 'Weekend cancelled.'), true); };

ACTIONS['f1-quali'] = () => {
  const w = F1.live(); if (!w || w.status !== 'practice') return;
  const track = F1.track(w.trackId), entrants = f1Entrants();
  if (entrants.length < 2) { toast('The grid needs at least two drivers.', true); return; }
  const setup = {}, used = [];
  f1Calls(w).forEach(c => { if (c.type === 'setup' && f1CallAllowed(c, w)) { setup[c.carId] = Number(c.value); used.push(c); } });
  const circuit = FormulaRacingAdapter.toCircuit(track), weather = f1Weather(w, track);
  const entries = FormulaRacingAdapter.toEntries(entrants.map(e => e.v3), F1.teams(), track, { setup });
  const quali = RaceEngine.qualify({ circuit, entries, weather, seed: w.seed });
  const state = RaceEngine.createRace({ circuit, entries, grid: quali.grid, weather, seed: w.seed, sprint: w.session === 'sprint' });
  const ents = entrants.map(e => { const o = Object.assign({}, e); delete o.v3; return o; });
  const doc = Object.assign(clone(S.store.f1_weekends[w.id]), { status: 'grid', entrants: ents, setup, weather, quali: { grid: quali.grid, results: quali.results, log: quali.log }, state });
  run(async () => {
    await Data.put('f1_weekends', w.id, doc);
    for (const c of f1Calls(w)) await Data.remove('f1_calls', c.id);
    await Data.audit('f1.qualifying', `Qualifying: ${quali.log[quali.log.length - 1].text}`);
  }, 'Qualifying done. The grid is set.');
};

async function f1Advance(laps) {
  const w = F1.live(); if (!w || !w.state || w.state.finished) return;
  const calls = f1Calls(w), engineCalls = [], notes = [];
  calls.forEach(c => {
    if (c.type === 'setup' || !f1CallAllowed(c, w)) return;
    const ent = (w.entrants || []).find(e => e.id === c.carId);
    if (c.type === 'order') engineCalls.push({ team: c.teamId, type: 'order', value: c.value });
    else if (c.type === 'box') engineCalls.push({ entry: c.carId, type: 'box', compound: c.value });
    else engineCalls.push({ entry: c.carId, type: c.type, value: c.value });
    notes.push({ kind: 'call', ids: ent ? [ent.id] : [], text: 'Pit wall, ' + f1CallText(c, w) });
  });
  const stopSc = (S.ui.form.f1stopSc !== false);
  let st = w.state, log = [];
  for (let i = 0; i < laps && !st.finished; i++) {
    const out = RaceEngine.stepLap(st, i === 0 ? engineCalls : []);
    if (i === 0 && notes.length) { notes.forEach(n => { n.lap = out.state.lap; }); out.state.events = out.state.events.slice(0, out.state.events.length - out.log.length).concat(notes, out.log); }
    st = out.state; log = log.concat(out.log);
    if (stopSc && i < laps - 1 && out.log.some(l => (l.kind === 'sc' || l.kind === 'vsc') && /deployed/.test(l.text))) break;
  }
  const doc = Object.assign(clone(S.store.f1_weekends[w.id]), { status: st.finished ? 'finished' : 'running', state: st });
  if (st.finished) {
    const byId = new Map((w.entrants || []).map(e => [e.id, e]));
    doc.results = RaceEngine.classify(st).map(r => Object.assign({}, r, byId.get(r.id) || {}));
    doc.finishedAt = nowIso();
  }
  await run(async () => {
    await Data.put('f1_weekends', w.id, doc);
    for (const c of calls) await Data.remove('f1_calls', c.id);
    if (st.finished) await Data.audit('f1.result', (log.find(l => l.kind === 'finish') || {}).text || 'Race finished');
  }, st.finished ? 'Chequered flag. The result counts towards the championship.' : null);
}
ACTIONS['f1-step'] = d => f1Advance(Number(d.laps) || 1);
ACTIONS['f1-view'] = d => { S.ui.f1view = d.id || null; render(); };

/* ---------------------------------------------------------------- Race Weekend screen */
function f1TyreChip(c, age) {
  const k = RaceEngine.COMPOUNDS[c]; if (!k) return '';
  return `<span class="f1-tyre ${c}" title="${k.label}">${k.short}</span>${age != null ? `<span class="f1-age">${age}</span>` : ''}`;
}
function f1Fmt(t) { if (t == null || !isFinite(t)) return '–'; const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`; }
function f1Order(st) {
  const run_ = st.cars.filter(c => c.status === 'running').sort((a, b) => a.cum - b.cum);
  return run_.concat(st.cars.filter(c => c.status !== 'running').sort((a, b) => (b.retiredLap || 0) - (a.retiredLap || 0)));
}
function f1Ent(w, id) { return (w.entrants || []).find(e => e.id === id) || { id, name: id, teamId: '' }; }
function f1DriverCell(w, c) {
  const e = f1Ent(w, c.id), mine = S.charId && e.charId === S.charId;
  return `<span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span><b>${esc(c.id)}</b> <span class="muted small">${esc(e.name)}</span>${e.charId ? ' <span class="tag player">Player</span>' : ''}${mine ? ' <span class="tag you">You</span>' : ''}`;
}
function f1TowerHtml(w) {
  const st = w.state;
  if (st.lap === 0) {
    const q = new Map(w.quali.results.map(r => [r.id, r]));
    return `<table class="data"><thead><tr><th>P</th><th>Driver</th><th class="num">Q1</th><th class="num">Q2</th><th class="num">Q3</th><th>Tyre</th></tr></thead><tbody>${st.cars.map((c, i) => { const r = q.get(c.id) || { times: [] };
      return `<tr><td><b>${i + 1}</b></td><td>${f1DriverCell(w, c)}</td>${[0, 1, 2].map(k => `<td class="num">${r.times[k] == null || !isFinite(r.times[k]) ? '' : f1Fmt(r.times[k])}</td>`).join('')}<td>${f1TyreChip(c.tyre.compound)}</td></tr>`; }).join('')}</tbody></table>`;
  }
  const order = f1Order(st), lead = order[0], avg = lead.cum / Math.max(1, st.lap);
  return `<table class="data"><thead><tr><th>P</th><th>Driver</th><th class="num">Gap</th><th class="num">Int</th><th>Tyre</th><th class="num">Last lap</th><th class="num">Pits</th></tr></thead><tbody>${order.map((c, i) => {
    if (c.status !== 'running') return `<tr><td>–</td><td>${f1DriverCell(w, c)}</td><td colspan="5" class="muted">Out on lap ${c.retiredLap}: ${esc(c.dnf)}</td></tr>`;
    const gap = c.cum - lead.cum, down = Math.floor(gap / avg), moved = c.grid - (i + 1);
    return `<tr><td><b>${i + 1}</b> ${moved ? `<span class="${moved > 0 ? 'f1-up' : 'f1-down'}">${moved > 0 ? '▲' : '▼'}${Math.abs(moved)}</span>` : ''}</td><td>${f1DriverCell(w, c)}</td>
      <td class="num">${i === 0 ? 'Leader' : down >= 1 ? `+${down} lap${down > 1 ? 's' : ''}` : '+' + gap.toFixed(1)}</td><td class="num">${i === 0 ? '' : '+' + (c.cum - order[i - 1].cum).toFixed(1)}</td>
      <td>${f1TyreChip(c.tyre.compound, c.tyre.age)}</td><td class="num">${f1Fmt(c.lastLap)}</td><td class="num">${c.stops}</td></tr>`; }).join('')}</tbody></table>`;
}
function f1ChartHtml(w) {
  const st = w.state, rows = st.lap ? f1Order(st) : st.cars, L = st.laps, rowH = 19, left = 46, right = 12, top = 22, W = 1000, H = top + rows.length * rowH + 8;
  const x = lap => left + (lap - 1) / L * (W - left - right), cw = (W - left - right) / L;
  const col = { soft: 'var(--f1-soft)', medium: 'var(--f1-medium)', hard: 'var(--f1-hard)', inter: 'var(--f1-inter)', wet: 'var(--f1-wet)' };
  const sc = {}; let on = null;
  st.events.forEach(e => { if ((e.kind === 'sc' || e.kind === 'vsc') && /deployed/.test(e.text)) on = e.lap + 1; if ((e.kind === 'sc' || e.kind === 'vsc') && /ends/.test(e.text) && on) { for (let l = on; l <= e.lap; l++) sc[l] = 1; on = null; } });
  if (on) for (let l = on; l <= st.lap; l++) sc[l] = 1;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tyre stints for every car">`;
  Object.keys(sc).forEach(l => { s += `<rect x="${x(+l)}" y="${top - 6}" width="${cw}" height="${H - top}" fill="var(--f1-flag)" opacity=".28"/>`; });
  for (let l = 1; l <= L; l++) if (l === 1 || l % 10 === 0) s += `<text x="${x(l) + cw / 2}" y="12" font-size="11" text-anchor="middle" fill="var(--muted)" font-family="Rajdhani, Arial Narrow, sans-serif">${l}</text><line x1="${x(l)}" x2="${x(l)}" y1="${top - 6}" y2="${H}" stroke="var(--line)"/>`;
  rows.forEach((c, i) => {
    const y = top + i * rowH, e = f1Ent(w, c.id);
    s += `<text x="${left - 8}" y="${y + 12}" font-size="13" text-anchor="end" font-weight="700" fill="var(--text)" font-family="Rajdhani, Arial Narrow, sans-serif">${esc(c.id)}</text><rect x="${left - 5}" y="${y + 2}" width="3" height="${rowH - 6}" fill="${esc(f1Colour(e.teamId))}"/>`;
    c.stints.forEach(t => { const to = t.to || st.lap; if (to < t.from) return;
      s += `<rect x="${x(t.from)}" y="${y + 3}" width="${Math.max(1, (to - t.from + 1) * cw - 1.5)}" height="${rowH - 8}" rx="2" fill="${col[t.compound]}" stroke="${t.compound === 'hard' ? 'var(--f1-hard-edge)' : 'none'}"/>`; });
    if (c.status !== 'running') s += `<text x="${x(c.retiredLap) + cw + 4}" y="${y + 12}" font-size="12" fill="var(--bad)">Out</text>`;
  });
  if (st.lap && !st.finished) s += `<line x1="${x(st.lap) + cw}" x2="${x(st.lap) + cw}" y1="${top - 6}" y2="${H}" stroke="var(--text)" stroke-width="1.5"/>`;
  return `<div class="scroll-x f1-chart">${s}</svg></div><div class="f1-legend"><span><i style="background:var(--f1-soft)"></i>Soft</span><span><i style="background:var(--f1-medium)"></i>Medium</span><span><i style="background:var(--f1-hard);box-shadow:inset 0 0 0 1px var(--f1-hard-edge)"></i>Hard</span><span><i style="background:var(--f1-inter)"></i>Intermediate</span><span><i style="background:var(--f1-wet)"></i>Wet</span><span><i style="background:var(--f1-flag);opacity:.5"></i>Safety car laps</span></div>`;
}
function f1FeedHtml(w) {
  const ev = ((w.state && w.state.events) || []).slice().reverse().slice(0, 150);
  const q = ((w.quali && w.quali.log) || []).slice().reverse().map(l => Object.assign({ lap: 'Q' }, l));
  const all = ev.concat(w.state && w.state.lap ? [] : q);
  if (!all.length) return '<p class="muted small">Overtakes, pit stops, safety cars and retirements are logged here lap by lap.</p>';
  return `<ul class="f1-feed">${all.map(l => `<li class="${esc(l.kind)}"><span class="l">${l.lap === 'Q' ? 'Q' : 'L' + esc(l.lap)}</span><span class="t">${esc(l.text)}</span></li>`).join('')}</ul>`;
}
function f1ResultsHtml(w) {
  return `<table class="data"><thead><tr><th>Pos</th><th>Driver</th><th>Team</th><th class="num">Grid</th><th>Gap</th><th class="num">Stops</th><th class="num">Best lap</th><th class="num">Points</th></tr></thead><tbody>${(w.results || []).map(r =>
    `<tr><td><b>${r.position || 'DNF'}</b></td><td><span class="f1-bar" style="background:${esc(f1Colour(r.teamId))}"></span>${esc(r.name)}${r.charId ? ' <span class="tag player">Player</span>' : ''}</td><td>${esc(F1.team(r.teamId).name)}</td>
     <td class="num">${r.grid}</td><td>${r.position === 1 ? f1Fmt(r.time) : esc(r.gap || '')}</td><td class="num">${r.stops}</td><td class="num">${f1Fmt(r.best)}</td><td class="num">${r.points || ''}</td></tr>`).join('')}</tbody></table>`;
}

/* The current character's pit wall: only the controls their seat allows. */
function f1PitWallHtml(w) {
  const seats = f1MySeats(); if (!seats.length) return '';
  const teamIds = [...new Set(seats.map(s => s.teamId))];
  const st = w.state, mine = f1Calls(w).filter(c => c.charId === S.charId);
  let h = '';
  teamIds.forEach(tid => {
    const t = F1.team(tid), tp = seats.some(s => s.teamId === tid && s.role === 'principal');
    const cars = (w.entrants || f1Entrants()).filter(e => e.teamId === tid);
    cars.forEach(e => {
      const can = type => f1CallAllowed({ type, carId: e.id, teamId: null, charId: S.charId }, w);
      const car = st ? st.cars.find(c => c.id === e.id) : null;
      if (w.status === 'practice') {
        if (!can('setup')) return;
        const v = (S.ui.form.f1setup || {})[e.id] == null ? 60 : S.ui.form.f1setup[e.id];
        h += `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(e.name)}</h3>
          <label class="field">Set-up quality, from 20 to 95<input id="f1su-${esc(e.id)}" type="number" min="20" max="95" step="1" value="${esc(v)}" data-bind="ui/form/f1setup/${esc(e.id)}" data-type="number" style="max-width:120px"></label>
          <p class="muted small">Each point is worth about six thousandths of a second a lap, in qualifying and the race.</p>
          <div class="btn-row"><button class="btn primary" data-act="f1-call-setup" data-car="${esc(e.id)}">Send set-up</button></div></div>`;
        return;
      }
      if (!car || w.status === 'finished' || !st) return;
      if (car.status !== 'running') { h += `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(e.name)}</h3><p class="muted">Out: ${esc(car.dnf)}</p></div>`; return; }
      const life = RaceEngine.tyreLife(car.tyre.compound, car, st.circuit), wear = Math.min(100, Math.round(car.tyre.wear / life * 100)), pos = f1Order(st).indexOf(car) + 1;
      const pend = type => mine.find(c => c.type === type && c.carId === e.id);
      const pb = pend('box'), pm = pend('mode');
      h += `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(e.name)}</h3>
        <p class="muted small" style="margin:0">P${pos}, ${RaceEngine.COMPOUNDS[car.tyre.compound].label.toLowerCase()}s ${car.tyre.age} laps old, ${plural(car.stops, 'stop')}</p>
        <div class="f1-gauges"><div class="f1-gauge">Tyre wear ${wear}%<div class="track"><div class="fill ${wear >= 90 ? 'hot' : ''}" style="width:${wear}%"></div></div></div>
          <div class="f1-gauge">Battery ${Math.round(car.energy)}%<div class="track"><div class="fill" style="width:${car.energy}%"></div></div></div></div>
        ${can('mode') ? `<div class="f1-row"><span class="lbl">Mode</span>${['push', 'standard', 'manage'].map(m => `<button class="btn small" data-act="f1-call" data-type="mode" data-car="${esc(e.id)}" data-value="${m}" aria-pressed="${(pm ? pm.value : car.mode) === m}">${RaceEngine.MODES[m].label}</button>`).join('')}</div>` : ''}
        ${can('box') ? `<div class="f1-row"><span class="lbl">Box</span>${['soft', 'medium', 'hard', 'inter', 'wet'].map(k => `<button class="btn small" data-act="f1-call" data-type="box" data-car="${esc(e.id)}" data-value="${k}" aria-pressed="${!!(pb && pb.value === k)}">${f1TyreChip(k)} ${k === 'inter' ? 'Inter' : RaceEngine.COMPOUNDS[k].label}</button>`).join('')}</div>` : ''}
        ${can('refuseOrder') && st.orders[tid] ? `<div class="f1-row"><span class="lbl">Order</span><span class="small">The team says: ${st.orders[tid].value === 'hold' ? 'hold position' : 'swap the cars'}.</span><button class="btn small" data-act="f1-call" data-type="refuseOrder" data-car="${esc(e.id)}" aria-pressed="${!!pend('refuseOrder')}">Refuse the order</button></div>` : ''}
      </div>`;
    });
    if (tp && st && w.status === 'running') {
      const cur = st.orders[tid] ? st.orders[tid].value : 'none', po = mine.find(c => c.type === 'order' && c.teamId === tid), v = po ? po.value : cur;
      h += `<div class="f1-row" style="border-top:1px solid var(--line);padding-top:10px"><span class="lbl">Orders</span>${[['none', 'Free to race'], ['hold', 'Hold positions'], ['swap', 'Swap the cars']].map(([k, l]) => `<button class="btn small" data-act="f1-call" data-type="order" data-team="${esc(tid)}" data-value="${k}" aria-pressed="${v === k}">${l}</button>`).join('')}</div>`;
    }
  });
  if (!h) return '';
  const pendingList = mine.filter(c => c.type !== 'setup' || w.status === 'practice');
  return `<section class="card" style="margin-bottom:16px"><h2>Your pit wall <span class="sub">${seats.map(s => `${F1_ROLE[s.role]}, ${F1.team(s.teamId).name}`).join('; ')}</span></h2>${h}
    ${pendingList.length ? `<p class="small" style="margin-top:10px"><b>Waiting for Race Control:</b> ${pendingList.map(c => `${esc(f1CallText(c, w))} <button class="btn small" data-act="f1-call-withdraw" data-id="${esc(c.id)}">Withdraw</button>`).join(' ')}</p>` : ''}
    <p class="muted small">Calls apply when Race Control runs the next lap. Anything you don’t call, the team’s AI strategist decides.</p></section>`;
}

function f1OpenFormHtml() {
  const tracks = F1.tracks(); if (!tracks.length) return '';
  const f = S.ui.form.f1w = S.ui.form.f1w || { trackId: (f1NextTrack() || {}).id, session: 'gp', weatherMode: 'track', seed: '' };
  const t = F1.track(f.trackId) || tracks[0];
  return `<section class="card"><h2>Open the next weekend</h2>
    <div class="metrics" style="align-items:end">
      <label class="field">Circuit${sel('f1w-track', 'ui/form/f1w/trackId', f.trackId, tracks.map(x => [x.id, `Round ${x.round}: ${x.name}`]))}</label>
      <label class="field">Session${sel('f1w-session', 'ui/form/f1w/session', f.session, [['gp', 'Grand Prix']].concat(t.hasSprint ? [['sprint', 'Sprint']] : []))}</label>
      <label class="field">Weather${sel('f1w-weather', 'ui/form/f1w/weatherMode', f.weatherMode, F1_WEATHER)}</label>
      <label class="field">Seed (optional)<input id="f1w-seed" type="number" min="1" data-bind="ui/form/f1w/seed" value="${esc(f.seed || '')}" placeholder="Random"></label>
    </div>
    <p class="muted small">${esc(t.circuit)}: ${t.laps} laps, ${esc(String(t.type).replace('-', ' '))}, ${t.wr}% rain risk. The seed makes the weekend repeatable: the same seed and the same calls give the same race.</p>
    <div class="btn-row"><button class="btn primary" data-act="f1-open">Open the weekend</button></div></section>`;
}

route('weekend', 'Race Weekend', function () {
  const head = (k, t, p, right) => `<div class="page-head"><div>${k ? `<p class="eyebrow">${k}</p>` : ''}<h1>${t}</h1>${p ? `<p>${p}</p>` : ''}</div>${right || ''}</div>`;
  if (!F1.teams().length) return head('', 'Race Weekend', 'The grid isn’t set up yet.') + (S.isGm ? '<div class="card"><p>Load today’s grid on The Grid page first.</p><button class="btn primary" data-act="nav" data-route="grid">Go to The Grid</button></div>' : '');
  const past = F1.weekends().filter(w => w.status === 'finished');
  const view = S.ui.f1view ? get('f1_weekends', S.ui.f1view) : null;
  const w = view || F1.live() || past[0] || null;
  const pastHtml = past.length ? `<section class="card" style="margin-top:16px"><h2>Results so far</h2><table class="data"><thead><tr><th>Round</th><th>Session</th><th>Winner</th><th></th></tr></thead><tbody>${past.map(x => { const t = F1.track(x.trackId) || {}, win = (x.results || [])[0] || {};
      return `<tr><td>${esc(t.round || '')} ${esc(t.name || x.trackId)}</td><td>${x.session === 'sprint' ? 'Sprint' : 'Grand Prix'}</td><td><span class="f1-bar" style="background:${esc(f1Colour(win.teamId))}"></span>${esc(win.name || '')}</td><td><button class="btn small" data-act="f1-view" data-id="${esc(x.id)}">View</button></td></tr>`; }).join('')}</tbody></table></section>` : '';
  if (!w) return head('', 'Race Weekend', S.isGm ? 'Open a weekend, let teams send their set-ups, run qualifying, then run the race lap by lap.' : 'No weekend is open. Race Control opens each one.') + (S.isGm ? f1OpenFormHtml() : '') + pastHtml;

  const t = F1.track(w.trackId) || { name: w.trackId, laps: 0 }, st = w.state, sprint = w.session === 'sprint';
  const laps = st ? st.laps : (sprint ? Math.ceil(t.laps / 3) : t.laps);
  const lapLbl = !st ? 'Practice' : st.finished ? 'Chequered flag' : st.lap === 0 ? 'Grid set' : 'Lap';
  const right = `<div class="f1-lap" aria-live="polite"><small>${lapLbl}</small>${st ? `${st.lap}<span class="of">/${laps}</span>` : '–'}</div>`;
  const track = st ? st.track[Math.max(0, st.lap - 1)] : 0;
  const chips = st ? `<p style="margin:6px 0 0"><span class="tag ${track === 2 ? 'wet' : track === 1 ? 'damp' : ''}">${['Dry', 'Damp', 'Wet'][track]} track</span>${st.sc.type ? ` <span class="tag flag">${st.sc.type === 'sc' ? 'Safety car' : 'Virtual safety car'}</span>` : ''}${st.fastest ? ` <span class="tag">Fastest lap ${esc(st.fastest.id)} ${f1Fmt(st.fastest.time)}</span>` : ''}</p>` : '';
  let h = head(`Round ${esc(t.round || '')}${sprint ? ', sprint' : ''}`, `${esc(t.flag || '')} ${esc(t.name)}${sprint ? ' Sprint' : ''}`,
    `${esc(t.circuit || '')}, ${laps} laps. ${w.status === 'practice' ? 'Practice: teams are sending set-ups.' : ''}${w.status === 'finished' ? 'Final result.' : ''}` + chips, right);
  if (view) h += `<div class="btn-row" style="margin-bottom:12px"><button class="btn" data-act="f1-view">Back to the current weekend</button></div>`;

  if (S.isGm && !view) {
    const calls = f1Calls(w), setups = calls.filter(c => c.type === 'setup').length, pending = calls.length - setups;
    if (w.status === 'practice') h += `<section class="card" style="margin-bottom:16px"><h2>Race Control</h2><p>${setups ? plural(setups, 'set-up') + ' received from the teams.' : 'No set-ups received yet; cars without one run a standard set-up.'}</p>
      <div class="btn-row"><button class="btn primary" data-act="f1-quali">Run qualifying</button><button class="btn" data-act="f1-cancel">Cancel the weekend</button></div></section>`;
    else if (w.status !== 'finished') h += `<section class="card" style="margin-bottom:16px"><h2>Race Control <span class="sub">${pending ? plural(pending, 'pit-wall call') + ' waiting' : 'No calls waiting'}</span></h2>
      <div class="btn-row" style="align-items:center"><button class="btn primary" data-act="f1-step" data-laps="1">${st.lap === 0 ? 'Start the race' : 'Next lap'}</button>
        <button class="btn" data-act="f1-step" data-laps="5">Run 5 laps</button><button class="btn" data-act="f1-step" data-laps="999">Run to the flag</button>
        <label class="small"><input type="checkbox" data-act="f1-stopsc" ${S.ui.form.f1stopSc !== false ? 'checked' : ''}> Stop when a safety car comes out</label>
        <button class="btn" data-act="f1-cancel">Cancel the weekend</button></div>
      <p class="muted small">Waiting calls apply on the next lap you run. Stopping at a safety car gives the teams time to call their stops.</p></section>`;
    else h += `<section class="card" style="margin-bottom:16px"><h2>Race Control</h2><p>This weekend is finished and counts towards the championship.</p>
      <div class="btn-row"><button class="btn" data-act="f1-discord" data-id="${esc(w.id)}">Post the result to Discord</button></div></section>` + f1OpenFormHtml();
  }
  if (!view && w.status !== 'finished') h += f1PitWallHtml(w);

  if (!st) {
    const ents = f1Entrants();
    h += `<section class="card"><h2>Entry list</h2><table class="data"><thead><tr><th>Car</th><th>Driver</th><th>Team</th></tr></thead><tbody>${ents.map(e => `<tr><td><b>${esc(e.id)}</b></td><td>${esc(e.name)}${e.charId ? ' <span class="tag player">Player</span>' : ''}</td><td><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span>${esc(F1.team(e.teamId).name)}</td></tr>`).join('')}</tbody></table>
      <p class="muted small">The entry list is fixed when qualifying runs, so seat changes after that apply from the next weekend.</p></section>`;
    return h + pastHtml;
  }
  if (w.status === 'finished') h += `<section class="card" style="margin-bottom:16px"><h2>Classification</h2><div class="scroll-x">${f1ResultsHtml(w)}</div></section>`;
  h += `<div class="f1-main"><section class="card"><h2>Timing</h2><div class="scroll-x">${f1TowerHtml(w)}</div></section>
    <section class="card"><h2>Race control</h2>${f1FeedHtml(w)}</section></div>
    <section class="card" style="margin-top:16px"><h2>Tyre strategy</h2>${f1ChartHtml(w)}</section>`;
  return h + (view ? '' : pastHtml);
});
ACTIONS['f1-stopsc'] = (d, el) => { S.ui.form.f1stopSc = !!el.checked; };

/* ---------------------------------------------------------------- Championship */
function f1Standings() {
  const drivers = new Map(), teams = new Map();
  F1.weekends().filter(w => w.status === 'finished').slice().reverse().forEach(w => (w.results || []).forEach(r => {
    const d = drivers.get(r.personId) || { personId: r.personId, name: r.name, teamId: r.teamId, charId: r.charId, pts: 0, wins: 0, podiums: 0, starts: 0, best: 99 };
    d.pts += r.points || 0; d.starts += 1; d.teamId = r.teamId; d.name = r.name;
    if (w.session !== 'sprint' && r.position) { if (r.position === 1) d.wins += 1; if (r.position <= 3) d.podiums += 1; d.best = Math.min(d.best, r.position); }
    drivers.set(r.personId, d);
    const t = teams.get(r.teamId) || { teamId: r.teamId, pts: 0, wins: 0 }; t.pts += r.points || 0; if (w.session !== 'sprint' && r.position === 1) t.wins += 1; teams.set(r.teamId, t);
  }));
  const order = (a, b) => b.pts - a.pts || b.wins - a.wins || (a.best || 99) - (b.best || 99);
  return { drivers: [...drivers.values()].sort(order), teams: [...teams.values()].sort(order) };
}
route('standings', 'Championship', function () {
  const s = f1Standings(), races = F1.weekends().filter(w => w.status === 'finished' && w.session === 'gp').length;
  const head = `<div class="page-head"><div><h1>Championship</h1><p>${races ? `After ${races} Grand Prix${races === 1 ? '' : ' weekends'}${F1.weekends().some(w => w.status === 'finished' && w.session === 'sprint') ? ' and the sprints' : ''}. Points go to whoever drove the car that weekend.` : 'No races yet. Standings appear after the first chequered flag.'}</p></div></div>`;
  if (!s.drivers.length) return head;
  return head + `<div class="cols2" style="align-items:start"><section class="card"><h2>Drivers</h2><div class="scroll-x"><table class="data"><thead><tr><th>Pos</th><th>Driver</th><th>Team</th><th class="num">Wins</th><th class="num">Podiums</th><th class="num">Points</th></tr></thead><tbody>${s.drivers.map((d, i) =>
      `<tr${S.charId && d.charId === S.charId ? ' class="me"' : ''}><td><b>${i + 1}</b></td><td>${esc(d.name)}${d.charId ? ' <span class="tag player">Player</span>' : ''}</td><td><span class="f1-bar" style="background:${esc(f1Colour(d.teamId))}"></span>${esc(F1.team(d.teamId).name)}</td><td class="num">${d.wins}</td><td class="num">${d.podiums}</td><td class="num"><b>${d.pts}</b></td></tr>`).join('')}</tbody></table></div></section>
    <section class="card"><h2>Constructors</h2><div class="scroll-x"><table class="data"><thead><tr><th>Pos</th><th>Team</th><th class="num">Wins</th><th class="num">Points</th></tr></thead><tbody>${s.teams.map((t, i) =>
      `<tr><td><b>${i + 1}</b></td><td><span class="f1-bar" style="background:${esc(f1Colour(t.teamId))}"></span>${esc(F1.team(t.teamId).name)}</td><td class="num">${t.wins}</td><td class="num"><b>${t.pts}</b></td></tr>`).join('')}</tbody></table></div></section></div>`;
});

/* =====================================================================
   F1 SIM — Home, Paddock, Race Control desk, accounts and backups.
   ===================================================================== */
'use strict';

const sel = (id, path, value, opts, empty) => `<select id="${id}" data-bind="${path}">${empty ? `<option value="">${esc(empty)}</option>` : ''}${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const paras = t => String(t || '').split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
function charSeat(charId) { return list('f1_seats').find(s => s.holderCharId === charId) || null; }
function charLine(c) {
  if (!c) return '';
  const s = charSeat(c.id), t = s ? F1.team(s.teamId) : null;
  return t ? `${seatTitle(s).toLowerCase()}, ${t.name}` : charRoleName(c.role).toLowerCase();
}

/* ---------------------------------------------------------------- car performance (Race Control) */
const CAR_FIELDS = [['carPace', 'Overall pace', 50, 99], ['topSpeed', 'Top speed (5 to 20)', 1, 25], ['cornering', 'Cornering (5 to 20)', 1, 25],
  ['reliability', 'Reliability', 40, 99], ['tyreLife', 'Kindness to tyres', 40, 99], ['pitSpeed', 'Pit crew speed', 50, 99]];
ACTIONS['car-edit'] = d => { const t = get('f1_teams', d.id); if (!t) return; S.ui.form.car = Object.assign(clone(S.store.f1_teams[d.id]), { id: d.id }); openDrawer('car'); };
DRAWERS.car = function () {
  const f = S.ui.form.car || {};
  const num = ([k, l, min, max]) => `<label class="field">${l}<input id="car-${k}" type="number" min="${min}" max="${max}" data-bind="ui/form/car/${k}" data-type="number" value="${esc(f[k] == null ? '' : f[k])}"></label>`;
  const arch = FormulaRacingAdapter.ARCHETYPES;
  return `<header><div><h2>${esc(f.name || '')}: the car</h2><p>These numbers decide the team’s pace and reliability in every session. Changes apply from the next qualifying.</p></div>
    <button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><div class="form-grid">
      <label class="field">Team name<input id="car-name" type="text" data-bind="ui/form/car/name" value="${esc(f.name || '')}"></label>
      <label class="field">Power unit<input id="car-pu" type="text" data-bind="ui/form/car/powerUnit" value="${esc(f.powerUnit || '')}"></label>
      <label class="field">Team colour<input id="car-color" type="color" data-bind="ui/form/car/color" value="${esc(f.color || '#888888')}"></label>
      <label class="field">AI strategist’s habit${sel('car-strategy', 'ui/form/car/strategy', f.strategy, Object.keys(arch).map(k => [k, arch[k].label]))}</label>
      ${CAR_FIELDS.map(num).join('')}
    </div>
    <div class="btn-row"><button class="btn primary" data-act="car-save">Save the car</button></div></div>`;
};
ACTIONS['car-save'] = () => {
  const f = clone(S.ui.form.car || {}), id = f.id; delete f.id; if (!id) return;
  const bad = CAR_FIELDS.find(([k, , min, max]) => !(f[k] >= min && f[k] <= max));
  if (bad) { toast(`${bad[1]} must be between ${bad[2]} and ${bad[3]}.`, true); return; }
  run(async () => { await Data.put('f1_teams', id, f); await Data.audit('car.update', `${f.name}: car performance updated`); closeDrawer(); }, 'Car saved.');
};

/* ---------------------------------------------------------------- Discord */
ACTIONS['f1-discord'] = d => {
  const w = get('f1_weekends', d.id); if (!w || !w.results) return;
  const t = F1.track(w.trackId) || { name: w.trackId }, win = w.results[0] || {};
  run(async () => {
    const api = await window.claude.use('discord');
    let channel = 'default';
    try { const ch = (await api.channels()).map(c => typeof c === 'string' ? c : c.name); channel = ch.indexOf('results') !== -1 ? 'results' : ch.indexOf('default') !== -1 ? 'default' : (ch[0] || 'default'); } catch (e) { throw e; }
    const lines = w.results.slice(0, 10).map(r => `**${r.position || 'DNF'}.** ${r.name}, ${F1.team(r.teamId).name}${r.points ? ` (${r.points} pts)` : ''}`);
    const fast = w.state && w.state.fastest ? (w.entrants || []).find(e => e.id === w.state.fastest.id) : null;
    await api.post({ channel, payload: { embeds: [{
      title: `${t.flag || ''} ${t.name}${w.session === 'sprint' ? ' Sprint' : ''}: result`.trim(),
      description: lines.join('\n') + (fast ? `\n\nFastest lap: ${fast.name}, ${f1Fmt(w.state.fastest.time)}` : ''),
      color: parseInt(String(f1Colour(win.teamId)).replace('#', ''), 16) || 0xE10600, footer: { text: 'F1 SIM' } }] } });
    await Data.audit('discord.result', `${t.name} result posted to Discord (${channel})`);
  }, 'Result posted to Discord.');
};

/* ---------------------------------------------------------------- Paddock: news, interviews and paddock life */
const POST_KINDS = [['news', 'News'], ['interview', 'Interview'], ['life', 'Paddock life']];
const postKind = k => (POST_KINDS.find(p => p[0] === k) || [k, k])[1];
ACTIONS['post-new'] = d => {
  const c = currentChar(); if (!c) { toast('Create a character first, on Your characters.', true); return; }
  S.ui.form.post = { kind: d.kind || (c.role === 'media' ? 'news' : 'life'), title: '', body: '', weekendId: '' }; openDrawer('post');
};
ACTIONS['post-edit'] = d => { const p = get('f1_posts', d.id); if (!p) return; S.ui.form.post = Object.assign(clone(S.store.f1_posts[d.id]), { id: d.id }); openDrawer('post'); };
DRAWERS.post = function () {
  const f = S.ui.form.post || {}, c = f.id ? get('characters', f.charId) : currentChar();
  const weekends = F1.weekends().filter(w => w.status !== 'practice').slice(0, 8);
  return `<header><div><h2>${f.id ? 'Edit post' : 'Write for the paddock'}</h2><p>Posting as ${esc(c ? c.name : 'your character')}${c ? ', ' + esc(charLine(c)) : ''}.</p></div>
    <button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><div class="form-grid">
      <label class="field">Kind of post${sel('post-kind', 'ui/form/post/kind', f.kind, POST_KINDS)}</label>
      <label class="field">About a race weekend (optional)${sel('post-weekend', 'ui/form/post/weekendId', f.weekendId || '', weekends.map(w => [w.id, ((F1.track(w.trackId) || {}).name || w.trackId) + (w.session === 'sprint' ? ' sprint' : '')]), 'None')}</label>
    </div>
    <label class="field">Headline<input id="post-title" type="text" data-bind="ui/form/post/title" value="${esc(f.title || '')}" placeholder="${f.kind === 'life' ? 'e.g. Rain delay, so the garage ordered pizza' : 'e.g. Hart holds off the champion in Interlagos'}"></label>
    <label class="field">${f.kind === 'interview' ? 'The interview' : 'The story'}<textarea id="post-body" rows="12" data-bind="ui/form/post/body" placeholder="Leave a blank line between paragraphs.">${esc(f.body || '')}</textarea></label>
    <p class="muted small">Interviews and quotes are for characters in this league. Real drivers and team principals appear in race results only.</p>
    <div class="btn-row"><button class="btn primary" data-act="post-save">${f.id ? 'Save changes' : 'Publish'}</button></div></div>`;
};
ACTIONS['post-save'] = () => {
  const f = clone(S.ui.form.post || {}), id = f.id || newId('post'); delete f.id;
  f.title = String(f.title || '').trim(); f.body = String(f.body || '').trim();
  if (!f.title || !f.body) { toast('Give the post a headline and some words.', true); return; }
  const prev = get('f1_posts', id), c = prev ? get('characters', prev.charId) : currentChar(); if (!c) return;
  const doc = Object.assign({}, prev ? clone(S.store.f1_posts[id]) : { createdAt: nowIso(), userId: S.uid, charId: c.id, charName: c.name }, f, prev ? { editedAt: nowIso() } : {});
  run(async () => { await Data.put('f1_posts', id, doc); closeDrawer(); }, prev ? 'Post updated.' : 'Published to the paddock.');
};
ACTIONS['post-delete'] = d => askConfirm('Delete this post? It can’t be brought back.', 'Delete', () => run(async () => { await Data.remove('f1_posts', d.id); }, 'Post deleted.'), true);
ACTIONS['paddock-filter'] = d => { S.ui.padKind = d.kind || ''; render(); };
function postCardHtml(p, short) {
  const c = get('characters', p.charId), s = c ? charSeat(c.id) : null, t = s ? F1.team(s.teamId) : null, w = p.weekendId ? get('f1_weekends', p.weekendId) : null;
  const mine = p.userId === S.uid, body = short && p.body.length > 320 ? p.body.slice(0, 320) + '…' : p.body;
  return `<article class="card post ${esc(p.kind)}" ${t ? `style="--team:${esc(t.color)}"` : ''}>
    <p class="post-meta"><span class="tag ${p.kind === 'life' ? 'life' : ''}">${esc(postKind(p.kind))}</span> ${esc((c && c.name) || p.charName || 'Someone')}${c ? ', ' + esc(charLine(c)) : ''}. ${esc(fmtWhen(p.createdAt))}${w ? `. ${esc((F1.track(w.trackId) || {}).name || '')}` : ''}</p>
    <h2>${esc(p.title)}</h2><div class="post-body">${paras(body)}</div>
    ${!short && (mine || S.isGm) ? `<div class="btn-row">${mine ? `<button class="btn small" data-act="post-edit" data-id="${esc(p.id)}">Edit</button>` : ''}<button class="btn small" data-act="post-delete" data-id="${esc(p.id)}">Delete</button></div>` : ''}
  </article>`;
}
/* Facts for the press: what happened at the latest race, straight from the race record. */
function pressFactsHtml() {
  const w = F1.weekends().find(x => x.status === 'finished'); if (!w) return '';
  const t = F1.track(w.trackId) || {}, r = w.results || [], players = r.filter(x => x.charId);
  const ev = (w.state && w.state.events) || [], dnf = r.filter(x => x.status === 'dnf'), sc = ev.filter(e => e.kind === 'sc' && /deployed/.test(e.text)).length;
  const gain = r.filter(x => x.position).map(x => ({ x, g: x.grid - x.position })).sort((a, b) => b.g - a.g)[0];
  return `<aside class="card facts"><h2>Press notes: ${esc(t.name || '')}${w.session === 'sprint' ? ' sprint' : ''}</h2><ul>
    ${r.slice(0, 3).map(x => `<li>P${x.position}: ${esc(x.name)}, ${esc(F1.team(x.teamId).name)}</li>`).join('')}
    ${gain && gain.g > 0 ? `<li>Biggest climb: ${esc(gain.x.name)}, ${gain.g} places from P${gain.x.grid}</li>` : ''}
    ${players.map(x => `<li>${esc(x.name)} (player): ${x.position ? 'P' + x.position : 'out, ' + esc(x.gap || '')}</li>`).join('')}
    <li>${plural(sc, 'safety car')}, ${plural(dnf.length, 'retirement')}</li></ul>
    <button class="btn small" data-act="f1-view" data-id="${esc(w.id)}" data-go="weekend">Full race record</button></aside>`;
}
ACTIONS['f1-view'] = d => { S.ui.f1view = d.id || null; if (d.go) go(d.go); else render(); };
route('paddock', 'Paddock', function () {
  const k = S.ui.padKind || '', posts = list('f1_posts').filter(p => !k || p.kind === k).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const c = currentChar();
  const tabs = [['', 'Everything']].concat(POST_KINDS).map(([v, l]) => `<button class="btn small" data-act="paddock-filter" data-kind="${v}" aria-pressed="${k === v}">${l}</button>`).join('');
  return `<div class="page-head"><div><h1>Paddock</h1><p>The league’s own press and its life off track: race reports and interviews from the media, and everyday stories from everyone else.</p></div>
      ${c ? `<div class="btn-row"><button class="btn primary" data-act="post-new">${icon('plus', 16)} Write as ${esc(c.name.split(' ')[0])}</button></div>` : ''}</div>
    <div class="paddock"><div><div class="btn-row filters" role="group" aria-label="Show">${tabs}</div>
      ${posts.length ? posts.map(p => postCardHtml(p)).join('') : `<div class="card empty-card"><h2>Nothing here yet</h2><p>${c ? 'Be the first: a race report, an interview with a team-mate, or a day in the life of the garage.' : 'Create a character to start writing.'}</p></div>`}</div>
      ${pressFactsHtml()}</div>`;
});

/* ---------------------------------------------------------------- Home */
route('home', 'Home', function () {
  const c = currentChar(), a = ACCOUNT();
  const teams = F1.teams();
  if (!teams.length) return `<div class="page-head"><div><h1>Welcome to the paddock</h1><p>${S.isGm ? 'Start by loading today’s grid.' : 'Race Control is setting up the grid.'}</p></div></div>
    ${S.isGm ? `<div class="card empty-card"><h2>Set up the league</h2><p>Load today’s grid: 11 teams, their real drivers and team principals, and 23 circuits. Players’ characters then take seats in place of the real people.</p><button class="btn primary" data-act="f1-load">Load today’s grid</button></div>` : ''}
    ${!c ? charPromptHtml() : ''}`;
  const live = F1.live(), last = F1.weekends().find(w => w.status === 'finished'), next = f1NextTrack();
  const seat = c ? charSeat(c.id) : null, team = seat ? F1.team(seat.teamId) : null;
  const apps = c ? list('f1_applications').filter(x => x.charId === c.id).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))) : [];
  const st = f1Standings(), posts = list('f1_posts').sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))).slice(0, 3);
  const liveTrack = live ? F1.track(live.trackId) : null;
  const weekendCard = live ? `<section class="card hero-race" style="--team:${esc(f1Colour((last && last.results && last.results[0] || {}).teamId))}">
      <p class="eyebrow">Round ${esc(liveTrack.round)}${live.session === 'sprint' ? ', sprint' : ''}</p><h2>${esc(liveTrack.flag || '')} ${esc(liveTrack.name)}</h2>
      <p>${live.status === 'practice' ? 'Practice: teams are sending set-ups.' : live.status === 'grid' ? 'Qualifying is done. The grid is set.' : `Lap ${live.state.lap} of ${live.state.laps}.`}</p>
      <button class="btn primary" data-act="nav" data-route="weekend">${seat ? 'Go to your pit wall' : 'Watch the timing'}</button></section>`
    : `<section class="card hero-race"><p class="eyebrow">Next up</p><h2>${next ? esc((next.flag || '') + ' ' + next.name) : 'No races yet'}</h2>
      <p>${next ? `Round ${next.round}, ${esc(next.circuit)}, ${next.laps} laps.` : ''} ${S.isGm ? 'Open the weekend when you’re ready.' : 'Race Control opens the weekend.'}</p>
      <button class="btn" data-act="nav" data-route="weekend">Race Weekend</button></section>`;
  const you = c ? `<section class="card" ${team ? `style="--team:${esc(team.color)}"` : ''}><h2>${esc(c.name)}</h2>
      <p>${seat ? `<b>${esc(seatTitle(seat))}, ${esc(team.name)}</b>${f1Occupant(seat).real ? `, in place of ${esc(f1Occupant(seat).real.name)}` : ''}.` : esc(charRoleName(c.role)) + ', without a seat.'}</p>
      ${apps.slice(0, 3).map(x => `<p class="small">Application for ${esc(seatTitle(get('f1_seats', x.seatId) || { role: x.role, car: '' }).toLowerCase())} at ${esc(F1.team(x.teamId).name)}: <b>${x.status === 'pending' ? 'waiting for Race Control' : x.status}</b></p>`).join('')}
      ${!seat && (c.role === 'driver' || c.role === 'principal' || c.role === 'engineer') ? '<button class="btn small" data-act="nav" data-route="grid">Find an open seat</button>' : ''}</section>` : charPromptHtml();
  const result = last ? `<section class="card"><h2>Latest result: ${esc((F1.track(last.trackId) || {}).name || '')}${last.session === 'sprint' ? ' sprint' : ''}</h2>
      <ol class="podium">${(last.results || []).slice(0, 3).map(r => `<li style="--team:${esc(f1Colour(r.teamId))}"><b>${esc(r.name)}</b><span>${esc(F1.team(r.teamId).name)}</span></li>`).join('')}</ol>
      <button class="btn small" data-act="f1-view" data-id="${esc(last.id)}" data-go="weekend">Full result</button></section>` : '';
  const table = st.drivers.length ? `<section class="card"><h2>Championship</h2><table class="data compact"><tbody>${st.drivers.slice(0, 5).map((d, i) =>
      `<tr${d.charId && d.charId === S.charId ? ' class="me"' : ''}><td>${i + 1}</td><td><span class="f1-bar" style="background:${esc(f1Colour(d.teamId))}"></span>${esc(d.name)}</td><td class="num"><b>${d.pts}</b></td></tr>`).join('')}</tbody></table>
      <button class="btn small" data-act="nav" data-route="standings">Full standings</button></section>` : '';
  return `<div class="page-head"><div><h1>${c ? 'Welcome back, ' + esc(c.name.split(' ')[0]) : 'Welcome' + (a ? ', ' + esc(a.username) : '')}</h1></div></div>
    <div class="home">${weekendCard}${you}${result}${table}
      ${posts.length ? `<section class="home-posts"><h2>From the paddock</h2>${posts.map(p => postCardHtml(p, true)).join('')}<button class="btn small" data-act="nav" data-route="paddock">More in Paddock</button></section>` : ''}</div>`;
});
function charPromptHtml() {
  return `<section class="card empty-card"><h2>Create your character</h2><p>A driver, team principal, race engineer, journalist, or someone living the paddock life. Race Control can put them into a seat, or they can apply for an open one.</p>
    <button class="btn primary" data-act="char-new">Create a character</button></section>`;
}

/* ---------------------------------------------------------------- Race Control desk */
route('control', 'Race Control', function () {
  const apps = list('f1_applications').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const pending = apps.filter(a => a.status === 'pending'), decided = apps.filter(a => a.status !== 'pending').slice(0, 10);
  const chars = list('characters').filter(c => !c.retired).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const audit = list('audit').sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 60);
  const appCard = a => { const s = get('f1_seats', a.seatId), c = get('characters', a.charId), o = s ? f1Occupant(s) : null, t = F1.team(a.teamId);
    return `<article class="card" style="--team:${esc(t.color)}"><h3>${esc(a.charName)} for ${esc(s ? seatTitle(s).toLowerCase() : a.role)} at ${esc(t.name)}</h3>
      <p class="muted small">Sent ${esc(fmtWhen(a.createdAt))}. ${o ? `The seat is held by ${esc(o.name)}${o.player ? ' (a player)' : ''}.` : ''}</p>
      ${a.note ? paras(a.note) : '<p class="muted">No note.</p>'}
      ${c && c.bio ? `<details><summary>About ${esc(c.name)}</summary>${paras(c.bio)}</details>` : ''}
      <div class="btn-row"><button class="btn primary" data-act="app-decide" data-id="${esc(a.id)}" data-ok="1">Give them the seat</button><button class="btn" data-act="app-decide" data-id="${esc(a.id)}" data-ok="0">Decline</button></div></article>`; };
  return `<div class="page-head"><div><h1>Race Control</h1><p>Seat applications, the people in the paddock, and a record of everything Race Control and the teams have done.</p></div></div>
    <section><h2 class="section-h">Seat applications ${pending.length ? `<span class="count">${pending.length}</span>` : ''}</h2>
      ${pending.length ? `<div class="cards">${pending.map(appCard).join('')}</div>` : '<p class="muted">No applications waiting. Open seats on The Grid to take applications.</p>'}
      ${decided.length ? `<details class="card"><summary>Recently decided</summary><table class="data"><tbody>${decided.map(a => `<tr><td>${esc(a.charName)}</td><td>${esc(F1.team(a.teamId).name)}</td><td>${esc(a.status)}</td><td>${esc(fmtDate(a.decidedAt))}</td></tr>`).join('')}</tbody></table></details>` : ''}</section>
    <section class="card"><h2>Characters</h2>${chars.length ? `<div class="scroll-x"><table class="data"><thead><tr><th>Name</th><th>What they do</th><th>Seat</th><th>Discord</th></tr></thead><tbody>${chars.map(c => { const s = charSeat(c.id);
        return `<tr><td><b>${esc(c.name)}</b>${c.code ? ` <span class="muted">${esc(c.code)}</span>` : ''}</td><td>${esc(charRoleName(c.role))}</td><td>${s ? esc(seatTitle(s) + ', ' + F1.team(s.teamId).name) : '<span class="muted">None</span>'}</td><td>${esc(c.discord || '')}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">No characters yet.</p>'}</section>
    <section class="card"><h2>Audit record</h2>${audit.length ? `<div class="scroll-x"><table class="data compact"><tbody>${audit.map(x => `<tr><td class="nowrap">${esc(fmtWhen(x.at))}</td><td>${esc(x.actor || '')}</td><td>${esc(x.summary || x.action)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing recorded yet.</p>'}</section>`;
}, { gm: true });

/* ---------------------------------------------------------------- Accounts and backups (Administrator) */
async function loadMembers() {
  const a = ACCOUNT(); if (!a || !a.listMembers) { S.ui.members = []; S.ui.membersErr = 'Accounts are managed in Supabase in this set-up.'; render(); return; }
  try { S.ui.members = await a.listMembers(); S.ui.membersErr = null; } catch (e) { S.ui.membersErr = e.message || 'Couldn’t load the accounts.'; }
  render();
}
CHANGES['member-role'] = (v, d) => run(async () => { await ACCOUNT().setRole(d.id, v, []); await Data.audit('account.role', `${d.name} is now ${v === 'mod' ? 'Race Control' : 'a player'}`); await loadMembers(); }, 'Role changed.');
ACTIONS['member-reset'] = d => { const p = String((S.ui.form.pw || {})[d.id] || ''); if (p.length < 8) { toast('Type a new password of at least 8 characters first.', true); return; }
  run(async () => { await ACCOUNT().resetPassword(d.id, p); S.ui.form.pw[d.id] = ''; await Data.audit('account.password', `Password reset for ${d.name}`); }, `Password reset. Give ${d.name} the new one privately.`); };
ACTIONS['member-delete'] = d => askConfirm(`Delete the account ${d.name}? Their characters stay in the league until you retire them.`, 'Delete the account', () => run(async () => { await ACCOUNT().deleteAccount(d.id); await Data.audit('account.delete', `Account ${d.name} deleted`); await loadMembers(); }, 'Account deleted.'), true);
ACTIONS['invite-set'] = () => run(async () => { await ACCOUNT().setInviteCode(String(S.ui.form.invite || '').trim()); S.ui.form.invite = ''; }, (S.ui.form.invite || '').trim() ? 'Invite code set. New accounts now need it.' : 'Invite code removed. Anyone with the link can sign up.');
ACTIONS['backup'] = () => {
  const out = { app: 'F1 SIM', exportedAt: nowIso(), collections: {} };
  COLLECTIONS.forEach(c => { out.collections[c] = clone(S.store[c] || {}); });
  const name = `f1-sim-backup-${new Date().toISOString().slice(0, 10)}.json`, data = JSON.stringify(out, null, 1);
  Promise.resolve(window.claude.use('downloads')).then(d => d.save({ filename: name, data })).catch(() => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); });
  toast('Backup downloaded. Keep it somewhere safe, not in the repository.');
};
CHANGES['restore'] = (v, d, el) => {
  const file = el.files && el.files[0]; if (!file) return;
  file.text().then(t => {
    let j; try { j = JSON.parse(t); } catch (e) { toast('That file isn’t a backup: it isn’t valid JSON.', true); return; }
    if (!j || j.app !== 'F1 SIM' || !j.collections) { toast('That file isn’t an F1 SIM backup.', true); return; }
    const rows = []; Object.keys(j.collections).filter(c => COLLECTIONS.indexOf(c) !== -1).forEach(c => Object.keys(j.collections[c]).forEach(id => rows.push({ collection: c, id, data: j.collections[c][id] })));
    askConfirm(`Restore ${plural(rows.length, 'record')} from ${fmtDate(j.exportedAt)}? Records with the same names are replaced; nothing else is deleted.`, 'Restore', () => run(async () => {
      const a = ACCOUNT();
      if (a && a.bulkPut) await a.bulkPut(rows); else for (const r of rows) await Data.put(r.collection, r.id, r.data);
      rows.forEach(r => { (S.store[r.collection] = S.store[r.collection] || {})[r.id] = r.data; });
      await Data.audit('backup.restore', `Restored ${rows.length} records from a backup`);
    }, 'Backup restored.'));
  });
  el.value = '';
};
route('admin', 'Accounts and backups', function () {
  if (S.ui.members === undefined) { S.ui.members = null; setTimeout(loadMembers, 0); }
  const ms = S.ui.members, pw = S.ui.form.pw = S.ui.form.pw || {};
  const rows = (ms || []).map(m => { const self = m.user_id === S.uid, name = m.username;
    return `<tr><td><b>${esc(name)}</b>${self ? ' <span class="tag you">You</span>' : ''}</td><td>${m.role === 'owner' ? 'Administrator' : self ? (m.role === 'mod' ? 'Race Control' : 'Player')
      : `<label class="sr-only" for="role-${esc(m.user_id)}">Role for ${esc(name)}</label><select id="role-${esc(m.user_id)}" data-change="member-role" data-id="${esc(m.user_id)}" data-name="${esc(name)}"><option value="player" ${m.role === 'player' ? 'selected' : ''}>Player</option><option value="mod" ${m.role === 'mod' || m.role === 'gm' ? 'selected' : ''}>Race Control</option></select>`}</td>
      <td>${list('characters').filter(c => c.userId === m.user_id && !c.retired).map(c => esc(c.name)).join(', ') || '<span class="muted">None</span>'}</td>
      <td class="nowrap">${esc(fmtDate(m.created_at))}</td>
      <td>${self || m.role === 'owner' ? '' : `<div class="btn-row"><label class="sr-only" for="pw-${esc(m.user_id)}">New password for ${esc(name)}</label><input id="pw-${esc(m.user_id)}" type="text" autocomplete="off" placeholder="New password" data-bind="ui/form/pw/${esc(m.user_id)}" value="${esc(pw[m.user_id] || '')}" style="max-width:160px">
        <button class="btn small" data-act="member-reset" data-id="${esc(m.user_id)}" data-name="${esc(name)}">Reset password</button><button class="btn small danger" data-act="member-delete" data-id="${esc(m.user_id)}" data-name="${esc(name)}">Delete</button></div>`}</td></tr>`; }).join('');
  return `<div class="page-head"><div><h1>Accounts and backups</h1><p>Who can sign in, who runs Race Control, and copies of the league’s records.</p></div></div>
    <section class="card"><h2>Accounts</h2>${S.ui.membersErr ? `<p class="bad-text">${esc(S.ui.membersErr)}</p>` : ms === null ? '<p class="muted">Loading the accounts…</p>'
      : `<div class="scroll-x"><table class="data"><thead><tr><th>Username</th><th>Role</th><th>Characters</th><th>Joined</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`}
      <p class="muted small">Race Control can run weekends, fill seats and tune cars. Only the Administrator changes roles.</p></section>
    <section class="card"><h2>Invite code</h2><p>With a code set, new accounts need it to sign up. Leave the box empty and save to let anyone with the link join.</p>
      <div class="btn-row"><label class="sr-only" for="invite">Invite code</label><input id="invite" type="text" autocomplete="off" placeholder="At least 6 characters" data-bind="ui/form/invite" value="${esc(S.ui.form.invite || '')}" style="max-width:260px"><button class="btn primary" data-act="invite-set">Save the invite code</button></div></section>
    <section class="card"><h2>Backups</h2><p>The free Supabase plan has no automatic backups. Download one every few race weekends.</p>
      <div class="btn-row"><button class="btn primary" data-act="backup">Download a backup</button>
        <label class="btn file-btn">Restore a backup<input type="file" accept="application/json,.json" data-change="restore" class="sr-only"></label></div></section>`;
}, { gm: true, owner: true });

/* start-up: every part has registered its routes, drawers and actions */
init();
