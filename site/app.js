/* F1 SIM v0.24.0 (build f1sim-0.24.0): a Formula 1 league. Race engine, Formula Racing V3.0 adapter, app core, the grid and race weekends, the paddock. */
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
     { entry, type: 'strategy', name, stops, wetCall, dryCall, useSC }   switch to another plan
     { entry, type: 'manual', value: true }      AI stops making pit calls for this car
     { team,  type: 'order', value }             hold | swap | none
     { entry, type: 'refuseOrder' }              the driver ignores the current team order
     { entry, type: 'moment', kind, choice }     a driver moment for the coming lap:
         attack: outside | inside | boost | wait    defend: cover | hold | concede
         restart: jump | safe          (momentOdds() gives the odds shown to the player)

   Optional entry fields (all default to neutral)
     driver.overtaking / driver.defense   split attack and defence (else racecraft for both)
     driver.experience / driver.mental    fewer mistakes under pressure
     car.pitSpeed / car.tyreLife          crew speed and how kind the car is to its tyres
     paceAdj / qualiAdj                   seconds per lap, e.g. a driver's good or bad tracks
     ai: { stretch, scPit, undercut }     the AI strategist's personality for this car
     planned, plan, ai.wetCall/dryCall    a team's own plan: stops on set laps, and when to
                                          go to wet tyres (early | normal | late) and back
     ai.useSC                             pit under a safety car if a planned stop is near
     plans: [{ name, stops, wetCall, dryCall, useSC }]   the car's plans, for triggers to switch
     triggers: [{ when, n, from, to, action, plan, mode, chance }]
         when: sc | rain | dry | lost | gained | wear      action: plan | mode | box
         Checked at the end of every lap; acted on with the given % chance, once each.
     approach: balanced | attacker | defender | tyres   drives the car's mode lap by lap
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
    crashRate: 0.0008, mistakeRate: 0.006,
    /* Engine eras. modeEnergy replaces how much each driving mode recharges (or drains) the battery;
       emptyBattery is the time lost on a lap run with a flat battery; noHybrid removes the battery boost. */
    modeEnergy: null, emptyBattery: 0, noHybrid: false,
    /* Race incidents: multipliers for each family (see INCIDENTS). */
    incidents: { crashes: 1, failures: 1, outside: 1 }, weatherEvents: true
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

  /* ------------------------------------------------------------ plans, triggers and race approaches */
  function switchPlan(car, p, s, log, why) {
    car.plan = (p.stops || []).filter(function (x) { return x.lap > s.lap; }).sort(function (a, b) { return a.lap - b.lap; });
    car.planned = true; car.planName = p.name || car.planName;
    car.ai = merge(car.ai || {}, { wetCall: p.wetCall || 'normal', dryCall: p.dryCall || 'normal', useSC: p.useSC !== false });
    log.push({ kind: 'trigger', ids: [car.id], text: car.driver.code + ': ' + why + ', so the team switches to ' + (p.name || 'another plan') });
  }
  var TRIGGER_WHY = { sc: 'safety car', rain: 'rain', dry: 'the track is drying', lost: 'places lost', gained: 'places gained', wear: 'tyres going off' };
  function checkTriggers(s, r, log, track, scNow) {
    var prev = s.lap > 1 ? s.track[s.lap - 2] : track, ord = order(s);
    running(s).forEach(function (car) {
      (car.triggers || []).forEach(function (t) {
        if (t.fired || (t.from && s.lap < t.from) || (t.to && s.lap > t.to)) return;
        var pos = ord.indexOf(car) + 1, life = tyreLife(car.tyre.compound, car, s.circuit), hit = false;
        if (t.when === 'sc') hit = scNow; else if (t.when === 'rain') hit = track > 0 && prev === 0; else if (t.when === 'dry') hit = track === 0 && prev > 0;
        else if (t.when === 'lost') hit = pos - car.grid >= (t.n || 3); else if (t.when === 'gained') hit = car.grid - pos >= (t.n || 3);
        else if (t.when === 'wear') hit = car.tyre.wear / life * 100 >= (t.n || 90);
        if (!hit) return;
        t.fired = true;
        if (r() * 100 >= (t.chance == null ? 100 : t.chance)) { log.push({ kind: 'trigger', ids: [car.id], text: car.driver.code + ': ' + TRIGGER_WHY[t.when] + ', but the team sticks with the plan' }); return; }
        if (t.action === 'plan' && car.plans[t.plan]) switchPlan(car, car.plans[t.plan], s, log, TRIGGER_WHY[t.when]);
        else if (t.action === 'mode' && MODES[t.mode]) { car.mode = t.mode; car.modeHold = 6; log.push({ kind: 'trigger', ids: [car.id], text: car.driver.code + ': ' + TRIGGER_WHY[t.when] + ', so the call is ' + MODES[t.mode].label.toLowerCase() }); }
        else if (t.action === 'box') { car.pendingBox = 'auto'; log.push({ kind: 'trigger', ids: [car.id], text: car.driver.code + ': ' + TRIGGER_WHY[t.when] + ', so the team calls them in' }); }
      });
    });
  }
  /* The race approach picks the driving mode each lap, unless the pit wall has just made a call. */
  function applyApproach(s, field) {
    field.forEach(function (car, i) {
      if (!car.approach || car.approach === 'balanced') return;
      if (car.modeHold > 0) { car.modeHold -= 1; return; }
      var ahead = field[i - 1], behind = field[i + 1], ga = ahead ? car.cum - ahead.cum : 99, gb = behind ? behind.cum - car.cum : 99;
      var worn = car.tyre.wear > tyreLife(car.tyre.compound, car, s.circuit) * 0.8;
      if (car.approach === 'attacker') car.mode = ga < 1.2 && !worn ? 'push' : 'standard';
      else if (car.approach === 'defender') car.mode = gb < 1.0 && !worn ? 'push' : 'standard';
      else if (car.approach === 'tyres') car.mode = ga > 1.5 && gb > 1.5 ? 'manage' : 'standard';
    });
  }

  /* ------------------------------------------------------------ driver moments
     The same numbers are shown to the player and used to settle the moment. */
  function momentOdds(kind, choice, me, other, circuit) {
    var ease = circuit && circuit.overtaking != null ? circuit.overtaking : 0.7, d = me.driver, o = other ? other.driver : null;
    if (kind === 'attack') {
      var base = 0.3 + (attack(d) - (o ? defend(o) : 80)) * 0.012 + (ease - 0.7) * 0.35;
      var b = { outside: [0.14, 0.3], inside: [0.06, 0.12], boost: [0.1, 0.05], wait: [-1, 0] }[choice] || [0, 0];
      if (choice === 'boost' && me.energy < 35) b = [0.0, 0.05];
      return { success: choice === 'wait' ? 0 : clamp(base + b[0], 0.05, 0.9), contact: b[1] };
    }
    if (kind === 'defend') {
      var keep = 0.5 + (defend(d) - (o ? attack(o) : 80)) * 0.012 - (ease - 0.7) * 0.25;
      return { success: choice === 'concede' ? 0 : clamp(keep + (choice === 'cover' ? 0.2 : 0), 0.05, 0.95), contact: choice === 'cover' ? 0.08 : 0 };
    }
    var jump = clamp(0.5 + (attack(d) - 80) * 0.01, 0.2, 0.85);
    return { success: choice === 'jump' ? jump : 0, contact: choice === 'jump' ? 0.12 : 0 };
  }
  function settleMoments(s, r, log) {
    var R = s.rules, ordered = order(s);
    running(s).filter(function (c) { return c.moment; }).forEach(function (car) {
      var m = car.moment, idx = ordered.indexOf(car), ahead = ordered[idx - 1], behind = ordered[idx + 1], code = car.driver.code;
      if (m.kind === 'attack') {
        var odds = momentOdds('attack', m.choice, car, ahead, s.circuit);
        if (m.choice === 'wait' || !ahead) { car.tyre.wear = Math.max(0, car.tyre.wear - 0.3); car.energy = clamp(car.energy + 15, 0, 100);
          log.push({ kind: 'moment', ids: [car.id], text: code + ' bides their time, saving tyres and battery' }); return; }
        if (m.choice === 'boost') car.energy = Math.max(0, car.energy - 35);
        if (r() < odds.success) {
          if (car.cum > ahead.cum) { var t = ahead.cum; car.cum = round3(t - 0.15); ahead.cum = round3(Math.max(ahead.cum, car.cum + R.minGap * 0.5)); }
          log.push({ kind: 'moment', ids: [car.id, ahead.id], text: code + (m.choice === 'outside' ? ' goes around the outside of ' : m.choice === 'inside' ? ' dives down the inside of ' : ' uses the boost to pass ') + ahead.driver.code + ' and makes it stick' });
        } else if (r() < odds.contact / Math.max(0.05, 1 - odds.success)) {
          car.cum = round3(car.cum + 2.5); log.push({ kind: 'moment', ids: [car.id, ahead.id], text: code + ' makes contact with ' + ahead.driver.code + ' and loses time' });
          if (r() < 0.12) retire(car, 'Accident', log, s);
        } else { if (car.cum < ahead.cum) car.cum = round3(ahead.cum + R.minGap + 0.1); log.push({ kind: 'moment', ids: [car.id, ahead.id], text: code + ' tries a move on ' + ahead.driver.code + ' but it doesn’t work' }); }
      } else if (m.kind === 'defend') {
        if (!behind) return;
        if (m.choice === 'concede') { if (behind.cum > car.cum) { var u = car.cum; car.cum = round3(behind.cum + 0.4); behind.cum = round3(Math.min(behind.cum, u)); }
          car.tyre.wear = Math.max(0, car.tyre.wear - 0.3); log.push({ kind: 'moment', ids: [car.id, behind.id], text: code + ' lets ' + behind.driver.code + ' through to save the tyres' }); return; }
        var od = momentOdds('defend', m.choice, car, behind, s.circuit);
        if (m.choice === 'cover') car.cum = round3(car.cum + 0.2);
        if (r() < od.success) { if (behind.cum < car.cum) { var v = car.cum; car.cum = round3(behind.cum - 0.1); behind.cum = round3(Math.max(v, car.cum + R.minGap)); }
          log.push({ kind: 'moment', ids: [car.id, behind.id], text: code + ' holds off ' + behind.driver.code }); }
        else if (r() < od.contact / Math.max(0.05, 1 - od.success)) { car.cum = round3(car.cum + 2); log.push({ kind: 'moment', ids: [car.id, behind.id], text: code + ' and ' + behind.driver.code + ' touch as ' + code + ' moves to defend' }); }
        else { if (behind.cum > car.cum) { var x = car.cum; car.cum = round3(behind.cum + 0.3); behind.cum = round3(x); } log.push({ kind: 'moment', ids: [car.id, behind.id], text: behind.driver.code + ' gets past ' + code }); }
      } else if (m.kind === 'restart' && m.choice === 'jump') {
        var oj = momentOdds('restart', 'jump', car, ahead, s.circuit);
        if (r() < oj.success) { car.cum = round3(car.cum - 0.6); log.push({ kind: 'moment', ids: [car.id], text: code + ' gets a great jump at the restart' }); }
        else if (r() < oj.contact / Math.max(0.05, 1 - oj.success)) { car.cum = round3(car.cum + 1.5); log.push({ kind: 'moment', ids: [car.id], text: code + ' gets the restart wrong and loses time' }); }
      }
    });
    s.cars.forEach(function (c) { delete c.moment; });
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
        plans: (e.plans || []).slice(), triggers: (e.triggers || []).map(function (t) { return merge(t, { fired: false }); }), approach: e.approach || null, modeHold: 0,
        used: [comp], stops: 0, mode: MODES[e.startMode] ? e.startMode : 'standard', energy: 60, plan: (e.plan || []).slice().sort(function (a, b) { return a.lap - b.lap; }), planned: !!e.planned, manual: !!e.manual,
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
      else if (c.type === 'mode' && MODES[c.value]) { car.mode = c.value; car.modeHold = 3; }
      else if (c.type === 'plan') { car.plan = (c.stops || []).filter(function (p) { return p.lap > s.lap; }).sort(function (a, b) { return a.lap - b.lap; }); car.planned = true; }
      else if (c.type === 'strategy') {
        if (c.plan != null && car.plans[c.plan]) { switchPlan(car, car.plans[c.plan], s, log, 'a call from the pit wall'); return; }
        car.plan = (c.stops || []).filter(function (p) { return p.lap > s.lap; }).sort(function (a, b) { return a.lap - b.lap; });
        car.planned = true; car.planName = c.name || null;
        car.ai = merge(car.ai || {}, { wetCall: c.wetCall || 'normal', dryCall: c.dryCall || 'normal', useSC: c.useSC !== false });
        log.push({ kind: 'order', ids: [car.id], text: car.driver.code + ' switches to ' + (c.name || 'a new plan') });
      }
      else if (c.type === 'manual') car.manual = !!c.value;
      else if (c.type === 'moment') car.moment = { kind: c.kind, choice: c.choice };
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
  /* How many laps in a row, up to this one, the track has been wet (or dry). */
  function streak(s, wet) { var n = 0; for (var i = s.lap - 1; i >= 0; i--) { if ((s.track[i] > 0) === wet) n++; else break; } return n; }
  function aiWantsBox(car, s, track) {
    var left = s.laps - s.lap, c = COMPOUNDS[car.tyre.compound], life = tyreLife(car.tyre.compound, car, s.circuit), ai = car.ai || {};
    /* Weather first: the team's call decides how soon to react. Late means staying on slicks through the damp. */
    if (track > 0 && !c.wet) { var w = streak(s, true), wc = ai.wetCall || 'normal';
      if (wc === 'early' ? w >= 1 : wc === 'late' ? (track === 2 || w >= 4) : w >= 2) return 'auto'; return car.planned ? null : null; }
    if (track === 0 && c.wet) { var d = streak(s, false), dc = ai.dryCall || 'normal';
      if (dc === 'early' ? d >= 1 : dc === 'late' ? d >= 4 : d >= 2) return 'auto'; return null; }
    if (track === 1 && car.tyre.compound === 'wet' && s.track[s.lap - 2] === 1) return 'auto';
    if (track === 2 && car.tyre.compound === 'inter' && s.track[s.lap - 2] === 2) return 'auto';
    if (c.wet) return null;
    var dry = car.used.filter(function (x) { return !COMPOUNDS[x].wet; });
    var wetRace = s.track.some(function (t) { return t > 0; });
    var mustSecond = s.rules.mandatoryCompounds !== false && !wetRace && dry.length < 2 && left <= 3 && left > 1;
    if (car.planned) {
      /* The team's plan: stop on the planned lap, early under a safety car if it says so, or if the tyre is finished. */
      var next = car.plan[0];
      if (next && next.lap <= s.lap && left > 1) return next.compound || 'auto';
      if (next && s.sc.type && ai.useSC !== false && next.lap - s.lap <= 10 && left > 3) return next.compound || 'auto';
      if (car.tyre.wear > life * 1.15 && left > 2) return (next && next.compound) || 'auto';
      return mustSecond ? 'auto' : null;
    }
    if (car.manual) return car.tyre.wear > life * 1.3 ? 'auto' : null;
    if (left <= 1) return null;
    var stretch = ai.stretch || 1;
    if (car.tyre.wear >= life * 0.92 * stretch && left > 3) return 'auto';
    if (s.sc.type && car.tyre.wear > life * (ai.scPit || 0.45) && left > 8) return 'auto';
    if (ai.undercut && !s.sc.type && car.tyre.wear >= life * 0.7 && left > 8) {
      /* Undercut: stop early when stuck within a second and a half of the car ahead. */
      var ahead = order(s).filter(function (x) { return x.cum < car.cum; }).pop();
      if (ahead && car.cum - ahead.cum < 1.5 && ahead.tyre.age >= car.tyre.age - 2) return 'auto';
    }
    return mustSecond ? 'auto' : null;
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
    var newSc = null, ctx = {};
    /* The start, and restarts after a safety car: tangles and (rarely) pile-ups. */
    if (!s.sc.type && (s.lap === 1 || s.restartLap === s.lap)) startIncidents(s, R, r, track, field, log, ctx, s.lap !== 1);

    if (!s.sc.type) applyApproach(s, field);
    /* An all-electric race: everyone eases off when the battery runs low, unless the pit wall has just made a call. */
    if (R.modeEnergy && (R.modeEnergy.standard || 0) < 0 && !s.sc.type) field.forEach(function (car) {
      if (car.modeHold > 0) return;
      if (car.energy < 12) car.mode = 'manage'; else if (car.mode === 'manage' && car.energy > 50 && car.approach !== 'tyres') car.mode = 'standard';
    });
    /* raw lap times */
    var raw = {};
    field.forEach(function (car, i) {
      if (car.status !== 'running') return;
      var m = MODES[car.mode], t = basePace(car, circuit, R, track) + m.pace + tyreTime(car.tyre, car, circuit, track)
        + R.fuelEffect * (1 - (s.lap - 1) / s.laps);
      if (R.emptyBattery && !R.noHybrid && car.energy <= 0) t += R.emptyBattery;
      t += gauss(r) * (0.12 + (100 - car.driver.consistency) * 0.008);
      if (s.lap === 1) t += 4 + gauss(r) * (0.5 + (100 - car.driver.racecraft) * 0.02);
      var risk = m.risk * (1 + track * 1.5) * (1 + ((car.driver.aggression || 50) - 50) / 100) * composure(car.driver) * (s.lap === 1 ? 4 : 1);
      var lost = carIncidents(car, s, R, r, track, risk, log, ctx);
      if (lost === null) return;
      t += lost;
      if (i > 0 && !s.sc.type) {
        var gap = car.cum - field[i - 1].cum;
        if (gap < 1.0) t += R.dirtyAir * (1 - gap);
      }
      raw[car.id] = t;
    });
    trackIncidents(s, R, r, track, log, ctx);

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
            /* Racing close: sometimes they touch. */
            if (!hold && ahead.status === 'running') {
              var cc = 0.003 * (R.incidents ? R.incidents.crashes : 1) * (1 + track) * (1 + ((car.driver.aggression || 50) - 50) / 80) * (s.lap === 1 || s.restartLap === s.lap ? 2.5 : 1);
              if (r() < cc) {
                var before = car.cum; contactIncident(car, ahead, s, R, r, log, ctx); end += car.cum - before; car.cum = before;
                if (car.status !== 'running' || ahead.status !== 'running') { car.lastLap = round3(end - car.cum); car.cum = round3(end); return; }
              }
            }
            var chance = 0;
            if (!hold) {
              var adv = raw[ahead.id] - t, ease = circuit.overtaking == null ? 0.7 : circuit.overtaking;
              chance = ease * (R.overtake.base + Math.max(0, adv - 0.1) * R.overtake.pace) + (attack(car.driver) - defend(ahead.driver)) * R.overtake.racecraft;
              if (!R.noHybrid && car.energy >= R.overtakeMode.cost && (start[car.id] - start[ahead.id]) < R.overtakeMode.gap) { chance += R.overtakeMode.bonus * (0.4 + ease * 0.6); car.energy -= R.overtakeMode.cost; }
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
      field = field.filter(function (c) { return c.status === 'running'; });
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

    settleMoments(s, r, log);

    /* tyres, energy, pit stops (laps after a pit stop don't count for fastest lap) */
    var box0 = {}; running(s).forEach(function (car) { box0[car.id] = s.events.concat(log).some(function (e) { return e.kind === 'pit' && e.ids[0] === car.id && (e.lap === s.lap - 1 || e.lap == null); }); });
    running(s).forEach(function (car) {
      var m = MODES[car.mode];
      car.tyre.age += 1;
      car.tyre.wear = round3(car.tyre.wear + (s.sc.type ? 0.3 : 1) * m.deg * (circuit.tyreStress || 1) * (1.25 - car.driver.tyreMgmt / 200));
      car.energy = R.noHybrid ? 0 : clamp(car.energy + (R.modeEnergy && R.modeEnergy[car.mode] != null ? R.modeEnergy[car.mode] : m.energy), 0, 100);
      if (!s.sc.type && !box0[car.id] && car.lastLap && (!car.bestLap || car.lastLap < car.bestLap)) car.bestLap = car.lastLap;
      if (!s.sc.type && !box0[car.id] && car.lastLap && (!s.fastest || car.lastLap < s.fastest.time)) s.fastest = { id: car.id, time: car.lastLap, lap: s.lap };
      var box = car.pendingBox || (s.lap < s.laps ? aiWantsBox(car, s, track) : null);
      if (box && s.lap < s.laps) {
        var nextTrack = s.track[s.lap] != null ? s.track[s.lap] : track;
        var comp = box === 'auto' || !COMPOUNDS[box] ? chooseCompound(car, s, nextTrack) : box;
        /* Back onto slicks after rain: that stop is the next planned one, on its tyre. */
        var offWets = COMPOUNDS[car.tyre.compound].wet && !COMPOUNDS[comp].wet;
        if (offWets && car.planned && car.plan.length && nextTrack === 0 && (box === 'auto' || !COMPOUNDS[box])) comp = car.plan[0].compound || comp;
        var crew = car.car.pitSpeed == null ? 85 : car.car.pitSpeed;
        var stop = Math.max(1.9, R.pitStop.mean - (crew - 85) * 0.03 + gauss(r) * R.pitStop.sd);
        var slow = r() < R.pitStop.slowChance * (1 + (85 - crew) / 30); if (slow) stop += 2 + r() * 6;
        var pm = (R.incidents || { failures: 1 }).failures, note = '';
        if (car.repair) { stop += car.repair; note += ', a new nose'; }
        if (car.limp && car.limp.fix) car.limp = null;
        car.repair = 0; car.flatSpot = false;
        if (car.pen) { stop += car.pen; note += ', serving a ' + car.pen + '-second penalty'; car.penServed = (car.penServed || 0) + car.pen; car.pen = 0; }
        if (r() < INC.wheelnut.perStop * pm) { var wn = rr(r, 5, 12); stop += wn; log.push({ kind: 'incident', inc: 'wheelnut', ids: [car.id], text: car.driver.code + ' loses ' + wn.toFixed(0) + 's with a wheel nut problem' }); }
        else if (r() < INC.stall.perStop * pm) { var stl = rr(r, 6, 10); stop += stl; log.push({ kind: 'incident', inc: 'stall', ids: [car.id], text: car.driver.code + ' stalls in the pit box, ' + stl.toFixed(0) + 's lost' }); }
        var unsafe = r() < INC.unsafe.perStop * pm, speeding = r() < INC.speeding.perStop * pm;
        var loss = (circuit.pitLoss || 21) * (s.sc.type === 'sc' ? 0.55 : s.sc.type === 'vsc' ? 0.65 : 1) + stop;
        car.cum = round3(car.cum + loss); car.lastLap = round3(car.lastLap + loss);
        car.stints[car.stints.length - 1].to = s.lap;
        car.stints.push({ compound: comp, from: s.lap + 1, to: null });
        car.tyre = { compound: comp, wear: 0, age: 0 }; car.stops += 1; car.pendingBox = null;
        if (car.used.indexOf(comp) < 0) car.used.push(comp);
        /* A dry stop uses up the next planned stop (even if it came early); weather stops don't. Stops planned for the next few laps are dropped. */
        var weatherStop = COMPOUNDS[comp].wet;
        if (!weatherStop && car.plan.length) car.plan.shift();
        car.plan = car.plan.filter(function (p) { return p.lap > s.lap + 3; });
        log.push({ kind: 'pit', ids: [car.id], text: car.driver.code + ' pits for ' + COMPOUNDS[comp].label + 's (' + stop.toFixed(1) + 's' + (slow ? ', slow stop' : '') + note + ')' });
        if (unsafe) { penalise(car, 5, { inc: 'unsafe', text: 'unsafe release' }, log); if (r() < 0.2) { retire(car, 'Lost a wheel after an unsafe release', log, s, 'unsafe'); flagUp(ctx, 'vsc'); } }
        if (speeding && car.status === 'running') penalise(car, 5, { inc: 'speeding', text: 'speeding in the pit lane' }, log);
      }
    });

    /* safety car bookkeeping */
    if (ctx.flag === 'sc' || ctx.flag === 'vsc') newSc = newSc === 'sc' ? 'sc' : ctx.flag;
    if (s.sc.type) {
      s.sc.laps -= 1;
      if (s.sc.laps <= 0) { log.push({ kind: s.sc.type, text: (s.sc.type === 'sc' ? 'Safety car' : 'Virtual safety car') + ' ends, racing resumes' }); if (s.sc.type === 'sc') s.restartLap = s.lap + 1; s.sc = { type: null, laps: 0 }; }
    } else if (newSc && s.lap < s.laps - 1) {
      s.sc = { type: newSc, laps: newSc === 'sc' ? 3 + Math.floor(r() * 3) : 2 + Math.floor(r() * 2) };
      log.push({ kind: newSc, text: newSc === 'sc' ? 'Safety car deployed' : 'Virtual safety car deployed' });
    }

    /* A red flag: the race stops. Gaps close up, everyone gets fresh tyres and repairs, then a restart behind the safety car. */
    if (ctx.endRace && s.lap < s.laps) { log.push({ kind: 'red', inc: 'storm', text: 'Red flag: the race is not resumed, and the results stand' }); s.laps = s.lap; }
    else if (ctx.flag === 'red' && s.lap < s.laps - 1) {
      var stopped = order(s), lead0 = stopped[0], nt = s.track[s.lap] != null ? s.track[s.lap] : track;
      log.push({ kind: 'red', inc: 'red', text: 'Red flag: the race is stopped' }); s.redFlags = (s.redFlags || 0) + 1;
      stopped.forEach(function (c, i) {
        c.cum = round3((lead0 ? lead0.cum : 0) + i * 0.8);
        var comp = chooseCompound(c, s, nt);
        if (comp !== c.tyre.compound) { c.stints[c.stints.length - 1].to = s.lap; c.stints.push({ compound: comp, from: s.lap + 1, to: null }); if (c.used.indexOf(comp) < 0) c.used.push(comp); }
        c.tyre = { compound: comp, wear: 0, age: 0 }; if (c.limp && c.limp.fix) c.limp = null; c.repair = 0; c.flatSpot = false; c.pendingBox = null;
      });
      s.sc = { type: 'sc', laps: 2 }; log.push({ kind: 'sc', text: 'The race will restart behind the safety car, with fresh tyres and repairs for everyone' });
    }
    if (s.slippery > 0) s.slippery -= 1;
    order(s).forEach(function (car, i) { car.positions.push(i + 1); car.lapTimes.push(car.lastLap); car.refuse = car.refuse && !!s.orders[car.team]; });
    if (!s.finished || s.lap < s.laps) checkTriggers(s, r, log, track, log.some(function (l) { return (l.kind === 'sc' || l.kind === 'vsc') && /deployed/.test(l.text); }));
    s.cars.forEach(function (car) { if (car.status !== 'running' && car.positions.length < s.lap) car.positions.push(null); });

    if (s.lap >= s.laps) {
      s.finished = true;
      running(s).forEach(function (c) { c.stints[c.stints.length - 1].to = s.lap;
        if (c.pen) { c.cum = round3(c.cum + c.pen); c.penServed = (c.penServed || 0) + c.pen; log.push({ kind: 'penalty', inc: 'served', ids: [c.id], text: c.driver.code + '’s ' + c.pen + '-second penalty is added to their race time' }); c.pen = 0; } });
      var w = order(s)[0];
      log.push({ kind: 'finish', ids: w ? [w.id] : [], text: w ? w.driver.code + ' wins the ' + (circuit.race || circuit.name) : 'Race over' });
    }
    log.forEach(function (l) { l.lap = s.lap; });
    s.events = s.events.concat(log);
    return { state: s, log: log };
  }

  /* ------------------------------------------------------------ race incidents
     The catalogue: each incident's family, what it does, and how often it happens on a normal
     setting (perRace: about how many in a dry 55-lap race with 22 cars; perStop: chance at each pit
     stop; perStart: chance at the start). Race Control's settings scale each family:
     crashes (driver errors, contact, pile-ups, tyres and stewards), failures (mechanical and pit lane)
     and outside events. Rain, lap 1, restarts, push mode, aggression, reliability, tyre wear, street
     circuits and the engine era move the odds for each car. */
  var INCIDENTS = [
    { id: 'lockup', family: 'driver', label: 'Lock-up, runs wide', perRace: 4.0, effect: '1 to 2.5s lost; sometimes a flat-spotted tyre (slower until the next stop)' },
    { id: 'off', family: 'driver', label: 'Off the track, rejoins', perRace: 2.0, effect: '3 to 7s lost' },
    { id: 'spin', family: 'driver', label: 'Spin', perRace: 0.7, effect: '8 to 16s lost' },
    { id: 'gravel', family: 'driver', label: 'Through the gravel', perRace: 0.35, effect: '15 to 30s lost; sometimes front wing damage' },
    { id: 'wing', family: 'driver', label: 'Clips the barrier: front wing damage', perRace: 0.3, effect: 'About 1.4s a lap slower until the car pits for a new nose' },
    { id: 'beached', family: 'driver', label: 'Beached in the gravel', perRace: 0.12, effect: 'Out; virtual safety car or safety car' },
    { id: 'wall', family: 'driver', label: 'Hits the barrier', perRace: 0.4, effect: 'Out; safety car (sometimes virtual), red flag 1 in 10' },
    { id: 'heavy', family: 'driver', label: 'Heavy crash', perRace: 0.07, effect: 'Out; red flag half the time, else safety car' },
    { id: 'contact', family: 'contact', label: 'Contact between two cars', perRace: 0.8, effect: 'A touch (time lost), a puncture, wing damage, one car out, or both out; stewards often penalise whoever caused it' },
    { id: 'tangle', family: 'pileup', label: 'First-lap or restart tangle (2 to 5 cars)', perStart: 0.2, effect: 'Each car: out, damaged, punctured or delayed; safety car or red flag' },
    { id: 'pileup', family: 'pileup', label: 'Multi-car pile-up (5 to 8 cars)', perStart: 0.02, effect: 'Red flag; several cars out' },
    { id: 'pu', family: 'mechanical', label: 'Power unit failure', perRace: 0.28, effect: 'Out; sometimes smoke and a virtual safety car, sometimes oil on the track' },
    { id: 'gearbox', family: 'mechanical', label: 'Gearbox failure', perRace: 0.14, effect: 'Out' },
    { id: 'hydraulics', family: 'mechanical', label: 'Hydraulics failure', perRace: 0.10, effect: 'Out' },
    { id: 'energy', family: 'mechanical', label: 'Energy store failure (hybrid eras)', perRace: 0.07, effect: 'Out' },
    { id: 'fuel', family: 'mechanical', label: 'Fuel pressure problem', perRace: 0.05, effect: 'Out' },
    { id: 'electrical', family: 'mechanical', label: 'Electrical shutdown', perRace: 0.10, effect: 'A third restart after a power cycle (25s lost); the rest are out' },
    { id: 'brakes', family: 'mechanical', label: 'Brake failure', perRace: 0.05, effect: 'Out; half end in the barrier (safety car)' },
    { id: 'suspension', family: 'mechanical', label: 'Suspension failure', perRace: 0.05, effect: 'Out; some end in the barrier' },
    { id: 'fire', family: 'mechanical', label: 'Engine fire', perRace: 0.025, effect: 'Out; safety car' },
    { id: 'overheat', family: 'mechanical', label: 'Overheating (water leak)', perRace: 0.07, effect: 'A second a lap slower for 2 to 4 laps, then out' },
    { id: 'power', family: 'mechanical', label: 'Loss of power (MGU-K, or a misfire without hybrid)', perRace: 0.18, effect: 'About 0.6 to 0.9s a lap slower for the rest of the race' },
    { id: 'shift', family: 'mechanical', label: 'Gearshift problems', perRace: 0.12, effect: '0.6s a lap slower for 5 to 10 laps' },
    { id: 'braketemp', family: 'mechanical', label: 'Brake temperatures', perRace: 0.10, effect: '0.35s a lap slower for the rest of the race' },
    { id: 'floor', family: 'mechanical', label: 'Floor damage from the kerbs', perRace: 0.08, effect: '0.5s a lap slower for the rest of the race' },
    { id: 'puncture', family: 'tyre', label: 'Puncture', perRace: 0.22, effect: 'A slow lap back to the pits (12 to 20s) and a stop; more at street circuits and on worn tyres' },
    { id: 'blowout', family: 'tyre', label: 'Tyre failure on worn tyres', perRace: 0.05, effect: 'Only past 85% wear: a third crash out (safety car), the rest limp to the pits' },
    { id: 'wheelnut', family: 'pit', label: 'Wheel nut problem', perStop: 0.018, effect: '5 to 12s lost in the stop' },
    { id: 'unsafe', family: 'pit', label: 'Unsafe release', perStop: 0.006, effect: '5-second penalty; 1 in 5 lose a wheel and are out' },
    { id: 'speeding', family: 'pit', label: 'Speeding in the pit lane', perStop: 0.004, effect: '5-second penalty' },
    { id: 'stall', family: 'pit', label: 'Stalls in the pit box', perStop: 0.005, effect: '6 to 10s lost' },
    { id: 'tracklimits', family: 'stewards', label: 'Track limits', perRace: 0.35, effect: '5-second penalty' },
    { id: 'jumpstart', family: 'stewards', label: 'Jump start', perRace: 0.08, effect: '5-second penalty' },
    { id: 'debris', family: 'external', label: 'Debris on the track', perRace: 0.22, effect: 'Virtual safety car or safety car (more at circuits that have more)' },
    { id: 'bag', family: 'external', label: 'Debris in a brake duct or radiator', perRace: 0.10, effect: '0.4s a lap slower for 3 to 6 laps; sometimes out with overheating' },
    { id: 'animal', family: 'external', label: 'An animal on the track', perRace: 0.03, effect: 'Virtual safety car' },
    { id: 'invasion', family: 'external', label: 'A spectator on the track', perRace: 0.01, effect: 'Safety car' },
    { id: 'drain', family: 'external', label: 'Loose drain cover', perRace: 0.012, effect: 'Red flag while it is fixed' },
    { id: 'cloudburst', family: 'external', label: 'Sudden cloudburst', perRace: 0.05, effect: 'Wet track for 3 to 8 laps, then damp (not when the weekend is set to dry)' },
    { id: 'storm', family: 'external', label: 'Storm: lightning in the area', perRace: 0.008, effect: 'Red flag; in the last quarter of the race it is not resumed and the results stand' }
  ];
  var INC = {}; INCIDENTS.forEach(function (x) { INC[x.id] = x; });
  var REF_CAR_LAPS = 22 * 55, REF_LAPS = 55;
  function flagUp(ctx, kind) { var rank = { vsc: 1, sc: 2, red: 3 }; if (!ctx.flag || rank[kind] > rank[ctx.flag]) ctx.flag = kind; }
  function rr(r, a, b) { return a + r() * (b - a); }
  function penalise(car, secs, why, log) { car.pen = (car.pen || 0) + secs; log.push({ kind: 'penalty', inc: why.inc, ids: [car.id], text: car.driver.code + ' gets a ' + secs + '-second penalty: ' + why.text }); }
  function limp(car, o) { car.limp = o; }
  function needsPit(car, repair) { car.pendingBox = car.pendingBox || 'auto'; car.repair = Math.max(car.repair || 0, repair || 0); }
  var ANIMALS = ['A dog', 'A hare', 'A groundhog', 'A monitor lizard', 'A cat', 'A fox'];

  /* Incidents for one car on one lap. Returns time lost, or null if the car is out. */
  function carIncidents(car, s, R, r, track, risk, log, ctx) {
    var mult = R.incidents || { crashes: 1, failures: 1, outside: 1 }, add = 0, code = car.driver.code;
    /* What's already wrong with the car. */
    if (car.limp) {
      add += car.limp.pace;
      if (car.limp.laps != null) { car.limp.laps -= 1; if (car.limp.laps <= 0) { if (car.limp.out) { retire(car, car.limp.out, log, s, car.limp.inc); if (r() < 0.4) flagUp(ctx, 'vsc'); return null; } car.limp = null; } }
    }
    if (car.flatSpot) add += 0.2;
    if (s.sc.type) return add;
    var slip = s.slippery > 0 ? 2.5 : 1, cm = mult.crashes * slip, fm = mult.failures, om = mult.outside;
    var drv = function (id) { return INC[id].perRace / REF_CAR_LAPS * risk * cm; };
    /* Driver errors, most serious first; one per lap at most. */
    var roll = r(), acc = 0, pick = null, order = ['heavy', 'wall', 'beached', 'wing', 'gravel', 'spin', 'off', 'lockup'];
    for (var k = 0; k < order.length && !pick; k++) { acc += drv(order[k]) * (order[k] === 'lockup' || order[k] === 'off' ? 1 : (1 + track)); if (roll < acc) pick = order[k]; }
    if (pick === 'heavy') { retire(car, 'Heavy crash', log, s, 'heavy'); flagUp(ctx, r() < 0.5 ? 'red' : 'sc'); return null; }
    if (pick === 'wall') { retire(car, 'Hit the barrier', log, s, 'wall'); flagUp(ctx, r() < 0.1 ? 'red' : r() < 0.7 ? 'sc' : 'vsc'); return null; }
    if (pick === 'beached') { retire(car, 'Beached in the gravel', log, s, 'beached'); flagUp(ctx, r() < 0.7 ? 'vsc' : 'sc'); return null; }
    if (pick === 'wing') { limp(car, { pace: 1.4, laps: null, fix: true, inc: 'wing' }); needsPit(car, 9); log.push({ kind: 'damage', inc: 'wing', ids: [car.id], text: code + ' clips the barrier: front wing damage, pitting for a new nose' }); return add + rr(r, 2, 5); }
    if (pick === 'gravel') { var g = rr(r, 15, 30); log.push({ kind: 'mistake', inc: 'gravel', ids: [car.id], text: code + ' goes through the gravel, ' + g.toFixed(0) + 's lost' }); if (r() < 0.3) { limp(car, { pace: 1.4, laps: null, fix: true, inc: 'wing' }); needsPit(car, 9); log.push({ kind: 'damage', inc: 'wing', ids: [car.id], text: code + ' has front wing damage and pits for a new nose' }); } return add + g; }
    if (pick === 'spin') { var sp = rr(r, 8, 16); if (r() < 0.25) car.flatSpot = true; log.push({ kind: 'mistake', inc: 'spin', ids: [car.id], text: code + ' spins, ' + sp.toFixed(0) + 's lost' + (car.flatSpot ? ' and a flat-spotted tyre' : '') }); return add + sp; }
    if (pick === 'off') { var of = rr(r, 3, 7); log.push({ kind: 'mistake', inc: 'off', ids: [car.id], text: code + ' goes off and rejoins, ' + of.toFixed(1) + 's lost' }); return add + of; }
    if (pick === 'lockup') { var lu = rr(r, 1, 2.5); if (r() < 0.15) car.flatSpot = true; log.push({ kind: 'mistake', inc: 'lockup', ids: [car.id], text: code + ' locks up and runs wide, ' + lu.toFixed(1) + 's lost' + (car.flatSpot ? ', flat-spotting a tyre' : '') }); return add + lu; }
    /* Stewards. */
    if (r() < INC.tracklimits.perRace / REF_CAR_LAPS * mult.crashes * (1 + ((car.driver.aggression || 50) - 50) / 100)) penalise(car, 5, { inc: 'tracklimits', text: 'track limits' }, log);
    if (s.lap === 1 && r() < INC.jumpstart.perRace / 22 * mult.crashes) penalise(car, 5, { inc: 'jumpstart', text: 'jump start' }, log);
    /* Mechanical: worse with low reliability, a worn power unit and a fragile engine era. */
    var relF = Math.max(0.2, (1 - (car.car.reliability || 85) / 100) / 0.15) * (1 + (car.car.wear || 0) / 100) * fm;
    var mech = function (id) { return INC[id].perRace / REF_CAR_LAPS * relF; };
    var mroll = r(), macc = 0, mpick = null, mlist = ['pu', 'gearbox', 'hydraulics', 'energy', 'fuel', 'electrical', 'brakes', 'suspension', 'fire', 'overheat', 'power', 'shift', 'braketemp', 'floor'];
    for (var j = 0; j < mlist.length && !mpick; j++) { if (mlist[j] === 'energy' && R.noHybrid) continue; macc += mech(mlist[j]); if (mroll < macc) mpick = mlist[j]; }
    if (mpick && car.limp && ['overheat', 'power', 'shift', 'braketemp', 'floor'].indexOf(mpick) >= 0) mpick = null;
    if (mpick === 'pu') { retire(car, 'Power unit failure', log, s, 'pu'); if (r() < 0.25) flagUp(ctx, 'vsc'); if (r() < 0.15) { s.slippery = 3; log.push({ kind: 'incident', inc: 'oil', text: 'Oil on the track: it’s slippery for a few laps' }); } return null; }
    if (['gearbox', 'hydraulics', 'energy', 'fuel'].indexOf(mpick) >= 0) { retire(car, { gearbox: 'Gearbox failure', hydraulics: 'Hydraulics failure', energy: 'Energy store failure', fuel: 'Fuel pressure' }[mpick], log, s, mpick); if (r() < 0.2) flagUp(ctx, 'vsc'); return null; }
    if (mpick === 'electrical') { if (r() < 0.35) { log.push({ kind: 'damage', inc: 'electrical', ids: [car.id], text: code + ' stops with an electrical shutdown, power-cycles the car and gets going again, 25s lost' }); return add + 25; } retire(car, 'Electrical shutdown', log, s, 'electrical'); if (r() < 0.4) flagUp(ctx, 'vsc'); return null; }
    if (mpick === 'brakes' || mpick === 'suspension') { var wall = r() < (mpick === 'brakes' ? 0.5 : 0.4); retire(car, (mpick === 'brakes' ? 'Brake failure' : 'Suspension failure') + (wall ? ', into the barrier' : ''), log, s, mpick); if (wall) flagUp(ctx, 'sc'); return null; }
    if (mpick === 'fire') { retire(car, 'Engine fire', log, s, 'fire'); flagUp(ctx, 'sc'); return null; }
    if (mpick === 'overheat') { limp(car, { pace: 1.0, laps: 2 + Math.floor(r() * 3), out: 'Overheating', inc: 'overheat' }); log.push({ kind: 'damage', inc: 'overheat', ids: [car.id], text: code + ' is overheating: a water leak' }); return add + 1; }
    if (mpick === 'power') { var pw = rr(r, 0.6, 0.9); limp(car, { pace: pw, laps: null, inc: 'power' }); log.push({ kind: 'damage', inc: 'power', ids: [car.id], text: code + (R.noHybrid ? ' has an engine misfire' : ' loses electrical power (MGU-K)') + ', ' + pw.toFixed(1) + 's a lap slower' }); return add + pw; }
    if (mpick === 'shift') { limp(car, { pace: 0.6, laps: 5 + Math.floor(r() * 6), inc: 'shift' }); log.push({ kind: 'damage', inc: 'shift', ids: [car.id], text: code + ' has gearshift problems' }); return add + 0.6; }
    if (mpick === 'braketemp') { limp(car, { pace: 0.35, laps: null, inc: 'braketemp' }); log.push({ kind: 'damage', inc: 'braketemp', ids: [car.id], text: code + ' is managing brake temperatures' }); return add + 0.35; }
    if (mpick === 'floor') { limp(car, { pace: 0.5, laps: null, inc: 'floor' }); log.push({ kind: 'damage', inc: 'floor', ids: [car.id], text: code + ' has floor damage from the kerbs' }); return add + 0.5; }
    /* Tyres. */
    var street = (s.circuit.type || '') === 'street' ? 1.8 : 1, wearNow = car.tyre.wear || 0;
    if (r() < INC.puncture.perRace / REF_CAR_LAPS * street * (1 + wearNow / 100) * mult.crashes * slip) { var pc = rr(r, 12, 20); needsPit(car, 0); log.push({ kind: 'damage', inc: 'puncture', ids: [car.id], text: code + ' has a puncture: ' + pc.toFixed(0) + 's lost getting back to the pits' }); return add + pc; }
    if (wearNow > 85 && r() < 0.012 * (wearNow - 85) / 15 * mult.crashes) {
      if (r() < 0.35) { retire(car, 'Tyre failure, into the barrier', log, s, 'blowout'); flagUp(ctx, 'sc'); return null; }
      needsPit(car, 0); log.push({ kind: 'damage', inc: 'blowout', ids: [car.id], text: code + '’s worn tyre fails: limping back to the pits' }); return add + 25;
    }
    /* Debris picked up. */
    if (r() < INC.bag.perRace / REF_CAR_LAPS * om && !car.limp) { var bl = 3 + Math.floor(r() * 4); limp(car, { pace: 0.4, laps: bl, out: r() < 0.15 ? 'Overheating (debris in the radiator)' : null, inc: 'bag' }); log.push({ kind: 'damage', inc: 'bag', ids: [car.id], text: code + ' has debris caught in a brake duct' }); return add + 0.4; }
    return add;
  }
  /* Race-wide events on a lap. */
  function trackIncidents(s, R, r, track, log, ctx) {
    var om = (R.incidents || { outside: 1 }).outside, per = function (id) { return INC[id].perRace / REF_LAPS * om; };
    if (s.sc.type) return;
    if (r() < (s.circuit.scChance || 0.004) * om) { flagUp(ctx, r() < 0.6 ? 'vsc' : 'sc'); log.push({ kind: 'incident', inc: 'debris', text: 'Debris on the track' }); }
    if (r() < per('animal')) { flagUp(ctx, 'vsc'); log.push({ kind: 'incident', inc: 'animal', text: ANIMALS[Math.floor(r() * ANIMALS.length)] + ' on the track' }); }
    if (r() < per('invasion')) { flagUp(ctx, 'sc'); log.push({ kind: 'incident', inc: 'invasion', text: 'A spectator gets onto the track' }); }
    if (r() < per('drain')) { flagUp(ctx, 'red'); log.push({ kind: 'incident', inc: 'drain', text: 'A loose drain cover: red flag while it’s fixed' }); }
    if (R.weatherEvents !== false && track === 0 && s.lap < s.laps - 3 && r() < per('cloudburst')) {
      var n = 3 + Math.floor(r() * 6); for (var i = s.lap; i < Math.min(s.laps, s.lap + n); i++) s.track[i] = 2;
      for (var d = s.lap + n; d < Math.min(s.laps, s.lap + n + 2); d++) if (s.track[d] === 0) s.track[d] = 1;
      log.push({ kind: 'weather', inc: 'cloudburst', text: 'A sudden cloudburst: heavy rain for the next few laps' });
    }
    if (r() < per('storm')) { log.push({ kind: 'incident', inc: 'storm', text: 'Lightning in the area' }); if (s.lap >= s.laps * 0.75) ctx.endRace = true; else flagUp(ctx, 'red'); }
  }
  /* First lap and restarts: a tangle, or (rarely) a pile-up. */
  function startIncidents(s, R, r, track, field, log, ctx, restart) {
    var cm = (R.incidents || { crashes: 1 }).crashes * (1 + track) * (restart ? 0.4 : 1), n = field.length;
    var big = r() < INC.pileup.perStart * cm, tangle = !big && r() < INC.tangle.perStart * cm;
    if ((!big && !tangle) || n < 4) return;
    var m = big ? 5 + Math.floor(r() * 4) : 2 + Math.floor(r() * 4); m = Math.min(m, n - 1);
    var at = 1 + Math.floor(r() * Math.max(1, n - m)), who = field.slice(at, at + m), out = 0;
    log.push({ kind: 'incident', inc: big ? 'pileup' : 'tangle', ids: who.map(function (c) { return c.id; }), text: (big ? 'Multi-car pile-up' : ['Two', 'Three', 'Four', 'Five'][m - 2] + '-car tangle') + (restart ? ' at the restart' : ' at the first corner') + ': ' + who.map(function (c) { return c.driver.code; }).join(', ') });
    who.forEach(function (c) {
      var x = r();
      if (x < (big ? 0.55 : 0.35)) { retire(c, big ? 'Pile-up' : 'First-lap collision', log, s, big ? 'pileup' : 'tangle'); out++; }
      else if (x < 0.7) { limp(c, { pace: 1.4, laps: null, fix: true, inc: 'wing' }); needsPit(c, 9); c.cum += rr(r, 3, 8); log.push({ kind: 'damage', inc: 'wing', ids: [c.id], text: c.driver.code + ' has front wing damage and pits for a new nose' }); }
      else if (x < 0.85) { needsPit(c, 0); c.cum += rr(r, 10, 18); log.push({ kind: 'damage', inc: 'puncture', ids: [c.id], text: c.driver.code + ' has a puncture from the contact' }); }
      else { c.cum += rr(r, 4, 12); }
    });
    if (big || out >= 2) flagUp(ctx, big || r() < 0.35 ? 'red' : 'sc'); else flagUp(ctx, out ? 'sc' : 'vsc');
  }
  /* Two cars touch while racing: the follower (attacker) is usually to blame. */
  function contactIncident(car, ahead, s, R, r, log, ctx) {
    var x = r(), a = car.driver.code, b = ahead.driver.code;
    if (x < 0.45) { car.cum += rr(r, 1, 3); ahead.cum += rr(r, 1, 3); log.push({ kind: 'incident', inc: 'contact', ids: [car.id, ahead.id], text: a + ' and ' + b + ' touch, both lose time' }); if (r() < 0.3) penalise(car, 5, { inc: 'contact', text: 'causing a collision' }, log); return; }
    if (x < 0.65) { needsPit(ahead, 0); ahead.cum += rr(r, 12, 18); log.push({ kind: 'incident', inc: 'contact', ids: [car.id, ahead.id], text: a + ' hits ' + b + ', who gets a puncture' }); if (r() < 0.5) penalise(car, r() < 0.5 ? 5 : 10, { inc: 'contact', text: 'causing a collision' }, log); return; }
    if (x < 0.8) { limp(car, { pace: 1.4, laps: null, fix: true, inc: 'wing' }); needsPit(car, 9); log.push({ kind: 'incident', inc: 'contact', ids: [car.id, ahead.id], text: a + ' runs into the back of ' + b + ' and breaks the front wing' }); if (r() < 0.4) penalise(car, 5, { inc: 'contact', text: 'causing a collision' }, log); return; }
    if (x < 0.95) { var victim = r() < 0.5 ? ahead : car, other = victim === car ? ahead : car; retire(victim, 'Collision with ' + other.driver.code, log, s, 'contact'); log.push({ kind: 'incident', inc: 'contact', ids: [car.id, ahead.id], text: a + ' and ' + b + ' collide; ' + victim.driver.code + ' is out' }); flagUp(ctx, r() < 0.6 ? 'sc' : 'vsc'); if (car.status === 'running') penalise(car, 10, { inc: 'contact', text: 'causing a collision' }, log); return; }
    retire(car, 'Collision with ' + b, log, s, 'contact'); retire(ahead, 'Collision with ' + a, log, s, 'contact');
    log.push({ kind: 'incident', inc: 'contact', ids: [car.id, ahead.id], text: a + ' and ' + b + ' collide: both are out' }); flagUp(ctx, 'sc');
  }

  function retire(car, why, log, s, inc) {
    if (car.status !== 'running') return;
    car.status = 'dnf'; car.dnf = why; car.retiredLap = s.lap; car.limp = null;
    car.stints[car.stints.length - 1].to = s.lap;
    log.push({ kind: 'dnf', inc: inc || null, ids: [car.id], text: car.driver.code + ' out: ' + why });
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

  var api = { momentOdds: momentOdds, COMPOUNDS: COMPOUNDS, MODES: MODES, TRACK: TRACK, DEFAULTS: DEFAULTS, rng: rng, carScore: carScore, tyreLife: tyreLife, composure: composure,
              weatherPlan: weatherPlan, INCIDENTS: INCIDENTS, qualify: qualify, createRace: createRace, stepLap: stepLap, runTo: runTo, classify: classify };
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
  'f1_applications', 'f1_posts', 'f1_settings', 'f1_runs', 'f1_projects', 'f1_dev', 'f1_plans',
  'f1_notices', 'f1_diary', 'f1_relations', 'f1_votes', 'f1_parts', 'f1_contracts', 'f1_series', 'f1_seasons', 'f1_branding', 'audit'];

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
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  flask: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7.5 15h9',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
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
/* Race Control can view and act as any character ("View as"); players only as their own. */
const currentChar = () => { const c = get('characters', S.charId); return c && !c.retired && (c.userId === S.uid || S.isGm) ? c : null; };
const actingForOther = () => { const c = currentChar(); return !!(c && c.userId !== S.uid); };
/* Records made as a character belong to that character's player, even when Race Control makes them. */
const asOwner = () => { const c = currentChar(); return (c && c.userId) || S.uid; };
function resolveChar() {
  const mine = myChars(), saved = lsGet('f1sim.char');
  if (S.isGm) { const c = get('characters', saved); S.charId = c && !c.retired ? c.id : null; return; }
  S.charId = (mine.find(c => c.id === saved) || mine[0] || {}).id || null;
}

/* ---------------------------------------------------------------- routes, actions, drawers */
const ROUTES = {}, ACTIONS = {}, CHANGES = {}, DRAWERS = {};
function route(name, title, view, opts) { ROUTES[name] = Object.assign({ title, view }, opts || {}); }
function openDrawer(type, extra) { S.ui.drawer = Object.assign({ type }, extra || {}); renderOverlay(); }
function closeDrawer() { S.ui.drawer = null; renderOverlay(); }
function go(r) { if (!ROUTES[r]) r = 'home'; S.route = r; S.navOpen = false; S.ui.drawer = null; if (location.hash.slice(1) !== r) history.replaceState(null, '', '#' + r); render(); window.scrollTo(0, 0); }

const NAV = [
  ['home', 'home', 'Home'], ['notices', 'bell', 'Notifications'], ['grid', 'flag', 'The Grid'], ['team', 'wrench', 'Team HQ'], ['weekend', 'radio', 'Race Weekend'], ['calendar', 'calendar', 'Calendar'], ['test', 'flask', 'Test Track'], ['standings', 'star', 'Championship'], ['seasons', 'star', 'Seasons'], ['people', 'users', 'Characters'],
  ['paddock', 'news', 'Paddock'], ['characters', 'user', 'Your characters']
];
const NAV_RC = [['control', 'shield', 'Race Control'], ['admin', 'server', 'Accounts and backups']];
function navHtml() {
  const item = ([r, ic, label, count]) => `<button class="nav-item" data-act="nav" data-route="${r}" ${S.route === r ? 'aria-current="page"' : ''}>${icon(ic)}<span>${esc(label)}</span>${count ? `<span class="count">${count}</span>` : ''}</button>`;
  const pending = S.isGm ? list('f1_applications').filter(a => a.status === 'pending').length + list('characters').filter(c => !c.retired && c.status === 'pending').length : 0;
  const unread = typeof unreadCount === 'function' ? unreadCount() : 0;
  let h = `<div class="nav-group">${NAV.map(x => item(x[0] === 'notices' ? [x[0], x[1], x[2], unread] : x)).join('')}</div>`;
  if (S.isGm) h += `<div class="nav-group rc"><p class="nav-h">Race Control</p>${item(['control', 'shield', 'Race Control', pending])}${item(['series', 'flag', 'Series'])}${S.isOwner ? item(NAV_RC[1]) : ''}</div>`;
  /* The version the site is running, to match against CHANGELOG.md and the commits. */
  if (window.F1SIM_VERSION && window.F1SIM_VERSION.indexOf('__') !== 0) h += `<p class="nav-version">F1 SIM v${esc(window.F1SIM_VERSION)}</p>`;
  return h;
}
function topbarHtml() {
  const a = ACCOUNT(), mine = myChars(), c = currentChar();
  const all = S.isGm ? list('characters').filter(x => !x.retired).sort((x, y) => String(x.name).localeCompare(String(y.name))) : [];
  const who = S.isGm ? `<label class="who"><span class="sr-only">View as</span><select id="char-switch" data-change="char-switch" title="See the league as any character">
      <option value="">Race Control view</option>${mine.length ? `<optgroup label="Your characters">${mine.map(x => `<option value="${esc(x.id)}" ${x.id === S.charId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>` : ''}
      <optgroup label="View as a player’s character">${all.filter(x => x.userId !== S.uid).map(x => `<option value="${esc(x.id)}" ${x.id === S.charId ? 'selected' : ''}>${esc(x.name)} (${esc(charRoleName(x.role).toLowerCase())})</option>`).join('')}</optgroup></select></label>`
    : mine.length > 1 ? `<label class="who"><span class="sr-only">Playing as</span><select id="char-switch" data-change="char-switch">${mine.map(x => `<option value="${esc(x.id)}" ${x.id === S.charId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`
    : c ? `<span class="who">${esc(c.name)}</span>` : '';
  return `<button class="menu-btn" data-act="nav-toggle" aria-label="${S.navOpen ? 'Close' : 'Open'} the menu" aria-expanded="${S.navOpen}">${icon(S.navOpen ? 'x' : 'menu', 22)}</button>
    <button class="brand" data-act="nav" data-route="home">${typeof leagueLogo === 'function' && leagueLogo() ? `<img class="league-logo" src="${esc(leagueLogo())}" alt="">` : '<span class="brand-mark" aria-hidden="true"></span>'}F1 SIM</button>
    <div class="top-right">${typeof seriesSwitchHtml === 'function' ? seriesSwitchHtml() : ''}${S.isGm ? '<span class="rc-badge">Race Control</span>' : ''}${(() => { const n = typeof unreadCount === 'function' ? unreadCount() : 0; return `<button class="bell" data-act="nav" data-route="notices" aria-label="Notifications${n ? ', ' + n + ' new' : ''}">${icon('bell', 20)}${n ? `<span class="count">${n}</span>` : ''}</button>`; })()}${who}
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
  const vb = actingForOther() ? `<div class="view-as">Viewing as <b>${esc(currentChar().name)}</b>, a player’s character. What you do here counts as them. <button class="btn small" data-act="view-as-stop">Back to Race Control</button></div>` : '';
  document.getElementById('main').innerHTML = `<div class="page">${vb}${body}</div>`;
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
  'sign-out': () => { const a = ACCOUNT(); if (a) a.signOut(); },
  'view-as-stop': () => { S.charId = null; lsSet('f1sim.char', null); render(); }
});
CHANGES['char-switch'] = v => { S.charId = v || null; lsSet('f1sim.char', v || null); render(); };

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
const CHAR_BLANK = { name: '', code: '', number: '', nationality: '', role: 'driver', bio: '', discord: '', discordId: '', faceclaim: '', portraitUrl: null, nickname: '', birthplace: '', junior: '', helmet: '' };
ACTIONS['char-new'] = () => { S.ui.form.ch = Object.assign({}, CHAR_BLANK); openDrawer('char'); };
ACTIONS['char-edit'] = d => { const c = get('characters', d.id); if (!c) return; S.ui.form.ch = Object.assign({}, CHAR_BLANK, clone(S.store.characters[d.id]), { id: d.id }); openDrawer('char'); };
ACTIONS['char-play'] = d => { S.charId = d.id; lsSet('f1sim.char', d.id); toast('Now playing as ' + ((get('characters', d.id) || {}).name || 'this character') + '.'); render(); };
DRAWERS.char = function () {
  const f = S.ui.form.ch || {}, txt = (k, label, extra) => `<label class="field">${label}<input id="ch-${k}" type="text" data-bind="ui/form/ch/${k}" value="${esc(f[k] || '')}" ${extra || ''}></label>`;
  return `<header><div><h2>${f.id ? 'Edit character' : 'New character'}</h2><p>Characters are fiction. Race Control puts characters into seats on the grid; you can also apply for one.</p></div>
      <button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><div class="ch-photo-row"><div class="ch-photo">${f.portraitUrl ? `<img src="${esc(f.portraitUrl)}" alt="The character’s picture">` : '<span class="muted small">No picture yet</span>'}</div>
      <div><h3>Picture and face claim</h3><div class="btn-row"><label class="btn small file-btn">${f.portraitUrl ? 'Change the picture' : 'Upload a picture'}<input type="file" accept="image/*" class="sr-only" data-change="ch-portrait"></label>${f.portraitUrl ? '<button class="btn small ghost" data-act="ch-portrait-remove">Remove</button>' : ''}${S.ui.chUploading ? '<span class="muted small">Uploading…</span>' : ''}</div>
      <p class="muted small">JPEG, PNG or WebP; a head-and-shoulders shot works best. It’s saved with the character.</p>
      ${txt('faceclaim', 'Face claim', 'placeholder="Who the picture shows, e.g. the actor or model" autocomplete="off"')}</div></div>
    <div class="form-grid">
      ${txt('name', 'Name', 'autocomplete="off" required')}
      <label class="field">What they do<select id="ch-role" data-bind="ui/form/ch/role" ${f.id && charStatus(get('characters', f.id) || {}) === 'approved' ? 'disabled' : ''}>${CHAR_ROLES.map(([k, l]) => `<option value="${k}" ${f.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select>${f.id && charStatus(get('characters', f.id) || {}) === 'approved' ? '<span class="muted small">Fixed once approved; ask Race Control to change it.</span>' : ''}</label>
      ${txt('nationality', 'Nationality', 'placeholder="e.g. Scottish"')}
      ${f.role === 'driver' ? txt('code', 'Three-letter code (drivers)', 'maxlength="3" placeholder="e.g. HAR"') + `<label class="field">Car number (drivers)<input id="ch-number" type="number" min="1" max="99" data-bind="ui/form/ch/number" data-type="number" value="${esc(f.number || '')}"></label>` : ''}
      ${txt('discord', 'Discord username (optional)', 'autocomplete="off"')}
      <label class="field">Discord user ID (optional, for @mentions)<input id="ch-discordId" type="text" inputmode="numeric" autocomplete="off" data-bind="ui/form/ch/discordId" value="${esc(f.discordId || '')}" placeholder="e.g. 123456789012345678"><span class="muted small">In Discord: Settings, Advanced, turn on Developer Mode. Then right-click your name and choose Copy User ID.</span></label>
      ${txt('nickname', 'Nickname (optional)')}${txt('birthplace', 'Where they’re from (optional)')}
    </div>
    <label class="field">About them<textarea id="ch-bio" rows="6" data-bind="ui/form/ch/bio" placeholder="Background, personality, how they got into the paddock">${esc(f.bio || '')}</textarea></label>
    ${f.role === 'driver' ? `<label class="field">Before Formula 1 (optional)<textarea id="ch-junior" rows="3" data-bind="ui/form/ch/junior" placeholder="Karting, junior series, titles, the one that got away">${esc(f.junior || '')}</textarea></label>
    ${txt('helmet', 'Helmet design (optional)', 'placeholder="e.g. Saltire blue with a gold stripe"')}` : ''}
    <div class="btn-row"><button class="btn primary" data-act="char-save">${f.id ? 'Save changes' : 'Create character'}</button>${f.id ? `<button class="btn danger" data-act="char-retire" data-id="${esc(f.id)}">Retire this character</button>` : ''}</div></div>`;
};
ACTIONS['char-save'] = () => {
  const f = clone(S.ui.form.ch || {}), id = f.id || newId('ch'); delete f.id;
  f.name = String(f.name || '').trim();
  if (!f.name) { toast('Give your character a name.', true); return; }
  f.code = String(f.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  f.discordId = String(f.discordId || '').replace(/\s/g, '');
  if (f.discordId && !/^\d{15,21}$/.test(f.discordId)) { toast('A Discord user ID is a long number, 15 to 21 digits. Use Copy User ID in Discord.', true); return; }
  const prev = get('characters', id);
  if (prev && charStatus(prev) === 'approved') f.role = prev.role;
  const doc = Object.assign({}, prev ? clone(S.store.characters[id]) : { createdAt: nowIso() }, f, { userId: prev ? prev.userId : S.uid, updatedAt: nowIso() });
  run(async () => {
    await Data.put('characters', id, doc);
    /* An approved character's name, code and number also change on the grid. */
    const pid = f1PcId(id), person = prev && F1.person(pid);
    if (person && (person.name !== doc.name || person.abbr !== (doc.code || person.abbr) || (person.num || null) !== (doc.number || null))) {
      await Data.put('f1_people', pid, Object.assign(clone(S.store.f1_people[pid]), { name: doc.name, abbr: doc.code || person.abbr, num: doc.number || null }));
      for (const s of list('f1_seats').filter(x => x.holderCharId === id)) await Data.put('f1_seats', s.id, Object.assign(clone(S.store.f1_seats[s.id]), { holderName: doc.name }));
    }
    if (!prev) { if (!S.isGm || !S.charId) { S.charId = id; lsSet('f1sim.char', id); } await Data.audit('character.new', `${doc.name} started an application as ${charRoleName(doc.role).toLowerCase()}`); }
    closeDrawer();
    if (!prev) { S.ui.charEdit = id; go('character'); }
  }, prev ? 'Character saved.' : 'Character started. Next: their application.');
};
ACTIONS['char-retire'] = d => askConfirm('Retire this character? They leave any seat they hold and stop appearing in your list. Their race results stay in the record books.', 'Retire', () => run(async () => {
  const c = clone(S.store.characters[d.id]); c.retired = true; c.retiredAt = nowIso();
  for (const s of list('f1_seats').filter(x => x.holderCharId === d.id)) await Data.put('f1_seats', s.id, Object.assign(clone(S.store.f1_seats[s.id]), { holderCharId: null, holderName: null, holderSince: null }));
  await Data.put('characters', d.id, c); closeDrawer(); resolveChar();
}, 'Character retired.'), true);

route('characters', 'Your characters', function () {
  const mine = myChars();
  const card = c => { const seat = charSeat(c.id), t = seat ? get('f1_teams', seat.teamId) : null;
    return `<article class="card char-card ${c.id === S.charId ? 'active' : ''}" ${t ? `style="--team:${esc(t.color)}"` : ''}>
      <h2>${esc(c.name)}</h2><p><span class="tag ${charStatus(c) === 'approved' ? 'player' : charStatus(c) === 'pending' ? 'open' : charStatus(c) === 'returned' ? 'flag' : ''}">${esc(STATUS_TEXT[charStatus(c)])}</span></p><p class="meta">${esc(charRoleName(c.role))}${c.nationality ? ', ' + esc(c.nationality) : ''}${c.code ? `, ${esc(c.code)}` : ''}${c.number ? ` #${esc(c.number)}` : ''}</p>
      <p>${seat ? `<b>${esc(seatTitle(seat))}, ${esc(t ? t.name : '')}</b>` : '<span class="muted">No seat yet</span>'}</p>
      ${c.bio ? `<p class="bio">${esc(c.bio.slice(0, 220))}${c.bio.length > 220 ? '…' : ''}</p>` : ''}
      <div class="btn-row">${c.id === S.charId ? '<span class="tag on">Playing now</span>' : `<button class="btn small primary" data-act="char-play" data-id="${esc(c.id)}">Play as ${esc(c.name.split(' ')[0])}</button>`}
        <button class="btn small ${charStatus(c) === 'approved' ? '' : 'primary'}" data-act="char-open" data-id="${esc(c.id)}">${charStatus(c) === 'approved' ? 'Open' : charStatus(c) === 'pending' ? 'View the application' : 'Continue the application'}</button></div></article>`; };
  return `<div class="page-head"><div><h1>Your characters</h1><p>Drivers, team principals, race engineers, journalists and everyone else in the paddock. Each starts as an application to Race Control; drivers roll their ratings. Play as one at a time.</p></div>
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
  /* One seat per series: hand back the character's other seat in this seat's series, whichever series Race Control is looking at. */
  const seriesOfSeat = (get('f1_teams', seat.teamId) || {}).seriesId || 'f1';
  for (const other of list('f1_seats').filter(s => s.holderCharId === charId && s.id !== seatId && ((get('f1_teams', s.teamId) || {}).seriesId || 'f1') === seriesOfSeat))
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
  if (!charApproved(c)) { toast(`Race Control needs to approve ${c.name}’s application before they can apply for a seat.`, true); return; }
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
    await Data.put('f1_applications', newId('app'), { userId: asOwner(), charId: c.id, charName: c.name, seatId: s.id, teamId: s.teamId, role: s.role, note: String(f.note || '').trim(), status: 'pending', createdAt: nowIso() });
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
  return `<div class="f1-occ"><b>${p && p.flag ? esc(p.flag) + ' ' : ''}${p ? careerLink(p.id, o.name) : esc(o.name)}</b> ${chips}${sub}</div>`;
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
    ${(b => b.car ? `<img class="grid-car" src="${esc(b.car)}" alt="${esc(t.name)} car">` : '')(teamBrand(t.id))}
    <header><h2>${(b => b.logo ? `<img class="team-logo" src="${esc(b.logo)}" alt="">` : '')(teamBrand(t.id))}${esc(t.name)}</h2><span class="meta">${esc(engineLabel(t.id))}. AI strategist: ${esc(arch.label.toLowerCase())}.</span>
      ${S.isGm ? `<button class="btn small ghost" data-act="car-edit" data-id="${esc(t.id)}">Car</button>` : ''}</header>
    <ul class="f1-seatlist">${F1.seats(t.id).map(s => `<li><span class="role">${esc(seatTitle(s))}</span>${f1OccupantHtml(s)}${f1SeatControls(s)}</li>`).join('')}</ul>
  </section>`;
}
route('grid', 'The Grid', function () {
  const teams = F1.teams();
  const head = `<div class="page-head"><div><h1>The Grid</h1>
    <p>Today’s real grid is the starting point. When a player’s character takes a seat, they race in place of the real driver, or run the team in place of the real team principal, until the seat is handed back.</p></div></div>`;
  if (!teams.length && curSeriesId() !== 'f1') return head + `<div class="card empty-card"><h2>${esc(curSeries().name)} has no teams yet</h2><p>${S.isGm ? 'Set it up on the Series page.' : 'Race Control hasn’t set it up yet.'}</p></div>`;
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
      v3: f1DevApply(Object.assign({}, F1_ROOKIE, p, { abbr: code, teamId: t.id }), s.holderCharId) });
  }));
  return out;
}
function f1Weather(w, track) {
  const L = track.laps, at = f => Math.max(2, Math.round(L * f));
  if (w.weatherMode === 'dry') return { start: 'dry' };
  if (w.weatherMode === 'mid') return { start: 'dry', changes: [{ lap: at(.35), to: 'damp' }, { lap: at(.41), to: 'wet' }, { lap: at(.55), to: 'damp' }, { lap: at(.63), to: 'dry' }] };
  if (w.weatherMode === 'wet') return { start: 'wet', qualifying: 'wet', changes: [{ lap: at(.18), to: 'damp' }, { lap: at(.34), to: 'dry' }] };
  const pct = raceSettings(w).rainPct;
  if (pct !== 'track' && pct != null) return { mode: 'variable', rainChance: Number(pct) / 100 };
  return FormulaRacingAdapter.weatherFor(track, 'variable');
}
/* The circuit and rules for this weekend, with Race Control's chances for safety cars and failures. */
function f1RaceSetup(w, track) {
  const st = raceSettings(w), circuit = FormulaRacingAdapter.toCircuit(track);
  circuit.sprintLaps = track.sprintLaps;
  const rules = Object.assign({}, F1_RULES, seriesRules(seriesDoc(wSeries(w))), { crashRate: RaceEngine.DEFAULTS.crashRate * st.scRate, failureRate: RaceEngine.DEFAULTS.failureRate * st.failRate });
  /* The season's engine era: lap times, power, battery and boost, fuel, tyres and reliability. */
  const out = engineRaceSetup(w, circuit, rules);
  /* Race incidents: Race Control's settings scale each family; the engine era makes failures likelier or rarer. */
  out.rules.incidents = { crashes: rateNum(st.scRate), failures: rateNum(st.failRate) * engineFormula(wSeries(w), wSeason(w)).fail, outside: rateNum(st.extRate) };
  out.rules.weatherEvents = w.weatherMode !== 'dry';
  return out;
}
function f1NextTrack() {
  const done = new Set(F1.weekends().filter(w => w.status === 'finished' && w.session === 'gp').map(w => w.trackId));
  return F1.tracks().find(t => !done.has(t.id)) || F1.tracks()[0];
}

/* ---------------------------------------------------------------- pit-wall calls and who may make them */
function f1CallAllowed(c, w) {
  const ent = (w.entrants || f1Entrants()).find(e => e.id === c.carId), team = c.teamId || (ent && ent.teamId);
  if (raceLocked(w) && RACE_CALLS.indexOf(c.type) !== -1) return false;
  const seats = F1.seats(team).filter(s => s.holderCharId && s.holderCharId === c.charId);
  if (!seats.length) return false;
  const tp = seats.some(s => s.role === 'principal');
  const own = role => !!ent && seats.some(s => s.role === role && s.car === ent.car);
  switch (c.type) {
    case 'order': return tp;
    case 'setup': return f1CanRun(w, ent, c.charId);
    case 'box': case 'mode': return tp || own('engineer') || own('driver');
    case 'refuseOrder': return own('driver');
    case 'strategy': return tp || own('engineer') || own('driver');
    case 'moment': return own('driver');
    default: return false;
  }
}
const f1Calls = w => list('f1_calls').filter(c => c.weekendId === w.id).sort((a, b) => String(a.at).localeCompare(String(b.at)));
function f1CallText(c, w) {
  const ent = (w.entrants || f1Entrants()).find(e => e.id === c.carId), who = ent ? ent.id : F1.team(c.teamId).name;
  if (c.type === 'box') return `${who}: box for ${c.value === 'auto' ? 'the best tyre' : RaceEngine.COMPOUNDS[c.value].label.toLowerCase() + 's'}`;
  if (c.type === 'mode') return `${who}: ${RaceEngine.MODES[c.value].label.toLowerCase()} mode`;
  if (c.type === 'order') return `${who}: team order, ${c.value === 'none' ? 'free to race' : c.value === 'hold' ? 'hold positions' : 'swap the cars'}`;
  if (c.type === 'refuseOrder') return `${who}: refuses the team order`;
  if (c.type === 'moment') return `${who}: driver’s call made`;
  if (c.type === 'strategy') return `${who}: switch to ${PLAN_NAMES[Number(c.value) || 0]}`;
  if (c.type === 'setup') return `${who}: set-up locked in (${typeof c.value === 'object' ? dialText(c.value) : c.value})`;
  return who;
}
function f1SendCall(call) {
  const w = F1.live(); if (!w || !S.charId) return;
  const doc = Object.assign({ weekendId: w.id, userId: asOwner(), charId: S.charId, at: nowIso(), lap: (w.state && w.state.lap) || 0 }, call);
  if (raceLocked(w) && RACE_CALLS.indexOf(doc.type) !== -1) { toast('This is an official race: nothing can be changed once it starts. Your plans, triggers and race approach are running the car.', true); return; }
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
  if (seasonClosed()) { toast('This season is catalogued. Start the next season on the Seasons page first.', true); return; }
  const session = f.session === 'test' ? 'test' : f.session === 'sprint' && track.hasSprint ? 'sprint' : 'gp', id = newId('f1w');
  const seed = Math.max(1, parseInt(f.seed, 10) || (1 + Math.floor(Math.random() * 999999)));
  run(async () => {
    await Data.put('f1_weekends', id, { seriesId: curSeriesId(), seasonId: curSeasonId(), trackId: track.id, round: track.round, session, seed, weatherMode: f.weatherMode || 'track', status: 'practice', createdAt: nowIso(),
      settings: { lock: f.lock !== false, scRate: rateNum(f.scRate), failRate: rateNum(f.failRate), extRate: rateNum(f.extRate), rainPct: f.rainPct || 'track', practice: f.practice || 'full' } });
    await f1LockProjects();
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
  /* Set-up quality from the dials each team locked in; cars nobody locked in run a standard set-up. */
  const setup = {}, setupBy = {}, setupDials = {}, setupSource = {};
  /* Nothing has to be locked in: the chosen dials, else the latest set-up run, else the set-up from last time. */
  entrants.forEach(e => { if (!playerRun(w, e)) return; const ch = setupChoice(w, e); if (!ch) return;
    setup[e.id] = Math.min(95, f1SetupQuality(w, e.teamId, ch.dials, e) + rapportSetup(f1Rapport(e.teamId, e.car))); setupDials[e.id] = ch.dials; setupSource[e.id] = ch.source; if (ch.by) setupBy[e.id] = ch.by; });
  entrants.forEach(e => { if (setup[e.id] == null) setup[e.id] = f1AiSetup(F1.team(e.teamId)); });
  const rs = f1RaceSetup(w, track), circuit = rs.circuit, weather = f1Weather(w, track);
  const teams = F1.teams().map(t => f1EffectiveTeam(t));
  const entries = FormulaRacingAdapter.toEntries(entrants.map(e => e.v3), teams, track, { setup });
  /* Confidence from practice: up to two tenths a lap. */
  const confidence = {}; entrants.forEach(e => { confidence[e.id] = confidenceAfter(w, e, sessionsOf(w)); const en = entries.find(x => x.id === e.id); if (en) en.paceAdj = (en.paceAdj || 0) - CONF_MAX * confidence[e.id]; });
  engineEfficiency(entrants, entries, w);
  const penalties = f1PuEffects(w, entrants, entries);
  const quali = RaceEngine.qualify({ circuit, entries, weather, seed: w.seed, rules: rs.rules });
  const puLog = [], startGrid = f1PuGrid(quali.grid, penalties, puLog); quali.log = quali.log.concat(puLog);
  const state = RaceEngine.createRace({ circuit, entries, grid: startGrid, weather, seed: w.seed, sprint: w.session === 'sprint', rules: rs.rules });
  const ents = entrants.map(e => { const o = Object.assign({}, e); delete o.v3; return o; });
  const doc = Object.assign(clone(S.store.f1_weekends[w.id]), { status: curSeries().quali === 'single' ? 'grid' : 'quali', qualiStage: curSeries().quali === 'single' ? 3 : 1, entrants: ents, setup, setupBy, setupDials, setupSource, penalties, confidence, weather, quali: { grid: quali.grid, results: quali.results, log: quali.log }, state });
  run(async () => {
    await Data.put('f1_weekends', w.id, doc);
    for (const c of f1Calls(w)) await Data.remove('f1_calls', c.id);
    await Data.audit('f1.qualifying', `Qualifying: ${quali.log[quali.log.length - 1].text}`);
  }, curSeries().quali === 'single' ? 'Qualifying done. The grid is set.' : 'Q1 is done. Run Q2 when you’re ready.');
};

async function f1Advance(laps) {
  const w = F1.live(); if (!w || !w.state || w.state.finished || w.status === 'quali') return null;
  const calls = f1Calls(w), engineCalls = [], notes = [];
  calls.forEach(c => {
    if (c.type === 'setup' || c.type === 'moment' || !f1CallAllowed(c, w)) return;
    const ent = (w.entrants || []).find(e => e.id === c.carId);
    if (c.type === 'order') engineCalls.push({ team: c.teamId, type: 'order', value: c.value });
    else if (c.type === 'box') engineCalls.push({ entry: c.carId, type: 'box', compound: c.value });
    else if (c.type === 'strategy') { const sc = f1StrategyCall(w, c); if (!sc) return; engineCalls.push(sc); }
    else engineCalls.push({ entry: c.carId, type: c.type, value: c.value });
    notes.push({ kind: 'call', ids: ent ? [ent.id] : [], text: 'Pit wall, ' + f1CallText(c, w) });
  });
  /* Driver moments due this lap: the player's choice, or their instinct. */
  const mom = f1MomentCalls(w); engineCalls.push(...mom.calls);
  const stopSc = (S.ui.form.f1stopSc !== false);
  /* At the start, every car with saved plans takes its starting tyre and follows its plan. */
  let st = w.state.lap === 0 ? f1ApplyPlans(w, w.state) : w.state, log = [], lastLog = [];
  for (let i = 0; i < laps && !st.finished; i++) {
    const out = RaceEngine.stepLap(st, i === 0 ? engineCalls : []);
    if (i === 0 && notes.length) { notes.forEach(n => { n.lap = out.state.lap; }); out.state.events = out.state.events.slice(0, out.state.events.length - out.log.length).concat(notes, out.log); }
    st = out.state; log = log.concat(out.log); lastLog = out.log;
    if (stopSc && i < laps - 1 && out.log.some(l => l.kind === 'red' || ((l.kind === 'sc' || l.kind === 'vsc') && /deployed/.test(l.text)))) break;
  }
  const doc = Object.assign(clone(S.store.f1_weekends[w.id]), { status: st.finished ? 'finished' : 'running', state: st, live: !!S.f1live && !st.finished });
  /* Moments: record how the settled ones went, drop any that were missed, and look for new ones (one lap at a time only). */
  const settled = new Map(mom.resolved.map(m => [m.id, m]));
  doc.moments = (w.moments || []).map(m => { const r = settled.get(m.id); if (r) { const ev = log.find(l => l.kind === 'moment' && (l.ids || [])[0] === m.carId); return Object.assign(r, { outcome: ev ? ev.text : 'Nothing came of it.' }); }
    return !m.resolved && m.lap <= st.lap ? Object.assign({}, m, { resolved: true, expired: true }) : m; });
  if (laps === 1 && S.ui.form.f1moments !== false) doc.moments = doc.moments.concat(f1NewMoments(Object.assign({}, w, { moments: doc.moments }), st, lastLog));
  if (st.finished) {
    const byId = new Map((w.entrants || []).map(e => [e.id, e]));
    doc.results = RaceEngine.classify(st).map(r => Object.assign({}, r, byId.get(r.id) || {}));
    doc.finishedAt = nowIso();
  }
  const ok = await run(async () => {
    await Data.put('f1_weekends', w.id, doc);
    for (const c of calls) await Data.remove('f1_calls', c.id);
    if (st.finished) await Data.audit('f1.result', (log.find(l => l.kind === 'finish') || {}).text || 'Race finished');
  }, st.finished ? 'Chequered flag. The result counts towards the championship.' : null);
  return ok ? log : null;
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
      if (S.ui.wkCarNow && e.id !== S.ui.wkCarNow) return;
      const can = type => f1CallAllowed({ type, carId: e.id, teamId: null, charId: S.charId }, w);
      const car = st ? st.cars.find(c => c.id === e.id) : null;
      if (w.status === 'practice') {
        if (can('setup')) { h += f1PracticeHtml(w, e, t, f1Calls(w)); return; }
        /* A driver whose car has a player engineer follows the programme without running it. */
        if (seats.some(s => s.teamId === tid && s.role === 'driver' && s.car === e.car)) h += f1PracticeHtml(w, e, t, f1Calls(w), true);
        return;
      }
      if (!car || w.status === 'finished' || w.status === 'quali' || !st) return;
      if (st.lap === 0 && (can('setup') || seats.some(s => s.teamId === tid))) h += `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(e.name)}</h3>${qualiDebriefHtml(w, Object.assign({}, e, { v3: (f1Entrants().find(x => x.id === e.id) || {}).v3 }))}</div>`;
      if (car.status !== 'running') { h += `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(e.name)}</h3><p class="muted">Out: ${esc(car.dnf)}</p></div>`; return; }
      const life = RaceEngine.tyreLife(car.tyre.compound, car, st.circuit), wear = Math.min(100, Math.round(car.tyre.wear / life * 100)), pos = f1Order(st).indexOf(car) + 1;
      const pend = type => mine.find(c => c.type === type && c.carId === e.id);
      const pb = pend('box'), pm = pend('mode');
      h += `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(e.name)}</h3>
        <p class="muted small" style="margin:0">P${pos}, ${RaceEngine.COMPOUNDS[car.tyre.compound].label.toLowerCase()}s ${car.tyre.age} laps old, ${plural(car.stops, 'stop')}</p>
        <div class="f1-gauges"><div class="f1-gauge">Tyre wear ${wear}%<div class="track"><div class="fill ${wear >= 90 ? 'hot' : ''}" style="width:${wear}%"></div></div></div>
          ${st.rules.noHybrid ? `<div class="f1-gauge">${esc(engineFormula(wSeries(w), wSeason(w)).short)}: no battery</div></div>` : `<div class="f1-gauge">Battery ${Math.round(car.energy)}%<div class="track"><div class="fill" style="width:${car.energy}%"></div></div></div></div>`}
        ${can('mode') ? `<div class="f1-row"><span class="lbl">Mode</span>${['push', 'standard', 'manage'].map(m => `<button class="btn small" data-act="f1-call" data-type="mode" data-car="${esc(e.id)}" data-value="${m}" aria-pressed="${(pm ? pm.value : car.mode) === m}">${RaceEngine.MODES[m].label}</button>`).join('')}</div>` : ''}
        ${can('box') ? `<div class="f1-row"><span class="lbl">Box</span>${['soft', 'medium', 'hard', 'inter', 'wet'].map(k => `<button class="btn small" data-act="f1-call" data-type="box" data-car="${esc(e.id)}" data-value="${k}" aria-pressed="${!!(pb && pb.value === k)}">${f1TyreChip(k)} ${k === 'inter' ? 'Inter' : RaceEngine.COMPOUNDS[k].label}</button>`).join('')}</div>` : ''}
        ${can('refuseOrder') && st.orders[tid] ? `<div class="f1-row"><span class="lbl">Order</span><span class="small">The team says: ${st.orders[tid].value === 'hold' ? 'hold position' : 'swap the cars'}.</span><button class="btn small" data-act="f1-call" data-type="refuseOrder" data-car="${esc(e.id)}" aria-pressed="${!!pend('refuseOrder')}">Refuse the order</button></div>` : ''}
      </div>`;
    });
    if (tp && st && w.status === 'running' && !raceLocked(w)) {
      const cur = st.orders[tid] ? st.orders[tid].value : 'none', po = mine.find(c => c.type === 'order' && c.teamId === tid), v = po ? po.value : cur;
      h += `<div class="f1-row" style="border-top:1px solid var(--line);padding-top:10px"><span class="lbl">Orders</span>${[['none', 'Free to race'], ['hold', 'Hold positions'], ['swap', 'Swap the cars']].map(([k, l]) => `<button class="btn small" data-act="f1-call" data-type="order" data-team="${esc(tid)}" data-value="${k}" aria-pressed="${v === k}">${l}</button>`).join('')}</div>`;
    }
  });
  if (!h) return '';
  const pendingList = mine.filter(c => c.type !== 'setup' || w.status === 'practice');
  return `<section class="card" style="margin-bottom:16px"><h2>Your pit wall <span class="sub">${seats.map(s => `${F1_ROLE[s.role]}, ${F1.team(s.teamId).name}`).join('; ')}</span></h2>${h}
    ${pendingList.length ? `<p class="small" style="margin-top:10px"><b>Waiting for Race Control:</b> ${pendingList.map(c => `${esc(f1CallText(c, w))} <button class="btn small" data-act="f1-call-withdraw" data-id="${esc(c.id)}">Withdraw</button>`).join(' ')}</p>` : ''}
    ${w.status === 'practice' ? '' : `<p class="muted small">`}${w.status === 'practice' ? '' : (raceLocked(w) ? 'Official race: no changes from the pit wall. Your plans, triggers and race approach are running the car.' : 'Calls apply when Race Control runs the next lap. Anything you don’t call, the team’s plan decides.') + '</p>'}</section>`;
}

function f1OpenFormHtml() {
  const tracks = F1.tracks(); if (!tracks.length) return '';
  if (seasonClosed()) return `<section class="card"><h2>Between seasons</h2><p>${esc(curSeason().name)} is catalogued. Start the next season on the Seasons page to open weekends again.</p><button class="btn primary" data-act="nav" data-route="seasons">Seasons</button></section>`;
  const f = S.ui.form.f1w = S.ui.form.f1w || { trackId: (f1NextTrack() || {}).id, session: 'gp', weatherMode: 'track', seed: '', rainPct: 'track', scRate: '1', failRate: '1', extRate: '1', lock: true, practice: 'full' };
  const t = F1.track(f.trackId) || tracks[0];
  return `<section class="card"><h2>Open the next weekend</h2>
    <div class="metrics" style="align-items:end">
      <label class="field">Circuit${sel('f1w-track', 'ui/form/f1w/trackId', f.trackId, tracks.map(x => [x.id, `Round ${x.round}: ${x.name}`]))}</label>
      <label class="field">Session${sel('f1w-session', 'ui/form/f1w/session', f.session, [['gp', 'Grand Prix']].concat(t.hasSprint ? [['sprint', 'Sprint']] : [], [['test', 'Pre-season testing']]))}</label>
      <label class="field">Weather${sel('f1w-weather', 'ui/form/f1w/weatherMode', f.weatherMode, F1_WEATHER)}</label>
      <label class="field">Seed (optional)<input id="f1w-seed" type="number" min="1" data-bind="ui/form/f1w/seed" value="${esc(f.seed || '')}" placeholder="Random"></label>
    </div>
    ${randomnessHtml('f1w', f, t)}
    <label class="field" style="max-width:520px">Practice${sel('f1w-practice', 'ui/form/f1w/practice', f.practice || 'full', [['full', 'Full sessions: run like qualifying, with weather and incidents'], ['quick', 'Quick: runs report straight away, always dry']])}</label>
    <label class="small"><input type="checkbox" data-bind="ui/form/f1w/lock" ${f.lock !== false ? 'checked' : ''}> Official race: no pit-wall changes once it starts. The teams’ plans, triggers and race approaches run the cars.</label>
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
  const head = `<div class="page-head"><div><h1>Championship</h1><p>${esc(curSeries().name)}, ${esc(curSeason().name)} season. ${races ? `After ${races} Grand Prix${races === 1 ? '' : ' weekends'}${F1.weekends().some(w => w.status === 'finished' && w.session === 'sprint') ? ' and the sprints' : ''}. Points go to whoever drove the car that weekend.` : 'No races yet. Standings appear after the first chequered flag.'}</p></div>${s.drivers.length ? '<div class="btn-row"><button class="btn" data-act="share-open" data-kind="drivers">Export standings</button></div>' : ''}</div>`;
  if (!s.drivers.length) return head;
  return head + `<div class="cols2" style="align-items:start"><section class="card"><h2>Drivers</h2><div class="scroll-x"><table class="data"><thead><tr><th>Pos</th><th>Driver</th><th>Team</th><th class="num">Wins</th><th class="num">Podiums</th><th class="num">Points</th></tr></thead><tbody>${s.drivers.map((d, i) =>
      `<tr${S.charId && d.charId === S.charId ? ' class="me"' : ''}><td><b>${i + 1}</b></td><td>${careerLink(d.personId, d.name)}${d.charId ? ' <span class="tag player">Player</span>' : ''}</td><td><span class="f1-bar" style="background:${esc(f1Colour(d.teamId))}"></span>${esc(F1.team(d.teamId).name)}</td><td class="num">${d.wins}</td><td class="num">${d.podiums}</td><td class="num"><b>${d.pts}</b></td></tr>`).join('')}</tbody></table></div></section>
    <section class="card"><h2>Constructors</h2><div class="scroll-x"><table class="data"><thead><tr><th>Pos</th><th>Team</th><th class="num">Wins</th><th class="num">Points</th></tr></thead><tbody>${s.teams.map((t, i) =>
      `<tr><td><b>${i + 1}</b></td><td><span class="f1-bar" style="background:${esc(f1Colour(t.teamId))}"></span>${esc(F1.team(t.teamId).name)}</td><td class="num">${t.wins}</td><td class="num"><b>${t.pts}</b></td></tr>`).join('')}</tbody></table></div></section></div>`;
});

/* =====================================================================
   F1 SIM — roles: the race engineer's practice programme, the team
   principal's budget and upgrades, and driver careers.
   Everything here is worked out from the records each time it's needed,
   and checked against the seats, so a player can't make a car faster by
   writing a number: upgrades count only once Race Control has locked
   them in, and development points only up to what the races started have earned.
   ===================================================================== */
'use strict';

const F1_RULES = { setupCoef: 0.01 };   // a perfect set-up against a poor one: about three tenths a lap
const h32 = (...parts) => { let h = 2166136261; parts.join('|').split('').forEach(ch => { h = Math.imul(h ^ ch.charCodeAt(0), 16777619); }); return h >>> 0; };
const roll = (...parts) => RaceEngine.rng(h32(...parts))();
const clampN = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const f1Gauss = r => { const u = 1 - r(), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const finishedGps = () => F1.weekends().filter(w => w.status === 'finished' && w.session === 'gp').sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
const finishedAll = () => F1.weekends().filter(w => w.status === 'finished').sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));

/* ================================================================ practice programme */
const DIALS = [['wing', 'Downforce', 'low', 'high'], ['susp', 'Suspension', 'soft', 'stiff'], ['diff', 'Differential', 'open', 'locked']];
const TYPE_IDEAL = { 'low-downforce': { wing: 18, susp: 62 }, 'high-speed': { wing: 40, susp: 70 }, mixed: { wing: 55, susp: 52 },
  technical: { wing: 70, susp: 45 }, 'high-downforce': { wing: 78, susp: 50 }, street: { wing: 85, susp: 30 } };
const F1_RUNS_PER_CAR = 4;
/* Each team's ideal set-up for the weekend: the circuit decides roughly where it is, the car moves it. Nobody sees it. */
function f1Ideal(w, teamId) {
  const t = F1.track(w.trackId) || {}, b = TYPE_IDEAL[t.type] || TYPE_IDEAL.mixed, r = k => roll(w.seed, teamId, k);
  return { wing: clampN(Math.round(b.wing + (r('w') - 0.5) * 24), 5, 95), susp: clampN(Math.round(b.susp + (r('s') - 0.5) * 30), 5, 95), diff: Math.round(25 + r('d') * 50) };
}
function f1SetupQuality(w, teamId, dials, ent) {
  if (!dials || typeof dials !== 'object') return null;
  /* With the car known, the driver's style moves the ideal. */
  const i = ent ? f1IdealFor(w, ent) : f1Ideal(w, teamId), d = k => Math.abs(clampN(Number(dials[k]) || 50, 0, 100) - i[k]);
  return clampN(Math.round(95 - d('wing') * 0.5 - d('susp') * 0.4 - d('diff') * 0.3), 20, 95);
}
/* Cars nobody works on run a competent standard set-up, a little better at the bigger teams. */
const f1AiSetup = team => clampN(Math.round(62 + ((team.carPace || 80) - 80) * 0.3), 50, 75);
/* Who may use a car's practice runs: the team principal, the car's race engineer, or its driver if no player engineers it. */
function f1CanRun(w, ent, charId) {
  if (!ent || !charId) return false;
  const seats = F1.seats(ent.teamId).filter(s => s.holderCharId === charId); if (!seats.length) return false;
  if (seats.some(s => s.role === 'principal') || seats.some(s => s.role === 'engineer' && s.car === ent.car)) return true;
  const eng = F1.seats(ent.teamId).find(s => s.role === 'engineer' && s.car === ent.car);
  return seats.some(s => s.role === 'driver' && s.car === ent.car) && !(eng && eng.holderCharId);
}
/* Runs count in the order they were made, up to the limit per car. */
const f1Runs = (w, carId) => list('f1_runs').filter(r => r.weekendId === w.id && r.carId === carId).sort((a, b) => String(a.at).localeCompare(String(b.at)));
function f1Lap(circuit, entry, setup) {
  return circuit.baseLap - (RaceEngine.carScore(entry.car, circuit) - 85) * RaceEngine.DEFAULTS.carCoef - (entry.driver.pace - 85) * RaceEngine.DEFAULTS.driverCoef - (setup - 60) * F1_RULES.setupCoef;
}
const ADJ = d => Math.abs(d) < 12 ? 'a touch' : Math.abs(d) < 25 ? 'a bit' : 'a lot';
const NOTES = {
  wing: [d => `Draggy on the straights. Take ${ADJ(d)} of wing off.`, d => `Light and nervous in the fast corners. Add ${ADJ(d)} more wing.`],
  susp: [d => `Skipping over the bumps and kerbs. Soften it ${ADJ(d)}.`, d => `Lazy changing direction. Stiffen it ${ADJ(d)}.`],
  diff: [d => `Pushing wide on the way out of corners. Open the diff ${ADJ(d)}.`, d => `Snappy on the throttle out of the slow corners. Lock the diff ${ADJ(d)}.`]
};
/* What a run tells the team. Pure: the same run always says the same thing. Experienced drivers give clearer feedback. */
function f1RunResult(w, ent, run) {
  /* Full practice: nothing to report until the session has run; lost runs report why; conditions change what a run tells you. */
  const ctx = runContext(w, run); if (ctx && ctx.pending) return { pending: true }; if (ctx && ctx.lost) return { lost: ctx.lost };
  const cond = (ctx && ctx.cond) || 'dry', wp = WET_PEN[cond];
  const track = F1.track(w.trackId), circuit = FormulaRacingAdapter.toCircuit(track), r = RaceEngine.rng(h32(w.seed, ent.id, run.id));
  const team = f1EffectiveTeam(F1.team(ent.teamId)), entry = FormulaRacingAdapter.toEntries([ent.v3], [team], track, {})[0];
  const noise = (2 + (100 - (ent.v3.experience || 50)) / 12) * rapportNoise(f1Rapport(ent.teamId, ent.car));
  if (run.kind === 'setup') {
    const i = f1IdealFor(w, ent), q = f1SetupQuality(w, ent.teamId, run.dials, ent);
    const notes = DIALS.map(([k, label]) => { const d = (Number(run.dials[k]) || 50) - i[k] + f1Gauss(r) * noise * (cond === 'dry' ? 1 : 2.5);
      return `${label}: ${Math.abs(d) < 5 ? 'feels right.' : NOTES[k][d > 0 ? 0 : 1](d).replace(/^./, c => c.toLowerCase())}`; });
    return { lap: f1Lap(circuit, entry, q) + 0.8 + wp + f1Gauss(r) * 0.08, cond, q, notes: cond === 'dry' ? notes : [`The track was ${cond}: the balance is hard to read, so treat this feedback with care.`].concat(notes) };
  }
  if (run.kind === 'long') {
    const c = RaceEngine.COMPOUNDS[run.compound] ? run.compound : 'medium';
    if (cond !== 'dry' && !RaceEngine.COMPOUNDS[c].wet) return { cond, wet: true, compound: cond === 'wet' ? 'wet' : 'inter', life: null, lap: f1Lap(circuit, entry, 60) + 2.2 + wp + f1Gauss(r) * 0.2 };
    const life = RaceEngine.tyreLife(c, { driver: entry.driver, car: entry.car }, circuit) * (1 + f1Gauss(r) * 0.03 * noise / 4);
    return { compound: c, life: Math.max(4, Math.round(life)), lap: f1Lap(circuit, entry, 60) + RaceEngine.COMPOUNDS[c].offset + 2.2 + wp + f1Gauss(r) * 0.1, cond };
  }
  /* Qualifying simulation: one lap against everyone else's likely pace. */
  const last = f1Runs(w, ent.id).filter(x => x.kind === 'setup' && x.at <= run.at).pop();
  const mySetup = last ? f1SetupQuality(w, ent.teamId, last.dials, ent) : f1AiSetup(team);
  const teams = F1.teams().map(t => f1EffectiveTeam(t));
  const all = FormulaRacingAdapter.toEntries(f1Entrants().map(e => e.v3), teams, track, {});
  const mine = f1Lap(circuit, entry, mySetup);
  const faster = all.filter(e => e.id !== ent.id).filter(e => f1Lap(circuit, e, f1AiSetup(F1.team(e.team))) < mine).length;
  const pos = clampN(faster + 1 + Math.round(f1Gauss(r) * 1.2), 1, all.length);
  const spread = cond === 'dry' ? 1 : 4;
  return { lap: mine - RaceEngine.DEFAULTS.fuelEffect - 0.35 + wp + f1Gauss(r) * 0.06, from: Math.max(1, pos - spread), to: Math.min(all.length, pos + spread), cond };
}
ACTIONS['f1-run'] = d => {
  const w = F1.live(), c = currentChar(); if (!w || w.status !== 'practice' || !c) return;
  const ent = f1Entrants().find(e => e.id === d.car);
  if (!f1CanRun(w, ent, c.id)) { toast('Your seat doesn’t run this car.', true); return; }
  if (endedSessions(w).length >= sessionsOf(w)) { toast('Practice is over. Qualifying is next.', true); return; }
  if (runsIn(w, ent.id, curSession(w)).length >= runsPerSession(w)) { toast(`This car has used its ${runsPerSession(w)} runs in ${sessionName(w, curSession(w))}. More in the next session.`, true); return; }
  const dials = Object.assign({ wing: 50, susp: 50, diff: 50 }, (S.ui.form.f1d || {})[ent.id] || {});
  DIALS.forEach(([k]) => { dials[k] = clampN(Math.round(Number(dials[k]) || 0), 0, 100); });
  const compound = ((S.ui.form.f1long || {})[ent.id]) || 'medium';
  run(async () => { await Data.put('f1_runs', newId('run'), { userId: asOwner(), charId: c.id, weekendId: w.id, carId: ent.id, session: curSession(w), kind: d.kind, dials, compound, at: nowIso() }); },
    fullPractice(w) ? `Run planned for ${sessionName(w, curSession(w))}. Results come when Race Control runs the session.` : d.kind === 'setup' ? 'Run done. Read what the driver said.' : 'Run done.');
};
ACTIONS['f1-lock'] = d => {
  const dials = Object.assign({ wing: 50, susp: 50, diff: 50 }, (S.ui.form.f1d || {})[d.car] || {});
  DIALS.forEach(([k]) => { dials[k] = clampN(Math.round(Number(dials[k]) || 0), 0, 100); });
  f1SendCall({ type: 'setup', carId: d.car, value: dials });
};
const dialText = v => DIALS.map(([k, l]) => `${l.toLowerCase()} ${v[k]}`).join(', ');
function f1PracticeHtml(w, e, t, mine, ro) {
  const runs = f1Runs(w, e.id), over = endedSessions(w).length >= sessionsOf(w), n = curSession(w), left = over ? 0 : runsPerSession(w) - runsIn(w, e.id, n).length;
  const form = S.ui.form.f1d = S.ui.form.f1d || {};
  if (!form[e.id]) { const lastSetup = runs.filter(x => x.kind === 'setup').pop(); form[e.id] = Object.assign({ wing: 50, susp: 50, diff: 50 }, lastSetup ? lastSetup.dials : {}); }
  const f = form[e.id], locked = mine.find(c => c.type === 'setup' && c.carId === e.id);
  const long = (S.ui.form.f1long = S.ui.form.f1long || {})[e.id] || 'medium';
  const ent = Object.assign({}, e, { v3: (f1Entrants().find(x => x.id === e.id) || {}).v3 });
  /* One run, as a line. */
  const runLine = r => { const x = f1RunResult(w, ent, r);
    const sn = `<span class="muted small">${sessionName(w, r.session || 1)}</span> `, kl = r.kind === 'setup' ? `set-up run (${esc(dialText(r.dials))})` : r.kind === 'long' ? `long run on ${esc(RaceEngine.COMPOUNDS[r.compound] ? RaceEngine.COMPOUNDS[r.compound].label.toLowerCase() : 'medium')}s` : 'qualifying simulation';
    const wt = x.cond && x.cond !== 'dry' ? ` <span class="tag">${esc(x.cond)} track</span>` : '';
    if (x.pending) return `<li>${sn}<b>Planned:</b> ${kl}. It runs when Race Control runs ${esc(sessionName(w, r.session || 1))}. ${ro ? '' : `<button class="btn small ghost" data-act="run-cancel" data-id="${esc(r.id)}">Take it off the plan</button>`}</li>`;
    if (x.lost) return `<li>${sn}<b>Lost:</b> ${kl}. ${esc(x.lost)}</li>`;
    if (x.wet) return `<li>${sn}<b>Long run</b>${wt}: too wet for slicks, so it ran on ${x.compound === 'wet' ? 'full wets' : 'intermediates'}. No dry tyre data. Average lap ${f1Fmt(x.lap)}.</li>`;
    if (r.kind === 'setup') return `<li>${sn}<b>Set-up run</b> (${esc(dialText(r.dials))})${wt}: ${f1Fmt(x.lap)}<ul>${x.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></li>`;
    if (r.kind === 'long') return `<li>${sn}<b>Long run on ${esc(RaceEngine.COMPOUNDS[x.compound].label.toLowerCase())}s</b>: about ${x.life} laps before the time falls away. Average lap ${f1Fmt(x.lap)} on full tanks.</li>`;
    return `<li>${sn}<b>Qualifying simulation</b>${wt}: ${f1Fmt(x.lap)}, which looks like P${x.from} to P${x.to} on one lap.</li>`; };
  const focus = over ? Math.max(1, ...runs.map(r => r.session || 1), 1) : n;
  const now = runs.filter(r => (r.session || 1) === focus).slice().reverse().map(runLine).join(''), earlier = runs.filter(r => (r.session || 1) !== focus).slice().reverse();
  const choice = setupChoiceText(w, ent);
  return `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(e.name)}</h3>
    <p class="muted small"><b>${over ? 'Practice is over' : esc(sessionName(w, n))}</b>${over ? '' : `: ${left ? plural(left, 'run') + ' left' : 'all runs used; more in the next session'}`}.${fullPractice(w) && !over ? ` Planned runs play out when Race Control runs the session. ${esc(practiceForecastText(w))}` : ''}</p>
    ${ro ? `<p class="small">${esc((F1.seats(e.teamId).find(s => s.role === 'engineer' && s.car === e.car) || {}).holderName || 'Your race engineer')} runs this car’s practice. Here’s what’s planned, what you’ve told them, and the debriefs.</p>` : ''}
    ${setupGuideHtml(w, ent, ro)}
    ${ro ? '' : `<div class="dials">${DIALS.map(([k, l, lo, hi]) => `<label class="field">${l} <span class="muted">(0 ${lo}, 100 ${hi})</span><input id="f1d-${esc(e.id)}-${k}" type="number" min="0" max="100" step="1" value="${esc(f[k])}" data-bind="ui/form/f1d/${esc(e.id)}/${k}" data-type="number"></label>`).join('')}</div>
    <div class="btn-row"><button class="btn primary" data-act="f1-run" data-kind="setup" data-car="${esc(e.id)}" ${left ? '' : 'disabled'}>${fullPractice(w) ? 'Plan a set-up run' : 'Set-up run'}</button>
      <label class="sr-only" for="f1long-${esc(e.id)}">Tyre for the long run</label>${sel('f1long-' + e.id, 'ui/form/f1long/' + e.id, long, [['soft', 'Softs'], ['medium', 'Mediums'], ['hard', 'Hards']])}
      <button class="btn" data-act="f1-run" data-kind="long" data-car="${esc(e.id)}" ${left ? '' : 'disabled'}>${fullPractice(w) ? 'Plan a long run' : 'Long run'}</button>
      <button class="btn" data-act="f1-run" data-kind="quali" data-car="${esc(e.id)}" ${left ? '' : 'disabled'}>${fullPractice(w) ? 'Plan a qualifying simulation' : 'Qualifying simulation'}</button></div>`}
    ${now ? `<h4>${esc(sessionName(w, focus))}</h4><ul class="runs">${now}</ul>` : ''}
    ${S.ui.wkRail ? '' : practiceDebriefsHtml(w, ent)}
    ${earlier.length ? `<details><summary>Earlier runs (${earlier.length})</summary><ul class="runs">${earlier.map(runLine).join('')}</ul></details>` : ''}
    <div class="quali-setup"><p class="small"><b>For qualifying:</b> ${esc(choice)} ${locked ? '' : '<span class="muted">Nothing needs locking in.</span>'}</p>
      ${ro ? '' : `<button class="btn small" data-act="f1-lock" data-car="${esc(e.id)}">${locked ? 'Use these dials instead' : 'Use these dials for qualifying'}</button>`}</div></div>`;
}

/* ================================================================ team budget and upgrades */
const F1_BUDGET = 30;   // £m for development across the season
const F1_PROJECTS = {
  frontwing: { label: 'Front wing update', cost: 4, build: 1, odds: 0.85, fx: { carPace: 0.8 }, note: 'A small, safe step everywhere.' },
  floor: { label: 'New floor', cost: 9, build: 2, odds: 0.65, fx: { carPace: 1.8 }, note: 'The big one. Takes longer and might not work.' },
  lowdrag: { label: 'Low-drag package', cost: 5, build: 1, odds: 0.8, fx: { topSpeed: 1.5, cornering: -0.5 }, note: 'Quicker on the straights, at a cost in the corners.' },
  highdf: { label: 'High-downforce package', cost: 5, build: 1, odds: 0.8, fx: { cornering: 1.5, topSpeed: -0.5 }, note: 'Quicker in the corners, slower on the straights.' },
  pumode: { label: 'Power unit modes', cost: 6, build: 2, odds: 0.7, fx: { topSpeed: 1.2, reliability: -1.5 }, note: 'More power, a little more fragile.' },
  reliability: { label: 'Reliability programme', cost: 4, build: 1, odds: 0.9, fx: { reliability: 3 }, note: 'Fewer failures.' },
  suspension: { label: 'Suspension rework', cost: 5, build: 2, odds: 0.75, fx: { tyreLife: 3 }, note: 'Kinder to the tyres: longer stints.' },
  pitcrew: { label: 'Pit crew training', cost: 2, build: 1, odds: 0.95, fx: { pitSpeed: 2 }, note: 'Quicker, more reliable stops.' }
};
const FX_NAMES = { carPace: 'overall pace', topSpeed: 'top speed', cornering: 'cornering', reliability: 'reliability', tyreLife: 'kindness to tyres', pitSpeed: 'pit stops' };
const fxText = fx => Object.keys(fx).map(k => `${fx[k] > 0 ? '+' : '−'}${Math.abs(fx[k])} ${FX_NAMES[k]}`).join(', ');
const projectWorks = p => roll(p.id, 'works') < (F1_PROJECTS[p.type] || { odds: 0 }).odds;
const projectArrived = (p, n) => !!p.locked && n >= p.lockedAt + (F1_PROJECTS[p.type] || { build: 99 }).build;
const tpSeat = teamId => F1.seats(teamId).find(s => s.role === 'principal');
const teamProjects = teamId => list('f1_projects').filter(p => p.teamId === teamId && F1_PROJECTS[p.type] && recSeason(p) === curSeasonId()).sort((a, b) => String(a.at).localeCompare(String(b.at)));
/* Teams without a player in charge develop too: one project every second race, until a player takes over. */
function aiProjects(teamId, n) {
  if (!curSeries().development) return [];
  const tp = tpSeat(teamId), since = tp && tp.holderCharId ? tp.holderSince : null, gps = finishedGps(), keys = Object.keys(F1_PROJECTS), out = [];
  for (let i = 2; i <= n; i += 2) {
    const gp = gps[i - 1]; if (since && gp && String(gp.finishedAt) > String(since)) break;
    const type = keys[Math.floor(roll(teamId, 'ai', i) * keys.length)];
    out.push({ id: `ai-${teamId}-${i}`, type, ai: true, locked: true, lockedAt: i, works: roll(teamId, 'ai-works', i) < F1_PROJECTS[type].odds });
  }
  return out;
}
/* The car for race n+1 (n races finished): the team's base numbers plus whatever has arrived. */
function f1EffectiveTeam(team, n) {
  if (!team) return team;
  n = n == null ? finishedGps().length : n;
  const out = Object.assign({}, team), applied = [];
  engineApply(team, out);   /* the season's engine maker */
  if (!curSeries().development) { Object.defineProperty(out, 'applied', { value: [], enumerable: false }); return out; }
  teamProjects(team.id).filter(p => projectArrived(p, n)).concat(aiProjects(team.id, n).filter(p => n >= p.lockedAt)).forEach(p => {
    const def = F1_PROJECTS[p.type], works = p.ai ? p.works : projectWorks(p), k = works ? 1 : 0.25;
    Object.keys(def.fx).forEach(s => { out[s] = Math.round(((out[s] || 0) + def.fx[s] * k) * 100) / 100; });
    applied.push(Object.assign({}, p, { works }));
  });
  teamDevApply(team.id, out, n);
  Object.defineProperty(out, 'applied', { value: applied, enumerable: false });
  return out;
}
/* Sponsors expect results in line with the car: the quickest car aims for P2, the slowest for P15. */
function sponsorTarget(teamId) {
  const order = F1.teams().slice().sort((a, b) => (b.carPace || 0) - (a.carPace || 0)).map(t => t.id), i = Math.max(0, order.indexOf(teamId));
  return Math.min(15, 2 + Math.round(i * 1.3));
}
function f1TeamMoney(teamId) {
  const lines = [], target = sponsorTarget(teamId);
  finishedAll().forEach(w => {
    const rs = (w.results || []).filter(r => r.teamId === teamId), pts = rs.reduce((s, r) => s + (r.points || 0), 0), t = F1.track(w.trackId) || {};
    let amt = Math.round(((w.session === 'gp' ? 1 : 0) + pts * 0.05) * 100) / 100, best = Math.min(...rs.map(r => r.position || 99));
    const bonus = w.session === 'gp' && best <= target && !f1Sponsor(teamId) ? 0.8 : 0;
    if (amt + bonus > 0) lines.push({ text: `${t.name || ''}${w.session === 'sprint' ? ' sprint' : ''}: ${pts} points${bonus ? `, sponsor target met (P${best})` : ''}`, amt: Math.round((amt + bonus) * 100) / 100 });
  });
  const ex = f1TeamExtras(teamId); ex.lines.forEach(l => lines.push(l));
  const income = lines.filter(l => l.amt > 0).reduce((s, l) => s + l.amt, 0);
  const spent = teamProjects(teamId).filter(p => p.locked).reduce((s, p) => s + F1_PROJECTS[p.type].cost, 0) - lines.filter(l => l.amt < 0).reduce((s, l) => s + l.amt, 0);
  const budget = curSeries().budget == null ? F1_BUDGET : curSeries().budget;
  return { budget, income: Math.round(income * 100) / 100, spent: Math.round(spent * 100) / 100, left: Math.round((budget + income - spent) * 100) / 100, lines, target };
}
/* Race Control locks in what each team principal ordered when it opens a weekend: checked against the seat, the budget and two projects at a time. */
async function f1LockProjects() {
  const n = finishedGps().length, done = [];
  for (const t of F1.teams()) {
    const tp = tpSeat(t.id), money = f1TeamMoney(t.id); let left = money.left;
    let building = teamProjects(t.id).filter(p => p.locked && !projectArrived(p, n)).length;
    for (const p of teamProjects(t.id).filter(x => !x.locked && !x.rejected)) {
      const def = F1_PROJECTS[p.type], doc = clone(S.store.f1_projects[p.id]);
      if (!tp || !tp.holderCharId || p.charId !== tp.holderCharId) Object.assign(doc, { rejected: 'Ordered by someone who isn’t the team principal now.' });
      else if (def.cost > left) Object.assign(doc, { rejected: `Not enough budget: £${left}m left.` });
      else if (building >= 2) Object.assign(doc, { rejected: 'Two projects are already being built.' });
      else { Object.assign(doc, { locked: true, lockedAt: n, lockedOn: nowIso() }); left -= def.cost; building += 1; done.push(`${t.name}: ${def.label}`); }
      await Data.put('f1_projects', p.id, doc);
    }
  }
  if (done.length) await Data.audit('upgrades.lock', 'Upgrades started: ' + done.join('; '));
}
ACTIONS['proj-order'] = d => {
  const c = currentChar(), seat = c && tpSeat(d.team); if (!c || !seat || seat.holderCharId !== c.id) { toast('Only the team principal orders upgrades.', true); return; }
  const def = F1_PROJECTS[d.type], money = f1TeamMoney(d.team), pending = teamProjects(d.team).filter(p => !p.locked && !p.rejected).reduce((s, p) => s + F1_PROJECTS[p.type].cost, 0);
  if (def.cost > money.left - pending) { toast(`Not enough budget: £${Math.round((money.left - pending) * 100) / 100}m left after what you’ve already ordered.`, true); return; }
  run(async () => { await Data.put('f1_projects', newId('proj'), { userId: asOwner(), charId: c.id, teamId: d.team, type: d.type, seasonId: curSeasonId(), at: nowIso() }); }, `${def.label} ordered. It starts when Race Control opens the next weekend.`);
};
ACTIONS['proj-cancel'] = d => run(async () => { await Data.remove('f1_projects', d.id); }, 'Order cancelled.');

/* ================================================================ driver careers */
const DEV_ATTRS = F1_RATINGS.map(r => r[0]).filter(k => k !== 'experience');
const devCost = v => v < 80 ? 1 : v < 90 ? 2 : 3;
/* Each person's race-by-race record, from the results. */
function f1Record(personId) {
  const out = [];
  F1.allWeekends().filter(w => w.status === 'finished').sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt))).forEach(w => {
    const r = (w.results || []).find(x => x.personId === personId); if (!r) return;
    const mate = (w.results || []).find(x => x.teamId === r.teamId && x.personId !== personId);
    const pole = w.quali && w.quali.grid && w.quali.grid[0] === r.id;
    out.push({ w, r, mate, pole, beat: !!mate && (r.position || 99) < (mate.position || 99), qbeat: !!mate && r.grid < mate.grid });
  });
  return out;
}
/* Driver development: 1 point for every 4 Grands Prix started, per season of a series, up to 1 for every 4 rounds on its calendar.
   Years of experience scale it (younger drivers earn more). Unspent points carry on to the next season. */
function devSeasons(personId) {
  const m = new Map();
  f1Record(personId).filter(x => x.w.session === 'gp').forEach(x => { const k = wSeries(x.w) + '|' + wSeason(x.w); m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].map(([k, starts]) => { const [sid, season] = k.split('|'), s = seriesDoc(sid), rounds = (s.calendar && s.calendar.length) || list('f1_tracks').length || 23, cap = Math.floor(rounds / RACES_PER_DEV);
    return { sid, season, starts, cap, earned: Math.min(cap, Math.floor(starts / RACES_PER_DEV)) }; });
}
function devEarned(personId) {
  const growth = (F1.person(personId) || {}).growth || 1;
  return devSeasons(personId).reduce((s, x) => s + Math.floor(x.earned * growth), 0);
}
/* A player's driver with their development spent: in order, while the points last. Experience grows with every second start. */
function f1DevApply(v3, charId) {
  if (!charId) return v3;
  const pid = f1PcId(charId), out = Object.assign({}, v3);
  const starts = f1Record(pid).filter(x => x.w.session === 'gp').length;
  out.experience = Math.min(99, (out.experience || 40) + Math.floor(starts / 2));
  let left = devEarned(pid);
  list('f1_dev').filter(x => x.charId === charId && DEV_ATTRS.indexOf(x.attr) !== -1).sort((a, b) => String(a.at).localeCompare(String(b.at))).forEach(x => {
    const cost = devCost(out[x.attr] || 0); if (cost > left || (out[x.attr] || 0) >= 99) return;
    out[x.attr] = (out[x.attr] || 0) + 1; left -= cost;
  });
  Object.defineProperty(out, 'devLeft', { value: left, enumerable: false });
  return out;
}
ACTIONS['dev-spend'] = d => {
  const c = currentChar(); if (!c || c.id !== d.char) return;
  const base = Object.assign({}, F1_ROOKIE, F1.person(f1PcId(c.id)) || {}), now = f1DevApply(base, c.id);
  if (devCost(now[d.attr] || 0) > now.devLeft) { toast('Not enough development points yet. Drivers earn 1 for every 4 Grands Prix.', true); return; }
  run(async () => { await Data.put('f1_dev', newId('dev'), { userId: asOwner(), charId: c.id, attr: d.attr, at: nowIso() }); }, `${F1_RATINGS.find(r => r[0] === d.attr)[1]} up by one.`);
};
ACTIONS.career = d => { S.ui.career = d.id; go('career'); };
const careerLink = (personId, name) => personId ? `<button class="linkish" data-act="career" data-id="${esc(personId)}">${esc(name)}</button>` : esc(name);

function devPanelHtml(charId) {
  const base = Object.assign({}, F1_ROOKIE, F1.person(f1PcId(charId)) || {}), now = f1DevApply(base, charId), mine = S.charId === charId;
  const p = F1.person(f1PcId(charId)) || {}, seasons = devSeasons(f1PcId(charId)), here = seasons.find(x => x.sid === curSeriesId() && x.season === curSeasonId()), s = curSeries();
  const cap = Math.floor((((s.calendar && s.calendar.length) || list('f1_tracks').length || 23)) / RACES_PER_DEV), starts = here ? here.starts : 0, got = here ? here.earned : 0;
  const growth = p.growth && p.growth !== 1 ? ` Their years of experience make each point worth ×${p.growth}.` : '';
  return `<div class="dev"><p><b>${plural(now.devLeft, 'development point')}</b> to spend. Drivers earn 1 for every ${RACES_PER_DEV} Grands Prix, up to ${cap} a season.${growth}</p>
    <p class="muted small">This season: ${plural(starts, 'Grand Prix', 'Grands Prix')}, ${got} of ${cap} earned${got < cap ? `, the next after ${RACES_PER_DEV - (starts % RACES_PER_DEV)} more` : ''}. Unspent points carry on to next season.</p>
    <table class="data compact"><tbody>${F1_RATINGS.map(([k, l]) => `<tr><td>${esc(l)}</td><td class="num"><b>${now[k]}</b>${now[k] !== base[k] ? ` <span class="f1-up">+${now[k] - base[k]}</span>` : ''}</td>
      <td class="num">${mine && k !== 'experience' && now[k] < 99 ? `<button class="btn small" data-act="dev-spend" data-char="${esc(charId)}" data-attr="${k}" ${devCost(now[k]) > now.devLeft ? 'disabled' : ''}>+1 for ${plural(devCost(now[k]), 'point')}</button>` : k === 'experience' ? '<span class="muted small">Grows with races</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

route('career', 'Career', function () {
  const p = F1.person(S.ui.career);
  if (!p) return `<div class="empty">Choose a driver from The Grid or the Championship.</div>`;
  const rec = f1Record(p.id), gps = rec.filter(x => x.w.session === 'gp'), seat = list('f1_seats').find(s => (p.charId && s.holderCharId === p.charId) || (!p.charId && s.defaultPersonId === p.id && !s.holderCharId));
  const team = seat ? F1.team(seat.teamId) : F1.team(p.teamId), c = p.charId ? get('characters', p.charId) : null;
  const pts = rec.reduce((s, x) => s + (x.r.points || 0), 0), wins = gps.filter(x => x.r.position === 1).length, pods = gps.filter(x => x.r.position && x.r.position <= 3).length;
  const best = Math.min(...gps.map(x => x.r.position || 99)), dnf = gps.filter(x => !x.r.position).length, poles = gps.filter(x => x.pole).length;
  const vs = gps.filter(x => x.mate), mates = [...new Set(vs.map(x => x.mate.name))];
  const ratings = p.kind === 'driver' || !p.kind ? (p.charId ? f1DevApply(Object.assign({}, F1_ROOKIE, p), p.charId) : p) : null;
  const eng = p.kind === 'engineer' && c ? F1.weekends().filter(w => w.setupBy && Object.values(w.setupBy).indexOf(c.id) !== -1) : [];
  const engQ = eng.map(w => { const code = Object.keys(w.setupBy).find(k => w.setupBy[k] === c.id); return w.setup[code]; });
  return `<div class="page-head"><div><p class="eyebrow">${esc(F1_ROLE[p.kind] || 'Driver')}${team ? ', ' + esc(team.name) : ''}${p.charId ? '' : ', real'}</p><h1>${p.flag ? esc(p.flag) + ' ' : ''}${esc(p.name)}</h1>
      ${c && c.bio ? `<p>${esc(c.bio.slice(0, 300))}</p>` : ''}</div></div>
    ${p.kind === 'engineer' ? `<div class="metrics"><div class="metric"><b>${eng.length}</b><span>Weekends with a set-up locked in</span></div><div class="metric"><b>${engQ.length ? Math.round(engQ.reduce((a, b) => a + b, 0) / engQ.length) : '–'}</b><span>Average set-up found (out of 95)</span></div></div>` : ''}
    ${p.kind !== 'engineer' && p.kind !== 'principal' ? `<div class="metrics"><div class="metric"><b>${gps.length}</b><span>Grands Prix</span></div><div class="metric"><b>${wins}</b><span>Wins</span></div>
      <div class="metric"><b>${pods}</b><span>Podiums</span></div><div class="metric"><b>${pts}</b><span>Points</span></div></div>
    <div class="cols2"><section class="card"><h2>Record</h2><table class="data compact"><tbody>
      <tr><td>Pole positions</td><td class="num">${poles}</td></tr><tr><td>Best finish</td><td class="num">${best < 99 ? 'P' + best : '–'}</td></tr><tr><td>Retirements</td><td class="num">${dnf}</td></tr>
      ${mates.length ? `<tr><td>Against ${esc(mates.join(' and '))} in races</td><td class="num">${vs.filter(x => x.beat).length} to ${vs.filter(x => !x.beat).length}</td></tr>
      <tr><td>Against ${esc(mates.join(' and '))} in qualifying</td><td class="num">${vs.filter(x => x.qbeat).length} to ${vs.filter(x => !x.qbeat).length}</td></tr>` : ''}</tbody></table></section>
      <section class="card"><h2>Ratings</h2>${p.charId ? devPanelHtml(p.charId) : `<table class="data compact"><tbody>${F1_RATINGS.map(([k, l]) => `<tr><td>${esc(l)}</td><td class="num"><b>${esc(ratings[k])}</b></td></tr>`).join('')}</tbody></table>`}</section></div>
    ${rec.length ? `<section class="card"><h2>Race by race</h2><div class="scroll-x"><table class="data"><thead><tr><th>Race</th><th>Team</th><th class="num">Grid</th><th class="num">Finish</th><th class="num">Points</th></tr></thead><tbody>${rec.slice().reverse().map(x => { const t = F1.track(x.w.trackId) || {};
      return `<tr><td>${esc(t.name || '')}${x.w.session === 'sprint' ? ' sprint' : ''}</td><td><span class="f1-bar" style="background:${esc(f1Colour(x.r.teamId))}"></span>${esc(F1.team(x.r.teamId).name)}</td><td class="num">${x.r.grid}</td><td class="num">${x.r.position ? 'P' + x.r.position : 'Out'}</td><td class="num">${x.r.points || ''}</td></tr>`; }).join('')}</tbody></table></div></section>` : '<p class="muted">No races yet.</p>'}` : ''}`;
});

/* ================================================================ Team HQ */
route('team', 'Team HQ', function () {
  const teams = F1.teams(); if (!teams.length) return '<div class="empty">The grid isn’t set up yet.</div>';
  const mySeat = S.charId ? F1.seats().find(s => s.holderCharId === S.charId) : null;
  const tid = S.ui.teamId || (mySeat && mySeat.teamId) || teams[0].id, team = F1.team(tid), n = finishedGps().length;
  const eff = f1EffectiveTeam(team, n), money = f1TeamMoney(tid), tp = tpSeat(tid), isTp = !!(tp && S.charId && tp.holderCharId === S.charId);
  const inTeam = S.isGm || F1.seats(tid).some(s => S.charId && s.holderCharId === S.charId), projs = teamProjects(tid);
  const pendingCost = projs.filter(p => !p.locked && !p.rejected).reduce((s, p) => s + F1_PROJECTS[p.type].cost, 0);
  const statRow = ([k, l]) => { const d = Math.round(((eff[k] || 0) - (team[k] || 0)) * 100) / 100; return `<tr><td>${esc(l)}</td><td class="num"><b>${eff[k]}</b>${d ? ` <span class="${d > 0 ? 'f1-up' : 'f1-down'}">${d > 0 ? '+' : '−'}${Math.abs(d)}</span>` : ''}</td></tr>`; };
  const projStatus = p => { const def = F1_PROJECTS[p.type];
    if (p.rejected) return `<span class="tag">Not started</span> ${esc(p.rejected)}`;
    if (!p.locked) return `<span class="tag open">Ordered</span> Starts when the next weekend opens.${isTp ? ` <button class="btn small" data-act="proj-cancel" data-id="${esc(p.id)}">Cancel</button>` : ''}`;
    if (!projectArrived(p, n)) return `<span class="tag">Being built</span> On the car after ${plural(p.lockedAt + def.build - n, 'more race')}.`;
    return projectWorks(p) ? `<span class="tag player">On the car</span> It works.` : `<span class="tag flag">On the car</span> It didn’t work as hoped: about a quarter of the gain.`; };
  const drivers = F1.seats(tid).filter(s => s.role === 'driver').map(s => ({ s, o: f1Occupant(s) }));
  return `<div class="page-head"><div><h1>${esc(team.name)}</h1><p>${esc(engineLabel(team.id))}. Sponsors expect P${money.target} or better at each Grand Prix.</p></div>
      <label class="field" style="margin:0">Team${sel('team-pick', 'ui/teamId', tid, teams.map(t => [t.id, t.name]))}</label></div>
    <div class="cols2">
      <section class="card" style="--team:${esc(team.color)}"><h2>The car</h2><p class="muted small">For the next race, with ${plural(eff.applied.length, 'upgrade')} fitted.</p>
        <table class="data compact"><tbody>${[['carPace', 'Overall pace'], ['topSpeed', 'Top speed'], ['cornering', 'Cornering'], ['reliability', 'Reliability'], ['tyreLife', 'Kindness to tyres'], ['pitSpeed', 'Pit crew']].map(statRow).join('')}</tbody></table></section>
      <section class="card"><h2>People</h2><ul class="f1-seatlist">${F1.seats(tid).map(s => { const o = f1Occupant(s);
        return `<li><span class="role">${esc(seatTitle(s))}</span><div class="f1-occ">${o.person ? careerLink(o.person.id, o.name) : esc(o.name)} ${o.player ? '<span class="tag player">Player</span>' : o.person ? '<span class="tag">Real</span>' : ''}${s.role === 'driver' && o.person ? `<span class="muted small">${f1Record(o.person.id).filter(x => wSeries(x.w) === curSeriesId() && wSeason(x.w) === curSeasonId()).reduce((a, x) => a + (x.r.points || 0), 0)} points this season</span>` : ''}</div></li>`; }).join('')}</ul></section></div>
    ${inTeam ? `<section class="card"><h2>Budget</h2><div class="metrics"><div class="metric"><b>£${money.left}m</b><span>Left to spend${pendingCost ? `, £${pendingCost}m of it on order` : ''}</span></div>
        <div class="metric"><b>£${money.budget}m</b><span>Season development budget</span></div><div class="metric"><b>£${money.income}m</b><span>Earned from races</span></div><div class="metric"><b>£${money.spent}m</b><span>Spent on upgrades</span></div></div>
        ${money.lines.length ? `<details><summary>Race by race</summary><table class="data compact"><tbody>${money.lines.map(l => `<tr><td>${esc(l.text)}</td><td class="num">${l.amt < 0 ? '−' : ''}£${Math.abs(l.amt)}m</td></tr>`).join('')}</tbody></table></details>` : '<p class="muted small">Each Grand Prix earns £1m, plus £0.05m a point, plus £0.8m when the sponsors’ target is met.</p>'}</section>
      <section class="card"><h2>Development</h2>
        ${projs.length || eff.applied.some(p => p.ai) ? `<table class="data"><tbody>${projs.map(p => `<tr><td><b>${esc(F1_PROJECTS[p.type].label)}</b><br><span class="muted small">${esc(fxText(F1_PROJECTS[p.type].fx))}</span></td><td>${projStatus(p)}</td></tr>`).join('')}
          ${eff.applied.filter(p => p.ai).map(p => `<tr><td><b>${esc(F1_PROJECTS[p.type].label)}</b><br><span class="muted small">${esc(fxText(F1_PROJECTS[p.type].fx))}</span></td><td><span class="tag">Before a player ran the team</span> ${p.works ? 'It works.' : 'It didn’t work as hoped.'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No upgrades yet.</p>'}
        ${isTp && curSeries().development ? `<h3 style="margin-top:16px">Order an upgrade</h3><p class="muted small">Race Control starts your orders when it opens the next weekend, two at a time, within the budget. Some don’t work as well as hoped.</p>
          <div class="cards">${Object.keys(F1_PROJECTS).map(k => { const def = F1_PROJECTS[k];
            return `<article class="card proj"><h3>${esc(def.label)}</h3><p>${esc(def.note)}</p><p class="muted small">${esc(fxText(def.fx))}. £${def.cost}m, on the car after ${plural(def.build, 'race')}. ${Math.round(def.odds * 100)}% chance it works fully.</p>
              <button class="btn small primary" data-act="proj-order" data-team="${esc(tid)}" data-type="${k}" ${def.cost > money.left - pendingCost ? 'disabled' : ''}>Order for £${def.cost}m</button></article>`; }).join('')}</div>` : tp && !tp.holderCharId ? '<p class="muted small">This team has no player as team principal, so it develops on its own: one upgrade every second race.</p>' : ''}</section>` : '<p class="muted">The budget and upgrade plans are for the team’s own people and Race Control.</p>'}
    ${drivers.filter(x => x.o.player && x.s.holderCharId === S.charId).map(x => `<section class="card"><h2>Your development</h2>${devPanelHtml(x.s.holderCharId)}</section>`).join('')}`;
});

/* =====================================================================
   F1 SIM — the race weekend, live.
   Qualifying is revealed a session at a time (Q1, Q2, Q3). Race Control
   can run the race live: press play and a lap is run every few seconds,
   saved, and shown to everyone at once through the live database link.
   The race view is broken down into timing plus tabs for the race log,
   a lap chart, tyre strategy and one driver in detail.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------- qualifying, one session at a time */
ACTIONS['f1-quali-next'] = () => {
  const w = F1.live(); if (!w || w.status !== 'quali') return;
  const stage = (w.qualiStage || 1) + 1, doc = Object.assign(clone(S.store.f1_weekends[w.id]), { qualiStage: stage });
  if (stage >= 3) doc.status = 'grid';
  const pole = (w.quali.log || []).find(l => l.kind === 'pole');
  run(async () => { await Data.put('f1_weekends', w.id, doc); if (stage >= 3 && pole) await Data.audit('f1.pole', pole.text); },
    stage >= 3 ? `Q3 is done: ${pole ? pole.text : 'the grid is set'}.` : `Q${stage} is done.`);
};
const qStage = w => w.status === 'quali' ? (w.qualiStage || 1) : 3;
function lvQualiHtml(w) {
  if (w.state.rules.qualifying && w.state.rules.qualifying.q2 >= 99) {
    const res = ((w.quali && w.quali.results) || []).slice().sort((a, b) => (a.times[2] || 999) - (b.times[2] || 999)), fast = res[0] && res[0].times[2];
    return `<table class="data timing"><thead><tr><th>P</th><th>Driver</th><th class="num">Time</th><th class="num">Gap</th></tr></thead><tbody>${res.map((r, i) => { const c = w.state.cars.find(x => x.id === r.id) || { id: r.id };
      return `<tr class="${r.id === S.ui.f1pick ? 'picked' : ''}"><td><b>${i + 1}</b></td><td>${lvDriverBtn(w, c)}</td><td class="num ${i === 0 ? 'fl' : ''}">${f1Fmt(r.times[2])}</td><td class="num">${i ? '+' + (r.times[2] - fast).toFixed(3) : ''}</td></tr>`; }).join('')}</tbody></table>`;
  }
  /* Stage s means Q1..Qs have been run. Only those sessions' times are shown, so nothing later leaks. */
  const s = qStage(w), res = (w.quali && w.quali.results) || [], n = k => k === 'Q1' ? 1 : k === 'Q2' ? 2 : 9;
  const through = res.filter(r => n(r.out) > s).sort((a, b) => (a.times[s - 1] || 999) - (b.times[s - 1] || 999));
  const outs = [];
  for (let k = s; k >= 1; k--) outs.push(...res.filter(r => n(r.out) === k).sort((a, b) => (a.times[k - 1] || 999) - (b.times[k - 1] || 999)));
  const fastest = k => Math.min(...res.map(r => r.times[k]).filter(x => x != null && isFinite(x)));
  const row = (r, i, outIn) => { const c = w.state.cars.find(x => x.id === r.id) || { id: r.id };
    return `<tr class="${outIn ? 'out' : ''} ${r.id === S.ui.f1pick ? 'picked' : ''}"><td><b>${i + 1}</b></td><td>${lvDriverBtn(w, c)}</td>
      ${[0, 1, 2].slice(0, s).map(k => `<td class="num ${r.times[k] != null && r.times[k] === fastest(k) ? 'fl' : ''}">${r.times[k] == null || !isFinite(r.times[k]) ? '' : f1Fmt(r.times[k])}</td>`).join('')}
      <td>${outIn ? `<span class="tag">Out in Q${outIn}</span>` : ''}</td></tr>`; };
  return `<table class="data timing"><thead><tr><th>P</th><th>Driver</th>${[1, 2, 3].slice(0, s).map(k => `<th class="num">Q${k}</th>`).join('')}<th></th></tr></thead><tbody>
    ${through.map((r, i) => row(r, i, null)).join('')}${outs.map((r, i) => row(r, through.length + i, n(r.out) <= 2 ? n(r.out) : null)).join('')}</tbody></table>
    <p class="legend-line muted small"><span class="fl">Purple</span>: fastest in that session.${s < 3 ? ` ${plural(through.length, 'driver')} go through to Q${s + 1}.` : ''}</p>`;
}
/* ---------------------------------------------------------------- live running (Race Control) */
const LIVE_SPEEDS = [['4000', 'Steady: a lap every 4 seconds'], ['2000', 'Normal: a lap every 2 seconds'], ['1000', 'Fast: a lap a second']];
function liveStop(msg) {
  if (!S.f1live) return;
  clearTimeout(S.f1live); S.f1live = null;
  const w = F1.live();
  if (w && w.live) Data.put('f1_weekends', w.id, Object.assign(clone(S.store.f1_weekends[w.id]), { live: false })).catch(() => {});
  if (msg) toast(msg); render();
}
async function liveTick() {
  const w = F1.live();
  if (!S.f1live || !w || !w.state || w.state.finished) { liveStop(); return; }
  if (S.busy) { S.f1live = setTimeout(liveTick, 300); return; }
  /* A driver moment is waiting: give the driver up to 45 seconds unless everyone has answered. */
  if (!raceLocked(w) && pendingMoments(w).length && !momentsAnswered(w) && momentWaitLeft(w) > 0) { S.f1live = setTimeout(liveTick, 1000); render(); return; }
  const log = await f1Advance(1);
  if (!S.f1live) return;
  if (!log) { liveStop('The race is paused: the lap couldn’t be saved.'); return; }
  const now = F1.live();
  if (!now || !now.state || now.state.finished) { S.f1live = null; render(); return; }
  if (S.ui.form.f1stopSc !== false && log.some(l => l.kind === 'red' || ((l.kind === 'sc' || l.kind === 'vsc') && /deployed/.test(l.text)))) { liveStop(log.some(l => l.kind === 'red') ? 'Red flag. The race is stopped: everyone gets fresh tyres and repairs, and it restarts behind the safety car when Race Control carries on.' : 'Safety car. The race is paused so the teams can make their calls.'); return; }
  S.f1live = setTimeout(liveTick, Number(S.ui.form.f1speed || 2000));
}
ACTIONS['f1-moments'] = (d, el) => { S.ui.form.f1moments = !!el.checked; };
ACTIONS['live-play'] = () => { if (S.f1live) { liveStop('Paused.'); return; } S.f1live = setTimeout(liveTick, 50); render(); };

/* ---------------------------------------------------------------- pieces of the race view */
/* The race log; during qualifying it only shows the sessions already run. */
function lvFeedHtml(w) {
  if (w.status !== 'quali') return f1FeedHtml(w);
  const log = (w.quali && w.quali.log) || [], s = w.qualiStage || 1; let seen = 0, upto = log.length;
  for (let i = 0; i < log.length; i++) { if (log[i].kind === 'session') { seen++; if (seen === s) { upto = i + 1; break; } } }
  const shown = log.slice(0, upto).reverse();
  return shown.length ? `<ul class="f1-feed">${shown.map(l => `<li class="${esc(l.kind)}"><span class="l">Q</span><span class="t">${esc(l.text)}</span></li>`).join('')}</ul>` : '<p class="muted">No news from qualifying yet.</p>';
}
/* What's wrong with a car that's still running. */
function lvLimpText(c) { const l = c.limp || {}; return { wing: 'Front wing damage: pitting for a new nose', power: 'Down on power', shift: 'Gearshift problems', braketemp: 'Managing brake temperatures', floor: 'Floor damage', overheat: 'Overheating', bag: 'Debris in a brake duct' }[l.inc] || 'A problem with the car'; }
function lvDriverBtn(w, c) {
  const e = f1Ent(w, c.id), mine = S.charId && e.charId === S.charId;
  return `<button class="drv-btn" data-act="f1-pick" data-id="${esc(c.id)}" aria-pressed="${S.ui.f1pick === c.id}"><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span><b>${esc(c.id)}</b><span class="full">${esc(e.name)}</span></button>${e.charId ? ' <span class="tag player">Player</span>' : ''}${mine ? ' <span class="tag you">You</span>' : ''}`;
}
ACTIONS['f1-pick'] = d => { S.ui.f1pick = S.ui.f1pick === d.id && S.ui.f1tab === 'driver' ? null : d.id; S.ui.f1tab = S.ui.f1pick ? 'driver' : (S.ui.f1tab === 'driver' ? 'feed' : S.ui.f1tab); render(); };
ACTIONS['f1-tab'] = d => { S.ui.f1tab = d.tab; render(); };
function lvTowerHtml(w) {
  const st = w.state; if (!st.lap) return lvQualiHtml(w);
  const order = f1Order(st), lead = order[0], avg = lead.cum / Math.max(1, st.lap), fast = st.fastest;
  return `<table class="data timing"><thead><tr><th>P</th><th>Driver</th><th class="num">Gap</th><th class="num">Int</th><th>Tyre</th><th class="num">Last lap</th><th class="num">Pits</th></tr></thead><tbody>${order.map((c, i) => {
    const cls = `${c.id === S.ui.f1pick ? 'picked' : ''} ${c.status !== 'running' ? 'out' : ''}`;
    if (c.status !== 'running') return `<tr class="${cls}"><td>–</td><td>${lvDriverBtn(w, c)}</td><td colspan="5" class="muted">Out on lap ${c.retiredLap}: ${esc(c.dnf)}</td></tr>`;
    const gap = c.cum - lead.cum, down = Math.floor(gap / avg), moved = c.grid - (i + 1);
    const lapCls = fast && fast.id === c.id && c.lastLap === fast.time ? 'fl' : c.lastLap && c.lastLap === c.bestLap ? 'pb' : '';
    return `<tr class="${cls}"><td><b>${i + 1}</b>${moved ? ` <span class="${moved > 0 ? 'f1-up' : 'f1-down'}">${moved > 0 ? '▲' : '▼'}${Math.abs(moved)}</span>` : ''}</td><td>${lvDriverBtn(w, c)}${c.pen ? `<span class="tag pen" title="Penalty to serve">+${c.pen}s</span>` : ''}${c.limp ? `<span class="tag dmg" title="${esc(lvLimpText(c))}">${c.limp.fix ? 'Damage' : 'Problem'}</span>` : ''}</td>
      <td class="num">${i === 0 ? 'Leader' : down >= 1 ? `+${down} lap${down > 1 ? 's' : ''}` : '+' + gap.toFixed(1)}</td><td class="num">${i === 0 ? '' : '+' + (c.cum - order[i - 1].cum).toFixed(1)}</td>
      <td>${f1TyreChip(c.tyre.compound, c.tyre.age)}</td><td class="num ${lapCls}">${f1Fmt(c.lastLap)}</td><td class="num">${c.stops}</td></tr>`; }).join('')}</tbody></table>
    <p class="legend-line muted small"><span class="fl">Purple</span>: fastest lap of the race. <span class="pb">Green</span>: a driver’s personal best. Click a driver for their race.</p>`;
}
/* Positions lap by lap: every car a line in its team colour; the picked driver and players stand out. */
function lvLapChartHtml(w) {
  const st = w.state; if (!st.lap) return '<p class="muted">The lap chart starts with the race.</p>';
  const cars = st.cars, N = cars.length, L = Math.max(st.lap, 1), rowH = 18, top = 14, left = 40, right = 44, W = 660, H = top + N * rowH + 18;
  const x = l => left + l / L * (W - left - right), y = p => top + (p - 1) * rowH + rowH / 2;
  const hi = c => c.id === S.ui.f1pick || (!S.ui.f1pick && !!f1Ent(w, c.id).charId);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Positions lap by lap">`;
  for (let p = 1; p <= N; p++) if (p === 1 || p % 5 === 0) s += `<line x1="${left}" x2="${W - right}" y1="${y(p)}" y2="${y(p)}" stroke="var(--line)"/>`;
  for (let l = 0; l <= L; l += (L > 40 ? 10 : 5)) s += `<text x="${x(l)}" y="${H - 4}" font-size="11" text-anchor="middle" fill="var(--muted)">${l === 0 ? 'Grid' : l}</text>`;
  const draw = c => { const pts = [[0, c.grid]].concat(c.positions.map((p, i) => [i + 1, p])).filter(q => q[1] != null);
    const strong = hi(c), col = f1Colour(f1Ent(w, c.id).teamId);
    let h = `<polyline points="${pts.map(q => `${x(q[0]).toFixed(1)},${y(q[1]).toFixed(1)}`).join(' ')}" fill="none" stroke="${esc(col)}" stroke-width="${strong ? 3.2 : 1.6}" stroke-linejoin="round" opacity="${strong || !S.ui.f1pick ? 1 : 0.28}"/>`;
    const last = pts[pts.length - 1];
    h += `<text x="${x(last[0]) + 6}" y="${y(last[1]) + 4}" font-size="11.5" font-weight="${strong ? 700 : 500}" fill="var(--ink)" opacity="${strong || !S.ui.f1pick ? 1 : 0.45}">${esc(c.id)}</text>`;
    if (c.status !== 'running') h += `<text x="${x(last[0]) + 6}" y="${y(last[1]) + 4}" dx="30" font-size="11" fill="var(--bad)">Out</text>`;
    return h; };
  cars.filter(c => !hi(c)).forEach(c => { s += draw(c); }); cars.filter(hi).forEach(c => { s += draw(c); });
  cars.slice().sort((a, b) => a.grid - b.grid).forEach(c => { s += `<text x="${left - 6}" y="${y(c.grid) + 4}" font-size="11" text-anchor="end" fill="var(--muted)">${esc(c.id)}</text>`; });
  return `<div class="scroll-x f1-chart">${s}</svg></div><p class="muted small">${S.ui.f1pick ? 'Click the driver again in the timing to see everyone.' : 'Players’ drivers are drawn bold. Click a driver in the timing to follow them.'}</p>`;
}
function lvDriverHtml(w) {
  const st = w.state, c = st.cars.find(x => x.id === S.ui.f1pick);
  if (!c) return '<p class="muted">Click a driver in the timing to see their race.</p>';
  const e = f1Ent(w, c.id), order = f1Order(st), pos = order.indexOf(c) + 1, lead = order[0], team = F1.team(e.teamId);
  const life = RaceEngine.tyreLife(c.tyre.compound, c, st.circuit), wear = Math.min(100, Math.round(c.tyre.wear / life * 100));
  const laps = c.lapTimes.map((t, i) => ({ t, lap: i + 1 })).filter(x => x.t != null);
  const clean = laps.filter(x => x.t < (c.bestLap || 999) * 1.07), lo = c.bestLap || 0, hiT = lo + 4;
  const scLaps = new Set(); let on = null;
  st.events.forEach(ev => { if ((ev.kind === 'sc' || ev.kind === 'vsc') && /deployed/.test(ev.text)) on = ev.lap + 1; if ((ev.kind === 'sc' || ev.kind === 'vsc') && /ends/.test(ev.text) && on) { for (let l = on; l <= ev.lap; l++) scLaps.add(l); on = null; } });
  if (on) for (let l = on; l <= st.lap; l++) scLaps.add(l);
  const pits = new Set(c.stints.slice(1).map(s => s.from - 1));
  const span = st.finished ? st.laps : Math.max(st.lap, 12), W = 640, H = 190, bw = (W - 50) / span;
  let bars = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Lap times for ${esc(e.name)}">`;
  laps.forEach(x => { const slow = x.t > hiT, hgt = slow ? H - 30 : Math.max(3, (x.t - lo) / 4 * (H - 30) + 3);
    const col = pits.has(x.lap) ? 'var(--muted)' : scLaps.has(x.lap) ? 'var(--f1-flag)' : x.t === c.bestLap ? 'var(--pb)' : esc(f1Colour(e.teamId));
    bars += `<rect x="${44 + (x.lap - 1) * bw}" y="${H - 18 - hgt}" width="${Math.max(1, bw - 1.5)}" height="${hgt}" fill="${col}" opacity="${slow ? 0.35 : 1}"><title>Lap ${x.lap}: ${f1Fmt(x.t)}</title></rect>`; });
  bars += `<text x="40" y="${H - 18}" font-size="11" text-anchor="end" fill="var(--muted)">${f1Fmt(lo)}</text><text x="40" y="16" font-size="11" text-anchor="end" fill="var(--muted)">+4s</text></svg>`;
  const mine = st.events.filter(ev => (ev.ids || []).indexOf(c.id) !== -1).slice(-12).reverse();
  return `<div class="driver-head" style="--team:${esc(team.color)}"><h3>${careerLink(e.personId, e.name)}</h3><p class="muted">${esc(team.name)}${e.charId ? ', a player' : ''}</p></div>
    <div class="metrics small-metrics"><div class="metric"><b>${c.status === 'running' ? 'P' + pos : 'Out'}</b><span>Started P${c.grid}</span></div>
      <div class="metric"><b>${c.status === 'running' && pos > 1 ? '+' + (c.cum - lead.cum).toFixed(1) : c.status === 'running' ? 'Leader' : esc(c.dnf)}</b><span>${c.status === 'running' ? 'To the leader' : 'Retired on lap ' + c.retiredLap}</span></div>
      <div class="metric"><b>${f1Fmt(c.bestLap)}</b><span>Best lap</span></div><div class="metric"><b>${c.stops}</b><span>${c.stops === 1 ? 'Pit stop' : 'Pit stops'}</span></div></div>
    ${c.status === 'running' ? `<div class="f1-gauges"><div class="f1-gauge">${esc(RaceEngine.COMPOUNDS[c.tyre.compound].label)}s, ${c.tyre.age} laps old: wear ${wear}%<div class="track"><div class="fill ${wear >= 90 ? 'hot' : ''}" style="width:${wear}%"></div></div></div>
      <div class="f1-gauge">${w.state.rules.noHybrid ? 'No battery' : `Battery ${Math.round(c.energy)}%`}, ${esc(RaceEngine.MODES[c.mode].label.toLowerCase())} mode<div class="track"><div class="fill" style="width:${c.energy}%"></div></div></div></div>` : ''}
    <h4>Lap times</h4><div class="scroll-x f1-chart">${bars}</div>
    <p class="muted small">Team colour: a racing lap. Green: their best. Yellow: safety car. Grey: a pit stop. Faded: more than 4 seconds off their best.</p>
    <h4>Stints</h4><p>${c.stints.map(s => `${f1TyreChip(s.compound)} laps ${s.from}${s.to ? '–' + s.to : ' onwards'}`).join(' &nbsp; ')}</p>
    ${mine.length ? `<h4>Their race</h4><ul class="f1-feed short">${mine.map(l => `<li class="${esc(l.kind)}"><span class="l">L${esc(l.lap)}</span><span class="t">${esc(l.text)}</span></li>`).join('')}</ul>` : ''}`;
}
function lvStagesHtml(w) {
  const single = !!(w.state && w.state.rules.qualifying && w.state.rules.qualifying.q2 >= 99) || (!w.state && seriesDoc(wSeries(w)).quali === 'single');
  const stages = single ? ['Practice', 'Qualifying', 'Race', 'Result'] : ['Practice', 'Q1', 'Q2', 'Q3', 'Race', 'Result'];
  let cur = w.status === 'practice' ? 0 : w.status === 'quali' ? (w.qualiStage || 1) : w.status === 'grid' ? 3 : w.status === 'running' ? 4 : 5;
  if (single) cur = w.status === 'practice' ? 0 : w.status === 'grid' ? 1 : w.status === 'running' ? 2 : 3;
  return `<ol class="stages" aria-label="The weekend">${stages.map((s, i) => `<li class="${i < cur ? 'done' : i === cur ? 'now' : ''}" ${i === cur ? 'aria-current="step"' : ''}>${s}</li>`).join('')}</ol>`;
}
function lvControlHtml(w) {
  const st = w.state, calls = f1Calls(w), setups = calls.filter(c => c.type === 'setup').length, pending = calls.length - setups;
  const runs = list('f1_runs').filter(r => r.weekendId === w.id).length;
  if (w.status === 'practice') { const done = endedSessions(w).length, n = curSession(w), all = done >= sessionsOf(w), single = seriesDoc(wSeries(w)).quali === 'single';
    return `<section class="card rc"><h2>Race Control <span class="sub">${all ? 'Practice is over' : esc(sessionName(w, n)) + ' is running'}</span></h2><p>${plural(runs, 'practice run')} done, ${plural(setups, 'set-up')} locked in. Cars without a locked set-up run a standard one. ${fullPractice(w) ? `Full sessions: teams plan their runs, then running the session plays them out with its own weather, red flags, crashes and failures. ${esc(practiceForecastText(w))}` : 'Quick practice: runs report straight away; ending a session posts its timesheet.'} Each player car gets a debrief.</p>
    <div class="btn-row">${all ? '' : `<button class="btn ${all ? '' : 'primary'}" data-act="fp-end">${fullPractice(w) ? 'Run' : 'End'} ${esc(sessionName(w, n))}</button>`}${w.session === 'test' ? `<button class="btn ${all ? 'primary' : ''}" data-act="test-finish">Finish testing</button>` : `<button class="btn ${all ? 'primary' : ''}" data-act="f1-quali">${single ? 'Run qualifying' : 'Run Q1'}${all ? '' : ' now'}</button>`}<button class="btn" data-act="f1-cancel">Cancel the weekend</button></div></section>`; }
  if (w.status === 'quali') return `<section class="card rc"><h2>Race Control</h2><p>Q${w.qualiStage || 1} is done.</p>
    <div class="btn-row"><button class="btn primary" data-act="f1-quali-next">Run Q${(w.qualiStage || 1) + 1}</button><button class="btn" data-act="f1-cancel">Cancel the weekend</button></div></section>`;
  if (w.status === 'finished') return '';
  const live = !!S.f1live;
  return `<section class="card rc ${live ? 'is-live' : ''}"><h2>Race Control ${live ? '<span class="tag live">Live</span>' : ''} <span class="sub">${pending ? plural(pending, 'pit-wall call') + ' waiting' : 'No calls waiting'}</span></h2>
    <div class="btn-row"><button class="btn primary" data-act="live-play">${live ? 'Pause' : st.lap === 0 ? 'Start the race live' : 'Resume live'}</button>
      <label class="sr-only" for="f1-speed">Speed</label>${sel('f1-speed', 'ui/form/f1speed', S.ui.form.f1speed || '2000', LIVE_SPEEDS)}
      <button class="btn" data-act="f1-step" data-laps="1" ${live ? 'disabled' : ''}>${st.lap === 0 ? 'Run lap 1' : 'Next lap'}</button>
      <button class="btn" data-act="f1-step" data-laps="999" ${live ? 'disabled' : ''}>Run to the flag</button>
      <label class="small"><input type="checkbox" data-act="f1-stopsc" ${S.ui.form.f1stopSc !== false ? 'checked' : ''}> Pause when a safety car comes out</label>
      <label class="small"><input type="checkbox" data-act="f1-moments" ${S.ui.form.f1moments !== false ? 'checked' : ''}> Driver moments</label>
      <button class="btn" data-act="f1-cancel" ${live ? 'disabled' : ''}>Cancel the weekend</button></div>
    ${pendingMoments(w).length ? `<p class="small"><b>Driver moment${pendingMoments(w).length > 1 ? 's' : ''}:</b> ${pendingMoments(w).map(m => `${esc(m.carId)} ${momentCall(w, m) ? 'has chosen' : 'is choosing'}`).join(', ')}.${live ? ` The race waits up to ${Math.ceil(momentWaitLeft(w) / 1000)} more seconds.` : ' Running the next lap settles them (the driver’s instinct decides for anyone who hasn’t chosen).'}</p>` : ''}
    <p class="muted small">Live, everyone watches the same laps as they happen, and pit-wall calls apply on the next lap. Keep this page open while it runs.</p></section>`;
}

/* ---------------------------------------------------------------- the Race Weekend screen */
route('weekend', 'Race Weekend', function () {
  const head = (k, t, p, right) => `<div class="page-head"><div>${k ? `<p class="eyebrow">${k}</p>` : ''}<h1>${t}</h1>${p ? `<p>${p}</p>` : ''}</div>${right || ''}</div>`;
  if (!F1.teams().length) return head('', 'Race Weekend', 'The grid isn’t set up yet.') + (S.isGm ? '<div class="card"><p>Load today’s grid on The Grid first.</p><button class="btn primary" data-act="nav" data-route="grid">Go to The Grid</button></div>' : '');
  const past = F1.weekends().filter(w => w.status === 'finished' && w.session !== 'test');
  const view = S.ui.f1view ? get('f1_weekends', S.ui.f1view) : null;
  const w = view || F1.live() || past[0] || null;
  const pastHtml = past.length ? `<section class="card" style="margin-top:16px"><h2>Results so far</h2><div class="scroll-x"><table class="data"><thead><tr><th>Round</th><th>Session</th><th>Winner</th><th></th></tr></thead><tbody>${past.map(x => { const t = F1.track(x.trackId) || {}, win = (x.results || [])[0] || {};
      return `<tr><td>${esc(t.round || '')} ${esc(t.name || x.trackId)}</td><td>${x.session === 'sprint' ? 'Sprint' : 'Grand Prix'}</td><td><span class="f1-bar" style="background:${esc(f1Colour(win.teamId))}"></span>${esc(win.name || '')}</td><td><button class="btn small" data-act="f1-view" data-id="${esc(x.id)}">View</button></td></tr>`; }).join('')}</tbody></table></div></section>` : '';
  if (!w) return head('', 'Race Weekend', S.isGm ? 'Open a weekend. Teams use practice to find their set-ups; qualifying runs a session at a time; the race can run live.' : 'No weekend is open. Race Control opens each one.') + (S.isGm ? f1OpenFormHtml() : '') + pastHtml;

  const t = F1.track(w.trackId) || { name: w.trackId, laps: 0 }, st = w.state, sprint = w.session === 'sprint';
  const laps = st ? st.laps : (sprint ? (t.sprintLaps || Math.ceil(t.laps / 3)) : t.laps);
  const lapLbl = w.status === 'practice' ? 'Practice' : w.status === 'quali' ? 'Qualifying' : !st ? (w.session === 'test' ? 'Testing' : '') : st.finished ? 'Chequered flag' : st.lap === 0 ? 'Grid set' : (w.live ? 'Live, lap' : 'Lap');
  const right = `<div class="f1-lap ${w.live ? 'live' : ''}" aria-live="polite"><small>${lapLbl}</small>${st && w.status !== 'quali' ? `${st.lap}<span class="of">/${laps}</span>` : w.status === 'quali' ? `Q${w.qualiStage || 1}` : ''}</div>`;
  const track = st ? st.track[Math.max(0, st.lap - 1)] : 0;
  const chips = st && st.lap ? `<p class="chips"><span class="tag ${track === 2 ? 'wet' : track === 1 ? 'damp' : ''}">${['Dry', 'Damp', 'Wet'][track]} track</span>${st.sc.type ? ` <span class="tag flag">${st.sc.type === 'sc' ? 'Safety car' : 'Virtual safety car'}</span>` : ''}${st.fastest ? ` <span class="tag">Fastest lap ${esc(st.fastest.id)} ${f1Fmt(st.fastest.time)}</span>` : ''}</p>` : '';
  let h = head(`${w.session === 'test' ? 'Pre-season testing' : `Round ${esc(t.round || '')}${sprint ? ', sprint' : ''}`}`, `${esc(t.flag || '')} ${esc(t.name)}${sprint ? ' Sprint' : w.session === 'test' ? ' testing' : ''}`, `${esc(t.circuit || '')}, ${laps} laps.` + chips, right);
  h += lvStagesHtml(w);
  if (view) h += `<div class="btn-row" style="margin-bottom:12px"><button class="btn" data-act="f1-view">Back to the current weekend</button></div>`;
  if (S.isGm && !view) h += lvControlHtml(w) || '';
  { const done = endedSessions(w); if (done.length && ['practice', 'quali', 'grid'].indexOf(w.status) !== -1) { const last = done[done.length - 1];
    h += `<section class="card"><h2>${esc(sessionName(w, last.n))} timesheet</h2><div class="scroll-x">${timesheetHtml(w, last)}</div>${done.length > 1 ? `<details><summary>Earlier sessions</summary>${done.slice(0, -1).reverse().map(s => `<h4>${esc(sessionName(w, s.n))}</h4><div class="scroll-x">${timesheetHtml(w, s)}</div>`).join('')}</details>` : ''}</section>`; } }
  if (S.isGm && !view && w.status === 'finished') h += `<section class="card"><h2>Race Control</h2><p>This weekend is finished and counts towards the championship.</p><div class="btn-row"><button class="btn" data-act="f1-discord" data-id="${esc(w.id)}">Post the result to Discord</button></div></section>` + f1OpenFormHtml();
  if (!view && w.status !== 'finished') h += f1MomentCardHtml(w) + f1PitWallHtml(w) + f1StrategyCardHtml(w);

  if (w.session === 'test' && w.status === 'finished') return h + testingSummaryHtml(w) + (view ? '' : pastHtml);
  if (!st) {
    const ents = f1Entrants();
    h += `<section class="card"><h2>Entry list</h2><div class="scroll-x"><table class="data"><thead><tr><th>Car</th><th>Driver</th><th>Team</th></tr></thead><tbody>${ents.map(e => `<tr><td><b>${esc(e.id)}</b></td><td>${careerLink(e.personId, e.name)}${e.charId ? ' <span class="tag player">Player</span>' : ''}</td><td><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span>${esc(F1.team(e.teamId).name)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">The entry list is fixed when Q1 runs, so seat changes after that apply from the next weekend.</p></section>`;
    return h + pastHtml;
  }
  if (w.status === 'finished') {
    const aw = weekendAwards(w), where = `${t.name}${sprint ? ' sprint' : ''}`;
    h += `<section class="card"><h2>Classification</h2><div class="scroll-x">${f1ResultsHtml(w)}</div>
      ${aw.length ? `<h4>Awards</h4><ul class="awards">${aw.map(a => `<li><span class="tag trophy">${esc(a.label)}</span> ${careerLink(a.personId, (F1.person(a.personId) || {}).name || '')}${['pole', 'win', 'dotd'].indexOf(a.key) !== -1 ? ` <button class="btn small ghost" data-act="card-open" data-id="${esc(a.personId)}" data-kind="${a.key}" data-where="${esc(where)}">Card</button>` : ''}</li>`).join('')}</ul>` : ''}</section>` + dotdHtml(w) + weekendStoryHtml(w);
  }
  const racing = st.lap > 0, tab = S.ui.f1tab && (racing || S.ui.f1tab === 'feed') ? S.ui.f1tab : 'feed';
  const tabs = [['feed', 'Race log'], ['lapchart', 'Lap chart'], ['tyres', 'Tyre strategy'], ['driver', S.ui.f1pick ? `Driver: ${S.ui.f1pick}` : 'Driver']].filter(x => racing || x[0] === 'feed');
  const body = tab === 'lapchart' ? lvLapChartHtml(w) : tab === 'tyres' ? f1ChartHtml(w) : tab === 'driver' ? lvDriverHtml(w) : lvFeedHtml(w);
  h += `<div class="f1-main"><section class="card"><h2>${racing ? 'Timing' : w.status === 'quali' ? `Qualifying: Q${w.qualiStage || 1}` : 'Qualifying'}</h2><div class="scroll-x">${lvTowerHtml(w)}</div></section>
    <section class="card"><div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="tab" data-act="f1-tab" data-tab="${k}" aria-selected="${tab === k}">${esc(l)}</button>`).join('')}</div>${body}</section></div>`;
  return h + (view ? '' : pastHtml);
});

/* =====================================================================
   F1 SIM — character applications and rolled driver ratings.
   A character starts as a draft. Drivers choose a background, roll their
   ratings (two re-rolls; the latest roll stands), arrange the five
   numbers across the five ratings, choose a driving style, and send the
   application. Race Control sees every roll and approves it (which
   writes the ratings to the driver record the race uses) or returns it
   with a note. Rolls are worked out from the character and the roll
   number, so the same roll always gives the same numbers, and approval
   recalculates them rather than trusting what the application says.
   ===================================================================== */
'use strict';

const ROLL_ATTRS = [['pace', 'Pace'], ['consistency', 'Consistency'], ['wet', 'Wet weather'], ['overtaking', 'Overtaking'], ['defense', 'Defence']];
const MAX_ROLLS = 3;          // the first roll and two re-rolls
const ROLL_CAP = 90;          // nobody arrives better than 90: the rest is earned
const BRACKETS = [
  { id: 'f2', name: 'Formula 2 graduate', blurb: 'Quick and well drilled, straight up the ladder.', base: 70, dice: [2, 10], exp: 30, mods: {} },
  { id: 'prodigy', name: 'Karting prodigy', blurb: 'Skipped a step. Could be brilliant, could be raw.', base: 63, dice: [3, 10], exp: 15, mods: {} },
  { id: 'convert', name: 'IndyCar or endurance convert', blurb: 'Hardened wheel-to-wheel racer, new to these cars.', base: 68, dice: [2, 10], exp: 55, mods: { overtaking: 3, defense: 3, pace: -2 } },
  { id: 'current', name: 'Current driver', blurb: 'Already on the grid. Proven over full seasons: knows the circuits, the car and the pressure.', base: 72, dice: [2, 8], exp: 60, mods: { consistency: 2, defense: 2 } },
  { id: 'reserve', name: 'Team reserve driver', blurb: 'Knows the car from the simulator. Steady rather than spectacular.', base: 71, dice: [2, 8], exp: 40, mods: { consistency: 3 } },
  { id: 'veteran', name: 'Returning veteran', blurb: 'Been here before. Not the fastest any more, but rarely wrong.', base: 66, dice: [2, 10], exp: 75, mods: { consistency: 4, wet: 2, pace: -3 } }
];
/* Years in racing: more years, more experience; younger drivers earn development points faster. */
const YEARS = [
  { id: '1-2', label: '1 to 2 years', min: 1, max: 2, growth: 1.5, note: 'Raw. Little experience, but they develop half as fast again.' },
  { id: '3-6', label: '3 to 6 years', min: 3, max: 6, growth: 1, note: 'Established. A solid base of experience.' },
  { id: '7+', label: '7 years or more', min: 7, max: 12, growth: 0.75, note: 'Seasoned. Lots of experience and composure, but slower to develop.' }];
const BRACKET_YEARS = { f2: ['1-2', '3-6'], prodigy: ['1-2', '3-6'], convert: ['3-6', '7+'], current: ['3-6', '7+'], reserve: ['1-2', '3-6', '7+'], veteran: ['7+'] };
const BRACKET_EXP = { f2: 0, prodigy: -5, convert: 8, current: 5, reserve: 3, veteran: 6 };
const yearsOf = id => YEARS.find(y => y.id === id) || null;
const bracketOf = id => BRACKETS.find(b => b.id === id) || null;
const charStatus = c => c.status || (F1.person(f1PcId(c.id)) ? 'approved' : 'draft');
const charApproved = c => !!c && charStatus(c) === 'approved';
const STATUS_TEXT = { draft: 'Draft', pending: 'Waiting for Race Control', approved: 'Approved', returned: 'Returned with notes' };

/* Roll k for a character: base plus dice for each of the five ratings, plus mental strength (1d6 + 3). */
function rollValues(charId, k, bracketId) {
  const b = bracketOf(bracketId); if (!b || !k) return null;
  const r = RaceEngine.rng(h32(charId, 'roll', k)), d = () => { let s = 0; for (let i = 0; i < b.dice[0]; i++) s += 1 + Math.floor(r() * b.dice[1]); return s; };
  const out = { values: ROLL_ATTRS.map(() => Math.min(ROLL_CAP, b.base + d())), mental: 4 + Math.floor(r() * 6) };
  /* Years and experience have their own dice, so adding them didn't change anyone's earlier rolls. */
  const c = get('characters', charId), y = yearsOf(c && c.gen && c.gen.years);
  if (y) { const ry = RaceEngine.rng(h32(charId, 'years', k)); out.years = y.min + Math.floor(ry() * (y.max - y.min + 1));
    out.experience = Math.max(15, Math.min(88, 15 + out.years * 7 + Math.floor(ry() * 8) + (BRACKET_EXP[bracketId] || 0))); }
  return out;
}
const validOrder = o => Array.isArray(o) && o.length === ROLL_ATTRS.length && o.slice().sort().join() === ROLL_ATTRS.map((x, i) => i).join();
/* The finished ratings: the latest roll, arranged, plus the background's adjustments. */
function rolledRatings(c) {
  const g = c.gen || {}, b = bracketOf(g.bracket), roll = rollValues(c.id, Math.min(g.rolls || 0, MAX_ROLLS), g.bracket); if (!b || !roll) return null;
  const order = validOrder(g.order) ? g.order : ROLL_ATTRS.map((x, i) => i), y = yearsOf(g.years);
  const out = { experience: roll.experience != null ? roll.experience : b.exp, mental: Math.min(10, roll.mental + (g.years === '7+' ? 1 : 0)), style: g.style || 'technical' };
  if (roll.years != null) { out.years = roll.years; out.growth = y.growth; }
  ROLL_ATTRS.forEach(([k], i) => { out[k] = Math.max(40, Math.min(ROLL_CAP, roll.values[order[i]] + (b.mods[k] || 0))); });
  return out;
}

/* ---------------------------------------------------------------- the player's side */
function charDoc(id) { return clone(S.store.characters[id]); }
function saveGen(c, patch, msg) {
  const doc = charDoc(c.id); doc.gen = Object.assign({}, doc.gen || {}, patch); doc.updatedAt = nowIso();
  return run(async () => { await Data.put('characters', c.id, doc); }, msg);
}
const editable = c => ['draft', 'returned'].indexOf(charStatus(c)) !== -1 && (c.userId === S.uid || S.isGm);
ACTIONS['char-open'] = d => { S.ui.charEdit = d.id; go('character'); };
ACTIONS['gen-bracket'] = d => { const c = get('characters', S.ui.charEdit); if (!c || !editable(c) || (c.gen && c.gen.rolls)) return; const ok = BRACKET_YEARS[d.id] || []; saveGen(c, { bracket: d.id, years: ok.indexOf((c.gen || {}).years) !== -1 ? c.gen.years : (ok.length === 1 ? ok[0] : null) }); };
ACTIONS['gen-years'] = d => { const c = get('characters', S.ui.charEdit); if (!c || !editable(c) || (c.gen && c.gen.rolls)) return; if ((BRACKET_YEARS[(c.gen || {}).bracket] || []).indexOf(d.id) === -1) return; saveGen(c, { years: d.id }); };
ACTIONS['gen-roll'] = () => {
  const c = get('characters', S.ui.charEdit); if (!c || !editable(c)) return;
  const g = c.gen || {}; if (!g.bracket) { toast('Choose a background first.', true); return; }
  if (!g.years) { toast('Choose how many years they’ve been racing first.', true); return; }
  if ((g.rolls || 0) >= MAX_ROLLS) { toast('No re-rolls left.', true); return; }
  const n = (g.rolls || 0) + 1;
  saveGen(c, { rolls: n, order: ROLL_ATTRS.map((x, i) => i), rolledAt: (g.rolledAt || []).concat(nowIso()) }, n === 1 ? 'Rolled. Arrange the numbers, or re-roll.' : `Re-rolled. ${plural(MAX_ROLLS - n, 're-roll')} left; this roll now stands.`);
};
ACTIONS['gen-move'] = d => {
  const c = get('characters', S.ui.charEdit); if (!c || !editable(c)) return;
  const o = validOrder((c.gen || {}).order) ? c.gen.order.slice() : ROLL_ATTRS.map((x, i) => i), i = Number(d.i), j = i + Number(d.dir);
  if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; saveGen(c, { order: o });
};
CHANGES['gen-style'] = (v) => { const c = get('characters', S.ui.charEdit); if (c && editable(c)) saveGen(c, { style: v }); };
ACTIONS['gen-submit'] = () => {
  const c = get('characters', S.ui.charEdit); if (!c || !editable(c)) return;
  if (c.role === 'driver' && !rolledRatings(c)) { toast('Roll your driver’s ratings first.', true); return; }
  if (!String(c.bio || '').trim()) { toast('Add a few lines about who they are first (Edit details).', true); return; }
  const doc = charDoc(c.id); doc.status = 'pending'; doc.submittedAt = nowIso();
  run(async () => { await Data.put('characters', c.id, doc); }, 'Application sent to Race Control.');
};

/* ---------------------------------------------------------------- Race Control's side */
ACTIONS['gen-approve'] = d => {
  const c = get('characters', d.id); if (!c) return;
  const ratings = c.role === 'driver' ? rolledRatings(c) : {};
  if (c.role === 'driver' && !ratings) { toast('This driver hasn’t rolled their ratings.', true); return; }
  const pid = f1PcId(c.id), cur = F1.person(pid) ? clone(S.store.f1_people[pid]) : {};
  const person = Object.assign({}, c.role === 'driver' ? F1_ROOKIE : {}, cur, ratings, { kind: c.role === 'principal' || c.role === 'engineer' ? c.role : c.role === 'driver' ? 'driver' : c.role,
    charId: c.id, name: c.name, abbr: c.code || f1Code(c.name), num: c.number || null, flag: cur.flag || '', approved: true, bracket: (c.gen || {}).bracket || null, approvedAt: nowIso() });
  run(async () => {
    await Data.put('f1_people', pid, person);
    await Data.put('characters', c.id, Object.assign(charDoc(c.id), { status: 'approved', decidedAt: nowIso(), rcNote: null }));
    await Data.audit('character.approve', `${c.name} approved as ${charRoleName(c.role).toLowerCase()}${c.role === 'driver' ? ` (pace ${ratings.pace}, consistency ${ratings.consistency})` : ''}`);
  }, `${c.name} is approved.`);
};
ACTIONS['gen-return'] = d => {
  const c = get('characters', d.id); if (!c) return; const note = String(((S.ui.form.rcnote || {})[d.id]) || '').trim();
  if (!note) { toast('Say what needs changing, in the note box.', true); return; }
  run(async () => { await Data.put('characters', c.id, Object.assign(charDoc(c.id), { status: 'returned', decidedAt: nowIso(), rcNote: note })); await Data.audit('character.return', `${c.name} returned: ${note}`); }, 'Returned to the player with your note.');
};
function rollHistoryHtml(c) {
  const g = c.gen || {}, rows = [];
  for (let k = 1; k <= Math.min(g.rolls || 0, MAX_ROLLS); k++) { const r = rollValues(c.id, k, g.bracket); rows.push(`<tr${k === g.rolls ? ' class="me"' : ''}><td>Roll ${k}${k === g.rolls ? ' (stands)' : ''}</td>${r.values.map(v => `<td class="num">${v}</td>`).join('')}<td class="num">${r.mental}</td></tr>`); }
  return rows.length ? `<table class="data compact"><thead><tr><th></th>${ROLL_ATTRS.map(() => '<th class="num">Value</th>').join('')}<th class="num">Mental</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '<p class="muted small">No rolls yet.</p>';
}
function ratingsTableHtml(r) {
  return `<table class="data compact"><tbody>${r.years != null ? `<tr><td>Years of experience</td><td class="num"><b>${r.years}</b></td></tr>` : ''}${ROLL_ATTRS.concat([['experience', 'Experience'], ['mental', 'Mental strength (1 to 10)']]).map(([k, l]) => `<tr><td>${esc(l)}</td><td class="num"><b>${r[k]}</b></td></tr>`).join('')}
    <tr><td>Driving style</td><td class="num">${esc((F1_STYLES.find(s => s[0] === r.style) || ['', r.style])[1])}</td></tr></tbody></table>`;
}
function chargenQueueHtml() {
  const pend = list('characters').filter(c => !c.retired && charStatus(c) === 'pending').sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
  return `<section><h2 class="section-h">Character applications ${pend.length ? `<span class="count">${pend.length}</span>` : ''}</h2>
    ${pend.length ? `<div class="cards">${pend.map(c => { const b = bracketOf((c.gen || {}).bracket), r = c.role === 'driver' ? rolledRatings(c) : null;
      return `<article class="card">${c.portraitUrl ? `<img class="app-photo" src="${esc(c.portraitUrl)}" alt="${esc(c.name)}">` : ''}<h3>${esc(c.name)}</h3><p class="small">${c.faceclaim ? `Face claim: <b>${esc(c.faceclaim)}</b>` : '<span class="tag flag">No face claim given</span>'}${c.portraitUrl ? '' : ' <span class="tag flag">No picture</span>'}</p><p class="muted small">${esc(charRoleName(c.role))}${c.nationality ? ', ' + esc(c.nationality) : ''}${c.code ? ', ' + esc(c.code) : ''}${c.number ? ' #' + esc(c.number) : ''}. Sent ${esc(fmtWhen(c.submittedAt))}.</p>
        ${paras(c.bio)}
        ${careerRows(c).length ? `<h4>Career record</h4>${careerTableHtml(careerRows(c), { review: c.id })}<p class="muted small">Mark any season you won’t accept as not canon; approving makes the rest canon.</p>` : ''}
        ${r ? `<p><b>${esc(b.name)}</b>. ${esc(b.blurb)}</p>${ratingsTableHtml(r)}<details><summary>Every roll</summary>${rollHistoryHtml(c)}<p class="muted small">Rolls are worked out from the character, so these are exactly what the player saw.</p></details>` : ''}
        <label class="field">Note to the player (needed to return it)<textarea id="rcn-${esc(c.id)}" rows="2" data-bind="ui/form/rcnote/${esc(c.id)}"></textarea></label>
        <label class="small"><input type="checkbox" data-bind="ui/form/postAccept/${esc(c.id)}" ${((S.ui.form.postAccept || {})[c.id]) !== false ? 'checked' : ''}> Post the acceptance card to Discord${c.discordId ? `, mentioning ${esc(c.discord || 'the player')}` : ' (no Discord user ID, so no @mention)'}</label>
        <div class="btn-row"><button class="btn primary" data-act="gen-approve" data-id="${esc(c.id)}">Approve</button><button class="btn" data-act="gen-return" data-id="${esc(c.id)}">Return with the note</button></div></article>`; }).join('')}</div>`
      : '<p class="muted">No characters waiting.</p>'}</section>`;
}

/* ---------------------------------------------------------------- the character page */
const WEEKEND_MAP = [
  ['Pace', 'Your raw speed: every lap, in practice, qualifying and the race. The biggest single number after the car.'],
  ['Consistency', 'How much your lap times scatter. High consistency means fewer slow laps and tighter qualifying runs.'],
  ['Wet weather', 'Extra pace (or lost pace) whenever the track is damp or wet, and an edge in wet wheel-to-wheel fights.'],
  ['Overtaking', 'Your chance of making a pass stick when you’re close behind someone.'],
  ['Defence', 'How hard you are to pass. It’s set against the attacker’s overtaking every time.'],
  ['Experience', 'Fewer mistakes under pressure, and clearer feedback to your engineer in practice. It grows with every second Grand Prix you start.'],
  ['Mental strength', 'Fewer mistakes when it matters: starts, wet races, battles.'],
  ['Driving style', 'Small nudges: qualifiers find a little extra over one lap, smooth drivers are kinder to tyres, technical drivers help the set-up, aggressive ones take more risks.']
];
function weekendGuideHtml() {
  return `<section class="card"><h2>How your driver plays out on a race weekend</h2><ol class="journey">
    <li><b>Approval.</b> Race Control approves the application, and your ratings become your driver’s record. That record is what every session uses.</li>
    <li><b>A seat.</b> Apply for an open seat on The Grid, or Race Control puts you in one. You then race in place of that team’s real driver, in that team’s car.</li>
    <li><b>Practice.</b> Your race engineer (or you, if no player engineers your car) uses four runs. You describe what the car is doing; the more experienced you are, the clearer that feedback. The set-up they lock in is worth up to three tenths a lap.</li>
    <li><b>Qualifying.</b> One flying lap in each session: the car, your pace, the set-up, and a little luck from your consistency.</li>
    <li><b>The race.</b> Every lap uses your ratings: pace for speed, consistency for scatter, overtaking and defence in every fight, experience and mental strength for mistakes. From the pit wall you choose push, standard or manage, call your own stops, and can refuse a team order.</li>
    <li><b>Over the season.</b> You earn a development point for every 4 Grands Prix you start, up to a cap each season. Spend them in Team HQ to raise your ratings. Above 80 and 90, each point costs more.</li></ol>
    <table class="data compact"><tbody>${WEEKEND_MAP.map(([k, v]) => `<tr><td class="nowrap"><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}</tbody></table></section>`;
}
route('character', 'Character', function () {
  const c = get('characters', S.ui.charEdit);
  if (!c || (c.userId !== S.uid && !S.isGm)) return '<div class="empty">Choose a character from Your characters.</div>';
  const st = charStatus(c), ed = editable(c), g = c.gen || {}, b = bracketOf(g.bracket), driver = c.role === 'driver', r = driver ? rolledRatings(c) : null;
  const roll = driver && g.rolls ? rollValues(c.id, g.rolls, g.bracket) : null, order = validOrder(g.order) ? g.order : ROLL_ATTRS.map((x, i) => i);
  const steps = [['Who they are', !!String(c.bio || '').trim()], ['Picture and face claim', !!(c.portraitUrl && String(c.faceclaim || '').trim())], ...(driver ? [['Background', !!b], ['Years', !!g.years], ['Roll and arrange', !!g.rolls]] : []), ['Race Control', st === 'approved']];
  let h = `<div class="page-head"><div><p class="eyebrow">${esc(charRoleName(c.role))}</p><h1>${esc(c.name)}</h1><p><span class="tag ${st === 'approved' ? 'player' : st === 'pending' ? 'open' : st === 'returned' ? 'flag' : ''}">${esc(STATUS_TEXT[st])}</span></p></div>
      <div class="btn-row"><button class="btn" data-act="char-edit" data-id="${esc(c.id)}">Edit details</button><button class="btn" data-act="sheet-open" data-id="${esc(c.id)}">Export</button><button class="btn ghost" data-act="nav" data-route="characters">All characters</button></div></div>
    <ol class="stages" aria-label="Application">${steps.map(([l, done], i) => `<li class="${done ? 'done' : (steps.findIndex(s => !s[1]) === i ? 'now' : '')}">${esc(l)}</li>`).join('')}</ol>`;
  if (st === 'returned' && c.rcNote) h += `<div class="card notice warn"><b>Race Control’s note:</b> ${esc(c.rcNote)}</div>`;
  h += offersHtml(c.id);
  h += `<section class="card"><h2>Who they are</h2>${c.bio ? paras(c.bio) : '<p class="muted">No background written yet. Use Edit details.</p>'}
    <p class="muted small">${[c.nationality, c.code, c.number ? '#' + c.number : '', c.faceclaim ? 'Face claim: ' + c.faceclaim : '', c.discord ? 'Discord: ' + c.discord : ''].filter(Boolean).map(esc).join('. ')}</p>${c.portraitUrl ? `<img class="app-photo" src="${esc(c.portraitUrl)}" alt="${esc(c.name)}">` : ''}</section>`;
  h += careerAppHtml(c);
  if (driver) {
    h += `<section class="card"><h2>Background</h2>${g.rolls ? `<p><b>${esc(b.name)}</b>. ${esc(b.blurb)}</p>` : `<p class="muted">Where your driver comes from sets their starting range and experience. It’s fixed once you roll.</p>
      <div class="cards brackets">${BRACKETS.map(x => `<button class="card bracket ${g.bracket === x.id ? 'on' : ''}" data-act="gen-bracket" data-id="${x.id}" aria-pressed="${g.bracket === x.id}" ${ed ? '' : 'disabled'}>
        <b>${esc(x.name)}</b><span>${esc(x.blurb)}</span><span class="muted small">Ratings ${x.base + x.dice[0]} to ${Math.min(ROLL_CAP, x.base + x.dice[0] * x.dice[1])}; ${esc((BRACKET_YEARS[x.id] || []).map(y => yearsOf(y).label.replace(' years', '').replace(' or more', '+')).join(', '))} years${Object.keys(x.mods).length ? '. ' + Object.keys(x.mods).map(k => `${x.mods[k] > 0 ? '+' : '−'}${Math.abs(x.mods[k])} ${k === 'defense' ? 'defence' : k}`).join(', ') : ''}</span></button>`).join('')}</div>`}</section>`;
    if (b) { const ok = BRACKET_YEARS[b.id] || [], y = yearsOf(g.years);
      h += `<section class="card"><h2>Years in racing</h2>${g.rolls ? `<p><b>${esc(y ? y.label : 'Not chosen')}</b>${r && r.years != null ? `: rolled <b>${r.years}</b> years, experience ${r.experience}` : ''}. ${esc(y ? y.note : '')}</p>`
        : `<p class="muted">How long they’ve been racing. The exact number of years, and the experience rating that comes with it, are rolled with the ratings. Fixed once you roll.</p>
        <div class="cards brackets">${ok.map(id => { const x = yearsOf(id); return `<button class="card bracket ${g.years === id ? 'on' : ''}" data-act="gen-years" data-id="${id}" aria-pressed="${g.years === id}" ${ed ? '' : 'disabled'}><b>${esc(x.label)}</b><span>${esc(x.note)}</span>
          <span class="muted small">Development points ×${x.growth}</span></button>`; }).join('')}</div>`}</section>`; }
    if (b) h += `<section class="card"><h2>Ratings</h2>
      ${!g.rolls ? `<p>Roll five numbers for pace, consistency, wet weather, overtaking and defence, plus mental strength. You get ${MAX_ROLLS - 1} re-rolls; the latest roll always stands. Then arrange the five numbers across the ratings however you like.</p>`
        : `<p class="muted small">Roll ${g.rolls} of ${MAX_ROLLS}${g.rolls < MAX_ROLLS ? `: ${plural(MAX_ROLLS - g.rolls, 're-roll')} left, and a re-roll replaces this one` : ''}. Use the arrows to move numbers between ratings; the background’s adjustments are added on top.</p>
        <table class="data arrange"><tbody>${ROLL_ATTRS.map(([k, l], i) => `<tr><td>${esc(l)}</td><td class="num"><b>${roll.values[order[i]]}</b>${b.mods[k] ? ` <span class="${b.mods[k] > 0 ? 'f1-up' : 'f1-down'}">${b.mods[k] > 0 ? '+' : '−'}${Math.abs(b.mods[k])}</span>` : ''}</td><td class="num">= <b>${r[k]}</b></td>
          <td class="num">${ed ? `<button class="btn small" data-act="gen-move" data-i="${i}" data-dir="-1" aria-label="Move ${esc(l)}’s number up" ${i === 0 ? 'disabled' : ''}>▲</button> <button class="btn small" data-act="gen-move" data-i="${i}" data-dir="1" aria-label="Move ${esc(l)}’s number down" ${i === ROLL_ATTRS.length - 1 ? 'disabled' : ''}>▼</button>` : ''}</td></tr>`).join('')}
          <tr><td>Experience</td><td></td><td class="num">= <b>${r.experience}</b></td><td class="muted small num">${r.years != null ? `${r.years} years of racing` : 'From the background'}</td></tr>
          <tr><td>Mental strength</td><td></td><td class="num">= <b>${r.mental}</b></td><td class="muted small num">Rolled, 4 to 9</td></tr></tbody></table>
        <label class="field" style="max-width:320px;margin-top:12px">Driving style<select id="gen-style" data-change="gen-style" ${ed ? '' : 'disabled'}>${F1_STYLES.map(([k, l]) => `<option value="${k}" ${(g.style || 'technical') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`}
      ${ed ? `<div class="btn-row"><button class="btn ${g.rolls ? '' : 'primary'}" data-act="gen-roll" ${g.rolls >= MAX_ROLLS ? 'disabled' : ''}>${g.rolls ? `Re-roll (${MAX_ROLLS - g.rolls} left)` : 'Roll the ratings'}</button></div>` : ''}
      ${g.rolls > 1 ? `<details><summary>Earlier rolls</summary>${rollHistoryHtml(c)}</details>` : ''}</section>`;
  }
  if (ed) h += `<section class="card"><h2>Send to Race Control</h2><p>Race Control reads the application${driver ? ' and sees every roll' : ''}, then approves it or sends it back with a note. ${driver ? 'Once approved, you can apply for a seat.' : 'Once approved, you can apply for a seat or take part in the paddock.'}</p>
    <div class="btn-row"><button class="btn primary" data-act="gen-submit">Send the application</button></div></section>`;
  if (st === 'pending') h += `<section class="card"><h2>With Race Control</h2><p>Sent ${esc(fmtWhen(c.submittedAt))}. You’ll see the result here and on Home.</p></section>`;
  if (st === 'approved' && driver) { const p = F1.person(f1PcId(c.id)); if (p) h += `<section class="card"><h2>Your driver’s record</h2>${ratingsTableHtml(f1DevApply(Object.assign({}, F1_ROOKIE, p), c.id))}
    <div class="btn-row"><button class="btn" data-act="career" data-id="${esc(p.id)}">Profile</button>${charSeat(c.id) ? '<button class="btn" data-act="nav" data-route="team">Team HQ</button>' : '<button class="btn primary" data-act="nav" data-route="grid">Find an open seat</button>'}</div></section>`; }
  if (driver) h += weekendGuideHtml();
  return h;
});

/* =====================================================================
   F1 SIM — race strategy.
   For every car, its team principal, race engineer and driver can build
   three plans: the starting tyre, up to three stops (lap and tyre), when
   to go onto wet tyres if it rains and back onto slicks as it dries, and
   whether to take a cheap stop under a safety car. One plan is chosen for
   the start; any of them can be switched to during the race from the
   pit wall. Whoever saved last decides, and everyone in the team sees who.
   ===================================================================== */
'use strict';

const PLAN_NAMES = ['Plan A', 'Plan B', 'Plan C'];
const WET_CALLS = [['early', 'Straight away, at the first spots'], ['normal', 'After a lap of rain'], ['late', 'Gamble: stay on slicks until it’s properly wet']];
const DRY_CALLS = [['early', 'Straight away, on the first dry lap'], ['normal', 'After a dry lap'], ['late', 'Carefully: after a few dry laps']];
const DRY_TYRES = [['soft', 'Softs'], ['medium', 'Mediums'], ['hard', 'Hards']];

/* Who may plan a car: the team principal, the car's race engineer, the car's driver. */
function canPlan(w, ent, charId) {
  if (!ent || !charId) return false;
  const seats = F1.seats(ent.teamId).filter(s => s.holderCharId === charId);
  return seats.some(s => s.role === 'principal' || ((s.role === 'engineer' || s.role === 'driver') && s.car === ent.car));
}
const raceLaps = w => { const t = F1.track(w.trackId) || {}; return w.state ? w.state.laps : (w.session === 'sprint' ? (t.sprintLaps || Math.ceil((t.laps || 50) / 3)) : (t.laps || 50)); };
function cleanPlan(p, laps) {
  p = p || {};
  const dryOk = k => ['soft', 'medium', 'hard'].indexOf(k) !== -1;
  const stops = (p.stops || []).map(s => ({ lap: Math.round(Number(s.lap)), compound: dryOk(s.compound) ? s.compound : 'medium' }))
    .filter(s => s.lap >= 2 && s.lap <= laps - 1).sort((a, b) => a.lap - b.lap).slice(0, 3);
  return { start: dryOk(p.start) ? p.start : 'medium', stops,
    wetCall: ['early', 'normal', 'late'].indexOf(p.wetCall) !== -1 ? p.wetCall : 'normal',
    dryCall: ['early', 'normal', 'late'].indexOf(p.dryCall) !== -1 ? p.dryCall : 'normal', useSC: p.useSC !== false };
}
/* The plans that count for a car: the latest saved by someone allowed to plan it. */
function f1Plan(w, ent) {
  return list('f1_plans').filter(p => p.weekendId === w.id && p.carId === ent.id && canPlan(w, ent, p.charId))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
}
function weekendEnt(w, carId) { return (w.entrants || f1Entrants()).find(e => e.id === carId) || null; }

/* Tyre life the team knows about: measured on long runs in practice, or a rough guide from the circuit. */
function tyreKnowledge(w, ent) {
  const track = F1.track(w.trackId), circuit = FormulaRacingAdapter.toCircuit(track), out = {};
  const full = Object.assign({}, ent, { v3: ent.v3 || (f1Entrants().find(x => x.id === ent.id) || {}).v3 });
  f1Runs(w, ent.id).filter(r => r.kind === 'long').forEach(r => { const x = f1RunResult(w, full, r); if (!x.life) return; out[x.compound] = { laps: x.life, measured: true }; });
  ['soft', 'medium', 'hard'].forEach(k => { if (!out[k]) out[k] = { laps: Math.round(RaceEngine.COMPOUNDS[k].life / (circuit.tyreStress || 1)), measured: false }; });
  return out;
}
function suggestPlans(w, ent) {
  const N = raceLaps(w), L = tyreKnowledge(w, ent), clampLap = x => Math.max(2, Math.min(N - 2, Math.round(x)));
  const one = clampLap(Math.min(L.medium.laps * 0.95, Math.max(N * 0.35, N - L.hard.laps * 0.9)));
  return [
    { start: 'medium', stops: [{ lap: one, compound: 'hard' }], wetCall: 'normal', dryCall: 'normal', useSC: true },
    { start: 'soft', stops: [{ lap: clampLap(Math.min(L.soft.laps * 0.9, N * 0.3)), compound: 'medium' }, { lap: clampLap(N * 0.64), compound: 'medium' }], wetCall: 'early', dryCall: 'early', useSC: true },
    { start: 'hard', stops: [{ lap: clampLap(Math.min(L.hard.laps * 0.95, N * 0.6)), compound: 'medium' }], wetCall: 'late', dryCall: 'normal', useSC: false }
  ];
}
/* What a plan looks like, and what's wrong with it. */
function planNotes(p, N, L) {
  const stints = [], notes = []; let from = 1, tyre = p.start;
  p.stops.concat([{ lap: N, compound: null }]).forEach(s => { stints.push({ tyre, from, to: s.lap }); from = s.lap + 1; tyre = s.compound; });
  stints.forEach(s => { const len = s.to - s.from + 1, life = L[s.tyre] ? L[s.tyre].laps : 99;
    if (len > life * 1.1) notes.push(`${len} laps on ${s.tyre}s is longer than they last here (about ${life}). Expect a forced early stop.`); });
  if (new Set(stints.map(s => s.tyre)).size < 2) notes.push('Only one dry tyre: the rules need two, so the car will be made to stop near the end.');
  return { stints, notes };
}
function forecastText(w) {
  const t = F1.track(w.trackId) || {}, st = raceSettings(w), rate = r => r >= 3 ? 'far more likely than usual' : r >= 2 ? 'more likely than usual' : r <= 0.5 ? 'less likely than usual' : '';
  const extra = [st.scRate !== 1 ? `Safety cars ${rate(st.scRate)}.` : '', st.failRate !== 1 ? `Mechanical failures ${rate(st.failRate)}.` : ''].filter(Boolean).join(' ');
  let wx = `${Math.round((t.wr || 0) * 0.6)}% chance of rain during the race.`;
  if (w.weatherMode === 'dry') wx = 'Dry all race.'; else if (w.weatherMode === 'mid') wx = 'Rain is expected during the race.'; else if (w.weatherMode === 'wet') wx = 'A wet start, drying out.';
  else if (st.rainPct !== 'track' && st.rainPct != null) wx = `${st.rainPct}% chance of rain during the race.`;
  return (wx + ' ' + extra).trim();
}

/* ---------------------------------------------------------------- editing */
function stratForm(w, ent) {
  const f = S.ui.form.strat = S.ui.form.strat || {};
  if (!f[ent.id] || f[ent.id].weekendId !== w.id) {
    const doc = f1Plan(w, ent);
    const def = doc ? null : (prevPlanDoc(w, ent) || presetFor('team', w, ent));
    f[ent.id] = { weekendId: w.id, plans: doc ? clone(doc.plans) : def.plans, active: doc ? String(doc.active || 0) : '0', tab: 0,
      triggers: doc ? clone(doc.triggers || []) : def.triggers, approach: doc ? (doc.approach || defaultApproach(ent)) : (def.approach || defaultApproach(ent)), preset: doc ? doc.preset : (def.preset || 'team') };
  }
  return f[ent.id];
}
ACTIONS['strat-tab'] = d => { S.ui.form.strat[d.car].tab = Number(d.i); render(); };
ACTIONS['strat-add'] = d => { const p = S.ui.form.strat[d.car].plans[d.i]; if (p.stops.length >= 3) return;
  const last = p.stops.length ? p.stops[p.stops.length - 1].lap : 0; p.stops.push({ lap: Math.min(raceLaps(S.ui.stratW || F1.live()) - 2, last + 15), compound: 'medium' }); render(); };
ACTIONS['strat-del'] = d => { S.ui.form.strat[d.car].plans[d.i].stops.splice(Number(d.j), 1); render(); };
ACTIONS['strat-suggest'] = d => { const w = S.ui.stratW || F1.live(), ent = weekendEnt(w, d.car); S.ui.form.strat[d.car].plans = suggestPlans(w, ent); toast('Plans filled in from what the team knows about the tyres. Adjust, then save.'); render(); };
ACTIONS['strat-save'] = d => {
  const w = F1.live(), c = currentChar(), ent = w && weekendEnt(w, d.car); if (!w || !c || !ent) return;
  if (!canPlan(w, ent, c.id)) { toast('Only the team principal, this car’s engineer or its driver plan its race.', true); return; }
  if (w.state && w.state.lap > 0) { toast('The race has started: switch plans from the pit wall instead.', true); return; }
  const f = S.ui.form.strat[d.car], N = raceLaps(w);
  run(async () => { await Data.put('f1_plans', `${w.id}-${d.car}-${c.id}`, { userId: asOwner(), charId: c.id, weekendId: w.id, carId: d.car,
    plans: f.plans.map(p => cleanPlan(p, N)), active: Math.max(0, Math.min(2, Number(f.active) || 0)), triggers: (f.triggers || []).slice(0, 6), approach: f.approach || defaultApproach(ent), preset: f.preset || null, at: nowIso() }); },
    `Plans saved. ${PLAN_NAMES[Number(f.active) || 0]} is set for the start.`);
};
ACTIONS['strat-switch'] = d => f1SendCall({ type: 'strategy', carId: d.car, value: Number(d.i) });

/* At the start: every car with a saved plan starts on its tyre and follows it. */
function f1ApplyPlans(w, state) {
  const st = clone(state);
  st.cars.forEach(car => {
    const ent = (w.entrants || []).find(e => e.id === car.id); if (!ent) return;
    /* Saved plans, or for a team with players and nothing saved, the team's own preset and the driver's natural approach. */
    const doc = planDocFor(w, ent); if (!doc) return;
    applyPlanDoc(car, doc, st);
  });
  return st;
}
function f1StrategyCall(w, c) {
  const ent = weekendEnt(w, c.carId), doc = ent && f1Plan(w, ent); if (!doc) return null;
  const i = Number(c.value) || 0, p = cleanPlan(doc.plans[i], w.state.laps);
  return { entry: c.carId, type: 'strategy', plan: i, name: PLAN_NAMES[i], stops: p.stops, wetCall: p.wetCall, dryCall: p.dryCall, useSC: p.useSC };
}

/* ---------------------------------------------------------------- the strategy card */
function stintsHtml(stints) { return stints.map(s => `${f1TyreChip(s.tyre)} <span class="small">${s.from}–${s.to}</span>`).join(' &nbsp;'); }
function planEditorHtml(w, ent, f, i, N, L) {
  const p = f.plans[i], base = `ui/form/strat/${ent.id}/plans/${i}`, sel2 = (id, path, val, opts) => sel(id, path, val, opts);
  const look = planNotes(cleanPlan(p, N), N, L);
  return `<div class="plan">
    <div class="plan-grid"><label class="field">Start on${sel2(`sp-${ent.id}-${i}-start`, base + '/start', p.start, DRY_TYRES)}</label>
      <label class="field">If it rains, go onto wet tyres${sel2(`sp-${ent.id}-${i}-wet`, base + '/wetCall', p.wetCall, WET_CALLS)}</label>
      <label class="field">As it dries, back onto slicks${sel2(`sp-${ent.id}-${i}-dry`, base + '/dryCall', p.dryCall, DRY_CALLS)}</label></div>
    <table class="data compact stops"><thead><tr><th>Stop</th><th>Lap</th><th>New tyres</th><th></th></tr></thead><tbody>
      ${p.stops.map((s, j) => `<tr><td>${j + 1}</td><td><label class="sr-only" for="sp-${ent.id}-${i}-${j}-lap">Lap for stop ${j + 1}</label><input id="sp-${ent.id}-${i}-${j}-lap" type="number" min="2" max="${N - 1}" value="${esc(s.lap)}" data-bind="${base}/stops/${j}/lap" data-type="number" style="max-width:90px"></td>
        <td><label class="sr-only" for="sp-${ent.id}-${i}-${j}-c">Tyre for stop ${j + 1}</label>${sel2(`sp-${ent.id}-${i}-${j}-c`, `${base}/stops/${j}/compound`, s.compound, DRY_TYRES)}</td>
        <td><button class="btn small" data-act="strat-del" data-car="${esc(ent.id)}" data-i="${i}" data-j="${j}">Remove</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No stops: start to finish on one set (risky, and against the rules in a dry race).</td></tr>'}</tbody></table>
    <div class="btn-row">${p.stops.length < 3 ? `<button class="btn small" data-act="strat-add" data-car="${esc(ent.id)}" data-i="${i}">Add a stop</button>` : ''}
      <label class="small"><input type="checkbox" data-bind="${base}/useSC" ${p.useSC !== false ? 'checked' : ''}> Take a stop under a safety car if one is due within 10 laps</label></div>
    <p class="plan-look">${stintsHtml(look.stints)}</p>${look.notes.map(n => `<p class="small warn-note">${esc(n)}</p>`).join('')}</div>`;
}
function f1StrategyCardHtml(w) {
  if (!w || w.status === 'finished') return '';
  const c = currentChar(); if (!c) return '';
  const cars = (w.entrants || f1Entrants()).filter(e => canPlan(w, e, c.id) && (!S.ui.wkCarNow || e.id === S.ui.wkCarNow)); if (!cars.length) return '';
  S.ui.stratW = w;
  const N = raceLaps(w), started = !!(w.state && w.state.lap > 0), locked = raceLocked(w);
  const body = cars.map(ent => {
    const t = F1.team(ent.teamId), doc = f1Plan(w, ent), by = doc ? get('characters', doc.charId) : null;
    if (started) {
      const car = w.state.cars.find(x => x.id === ent.id); if (!car || car.status !== 'running') return '';
      const pend = f1Calls(w).find(x => x.type === 'strategy' && x.carId === ent.id), plans = doc ? doc.plans : [];
      const next = (car.plan || [])[0];
      if (locked) return `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(ent.name)}</h3>${lockedStatusHtml(w, ent, car)}</div>`;
      return `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(ent.name)}</h3>
        <p>${car.planned ? `On <b>${esc(car.planName || 'the team’s plan')}</b>. ${next ? `Next stop: lap ${next.lap}, ${esc(RaceEngine.COMPOUNDS[next.compound].label.toLowerCase())}s.` : 'No more stops planned.'}` : 'No plan saved: the AI strategist is running this car.'}</p>
        ${plans.length ? `<div class="btn-row">${plans.map((p, i) => `<button class="btn small" data-act="strat-switch" data-car="${esc(ent.id)}" data-i="${i}" aria-pressed="${!!(pend && Number(pend.value) === i)}" ${car.planName === PLAN_NAMES[i] && !pend ? 'disabled' : ''}>Switch to ${PLAN_NAMES[i]}</button>`).join('')}</div>
          <p class="muted small">Switching keeps the stops still ahead in that plan, and its weather calls.</p>` : ''}</div>`;
    }
    const f = stratForm(w, ent), L = tyreKnowledge(w, ent), tab = f.tab || 0;
    return `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(ent.name)}</h3>
      <p class="muted small">Tyre life here: ${['soft', 'medium', 'hard'].map(k => `${f1TyreChip(k)} about ${L[k].laps} laps${L[k].measured ? '' : ' (rough guide)'}`).join(' &nbsp; ')}. ${Object.values(L).some(x => !x.measured) ? 'Long runs in practice measure them properly.' : 'Measured in practice.'}</p>
      ${doc ? `<p class="small">Saved by ${esc(by ? by.name : 'the team')} ${esc(fmtWhen(doc.at))}. ${esc(PLAN_NAMES[doc.active || 0])} is set for the start.</p>` : `<p class="small">${esc(planSourceText(w, ent))} Shown below; change anything and save.</p>`}
      <div class="tabs" role="tablist">${PLAN_NAMES.map((n, i) => `<button role="tab" class="tab" data-act="strat-tab" data-car="${esc(ent.id)}" data-i="${i}" aria-selected="${tab === i}">${n}</button>`).join('')}</div>
      ${presetBarHtml(ent, f)}
      ${planEditorHtml(w, ent, f, tab, N, L)}
      ${approachHtml(ent, f)}
      ${triggersEditorHtml(ent, f, N)}
      <div class="btn-row"><label class="field" style="margin:0">Start the race on${sel(`sp-${ent.id}-active`, `ui/form/strat/${ent.id}/active`, f.active, PLAN_NAMES.map((n, i) => [String(i), n]))}</label>
        <button class="btn primary" data-act="strat-save" data-car="${esc(ent.id)}">Save all three plans</button>
        <button class="btn" data-act="strat-suggest" data-car="${esc(ent.id)}">Suggest plans</button></div></div>`;
  }).join('');
  if (!body.trim()) return '';
  return `<section class="card strategy"><h2>Race strategy <span class="sub">${esc(raceLaps(w))} laps. ${esc(forecastText(w))}</span></h2>
    ${!started ? `<p class="muted small">The team principal, the car’s engineer and its driver can all plan; the last plans saved are the ones the car uses. ${raceSettings(w).lock !== false ? 'This is an official race: once it starts, nothing can be changed. The plans, triggers and race approach run the car.' : 'Plans can be switched from here during the race.'}</p>` : ''}${body}</section>`;
}

/* =====================================================================
   F1 SIM — driver moments.
   When a player's driver is right behind someone, has someone right
   behind them, or is lining up a safety-car restart, the race offers them
   a choice for the next lap. The odds shown come from the race engine and
   are the odds used. In a live race Race Control's run waits up to 45
   seconds for the answer; otherwise the driver's instinct decides.
   ===================================================================== */
'use strict';

const MOMENT_WAIT = 45000;
const MOMENT_GAP = 0.9;          // seconds: close enough for a moment
const MOMENT_COOLDOWN = 5;       // laps between moments for one car
const MOMENT_CHOICES = {
  attack: [['outside', 'Around the outside', 'The bold move: the best chance, and the most risk of contact.'], ['inside', 'Down the inside', 'Late on the brakes: a decent chance, less risk.'],
    ['boost', 'Use the boost', 'Spend battery for a clean run past. Needs 35% battery.'], ['wait', 'Bide your time', 'No attempt: save tyres and battery for later.']],
  defend: [['cover', 'Cover the inside', 'Defend hard: the best chance to hold on, costs a little time.'], ['hold', 'Hold your line', 'Race them fairly.'],
    ['concede', 'Let them by', 'Save your tyres for the fight that matters.']],
  restart: [['jump', 'Go for the jump', 'Gain time at the restart, or get it wrong.'], ['safe', 'Play it safe', 'Clean restart, no risk.']]
};
const MOMENT_TITLE = { attack: o => `You’re right behind ${o}`, defend: o => `${o} is all over the back of you`, restart: () => 'The safety car is coming in' };

const pendingMoments = w => (w && w.moments || []).filter(m => !m.resolved && w.state && m.lap === w.state.lap + 1);
const momentCall = (w, m) => f1Calls(w).filter(c => c.type === 'moment' && c.momentId === m.id && f1CallAllowed(c, w)).pop() || null;
/* The driver's instinct, when nobody answers. */
function defaultChoice(m, car) {
  const ap = car && car.approach;
  if (ap === 'attacker') return { attack: 'outside', defend: 'cover', restart: 'jump' }[m.kind];
  if (ap === 'defender') return { attack: 'inside', defend: 'cover', restart: 'safe' }[m.kind];
  if (ap === 'tyres') return { attack: 'wait', defend: 'concede', restart: 'safe' }[m.kind];
  const ag = (car && car.driver && car.driver.aggression) || 50;
  if (m.kind === 'attack') return ag >= 65 ? 'outside' : ag >= 50 ? 'inside' : 'wait';
  if (m.kind === 'defend') return ag >= 60 ? 'cover' : 'hold';
  return ag >= 60 ? 'jump' : 'safe';
}
/* After a lap: new moments for players' drivers. */
function f1NewMoments(w, st, log) {
  if (st.finished || st.sc.type && !log.some(l => (l.kind === 'sc' || l.kind === 'vsc') && /ends/.test(l.text))) return [];
  const restart = log.some(l => l.kind === 'sc' && /ends/.test(l.text)), order = f1Order(st).filter(c => c.status === 'running'), out = [];
  const recent = id => (w.moments || []).some(m => m.carId === id && m.lap > st.lap - MOMENT_COOLDOWN);
  (w.entrants || []).filter(e => e.charId).forEach(e => {
    const car = order.find(c => c.id === e.id); if (!car || recent(e.id)) return;
    const i = order.indexOf(car), ahead = order[i - 1], behind = order[i + 1];
    let kind = null, opp = null;
    if (restart) kind = 'restart';
    else if (ahead && car.cum - ahead.cum < MOMENT_GAP) { kind = 'attack'; opp = ahead.id; }
    else if (behind && behind.cum - car.cum < MOMENT_GAP) { kind = 'defend'; opp = behind.id; }
    if (kind) out.push({ id: newId('mom'), carId: e.id, kind, opponent: opp, lap: st.lap + 1, createdAt: nowIso() });
  });
  return out;
}
/* Before a lap: settle the pending moments into engine calls. */
function f1MomentCalls(w) {
  const calls = [], resolved = [];
  pendingMoments(w).forEach(m => {
    const call = momentCall(w, m), car = w.state.cars.find(c => c.id === m.carId);
    const choice = call && MOMENT_CHOICES[m.kind].some(x => x[0] === call.value) ? call.value : defaultChoice(m, car);
    calls.push({ entry: m.carId, type: 'moment', kind: m.kind, choice });
    resolved.push(Object.assign({}, m, { resolved: true, choice, auto: !call }));
  });
  return { calls, resolved };
}
function momentsAnswered(w) { return pendingMoments(w).every(m => !!momentCall(w, m)); }
function momentWaitLeft(w) {
  const p = pendingMoments(w); if (!p.length) return 0;
  return Math.max(0, MOMENT_WAIT - (Date.now() - Math.min(...p.map(m => Date.parse(m.createdAt)))));
}
ACTIONS['moment-choose'] = d => {
  const w = F1.live(); if (!w) return;
  const m = (w.moments || []).find(x => x.id === d.id); if (!m || m.resolved) { toast('That moment has passed.', true); return; }
  f1SendCall({ type: 'moment', carId: m.carId, value: d.choice, momentId: m.id });
};

/* The choice card on the driver's pit wall. */
function f1MomentCardHtml(w) {
  if (!w || w.status !== 'running' || !S.charId || raceLocked(w)) return '';
  const mine = pendingMoments(w).filter(m => f1CallAllowed({ type: 'moment', carId: m.carId, charId: S.charId }, w)); if (!mine.length) return '';
  return mine.map(m => {
    const st = w.state, car = st.cars.find(c => c.id === m.carId), opp = m.opponent ? st.cars.find(c => c.id === m.opponent) : null;
    const call = momentCall(w, m), left = Math.ceil(momentWaitLeft(w) / 1000);
    const odds = ch => RaceEngine.momentOdds(m.kind, ch, car, opp, st.circuit);
    const oppName = opp ? f1Ent(w, opp.id).name : '';
    return `<section class="card moment" aria-live="assertive"><p class="eyebrow">Driver moment, lap ${m.lap}</p><h2>${esc(MOMENT_TITLE[m.kind](oppName))}</h2>
      <p class="muted">${w.live ? `The race waits ${left > 0 ? `${left} more seconds` : 'a moment longer'} for your call; after that your instinct decides.` : 'Choose before Race Control runs the next lap; otherwise your instinct decides.'}</p>
      <div class="choices">${MOMENT_CHOICES[m.kind].filter(c => c[0] !== 'boost' || !st.rules.noHybrid).map(([k, l, d]) => { const o = odds(k), pct = Math.round(o.success * 100);
        return `<button class="choice" data-act="moment-choose" data-id="${esc(m.id)}" data-choice="${k}" aria-pressed="${!!(call && call.value === k)}"><b>${esc(l)}</b><span>${esc(d)}</span>
          <span class="odds">${['wait', 'concede', 'safe'].indexOf(k) !== -1 ? 'No risk' : `${pct}% ${m.kind === 'defend' ? 'to hold on' : m.kind === 'restart' ? 'to gain time' : 'to make it stick'}${o.contact ? `, ${Math.round(o.contact * 100)}% contact risk` : ''}`}</span></button>`; }).join('')}</div>
      ${call ? `<p class="small">Your call: <b>${esc(MOMENT_CHOICES[m.kind].find(x => x[0] === call.value)[1])}</b>. You can change it until the lap runs.</p>` : ''}</section>`;
  }).join('');
}

/* =====================================================================
   F1 SIM — notifications and announcements.
   Each person's feed is worked out from the league's records: decisions
   on their applications, seats, race weekends, contract offers, a team-
   mate changing their plans, awards, driver moments, and announcements
   from Race Control. What's been read is remembered on this device.
   ===================================================================== */
'use strict';

const seenKey = () => 'f1sim.seen.' + (S.uid || 'anon');
const lastSeen = () => lsGet(seenKey()) || '1970';
function f1Feed() {
  const items = [], mine = S.isGm ? list('characters').filter(c => c.userId === S.uid) : myChars(), mineIds = new Set(mine.map(c => c.id));
  const add = (at, text, route, opts) => { if (at) items.push(Object.assign({ at, text, route }, opts || {})); };
  list('f1_notices').forEach(n => add(n.at, `${n.title}`, 'notices', { kind: 'notice', body: n.body }));
  mine.forEach(c => {
    if (c.decidedAt && (c.status === 'approved' || c.status === 'returned')) add(c.decidedAt, c.status === 'approved' ? `${c.name}’s application was approved.` : `${c.name}’s application came back with a note from Race Control.`, 'character', { charId: c.id });
  });
  list('f1_applications').filter(a => mineIds.has(a.charId) && a.decidedAt).forEach(a => add(a.decidedAt, `${a.charName}’s application to ${F1.team(a.teamId).name}: ${a.status === 'approved' ? 'you have the seat' : 'declined'}.`, 'grid'));
  F1.seats().filter(s => mineIds.has(s.holderCharId) && s.holderSince).forEach(s => add(s.holderSince, `${s.holderName} is now ${seatTitle(s).toLowerCase()} at ${F1.team(s.teamId).name}.`, 'team'));
  F1.weekends().forEach(w => { const t = F1.track(w.trackId) || {}, nm = `${t.name || ''}${w.session === 'sprint' ? ' sprint' : ''}`;
    add(w.createdAt, `${nm} weekend is open: practice has started.`, 'weekend');
    if (w.status === 'finished') { const win = (w.results || [])[0]; add(w.finishedAt, `${nm}: ${win ? win.name + ' wins' : 'race finished'}.`, 'weekend'); }
    if (S.charId && w.status !== 'finished') {
      (w.entrants || f1Entrants()).filter(e => canPlan(w, e, S.charId)).forEach(e => { const p = f1Plan(w, e);
        if (p && p.charId !== S.charId) add(p.at, `${(get('characters', p.charId) || {}).name || 'A team-mate'} saved the race plans for ${e.name}.`, 'weekend'); });
    }
    (w.moments || []).filter(m => !m.resolved).forEach(m => { const e = (w.entrants || []).find(x => x.id === m.carId); if (e && mineIds.has(e.charId)) items.push({ at: nowIso(), text: `Driver moment for ${e.name}: make your call now.`, route: 'weekend', urgent: true }); });
  });
  if (typeof f1ContractOffersFor === 'function') mine.forEach(c => f1ContractOffersFor(c.id).forEach(o => add(o.at, `${F1.team(o.teamId).name} has offered ${c.name} a contract.`, 'character', { charId: c.id })));
  if (typeof f1AwardsFor === 'function') mine.forEach(c => f1AwardsFor(f1PcId(c.id)).forEach(a => add(a.at, `${c.name}: ${a.label}, ${a.where}.`, 'career', { personId: f1PcId(c.id) })));
  return items.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 80);
}
const unreadCount = () => { const seen = lastSeen(); return f1Feed().filter(i => i.urgent || String(i.at) > seen).length; };
ACTIONS['feed-open'] = d => {
  const i = f1Feed()[Number(d.i)]; if (!i) return;
  if (i.charId) S.ui.charEdit = i.charId; if (i.personId) S.ui.career = i.personId;
  go(i.route || 'home');
};
route('notices', 'Notifications', function () {
  const seen = lastSeen(), feed = f1Feed(), notices = list('f1_notices').sort((a, b) => String(b.at).localeCompare(String(a.at)));
  setTimeout(() => { lsSet(seenKey(), nowIso()); }, 0);
  return `<div class="page-head"><div><h1>Notifications</h1><p>What’s happened for you and your characters, newest first.</p></div></div>
    ${notices.length ? `<section class="card"><h2>From Race Control</h2>${notices.slice(0, 5).map(n => `<article class="notice-item"><p class="muted small">${esc(fmtWhen(n.at))}</p><h3>${esc(n.title)}</h3>${paras(n.body)}</article>`).join('')}</section>` : ''}
    <section class="card"><ul class="feed-list">${feed.length ? feed.map((i, n) => `<li class="${i.urgent ? 'urgent' : String(i.at) > seen ? 'new' : ''}"><button class="linkish" data-act="feed-open" data-i="${n}">${esc(i.text)}</button><span class="muted small">${i.urgent ? 'Now' : esc(fmtWhen(i.at))}</span></li>`).join('') : '<li class="muted">Nothing yet.</li>'}</ul></section>`;
});

/* ---------------------------------------------------------------- announcements (Race Control) */
ACTIONS['notice-post'] = () => {
  const f = S.ui.form.notice || {}, title = String(f.title || '').trim(), body = String(f.body || '').trim();
  if (!title || !body) { toast('Give the announcement a title and some words.', true); return; }
  run(async () => {
    await Data.put('f1_notices', newId('note'), { title, body, at: nowIso(), by: actorLabel() });
    if (f.discord) await discordSend('announcements', { embeds: [{ title, description: body.slice(0, 3900), color: 0xE10600, footer: { text: 'F1 SIM, Race Control' } }] });
    await Data.audit('notice.post', `Announcement: ${title}`);
    S.ui.form.notice = {};
  }, f.discord ? 'Announcement posted, here and on Discord.' : 'Announcement posted.');
};
ACTIONS['notice-delete'] = d => askConfirm('Delete this announcement?', 'Delete', () => run(async () => { await Data.remove('f1_notices', d.id); }, 'Announcement deleted.'), true);
function noticeComposerHtml() {
  const f = S.ui.form.notice = S.ui.form.notice || {}, all = list('f1_notices').sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return `<section class="card"><h2>Announcements</h2><p class="muted small">Briefings, rule changes, race-night times. Everyone sees them in Notifications.</p>
    <label class="field">Title<input id="nt-title" type="text" data-bind="ui/form/notice/title" value="${esc(f.title || '')}" placeholder="e.g. Silverstone weekend: practice opens Friday at 8pm"></label>
    <label class="field">Announcement<textarea id="nt-body" rows="4" data-bind="ui/form/notice/body">${esc(f.body || '')}</textarea></label>
    <div class="btn-row"><button class="btn primary" data-act="notice-post">Post the announcement</button><label class="small"><input type="checkbox" data-bind="ui/form/notice/discord" ${f.discord ? 'checked' : ''}> Also post it to Discord</label></div>
    ${all.length ? `<details style="margin-top:12px"><summary>Earlier announcements</summary><table class="data compact"><tbody>${all.map(n => `<tr><td class="nowrap">${esc(fmtDate(n.at))}</td><td>${esc(n.title)}</td><td class="num"><button class="btn small" data-act="notice-delete" data-id="${esc(n.id)}">Delete</button></td></tr>`).join('')}</tbody></table></details>` : ''}</section>`;
}

/* =====================================================================
   F1 SIM — driver profiles, awards and driver cards.
   A profile for every driver: portrait, particulars, diary, the
   relationships players declare, track rivals worked out from the race
   logs, a career timeline, the trophy cabinet and the race-by-race
   record. Awards come from the results (pole, win, fastest lap, biggest
   climber, set-up of the weekend) plus Driver of the Day, voted by
   everyone after each race. Driver cards are drawn in the browser as
   images to download or, for Race Control, post to Discord.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------- portraits */
async function shrinkImage(file, max) {
  const url = URL.createObjectURL(file), img = new Image();
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; });
  const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  return new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.86));
}
CHANGES['portrait'] = (v, d, el) => {
  const file = el.files && el.files[0], c = get('characters', d.id); if (!file || !c) return;
  if (!/^image\//.test(file.type)) { toast('Choose a picture: a JPEG, PNG or WebP.', true); return; }
  run(async () => {
    const blob = await shrinkImage(file, 900), assets = await window.claude.use('assets');
    const up = await assets.upload(blob, { type: 'image/jpeg' });
    await Data.put('characters', c.id, Object.assign(clone(S.store.characters[c.id]), { portraitUrl: up.url, updatedAt: nowIso() }));
  }, 'Portrait saved.');
  el.value = '';
};
const portraitHtml = (c, size) => c && c.portraitUrl ? `<img class="portrait" src="${esc(c.portraitUrl)}" alt="${esc(c.name)}" width="${size}" height="${size}" loading="lazy">`
  : `<span class="portrait none" style="width:${size}px;height:${size}px" aria-hidden="true">${esc((c && (c.code || f1Code(c.name))) || '')}</span>`;

/* ---------------------------------------------------------------- awards and Driver of the Day */
const votesFor = w => list('f1_votes').filter(v => v.weekendId === w.id);
const votingOpen = w => w.status === 'finished' && !F1.weekends().some(x => x.id !== w.id && String(x.createdAt) > String(w.finishedAt));
function dotdWinner(w) {
  const tally = new Map(); votesFor(w).forEach(v => tally.set(v.personId, (tally.get(v.personId) || 0) + 1));
  if (!tally.size) return null;
  const pos = id => ((w.results || []).find(r => r.personId === id) || {}).position || 99;
  const [personId, votes] = [...tally.entries()].sort((a, b) => b[1] - a[1] || pos(a[0]) - pos(b[0]))[0];
  return { personId, votes, total: votesFor(w).length };
}
function weekendAwards(w) {
  if (w.status !== 'finished') return [];
  const t = F1.track(w.trackId) || {}, where = `${t.name || ''}${w.session === 'sprint' ? ' sprint' : ''}`, at = w.finishedAt, rs = w.results || [], out = [];
  const byCode = code => (w.entrants || []).find(e => e.id === code) || {};
  const pole = w.quali && w.quali.grid ? byCode(w.quali.grid[0]) : null;
  if (pole && pole.personId && w.session === 'gp') out.push({ key: 'pole', label: 'Pole position', personId: pole.personId, where, at });
  if (rs[0]) out.push({ key: 'win', label: w.session === 'sprint' ? 'Sprint win' : 'Race win', personId: rs[0].personId, where, at });
  if (w.state && w.state.fastest) { const f = byCode(w.state.fastest.id); if (f.personId) out.push({ key: 'fastest', label: 'Fastest lap', personId: f.personId, where, at }); }
  const climb = rs.filter(r => r.position).map(r => ({ r, g: r.grid - r.position })).sort((a, b) => b.g - a.g)[0];
  if (climb && climb.g >= 3) out.push({ key: 'climber', label: `Biggest climber (${climb.g} places)`, personId: climb.r.personId, where, at });
  const d = dotdWinner(w); if (d && !votingOpen(w)) out.push({ key: 'dotd', label: 'Driver of the Day', personId: d.personId, where, at });
  if (w.setupBy && w.setup) { const best = Object.keys(w.setupBy).sort((a, b) => w.setup[b] - w.setup[a])[0]; if (best) out.push({ key: 'setup', label: 'Set-up of the weekend', personId: f1PcId(w.setupBy[best]), where, at }); }
  return out;
}
const f1AwardsFor = personId => F1.allWeekends().flatMap(weekendAwards).filter(a => a.personId === personId);
ACTIONS['dotd-vote'] = d => {
  const w = get('f1_weekends', d.w); if (!w || !votingOpen(w)) { toast('Voting for this race has closed.', true); return; }
  run(async () => { await Data.put('f1_votes', `${w.id}-${S.uid}`, { userId: S.uid, weekendId: w.id, personId: d.id, at: nowIso() }); }, 'Vote counted. You can change it until the next weekend opens.');
};
function dotdHtml(w) {
  if (w.status !== 'finished') return '';
  const open = votingOpen(w), mine = votesFor(w).find(v => v.userId === S.uid), win = dotdWinner(w), rs = (w.results || []).filter(r => r.position);
  const tally = new Map(); votesFor(w).forEach(v => tally.set(v.personId, (tally.get(v.personId) || 0) + 1));
  const cands = rs.slice(0, 10).concat(rs.filter(r => r.charId && r.position > 10)).concat(rs.filter(r => r.grid - r.position >= 5 && r.position > 10));
  const uniq = [...new Map(cands.map(r => [r.personId, r])).values()];
  return `<section class="card dotd"><h2>Driver of the Day</h2>
    ${open ? `<p class="muted small">Everyone gets one vote. ${mine ? 'You can change yours until the next weekend opens.' : 'Voting closes when the next weekend opens.'}</p>
      <div class="vote-grid">${uniq.map(r => `<button class="vote ${mine && mine.personId === r.personId ? 'on' : ''}" data-act="dotd-vote" data-w="${esc(w.id)}" data-id="${esc(r.personId)}" aria-pressed="${!!(mine && mine.personId === r.personId)}" style="--team:${esc(f1Colour(r.teamId))}">
        <b>${esc(r.name)}</b><span>P${r.position} from P${r.grid}</span>${mine ? `<span class="votes">${tally.get(r.personId) || 0}</span>` : ''}</button>`).join('')}</div>`
      : win ? `<p><b>${careerLink(win.personId, (F1.person(win.personId) || {}).name || '')}</b>, with ${plural(win.votes, 'vote')} of ${win.total}.</p>` : '<p class="muted">Nobody voted.</p>'}</section>`;
}

/* ---------------------------------------------------------------- diary and relationships */
const REL_KINDS = [['rival', 'Rival'], ['friend', 'Friend'], ['mentor', 'Mentor'], ['history', 'Unfinished business']];
ACTIONS['diary-new'] = () => { S.ui.form.diary = { title: '', body: '' }; openDrawer('diary'); };
DRAWERS.diary = function () {
  const f = S.ui.form.diary || {}, c = currentChar();
  return `<header><div><h2>Diary</h2><p>Written as ${esc(c ? c.name : '')}. Diary entries appear on the profile for everyone to read.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><label class="field">Title<input id="di-title" type="text" data-bind="ui/form/diary/title" value="${esc(f.title || '')}" placeholder="e.g. Monza, Thursday night"></label>
    <label class="field">Entry<textarea id="di-body" rows="12" data-bind="ui/form/diary/body">${esc(f.body || '')}</textarea></label>
    <div class="btn-row"><button class="btn primary" data-act="diary-save">Save the entry</button></div></div>`;
};
ACTIONS['diary-save'] = () => { const f = S.ui.form.diary || {}, c = currentChar(); if (!c) return;
  if (!String(f.title || '').trim() || !String(f.body || '').trim()) { toast('Give the entry a title and some words.', true); return; }
  run(async () => { await Data.put('f1_diary', newId('di'), { userId: asOwner(), charId: c.id, title: f.title.trim(), body: f.body.trim(), at: nowIso() }); closeDrawer(); }, 'Diary entry saved.'); };
ACTIONS['diary-delete'] = d => askConfirm('Delete this diary entry?', 'Delete', () => run(async () => { await Data.remove('f1_diary', d.id); }, 'Entry deleted.'), true);
ACTIONS['rel-new'] = () => { S.ui.form.rel = { otherId: '', kind: 'rival', note: '' }; openDrawer('rel'); };
DRAWERS.rel = function () {
  const f = S.ui.form.rel || {}, c = currentChar(), people = list('f1_people').filter(p => p.id !== f1PcId(c && c.id)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return `<header><div><h2>A relationship</h2><p>Who matters to ${esc(c ? c.name : '')}, and how. It shows on both profiles.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><label class="field">Who${sel('rel-other', 'ui/form/rel/otherId', f.otherId, people.map(p => [p.id, p.name + (p.charId ? ' (player)' : '')]), 'Choose someone')}</label>
    <label class="field">What they are${sel('rel-kind', 'ui/form/rel/kind', f.kind, REL_KINDS)}</label>
    <label class="field">The story (optional)<textarea id="rel-note" rows="4" data-bind="ui/form/rel/note" placeholder="e.g. Karting rivals since they were nine. Neither has forgiven Macau.">${esc(f.note || '')}</textarea></label>
    <div class="btn-row"><button class="btn primary" data-act="rel-save">Save</button></div></div>`;
};
ACTIONS['rel-save'] = () => { const f = S.ui.form.rel || {}, c = currentChar(); if (!c || !f.otherId) { toast('Choose someone.', true); return; }
  run(async () => { await Data.put('f1_relations', newId('rel'), { userId: asOwner(), charId: c.id, personId: f1PcId(c.id), otherId: f.otherId, kind: f.kind || 'rival', note: String(f.note || '').trim(), at: nowIso() }); closeDrawer(); }, 'Saved to the profile.'); };
ACTIONS['rel-delete'] = d => run(async () => { await Data.remove('f1_relations', d.id); }, 'Removed.');

/* Track rivals: who they've swapped places with most, from every race log. */
function trackRivals(personId) {
  const m = new Map();
  F1.allWeekends().filter(w => w.status === 'finished').forEach(w => {
    const me = (w.entrants || []).find(e => e.personId === personId); if (!me) return;
    ((w.state && w.state.events) || []).filter(e => (e.kind === 'overtake' || e.kind === 'moment') && (e.ids || []).length === 2 && e.ids.indexOf(me.id) !== -1).forEach(e => {
      const otherCode = e.ids[0] === me.id ? e.ids[1] : e.ids[0], other = (w.entrants || []).find(x => x.id === otherCode); if (!other) return;
      const r = m.get(other.personId) || { personId: other.personId, name: other.name, teamId: other.teamId, won: 0, lost: 0 };
      if (e.kind === 'overtake') { if (e.ids[0] === me.id) r.won++; else r.lost++; } else if (/stick|holds off/.test(e.text)) r.won += e.ids[0] === me.id ? 1 : 0;
      m.set(other.personId, r);
    });
  });
  return [...m.values()].sort((a, b) => (b.won + b.lost) - (a.won + a.lost)).slice(0, 4);
}
/* The career timeline, from the records. */
function timeline(p) {
  const out = [], c = p.charId ? get('characters', p.charId) : null;
  if (c && c.decidedAt && c.status === 'approved') out.push({ at: c.decidedAt, text: 'Approved by Race Control' });
  const seat = p.charId ? F1.seats().find(s => s.holderCharId === p.charId) : null;
  if (seat && seat.holderSince) out.push({ at: seat.holderSince, text: `${seatTitle(seat)} at ${F1.team(seat.teamId).name}` });
  if (typeof f1ContractsFor === 'function' && p.charId) f1ContractsFor(p.charId).forEach(k => out.push({ at: k.signedAt, text: `Signed with ${F1.team(k.teamId).name}${k.salary ? `, £${k.salary}m a season` : ''}` }));
  const rec = f1Record(p.id), firsts = {};
  rec.forEach(x => { const t = F1.track(x.w.trackId) || {}, where = t.name + (x.w.session === 'sprint' ? ' sprint' : ''), pos = x.r.position;
    if (!firsts.start) { firsts.start = 1; out.push({ at: x.w.finishedAt, text: `First race: ${where}, ${pos ? 'P' + pos : 'retired'}` }); }
    if (pos && x.r.points && !firsts.points) { firsts.points = 1; out.push({ at: x.w.finishedAt, text: `First points: P${pos} at ${where}` }); }
    if (pos && pos <= 3 && !firsts.podium && x.w.session === 'gp') { firsts.podium = 1; out.push({ at: x.w.finishedAt, text: `First podium: P${pos} at ${where}` }); }
    if (pos === 1 && x.w.session === 'gp') out.push({ at: x.w.finishedAt, text: `Won the ${where}` });
  });
  f1AwardsFor(p.id).filter(a => a.key === 'dotd' || a.key === 'pole').forEach(a => out.push({ at: a.at, text: `${a.label}, ${a.where}` }));
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/* ---------------------------------------------------------------- driver cards */
const CARD_KINDS = [['card', 'Driver card'], ['signing', 'New signing'], ['pole', 'Pole position'], ['win', 'Race winner'], ['dotd', 'Driver of the Day']];
async function drawCard(personId, kind, where) {
  const p = F1.person(personId); if (!p) return null;
  const c = p.charId ? get('characters', p.charId) : null, seat = c ? F1.seats().find(s => s.holderCharId === c.id) : F1.seats().find(s => s.defaultPersonId === p.id);
  const team = F1.team(seat ? seat.teamId : p.teamId), col = team.color || '#E10600', rec = f1Record(p.id);
  const W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
  try { await Promise.all(['700 200px "Titillium Web"', '600 40px "Titillium Web"'].map(f => document.fonts.load(f))); } catch (e) { /* fall back */ }
  const cond = (wt, px) => `${wt} ${px}px "Titillium Web", "Arial Narrow", sans-serif`, body = (wt, px) => `${wt} ${px}px "Titillium Web", system-ui, sans-serif`;
  g.fillStyle = '#14181C'; g.fillRect(0, 0, W, H);
  const grad = g.createLinearGradient(0, 0, W, H); grad.addColorStop(0, col); grad.addColorStop(0.62, '#14181C'); g.globalAlpha = 0.9; g.fillStyle = grad; g.fillRect(0, 0, W, H); g.globalAlpha = 1;
  g.font = cond(700, 760); g.fillStyle = 'rgba(255,255,255,0.07)'; g.textAlign = 'right'; g.fillText(String(p.num || p.abbr || ''), W - 20, 820);
  if (c && c.portraitUrl) { try { const img = new Image(); img.crossOrigin = 'anonymous'; await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = c.portraitUrl; });
    const s = Math.max(760 / img.width, 860 / img.height), w = img.width * s, h = img.height * s; g.save(); g.beginPath(); g.rect(160, 120, 760, 860); g.clip(); g.drawImage(img, 160 + (760 - w) / 2, 120 + (860 - h) / 2, w, h); g.restore();
    const fade = g.createLinearGradient(0, 700, 0, 990); fade.addColorStop(0, 'rgba(20,24,28,0)'); fade.addColorStop(1, 'rgba(20,24,28,1)'); g.fillStyle = fade; g.fillRect(160, 700, 760, 290); } catch (e) { /* no portrait */ } }
  g.textAlign = 'left'; g.fillStyle = '#fff';
  const lg = typeof leagueLogo === 'function' ? await loadImg(leagueLogo()) : null;
  if (lg) { const h = 48, lw = Math.min(220, lg.width / lg.height * h); g.drawImage(lg, 64, 62, lw, h); g.fillStyle = '#fff'; g.font = cond(700, 44); g.fillText('F1 SIM', 64 + lw + 16, 100); }
  else { for (let r = 0; r < 2; r++) for (let q = 0; q < 2; q++) { g.fillStyle = (r + q) % 2 ? 'rgba(255,255,255,0.15)' : '#fff'; g.fillRect(64 + q * 18, 64 + r * 18, 18, 18); }
    g.fillStyle = '#fff'; g.font = cond(700, 44); g.fillText('F1 SIM', 120, 98); }
  const label = (CARD_KINDS.find(k => k[0] === kind) || CARD_KINDS[0])[1];
  g.font = cond(700, 56); g.fillStyle = col; g.fillRect(64, 150, g.measureText(label).width + 40, 76); g.fillStyle = '#fff'; g.fillText(label, 84, 208);
  const parts = String(p.name).split(' '), last = parts.pop(), first = parts.join(' ');
  g.font = body(500, 56); g.fillText(first, 64, 1060);
  let size = 190; g.font = cond(700, size); while (g.measureText(last.toUpperCase()).width > W - 128 && size > 90) { size -= 8; g.font = cond(700, size); }
  g.fillText(last.toUpperCase(), 60, 1060 + size * 0.86);
  g.font = body(600, 40); g.fillStyle = 'rgba(255,255,255,0.86)';
  const line2 = [team.name, p.num ? '#' + p.num : '', c && c.nationality ? c.nationality : ''].filter(Boolean).join('   ');
  g.fillText(line2, 64, H - 70);
  if (where) { g.textAlign = 'right'; g.fillText(where, W - 64, H - 70); g.textAlign = 'left'; }
  g.fillStyle = col; g.fillRect(0, H - 22, W, 22);
  if (kind === 'card' || kind === 'signing') {
    const stats = rec.length ? [['Races', rec.filter(x => x.w.session === 'gp').length], ['Wins', rec.filter(x => x.w.session === 'gp' && x.r.position === 1).length], ['Points', rec.reduce((a, x) => a + (x.r.points || 0), 0)]]
      : [['Pace', p.pace], ['Racecraft', Math.round(((p.overtaking || 0) + (p.defense || 0)) / 2)], ['Wet', p.wet]];
    stats.forEach(([k, v], i) => { const x = 64 + i * 200; g.fillStyle = '#fff'; g.font = cond(700, 88); g.fillText(String(v), x, 330); g.font = body(500, 32); g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillText(k, x, 372); });
  }
  return new Promise(ok => cv.toBlob(ok, 'image/png'));
}
ACTIONS['card-open'] = d => { S.ui.card = { personId: d.id, kind: d.kind || 'card', where: d.where || '', url: null }; openDrawer('card'); refreshCard(); };
async function refreshCard() {
  const c = S.ui.card; if (!c) return;
  const blob = await drawCard(c.personId, c.kind, c.where); if (!blob || S.ui.card !== c) return;
  if (c.url) URL.revokeObjectURL(c.url); c.blob = blob; c.url = URL.createObjectURL(blob); renderOverlay();
}
CHANGES['card-kind'] = v => { S.ui.card.kind = v; refreshCard(); renderOverlay(); };
DRAWERS.card = function () {
  const c = S.ui.card || {}, p = F1.person(c.personId);
  return `<header><div><h2>Driver card</h2><p>${esc(p ? p.name : '')}. Download it, or post it to Discord.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><label class="field">Kind of card<select id="card-kind" data-change="card-kind">${CARD_KINDS.map(([k, l]) => `<option value="${k}" ${c.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    ${c.url ? `<img class="card-preview" src="${c.url}" alt="The driver card">` : '<p class="muted">Drawing the card…</p>'}
    <div class="btn-row"><button class="btn primary" data-act="card-download" ${c.url ? '' : 'disabled'}>Download</button>${S.isGm ? `<button class="btn" data-act="card-discord" ${c.url ? '' : 'disabled'}>Post to Discord</button>` : ''}</div></div>`;
};
ACTIONS['card-download'] = () => { const c = S.ui.card; if (!c || !c.url) return; const a = document.createElement('a'); a.href = c.url; a.download = `${(F1.person(c.personId) || {}).abbr || 'driver'}-${c.kind}.png`; document.body.appendChild(a); a.click(); a.remove(); };
ACTIONS['card-discord'] = () => { const c = S.ui.card; if (!c || !c.blob) return; const p = F1.person(c.personId), label = (CARD_KINDS.find(k => k[0] === c.kind) || CARD_KINDS[0])[1];
  run(async () => { await discordSend('cards', { content: `**${label}:** ${p.name}${c.where ? `, ${c.where}` : ''}` }, { blob: c.blob, name: `${p.abbr || 'driver'}-${c.kind}.png` }); await Data.audit('discord.card', `${label} card for ${p.name} posted to Discord`); }, 'Posted to Discord.'); };

/* ---------------------------------------------------------------- the profile page */
route('career', 'Driver profile', function () {
  const p = F1.person(S.ui.career); if (!p) return `<div class="empty">Choose a driver from The Grid or the Championship.</div>`;
  const c = p.charId ? get('characters', p.charId) : null, mine = !!(c && (c.userId === S.uid || S.isGm) && S.charId === c.id);
  const rec = f1Record(p.id), gps = rec.filter(x => x.w.session === 'gp'), seat = c ? F1.seats().find(s => s.holderCharId === c.id) : F1.seats().find(s => s.defaultPersonId === p.id && !s.holderCharId);
  const team = seat ? F1.team(seat.teamId) : F1.team(p.teamId), pts = rec.reduce((a, x) => a + (x.r.points || 0), 0);
  const wins = gps.filter(x => x.r.position === 1).length, pods = gps.filter(x => x.r.position && x.r.position <= 3).length, poles = gps.filter(x => x.pole).length;
  const best = Math.min(...gps.map(x => x.r.position || 99)), vs = gps.filter(x => x.mate), mates = [...new Set(vs.map(x => x.mate.name))];
  const awards = f1AwardsFor(p.id), counts = {}; awards.forEach(a => { counts[a.label.replace(/ \(.*\)$/, '')] = (counts[a.label.replace(/ \(.*\)$/, '')] || 0) + 1; });
  const diary = c ? list('f1_diary').filter(x => x.charId === c.id).sort((a, b) => String(b.at).localeCompare(String(a.at))) : [];
  const rels = list('f1_relations').filter(r => r.personId === p.id || r.otherId === p.id);
  const relName = id => (F1.person(id) || {}).name || 'someone', relKind = k => (REL_KINDS.find(x => x[0] === k) || [k, k])[1];
  const rivals = trackRivals(p.id), tl = timeline(p);
  const ratings = c ? f1DevApply(Object.assign({}, F1_ROOKIE, p), c.id) : p;
  const isDriver = !p.kind || p.kind === 'driver';
  return `<div class="profile-head" style="--team:${esc(team.color || '#888')}">${portraitHtml(c || { name: p.name, code: p.abbr }, 132)}
      <div><p class="eyebrow">${team && teamBrand(team.id).logo ? `<img class="team-logo tiny" src="${esc(teamBrand(team.id).logo)}" alt="">` : ''}${esc(F1_ROLE[p.kind] || 'Driver')}${team ? ', ' + esc(team.name) : ''}${c ? '' : ', real'}</p><h1>${p.flag ? esc(p.flag) + ' ' : ''}${esc(p.name)}</h1>
        <p class="muted">${[c && c.nickname ? `“${c.nickname}”` : '', yearsNow(p) ? plural(yearsNow(p), 'year') + ' of experience' : '', p.num ? '#' + p.num : '', c && c.nationality, c && c.birthplace ? 'from ' + c.birthplace : ''].filter(Boolean).map(esc).join(', ')}</p>
        <div class="btn-row">${mine ? `<label class="btn small file-btn">Change portrait<input type="file" accept="image/*" data-change="portrait" data-id="${esc(c.id)}" class="sr-only"></label>
          <button class="btn small" data-act="diary-new">Write in the diary</button><button class="btn small" data-act="rel-new">Add a relationship</button>` : ''}
          ${isDriver ? `<button class="btn small" data-act="card-open" data-id="${esc(p.id)}" data-kind="card">Driver card</button>` : ''}</div></div></div>
    ${c && (c.bio || c.junior || c.helmet) ? `<section class="card">${c.bio ? paras(c.bio) : ''}${c.junior ? `<h4>Before Formula 1</h4>${paras(c.junior)}` : ''}${c.helmet ? `<p class="muted small">Helmet: ${esc(c.helmet)}</p>` : ''}</section>` : ''}
    ${isDriver ? `<div class="metrics"><div class="metric"><b>${gps.length}</b><span>Grands Prix</span></div><div class="metric"><b>${wins}</b><span>Wins</span></div><div class="metric"><b>${pods}</b><span>Podiums</span></div><div class="metric"><b>${pts}</b><span>Points</span></div></div>` : ''}
    <div class="cols2">
      ${isDriver ? `<section class="card"><h2>Record</h2><table class="data compact"><tbody><tr><td>Pole positions</td><td class="num">${poles}</td></tr><tr><td>Best finish</td><td class="num">${best < 99 ? 'P' + best : '–'}</td></tr>
        <tr><td>Retirements</td><td class="num">${gps.filter(x => !x.r.position).length}</td></tr>
        ${mates.length ? `<tr><td>Against ${esc(mates.join(' and '))}, races</td><td class="num">${vs.filter(x => x.beat).length} to ${vs.filter(x => !x.beat).length}</td></tr><tr><td>Against ${esc(mates.join(' and '))}, qualifying</td><td class="num">${vs.filter(x => x.qbeat).length} to ${vs.filter(x => !x.qbeat).length}</td></tr>` : ''}</tbody></table>
        <h4>Trophy cabinet</h4>${awards.length ? `<p>${Object.keys(counts).map(k => `<span class="tag trophy">${esc(k)}${counts[k] > 1 ? ' ×' + counts[k] : ''}</span>`).join(' ')}</p>` : '<p class="muted small">Empty, for now.</p>'}</section>
      <section class="card"><h2>Ratings</h2>${c ? devPanelHtml(c.id) : `<table class="data compact"><tbody>${F1_RATINGS.map(([k, l]) => `<tr><td>${esc(l)}</td><td class="num"><b>${esc(ratings[k])}</b></td></tr>`).join('')}</tbody></table>`}</section>` : ''}
      <section class="card"><h2>Relationships</h2>${rels.length ? `<ul class="rels">${rels.map(r => { const mineRel = r.personId === p.id;
          return `<li><span class="tag ${r.kind}">${esc(relKind(r.kind))}</span> ${mineRel ? careerLink(r.otherId, relName(r.otherId)) : `${careerLink(r.personId, relName(r.personId))} counts them as a ${esc(relKind(r.kind).toLowerCase())}`}${r.note ? `<p class="muted small">${esc(r.note)}</p>` : ''}${mineRel && mine ? ` <button class="btn small ghost" data-act="rel-delete" data-id="${esc(r.id)}">Remove</button>` : ''}</li>`; }).join('')}</ul>` : '<p class="muted small">None declared.</p>'}
        ${rivals.length ? `<h4>On track</h4><table class="data compact"><tbody>${rivals.map(r => `<tr><td><span class="f1-bar" style="background:${esc(f1Colour(r.teamId))}"></span>${careerLink(r.personId, r.name)}</td><td class="num">${r.won} passes for, ${r.lost} against</td></tr>`).join('')}</tbody></table>` : ''}</section>
      <section class="card"><h2>Timeline</h2>${tl.length ? `<ol class="timeline">${tl.map(x => `<li><span class="muted small">${esc(fmtDate(x.at))}</span> ${esc(x.text)}</li>`).join('')}</ol>` : '<p class="muted small">The story starts at the first race.</p>'}</section></div>
    ${diary.length ? `<section class="card"><h2>Diary</h2>${diary.slice(0, 10).map(d => `<article class="diary"><p class="muted small">${esc(fmtWhen(d.at))}</p><h3>${esc(d.title)}</h3>${paras(d.body)}${mine ? `<button class="btn small ghost" data-act="diary-delete" data-id="${esc(d.id)}">Delete</button>` : ''}</article>`).join('')}</section>` : ''}
    ${rec.length ? `<section class="card"><h2>Race by race</h2><div class="scroll-x"><table class="data"><thead><tr><th>Race</th><th>Team</th><th class="num">Grid</th><th class="num">Finish</th><th class="num">Points</th></tr></thead><tbody>${rec.slice().reverse().map(x => { const t = F1.track(x.w.trackId) || {};
      return `<tr><td>${esc(t.name || '')}${x.w.session === 'sprint' ? ' sprint' : ''}</td><td><span class="f1-bar" style="background:${esc(f1Colour(x.r.teamId))}"></span>${esc(F1.team(x.r.teamId).name)}</td><td class="num">${x.r.grid}</td><td class="num">${x.r.position ? 'P' + x.r.position : 'Out'}</td><td class="num">${x.r.points || ''}</td></tr>`; }).join('')}</tbody></table></div></section>` : ''}`;
});

/* Years of experience: what was rolled, plus one for every catalogued season they've raced in since. */
function yearsNow(p) {
  if (!p) return 0;
  const base = p.years != null ? p.years : (p.fictional ? Math.max(1, Math.round(((p.experience || 40) - 15) / 7)) : 0); if (!base) return 0;
  const seasons = list('f1_seasons').filter(s => s.status === 'archived' && (!p.approvedAt || String(s.endedAt) > String(p.approvedAt)) && ((s.archive || {}).drivers || []).some(d => d.personId === p.id)).length;
  return base + seasons;
}

/* =====================================================================
   F1 SIM — team depth: power units, contracts, sponsors and rapport.
   Power units belong to the car (not the driver). Each car has an
   allowance for the season; a fresh unit beyond it means a grid penalty.
   Older units fail more often and lose a little power. A power unit
   failure means a new one at the next weekend. Crashes cost money to
   repair. Team principals offer contracts (paid from the budget) and
   choose one sponsor deal for the season. Race engineers who work with
   the same driver weekend after weekend build rapport: clearer feedback
   and a better set-up.
   ===================================================================== */
'use strict';

const PU_ALLOWANCE_DEFAULT = 4;
const puAllow = () => curSeries().development ? engineFormula().pu : null;
const PU_EXTRA_COST = 1;      // £m for each unit beyond the allowance
const REPAIR_COST = 0.8;      // £m after an accident
const carKey = (teamId, car) => `${teamId}-${car}`;
const seasonWeekends = () => F1.weekends().filter(w => w.session !== 'test' && (w.status !== 'practice' || w.state)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

/* ---------------------------------------------------------------- power units */
/* Fits ordered for a car at a weekend: by the team principal or that car's engineer. */
function puOrdered(w, key) {
  const [teamId, car] = [key.slice(0, key.lastIndexOf('-')), Number(key.slice(key.lastIndexOf('-') + 1))];
  return list('f1_parts').some(p => p.weekendId === w.id && p.carKey === key && F1.seats(teamId).some(s => s.holderCharId === p.charId && (s.role === 'principal' || (s.role === 'engineer' && s.car === car))));
}
/* The car's power unit story up to (and including) weekend w: how many it has used, how old the current one is, and whether one was fitted there. */
function puState(key, w) {
  const weeks = seasonWeekends(), upto = w ? weeks.filter(x => x.id !== w.id && String(x.createdAt) < String(w.createdAt)).concat([w]) : weeks;
  const teamId = key.slice(0, key.lastIndexOf('-')), car = Number(key.slice(key.lastIndexOf('-') + 1));
  const ai = !(F1.seats(teamId).some(s => s.holderCharId && (s.role === 'principal' || (s.role === 'engineer' && s.car === car))));
  let count = 1, age = 0, broke = false, fits = [];
  upto.forEach((x, i) => {
    let fit = broke || puOrdered(x, key) || (ai && age >= 6 && count < puAllow());
    if (fit && i > 0) { count += 1; age = 0; fits.push({ w: x, forced: broke, n: count }); } else if (i > 0) age += 1;
    const ent = (x.entrants || []).find(e => e.teamId === teamId && e.car === car), res = ent && (x.results || []).find(r => r.id === ent.id);
    broke = !!(res && /power unit|energy store/.test(res.gap || ''));
  });
  const last = fits[fits.length - 1], here = !!(last && w && last.w.id === w.id);
  return { count, age, fitted: here, forced: here && last.forced, over: Math.max(0, count - puAllow()), brokeLast: broke, ai };
}
/* Grid penalty for this weekend: 10 places for the first unit over the allowance, 5 for each one after. */
function puPenalty(st) { return st.fitted && st.count > puAllow() ? (st.count === puAllow() + 1 ? 10 : 5) : 0; }
/* Applied at qualifying: older units are slower and less reliable; penalties move cars back on the grid. */
function f1PuEffects(w, entrants, entries) {
  const penalties = {}; if (!puAllow()) return penalties;
  entrants.forEach(e => {
    const st = puState(carKey(e.teamId, e.car), w), en = entries.find(x => x.id === e.id); if (!en) return;
    en.car = Object.assign({}, en.car, { wear: Math.min(150, st.age * 14), power: (en.car.power || 85) - Math.max(0, st.age - 3) * 0.4 });
    const pen = puPenalty(st); if (pen) penalties[e.id] = { places: pen, reason: `power unit ${st.count} of ${puAllow()}` };
  });
  return penalties;
}
function f1PuGrid(grid, penalties, log) {
  const g = grid.slice();
  Object.keys(penalties).sort((a, b) => g.indexOf(a) - g.indexOf(b)).forEach(id => { const i = g.indexOf(id); g.splice(i, 1); g.splice(Math.min(g.length, i + penalties[id].places), 0, id);
    log.push({ kind: 'penalty', ids: [id], text: `${id} takes a ${penalties[id].places}-place grid penalty for a new ${penalties[id].reason.replace(/^power unit (\d+)/, 'power unit, number $1')}` }); });
  return g;
}
ACTIONS['pu-fit'] = d => {
  const w = F1.live(), c = currentChar(); if (!w || !c) { toast('Fit a power unit while a weekend is open, before qualifying.', true); return; }
  if (w.status !== 'practice') { toast('Power units are fitted before qualifying.', true); return; }
  if (!seasonWeekends().some(x => x.id !== w.id)) { toast('Every car starts the season on a fresh unit.', true); return; }
  const st = puState(d.key, w);
  const go2 = () => run(async () => { await Data.put('f1_parts', `${w.id}-${d.key}`, { userId: asOwner(), charId: c.id, weekendId: w.id, carKey: d.key, part: 'pu', at: nowIso() }); }, 'New power unit ordered for this weekend.');
  if (st.count + 1 > puAllow()) askConfirm(`That would be power unit ${st.count + 1} of ${puAllow()}: a ${st.count + 1 === puAllow() + 1 ? 10 : 5}-place grid penalty and £${PU_EXTRA_COST}m. Fit it anyway?`, 'Fit it and take the penalty', go2, true);
  else go2();
};
ACTIONS['pu-cancel'] = d => run(async () => { await Data.remove('f1_parts', d.id); }, 'Power unit order cancelled.');

/* ---------------------------------------------------------------- sponsors */
const SPONSORS = {
  title: { label: 'Title partner', upfront: 6, blurb: '£6m now, then £0.3m for every car that scores points.', per: (rs) => rs.filter(r => r.points).length * 0.3 },
  podium: { label: 'Performance partner', upfront: 2, blurb: '£2m now, then £1.2m for every podium.', per: (rs, w) => w.session === 'gp' ? rs.filter(r => r.position && r.position <= 3).length * 1.2 : 0 },
  steady: { label: 'Reliability backer', upfront: 3, blurb: '£3m now, then £0.6m every Grand Prix both cars finish.', per: (rs, w) => w.session === 'gp' && rs.length >= 2 && rs.every(r => r.position) ? 0.6 : 0 },
  youth: { label: 'Young talent fund', upfront: 2, blurb: '£2m now, then £0.8m whenever a player’s driver scores points.', per: rs => rs.some(r => r.charId && r.points) ? 0.8 : 0 }
};
/* The team's sponsor: the first deal signed by whoever was team principal. It can't be changed mid-season. */
function f1Sponsor(teamId) {
  const tp = F1.seats(teamId).find(s => s.role === 'principal');
  return list('f1_contracts').filter(k => k.kind === 'sponsor' && k.teamId === teamId && recSeason(k) === curSeasonId() && SPONSORS[k.deal] && (k.locked || (tp && tp.holderCharId === k.charId)))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))[0] || null;
}
ACTIONS['sponsor-sign'] = d => {
  const c = currentChar(), tp = F1.seats(d.team).find(s => s.role === 'principal'); if (!c || !tp || tp.holderCharId !== c.id) { toast('Only the team principal signs sponsors.', true); return; }
  if (f1Sponsor(d.team)) { toast('A sponsor is already signed for this season.', true); return; }
  askConfirm(`Sign with the ${SPONSORS[d.deal].label.toLowerCase()} for the season? It can’t be changed afterwards.`, 'Sign the deal', () => run(async () => {
    await Data.put('f1_contracts', newId('spon'), { kind: 'sponsor', userId: asOwner(), charId: c.id, teamId: d.team, deal: d.deal, seasonId: curSeasonId(), at: nowIso() });
    await Data.audit('sponsor.sign', `${F1.team(d.team).name} signs a ${SPONSORS[d.deal].label.toLowerCase()}`); }, 'Sponsor signed.'));
};

/* ---------------------------------------------------------------- contracts */
const offersOf = teamId => list('f1_contracts').filter(k => k.kind === 'offer' && k.teamId === teamId && recSeason(k) === curSeasonId());
const replyTo = id => list('f1_contracts').filter(k => (k.kind === 'accept' || k.kind === 'decline') && k.offerId === id).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0] || null;
/* A contract stands when the team principal offered it and the character's own player accepted. */
function f1ContractsFor(charId) {
  return list('f1_contracts').filter(k => k.kind === 'offer' && k.toCharId === charId).map(o => ({ o, r: replyTo(o.id) }))
    .filter(x => x.r && x.r.kind === 'accept' && x.r.charId === charId).map(x => Object.assign({}, x.o, { signedAt: x.r.at }));
}
const f1ContractOffersFor = charId => list('f1_contracts').filter(k => k.kind === 'offer' && k.toCharId === charId && !replyTo(k.id));
function activeContract(charId, teamId) {
  return f1ContractsFor(charId).filter(k => k.teamId === teamId && recSeason(k) === curSeasonId()).sort((a, b) => String(b.signedAt).localeCompare(String(a.signedAt)))[0] || null;
}
function contractLeft(k) { if (!k.races) return 'the end of the season'; const done = finishedAll().filter(w => String(w.finishedAt) > String(k.signedAt) && w.session === 'gp').length; return k.races - done > 0 ? plural(k.races - done, 'more Grand Prix', 'more Grands Prix') : 'its end'; }
ACTIONS['offer-new'] = d => { S.ui.form.offer = { teamId: d.team, toCharId: d.char, salary: 2, races: 0, terms: '' }; openDrawer('offer'); };
DRAWERS.offer = function () {
  const f = S.ui.form.offer || {}, who = get('characters', f.toCharId), t = F1.team(f.teamId);
  return `<header><div><h2>Offer ${esc(who ? who.name : '')} a contract</h2><p>${esc(t.name)}. The salary comes out of the team’s budget, a share at each Grand Prix.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><div class="form-grid"><label class="field">Salary (£m a season)<input id="of-sal" type="number" min="0" max="20" step="0.5" data-bind="ui/form/offer/salary" data-type="number" value="${esc(f.salary)}"></label>
      <label class="field">Length${sel('of-len', 'ui/form/offer/races', String(f.races || 0), [['0', 'To the end of the season'], ['5', 'Five Grands Prix'], ['10', 'Ten Grands Prix']])}</label></div>
    <label class="field">Terms (optional)<textarea id="of-terms" rows="4" data-bind="ui/form/offer/terms" placeholder="e.g. Number one status for the first five races. Release clause if not in the top 10.">${esc(f.terms || '')}</textarea></label>
    <div class="btn-row"><button class="btn primary" data-act="offer-send">Send the offer</button></div></div>`;
};
ACTIONS['offer-send'] = () => {
  const f = S.ui.form.offer || {}, c = currentChar(), tp = F1.seats(f.teamId).find(s => s.role === 'principal');
  if (!c || !tp || tp.holderCharId !== c.id) { toast('Only the team principal makes offers.', true); return; }
  run(async () => { await Data.put('f1_contracts', newId('off'), { kind: 'offer', userId: asOwner(), charId: c.id, teamId: f.teamId, seasonId: curSeasonId(), toCharId: f.toCharId, salary: Math.max(0, Number(f.salary) || 0), races: Number(f.races) || 0, terms: String(f.terms || '').trim(), at: nowIso() }); closeDrawer(); }, 'Offer sent.');
};
ACTIONS['offer-reply'] = d => {
  const o = get('f1_contracts', d.id), c = get('characters', o && o.toCharId); if (!o || !c || (c.userId !== S.uid && !S.isGm)) return;
  run(async () => { await Data.put('f1_contracts', newId('rep'), { kind: d.yes === '1' ? 'accept' : 'decline', offerId: o.id, userId: c.userId, charId: c.id, at: nowIso() });
    if (d.yes === '1') await Data.audit('contract.sign', `${c.name} signs with ${F1.team(o.teamId).name}`); }, d.yes === '1' ? 'Contract signed.' : 'Offer declined.');
};
function offersHtml(charId) {
  const offers = f1ContractOffersFor(charId); if (!offers.length) return '';
  return `<section class="card"><h2>Contract offers</h2>${offers.map(o => `<article class="offer" style="--team:${esc(F1.team(o.teamId).color)}"><h3>${esc(F1.team(o.teamId).name)}</h3>
    <p>£${o.salary}m a season, ${o.races ? `for ${o.races} Grands Prix` : 'to the end of the season'}.</p>${o.terms ? paras(o.terms) : ''}
    <div class="btn-row"><button class="btn primary" data-act="offer-reply" data-id="${esc(o.id)}" data-yes="1">Sign it</button><button class="btn" data-act="offer-reply" data-id="${esc(o.id)}" data-yes="0">Turn it down</button></div></article>`).join('')}</section>`;
}

/* ---------------------------------------------------------------- the team's money, extended */
function f1TeamExtras(teamId) {
  const lines = [], sp = f1Sponsor(teamId), byW = finishedAll();
  if (sp) { lines.push({ text: `${SPONSORS[sp.deal].label}: signing payment`, amt: SPONSORS[sp.deal].upfront });
    byW.forEach(w => { const rs = (w.results || []).filter(r => r.teamId === teamId), a = Math.round(SPONSORS[sp.deal].per(rs, w) * 100) / 100; if (a) lines.push({ text: `${(F1.track(w.trackId) || {}).name || ''}: ${SPONSORS[sp.deal].label.toLowerCase()} bonus`, amt: a }); }); }
  byW.forEach(w => { const t = (F1.track(w.trackId) || {}).name || '';
    ((w.practice && w.practice.done) || []).forEach(s => (s.crashes || []).forEach(id => { const e = (w.entrants || []).find(x => x.id === id); if (e && e.teamId === teamId && teamHasPlayers(teamId)) lines.push({ text: `${t}: ${sessionName(w, s.n)} crash repairs, ${e.name}`, amt: -PRACTICE_REPAIR }); }));
    (w.results || []).filter(r => r.teamId === teamId && r.status === 'dnf' && /Accident/.test(r.gap || '')).forEach(r => lines.push({ text: `${t}: crash repairs, ${r.name}`, amt: -REPAIR_COST }));
    if (puAllow()) [1, 2, 3].forEach(car => { const st = puState(carKey(teamId, car), w); if (st.fitted && st.count > puAllow()) lines.push({ text: `${t}: extra power unit, car ${car}`, amt: -PU_EXTRA_COST }); });
    if (w.session === 'gp') F1.seats(teamId).filter(s => s.holderCharId).forEach(s => { const k = activeContract(s.holderCharId, teamId);
      const nGp = Math.max(1, F1.tracks().length);
      if (k && k.salary && String(w.finishedAt) > String(k.signedAt) && (!k.races || finishedAll().filter(x => x.session === 'gp' && String(x.finishedAt) > String(k.signedAt) && String(x.finishedAt) <= String(w.finishedAt)).length <= k.races))
        lines.push({ text: `${t}: salary, ${s.holderName}`, amt: -Math.round(k.salary / nGp * 100) / 100 }); }); });
  return { lines, sponsor: sp };
}

/* ---------------------------------------------------------------- rapport */
/* Weekends the car's engineer and driver (both players) have locked a set-up in together. */
function f1Rapport(teamId, car) {
  const eng = F1.seats(teamId).find(s => s.role === 'engineer' && s.car === car), drv = F1.seats(teamId).find(s => s.role === 'driver' && s.car === car);
  if (!eng || !drv || !eng.holderCharId || !drv.holderCharId) return 0;
  return F1.weekends().filter(w => w.setupBy && (w.entrants || []).some(e => e.teamId === teamId && e.car === car && e.charId === drv.holderCharId && w.setupBy[e.id] === eng.holderCharId)).length;
}
const rapportNoise = n => 1 - Math.min(0.5, n * 0.1);
const rapportSetup = n => Math.min(4, n);

/* ---------------------------------------------------------------- Team HQ sections */
function teamDepthHtml(tid) {
  const team = F1.team(tid), c = currentChar(), tp = F1.seats(tid).find(s => s.role === 'principal'), isTp = !!(c && tp && tp.holderCharId === c.id);
  const inTeam = S.isGm || F1.seats(tid).some(s => c && s.holderCharId === c.id); if (!inTeam) return '';
  const w = F1.live(), sp = f1Sponsor(tid);
  const cars = F1.seats(tid).filter(x => x.role === 'driver').map(x => x.car);
  const pu = cars.map(car => { const key = carKey(tid, car), st = puState(key, w && w.status === 'practice' ? w : null), drv = F1.seats(tid).find(s => s.role === 'driver' && s.car === car);
    const ordered = w && list('f1_parts').find(p => p.weekendId === w.id && p.carKey === key);
    const canFit = c && w && w.status === 'practice' && seasonWeekends().some(x => x.id !== w.id) && F1.seats(tid).some(s => s.holderCharId === c.id && (s.role === 'principal' || (s.role === 'engineer' && s.car === car)));
    const n = f1Rapport(tid, car);
    return `<tr><td><b>Car ${car}</b><br><span class="muted small">${esc(drv ? f1Occupant(drv).name : '')}</span></td>
      ${puAllow() ? `      <td>Unit ${st.count} of ${puAllow()}${st.over ? ` <span class="tag flag">${st.over} over</span>` : ''}<br><span class="muted small">${st.age ? `${plural(st.age, 'weekend')} old${st.age >= 4 ? ': failing more often, a little down on power' : ''}` : 'Fresh'}${st.brokeLast ? '. It failed last time: a new one goes in.' : ''}</span></td>
      <td>${ordered ? `<span class="tag player">New unit this weekend</span> ${canFit ? `<button class="btn small" data-act="pu-cancel" data-id="${esc(ordered.id)}">Cancel</button>` : ''}` : canFit ? `<button class="btn small" data-act="pu-fit" data-key="${esc(key)}">Fit a new power unit</button>` : ''}</td>` : ''}
      <td>${n ? `Rapport: ${plural(n, 'weekend')} together<br><span class="muted small">Feedback ${Math.round((1 - rapportNoise(n)) * 100)}% clearer, +${rapportSetup(n)} set-up</span>` : '<span class="muted small">No rapport yet</span>'}</td></tr>`; }).join('');
  const people = F1.seats(tid).filter(s => s.holderCharId && s.role !== 'principal');
  return `${puAllow() ? '' : '<!--spec-->'}<section class="card"><h2>${puAllow() ? 'Power units and rapport' : 'Rapport'}</h2>${puAllow() ? `<p class="muted small">Each car has ${puAllow()} power units for the season. A new one beyond that costs a grid penalty (10 places, then 5) and £${PU_EXTRA_COST}m. Fit units during practice. Rapport grows each weekend the same engineer and driver lock in a set-up together.</p>` : '<p class="muted small">Identical cars in this series: no power units to manage. Rapport grows each weekend the same engineer and driver lock in a set-up together.</p>'}
      <div class="scroll-x"><table class="data"><tbody>${pu}</tbody></table></div></section>
    <section class="card"><h2>Sponsor</h2>${sp ? `<p><b>${esc(SPONSORS[sp.deal].label)}</b>: ${esc(SPONSORS[sp.deal].blurb)}</p>` : isTp ? `<p>Choose one deal for the season. It can’t be changed afterwards.</p>
      <div class="cards">${Object.keys(SPONSORS).map(k => `<article class="card"><h3>${esc(SPONSORS[k].label)}</h3><p>${esc(SPONSORS[k].blurb)}</p><button class="btn small primary" data-act="sponsor-sign" data-team="${esc(tid)}" data-deal="${k}">Sign this deal</button></article>`).join('')}</div>`
      : '<p class="muted">No sponsor deal signed: the team earns the standard sponsor bonus for meeting its target.</p>'}</section>
    <section class="card"><h2>Contracts</h2>${people.length ? `<table class="data"><tbody>${people.map(s => { const k = activeContract(s.holderCharId, tid), pend = offersOf(tid).find(o => o.toCharId === s.holderCharId && !replyTo(o.id));
      return `<tr><td><b>${esc(s.holderName)}</b><br><span class="muted small">${esc(seatTitle(s))}</span></td><td>${k ? `£${k.salary}m a season, until ${esc(contractLeft(k))}${k.terms ? `<br><span class="muted small">${esc(k.terms)}</span>` : ''}` : pend ? '<span class="tag open">Offer waiting for an answer</span>' : '<span class="muted">No contract</span>'}</td>
        <td>${isTp && !pend ? `<button class="btn small" data-act="offer-new" data-team="${esc(tid)}" data-char="${esc(s.holderCharId)}">${k ? 'Offer a new contract' : 'Offer a contract'}</button>` : ''}</td></tr>`; }).join('')}</tbody></table>` : '<p class="muted">No players in the team’s seats yet.</p>'}
      <p class="muted small">Salaries are paid from the budget, a share at each Grand Prix.</p></section>`;
}

const _teamViewTD = ROUTES.team.view;
ROUTES.team.view = function () {
  const html = _teamViewTD(), teams = F1.teams(); if (!teams.length) return html;
  const my = S.charId ? F1.seats().find(s => s.holderCharId === S.charId) : null, tid = S.ui.teamId || (my && my.teamId) || teams[0].id;
  return html + teamDepthHtml(tid);
};

/* =====================================================================
   F1 SIM — race presets, race approaches, triggers and the official lock.
   Presets fill a car's three plans and its triggers in one go: each
   team's own default (from how that team likes to race), or one of four
   general ones. The race approach drives the car lap by lap. Triggers
   swap plans, change the mode or call a stop when something happens,
   each with a chance of the team acting on it. In an official race,
   nothing can be changed once it starts: the plans, triggers and race
   approach run the car, and driver moments follow the approach.
   ===================================================================== */
'use strict';

const APPROACHES = [['balanced', 'Balanced', 'Races to the plan without fuss.'], ['attacker', 'Attacker', 'Pushes whenever there’s a car to catch, and goes around the outside.'],
  ['defender', 'Defender', 'Pushes when someone’s close behind, and covers the inside.'], ['tyres', 'Tyre saver', 'Manages the tyres in clean air, and picks the battles worth having.']];
const STYLE_APPROACH = { charger: 'attacker', aggressive: 'attacker', defender: 'defender', smooth: 'tyres', strategist: 'tyres', ironman: 'balanced', technical: 'balanced', qualifier: 'balanced' };
const TRIGGER_WHEN = [['sc', 'A safety car comes out'], ['rain', 'It starts to rain'], ['dry', 'The track dries out'], ['lost', 'We’ve lost places from the grid'], ['gained', 'We’ve gained places from the grid'], ['wear', 'Tyre wear reaches']];
const TRIGGER_DO = [['plan0', 'Switch to Plan A'], ['plan1', 'Switch to Plan B'], ['plan2', 'Switch to Plan C'], ['push', 'Push'], ['manage', 'Manage the tyres'], ['box', 'Box this lap']];
const CHANCES = [['100', 'Always'], ['75', '75% of the time'], ['50', 'Half the time'], ['25', 'Now and then (25%)']];
const PRESETS = [['team', 'The team’s own approach'], ['onestop', 'Safe one-stop'], ['twostop', 'Attacking two-stop'], ['wet', 'Wet-weather gamble'], ['sc', 'Safety-car opportunist']];
const ARCH_PRESET = { aggressive_two: 'twostop', undercut_king: 'twostop', one_stop: 'onestop', fuel_save: 'onestop', tyre_banker: 'onestop', overcut: 'onestop', safety_car: 'sc', reactive: 'onestop' };

function defaultApproach(ent) { const v3 = ent.v3 || (f1Entrants().find(x => x.id === ent.id) || {}).v3 || {}; return STYLE_APPROACH[v3.style] || 'balanced'; }
const approachLabel = k => (APPROACHES.find(a => a[0] === k) || APPROACHES[0])[1];
const wetVersion = p => Object.assign({}, clone(p), { wetCall: 'early', dryCall: 'early' });
/* A preset's plans and triggers for this car at this circuit, built on what the team knows about the tyres. */
function presetFor(key, w, ent) {
  const N = raceLaps(w), base = suggestPlans(w, ent), team = F1.team(ent.teamId);
  if (key === 'team') key = ARCH_PRESET[team.strategy] || 'onestop';
  const later = p => Object.assign({}, clone(p), { stops: p.stops.map(s => ({ lap: Math.min(N - 2, s.lap + 6), compound: s.compound })), useSC: true });
  if (key === 'twostop') return { plans: [base[1], base[0], wetVersion(base[1])], triggers: [
    { when: 'sc', from: 8, to: Math.max(9, N - 12), action: 'plan1', chance: '75' }, { when: 'rain', action: 'plan2', chance: '100' }, { when: 'lost', n: 3, action: 'push', chance: '100' }] };
  if (key === 'wet') return { plans: [Object.assign({}, clone(base[0]), { wetCall: 'late', dryCall: 'early' }), wetVersion(base[0]), base[2]], triggers: [
    { when: 'rain', action: 'plan1', chance: '50' }, { when: 'dry', action: 'push', chance: '100' }] };
  if (key === 'sc') return { plans: [later(base[0]), base[1], wetVersion(base[0])], triggers: [
    { when: 'sc', from: 5, to: Math.max(6, N - 8), action: 'plan1', chance: '100' }, { when: 'rain', action: 'plan2', chance: '100' }] };
  return { plans: [base[0], base[1], wetVersion(base[0])], triggers: [{ when: 'rain', action: 'plan2', chance: '100' }, { when: 'wear', n: 100, action: 'box', chance: '100' }] };
}
function cleanTriggers(ts, N) {
  return (ts || []).slice(0, 6).filter(t => TRIGGER_WHEN.some(x => x[0] === t.when) && TRIGGER_DO.some(x => x[0] === t.action)).map(t => {
    const a = t.action, out = { when: t.when, chance: Math.max(0, Math.min(100, Number(t.chance) || 100)) };
    if (t.when === 'lost' || t.when === 'gained') out.n = Math.max(1, Math.min(15, Number(t.n) || 3));
    if (t.when === 'wear') out.n = Math.max(50, Math.min(130, Number(t.n) || 90));
    if (Number(t.from)) out.from = Math.max(1, Math.min(N, Number(t.from))); if (Number(t.to)) out.to = Math.max(1, Math.min(N, Number(t.to)));
    if (/^plan\d$/.test(a)) { out.action = 'plan'; out.plan = Number(a.slice(4)); } else if (a === 'box') out.action = 'box'; else { out.action = 'mode'; out.mode = a; }
    return out;
  });
}
/* Put a team's saved plans (or the defaults) onto a car in the race state. */
function applyPlanDoc(car, doc, st) {
  const i = Number(doc.active) || 0, plans = (doc.plans || []).map((p, k) => Object.assign(cleanPlan(p, st.laps), { name: PLAN_NAMES[k] })), p = plans[i] || plans[0];
  if (!p) return;
  const wet = st.track[0], start = wet === 2 ? 'wet' : wet === 1 ? 'inter' : p.start;
  car.tyre = { compound: start, wear: 0, age: 0 }; car.stints = [{ compound: start, from: 1, to: null }]; car.used = [start];
  car.plan = p.stops.map(s => ({ lap: s.lap, compound: s.compound })); car.planned = true; car.planName = PLAN_NAMES[i];
  car.plans = plans; car.triggers = cleanTriggers(doc.triggers, st.laps).map(t => Object.assign(t, { fired: false })); car.approach = doc.approach || 'balanced'; car.modeHold = 0;
  car.ai = Object.assign({}, car.ai, { wetCall: p.wetCall, dryCall: p.dryCall, useSC: p.useSC });
}
/* Cars in a team with players but no saved plans start on the team's own preset and the driver's natural approach. */
function defaultPlanDoc(w, ent) { const pr = presetFor('team', w, ent); return { plans: pr.plans, active: 0, triggers: pr.triggers, approach: defaultApproach(ent), isDefault: true }; }
const teamHasPlayers = teamId => F1.seats(teamId).some(s => s.holderCharId);

/* ---------------------------------------------------------------- official races */
const raceSettings = w => Object.assign({ lock: true, scRate: 1, failRate: 1, extRate: 1, rainPct: 'track' }, (w && w.settings) || {});
const rateNum = v => v == null || v === '' || isNaN(Number(v)) ? 1 : Number(v);
const raceLocked = w => !!(w && w.state && w.state.lap > 0 && !w.state.finished && !w.test && raceSettings(w).lock !== false);
const RACE_CALLS = ['box', 'mode', 'order', 'refuseOrder', 'strategy', 'moment'];

/* ---------------------------------------------------------------- the editor pieces */
ACTIONS['strat-preset'] = d => {
  const w = S.ui.stratW || F1.live(), ent = weekendEnt(w, d.car), key = ((S.ui.form.presetPick || {})[d.car]) || 'team'; if (!ent) return;
  const pr = presetFor(key, w, ent), f = S.ui.form.strat[d.car];
  f.plans = pr.plans; f.triggers = pr.triggers.map(t => Object.assign({}, t, { action: t.action })); f.preset = key; f.tab = 0;
  toast(`${(PRESETS.find(p => p[0] === key) || PRESETS[0])[1]} loaded: three plans and their triggers. Adjust, then save.`); render();
};
ACTIONS['trig-toggle'] = (d, el, ev) => { if (ev) ev.preventDefault(); S.ui.trigOpen = S.ui.trigOpen || {}; S.ui.trigOpen[d.car] = !S.ui.trigOpen[d.car]; render(); };
ACTIONS['trig-add'] = d => { S.ui.trigOpen = S.ui.trigOpen || {}; S.ui.trigOpen[d.car] = true; const f = S.ui.form.strat[d.car]; f.triggers = f.triggers || []; if (f.triggers.length >= 6) return; f.triggers.push({ when: 'sc', action: 'plan1', chance: '100' }); render(); };
ACTIONS['trig-del'] = d => { S.ui.form.strat[d.car].triggers.splice(Number(d.i), 1); render(); };
function triggersEditorHtml(ent, f, N) {
  const base = `ui/form/strat/${ent.id}/triggers`, ts = f.triggers || [];
  const open = !!((S.ui.trigOpen || {})[ent.id]);
  return `<details class="trig-box" ${open ? 'open' : ''}><summary data-act="trig-toggle" data-car="${esc(ent.id)}"><b>Triggers</b> <span class="muted small">${ts.length ? plural(ts.length, 'trigger') + ' set' : 'none set'}: what the team does if something happens</span></summary><p class="muted small">Each trigger fires once, and the team acts on it with the chance you set.</p>
    ${ts.length ? `<div class="triggers">${ts.map((t, i) => `<div class="trigger">
      <label class="field">When${sel(`tg-${ent.id}-${i}-w`, `${base}/${i}/when`, t.when, TRIGGER_WHEN)}</label>
      ${['lost', 'gained', 'wear'].indexOf(t.when) !== -1 ? `<label class="field">${t.when === 'wear' ? 'Wear (%)' : 'Places'}<input id="tg-${ent.id}-${i}-n" type="number" min="1" max="130" value="${esc(t.n || (t.when === 'wear' ? 90 : 3))}" data-bind="${base}/${i}/n" data-type="number"></label>` : ''}
      ${['sc', 'rain', 'dry'].indexOf(t.when) !== -1 ? `<label class="field">From lap<input id="tg-${ent.id}-${i}-f" type="number" min="1" max="${N}" value="${esc(t.from || '')}" placeholder="Any" data-bind="${base}/${i}/from" data-type="number"></label>
        <label class="field">To lap<input id="tg-${ent.id}-${i}-t" type="number" min="1" max="${N}" value="${esc(t.to || '')}" placeholder="Any" data-bind="${base}/${i}/to" data-type="number"></label>` : ''}
      <label class="field">Then${sel(`tg-${ent.id}-${i}-a`, `${base}/${i}/action`, t.action, TRIGGER_DO)}</label>
      <label class="field">Chance${sel(`tg-${ent.id}-${i}-c`, `${base}/${i}/chance`, String(t.chance || '100'), CHANCES)}</label>
      <button class="btn small" data-act="trig-del" data-car="${esc(ent.id)}" data-i="${i}">Remove</button></div>`).join('')}</div>` : '<p class="muted small">No triggers: the car sticks to its starting plan whatever happens.</p>'}
    ${ts.length < 6 ? `<button class="btn small" data-act="trig-add" data-car="${esc(ent.id)}">Add a trigger</button>` : ''}</details>`;
}
function presetBarHtml(ent, f) {
  const pick = (S.ui.form.presetPick = S.ui.form.presetPick || {})[ent.id] || f.preset || 'team', team = F1.team(ent.teamId);
  const arch = FormulaRacingAdapter.ARCHETYPES[team.strategy] || FormulaRacingAdapter.ARCHETYPES.reactive;
  return `<div class="btn-row preset-bar"><label class="field" style="margin:0">Preset${sel(`pp-${ent.id}`, `ui/form/presetPick/${ent.id}`, pick, PRESETS.map(([k, l]) => [k, k === 'team' ? `${team.name}’s own: ${arch.label.toLowerCase()}` : l]))}</label>
    <button class="btn" data-act="strat-preset" data-car="${esc(ent.id)}">Load the preset</button></div>`;
}
function approachHtml(ent, f) {
  return `<label class="field" style="max-width:440px">Race approach${sel(`ap-${ent.id}`, `ui/form/strat/${ent.id}/approach`, f.approach || defaultApproach(ent), APPROACHES.map(([k, l, d]) => [k, `${l}: ${d}`]))}</label>`;
}
/* In a locked race: what the car is doing, and which triggers have fired. */
function lockedStatusHtml(w, ent, car) {
  const fired = w.state.events.filter(e => e.kind === 'trigger' && (e.ids || [])[0] === ent.id);
  return `<p>On <b>${esc(car.planName || 'the AI strategist’s plan')}</b>, ${esc(approachLabel(car.approach).toLowerCase())} approach. ${(car.plan || [])[0] ? `Next stop: lap ${car.plan[0].lap}, ${esc(RaceEngine.COMPOUNDS[car.plan[0].compound].label.toLowerCase())}s.` : 'No more stops planned.'}</p>
    ${(car.triggers || []).length ? `<ul class="trig-status">${car.triggers.map(t => `<li class="${t.fired ? 'fired' : ''}">${esc((TRIGGER_WHEN.find(x => x[0] === t.when) || ['', t.when])[1])}${t.n ? ` (${t.n}${t.when === 'wear' ? '%' : ''})` : ''}: ${t.action === 'plan' ? 'switch to ' + PLAN_NAMES[t.plan] : t.action === 'box' ? 'box' : t.mode} ${t.chance < 100 ? `(${t.chance}%)` : ''}${t.fired ? ' <span class="tag">Fired</span>' : ''}</li>`).join('')}</ul>` : ''}
    ${fired.length ? `<p class="small">${fired.map(e => `Lap ${e.lap}: ${esc(e.text)}`).join('<br>')}</p>` : ''}`;
}

/* ---------------------------------------------------------------- randomness (Race Control, and the Test Track) */
const RATES = [['0', 'None'], ['0.5', 'Fewer than usual'], ['1', 'As usual'], ['2', 'More than usual'], ['3', 'Chaos']];
const RAIN_PCTS = [['track', 'The circuit’s usual'], ['0', 'No chance'], ['20', '20%'], ['40', '40%'], ['60', '60%'], ['90', '90%']];
function randomnessHtml(prefix, f, t) {
  return `<div class="metrics" style="align-items:end">
    <label class="field">Chance of rain (changeable weather)${sel(prefix + '-rain', `ui/form/${prefix}/rainPct`, f.rainPct || 'track', RAIN_PCTS.map(([k, l]) => [k, k === 'track' ? `${l} (${Math.round((t.wr || 0) * 0.6)}%)` : l]))}</label>
    <label class="field">Crashes, contact and driver errors${sel(prefix + '-sc', `ui/form/${prefix}/scRate`, String(f.scRate == null ? '1' : f.scRate), RATES)}</label>
    <label class="field">Mechanical failures and pit problems${sel(prefix + '-fail', `ui/form/${prefix}/failRate`, String(f.failRate == null ? '1' : f.failRate), RATES)}</label>
    <label class="field">Outside events (debris, animals, storms)${sel(prefix + '-ext', `ui/form/${prefix}/extRate`, String(f.extRate == null ? '1' : f.extRate), RATES)}</label>
    <button class="btn small ghost" data-act="inc-open">What can happen?</button></div>`;
}

/* =====================================================================
   F1 SIM — the Test Track.
   The same simulator as the official races, on the league's own grid,
   cars, upgrades and ratings, but run entirely in the browser: nothing
   is saved and nothing counts. Anyone can pick any car, try presets,
   plans, triggers and race approaches, change the chances of rain,
   safety cars and failures, and step in at any moment with the pit
   wall and driver moments.
   ===================================================================== */
'use strict';

S.tt = { cfg: null, w: null, calls: [], choice: {}, timer: null };
function ttCfg() {
  if (!S.tt.cfg) {
    const mine = S.charId ? F1.seats().find(s => s.holderCharId === S.charId && s.role !== 'engineer') : null;
    const ents = F1.teams().length ? f1Entrants() : [], myCar = mine ? (ents.find(e => e.teamId === mine.teamId && (mine.car ? e.car === mine.car : true)) || {}).id : null;
    S.tt.cfg = { trackId: (f1NextTrack() || {}).id, session: 'gp', weatherMode: 'track', rainPct: 'track', scRate: '1', failRate: '1', extRate: '1', seed: '', car: myCar || (ents[0] || {}).id, setup: 75, speed: '1000' };
  }
  return S.ui.form.tt = S.tt.cfg;
}
/* A weekend-shaped object, so the race view, the plan editor and the moments all work as they do in the league. */
function ttW() {
  const f = ttCfg(), w = S.tt.w;
  return w || { id: 'test-' + f.trackId + '-' + f.session, test: true, trackId: f.trackId, session: f.session, seed: Number(f.seed) || 1, weatherMode: f.weatherMode,
    seriesId: curSeriesId(), seasonId: curSeasonId(), settings: { lock: false, scRate: rateNum(f.scRate), failRate: rateNum(f.failRate), extRate: rateNum(f.extRate), rainPct: f.rainPct }, status: 'practice', entrants: null, state: null };
}
function ttStop() { clearTimeout(S.tt.timer); S.tt.timer = null; }
ACTIONS['tt-reset'] = () => { ttStop(); S.tt.w = null; S.tt.calls = []; S.tt.choice = {}; render(); };
ACTIONS['tt-quali'] = () => {
  ttStop();
  const f = ttCfg(), w = ttW(), track = F1.track(f.trackId); if (!track) return;
  const seed = Number(f.seed) || (1 + Math.floor(Math.random() * 999999)); w.seed = seed;
  const entrants = f1Entrants(), mine = entrants.find(e => e.id === f.car) || entrants[0];
  const setup = {}; entrants.forEach(e => { setup[e.id] = e.id === mine.id ? Math.max(20, Math.min(95, Number(f.setup) || 75)) : f1AiSetup(F1.team(e.teamId)); });
  const rs = f1RaceSetup(w, track), weather = f1Weather(w, track), teams = F1.teams().map(t => f1EffectiveTeam(t));
  const entries = FormulaRacingAdapter.toEntries(entrants.map(e => e.v3), teams, track, { setup });
  engineEfficiency(entrants, entries, w);
  const quali = RaceEngine.qualify({ circuit: rs.circuit, entries, weather, seed, rules: rs.rules });
  let state = RaceEngine.createRace({ circuit: rs.circuit, entries, grid: quali.grid, weather, seed, sprint: f.session === 'sprint', rules: rs.rules });
  /* Your car runs your plans; other cars in teams with players run their team defaults. */
  const form = stratForm(w, mine);
  state = clone(state);
  state.cars.forEach(car => { const ent = entrants.find(e => e.id === car.id);
    if (car.id === mine.id) applyPlanDoc(car, { plans: form.plans, active: form.active, triggers: form.triggers, approach: form.approach }, state);
    else if (ent && teamHasPlayers(ent.teamId)) applyPlanDoc(car, defaultPlanDoc(w, ent), state); });
  S.tt.w = Object.assign({}, w, { status: 'grid', seed, weather, quali: { grid: quali.grid, results: quali.results, log: quali.log }, state, moments: [],
    entrants: entrants.map(e => { const o = Object.assign({}, e, { charId: e.id === mine.id ? 'tt-you' : null }); delete o.v3; return o; }) });
  S.tt.calls = []; S.tt.choice = {}; S.ui.f1pick = mine.id; S.ui.f1tab = 'driver';
  render();
};
function ttStep(laps) {
  const w = S.tt.w; if (!w || !w.state || w.state.finished) return null;
  const calls = S.tt.calls.splice(0), resolved = [];
  (w.moments || []).filter(m => !m.resolved && m.lap === w.state.lap + 1).forEach(m => {
    const car = w.state.cars.find(c => c.id === m.carId), choice = S.tt.choice[m.id] || defaultChoice(m, car);
    calls.push({ entry: m.carId, type: 'moment', kind: m.kind, choice }); resolved.push(Object.assign({}, m, { resolved: true, choice, auto: !S.tt.choice[m.id] }));
  });
  let st = w.state, log = [], last = [];
  for (let i = 0; i < laps && !st.finished; i++) {
    const out = RaceEngine.stepLap(st, i === 0 ? calls : []); st = out.state; log = log.concat(out.log); last = out.log;
    if (S.ui.form.ttStopSc !== false && i < laps - 1 && out.log.some(l => (l.kind === 'sc' || l.kind === 'vsc') && /deployed/.test(l.text))) break;
  }
  const done = new Map(resolved.map(m => [m.id, m]));
  w.moments = (w.moments || []).map(m => done.get(m.id) ? Object.assign(done.get(m.id), { outcome: (log.find(l => l.kind === 'moment' && (l.ids || [])[0] === m.carId) || {}).text || 'Nothing came of it.' }) : m);
  w.state = st; w.status = st.finished ? 'finished' : 'running';
  if (laps === 1 && !st.finished) w.moments = w.moments.concat(f1NewMoments(w, st, last));
  if (st.finished) { const byId = new Map(w.entrants.map(e => [e.id, e])); w.results = RaceEngine.classify(st).map(r => Object.assign({}, r, byId.get(r.id) || {})); w.finishedAt = nowIso(); ttStop(); }
  return log;
}
function ttTick() {
  const w = S.tt.w; if (!S.tt.timer || !w || !w.state || w.state.finished) { ttStop(); render(); return; }
  const pend = (w.moments || []).filter(m => !m.resolved && m.lap === w.state.lap + 1 && !S.tt.choice[m.id]);
  if (pend.length && Date.now() - Date.parse(pend[0].createdAt) < MOMENT_WAIT) { S.tt.timer = setTimeout(ttTick, 500); render(); return; }
  const log = ttStep(1);
  if (log && S.ui.form.ttStopSc !== false && log.some(l => (l.kind === 'sc' || l.kind === 'vsc') && /deployed/.test(l.text))) { ttStop(); toast('Safety car: paused. Make your calls, then carry on.'); render(); return; }
  if (S.tt.timer) S.tt.timer = setTimeout(ttTick, Number(ttCfg().speed) || 1000);
  render();
};
ACTIONS['tt-play'] = () => { if (S.tt.timer) { ttStop(); render(); return; } S.tt.timer = setTimeout(ttTick, 50); render(); };
ACTIONS['tt-step'] = d => { ttStop(); ttStep(Number(d.laps) || 1); render(); };
ACTIONS['tt-call'] = d => {
  const w = S.tt.w, car = ttCfg().car; if (!w || !w.state) return;
  S.tt.calls = S.tt.calls.filter(c => c.type !== d.type);
  if (d.type === 'box') S.tt.calls.push({ entry: car, type: 'box', compound: d.value });
  else if (d.type === 'mode') S.tt.calls.push({ entry: car, type: 'mode', value: d.value });
  else if (d.type === 'plan') S.tt.calls.push({ entry: car, type: 'strategy', plan: Number(d.value) });
  toast('Call made: it applies on the next lap.'); render();
};
ACTIONS['tt-moment'] = d => { S.tt.choice[d.id] = d.choice; render(); };
ACTIONS['tt-stopsc'] = (d, el) => { S.ui.form.ttStopSc = !!el.checked; };

function ttMomentHtml(w) {
  const mine = ttCfg().car, m = (w.moments || []).find(x => !x.resolved && x.carId === mine && x.lap === w.state.lap + 1); if (!m) return '';
  const st = w.state, car = st.cars.find(c => c.id === m.carId), opp = m.opponent ? st.cars.find(c => c.id === m.opponent) : null, pick = S.tt.choice[m.id];
  return `<section class="card moment"><p class="eyebrow">Driver moment, lap ${m.lap}</p><h2>${esc(MOMENT_TITLE[m.kind](opp ? f1Ent(w, opp.id).name : ''))}</h2>
    <div class="choices">${MOMENT_CHOICES[m.kind].filter(c => c[0] !== 'boost' || !st.rules.noHybrid).map(([k, l, dsc]) => { const o = RaceEngine.momentOdds(m.kind, k, car, opp, st.circuit);
      return `<button class="choice" data-act="tt-moment" data-id="${esc(m.id)}" data-choice="${k}" aria-pressed="${pick === k}"><b>${esc(l)}</b><span>${esc(dsc)}</span><span class="odds">${['wait', 'concede', 'safe'].indexOf(k) !== -1 ? 'No risk' : `${Math.round(o.success * 100)}%${o.contact ? `, ${Math.round(o.contact * 100)}% contact risk` : ''}`}</span></button>`; }).join('')}</div></section>`;
}
function ttCarHtml(w) {
  const id = ttCfg().car, car = w.state.cars.find(c => c.id === id), e = f1Ent(w, id), t = F1.team(e.teamId); if (!car) return '';
  if (car.status !== 'running') return `<section class="card"><h2>Your car</h2><p>${esc(e.name)} is out: ${esc(car.dnf)}.</p></section>`;
  const life = RaceEngine.tyreLife(car.tyre.compound, car, w.state.circuit), wear = Math.min(100, Math.round(car.tyre.wear / life * 100)), pos = f1Order(w.state).indexOf(car) + 1;
  const pend = type => S.tt.calls.find(c => c.type === type);
  return `<section class="card" style="--team:${esc(t.color)}"><h2>Your car: ${esc(e.name)} <span class="sub">P${pos}, ${esc(car.planName || 'no plan')}, ${esc(approachLabel(car.approach).toLowerCase())}</span></h2>
    <div class="f1-gauges"><div class="f1-gauge">${esc(RaceEngine.COMPOUNDS[car.tyre.compound].label)}s, ${car.tyre.age} laps: wear ${wear}%<div class="track"><div class="fill ${wear >= 90 ? 'hot' : ''}" style="width:${wear}%"></div></div></div>
      <div class="f1-gauge">${w.state.rules.noHybrid ? 'No battery' : `Battery ${Math.round(car.energy)}%`}, ${esc(RaceEngine.MODES[car.mode].label.toLowerCase())}<div class="track"><div class="fill" style="width:${car.energy}%"></div></div></div></div>
    <div class="f1-row"><span class="lbl">Mode</span>${['push', 'standard', 'manage'].map(m => `<button class="btn small" data-act="tt-call" data-type="mode" data-value="${m}" aria-pressed="${(pend('mode') ? pend('mode').value : car.mode) === m}">${RaceEngine.MODES[m].label}</button>`).join('')}</div>
    <div class="f1-row"><span class="lbl">Box</span>${['soft', 'medium', 'hard', 'inter', 'wet'].map(k => `<button class="btn small" data-act="tt-call" data-type="box" data-value="${k}" aria-pressed="${!!(pend('box') && pend('box').compound === k)}">${f1TyreChip(k)} ${k === 'inter' ? 'Inter' : RaceEngine.COMPOUNDS[k].label}</button>`).join('')}</div>
    ${(car.plans || []).length ? `<div class="f1-row"><span class="lbl">Plan</span>${car.plans.map((p, i) => `<button class="btn small" data-act="tt-call" data-type="plan" data-value="${i}" aria-pressed="${!!(pend('strategy') && pend('strategy').plan === i)}" ${car.planName === PLAN_NAMES[i] ? 'disabled' : ''}>Switch to ${PLAN_NAMES[i]}</button>`).join('')}</div>` : ''}
    ${lockedStatusHtml(w, e, car)}</section>`;
}

route('test', 'Test Track', function () {
  if (!F1.teams().length) return '<div class="page-head"><div><h1>Test Track</h1><p>The grid isn’t set up yet.</p></div></div>';
  const f = ttCfg(), w = S.tt.w, tracks = F1.tracks(), t = F1.track(f.trackId) || tracks[0], ents = f1Entrants(), live = !!S.tt.timer;
  let h = `<div class="page-head"><div><h1>Test Track</h1><p>The same simulator as the official races, with the league’s grid, cars and ratings. It runs in your browser: nothing here is saved or counts towards anything, so try whatever you like.</p></div>
    ${w && w.state ? `<div class="f1-lap ${live ? 'live' : ''}"><small>${w.state.finished ? 'Chequered flag' : w.state.lap ? 'Test, lap' : 'Grid set'}</small>${w.state.lap}<span class="of">/${w.state.laps}</span></div>` : ''}</div>`;
  if (!w) {
    const fakeW = ttW(), mine = ents.find(e => e.id === f.car) || ents[0], sf = stratForm(fakeW, mine), N = raceLaps(fakeW), L = tyreKnowledge(fakeW, mine);
    S.ui.stratW = fakeW;
    h += `<section class="card"><h2>The session</h2><div class="metrics" style="align-items:end">
        <label class="field">Circuit${sel('tt-track', 'ui/form/tt/trackId', f.trackId, tracks.map(x => [x.id, x.name]))}</label>
        <label class="field">Session${sel('tt-session', 'ui/form/tt/session', f.session, [['gp', 'Grand Prix']].concat(t.hasSprint ? [['sprint', 'Sprint']] : []))}</label>
        <label class="field">Weather${sel('tt-weather', 'ui/form/tt/weatherMode', f.weatherMode, F1_WEATHER)}</label>
        <label class="field">Seed (optional)<input id="tt-seed" type="number" min="1" data-bind="ui/form/tt/seed" value="${esc(f.seed || '')}" placeholder="Random"></label></div>
      ${randomnessHtml('tt', f, t)}</section>
      <section class="card" style="--team:${esc(F1.team(mine.teamId).color)}"><h2>Your car</h2>
        <div class="metrics" style="align-items:end"><label class="field">Car${sel('tt-car', 'ui/form/tt/car', f.car, ents.map(e => [e.id, `${e.name}, ${F1.team(e.teamId).name}`]))}</label>
          <label class="field">Set-up quality (20 to 95)<input id="tt-setup" type="number" min="20" max="95" data-bind="ui/form/tt/setup" data-type="number" value="${esc(f.setup)}"></label></div>
        <p class="muted small">Tyre life here: ${['soft', 'medium', 'hard'].map(k => `${f1TyreChip(k)} about ${L[k].laps} laps`).join(' &nbsp; ')}. ${esc(forecastText(fakeW))}</p>
        ${presetBarHtml(mine, sf)}
        <div class="tabs" role="tablist">${PLAN_NAMES.map((n, i) => `<button role="tab" class="tab" data-act="strat-tab" data-car="${esc(mine.id)}" data-i="${i}" aria-selected="${(sf.tab || 0) === i}">${n}</button>`).join('')}</div>
        ${planEditorHtml(fakeW, mine, sf, sf.tab || 0, N, L)}
        <label class="field" style="max-width:240px">Start on${sel(`sp-${mine.id}-active`, `ui/form/strat/${mine.id}/active`, sf.active, PLAN_NAMES.map((n, i) => [String(i), n]))}</label>
        ${approachHtml(mine, sf)}${triggersEditorHtml(mine, sf, N)}
        <div class="btn-row"><button class="btn primary" data-act="tt-quali">Run qualifying</button></div></section>`;
    return h;
  }
  h += `<section class="card rc ${live ? 'is-live' : ''}"><h2>Controls ${live ? '<span class="tag live">Running</span>' : ''}</h2><div class="btn-row">
    ${w.state.finished ? '' : `<button class="btn primary" data-act="tt-play">${live ? 'Pause' : w.state.lap ? 'Resume' : 'Start the race'}</button>
      <label class="sr-only" for="tt-speed">Speed</label>${sel('tt-speed', 'ui/form/tt/speed', f.speed, [['2000', 'A lap every 2 seconds'], ['1000', 'A lap a second'], ['300', 'Fast']])}
      <button class="btn" data-act="tt-step" data-laps="1" ${live ? 'disabled' : ''}>Next lap</button><button class="btn" data-act="tt-step" data-laps="999" ${live ? 'disabled' : ''}>Run to the flag</button>
      <label class="small"><input type="checkbox" data-act="tt-stopsc" ${S.ui.form.ttStopSc !== false ? 'checked' : ''}> Pause for safety cars</label>`}
    <button class="btn" data-act="tt-reset">Back to set-up</button><button class="btn" data-act="tt-quali">Run it again (new seed unless set)</button></div>
    <p class="muted small">${esc(forecastText(w))}</p></section>`;
  if (w.state.lap > 0 && !w.state.finished) h += ttMomentHtml(w) + ttCarHtml(w);
  if (w.status === 'finished') h += `<section class="card"><h2>Classification</h2><div class="scroll-x">${f1ResultsHtml(w)}</div></section>`;
  const racing = w.state.lap > 0, tab = S.ui.f1tab && (racing || S.ui.f1tab === 'feed') ? S.ui.f1tab : 'feed';
  const tabs = [['feed', 'Race log'], ['lapchart', 'Lap chart'], ['tyres', 'Tyre strategy'], ['driver', S.ui.f1pick ? `Driver: ${S.ui.f1pick}` : 'Driver']].filter(x => racing || x[0] === 'feed');
  const body = tab === 'lapchart' ? lvLapChartHtml(w) : tab === 'tyres' ? f1ChartHtml(w) : tab === 'driver' ? lvDriverHtml(w) : f1FeedHtml(w);
  h += `<div class="f1-main"><section class="card"><h2>${racing ? 'Timing' : 'Qualifying'}</h2><div class="scroll-x">${lvTowerHtml(w)}</div></section>
    <section class="card"><div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="tab" data-act="f1-tab" data-tab="${k}" aria-selected="${tab === k}">${esc(l)}</button>`).join('')}</div>${body}</section></div>`;
  return h;
});

/* =====================================================================
   F1 SIM — series and seasons.
   The league can run several series side by side (Formula 1, Formula 2,
   Formula 3, or one built from scratch), each with its own teams, seats,
   drivers, calendar, race lengths, points, qualifying and rules. A switch
   in the top bar changes which series the whole site shows. Every race
   weekend belongs to a season of a series; Race Control catalogues a
   finished season into the archive and starts the next, choosing what
   carries over. Characters keep one set of ratings across every series
   and season, and can hold one seat in each series.
   Existing records with no series belong to Formula 1's first season.
   ===================================================================== */
'use strict';

const F1_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const SERIES_TEMPLATES = {
  f1: { name: 'Formula 1', short: 'F1', color: '#E10600', lapFactor: 1, sprintFactor: 0.33, points: F1_POINTS, sprintPoints: [8, 7, 6, 5, 4, 3, 2, 1], quali: 'knockout',
    development: true, puAllowance: 4, budget: 30, mandatoryStop: true, carsPerTeam: 2, firstSeason: '2026', blurb: 'Today’s grid, real teams, development and power units.' },
  f2: { name: 'Formula 2', short: 'F2', color: '#1B6FD1', lapFactor: 0.56, sprintFactor: 0.4, points: F1_POINTS, sprintPoints: [10, 8, 6, 5, 4, 3, 2, 1], quali: 'single', sprintEvery: true,
    development: false, puAllowance: null, budget: 6, mandatoryStop: true, carsPerTeam: 2, engine: 'Mecachrome V6 (spec)', level: 'feeder', firstSeason: '2026',
    blurb: 'Identical cars, a sprint and a feature race every round. The last step before F1.',
    teams: [['invicta', 'Invicta Racing', '#C9A227'], ['campos', 'Campos Racing', '#E4572E'], ['dams', 'DAMS', '#2D6FB7'], ['hitech', 'Hitech', '#9AA3AD'], ['art', 'ART Grand Prix', '#3D3D3D'],
      ['mp', 'MP Motorsport', '#F28C28'], ['prema', 'Prema Racing', '#D7263D'], ['rodin', 'Rodin Motorsport', '#4C9A2A'], ['aix', 'AIX Racing', '#7A4FBF'], ['trident', 'Trident', '#1F3A93'], ['var', 'Van Amersfoort Racing', '#E6194B']],
    calendar: ['australia', 'bahrain', 'saudi', 'monaco', 'spain', 'austria', 'britain', 'belgium', 'hungary', 'italy', 'azerbaijan', 'qatar', 'abudhabi'] },
  f3: { name: 'Formula 3', short: 'F3', color: '#2FA84F', lapFactor: 0.45, sprintFactor: 0.37, points: F1_POINTS, sprintPoints: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1], quali: 'single', sprintEvery: true,
    development: false, puAllowance: null, budget: 3, mandatoryStop: false, carsPerTeam: 3, engine: 'Mecachrome (spec)', level: 'junior', firstSeason: '2026',
    blurb: 'Thirty cars, three per team, no pit stops. Where careers start.',
    teams: [['prema', 'Prema Racing', '#D7263D'], ['trident', 'Trident', '#1F3A93'], ['art', 'ART Grand Prix', '#3D3D3D'], ['mp', 'MP Motorsport', '#F28C28'], ['hitech', 'Hitech', '#9AA3AD'],
      ['campos', 'Campos Racing', '#E4572E'], ['rodin', 'Rodin Motorsport', '#4C9A2A'], ['aix', 'AIX Racing', '#7A4FBF'], ['var', 'Van Amersfoort Racing', '#E6194B'], ['dams', 'DAMS', '#2D6FB7']],
    calendar: ['australia', 'bahrain', 'monaco', 'spain', 'austria', 'britain', 'belgium', 'hungary', 'italy'] }
};
const LEVELS = { elite: { base: 82, spread: 14 }, feeder: { base: 73, spread: 14 }, junior: { base: 64, spread: 16 } };
const FIRST = ['Mateo', 'Elena', 'Jonas', 'Aiko', 'Rafael', 'Nora', 'Kai', 'Lucía', 'Theo', 'Ines', 'Ravi', 'Maja', 'Oscar', 'Leila', 'Arlo', 'Sofia', 'Hugo', 'Ama', 'Niko', 'Freya', 'Dario', 'Yuki', 'Cian', 'Mira', 'Emil', 'Zara', 'Luca', 'Ines', 'Tomás', 'Hana', 'Ezra', 'Aoife'];
const LAST = ['Varga', 'Lindholm', 'Okafor', 'Castell', 'Brandt', 'Moreau', 'Sato', 'Delgado', 'Kowalski', 'Hallberg', 'Ferreira', 'Novak', 'Achterberg', 'Rossi-Lane', 'MacAulay', 'Petrov', 'Haddad', 'Quinlan', 'Jensen', 'Abara', 'Silvestri', 'Takeda', 'Laurent', 'Mbeki', 'Ortega', 'Halvorsen', 'Duarte', 'Kerrigan', 'Vasquez', 'Ilić', 'Brennan', 'Asante'];
const TEAM_WORDS = ['Aurora', 'Kestrel', 'Meridian', 'Halcyon', 'Vanguard', 'Ironbridge', 'Solent', 'Corsa', 'Northwind', 'Cobalt', 'Granite', 'Arrowfield', 'Lumen', 'Torque', 'Saltire', 'Pinnacle'];
const TEAM_COLOURS = ['#E4572E', '#2D6FB7', '#4C9A2A', '#C9A227', '#7A4FBF', '#D7263D', '#1F3A93', '#F28C28', '#118A7E', '#9AA3AD', '#B5179E', '#3D3D3D', '#E6194B', '#6C8EAD', '#8D6E63', '#00A6A6'];

/* ---------------------------------------------------------------- the current series and season */
const curSeriesId = () => S.series || 'f1';
function seriesDoc(id) {
  const d = get('f1_series', id), tpl = SERIES_TEMPLATES[(d && d.template) || id] || SERIES_TEMPLATES.f1;
  return Object.assign({}, tpl, d || {}, { id });
}
const curSeries = () => seriesDoc(curSeriesId());
function allSeries() {
  const ids = new Set(list('f1_series').map(s => s.id)); if (list('f1_teams').some(t => (t.seriesId || 'f1') === 'f1')) ids.add('f1');
  return [...ids].map(seriesDoc).sort((a, b) => (a.order || (a.id === 'f1' ? 0 : a.id === 'f2' ? 1 : a.id === 'f3' ? 2 : 9)) - (b.order || (b.id === 'f1' ? 0 : b.id === 'f2' ? 1 : b.id === 'f3' ? 2 : 9)));
}
const curSeasonId = sid => seriesDoc(sid || curSeriesId()).activeSeason || `${sid || curSeriesId()}-1`;
function seasonDoc(id) {
  const d = get('f1_seasons', id); if (d) return d;
  const sid = id.slice(0, id.lastIndexOf('-')), s = seriesDoc(sid);
  return { id, seriesId: sid, name: s.firstSeason || '2026', status: 'active', implicit: true };
}
const curSeason = () => seasonDoc(curSeasonId());
const seasonClosed = () => curSeason().status === 'archived';
const wSeries = w => w.seriesId || 'f1';
const wSeason = w => w.seasonId || `${wSeries(w)}-1`;
const recSeason = x => x.seasonId || `${(F1.team(x.teamId) || {}).seriesId || 'f1'}-1`;
function adjustTrack(t, s, round) {
  return Object.assign({}, t, { round, laps: Math.max(5, Math.round(t.laps * (s.lapFactor || 1))), sprintLaps: Math.max(4, Math.round(t.laps * (s.sprintFactor || 0.33))), hasSprint: s.sprintEvery ? true : t.hasSprint });
}
/* The rest of the app reads everything through these, so the whole site follows the series switch. */
Object.assign(F1, {
  teams: () => list('f1_teams').filter(t => (t.seriesId || 'f1') === curSeriesId()).sort((a, b) => (a.order || 0) - (b.order || 0)),
  seats: teamId => { const ids = teamId ? null : new Set(F1.teams().map(t => t.id)); return list('f1_seats').filter(s => teamId ? s.teamId === teamId : ids.has(s.teamId)).sort((a, b) => (a.order || 0) - (b.order || 0)); },
  tracks: () => { const s = curSeries(), all = list('f1_tracks').sort((a, b) => (a.round || 0) - (b.round || 0)), cal = s.calendar;
    return (cal && cal.length ? cal.map(id => all.find(t => t.id === id)).filter(Boolean) : all).map((t, i) => adjustTrack(t, s, i + 1)); },
  track: id => { const t = get('f1_tracks', id); if (!t) return null; const s = curSeries(), cal = s.calendar || [], i = cal.indexOf(id); return adjustTrack(t, s, cal.length ? (i >= 0 ? i + 1 : '') : t.round); },
  weekends: () => list('f1_weekends').filter(w => wSeries(w) === curSeriesId() && wSeason(w) === curSeasonId()).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
  allWeekends: () => list('f1_weekends').sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
  live: () => F1.weekends().find(w => w.status !== 'finished') || null
});
CHANGES['series-switch'] = v => { S.series = v; lsSet('f1sim.series', v); S.ui.teamId = null; S.ui.f1view = null; S.tt.cfg = null; S.tt.w = null; S.ui.form.f1w = null; render(); };
(function () { const saved = lsGet('f1sim.series'); if (saved) S.series = saved; })();
function seriesSwitchHtml() {
  const all = allSeries(); if (all.length < 2) return '';
  return `<label class="series-pick"><span class="sr-only">Series</span><select id="series-switch" data-change="series-switch" style="--series:${esc(curSeries().color)}">${all.map(s => `<option value="${esc(s.id)}" ${s.id === curSeriesId() ? 'selected' : ''}>${esc(s.short)}: ${esc(s.name)}</option>`).join('')}</select></label>`;
}

/* ---------------------------------------------------------------- the series' own rules, in the race */
function seriesRules(s) {
  const out = { points: s.points || F1_POINTS, sprintPoints: s.sprintPoints, mandatoryCompounds: s.mandatoryStop !== false };
  if (s.quali === 'single') out.qualifying = { q2: 99, q3: 99 };
  return out;
}

/* ---------------------------------------------------------------- loading a series */
function genPerson(id, rng, lvl, extra) {
  const L = LEVELS[lvl] || LEVELS.feeder, r = () => L.base + Math.floor(rng() * L.spread);
  const first = FIRST[Math.floor(rng() * FIRST.length)], last = LAST[Math.floor(rng() * LAST.length)];
  const styles = ['charger', 'aggressive', 'qualifier', 'technical', 'smooth', 'defender', 'strategist', 'ironman'];
  return Object.assign({ id, kind: 'driver', fictional: true, name: `${first} ${last}`, abbr: last.normalize('NFD').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase(),
    pace: r(), consistency: r(), wet: r(), overtaking: r(), defense: r(), experience: Math.max(10, L.base - 50 + Math.floor(rng() * 30)), mental: 4 + Math.floor(rng() * 6),
    style: styles[Math.floor(rng() * styles.length)], goodTracks: [], badTracks: [], rivals: [] }, extra || {});
}
/* Rows to write for a series made from a template (or a custom one): series, season, teams, seats, people. */
function seriesRows(key, opts) {
  opts = opts || {};
  const tpl = SERIES_TEMPLATES[opts.template || key], rows = [], rng = RaceEngine.rng(h32('series', key, opts.name || '')), cars = Number(opts.carsPerTeam) || tpl.carsPerTeam || 2;
  const teamList = opts.teams || tpl.teams || [];
  const doc = Object.assign({ template: opts.template || key, activeSeason: `${key}-1` }, opts.name ? { name: opts.name, short: opts.short, color: opts.color, carsPerTeam: cars, level: opts.level || tpl.level } : {});
  if (key !== 'f1' || opts.template) rows.push(['f1_series', key, doc]);
  const archs = ['one_stop', 'aggressive_two', 'undercut_king', 'overcut', 'reactive', 'tyre_banker', 'safety_car'];
  teamList.forEach(([slug, name, color], ti) => {
    const id = `${key}-${slug}`, base = tpl.development ? 80 + Math.round(rng() * 10) : 82;
    rows.push(['f1_teams', id, { seriesId: key, name, color, order: ti + 1, powerUnit: tpl.engine || 'Customer', strategy: archs[Math.floor(rng() * archs.length)],
      carPace: base, topSpeed: tpl.development ? 10 + Math.round(rng() * 6) : 12, cornering: tpl.development ? 10 + Math.round(rng() * 6) : 12,
      reliability: 86 + Math.round(rng() * 8), pitSpeed: 80 + Math.round(rng() * 12), tyreLife: 72 + Math.round(rng() * 8) }]);
    const tp = genPerson(`${key}-tp-${slug}`, rng, 'elite', { kind: 'principal', seriesId: key, teamId: id }); rows.push(['f1_people', tp.id, tp]);
    const seat = (k, role, car, order, def) => rows.push(['f1_seats', `${id}-${k}`, { teamId: id, role, car, order: ti * 10 + order, defaultPersonId: def || null, holderCharId: null, holderName: null, holderSince: null }]);
    seat('tp', 'principal', null, 0, tp.id);
    for (let c = 1; c <= cars; c++) {
      const p = genPerson(`${key}-drv-${slug}-${c}`, rng, opts.level || tpl.level || 'feeder', { seriesId: key, teamId: id, num: ti * cars + c + 1 }); rows.push(['f1_people', p.id, p]);
      seat('d' + c, 'driver', c, c * 2 - 1, p.id); seat('e' + c, 'engineer', c, c * 2, null);
    }
  });
  if (!list('f1_tracks').length) F1_DEFAULTS.tracks.forEach(t => rows.push(['f1_tracks', t.id, Object.assign({}, t)]));
  return rows;
}
ACTIONS['series-add'] = d => {
  const tpl = SERIES_TEMPLATES[d.key]; if (!tpl) return;
  if (get('f1_series', d.key)) { toast(`${tpl.name} is already set up.`, true); return; }
  askConfirm(`Set up ${tpl.name}: ${tpl.teams.length} teams with ${tpl.carsPerTeam} cars each, fictional drivers to start with, and a ${tpl.calendar.length}-round calendar? Players’ characters can then take seats in it.`, `Set up ${tpl.short}`, () => run(async () => {
    await f1PutAll(seriesRows(d.key)); await Data.audit('series.add', `${tpl.name} set up`);
  }, `${tpl.name} is ready. Switch to it in the top bar.`));
};
ACTIONS['series-custom'] = () => {
  const f = S.ui.form.newSeries || {}, name = String(f.name || '').trim(), short = String(f.short || '').trim().toUpperCase().slice(0, 4);
  if (!name || !short) { toast('Give the series a name and a short code.', true); return; }
  const key = 'cx-' + short.toLowerCase().replace(/[^a-z0-9]/g, ''); if (get('f1_series', key)) { toast('There’s already a series with that code.', true); return; }
  const n = Math.max(4, Math.min(14, Number(f.teams) || 8)), rng = RaceEngine.rng(h32('custom', key)), words = TEAM_WORDS.slice().sort(() => rng() - 0.5);
  const teams = words.slice(0, n).map((w, i) => [w.toLowerCase(), `${w} ${['Racing', 'Motorsport', 'GP', 'Racing Team'][i % 4]}`, TEAM_COLOURS[i % TEAM_COLOURS.length]]);
  const tpl = SERIES_TEMPLATES[f.template || 'f2'], opts = { template: f.template || 'f2', name, short, color: f.color || '#7A4FBF', carsPerTeam: Number(f.cars) || 2, level: f.level || 'feeder', teams };
  run(async () => { const rows = seriesRows(key, opts); rows.find(r => r[0] === 'f1_series')[2].calendar = (tpl.calendar || F1_DEFAULTS.tracks.map(t => t.id)).slice(0, 10);
    await f1PutAll(rows); await Data.audit('series.add', `${name} set up`); S.ui.form.newSeries = {}; }, `${name} is ready. Switch to it in the top bar, then rename its teams from The Grid (the Car button).`);
};
ACTIONS['calendar-save'] = () => {
  const s = curSeries(), pick = S.ui.form.cal || {}, ids = list('f1_tracks').sort((a, b) => (a.round || 0) - (b.round || 0)).map(t => t.id).filter(id => pick[id]);
  if (ids.length < 1) { toast('Pick at least one circuit.', true); return; }
  run(async () => { await Data.put('f1_series', s.id, Object.assign(get('f1_series', s.id) ? clone(S.store.f1_series[s.id]) : { template: s.id, activeSeason: curSeasonId() }, { calendar: ids })); }, `${s.name}’s calendar saved: ${plural(ids.length, 'round')}.`);
};

/* ---------------------------------------------------------------- standings for any season */
function standingsOf(weekends) {
  const drivers = new Map(), teams = new Map();
  weekends.filter(w => w.status === 'finished').slice().sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt))).forEach(w => (w.results || []).forEach(r => {
    const d = drivers.get(r.personId) || { personId: r.personId, name: r.name, teamId: r.teamId, charId: r.charId, pts: 0, wins: 0, podiums: 0, starts: 0, best: 99 };
    d.pts += r.points || 0; d.starts += 1; d.teamId = r.teamId; d.name = r.name;
    if (r.position) { if (r.position === 1 && w.session !== 'sprint') d.wins += 1; if (r.position <= 3 && w.session !== 'sprint') d.podiums += 1; d.best = Math.min(d.best, r.position); }
    drivers.set(r.personId, d);
    const t = teams.get(r.teamId) || { teamId: r.teamId, name: (get('f1_teams', r.teamId) || {}).name || r.teamId, pts: 0, wins: 0 }; t.pts += r.points || 0; if (w.session !== 'sprint' && r.position === 1) t.wins += 1; teams.set(r.teamId, t);
  }));
  const order = (a, b) => b.pts - a.pts || b.wins - a.wins || (a.best || 99) - (b.best || 99);
  return { drivers: [...drivers.values()].sort(order), teams: [...teams.values()].sort(order) };
}
const seasonWeekendsOf = (seriesId, seasonId) => list('f1_weekends').filter(w => wSeries(w) === seriesId && wSeason(w) === seasonId);

/* ---------------------------------------------------------------- cataloguing a season, starting the next */
ACTIONS['season-end'] = () => {
  const s = curSeries(), season = curSeason(); if (season.status === 'archived') return;
  if (F1.live()) { toast('Finish or cancel the open weekend first.', true); return; }
  const ws = seasonWeekendsOf(s.id, season.id).filter(w => w.status === 'finished'), st = standingsOf(ws);
  askConfirm(`Catalogue ${s.name}’s ${season.name} season? Its ${plural(ws.length, 'race')}, standings and champions go into the archive, and no more weekends can be opened until you start the next season.`, 'Catalogue the season', () => run(async () => {
    const snap = { drivers: st.drivers.map(d => ({ personId: d.personId, name: d.name, teamId: d.teamId, teamName: (get('f1_teams', d.teamId) || {}).name || '', charId: d.charId || null, pts: d.pts, wins: d.wins, podiums: d.podiums })),
      teams: st.teams.map(t => ({ teamId: t.teamId, name: t.name, pts: t.pts, wins: t.wins })), races: ws.filter(w => w.session === 'gp').length, sprints: ws.filter(w => w.session === 'sprint').length };
    /* Keep what's already on the season (its engine rules, say). */
    const was = get('f1_seasons', season.id) ? clone(S.store.f1_seasons[season.id]) : {};
    await Data.put('f1_seasons', season.id, Object.assign(was, { seriesId: s.id, name: season.name, status: 'archived', startedAt: season.startedAt || (ws[ws.length - 1] || {}).createdAt || null, endedAt: nowIso(), archive: snap }));
    await Data.audit('season.end', `${s.name} ${season.name} catalogued: ${snap.drivers[0] ? snap.drivers[0].name + ' champion' : 'no races'}`);
  }, `${season.name} catalogued. Start the next season when you’re ready.`), true);
};
ACTIONS['season-start'] = () => {
  const s = curSeries(), prev = curSeason(), f = S.ui.form.newSeason || {}, name = String(f.name || '').trim() || String((Number(prev.name) || 2026) + 1);
  if (prev.status !== 'archived') { toast('Catalogue the current season first.', true); return; }
  const n = Number(String(prev.id).split('-').pop()) + 1, id = `${s.id}-${n}`, carry = Number(f.carry == null ? 0.5 : f.carry), keep = f.keepSeats !== false;
  run(async () => {
    /* Car development carries over in part: each team's base moves towards where its car finished the season. */
    if (carry > 0 && s.development) for (const t of F1.teams()) {
      /* Only development carries over, not the engine's effect (next season's engine applies on top). */
      const eff = f1EffectiveTeam(t, finishedGps().length), withEngine = engineApply(t, Object.assign({}, t)), doc = clone(S.store.f1_teams[t.id]);
      ['carPace', 'topSpeed', 'cornering', 'reliability', 'tyreLife', 'pitSpeed'].forEach(k => { if (eff[k] != null && t[k] != null) { const dev = (eff[k] - ((withEngine[k] || 0) - (t[k] || 0))) - t[k]; doc[k] = Math.round((t[k] + dev * carry) * 100) / 100; } });
      await Data.put('f1_teams', t.id, doc);
    }
    if (!keep) for (const seat of F1.seats().filter(x => x.holderCharId)) await Data.put('f1_seats', seat.id, Object.assign(clone(S.store.f1_seats[seat.id]), { holderCharId: null, holderName: null, holderSince: null }));
    const pe = engineConfig(s.id, prev.id), nf = ENGINE_FORMULAS[f.engine] ? f.engine : pe.formula;
    await Data.put('f1_seasons', id, { seriesId: s.id, name, status: 'active', startedAt: nowIso(), carry, keptSeats: keep, engine: { formula: nf, teams: pe.teams, ratings: nf === pe.formula ? pe.ratings : {}, seed: 0 } });
    await Data.put('f1_series', s.id, Object.assign(get('f1_series', s.id) ? clone(S.store.f1_series[s.id]) : { template: s.id }, { activeSeason: id }));
    await Data.audit('season.start', `${s.name} ${name} season started`);
    S.ui.form.newSeason = {};
  }, `${s.name} ${name} has started. Budgets, upgrades, power units, sponsors and contracts start fresh; drivers keep their ratings and careers.`);
};

/* ---------------------------------------------------------------- Seasons page (everyone; Race Control acts here) */
function archiveHtml(season) {
  const a = season.archive || { drivers: [], teams: [] }, champ = a.drivers[0], cons = a.teams[0];
  const ws = seasonWeekendsOf(season.seriesId, season.id).filter(w => w.status === 'finished').sort((x, y) => String(x.finishedAt).localeCompare(String(y.finishedAt)));
  return `<section class="card season-card"><h2>${esc(season.name)} <span class="sub">${plural(a.races || 0, 'Grand Prix', 'Grands Prix')}${a.sprints ? `, ${plural(a.sprints, 'sprint')}` : ''}. Catalogued ${esc(fmtDate(season.endedAt))}.</span></h2>
    ${champ ? `<p class="champ"><span class="tag trophy">Champion</span> <b>${careerLink(champ.personId, champ.name)}</b>, ${esc(champ.teamName)}, ${champ.pts} points${cons ? `. <span class="tag trophy">Teams’ champions</span> <b>${esc(cons.name)}</b>, ${cons.pts} points` : ''}.</p>` : '<p class="muted">No races were run.</p>'}
    <details><summary>Final standings</summary><div class="cols2"><table class="data compact"><thead><tr><th>Pos</th><th>Driver</th><th>Team</th><th class="num">Points</th></tr></thead><tbody>${a.drivers.map((d, i) => `<tr><td>${i + 1}</td><td>${careerLink(d.personId, d.name)}${d.charId ? ' <span class="tag player">Player</span>' : ''}</td><td>${esc(d.teamName)}</td><td class="num">${d.pts}</td></tr>`).join('')}</tbody></table>
      <table class="data compact"><thead><tr><th>Pos</th><th>Team</th><th class="num">Points</th></tr></thead><tbody>${a.teams.map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.name)}</td><td class="num">${t.pts}</td></tr>`).join('')}</tbody></table></div></details>
    ${ws.length ? `<details><summary>Every result</summary><table class="data compact"><tbody>${ws.map(w => { const t = get('f1_tracks', w.trackId) || {}, win = (w.results || [])[0] || {};
      return `<tr><td>${esc(t.name || w.trackId)}${w.session === 'sprint' ? ' sprint' : ''}</td><td>${esc(win.name || '')}</td><td class="num"><button class="btn small" data-act="f1-view" data-id="${esc(w.id)}" data-go="weekend">View</button></td></tr>`; }).join('')}</tbody></table></details>` : ''}</section>`;
}
route('seasons', 'Seasons', function () {
  const s = curSeries(), season = curSeason(), ws = F1.weekends(), done = ws.filter(w => w.status === 'finished'), st = standingsOf(done), lead = st.drivers[0];
  const archived = list('f1_seasons').filter(x => x.seriesId === s.id && x.status === 'archived').sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)));
  const f = S.ui.form.newSeason = S.ui.form.newSeason || {};
  let h = `<div class="page-head"><div><p class="eyebrow">${esc(s.name)}</p><h1>Seasons</h1><p>The current season, and every one catalogued before it.</p></div></div>`;
  if (season.status !== 'archived') h += `<section class="card" style="--team:${esc(s.color)}"><h2>${esc(season.name)} <span class="sub">In progress</span></h2>
    <p>${plural(done.filter(w => w.session === 'gp').length, 'Grand Prix', 'Grands Prix')} run of ${F1.tracks().length} rounds.${lead ? ` ${careerLink(lead.personId, lead.name)} leads with ${lead.pts} points.` : ''}</p>
    ${S.isGm ? `<div class="btn-row"><button class="btn" data-act="season-end">Catalogue the season</button></div><p class="muted small">Do this after the last round. The season’s results and champions go into the archive; then you start the next one.</p>` : ''}</section>`;
  else h += `<section class="card"><h2>Between seasons</h2><p>${esc(season.name)} is catalogued. ${S.isGm ? 'Start the next season to open weekends again.' : 'Race Control will start the next season soon.'}</p>
    ${S.isGm ? `<div class="metrics" style="align-items:end"><label class="field">Season name<input id="ns-name" type="text" data-bind="ui/form/newSeason/name" value="${esc(f.name || String((Number(season.name) || 2026) + 1))}"></label>
      ${s.development ? `<label class="field">Car development carried over${sel('ns-carry', 'ui/form/newSeason/carry', String(f.carry == null ? '0.5' : f.carry), [['0', 'None: back to base'], ['0.5', 'Half of it'], ['1', 'All of it']])}</label>` : ''}</div>
      <label class="field" style="max-width:420px">Engines${sel('ns-engine', 'ui/form/newSeason/engine', f.engine || engineConfig().formula, ENGINE_ORDER.map(k => [k, ENGINE_FORMULAS[k].label]))}</label>
      <label class="small"><input type="checkbox" data-bind="ui/form/newSeason/keepSeats" ${f.keepSeats !== false ? 'checked' : ''}> Players keep their seats</label>
      <p class="muted small">Budgets, upgrades in progress, power units, sponsors and contracts start fresh. Drivers keep their ratings, development and careers.</p>
      <div class="btn-row"><button class="btn primary" data-act="season-start">Start the new season</button></div>` : ''}</section>`;
  if (season.status !== 'archived') h += engineCardHtml();
  h += archived.length ? archived.map(archiveHtml).join('') : '<p class="muted">No seasons catalogued yet.</p>';
  return h;
});

/* ---------------------------------------------------------------- Series page (Race Control) */
route('series', 'Series', function () {
  const all = allSeries(), cur = curSeries(), tracks = list('f1_tracks').sort((a, b) => (a.round || 0) - (b.round || 0));
  const cal = S.ui.form.cal = S.ui.form.cal && S.ui.form.calFor === cur.id ? S.ui.form.cal : Object.fromEntries((cur.calendar && cur.calendar.length ? cur.calendar : tracks.map(t => t.id)).map(id => [id, true]));
  S.ui.form.calFor = cur.id;
  const nf = S.ui.form.newSeries = S.ui.form.newSeries || { template: 'f2', teams: 8, cars: 2, level: 'feeder', color: '#7A4FBF' };
  return `<div class="page-head"><div><h1>Series</h1><p>Run several series side by side. Each has its own teams, seats, calendar, points and rules; characters can hold one seat in each, and keep their ratings everywhere.</p></div></div>
    <section class="card"><h2>Running now</h2><table class="data"><tbody>${all.map(s => `<tr><td><span class="f1-bar" style="background:${esc(s.color)}"></span><b>${esc(s.name)}</b> <span class="muted">${esc(s.short)}</span></td>
      <td>${esc(seasonDoc(curSeasonId(s.id)).name)} season${seasonDoc(curSeasonId(s.id)).status === 'archived' ? ' (catalogued)' : ''}</td><td class="muted small">${esc(s.blurb || '')}</td></tr>`).join('')}</tbody></table></section>
    <section class="card"><h2>Add a series</h2><div class="cards">${Object.keys(SERIES_TEMPLATES).filter(k => k !== 'f1' && !get('f1_series', k)).map(k => { const t = SERIES_TEMPLATES[k];
      return `<article class="card" style="--team:${esc(t.color)}"><h3>${esc(t.name)}</h3><p>${esc(t.blurb)}</p><p class="muted small">${t.teams.length} teams, ${t.carsPerTeam} cars each. ${t.quali === 'single' ? 'One qualifying session.' : ''} ${t.mandatoryStop ? 'A pit stop is required.' : 'No pit stops.'} Races ${Math.round(t.lapFactor * 100)}% of F1 distance; sprints too.</p>
        <button class="btn small primary" data-act="series-add" data-key="${k}">Set up ${esc(t.short)}</button></article>`; }).join('') || '<p class="muted">Formula 2 and Formula 3 are set up.</p>'}</div>
      <h3 style="margin-top:16px">Or build your own</h3><div class="form-grid">
        <label class="field">Name<input id="ns-n" type="text" data-bind="ui/form/newSeries/name" value="${esc(nf.name || '')}" placeholder="e.g. Saltire Formula Cup"></label>
        <label class="field">Short code<input id="ns-s" type="text" maxlength="4" data-bind="ui/form/newSeries/short" value="${esc(nf.short || '')}" placeholder="e.g. SFC"></label>
        <label class="field">Rules like${sel('ns-t', 'ui/form/newSeries/template', nf.template, [['f1', 'Formula 1: development, power units'], ['f2', 'Formula 2: spec cars, sprint and feature'], ['f3', 'Formula 3: spec cars, no pit stops']])}</label>
        <label class="field">Driver standard${sel('ns-l', 'ui/form/newSeries/level', nf.level, [['elite', 'Elite'], ['feeder', 'Feeder series'], ['junior', 'Junior']])}</label>
        <label class="field">Teams (4 to 14)<input id="ns-tm" type="number" min="4" max="14" data-bind="ui/form/newSeries/teams" data-type="number" value="${esc(nf.teams)}"></label>
        <label class="field">Cars per team${sel('ns-c', 'ui/form/newSeries/cars', String(nf.cars), [['2', 'Two'], ['3', 'Three']])}</label>
        <label class="field">Colour<input id="ns-col" type="color" data-bind="ui/form/newSeries/color" value="${esc(nf.color)}"></label></div>
      <div class="btn-row"><button class="btn primary" data-act="series-custom">Create the series</button></div>
      <p class="muted small">Custom series start with fictional teams and drivers; rename teams and tune their cars from The Grid.</p></section>
    <section class="card"><h2>${esc(cur.name)} calendar</h2><p class="muted small">Tick the circuits this series visits, in calendar order. Race lengths follow the series’ rules.</p>
      <div class="cal-grid">${tracks.map(t => `<label class="small"><input type="checkbox" data-bind="ui/form/cal/${esc(t.id)}" ${cal[t.id] ? 'checked' : ''}> ${esc(t.flag || '')} ${esc(t.name)}</label>`).join('')}</div>
      <div class="btn-row"><button class="btn primary" data-act="calendar-save">Save the calendar</button></div></section>`;
}, { gm: true });

/* =====================================================================
   F1 SIM — practice sessions, set-up guidance and debriefs.
   Each driving style wants something different from the car, so the
   ideal set-up is the team's (from the circuit and car) moved by the
   driver's style. The set-up guide says what the circuit rewards, what
   the driver likes, and the engineer's best guess so far, which sharpens
   with each session, the driver's experience and rapport.
   A Grand Prix weekend has three practice sessions (sprint weekends and
   one-session series have one), each with its own runs. Race Control
   ends each session: everyone gets the timesheet, and each player's car
   a debrief. Confidence at the circuit builds through practice and is
   worth up to two tenths a lap in qualifying and the race. After
   qualifying, a debrief breaks down the gap and looks ahead to the race.
   ===================================================================== */
'use strict';

const CONF_MAX = 0.2;        // seconds a lap: full confidence against none
const AI_CONF = 0.5;         // cars nobody plays run a normal programme
const STYLE_PREF = {
  charger: { wing: 6, susp: 8, diff: 6, likes: 'a pointy, responsive car: a little more wing and a stiffer platform than most, with the diff fairly locked to fire out of corners', hates: 'understeer: if the front won’t bite, the confidence goes' },
  aggressive: { wing: 4, susp: 6, diff: 8, likes: 'a stiff car with a locked diff, to throw it at the kerbs and get on the power early', hates: 'a lazy car that won’t change direction' },
  qualifier: { wing: 6, susp: 4, diff: 0, likes: 'maximum grip over one lap: more wing and a slightly stiffer car', hates: 'running light: give up a little straight-line speed for corner speed' },
  smooth: { wing: -2, susp: -8, diff: -6, likes: 'a soft, progressive car with an open diff, kind to the tyres', hates: 'a snappy rear end on the throttle' },
  defender: { wing: -4, susp: 0, diff: 4, likes: 'straight-line speed to stay out of reach: a little less wing than most', hates: 'being a sitting duck on the straights' },
  technical: { wing: 0, susp: 0, diff: 0, likes: 'whatever is fastest: technical drivers adapt, and their feedback is precise', hates: 'a car that’s out of balance' },
  strategist: { wing: 0, susp: -4, diff: -4, likes: 'a car that looks after its tyres: slightly softer, with an open diff', hates: 'a car that chews through the rears' },
  ironman: { wing: 2, susp: 2, diff: 0, likes: 'a stable, predictable car to rely on lap after lap', hates: 'a car that’s on a knife edge' }
};
const TYPE_TEXT = {
  'low-downforce': 'Long straights. Run low downforce and a fairly stiff car; top speed matters more than corner grip.',
  'high-speed': 'Fast, flowing corners. Medium-low downforce and a stiff car to keep it stable at speed.',
  mixed: 'A bit of everything. Middling downforce and a balanced, middle-of-the-range suspension.',
  technical: 'Lots of medium and slow corners. More downforce and a slightly softer car for the traction zones.',
  'high-downforce': 'Grip is everything. Plenty of downforce and medium suspension.',
  street: 'Bumpy, tight and walled in. Maximum downforce and a soft car to ride the bumps and kerbs.'
};
const styleOf = ent => (ent && ent.v3 && ent.v3.style) || ((f1Entrants().find(x => x.id === (ent && ent.id)) || {}).v3 || {}).style || 'technical';
const styleName = k => (F1_STYLES.find(s => s[0] === k) || ['', k])[1];
/* The set-up this car wants: the team's ideal, moved by its driver's style. */
function f1IdealFor(w, ent) {
  const i = f1Ideal(w, ent.teamId), p = STYLE_PREF[styleOf(ent)] || STYLE_PREF.technical;
  return { wing: clampN(i.wing + p.wing, 5, 95), susp: clampN(i.susp + p.susp, 5, 95), diff: clampN(i.diff + p.diff, 5, 95) };
}

/* ---------------------------------------------------------------- sessions */
const sessionsOf = w => w.session === 'test' ? 3 : w.session === 'sprint' || seriesDoc(wSeries(w)).quali === 'single' ? 1 : 3;
const runsPerSession = w => w.session === 'test' ? 6 : sessionsOf(w) === 1 ? 4 : 2;
const curSession = w => Math.min(sessionsOf(w), ((w.practice && w.practice.session) || 1));
const sessionName = (w, n) => w.session === 'test' ? `Day ${n}` : sessionsOf(w) === 1 ? 'Practice' : `FP${n}`;
const endedSessions = w => (w.practice && w.practice.done) || [];
const runsIn = (w, carId, n) => f1Runs(w, carId).filter(r => (r.session || 1) === n);
/* Can a player work on this car? Otherwise it runs a normal programme. */
const playerRun = (w, ent) => F1.seats(ent.teamId).some(s => s.holderCharId && (s.role === 'principal' || (s.car === ent.car && (s.role === 'engineer' || s.role === 'driver'))));
function bestSetupIn(w, ent, runs) {
  /* Only runs that happened count; a set-up found on a wet track is only half trusted. */
  return runs.filter(r => r.kind === 'setup').map(r => ({ r, ctx: runContext(w, r) })).filter(x => !x.ctx || x.ctx.cond)
    .reduce((b, x) => { const wet = !!(x.ctx && x.ctx.cond !== 'dry'), q = f1SetupQuality(w, ent.teamId, x.r.dials, ent), score = wet ? 60 + (q - 60) / 2 : q; return !b || score > b.score ? { q, r: x.r, wet, score } : b; }, null);
}
/* Confidence at this circuit, 0 to 1: built session by session, more with a set-up the driver likes. */
function confidenceAfter(w, ent, upTo) {
  if (!playerRun(w, ent)) return AI_CONF;
  const per = 3 / sessionsOf(w); let c = 0;
  for (let n = 1; n <= upTo; n++) { const runs = runsIn(w, ent.id, n).filter(r => { const x = runContext(w, r); return !x || x.cond; }), rec = endedSessions(w).find(s => s.n === n);
    if (rec && (rec.crashes || []).indexOf(ent.id) !== -1) c -= 0.15;
    if (!runs.length) continue;
    const b = bestSetupIn(w, ent, runs), close = b ? clampN((b.score - 60) / 35, 0, 1) : 0; c += (0.2 + 0.15 * close) * per; }
  c = Math.max(0, c);
  return Math.min(1, Math.round(c * 100) / 100);
}
const confidenceNow = (w, ent) => confidenceAfter(w, ent, w.status === 'practice' ? endedSessions(w).length : sessionsOf(w));

/* The timesheet when a session ends. Players' cars use their runs; the rest run a normal programme. */
function sessionTimes(w, n, rec) {
  const track = F1.track(w.trackId), circuit = FormulaRacingAdapter.toCircuit(track), teams = F1.teams().map(t => f1EffectiveTeam(t)), ents = f1Entrants();
  const entries = FormulaRacingAdapter.toEntries(ents.map(e => e.v3), teams, track, {}), out = {};
  ents.forEach((e, i) => {
    const en = entries[i], r = RaceEngine.rng(h32(w.seed, 'fp', n, e.id));
    if (playerRun(w, e)) { const rs = runsIn(w, e.id, n).map(x => f1RunResult(w, e, x)), laps = rs.filter(x => x.lap && !x.compound).map(x => x.lap);
      const longs = rs.filter(x => x.compound && x.lap).map(x => x.lap + 1.5);
      const best = Math.min(...laps.concat(longs)); out[e.id] = isFinite(best) ? Math.round(best * 1000) / 1000 : null; return; }
    /* Long runs early in the weekend; the last session ends with low-fuel qualifying runs, like the players' qualifying simulations. */
    if (rec) { const t = aiSessionLap(w, n, e, en, rec); out[e.id] = t == null ? null : Math.round(t * 1000) / 1000; return; }
    const prog = n === sessionsOf(w) ? -RaceEngine.DEFAULTS.fuelEffect - 0.2 : n === 2 ? 0.55 : 0.85;
    out[e.id] = Math.round((f1Lap(circuit, en, f1AiSetup(F1.team(e.teamId))) + prog + f1Gauss(r) * 0.22) * 1000) / 1000;
  });
  return out;
}
ACTIONS['fp-end'] = () => {
  const w = F1.live(); if (!w || w.status !== 'practice') return;
  const n = curSession(w), done = endedSessions(w).length; if (done >= sessionsOf(w)) { toast('Practice is over: run qualifying.', true); return; }
  run(async () => {
    const doc = clone(S.store.f1_weekends[w.id]);
    let rec = { n };
    if (fullPractice(w)) { rec = simulateSession(w, n); S._fpRec = Object.assign(rec, { wid: w.id }); }
    rec.times = sessionTimes(w, n, fullPractice(w) ? rec : null); rec.endedAt = nowIso(); delete S._fpRec; delete rec.wid;
    doc.practice = { session: Math.min(sessionsOf(w), n + 1), done: (done ? doc.practice.done : []).concat([rec]) };
    await Data.put('f1_weekends', w.id, doc);
    await Data.audit('f1.practice', `${sessionName(w, n)} ended`);
  }, n < sessionsOf(w) ? `${sessionName(w, n)} is over: timesheet and debriefs are out. ${sessionName(w, n + 1)} is open.` : 'Practice is over: timesheet and debriefs are out. Run qualifying when you’re ready.');
};
function timesheetHtml(w, s) {
  const rows = Object.keys(s.times).map(id => ({ id, t: s.times[id] })).sort((a, b) => (a.t || 999) - (b.t || 999)), best = rows[0] && rows[0].t;
  const ents = w.entrants || f1Entrants();
  return `${sessionReportHtml(w, s)}<table class="data compact timing"><thead><tr><th>P</th><th>Driver</th><th class="num">Best</th><th class="num">Gap</th></tr></thead><tbody>${rows.map((x, i) => { const e = ents.find(z => z.id === x.id) || {};
    return `<tr class="${e.charId ? 'me' : ''}"><td>${x.t ? i + 1 : ''}</td><td><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span>${esc(e.name || x.id)}${e.charId ? ' <span class="tag player">Player</span>' : ''}</td>
      <td class="num">${x.t ? f1Fmt(x.t) : '<span class="muted">No time</span>'}</td><td class="num">${x.t && i ? '+' + (x.t - best).toFixed(3) : ''}</td></tr>`; }).join('')}</tbody></table>`;
}

/* ---------------------------------------------------------------- the set-up guide */
const fuzz = (v, r, sd) => clampN(Math.round((v + f1Gauss(r) * sd) / 5) * 5, 0, 100);
function setupGuideHtml(w, ent, ro) {
  const t = F1.track(w.trackId) || {}, base = TYPE_IDEAL[t.type] || TYPE_IDEAL.mixed, st = styleOf(ent), pref = STYLE_PREF[st] || STYLE_PREF.technical;
  const done = endedSessions(w).length, exp = (ent.v3 && ent.v3.experience) || 50, rap = f1Rapport(ent.teamId, ent.car);
  /* The engineer's error is fixed for the weekend and shrinks each session, so the guess closes in steadily. */
  const sd = Math.max(3, 14 - done * 3 - exp / 20 - rap * 1.5), r = RaceEngine.rng(h32(w.seed, ent.id, 'guide')), ideal = f1IdealFor(w, ent);
  const guess = { wing: fuzz(ideal.wing, r, sd), susp: fuzz(ideal.susp, r, sd), diff: fuzz(ideal.diff, r, sd) };
  const dir = (v, lo, hi) => v > 3 ? hi : v < -3 ? lo : 'about the same';
  return `<details class="guide"><summary><b>Set-up guide</b> <span class="muted small">engineer’s best guess: downforce ${guess.wing}, suspension ${guess.susp}, diff ${guess.diff}</span></summary>
    <p><b>${esc(t.name || '')}:</b> ${esc(TYPE_TEXT[t.type] || TYPE_TEXT.mixed)} <span class="muted small">Teams usually start around downforce ${base.wing}, suspension ${base.susp}.</span></p>
    <p><b>${esc(ent.name)} (${esc(styleName(st).toLowerCase())}):</b> likes ${esc(pref.likes)}. Can’t stand ${esc(pref.hates)}. Against a typical driver: downforce ${dir(pref.wing, 'lower', 'higher')}, suspension ${dir(pref.susp, 'softer', 'stiffer')}, diff ${dir(pref.diff, 'more open', 'more locked')}.</p>
    <p><b>Engineer’s best guess${done ? ` after ${sessionName(w, done)}` : ''}:</b> downforce ${guess.wing}, suspension ${guess.susp}, differential ${guess.diff}. <span class="muted small">Within about ±${Math.round(sd * 1.5 / 5) * 5 || 5} on each; it sharpens with every session${rap ? ', and rapport helps' : ''}.</span></p>
    </details>${ro ? '' : `<div class="guide-use"><button class="btn small" data-act="guide-use" data-car="${esc(ent.id)}" data-wing="${guess.wing}" data-susp="${guess.susp}" data-diff="${guess.diff}">Put the engineer’s guess on the dials</button></div>`}`;
}
ACTIONS['guide-use'] = d => { const f = (S.ui.form.f1d = S.ui.form.f1d || {}); f[d.car] = { wing: Number(d.wing), susp: Number(d.susp), diff: Number(d.diff) }; render(); };

/* ---------------------------------------------------------------- debriefs */
function sessionDebriefHtml(w, ent, s) {
  const n = s.n, runs = runsIn(w, ent.id, n), rows = Object.keys(s.times).filter(id => s.times[id]).sort((a, b) => s.times[a] - s.times[b]);
  const pos = rows.indexOf(ent.id) + 1, gap = pos > 1 ? s.times[ent.id] - s.times[rows[0]] : 0;
  const lost = runs.filter(r => (runContext(w, r) || {}).lost), crashed = (s.crashes || []).indexOf(ent.id) !== -1, failed = (s.failures || []).indexOf(ent.id) !== -1;
  const wxLine = s.weather ? ` ${weatherText(s.weather)}` : '';
  if (!runs.length) return `<li><b>${sessionName(w, n)}:</b>${esc(wxLine)} The car didn’t run. No set-up work, no time, and no confidence gained.</li>`;
  if (lost.length === runs.length) return `<li><b>${sessionName(w, n)}:</b>${esc(wxLine)} ${crashed ? 'The car crashed' : failed ? 'A mechanical problem stopped the car' : 'A red flag cost the running'}, and every planned run was lost. ${crashed ? 'Confidence took a knock.' : 'No confidence gained.'}</li>`;
  const b = bestSetupIn(w, ent, runs), ideal = f1IdealFor(w, ent), st = styleOf(ent), pref = STYLE_PREF[st] || STYLE_PREF.technical;
  const before = Math.round(confidenceAfter(w, ent, n - 1) * 100), after = Math.round(confidenceAfter(w, ent, n) * 100);
  const notes = [];
  if (s.weather && (s.weather.start !== 'dry' || s.weather.change)) notes.push(weatherText(s.weather) + ' Wet running tells you less about the dry set-up.');
  if (lost.length) notes.push(`${plural(lost.length, 'run')} lost: ${lost.map(r => runContext(w, r).lost.toLowerCase().replace(/\.$/, '')).join('; ')}.`);
  if (crashed) notes.push('The crash knocked the driver’s confidence and costs £0.4m in repairs.');
  if (b) {
    const r = RaceEngine.rng(h32(w.seed, ent.id, 'debrief', n)), noise = (2 + (100 - ((ent.v3 && ent.v3.experience) || 50)) / 12) * rapportNoise(f1Rapport(ent.teamId, ent.car));
    const errs = DIALS.map(([k, label], i) => ({ k, label, d: (Number(b.r.dials[k]) || 50) - ideal[k] + f1Gauss(r) * noise, wgt: [0.5, 0.4, 0.3][i] })).sort((x, y) => Math.abs(y.d) * y.wgt - Math.abs(x.d) * x.wgt);
    notes.push(b.q >= 88 ? `The set-up is very close to what ${ent.name.split(' ')[0]} wants.` : b.q >= 75 ? 'The set-up is getting there.' : 'The set-up is still some way off.');
    const top = errs[0];
    if (Math.abs(top.d) >= 5) notes.push(`Biggest gain: ${NOTES[top.k][top.d > 0 ? 0 : 1](top.d)}`);
    if (b.q < 80 && Math.abs(top.d) >= 5) notes.push(`${ent.name.split(' ')[0]} likes ${pref.likes.split(':')[0]}; this car isn’t there yet.`);
  } else notes.push('No set-up runs this session, so there’s nothing new on the set-up.');
  const did = k => f1Runs(w, ent.id).some(x => x.kind === k && (x.session || 1) <= n);
  if (n < sessionsOf(w)) { if (!did('long')) notes.push(`Next: a long run, to learn the tyres for the race plans.`); else if (!did('quali') && n === sessionsOf(w) - 1) notes.push('Next: a qualifying simulation in the last session.'); }
  return `<li><b>${sessionName(w, n)}:</b> ${pos ? `P${pos}${gap ? `, +${gap.toFixed(3)}` : ', fastest'}` : 'no representative time'}. Confidence ${before}% to <b>${after}%</b>.<ul>${notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul></li>`;
}
function practiceDebriefsHtml(w, ent) {
  const done = endedSessions(w); if (!done.length) return '';
  const rev = done.slice().reverse();
  return `<div class="debriefs"><h4>Debrief</h4><ul class="runs">${sessionDebriefHtml(w, ent, rev[0])}</ul>${rev.length > 1 ? `<details><summary>Earlier debriefs</summary><ul class="runs">${rev.slice(1).map(s => sessionDebriefHtml(w, ent, s)).join('')}</ul></details>` : ''}
    <p class="muted small">Confidence at this circuit is worth up to ${CONF_MAX.toFixed(1)}s a lap in qualifying and the race. It builds with every session the car runs, more when the set-up suits the driver.</p></div>`;
}
/* After qualifying: where the time went, and what it means for the race. */
function qualiDebriefHtml(w, ent) {
  if (!w.quali || !w.quali.results) return '';
  const res = w.quali.results, best = r => { const t = (r.times || []).filter(Boolean); return t.length ? Math.min(...t) : null; };
  const me = res.find(r => r.id === ent.id); if (!me || !best(me)) return '';
  const all = res.map(r => ({ id: r.id, t: best(r) })).filter(x => x.t).sort((a, b) => a.t - b.t), pole = all[0].t, pos = (w.state && w.state.cars.find(c => c.id === ent.id) ? (w.quali.grid || []).indexOf(ent.id) + 1 : all.findIndex(x => x.id === ent.id) + 1);
  const q = (w.setup && w.setup[ent.id]) || f1AiSetup(F1.team(ent.teamId)), conf = (w.confidence && w.confidence[ent.id] != null) ? w.confidence[ent.id] : confidenceNow(w, ent);
  const setupLoss = (95 - q) * F1_RULES.setupCoef, confLoss = CONF_MAX * (1 - conf), mine = best(me), better = mine - setupLoss - confLoss;
  const could = all.filter(x => x.id !== ent.id && x.t < better).length + 1;
  const knowsTyres = f1Runs(w, ent.id).some(x => x.kind === 'long');
  const pen = w.penalties && w.penalties[ent.id];
  return `<div class="debriefs"><h4>Qualifying debrief</h4><ul class="runs"><li><b>P${pos}</b>${mine > pole ? `, ${(mine - pole).toFixed(3)}s off pole` : ', pole position'}.${pen ? ` Starts ${pen.places} places further back: ${esc(pen.reason)}.` : ''}<ul>
    <li>Set-up: ${({ locked: 'the dials chosen for qualifying', practice: 'the latest set-up run from practice', previous: 'the set-up carried over from last time' })[(w.setupSource || {})[ent.id]] || 'a standard set-up'}, quality ${q} of 95, costing about ${setupLoss.toFixed(2)}s a lap against a perfect one.</li>
    <li>Confidence: ${Math.round(conf * 100)}%, costing about ${confLoss.toFixed(2)}s a lap against full confidence.</li>
    ${setupLoss + confLoss > 0.05 && could < pos ? `<li>With both perfect, that lap was worth about P${could}.</li>` : ''}
    <li>For the race: the set-up stays as it is. ${knowsTyres ? 'Your long runs have measured the tyres: check the race plans against them.' : 'Nobody measured the tyres in practice, so the race plans work from rough tyre life: leave some margin.'}</li></ul></li></ul></div>`;
}

/* =====================================================================
   F1 SIM — full practice sessions.
   In a full race weekend, practice runs like qualifying: teams plan
   their runs for the coming session, then Race Control runs it. Each
   session has its own weather, drawn from the weekend's forecast (dry,
   damp or wet, and rain can arrive or clear halfway through), and its
   own chaos: red flags that cut runs short, crashes (likelier in the wet,
   for inexperienced drivers and on qualifying simulations) and
   mechanical failures (from the team's reliability). Race Control's
   safety-car and failure settings scale them. Nobody sees a run's
   result until its session has run.
   Quick practice (results straight away, always dry) stays available
   for any weekend, and the Test Track keeps its fixed conditions.
   ===================================================================== */
'use strict';

const WET_PEN = { dry: 0, damp: 4.5, wet: 9 };
const PRACTICE_REPAIR = 0.4;   // £m for a practice crash
const fullPractice = w => !!w && !w.test && raceSettings(w).practice === 'full';
const condName = c => c === 'wet' ? 'wet' : c === 'damp' ? 'damp' : 'dry';

/* Chance of rain in a session, from the weekend's weather and Race Control's rain setting. */
function sessionRainChance(w) {
  const s = raceSettings(w), t = F1.track(w.trackId) || {};
  if (w.weatherMode === 'dry') return 0; if (w.weatherMode === 'wet') return 0.75; if (w.weatherMode === 'mid') return 0.5;
  return s.rainPct !== 'track' && s.rainPct != null ? Number(s.rainPct) / 100 : (t.wr || 0) * 0.6 / 100;
}
function sessionWeather(w, n) {
  const r = RaceEngine.rng(h32(w.seed, 'fpwx', n)), p = sessionRainChance(w);
  if (r() >= p) return { start: 'dry', change: null };
  const heavy = r() < 0.4 ? 'wet' : 'damp';
  if (r() < 0.5) return { start: heavy, change: r() < 0.4 ? { at: 0.5, to: 'dry' } : null };
  return { start: 'dry', change: { at: 0.5, to: heavy } };
}
const condAt = (wx, frac) => wx.change && frac >= wx.change.at ? wx.change.to : wx.start;
function weatherText(wx) {
  if (!wx.change) return wx.start === 'dry' ? 'Dry throughout.' : `${condName(wx.start).replace(/^./, c => c.toUpperCase())} throughout.`;
  return wx.change.to === 'dry' ? `Started ${condName(wx.start)}, dried out halfway through.` : `Started dry; rain arrived halfway through and the track went ${condName(wx.change.to)}.`;
}

/* Run the session: who loses which runs, and why. */
function simulateSession(w, n) {
  const st = raceSettings(w), wx = sessionWeather(w, n), r = RaceEngine.rng(h32(w.seed, 'fpsim', n)), per = runsPerSession(w);
  const rec = { n, weather: wx, events: [], lost: {}, cond: {}, crashes: [], failures: [], redFlag: null };
  const wetty = wx.start !== 'dry' || !!wx.change;
  const redAt = r() < 0.22 * st.scRate * (wetty ? 1.6 : 1) ? (r() < 0.5 ? 0 : 1) : null;
  f1Entrants().forEach(e => {
    const runs = playerRun(w, e) ? runsIn(w, e.id, n) : null, slots = runs ? runs.length : per, team = F1.team(e.teamId);
    const exp = (e.v3 && e.v3.experience) || 50; let out = null;
    for (let i = 0; i < slots; i++) {
      const id = runs ? runs[i].id : null, cond = condAt(wx, (i + 0.5) / per);
      if (id) rec.cond[id] = cond;
      if (out) { if (id) rec.lost[id] = out; continue; }
      if (r() < 0.003 * st.failRate * (1 + (95 - (team.reliability || 90)) / 10)) {
        out = 'A mechanical problem ended the session early.'; rec.failures.push(e.id); rec.events.push({ slot: i, ids: [e.id], text: `${e.name} stops on track with a mechanical problem.` }); if (id) rec.lost[id] = out; continue; }
      const quali = runs && runs[i].kind === 'quali';
      if (r() < 0.006 * st.scRate * (cond === 'wet' ? 3 : cond === 'damp' ? 2 : 1) * (1 + (60 - exp) / 100) * (quali ? 1.5 : 1)) {
        out = 'Crashed. The car couldn’t be repaired in time.'; rec.crashes.push(e.id); rec.events.push({ slot: i, ids: [e.id], text: `${e.name} crashes${cond !== 'dry' ? ' in the ' + condName(cond) : ''}. Red flag.` }); if (id) rec.lost[id] = 'Crashed. The car needed repairs.'; continue; }
      if (redAt === i && r() < 0.4 && id) rec.lost[id] = 'Cut short by a red flag.';
    }
  });
  if (redAt != null) { rec.redFlag = redAt; rec.events.push({ slot: redAt, ids: [], text: 'Red flag: debris on the track. Some teams lose their run.' }); }
  if (wx.change) rec.events.push({ slot: wx.change.at * per, ids: [], text: wx.change.to === 'dry' ? 'The track starts to dry.' : 'Rain arrives.' });
  rec.events.sort((a, b) => a.slot - b.slot);
  return rec;
}
/* A run's context: not run yet, lost, or the conditions it ran in. */
function runContext(w, run) {
  if (!fullPractice(w)) return null;
  const rec = (S._fpRec && S._fpRec.n === (run.session || 1) && S._fpRec.wid === w.id) ? S._fpRec : endedSessions(w).find(s => s.n === (run.session || 1));
  if (!rec || !rec.weather) return { pending: true };
  if (rec.lost && rec.lost[run.id]) return { lost: rec.lost[run.id] };
  return { cond: (rec.cond && rec.cond[run.id]) || 'dry' };
}
/* Lap times for cars nobody plays: their programme in the session's conditions, minus what they lost. */
function aiSessionLap(w, n, e, entry, rec) {
  if (!rec.weather) return null;
  const per = runsPerSession(w), circuit = FormulaRacingAdapter.toCircuit(F1.track(w.trackId)), r = RaceEngine.rng(h32(w.seed, 'fp', n, e.id));
  const failed = rec.failures.indexOf(e.id) !== -1 || rec.crashes.indexOf(e.id) !== -1, last = n === sessionsOf(w);
  let best = null;
  for (let i = 0; i < per; i++) {
    if (failed && i > 0) break;
    const cond = condAt(rec.weather, (i + 0.5) / per), prog = last && i === per - 1 ? -RaceEngine.DEFAULTS.fuelEffect - 0.2 : (n === 2 ? 0.55 : 0.85);
    const t = f1Lap(circuit, entry, f1AiSetup(F1.team(e.teamId))) + prog + WET_PEN[cond] + f1Gauss(r) * 0.22;
    best = best == null ? t : Math.min(best, t);
  }
  return best;
}
ACTIONS['run-cancel'] = d => {
  const r = get('f1_runs', d.id), w = F1.live(); if (!r || !w) return;
  if (!(runContext(w, r) || {}).pending) { toast('That run has already happened.', true); return; }
  run(async () => { await Data.remove('f1_runs', r.id); }, 'Run taken off the plan.');
};
function sessionReportHtml(w, s) {
  if (!s.weather) return '';
  return `<p><b>Conditions:</b> ${esc(weatherText(s.weather))}</p>${s.events.length ? `<ul class="fp-events">${s.events.map(e => `<li>${esc(e.text)}</li>`).join('')}</ul>` : '<p class="muted small">A clean session.</p>'}`;
}
function practiceForecastText(w) {
  const p = Math.round(sessionRainChance(w) * 100);
  return p ? `${p}% chance of rain in each session.` : 'Dry sessions expected.';
}

/* =====================================================================
   F1 SIM — the Race Weekend page, streamlined, and sensible defaults.
   Nobody has to lock anything in. A car's qualifying set-up is, in order:
   the dials someone chose for qualifying, the latest set-up run this
   weekend, the set-up it raced last time (scored against what this
   circuit and driver need), or a standard set-up. Its race plans are the
   plans saved this weekend, the plans from its last race (rescaled to
   this race's length), or the team's own preset.
   The page leads with what's happening and what each of your cars will
   use, then tabs: Set-up (or the qualifying debrief), Race plan, Timing
   and Entry list. A team principal switches between their two cars.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------- defaults: set-up */
function lastSetupRun(w, carId) {
  return f1Runs(w, carId).filter(r => r.kind === 'setup' && r.dials).filter(r => { const x = runContext(w, r); return !x || x.cond; }).pop() || null;
}
/* The same car (team and car number) at earlier weekends of this series, newest first. */
function earlierSameCar(w, ent) {
  return list('f1_weekends').filter(x => x.id !== w.id && wSeries(x) === wSeries(w) && String(x.createdAt) < String(w.createdAt) && x.entrants)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(x => ({ w: x, e: x.entrants.find(z => z.teamId === ent.teamId && z.car === ent.car) })).filter(x => x.e);
}
function setupChoice(w, ent) {
  const call = f1Calls(w).filter(c => c.type === 'setup' && c.carId === ent.id && c.value && typeof c.value === 'object' && f1CallAllowed(c, w)).pop();
  if (call) return { dials: call.value, source: 'locked', by: call.charId, text: `Chosen for qualifying: ${dialText(call.value)}.` };
  const run = lastSetupRun(w, ent.id);
  if (run) return { dials: run.dials, source: 'practice', by: run.charId, text: `Your latest set-up run: ${dialText(run.dials)}.` };
  for (const x of earlierSameCar(w, ent)) {
    const d = (x.w.setupDials || {})[x.e.id] || (lastSetupRun(x.w, x.e.id) || {}).dials;
    if (d) return { dials: d, source: 'previous', by: null, text: `The set-up from ${(get('f1_tracks', x.w.trackId) || {}).name || 'last time'}: ${dialText(d)}. It may not suit this circuit.` };
  }
  return null;
}
function setupChoiceText(w, ent) { const c = setupChoice(w, ent); return c ? c.text : 'A standard set-up: nobody has run this car yet.'; }

/* ---------------------------------------------------------------- defaults: race plans */
function prevPlanDoc(w, ent) {
  const N = raceLaps(w);
  for (const x of earlierSameCar(w, ent)) {
    const doc = f1Plan(x.w, x.e); if (!doc) continue;
    const oldN = x.w.state ? x.w.state.laps : raceLaps(x.w), k = N / Math.max(1, oldN), sc = v => v ? Math.max(2, Math.min(N - 1, Math.round(v * k))) : v;
    return { plans: doc.plans.map(p => Object.assign({}, clone(p), { stops: (p.stops || []).map(s => ({ lap: sc(s.lap), compound: s.compound })) })),
      active: doc.active || 0, triggers: (doc.triggers || []).map(t => Object.assign({}, t, { from: sc(t.from), to: sc(t.to) })), approach: doc.approach, preset: doc.preset,
      isPrevious: true, from: (get('f1_tracks', x.w.trackId) || {}).name || 'the last race' };
  }
  return null;
}
const planDocFor = (w, ent) => f1Plan(w, ent) || (teamHasPlayers(ent.teamId) ? (prevPlanDoc(w, ent) || defaultPlanDoc(w, ent)) : null);
function planSourceText(w, ent) {
  const doc = f1Plan(w, ent); if (doc) { const by = get('characters', doc.charId); return `Saved by ${by ? by.name : 'the team'}: ${PLAN_NAMES[doc.active || 0]} to start, ${approachLabel(doc.approach).toLowerCase()} approach.`; }
  const p = prevPlanDoc(w, ent); if (p) return `Not saved this weekend, so the plans from ${p.from} carry over, resized to this race.`;
  return `Not saved, so the team’s own preset and ${ent.name.split(' ')[0]}’s natural approach.`;
}

/* ---------------------------------------------------------------- the page */
function myWeekendCars(w) {
  if (!S.charId) return [];
  const seats = f1MySeats(); if (!seats.length) return [];
  return (w.entrants || f1Entrants()).filter(e => seats.some(s => s.teamId === e.teamId && (s.role === 'principal' || s.car === e.car)));
}
ACTIONS['wk-car'] = d => { S.ui.wkCar = d.id; render(); };
ACTIONS['wk-tab'] = d => { S.ui.wkTab = d.tab; S.ui.wkTabFor = d.status; render(); };
function stageLine(w) {
  const st = w.state;
  if (w.status === 'practice') { const done = endedSessions(w).length, all = done >= sessionsOf(w);
    return all ? 'Practice is over. Qualifying is next.' : fullPractice(w) ? `${sessionName(w, curSession(w))} is next. Plan up to ${runsPerSession(w)} runs per car before Race Control runs it.` : `${sessionName(w, curSession(w))}: up to ${runsPerSession(w)} runs per car, with results straight away.`; }
  if (w.status === 'quali') return `Qualifying: Q${w.qualiStage || 1} is done.`;
  if (st && st.lap === 0) return 'The grid is set. The race is next.';
  if (st && !st.finished) return `Race: lap ${st.lap} of ${st.laps}.${raceLocked(w) ? ' Plans and triggers are running the cars.' : ''}`;
  return 'Finished.';
}
function nowCardHtml(w, cars) {
  if (!cars.length || w.status === 'finished') return `<section class="card now-card"><p class="now-stage">${esc(stageLine(w))}</p></section>`;
  const before = w.status === 'practice', rows = cars.map(e => {
    const t = F1.team(e.teamId), ent = Object.assign({}, e, { v3: (f1Entrants().find(x => x.id === e.id) || {}).v3 }), car = w.state && w.state.cars.find(c => c.id === e.id);
    const conf = Math.round(confidenceNow(w, ent) * 100), left = before && endedSessions(w).length < sessionsOf(w) ? runsPerSession(w) - runsIn(w, e.id, curSession(w)).length : null;
    return `<tr style="--team:${esc(t.color)}"><td><span class="f1-bar" style="background:${esc(t.color)}"></span><b>${esc(e.name)}</b></td>
      ${before ? `<td>${left != null ? `${plural(left, 'run')} left in ${esc(sessionName(w, curSession(w)))}` : 'Practice done'}<br><span class="muted small">Confidence ${conf}%</span></td>
        <td><span class="muted small">Qualifying set-up</span><br>${esc(setupChoiceText(w, ent))}</td>` : car ? `<td>${car.status === 'running' ? `P${f1Order(w.state).indexOf(car) + 1}` : 'Out'}</td><td><span class="muted small">Grid</span><br>P${(w.quali && w.quali.grid ? w.quali.grid.indexOf(e.id) + 1 : '–')}</td>` : '<td></td><td></td>'}
      <td><span class="muted small">Race plans</span><br>${esc(w.state && w.state.lap > 0 && car ? `${car.planName || 'AI strategist'}, ${approachLabel(car.approach).toLowerCase()}` : planSourceText(w, ent))}</td></tr>`;
  }).join('');
  return `<section class="card now-card"><p class="now-stage">${esc(stageLine(w))}</p><div class="scroll-x"><table class="data compact now-table"><tbody>${rows}</tbody></table></div>
    <p class="muted small">Nothing has to be locked in. Anything you don’t set uses the latest set-up run, then the last race’s set-up and plans, then the team’s defaults.</p></section>`;
}
function carPickerHtml(cars) {
  if (cars.length < 2) return '';
  const cur = S.ui.wkCar && cars.some(e => e.id === S.ui.wkCar) ? S.ui.wkCar : cars[0].id;
  return `<div class="car-pick" role="tablist" aria-label="Car">${cars.map(e => `<button role="tab" class="pill" data-act="wk-car" data-id="${esc(e.id)}" aria-selected="${e.id === cur}" style="--team:${esc(F1.team(e.teamId).color)}">${esc(e.name)}</button>`).join('')}</div>`;
}
function timingHtml(w) {
  const st = w.state, done = endedSessions(w);
  if (!st) {
    if (!done.length) return '<section class="card"><p class="muted">No session has run yet. Timesheets appear here after each practice session.</p></section>';
    const last = done[done.length - 1];
    return `<section class="card"><h2>${esc(sessionName(w, last.n))} timesheet</h2><div class="scroll-x">${timesheetHtml(w, last)}</div>${done.length > 1 ? `<details><summary>Earlier sessions</summary>${done.slice(0, -1).reverse().map(s => `<h4>${esc(sessionName(w, s.n))}</h4><div class="scroll-x">${timesheetHtml(w, s)}</div>`).join('')}</details>` : ''}</section>`;
  }
  const racing = st.lap > 0, tab = S.ui.f1tab && (racing || S.ui.f1tab === 'feed') ? S.ui.f1tab : 'feed';
  const tabs = [['feed', 'Race log'], ['lapchart', 'Lap chart'], ['tyres', 'Tyre strategy'], ['driver', S.ui.f1pick ? `Driver: ${S.ui.f1pick}` : 'Driver']].filter(x => racing || x[0] === 'feed');
  const body = tab === 'lapchart' ? lvLapChartHtml(w) : tab === 'tyres' ? f1ChartHtml(w) : tab === 'driver' ? lvDriverHtml(w) : lvFeedHtml(w);
  return `<div class="f1-main"><section class="card"><h2>${racing ? 'Timing' : w.status === 'quali' ? `Qualifying: Q${w.qualiStage || 1}` : 'Qualifying'}</h2><div class="scroll-x">${lvTowerHtml(w)}</div></section>
    <section class="card"><div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="tab" data-act="f1-tab" data-tab="${k}" aria-selected="${tab === k}">${esc(l)}</button>`).join('')}</div>${body}</section></div>`;
}
function entryListHtml(w) {
  const ents = w.entrants || f1Entrants();
  return `<section class="card"><h2>Entry list</h2><div class="scroll-x"><table class="data"><thead><tr><th>Car</th><th>Driver</th><th>Team</th></tr></thead><tbody>${ents.map(e => `<tr><td><b>${esc(e.id)}</b></td><td>${careerLink(e.personId, e.name)}${e.charId ? ' <span class="tag player">Player</span>' : ''}</td><td><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span>${esc(F1.team(e.teamId).name)}</td></tr>`).join('')}</tbody></table></div>
    ${w.entrants ? '' : '<p class="muted small">The entry list is fixed when qualifying runs; seat changes after that apply from the next weekend.</p>'}</section>`;
}

const _weekendView = ROUTES.weekend.view;
ROUTES.weekend.view = function () {
  const view = S.ui.f1view ? get('f1_weekends', S.ui.f1view) : null, w = view || F1.live();
  if (!w || w.status === 'finished' || view || !F1.teams().length) return _weekendView();
  const t = F1.track(w.trackId) || { name: w.trackId, laps: 0 }, st = w.state, sprint = w.session === 'sprint', laps = st ? st.laps : raceLaps(w);
  const lapLbl = w.status === 'practice' ? (endedSessions(w).length >= sessionsOf(w) ? 'Done' : sessionName(w, curSession(w))) : w.status === 'quali' ? 'Qualifying' : st.lap === 0 ? 'Grid set' : (w.live ? 'Live, lap' : 'Lap');
  const right = `<div class="f1-lap ${w.live ? 'live' : ''}" aria-live="polite"><small>${w.status === 'practice' ? 'Practice' : lapLbl}</small>${st && w.status !== 'quali' ? `${st.lap}<span class="of">/${laps}</span>` : w.status === 'quali' ? `Q${w.qualiStage || 1}` : esc(lapLbl)}</div>`;
  const track = st ? st.track[Math.max(0, st.lap - 1)] : 0;
  const chips = st && st.lap ? `<p class="chips"><span class="tag ${track === 2 ? 'wet' : track === 1 ? 'damp' : ''}">${['Dry', 'Damp', 'Wet'][track]} track</span>${st.sc.type ? ` <span class="tag flag">${st.sc.type === 'sc' ? 'Safety car' : 'Virtual safety car'}</span>` : ''}</p>` : '';
  let h = `<div class="page-head"><div><p class="eyebrow">${w.session === 'test' ? 'Pre-season testing' : `Round ${esc(t.round || '')}${sprint ? ', sprint' : ''}`}</p><h1>${esc(t.flag || '')} ${esc(t.name)}${sprint ? ' Sprint' : w.session === 'test' ? ' testing' : ''}</h1><p>${esc(t.circuit || '')}, ${laps} laps. ${esc(forecastText(w))}</p>${chips}</div>${right}</div>`;
  h += lvStagesHtml(w);
  if (S.isGm) h += lvControlHtml(w) || '';
  const cars = myWeekendCars(w);
  h += f1MomentCardHtml(w) + nowCardHtml(w, cars);
  const before = w.status === 'practice', racing = st && st.lap > 0;
  const tabs = cars.length ? (before ? [['setup', 'Set-up'], ['plan', 'Race plan'], ['timing', 'Timing'], ['entry', 'Entry list']]
    : racing ? (raceLocked(w) ? [['timing', 'Timing'], ['wall', 'Your cars'], ['plan', 'Race plan']] : [['wall', 'Pit wall'], ['timing', 'Timing'], ['plan', 'Race plan']])
    : [['debrief', 'Qualifying debrief'], ['plan', 'Race plan'], ['timing', 'Timing'], ['entry', 'Entry list']])
    : [['timing', 'Timing'], ['entry', 'Entry list']];
  const tab = S.ui.wkTab && S.ui.wkTabFor === w.status + (racing ? 'r' : '') && tabs.some(x => x[0] === S.ui.wkTab) ? S.ui.wkTab : tabs[0][0];
  h += `<div class="tabs wk-tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="tab" data-act="wk-tab" data-tab="${k}" data-status="${esc(w.status + (racing ? 'r' : ''))}" aria-selected="${tab === k}">${esc(l)}</button>`).join('')}</div>`;
  const picker = ['setup', 'plan', 'wall', 'debrief'].indexOf(tab) !== -1 ? carPickerHtml(cars) : '';
  S.ui.wkCarNow = cars.length > 1 ? (S.ui.wkCar && cars.some(e => e.id === S.ui.wkCar) ? S.ui.wkCar : cars[0].id) : null;
  if (tab === 'setup' || tab === 'wall') h += picker + (f1PitWallHtml(w) || '<section class="card"><p class="muted">Nothing to do on this car right now.</p></section>');
  else if (tab === 'debrief') h += picker + cars.filter(e => !S.ui.wkCarNow || e.id === S.ui.wkCarNow).map(e => `<section class="card" style="--team:${esc(F1.team(e.teamId).color)}"><h2>${esc(e.name)}</h2>${qualiDebriefHtml(w, Object.assign({}, e, { v3: (f1Entrants().find(x => x.id === e.id) || {}).v3 })) || '<p class="muted">The debrief comes when qualifying is over.</p>'}</section>`).join('');
  else if (tab === 'plan') h += picker + (f1StrategyCardHtml(w) || '<section class="card"><p class="muted">Only the team principal, the car’s race engineer and its driver plan its race.</p></section>');
  else if (tab === 'timing') h += timingHtml(w);
  else h += entryListHtml(w);
  return h;
};

/* =====================================================================
   F1 SIM — the Race Weekend page, pit-wall layout.
   Three columns, nothing hidden behind tabs: on the left the weekend's
   sessions and what your car will use if you do nothing; in the middle
   the work (set-up, race plan, timing or the entry list, picked from the
   left); on the right the latest debrief and timing, or during the race
   your car and the race log. The big numbers along the top change with
   the stage. People without a seat keep the simpler tabbed page.
   ===================================================================== */
'use strict';

const _weekendTabs = ROUTES.weekend.view;
const pctRain = w => Math.round(sessionRainChance(w) * 100);
const gridPos = (w, id) => (w.quali && w.quali.grid ? w.quali.grid.indexOf(id) + 1 : 0);
function entWithV3(e) { return Object.assign({}, e, { v3: (f1Entrants().find(x => x.id === e.id) || {}).v3 }); }

/* The weekend's sessions, with what each meant (or will mean) for this car. */
function railSessionsHtml(w, ent) {
  const st = w.state, rows = [], done = endedSessions(w), cur = w.status === 'practice' && done.length < sessionsOf(w) ? curSession(w) : 0;
  for (let n = 1; n <= sessionsOf(w); n++) {
    const s = done.find(x => x.n === n), times = s && s.times ? Object.keys(s.times).filter(k => s.times[k]).sort((a, b) => s.times[a] - s.times[b]) : [];
    const pos = ent && times.indexOf(ent.id) + 1;
    rows.push({ label: sessionName(w, n), status: s ? (pos ? `Done, P${pos}` : 'Done') : n === cur ? (fullPractice(w) ? 'Plan now' : 'Running') : w.status === 'practice' ? `${runsPerSession(w)} runs` : 'Skipped', now: n === cur });
  }
  const single = seriesDoc(wSeries(w)).quali === 'single', g = ent ? gridPos(w, ent.id) : 0;
  if (w.session === 'test') return `<ol class="rail-sessions">${rows.map(r => `<li class="${r.now ? 'now' : ''}"><span>${esc(r.label)}</span><span>${esc(r.status)}</span></li>`).join('')}</ol>`;
  rows.push({ label: single ? 'Qualifying' : 'Qualifying', status: w.status === 'practice' ? (single ? 'One session' : 'Q1 to Q3') : w.status === 'quali' ? `Q${w.qualiStage || 1} done` : g ? `Grid P${g}` : 'Done', now: w.status === 'quali' });
  const car = ent && st ? st.cars.find(c => c.id === ent.id) : null, pos = car ? f1Order(st).indexOf(car) + 1 : 0;
  rows.push({ label: 'Race', status: !st || st.lap === 0 ? (raceSettings(w).lock !== false ? 'Official' : 'Live calls') : st.finished ? (car && car.status === 'running' ? `P${pos}` : 'Done') : `Lap ${st.lap}, P${pos || '–'}`, now: !!(st && st.lap > 0) || (w.status === 'grid') });
  return `<ol class="rail-sessions">${rows.map(r => `<li class="${r.now ? 'now' : ''}"><span>${esc(r.label)}</span><span>${esc(r.status)}</span></li>`).join('')}</ol>`;
}
/* The big numbers along the top, for the stage and the car. */
function statStripHtml(w, ent) {
  const st = w.state, cells = [];
  if (w.status === 'practice') {
    const all = endedSessions(w).length >= sessionsOf(w);
    cells.push(['Next', all ? (w.session === 'test' ? 'Done' : seriesDoc(wSeries(w)).quali === 'single' ? 'Quali' : 'Q1') : sessionName(w, curSession(w)), true], ['Rain chance', `${pctRain(w)}%`]);
    if (ent) cells.push(['Runs to plan', all ? '0' : String(runsPerSession(w) - runsIn(w, ent.id, curSession(w)).length)], ['Confidence', `${Math.round(confidenceNow(w, ent) * 100)}%`]);
  } else if (!st || st.lap === 0) {
    cells.push(['Stage', w.status === 'quali' ? `Q${w.qualiStage || 1}` : 'Grid set', true]);
    if (ent) cells.push(['Grid', gridPos(w, ent.id) ? `P${gridPos(w, ent.id)}` : '–'], ['Confidence', `${Math.round(((w.confidence || {})[ent.id] != null ? w.confidence[ent.id] : confidenceNow(w, ent)) * 100)}%`]);
    cells.push(['Laps', String(st ? st.laps : raceLaps(w))]);
  } else {
    const car = ent ? st.cars.find(c => c.id === ent.id) : null;
    cells.push(['Lap', `${st.lap}/${st.laps}`, true]);
    if (car) { const pos = f1Order(st).indexOf(car) + 1;
      cells.push(['Position', car.status === 'running' ? `P${pos}` : 'Out'], ['Tyre', car.status === 'running' ? `${RaceEngine.COMPOUNDS[car.tyre.compound].label} ${car.tyre.age}` : '–'], ['Plan', car.planName ? car.planName.replace('Plan ', '') : 'AI']); }
  }
  return `<div class="stat-strip">${cells.map(([k, v, hi]) => `<div><span>${esc(k)}</span><b class="${hi ? 'hi' : ''}">${esc(v)}</b></div>`).join('')}</div>`;
}
/* A short timesheet: the top eight, plus your cars if they're further down. */
function shortTimesheetHtml(w, s, mine) {
  const ents = w.entrants || f1Entrants(), rows = Object.keys(s.times).filter(k => s.times[k]).sort((a, b) => s.times[a] - s.times[b]), best = s.times[rows[0]];
  const show = rows.filter((id, i) => i < 8 || mine.indexOf(id) !== -1);
  return `<table class="data compact short-times"><tbody>${show.map(id => { const i = rows.indexOf(id), e = ents.find(z => z.id === id) || {};
    return `<tr class="${mine.indexOf(id) !== -1 ? 'me' : ''}"><td>${i + 1}</td><td><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span>${esc(e.name || id)}</td><td class="num">${i ? '+' + (s.times[id] - best).toFixed(3) : f1Fmt(best)}</td></tr>`; }).join('')}</tbody></table>`;
}
function shortQualiHtml(w, mine) {
  const g = (w.quali && w.quali.grid) || [], ents = w.entrants || [], show = g.filter((id, i) => i < 10 || mine.indexOf(id) !== -1);
  return `<table class="data compact short-times"><tbody>${show.map(id => { const e = ents.find(z => z.id === id) || {};
    return `<tr class="${mine.indexOf(id) !== -1 ? 'me' : ''}"><td>${g.indexOf(id) + 1}</td><td><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span>${esc(e.name || id)}</td></tr>`; }).join('')}</tbody></table>`;
}
ACTIONS['wk-view'] = d => { S.ui.wkView = d.view; S.ui.wkViewFor = d.stage; render(); };

ROUTES.weekend.view = function () {
  S.ui.wkRail = false;
  const view = S.ui.f1view ? get('f1_weekends', S.ui.f1view) : null, w = view || F1.live();
  if (!w || w.status === 'finished' || view || !F1.teams().length) return _weekendTabs();
  const cars = myWeekendCars(w); if (!cars.length) return _weekendTabs();
  S.ui.wkRail = true;
  const sel = cars.find(e => e.id === S.ui.wkCar) || cars[0], ent = entWithV3(sel), team = F1.team(sel.teamId), brand = typeof teamBrand === 'function' ? teamBrand(sel.teamId) : {};
  S.ui.wkCarNow = sel.id;
  const t = F1.track(w.trackId) || { name: w.trackId, laps: 0 }, st = w.state, sprint = w.session === 'sprint', racing = !!(st && st.lap > 0);
  const stage = w.status === 'practice' ? 'practice' : racing ? 'race' : 'quali';
  const views = stage === 'practice' ? [['setup', 'Set-up'], ['plan', 'Race plan'], ['timing', 'Full timing'], ['entry', 'Entry list']]
    : stage === 'quali' ? [['timing', 'Qualifying'], ['plan', 'Race plan'], ['entry', 'Entry list']]
    : [['timing', 'Timing'], ['plan', 'Race plan'], ['entry', 'Entry list']];
  const v = S.ui.wkView && S.ui.wkViewFor === stage && views.some(x => x[0] === S.ui.wkView) ? S.ui.wkView : views[0][0];
  const mine = cars.map(e => e.id);

  let h = `<div class="wk-head" style="--team:${esc(team.color)}"><div class="wk-title"><p class="muted">${w.session === 'test' ? `Pre-season testing, ${esc(t.circuit || t.name)}` : `Round ${esc(t.round || '')}, ${esc(t.circuit || t.name)}, ${st ? st.laps : raceLaps(w)} laps${sprint ? ', sprint' : ''}`}</p>
    <h1>${esc(t.flag || '')} ${esc(t.name)}${sprint ? ' Sprint' : w.session === 'test' ? ' testing' : ''}</h1>${exportButtonHtml(w) ? `<div class="wk-actions">${exportButtonHtml(w)}</div>` : ''}${racing ? `<p class="chips"><span class="tag ${st.track[Math.max(0, st.lap - 1)] === 2 ? 'wet' : st.track[Math.max(0, st.lap - 1)] === 1 ? 'damp' : ''}">${['Dry', 'Damp', 'Wet'][st.track[Math.max(0, st.lap - 1)]]} track</span>${st.sc.type ? ` <span class="tag flag">${st.sc.type === 'sc' ? 'Safety car' : 'Virtual safety car'}</span>` : ''}</p>` : ''}</div>
    ${statStripHtml(w, ent)}</div>`;
  if (S.isGm) h += lvControlHtml(w) || '';

  /* Left: the car, the weekend, the defaults, and what to work on. */
  const left = `<aside class="wk-rail" aria-label="Your weekend">
    ${cars.length > 1 ? `<div class="car-pick" role="tablist" aria-label="Car">${cars.map(e => `<button role="tab" class="pill" data-act="wk-car" data-id="${esc(e.id)}" aria-selected="${e.id === sel.id}" style="--team:${esc(F1.team(e.teamId).color)}">${esc(e.name)}</button>`).join('')}</div>` : ''}
    <div class="rail-car">${brand.logo ? `<img src="${esc(brand.logo)}" alt="${esc(team.name)}" class="team-logo">` : ''}<div><b>${esc(sel.name)}</b><span class="muted small">${esc(team.name)}, car ${esc(sel.car)}</span></div></div>
    <h2>Weekend</h2>${railSessionsHtml(w, ent)}
    <h2>Work on</h2><nav class="rail-views" aria-label="Work on">${views.map(([k, l]) => `<button class="${v === k ? 'on' : ''}" aria-current="${v === k ? 'page' : 'false'}" data-act="wk-view" data-view="${k}" data-stage="${stage}">${esc(l)}</button>`).join('')}</nav>
    ${!racing ? `<h2>If you do nothing</h2><dl class="rail-defaults">${stage === 'practice' ? `<div><dt>Qualifying set-up</dt><dd>${esc(setupChoiceText(w, ent))}</dd></div>` : ''}<div><dt>Race plans</dt><dd>${esc(planSourceText(w, ent))}</dd></div></dl>` : ''}
  </aside>`;

  /* Middle: the work. */
  let mid = racing ? f1MomentCardHtml(w) : '';
  if (v === 'setup') mid += f1PitWallHtml(w) || '<section class="card"><p class="muted">Nothing to do on this car right now.</p></section>';
  else if (v === 'plan') mid += f1StrategyCardHtml(w) || '<section class="card"><p class="muted">Only the team principal, the car’s race engineer and its driver plan its race.</p></section>';
  else if (v === 'entry') mid += entryListHtml(w);
  else if (stage === 'race') {
    /* The race: the tower, then the lap chart, tyres or your driver beneath it. The race log is on the right. */
    if (!S.ui.f1pick) S.ui.f1pick = sel.id;
    const tab = ['lapchart', 'tyres', 'driver'].indexOf(S.ui.f1tab) !== -1 ? S.ui.f1tab : 'driver';
    const body = tab === 'lapchart' ? lvLapChartHtml(w) : tab === 'tyres' ? f1ChartHtml(w) : lvDriverHtml(w);
    mid += `<section class="card"><h2>Timing</h2><div class="scroll-x">${lvTowerHtml(w)}</div></section>
      <section class="card"><div class="tabs" role="tablist">${[['driver', `Driver: ${S.ui.f1pick}`], ['lapchart', 'Lap chart'], ['tyres', 'Tyre strategy']].map(([k, l]) => `<button role="tab" class="tab" data-act="f1-tab" data-tab="${k}" aria-selected="${tab === k}">${esc(l)}</button>`).join('')}</div>${body}</section>`;
  } else mid += timingHtml(w);

  /* Right: what the last session said, and the timing; in the race, your car and the race log. */
  let right = '';
  if (stage === 'practice') {
    const done = endedSessions(w), last = done[done.length - 1];
    right += last ? `<section class="card"><h2>${esc(sessionName(w, last.n))} debrief</h2>${last.weather ? `<p class="muted small">${esc(weatherText(last.weather))}</p>` : ''}<ul class="runs">${sessionDebriefHtml(w, ent, last)}</ul>
        ${done.length > 1 ? `<details><summary>Earlier debriefs</summary><ul class="runs">${done.slice(0, -1).reverse().map(s => sessionDebriefHtml(w, ent, s)).join('')}</ul></details>` : ''}</section>
      <section class="card"><h2>${esc(sessionName(w, last.n))} timesheet</h2>${shortTimesheetHtml(w, last, mine)}<button class="linkish small" data-act="wk-view" data-view="timing" data-stage="${stage}">Full timesheet</button></section>`
      : `<section class="card"><h2>Debriefs</h2><p class="muted">After each session, the debrief for ${esc(sel.name.split(' ')[0])}’s car appears here, with the timesheet.</p></section>`;
  } else if (stage === 'quali') {
    right += `<section class="card">${qualiDebriefHtml(w, ent) || `<h2>Qualifying debrief</h2><p class="muted">It comes when qualifying is over.</p>`}</section>`;
    if (w.status === 'grid') right += `<section class="card"><h2>Grid</h2>${shortQualiHtml(w, mine)}</section>`;
  } else {
    const car = st.cars.find(c => c.id === sel.id);
    right += raceLocked(w) ? `<section class="card"><h2>${esc(sel.name)}</h2>${car && car.status === 'running' ? lockedStatusHtml(w, sel, car) : `<p class="muted">Out: ${esc((car || {}).dnf || '')}</p>`}</section>`
      : (f1PitWallHtml(w) || '');
    right += `<section class="card"><h2>Race log</h2><div class="rail-feed">${lvFeedHtml(w)}</div></section>`;
  }
  h += `<div class="wk-cols" style="--team:${esc(team.color)}">${left}<div class="wk-main">${mid}</div><aside class="wk-side" aria-label="Debrief and timing">${right}</aside></div>`;
  return h;
};

/* =====================================================================
   F1 SIM — team branding.
   Each team can have a logo, a banner photo and a car photo. The team
   principal uploads them from Team HQ (their uploads count while they
   hold the seat), or Race Control does (stored on the team itself). The
   newest valid upload for each picture wins. They show on Team HQ, The
   Grid, the Race Weekend page and driver profiles.
   ===================================================================== */
'use strict';

const BRAND_SLOTS = [
  ['logo', 'Team logo', 'Square works best. Shown beside the team’s name.', 512],
  ['banner', 'Banner photo', 'Wide: the garage, the crew, the crowd. Across the top of Team HQ.', 1800],
  ['car', 'Car photo', 'The car in its livery. On Team HQ and The Grid.', 1600]
];
const isTpOf = (teamId, charId) => F1.seats(teamId).some(s => s.role === 'principal' && s.holderCharId === charId) || list('f1_seats').some(s => s.teamId === teamId && s.role === 'principal' && s.holderCharId === charId);
/* The pictures a team shows now: for each, the newest of Race Control's and the current team principal's. */
function teamBrand(teamId) {
  const t = get('f1_teams', teamId) || {}, out = {};
  BRAND_SLOTS.forEach(([slot]) => {
    const cands = [];
    const rc = (t.brand || {})[slot]; if (rc && rc.at) cands.push(rc);
    list('f1_branding').filter(b => b.teamId === teamId && b.slot === slot && isTpOf(teamId, b.charId) && (get('characters', b.charId) || {}).userId === b.userId).forEach(b => cands.push(b));
    const best = cands.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    if (best && best.url) out[slot] = best.url;
  });
  return out;
}
const canBrand = teamId => S.isGm || !!(S.charId && isTpOf(teamId, S.charId));
async function saveBrand(teamId, slot, url) {
  const c = currentChar();
  if (c && isTpOf(teamId, c.id)) { await Data.put('f1_branding', `${teamId}-${slot}-${c.id}`, { userId: asOwner(), charId: c.id, teamId, slot, url, at: nowIso() }); return; }
  if (!S.isGm) throw { message: 'Only the team principal or Race Control can change the team’s pictures.' };
  const doc = clone(S.store.f1_teams[teamId]); doc.brand = Object.assign({}, doc.brand || {}, { [slot]: { url, at: nowIso() } });
  await Data.put('f1_teams', teamId, doc);
}
CHANGES['brand-upload'] = (v, d, el) => {
  const file = el.files && el.files[0], slot = BRAND_SLOTS.find(s => s[0] === d.slot); if (!file || !slot) return;
  if (!/^image\//.test(file.type)) { toast('Choose a picture: a JPEG, PNG or WebP.', true); return; }
  run(async () => {
    const blob = await shrinkImage(file, slot[3]), assets = await window.claude.use('assets'), up = await assets.upload(blob, { type: 'image/jpeg' });
    await saveBrand(d.team, slot[0], up.url);
    await Data.audit('team.brand', `${F1.team(d.team).name}: new ${slot[1].toLowerCase()}`);
  }, `${slot[1]} saved.`);
  el.value = '';
};
ACTIONS['brand-remove'] = d => askConfirm('Remove this picture?', 'Remove', () => run(async () => { await saveBrand(d.team, d.slot, null); }, 'Picture removed.'), true);

function brandingHtml(tid) {
  const b = teamBrand(tid), can = canBrand(tid), t = F1.team(tid);
  return `<section class="card"><h2>Team branding</h2><p class="muted small">${can ? 'Upload the team’s pictures. They show on Team HQ, The Grid, the Race Weekend page and drivers’ profiles.' : `${esc(t.name)}’s team principal and Race Control set these.`}</p>
    <div class="brand-slots">${BRAND_SLOTS.map(([slot, label, hint]) => `<div class="brand-slot ${slot}">
      <div class="brand-preview">${b[slot] ? `<img src="${esc(b[slot])}" alt="${esc(t.name)} ${esc(label.toLowerCase())}">` : `<span class="muted small">No ${esc(label.toLowerCase())} yet</span>`}</div>
      <p><b>${esc(label)}</b><br><span class="muted small">${esc(hint)}</span></p>
      ${can ? `<div class="btn-row"><label class="btn small file-btn">${b[slot] ? 'Replace' : 'Upload'}<input type="file" accept="image/*" class="sr-only" data-change="brand-upload" data-team="${esc(tid)}" data-slot="${slot}"></label>${b[slot] ? `<button class="btn small ghost" data-act="brand-remove" data-team="${esc(tid)}" data-slot="${slot}">Remove</button>` : ''}</div>` : ''}</div>`).join('')}</div></section>`;
}
/* Team HQ: the banner across the top, and the branding section. */
const _teamViewBrand = ROUTES.team.view;
ROUTES.team.view = function () {
  const html = _teamViewBrand(), teams = F1.teams(); if (!teams.length) return html;
  const my = S.charId ? F1.seats().find(s => s.holderCharId === S.charId) : null, tid = S.ui.teamId || (my && my.teamId) || teams[0].id, b = teamBrand(tid), t = F1.team(tid);
  const banner = b.banner || b.logo || b.car ? `<div class="team-banner" style="--team:${esc(t.color)}">${b.banner ? `<img class="banner-img" src="${esc(b.banner)}" alt="">` : ''}<div class="team-banner-id">${b.logo ? `<img class="team-logo big" src="${esc(b.logo)}" alt="">` : ''}<span>${esc(t.name)}</span></div>${b.car ? `<img class="car-img" src="${esc(b.car)}" alt="${esc(t.name)} car">` : ''}</div>` : '';
  const inTeam = S.isGm || F1.seats(tid).some(s => S.charId && s.holderCharId === S.charId);
  return banner + html + (inTeam || b.logo || b.banner || b.car ? brandingHtml(tid) : '');
};

/* =====================================================================
   F1 SIM — Characters: the showcase, and each character's own page.
   One page, three views of everyone in the league: Cards (portrait
   cards in team colours), By team (the paddock by series and team, with
   branding and open seats) and Register (a filterable directory with a
   preview). Every name links to the character's page: a banner and
   portrait, then particulars and relationships, their story, diary and
   timeline, and their ratings, trophies and race-by-race record.
   ===================================================================== */
'use strict';

const initialsOf = n => String(n || '').split(/\s+/).filter(Boolean).map(x => x[0]).slice(0, 2).join('').toUpperCase();
const showcaseChars = () => list('characters').filter(c => !c.retired && charApproved(c));
/* A character's seats in every series; the one shown first is in the series being viewed. */
function seatsOfChar(charId) { return list('f1_seats').filter(s => s.holderCharId === charId); }
function primarySeat(charId) { const all = seatsOfChar(charId); return all.find(s => ((get('f1_teams', s.teamId) || {}).seriesId || 'f1') === curSeriesId()) || all[0] || null; }
const seriesOfTeam = teamId => seriesDoc(((get('f1_teams', teamId) || {}).seriesId) || 'f1');
function seasonStandingsFor(seriesId) { return standingsOf(seasonWeekendsOf(seriesId, curSeasonId(seriesId))); }

/* Everything the showcase needs about one character. */
function charInfo(c) {
  const pid = f1PcId(c.id), p = F1.person(pid), seat = primarySeat(c.id), team = seat ? get('f1_teams', seat.teamId) : null, series = team ? seriesOfTeam(team.id) : null;
  const rec = f1Record(pid), gps = rec.filter(x => x.w.session === 'gp'), pts = rec.reduce((a, x) => a + (x.r.points || 0), 0);
  let stats;
  if (c.role === 'driver') stats = [[gps.length, 'Races'], [gps.filter(x => x.r.position && x.r.position <= 3).length, 'Podiums'], [pts, 'Points']];
  else if (c.role === 'principal') { const st = team ? seasonStandingsFor(series.id) : { teams: [] }, i = team ? st.teams.findIndex(x => x.teamId === team.id) : -1;
    stats = [[i >= 0 ? st.teams[i].pts : 0, 'Team points'], [i >= 0 ? 'P' + (i + 1) : '–', 'Team'], [list('f1_projects').filter(x => x.charId === c.id).length, 'Upgrades']]; }
  else if (c.role === 'engineer') stats = [[list('f1_weekends').filter(w => Object.values(w.setupBy || {}).indexOf(c.id) !== -1).length, 'Weekends'], [f1AwardsFor(pid).filter(a => a.key === 'setup').length, 'Set-up awards'], [seat ? f1Rapport(seat.teamId, seat.car) : 0, 'Rapport']];
  else { const posts = list('f1_posts').filter(x => x.charId === c.id);
    stats = [[posts.length, 'Posts'], [posts.filter(x => x.kind === 'interview').length, 'Interviews'], [list('f1_diary').filter(x => x.charId === c.id).length, 'Diary']]; }
  const where = team ? `${team.name}${seat.role !== 'principal' ? `, car ${seat.car}` : ''}` : (c.role === 'media' || c.role === 'paddock' ? 'The paddock' : 'Looking for a seat');
  return { c, pid, p, seat, team, series, where, stats, pts, color: team ? team.color : '#56636F', num: c.role === 'driver' ? (c.number || (p && p.num) || '') : '', years: p ? yearsNow(p) : 0 };
}
const charThumb = (c, size) => c.portraitUrl ? `<img class="ppl-thumb" src="${esc(c.portraitUrl)}" alt="" width="${size}" height="${size}" loading="lazy">` : `<span class="ppl-thumb none" style="width:${size}px;height:${size}px" aria-hidden="true">${esc(initialsOf(c.name))}</span>`;
ACTIONS['ppl-view'] = d => { S.ui.pplView = d.view; render(); };
ACTIONS['ppl-role'] = d => { (S.ui.ppl = S.ui.ppl || {}).role = d.role; render(); };
ACTIONS['ppl-search'] = () => render();
ACTIONS['ppl-sel'] = d => { S.ui.pplSel = d.id; render(); };
ACTIONS['ppl-open'] = d => { S.ui.career = d.id; go('career'); };
ACTIONS['ppl-apply'] = d => { S.series = d.series; lsSet('f1sim.series', d.series); go('grid'); };
const roleGroup = r => r === 'paddock' ? 'media' : r;

function filteredInfos() {
  const f = S.ui.ppl = S.ui.ppl || { role: 'all', series: 'all', sort: 'team', q: '' }, q = String(f.q || '').trim().toLowerCase();
  let rows = showcaseChars().map(charInfo).filter(x => (f.role === 'all' || roleGroup(x.c.role) === f.role) && (f.series === 'all' || (x.series && x.series.id === f.series)) && (!q || (x.c.name + ' ' + x.where + ' ' + charRoleName(x.c.role)).toLowerCase().indexOf(q) !== -1));
  const by = { name: (a, b) => String(a.c.name).localeCompare(String(b.c.name)), points: (a, b) => b.pts - a.pts || String(a.c.name).localeCompare(String(b.c.name)),
    newest: (a, b) => String(b.c.createdAt || '').localeCompare(String(a.c.createdAt || '')),
    team: (a, b) => String(a.series ? a.series.id : 'zz').localeCompare(String(b.series ? b.series.id : 'zz')) || String(a.team ? a.team.order : 99).localeCompare(String(b.team ? b.team.order : 99), undefined, { numeric: true }) || CHAR_ROLES.findIndex(r => r[0] === a.c.role) - CHAR_ROLES.findIndex(r => r[0] === b.c.role) };
  return rows.sort(by[f.sort] || by.team);
}
function cardsHtml() {
  const rows = filteredInfos(), f = S.ui.ppl, roles = [['all', 'Everyone'], ['driver', 'Drivers'], ['principal', 'Team principals'], ['engineer', 'Race engineers'], ['media', 'Media and paddock']];
  return `<div class="ppl-filters" role="search">
      <label class="sr-only" for="ppl-q">Search characters</label><input id="ppl-q" type="search" placeholder="Search by name or team" value="${esc(f.q || '')}" data-bind="ui/ppl/q"><button class="btn" data-act="ppl-search">Search</button>
      <div role="group" aria-label="Role" class="chip-row">${roles.map(([k, l]) => `<button class="chip ${f.role === k ? 'on' : ''}" aria-pressed="${f.role === k}" data-act="ppl-role" data-role="${k}">${l}</button>`).join('')}</div>
      <label class="sr-only" for="ppl-series">Series</label>${sel('ppl-series', 'ui/ppl/series', f.series, [['all', 'Every series']].concat(allSeries().map(s => [s.id, s.name])))}
      <label class="sr-only" for="ppl-sort">Sort</label>${sel('ppl-sort', 'ui/ppl/sort', f.sort, [['team', 'Sort: by team'], ['name', 'Sort: by name'], ['points', 'Sort: most points'], ['newest', 'Sort: newest']])}</div>
    <p class="muted small">${plural(rows.length, 'character')}</p>
    ${rows.length ? `<div class="ppl-cards">${rows.map(x => `<button class="ppl-card" data-act="ppl-open" data-id="${esc(x.pid)}" style="--team:${esc(x.color)}">
      <span class="ppl-photo">${x.c.portraitUrl ? `<img src="${esc(x.c.portraitUrl)}" alt="" loading="lazy">` : `<span class="ppl-init" aria-hidden="true">${esc(initialsOf(x.c.name))}</span>`}${x.num ? `<span class="ppl-num">${esc(x.num)}</span>` : ''}</span>
      <span class="ppl-body"><b class="ppl-name">${esc(x.c.name)}</b><span>${esc(charRoleName(x.c.role))}</span><span class="muted small">${esc(x.where)}${x.series ? `, ${esc(x.series.short)}` : ''}</span>
        <span class="ppl-stats">${x.stats.map(([v, l]) => `<span><b>${esc(v)}</b><span>${esc(l)}</span></span>`).join('')}</span></span></button>`).join('')}</div>`
      : '<div class="empty">Nobody matches. Try another role or series.</div>'}`;
}
function byTeamHtml() {
  const f = S.ui.ppl = S.ui.ppl || { role: 'all', series: 'all', sort: 'team', q: '' }, onlyActive = S.ui.pplActive !== false;
  const series = allSeries().filter(s => f.series === 'all' || s.id === f.series);
  const tile = (seat, team) => { const o = f1Occupant(seat), title = seatTitle(seat);
    if (o.player) { const c = get('characters', o.charId) || { name: o.name };
      return `<button class="ppl-seat player" data-act="ppl-open" data-id="${esc(f1PcId(o.charId))}">${charThumb(c, 44)}<span><span class="muted small">${esc(title)}</span><b>${esc(o.name)}</b></span></button>`; }
    if (seat.open) return `<div class="ppl-seat open"><span class="ppl-thumb none" aria-hidden="true" style="width:44px;height:44px">+</span><span><span class="muted small">${esc(title)}</span><b>Open seat</b><button class="linkish small" data-act="ppl-apply" data-series="${esc(team.seriesId || 'f1')}">Apply for this seat</button></span></div>`;
    return `<div class="ppl-seat other"><span class="ppl-thumb none" aria-hidden="true" style="width:44px;height:44px">${esc(initialsOf(o.name))}</span><span><span class="muted small">${esc(title)}</span><b>${o.person ? careerLink(o.person.id, o.name) : esc(o.name)}</b><span class="muted small">${o.person ? (o.person.fictional ? 'Not a player' : 'Real') : 'Not a player'}</span></span></div>`; };
  let h = `<label class="small ppl-toggle"><input type="checkbox" data-bind="ui/pplActive" ${onlyActive ? 'checked' : ''}> Only teams with players or open seats</label>`;
  series.forEach(s => {
    const teams = list('f1_teams').filter(t => (t.seriesId || 'f1') === s.id).sort((a, b) => (a.order || 0) - (b.order || 0))
      .filter(t => !onlyActive || F1.seats(t.id).some(x => x.holderCharId || x.open));
    if (!teams.length) return;
    h += `<section class="ppl-series"><h2>${esc(s.name)}</h2>${teams.map(t => { const b = teamBrand(t.id);
      return `<article class="ppl-team" style="--team:${esc(t.color)}"><div class="ppl-banner">${b.banner ? `<img src="${esc(b.banner)}" alt="">` : ''}<div class="ppl-team-id">${b.logo ? `<img class="team-logo" src="${esc(b.logo)}" alt="">` : ''}<h3>${esc(t.name)}</h3></div></div>
        <div class="ppl-seats">${F1.seats(t.id).map(x => tile(x, t)).join('')}</div></article>`; }).join('')}</section>`;
  });
  const others = showcaseChars().filter(c => c.role === 'media' || c.role === 'paddock' || !primarySeat(c.id));
  if (others.length) h += `<section class="ppl-series"><h2>Media, paddock and free agents</h2><div class="ppl-seats loose">${others.map(c => `<button class="ppl-seat player" data-act="ppl-open" data-id="${esc(f1PcId(c.id))}">${charThumb(c, 44)}<span><span class="muted small">${esc(charRoleName(c.role))}</span><b>${esc(c.name)}</b></span></button>`).join('')}</div></section>`;
  return h;
}
function registerHtml() {
  const g = S.ui.pplReg = S.ui.pplReg || { r: { driver: true, principal: true, engineer: true, media: true }, s: {}, y: { a: true, b: true, c: true } };
  const yb = n => !n ? 'n' : n <= 2 ? 'a' : n <= 6 ? 'b' : 'c', q = String((S.ui.ppl || {}).q || '').trim().toLowerCase();
  const rows = showcaseChars().map(charInfo).filter(x => g.r[roleGroup(x.c.role)] !== false && (!x.series || g.s[x.series.id] !== false) && (yb(x.years) === 'n' || g.y[yb(x.years)] !== false) && (!q || x.c.name.toLowerCase().indexOf(q) !== -1))
    .sort((a, b) => String(a.c.name).localeCompare(String(b.c.name)));
  const pick = rows.find(x => x.c.id === S.ui.pplSel) || rows[0];
  const cb = (path, on, label) => `<label class="reg-check"><input type="checkbox" data-bind="${path}" ${on !== false ? 'checked' : ''}> ${esc(label)}</label>`;
  const rec = x => x.c.role === 'driver' ? `${x.pts} pts, ${plural(x.stats[1][0], 'podium')}` : `${x.stats[0][0]} ${x.stats[0][1].toLowerCase()}`;
  return `<div class="reg-wrap"><aside class="reg-filters" aria-label="Filters">
      <label class="sr-only" for="ppl-q2">Search the register</label><input id="ppl-q2" type="search" placeholder="Search by name" value="${esc((S.ui.ppl || {}).q || '')}" data-bind="ui/ppl/q"><button class="btn small" data-act="ppl-search">Search</button>
      <fieldset><legend>Role</legend>${cb('ui/pplReg/r/driver', g.r.driver, 'Drivers')}${cb('ui/pplReg/r/principal', g.r.principal, 'Team principals')}${cb('ui/pplReg/r/engineer', g.r.engineer, 'Race engineers')}${cb('ui/pplReg/r/media', g.r.media, 'Media and paddock')}</fieldset>
      <fieldset><legend>Series</legend>${allSeries().map(s => cb(`ui/pplReg/s/${s.id}`, g.s[s.id], s.name)).join('')}</fieldset>
      <fieldset><legend>Experience</legend>${cb('ui/pplReg/y/a', g.y.a, '1 to 2 years')}${cb('ui/pplReg/y/b', g.y.b, '3 to 6 years')}${cb('ui/pplReg/y/c', g.y.c, '7 years or more')}</fieldset></aside>
    <div class="card reg-table"><div class="scroll-x"><table class="data"><thead><tr><th>Name</th><th>Role</th><th>Team</th><th>Series</th><th class="num">Years</th><th class="num">Record</th></tr></thead><tbody>
      ${rows.map(x => `<tr class="${pick && x.c.id === pick.c.id ? 'me' : ''}"><td><span class="f1-bar" style="background:${esc(x.color)}"></span><button class="linkish" data-act="ppl-sel" data-id="${esc(x.c.id)}">${esc(x.c.name)}</button></td><td>${esc(charRoleName(x.c.role))}</td><td>${esc(x.team ? x.team.name : x.where)}</td><td>${esc(x.series ? x.series.short : '')}</td><td class="num">${x.years || ''}</td><td class="num">${esc(rec(x))}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nobody matches these filters.</td></tr>'}</tbody></table></div></div>
    ${pick ? (() => { const x = pick, c = x.c, diary = list('f1_diary').filter(d => d.charId === c.id).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0], rival = list('f1_relations').find(r => r.charId === c.id && r.kind === 'rival');
      return `<aside class="card reg-preview" style="--team:${esc(x.color)}" aria-label="${esc(c.name)}"><div class="reg-photo">${c.portraitUrl ? `<img src="${esc(c.portraitUrl)}" alt="">` : `<span class="ppl-init" aria-hidden="true">${esc(initialsOf(c.name))}</span>`}</div>
        <h2>${esc(c.name)}${x.num ? ` <span class="muted">#${esc(x.num)}</span>` : ''}</h2><p class="muted small">${esc(charRoleName(c.role))}, ${esc(x.where)}.${c.nationality ? ' ' + esc(c.nationality) + '.' : ''}${x.years ? ` ${plural(x.years, 'year')} of experience.` : ''}</p>
        ${c.bio ? `<p>${esc(String(c.bio).split('\n')[0].slice(0, 220))}</p>` : ''}
        <div class="ppl-stats">${x.stats.map(([v, l]) => `<span><b>${esc(v)}</b><span>${esc(l)}</span></span>`).join('')}</div>
        ${diary ? `<p class="small"><b>Latest diary:</b> ${esc(diary.title)}</p>` : ''}${rival ? `<p class="small"><b>Rival:</b> ${esc((F1.person(rival.otherId) || {}).name || '')}</p>` : ''}
        <button class="btn primary" data-act="ppl-open" data-id="${esc(x.pid)}">Open ${esc(c.name.split(' ')[0])}’s page</button></aside>`; })() : ''}</div>`;
}
route('people', 'Characters', function () {
  const v = S.ui.pplView || 'cards';
  return `<div class="page-head"><div><h1>Characters</h1><p>Everyone racing, running teams and reporting in the league.</p></div>
      <div class="btn-row"><div class="seg" role="tablist" aria-label="View">${[['cards', 'Cards'], ['team', 'By team'], ['register', 'Register']].map(([k, l]) => `<button role="tab" aria-selected="${v === k}" data-act="ppl-view" data-view="${k}">${l}</button>`).join('')}</div>
      <button class="btn primary" data-act="nav" data-route="characters">Create a character</button></div></div>
    ${v === 'team' ? byTeamHtml() : v === 'register' ? registerHtml() : cardsHtml()}`;
});

/* ---------------------------------------------------------------- one character's page */
route('career', 'Character', function () {
  let p = F1.person(S.ui.career);
  const cid = p ? p.charId : (String(S.ui.career || '').indexOf('pc-') === 0 ? String(S.ui.career).slice(3) : null), c = cid ? get('characters', cid) : null;
  if (!p && c) p = { id: f1PcId(c.id), charId: c.id, name: c.name, kind: c.role };
  if (!p) return '<div class="empty">Choose someone from Characters, The Grid or the Championship.</div>';
  const mine = !!(c && (c.userId === S.uid || S.isGm) && S.charId === c.id), isDriver = !p.kind || p.kind === 'driver' || (c && c.role === 'driver');
  const seat = c ? primarySeat(c.id) : F1.seats().find(s => s.defaultPersonId === p.id && !s.holderCharId) || list('f1_seats').find(s => s.defaultPersonId === p.id);
  const team = seat ? get('f1_teams', seat.teamId) : (p.teamId ? get('f1_teams', p.teamId) : null), series = team ? seriesOfTeam(team.id) : null, brand = team ? teamBrand(team.id) : {};
  const color = team ? team.color : '#56636F', rec = f1Record(p.id), gps = rec.filter(x => x.w.session === 'gp'), pts = rec.reduce((a, x) => a + (x.r.points || 0), 0);
  const role = c ? charRoleName(c.role) : (F1_ROLE[p.kind] || 'Driver'), years = yearsNow(p), styleLbl = isDriver && p.style ? (F1_STYLES.find(s => s[0] === p.style) || ['', ''])[1] : '';
  let stats;
  if (isDriver) { const st = series ? seasonStandingsFor(series.id) : { drivers: [] }, i = st.drivers.findIndex(d => d.personId === p.id);
    stats = [['Races', gps.length], ['Podiums', gps.filter(x => x.r.position && x.r.position <= 3).length], ['Points', pts], ['Championship', i >= 0 ? 'P' + (i + 1) : '–']]; }
  else stats = (c ? charInfo(c).stats.map(([v, l]) => [l, v]) : []);
  const awards = f1AwardsFor(p.id), counts = {}; awards.forEach(a => { const k = a.label.replace(/ \(.*\)$/, ''); counts[k] = (counts[k] || 0) + 1; });
  const diary = c ? list('f1_diary').filter(x => x.charId === c.id).sort((a, b) => String(b.at).localeCompare(String(a.at))) : [];
  const rels = list('f1_relations').filter(r => r.personId === p.id || r.otherId === p.id), relKind = k => (REL_KINDS.find(x => x[0] === k) || [k, k])[1], relName = id => (F1.person(id) || {}).name || 'someone';
  const rivals = trackRivals(p.id), tl = timeline(p);
  const eng = isDriver && seat && seat.role === 'driver' ? F1.seats(seat.teamId).find(s => s.role === 'engineer' && s.car === seat.car && s.holderCharId) : null;
  const k = c && seat && typeof activeContract === 'function' ? activeContract(c.id, seat.teamId) : null;
  const ratings = isDriver ? (c ? f1DevApply(Object.assign({}, F1_ROOKIE, p), c.id) : p) : null;
  const where = team ? `${team.name}${seat && seat.role !== 'principal' ? `, car ${seat.car}` : ''}${series ? `, ${series.name}` : ''}` : (c && (c.role === 'media' || c.role === 'paddock') ? 'the paddock' : '');

  let h = `<button class="linkish small" data-act="nav" data-route="people">All characters</button>
  <section class="char-hero" style="--team:${esc(color)}"><div class="char-banner">${brand.banner ? `<img src="${esc(brand.banner)}" alt="">` : ''}</div>
    <div class="char-id"><div class="char-photo">${c && c.portraitUrl ? `<img src="${esc(c.portraitUrl)}" alt="${esc(p.name)}">` : `<span class="ppl-init" aria-hidden="true">${esc(initialsOf(p.name))}</span>`}</div>
      <div class="char-name"><p class="muted">${brand.logo ? `<img class="team-logo tiny" src="${esc(brand.logo)}" alt="">` : ''}${esc(role)}${where ? `, ${esc(where)}` : ''}${c ? '' : '. Real, not a player'}</p>
        <h1>${p.flag ? esc(p.flag) + ' ' : ''}${esc(p.name)}</h1>
        <p class="muted">${[c && c.nickname ? `“${c.nickname}”` : '', p.num || (c && c.number) ? '#' + (c && c.number || p.num) : '', c && c.nationality, c && c.birthplace ? 'from ' + c.birthplace : '', years ? plural(years, 'year') + ' of experience' : '', styleLbl].filter(Boolean).map(esc).join('. ')}</p></div>
      ${stats.length ? `<div class="stat-strip">${stats.map(([l, v], i) => `<div><span>${esc(l)}</span><b class="${i === stats.length - 1 && isDriver ? 'hi' : ''}">${esc(v)}</b></div>`).join('')}</div>` : ''}</div>
    ${mine ? `<div class="btn-row char-actions"><label class="btn small file-btn">Change portrait<input type="file" accept="image/*" data-change="portrait" data-id="${esc(c.id)}" class="sr-only"></label><button class="btn small" data-act="diary-new">Write in the diary</button><button class="btn small" data-act="rel-new">Add a relationship</button><button class="btn small" data-act="char-edit" data-id="${esc(c.id)}">Edit details</button></div>` : ''}</section>`;

  const left = `<aside class="char-left">
    <section class="card"><h2>Particulars</h2><dl class="rail-defaults">
      ${c && c.helmet ? `<div><dt>Helmet</dt><dd>${esc(c.helmet)}</dd></div>` : ''}${c && c.junior ? `<div><dt>Before Formula 1</dt><dd>${esc(c.junior)}</dd></div>` : ''}
      ${k ? `<div><dt>Contract</dt><dd>£${k.salary}m a season, until ${esc(contractLeft(k))}</dd></div>` : ''}
      ${eng ? `<div><dt>Race engineer</dt><dd>${careerLink(f1PcId(eng.holderCharId), eng.holderName)}${f1Rapport(seat.teamId, seat.car) ? `, ${plural(f1Rapport(seat.teamId, seat.car), 'weekend')} together` : ''}</dd></div>` : ''}
      ${seatsOfChar(cid || '').length > 1 ? `<div><dt>Also races in</dt><dd>${seatsOfChar(cid).filter(s => s.id !== seat.id).map(s => `${esc(seriesOfTeam(s.teamId).name)}, ${esc(F1.team(s.teamId).name)}`).join('<br>')}</dd></div>` : ''}
      ${c && c.faceclaim ? `<div><dt>Face claim</dt><dd>${esc(c.faceclaim)}</dd></div>` : ''}${c && c.discord ? `<div><dt>Discord</dt><dd>${esc(c.discord)}</dd></div>` : ''}
      ${!(c && (c.helmet || c.junior || c.discord || c.faceclaim)) && !k && !eng ? '<p class="muted small">Nothing more yet.</p>' : ''}</dl></section>
    <section class="card"><h2>Relationships</h2>${rels.length ? `<ul class="rels">${rels.map(r => { const mineRel = r.personId === p.id;
        return `<li><b>${esc(relKind(r.kind))}:</b> ${mineRel ? careerLink(r.otherId, relName(r.otherId)) : `${careerLink(r.personId, relName(r.personId))} counts them as a ${esc(relKind(r.kind).toLowerCase())}`}${r.note ? `<p class="muted small">${esc(r.note)}</p>` : ''}${mineRel && mine ? ` <button class="btn small ghost" data-act="rel-delete" data-id="${esc(r.id)}">Remove</button>` : ''}</li>`; }).join('')}</ul>` : '<p class="muted small">None declared.</p>'}
      ${rivals.length ? `<h4>On track</h4><ul class="rels">${rivals.map(r => `<li>${careerLink(r.personId, r.name)} <span class="muted small">${r.won} passes for, ${r.lost} against</span></li>`).join('')}</ul>` : ''}</section></aside>`;

  const mid = `<div class="char-mid">
    <section class="card"><h2>Story</h2>${c && c.bio ? paras(c.bio) : `<p class="muted">${c ? 'No story written yet.' : `${esc(p.name)} is part of today’s real grid.`}</p>`}</section>
    ${diary.length || mine ? `<section class="card"><h2>Diary</h2>${diary.length ? diary.slice(0, 8).map(d => `<article class="diary"><p class="muted small">${esc(fmtWhen(d.at))}</p><h3>${esc(d.title)}</h3>${paras(d.body)}${mine ? `<button class="btn small ghost" data-act="diary-delete" data-id="${esc(d.id)}">Delete</button>` : ''}</article>`).join('') : '<p class="muted">No entries yet. Diary entries are public.</p>'}</section>` : ''}
    <section class="card"><h2>Timeline</h2>${tl.length ? `<ol class="timeline">${tl.map(x => `<li><span class="muted small">${esc(fmtDate(x.at))}</span> ${esc(x.text)}</li>`).join('')}</ol>` : '<p class="muted small">The story starts at the first race.</p>'}</section></div>`;

  const right = `<aside class="char-right">
    ${isDriver ? `<section class="card"><h2>Ratings</h2>${mine && c ? devPanelHtml(c.id) : `<div class="rating-bars">${F1_RATINGS.map(([key, l]) => { const v = ratings[key]; const max = key === 'mental' ? 10 : 100;
        return v == null ? '' : `<div class="rating-row"><span>${esc(l)}</span><span class="bar" role="img" aria-label="${esc(l)} ${v}"><span style="width:${Math.min(100, v / max * 100)}%"></span></span><b>${esc(v)}</b></div>`; }).join('')}</div>`}</section>` : ''}
    <section class="card"><h2>Trophy cabinet</h2>${awards.length ? `<p>${Object.keys(counts).map(k2 => `<span class="tag trophy">${esc(k2)}${counts[k2] > 1 ? ' ×' + counts[k2] : ''}</span>`).join(' ')}</p>` : '<p class="muted small">Empty, for now.</p>'}</section>
    ${rec.length ? `<section class="card"><h2>Race by race</h2><table class="data compact"><thead><tr><th>Race</th><th class="num">Grid</th><th class="num">Finish</th><th class="num">Pts</th></tr></thead><tbody>${rec.slice().reverse().slice(0, 12).map(x => { const t = get('f1_tracks', x.w.trackId) || {};
        return `<tr><td>${esc(t.name || '')}${x.w.session === 'sprint' ? ' sprint' : ''}${wSeries(x.w) !== 'f1' ? ` <span class="muted small">${esc(seriesDoc(wSeries(x.w)).short)}</span>` : ''}</td><td class="num">${x.r.grid}</td><td class="num">${x.r.position ? 'P' + x.r.position : 'Out'}</td><td class="num">${x.r.points || ''}</td></tr>`; }).join('')}</tbody></table></section>` : ''}
    ${isDriver ? `<button class="btn" data-act="card-open" data-id="${esc(p.id)}" data-kind="card">Make a driver card</button>` : ''}</aside>`;
  const exportBtn = c && (c.userId === S.uid || S.isGm) ? `<div class="btn-row" style="justify-content:flex-end"><button class="btn" data-act="sheet-open" data-id="${esc(c.id)}">Export the character sheet</button></div>` : '';
  return h + exportBtn + `<div class="char-cols" style="--team:${esc(color)}">${left}${mid}${right}</div>` + careerRecordHtml(p, c);
});

/* =====================================================================
   F1 SIM — team development points.
   A team earns 2 development points for every 4 Grands Prix of the
   season. The team principal spends them on the car, a step at a time.
   Points and what they bought reset each season (how much of the car's
   development carries over is Race Control's choice when the new season
   starts). Teams without a player principal spend theirs on pace by
   themselves. Spec series have no car development.
   ===================================================================== */
'use strict';

const RACES_PER_DEV = 4;
const TEAM_DEV_EACH = 2;
const TEAM_DEV = [
  ['carPace', 'Overall pace', 0.3], ['topSpeed', 'Top speed', 0.5], ['cornering', 'Cornering', 0.5],
  ['reliability', 'Reliability', 1.5], ['tyreLife', 'Kindness to tyres', 1.5], ['pitSpeed', 'Pit crew', 1.5]
];
const teamDevEarned = n => Math.floor((n == null ? finishedGps().length : n) / RACES_PER_DEV) * TEAM_DEV_EACH;
const hasPlayerTp = teamId => F1.seats(teamId).some(s => s.role === 'principal' && s.holderCharId);
/* This season's spends by the team's principals (a principal's own records, checked against their character). */
function teamDevSpends(teamId) {
  return list('f1_dev').filter(x => x.kind === 'team' && x.teamId === teamId && recSeason(x) === curSeasonId() && TEAM_DEV.some(d => d[0] === x.attr)
    && (get('characters', x.charId) || {}).role === 'principal' && (get('characters', x.charId) || {}).userId === x.userId)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
/* Apply the team's development to a car: as many spends as the points so far cover. */
function teamDevApply(teamId, out, n) {
  const earned = teamDevEarned(n); let used = 0;
  if (hasPlayerTp(teamId)) teamDevSpends(teamId).forEach(x => { if (used >= earned) return; const d = TEAM_DEV.find(t => t[0] === x.attr); out[x.attr] = Math.round(((out[x.attr] || 0) + d[2]) * 100) / 100; used += 1; });
  else { out.carPace = Math.round(((out.carPace || 0) + earned * TEAM_DEV[0][2]) * 100) / 100; used = earned; }
  return { earned, used, left: earned - used };
}
ACTIONS['team-dev'] = d => {
  const c = currentChar(), w = F1.live();
  if (!c || !F1.seats(d.team).some(s => s.role === 'principal' && s.holderCharId === c.id)) { toast('Only the team principal spends the team’s development points.', true); return; }
  if (w && w.status !== 'practice') { toast('Car development waits until the race weekend is over.', true); return; }
  const st = teamDevApply(d.team, Object.assign({}, get('f1_teams', d.team)));
  if (st.left < 1) { toast('No team development points left. The team earns 2 for every 4 Grands Prix.', true); return; }
  run(async () => { await Data.put('f1_dev', newId('tdev'), { userId: asOwner(), charId: c.id, teamId: d.team, kind: 'team', attr: d.attr, seasonId: curSeasonId(), at: nowIso() }); },
    `${(TEAM_DEV.find(t => t[0] === d.attr) || [])[1]} improved.`);
};
function teamDevHtml(tid) {
  if (!curSeries().development) return '';
  const team = get('f1_teams', tid), n = finishedGps().length, st = teamDevApply(tid, Object.assign({}, team), n), eff = f1EffectiveTeam(team, n);
  const c = currentChar(), isTp = !!(c && F1.seats(tid).some(s => s.role === 'principal' && s.holderCharId === c.id)), toNext = RACES_PER_DEV - (n % RACES_PER_DEV);
  const counts = {}; if (hasPlayerTp(tid)) teamDevSpends(tid).slice(0, st.used).forEach(x => { counts[x.attr] = (counts[x.attr] || 0) + 1; });
  return `<section class="card"><h2>Team development points</h2>
    <div class="metrics"><div class="metric"><b>${st.left}</b><span>To spend</span></div><div class="metric"><b>${st.earned}</b><span>Earned this season</span></div><div class="metric"><b>${toNext}</b><span>${toNext === 1 ? 'Grand Prix' : 'Grands Prix'} to the next 2</span></div></div>
    <p class="muted small">The team earns ${TEAM_DEV_EACH} points for every ${RACES_PER_DEV} Grands Prix. Points and what they bought reset each season. ${hasPlayerTp(tid) ? (isTp ? 'Spend them between race weekends.' : 'The team principal spends them.') : 'With no player in charge, the team puts them into pace by itself.'}</p>
    <table class="data compact"><tbody>${TEAM_DEV.map(([k, l, step]) => `<tr><td>${esc(l)}</td><td class="num"><b>${esc(eff[k])}</b>${counts[k] ? ` <span class="f1-up">+${Math.round(counts[k] * step * 10) / 10}</span>` : ''}</td>
      <td class="num">${isTp ? `<button class="btn small" data-act="team-dev" data-team="${esc(tid)}" data-attr="${k}" ${st.left < 1 ? 'disabled' : ''}>+${step} for 1 point</button>` : ''}</td></tr>`).join('')}</tbody></table></section>`;
}
const _teamViewDev = ROUTES.team.view;
ROUTES.team.view = function () {
  const html = _teamViewDev(), teams = F1.teams(); if (!teams.length) return html;
  const my = S.charId ? F1.seats().find(s => s.holderCharId === S.charId) : null, tid = S.ui.teamId || (my && my.teamId) || teams[0].id;
  return html + teamDevHtml(tid);
};

/* =====================================================================
   F1 SIM — timing sheet export.
   An image of the timing at any stage of a weekend: each practice
   session, Q1, Q2 and Q3 (or qualifying in one-session series), the race
   at the current lap, and the result. Two formats: 1. Podium (portrait,
   1080 by 1350: P1 to P3 on podium steps, the rest in two columns) and
   2. Broadcast (widescreen, 1920 by 1080: three big cards and a timing
   tower). Drawn in the browser; anyone downloads it, Race Control can
   post it to Discord. Player characters show their portraits.
   ===================================================================== */
'use strict';

const EXPORT_FORMATS = [['podium', '1. Podium (portrait)'], ['broadcast', '2. Broadcast (widescreen)']];
const TYRE_COL = { soft: '#E10600', medium: '#F5C400', hard: '#F2F2F2', inter: '#2FA84F', wet: '#1D6FD1' };

/* The stages that have timing to export. */
function exportStages(w) {
  const out = [];
  endedSessions(w).forEach(s => out.push([`fp${s.n}`, w.session === 'test' ? `Testing, day ${s.n}` : sessionName(w, s.n) === 'Practice' ? 'Practice' : `Practice ${s.n}`]));
  if (w.quali && w.quali.results) {
    const single = w.state && w.state.rules.qualifying && w.state.rules.qualifying.q2 >= 99, upto = w.status === 'quali' ? (w.qualiStage || 1) : 3;
    if (single) out.push(['q3', 'Qualifying']); else for (let k = 1; k <= upto; k++) out.push([`q${k}`, `Q${k}`]);
  }
  if (w.state && w.state.lap > 0 && !w.state.finished) out.push(['race', `Lap ${w.state.lap} of ${w.state.laps}`]);
  if (w.status === 'finished' && w.session !== 'test') out.push(['result', w.session === 'sprint' ? 'Sprint result' : 'Race result']);
  return out;
}
const fmtRaceTime = s => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(1).padStart(4, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`; };
/* The order and the numbers for a stage. */
function exportRows(w, key) {
  const ents = w.entrants || f1Entrants(), info = id => { const e = ents.find(x => x.id === id) || { id, name: id };
    const c = e.charId ? get('characters', e.charId) : null, p = e.personId ? F1.person(e.personId) : null;
    return { id, code: id, name: e.name || id, team: (get('f1_teams', e.teamId) || {}).name || '', color: f1Colour(e.teamId), num: (c && c.number) || (p && p.num) || '', portrait: c && c.portraitUrl ? c.portraitUrl : null }; };
  let rows = [];
  if (/^fp/.test(key)) {
    const s = endedSessions(w).find(x => `fp${x.n}` === key); if (!s) return [];
    const ids = Object.keys(s.times || {}).filter(k => s.times[k]).sort((a, b) => s.times[a] - s.times[b]), best = s.times[ids[0]];
    rows = ids.map((id, i) => Object.assign(info(id), { value: i ? '+' + (s.times[id] - best).toFixed(3) : f1Fmt(best), lap: s.times[id] }));
    Object.keys(s.times || {}).filter(k => !s.times[k]).forEach(id => rows.push(Object.assign(info(id), { value: 'No time' })));
  } else if (/^q/.test(key)) {
    const k = Number(key.slice(1)) - 1, res = w.quali.results, best = r => r.times[k];
    const inIt = res.filter(r => best(r)).sort((a, b) => best(a) - best(b)), fast = inIt.length ? best(inIt[0]) : 0;
    rows = inIt.map((r, i) => Object.assign(info(r.id), { value: i ? '+' + (best(r) - fast).toFixed(3) : f1Fmt(fast) }));
    for (let j = k - 1; j >= 0; j--) res.filter(r => !r.times[j + 1] && r.times[j] && rows.every(x => x.id !== r.id)).sort((a, b) => a.times[j] - b.times[j]).forEach(r => rows.push(Object.assign(info(r.id), { value: `Out in Q${j + 1}` })));
  } else if (key === 'race') {
    const st = w.state, ord = f1Order(st), lead = ord[0];
    rows = ord.map((c, i) => Object.assign(info(c.id), { value: c.status !== 'running' ? 'Out' : i ? '+' + (c.cum - lead.cum).toFixed(1) : 'Leader', tyre: c.status === 'running' ? c.tyre.compound : null, age: c.tyre ? c.tyre.age : 0 }));
  } else {
    const rs = (w.results || []).slice().sort((a, b) => (a.position || 99) - (b.position || 99));
    rows = rs.map((r, i) => Object.assign(info(r.id), { value: !r.position ? 'Out' : i === 0 ? fmtRaceTime(r.time || 0) : String(r.gap || '').replace(/s$/, ''), tyre: null }));
  }
  return rows.map((r, i) => Object.assign(r, { pos: i + 1 }));
}

/* ---------------------------------------------------------------- drawing */
const EXP_THEMES = {
  dark: { bg: '#1C1D22', panel: '#25272D', ink: '#FFFFFF', muted: '#A7ABB3', line: '#3A3D45', photo: '#2E3037', photoInk: '#565A63', step: '#E10600', stepInk: '#FFFFFF' },
  light: { bg: '#E6E9EC', panel: '#FFFFFF', ink: '#142130', muted: '#56636F', line: '#CDD3D8', photo: '#D3D9DE', photoInk: '#9AA6B0', step: '#142130', stepInk: '#F7F8F9' }
};
const cond = (wt, px) => `${wt} ${px}px "Titillium Web", "Arial Narrow", sans-serif`, bodyF = (wt, px) => `${wt} ${px}px "Titillium Web", system-ui, sans-serif`;
function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function fitText(g, text, font, size, max) { let s = size; g.font = font(s); while (g.measureText(text).width > max && s > 10) { s -= 2; g.font = font(s); } return s; }
const initials = n => String(n || '').split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();
async function loadImg(url) { if (!url) return null; try { const img = new Image(); img.crossOrigin = 'anonymous'; await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; }); return img; } catch (e) { return null; } }
function drawPhoto(g, img, x, y, w, h, r, row, T) {
  g.save(); rr(g, x, y, w, h, r); g.clip(); g.fillStyle = T.photo; g.fillRect(x, y, w, h);
  if (img) { const s = Math.max(w / img.width, h / img.height), iw = img.width * s, ih = img.height * s; g.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih); }
  else { g.fillStyle = T.photoInk; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = cond(700, Math.round(Math.min(w, h) * 0.38)); g.fillText(initials(row.name), x + w / 2, y + h / 2); }
  g.restore(); g.textAlign = 'left'; g.textBaseline = 'alphabetic';
}
/* The league logo (when Race Control has uploaded one) or the F1 SIM mark, then the name. Returns where it ends. */
function drawMark(g, x, y, T, logo) {
  let tx = x + 38;
  if (logo) { const h = 34, w = Math.min(160, logo.width / logo.height * h); g.drawImage(logo, x, y - 4, w, h); tx = x + w + 12; }
  else [[0, 0, T.ink], [13, 13, T.ink], [13, 0, T.line], [0, 13, T.line]].forEach(([dx, dy, c]) => { g.fillStyle = c; g.fillRect(x + dx, y + dy, 13, 13); });
  g.fillStyle = T.ink; g.font = cond(700, 30); g.fillText('F1 SIM', tx, y + 24); return tx + g.measureText('F1 SIM').width;
}
function tyreDot(g, x, y, r, compound, T) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.lineWidth = Math.max(3, r / 3); g.strokeStyle = TYRE_COL[compound] || T.muted; g.stroke(); g.fillStyle = T.ink; g.font = cond(700, Math.round(r * 1.1)); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText((compound || '').charAt(0).toUpperCase(), x, y + 1); g.textAlign = 'left'; g.textBaseline = 'alphabetic'; }

async function drawTiming(w, key, format, theme) {
  const T = EXP_THEMES[theme] || EXP_THEMES.dark, rows = exportRows(w, key), stage = (exportStages(w).find(s => s[0] === key) || ['', ''])[1];
  const t = get('f1_tracks', w.trackId) || {}, race = key === 'race' || key === 'result', top = rows.slice(0, 3), rest = rows.slice(3), isTest = w.session === 'test';
  try { await Promise.all(['700 100px "Titillium Web"', '900 100px "Titillium Web"', '600 30px "Titillium Web"'].map(f => document.fonts.load(f))); } catch (e) { /* fall back */ }
  const imgs = await Promise.all(top.map(r => loadImg(r.portrait))), logo = await loadImg(leagueLogo());
  const wide = format === 'broadcast', W = wide ? 1920 : 1080, H = wide ? 1080 : 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.fillStyle = T.bg; g.fillRect(0, 0, W, H);
  const title = isTest ? `Pre-season testing, ${t.circuit || t.name || ''}` : `${t.name || ''}${w.session === 'sprint' ? ' Sprint' : ''}`, sub = race ? 'Gaps to the leader' : 'Best laps';
  if (!wide) {
    drawMark(g, 60, 56, T, logo); g.font = cond(600, 24); g.fillStyle = T.muted; g.textAlign = 'right'; g.fillText(`Round ${t.round || ''}, ${t.circuit || ''}`.trim(), W - 60, 80); g.textAlign = 'left';
    g.font = cond(600, 32); g.fillText(title, 60, 150); fitText(g, stage, s => cond(700, s), 116, W - 120); g.fillStyle = T.ink; g.fillText(stage, 58, 252);
    g.fillStyle = '#E10600'; g.beginPath(); g.moveTo(68, 284); g.lineTo(150, 284); g.lineTo(144, 292); g.lineTo(62, 292); g.closePath(); g.fill();
    /* Podium: P2, P1, P3. */
    const colW = (W - 120 - 36) / 3, baseY = 860, cardH = [450, 400, 370], stepH = [110, 72, 44];
    [1, 0, 2].forEach((i, slot) => { const r = top[i]; if (!r) return; const x = 60 + slot * (colW + 18), y = baseY - stepH[i] - cardH[i];
      g.save(); rr(g, x, y, colW, cardH[i], 16); g.clip(); g.fillStyle = r.color; g.fillRect(x, y, colW, cardH[i]); g.restore();
      drawPhoto(g, imgs[i], x + 8, y + 8, colW - 16, cardH[i] - 118, 10, r, T);
      if (r.num) { g.font = cond(700, 58); g.fillStyle = '#FFFFFF'; g.textAlign = 'right'; g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 8; g.fillText(String(r.num), x + colW - 18, y + 62); g.shadowBlur = 0; g.textAlign = 'left'; }
      g.fillStyle = T.panel; g.fillRect(x, y + cardH[i] - 104, colW, 104); g.fillStyle = r.color; g.fillRect(x, y + cardH[i] - 104, colW, 7);
      g.fillStyle = T.ink; fitText(g, r.name, s => cond(700, s), 34, colW - 28); g.fillText(r.name, x + 14, y + cardH[i] - 58);
      g.font = bodyF(500, 18); g.fillStyle = T.muted; g.fillText(r.team, x + 14, y + cardH[i] - 24); g.font = bodyF(600, 20); g.fillStyle = T.ink; g.textAlign = 'right'; g.fillText(r.value, x + colW - 14, y + cardH[i] - 24); g.textAlign = 'left';
      g.fillStyle = T.step; g.fillRect(x, baseY - stepH[i], colW, stepH[i]); g.fillStyle = T.stepInk; g.font = cond(700, Math.min(60, stepH[i] - 6)); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(`P${r.pos}`, x + colW / 2, baseY - stepH[i] / 2 + 2); g.textAlign = 'left'; g.textBaseline = 'alphabetic'; });
    /* The rest, in two columns. */
    const per = Math.ceil(rest.length / 2), rh = Math.min(36, Math.floor(380 / Math.max(1, per))), cw = (W - 120 - 36) / 2;
    rest.forEach((r, k) => { const col = k < per ? 0 : 1, x = 60 + col * (cw + 36), y = 900 + (k % per) * rh;
      g.fillStyle = T.line; g.fillRect(x, y + rh - 1, cw, 1);
      g.fillStyle = T.muted; g.font = cond(700, Math.min(24, rh - 8)); g.fillText(String(r.pos), x, y + rh - 10);
      g.fillStyle = r.color; g.fillRect(x + 42, y + 7, 6, rh - 14);
      g.fillStyle = T.ink; g.font = cond(700, Math.min(24, rh - 8)); g.fillText(r.code, x + 58, y + rh - 10);
      g.fillStyle = T.muted; g.font = bodyF(500, Math.min(18, rh - 12)); const nm = r.name; g.fillText(nm.length > 18 ? nm.slice(0, 17) + '…' : nm, x + 122, y + rh - 11);
      g.fillStyle = T.ink; g.font = bodyF(600, Math.min(19, rh - 12)); g.textAlign = 'right'; g.fillText(r.value, x + cw, y + rh - 11); g.textAlign = 'left'; });
    g.fillStyle = T.muted; g.font = bodyF(500, 17); g.fillText(sub, 60, H - 40); g.textAlign = 'right'; g.fillText(fmtDate(nowIso()), W - 60, H - 40); g.textAlign = 'left';
  } else {
    const me = drawMark(g, 56, 52, T, logo); g.fillStyle = T.line; g.fillRect(me + 20, 50, 2, 34); g.fillStyle = T.ink; g.font = cond(700, 44); g.fillText(title, me + 42, 84);
    g.font = cond(700, 34); const sw = g.measureText(stage).width + (key === 'race' ? 64 : 40); rr(g, W - 56 - sw, 44, sw, 52, 26); g.fillStyle = T.panel; g.fill();
    if (key === 'race') { g.beginPath(); g.arc(W - 56 - sw + 28, 70, 8, 0, Math.PI * 2); g.fillStyle = '#E10600'; g.fill(); }
    g.fillStyle = T.ink; g.fillText(stage, W - 56 - sw + (key === 'race' ? 46 : 20), 82);
    /* Three cards, stacked. */
    const cx = 56, cw = W - 56 - 640 - 36 - 56, ch = 270, gap = 18;
    top.forEach((r, i) => { const y = 126 + i * (ch + gap);
      rr(g, cx, y, cw, ch, 14); g.fillStyle = T.panel; g.fill();
      g.save(); rr(g, cx, y, cw, ch, 14); g.clip(); g.fillStyle = r.color; g.fillRect(cx, y, 180, ch); g.restore();
      g.fillStyle = '#FFFFFF'; g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 10; g.font = cond(700, 150); g.textAlign = 'center'; g.fillText(String(r.pos), cx + 90, y + ch / 2 + 52); g.shadowBlur = 0; g.textAlign = 'left';
      drawPhoto(g, imgs[i], cx + 206, y + 24, 210, ch - 48, 10, r, T);
      g.fillStyle = T.muted; g.font = cond(600, 28); g.fillText(r.team + (r.num ? `  #${r.num}` : ''), cx + 446, y + 76);
      g.fillStyle = T.ink; fitText(g, r.name, s => cond(700, s), 76, cw - 446 - 300); g.fillText(r.name, cx + 446, y + 146);
      if (r.tyre) { tyreDot(g, cx + 462, y + 196, 16, r.tyre, T); g.fillStyle = T.muted; g.font = bodyF(500, 22); g.fillText(`${RaceEngine.COMPOUNDS[r.tyre].label}s, ${r.age} laps old`, cx + 490, y + 204); }
      g.fillStyle = T.ink; g.font = cond(700, 66); g.textAlign = 'right'; g.fillText(r.value, cx + cw - 36, y + 150);
      g.fillStyle = T.muted; g.font = bodyF(500, 20); g.fillText(i === 0 ? (race ? (key === 'result' ? 'Race time' : 'Leading') : 'Fastest') : (race ? 'To the leader' : 'To the fastest'), cx + cw - 36, y + 186); g.textAlign = 'left'; });
    /* The timing tower. */
    const tx = W - 56 - 640, ty = 126, th = H - 126 - 48; rr(g, tx, ty, 640, th, 14); g.fillStyle = T.panel; g.fill();
    const rh = Math.min(42, Math.floor((th - 70) / Math.max(1, rest.length)));
    g.fillStyle = T.muted; g.font = bodyF(500, 17); g.fillText('Pos', tx + 22, ty + 38); g.fillText('Driver', tx + 104, ty + 38); g.textAlign = 'right'; g.fillText('Gap', tx + 560, ty + 38); g.textAlign = 'left'; if (race) g.fillText('Tyre', tx + 584, ty + 38);
    rest.forEach((r, k) => { const y = ty + 56 + k * rh;
      g.fillStyle = T.line; g.fillRect(tx + 22, y + rh - 1, 596, 1);
      g.fillStyle = T.muted; g.font = cond(700, Math.min(26, rh - 10)); g.fillText(String(r.pos), tx + 22, y + rh - 11);
      g.fillStyle = r.color; g.fillRect(tx + 76, y + 8, 7, rh - 16);
      g.fillStyle = T.ink; g.font = cond(700, Math.min(28, rh - 10)); g.fillText(r.code, tx + 104, y + rh - 11);
      g.fillStyle = T.muted; g.font = bodyF(500, Math.min(19, rh - 14)); const nm = r.team; g.fillText(nm.length > 16 ? nm.slice(0, 15) + '…' : nm, tx + 190, y + rh - 12);
      g.fillStyle = T.ink; g.font = bodyF(600, Math.min(21, rh - 14)); g.textAlign = 'right'; g.fillText(r.value, tx + 560, y + rh - 12); g.textAlign = 'left';
      if (r.tyre) tyreDot(g, tx + 600, y + rh / 2, Math.min(13, rh / 3), r.tyre, T); });
  }
  return new Promise(ok => cv.toBlob(ok, 'image/png'));
}

/* ---------------------------------------------------------------- the export drawer */
ACTIONS['tx-open'] = d => {
  const w = get('f1_weekends', d.id) || F1.live(); if (!w) return;
  const st = exportStages(w); if (!st.length) { toast('Nothing to export yet: run a session first.', true); return; }
  S.ui.tx = { wid: w.id, key: st[st.length - 1][0], format: 'podium', theme: 'dark', url: null, blob: null, channel: '' }; openDrawer('tx'); txRefresh();
  if (S.isGm) discordChannels().then(() => renderOverlay()).catch(() => {});
};
async function txRefresh() {
  const x = S.ui.tx; if (!x) return; const w = get('f1_weekends', x.wid); if (!w) return;
  const blob = await drawTiming(w, x.key, x.format, x.theme); if (S.ui.tx !== x) return;
  if (x.url) URL.revokeObjectURL(x.url); x.blob = blob; x.url = URL.createObjectURL(blob); renderOverlay();
}
CHANGES['tx-set'] = (v, d) => { const x = S.ui.tx; if (!x) return; x[d.field] = v; if (d.field === 'channel') { renderOverlay(); return; } x.url = null; renderOverlay(); txRefresh(); };
DRAWERS.tx = function () {
  const x = S.ui.tx || {}, w = get('f1_weekends', x.wid); if (!w) return '';
  const t = get('f1_tracks', w.trackId) || {}, opt = (field, list2) => `<select id="tx-${field}" data-change="tx-set" data-field="${field}">${list2.map(([k, l]) => `<option value="${k}" ${x[field] === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<header><div><h2>Export timing</h2><p>${esc(t.name || '')}${w.session === 'sprint' ? ' sprint' : ''}. Download it, or post it to Discord.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><div class="form-grid">
      <label class="field">Stage${opt('key', exportStages(w))}</label>
      <label class="field">Format${opt('format', EXPORT_FORMATS)}</label>
      <label class="field">Look${opt('theme', [['dark', 'Carbon'], ['light', 'Light']])}</label></div>
    ${x.url ? `<img class="card-preview tx-preview" src="${x.url}" alt="The timing sheet image">` : '<p class="muted">Drawing the timing sheet…</p>'}
    ${S.isGm ? `<label class="field" style="max-width:360px">Discord channel${opt('channel', [['', `Automatic: #${S.discordCh ? pickChannel(x.key === 'result' ? 'results' : 'timing', wSeries(w), S.discordCh) : '…'}`]].concat((S.discordCh || []).map(c => [c, '#' + c])))}</label>` : ''}
    <div class="btn-row"><button class="btn primary" data-act="tx-download" ${x.url ? '' : 'disabled'}>Download</button>${S.isGm ? `<button class="btn" data-act="tx-discord" ${x.url ? '' : 'disabled'}>Post to Discord</button>` : ''}${x.posted ? `<span class="tag player">Posted to #${esc(x.posted)}</span>` : ''}</div></div>`;
};
ACTIONS['tx-download'] = () => { const x = S.ui.tx; if (!x || !x.url) return; const w = get('f1_weekends', x.wid), a = document.createElement('a'); a.href = x.url; a.download = `${w.trackId}-${x.key}-${x.format}.png`; document.body.appendChild(a); a.click(); a.remove(); };
ACTIONS['tx-discord'] = () => { const x = S.ui.tx; if (!x || !x.blob) return; const w = get('f1_weekends', x.wid), t = get('f1_tracks', w.trackId) || {}, stage = (exportStages(w).find(s => s[0] === x.key) || ['', ''])[1];
  run(async () => { const ch = await discordSend(x.key === 'result' ? 'results' : 'timing', { content: `**${t.name || ''}${w.session === 'sprint' ? ' sprint' : ''}: ${stage}**` }, { blob: x.blob, name: `${w.trackId}-${x.key}.png` }, x.channel);
    x.posted = ch; await Data.audit('discord.timing', `${t.name}: ${stage} timing posted to Discord #${ch}`); }, 'Posted to Discord.'); };
function exportButtonHtml(w) { return w && exportStages(w).length ? `<button class="btn small" data-act="tx-open" data-id="${esc(w.id)}">Export timing</button>` : ''; }

/* The button sits beside the stage strip on every weekend page. */
const _lvStagesTx = lvStagesHtml;
lvStagesHtml = function (w) { const h = _lvStagesTx(w), b = exportButtonHtml(w); return b ? `<div class="stages-row">${h}${b}</div>` : h; };

/* =====================================================================
   F1 SIM — league logo and Discord channels.
   Race Control uploads the league's logo; plain background around it is
   trimmed off automatically. It shows in the top bar, on timing exports
   and on driver cards.
   Discord posts go through webhooks kept as Cloudflare secrets (the
   relay in functions/api/discord.js). Each kind of post has its own
   optional channel, then falls back: for a Formula 2 timing export it
   tries f2-timing, then timing, then default. Race Control can also pick
   a channel by hand when exporting.
   ===================================================================== */
'use strict';

const leagueLogo = () => (get('f1_settings', 'league') || {}).logoUrl || null;
/* Cut away the plain border around a logo (a wallpaper with the logo in the middle, say). */
async function trimImage(file) {
  const url = URL.createObjectURL(file), img = new Image();
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; });
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data, bg = [d[0], d[1], d[2], d[3]];
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
    const i = (y * c.width + x) * 4;
    if (Math.abs(d[i] - bg[0]) > 40 || Math.abs(d[i + 1] - bg[1]) > 40 || Math.abs(d[i + 2] - bg[2]) > 40 || Math.abs(d[i + 3] - bg[3]) > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  URL.revokeObjectURL(url);
  if (x1 < 0) return file;
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04), sx = Math.max(0, x0 - pad), sy = Math.max(0, y0 - pad), sw = Math.min(c.width, x1 + pad) - sx, sh = Math.min(c.height, y1 + pad) - sy;
  const k = Math.min(1, 900 / Math.max(sw, sh)), o = document.createElement('canvas'); o.width = Math.round(sw * k); o.height = Math.round(sh * k);
  o.getContext('2d').drawImage(c, sx, sy, sw, sh, 0, 0, o.width, o.height);
  return new Promise(ok => o.toBlob(ok, 'image/png'));
}
CHANGES['league-logo'] = (v, d, el) => {
  const file = el.files && el.files[0]; if (!file || !S.isGm) return;
  if (!/^image\//.test(file.type)) { toast('Choose a picture: a PNG, JPEG or WebP.', true); return; }
  run(async () => {
    const blob = await trimImage(file), assets = await window.claude.use('assets'), up = await assets.upload(blob, { type: 'image/png' });
    await Data.put('f1_settings', 'league', Object.assign({}, get('f1_settings', 'league') ? clone(S.store.f1_settings.league) : {}, { logoUrl: up.url, logoAt: nowIso() }));
    await Data.audit('league.logo', 'New league logo');
  }, 'League logo saved.');
  el.value = '';
};
ACTIONS['league-logo-remove'] = () => askConfirm('Remove the league logo?', 'Remove', () => run(async () => {
  await Data.put('f1_settings', 'league', Object.assign({}, clone(S.store.f1_settings.league || {}), { logoUrl: null }));
}, 'League logo removed.'), true);

/* ---------------------------------------------------------------- Discord channels */
const DISCORD_PURPOSES = [
  ['results', 'Race results and result exports', 'DISCORD_WEBHOOK_RESULTS'],
  ['timing', 'Practice, qualifying and live timing exports', 'DISCORD_WEBHOOK_TIMING'],
  ['announcements', 'Race Control announcements', 'DISCORD_WEBHOOK_ANNOUNCEMENTS'],
  ['cards', 'Driver cards (signings, poles, wins, Driver of the Day)', 'DISCORD_WEBHOOK_CARDS'],
  ['calendar', 'The season calendar', 'DISCORD_WEBHOOK_CALENDAR'],
  ['standings', 'Championship standings', 'DISCORD_WEBHOOK_STANDINGS'],
  ['approvals', 'Character approvals (acceptance cards with an @mention)', 'DISCORD_WEBHOOK_APPROVALS']
];
async function discordChannels(force) {
  if (S.discordCh && !force) return S.discordCh;
  const api = await window.claude.use('discord'); S.discordCh = await api.channels(); return S.discordCh;
}
function pickChannel(purpose, seriesId, list) { return [`${seriesId}-${purpose}`, purpose, 'default'].find(c => list.indexOf(c) !== -1) || list[0] || 'default'; }
/* Post to the right channel for this kind of post (or the one chosen by hand). Says which channel it went to. */
async function discordSend(purpose, payload, file, chosen) {
  const api = await window.claude.use('discord'), list = await discordChannels().catch(() => ['default']);
  const ch = chosen && list.indexOf(chosen) !== -1 ? chosen : pickChannel(purpose, curSeriesId(), list);
  await api.post(Object.assign({ channel: ch, payload }, file ? { file } : {}));
  return ch;
}
ACTIONS['discord-check'] = () => { S.ui.dcErr = null; discordChannels(true).then(() => render()).catch(e => { S.ui.dcErr = e.message || String(e); render(); }); };
function leaguePanelHtml() {
  const logo = leagueLogo(), list = S.discordCh;
  const rows = DISCORD_PURPOSES.map(([k, l, env]) => { const ch = list ? pickChannel(k, curSeriesId(), list) : null;
    return `<tr><td>${esc(l)}</td><td><code>${esc(env)}</code></td><td>${!list ? '<span class="muted">Not checked</span>' : list.indexOf(k) !== -1 || list.indexOf(`${curSeriesId()}-${k}`) !== -1 ? `<span class="tag player">#${esc(ch)}</span>` : `<span class="muted">Falls back to #${esc(ch)}</span>`}</td></tr>`; }).join('');
  return `<section class="card"><h2>League logo</h2><p class="muted small">Shown in the top bar, on timing exports and on driver cards. Plain background around the logo is trimmed off when you upload it.</p>
      <div class="league-logo-row"><div class="brand-preview">${logo ? `<img src="${esc(logo)}" alt="League logo">` : '<span class="muted small">No logo yet</span>'}</div>
      <div class="btn-row"><label class="btn small file-btn">${logo ? 'Replace' : 'Upload a logo'}<input type="file" accept="image/*" class="sr-only" data-change="league-logo"></label>${logo ? '<button class="btn small ghost" data-act="league-logo-remove">Remove</button>' : ''}</div></div></section>
    <section class="card"><h2>Discord channels</h2><p class="muted small">Each kind of post can have its own Discord webhook, added in Cloudflare as a secret with the name shown (SETUP.md, Discord). Anything without its own goes to <code>DISCORD_WEBHOOK</code>. For a separate channel per series, put the series code in the name: <code>DISCORD_WEBHOOK_F2_RESULTS</code>.</p>
      <div class="scroll-x"><table class="data compact"><thead><tr><th>Posts</th><th>Webhook secret</th><th>Goes to</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${list ? `<p class="small">Channels set up: ${list.map(c => `<span class="tag">#${esc(c)}</span>`).join(' ') || 'none'}.</p>` : ''}${S.ui.dcErr ? `<p class="small warn-note">${esc(S.ui.dcErr)}</p>` : ''}
      <div class="btn-row"><button class="btn small" data-act="discord-check">${list ? 'Check again' : 'Check the channels'}</button></div></section>`;
}

/* =====================================================================
   F1 SIM — pre-season testing.
   Race Control opens testing at any circuit, like a weekend with three
   test days and no qualifying or race. Each day has 6 runs per car and
   runs like a full practice session: weather, red flags, crashes,
   failures, timesheets and debriefs. Testing doesn't count for the
   championship, money, power units or development points, but the
   engineer and driver working together builds their rapport.
   ===================================================================== */
'use strict';

ACTIONS['test-finish'] = () => {
  const w = F1.live(); if (!w || w.session !== 'test') return;
  const done = endedSessions(w).length;
  askConfirm(done < sessionsOf(w) ? `Finish testing after ${plural(done, 'day')}? The days not run are skipped.` : 'Finish testing? The timesheets stay in the weekend’s record.', 'Finish testing', () => run(async () => {
    const doc = clone(S.store.f1_weekends[w.id]), ents = f1Entrants().map(e => { const o = Object.assign({}, e); delete o.v3; return o; });
    /* The engineer (or whoever ran the car) and the driver worked together: it counts towards their rapport. */
    const setupBy = {}; ents.forEach(e => { const r = lastSetupRun(w, e.id); if (r) setupBy[e.id] = r.charId; });
    Object.assign(doc, { status: 'finished', finishedAt: nowIso(), entrants: ents, results: [], setupBy });
    await Data.put('f1_weekends', w.id, doc);
    await Data.audit('f1.testing', `Testing at ${(F1.track(w.trackId) || {}).name || w.trackId} finished`);
  }, 'Testing finished.'));
};
/* Every day's timesheet, and each car's best across the whole test. */
function testingSummaryHtml(w) {
  const days = endedSessions(w), best = {};
  days.forEach(s => Object.keys(s.times || {}).forEach(id => { const t = s.times[id]; if (t && (!best[id] || t < best[id].t)) best[id] = { t, day: s.n }; }));
  const ents = w.entrants || f1Entrants(), ids = Object.keys(best).sort((a, b) => best[a].t - best[b].t), top = ids.length ? best[ids[0]].t : 0;
  return `<section class="card"><h2>Fastest of the test</h2>${ids.length ? `<div class="scroll-x"><table class="data compact timing"><thead><tr><th>P</th><th>Driver</th><th class="num">Best</th><th class="num">Gap</th><th class="num">Day</th></tr></thead><tbody>${ids.map((id, i) => { const e = ents.find(x => x.id === id) || {};
      return `<tr class="${e.charId ? 'me' : ''}"><td>${i + 1}</td><td><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span>${esc(e.name || id)}${e.charId ? ' <span class="tag player">Player</span>' : ''}</td><td class="num">${f1Fmt(best[id].t)}</td><td class="num">${i ? '+' + (best[id].t - top).toFixed(3) : ''}</td><td class="num">${best[id].day}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">No days were run.</p>'}
      <p class="muted small">Testing doesn’t count for the championship. Times depend on fuel, tyres and programme, so read them with care.</p></section>
    ${days.slice().reverse().map(s => `<details class="card"><summary><b>${esc(sessionName(w, s.n))}</b></summary><div class="scroll-x">${timesheetHtml(w, s)}</div></details>`).join('')}`;
}
/* The stage strip for testing: the three days, then done. */
const _lvStagesTest = lvStagesHtml;
lvStagesHtml = function (w) {
  if (w.session !== 'test') return _lvStagesTest(w);
  const done = endedSessions(w).length, cur = w.status === 'finished' ? sessionsOf(w) + 1 : done + 1;
  const items = [...Array(sessionsOf(w)).keys()].map(i => `Day ${i + 1}`).concat(['Done']);
  const strip = `<ol class="stages" aria-label="Testing">${items.map((l, i) => `<li class="${i + 1 < cur ? 'done' : i + 1 === cur ? 'now' : ''}">${esc(l)}</li>`).join('')}</ol>`;
  const b = exportButtonHtml(w); return b ? `<div class="stages-row">${strip}${b}</div>` : strip;
};

/* =====================================================================
   F1 SIM — the calendar.
   Every round of the season for the series being shown, with testing
   first: done (podium, pole, Driver of the Day), happening now, next, or
   still to come (the circuit, and who won there last time). Clicking a
   round that has happened opens that weekend in full. Race Control can
   give each round a date.
   ===================================================================== */
'use strict';

const roundDate = (s, trackId) => ((s.dates || {})[trackId]) || '';
const fmtDay = d => { try { return new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); } catch (e) { return d; } };
ACTIONS['cal-open'] = d => { const w = get('f1_weekends', d.id); if (!w) return; S.ui.f1view = w.status === 'finished' ? w.id : null; go('weekend'); };
ACTIONS['cal-filter'] = d => { S.ui.calFilter = d.f; render(); };
ACTIONS['cal-dates-save'] = () => {
  const s = curSeries(), f = S.ui.form.calDates || {}, dates = Object.assign({}, s.dates || {});
  Object.keys(f).forEach(k => { if (f[k]) dates[k] = f[k]; else delete dates[k]; });
  run(async () => { await Data.put('f1_series', s.id, Object.assign(get('f1_series', s.id) ? clone(S.store.f1_series[s.id]) : { template: s.id, activeSeason: curSeasonId() }, { dates })); S.ui.form.calDates = null; S.ui.calEdit = false; }, 'Dates saved.');
};
ACTIONS['cal-edit'] = () => { S.ui.calEdit = !S.ui.calEdit; render(); };

function podiumLine(w) {
  const rs = (w.results || []).filter(r => r.position && r.position <= 3).sort((a, b) => a.position - b.position);
  return rs.map(r => `<li><span class="cal-pos">${r.position}</span><span class="f1-bar" style="background:${esc(f1Colour(r.teamId))}"></span>${esc(r.name)}${r.charId ? ' <span class="tag player">Player</span>' : ''}</li>`).join('');
}
function lastTimeHere(s, trackId) {
  const w = list('f1_weekends').filter(x => wSeries(x) === s.id && x.trackId === trackId && x.session === 'gp' && x.status === 'finished' && wSeason(x) !== curSeasonId())
    .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))[0];
  if (!w) return '';
  const win = (w.results || [])[0], season = seasonDoc(wSeason(w));
  return win ? `Last time here (${esc(season.name)}): ${esc(win.name)} won.` : '';
}
route('calendar', 'Calendar', function () {
  const s = curSeries(), season = curSeason(), tracks = F1.tracks(), ws = F1.weekends(), filter = S.ui.calFilter || 'all';
  if (!tracks.length) return `<div class="page-head"><div><h1>Calendar</h1><p>${esc(s.name)} has no circuits yet.</p></div></div>`;
  const byTrack = id => ws.filter(w => w.trackId === id && w.session !== 'test').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const doneGp = id => byTrack(id).find(w => w.session === 'gp' && w.status === 'finished');
  const nextId = (tracks.find(t => !doneGp(t.id) && !byTrack(t.id).some(w => w.status !== 'finished')) || {}).id;
  const tests = ws.filter(w => w.session === 'test').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const edit = S.isGm && S.ui.calEdit, df = S.ui.form.calDates = S.ui.form.calDates || {};
  const done = tracks.filter(t => doneGp(t.id)).length;
  const cards = tracks.map(t => {
    const wk = byTrack(t.id), gp = wk.find(w => w.session === 'gp'), sprint = wk.find(w => w.session === 'sprint'), live = wk.find(w => w.status !== 'finished');
    const state = live ? 'live' : gp && gp.status === 'finished' ? 'done' : t.id === nextId ? 'next' : 'later';
    if (filter === 'done' && state !== 'done') return ''; if (filter === 'tocome' && state === 'done') return '';
    const pole = gp && gp.quali && gp.quali.grid ? (gp.entrants || []).find(e => e.id === gp.quali.grid[0]) : null, dotd = gp ? dotdWinner(gp) : null;
    const date = roundDate(s, t.id);
    return `<article class="cal-card ${state}" style="--team:${esc(state === 'done' ? f1Colour(((gp.results || [])[0] || {}).teamId) : 'var(--line)')}">
      <header><span class="cal-round">Round ${esc(t.round)}</span>${state === 'live' ? '<span class="tag live">On now</span>' : state === 'next' ? '<span class="tag open">Next</span>' : state === 'done' ? '<span class="tag">Done</span>' : ''}</header>
      <h2>${esc(t.flag || '')} ${esc(t.name)}</h2>
      <p class="muted small">${esc(t.circuit || '')}. ${t.laps} laps${t.hasSprint ? ', with a sprint' : ''}.${date ? ` ${esc(fmtDay(date))}.` : ''}</p>
      ${edit ? `<label class="field small">Date<input type="date" data-bind="ui/form/calDates/${esc(t.id)}" value="${esc(df[t.id] != null ? df[t.id] : date)}"></label>` : ''}
      ${state === 'done' ? `<ol class="cal-podium">${podiumLine(gp)}</ol><p class="small muted">${pole ? `Pole: ${esc(pole.name)}. ` : ''}${dotd && !votingOpen(gp) ? `Driver of the Day: ${esc((F1.person(dotd.personId) || {}).name || '')}.` : ''}</p>` : ''}
      ${state === 'live' ? `<p class="small">${live.status === 'practice' ? 'Practice is running.' : live.status === 'quali' ? 'Qualifying is running.' : live.state && live.state.lap ? `Race: lap ${live.state.lap} of ${live.state.laps}.` : 'The grid is set.'}</p>` : ''}
      ${state === 'next' || state === 'later' ? `<p class="small muted">${esc(String(t.type || '').replace('-', ' ').replace(/^./, c => c.toUpperCase()))} circuit, ${Math.round((t.wr || 0) * 0.6)}% chance of rain. ${lastTimeHere(s, t.id)}</p>` : ''}
      <div class="btn-row">${sprint ? `<button class="btn small" data-act="cal-open" data-id="${esc(sprint.id)}">Sprint</button>` : ''}${gp ? `<button class="btn small ${state === 'done' ? 'primary' : ''}" data-act="cal-open" data-id="${esc(gp.id)}">${gp.status === 'finished' ? 'What happened' : 'Go to the weekend'}</button>` : ''}</div>
    </article>`;
  }).join('');
  const testCards = tests.map(w => { const t = get('f1_tracks', w.trackId) || {};
    return `<article class="cal-card test ${w.status === 'finished' ? 'done' : 'live'}"><header><span class="cal-round">Testing</span>${w.status === 'finished' ? '<span class="tag">Done</span>' : '<span class="tag live">On now</span>'}</header>
      <h2>${esc(t.flag || '')} Pre-season testing</h2><p class="muted small">${esc(t.circuit || t.name || '')}. ${plural(endedSessions(w).length, 'day')} run.</p>
      <div class="btn-row"><button class="btn small ${w.status === 'finished' ? 'primary' : ''}" data-act="cal-open" data-id="${esc(w.id)}">${w.status === 'finished' ? 'See the timesheets' : 'Go to testing'}</button></div></article>`; }).join('');
  return `<div class="page-head"><div><p class="eyebrow">${esc(s.name)}, ${esc(season.name)} season</p><h1>Calendar</h1><p>${done} of ${plural(tracks.length, 'round')} done. Pick a round to see what happened.</p></div>
      <div class="btn-row"><button class="btn" data-act="share-open" data-kind="calendar">Export calendar</button><div class="seg" role="tablist" aria-label="Show">${[['all', 'All rounds'], ['done', 'Done'], ['tocome', 'To come']].map(([k, l]) => `<button role="tab" aria-selected="${filter === k}" data-act="cal-filter" data-f="${k}">${l}</button>`).join('')}</div>
      ${S.isGm ? (edit ? '<button class="btn primary" data-act="cal-dates-save">Save the dates</button><button class="btn" data-act="cal-edit">Cancel</button>' : '<button class="btn" data-act="cal-edit">Set dates</button>') : ''}</div></div>
    <div class="cal-grid">${filter !== 'done' || tests.some(w => w.status === 'finished') ? testCards : ''}${cards || '<div class="empty">Nothing here yet.</div>'}</div>`;
});

/* =====================================================================
   F1 SIM — the race report.
   Everything that happened in a weekend, for writing it up: each
   practice (or testing) session with its conditions, incidents,
   timesheet and the players' runs; qualifying session by session; and
   the race lap by lap, with every car's position, gap, lap time, tyre and
   stops, the weather and every event. Three formats: .txt (readable),
   .json (complete data) and .csv (one row per car per lap, plus events).
   ===================================================================== */
'use strict';

const TRACK_WORD = ['dry', 'damp', 'wet'];
function entInfo(w) { const ents = w.entrants || f1Entrants(); return id => { const e = ents.find(x => x.id === id) || { id, name: id }; return { code: id, name: e.name || id, team: (get('f1_teams', e.teamId) || {}).name || '', player: !!e.charId }; }; }
function buildReport(w) {
  const t = get('f1_tracks', w.trackId) || {}, s = seriesDoc(wSeries(w)), who = entInfo(w), st = w.state;
  const rep = { league: 'F1 SIM', series: s.name, season: seasonDoc(wSeason(w)).name, round: (F1.track(w.trackId) || {}).round || null, event: t.name || w.trackId, circuit: t.circuit || '',
    session: w.session === 'test' ? 'Pre-season testing' : w.session === 'sprint' ? 'Sprint' : 'Grand Prix', official: raceSettings(w).lock !== false, practice: [], qualifying: null, race: null };
  /* Practice or testing. */
  endedSessions(w).forEach(sess => {
    const rows = exportRows(w, `fp${sess.n}`);
    const runs = list('f1_runs').filter(r => r.weekendId === w.id && (r.session || 1) === sess.n).sort((a, b) => String(a.at).localeCompare(String(b.at))).map(r => {
      const e = (w.entrants || f1Entrants()).find(x => x.id === r.carId), x = e ? f1RunResult(w, Object.assign({}, e, { v3: (f1Entrants().find(z => z.id === e.id) || {}).v3 }), r) : {};
      return { car: r.carId, by: (get('characters', r.charId) || {}).name || '', kind: r.kind === 'setup' ? 'Set-up run' : r.kind === 'long' ? 'Long run' : 'Qualifying simulation',
        dials: r.kind === 'setup' ? r.dials : undefined, tyre: r.kind === 'long' ? r.compound : undefined, lost: x.lost || undefined, conditions: x.cond || undefined,
        lap: x.lap ? f1Fmt(x.lap) : undefined, tyreLife: x.life || undefined, feedback: x.notes || undefined };
    });
    rep.practice.push({ name: sessionName(w, sess.n), conditions: sess.weather ? weatherText(sess.weather) : 'Dry throughout.', incidents: (sess.events || []).map(e => e.text),
      timesheet: rows.map(r => ({ pos: r.pos, code: r.code, driver: r.name, team: r.team, time: r.value })), runs });
  });
  /* Qualifying. */
  if (w.quali && w.quali.results) {
    const stages = exportStages(w).filter(x => /^q/.test(x[0]));
    rep.qualifying = { stages: stages.map(([k, label]) => ({ name: label, results: exportRows(w, k).map(r => ({ pos: r.pos, code: r.code, driver: r.name, team: r.team, time: r.value })) })),
      penalties: Object.keys(w.penalties || {}).map(id => `${id}: ${w.penalties[id].places}-place grid penalty, ${w.penalties[id].reason}`),
      grid: (w.quali.grid || []).map((id, i) => Object.assign({ pos: i + 1 }, who(id))) };
  }
  /* The race, lap by lap. */
  if (st && st.lap > 0) {
    const cars = st.cars, cum = {}, laps = [];
    cars.forEach(c => { cum[c.id] = ((c.grid || 1) - 1) * 0.25; });   /* the grid stagger the race starts from */
    const tyreAt = (c, L) => (c.stints || []).find(x => x.from <= L && (x.to == null || x.to >= L)) || {};
    for (let L = 1; L <= st.lap; L++) {
      cars.forEach(c => { if (c.lapTimes[L - 1] != null && (c.status === 'running' || (c.retiredLap || 999) >= L)) cum[c.id] += c.lapTimes[L - 1]; });
      const running = cars.filter(c => c.positions[L - 1] != null).sort((a, b) => a.positions[L - 1] - b.positions[L - 1]), lead = running[0];
      laps.push({ lap: L, track: TRACK_WORD[st.track[L - 1] || 0], events: st.events.filter(e => e.lap === L).map(e => e.text),
        order: running.map(c => { const out = c.status !== 'running' && c.retiredLap != null && c.retiredLap < L, ty = tyreAt(c, L), stint = (c.stints || []).indexOf(ty);
          return { pos: c.positions[L - 1], code: c.id, driver: who(c.id).name, team: who(c.id).team, status: out ? 'out' : 'running',
            lapTime: out ? null : (c.lapTimes[L - 1] != null ? f1Fmt(c.lapTimes[L - 1]) : null), gap: out ? null : c === lead ? 0 : Math.round((cum[c.id] - cum[lead.id]) * 10) / 10,
            tyre: ty.compound || null, tyreAge: ty.from ? L - ty.from + 1 : null, pitted: !!(ty.to === L && stint < c.stints.length - 1) }; }) });
    }
    rep.race = { laps: st.laps, lapsRun: st.lap, finished: !!st.finished, lapsByLap: laps,
      result: (w.results || []).map(r => ({ pos: r.position || null, code: r.id, driver: r.name, team: (get('f1_teams', r.teamId) || {}).name || '', grid: r.grid, stops: r.stops, time: r.position === 1 ? fmtRaceTime(r.time || 0) : (r.gap || ''), points: r.points || 0, status: r.position ? 'finished' : (r.gap || 'out') })) };
  }
  return rep;
}
function reportTxt(rep) {
  const L = [], line = (s = '') => L.push(s), hr = () => line('-'.repeat(72));
  line(`${rep.league}: ${rep.series}, ${rep.season} season`); line(`${rep.round ? `Round ${rep.round}: ` : ''}${rep.event}${rep.session === 'Grand Prix' ? '' : ', ' + rep.session.toLowerCase()}`); line(rep.circuit); hr();
  rep.practice.forEach(p => { line(); line(p.name.toUpperCase() === p.name ? p.name : p.name); line(`Conditions: ${p.conditions}`);
    if (p.incidents.length) { line('Incidents:'); p.incidents.forEach(i => line(`  - ${i}`)); }
    line('Timesheet:'); p.timesheet.forEach(r => line(`  ${String(r.pos).padStart(2)}. ${r.code.padEnd(4)} ${r.driver.padEnd(22)} ${r.team.padEnd(16)} ${r.time}`));
    if (p.runs.length) { line('Players’ runs:'); p.runs.forEach(r => { line(`  ${r.car} (${r.by}): ${r.kind}${r.dials ? ` with downforce ${r.dials.wing}, suspension ${r.dials.susp}, differential ${r.dials.diff}` : ''}${r.tyre ? ` on ${r.tyre}s` : ''}.${r.lost ? ' Lost: ' + r.lost : ''}${r.lap ? ` ${r.lap}` : ''}${r.tyreLife ? `, tyres last about ${r.tyreLife} laps` : ''}${r.conditions && r.conditions !== 'dry' ? ` (${r.conditions} track)` : ''}`); (r.feedback || []).forEach(f => line(`      ${f}`)); }); }
    hr(); });
  if (rep.qualifying) { line(); line('QUALIFYING'); rep.qualifying.stages.forEach(q => { line(q.name + ':'); q.results.forEach(r => line(`  ${String(r.pos).padStart(2)}. ${r.code.padEnd(4)} ${r.driver.padEnd(22)} ${r.team.padEnd(16)} ${r.time}`)); });
    if (rep.qualifying.penalties.length) { line('Penalties:'); rep.qualifying.penalties.forEach(p => line(`  - ${p}`)); }
    line('Starting grid: ' + rep.qualifying.grid.map(g => `${g.pos} ${g.code}`).join(', ')); hr(); }
  if (rep.race) { line(); line(`THE RACE: ${rep.race.lapsRun} of ${rep.race.laps} laps${rep.race.finished ? '' : ' (still running)'}`);
    rep.race.lapsByLap.forEach(l => { line(); line(`Lap ${l.lap} (${l.track} track)`);
      l.events.forEach(e => line(`  * ${e}`));
      line('  ' + l.order.map(o => o.status === 'out' ? `${o.code} out` : `${o.pos}. ${o.code}${o.pos === 1 ? '' : ' +' + o.gap}${o.pitted ? ' (pitted)' : ''}`).join(' | '));
      line('  Laps and tyres: ' + l.order.filter(o => o.status !== 'out').map(o => `${o.code} ${o.lapTime || ''} ${o.tyre ? o.tyre.charAt(0).toUpperCase() + o.tyreAge : ''}`).join(', ')); });
    if (rep.race.result.length) { hr(); line('RESULT'); rep.race.result.forEach(r => line(`  ${r.pos ? String(r.pos).padStart(2) + '.' : 'Out'} ${r.code.padEnd(4)} ${r.driver.padEnd(22)} ${r.team.padEnd(16)} ${r.time.padEnd(12)} from P${r.grid}, ${plural(r.stops || 0, 'stop')}${r.points ? `, ${r.points} pts` : ''}`)); } }
  return L.join('\n') + '\n';
}
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function reportCsv(rep) {
  const rows = [['stage', 'session', 'lap', 'position', 'code', 'driver', 'team', 'time', 'gap_to_leader', 'tyre', 'tyre_age', 'pitted', 'status', 'note']];
  rep.practice.forEach(p => { p.timesheet.forEach(r => rows.push(['practice', p.name, '', r.pos, r.code, r.driver, r.team, r.time, '', '', '', '', '', ''])); p.incidents.forEach(i => rows.push(['practice', p.name, '', '', '', '', '', '', '', '', '', '', '', i]));
    p.runs.forEach(r => rows.push(['practice run', p.name, '', '', r.car, r.by, '', r.lap || '', '', r.tyre || '', '', '', r.lost ? 'lost' : '', `${r.kind}${r.dials ? ` ${r.dials.wing}/${r.dials.susp}/${r.dials.diff}` : ''}${r.lost ? ': ' + r.lost : ''}${r.tyreLife ? `: tyres about ${r.tyreLife} laps` : ''}`])); });
  if (rep.qualifying) rep.qualifying.stages.forEach(q => q.results.forEach(r => rows.push(['qualifying', q.name, '', r.pos, r.code, r.driver, r.team, r.time, '', '', '', '', '', ''])));
  if (rep.race) { rep.race.lapsByLap.forEach(l => { l.order.forEach(o => rows.push(['race', '', l.lap, o.pos, o.code, o.driver, o.team, o.lapTime || '', o.gap == null ? '' : o.gap, o.tyre || '', o.tyreAge || '', o.pitted ? 'yes' : '', o.status, l.track]));
      l.events.forEach(e => rows.push(['race event', '', l.lap, '', '', '', '', '', '', '', '', '', '', e])); });
    rep.race.result.forEach(r => rows.push(['result', '', '', r.pos || '', r.code, r.driver, r.team, r.time, '', '', '', '', r.status, `from P${r.grid}, ${r.stops} stops, ${r.points} pts`])); }
  return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}
ACTIONS['rep-download'] = d => {
  const w = get('f1_weekends', d.id); if (!w) return;
  const rep = buildReport(w), fmt = d.fmt, base = `${w.trackId}-${w.session}-${seasonDoc(wSeason(w)).name}-report`;
  const body = fmt === 'json' ? JSON.stringify(rep, null, 2) : fmt === 'csv' ? reportCsv(rep) : reportTxt(rep);
  const blob = new Blob([body], { type: fmt === 'json' ? 'application/json' : fmt === 'csv' ? 'text/csv' : 'text/plain' }), url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${base}.${fmt}`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`Race report saved as ${base}.${fmt}.`);
};
ACTIONS['rep-open'] = d => { S.ui.rep = { wid: d.id }; openDrawer('rep'); };
DRAWERS.rep = function () {
  const w = get('f1_weekends', (S.ui.rep || {}).wid); if (!w) return '';
  const t = get('f1_tracks', w.trackId) || {}, rep = buildReport(w);
  return `<header><div><h2>Race report</h2><p>${esc(t.name || '')}${w.session === 'sprint' ? ' sprint' : w.session === 'test' ? ' testing' : ''}: everything that happened, for writing it up.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><p>It covers ${[rep.practice.length ? `${plural(rep.practice.length, w.session === 'test' ? 'test day' : 'practice session')} (conditions, incidents, timesheets and the players’ runs)` : '', rep.qualifying ? 'qualifying, session by session' : '', rep.race ? `the race lap by lap, ${rep.race.lapsRun} of ${rep.race.laps} laps (positions, gaps, lap times, tyres, stops, weather and every event)` : ''].filter(Boolean).join('; ') || 'nothing yet'}.</p>
    <div class="rep-formats">
      <button class="btn" data-act="rep-download" data-id="${esc(w.id)}" data-fmt="txt"><b>Text (.txt)</b><span>A readable account, stage by stage and lap by lap.</span></button>
      <button class="btn" data-act="rep-download" data-id="${esc(w.id)}" data-fmt="json"><b>JSON (.json)</b><span>The complete data, for tools and bots.</span></button>
      <button class="btn" data-act="rep-download" data-id="${esc(w.id)}" data-fmt="csv"><b>Spreadsheet (.csv)</b><span>One row per car per lap, plus every event.</span></button>
    </div></div>`;
};
/* The report button sits beside Export timing. */
const _exportBtnRep = exportButtonHtml;
exportButtonHtml = function (w) {
  const a = _exportBtnRep(w), has = w && (endedSessions(w).length || (w.quali && w.quali.results) || (w.state && w.state.lap > 0));
  return (a || '') + (has ? `<button class="btn small" data-act="rep-open" data-id="${esc(w.id)}">Race report</button>` : '');
};
/* On a finished weekend: practice and qualifying as well as the race. */
function weekendStoryHtml(w) {
  const done = endedSessions(w), q = w.quali && w.quali.results ? exportStages(w).filter(x => /^q/.test(x[0])) : [];
  if (!done.length && !q.length) return '';
  return `<section class="card"><h2>The rest of the weekend</h2>
    ${done.map(s => `<details><summary><b>${esc(sessionName(w, s.n))}</b>${s.weather ? ` <span class="muted small">${esc(weatherText(s.weather))}</span>` : ''}</summary><div class="scroll-x">${timesheetHtml(w, s)}</div></details>`).join('')}
    ${q.map(([k, label]) => { const rows = exportRows(w, k); return `<details><summary><b>${esc(label)}</b></summary><table class="data compact"><tbody>${rows.map(r => `<tr><td>${r.pos}</td><td><span class="f1-bar" style="background:${esc(r.color)}"></span>${esc(r.name)}</td><td class="num">${esc(r.value)}</td></tr>`).join('')}</tbody></table></details>`; }).join('')}</section>`;
}

/* =====================================================================
   F1 SIM — engines: the era for each season, and the makers.
   Race Control picks a season's engine era: today's 2026 hybrids, the
   2014 to 2025 hybrids, V8s, V10s, V12s, a non-hybrid V6 turbo (as in F2
   and F3) or fully electric. The era changes how races run: lap times,
   how much power matters, the battery and its boost (or none), fuel
   weight, tyre wear, reliability and the power-unit allowance.
   Each engine maker has ratings for power, reliability, efficiency and
   driveability, which feed every car using its engine. A new era
   reshuffles them; Race Control can set them by hand, and move a team to
   another maker for the season.
   ===================================================================== */
'use strict';

const ENGINE_FORMULAS = {
  hybrid26: { label: 'V6 turbo hybrid, 2026 rules', short: 'V6 hybrid', blurb: 'Half the power is electric: how the battery is used wins and loses races.', lap: 0, power: 1, fail: 1, fuel: 3.2, tyre: 1, pu: 4, boost: { cost: 35, bonus: 0.07 }, modeEnergy: null, empty: 0, noHybrid: false, eff: 0.012 },
  hybrid14: { label: 'V6 turbo hybrid, 2014 to 2025', short: 'V6 hybrid', blurb: 'Quicker cars, a smaller electric share, and a cheaper, stronger overtaking boost.', lap: -1.0, power: 1, fail: 1, fuel: 3.0, tyre: 1, pu: 4, boost: { cost: 25, bonus: 0.09 }, modeEnergy: { push: 6, standard: 15, manage: 24 }, empty: 0, noHybrid: false, eff: 0.01 },
  v8: { label: 'V8, 2.4 litres (2006 to 2013)', short: 'V8', blurb: 'Light, screaming and very reliable, with a small battery boost.', lap: -0.7, power: 1.1, fail: 0.7, fuel: 2.6, tyre: 0.92, pu: 8, boost: { cost: 20, bonus: 0.05 }, modeEnergy: { push: 14, standard: 20, manage: 26 }, empty: 0, noHybrid: false, eff: 0.005 },
  v10: { label: 'V10, 3.0 litres', short: 'V10', blurb: 'No hybrid and no boost: raw power matters more, they drink fuel, eat tyres and blow up more often.', lap: -1.2, power: 1.3, fail: 1.5, fuel: 3.6, tyre: 1.1, pu: null, boost: null, modeEnergy: null, empty: 0, noHybrid: true, eff: 0.004 },
  v12: { label: 'V12, 3.5 litres', short: 'V12', blurb: 'Brutal power, thirsty and fragile. No hybrid.', lap: -0.5, power: 1.45, fail: 2.0, fuel: 4.2, tyre: 1.15, pu: null, boost: null, modeEnergy: null, empty: 0, noHybrid: true, eff: 0.006 },
  v6turbo: { label: 'V6 turbo, no hybrid', short: 'V6 turbo', blurb: 'Simple and robust, as in Formula 2 and Formula 3. No battery or boost.', lap: 0, power: 1, fail: 0.9, fuel: 3.0, tyre: 1, pu: null, boost: null, modeEnergy: null, empty: 0, noHybrid: true, eff: 0.004 },
  electric: { label: 'Fully electric', short: 'electric', blurb: 'No fuel weight, but the battery drains as you push. Run it flat and you crawl.', lap: 4.0, power: 0.9, fail: 0.8, fuel: 0, tyre: 0.85, pu: 4, boost: { cost: 20, bonus: 0.06 }, modeEnergy: { push: -9, standard: -3, manage: 5 }, empty: 1.2, noHybrid: false, eff: 0.03 }
};
const ENGINE_ORDER = ['hybrid26', 'hybrid14', 'v8', 'v10', 'v12', 'v6turbo', 'electric'];
const ENGINE_STATS = [['power', 'Power'], ['reliability', 'Reliability'], ['efficiency', 'Efficiency'], ['driveability', 'Driveability']];
const MAKER_2026 = { Mercedes: [90, 88, 88, 86], Ferrari: [89, 85, 86, 87], Honda: [88, 87, 87, 85], 'Red Bull Ford': [87, 83, 88, 86], Audi: [85, 82, 85, 84] };

/* A season's engine set-up: stored on the season, else the series' usual. */
function engineConfig(seriesId, seasonId) {
  const sid = seriesId || curSeriesId(), sea = seasonId || curSeasonId(sid), doc = get('f1_seasons', sea), s = seriesDoc(sid);
  const e = (doc && doc.engine) || {};
  return { formula: ENGINE_FORMULAS[e.formula] ? e.formula : (s.development ? 'hybrid26' : 'v6turbo'), ratings: e.ratings || {}, teams: e.teams || {}, seed: e.seed || 0 };
}
const engineFormula = (sid, sea) => ENGINE_FORMULAS[engineConfig(sid, sea).formula];
function supplierOf(teamId, cfg) { const c = cfg || engineConfig(((get('f1_teams', teamId) || {}).seriesId) || 'f1'); return c.teams[teamId] || (get('f1_teams', teamId) || {}).powerUnit || 'Customer'; }
function makersOf(sid) { const ids = new Set(list('f1_teams').filter(t => (t.seriesId || 'f1') === sid).map(t => supplierOf(t.id, engineConfig(sid)))); return [...ids].sort(); }
/* A maker's ratings: Race Control's, else for the 2026 hybrids today's order, else a fresh order for the era. */
function makerRatings(name, sid, sea) {
  const c = engineConfig(sid, sea);
  if (c.ratings[name]) return Object.assign({ power: 85, reliability: 85, efficiency: 85, driveability: 85 }, c.ratings[name]);
  if (c.formula === 'hybrid26' && MAKER_2026[name]) { const v = MAKER_2026[name]; return { power: v[0], reliability: v[1], efficiency: v[2], driveability: v[3] }; }
  const r = RaceEngine.rng(h32('engine', c.formula, name, c.seed, sea || '')), n = () => 80 + Math.floor(r() * 13);
  return { power: n(), reliability: n(), efficiency: n(), driveability: n() };
}
function engineLabel(teamId) {
  const t = get('f1_teams', teamId) || {}, sid = t.seriesId || 'f1', f = engineFormula(sid), name = supplierOf(teamId, engineConfig(sid));
  return /spec|\(/i.test(name) ? `${name.replace(/\s*\(spec\)/i, '')} ${f.short}, spec` : `${name} ${f.short}`;
}
/* The engine's effect on a car's base numbers (used by every session and Team HQ). */
function engineApply(team, out) {
  const sid = team.seriesId || 'f1', f = engineFormula(sid), m = makerRatings(supplierOf(team.id, engineConfig(sid)), sid);
  out.topSpeed = Math.round(((out.topSpeed || 0) + (m.power - 85) * 0.12 * f.power) * 100) / 100;
  out.carPace = Math.round(((out.carPace || 0) + (m.power - 85) * 0.06 * f.power) * 100) / 100;
  out.reliability = Math.round(((out.reliability || 0) + (m.reliability - 85) * 0.6) * 100) / 100;
  out.tyreLife = Math.round(((out.tyreLife || 0) + (m.driveability - 85) * 0.3) * 100) / 100;
  return out;
}
/* Efficiency: how well the battery and fuel are used, worth more in hybrid and electric eras. */
function engineEfficiency(entrants, entries, w) {
  const sid = wSeries(w), sea = wSeason(w), f = engineFormula(sid, sea), cfg = engineConfig(sid, sea);
  entrants.forEach(e => { const en = entries.find(x => x.id === e.id); if (!en) return; const m = makerRatings(supplierOf(e.teamId, cfg), sid, sea);
    en.paceAdj = (en.paceAdj || 0) - (m.efficiency - 85) * f.eff; });
}
/* The race rules for the era. */
function engineRaceSetup(w, circuit, rules) {
  const f = engineFormula(wSeries(w), wSeason(w));
  circuit.baseLap = (circuit.baseLap || 90) + f.lap;
  circuit.weights = Object.assign({}, circuit.weights || { power: 1, aero: 1, grip: 1 }); circuit.weights.power = (circuit.weights.power || 0) * f.power;
  circuit.tyreStress = (circuit.tyreStress || 1) * f.tyre;
  rules.fuelEffect = f.fuel; rules.failureRate = (rules.failureRate || RaceEngine.DEFAULTS.failureRate) * f.fail;
  rules.noHybrid = !!f.noHybrid; rules.modeEnergy = f.modeEnergy; rules.emptyBattery = f.empty;
  if (f.boost) rules.overtakeMode = Object.assign({}, RaceEngine.DEFAULTS.overtakeMode, f.boost);
  return { circuit, rules };
}

/* ---------------------------------------------------------------- Race Control: the season's engine rules */
async function saveEngine(patch, msg) {
  const sea = curSeasonId(), cur = get('f1_seasons', sea) ? clone(S.store.f1_seasons[sea]) : Object.assign({}, seasonDoc(sea)); delete cur.implicit;
  cur.engine = Object.assign({}, engineConfig(), cur.engine || {}, patch);
  return run(async () => { await Data.put('f1_seasons', sea, cur); await Data.audit('season.engine', msg); }, msg);
}
CHANGES['engine-formula'] = v => {
  if (!ENGINE_FORMULAS[v]) return; const done = finishedGps().length;
  const go2 = () => saveEngine({ formula: v, ratings: {} }, `Engines for ${curSeason().name}: ${ENGINE_FORMULAS[v].label}.`);
  if (done) askConfirm(`${plural(done, 'Grand Prix', 'Grands Prix')} of this season have been run. Change the engines for the rest of it?`, 'Change the engines', go2, true); else go2();
};
ACTIONS['engine-reshuffle'] = () => askConfirm('Give every engine maker a fresh set of ratings for this era?', 'Reshuffle the makers', () => saveEngine({ ratings: {}, seed: (engineConfig().seed || 0) + 1 }, 'Engine makers reshuffled.'));
ACTIONS['engine-save'] = () => {
  const f = S.ui.form.eng || {}, ratings = {}, teams = Object.assign({}, engineConfig().teams);
  Object.keys(f.r || {}).forEach(name => { ratings[name] = Object.assign(makerRatings(name), ...Object.keys(f.r[name]).map(k => ({ [k]: Math.max(50, Math.min(99, Number(f.r[name][k]) || 85)) }))); });
  Object.keys(f.t || {}).forEach(tid => { if (f.t[tid]) teams[tid] = f.t[tid]; });
  saveEngine({ ratings: Object.assign({}, engineConfig().ratings, ratings), teams }, 'Engine rules saved.').then(() => { S.ui.form.eng = null; });
};
function engineCardHtml() {
  const s = curSeries(), cfg = engineConfig(), f = ENGINE_FORMULAS[cfg.formula], makers = makersOf(s.id), rc = S.isGm && curSeason().status !== 'archived';
  const ef = S.ui.form.eng = S.ui.form.eng || { r: {}, t: {} };
  const teams = F1.teams();
  return `<section class="card engine-card"><h2>Engines</h2>
    <p><b>${esc(f.label)}.</b> ${esc(f.blurb)}</p>
    <p class="muted small">${f.noHybrid ? 'No battery or boost.' : f.modeEnergy && f.modeEnergy.standard < 0 ? 'The battery drains as cars race; a flat battery costs over a second a lap.' : 'Battery boost for overtaking.'} ${f.pu ? `${f.pu} power units per car for the season.` : 'No power-unit limit.'} ${f.lap < 0 ? `Laps about ${Math.abs(f.lap).toFixed(1)}s quicker than today’s cars.` : f.lap > 0 ? `Laps about ${f.lap.toFixed(1)}s slower than today’s cars.` : ''}</p>
    ${rc ? `<label class="field" style="max-width:420px">Engine era for ${esc(curSeason().name)}<select id="eng-formula" data-change="engine-formula">${ENGINE_ORDER.map(k => `<option value="${k}" ${cfg.formula === k ? 'selected' : ''}>${esc(ENGINE_FORMULAS[k].label)}</option>`).join('')}</select></label>` : ''}
    <h3>The makers</h3>
    <div class="scroll-x"><table class="data compact"><thead><tr><th>Maker</th><th>Teams</th>${ENGINE_STATS.map(([, l]) => `<th class="num">${l}</th>`).join('')}</tr></thead><tbody>
      ${makers.map(name => { const m = makerRatings(name), users = teams.filter(t => supplierOf(t.id, cfg) === name).map(t => t.name).join(', ');
        return `<tr><td><b>${esc(name)}</b></td><td class="small">${esc(users)}</td>${ENGINE_STATS.map(([k, l]) => `<td class="num">${rc ? `<label class="sr-only" for="eng-${esc(name)}-${k}">${esc(name)} ${l}</label><input id="eng-${esc(name)}-${k}" type="number" min="50" max="99" value="${esc(((ef.r[name] || {})[k]) != null ? ef.r[name][k] : m[k])}" data-bind="ui/form/eng/r/${esc(name)}/${k}" data-type="number" class="eng-num">` : `<b>${m[k]}</b>`}</td>`).join('')}</tr>`; }).join('')}</tbody></table></div>
    <p class="muted small">Power adds top speed and pace (more so in the V10 and V12 eras); reliability cuts failures; efficiency is worth lap time in hybrid and electric eras; driveability is kinder to tyres.</p>
    ${rc ? `<details><summary>Move a team to another maker</summary><div class="form-grid">${teams.map(t => `<label class="field small">${esc(t.name)}<select data-bind="ui/form/eng/t/${esc(t.id)}">${makers.concat(['Mercedes', 'Ferrari', 'Honda', 'Red Bull Ford', 'Audi'].filter(x => makers.indexOf(x) === -1 && s.development)).map(n => `<option ${((ef.t[t.id]) || supplierOf(t.id, cfg)) === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>`).join('')}</div></details>
      <div class="btn-row"><button class="btn primary" data-act="engine-save">Save the engine rules</button><button class="btn" data-act="engine-reshuffle">Reshuffle the makers</button></div>` : ''}</section>`;
}

/* =====================================================================
   F1 SIM — calendar and championship exports.
   Images for Discord in the Carbon look (or light): the season's
   calendar (every round, dates, winners, what's next), the drivers'
   championship (top three as cards, the rest below), the constructors'
   championship (points as bars in team colours), or both championships
   side by side (widescreen). Anyone can download; Race Control can post
   to Discord (DISCORD_WEBHOOK_CALENDAR / DISCORD_WEBHOOK_STANDINGS,
   falling back to the default channel).
   ===================================================================== */
'use strict';

const SHARE_KINDS = [['calendar', 'Calendar'], ['drivers', 'Drivers’ championship'], ['teams', 'Constructors’ championship'], ['both', 'Both championships (widescreen)']];
const slantBar = (g, x, y, w, h, col) => { g.fillStyle = col; g.beginPath(); g.moveTo(x + h, y); g.lineTo(x + w, y); g.lineTo(x + w - h, y + h); g.lineTo(x, y + h); g.closePath(); g.fill(); };
const codeOf = d => (F1.person(d.personId) || {}).abbr || initials(d.name);
function roundsDone() { return F1.weekends().filter(w => w.status === 'finished' && w.session === 'gp').length; }
function shareHeader(g, W, T, logo, title, sub) {
  drawMark(g, 60, 56, T, logo);
  g.font = cond(600, 24); g.fillStyle = T.muted; g.textAlign = 'right'; g.fillText(curSeries().name, W - 60, 80); g.textAlign = 'left';
  g.fillStyle = T.ink; fitText(g, title, s => cond(700, s), 92, W - 120); g.fillText(title, 58, 200);
  slantBar(g, 62, 222, 90, 8, '#E10600');
  g.font = bodyF(500, 24); g.fillStyle = T.muted; g.fillText(sub, 60, 268);
}
function drawCalendar(g, W, H, T) {
  const s = curSeries(), tracks = F1.tracks(), ws = F1.weekends(), dates = s.dates || {};
  const gpOf = id => ws.find(w => w.trackId === id && w.session === 'gp'), live = id => ws.some(w => w.trackId === id && w.session !== 'test' && w.status !== 'finished');
  const nextId = (tracks.find(t => !(gpOf(t.id) && gpOf(t.id).status === 'finished') && !live(t.id)) || {}).id;
  const items = ws.filter(w => w.session === 'test').map(w => ({ test: true, w, t: get('f1_tracks', w.trackId) || {} })).concat(tracks.map(t => ({ t })));
  const per = Math.ceil(items.length / 2), top = 300, rh = Math.min(92, Math.floor((H - top - 70) / Math.max(1, per))), cw = (W - 120 - 24) / 2;
  items.forEach((it, i) => {
    const col = i < per ? 0 : 1, x = 60 + col * (cw + 24), y = top + (i % per) * rh, h = rh - 8, t = it.t;
    const gp = !it.test && gpOf(t.id), done = it.test ? it.w.status === 'finished' : gp && gp.status === 'finished', isLive = it.test ? it.w.status !== 'finished' : live(t.id), isNext = !it.test && t.id === nextId;
    const win = done && !it.test ? (gp.results || [])[0] : null;
    rr(g, x, y, cw, h, 4); g.fillStyle = isNext ? (T.bg === '#E6E9EC' ? '#FDECEC' : '#3A1D20') : T.panel; g.fill();
    g.fillStyle = win ? f1Colour(win.teamId) : isNext || isLive ? '#E10600' : T.line; g.fillRect(x, y, 6, h);
    const fs = Math.min(28, Math.round(h * 0.34));
    g.font = cond(700, Math.round(fs * 0.7)); g.fillStyle = T.muted; g.fillText(it.test ? 'Testing' : `R${t.round}`, x + 20, y + h * 0.42);
    const nameX = x + 20 + (it.test ? 96 : 52);
    g.fillStyle = done ? T.muted : T.ink; g.font = cond(700, fs); const nm = `${t.flag || ''} ${it.test ? 'Pre-season testing' : t.name}`; fitText(g, nm, z => cond(700, z), fs, cw - (nameX - x) - 120); g.fillText(nm, nameX, y + h * 0.44);
    const date = it.test ? '' : dates[t.id] ? fmtDay(dates[t.id]) : '';
    g.font = bodyF(600, Math.round(fs * 0.62)); g.textAlign = 'right'; g.fillStyle = T.muted; if (date) g.fillText(date, x + cw - 16, y + h * 0.42);
    let line2 = '', c2 = T.muted;
    if (win) { line2 = `Winner: ${win.name}`; c2 = T.ink; } else if (isLive) { line2 = 'On now'; c2 = T.bg === '#E6E9EC' ? '#B80500' : '#FF6B63'; } else if (isNext) { line2 = 'Next'; c2 = T.bg === '#E6E9EC' ? '#B80500' : '#FF6B63'; } else if (done && it.test) line2 = 'Done';
    g.textAlign = 'left'; g.font = bodyF(600, Math.round(fs * 0.62)); g.fillStyle = c2; g.fillText(line2 || (t.circuit || ''), nameX, y + h * 0.8);
    if (!it.test && t.hasSprint && s.id === 'f1') { g.textAlign = 'right'; g.fillStyle = T.muted; g.font = bodyF(600, Math.round(fs * 0.55)); g.fillText('Sprint', x + cw - 16, y + h * 0.8); g.textAlign = 'left'; }
  });
}
async function drawDrivers(g, W, H, T, rows, top3imgs) {
  const lead = rows[0] ? rows[0].pts : 0, colW = (W - 120 - 36) / 3, cy = 300, ch = 330;
  rows.slice(0, 3).forEach((d, i) => { const x = 60 + i * (colW + 18);
    rr(g, x, cy, colW, ch, 6); g.fillStyle = T.panel; g.fill(); g.fillStyle = f1Colour(d.teamId); g.fillRect(x, cy, colW, 8);
    drawPhoto(g, top3imgs[i], x + 14, cy + 22, 110, 130, 6, d, T);
    g.fillStyle = i === 0 ? '#E10600' : T.muted; g.font = cond(700, 96); g.textAlign = 'right'; g.fillText(`P${i + 1}`, x + colW - 14, cy + 112); g.textAlign = 'left';
    g.fillStyle = T.ink; fitText(g, d.name, z => cond(700, z), 32, colW - 28); g.fillText(d.name, x + 14, cy + 196);
    g.font = bodyF(500, 18); g.fillStyle = T.muted; g.fillText(F1.team(d.teamId).name || '', x + 14, cy + 224);
    g.fillStyle = T.ink; g.font = cond(700, 64); g.fillText(String(d.pts), x + 14, cy + 300); const pw = g.measureText(String(d.pts)).width;
    g.font = bodyF(600, 20); g.fillStyle = T.muted; g.fillText(i ? `pts, −${lead - d.pts}` : 'pts', x + 22 + pw, cy + 300);
  });
  const rest = rows.slice(3), per = Math.ceil(rest.length / 2), rh = Math.min(40, Math.floor((H - 690 - 60) / Math.max(1, per))), cw = (W - 120 - 36) / 2;
  rest.forEach((d, k) => { const col = k < per ? 0 : 1, x = 60 + col * (cw + 36), y = 680 + (k % per) * rh, fs = Math.min(24, rh - 10);
    g.fillStyle = T.line; g.fillRect(x, y + rh - 1, cw, 1);
    g.fillStyle = T.muted; g.font = cond(700, fs); g.fillText(String(k + 4), x, y + rh - 11);
    g.fillStyle = f1Colour(d.teamId); g.fillRect(x + 42, y + 8, 6, rh - 16);
    g.fillStyle = T.ink; g.font = cond(700, fs); g.fillText(codeOf(d), x + 58, y + rh - 11);
    g.fillStyle = T.muted; g.font = bodyF(500, Math.min(18, rh - 14)); const nm = d.name.length > 18 ? d.name.slice(0, 17) + '…' : d.name; g.fillText(nm, x + 122, y + rh - 12);
    g.fillStyle = T.ink; g.font = cond(700, fs); g.textAlign = 'right'; g.fillText(`${d.pts}`, x + cw, y + rh - 11); g.textAlign = 'left'; });
}
function drawTeams(g, x0, y0, w, h, T, rows) {
  const lead = Math.max(1, rows[0] ? rows[0].pts : 1), rh = Math.min(84, Math.floor(h / Math.max(1, rows.length)));
  rows.forEach((t, i) => { const y = y0 + i * rh, team = F1.team(t.teamId), fs = Math.min(28, Math.round(rh * 0.36));
    g.fillStyle = i === 0 ? '#E10600' : T.muted; g.font = cond(700, fs + 4); g.fillText(String(i + 1), x0, y + rh * 0.62);
    const ny = y + rh * 0.36;
    g.fillStyle = T.ink; g.font = cond(700, fs); g.fillText(team.name || t.teamId, x0 + 52, ny);
    g.fillStyle = T.muted; g.font = bodyF(500, Math.round(fs * 0.6)); g.fillText(`${engineLabel(t.teamId)}${t.wins ? `, ${plural(t.wins, 'win')}` : ''}`, x0 + 52, ny + fs * 0.8);
    const bx = x0 + 52, bw = w - 52 - 110, bh = Math.max(6, Math.round(rh * 0.12)), by = ny + fs * 1.15;
    g.fillStyle = T.line; g.fillRect(bx, by, bw, bh); g.fillStyle = f1Colour(t.teamId); g.fillRect(bx, by, Math.max(2, bw * t.pts / lead), bh);
    g.fillStyle = T.ink; g.font = cond(700, fs + 6); g.textAlign = 'right'; g.fillText(String(t.pts), x0 + w, y + rh * 0.62); g.textAlign = 'left'; });
}
async function drawShare(kind, theme) {
  const T = EXP_THEMES[theme] || EXP_THEMES.dark, st = f1Standings(), done = roundsDone(), total = F1.tracks().length, season = curSeason();
  try { await Promise.all(['700 100px "Titillium Web"', '600 30px "Titillium Web"'].map(f => document.fonts.load(f))); } catch (e) { /* fall back */ }
  const logo = await loadImg(leagueLogo()), wide = kind === 'both', W = wide ? 1920 : 1080, H = wide ? 1080 : 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.fillStyle = T.bg; g.fillRect(0, 0, W, H);
  const after = done ? `After ${done} of ${plural(total, 'round')}.` : 'Before the first round.';
  if (kind === 'calendar') { shareHeader(g, W, T, logo, `${season.name} calendar`, `${plural(total, 'round')}${done ? `, ${done} done` : ''}.`); drawCalendar(g, W, H, T); }
  else if (kind === 'drivers') { shareHeader(g, W, T, logo, 'Drivers’ championship', `${season.name} season. ${after}`);
    const imgs = await Promise.all(st.drivers.slice(0, 3).map(d => loadImg(d.charId ? (get('characters', d.charId) || {}).portraitUrl : null))); await drawDrivers(g, W, H, T, st.drivers, imgs); }
  else if (kind === 'teams') { shareHeader(g, W, T, logo, 'Constructors’ championship', `${season.name} season. ${after}`); drawTeams(g, 60, 310, W - 120, H - 310 - 60, T, st.teams); }
  else {
    drawMark(g, 56, 52, T, logo); g.fillStyle = T.ink; g.font = cond(700, 64); g.fillText(`${season.name} championship`, 56, 160); slantBar(g, 60, 180, 90, 8, '#E10600');
    g.font = bodyF(500, 24); g.fillStyle = T.muted; g.fillText(`${curSeries().name}. ${after}`, 56, 226);
    const lx = 56, lw = 860, top = 270, rh = Math.min(36, Math.floor((H - top - 50) / Math.max(1, st.drivers.length)));
    g.font = cond(700, 30); g.fillStyle = T.ink; g.fillText('Drivers', lx, top - 6); g.fillText('Constructors', 1000, top - 6);
    st.drivers.forEach((d, i) => { const y = top + 8 + i * rh, fs = Math.min(22, rh - 10);
      g.fillStyle = T.line; g.fillRect(lx, y + rh - 1, lw, 1); g.fillStyle = i === 0 ? '#E10600' : T.muted; g.font = cond(700, fs); g.fillText(String(i + 1), lx, y + rh - 10);
      g.fillStyle = f1Colour(d.teamId); g.fillRect(lx + 44, y + 7, 6, rh - 14); g.fillStyle = T.ink; g.font = cond(700, fs); g.fillText(d.name, lx + 62, y + rh - 10);
      g.fillStyle = T.muted; g.font = bodyF(500, Math.min(17, rh - 14)); g.fillText(F1.team(d.teamId).name || '', lx + 420, y + rh - 11);
      g.fillStyle = T.ink; g.font = cond(700, fs); g.textAlign = 'right'; g.fillText(String(d.pts), lx + lw, y + rh - 10); g.textAlign = 'left'; });
    drawTeams(g, 1000, top + 10, W - 1000 - 56, H - top - 60, T, st.teams);
  }
  g.fillStyle = T.muted; g.font = bodyF(500, 17); g.textAlign = 'right'; g.fillText(`Shared from F1 SIM, ${fmtDate(nowIso())}`, W - 60, H - 30); g.textAlign = 'left';
  return new Promise(ok => cv.toBlob(ok, 'image/png'));
}

/* ---------------------------------------------------------------- the export panel */
ACTIONS['share-open'] = d => {
  if (d.kind !== 'calendar' && !f1Standings().drivers.length) { toast('No points yet: standings appear after the first race.', true); return; }
  S.ui.sh = { kind: d.kind, theme: 'dark', url: null, blob: null, channel: '' }; openDrawer('sh'); shRefresh();
  if (S.isGm) discordChannels().then(() => renderOverlay()).catch(() => {});
};
async function shRefresh() {
  const x = S.ui.sh; if (!x) return; const blob = await drawShare(x.kind, x.theme); if (S.ui.sh !== x) return;
  if (x.url) URL.revokeObjectURL(x.url); x.blob = blob; x.url = URL.createObjectURL(blob); renderOverlay();
}
CHANGES['sh-set'] = (v, d) => { const x = S.ui.sh; if (!x) return; x[d.field] = v; if (d.field === 'channel') { renderOverlay(); return; } x.url = null; x.posted = null; renderOverlay(); shRefresh(); };
const sharePurpose = k => k === 'calendar' ? 'calendar' : 'standings';
DRAWERS.sh = function () {
  const x = S.ui.sh || {}, opt = (field, l) => `<select id="sh-${field}" data-change="sh-set" data-field="${field}">${l.map(([k, t]) => `<option value="${k}" ${x[field] === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  return `<header><div><h2>Export</h2><p>${esc(curSeries().name)}, ${esc(curSeason().name)} season. Download it, or post it to Discord.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><div class="form-grid"><label class="field">What${opt('kind', SHARE_KINDS)}</label><label class="field">Look${opt('theme', [['dark', 'Carbon'], ['light', 'Light']])}</label>
      ${S.isGm ? `<label class="field">Discord channel${opt('channel', [['', `Automatic: #${S.discordCh ? pickChannel(sharePurpose(x.kind), curSeriesId(), S.discordCh) : '…'}`]].concat((S.discordCh || []).map(c => [c, '#' + c])))}</label>` : ''}</div>
    ${x.url ? `<img class="card-preview tx-preview" src="${x.url}" alt="The ${esc((SHARE_KINDS.find(k => k[0] === x.kind) || ['', ''])[1])} image">` : '<p class="muted">Drawing…</p>'}
    <div class="btn-row"><button class="btn primary" data-act="sh-download" ${x.url ? '' : 'disabled'}>Download</button>${S.isGm ? `<button class="btn" data-act="sh-discord" ${x.url ? '' : 'disabled'}>Post to Discord</button>` : ''}${x.posted ? `<span class="tag player">Posted to #${esc(x.posted)}</span>` : ''}</div></div>`;
};
ACTIONS['sh-download'] = () => { const x = S.ui.sh; if (!x || !x.url) return; const a = document.createElement('a'); a.href = x.url; a.download = `${curSeriesId()}-${curSeason().name}-${x.kind}.png`; document.body.appendChild(a); a.click(); a.remove(); };
ACTIONS['sh-discord'] = () => {
  const x = S.ui.sh; if (!x || !x.blob) return; const done = roundsDone(), s = curSeries(), sea = curSeason();
  const text = x.kind === 'calendar' ? `**${s.name}: the ${sea.name} calendar**` : `**${s.name} ${sea.name}: ${x.kind === 'teams' ? 'constructors’' : x.kind === 'drivers' ? 'drivers’' : 'the'} championship${done ? ` after round ${done}` : ''}**`;
  run(async () => { const ch = await discordSend(sharePurpose(x.kind), { content: text }, { blob: x.blob, name: `${s.id}-${sea.name}-${x.kind}.png` }, x.channel); x.posted = ch;
    await Data.audit('discord.share', `${text.replace(/\*/g, '')} posted to Discord #${ch}`); }, 'Posted to Discord.');
};

/* =====================================================================
   F1 SIM — race incidents: the reference list.
   Everything that can happen in a race, by family, with how often on the
   usual settings, and how Race Control's three settings scale them.
   ===================================================================== */
'use strict';

const INC_FAMILIES = [
  ['driver', 'Driver errors and crashes', 'Crashes, contact and driver errors', 'More in the rain, on lap 1 and at restarts, in push mode, and for aggressive or rattled drivers.'],
  ['contact', 'Contact between cars', 'Crashes, contact and driver errors', 'Happens when one car attacks another; more in the rain and on lap 1.'],
  ['pileup', 'Pile-ups', 'Crashes, contact and driver errors', 'At the start, and less often at restarts after a safety car; more in the rain.'],
  ['tyre', 'Tyres', 'Crashes, contact and driver errors', 'More at street circuits and on worn tyres.'],
  ['stewards', 'Stewards', 'Crashes, contact and driver errors', 'Penalties are served at the next stop, or added to the race time at the finish.'],
  ['mechanical', 'Mechanical', 'Mechanical failures and pit problems', 'More for less reliable cars and worn power units, and in the V10 and V12 eras; fewer with V8s.'],
  ['pit', 'Pit lane', 'Mechanical failures and pit problems', 'At each pit stop.'],
  ['external', 'Outside events', 'Outside events', 'Race-wide. Cloudbursts only when the weekend’s weather isn’t set to dry.']
];
const incRate = x => x.perRace != null ? (x.perRace >= 1 ? `About ${x.perRace.toFixed(1).replace('.0', '')} a race` : `1 race in ${Math.max(1, Math.round(1 / x.perRace))}`)
  : x.perStop != null ? `${(x.perStop * 100).toFixed(1).replace('.0', '')}% of stops` : `${Math.round(x.perStart * 100)}% of starts`;
ACTIONS['inc-open'] = () => openDrawer('incidents');
DRAWERS.incidents = function () {
  const list = RaceEngine.INCIDENTS || [];
  return `<header><div><h2>What can happen in a race</h2><p>How often each incident happens on the usual settings, in a dry race of about 55 laps with 22 cars. Race Control’s settings scale each group: none, fewer, as usual, more, or chaos.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body">${INC_FAMILIES.map(([fam, title, setting, note]) => { const xs = list.filter(x => x.family === fam); if (!xs.length) return '';
      return `<section class="inc-family"><h3>${esc(title)}</h3><p class="muted small">${esc(note)} Setting: <b>${esc(setting)}</b>.</p>
        <div class="scroll-x"><table class="data compact"><thead><tr><th>Incident</th><th>How often</th><th>What it does</th></tr></thead><tbody>${xs.map(x => `<tr><td><b>${esc(x.label)}</b></td><td class="nowrap">${esc(incRate(x))}</td><td class="small">${esc(x.effect)}</td></tr>`).join('')}</tbody></table></div></section>`; }).join('')}
      <section class="inc-family"><h3>Red flags</h3><p class="small">The race stops. The gaps close up, every car gets fresh tyres and repairs, and the race restarts behind the safety car. A storm in the last quarter ends the race there, and the results stand.</p></section></div>`;
};

/* =====================================================================
   F1 SIM — career records.
   A character's racing CV. On the application, players add seasons in
   other series (Formula 2 and 3, Formula 4, IndyCar, Super Formula,
   Formula E, WEC and Le Mans, IMSA, WRC, DTM and more). Each season waits
   for Race Control, who marks it canon or not canon; titles and wins in
   the top series are flagged as major achievements. Changes after
   approval go back for approval. The character page shows the canon
   record beside their F1 SIM seasons, which are worked out from results.
   ===================================================================== */
'use strict';

const CAREER_GROUPS = [
  ['Single-seaters', ['Formula 1', 'Formula 2', 'Formula 3', 'Formula Regional', 'Formula 4', 'Super Formula', 'Formula E', 'IndyCar', 'Indy NXT', 'Karting']],
  ['Endurance', ['WEC', 'Le Mans 24 Hours', 'IMSA', 'European Le Mans Series', 'GT World Challenge']],
  ['Rally', ['WRC', 'WRC2', 'Dakar']],
  ['Touring', ['DTM', 'BTCC', 'Supercars']],
  ['Other', ['Other']]
];
const MAJOR_SERIES = ['Formula 1', 'Formula 2', 'IndyCar', 'Super Formula', 'Formula E', 'WEC', 'Le Mans 24 Hours', 'IMSA', 'WRC'];
const CAREER_POS = [['', 'Not given'], ['1', 'Champion'], ['2', '2nd'], ['3', '3rd'], ['4', '4th'], ['5', '5th'], ['6', '6th'], ['7', '7th'], ['8', '8th'], ['9', '9th'], ['10', '10th'], ['11', 'Lower than 10th'], ['0', 'Part season']];
const careerGroupOf = series => (CAREER_GROUPS.find(g => g[1].indexOf(series) !== -1) || ['Other'])[0];
const seriesLabel = r => r.series === 'Other' ? (r.other || 'Other') : r.series;
const posLabel = p => (CAREER_POS.find(x => x[0] === String(p)) || ['', ''])[1];
const isMajor = r => MAJOR_SERIES.indexOf(r.series) !== -1 && (String(r.pos) === '1' || Number(r.wins) > 0);
const CAREER_STATUS = { pending: ['Awaiting approval', 'open'], canon: ['Canon', 'player'], notcanon: ['Not canon', 'flag'] };

/* ---------------------------------------------------------------- the player's side */
const careerRows = c => (c && Array.isArray(c.career) ? c.career : []);
const careerEditable = c => !!c && (c.userId === S.uid || S.isGm) && !c.retired;
ACTIONS['cr-add'] = () => { S.ui.form.cr = { id: null, years: '', series: 'Formula 2', other: '', cls: '', team: '', starts: '', wins: '', podiums: '', poles: '', pos: '', notes: '' }; render(); };
ACTIONS['cr-edit'] = d => { const c = get('characters', S.ui.charEdit), r = careerRows(c).find(x => x.id === d.rid); if (r) { S.ui.form.cr = Object.assign({}, r); render(); } };
ACTIONS['cr-cancel'] = () => { S.ui.form.cr = null; render(); };
CHANGES['cr-series'] = v => { if (S.ui.form.cr) { S.ui.form.cr.series = v; render(); } };
const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
ACTIONS['cr-save'] = () => {
  const c = get('characters', S.ui.charEdit), f = S.ui.form.cr; if (!c || !f || !careerEditable(c)) return;
  if (!String(f.years || '').trim()) { toast('Add the year or years, such as 2025 or 2023 to 2024.', true); return; }
  if (f.series === 'Other' && !String(f.other || '').trim()) { toast('Name the series.', true); return; }
  const num = v => v === '' || v == null ? '' : Math.max(0, Math.round(Number(v) || 0));
  const row = { id: f.id || newId('cr'), years: String(f.years).trim().slice(0, 20), series: f.series, other: f.series === 'Other' ? String(f.other).trim().slice(0, 60) : '',
    cls: String(f.cls || '').trim().slice(0, 40), team: String(f.team || '').trim().slice(0, 60), starts: num(f.starts), wins: num(f.wins), podiums: num(f.podiums), poles: num(f.poles),
    pos: String(f.pos || ''), notes: String(f.notes || '').trim().slice(0, 200), status: 'pending', at: nowIso() };
  if (row.wins !== '' && row.starts !== '' && row.wins > row.starts) { toast('More wins than starts: check the numbers.', true); return; }
  const doc = charDoc(c.id), rows = careerRows(doc).filter(x => x.id !== row.id).concat([row]);
  rows.sort((a, b) => String(parseInt(a.years, 10) || 0).localeCompare(String(parseInt(b.years, 10) || 0)) || 0);
  doc.career = rows;
  run(async () => { await Data.put('characters', c.id, doc); S.ui.form.cr = null; }, charStatus(c) === 'approved' ? 'Saved. Race Control will check it before it becomes canon.' : 'Season added.');
};
ACTIONS['cr-remove'] = d => {
  const c = get('characters', S.ui.charEdit); if (!c || !careerEditable(c)) return;
  askConfirm('Remove this season from the career record?', 'Remove', () => run(async () => { const doc = charDoc(c.id); doc.career = careerRows(doc).filter(x => x.id !== d.rid); await Data.put('characters', c.id, doc); }, 'Removed.'), true);
};
function careerFormHtml(f) {
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
  const num = (k, l) => `<label class="field small">${l}<input id="cr-${k}" type="number" min="0" max="999" data-bind="ui/form/cr/${k}" value="${esc(f[k] === '' || f[k] == null ? '' : f[k])}"></label>`;
  return `<div class="career-form card"><h3>${f.id ? 'Edit this season' : 'Add a season'}</h3><div class="form-grid">
      <label class="field">Year or years<input id="cr-years" type="text" data-bind="ui/form/cr/years" value="${esc(f.years || '')}" placeholder="e.g. 2025, or 2023 to 2024"></label>
      <label class="field">Series<select id="cr-series" data-change="cr-series">${CAREER_GROUPS.map(([g, xs]) => `<optgroup label="${esc(g)}">${xs.map(x => opt(x, x === 'Other' ? 'Another series' : x, f.series)).join('')}</optgroup>`).join('')}</select></label>
      ${f.series === 'Other' ? `<label class="field">Which series<input id="cr-other" type="text" data-bind="ui/form/cr/other" value="${esc(f.other || '')}" placeholder="e.g. Super GT"></label>` : ''}
      <label class="field">Class or category (optional)<input id="cr-cls" type="text" data-bind="ui/form/cr/cls" value="${esc(f.cls || '')}" placeholder="${/WEC|Le Mans|IMSA|European/.test(f.series) ? 'e.g. Hypercar, LMP2, LMGT3' : /WRC|Dakar/.test(f.series) ? 'e.g. Rally1, Rally2' : 'e.g. Senior, Rookie'}"></label>
      <label class="field">Team<input id="cr-team" type="text" data-bind="ui/form/cr/team" value="${esc(f.team || '')}"></label>
      ${num('starts', /WRC|Dakar/.test(f.series) ? 'Rallies' : 'Starts')}${num('wins', 'Wins')}${num('podiums', 'Podiums')}${num('poles', /WRC|Dakar/.test(f.series) ? 'Stage wins' : 'Poles')}
      <label class="field">Championship<select id="cr-pos" data-bind="ui/form/cr/pos">${CAREER_POS.map(([v, l]) => opt(v, l, f.pos)).join('')}</select></label></div>
    <label class="field">Notes (optional)<input id="cr-notes" type="text" data-bind="ui/form/cr/notes" value="${esc(f.notes || '')}" placeholder="e.g. Class win at Le Mans; rookie of the year"></label>
    <p class="muted small">Titles and wins in the top series count as major achievements: they only become canon once Race Control approves them.</p>
    <div class="btn-row"><button class="btn primary" data-act="cr-save">${f.id ? 'Save the season' : 'Add the season'}</button><button class="btn ghost" data-act="cr-cancel">Cancel</button></div></div>`;
}
/* The career record card on the application page. */
function careerAppHtml(c) {
  const rows = careerRows(c), can = careerEditable(c), f = S.ui.form.cr;
  return `<section class="card"><h2>Career record</h2>
    <p class="muted small">Seasons before F1 SIM, in any series: single-seaters, endurance, rally, touring and more. Each season waits for Race Control; only canon seasons show on the character page.</p>
    ${rows.length ? careerTableHtml(rows, { manage: can, review: false }) : '<p class="muted">No seasons added yet.</p>'}
    ${can ? (f ? careerFormHtml(f) : '<div class="btn-row"><button class="btn" data-act="cr-add">Add a season</button></div>') : ''}</section>`;
}
function careerTableHtml(rows, o) {
  const opts = o || {}, cell = v => v === '' || v == null ? '<span class="muted">–</span>' : esc(v);
  return `<div class="scroll-x"><table class="data compact career"><thead><tr><th>Years</th><th>Series</th><th>Team</th><th class="num">Starts</th><th class="num">Wins</th><th class="num">Podiums</th><th class="num">Poles</th><th>Championship</th>${opts.status !== false ? '<th></th>' : ''}${opts.manage || opts.review ? '<th></th>' : ''}</tr></thead><tbody>
    ${rows.map(r => { const st = CAREER_STATUS[r.status || 'pending'] || CAREER_STATUS.pending;
      return `<tr><td>${esc(r.years)}</td><td><b>${esc(seriesLabel(r))}</b>${r.cls ? ` <span class="muted small">${esc(r.cls)}</span>` : ''}${r.notes ? `<div class="muted small">${esc(r.notes)}</div>` : ''}</td><td>${cell(r.team)}</td>
        <td class="num">${cell(r.starts)}</td><td class="num">${cell(r.wins)}</td><td class="num">${cell(r.podiums)}</td><td class="num">${cell(r.poles)}</td><td>${String(r.pos) === '1' ? '<span class="tag trophy">Champion</span>' : r.pos ? esc(posLabel(r.pos)) : '<span class="muted">–</span>'}</td>
        ${opts.status !== false ? `<td>${isMajor(r) && r.status !== 'canon' ? '<span class="tag flag">Major achievement</span> ' : ''}<span class="tag ${st[1]}">${st[0]}</span></td>` : ''}
        ${opts.manage ? `<td class="nowrap"><button class="btn small" data-act="cr-edit" data-rid="${esc(r.id)}">Edit</button> <button class="btn small ghost" data-act="cr-remove" data-rid="${esc(r.id)}">Remove</button></td>` : ''}
        ${opts.review ? `<td class="nowrap"><button class="btn small ${r.status === 'canon' ? 'primary' : ''}" data-act="cr-judge" data-cid="${esc(opts.review)}" data-rid="${esc(r.id)}" data-v="canon" aria-pressed="${r.status === 'canon'}">Canon</button> <button class="btn small ${r.status === 'notcanon' ? 'primary' : ''}" data-act="cr-judge" data-cid="${esc(opts.review)}" data-rid="${esc(r.id)}" data-v="notcanon" aria-pressed="${r.status === 'notcanon'}">Not canon</button></td>` : ''}</tr>`; }).join('')}</tbody></table></div>`;
}

/* ---------------------------------------------------------------- Race Control's side */
ACTIONS['cr-judge'] = d => {
  if (!S.isGm) return; const c = get('characters', d.cid); if (!c) return;
  const doc = charDoc(c.id); doc.career = careerRows(doc).map(r => r.id === d.rid ? Object.assign({}, r, { status: d.v, judgedAt: nowIso() }) : r);
  const r = careerRows(c).find(x => x.id === d.rid) || {};
  run(async () => { await Data.put('characters', c.id, doc); await Data.audit('career.judge', `${c.name}: ${r.years} ${seriesLabel(r)} marked ${d.v === 'canon' ? 'canon' : 'not canon'}`); });
};
/* Approving a character makes any seasons still waiting canon (Race Control marks the ones it won't accept first). */
const _genApproveCareer = ACTIONS['gen-approve'];
ACTIONS['gen-approve'] = d => {
  const c = get('characters', d.id);
  if (c && careerRows(c).some(r => (r.status || 'pending') === 'pending')) {
    const doc = charDoc(c.id); doc.career = careerRows(doc).map(r => (r.status || 'pending') === 'pending' ? Object.assign({}, r, { status: 'canon', judgedAt: nowIso() }) : r);
    Data.put('characters', c.id, doc).then(() => _genApproveCareer(d)).catch(e => toast(e.message || String(e), true));
    return;
  }
  _genApproveCareer(d);
};
/* Approved characters with new or changed seasons. */
function careerQueueHtml() {
  const waiting = list('characters').filter(c => !c.retired && charStatus(c) === 'approved' && careerRows(c).some(r => (r.status || 'pending') === 'pending'));
  if (!waiting.length) return '';
  return `<section><h2 class="section-h">Career record changes <span class="count">${waiting.length}</span></h2>
    ${waiting.map(c => `<article class="card"><h3>${esc(c.name)}</h3><p class="muted small">${esc(charRoleName(c.role))}. New or changed seasons are awaiting approval.</p>${careerTableHtml(careerRows(c), { review: c.id })}</article>`).join('')}</section>`;
}

/* ---------------------------------------------------------------- the character page */
/* F1 SIM seasons from the results: one row per series and season. */
function simSeasons(personId) {
  const by = new Map();
  f1Record(personId).forEach(x => { const k = wSeries(x.w) + '|' + wSeason(x.w), o = by.get(k) || { sid: wSeries(x.w), sea: wSeason(x.w), starts: 0, wins: 0, podiums: 0, poles: 0, pts: 0, team: x.r.teamId };
    o.pts += x.r.points || 0; o.team = x.r.teamId;
    if (x.w.session === 'gp') { o.starts += 1; if (x.r.position === 1) o.wins += 1; if (x.r.position && x.r.position <= 3) o.podiums += 1; if (x.pole) o.poles += 1; }
    by.set(k, o); });
  return [...by.values()].map(o => {
    const tally = new Map();
    list('f1_weekends').filter(w => w.status === 'finished' && wSeries(w) === o.sid && wSeason(w) === o.sea).forEach(w => (w.results || []).forEach(r => {
      const t = tally.get(r.personId) || { pts: 0, wins: 0 }; t.pts += r.points || 0; if (w.session !== 'sprint' && r.position === 1) t.wins += 1; tally.set(r.personId, t); }));
    const order = [...tally.entries()].sort((a, b) => b[1].pts - a[1].pts || b[1].wins - a[1].wins).map(e => e[0]);
    const sd = seasonDoc(o.sea);
    return Object.assign(o, { pos: order.indexOf(personId) + 1, done: sd.status === 'archived', seasonName: sd.name, seriesName: seriesDoc(o.sid).name });
  }).sort((a, b) => String(a.seasonName).localeCompare(String(b.seasonName)));
}
function careerRecordHtml(p, c) {
  const sim = (p && (p.kind === 'driver' || !p.kind)) ? simSeasons(p.id) : [];
  const own = !!(c && (c.userId === S.uid || S.isGm));
  const rows = careerRows(c).filter(r => r.status === 'canon' || own);
  if (!sim.length && !rows.length) return own && c && c.role === 'driver' ? `<section class="card career-record"><h2>Career record</h2><p class="muted">No seasons yet. Add their career before F1 SIM on the application page.</p><div class="btn-row"><button class="btn" data-act="char-open" data-id="${esc(c.id)}">Add a season</button></div></section>` : '';
  const canon = rows.filter(r => r.status === 'canon');
  const titles = canon.filter(r => String(r.pos) === '1').length + sim.filter(o => o.done && o.pos === 1).length;
  const sum = k => canon.reduce((s, r) => s + (Number(r[k]) || 0), 0) + sim.reduce((s, o) => s + (o[k] || 0), 0);
  const groups = CAREER_GROUPS.map(([g]) => [g, rows.filter(r => careerGroupOf(r.series) === g)]).filter(x => x[1].length);
  return `<section class="card career-record"><h2>Career record</h2>
    <div class="metrics"><div class="metric"><b>${titles}</b><span>${titles === 1 ? 'Title' : 'Titles'}</span></div><div class="metric"><b>${sum('starts')}</b><span>Starts</span></div><div class="metric"><b>${sum('wins')}</b><span>Wins</span></div><div class="metric"><b>${sum('podiums')}</b><span>Podiums</span></div><div class="metric"><b>${sum('poles')}</b><span>Poles</span></div></div>
    ${sim.length ? `<h3>F1 SIM</h3><div class="scroll-x"><table class="data compact career"><thead><tr><th>Season</th><th>Series</th><th>Team</th><th class="num">Starts</th><th class="num">Wins</th><th class="num">Podiums</th><th class="num">Poles</th><th class="num">Points</th><th>Championship</th></tr></thead><tbody>
      ${sim.map(o => `<tr><td>${esc(o.seasonName)}</td><td><b>${esc(o.seriesName)}</b></td><td><span class="f1-bar" style="background:${esc(f1Colour(o.team))}"></span>${esc((F1.team(o.team) || {}).name || '')}</td><td class="num">${o.starts}</td><td class="num">${o.wins}</td><td class="num">${o.podiums}</td><td class="num">${o.poles}</td><td class="num"><b>${o.pts}</b></td>
        <td>${o.done && o.pos === 1 ? '<span class="tag trophy">Champion</span>' : o.pos ? `${ordinal(o.pos)}${o.done ? '' : ' <span class="muted small">so far</span>'}` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${groups.map(([g, rs]) => `<h3>${esc(g)}</h3>${careerTableHtml(rs, { status: own })}`).join('')}
    ${own && rows.some(r => r.status !== 'canon') ? '<p class="muted small">Only you and Race Control see seasons that aren’t canon yet.</p>' : ''}</section>`;
}
ACTIONS['char-open'] = d => { S.ui.charEdit = d.id; go('character'); };

/* Race Control's queue also lists approved characters with seasons to check. */
const _chargenQueueCareer = chargenQueueHtml;
chargenQueueHtml = function () { return _chargenQueueCareer() + careerQueueHtml(); };

/* =====================================================================
   F1 SIM — character sheet exports and the acceptance post.
   Any character's sheet can be exported as a photo card (in the style of
   the driver cards) or as a Word file laid out to open in Google Docs.
   When Race Control approves a character, the acceptance card is posted
   to Discord, @mentioning the player when the character has their Discord
   user ID (DISCORD_WEBHOOK_APPROVALS, else the default channel).
   ===================================================================== */
'use strict';

const SHEET_KINDS = [['sheet', 'Character sheet'], ['accepted', 'Acceptance card']];
/* Everything the exports need about a character, canon only. */
function sheetData(cid) {
  const c = get('characters', cid); if (!c) return null;
  const pid = f1PcId(c.id), p = F1.person(pid), seat = typeof primarySeat === 'function' ? primarySeat(c.id) : F1.seats().find(s => s.holderCharId === c.id);
  const team = seat ? F1.team(seat.teamId) : null, driver = c.role === 'driver', g = c.gen || {};
  let ratings = null;
  if (driver) ratings = p && p.approved ? f1DevApply(Object.assign({}, F1_ROOKIE, p), c.id) : rolledRatings(c);
  const canon = careerRows(c).filter(r => r.status === 'canon'), sim = p ? simSeasons(pid) : [];
  const titles = canon.filter(r => String(r.pos) === '1').length + sim.filter(o => o.done && o.pos === 1).length;
  const sum = k => canon.reduce((s, r) => s + (Number(r[k]) || 0), 0) + sim.reduce((s, o) => s + (o[k] || 0), 0);
  const rels = list('f1_relations').filter(r => r.personId === pid || r.otherId === pid).map(r => { const other = r.personId === pid ? r.otherId : r.personId;
    return { who: (F1.person(other) || {}).name || other, kind: (typeof REL_KINDS !== 'undefined' ? (REL_KINDS.find(x => x[0] === r.kind) || [r.kind, r.kind])[1] : r.kind), note: r.note || '' }; });
  const diary = list('f1_diary').filter(d => d.charId === c.id).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 3);
  const y = typeof yearsOf === 'function' ? yearsOf(g.years) : null, b = typeof bracketOf === 'function' ? bracketOf(g.bracket) : null;
  const style = ratings && ratings.style ? (F1_STYLES.find(s => s[0] === ratings.style) || ['', ratings.style])[1] : '';
  return { c, p, pid, seat, team, color: team ? team.color : '#E10600', driver, role: charRoleName(c.role), status: charStatus(c), ratings, canon, sim, titles,
    totals: { starts: sum('starts'), wins: sum('wins'), podiums: sum('podiums'), poles: sum('poles') }, rels, diary, style,
    background: b ? b.name : '', years: ratings && ratings.years != null ? `${ratings.years}` : (y ? y.label : ''),
    series: seat ? seriesDoc(seat.seriesId || F1.team(seat.teamId).seriesId || 'f1').name : '' };
}
function wrapLines(g, text, maxW, maxLines) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' '), out = []; let line = '';
  for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { out.push(line); line = w; if (out.length === maxLines) break; } else line = t; }
  if (out.length < maxLines && line) out.push(line);
  if (out.length === maxLines && words.join(' ').length > out.join(' ').length) out[maxLines - 1] = out[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  return out;
}
async function drawCharCard(cid, kind) {
  const d = sheetData(cid); if (!d) return null;
  const { c, color: col } = d, W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
  try { await Promise.all(['700 200px "Titillium Web"', '600 40px "Titillium Web"'].map(f => document.fonts.load(f))); } catch (e) { /* fall back */ }
  const T = EXP_THEMES.dark, img = await loadImg(c.portraitUrl), logo = await loadImg(leagueLogo());
  g.fillStyle = '#1C1D22'; g.fillRect(0, 0, W, H);
  const grad = g.createLinearGradient(0, 0, W * 0.9, H * 0.7); grad.addColorStop(0, col); grad.addColorStop(0.55, '#1C1D22'); g.globalAlpha = 0.85; g.fillStyle = grad; g.fillRect(0, 0, W, H); g.globalAlpha = 1;
  if (c.number) { g.font = cond(700, 620); g.fillStyle = 'rgba(255,255,255,0.06)'; g.textAlign = 'right'; g.fillText(String(c.number), W - 10, 700); g.textAlign = 'left'; }
  drawMark(g, 64, 64, Object.assign({}, T, { ink: '#FFFFFF' }), logo);
  const label = kind === 'accepted' ? 'Welcome to the grid' : 'Character sheet';
  g.font = cond(700, 50); const lw = g.measureText(label).width + 44; g.fillStyle = kind === 'accepted' ? '#E10600' : col; g.beginPath(); g.moveTo(74, 140); g.lineTo(64 + lw + 10, 140); g.lineTo(64 + lw, 210); g.lineTo(64, 210); g.closePath(); g.fill();
  g.fillStyle = '#FFFFFF'; g.fillText(label, 86, 193);
  const parts = String(c.name).split(' '), last = parts.pop(), first = parts.join(' ');
  if (kind === 'accepted') {
    /* Big portrait, the name, the role and seat, and an approved stamp. */
    const px = 240, py = 250, pw = 600, ph = 640;
    drawPhoto(g, img, px, py, pw, ph, 10, { name: c.name }, T);
    const fade = g.createLinearGradient(0, py + ph - 220, 0, py + ph); fade.addColorStop(0, 'rgba(28,29,34,0)'); fade.addColorStop(1, 'rgba(28,29,34,0.95)'); g.fillStyle = fade; g.fillRect(px, py + ph - 220, pw, 220);
    g.save(); g.translate(W - 260, 300); g.rotate(-0.18); g.font = cond(700, 64); const sw = g.measureText('APPROVED').width + 56; g.strokeStyle = '#E10600'; g.lineWidth = 8; g.strokeRect(-sw / 2, -52, sw, 104); g.fillStyle = '#E10600'; g.textAlign = 'center'; g.fillText('APPROVED', 0, 22); g.restore(); g.textAlign = 'left';
    g.fillStyle = '#FFFFFF'; g.font = cond(600, 56); g.textAlign = 'center'; g.fillText(first, W / 2, 980);
    let size = 150; g.font = cond(700, size); while (g.measureText(last.toUpperCase()).width > W - 120 && size > 70) { size -= 6; g.font = cond(700, size); } g.fillText(last.toUpperCase(), W / 2, 980 + size * 0.9);
    g.font = cond(600, 40); g.fillStyle = 'rgba(255,255,255,0.88)';
    const line = d.team ? `${d.role} for ${d.team.name}${d.driver && c.number ? `, car #${c.number}` : ''}` : `${d.role}${d.driver && c.number ? `, car #${c.number}` : ''}`;
    g.fillText(line, W / 2, 1210); g.font = bodyF(500, 28); g.fillStyle = 'rgba(255,255,255,0.7)'; g.fillText(d.team ? (d.series || '') : 'Seat to be confirmed', W / 2, 1258); g.textAlign = 'left';
  } else {
    /* Portrait on the right; name, particulars, ratings, record and story on the left. */
    drawPhoto(g, img, 600, 250, 416, 500, 10, { name: c.name }, T);
    g.fillStyle = '#FFFFFF'; g.font = cond(600, 44); g.fillText(first, 64, 300);
    let size = 120; g.font = cond(700, size); while (g.measureText(last.toUpperCase()).width > 510 && size > 56) { size -= 6; g.font = cond(700, size); } g.fillText(last.toUpperCase(), 60, 300 + size * 0.92);
    let y = 300 + size + 40;
    g.font = cond(600, 32); g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillText(d.team ? `${d.role}, ${d.team.name}` : d.role, 64, y); y += 52;
    const facts = [['Nationality', c.nationality], ['From', c.birthplace], d.driver ? ['Car', [c.number ? '#' + c.number : '', c.code].filter(Boolean).join('  ')] : null, d.driver ? ['Years racing', d.years] : null, d.driver ? ['Style', d.style] : null].filter(x => x && x[1]);
    facts.slice(0, 5).forEach(([k, v]) => { g.font = bodyF(500, 24); g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillText(k, 64, y); g.font = bodyF(600, 28); g.fillStyle = '#FFFFFF'; g.fillText(String(v), 230, y); y += 42; });
    let by = 800;
    if (d.ratings) {
      F1_RATINGS.forEach(([k, l], i) => { const v = d.ratings[k]; if (v == null) return; const col2 = i % 2, row = Math.floor(i / 2), x = 64 + col2 * 486, yy = by + row * 70;
        g.font = bodyF(600, 24); g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillText(l, x, yy); g.textAlign = 'right'; g.font = cond(700, 34); g.fillStyle = '#FFFFFF'; g.fillText(String(v), x + 440, yy + 4); g.textAlign = 'left';
        g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(x, yy + 14, 440, 10); g.fillStyle = col; g.fillRect(x, yy + 14, 440 * Math.min(1, v / 100), 10); });
      by += 230;
    }
    const tiles = [['Titles', d.titles], ['Starts', d.totals.starts], ['Wins', d.totals.wins], ['Podiums', d.totals.podiums]];
    tiles.forEach(([k, v], i) => { const x = 64 + i * 238; g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x, by, 220, 100); g.fillStyle = '#FFFFFF'; g.font = cond(700, 52); g.fillText(String(v), x + 18, by + 58); g.font = bodyF(500, 22); g.fillStyle = 'rgba(255,255,255,0.7)'; g.fillText(k, x + 18, by + 88); });
    by += 140;
    if (c.bio && by < H - 120) { g.font = bodyF(400, 26); g.fillStyle = 'rgba(255,255,255,0.85)'; wrapLines(g, c.bio, W - 128, Math.max(1, Math.floor((H - 90 - by) / 36))).forEach((l, i) => g.fillText(l, 64, by + i * 36)); }
  }
  g.fillStyle = col; g.fillRect(0, H - 20, W, 20);
  return new Promise(ok => cv.toBlob(ok, 'image/png'));
}

/* ---------------------------------------------------------------- the Word file for Google Docs */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
/* A plain (stored, uncompressed) zip: no folder entries, which some cloud editors refuse. */
function zipStore(files) {
  const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
  const le = (n, b) => { const a = new Uint8Array(b); for (let i = 0; i < b; i++) a[i] = (n >>> (8 * i)) & 0xFF; return a; };
  files.forEach(f => {
    const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
    const head = [le(0x04034b50, 4), le(20, 2), le(0x0800, 2), le(0, 2), le(0, 2), le(0x21, 2), le(crc, 4), le(data.length, 4), le(data.length, 4), le(name.length, 2), le(0, 2), name];
    const cen = [le(0x02014b50, 4), le(20, 2), le(20, 2), le(0x0800, 2), le(0, 2), le(0, 2), le(0x21, 2), le(crc, 4), le(data.length, 4), le(data.length, 4), le(name.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(offset, 4), name];
    head.concat([data]).forEach(p => { parts.push(p); offset += p.length; }); cen.forEach(p => central.push(p));
  });
  const cenSize = central.reduce((s, p) => s + p.length, 0);
  const end = [le(0x06054b50, 4), le(0, 2), le(0, 2), le(files.length, 2), le(files.length, 2), le(cenSize, 4), le(offset, 4), le(0, 2)];
  const all = parts.concat(central, end), out = new Uint8Array(all.reduce((s, p) => s + p.length, 0)); let o = 0; all.forEach(p => { out.set(p, o); o += p.length; });
  return out;
}
const xe = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hex = c => String(c || '#E10600').replace('#', '').toUpperCase().slice(0, 6);
function docxRun(text, o) { const p = o || {};
  return `<w:r><w:rPr><w:rFonts w:ascii="Titillium Web" w:hAnsi="Titillium Web" w:cs="Titillium Web"/>${p.b ? '<w:b/>' : ''}${p.i ? '<w:i/>' : ''}${p.color ? `<w:color w:val="${p.color}"/>` : ''}<w:sz w:val="${p.sz || 21}"/></w:rPr><w:t xml:space="preserve">${xe(text)}</w:t></w:r>`; }
function docxPara(runs, o) { const p = o || {};
  return `<w:p><w:pPr>${p.style ? `<w:pStyle w:val="${p.style}"/>` : ''}${p.keep ? '<w:keepNext/>' : ''}${p.rule ? `<w:pBdr><w:bottom w:val="single" w:sz="18" w:space="4" w:color="${p.rule}"/></w:pBdr>` : ''}<w:spacing w:before="${p.before || 0}" w:after="${p.after == null ? 100 : p.after}"/>${p.align ? `<w:jc w:val="${p.align}"/>` : ''}</w:pPr>${runs}</w:p>`; }
function docxCell(content, w, o) { const p = o || {};
  return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${p.span ? `<w:gridSpan w:val="${p.span}"/>` : ''}${p.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${p.fill}"/>` : ''}<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>${p.valign ? `<w:vAlign w:val="${p.valign}"/>` : ''}</w:tcPr>${content || docxPara('')}</w:tc>`; }
function docxTable(widths, rows, o) { const p = o || {}, total = widths.reduce((s, x) => s + x, 0), line = p.lines === false ? 'nil' : 'single';
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="${line}" w:sz="4" w:space="0" w:color="D0D3D8"/><w:right w:val="nil"/><w:insideH w:val="${line}" w:sz="4" w:space="0" w:color="D0D3D8"/><w:insideV w:val="nil"/></w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>
    <w:tblGrid>${widths.map(x => `<w:gridCol w:w="${x}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>${docxPara('', { after: 120 })}`; }
const docxRow = cells => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cells.join('')}</w:tr>`;
function docxImage(rid, cxIn, cyIn) { const cx = Math.round(cxIn * 914400), cy = Math.round(cyIn * 914400);
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Portrait"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>
    <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
    <pic:nvPicPr><pic:cNvPr id="1" name="portrait.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
    <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`; }
async function portraitPng(url) {
  const img = await loadImg(url); if (!img) return null;
  const size = Math.min(900, Math.max(img.width, img.height)), k = size / Math.max(img.width, img.height), cv = document.createElement('canvas');
  cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  const blob = await new Promise(ok => cv.toBlob(ok, 'image/png')); return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()), w: cv.width, h: cv.height } : null;
}
async function sheetDocx(cid) {
  const d = sheetData(cid); if (!d) return null;
  const { c } = d, accent = hex(d.color), DARK = '1C1D22', RED = 'E10600', GREY = '6B7280', LIGHT = 'F2F3F5', FULL = 9360;
  const pic = await portraitPng(c.portraitUrl);
  const H2 = t => docxPara(docxRun(t, { b: true, i: true, sz: 30, color: DARK }), { keep: true, before: 280, after: 80, rule: accent });
  const P = (t, o) => docxPara(docxRun(t, Object.assign({ sz: 21 }, o || {})), { after: 120 });
  const body = [];
  /* Header: portrait and name on a dark band. */
  const nameRuns = docxPara(docxRun('F1 SIM  ·  CHARACTER SHEET', { b: true, sz: 18, color: RED }), { after: 60 })
    + docxPara(docxRun(c.name, { b: true, i: true, sz: 56, color: 'FFFFFF' }), { after: 40 })
    + docxPara(docxRun([d.role, d.team ? d.team.name : '', d.series].filter(Boolean).join('  ·  '), { sz: 24, color: 'C9CCD2' }), { after: 40 })
    + docxPara(docxRun([c.code, c.number ? '#' + c.number : '', c.nationality].filter(Boolean).join('  ·  '), { b: true, sz: 24, color: accent }), { after: 40 })
    + docxPara(docxRun(d.status === 'approved' ? 'Approved by Race Control' : d.status === 'pending' ? 'Application with Race Control' : 'Draft application', { sz: 18, color: '9AA0A8' }), { after: 0 });
  const picW = 2.0, picH = pic ? Math.min(2.6, picW * pic.h / pic.w) : 0;
  body.push(docxTable(pic ? [3200, FULL - 3200] : [FULL], [docxRow((pic ? [docxCell(docxPara(docxImage('rIdImg1', picW, picH), { after: 0, align: 'center' }), 3200, { fill: DARK, valign: 'center' })] : [])
    .concat([docxCell(nameRuns, pic ? FULL - 3200 : FULL, { fill: DARK, valign: 'center' })]))], { lines: false }));
  body.push(docxPara('', { rule: RED, after: 160 }));
  /* Particulars. */
  const facts = [['Role', d.role], ['Team', d.team ? d.team.name : 'No seat yet'], ['Nationality', c.nationality], ['From', c.birthplace], ['Nickname', c.nickname], ['Face claim', c.faceclaim],
    d.driver ? ['Three-letter code', c.code] : null, d.driver ? ['Car number', c.number ? '#' + c.number : ''] : null, d.driver ? ['Background', d.background] : null,
    d.driver ? ['Years in racing', d.years] : null, d.driver ? ['Driving style', d.style] : null, d.driver ? ['Helmet', c.helmet] : null, ['Discord', c.discord]].filter(x => x && x[1]);
  body.push(H2('Particulars'));
  body.push(docxTable([2600, FULL - 2600], facts.map(([k, v], i) => docxRow([docxCell(docxPara(docxRun(k, { b: true, sz: 20, color: GREY }), { after: 0 }), 2600, { fill: i % 2 ? 'FFFFFF' : LIGHT }),
    docxCell(docxPara(docxRun(String(v), { sz: 21 }), { after: 0 }), FULL - 2600, { fill: i % 2 ? 'FFFFFF' : LIGHT })]))));
  /* Ratings, as numbers and bars. */
  if (d.ratings) {
    body.push(H2('Ratings'));
    body.push(docxTable([2600, 900, FULL - 3500], F1_RATINGS.filter(([k]) => d.ratings[k] != null).map(([k, l], i) => { const v = d.ratings[k];
      return docxRow([docxCell(docxPara(docxRun(l, { b: true, sz: 20, color: GREY }), { after: 0 }), 2600, { fill: i % 2 ? 'FFFFFF' : LIGHT }),
        docxCell(docxPara(docxRun(String(v), { b: true, sz: 24 }), { after: 0, align: 'right' }), 900, { fill: i % 2 ? 'FFFFFF' : LIGHT }),
        docxCell(docxPara(docxRun('█'.repeat(Math.max(1, Math.round(v / 4))), { sz: 18, color: accent }) + docxRun('█'.repeat(Math.max(0, 25 - Math.round(v / 4))), { sz: 18, color: 'E3E5E9' }), { after: 0 }), FULL - 3500, { fill: i % 2 ? 'FFFFFF' : LIGHT })]); })));
  }
  /* Story. */
  if (c.bio) { body.push(H2('Story')); String(c.bio).split(/\n+/).filter(Boolean).forEach(t => body.push(P(t))); }
  if (d.driver && c.junior) { body.push(H2('Before Formula 1')); String(c.junior).split(/\n+/).filter(Boolean).forEach(t => body.push(P(t))); }
  /* Career record. */
  if (d.sim.length || d.canon.length) {
    body.push(H2('Career record'));
    body.push(P(`${d.titles} ${d.titles === 1 ? 'title' : 'titles'}  ·  ${d.totals.starts} starts  ·  ${d.totals.wins} wins  ·  ${d.totals.podiums} podiums  ·  ${d.totals.poles} poles`, { b: true, color: accent, sz: 22 }));
    const cw = [880, 2080, 1760, 820, 700, 1020, 760, 1340], head = ['Year', 'Series', 'Team', 'Starts', 'Wins', 'Podiums', 'Poles', 'Finish'];
    const headRow = docxRow(head.map((h, i) => docxCell(docxPara(docxRun(h, { b: true, sz: 18, color: 'FFFFFF' }), { after: 0, align: i >= 3 && i < 7 ? 'right' : null }), cw[i], { fill: DARK })));
    const rows = d.sim.map(o => [o.seasonName, `F1 SIM: ${o.seriesName}`, (F1.team(o.team) || {}).name || '', o.starts, o.wins, o.podiums, o.poles, o.done && o.pos === 1 ? 'Champion' : o.pos ? ordinal(o.pos) + (o.done ? '' : ' so far') : ''])
      .concat(d.canon.map(r => [r.years, seriesLabel(r) + (r.cls ? ` (${r.cls})` : ''), r.team, r.starts, r.wins, r.podiums, r.poles, String(r.pos) === '1' ? 'Champion' : r.pos ? posLabel(r.pos) : '']));
    body.push(docxTable(cw, [headRow].concat(rows.map((r, j) => docxRow(r.map((v, i) => docxCell(docxPara(docxRun(v === '' || v == null ? '–' : String(v), { sz: 19, b: i === 7 && v === 'Champion', color: i === 7 && v === 'Champion' ? RED : null }), { after: 0, align: i >= 3 && i < 7 ? 'right' : null }), cw[i], { fill: j % 2 ? 'FFFFFF' : LIGHT })))))));
    const notes = d.canon.filter(r => r.notes); if (notes.length) notes.forEach(r => body.push(P(`${r.years} ${seriesLabel(r)}: ${r.notes}`, { sz: 19, color: GREY })));
  }
  if (d.rels.length) { body.push(H2('Relationships')); d.rels.forEach(r => body.push(P(`${r.who}: ${r.kind}${r.note ? `. ${r.note}` : ''}`))); }
  if (d.diary.length) { body.push(H2('From the diary')); d.diary.forEach(e => { body.push(docxPara(docxRun(`${e.title}`, { b: true, sz: 22 }) + docxRun(`   ${fmtDate(e.at)}`, { sz: 18, color: GREY }), { after: 40, keep: true })); body.push(P(String(e.body || '').slice(0, 800))); }); }
  body.push(docxPara(docxRun(`Exported from F1 SIM on ${fmtDate(nowIso())}.`, { i: true, sz: 17, color: GREY }), { before: 360, after: 0 }));
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1273" w:bottom="1000" w:left="1273" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Titillium Web" w:hAnsi="Titillium Web" w:cs="Titillium Web" w:eastAsia="Titillium Web"/><w:sz w:val="21"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${pic ? '<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/portrait.png"/>' : ''}</Relationships>`;
  const files = [{ name: '[Content_Types].xml', data: ct }, { name: '_rels/.rels', data: rels }, { name: 'word/document.xml', data: doc }, { name: 'word/styles.xml', data: styles }, { name: 'word/_rels/document.xml.rels', data: docRels }];
  if (pic) files.push({ name: 'word/media/portrait.png', data: pic.bytes });
  return new Blob([zipStore(files)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

/* ---------------------------------------------------------------- the export panel */
const fileSafe = s => String(s || 'character').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
ACTIONS['sheet-open'] = d => { S.ui.sheet = { cid: d.id, kind: 'sheet', url: null, blob: null }; openDrawer('sheet'); sheetRefresh(); if (S.isGm) discordChannels().then(() => renderOverlay()).catch(() => {}); };
async function sheetRefresh() { const x = S.ui.sheet; if (!x) return; const blob = await drawCharCard(x.cid, x.kind); if (S.ui.sheet !== x || !blob) return; if (x.url) URL.revokeObjectURL(x.url); x.blob = blob; x.url = URL.createObjectURL(blob); renderOverlay(); }
CHANGES['sheet-kind'] = v => { const x = S.ui.sheet; if (!x) return; x.kind = v; x.url = null; renderOverlay(); sheetRefresh(); };
DRAWERS.sheet = function () {
  const x = S.ui.sheet || {}, c = get('characters', x.cid); if (!c) return '';
  return `<header><div><h2>Export ${esc(c.name)}</h2><p>A photo card, or a document for Google Docs.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><h3>Photo card</h3><label class="field" style="max-width:320px">Card<select id="sheet-kind" data-change="sheet-kind">${SHEET_KINDS.map(([k, l]) => `<option value="${k}" ${x.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    ${x.url ? `<img class="card-preview tx-preview" src="${x.url}" alt="${esc(c.name)}’s ${x.kind === 'accepted' ? 'acceptance card' : 'character sheet'}">` : '<p class="muted">Drawing the card…</p>'}
    <div class="btn-row"><button class="btn primary" data-act="sheet-png" ${x.url ? '' : 'disabled'}>Download the card</button>${S.isGm ? `<button class="btn" data-act="sheet-discord" ${x.url ? '' : 'disabled'}>Post to Discord${x.kind === 'accepted' && c.discordId ? ' with an @mention' : ''}</button>` : ''}${x.posted ? `<span class="tag player">Posted to #${esc(x.posted)}</span>` : ''}</div>
    <h3>Google Doc</h3><p class="small">A styled document of the whole sheet: particulars, ratings, story, career record, relationships and recent diary entries.</p>
    <div class="btn-row"><button class="btn" data-act="sheet-docx">Download for Google Docs (.docx)</button></div>
    <p class="muted small">To open it in Google Docs: in Google Drive choose <b>New</b>, then <b>File upload</b>, pick the file, then open it with <b>Google Docs</b>. It opens in Word too.</p></div>`;
};
ACTIONS['sheet-png'] = () => { const x = S.ui.sheet; if (!x || !x.url) return; const c = get('characters', x.cid), a = document.createElement('a'); a.href = x.url; a.download = `${fileSafe(c && c.name)}-${x.kind === 'accepted' ? 'acceptance' : 'sheet'}.png`; document.body.appendChild(a); a.click(); a.remove(); };
ACTIONS['sheet-docx'] = () => { const x = S.ui.sheet; if (!x) return; const c = get('characters', x.cid);
  run(async () => { const blob = await sheetDocx(x.cid); const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `${fileSafe(c && c.name)}-character-sheet.docx`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000); }, 'Character sheet downloaded.'); };

/* ---------------------------------------------------------------- the acceptance post */
function acceptText(c) {
  const d = sheetData(c.id), who = c.discordId ? `<@${c.discordId}> ` : '';
  return `${who}🏁 **Welcome to the grid!** ${c.name} has been approved as ${d.role.toLowerCase()}${d.team ? ` for ${d.team.name}` : ''}.`;
}
async function postAcceptance(cid, chosen) {
  const c = get('characters', cid); if (!c) return null;
  const blob = await drawCharCard(cid, 'accepted');
  return discordSend('approvals', Object.assign({ content: acceptText(c) }, c.discordId ? { allowed_users: [c.discordId] } : {}), { blob, name: `${fileSafe(c.name)}-approved.png` }, chosen);
}
ACTIONS['sheet-discord'] = () => { const x = S.ui.sheet; if (!x || !x.blob) return; const c = get('characters', x.cid);
  run(async () => {
    x.posted = x.kind === 'accepted' ? await postAcceptance(x.cid) : await discordSend('cards', { content: `**Character sheet:** ${c.name}` }, { blob: x.blob, name: `${fileSafe(c.name)}-sheet.png` });
    await Data.audit('discord.sheet', `${c.name}: ${x.kind === 'accepted' ? 'acceptance card' : 'character sheet'} posted to Discord #${x.posted}`);
  }, 'Posted to Discord.'); };
const waitFor = (test, ms) => new Promise(ok => { const t0 = Date.now(), tick = () => { if (test()) ok(true); else if (Date.now() - t0 > ms) ok(false); else setTimeout(tick, 200); }; tick(); });
/* After approving, post the acceptance card (unless Race Control untick it). */
const _genApproveSheet = ACTIONS['gen-approve'];
ACTIONS['gen-approve'] = d => {
  const post = ((S.ui.form.postAccept || {})[d.id]) !== false;
  _genApproveSheet(d);
  if (!post) return;
  waitFor(() => charStatus(get('characters', d.id) || {}) === 'approved', 15000).then(ok => {
    if (!ok) return; const c = get('characters', d.id);
    postAcceptance(d.id).then(ch => toast(`Acceptance card posted to Discord #${ch}${c && c.discordId ? `, mentioning ${c.discord || 'the player'}` : ' (no Discord user ID on the character, so no @mention)'}.`))
      .catch(e => toast(`The character is approved, but the Discord post didn’t go: ${e.message || e}`, true));
  });
};

/* ---------------------------------------------------------------- picture and face claim on the character form */
CHANGES['ch-portrait'] = (v, d, el) => {
  const file = el.files && el.files[0]; if (!file || !S.ui.form.ch) return;
  if (!/^image\//.test(file.type)) { toast('Choose a picture: a JPEG, PNG or WebP.', true); return; }
  S.ui.chUploading = true; renderOverlay();
  (async () => { try { const blob = await shrinkImage(file, 900), assets = await window.claude.use('assets'), up = await assets.upload(blob, { type: 'image/jpeg' });
      if (S.ui.form.ch) S.ui.form.ch.portraitUrl = up.url; toast('Picture uploaded. Save the character to keep it.'); }
    catch (e) { toast('The picture didn’t upload: ' + (e.message || e), true); }
    S.ui.chUploading = false; renderOverlay(); })();
  el.value = '';
};
ACTIONS['ch-portrait-remove'] = () => { if (S.ui.form.ch) { S.ui.form.ch.portraitUrl = null; renderOverlay(); } };
/* Sending without a picture or face claim asks first. */
const _genSubmitPhoto = ACTIONS['gen-submit'];
ACTIONS['gen-submit'] = d => {
  const c = get('characters', S.ui.charEdit); if (!c) return;
  const missing = [!c.portraitUrl ? 'picture' : '', !String(c.faceclaim || '').trim() ? 'face claim' : ''].filter(Boolean);
  if (missing.length) askConfirm(`There’s no ${missing.join(' or ')} yet (add ${missing.length > 1 ? 'them' : 'it'} with Edit details). Send the application anyway?`, 'Send anyway', () => _genSubmitPhoto(d));
  else _genSubmitPhoto(d);
};

/* =====================================================================
   F1 SIM — Home, Paddock, Race Control desk, accounts and backups.
   ===================================================================== */
'use strict';

const sel = (id, path, value, opts, empty) => `<select id="${id}" data-bind="${path}">${empty ? `<option value="">${esc(empty)}</option>` : ''}${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const paras = t => String(t || '').split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
/* A character's seat: in the series being shown if they have one there, otherwise wherever they race. */
function charSeat(charId) { return F1.seats().find(s => s.holderCharId === charId) || list('f1_seats').find(s => s.holderCharId === charId) || null; }
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
  const doc = Object.assign({}, prev ? clone(S.store.f1_posts[id]) : { createdAt: nowIso(), userId: asOwner(), charId: c.id, charName: c.name }, f, prev ? { editedAt: nowIso() } : {});
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
      ${charStatus(c) !== 'approved' ? `<p>Application: <b>${esc(STATUS_TEXT[charStatus(c)].toLowerCase())}</b>. <button class="btn small" data-act="char-open" data-id="${esc(c.id)}">Open it</button></p>` : ''}
      ${f1ContractOffersFor(c.id).length ? `<p><b>${plural(f1ContractOffersFor(c.id).length, 'contract offer')}</b> waiting. <button class="btn small" data-act="char-open" data-id="${esc(c.id)}">See the offer</button></p>` : ''}
      ${apps.slice(0, 3).map(x => `<p class="small">Application for ${esc(seatTitle(get('f1_seats', x.seatId) || { role: x.role, car: '' }).toLowerCase())} at ${esc(F1.team(x.teamId).name)} (${esc(seriesDoc((get('f1_teams', x.teamId) || {}).seriesId || 'f1').short)}): <b>${x.status === 'pending' ? 'waiting for Race Control' : x.status}</b></p>`).join('')}
      ${!seat && (c.role === 'driver' || c.role === 'principal' || c.role === 'engineer') ? '<button class="btn small" data-act="nav" data-route="grid">Find an open seat</button>' : ''}</section>` : charPromptHtml();
  const result = last ? `<section class="card"><h2>Latest result: ${esc((F1.track(last.trackId) || {}).name || '')}${last.session === 'sprint' ? ' sprint' : ''}</h2>
      <ol class="podium">${(last.results || []).slice(0, 3).map(r => `<li style="--team:${esc(f1Colour(r.teamId))}"><b>${esc(r.name)}</b><span>${esc(F1.team(r.teamId).name)}</span></li>`).join('')}</ol>
      <button class="btn small" data-act="f1-view" data-id="${esc(last.id)}" data-go="weekend">Full result</button></section>` : '';
  const table = st.drivers.length ? `<section class="card"><h2>Championship</h2><table class="data compact"><tbody>${st.drivers.slice(0, 5).map((d, i) =>
      `<tr${d.charId && d.charId === S.charId ? ' class="me"' : ''}><td>${i + 1}</td><td><span class="f1-bar" style="background:${esc(f1Colour(d.teamId))}"></span>${esc(d.name)}</td><td class="num"><b>${d.pts}</b></td></tr>`).join('')}</tbody></table>
      <button class="btn small" data-act="nav" data-route="standings">Full standings</button></section>` : '';
  return `<div class="page-head"><div><p class="eyebrow">${esc(curSeries().name)}, ${esc(curSeason().name)} season</p><h1>${c ? 'Welcome back, ' + esc(c.name.split(' ')[0]) : 'Welcome' + (a ? ', ' + esc(a.username) : '')}</h1></div></div>
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
    const ser = seriesDoc((get('f1_teams', a.teamId) || {}).seriesId || 'f1');
    return `<article class="card" style="--team:${esc(t.color)}"><p class="eyebrow">${esc(ser.name)}</p><h3>${esc(a.charName)} for ${esc(s ? seatTitle(s).toLowerCase() : a.role)} at ${esc(t.name)}</h3>
      <p class="muted small">Sent ${esc(fmtWhen(a.createdAt))}. ${o ? `The seat is held by ${esc(o.name)}${o.player ? ' (a player)' : ''}.` : ''}</p>
      ${a.note ? paras(a.note) : '<p class="muted">No note.</p>'}
      ${c && c.bio ? `<details><summary>About ${esc(c.name)}</summary>${paras(c.bio)}</details>` : ''}
      <div class="btn-row"><button class="btn primary" data-act="app-decide" data-id="${esc(a.id)}" data-ok="1">Give them the seat</button><button class="btn" data-act="app-decide" data-id="${esc(a.id)}" data-ok="0">Decline</button></div></article>`; };
  return `<div class="page-head"><div><h1>Race Control</h1><p>Character applications, seat applications, the people in the paddock, and a record of everything Race Control and the teams have done. Use View as in the top bar to see the league as any character.</p></div></div>
    ${noticeComposerHtml()}
    ${leaguePanelHtml()}
    ${chargenQueueHtml()}
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
